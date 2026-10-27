# Neon (Postgres) y Cloudflare Workers: conexión, transacciones, costos y pruebas

Resumen de la documentación oficial para [ADR-016](../DECISIONES.md#adr-016--nube-primero-postgres-en-neon-como-base-oficial-y-el-pc-de-caja-como-puente-local) y [SYNC.md, «Hub ↔ nube»](../SYNC.md). Regla de este documento: si algo no está en la documentación oficial, dice **«No documentado»** y pasa a las preguntas abiertas. Los ejemplos de código marcados como *ilustrativos* están armados con piezas que sí aparecen en la documentación, pero no son un ejemplo oficial completo y hay que probarlos.

## 1. Estado y fecha de consulta

- **Fecha de consulta:** 26-oct-2026. Toda la documentación se leyó ese día.
- **Neon:** servicio en producción. Planes Free, Launch y Scale ([planes](https://neon.com/docs/introduction/plans)). La documentación de Neon menciona también un «Agent Plan» para plataformas de agentes, sin detalle; no aplica a Faro.
- **Cloudflare Hyperdrive:** en producción, incluido en los planes Free y Paid de Workers ([precios](https://developers.cloudflare.com/hyperdrive/platform/pricing/)).
- **Cloudflare Workers:** en producción. La página de [Node.js compat](https://developers.cloudflare.com/workers/runtime-apis/nodejs/) ya habla de fechas de compatibilidad de 2026.
- **Estado de piezas de pruebas** (importante, cambió este año):
  - `@cloudflare/vitest-pool-workers` ahora se llama `@cloudflare/vitest-plugin` (versión 1; [aviso del 19-ago-2026](https://developers.cloudflare.com/changelog/post/2026-08-19-vitest-plugin/)).
  - `unstable_dev()` está **obsoleto** ([API de Wrangler](https://developers.cloudflare.com/workers/wrangler/api/)).
  - PGlite se declara en **Alpha** en su [README](https://github.com/electric-sql/pglite).
- **Inconsistencias de la documentación detectadas** (ver preguntas abiertas):
  - La [página de regiones de Neon](https://neon.com/docs/introduction/regions) lista São Paulo, pero la [referencia de `neon projects create`](https://neon.com/docs/reference/cli-projects) no incluye `aws-sa-east-1` en los valores posibles de `--region-id`.
  - La [página de bases soportadas de Hyperdrive](https://developers.cloudflare.com/hyperdrive/reference/supported-databases-and-features/) dice que Neon «currently runs Postgres 15.x», mientras que Neon dice que el CLI crea proyectos con Postgres 18 ([CLI projects](https://neon.com/docs/reference/cli-projects)). Hyperdrive soporta Postgres 9.0 a 18.x según esa misma página.

## 2. Requisitos previos

Lo que debe tramitar el dueño (el detalle paso a paso está en la sección 10.2):

1. **Cuenta de Neon** (gratis para empezar). Para producción conviene un plan de pago: en Free el historial para restaurar es de solo 6 horas ([historial](https://neon.com/docs/postgres/backup-restore/history-window)). Neon mismo recomienda un plan de pago para producción ([lista de producción](https://neon.com/docs/get-started/production-checklist)).
2. **Cuenta de Cloudflare** con Workers. Hyperdrive viene incluido en Free (con tope de consultas) y en Paid ([precios de Hyperdrive](https://developers.cloudflare.com/hyperdrive/platform/pricing/)).
3. **Una tarjeta de pago** si se pasa a Workers Paid (mínimo de USD 5 al mes por cuenta, ver sección 7.1) o a Neon Launch/Scale (pago por uso, sin mínimo mensual según [uso y facturación](https://neon.com/docs/introduction/usage-metrics)). Facturas de menos de USD 0,50 no se cobran (misma fuente).
4. **Node.js y Wrangler** en el equipo de desarrollo; `npx wrangler login` abre el navegador para autorizar ([guía de inicio de Hyperdrive](https://developers.cloudflare.com/hyperdrive/get-started/)).
5. **Base pública**: Hyperdrive solo se conecta a IP públicas y exige TLS (no acepta conexiones sin cifrar). Neon cumple ambos ([errores de Hyperdrive](https://developers.cloudflare.com/hyperdrive/observability/troubleshooting/), [modos TLS](https://developers.cloudflare.com/hyperdrive/reference/supported-databases-and-features/)).
6. **Un rol de base de datos para la API** (ver sección 6.6 sobre RLS: no debe saltarse la seguridad por fila).

## 3. Ambientes

| Ambiente | Dónde | URL base |
|---|---|---|
| Producción, base | Proyecto Neon, rama `main` (la rama raíz por defecto) | Nombre de host del tipo `ep-...` que entrega la consola de Neon; con `-pooler` si se usa el pooler de Neon ([pooling](https://neon.com/docs/connect/connection-pooling)). No hay URL fija: la da Neon al crear el proyecto. |
| Producción, API | Worker desplegado con `wrangler deploy` | No verificado en esta consulta (Cloudflare asigna una URL por Worker, o se usa un dominio propio del dueño). Se confirma al crear el Worker. |
| Desarrollo local de la API | `wrangler dev` | `http://localhost:8787` ([guía Neon + Workers](https://neon.com/docs/guides/cloudflare-workers)) |
| Pruebas / desarrollo de la base | Una **rama de Neon**, un Postgres local o PGlite | Las ramas son copias «copy-on-write», aisladas de la rama madre ([ramas](https://neon.com/docs/introduction/branching)) |

No existe un «sandbox» aparte de Neon ni de Hyperdrive: el aislamiento se logra con ramas (Neon), con `localConnectionString` (Hyperdrive) y con proyectos separados.

## 4. Pregunta 1: cómo conectar un Worker a Neon

### 4.1 Qué recomienda cada proveedor

- **Cloudflare recomienda Hyperdrive.** Su página de conexión a bases de datos dice que para Postgres se use TCP «using Hyperdrive for optimal performance (optional, recommended)» ([conectar a bases de datos](https://developers.cloudflare.com/workers/databases/connecting-to-databases/)). Su página de Neon marca Hyperdrive como recomendado y dice que «puede dar las latencias más bajas posibles» ([Neon en Workers](https://developers.cloudflare.com/workers/databases/third-party-integrations/neon/)).
- **Neon recomienda Hyperdrive** en su guía de Workers (la etiqueta «Hyperdrive (recommended)») y deja el driver serverless como alternativa ([guía de Neon](https://neon.com/docs/guides/cloudflare-workers)). El README del driver serverless dice «consider using Cloudflare Hyperdrive» en lugar de ese driver ([repositorio](https://github.com/neondatabase/serverless)).
- **Con Hyperdrive no se debe usar el driver serverless de Neon.** Hay que usar `pg` o `postgres` (postgres.js): lo dicen las dos guías ([Cloudflare](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-database-providers/neon/), [Neon](https://neon.com/docs/guides/cloudflare-workers)).
- **Driver preferido con Hyperdrive:** `pg` (node-postgres) se llama «the recommended driver» y «has the best compatibility with Hyperdrive's caching» ([ejemplo con node-postgres](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/node-postgres/)). `postgres` (postgres.js) también está soportado ([ejemplo](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/postgres-js/)).

### 4.2 Comparación

| Aspecto | Hyperdrive + `pg` | Hyperdrive + `postgres` (postgres.js) | `@neondatabase/serverless` por HTTP (`neon()`) | `@neondatabase/serverless` por WebSocket (`Pool`/`Client`) |
|---|---|---|---|---|
| Versión mínima | `pg` 8.16.3 ([fuente](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/node-postgres/)) | `postgres` 3.4.5 ([fuente](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/postgres-js/)) | Node 19 o superior en servidores; en Workers no aplica ([doc del driver](https://neon.com/docs/serverless/serverless-driver)) | Igual |
| Transacciones interactivas (`BEGIN`, lógica, `COMMIT`) | Sí. Una transacción retiene una conexión del pool hasta terminar ([pooling de Hyperdrive](https://developers.cloudflare.com/hyperdrive/concepts/connection-pooling/)) | Sí, con `sql.begin` ([README](https://github.com/porsager/postgres)) | **No**: una consulta a la vez, sin sesiones ni transacciones interactivas. Solo `sql.transaction([...])`, no interactiva ([README del driver](https://github.com/neondatabase/serverless)) | Sí: `Pool` y `Client` dan sesión y transacciones ([doc del driver](https://neon.com/docs/serverless/serverless-driver)) |
| Conexiones | Hyperdrive mantiene el pool cerca de la base; no limita las conexiones de cliente desde Workers; sí las de origen (~20 en Free, ~100 en Paid) ([límites](https://developers.cloudflare.com/hyperdrive/platform/limits/)) | Igual; el ejemplo oficial usa `max: 5` por el límite de conexiones externas simultáneas del Worker ([ejemplo](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/postgres-js/)) | Sin conexión persistente: cada consulta es una petición HTTP | En Workers, un WebSocket «no puede sobrevivir a una sola petición»: crear, usar y cerrar `Pool`/`Client` dentro del manejador ([doc del driver](https://neon.com/docs/serverless/serverless-driver)) |
| Latencia | Cloudflare dice que el pool y el establecimiento de conexión ocurren cerca del Worker y de la base, lo que reduce la latencia ([cómo funciona](https://developers.cloudflare.com/hyperdrive/concepts/how-hyperdrive-works/)). Cifras propias para Colombia: No documentado | Igual | Neon la llama «la opción más rápida para consultas sueltas y para varias consultas en una transacción no interactiva» ([doc del driver](https://neon.com/docs/serverless/serverless-driver)); cifras: No documentado | Mensajes en tubería; cifras: No documentado |
| Pooling | Pool propio de Hyperdrive en modo transacción | Igual | Pooler de Neon (PgBouncer) si se usa la cadena con `-pooler` ([guía de Neon](https://neon.com/docs/guides/cloudflare-workers)) | Igual |
| Límites propios | Consultas hasta 60 s; respuestas en caché hasta 50 MB ([límites](https://developers.cloudflare.com/hyperdrive/platform/limits/)) | Igual | Solicitud y respuesta HTTP de hasta 64 MB cada una ([doc del driver](https://neon.com/docs/serverless/serverless-driver)) | No documentado |
| Costo extra | Hyperdrive incluido en Free (100.000 consultas/día) y en Paid (ilimitadas) | Igual | Ninguno aparte de Neon y Workers | Ninguno aparte de Neon y Workers |
| Secreto | Cadena guardada en la configuración de Hyperdrive; el Worker solo ve `env.HYPERDRIVE.connectionString` | Igual | `DATABASE_URL` como secreto del Worker (`wrangler secret put`) | Igual |
| Desarrollo local | `localConnectionString` o variable de entorno | Igual | Requiere un «proxy local de Neon»; la doc remite a una guía de la comunidad ([doc del driver](https://neon.com/docs/serverless/serverless-driver)) | Igual |
| Reintentos | Los de Hyperdrive/driver; ver errores en [troubleshooting](https://developers.cloudflare.com/hyperdrive/observability/troubleshooting/) | Igual | «Pueden ocurrir caídas transitorias de conexión; se recomienda lógica de reintento, sobre todo por HTTP» ([doc del driver](https://neon.com/docs/serverless/serverless-driver)) | Igual |

### 4.3 Pros y contras en una línea

- **Hyperdrive + `pg`**: es lo que ambos proveedores recomiendan, soporta transacciones interactivas y no requiere secretos en el Worker. Contras: **la caché de consultas viene activada por defecto** (ver 4.6), no soporta `LISTEN/NOTIFY`, bloqueos consultivos ni `PREPARE` a nivel SQL ([funciones no soportadas](https://developers.cloudflare.com/hyperdrive/reference/supported-databases-and-features/)), y las transacciones largas agotan el pool.
- **Hyperdrive + `postgres`**: igual que lo anterior; la documentación de Cloudflare avisa «no use `prepare: false`» con postgres.js, porque con el modo de transacción de Hyperdrive no es confiable y las consultas dejan de ser cacheables ([ejemplo](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/postgres-js/)). Trae `sql.begin` y un inserto masivo `sql(rows)` cómodos ([README](https://github.com/porsager/postgres)). Cloudflare prefiere `pg` por la compatibilidad con su caché.
- **Driver serverless HTTP**: sin conexiones que administrar, bueno para consultas sueltas; sin transacciones interactivas. No pasa por Hyperdrive (por lo que no hay pool de Cloudflare) y requiere un secreto en el Worker.
- **Driver serverless WebSocket**: transacciones interactivas, pero hay que abrir y cerrar la conexión en cada petición, y su propio README remite a Hyperdrive.

### 4.4 Configuración de `wrangler.jsonc`

Tomada del [ejemplo oficial de Neon con Hyperdrive](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-database-providers/neon/) y de la [guía de Neon](https://neon.com/docs/guides/cloudflare-workers):

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "faro-api",
  "main": "src/index.ts",
  "upload_source_maps": true,
  // La documentación pide poner la fecha del día en que se crea el proyecto
  "compatibility_date": "2026-10-26",
  "compatibility_flags": ["nodejs_compat"],
  "hyperdrive": [
    {
      "binding": "HYPERDRIVE",
      "id": "<ID que devuelve wrangler hyperdrive create>",
      // Solo para `wrangler dev`; nunca apunta a producción
      "localConnectionString": "postgres://usuario:clave@localhost:5432/faro_dev"
    }
  ]
}
```

- **`nodejs_compat`:** los drivers de base de datos lo exigen ([ejemplo de Neon](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-database-providers/neon/)). Con fecha de compatibilidad **2026-08-04 o posterior**, Workers activa `nodejs_compat` y `nodejs_compat_v2` por defecto y pide omitir los flags en configuraciones nuevas ([Node.js compat](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)); las guías de Hyperdrive y Neon todavía lo muestran. Dejarlo es inofensivo (los proyectos existentes no necesitan quitarlo); decisión de equipo.
- **`compatibility_date`:** «Set this to today's date» ([ejemplo](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-database-providers/neon/)). Para Faro: la del día en que se cree el Worker, y subirla después con pruebas.
- **Binding:** `"binding": "HYPERDRIVE"` con el `id` de la configuración creada.
- **No poner la clave de producción en `localConnectionString`** si el archivo va al repositorio. La documentación recomienda la variable de entorno para no guardar credenciales en el control de versiones (ver 4.7).

### 4.5 Código del Worker

Ejemplo oficial con `pg` ([fuente](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/node-postgres/)):

```ts
import { Client } from "pg";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Un cliente nuevo por petición; Hyperdrive mantiene el pool
    const client = new Client({ connectionString: env.HYPERDRIVE.connectionString });
    try {
      await client.connect();
      const result = await client.query("SELECT * FROM pg_tables");
      return Response.json({ success: true, result: result.rows });
    } catch (error: any) {
      console.error("Database error:", error.message);
      return new Response("Internal error occurred", { status: 500 });
    }
  },
};
```

Reglas de uso que da Cloudflare ([troubleshooting](https://developers.cloudflare.com/hyperdrive/observability/troubleshooting/)):

- Con `pg`, crear un `Client` nuevo dentro de cada manejador; no usar `new Pool()` en el ámbito global. Los errores «Connection terminated» y «Client has encountered a connection error» suelen venir de reutilizar clientes entre peticiones.
- Con postgres.js, crear `postgres()` dentro de cada manejador; los errores `CONNECTION_ENDED`, `CONNECTION_DESTROYED` o `CONNECTION_CLOSED` indican reutilización.
- La guía de Neon cierra el cliente con `ctx.waitUntil(client.end())` ([guía](https://neon.com/docs/guides/cloudflare-workers)); el ejemplo oficial de `pg` de Cloudflare no cierra el cliente.

### 4.6 Caché de consultas de Hyperdrive (afecta a Faro)

- **Está activada por defecto**, con `max_age` de 60 s y `stale_while_revalidate` de 15 s; el máximo de `max_age` es 1 hora ([caché](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/)).
- Solo se cachean consultas de lectura; los `INSERT` no. **Pero «no invalida los resultados cacheados cuando la aplicación escribe»**: un `SELECT` igual puede devolver un resultado viejo hasta que venza `max_age` (misma fuente).
- Para Faro: la carta y la configuración que baja el hub podrían verse hasta 60 s atrasadas tras editarse. Se desactiva con `--caching-disabled` al crear la configuración, o después con `npx wrangler hyperdrive update <ID> --caching-disabled` ([caché](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/)).
- Solo las funciones `IMMUTABLE` son compatibles con la caché; `NOW()` o `RANDOM()` la desactivan para esa consulta (misma fuente). Con la caché desactivada esto deja de importar.

### 4.7 Desarrollo local sin tocar producción

Opciones oficiales ([desarrollo local de Hyperdrive](https://developers.cloudflare.com/hyperdrive/configuration/local-development/)):

1. **`localConnectionString`** en el `wrangler.jsonc` (apunta a una base local, por ejemplo `postgres://user:password@localhost:5432/databasename`).
2. **Variable de entorno** `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_<NOMBRE_DEL_BINDING>`; con el binding `HYPERDRIVE` queda `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE`. Es la forma que la documentación recomienda para no dejar credenciales en el repositorio. **Tiene precedencia sobre el archivo.**
3. **Base remota con TLS** en `localConnectionString`: agregar `?sslmode=require`.
4. **`wrangler dev --remote`**: usa la configuración de Hyperdrive desplegada, con pool y caché reales. **Advertencia oficial: cualquier escritura afecta los datos de producción.** Para Faro: no usarlo contra la configuración de producción.
- Con `localConnectionString`, Worker y base se conectan directo: «la caché de consultas de Hyperdrive no tiene efecto en este modo» ([misma página](https://developers.cloudflare.com/hyperdrive/configuration/local-development/)). No se prueba la caché ni el pool en local.

Para no tocar producción: apuntar `localConnectionString` a (a) un Postgres local, (b) PGlite expuesto por socket (ver sección 8.1), o (c) una **rama de Neon** propia de desarrollo ([ramas](https://neon.com/docs/introduction/branching)). Secretos locales del Worker (por ejemplo `DATABASE_URL` si se usara el driver serverless) van en `.dev.vars` o `.env`, que no se versionan ([secretos](https://developers.cloudflare.com/workers/configuration/secrets/)).

## 5. Pregunta 2: transacciones con varios INSERT (un lote de eventos)

**Hecho de Postgres que simplifica el diseño:** cada sentencia SQL corre dentro de una transacción; sin `BEGIN` explícito, cada sentencia lleva su propio `BEGIN`/`COMMIT` implícito, y una transacción es atómica ([tutorial de Postgres](https://www.postgresql.org/docs/current/tutorial-transactions.html)). Por tanto **un solo `INSERT` con muchas filas es todo-o-nada** sin transacción explícita.

### 5.1 Un solo `INSERT` (sirve con cualquier driver, incluido el HTTP de Neon)

- `INSERT` admite `VALUES` con varias filas, `INSERT ... SELECT`, `ON CONFLICT DO NOTHING` y `RETURNING` (este último devuelve solo las filas realmente insertadas) ([INSERT](https://www.postgresql.org/docs/current/sql-insert.html)).
- `jsonb_to_recordset(jsonb)` expande un arreglo JSON de objetos en filas; la consulta debe declarar las columnas con `AS` ([funciones JSON](https://www.postgresql.org/docs/current/functions-json.html)).
- Esto permite mandar **todo el lote como un parámetro `jsonb`** y una sola sentencia. Ejemplo *ilustrativo* (nombres de tabla y columnas de ejemplo, no del esquema final):

```sql
INSERT INTO events (restaurant_id, id, hub_sequence, type, content)
SELECT $1, e.id, e.hub_sequence, e.type, e.content
FROM jsonb_to_recordset($2::jsonb)
  AS e(id text, hub_sequence bigint, type text, content jsonb)
ON CONFLICT (restaurant_id, id) DO NOTHING
RETURNING id;
```

  Con `ON CONFLICT DO NOTHING`, un lote reenviado no duplica (idempotencia; ver SYNC.md y ADR-007). `RETURNING` devuelve solo las filas nuevas, así que los `id` ausentes eran duplicados. Ventaja extra: una sola ida y vuelta, y según Cloudflare la ubicación del Worker solo ayuda cuando hay varias consultas por petición ([cómo funciona](https://developers.cloudflare.com/hyperdrive/concepts/how-hyperdrive-works/)).
- **Límite no documentado:** el tamaño máximo de un parámetro o de una sentencia, y el tamaño de lote recomendado, no están en las fuentes oficiales leídas.

### 5.2 Transacción explícita según el driver

| Opción | ¿Se puede? | Cómo |
|---|---|---|
| Hyperdrive + `pg` | Sí | Con un solo `Client` por petición: `BEGIN`, los `INSERT`, `COMMIT`; ante error `ROLLBACK`. Hay que usar el mismo cliente en todas las sentencias ([node-postgres](https://node-postgres.com/features/transactions)). Hyperdrive retiene una conexión durante la transacción y la devuelve al terminar; «mantenga las transacciones cortas» ([pooling](https://developers.cloudflare.com/hyperdrive/concepts/connection-pooling/)). Las transacciones largas son causa común de «Failed to acquire a connection from the pool» ([troubleshooting](https://developers.cloudflare.com/hyperdrive/observability/troubleshooting/)). |
| Hyperdrive + `postgres` | Sí | `await sql.begin(async sql => { ... })`: commit automático y `ROLLBACK` si algo falla; inserto masivo con ``sql`insert into t ${ sql(filas, 'col1', 'col2') }`` ([README](https://github.com/porsager/postgres)). |
| Neon serverless, HTTP | Solo no interactiva | `sql.transaction([consulta1, consulta2, ...])` o una función que devuelve el arreglo; admite nivel de aislamiento, solo lectura y diferible. No se puede decidir a mitad de la transacción según un resultado anterior ([doc del driver](https://neon.com/docs/serverless/serverless-driver), [README](https://github.com/neondatabase/serverless)). |
| Neon serverless, WebSocket | Sí | `Pool`/`Client` con `BEGIN`/`COMMIT`/`ROLLBACK`, dentro de un solo manejador ([README](https://github.com/neondatabase/serverless)). |

Ejemplo *ilustrativo* con `pg` y Hyperdrive (combina el ejemplo de Cloudflare y el patrón de node-postgres):

```ts
const client = new Client({ connectionString: env.HYPERDRIVE.connectionString });
await client.connect();
try {
  await client.query("BEGIN");
  // ... fijar el restaurante para RLS (ver 6.6) y hacer los INSERT ...
  await client.query("COMMIT");
} catch (e) {
  await client.query("ROLLBACK");
  throw e;
} finally {
  ctx.waitUntil(client.end());
}
```

**Detalle de SYNC.md:** el hub hoy guarda «una transacción por evento» (SQLite). En la nube se puede mantener esa semántica o usar una sentencia por lote; la elección es de diseño, no de la documentación de los proveedores.

**Estado de sesión y transacciones en Hyperdrive:** el pool es modo transacción. `SET` funciona dentro de una transacción o dentro de una misma consulta; al devolver la conexión se reinicia ([pooling](https://developers.cloudflare.com/hyperdrive/concepts/connection-pooling/)). Una invocación del Worker puede usar varias conexiones, así que hay que fijar los valores de sesión en cada transacción (misma fuente). La documentación de Cloudflare desaconseja envolver todo el trabajo en una transacción solo para conservar el `SET`, porque perjudica el rendimiento.

## 6. Pregunta 3: Neon

### 6.1 Regiones

Neon lista, para Postgres ([regiones](https://neon.com/docs/introduction/regions)):

- AWS: `aws-us-east-1` (Virginia del Norte), `aws-us-east-2` (Ohio), `aws-us-west-2` (Oregón), `aws-eu-central-1` (Fráncfort), `aws-eu-west-2` (Londres), `aws-ap-southeast-1` (Singapur), `aws-ap-southeast-2` (Sídney) y **`aws-sa-east-1` (São Paulo)**.
- Azure (`azure-eastus2`, `azure-westus3`, `azure-gwc`): **obsoleto**, no se pueden crear proyectos nuevos allí.
- La página dice que «Postgres» corre en todas las regiones; en São Paulo aún no hay Object Storage, Functions, AI Gateway ni Realtime. Faro no usa esos servicios.
- **Discrepancia:** la [referencia del CLI](https://neon.com/docs/reference/cli-projects) no lista `aws-sa-east-1` entre los valores de `--region-id` y dice que el valor por defecto es `aws-us-east-2`. Probar el comando con `aws-sa-east-1` al crear el proyecto.
- **Latencia desde Colombia a São Paulo o a Virginia:** No documentado. Neon aconseja poner el proyecto en la región más cercana a la aplicación ([lista de producción](https://neon.com/docs/get-started/production-checklist)). Habría que medirla. Importante: la «aplicación» aquí es el Worker (que corre cerca de quien llama) más el pool de Hyperdrive, que se ubica «en una o más regiones lo más cercanas posible a la base de datos» ([cómo funciona](https://developers.cloudflare.com/hyperdrive/concepts/how-hyperdrive-works/)). Cloudflare permite además una pista de ubicación del Worker, `region` con formato `{proveedor}:{región}`, por ejemplo `aws:us-east-1` ([ubicación](https://developers.cloudflare.com/workers/configuration/placement/)); para São Paulo sería `aws:sa-east-1` por analogía, **sin confirmar** en la documentación.
- Cambiar la región de un proyecto ya creado: No documentado en las páginas leídas (pregunta abierta).

### 6.2 Planes y precios publicados

Fuente: [planes](https://neon.com/docs/introduction/plans) y [uso y facturación](https://neon.com/docs/introduction/usage-metrics). Precios en USD; son los publicados el 26-oct-2026 y pueden cambiar.

| | Free | Launch | Scale |
|---|---|---|---|
| Precio base | 0 por mes | Pago por uso, sin mínimo mensual | Pago por uso, sin mínimo mensual |
| Cómputo | 100 CU-hora por proyecto | 0,106 por CU-hora | 0,222 por CU-hora |
| Autoescalado | Hasta 2 CU (8 GB de RAM) | Hasta 16 CU (64 GB) | Hasta 16 CU, o tamaños fijos hasta 56 CU |
| Escalar a cero | A los 5 min, no se puede desactivar | A los 5 min, se puede desactivar | Configurable (de 1 minuto a siempre activo) |
| Almacenamiento | 1 GB por proyecto, 20 GB por cuenta | 0,35 por GB-mes | 0,35 por GB-mes |
| Historial para restaurar (PITR) | 6 horas (tope de 1 GB de historial) | Predeterminado 1 día, hasta 7 días | Predeterminado 1 día, hasta 30 días |
| Costo del historial | Sin costo | 0,20 por GB-mes | 0,20 por GB-mes |
| Proyectos | 100 | 100 | 1.000 (ampliable a pedido) |
| Ramas por proyecto | 10 | 10 (ramas extra: 1,50 por rama-mes) | 25 (ramas extra: 1,50 por rama-mes) |

- Una **CU** equivale a unas 4 GB de RAM más CPU y disco local asociados ([uso y facturación](https://neon.com/docs/introduction/usage-metrics)). Tamaños fijos de 0,25 CU a 56 CU; el autoescalado cubre 0,25 a 16 CU, con una diferencia máxima de 8 CU entre mínimo y máximo ([cómputo](https://neon.com/docs/manage/endpoints)).
- Con una sola base compartida por todos los restaurantes (ADR-016), el proyecto es uno solo; el plan se paga por proyecto/organización, no por restaurante. **Costo por restaurante: No documentado** (depende del uso); el ADR lo marca «validar».
- **Cálculo propio, no es una cifra publicada:** un cómputo de 0,25 CU activo las 24 horas del mes (730 h) sería 0,25 × 730 × 0,106 = 19,3 USD de cómputo en Launch, más almacenamiento. Con escalar a cero el cómputo se factura solo mientras está activo ([escalar a cero](https://neon.com/docs/introduction/scale-to-zero)).
- Neon recomienda un plan de pago en producción porque es por uso («tu app no se detiene ni se limita al crecer»); Free está pensado para prototipos ([lista de producción](https://neon.com/docs/get-started/production-checklist)).
- **Límite de conexiones de la base** (directas) por tamaño de cómputo: 104 con 0,25 CU, 209 con 0,5 CU, 419 con 1 CU; 7 reservadas para el superusuario de Neon ([pooling de Neon](https://neon.com/docs/connect/connection-pooling)). El pooler de Neon admite hasta 10.000 conexiones de cliente. Hyperdrive abre como máximo ~20 (Free) o ~100 (Paid) conexiones de origen por configuración ([límites](https://developers.cloudflare.com/hyperdrive/platform/limits/)), así que quedan por debajo de los topes de Neon.

### 6.3 Escalar a cero y arranque en frío

- Neon suspende el cómputo tras **5 minutos** de inactividad; la siguiente consulta lo despierta «en unos cientos de milisegundos» ([escalar a cero](https://neon.com/docs/introduction/scale-to-zero)). No hay una cifra más precisa documentada.
- Solo disponible en cómputos de hasta 16 CU (misma fuente).
- La página no dice qué pasa con las conexiones ya abiertas (ni las del pool de Hyperdrive) al suspender o reanudar: **No documentado**. Para un restaurante con hub que sube cada evento al instante, el primer evento tras 5 minutos sin tráfico pagaría ese arranque (cientos de ms según Neon). Neon sugiere desactivar el escalado a cero si se necesita latencia baja constante o si el arranque en frío es inaceptable en solicitudes de cara al usuario ([lista de producción](https://neon.com/docs/get-started/production-checklist)); en Launch se puede desactivar, en Free no.

### 6.4 Respaldos y restauración a un momento dado

Fuentes: [restauración de ramas](https://neon.com/docs/introduction/branch-restore), [ventana de historial](https://neon.com/docs/postgres/backup-restore/history-window), [respaldos y restauración](https://neon.com/docs/guides/backup-restore).

- **Restauración instantánea (PITR):** revierte una rama **raíz** a cualquier momento dentro de la ventana de historial, «hasta el milisegundo». Solo se restauran ramas raíz.
- **Ventana por plan:**

| Plan | Predeterminada | Máxima |
|---|---|---|
| Free | 6 horas | 6 horas (tope de 1 GB de historial) |
| Launch | 1 día | 7 días |
| Scale | 1 día | 30 días |

- La ventana se configura en la consola (Settings, Postgres, «History window») o con la propiedad `history_retention_seconds` del proyecto (21.600 s = 6 h, 86.400 = 1 día, 604.800 = 7 días, 2.592.000 = 30 días). Aplica a **todas** las ramas del proyecto. En ventana 0 se desactiva la restauración instantánea ([ventana de historial](https://neon.com/docs/postgres/backup-restore/history-window)). En proyectos de pago el valor inicial es 1 día: hay que subirlo a mano para tener 7 o 30 (según un resumen de búsqueda de esa misma documentación; confirmar en la consola).
- **Cómo se restaura:** consola (página Restore); CLI `neon branches restore <destino> <origen@marca_de_tiempo|lsn>`, por ejemplo `neon branches restore development ^self@2024-01-01T00:00:00Z --preserve-under-name development_old`; o API `POST /projects/{project_id}/branches/{branch_id}/restore` ([branch-restore](https://neon.com/docs/introduction/branch-restore)). Marcas de tiempo en formato RFC 3339.
- **Efecto:** es una sobrescritura completa de la línea de tiempo (no una mezcla), afecta a **todas las bases** de la rama, y guarda el estado previo en una rama de respaldo `{rama}_old_{marca}`. Las conexiones existentes se cortan un momento, pero los datos de conexión no cambian (misma fuente).
- **Instantáneas (snapshots):** manuales (1 en Free, 100 en planes de pago) y programadas diaria, semanal o mensualmente en planes de pago, solo en ramas raíz; las programadas se conservan 35 días por defecto (también es el máximo). Se facturan a 0,09 por GB-mes ([respaldos](https://neon.com/docs/guides/backup-restore)).
- Un proyecto borrado se puede recuperar dentro de 7 días, aparte de la ventana de historial ([proyectos](https://neon.com/docs/manage/projects)).
- **`pg_dump`:** Neon indica la conexión **directa** (sin `-pooler`) para `pg_dump`/`pg_restore` y migraciones ([pooling](https://neon.com/docs/connect/connection-pooling)). Un respaldo externo programado (por ejemplo a otro proveedor): No documentado por Neon como servicio.

### 6.5 Ramas para desarrollo

- Una rama es un clon «copy-on-write»; crear una no cuesta carga a la rama madre y se puede ramificar el estado actual o uno pasado ([ramas](https://neon.com/docs/introduction/branching)). Hay pruebas en paralelo con una rama (y cómputo) propia cada una.
- **Aviso para Faro:** una rama de producción trae los datos reales de los restaurantes. Si se usa para desarrollo habría que borrar o anonimizar datos; el procedimiento: No documentado en las páginas leídas. Opción simple: ramificar mientras la base está vacía o crear un proyecto de desarrollo aparte (100 proyectos incluso en Free).
- El tope de ramas por proyecto (10 en Free y Launch, 25 en Scale) y su costo extra están en la tabla de 6.2.
- Neon recomienda correr las migraciones por conexión directa ([pooling](https://neon.com/docs/connect/connection-pooling)).

### 6.6 Seguridad por fila (RLS)

- Es una función estándar de Postgres: `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` y `CREATE POLICY`. Con RLS activado y sin política, aplica una política de denegar todo ([Postgres](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)).
- **Quién se la salta:** superusuarios y roles con `BYPASSRLS`; los dueños de la tabla normalmente también, salvo que se use `ALTER TABLE ... FORCE ROW LEVEL SECURITY` (misma fuente). Solo el dueño de la tabla puede activarla o crear políticas.
- **En Neon:** los roles creados por consola, CLI o API (incluido el rol por defecto `neondb_owner`) son miembros de `neon_superuser`, que incluye `BYPASSRLS` ([roles de Neon](https://neon.com/docs/manage/roles)). Esa página dice que un rol creado con SQL (`CREATE ROLE nombre WITH LOGIN PASSWORD '...'`) no se añade a `neon_superuser`, aunque no afirma por escrito que eso lo deje sin `BYPASSRLS`: **verificar en el proyecto real**. Consecuencia para Faro: la API no debe conectarse con el rol creado por la consola; hay que crear con SQL un rol de aplicación sin privilegios de más, y darle solo lo necesario.
- **Cómo pasar el restaurante a las políticas con Hyperdrive:** el pool es en modo transacción y `SET` solo dura dentro de la transacción ([pooling de Hyperdrive](https://developers.cloudflare.com/hyperdrive/concepts/connection-pooling/)). Postgres ofrece `set_config(nombre, valor, true)`, cuyo valor aplica solo durante la transacción actual ([funciones de administración](https://www.postgresql.org/docs/current/functions-admin.html)). Es decir: `BEGIN; SELECT set_config('app.restaurant_id', $1, true); ...; COMMIT;`, y las políticas leen ese valor. Esa combinación es una **inferencia a partir de dos fuentes**; no hay un ejemplo oficial de RLS con Hyperdrive. Requiere prueba (ver preguntas abiertas).
- Neon documenta también RLS para su «Data API» con JWT; no aplica a Faro (la API es nuestro Worker) ([guía RLS de Neon](https://neon.com/docs/guides/rls-drizzle)). Esa guía indica correr las migraciones y políticas por conexión directa.

## 7. Pregunta 4: Workers e Hyperdrive, precios y límites

### 7.1 Workers

Fuentes: [precios](https://developers.cloudflare.com/workers/platform/pricing/), [límites](https://developers.cloudflare.com/workers/platform/limits/). Precios en USD.

| | Workers Free | Workers Paid |
|---|---|---|
| Suscripción | 0 | Mínimo 5 por mes por cuenta |
| Solicitudes | 100.000 por día | 10 millones al mes incluidos, luego 0,30 por millón |
| Tiempo de CPU facturado | — | 30 millones de ms al mes incluidos, luego 0,02 por millón de ms |
| CPU por solicitud HTTP | 10 ms | Hasta 5 min (predeterminado 30 s) |
| Subrequests por solicitud | 50 | 10.000 |
| Memoria por aislado | 128 MB | 128 MB |
| Conexiones salientes simultáneas por solicitud | 6 | 6 |
| Variables de entorno por Worker (incluye secretos) | 64 | 128 |
| Tamaño de variable | 5 KB | 5 KB |
| Número de Workers | 100 | 500 |
| Duración de la solicitud | Sin límite (HTTP) | Sin límite (HTTP) |

- **Tamaño del cuerpo de la solicitud:** depende del plan de Cloudflare de la zona, no del plan de Workers: 100 MB en Free y Pro, 200 MB en Business, hasta 5 GB en Enterprise ([límites](https://developers.cloudflare.com/workers/platform/limits/)). Un lote de eventos normal está muy por debajo.
- Se factura por solicitudes entrantes más CPU; los subrequests no se cobran; no hay cargo por transferencia (egress) ([precios](https://developers.cloudflare.com/workers/platform/pricing/)).
- En el plan Free, 10 ms de CPU por solicitud son pocos para parsear y validar un lote grande; con el plan Paid el límite es mucho mayor. **Si las consultas a Hyperdrive cuentan como subrequests:** No documentado en las páginas leídas.
- Costo por restaurante: No documentado (depende del tráfico).

### 7.2 Hyperdrive

Fuentes: [precios](https://developers.cloudflare.com/hyperdrive/platform/pricing/), [límites](https://developers.cloudflare.com/hyperdrive/platform/limits/).

| | Free | Paid |
|---|---|---|
| Incluido | Sí | Sí |
| Consultas | 100.000 por día (reinicia a las 00:00 UTC); al pasarse, las operaciones fallan con error | Ilimitadas |
| Pooling y caché | Sin cargo | Sin cargo |
| Transferencia de datos (egress) | Sin cargo | Sin cargo |
| Configuraciones por cuenta | 10 | 25 |
| Conexiones de origen máximas por configuración | ~20 | ~100 |
| Tiempo de conexión inicial | 15 s | 15 s |
| Tiempo de inactividad de conexión | 10 min | 10 min |
| Duración máxima de una sentencia | 60 s | 60 s |
| Respuesta máxima cacheada | 50 MB | 50 MB |

- Una «consulta» es cualquier sentencia que pase por Hyperdrive (lecturas, escrituras, cambios de esquema), cacheada o no. Si la definición es literal, `BEGIN`, cada `INSERT` y `COMMIT` cuentan por separado; un lote en una sola sentencia gasta menos de la cuota Free.
- El máximo de conexiones de origen es un límite blando: puede excederse brevemente ([pooling](https://developers.cloudflare.com/hyperdrive/concepts/connection-pooling/)).
- Hyperdrive «no limita las conexiones de cliente concurrentes desde Workers».

### 7.3 Secretos

- `npx wrangler secret put <NOMBRE>`: crea la versión y la despliega de inmediato. Con despliegues graduales: `npx wrangler versions secret put <NOMBRE>` y luego `wrangler versions deploy` ([secretos](https://developers.cloudflare.com/workers/configuration/secrets/)).
- Los valores quedan ocultos en Wrangler y en el panel después de definirlos. Cloudflare avisa: no usar `vars` (texto plano) en `wrangler.jsonc` para datos sensibles ([variables de entorno](https://developers.cloudflare.com/workers/configuration/environment-variables/)).
- Secretos locales en `.dev.vars` o `.env`, no se versionan.
- Alcance: un secreto es de un solo Worker; para secretos de toda la cuenta existe Secrets Store (misma fuente).
- **Con Hyperdrive, la cadena de conexión no es un secreto del Worker:** se entrega al crear la configuración y el Worker solo recibe `env.HYPERDRIVE.connectionString`. La [guía de Neon](https://neon.com/docs/guides/cloudflare-workers) lo confirma al decir que no se necesita un secreto porque la conexión está definida en `wrangler.jsonc` (es decir, en la configuración de Hyperdrive). Cómo guarda Cloudflare internamente las credenciales: **No documentado** en [rotar credenciales](https://developers.cloudflare.com/hyperdrive/configuration/rotate-credentials/). Para rotar: crear una configuración nueva (`wrangler hyperdrive create`) y actualizar el `id` del binding, o `wrangler hyperdrive update <ID>` con los datos nuevos (misma página).
- **Otros secretos de Faro** (por ejemplo la clave para firmar las credenciales de los hubs, ADR-016): `wrangler secret put`. Su diseño no está en la documentación de los proveedores.

## 8. Pregunta 5: pruebas en local sin Neon

### 8.1 PGlite (`@electric-sql/pglite`)

- Es una compilación completa de Postgres a WASM, de menos de 3 MB comprimida; corre en el navegador, Node.js, Bun y Deno; en memoria por defecto, o persistente en el sistema de archivos ([pglite.dev](https://pglite.dev/), [README](https://github.com/electric-sql/pglite), [acerca de](https://pglite.dev/docs/about)). Instalar: `npm install @electric-sql/pglite` ([docs](https://pglite.dev/docs/)).
- **Uso en Node:** `new PGlite()` (memoria) o `new PGlite('./ruta')`; `.query` (una sentencia con parámetros), `.exec` (varias sentencias, sin parámetros) y `.transaction(async tx => ...)` con commit y rollback automáticos ([API](https://pglite.dev/docs/api)). La opción `username` aplica los permisos en el contexto de ese usuario.
- **Estado y límites:** el README muestra «Status - Alpha» y dice que «PGlite is single user/connection» ([README](https://github.com/electric-sql/pglite)). Es un solo usuario/una sola conexión, así que **no sirve para probar concurrencia real** ni el pool.
- **Versión de Postgres:** **No documentada** en las páginas oficiales leídas (el README solo cita una bifurcación `postgres-pglite`). Una fuente de terceros menciona la 17; no se tomó como válida. Neon crea proyectos nuevos en Postgres 18 ([CLI](https://neon.com/docs/reference/cli-projects)); si las versiones difieren hay riesgo de diferencias.
- **Actualizaciones:** los cambios de versión menor pueden romper compatibilidad y la ruta es `pg_dump` y reimportar ([upgrade](https://pglite.dev/docs/upgrade)). Para pruebas efímeras en memoria no afecta.
- **Compatibilidad con RLS, roles múltiples, `jsonb_to_recordset`, `ON CONFLICT`:** **No documentada** en las páginas leídas. `ON CONFLICT` y `jsonb_to_recordset` son Postgres estándar y deberían funcionar, pero hay que verificarlo con una prueba. RLS y roles (la parte más delicada para Faro): probar y, si falla, usar Postgres real.
- **Servidor por socket:** `@electric-sql/pglite-socket` (`PGLiteSocketServer`) permite conectar clientes `pg`, postgres.js y psql a PGlite; **no admite SSL**; la multiplexación de varios clientes sobre una conexión no está garantizada para todos los casos ([docs](https://pglite.dev/docs/pglite-socket)). Sirve en teoría para apuntar `localConnectionString` de `wrangler dev` a PGlite; **no está documentado** que Wrangler/Miniflare lo soporte: probarlo.
- **¿Sirve en CI?** Corre en Node sin instalar nada aparte ([README](https://github.com/electric-sql/pglite)), así que no necesita servicio externo. No hay página oficial que lo valide para CI; en la práctica es una dependencia npm más. Por ser Alpha y de una sola conexión, no reemplaza una prueba contra Postgres real.

### 8.2 Probar el Worker

- **Recomendación actual de Cloudflare** ([pruebas](https://developers.cloudflare.com/workers/testing/)): la integración Vitest para pruebas unitarias y `createTestHarness()` para pruebas de integración.
- **Integración Vitest:** paquete `@cloudflare/vitest-plugin` (antes `@cloudflare/vitest-pool-workers`); requiere **Vitest 4.1 o superior**, módulos ES y fecha de compatibilidad `2022-10-31` o posterior; instalar con `pnpm add -D vitest@^4.1.0 @cloudflare/vitest-plugin`; la configuración lee el `wrangler.jsonc` con `cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })` ([primera prueba](https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/)). Las pruebas corren en el runtime de Workers (Miniflare). La API de configuración no cambió con el renombre, y hay un codemod: `npx @cloudflare/codemods vitest:pool-workers-to-vitest-plugin` ([aviso](https://developers.cloudflare.com/changelog/post/2026-08-19-vitest-plugin/)).
- **Para este repositorio:** antes de adoptar el plugin hay que confirmar qué versión de Vitest usa el monorepo, porque el plugin exige 4.1 o superior.
- **`createTestHarness()`:** se importa de `wrangler` (`import { createTestHarness } from "wrangler"`), se inicia con `server.listen()`, se reinicia con `server.reset()` y se cierra con `server.close()`; sirve con cualquier ejecutor de pruebas de Node ([primeros pasos](https://developers.cloudflare.com/workers/testing/test-harness/get-started/)). **No documentado** el estado (beta o estable) ni cómo trata los bindings como Hyperdrive.
- **`unstable_dev`:** **obsoleto**; Cloudflare recomienda `createTestHarness()` ([API de Wrangler](https://developers.cloudflare.com/workers/wrangler/api/)). No usarlo.
- **Cómo se prueba Hyperdrive en las pruebas:** **No documentado** en las páginas leídas del plugin ni del harness. Consecuencia práctica: separar el acceso a la base en un módulo con una interfaz mínima (`query(texto, parámetros)`), probar ese módulo con PGlite o Postgres real, y probar el manejador HTTP con un sustituto. Esta es una sugerencia de diseño, no de la documentación.
- Para simular peticiones salientes en pruebas de Workers, Cloudflare recomienda `@msw/cloudflare` ([aviso](https://developers.cloudflare.com/changelog/post/2026-08-19-vitest-plugin/)).

## 9. Pregunta 6: CLI

### 9.1 Wrangler

Todos con `npx wrangler ...` ([comandos de Hyperdrive](https://developers.cloudflare.com/workers/wrangler/commands/hyperdrive/), [guía de inicio](https://developers.cloudflare.com/hyperdrive/get-started/), [secretos](https://developers.cloudflare.com/workers/configuration/secrets/)):

```sh
# 1. Iniciar sesión (abre el navegador)
npx wrangler login

# 2. Crear la configuración de Hyperdrive (verifica las credenciales al crearla)
#    Cadena SIN pooler de Neon. Desactivar la caché (ver 4.6).
npx wrangler hyperdrive create faro-neon --connection-string="postgres://USUARIO:CLAVE@HOST:5432/BASE" --caching-disabled

# 3. Otros comandos de Hyperdrive
npx wrangler hyperdrive list
npx wrangler hyperdrive get <ID>
npx wrangler hyperdrive update <ID> --caching-disabled   # o con nuevas credenciales
npx wrangler hyperdrive delete <ID>

# 4. Local
npx wrangler dev

# 5. Secretos del Worker
npx wrangler secret put NOMBRE_DEL_SECRETO

# 6. Desplegar
npx wrangler deploy
```

- `hyperdrive create` también acepta `--origin-host`, `--origin-port`, `--database`, `--origin-user`, `--origin-password`, `--sslmode` (`require`, `verify-ca`, `verify-full`), `--origin-connection-limit`, `--max-age`, `--swr`, `--binding` y `--update-config` ([comandos](https://developers.cloudflare.com/workers/wrangler/commands/hyperdrive/)). La guía de Neon dice que `create` ofrece agregar el binding automáticamente.
- **La cadena con la clave puede quedar en el historial de la terminal** (observación propia, no está en la documentación). La documentación no ofrece otra vía por CLI (como leer la clave de un archivo); se puede crear la configuración desde el panel web de Hyperdrive en vez del CLI ([ejemplo de Neon](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-database-providers/neon/): «Dashboard: ir a Hyperdrive, Create Configuration»).
- **Despliegue desde CI (si algún día se automatiza):** `cloudflare/wrangler-action@v4` con los secretos `CLOUDFLARE_API_TOKEN` (permiso «Edit Cloudflare Workers», limitado a la cuenta) y `CLOUDFLARE_ACCOUNT_ID` ([GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)). La página de creación de tokens no confirma permisos de Hyperdrive: **No documentado** (pregunta abierta).

### 9.2 CLI de Neon

Existe. **Nombre del paquete y del comando: la documentación se contradice.**

- La [documentación del CLI en neon.com](https://neon.com/docs/reference/neon-cli) dice: paquete npm `neon` (`npm i -g neon`), comando `neon`, y que «`neonctl` es un alias de `neon`».
- El [repositorio `neondatabase/neonctl`](https://github.com/neondatabase/neonctl) (archivado, de solo lectura; el desarrollo se mudó a `neondatabase/neon-pkgs`) dice: `npm i -g neonctl` o `brew install neonctl`, y usa el comando `neonctl`.
- Acción: probar `neonctl --version` y `neon --version` al instalar; los subcomandos son los mismos.

Autenticación: `neon login` (o `neonctl auth`) abre el navegador; o `--api-key` / variable `NEON_API_KEY` para uso sin interacción ([CLI](https://neon.com/docs/reference/neon-cli)). Las claves de API pueden ser personales, de organización o de un solo proyecto; el valor se muestra una sola vez ([claves de API](https://neon.com/docs/manage/api-keys)).

Comandos (con el nombre `neon`; reemplazable por `neonctl`):

```sh
# Crear el proyecto (CLI usa Postgres 18; la base por defecto se llama neondb)
neon projects create --name faro --region-id aws-sa-east-1 --output json

# Crear una base y un rol (el rol creado por CLI es miembro de neon_superuser; ver 6.6)
neon databases create --name faro
neon roles create --name faro_api

# Cadena de conexión (directa, sin pooler, para Hyperdrive y migraciones)
neon connection-string
# Con pooler (solo para el driver serverless de Neon)
neon connection-string --pooled
# Ramas
neon branches create --name desarrollo
neon branches restore main ^self@2026-11-01T00:00:00Z --preserve-under-name main_antes
```

- `neon projects create` acepta `--name`, `--region-id`, `--pg-version` (14 a 19), `--org-id`, `--database`, `--role`, `--cu` y otros ([proyectos](https://neon.com/docs/reference/cli-projects)).
- `neon connection-string [rama]` usa la rama por defecto si se omite; `--role-name` (por defecto `neondb_owner`), `--database-name`, `--pooled`, `--ssl` (por defecto `require`) ([connection-string](https://neon.com/docs/reference/cli-connection-string)).
- `neon databases create --name <nombre> [--owner-name <rol>]` ([databases](https://neon.com/docs/reference/cli-databases)); `neon roles create --name <nombre>` ([roles](https://neon.com/docs/reference/cli-roles)).
- Los ejemplos de `branches create` y `branches restore` siguen la sintaxis de la [documentación de restauración](https://neon.com/docs/introduction/branch-restore) y de la lista de comandos del [CLI](https://neon.com/docs/reference/neon-cli); las opciones exactas de `branches create` no se leyeron: **verificar con `neon branches create --help`**.
- **Importante:** `neon connection-string` imprime la clave en la pantalla. Quien ejecute estos comandos ve la clave: debe ser el dueño en su propio equipo (ver sección 10.2).

## 10. Recomendación para Faro

### 10.1 Conexión recomendada: Hyperdrive + `pg` (node-postgres)

Razones:

1. **Es lo que recomiendan Cloudflare y Neon** para Workers con Neon, y Cloudflare dice que `pg` es el driver con mejor compatibilidad con Hyperdrive ([ejemplo con pg](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/node-postgres/)).
2. **El hub sube lotes de eventos**, y el diseño idempotente (`ON CONFLICT DO NOTHING` por `(restaurant_id, id)`) y la seguridad por fila piden transacciones interactivas (`BEGIN`, `set_config(..., true)`, inserciones, `COMMIT`). El driver HTTP de Neon no las admite; el de WebSocket sí, pero Neon mismo remite a Hyperdrive.
3. **No hay una clave de Neon dentro del Worker**: el dueño la pega una vez en la configuración de Hyperdrive; el Worker solo recibe `env.HYPERDRIVE.connectionString`. Menos secretos que cuidar.
4. **Costo**: Hyperdrive va incluido en Workers Free y Paid, sin cargo de pooling, caché ni transferencia.
5. **Un lote = una sentencia** (con `jsonb_to_recordset` y `ON CONFLICT DO NOTHING`), dentro de una transacción corta que también fija el restaurante para RLS. Esto minimiza las consultas contadas por Hyperdrive y mantiene la transacción breve, como pide Cloudflare.

Ajustes recomendados (cada uno con su fuente arriba):

- Crear la configuración de Hyperdrive con `--caching-disabled` (la caché de 60 s por defecto puede devolver la carta vieja; ver 4.6).
- Usar la cadena **directa** de Neon (sin `-pooler`) en Hyperdrive; la del pooler solo para el driver serverless.
- Rol de aplicación creado con SQL, sin privilegios de superusuario, y comprobar que **no** se salta RLS. Migraciones con otro rol, por conexión directa, desde el equipo del dueño o de quien él autorice.
- Plan de pago de Neon en producción (Launch al menos), con la ventana de historial subida a 7 días y valorando snapshots programados. En Free solo hay 6 horas de restauración.
- Workers Paid (5 USD al mes) cuando haya restaurantes reales: Free permite 10 ms de CPU y 100.000 solicitudes diarias.
- Región: medir antes de decidir entre `aws-sa-east-1` y `aws-us-east-1` (ADR-016 ya lo marca «validar»); no hay cifras oficiales de latencia desde Colombia.
- Pruebas: Vitest con `@cloudflare/vitest-plugin` para el Worker y PGlite (con aviso de Alpha, una sola conexión y sin garantías de RLS) para el SQL; una prueba periódica contra una rama de Neon para lo que PGlite no cubre (roles, RLS, pooler).
- Desarrollo local: `localConnectionString` por **variable de entorno**, apuntando a PGlite por socket, a Postgres local o a una rama de Neon de desarrollo; nunca `wrangler dev --remote` contra la configuración de producción.

### 10.2 Lo que debe hacer el dueño a mano (nadie más ve sus credenciales)

Regla general: cada clave se copia **del panel del proveedor al lugar de destino** sin pasar por chat, correo ni el repositorio. La clave nunca se pega en conversaciones con la IA ni en archivos del proyecto.

1. **Crear la cuenta de Cloudflare** en https://dash.cloudflare.com/sign-up, con correo propio y verificación en dos pasos. Debe ver el panel de Cloudflare en pantalla.
2. **Pasar Workers a plan de pago** cuando haya clientes reales: en el panel, Workers & Pages, Plans, Paid. Pide tarjeta. Mínimo de USD 5 al mes ([precios](https://developers.cloudflare.com/workers/platform/pricing/)). Los nombres exactos de los menús del panel no se verificaron.
3. **Crear la cuenta de Neon** en https://console.neon.tech con correo propio y verificación en dos pasos si está disponible. Crear el proyecto `faro`, con región São Paulo (o la que se decida tras medir) y Postgres 18. Debe ver el panel con una rama `main` y la base `neondb`.
4. **Elegir el plan de Neon**: para producción, Launch (pago por uso), con la tarjeta del dueño. Subir la ventana de historial: Settings, Postgres, «History window», 7 días, Save ([ventana](https://neon.com/docs/postgres/backup-restore/history-window)).
5. **Crear los roles de base de datos** (lo hace el dueño, o quien él autorice **sin ver las claves**):
   - un **rol de migraciones** (el que crea tablas): puede ser el rol por defecto de Neon, solo para migrar;
   - un **rol de aplicación** creado con SQL (`CREATE ROLE faro_api WITH LOGIN PASSWORD '...'`) en el editor SQL de la consola de Neon, con la clave generada por un gestor de contraseñas.
   - Copiar la clave del rol **en el momento**: Neon la muestra una sola vez ([guía de Neon](https://neon.com/docs/guides/cloudflare-workers)) cuando el rol se crea en la consola; si se crea con SQL, la clave es la que el dueño escribió.
6. **Copiar la cadena de conexión directa**: en el panel de Neon, botón «Connect», elegir rama `main`, la base y el rol de **aplicación**, **desmarcar «Connection pooling»** y copiar. Debe empezar con `postgres://faro_api@ep-...` y **no** debe contener `-pooler`.
7. **Crear la configuración de Hyperdrive en su propio equipo** (la clave nunca sale de su pantalla):
   - Abrir una terminal, `npx wrangler login`, aceptar en el navegador.
   - `npx wrangler hyperdrive create faro-neon --connection-string="..." --caching-disabled` (o, sin terminal, Cloudflare, Hyperdrive, Create Configuration). Debe ver el mensaje con el `id` de la configuración; ese `id` **no es un secreto** y sí se puede compartir para el `wrangler.jsonc`.
8. **Guardar la cadena de migraciones** en su equipo, en un gestor de contraseñas o una variable de entorno local, y **no** en el repositorio. Quien migre la base la usa desde su equipo y no la comparte.
9. **Crear un token de API de Cloudflare** solo si se automatiza el despliegue: My Profile, API Tokens, Create Token, con permiso de editar Workers y limitado a su cuenta. Se muestra una sola vez ([crear token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)). Guardarlo en un gestor de contraseñas.
10. **Si el despliegue lo hace otra persona**, debe hacerlo con su propia sesión (`wrangler login`) o con un token limitado, nunca con la contraseña del dueño. Los roles y permisos de miembros de una cuenta de Cloudflare: No documentado en esta consulta.
11. **Rotar** si una clave se filtra: en Neon, restablecer la contraseña del rol y actualizar Hyperdrive con `npx wrangler hyperdrive update <ID> ...` ([rotación](https://developers.cloudflare.com/hyperdrive/configuration/rotate-credentials/)).

## 11. Preguntas abiertas

Para Neon:

1. ¿Se puede crear un proyecto directamente en `aws-sa-east-1` por CLI y consola hoy (la referencia del CLI no la lista)? ¿Se puede **cambiar la región** de un proyecto existente?
2. Latencia medida desde Colombia a São Paulo y a Virginia (hay que medirla; no hay cifras publicadas).
3. ¿Qué pasa con las conexiones abiertas (incluidas las del pool de Hyperdrive) cuando el cómputo se suspende y se reanuda? ¿Hay un tiempo de arranque garantizado, más allá de «unos cientos de milisegundos»?
4. ¿Un rol creado con `CREATE ROLE` en SQL queda sin `BYPASSRLS`? (La página de roles no lo dice expresamente.)
5. ¿Hay límite de conexiones o de consultas por segundo del plan Launch en el pooler o en el cómputo directo para varios cientos de hubs?
6. ¿Cómo se anonimiza o se limita lo que trae una rama de desarrollo hecha desde producción?
7. ¿Qué respaldo externo (fuera de Neon, por ejemplo `pg_dump` programado) recomienda Neon para tener una copia independiente?
8. ¿Cuál es el nombre correcto del paquete y del comando del CLI (`neon` o `neonctl`)?

Para Cloudflare:

9. ¿Las consultas a Hyperdrive cuentan contra el límite de subrequests del Worker (50 en Free, 10.000 en Paid)?
10. ¿Cómo prueba Cloudflare un Worker con Hyperdrive dentro de `@cloudflare/vitest-plugin` y de `createTestHarness()`? ¿Se puede apuntar el binding a un Postgres local o a PGlite?
11. ¿`createTestHarness()` es estable o beta?
12. ¿Qué permisos de token exige `wrangler hyperdrive create` y `wrangler deploy` con Hyperdrive?
13. ¿Cómo guarda Cloudflare internamente las credenciales de la configuración de Hyperdrive? ¿Hay una forma de crear la configuración sin dejar la clave en el historial de la terminal?
14. ¿El formato JSONC de la pista de ubicación del Worker es `"placement": { "region": "aws:sa-east-1" }`? La página lo describe en TOML.

Para PGlite:

15. ¿Qué versión de Postgres usa la versión actual de PGlite y soporta RLS, roles múltiples y `set_config` local de transacción?

Para el diseño de Faro (con el proveedor y con el equipo):

16. Tamaño máximo recomendado de un lote (número de eventos) y tamaño del parámetro `jsonb`: no hay límite documentado por Postgres en las páginas leídas ni por Hyperdrive; los topes conocidos son 100 MB de cuerpo (Workers) y 60 s por sentencia (Hyperdrive).
17. Combinación de RLS con `set_config(..., true)` dentro de una transacción de Hyperdrive: no hay ejemplo oficial; requiere una prueba propia antes de la tarea 1.10.

## 12. Enlaces

**Cloudflare Hyperdrive**
- [Conectar Neon con Hyperdrive](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-database-providers/neon/)
- [Ejemplo con node-postgres](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/node-postgres/)
- [Ejemplo con postgres.js](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/postgres-js/)
- [Guía de inicio](https://developers.cloudflare.com/hyperdrive/get-started/)
- [Pooling y modo transacción](https://developers.cloudflare.com/hyperdrive/concepts/connection-pooling/)
- [Cómo funciona](https://developers.cloudflare.com/hyperdrive/concepts/how-hyperdrive-works/)
- [Caché de consultas](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/)
- [Desarrollo local](https://developers.cloudflare.com/hyperdrive/configuration/local-development/)
- [Rotar credenciales](https://developers.cloudflare.com/hyperdrive/configuration/rotate-credentials/)
- [Bases y funciones soportadas](https://developers.cloudflare.com/hyperdrive/reference/supported-databases-and-features/)
- [Precios](https://developers.cloudflare.com/hyperdrive/platform/pricing/)
- [Límites](https://developers.cloudflare.com/hyperdrive/platform/limits/)
- [Solución de problemas](https://developers.cloudflare.com/hyperdrive/observability/troubleshooting/)
- [Comandos `wrangler hyperdrive`](https://developers.cloudflare.com/workers/wrangler/commands/hyperdrive/)

**Cloudflare Workers**
- [Conectar a bases de datos](https://developers.cloudflare.com/workers/databases/connecting-to-databases/)
- [Neon en Workers](https://developers.cloudflare.com/workers/databases/third-party-integrations/neon/)
- [Precios](https://developers.cloudflare.com/workers/platform/pricing/)
- [Límites](https://developers.cloudflare.com/workers/platform/limits/)
- [Secretos](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Variables de entorno](https://developers.cloudflare.com/workers/configuration/environment-variables/)
- [Compatibilidad con Node.js](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)
- [Ubicación (Smart Placement)](https://developers.cloudflare.com/workers/configuration/placement/)
- [Comandos generales de Wrangler](https://developers.cloudflare.com/workers/wrangler/commands/general/)
- [API de Wrangler (`unstable_dev` obsoleto)](https://developers.cloudflare.com/workers/wrangler/api/)
- [Pruebas](https://developers.cloudflare.com/workers/testing/)
- [Integración Vitest: primera prueba](https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/)
- [Renombre a `@cloudflare/vitest-plugin`](https://developers.cloudflare.com/changelog/post/2026-08-19-vitest-plugin/)
- [`createTestHarness()`](https://developers.cloudflare.com/workers/testing/test-harness/get-started/)
- [Crear un token de API](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/)
- [GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)

**Neon**
- [Guía de Cloudflare Workers](https://neon.com/docs/guides/cloudflare-workers)
- [Driver serverless](https://neon.com/docs/serverless/serverless-driver) y [repositorio](https://github.com/neondatabase/serverless)
- [Regiones](https://neon.com/docs/introduction/regions)
- [Planes](https://neon.com/docs/introduction/plans) y [uso y facturación](https://neon.com/docs/introduction/usage-metrics)
- [Escalar a cero](https://neon.com/docs/introduction/scale-to-zero) y [cómputo](https://neon.com/docs/manage/endpoints)
- [Ramas](https://neon.com/docs/introduction/branching)
- [Restauración](https://neon.com/docs/introduction/branch-restore), [ventana de historial](https://neon.com/docs/postgres/backup-restore/history-window) y [respaldos](https://neon.com/docs/guides/backup-restore)
- [Pooling de conexiones](https://neon.com/docs/connect/connection-pooling)
- [Roles](https://neon.com/docs/manage/roles) y [guía de RLS](https://neon.com/docs/guides/rls-drizzle)
- [Lista para producción](https://neon.com/docs/get-started/production-checklist) y [proyectos](https://neon.com/docs/manage/projects)
- [CLI](https://neon.com/docs/reference/neon-cli), [proyectos](https://neon.com/docs/reference/cli-projects), [connection-string](https://neon.com/docs/reference/cli-connection-string), [databases](https://neon.com/docs/reference/cli-databases), [roles](https://neon.com/docs/reference/cli-roles), [claves de API](https://neon.com/docs/manage/api-keys) y [repositorio neonctl](https://github.com/neondatabase/neonctl)

**Postgres y drivers**
- [RLS](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)
- [INSERT](https://www.postgresql.org/docs/current/sql-insert.html)
- [Funciones JSON](https://www.postgresql.org/docs/current/functions-json.html)
- [`set_config`](https://www.postgresql.org/docs/current/functions-admin.html)
- [Transacciones](https://www.postgresql.org/docs/current/tutorial-transactions.html)
- [node-postgres: transacciones](https://node-postgres.com/features/transactions)
- [postgres.js](https://github.com/porsager/postgres)

**PGlite**
- [Inicio](https://pglite.dev/), [documentación](https://pglite.dev/docs/), [API](https://pglite.dev/docs/api), [acerca de](https://pglite.dev/docs/about), [socket](https://pglite.dev/docs/pglite-socket), [actualizaciones](https://pglite.dev/docs/upgrade) y [repositorio](https://github.com/electric-sql/pglite)
