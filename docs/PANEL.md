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

El latido bloquea la fila del hub antes de leer la hora anterior: de dos llamadas al mismo tiempo, la segunda espera y ve la hora de la primera, así que solo una puede ser «volvió tras un silencio» (un solo `back_online`). Si el hub ya no está (lo revocaron entre la revisión de su credencial y el latido), no se escribe nada ni se avisa a nadie (revisión de la 1.11c-2, 3-nov-2026).

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
- **Eventos guardados como conflicto:** desde la tarea 1.7b el hub los marca (`unapplied`) y los reportes no los cuentan, igual en el hub y en la nube; su dinero va aparte en `Report.unapplied`. Uno guardado antes de la marca todavía cuenta ([KPIS.md](KPIS.md#eventos-guardados-como-conflicto)).
- **Una sola foto:** cada lectura del panel (`me`, el tablero, los reportes, el salón, la caja y las alertas) es una transacción `REPEATABLE READ, READ ONLY` (`inRestaurant(…, { readOnly: true })`): el reporte de hoy, los pedidos abiertos y las cajas salen de la misma foto de la base aunque el hub suba algo en medio, y la lectura no puede escribir.

### Rutas del panel (sesión por cookie)

| Ruta | Pide | Devuelve |
|---|---|---|
| `POST /v1/panel/sign-in` `{ restaurant, username, password }` | — | 200 `Me` y la cookie; 401 `invalid_credentials` («Usuario o contraseña incorrectos», igual para todo); 429 con espera |
| `POST /v1/panel/sign-out` | sesión | 204 y borra la cookie |
| `GET /v1/panel/me` | sesión | 200 `Me` o 401 |
| `GET /v1/panel/summary` | `view_reports` | El tablero (abajo) |
| `GET /v1/panel/reports?from=&until=` | `view_reports` | La misma forma que `/api/reports` del hub (`PeriodReport` de `apps/pos/src/floor/engine.ts`) con `printer: false` |
| `GET /v1/panel/floor?plan=<version>` | `remote_access` | El salón y la cocina ahora mismo ([En vivo](#en-vivo-111c-2)) |
| `GET /v1/panel/register` | `view_reports` | Las cajas abiertas y las cerradas hoy ([Caja](#caja)) |
| `GET /v1/panel/alerts?day=YYYY-MM-DD` | `view_reports` | Las alertas de un día; sin `day`, hoy ([Alertas](#alertas)). Fecha inválida, que no ha llegado o de hace más de 14 días: 400 |
| `GET /v1/panel/live` (WebSocket) | `remote_access` | El aviso «algo cambió» ([Aviso en vivo](#aviso-en-vivo-websocket)) |

Qué permiso pide cada ruta está en una tabla de `apps/cloud/src/api.ts` (`PANEL_ROUTES`); una ruta que no está ahí es 404.

- **`Me`:** `{ user: { id, name, permissions: string[] }, restaurant: { id, name, slug } }`.
- **Tablero:**

```
{
  server_now, today,
  report,                      // report() de hoy hasta ahora
  last_week: { day, report_until_now, report_full },
  users,                       // id → nombre
  local: { last_seen_at, last_event_at, pending },
  open: { orders, tables, guests, total },  // «Mesas abiertas» (1.11c-2; D2)
  alerts                       // cuántas alertas tiene hoy (1.11c-2)
}
```

  `pending` es `hub_max_sequence` menos lo recibido. En `open` cuentan los pedidos abiertos que ocupan su mesa (`occupiesTable`; también los que no tienen mesa) de un PC de caja activo (D1); `tables` cuenta cada mesa, también las unidas; `total` es **lo que aún no está en ventas**, sin propinas: el neto de cada pedido y, de una **cuenta reabierta, solo su neto actual menos el neto con que cerró la última vez** (decisión D2, 3-nov-2026; [KPIS.md](KPIS.md#mesas-abiertas-panel)). Puede ser negativo.

  **El día de la semana pasada** se lee una vez que ya no puede cambiar: el reporte de un día depende solo de los eventos de la sede hasta el último de ese día; cuando la nube ya tiene todos hasta ahí (algún hub subió sin huecos hasta más allá), se guarda unos minutos en la memoria del Worker (`lastWeek` en `panel.ts`) por ese último evento, y «hasta esta hora» por min(corte, último). Un evento de ese día que llega tarde (un equipo sin conexión) cambia el último y se vuelve a calcular. Mismos números, menos lecturas (revisión de la 1.11c-2, punto 7: medido, los dos reportes de la semana pasada eran la mitad del tablero). Las alertas de hoy reusan el reporte de hoy ya calculado.

- **Cookie:**
  - nombre `__Host-faro_panel` con valor `<session_id>.<secret>`;
  - `HttpOnly; Secure; SameSite=Strict; Path=/`;
  - la nube guarda solo el sha256 del secreto;
  - vence a los 7 días sin uso, o a los 30 días de todos modos.
- **Validación en cada petición:**
  - la nube vuelve a leer `remote_users`: si a la persona le quitaron el permiso, la archivaron o cambió la contraseña (otro `verifier`), la sesión muere y sus sockets en vivo se cierran (`closeSession`);
  - **la sesión lleva su sede**: la del usuario remoto con el que entró (la fila de `remote_users` cuyo `verifier` es el que la sesión recuerda: cada uno tiene su sal). No se recalcula con «el hub que llamó de último»: una llamada de otra sede del restaurante no la mueve ni la mata (revisión de la 1.11c-2, punto 14). Al entrar, la sede es la del hub activo que llamó de último (hoy cada restaurante tiene una);
  - todo `POST`, y el WebSocket de `/v1/panel/live`, exigen que `Origin` sea la dirección del panel.
- **Límite de intentos:**
  - Rate Limiting de Workers, por IP y por `restaurante:usuario`;
  - en `panel_attempts`, una espera que crece con cada fallo, hasta 10 s por usuario, como en el hub;
  - se calcula el hash aunque el usuario no exista, para que no se note la diferencia.

### En vivo (1.11c-2)

El salón y la cocina se calculan en la nube con **las mismas proyecciones de los equipos** (`openOrders`, `kitchenTickets`, `tableStatus`, `occupiesTable`), que viven en `packages/sync/src/views/` (`@pos/sync/views`). No hay tabla de pedidos abiertos ni migración (`apps/cloud/src/live.ts`):

1. Candidatos: por pedido, el último `OrderOpened`, `OrderReopened`, `OrderClosed` u `OrderCanceled` con `business_day` desde hoy − `LIVE_WINDOW_DAYS`; quedan los que terminan en abrir o reabrir y no se unieron a otro (el origen de un `OrdersMerged`, `data.source_order_id`, ya no está abierto; sus comandas llegan igual por el pedido destino).
2. Se cargan todos sus eventos (`event_aggregates`) y, vuelta tras vuelta (`untilComplete`, hasta `LIVE_MAX_ROUNDS = 8`), los de los otros pedidos que esos eventos tocan: un plato movido desde un pedido ya cerrado sigue en la comanda que ese pedido envió.
3. `openOrders` y `kitchenTickets` sobre esos eventos, todos confirmados y en el orden del hub. La prueba: con historias al azar da lo mismo que un equipo con todos los eventos.

**Límite: `LIVE_WINDOW_DAYS = 31`.** Un pedido cuyo último abrir o reabrir tiene más de 31 días operativos no sale en el panel (la caja sí lo tiene). Así el panel nunca lee la historia entera. Decisión del dueño del 2-nov-2026.

#### PC de caja revocado

**D1 (3-nov-2026):** lo **en vivo** (Salón, Cocina, las cajas abiertas y «Mesas abiertas») es solo lo que respalda un PC de caja **activo** de la sede: sus eventos y, de un PC revocado, solo los que un activo ya subió de nuevo sin huecos (`Scope.live` y `locationScopes` en `reports.ts`: `hub_sequence` ≤ el mayor `contiguous_sequence` de los activos). Un PC que se registra de nuevo con la misma base vuelve a subir su serie desde 1: la nube ya tenía esos eventos (bajo el PC viejo) y con eso vuelven a verse los pedidos que siguen abiertos. Lo que el PC revocado dejó abierto y nadie respalda no se queda en el salón como fantasma, con sus tiempos de cocina corriendo. Sin ningún PC activo, no hay nada en vivo. En los **reportes y las alertas** (historia) cuentan todos, también los revocados.

```
GET /v1/panel/floor?plan=<version>
{
  server_now, today,
  as_of,                       // el received_at más reciente de los eventos leídos
  local: { last_seen_at, last_event_at, pending },
  plan_version,                // la huella de la instantánea `catalog`; null sin carta
  plan: { zones, tables, elements, stations } | null,   // null si el panel ya tiene esa versión
  timers: { yellow, red },     // kitchenYellowMin y kitchenRedMin de la carta (10 y 20 sin ellos)
  orders: OrderState[],        // los pedidos abiertos
  tickets: [{ key, ticket_id, order_id, station_id, number, sent_at, item_ids, ready }],
  users                        // id → nombre: meseros y quien agregó cada producto
}
```

Del plano viajan solo esos cuatro campos de la carta, en una sola lectura (sin el plano si `?plan=` ya es la versión actual), revisados **pieza por pieza**: una zona, mesa, elemento o estación que no se pueda leer se deja por fuera sola, y el resto se dibuja; un campo que no es una lista llega vacío.

### Caja

Las cajas abiertas salen de los eventos, como los pedidos abiertos (`apps/cloud/src/register.ts`): por turno, el último `ShiftOpened` o `ShiftClosed` con `business_day` desde hoy − `LIVE_WINDOW_DAYS`; quedan los que terminan en abrir, solo de un PC de caja activo ([D1](#pc-de-caja-revocado)); los cierres de hoy son de todos (historia). Van por hora de apertura y, a la misma hora, por `shift_id`. La cuenta de cada una es **la del hub**: `savedReconciliation` de `@pos/sync` sobre sus eventos, sus cobros y los pagos que sus anulaciones reversan, cargados vuelta tras vuelta (`untilComplete`). La prueba: con historias al azar da exactamente lo mismo que `HubSync.reconciliation`. Un turno abierto ayer sigue abierto; uno abierto hace más de 31 días no sale (el mismo límite del salón).

La nube no tiene el nombre de la caja: el panel la identifica por quién la abrió.

Un pago, una anulación de pago o una devolución que el hub marcó como no aplicados (llegaron a un pedido ya cerrado, tarea 1.7b) **no cuentan** en lo cobrado ni en el efectivo esperado, igual que en el hub y en el equipo de caja: van en `reconciliation.unapplied`, con su medio y su monto con signo ([DINERO.md](DINERO.md#movimientos-no-aplicados-tarea-17b)). Uno guardado antes de la marca todavía cuenta, como antes.

**D3 (3-nov-2026):** el umbral de descuadre (`threshold`, y el que decide qué cierre es alerta) es **el valor actual** de `register_variance_threshold`, también para un cierre de otro día: si el dueño lo baja, un cierre viejo con una diferencia menor que el umbral de entonces pasa a ser alerta (y al revés). La justificación que el hub exigió al cerrar fue con el umbral de ese momento.

```
GET /v1/panel/register
{
  server_now, today, as_of, local,
  threshold,                   // register_variance_threshold actual de la config (1.000 sin ella; D3)
  open: [{ shift_id, register_id, opened_at, opened_by,
           reconciliation }],  // ShiftReconciliation de @pos/core, con closed: null
  closed: ReportClose[],       // los cierres de hoy, como los `closings` de /v1/panel/reports
  users                        // id → nombre: quien abrió y quien cerró
}
```

### Alertas

`alerts()` de `@pos/core` (`packages/core/src/reports/alerts.ts`) arma las alertas de un día operativo; la nube solo reúne los eventos (`apps/cloud/src/alerts.ts`):

| Tipo | De dónde | `value` |
|---|---|---|
| `item_voided` | `report().voids` del día | lo anulado |
| `order_canceled` | `report().cancellations` del día | el neto del pedido |
| `discount` | `DiscountApplied` del día (descuento o cortesía); `removedAt` y `removedBy` si después hubo un `DiscountRemoved` | la suma de sus montos |
| `payment_voided` | `PaymentVoided` del día; `tip` y `roundingAdjustment`: la parte de `value` que fue propina y ajuste de redondeo | lo que devolvió: monto + ajuste + propina del pago; `null` (y `tip`, `roundingAdjustment` y `method` null) si el pago no está entre los eventos |
| `refund` | `RefundRecorded` del día | `sale_amount + tip_amount` |
| `order_reopened` | `OrderReopened` del día | el neto con que había cerrado; `null` sin los eventos anteriores del pedido |
| `register_variance` | los cierres de caja del día: el efectivo y cada otro medio (datáfono, apps) con `isLargeVariance(diferencia, register_variance_threshold)`, con el umbral **actual** (D3) | la diferencia, contado − esperado (negativa: faltó) |
| `unapplied_money` (tarea 1.7b) | `report().unapplied` del día: cada pago, anulación de pago o devolución que el hub guardó sin aplicar; `kind` dice cuál, con `method` y `customMethodId` | lo que habría movido la caja, con signo: + cobrado (monto + ajuste + propina), − devuelto; `null` (y `method` null) en una anulación cuyo pago no está entre los eventos |

Cada alerta lleva `id`, `time`, `order` (`{ id, number, tableId, channel }` como estaba justo antes; null en un descuadre), `userId` (quien lo hizo; en un descuadre, quien cerró), `authorizedById`, `reason` (en un descuadre, la justificación del cajero) y `value` en pesos, más los campos de su tipo. `value` es `number | null`: null solo en `payment_voided`, `order_reopened` y `unapplied_money` cuando no se puede saber (el panel dice «monto no disponible», nunca un 0 inventado). Van de la más nueva a la más vieja. Un `DiscountRemoved` de un descuento puesto otro día no es alerta (quitar un descuento no le quita plata al restaurante).

Un evento **guardado como conflicto** (no lo aplicó el pedido: llegó a una mesa ya cerrada, anuló un producto ya anulado) **no es alerta de lo que intentó**; si es dinero (un pago, una anulación de pago, una devolución), es una alerta **`unapplied_money`**, «Dinero no aplicado» en el panel, en rojo, con monto, medio, mesa y quién: alguien pudo recibir o entregar ese dinero y no está en la caja. Una anulación de producto, una cancelación o un descuento no aplicados no son alerta (no movieron dinero; el equipo que los mandó ya avisó). Un evento guardado antes de la marca se reconoce volviendo a aplicar su pedido: `alerts()` lo deja por fuera por sí misma, también la anulación o cancelación que `report()` todavía lista, y un `DiscountRemoved` guardado así no marca el descuento como quitado. Para eso la nube le pasa también todos los eventos de los pedidos de las anulaciones, las cancelaciones y el dinero no aplicado del día; sin la apertura del pedido, el evento viejo sí es alerta ([KPIS.md](KPIS.md#eventos-guardados-como-conflicto)).

En la pantalla, «Dinero no aplicado» va en el filtro por tipo y en rojo, con la leyenda «Rojo: salió dinero, la caja no cuadró o hubo dinero que no se aplicó».

```
GET /v1/panel/alerts?day=YYYY-MM-DD
{
  server_now, today,
  day,                         // el día de las alertas
  as_of, local, threshold,
  alerts: Alert[],
  users,                       // id → nombre
  tables                       // id → nombre de las mesas que nombran (de la carta)
}
```

### Aviso en vivo (WebSocket)

Cuando algo de una sede cambia en la nube, el panel abierto lo sabe al instante y vuelve a leer. El aviso **no lleva datos del restaurante**: solo dice «algo cambió»; los datos siguen saliendo de Postgres por las rutas de arriba, con su seguridad por fila. Investigación: [panel-cloudflare.md](integraciones/panel-cloudflare.md), secciones 4 y 7.

**Durable Object `PanelLive`** (`apps/cloud/src/live-object.ts`, binding `PANEL_LIVE`, migración `{ "tag": "v1", "new_sqlite_classes": ["PanelLive"] }` en `wrangler.jsonc`; se usa el arreglo `migrations`, no `exports`):
- uno por sede, con nombre `${restaurantId}:${locationId}` (`roomOf` en `live-protocol.ts`), que sale siempre de la sesión o del hub ya comprobados, nunca de la dirección;
- acepta cada WebSocket con la API de hibernación (`ctx.acceptWebSocket`), con la etiqueta `session:<id>` y el adjunto `{ sessionId, expiresAt, checkedAt }` (`checkedAt`: cuándo revisó el Worker la sesión para abrirlo);
- como mucho `MAX_SOCKETS_PER_SESSION = 10` sockets por sesión: uno nuevo cierra con 4401 el más viejo;
- `setWebSocketAutoResponse("ping" → "pong")`: el ping del panel se responde sin despertar al objeto;
- RPC `notify(reason)`: manda `{"type":"changed","reason":…}` a cada panel de la sede y cierra con **4401** los de sesión vencida y los abiertos con una revisión de sesión de hace `REVALIDATE_MS` = 1 h o más (el panel revisa `me` y, si la sesión sigue, abre otro); un socket roto no frena a los demás;
- RPC `closeSession(id)`: cierra con 4401 los sockets de esa sesión (todas sus pestañas);
- el navegador solo manda «ping»: cualquier otro mensaje cierra ese socket con **1008**; cuando el navegador cierra, responde el cierre con su código (1000 si es uno que no puede ir en un cierre: 1005, 1006, 1015);
- sin alarmas ni temporizadores (no lo dejarían dormir).

**`GET /v1/panel/live`**, en este orden y antes de tocar el Durable Object:
1. sin `Upgrade: websocket`: **426**;
2. `Origin` ausente, `null` o que no es el del panel (`PANEL_ORIGIN`, o el del Worker): **403** `invalid_origin` (otra página podría abrir el socket con la cookie);
3. sin sesión válida: **401** (y borra la cookie si traía una);
4. sin `remote_access`: 403 (en la práctica la sesión ya muere sin él: 401);
5. sin el binding (las pruebas del hub): 503.

El Worker le pasa al Durable Object el saludo del navegador **sin la cookie y sin ninguna cabecera `x-faro-*`** que haya mandado el navegador, y agrega las suyas: `x-faro-session-id` y `x-faro-session-expires` (el vencimiento absoluto de la sesión). La respuesta **101** del Durable Object se devuelve intacta: `handle` no le pone las cabeceras de seguridad, porque armar otra `Response` pierde el socket.

**Avisos** (`tellLive` en `api.ts`): siempre con `ctx.waitUntil`, después de responder; uno que falla solo se registra y no cambia la respuesta al hub.

| Cuándo | `reason` |
|---|---|
| `POST /v1/events` con al menos un evento `saved` (tras el commit). Si solo había ya guardados, divergentes o inválidos, no hay aviso | `events` |
| `PUT /v1/snapshots/:kind` guardada (una igual a la que había no avisa) | `snapshot` |
| Una llamada del hub tras más de `BACK_ONLINE_AFTER_MS` = 2 min callado (o la primera de su vida); el latido devuelve el `last_seen_at` anterior. Si en esa llamada también llegaron eventos nuevos, basta `events` | `back_online` |
| `POST /v1/panel/sign-out` | `closeSession` de esa sesión |
| Una petición del panel en la que la nube revoca la sesión (le quitaron el permiso, la archivaron, cambió la contraseña) | `closeSession` de esa sesión en las salas de las sedes del restaurante (`onSessionRevoked` de `Panel`) |

Una sesión que muere sin pasar por una petición (el hub se revocó y la sede quedó sin usuarios) no cierra su socket enseguida: por ese socket no viajan datos, al siguiente aviso el panel relee y recibe 401, y a más tardar en `REVALIDATE_MS` el objeto lo cierra para que se vuelva a revisar.

## Panel (apps/pos)

- **Entrada:** una segunda entrada de la app, `panel.html` con `src/panel/`, que se compila a `dist-panel`. El Worker la sirve con Workers Static Assets: `run_worker_first: ["/v1/*"]` y `not_found_handling: "single-page-application"`.
- **Reutiliza** el design system (`src/ui`), la marca del restaurante y las pantallas de Reportes (el contenido, sin reimprimir el cierre Z).
- **Diseño:** primero para el celular.
- **En la 1.11c-1:**
  - consulta el tablero cada 15 s mientras está a la vista;
  - si no hay respuesta, dice desde qué hora tiene los datos.
- **En vivo (1.11c-2, `src/panel/live.ts`):**
  - un WebSocket por pestaña, a `wss://<host>/v1/panel/live`, abierto solo con sesión y con la pestaña a la vista (escondida lo cierra: Safari los corta igual);
  - manda `ping` cada 25 s; sin `pong` en 10 s da el socket por muerto y reconecta;
  - reconecta a los 1, 2, 5, 10, 20 y 30 s (y luego cada 30 s), cada espera con ±20 % de azar; al volver a la vista o con el evento `online`, al instante. La espera y el conteo de fallos vuelven a cero solo cuando el socket lleva **5 s vivo**: un servidor que acepta y corta enseguida no se reintenta cada segundo;
  - con un cierre 4401 (sesión vencida, revisión de cada hora o más de 10 sockets de la misma sesión), o tras 3 intentos seguidos que no abren (así se ve un 401 en el saludo), pregunta `me()`: si da 401 vuelve a «Entrar» con «Tu sesión se cerró»; si no, abre otro socket. Un `online` que llega mientras pregunta no se pierde: al terminar conecta al instante;
  - con un cierre **1008** (el navegador mandó algo que no es `ping`) no reintenta en bucle: queda sin socket hasta que la pestaña vuelva a la vista o regrese el internet, y mientras tanto las pantallas leen cada 15 s;
  - estados `connecting`, `live` y `down`; junto al título de cada pantalla, en pequeño y en gris: «En vivo», «Conectando…» o «Se actualiza cada 15 s»;
  - al reabrir tras una caída avisa «cambió» (lo que pasó mientras no se oyó).
- **Estados de los datos** (`DataStatus.tsx`, en las cinco pantallas): «Leyendo…» pasa a «Tarda más de lo normal» a los 5 s; si una lectura falla, el aviso sale una sola vez, con la hora de las cifras y un botón **«Intentar ahora»**; «Sin noticias del restaurante desde las HH:MM» trae una segunda línea: «Puede que la caja esté apagada o sin internet. Las cifras son de las HH:MM.».
- **Relectura** (`poller.ts`): con `changed`, la pantalla visible vuelve a leer como mucho cada **3 s** en Salón y Cocina y cada **10 s** en Hoy, Caja, Alertas y Reportes (estos solo si el período llega a hoy), sin peticiones encimadas: si llega otro aviso durante una lectura, hace una más al terminar. La consulta de respaldo sigue: cada **60 s** con el socket vivo y cada **15 s** sin él. Escondida no pide; al volver a la vista pide al instante.
