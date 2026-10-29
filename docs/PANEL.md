# Panel del dueño en la nube (tarea 1.11c, [ADR-017](DECISIONES.md#adr-017--panel-del-dueño-en-la-nube-en-vivo-y-con-acciones-a-distancia))

Contrato entre el hub, la nube y el panel. Los nombres de rutas, campos y tablas van en inglés (ADR-010).

La tarea se hace en tres partes:

| Parte | Qué trae |
|---|---|
| **1.11c-1** | Entrar al panel; tablero del día y todos los reportes. El panel consulta cada 15 s |
| **1.11c-2** | En vivo con Durable Object: salón, cocina, caja, alertas y «sin noticias del local» |
| **1.11c-3** | Períodos de más de 14 días (caché de cierres) y fotos de los productos |

## Quién entra

- **Usuarios:** los mismos del local, con su usuario y contraseña de la caja. Entra quien tenga el permiso nuevo `remote_access`, «Entrar desde fuera del local», que solo se da a quien entra con contraseña:
  - en restaurantes nuevos, el rol Administrador lo trae por defecto;
  - en un hub existente se agrega una sola vez a los roles que hoy son el Administrador;
  - si después el administrador lo quita, no vuelve a aparecer.
- **Lo que ve cada uno** depende de sus permisos de siempre:
  - el tablero, los reportes, la caja y las alertas piden `view_reports`;
  - el salón y la cocina (1.11c-2) piden solo `remote_access`.
- **Cómo se identifica el restaurante:**
  - cada restaurante tiene un `slug` en la nube (`la-spritzzeria`);
  - la pantalla de entrada pide restaurante, usuario y contraseña;
  - el panel recuerda el restaurante en el celular;
  - la dirección `/r/<slug>` lo deja escrito.

## Hub → nube

Todo va con la credencial del hub (`authorization: Bearer <credential>`), como `POST /v1/events`.

### Instantáneas: `PUT /v1/snapshots/:kind`

La nube aún no tiene la carta, la configuración ni el personal: viven en el hub hasta la 1.11b. Mientras tanto, el hub sube una **instantánea** de solo lectura de cada cosa cuando cambia.

- **Cuerpo:** `{ "fingerprint": string, "content": <json> }`, de hasta 2 MB.
- **Respuestas:** 204 si se guardó (o ya estaba igual), 400 si el formato es malo, 401 si la credencial no sirve, 413 si es muy grande.
- **Dónde se guarda:** la nube guarda solo la última de cada `kind`, por restaurante y sede (`location_id` del hub).
- **Cómo detecta el cambio el hub:**
  - arma cada instantánea y le calcula la huella (`fingerprint` de `canonicalJson`);
  - la sube solo si es distinta de la última que la nube aceptó, guardada en `counters` o junto a `cloud-link.json`;
  - lo revisa cuando cambia la carta o el personal, y en cada vuelta del uploader cuando está al día.

| `kind` | Contenido |
|---|---|
| `catalog` | Lo que devuelve `readCatalog()` (`/api/catalog`) |
| `config` | `{ config: configOf(…), time_zone }`: la misma configuración que usan los reportes |
| `people` | `[{ id, name, role_id, active }]`: todas las personas, también las archivadas (los reportes muestran nombres viejos). Sin PIN ni contraseñas |
| `roles` | `[{ id, name, permissions: string[], active }]` |
| `remote_users` | `[{ user_id, username, name, verifier, permissions: string[] }]`: solo las personas activas con usuario y contraseña cuyo rol tiene `remote_access` |

