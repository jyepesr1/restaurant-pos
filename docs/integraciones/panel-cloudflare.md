# Panel del dueño en Cloudflare: tiempo real, SPA, cuentas y WebSocket

Resumen de la documentación oficial para la tarea 1.11c ([ADR-017](../DECISIONES.md#adr-017--panel-del-dueño-en-la-nube-en-vivo-y-con-acciones-a-distancia)), sobre la nube de [ADR-016](../DECISIONES.md#adr-016--nube-primero-postgres-en-neon-como-base-oficial-y-el-pc-de-caja-como-puente-local). Complementa [neon-cloudflare.md](neon-cloudflare.md) (Neon + Hyperdrive + Workers), que no se repite aquí.

Regla de este documento: si algo no está en la documentación oficial dice **«No documentado»** y pasa a las preguntas abiertas. Lo que es **cálculo propio** o **inferencia** está marcado así. Los precios son en USD y los publicados el 29-oct-2026.

Alcance de las fuentes: lo de Cloudflare viene de developers.cloudflare.com (y del repositorio oficial `cloudflare/workerd` para el límite de PBKDF2). Para contraseñas, cookies y CSRF, Cloudflare no publica guía; se usó la guía de OWASP y MDN como **estándar de la industria, no como documentación del proveedor**. Está dicho en cada caso.

## 1. Estado y fecha de consulta

- **Fecha de consulta:** 29-oct-2026.
- **Durable Objects (DO) con la API de hibernación de WebSocket:** en producción. Las clases nuevas **deben usar el almacenamiento SQLite**: desde el [9-jul-2026](https://developers.cloudflare.com/changelog/post/2026-07-09-restrict-new-kv-backed-namespaces/) no se crean espacios con almacenamiento clave-valor en cuentas que no tengan uno.
- **Declaración de clases de DO:** desde el [30-jun-2026](https://developers.cloudflare.com/changelog/post/2026-06-30-declarative-do-class-exports/) existe el campo `exports` que reemplaza al arreglo `migrations`. **Los dos se soportan, pero un Worker solo puede usar uno** ([migraciones](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)). La versión mínima de Wrangler para `exports`: **No documentado** (el aviso no la dice). Faro usa Wrangler 4.149.0.
- **Binding de limitación de intentos (`ratelimits`):** GA desde el [19-sep-2025](https://developers.cloudflare.com/changelog/post/2025-09-19-ratelimit-workers-ga/); exige Wrangler 4.36.0 o posterior ([doc](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)). Se cumple con 4.149.0.
- **Fecha de compatibilidad:** con `compatibility_date` 2026-10-26 (la del Worker `faro-api`) quedan activos `web_socket_auto_reply_to_close` (desde 2026-04-07, [doc](https://developers.cloudflare.com/workers/runtime-apis/websockets/)) y la preferencia de servir recursos estáticos en las navegaciones (desde 2025-04-01, [doc](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/)).

## 2. Requisitos previos

1. **Cuenta de Cloudflare con Workers** (la misma de `faro-api`).
2. **Plan de Workers.** Los DO con SQLite **sí están en el plan Free**, con tope diario: 100.000 solicitudes/día y 13.000 GB-s/día; al pasarse, las operaciones fallan ([precios de DO](https://developers.cloudflare.com/durable-objects/platform/pricing/)). El plan **Paid** (mínimo USD 5 al mes por cuenta, [precios de Workers](https://developers.cloudflare.com/workers/platform/pricing/)) probablemente haga falta: Free da 10 ms de CPU por solicitud ([límites](https://developers.cloudflare.com/workers/platform/limits/)), y cuánta CPU gasta un hash de contraseña **no está documentado** (ver 6.1; **inferencia:** 10 ms es muy poco para un hash que se quiere lento). Paid da 30 s por defecto.
3. **Dominio propio:** el panel y la API deben compartir **un solo origen** para que la cookie de sesión viaje en el WebSocket y se pueda usar el prefijo `__Host-` (ver 6.2 y 7.2). Dónde se publica y con qué dirección: pendiente de la 1.10 (ADR-017).
4. **Wrangler 4.149.0** sirve para todo lo de abajo (`run_worker_first` en arreglo pide 4.20.0, `ratelimits` pide 4.36.0).

## 3. Ambientes

- **Producción:** el mismo Worker `faro-api` sirve la API (`/v1/*`), el WebSocket y los archivos del panel. Su URL: No verificada aquí; la asigna Cloudflare o es el dominio propio.
- **Local:** `wrangler dev` para el Worker. Cómo se prueban los DO con el plugin de Vitest o `createTestHarness()`: **No leído** en esta consulta; ver [pruebas](https://developers.cloudflare.com/workers/testing/) antes de escribir pruebas.
- **Ubicación de los DO:** por defecto se crean cerca de la primera solicitud; el `locationHint` `sam` (Sudamérica) existe pero **los DO no se crean en `sam`, `afr` ni `me`**: caen en una ubicación cercana, por ejemplo América del Norte oriental ([ubicación de datos](https://developers.cloudflare.com/durable-objects/reference/data-location/)). Latencia desde Colombia: **No documentado**.

## 4. Pregunta 1: empujar cambios en vivo al navegador

### 4.1 Cómo funciona (WebSocket con hibernación)

Diseño que cabe en la documentación (un DO por restaurante):

1. El Worker recibe el lote de eventos del hub y lo guarda en Postgres (ADR-016).
2. Después del guardado, llama al DO de ese restaurante: `env.<BINDING>.getByName(restaurantId)`. `getByName` da siempre el mismo DO para el mismo nombre, y crear el stub no despierta al DO ([reglas](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)). Cloudflare recomienda **un DO por unidad lógica** y no uno «global» (misma fuente).
3. El DO recorre `this.ctx.getWebSockets()` y manda un aviso corto a cada navegador conectado. Los ejemplos oficiales hacen exactamente ese recorrido ([ejemplo de servidor WebSocket con hibernación](https://developers.cloudflare.com/durable-objects/examples/websocket-hibernation-server/)).
4. El navegador pide los datos a la API con su cookie. **Sugerencia de diseño (no es de la documentación):** que el DO no guarde datos del restaurante; solo avisa «hay algo nuevo hasta la secuencia N». Así Postgres, con su seguridad por fila, sigue siendo la única fuente y el DO no puede filtrar datos por error.

Datos de la API de hibernación ([WebSockets en DO](https://developers.cloudflare.com/durable-objects/best-practices/websockets/), [API de estado](https://developers.cloudflare.com/durable-objects/api/state/)):

- Se acepta la conexión con `this.ctx.acceptWebSocket(server, tags?)` (no `ws.accept()`); así el DO puede dormir con los navegadores conectados.
- Tras un periodo sin eventos el DO sale de memoria, **los clientes siguen conectados**, la memoria se pierde y el constructor corre otra vez al llegar un evento. El estado por conexión se restaura con `serializeAttachment` / `deserializeAttachment` (máximo **16.384 bytes** serializados, página de WebSockets).
- Los manejadores `webSocketMessage` y `webSocketClose` se definen como métodos de la clase. Los pings de protocolo se atienden solos.
- `setWebSocketAutoResponse(new WebSocketRequestResponsePair(pedido, respuesta))` responde sin despertar al DO; cada cadena admite hasta **2.048 caracteres**. Sirve para el ping/pong de la aplicación (los navegadores no pueden enviar un ping de protocolo desde JavaScript; esto último es del estándar, no de las páginas leídas).
- **Etiquetas:** hasta **10 por conexión**, de hasta **256 caracteres** cada una; `getWebSockets(etiqueta)` filtra. Útil para cerrar todas las conexiones de una sesión revocada (ver 7.2, paso 5).
- Lo que **impide** hibernar: alarmas, solicitudes entrantes, `setTimeout`/`setInterval`, un WebSocket saliente abierto (hasta 15 minutos) y `waitUntil` (hasta 15 minutos). Solo hiberna cuando el DO es servidor WebSocket.

### 4.2 Cómo se declara en `wrangler.jsonc`

Ilustrativo, armado con piezas de la documentación ([migraciones](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/), [empezar con DO](https://developers.cloudflare.com/durable-objects/get-started/)):

```jsonc
{
  "durable_objects": {
    "bindings": [{ "name": "RESTAURANT_LIVE", "class_name": "RestaurantLive" }]
  },
  // Opción A: arreglo migrations (documentado, sigue soportado)
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["RestaurantLive"] }]
  // Opción B (reemplaza a la A; son excluyentes):
  // "exports": { "RestaurantLive": { "type": "durable-object", "storage": "sqlite" } }
}
```

- La clase se **exporta** desde el módulo principal del Worker, extiende `DurableObject` y su constructor llama `super(ctx, env)`. Los métodos públicos son llamables desde el Worker por RPC ([empezar](https://developers.cloudflare.com/durable-objects/get-started/)). Las reglas recomiendan RPC para fechas de compatibilidad desde 2024-04-03 ([reglas](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)); el ejemplo oficial usa `stub.fetch(request)` para reenviar el `Upgrade`.
- **Con `exports`:** los cambios de clases solo se aplican con `wrangler deploy` (`wrangler versions upload` falla), no hay despliegues graduales y **no se puede volver al arreglo `migrations`** ni retroceder a una versión anterior al cambio ([migraciones](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)). Con `migrations` no aparece esa restricción. Elegir una y no mezclar.
- El script de despliegue de Faro ya usa `wrangler deploy` (CLAUDE.md), compatible con ambas.

### 4.3 Límites y cobro

Fuentes: [límites de DO](https://developers.cloudflare.com/durable-objects/platform/limits/), [precios de DO](https://developers.cloudflare.com/durable-objects/platform/pricing/), [API de estado](https://developers.cloudflare.com/durable-objects/api/state/).

| Dato | Valor |
|---|---|
| Conexiones WebSocket con hibernación por DO | **32.768** (CPU y memoria pueden bajar el límite práctico) |
| Tamaño de un mensaje WebSocket recibido | **32 MiB** (si se pasa, se cierra con código 1009; [WebSockets en Workers](https://developers.cloudflare.com/workers/runtime-apis/websockets/)). Tamaño de los mensajes enviados: No documentado |
| Solicitudes por segundo por DO | límite blando de **1.000** (las reglas dicen 500 a 1.000 para operaciones simples) |
| CPU por solicitud o mensaje | 30 s por defecto, hasta 5 min con `limits.cpu_ms`; cada mensaje reinicia el contador |
| Memoria por DO | No aparece en la página de límites |
| Número de DO | Ilimitado. Clases por cuenta: 100 (Free) o 500 (Paid) |
| Solicitudes (Paid) | 1 millón al mes incluido, luego USD 0,15 por millón (Free: 100.000/día) |
| Duración (Paid) | 400.000 GB-s al mes incluidos, luego USD 12,50 por millón de GB-s (Free: 13.000 GB-s/día) |
| Filas leídas / escritas SQLite (Paid) | 25.000 millones / 50 millones al mes incluidas; USD 0,001 por millón leídas y USD 1,00 por millón escritas |
| Almacenamiento SQLite | 5 GB-mes incluidos, luego USD 0,20 por GB-mes. Una base vacía ocupa unos 12 KB |

Reglas de cobro de los WebSocket ([precios de DO](https://developers.cloudflare.com/durable-objects/platform/pricing/)):

- Abrir una conexión cuenta **una solicitud**.
- Los mensajes **salientes** (el DO hacia el navegador) y los pings de protocolo entrantes son **gratis**.
- Los mensajes **entrantes** (navegador al DO) se cobran en proporción **20:1** (20 mensajes = 1 solicitud).
- Cada llamada del Worker al DO (RPC o `fetch`) cuenta como una solicitud.
- La duración es de reloj de pared, sobre 128 MB asignados sin importar el uso real. Un DO **elegible para hibernar no cobra duración, ni siquiera antes de que el sistema lo duerma**. Con operaciones pendientes se queda en memoria hasta 15 minutos y sí cobra.
- Si las respuestas automáticas de `setWebSocketAutoResponse` cuentan como mensajes entrantes para la proporción 20:1: **No documentado**. La página solo dice que no cobran duración.
- Los mensajes WebSocket que pasan por un Worker (no por un DO) **no cuentan como solicitudes**; solo cuenta el `Upgrade` inicial ([precios de Workers](https://developers.cloudflare.com/workers/platform/pricing/)).
- **Cortes de conexión:** las conexiones **pueden cortarse** al desplegar código nuevo en la red de Cloudflare ([WebSockets de red](https://developers.cloudflare.com/network/websockets/)) y por actualizaciones del runtime ([WebSockets en Workers](https://developers.cloudflare.com/workers/runtime-apis/websockets/)). La documentación pide que el cliente se reconecte y restaure su estado. El panel debe reconectar solo y, al reconectar, volver a leer desde Postgres.
- **Tiempo de inactividad:** Cloudflare cierra un WebSocket «cuando no se transmiten datos en ninguna dirección durante un periodo»; **el número no está documentado** (solo Enterprise lo configura). Pide implementar un keepalive sin dar el intervalo ([WebSockets de red](https://developers.cloudflare.com/network/websockets/)). Hay que medir y fijar el ping de la aplicación con margen.

### 4.4 Costo aproximado para ~10 navegadores por restaurante

**Es cálculo propio**, con supuestos míos (no publicados): por restaurante, 3.000 avisos al día (uno por lote que sube el hub), 10 navegadores conectados 12 horas al día con un ping de aplicación cada 30 s, 2 conexiones por navegador al día, 30 días, y cada navegador vuelve a leer la API tras cada aviso.

| Concepto | Cuenta | Por restaurante al mes |
|---|---|---|
| Llamadas Worker a DO | 3.000 × 30 = 90.000 | |
| Conexiones | 10 × 2 × 30 = 600 | |
| Pings entrantes, si cuentan (peor caso) | 10 × 1.440 × 30 = 432.000, entre 20 = 21.600 | |
| **Solicitudes de DO** | ≈ 112.000 | ≈ USD 0,017 como máximo (112.000 × USD 0,15 por millón); el millón incluido es de toda la cuenta |
| Duración, peor caso (DO despierto las 12 h de servicio) | 12 × 3.600 × 30 = 1.296.000 s × 0,125 GB = 162.000 GB-s | USD 2,03 si no queda dentro de los 400.000 incluidos (caben ~2 restaurantes así) |
| Duración, caso del ejemplo oficial (~1 s activo por minuto) | 5.530 GB-s | ≈ USD 0,07 |
| Solicitudes de Worker de las lecturas (refresco tras cada aviso) | 10 × 3.000 × 30 = 900.000 | ≈ USD 0,27 (10 millones incluidos por cuenta, luego USD 0,30 por millón) |
| Archivos del panel | | USD 0: las solicitudes a recursos estáticos son «gratis e ilimitadas» ([facturación](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)) |

Total orientativo: **de unos USD 0,10 (caso típico) a unos USD 2,50 (peor caso) por restaurante al mes**, sobre el piso de USD 5 al mes de la cuenta. La CPU de los Workers (USD 0,02 por millón de ms sobre 30 millones incluidos) depende de cuánto tarde cada lectura: **No documentado**, se mide. El ejemplo 4 de la [página de precios](https://developers.cloudflare.com/durable-objects/platform/pricing/) (100 DO con 100 WebSocket cada uno, hibernando) da USD 20,65 al mes en total; sirve de contraste.

### 4.5 Alternativas

**A. Server-Sent Events (SSE) desde un Worker**

- Un Worker HTTP **no tiene límite duro de duración**; mientras transmite el cuerpo sigue activo. Esperar red no cuenta como CPU. Si el cliente se desconecta, las tareas de la solicitud pueden cancelarse; `ctx.waitUntil()` extiende hasta 30 s ([límites de Workers](https://developers.cloudflare.com/workers/platform/limits/)). Una actualización del runtime da a las conexiones abiertas hasta **20 minutos** para terminar (misma fuente), así que igual hay que reconectar.
- **Problema:** una invocación de Worker no tiene forma documentada de avisarle a otra que está sirviendo un SSE. La documentación presenta a los DO como el punto de coordinación entre clientes ([qué son los DO](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/)). Sin DO, el SSE tendría que consultar Postgres cada pocos segundos, que es el caso de la alternativa B. **Con DO**, la hibernación documentada es solo para WebSocket servidor; **inferencia:** un SSE mantenido por un DO no hibernaría y cobraría duración mientras haya navegadores conectados (24 h = 2.592.000 s × 0,125 GB = 324.000 GB-s por restaurante al mes, cálculo propio).
- Veredicto: no ahorra nada frente al WebSocket y pierde la hibernación.

**B. Consultas periódicas (polling)**

- Cálculo propio: cada 5 s, 10 navegadores, 12 h al día = 10 × 8.640 = 86.400 solicitudes/día = 2,59 millones al mes por restaurante, unos USD 0,78 en solicitudes de Worker pasados los 10 millones incluidos, más al menos una consulta a Hyperdrive por solicitud. En Free, Hyperdrive acepta 100.000 consultas/día ([neon-cloudflare.md](neon-cloudflare.md#72-hyperdrive)), así que un solo restaurante con sesión y lectura por solicitud pasaría de ese tope.
- Otro costo, ya documentado: Neon suspende el cómputo a los 5 minutos de inactividad ([escalar a cero](https://neon.com/docs/introduction/scale-to-zero)). Con un panel abierto consultando a todas horas, **la base nunca se duerme**: un cómputo de 0,25 CU activo 24 h son ≈ USD 19,3 al mes en Launch (cálculo del documento [neon-cloudflare.md](neon-cloudflare.md#62-planes-y-precios-publicados)). El push solo toca la base cuando hay eventos.
- Latencia: hasta el intervalo de consulta. Es lo más simple y sin piezas nuevas.

**C. Recomendación**

**WebSocket con DO e hibernación, un DO por restaurante, con el aviso mínimo y relectura desde la API.** Es lo que Cloudflare propone para conexiones largas con mucho tiempo ocioso, cuesta centavos por restaurante, no despierta la base de Neon sin eventos y llega en cuanto el Worker termina de guardar. Dejar un **polling lento de respaldo** (por ejemplo, al reconectar y cada minuto mientras la pestaña esté visible; frecuencia a decidir) para el caso de que el aviso se pierda: el aviso del DO es una optimización, la verdad está en Postgres.

## 5. Pregunta 2: servir la SPA desde el mismo Worker (Workers Static Assets)

Fuentes: [Static Assets](https://developers.cloudflare.com/workers/static-assets/), [SPA](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/), [binding y `run_worker_first`](https://developers.cloudflare.com/workers/static-assets/binding/).

Ilustrativo (la ruta `directory` es de ejemplo; el paquete del panel aún no existe):

```jsonc
{
  "assets": {
    "directory": "../panel/dist",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/v1/*"]
  }
}
```

- `directory`: carpeta que Wrangler sube al desplegar; hay que **compilar la SPA antes** de `wrangler deploy`. Con el plugin de Vite de Cloudflare no hace falta ponerla ([Static Assets](https://developers.cloudflare.com/workers/static-assets/)); su configuración **no se leyó** (la [página del plugin](https://developers.cloudflare.com/workers/vite-plugin/) no la cubre).
- `not_found_handling: "single-page-application"`: si ningún archivo coincide, responde `/index.html` con **200**. Así `/salon` o `/reportes` funcionan al recargar.
- `run_worker_first` como **arreglo de patrones**: el Worker corre primero solo en esas rutas. Admite `*` y negativos con `!`; los negativos ganan; el orden no importa; **máximo 100 entradas**; pide Wrangler 4.20.0 o plugin de Vite 1.7.0. Esto **reemplaza la detección automática de navegaciones**. Todo lo que no coincide va primero a los archivos y, si no hay archivo, cae al `index.html`.
- **Cómo convive con la API:**
  - `/v1/*` (API de los hubs, API del panel, WebSocket) entra siempre al Worker. Una ruta `/v1/...` que no exista **la responde el Worker** (debe devolver su propio 404 en JSON); nunca el `index.html`.
  - Un `GET` del navegador a una ruta no `/v1` que no sea archivo recibe el `index.html`.
  - Sin `run_worker_first`, una llamada `fetch("/api/...")` de la SPA sí invocaría al Worker, pero escribir esa misma URL en la barra del navegador devolvería el HTML de la SPA (documentado en la página SPA). Con el arreglo explícito no pasa en `/v1/*`.
  - `env.ASSETS.fetch(request)` permite que el Worker pase al contenido estático lo que no sea API ([binding](https://developers.cloudflare.com/workers/static-assets/binding/)); aplica `not_found_handling`.
- **Cobro:** las solicitudes a recursos estáticos son **gratis e ilimitadas** y guardarlos no cuesta; las que invocan al Worker cuentan como solicitudes normales ([facturación](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)). En Free, las rutas de `run_worker_first` siempre invocan al Worker y, al pasar el tope, reciben **429**, sin caer a los archivos (misma fuente).
- **Límites** ([límites de Workers](https://developers.cloudflare.com/workers/platform/limits/)): **20.000** archivos por versión en Free y **100.000** en Paid; **25 MiB** por archivo; el Worker pesa hasta 64 MiB sin comprimir. Una SPA de React + Vite está muy por debajo.
- **Cabeceras de seguridad (CSP, etc.):** el archivo `_headers` (hasta 100 reglas, 2.000 caracteres por línea) **no aplica a las respuestas que genera el Worker**, solo a los archivos ([cabeceras](https://developers.cloudflare.com/workers/static-assets/headers/)). Las respuestas de `/v1/*` deben llevar las suyas desde el código.
- **Caché de `index.html` y de los archivos con hash:** no se leyó la página de caché. **No documentado aquí.**

## 6. Pregunta 3: cuentas con usuario y contraseña en Workers

### 6.1 Hash de contraseñas

| Opción | Qué dice la documentación | Parámetro de referencia (OWASP) |
|---|---|---|
| **Web Crypto, PBKDF2** (`crypto.subtle.deriveBits`) | Soportado ([Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)). Esa página **no menciona ningún límite de iteraciones**. | 600.000 iteraciones con HMAC-SHA-256; 220.000 con SHA-512 ([OWASP, almacenamiento de contraseñas](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)) |
| **`node:crypto` con `nodejs_compat`** | Está disponible; «todas las APIs de `node:crypto` están soportadas» salvo `argon2`/`argon2Sync`, `randomUUIDv7`, curvas ed448/x448, y pares DSA/DH ([doc](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/)). La página **no nombra `scrypt` ni `pbkdf2`**, pero tampoco los excluye. Con `compatibility_date` desde 2026-08-04 `nodejs_compat` ya viene activo. | scrypt: N=2^17 (128 MiB) r=8 p=1; o N=2^16 p=2; 2^15 p=3 (32 MiB); 2^14 p=5; 2^13 p=10, todas con r=8 (OWASP) |
| **Argon2** | **No soportado** en `node:crypto` de Workers | |

- **Límite de iteraciones de PBKDF2:** no está en las páginas de documentación. Sí en el repositorio oficial del runtime: Cloudflare limita PBKDF2 a **100.000 iteraciones**, por una razón técnica (el limitador de CPU no puede interrumpir BoringSSL en mitad de PBKDF). En enero de 2024 un cambio hizo configurable el máximo en `workerd`, pero «producción mantendría el límite actual por algún tiempo»; el último comentario de Cloudflare (abril de 2024) dice que **aún no se subió** ([workerd #1346](https://github.com/cloudflare/workerd/issues/1346)). No hay confirmación posterior. **Consecuencia:** con Web Crypto no se llega a los 600.000 de OWASP si el tope sigue vigente. Hay que **probarlo** en el Worker desplegado.
- **scrypt con `node:crypto`:** sin límite documentado de parámetros. **Inferencia (no documentada):** N=2^17 pide 128 MiB y el aislado tiene **128 MB** de memoria ([límites](https://developers.cloudflare.com/workers/platform/limits/)), así que no cabe; las opciones de OWASP con N=2^15 (32 MiB) o 2^14 (16 MiB) sí caben, pero varias contraseñas hasheándose a la vez en el mismo aislado comparten esos 128 MB.
- **Costo de CPU de un hash en Workers (milisegundos de PBKDF2 con 100.000 iteraciones o de scrypt con N=2^15):** **No documentado**. Lo que sí hay: límite de CPU por solicitud de **10 ms en Free** y **30 s por defecto (hasta 5 min) en Paid** ([límites](https://developers.cloudflare.com/workers/platform/limits/)). La CPU se factura a USD 0,02 por millón de ms ([precios](https://developers.cloudflare.com/workers/platform/pricing/)); esperar red no cuenta como CPU. Un hash de 100 ms de CPU cuesta USD 0,000002 (cálculo propio); el costo real es irrelevante, el riesgo es el límite en Free.
- **Comparación en tiempo constante:** `crypto.subtle.timingSafeEqual(a, b)` es una extensión de Cloudflare a Web Crypto ([doc](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)). `crypto.getRandomValues` y `crypto.randomUUID` (v4) también existen (misma página).
- **Sal y parámetros:** OWASP: una sal única y aleatoria por contraseña; guardar los parámetros con el hash para poder subirlos al próximo inicio de sesión; apuntar a menos de un segundo por hash.

**Recomendación (sujeta a una prueba de CPU en el Worker desplegado):** `scrypt` de `node:crypto` con N=2^15, r=8, p=3 (alternativa de OWASP al mínimo de 128 MiB) si la prueba da una CPU aceptable en Paid; si `node:crypto` falla o es lento, PBKDF2-SHA-256 al tope de 100.000 por Web Crypto, **sabiendo que queda por debajo de lo que pide OWASP** (compensar con limitación de intentos y contraseñas largas). Guardar `algoritmo$parámetros$sal$hash` para poder subir el costo después. Esa prueba es un paso previo a escribir el código de cuentas.

### 6.2 Cookies de sesión y CSRF

Cloudflare no publica guía de cookies ni de CSRF para Workers (las páginas leídas de Request, Response y Headers no la contienen). Lo siguiente es **el estándar de OWASP**, no documentación de Cloudflare:

- **Cookie** ([OWASP, sesiones](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)): `Secure`, `HttpOnly`, `SameSite=Strict` (preferido) o `Lax`; el prefijo `__Host-` (exige `Secure`, sin `Domain`, `Path=/`) se recomienda para el identificador de sesión. Ejemplo de OWASP: `Set-Cookie: __Host-SessionID=<valor>; Secure; HttpOnly; SameSite=Strict; Path=/`.
- **Identificador:** mínimo 64 bits de entropía, 128 bits o más si lo genera uno mismo, de un generador criptográfico (en Workers, `crypto.getRandomValues`). Regenerar el identificador al iniciar sesión y al cambiar permisos; invalidar en el servidor al cerrar sesión.
- **Caducidad:** OWASP da 2 a 5 minutos de inactividad para aplicaciones de alto valor y 15 a 30 minutos para las de bajo riesgo, y 4 a 8 horas absolutas para uso de oficina. Es una **decisión de producto** para el panel del dueño; no se toma aquí.
- **Dónde guardar las sesiones (sugerencia de diseño):** Postgres, con el identificador guardado como hash. Workers KV es **eventualmente consistente** y puede tardar «60 segundos o más» en reflejar un cambio en otras ubicaciones ([KV](https://developers.cloudflare.com/kv/concepts/how-kv-works/)): no sirve para revocar sesiones o bloquear usuarios, que ADR-017 pide. Recordar que **la caché de Hyperdrive debe estar desactivada** para estas lecturas ([neon-cloudflare.md](neon-cloudflare.md#46-caché-de-consultas-de-hyperdrive-afecta-a-faro)).
- **CSRF** ([OWASP, CSRF](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)): SameSite es defensa adicional, no reemplaza una defensa propia. Para una SPA con API JSON, OWASP acepta una **cabecera personalizada obligatoria** más **verificar `Origin`** (rechazando `Origin` ausente o `null`) en toda petición que cambie datos, sin CORS abierto, y rechazar tipos de contenido «simples» como `text/plain`. Alternativa para software sin estado: doble envío de cookie **firmado y ligado a la sesión** (el doble envío simple se considera inseguro). Ningún cambio de estado por `GET`.
- El inicio de sesión del panel y el PIN del hub son entradas distintas (ADR-017).

### 6.3 Limitación de intentos (Rate Limiting binding)

Fuente: [Rate Limiting en Workers](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).

```jsonc
{
  "ratelimits": [
    {
      "name": "LOGIN_LIMITER",
      "namespace_id": "1001",      // entero único en la cuenta, escrito como cadena
      "simple": { "limit": 5, "period": 60 }   // period: solo 10 o 60 segundos
    }
  ]
}
```

- Uso: `const { success } = await env.LOGIN_LIMITER.limit({ key })`. La clave es cualquier cadena. Cloudflare recomienda identificadores estables (usuario, inquilino) y **desaconseja usar la IP**, porque muchos usuarios la comparten. Se pueden combinar actor y recurso, por ejemplo usuario + IP.
- **Semántica, que importa para un login:** el límite es **aproximado y por ubicación de Cloudflare**, no mundial; es **eventualmente consistente** y **permisivo** («las solicitudes pueden exceder el límite configurado mientras se actualizan los conteos»). No bloquea la espera. Bindings con el mismo `namespace_id` comparten contadores.
- Para un límite **estricto** y único en todo el mundo, la propia página recomienda un **Durable Object por credencial con un contador persistente**. **Sugerencia de diseño:** el binding como primera barrera barata, y un contador de intentos fallidos por cuenta en Postgres (con bloqueo temporal) como límite real.
- Máximos de `limit`, número de bindings, costo y disponibilidad en Free/Paid: **No documentados** (la página no los menciona). No se ve en el panel de Cloudflare; se observa con los registros de Workers (respuestas 429) o Analytics Engine.

## 7. Pregunta 4: el navegador abre un WebSocket a un DO autenticado

### 7.1 Qué dice la documentación

- El Worker comprueba la cabecera `Upgrade: websocket` (si falta, responde **426**), acepta solo `GET`, elige el DO con `getByName(...)` y le reenvía la solicitud con `stub.fetch(request)`. El DO crea el `WebSocketPair`, llama `this.ctx.acceptWebSocket(server)` y devuelve la respuesta 101 con el extremo cliente ([ejemplo oficial](https://developers.cloudflare.com/durable-objects/examples/websocket-hibernation-server/)). El ejemplo oficial **no autentica**: nombra al DO con la cadena fija `"foo"`.
- Cloudflare **no publica** un ejemplo de autenticación de cookie ni de verificación de `Origin` para estos WebSocket (ni la página de WebSockets de red menciona `Origin`). Lo que sigue combina lo oficial con OWASP.

### 7.2 Cómo se arma (mismo origen, cookie en el `Upgrade`)

1. La SPA abre `new WebSocket("wss://" + location.host + "/v1/...")`. El constructor solo acepta URL y subprotocolos, **sin parámetro de cabeceras** ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/WebSocket)); por eso la sesión viaja en la **cookie**: «los navegadores incluyen las cookies en el saludo del WebSocket» ([OWASP, seguridad de WebSocket](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html)). Con `__Host-` y `SameSite=Strict` la cookie solo se envía al mismo origen.
2. El Worker (la ruta cae en `/v1/*`, así que `run_worker_first` lo ejecuta antes que los archivos) hace, antes de tocar el DO:
   - verifica `Upgrade` y método (426/400 como el ejemplo);
   - **valida `Origin` contra una lista permitida**: los navegadores envían las cookies también desde sitios ajenos (secuestro de WebSocket entre sitios, CSWSH), y OWASP exige validar `Origin` en cada saludo con lista blanca, además de `SameSite`;
   - lee la cookie, busca la sesión en Postgres y comprueba que la cuenta tiene acceso al restaurante pedido (ADR-017: cada cuenta ve solo los suyos);
   - **el nombre del DO sale de la sesión o de ese permiso comprobado, nunca de un dato sin verificar** (sugerencia de diseño);
   - reenvía con `env.RESTAURANT_LIVE.getByName(restaurantId).fetch(request)`.
3. El DO acepta con `acceptWebSocket(server, [\`session:${sessionId}\`])` y guarda en `serializeAttachment` (≤ 16.384 bytes) lo mínimo: id de cuenta, restaurante, vencimiento de la sesión.
4. **Evitar** el token en la URL (queda en los registros de acceso, según OWASP). La alternativa de OWASP, enviar el token en el primer mensaje y no mandar nada protegido hasta validarlo, sirve si hubiera que autenticar tras abrir; con cookie de mismo origen no hace falta.
5. **Revocación (ADR-017: «cerrar sesiones o bloquear un usuario»):** una conexión abierta no revisa la cookie otra vez. Con la etiqueta de la sesión, el Worker llama a un método del DO que ejecuta `getWebSockets(etiqueta)` y cierra cada conexión. El vencimiento absoluto se puede cerrar igual (por ejemplo al primer aviso posterior al vencimiento guardado en el adjunto). Si se usa una alarma para cerrar a la hora exacta, **impide hibernar** mientras esté pendiente (página de WebSockets de DO).

### 7.3 Detalles de la respuesta

- Un `Response` con `webSocket` solo existe en el apretón de manos exitoso; el Worker no puede interceptar los datos que luego pasan por la conexión ([Response](https://developers.cloudflare.com/workers/runtime-apis/response/)).
- Con una cuenta bloqueada, el Worker responde **antes** de llegar al DO con 401 o 403 (códigos a decidir; no hay norma de Cloudflare).
- **Límites de mensajes que manda el navegador:** OWASP sugiere topes de tamaño (típicamente 64 KB o menos) y de ritmo (100 mensajes por minuto como punto de partida). El panel solo necesita enviar pings; todo mensaje de otro tipo debe ignorarse. Recordar que cada 20 mensajes entrantes cuestan una solicitud de DO.

## 8. Limitaciones y qué pasa sin internet

- **Local sin internet:** no cambia el diseño de ADR-016: el hub encola y sube al volver. Cuando vuelve, los eventos llegan en lote y el Worker avisa una vez. **El panel debe mostrar «sin datos desde las HH:MM»**: el último evento recibido sale de Postgres, no del DO (que puede estar dormido y sin estado). Qué mensaje manda el DO al conectarse un navegador nuevo es decisión de diseño.
- **Sin internet en el navegador del dueño:** el WebSocket se cae; la SPA debe reconectar con espera creciente y releer.
- **Despliegues y actualizaciones:** cortan los WebSocket (ver 4.3). Un `wrangler deploy` del Worker puede cerrar las conexiones abiertas; **no hay cifra documentada** de cuánto tardan en reconectar.
- **Idempotencia:** el aviso del DO es una pista, no un dato. Si se duplica o se pierde, la relectura desde Postgres lo corrige.
- **Retraso del aviso:** No documentado. El DO está en la ubicación más cercana a la primera solicitud o, para `sam`, en América del Norte oriental; sin cifras para Colombia.

## 9. Preguntas abiertas para Cloudflare

1. ¿Sigue vigente el tope de **100.000 iteraciones de PBKDF2** en producción? ¿Aplica igual a `node:crypto.pbkdf2` y `scrypt`? ¿Cuánta CPU consume un `scrypt` N=2^15, r=8, p=3?
2. ¿Qué **versión mínima de Wrangler** pide el campo `exports` de los DO?
3. ¿Cuál es el **tiempo de inactividad** exacto del WebSocket y el intervalo de ping recomendado?
4. ¿Los mensajes de **`setWebSocketAutoResponse`** cuentan como mensajes entrantes en la proporción 20:1?
5. ¿Cuántos segundos queda despierto un DO después de quedar ocioso («varios segundos») y cuándo empieza a considerarse elegible para hibernar?
6. ¿La llamada Worker a DO cuenta contra el tope de **subrequests** del Worker?
7. ¿El **Rate Limiting binding** tiene costo o aplica a Free y Paid sin distinción? ¿Tiene tope de `limit`?
8. ¿Latencia típica Colombia a un DO en América del Norte oriental, y a Neon en São Paulo? ¿Conviene un `locationHint`?
9. ¿Cómo se prueban los DO con hibernación en `@cloudflare/vitest-plugin` y `createTestHarness()`?
10. ¿Cómo se cachean `index.html` y los archivos con hash servidos por Static Assets?
11. Contradicción detectada: la [página de límites de DO](https://developers.cloudflare.com/durable-objects/platform/limits/) da 10 GB por objeto en Free en la tabla, pero su FAQ dice 1 GB (según el extracto leído); no afecta a Faro.
12. Contradicción detectada: la tabla de [precios de DO](https://developers.cloudflare.com/durable-objects/platform/pricing/) cobra USD 1,00 por millón de borrados de clave-valor pero una nota dice que no se miden; no afecta a Faro (SQLite).

## 10. Enlaces

**Durable Objects**
- [WebSockets y API de hibernación](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [API de estado (acceptWebSocket, etiquetas, auto-respuesta, 32.768 conexiones)](https://developers.cloudflare.com/durable-objects/api/state/)
- [Ejemplo de servidor WebSocket con hibernación](https://developers.cloudflare.com/durable-objects/examples/websocket-hibernation-server/)
- [Precios](https://developers.cloudflare.com/durable-objects/platform/pricing/) y [límites](https://developers.cloudflare.com/durable-objects/platform/limits/)
- [Migraciones y `exports`](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/), [aviso de `exports`](https://developers.cloudflare.com/changelog/post/2026-06-30-declarative-do-class-exports/), [aviso de SQLite obligatorio](https://developers.cloudflare.com/changelog/post/2026-07-09-restrict-new-kv-backed-namespaces/)
- [Empezar](https://developers.cloudflare.com/durable-objects/get-started/), [reglas](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/), [qué son](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/), [ubicación de datos](https://developers.cloudflare.com/durable-objects/reference/data-location/)

**Workers y Static Assets**
- [Precios](https://developers.cloudflare.com/workers/platform/pricing/) y [límites](https://developers.cloudflare.com/workers/platform/limits/)
- [WebSockets en Workers](https://developers.cloudflare.com/workers/runtime-apis/websockets/), [WebSockets en la red de Cloudflare](https://developers.cloudflare.com/network/websockets/), [Response](https://developers.cloudflare.com/workers/runtime-apis/response/), [Request](https://developers.cloudflare.com/workers/runtime-apis/request/)
- [Static Assets](https://developers.cloudflare.com/workers/static-assets/), [SPA](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/), [binding y `run_worker_first`](https://developers.cloudflare.com/workers/static-assets/binding/), [facturación](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/), [`_headers`](https://developers.cloudflare.com/workers/static-assets/headers/), [plugin de Vite](https://developers.cloudflare.com/workers/vite-plugin/)
- [Workers KV](https://developers.cloudflare.com/kv/concepts/how-kv-works/)

**Cuentas**
- [Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/), [`node:crypto`](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/), [issue de PBKDF2 en workerd](https://github.com/cloudflare/workerd/issues/1346)
- [Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/), [GA](https://developers.cloudflare.com/changelog/post/2025-09-19-ratelimit-workers-ga/)
- Estándares (no son del proveedor): [OWASP contraseñas](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html), [OWASP sesiones](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html), [OWASP CSRF](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html), [OWASP WebSocket](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html), [MDN WebSocket](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/WebSocket)

**Neon**
- [Escalar a cero](https://neon.com/docs/introduction/scale-to-zero)
