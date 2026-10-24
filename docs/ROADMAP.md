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
| 0.6 | Motor de sincronización | ⏳ |
| 0.7 | Autenticación con PIN, roles y permisos | ⏳ |
| 0.8 | Seed con la carta de La Spritzzería | ⏳ |
| 0.9 | Design system y bocetos de las 5 pantallas | ⏳ |
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
