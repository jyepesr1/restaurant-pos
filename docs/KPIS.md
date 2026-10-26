# Indicadores y reportes

Las fórmulas de cada número de los reportes (tarea 1.9). Todos salen de los **mismos eventos** del hub, con el código de `@pos/core` (`src/reportes/`), para que cuadren entre sí. Dinero en pesos enteros (ADR-004); las reglas de dinero están en [DINERO.md](DINERO.md).

## Período

- Un reporte cubre uno o varios **días operativos** completos (por defecto de 6:00 a. m. a 5:59 a. m. del día siguiente, `inicio_dia_operativo`).
- Un **pedido** cuenta en el día de su **primer cierre** (`PedidoCerrado`), con lo que tenía al cerrarse.
- **Lo ya reportado de un día no cambia nunca** (decisión del dueño, 26-oct-2026; DINERO.md#día-operativo-e-informes). Si una mesa se reabre y se vuelve a cerrar otro día, ese otro día suma **solo la diferencia** (el pedido al cerrar de nuevo menos como estaba en su cierre anterior); puede ser negativa si se corrigió un cobro. Una mesa reabierta que sigue abierta conserva lo que reportó en su cierre anterior. La cuenta y sus comensales se cuentan una sola vez, en el primer cierre.
- Un **pago**, una **anulación de pago**, un **reembolso** y un **movimiento de caja** cuentan en el día en que se registraron (`dia_operativo` del evento).
- Una **anulación de producto** y una **cancelación** cuentan en el día en que se registraron.

## Ventas

Sobre los cierres de mesa del período (lo que sumó cada uno):

| Indicador | Fórmula |
|---|---|
| Bruto | Σ por línea: cantidad × precio unitario con extras |
| Anulado | Σ por línea: unidades anuladas × precio unitario con extras |
| Descuentos | Σ descuentos de las líneas |
| **Neto** (ventas) | bruto − anulado − descuentos. Es lo que pagan los clientes sin propina |
| Impuestos | Por tipo y tarifa, el desglose por línea del documento DIAN (DINERO.md#desglose-fiscal): las centésimas de todas las líneas del período se suman por grupo y se redondean a pesos **una sola vez**; la base es el neto del grupo menos su impuesto. Informativo hasta la Fase 2: **(validar)** con el contador |
| Ajuste por redondeo | Σ ajuste de redondeo del efectivo de los pagos de esos pedidos (lo cobrado de más o de menos al redondear; renglón propio del cierre Z) |
| Propinas | Σ propina de los pagos de esos pedidos, menos lo reembolsado de propina |
| Cuentas | Pedidos cerrados con neto > 0 |
| Comensales | Σ comensales de esos pedidos |
| Ticket promedio | neto ÷ cuentas, redondeado a pesos con el `redondeo_modo` del restaurante (por defecto, mitad hacia arriba); 0 sin cuentas |
| Gasto por comensal | neto ÷ comensales, redondeado igual; 0 sin comensales |

Identidad: `neto = Σ (monto − reembolso de venta)` de los pagos de esos pedidos, sin importar el día en que se registró cada pago (DINERO.md#día-operativo-e-informes).

## Por medio de pago

Sobre los pagos **registrados** en el período (no los de los pedidos cerrados): por medio (los propios por su nombre), venta = Σ (monto + ajuste de redondeo) y propina = Σ propina, menos las anulaciones y reembolsos registrados en el período. Por eso puede diferir del neto: un abono de una mesa que se cierra mañana cuenta hoy aquí y mañana en ventas.

## Por mesero

Por defecto a **quien agregó cada ítem** (`ventas_por_mesero: 'quien_agrega'`), también si el ítem pasó a otra mesa; con `'mesero_asignado'`, al mesero de la mesa. Por mesero:

| Indicador | Fórmula |
|---|---|
| Neto | Σ neto de sus líneas en los pedidos cerrados |
| Cuentas | Pedidos cerrados en los que tiene al menos una línea con neto > 0 |
| Ticket promedio | su neto ÷ sus cuentas |

Las propinas van a un **fondo común** (ADR-011): no se reparten por mesero.

## Por producto

Por producto y variante, sobre las líneas de los pedidos cerrados: unidades vendidas (cantidad − anuladas), neto y % del neto total (con un decimal, solo para mostrar). Ordenado de más a menos neto.

## Anulaciones y cancelaciones

- **Anulaciones**: cada `ItemAnulado` del período, con producto, unidades, valor (unidades × precio con extras, del pedido tal como estaba al anular: el ítem pudo pasar después a otra mesa), motivo, si la cocina ya lo había hecho (merma), quién y quién autorizó.
- **Cancelaciones**: cada `PedidoCancelado` del período, con lo que tenía, el motivo y quién.
- **Descuentos**: cada descuento aplicado y vigente en los pedidos cerrados, con regla, valor, monto y motivo (quién lo autorizó queda en el evento; el reporte aún no lo muestra).

## Caja

- **Cierres**: cada turno cerrado del período, con el cuadre de [DINERO.md#caja](DINERO.md#caja): base, efectivo esperado, contado y diferencia, los demás medios (registrado, según su cierre y diferencia) y la justificación.
- **Fondo de propinas**: propinas registradas en el período (de todos los medios, netas de reembolsos) − propinas pagadas desde la caja (`pago_propinas`) = saldo del período.

## Cierre Z impreso

Al cerrar la caja sale en la impresora de precuentas (si hay una elegida) y se puede reimprimir desde Reportes:

- el cuadre del turno (efectivo y demás medios, con la justificación);
- las ventas del día operativo en que **se abrió** el turno (aunque se cierre pasadas las 6 a. m.): neto, ajuste por redondeo, impuestos discriminados, propinas, cuentas, comensales y ticket promedio;
- lo cobrado por medio de pago en el turno;
- lo anulado (la suma de las anulaciones registradas en el día, como la lista de Reportes), lo cancelado y lo descontado del día.

## Exportar

El reporte se descarga en CSV para Excel: separado por punto y coma, en UTF-8 con BOM (para que Excel en español lea las tildes), con los montos como enteros en pesos, sin separador de miles.
