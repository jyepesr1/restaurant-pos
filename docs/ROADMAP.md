# Roadmap

Estados: ✅ terminado · 🚧 en curso · ⏳ pendiente

## Fase 0 — Fundaciones

| # | Tarea | Estado |
|---|---|---|
| 0.1 | Prueba de conexión en dispositivos reales | ✅ |
| 0.2 | Monorepo, herramientas y CI | ✅ |
| 0.3 | Documentos vivos (DECISIONES, MODELO_DATOS, SYNC, DINERO) | ✅ |
| 0.4 | Modelo de datos y migraciones | ✅ |
| 0.5 | Núcleo de dominio: dinero y eventos del pedido | ✅ |
| 0.6 | Motor de sincronización | ✅ |
| 0.7 | Autenticación con PIN, roles y permisos | ✅ |
| 0.8 | Seed con la carta de La Spritzzería | ✅ |
| 0.9 | Design system y bocetos de las 5 pantallas | 🚧 esperando tu aprobación |
| 0.10 | Pantalla mínima para la demo de sincronización | ⏳ |
| 0.11 | Demo guiada | ⏳ |

### 0.1 — Prueba de conexión en dispositivos reales ✅

Pantalla **Diagnóstico del dispositivo** en `/diagnostico` (queda como herramienta para instalar restaurantes). Comprueba en cada celular o tablet abierto por IP con HTTP:
- canal en tiempo real con el hub (WebSocket con latidos, reconexión y detección de conexión muerta) y tiempo de respuesta;
- qué pasa al bloquear la pantalla: si la conexión sobrevive y si el navegador recarga la página solo;
- datos locales (IndexedDB), vibración, sonido, pantalla encendida y notificaciones.

Los resultados se envían al hub y quedan en `apps/hub/datos/diagnosticos.jsonl` (máximo 5 MB).