`verifier` es el mismo hash scrypt que guarda el hub (`scrypt$cost$r$p$salt$hash`, `apps/hub/src/access/secrets.ts`): la nube lo verifica con `node:crypto` (medido: unos 31 ms en workerd). No viaja ningún PIN, ni contraseñas en claro, ni las credenciales de los dispositivos. Por qué es aceptable: [ADR-013, enmienda del 29-oct-2026](DECISIONES.md#adr-013--acceso-por-rol-meseros-con-pin-desde-la-ip-caja-con-usuario-y-contraseña).

### Latido

El uploader, cuando está al día, pregunta `GET /v1/events/last` cada **30 s** (antes 60) y agrega la cabecera `x-faro-hub-max: <maxSequence del hub>`.

La nube guarda en `hubs`:
- `last_seen_at`: la hora;
- `hub_max_sequence`: lo que el hub tiene.

Con eso el panel sabe desde cuándo no hay noticias del local y cuántos cambios faltan por subir.

## Nube

### Migración 2

En `apps/cloud/src/migrations.ts`, con el mismo estilo de la 1: seguridad por fila con `faro.restaurant_id` y GRANT por columna a `faro_data`.

| Cambio | Detalle |
|---|---|
| `restaurants.slug` | `text UNIQUE` |
| `hubs.last_seen_at` | `timestamptz` |
| `hubs.hub_max_sequence` | `bigint` |
| `event_aggregates` | `(restaurant_id, event_id, aggregate_id, hub_id, hub_sequence)`. Es la misma idea que la tabla del hub, porque un evento toca varios pedidos (mover ítems, unir mesas). Se calcula con `ordersOf()` de `@pos/sync` al recibir, y se rellena con lo ya guardado |
| `snapshots` | `(restaurant_id, location_id, kind, fingerprint, content jsonb, hub_id, uploaded_at)` |
| `remote_users` | `(restaurant_id, location_id, user_id, username, name, verifier, permissions text[])` |
| `panel_sessions` | `(id, restaurant_id, user_id, secret_hash, verifier_fingerprint, created_at, last_used_at, expires_at, revoked_at)` |
| `panel_attempts` | `(restaurant_id, key, failures, blocked_until)` |
| Índices | Los que piden los reportes por día operativo, agregado y turno de caja |

### Reportes con el mismo código

`reportData()` y `report()` son las mismas funciones del hub. La nube carga de Postgres los eventos del período en un store en memoria que cumple `HubStore`. Si `reportData` pide algo que no cargó (otros eventos de un pedido, los cargos de un turno), la nube lo trae y repite, hasta 4 veces. Los eventos se ordenan por `hub_sequence` dentro de la sede.

- **Período máximo:** 14 días en la 1.11c-1: 31 días al volumen del piloto cargan unos 35 MB de eventos de una vez, cerca de los 128 MB de un Worker. Los períodos largos vienen con la 1.11c-3.
- **Prueba:** el panel y el hub dan **el mismo número** con las mismas historias de pedidos.

### Rutas del panel (sesión por cookie)

| Ruta | Pide | Devuelve |
|---|---|---|
| `POST /v1/panel/sign-in` `{ restaurant, username, password }` | — | 200 `Me` y la cookie; 401 `invalid_credentials` («Usuario o contraseña incorrectos», igual para todo); 429 con espera |
| `POST /v1/panel/sign-out` | sesión | 204 y borra la cookie |
| `GET /v1/panel/me` | sesión | 200 `Me` o 401 |
| `GET /v1/panel/summary` | `view_reports` | El tablero (abajo) |
| `GET /v1/panel/reports?from=&until=` | `view_reports` | La misma forma que `/api/reports` del hub (`PeriodReport` de `apps/pos/src/floor/engine.ts`) con `printer: false` |

- **`Me`:** `{ user: { id, name, permissions: string[] }, restaurant: { id, name, slug } }`.
- **Tablero:**

```
{
  server_now, today,
  report,                      // report() de hoy hasta ahora
  last_week: { day, report_until_now, report_full },
  users,                       // id → nombre
  local: { last_seen_at, last_event_at, pending }
}
```

  `pending` es `hub_max_sequence` menos lo recibido.

- **Cookie:**
  - nombre `__Host-faro_panel` con valor `<session_id>.<secret>`;
  - `HttpOnly; Secure; SameSite=Strict; Path=/`;
  - la nube guarda solo el sha256 del secreto;
  - vence a los 7 días sin uso, o a los 30 días de todos modos.
- **Validación en cada petición:**
  - la nube vuelve a leer `remote_users`: si a la persona le quitaron el permiso, la archivaron o cambió la contraseña (otro `verifier`), la sesión muere;
  - todo `POST` exige que `Origin` sea la dirección del panel.
- **Límite de intentos:**
  - Rate Limiting de Workers, por IP y por `restaurante:usuario`;
  - en `panel_attempts`, una espera que crece con cada fallo, hasta 10 s por usuario, como en el hub;
  - se calcula el hash aunque el usuario no exista, para que no se note la diferencia.

## Panel (apps/pos)

- **Entrada:** una segunda entrada de la app, `panel.html` con `src/panel/`, que se compila a `dist-panel`. El Worker la sirve con Workers Static Assets: `run_worker_first: ["/v1/*"]` y `not_found_handling: "single-page-application"`.
- **Reutiliza** el design system (`src/ui`), la marca del restaurante y las pantallas de Reportes (el contenido, sin reimprimir el cierre Z).
- **Diseño:** primero para el celular.
- **En la 1.11c-1:**
  - consulta el tablero cada 15 s mientras está a la vista;
  - si no hay respuesta, dice desde qué hora tiene los datos.
