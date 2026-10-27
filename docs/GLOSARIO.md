# Glosario: términos del dominio en el código

Desde el 26-oct-2026 el código de Faro está en inglés (ver [ADR-010](DECISIONES.md#adr-010--idioma-código-y-commits-en-inglés-interfaz-y-documentación-en-español)). La interfaz, lo que se imprime, los mensajes al usuario, la documentación y la conversación siguen en español. Esta tabla fija **un solo nombre en inglés por término** para todo el código: identificadores, archivos, tablas y columnas, rutas de la API, tipos de evento y claves guardadas.

Reglas generales:

- Inglés de producto POS estándar (Toast, Square), en inglés de Estados Unidos (`canceled`, `color`).
- Tipos y componentes en `PascalCase`, variables y funciones en `camelCase`, constantes en `UPPER_SNAKE`, columnas, claves de evento y códigos de error en `snake_case`, rutas en `kebab-case`.
- Eventos: sustantivo + participio, como en `ItemVoided`, `OrderOpened`, `ShiftClosed`.
- Tablas de la base en plural (`orders`, `order_items`); evita palabras reservadas de SQL (`order`, `table`, `user`) y deja las columnas en singular (`order_id`).
- Los textos en español que ve el personal no se traducen: pantallas, comanda, precuenta, cierre Z, mensajes (`mensaje` pasa a llamarse `message`, pero su contenido sigue en español), encabezados del CSV y avisos.

## Pedido y servicio a la mesa

| Español | Inglés | Notas |
|---|---|---|
| Pedido | `Order` · tabla `orders` | `PedidoAbierto` → `OrderOpened`, `PedidoCerrado` → `OrderClosed`, `PedidoReabierto` → `OrderReopened`, `PedidoCancelado` → `OrderCanceled` |
| Pedido de rescate | rescue order | `PedidoRescateCreado` → `RescueOrderCreated` |
| Pedidos unidos / unir mesas | merged orders / merge tables | `PedidosUnidos` → `OrdersMerged`, mesas unidas → `mergedTables` |
| Ítem (línea del pedido) | `Item` · tabla `order_items` | `ItemAgregado` → `ItemAdded`, `ItemCambiado` → `ItemChanged`, `ItemQuitado` → `ItemRemoved`, `ItemBorrado` → `ItemDeleted`, `ItemsMovidos` → `ItemsMoved` |
| Anulación / anular | void | `ItemAnulado` → `ItemVoided`, `PagoAnulado` → `PaymentVoided` |
| Cancelación / cancelar | cancellation / cancel | |
| Comanda | `Ticket` (comanda de cocina) | `comandas` → `tickets` |
| Toma de pedido | order entry | `TomaPedido` → `OrderEntry` |
| Mesa | `Table` · tabla `dining_tables` | `mesa_id` → `table_id`. La tabla SQL lleva `dining_` porque `table` es palabra reservada |
| Zona | `Zone` | |
| Plano (de mesas) | floor plan | `elemento_plano` → `floor_plan_elements` |
| Sala (la operación: plano, pedidos, caja) | `Floor` | `src/sala` → `src/floor`, `SalaSync` → `FloorSync` |
| Salón (canal) | dine-in | canal `salon` → `dine_in`, `para_llevar` → `takeout`, `domicilio` → `delivery` |
| Canal | channel | |
| Comensal(es) | guest(s) | número de comensales → `guests` |
| Persona(s) (en la mesa) | people | |
| Silla | seat | |
| Curso / tiempo | course | |
| Plato | dish | |
| Nota | note | |
| Término (de cocción) | doneness | |
| Sabor | flavor | |
| Enviar / mandar a cocina | send (fire) | enviado → `sent` |
| Agotado / agotar | sold out / mark sold out | `ProductoAgotado` → `ProductSoldOut`, `ProductoDisponible` → `ProductAvailable` |
| Mesero | `Waiter` | No `server`, para no confundirlo con el servidor HTTP |
| Cocina | `Kitchen` | |
| Pantalla de cocina (KDS) | kitchen screen / KDS | |
| Estación | `Station` | |
| Borrador | draft | |

## Carta y catálogo

| Español | Inglés | Notas |
|---|---|---|
| Carta | `Menu` | |
| Catálogo | `Catalog` | `CatalogoCambiado` → `CatalogChanged`, `catalogo_cambio` → `catalog_changes` |
| Categoría | `Category` | |
| Producto | `Product` | |
| Variante | `Variant` | |
| Grupo de modificadores | `ModifierGroup` | |
| Modificador | `Modifier` | |
| Precio | price | precio unitario → `unitPrice` |
| Impuesto | `Tax` | |
| Tarifa | rate | |
| Foto | photo | |
| Marca (del restaurante) | brand | |

## Caja y dinero

| Español | Inglés | Notas |
|---|---|---|
| Caja (puesto y rol) | `Register` | `/api/caja/...` → `/api/register/...` |
| Cajero | cashier | |
| Turno | `Shift` | `TurnoAbierto` → `ShiftOpened`, `TurnoCerrado` → `ShiftClosed` |
| Apertura / cierre de turno | shift opening / shift close | |
| Arqueo | cash count | `ArqueoRegistrado` → `CashCountRecorded` |
| Cuadre | reconciliation | `CuadreTurno` → `ShiftReconciliation` |
| Diferencia | variance | diferencia del turno |
| Movimiento de caja | cash movement | `MovimientoCajaRegistrado` → `CashMovementRecorded` |
| Fondo de propinas | tip pool | |
| Precuenta | `PreBill` | `PrecuentaImpresa` → `PreBillPrinted`, ruta `pre-bill` |
| Cuenta (división del pedido) | `Check` | `CuentaDividida` → `CheckSplit` |
| Dividir | split | |
| Cobro / cobrar | checkout / charge | `Cobro.tsx` → `Checkout.tsx`. No `payment`, que es el pago ya registrado |
| Pago / pagar | `Payment` / pay | `PagoRegistrado` → `PaymentRecorded` |
| Reembolso | refund | `ReembolsoRegistrado` → `RefundRecorded` |
| Medio de pago | payment method | `medio` → `method` |
| Medio propio | custom method | medio que define el restaurante (`medio_propio_id` → `custom_method_id`) |
| Otros medios | other methods | |
| Efectivo | cash | |
| Tarjeta | card | |
| Datáfono | `CardTerminal` | |
| Propina | tip | |
| Descuento | discount | `DescuentoAplicado` → `DiscountApplied`, `DescuentoRetirado` → `DiscountRemoved` |
| Monto | amount | |
| Saldo | balance | |
| Neto / bruto | net / gross | |
| Redondeo | rounding | `ajuste_redondeo` → `rounding_adjustment` |
| Reparto (mayor residuo) | allocation (largest remainder) | |
| Dinero | money | |
| Pesos | pesos | |

## Reportes

| Español | Inglés | Notas |
|---|---|---|
| Informe / reporte | `Report` | |
| Cierre Z | `ZReport` | `cierre-z` → `z-report` |
| Ventas | sales | |
| Día operativo | business day | `dia_operativo` → `business_day` |
| Período | period | |

## Acceso y personal

| Español | Inglés | Notas |
|---|---|---|
| Personal | staff | |
| Usuario | `User` · tabla `users` | |
| Rol | `Role` | |
| Permiso | `Permission` | |
| Gerente | manager | |
| Administrador | admin | |
| Entrar (iniciar sesión) | sign in | |
| Sesión | `Session` | |
| Contraseña | password | |
| Clave | key | `clave` del rol → `key` |
| Comprobante (de supervisor) | approval | prueba firmada de que alguien con el permiso aprobó |
| Autorización / autorizar | authorization / authorize | |
| Vigente | current | credencial no reemplazada |
| Activo | active | |
| Revocar | revoke | |
| Emparejar | pair | |
| Credencial | credential | |
| Intentos | attempts | |
| Restablecer | reset | `restablecer-admin` → `reset-admin` |

## Equipos, sincronización e impresión

| Español | Inglés | Notas |
|---|---|---|
| Restaurante | `Restaurant` | |
| Sede | `Location` | |
| Hub (PC de caja) | `Hub` | |
| Nube | `Cloud` | `apps/nube` → `apps/cloud`, `@pos/nube` → `@pos/cloud` |
| Dispositivo / equipo | `Device` | |
| Evento | `Event` | `datos` → `data` |
| Agregado (pedido, producto, turno) | aggregate | `agregado_id` → `aggregate_id` |
| Secuencia | sequence | |
| Huella | fingerprint | |
| Firma / firmar | signature / sign | |
| Cuarentena | quarantine | |
| Rechazado | rejected | |
| Conflicto | conflict | |
| Proyección | projection | |
| Instantánea | snapshot | |
| Almacén (de datos) | store | |
| Motor (de la app) | engine | |
| Conexión | connection | |
| Sincronización | sync | |
| Impresora | `Printer` | |
| Trabajo de impresión | print job | tabla `print_jobs` |
| Cola | queue | |
| Respaldo | fallback | impresora de respaldo |
| Aviso | alert / toast | `avisos.tsx` (avisos con Deshacer) → `toasts.tsx`; los demás avisos → `alert` |
| Diagnóstico | diagnostics | |
| Arranque | startup | |
| Migración | migration | |
| Esquema | schema | |
| Semilla / sembrar | seed | |
| Bocetos | mockups | `src/bocetos` → `src/mockups` |
| Pruebas (carpeta de ayudas) | testing | `pruebas/` → `testing/` |
| Montaje (de pruebas) | setup | |
| Mundo (de pruebas) | world | |
