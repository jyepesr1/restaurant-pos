# POS para restaurantes (Colombia)

Sistema POS para restaurantes de servicio a la mesa. Documentos:

- `docs/BRIEF.md`: brief completo del proyecto.
- `docs/DECISIONES.md`: decisiones de arquitectura y de negocio (ADR), con alternativas y evidencia.
- `docs/MODELO_DATOS.md`: entidades, tipos, eventos del pedido y categorías de sincronización.
- `docs/SYNC.md`: protocolo de sincronización dispositivo ↔ hub ↔ nube.
- `docs/DINERO.md`: fórmulas exactas de todo cálculo de dinero y las pruebas que deben cubrirlas.
- `docs/ROADMAP.md`: estado de cada tarea y cómo probarla a mano.

Antes de cambiar el modelo, la sincronización o una regla de negocio, leer el ADR correspondiente; si la decisión cambia, actualizar el ADR.

Restaurante piloto: **La Spritzzería** (Envigado). Su carta real está en `docs/datos/carta-la-spritzzeria.yaml`.

## Convenciones

- **Idioma**: el dominio va en español (`Pedido`, `Comanda`, `Mesa`, eventos como `ItemAnulado`); la parte técnica en inglés (`useSyncStatus`, `retryWithBackoff`). Interfaz, documentación y mensajes de commit en español.
- **Dinero**: pesos enteros en todo el sistema. Los decimales solo existen dentro del cálculo fiscal DIAN, con aritmética exacta. Repartos por mayor residuo. Toda fórmula sigue `docs/DINERO.md`.
- **IDs**: ULID generados en el dispositivo.
- **Nada se borra** en entidades transaccionales: se anula con motivo, usuario y dispositivo.
- **Todo cambio de un pedido es un evento** append-only con usuario, dispositivo y hora.
- **Persistir antes de mostrar**: una operación se muestra como hecha solo después de guardarse localmente.
- **Nada tributario cableado**: tarifas, redondeos y reglas DIAN son configurables y quedan marcados para validar con contador.
- El usuario no es desarrollador de despliegue: todo lo que deba hacer él va en pasos numerados con lo que debe ver en pantalla.

## Flujo de trabajo

Los subagentes del proyecto están en `.claude/agents/`.

| Subagente | Cuándo usarlo |
|---|---|
| `revisor-codigo` | Al terminar **cada** tarea, antes del commit. Revisa los cambios buscando errores, seguridad y desorden. Solo lectura. |
| `qa-pruebas` | Al terminar **cada** tarea, antes del commit. Escribe y ejecuta pruebas (Vitest, Playwright, cortes de red y caída del hub) y devuelve solo lo que falló. |
| `auditor-dinero` | Cuando una tarea toque dinero: totales, impuestos, descuentos, divisiones, propinas, redondeos, caja o conciliación de datáfonos. Solo lectura. |
| `revisor-ux` | Cuando una tarea agregue o cambie pantallas o componentes de interfaz. Revisa contra la sección 5 del brief. Solo lectura. |
| `investigador-integraciones` | Antes de escribir código de integración con Bold, Redeban, el proveedor DIAN u otro servicio externo. Resume la documentación oficial en `docs/integraciones/`. |

### Regla al terminar cada tarea

1. Pasar el trabajo por `revisor-codigo` y `qa-pruebas`, en paralelo.
2. Si la tarea toca dinero, pasarlo también por `auditor-dinero`. Si toca pantallas, por `revisor-ux`.
3. Corregir lo que encuentren (o dejar registrado en `docs/ROADMAP.md` por qué no se corrige).
4. Confirmar que `pnpm check` pasa.
5. Hacer un commit con un mensaje claro en español: qué cambió y por qué.
6. Actualizar `docs/ROADMAP.md` con el estado de la tarea y cómo probarla manualmente.

No hacer push ni abrir PR sin que el usuario lo pida.

## Estructura

Monorepo con pnpm workspaces y Turborepo. TypeScript estricto en todo.

| Carpeta | Qué contiene |
|---|---|
| `apps/pos` (`@pos/app`) | App React + Vite + Tailwind que usan meseros, caja y KDS en el navegador |
| `apps/hub` (`@pos/hub`) | Servidor local (Fastify) que corre en el PC de caja: sirve la app y la API en la red local. En `src/acceso`: emparejamiento, PIN, sesiones, comprobantes de supervisor y revocación (ADR-008) |
| `packages/core` (`@pos/core`) | Lógica de negocio compartida, sin dependencias de navegador ni de Node: dinero (`src/dinero`), esquemas de eventos (`src/eventos`), reductor del pedido (`src/pedido`) y permisos, roles y firma de eventos (`src/acceso`) |
| `packages/sync` (`@pos/sync`) | Sincronización dispositivo ↔ hub: `HubSync` y `SalaSync` (hub), `ClienteSync` y `GestorConexion` (dispositivo), almacén del hub sobre SQLite en `@pos/sync/sqlite` |
| `packages/db` (`@pos/db`) | Esquema SQLite, migraciones y la interfaz `BaseSqlite`; `@pos/db/node` abre la base con `node:sqlite` (solo Node) |
| `tests/e2e` | Pruebas Playwright de punta a punta (celular Android y caja) |
| `docs/` | Brief, decisiones, roadmap, modelo de datos y datos del piloto |

Los paquetes internos se consumen como código fuente TypeScript (`exports` apunta a `src/index.ts`); no se compilan por separado. Paquetes nuevos (`ui`, `printing`, `dian`, `payments`) se crean en la tarea que los necesita, no antes.

## Comandos

Requiere Node 24 (`.nvmrc`) y pnpm por corepack (`corepack enable pnpm`). En una terminal nueva: `nvm use 24` antes de cualquier comando.

| Comando | Qué hace |
|---|---|
| `pnpm install` | Instala dependencias |
| `pnpm dev` | Levanta hub (puerto 4000) y app (Vite) en modo desarrollo |
| `pnpm --filter @pos/app build && pnpm --filter @pos/hub start` | Compila la app y la sirve desde el hub, como en el restaurante. Imprime las IP para abrir desde el celular |
| `pnpm check` | Lint y formato (Biome), tipos y pruebas unitarias. Debe pasar antes de cada commit |
| `pnpm format` | Corrige formato y orden de imports |
| `pnpm test` | Pruebas unitarias (Vitest) de todos los paquetes; en `@pos/core` exige 90 % de cobertura |
| `pnpm test:e2e` | Pruebas Playwright; compila la app y levanta el hub en el puerto 4100 |

Biome no formatea los archivos Markdown (están excluidos en `biome.json`).

Base de datos: los cambios de esquema van en una migración **nueva** en `packages/db/src/migraciones/` (nunca se edita una publicada), con la tabla agregada a su categoría en `packages/db/src/esquema.ts`. Toda tabla es `STRICT`.

Las dependencias que ejecutan scripts al instalarse deben aprobarse con `pnpm approve-builds <paquete>`; quedan en `allowBuilds` de `pnpm-workspace.yaml`.