**Resultado:** la app funciona por IP con HTTP en Android (Chrome) y en iPhone (Safari) sin instalar nada. Decisión, evidencia y consecuencias para el diseño en [ADR-001](DECISIONES.md#adr-001--los-dispositivos-abren-la-app-por-la-ip-del-hub-con-http-y-sin-instalar-nada). Lo más importante: la conexión se pierde cada vez que se bloquea la pantalla y el reloj de los celulares no es confiable.

**Queda pendiente:**
- Confirmar en Android la reconexión de menos de 1 s con la versión corregida (el Android probó la versión anterior).
- Fase 1: repetir la prueba con el hub en el PC de caja (Windows 11), cuando exista el instalador del hub.

**Cómo probarlo a mano:**

1. Inicia el hub: `pnpm --filter @pos/app build && pnpm --filter @pos/hub start`. Debes ver `Hub en marcha` y la dirección `http://192.168…:4000`.
2. En el celular, conectado al mismo Wi-Fi, abre esa dirección agregando `/diagnostico`. Debes ver **Diagnóstico del dispositivo** y **✓ Conectado** en «Canal en tiempo real».
3. Sigue los cuatro pasos numerados de la pantalla. Al enviar debes ver **✓ Resultados enviados**.

## Antes de probar cualquier tarea

En cada terminal nueva, desde la carpeta del proyecto:

1. Escribe `nvm use 24`. Debes ver `Now using node v24…`.
2. Solo la primera vez: escribe `corepack enable pnpm`. No muestra nada; es normal.

### 0.9 — Design system y bocetos de las 5 pantallas 🚧

**Falta tu aprobación:** ábrelos en tu celular y en una tablet (pasos abajo) y dime qué cambiarías.

**Design system** (`apps/pos/src/estilos.css` y `apps/pos/src/ui`), según la sección 5 del brief:
- **Colores con significado fijo:** verde = libre o listo, ámbar = en proceso, rojo = demora o alerta, azul = acción principal, gris = lo demás. Siempre con ícono y texto, nunca solo color.
- **Contraste y tamaños:** contraste AA en claro y en oscuro, que una prueba automática mide en cada cambio. Botones de al menos 48 px.
- **Modo oscuro:** sigue al sistema, se puede elegir y se recuerda. Se aplica antes de pintar para que no haya destello blanco.
- **Componentes:**
  - botón;
  - etiqueta de estado;
  - opciones que se eligen tocando;
  - **panel lateral** (sube desde abajo en el celular y sale por la derecha en tablet y caja);
  - **avisos con Deshacer** (hasta tres a la vez);
  - **teclado PIN** de 4 dígitos;
  - **indicador de conexión** y de impresoras;
  - **búsqueda tolerante** («hamburgesa» encuentra la Spritz Burguer; «quatro formagi», la Quattro Formaggi).

**Bocetos navegables** en `/bocetos`, con la carta real (98 productos) y los cálculos de dinero reales de `packages/core`:
- **Plano de mesas:** estados con color, ícono y texto, y tiempo y saldo en cada mesa. Plano o lista. En tablet y caja, las cuentas abiertas al lado.
- **Toma de pedido:**
  - tocar mesa → tocar producto → Enviar, en 3 toques;
  - el mismo producto suma a su línea;
  - copa o botella, sabor y término con un toque en el panel lateral;
  - deshacer lo agregado o quitado;
  - anular lo ya enviado, con motivo y confirmación;
  - botón «Cuenta».
- **Cocina y barra (KDS):** tarjetas por mesa y estación, tiempo desde el envío (a tiempo, atención a los 10 min, demora a los 20). Tocar un ítem lo marca listo; «Todo listo» deja la mesa «Lista para servir» en el plano.
- **Precuenta y división:** propina sugerida sobre la base sin INC, en partes iguales o por ítems (con ítems compartidos). Cada cuenta tiene su propina y su botón para cobrarla.
- **Cobro:**
  - efectivo con redondeo a $100 y cambio;
  - propina en efectivo sugerida redondeada y editable (tu decisión), con «deja el cambio de propina»;
  - tarjeta con número de aprobación;
  - pagos parciales por cuenta;
  - confirmación antes de registrar;
  - atajos F2, F3, Enter y Esc;
  - la mesa se cierra sola al quedar en $0.

Revisado por `revisor-ux`, `revisor-codigo`, `auditor-dinero` y `qa-pruebas`. Se corrigieron, entre otros:
- escribir notas hacía perder el foco en cada letra;
- el teclado del PIN se trababa con dos errores iguales seguidos;
- Enter sobre «Cancelar» registraba el pago;
- no había forma de pedir la cuenta desde el celular;
- quitar una cuenta en la división hacía caer la pantalla;
- dividir usaba el total en vez del saldo;
- el tiempo de una comanda se reiniciaba al enviar otra;
- la propina en efectivo daba totales imposibles de pagar con billetes.

**Pruebas:** 95 unitarias en `apps/pos` (contraste AA, búsqueda, formatos, y división y cobro con pruebas de propiedades). Hay además unas 185 pruebas de navegador en `tests/e2e/bocetos.spec.ts`, cada una en celular y en caja. En su última corrida pasaron 370 de 371; la única falla era un error real (dos paneles abiertos), que ya quedó corregido. Por pedido tuyo, la corrida completa de las pruebas e2e se deja para el final.

**Decisiones abiertas para cuando revises:**
- «Por cobrar» va en gris; el revisor de UX propone ámbar.
- Modo oscuro automático de noche, o solo siguiendo al sistema.
- Sonido al enviar una comanda.

**Ojo para la Fase 1:** los datos de los bocetos viven en memoria y se simplifican, porque los ítems se borran y los pagos no son eventos. No son el modelo: allí todo es un evento (ADR-005). Las reglas de término y sabor de la carta (`CON_TERMINO`, `CON_SABOR`) deben pasar a la configuración del catálogo.

**Cómo verlo en tu celular y tu tablet:**

1. En la terminal, compila la app y arranca el hub:

```bash
pnpm --filter @pos/app build && pnpm --filter @pos/hub start
```

   Debes ver `Hub en marcha` y una dirección como `http://192.168…:4000`.
2. En el celular, conectado al mismo Wi-Fi, abre esa dirección agregando `/bocetos`. Debes ver **Bocetos del POS** con seis tarjetas.
3. Prueba el flujo del mesero: **Plano de mesas** → toca una mesa libre → toca un producto → **Enviar**. Debes volver al plano con la mesa en «En preparación».
4. Abre **Cocina y barra**, toca **Todo listo** en esa mesa y vuelve al plano: la mesa debe decir «Listo para servir».
5. En la tablet, abre **Precuenta y división** → **Partes iguales** → **Cobrar** en la cuenta 1 → **Cobrar** → **Confirmar**. Debes volver a la precuenta con «Ya pagado».
6. Toca el ícono de la luna arriba a la derecha: todo debe pasar a modo oscuro y quedarse así al recargar.

### 0.8 — Seed con la carta de La Spritzzería ✅

Comando `pnpm seed` (código en `apps/hub/src/seed`). Lee [la carta](datos/carta-la-spritzzeria.yaml) y carga en la base del hub:
- el restaurante «La Spritzzería» (sede Envigado), con la configuración del piloto (esquema `ConfigRestaurante` en `packages/core/src/config.ts`);
- un salón con **25 mesas** en cuadrícula: es provisional, el plano real se dibuja con el editor (Fase 1);
- las estaciones **Cocina** y **Barra**: la comida va a cocina y las bebidas a barra;
- el impuesto **INC 8 %**, **(validar)** con el contador;
- **15 categorías y 98 productos** (los 100 platos de la carta). Según ADR-011:
  - copa y botella del Ramón Bilbao son un solo producto con dos opciones;
  - el sabor del Té Hatsu y de la Soda Hatsu es obligatorio y sin costo;
  - la hamburguesa y la Tagliata llevan el término de la carne;
- **personal de ejemplo**: Gerente, Caja, Mesero 1 a 3, Cocina y Barra, cada uno con su PIN. Son cuentas para el piloto: el restaurante pone luego los nombres reales. `pnpm seed --sin-personal` no las crea.

**Reglas al volver a correrlo:**
- da siempre el mismo resultado: cada registro tiene un identificador estable y lo que ya está igual no se toca;
- solo cambia lo que cambió en la carta;
- lo que ya no está en la carta, o quedó «no disponible», se archiva (nunca se borra);
- lo que cambió una persona (con el futuro editor) se respeta;
- el impuesto se crea una sola vez: si el contador lo cambia, el seed no lo devuelve;
- cada persona conserva su PIN; quien se archive no vuelve;
- todo va en una sola transacción: si algo falla o se corta, no queda nada a medias.

Revisado por `revisor-codigo`, `qa-pruebas` (unas 50 pruebas: repetir el seed, varios hubs, cambios en la carta, procesos cortados a mitad y un pedido real con lo sembrado) y `auditor-dinero` (ningún precio se pierde ni cambia; sin decimales). Corregido, entre otros:
- los PIN se podían perder si la carga fallaba a mitad;
- un plato renombrado o quitado de la carta quedaba activo y duplicado;
- un plato «no disponible» se cargaba como vendible;
- volver a correr el seed devolvía el impuesto al 8 % aunque se hubiera cambiado;
- un sabor repetido en la carta hacía que cada corrida cambiara la base;
- la configuración aceptaba una propina sugerida por encima del 10 % (tope legal, **(validar)** con el contador) y un desglose fiscal que aún no existe.

**Queda para otras tareas:**
- `CatalogoCambiado` en cada cambio del catálogo, antes de validar precios copiados (`precio_distinto`, Fase 1);
- que el hub exija elegir la variante en un producto con copa y botella (Fase 1, ver [DINERO.md](DINERO.md#precio-copiado));
- los modificadores reales con precio (quitar ingredientes, adicionales), que el restaurante enviará antes de la Fase 1;
- el plano real del salón y los nombres reales del personal.

**Cómo probarlo a mano:**

1. Cierra el hub si está abierto (Ctrl+C en su ventana). El seed necesita la base solo para él.
2. Carga los datos:

```bash
pnpm seed
```

   Debes ver `Datos de La Spritzzería cargados en …`, una línea por tabla (por ejemplo `producto  98 nuevos, 0 cambiados, 0 iguales`) y, al final, `PIN nuevos:` con un PIN de 4 dígitos para cada persona. Anótalos.

3. Vuelve a correr el mismo comando. Ahora todas las líneas deben decir `0 nuevos, 0 cambiados` y al final `No se creó personal nuevo: cada quien conserva su PIN.`
4. Si quieres probarlo sin tocar tu hub, usa una carpeta aparte: `DIR_DATOS=/tmp/hub-piloto pnpm seed`.

### 0.7 — Autenticación con PIN, roles y permisos ✅

Según [ADR-008](DECISIONES.md#adr-008--inicio-de-sesión-solo-con-pin-generado-por-el-sistema) y [SYNC.md](SYNC.md#seguridad):
- **Permisos y roles** (`packages/core/src/acceso`): las 24 claves de permiso, los 6 roles de fábrica con la matriz de [MODELO_DATOS.md](MODELO_DATOS.md#permisos) y qué permiso pide cada tipo de evento. Pagos y cierres solo desde un dispositivo de caja.
- **Acceso en el hub** (`apps/hub/src/acceso`):
  - PIN de **4 dígitos** (decisión del dueño) generados al azar, únicos entre usuarios activos, guardados solo como HMAC con la clave del hub.
  - Emparejar un equipo con un código de un solo uso (5 minutos), aprobado con el PIN del administrador desde la caja.
  - Sesión con PIN; espera creciente tras errores (hasta 60 s) y aviso al administrador.
  - Comprobante de supervisor para un evento exacto.
  - Revocar un equipo.
  - API HTTP: `/api/emparejamientos`, `/api/emparejar`, `/api/sesiones`, `/api/sesiones/cerrar`, `/api/autorizaciones` y `/api/dispositivos/:id/revocar`.
- **En cada evento**, el hub de sincronización comprueba la sesión, la firma del evento, el permiso del rol al recibirlo (o el comprobante) y el tipo de equipo.
- **Al instalar**, el hub crea el restaurante, los roles y el usuario «Administrador», y muestra su PIN una sola vez.

Criterios cumplidos, con pruebas que recorren el hub completo: un dispositivo revocado es rechazado (no lee el salón y lo nuevo que envía no entra); un mesero no puede anular sin autorización; cada autorización deja registro de quién la dio (`autorizado_por_id` en el evento y el comprobante usado).

Revisado por `revisor-codigo` y `qa-pruebas` (unas 140 pruebas nuevas: la matriz completa de roles por evento, carreras de comprobantes, fuerza bruta, reinicios del hub y entradas raras a la API). Corregido, entre otros:
- **Grave:** un empleado podía alternar su propio PIN con PIN ajenos para que la espera nunca empezara y probar los diez mil PIN en minutos. Ahora un acierto no borra los fallos.
- Desde cualquier equipo de la red, cambiando de IP, se podía probar el PIN del administrador para emparejar. Ahora solo desde la caja.
- Un comprobante de supervisor servía para otro contenido del mismo evento (otro ítem, otro valor de descuento). Ahora está atado a la huella del evento exacto.
- En un celular compartido, alguien podía crear eventos a nombre del mesero anterior con su sesión ya cerrada. Ahora cada evento va firmado.
- Un mesero podía abaratar un ítem ya enviado cambiando sus modificadores. Ahora eso pide autorización.
- El trabajo hecho sin conexión antes de que archivaran a un usuario se perdía. Ahora va a cuarentena.
- El PIN del administrador podía quedar escrito en un archivo de log. Ahora, si no hay ventana, va a un archivo aparte para borrar.

Agrega la migración 2 (comprobante atado al contenido) y la dependencia `@noble/hashes` (SHA-256 en JavaScript puro, porque por HTTP el navegador no ofrece el suyo).

**Queda para otras tareas:**
- pantallas de PIN, emparejamiento con QR y administración de usuarios (0.9 y 0.10; mientras tanto, los usuarios se crean desde el código y el seed de la 0.8);
- conectar la API y la firma de eventos en la app, y la sala de sincronización por WebSocket en el hub (0.10);
- auditoría como eventos `AccionAuditada` y aviso de intentos en la pantalla de caja (Fase 1).

**Cómo probarlo a mano:**

1. Corre las pruebas:

```bash
pnpm --filter @pos/hub test
```

   Debes ver `Tests 206 passed` en verde.

2. Para ver el arranque de un hub recién instalado sin tocar los datos del tuyo (por ejemplo, los resultados de los celulares de la tarea 0.1), detén el hub si está abierto y arranca uno con una carpeta de datos aparte:

```bash
DIR_DATOS=/tmp/hub-nuevo pnpm --filter @pos/hub start
```

   En la ventana debes ver `PIN del administrador: ` seguido de 4 dígitos, y `Hub en marcha`.

3. Detén ese hub con Ctrl+C y repite el mismo comando. Esta vez **no** debe aparecer el PIN: se muestra una sola vez.

### 0.6 — Motor de sincronización ✅

Paquete `packages/sync`, según [SYNC.md](SYNC.md):
- **Hub** (`HubSync`): valida, detecta duplicados por id y contenido, aplica el evento a los pedidos que toca, decide rechazo, conflicto o aceptación según si el dispositivo estaba al día, numera, calcula el día operativo y guarda, un evento por transacción. `SalaSync` atiende las conexiones y difunde lo aceptado. Almacén en memoria y sobre SQLite (`@pos/sync/sqlite`).
- **Dispositivo** (`ClienteSync`): guarda cada evento como pendiente, envía lotes de 100 (uno a la vez), aplica lo confirmado, avanza el cursor solo de forma contigua (pide lo que falte ante un hueco), rechaza en cascada lo que dependía de un rechazo y, si el hub se restauró, reenvía todo.
- **Conexión** (`GestorConexion`): reconecta al instante al volver a la pantalla, abandona intentos colgados a los 4 s, descarta canales mudos (3 s tras volver, 15 s sin latidos) y reintenta con espera de 1 a 5 s.

Escenarios probados con red simulada (el hub sobre SQLite real): pedidos sin conexión en dos dispositivos, ítems al mismo pedido, misma mesa (un solo conflicto, también al reenviar), respuesta perdida, hub caído a mitad de un lote y antes de responder, reloj desfasado 5 horas, rechazo en cascada, hueco en lo recibido, hub restaurado de un respaldo, dispositivo con datos borrados, 150 eventos pendientes y dispositivo revocado (cuarentena). Además: casos borde del protocolo (mensajes fuera de orden, `traer` de varias páginas, cortes con un lote en vuelo) y una prueba de propiedades que genera cientos de historias al azar con cortes, pérdidas, duplicados y caídas del hub, y exige que al final todos vean lo mismo y nada se pierda.

Revisado por `revisor-codigo` y `qa-pruebas`; corregido, entre otros:
- al reenviar a un hub restaurado de un respaldo, el hub tomaba como distintos los eventos que el respaldo ya tenía y **se perdía un ítem**;
- un evento rechazado que se reenviaba dos veces, o uno malformado sin id, hacía fallar al hub a mitad del lote;
- un evento enorme o muy anidado podía agotar la memoria del hub;
- al cortarse y volver la conexión muy rápido, el dispositivo podía quedar con un lote que nunca se respondía;
- el dispositivo no corregía su reloj con la hora del hub;
- un dispositivo revocado seguía recibiendo los pedidos del salón;
- los eventos del mismo dispositivo contaban como "no conocidos", lo que convertía en conflicto errores que debían rechazarse.

**Queda para otras tareas:** sesiones, tokens y revocación reales (0.7); WebSocket real en el hub con límite de tamaño, almacén IndexedDB con índices y prueba Playwright con dos navegadores (0.10); foto inicial, conflictos como eventos, pedido de rescate, `afecta`, bloqueo de mesas, filtros por tipo de dispositivo y proyecciones guardadas en la base para que el hub arranque rápido con años de datos (Fase 1). Ver el detalle en [SYNC.md](SYNC.md).

**Cómo probarlo a mano:** ejecuta `pnpm --filter @pos/sync test`. Debes ver todas las pruebas en verde.

### 0.5 — Núcleo de dominio: dinero y eventos del pedido ✅

En `packages/core`, el mismo código para celular, hub y nube:
- **Dinero** (`src/dinero/`): redondeo, reparto por mayor residuo, línea, descuentos, desglose fiscal, propina sobre la base, redondeo del efectivo y efectivo esperado de caja, tal como los define [DINERO.md](DINERO.md).
- **Eventos del pedido** (`src/eventos/`): los 31 tipos de la versión 1 con su esquema Zod; `validarEventoNuevo` devuelve los errores en español y nunca lanza.
- **Reductor** (`src/pedido/`): `aplicarEvento` aplica cada evento al estado del pedido y devuelve un `problema` cuando no puede (por ejemplo `saldo_negativo` o `pedido_dividido`); `totalesPedido` calcula bruto, anulado, descuentos, neto, pagado y saldo.

Pruebas: los ejemplos de DINERO.md, cada regla del reductor y pruebas de propiedades (miles de casos al azar) que exigen que las partes sumen el total, que ninguna línea quede negativa y que con cualquier secuencia de eventos el reductor no falle, sea determinista y nunca deje saldo negativo. La prueba de propiedades encontró un error real (quitar un ítem sin enviar en un pedido ya pagado dejaba saldo negativo), ya corregido. Cobertura exigida: 90 % (actual: 98,8 %).

Revisado por `revisor-codigo`, `qa-pruebas` y `auditor-dinero`; corregido, entre otros: un ajuste de redondeo sin límite que permitía cerrar un pedido sin cobrar, anular un pago ya reembolsado (se devolvía dos veces), unir pedidos perdiendo descuentos, copias de ítems movidos que no coincidían con el original, eventos aplicados dos veces y acciones de cocina bloqueadas con la mesa ya pagada. Los esquemas ahora son estrictos (un campo de más se rechaza).

**Queda para la Fase 1** (con caja y turnos): diferencia de arqueo por medio, efectivo esperado de otros medios, fondo de propinas con saldo entre días e informes cruzados (por medio = por mesero = documentos DIAN).

**Cómo probarlo a mano:** ejecuta `pnpm --filter @pos/core test`. Debes ver todas las pruebas en verde y la tabla de cobertura sin el mensaje `ERROR: Coverage`.

### 0.4 — Base de datos y migraciones ✅

Paquete `packages/db`: migración inicial con las tablas de la Fase 0 de [MODELO_DATOS.md](MODELO_DATOS.md), sobre el SQLite incluido en Node ([ADR-012](DECISIONES.md#adr-012--base-del-hub-sqlite-incluido-en-node-tablas-estrictas-y-migraciones-en-código)). El hub abre la base y aplica las migraciones al arrancar.

Lo que hace cumplir la propia base:
- montos y tarifas enteros y dentro de rango (un decimal o un negativo se rechazan);
- eventos que no se pueden editar ni borrar;
- un PIN único entre usuarios activos;
- claves foráneas activas.

- el catálogo no se borra (se archiva) y archivar un usuario libera su PIN;
- un `INSERT OR REPLACE` tampoco puede reescribir eventos, y la secuencia es contigua;
- un solo hub por carpeta de datos (apertura exclusiva).

Las pruebas además exigen que toda tabla esté clasificada en una categoría y que las de catálogo tengan las columnas comunes. Incluyen un proceso que muere a mitad de una transacción: al reabrir no queda nada a medias.

**Queda para la 0.6:** la cola de salida y el cursor viven en IndexedDB del dispositivo (no en esta base); la unicidad del número de pedido del día se aplica al asignarlo.

**Cómo probarlo a mano:**

1. Ejecuta `pnpm --filter @pos/db test`. Debes ver todas las pruebas en verde.
2. Inicia el hub (`pnpm --filter @pos/app build && pnpm --filter @pos/hub start`). La primera vez debe decir `Base de datos actualizada a la versión 1.`; las siguientes, `Base de datos en la versión 1.`
3. La base queda en `apps/hub/datos/pos.sqlite`.

### 0.3 — Documentos vivos ✅

- [DECISIONES.md](DECISIONES.md): ADR-001 a ADR-011, con alternativas descartadas y lo que queda **(validar)** con el contador o el proveedor DIAN.
- [MODELO_DATOS.md](MODELO_DATOS.md): entidades por fase, tipos (todo entero), una sola tabla de eventos, catálogo de eventos v1, matriz de permisos por rol y configuración del restaurante.
- [SYNC.md](SYNC.md): protocolo dispositivo ↔ hub (modo normal conectado, sin conexión como respaldo), rechazos, cuarentena y conflictos, seguridad de sesiones y PIN, fallas, y 14 escenarios de aceptación para la 0.6.
- [DINERO.md](DINERO.md): fórmulas exactas de descuentos, desglose fiscal, propina, división, pagos, efectivo, caja y fondo de propinas, con la lista de pruebas para la 0.5.

Revisado dos veces por `revisor-codigo` y `auditor-dinero`; sus hallazgos están incorporados.

**Decisiones del dueño en esta tarea:** propina sugerida sobre la base sin INC; propinas en un fondo común; efectivo redondeado a $100; propinas de tarjeta pagadas desde caja o acumuladas según el día; sin conexión es solo un respaldo.

**Pendiente de validar con el contador y el proveedor DIAN** (no bloquea la Fase 0): ver "Pendiente de validar" en ADR-004.

**Cómo revisarlo:** abre los cuatro documentos en GitHub (cuando el repositorio esté subido) o en el editor; los diagramas se ven en GitHub.

### 0.2 — Monorepo, herramientas y CI ✅

Monorepo pnpm + Turborepo con `apps/pos`, `apps/hub` y `packages/core`; Biome, TypeScript estricto, Vitest, Playwright y GitHub Actions (`.github/workflows/ci.yml`).

**Cómo probarlo a mano:**

1. En la carpeta del proyecto, ejecuta `pnpm install` y luego `pnpm check`. Debes ver `Tasks: 6 successful, 6 total` al final.
2. Ejecuta `pnpm test:e2e`. Debes ver `62 passed` y `2 skipped`.
3. Ejecuta `pnpm --filter @pos/app build && pnpm --filter @pos/hub start`. Debes ver `Hub en marcha` y una o más direcciones `http://192.168…:4000`.
4. Abre esa dirección en el navegador del computador. Debes ver "POS" y el indicador verde **✓ Conectado al hub**.
5. Detén el hub con `Ctrl+C`. En unos 3 segundos el indicador cambia a rojo **✕ Sin conexión con el hub**.

Las pruebas e2e compilan la app en `.e2e/app` y guardan datos en `.e2e/datos`, para no tocar un hub de desarrollo que esté sirviendo a celulares reales.

El CI de GitHub corre cuando el repositorio se suba a GitHub (pendiente: se verificará en la primera corrida).
