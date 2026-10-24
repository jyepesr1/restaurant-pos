# Roadmap

Estados: ✅ terminado · 🚧 en curso · ⏳ pendiente

## Fase 0 — Fundaciones

| # | Tarea | Estado |
|---|---|---|
| 0.1 | Prueba de conexión en dispositivos reales | ✅ |
| 0.2 | Monorepo, herramientas y CI | ✅ |
| 0.3 | Documentos vivos (DECISIONES, MODELO_DATOS, SYNC, DINERO) | ✅ |
| 0.4 | Modelo de datos y migraciones | ⏳ |
| 0.5 | Núcleo de dominio: dinero y eventos del pedido | ⏳ |
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
2. Ejecuta `pnpm test:e2e`. Debes ver `61 passed` y `1 skipped`.
3. Ejecuta `pnpm --filter @pos/app build && pnpm --filter @pos/hub start`. Debes ver `Hub en marcha` y una o más direcciones `http://192.168…:4000`.
4. Abre esa dirección en el navegador del computador. Debes ver "POS" y el indicador verde **✓ Conectado al hub**.
5. Detén el hub con `Ctrl+C`. En unos 3 segundos el indicador cambia a rojo **✕ Sin conexión con el hub**.

Las pruebas e2e compilan la app en `.e2e/app` y guardan datos en `.e2e/datos`, para no tocar un hub de desarrollo que esté sirviendo a celulares reales.

El CI de GitHub corre cuando el repositorio se suba a GitHub (pendiente: se verificará en la primera corrida).
