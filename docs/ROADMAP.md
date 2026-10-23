# Roadmap

Estados: ✅ terminado · 🚧 en curso · ⏳ pendiente

## Fase 0 — Fundaciones

| # | Tarea | Estado |
|---|---|---|
| 0.1 | Prueba de conexión en dispositivos reales | 🚧 |
| 0.2 | Monorepo, herramientas y CI | ✅ |
| 0.3 | Documentos vivos (DECISIONES, MODELO_DATOS, SYNC) | ⏳ |
| 0.4 | Modelo de datos y migraciones | ⏳ |
| 0.5 | Núcleo de dominio: dinero y eventos del pedido | ⏳ |
| 0.6 | Motor de sincronización | ⏳ |
| 0.7 | Autenticación con PIN, roles y permisos | ⏳ |
| 0.8 | Seed con la carta de La Spritzzería | ⏳ |
| 0.9 | Design system y bocetos de las 5 pantallas | ⏳ |
| 0.10 | Pantalla mínima para la demo de sincronización | ⏳ |
| 0.11 | Demo guiada | ⏳ |

### 0.1 — Prueba de conexión en dispositivos reales 🚧

Pantalla **Diagnóstico del dispositivo** en `/diagnostico` (queda como herramienta para instalar restaurantes). Comprueba en cada celular o tablet abierto por IP con HTTP:
- canal en tiempo real con el hub (WebSocket con latidos, reconexión y detección de conexión muerta) y tiempo de respuesta;
- qué pasa al bloquear la pantalla: si la conexión sobrevive y si el navegador recarga la página solo;
- datos locales (IndexedDB), vibración, sonido, pantalla encendida y notificaciones.

Los resultados se envían al hub y quedan en `apps/hub/datos/diagnosticos.jsonl` (máximo 5 MB).

**Pendiente:** correr la prueba en un Android y un iPhone del restaurante, primero con el hub en el Mac y luego en el PC de caja con Windows 11, y registrar la decisión en `docs/DECISIONES.md`.

**Cómo probarlo a mano:**

1. Inicia el hub: `pnpm --filter @pos/app build && pnpm --filter @pos/hub start`. Debes ver `Hub en marcha` y la dirección `http://192.168…:4000`.
2. En el celular, conectado al mismo Wi-Fi, abre esa dirección agregando `/diagnostico`. Debes ver **Diagnóstico del dispositivo** y **✓ Conectado** en «Canal en tiempo real».
3. Sigue los cuatro pasos numerados de la pantalla. Al enviar debes ver **✓ Resultados enviados**.

### 0.2 — Monorepo, herramientas y CI ✅

Monorepo pnpm + Turborepo con `apps/pos`, `apps/hub` y `packages/core`; Biome, TypeScript estricto, Vitest, Playwright y GitHub Actions (`.github/workflows/ci.yml`).

**Cómo probarlo a mano:**

1. En la carpeta del proyecto, ejecuta `pnpm install` y luego `pnpm check`. Debes ver `Tasks: 6 successful, 6 total` al final.
2. Ejecuta `pnpm test:e2e`. Debes ver `43 passed` y `1 skipped`.
3. Ejecuta `pnpm --filter @pos/app build && pnpm --filter @pos/hub start`. Debes ver `Hub en marcha` y una o más direcciones `http://192.168…:4000`.
4. Abre esa dirección en el navegador del computador. Debes ver "POS" y el indicador verde **✓ Conectado al hub**.
5. Detén el hub con `Ctrl+C`. En unos 3 segundos el indicador cambia a rojo **✕ Sin conexión con el hub**.

El CI de GitHub corre cuando el repositorio se suba a GitHub (pendiente: se verificará en la primera corrida).
