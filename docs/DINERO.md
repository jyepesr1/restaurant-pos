# Reglas de dinero

Fórmulas exactas de todo cálculo de dinero. Las implementa `packages/core` (tarea 0.5) y son las mismas en el celular, el hub y la nube. Decisión de fondo: [ADR-004](DECISIONES.md#adr-004--dinero-en-pesos-enteros-decimales-solo-dentro-del-cálculo-fiscal). Lo marcado **(validar)** debe confirmarlo el contador o el proveedor DIAN antes de producción; todo lo marcado como parámetro está en `Restaurante.config` ([MODELO_DATOS.md](MODELO_DATOS.md#configuración-del-restaurante)).

## Principios

1. **Pesos enteros** en todo monto. Fiscal en **centésimas** enteras. Porcentajes en **puntos básicos** (1 % = 100).
2. Las fracciones solo existen dentro de una fórmula, como numerador y denominador enteros (`BigInt`), y se redondean **una sola vez**, al final.
3. **Redondeo** por defecto: a la mitad hacia arriba, `redondeo(a / b) = ⌊(2a + b) / (2b)⌋` para `a, b ≥ 0`. Parámetro `redondeo_modo`.
4. **Repartos por mayor residuo**: las partes suman exactamente el total. Desempate por orden: el de las líneas es el orden en que se agregaron; el de las cuentas, el orden de creación.
5. Todo monto que sale de un cálculo **se guarda ya calculado en el evento**; la proyección lo lee y nunca lo recalcula.
6. Límites: la unidad completa (precio + extras) ≤ $100.000.000; cantidad de 1 a 999; bruto de un pedido ≤ $10.000.000.000. Todo resultado debe caber en `Number.MAX_SAFE_INTEGER`. Zod rechaza lo que se salga.

Campos de dinero **con signo** (los únicos que pueden ser negativos): `ajuste_redondeo`, `diferencia` del turno por medio, `MovimientoInventario.cantidad`. Todos los demás son ≥ 0.

## Línea de pedido

```
bruto_linea      = cantidad × (precio_unitario + Σ precio_extra de sus modificadores)
neto_tras_linea  = bruto_linea − Σ descuentos de la línea
neto_linea       = neto_tras_linea − Σ partes de los descuentos del pedido
```

Ejemplo: 2 × hamburguesa $39.900 con extra de queso $3.000 → bruto 2 × 42.900 = **85.800**.

## Descuentos

Siempre en **pesos con impuesto incluido**. Los porcentajes se convierten a pesos al aplicarse y quedan fijos en el evento.

| Tipo | Cálculo | Ejemplo |
|---|---|---|
| % a una línea | `redondeo(bruto_linea × bp / 10000)` | 15 % de $12.950 = 1.942,5 → **1.943** |
| Valor a una línea | El valor | $5.000 a una pizza de $40.900 → neto 35.900 |
| Cortesía | `k × (precio_unitario + Σ extras)` para `k` unidades de la línea | 1 de 3 cervezas de $14.900 → 14.900 |
| % al pedido | `redondeo(Σ neto_tras_linea × bp / 10000)`: sobre el neto de las líneas después de sus propios descuentos, **sin** restar otros descuentos del pedido | |
| Valor al pedido | El valor | |

- El **valor** de cada descuento del pedido se calcula sobre la misma base común (`Σ neto_tras_linea`), así que no hay cascada en el monto.
- Su **reparto** entre líneas es por mayor residuo, en proporción a lo que **le queda a cada línea** después de los descuentos del pedido ya aplicados. Ejemplo: $5.000 sobre 40.900 + 12.900 → **3.801 + 1.199**. Con `descuento ≤ Σ lo que queda`, ninguna línea puede quedar negativa, ni siquiera por residuos empatados (líneas 12.900 + 12.950 + 12.950 con 5 % y luego 95 % → netos 0, 0, 0).
- **Ninguna línea queda negativa**: se rechaza el descuento que lleve una línea (o el pedido) por debajo de 0. Ejemplo: 3 cervezas en cortesía (44.700) + pizza 40.900, y luego 10 % al pedido: el 10 % se calcula sobre el neto 40.900 → 4.090, todo a la pizza; la cerveza queda en 0, no en −4.470.
- Mientras una línea tenga descuentos o el pedido esté dividido, cambiar su cantidad, anularla, moverla o agregarle modificadores con precio exige antes `DescuentoRetirado` o `DivisionDeshecha`. Así un descuento fijado en pesos nunca queda mayor que su línea.
- Trato fiscal de cortesías y descuentos al pedido: **(validar)**.

## Desglose fiscal (documento DIAN, cierre Z)

Por cada línea neta, con la tarifa `t` copiada en el ítem:

```
base_c     = redondeo(neto_linea × 100 × 10000 / (10000 + t))      (centésimas)
impuesto_c = neto_linea × 100 − base_c
```

Base e impuesto siempre suman el total exacto. Ejemplos:

| Neto de la línea | Tarifa | Base (centésimas) | Impuesto (centésimas) |
|---|---|---|---|
| $40.900 | 8 % | 3.787.037 | 302.963 |
| 2 × $12.900 = $25.800 | 8 % | 2.388.889 | 191.111 |
| $16.000 | 8 % | 1.481.481 | 118.519 (¹) |
| $0 | 8 % | 0 | 0 |
| $40.900 | exento (0) | 4.090.000 | 0 |

(¹) Calculado como diferencia, el impuesto puede diferir en 1 centésima de `base × tarifa` (pasa con $200, $2.500, $16.000, $29.900, $34.900, $40.300). **(validar)** si el proveedor DIAN lo acepta o exige `impuesto = redondeo(base × tarifa)` con un ajuste en otro campo.

- Granularidad por línea por defecto (`granularidad_fiscal`) **(validar)**.
- Desde la Fase 1, el cierre Z calcula impuestos con esta misma función. Los reportes de impuestos suman los documentos emitidos; no recalculan sobre totales.

## Propina sugerida

Sobre la **base sin INC, neta de descuentos** (decisión del dueño), con un solo redondeo:

```
propina = redondeo( Σ_líneas neto_linea × 10000 / (10000 + t_linea) × tasa / 10000 )
```

| Cuenta | Propina 10 % | Nota |
|---|---|---|
| $100.000 al 8 % | **9.259** | base exacta 92.592,59 |
| $16.000 al 8 % | **1.481** | redondear primero la base daría 1.482 (error) |
| $2.500 al 8 % | **231** | redondear primero daría 232 |
| $53.800 con 10 % de descuento (neto 48.420) | **4.483** | sobre el neto, no sobre el bruto |

- En cuentas divididas se calcula la propina **sobre el saldo que se divide** (sin la cuenta `general` ya pagada) y se reparte por mayor residuo en proporción al `monto` de cada cuenta; cada precuenta guarda el monto impreso (`PrecuentaImpresa` con `cuenta_id`). Ejemplo: pedido de $100.000 al 8 % con $40.000 ya pagados y el saldo de $60.000 en 2 cuentas → propina de las dos cuentas 5.556 → 2.778 + 2.778.
- La propina va fuera de la base gravable y fuera del documento como venta. Tope legal y si aparece en el documento: **(validar)**.
- **En efectivo**, la propina se sugiere redondeada al múltiplo del efectivo (`redondeo_efectivo`, con `redondeo_efectivo_modo`): $23.843 → **$23.800**, para que el total se pueda pagar con billetes. El cajero la puede cambiar, y si el cliente deja el cambio, ese cambio pasa a `propina`. Con tarjeta va exacta. Es un redondeo de la propina, no de la venta: no toca `ajuste_redondeo` ni el documento DIAN (decisión del dueño, 24-oct-2026).

## División de la cuenta

- Los montos de cada cuenta se calculan al dividir y quedan fijos en `CuentaDividida`. **Partes iguales**: mayor residuo sobre el saldo (100.000 ÷ 3 → 33.334 + 33.333 + 33.333).
- **Ítem compartido**: fracción como numerador/denominador enteros (1/3 de botella); su neto se reparte por mayor residuo.
- **Por monto libre**: lo que no se asigne queda en la cuenta `sin_asignar`.
- **Con pagos previos**: se divide el saldo pendiente; los pagos ya hechos quedan en la cuenta `general`.
- Lo que se agregue después de dividir va a `sin_asignar`. Una cuenta con pagos nunca se recalcula. `DivisionDeshecha` solo si ninguna cuenta tiene pagos.

## Pagos

| Regla | Detalle |
|---|---|
| Monto | `0 < monto ≤ saldo de la cuenta`. `monto` es la parte del saldo que el pago cancela. |
| Efectivo | `recibido = monto + ajuste_redondeo + propina + cambio`, con `cambio ≥ 0`. Si el cliente deja el cambio, el cajero lo marca y pasa a `propina`. |
| Otros medios | Sin `recibido` ni `cambio`. En datáfono, `monto + propina` debe ser igual al total aprobado. |
| Redondeo del efectivo | Solo en el pago en efectivo **que deja el saldo en 0**. Se cobra el saldo redondeado al múltiplo `m = redondeo_efectivo` ($100) más cercano; la mitad, a favor del cliente — parámetro `redondeo_efectivo_modo`: `cobrado = m × ⌊(2 × saldo + m − 1) / (2m)⌋`. `ajuste_redondeo = cobrado − monto`. El evento trae la regla (`redondeo`: múltiplo y modo) y el reductor exige que el ajuste sea exactamente el que da esa regla. |
| Saldo de hasta medio múltiplo | Saldo de $30 (o de $50) tras pagar con tarjeta: se cobra $0 y el ajuste es −30 (o −50). |
| Sin turno | `PagoRegistrado` se rechaza si la caja no tiene turno abierto. |
| Reembolsos | Por el mismo medio del pago. Cada reembolso separa `monto_venta` y `monto_propina`. Topes: `Σ monto_venta ≤ monto` y `Σ monto_propina ≤ propina`; en efectivo, además, el total no puede pasar de lo cobrado (`monto + ajuste_redondeo + propina`). El de venta exige nota crédito si ya hubo documento DIAN; el de propina resta del fondo el día del reembolso. Para devolver toda la venta de un pago en efectivo con ajuste, se anula el pago (así el ajuste también se revierte); un pago con reembolsos ya no se anula. |

Ejemplos de efectivo:

| Saldo | Cobrado | Ajuste | El cliente da | Cambio |
|---|---|---|---|---|
| $36.810 | $36.800 | −10 | $40.000 | $3.200 |
| $36.850 | $36.800 | −50 | $40.000 | $3.200 |
| $36.851 | $36.900 | +49 | $40.000 | $3.100 |
| $36.860 | $36.900 | +40 | $50.000 | $13.100 |
| $36.800 | $36.800 | 0 | $36.800 | $0 |

El documento DIAN dice el **total exacto de la venta**; la suma de los `ajuste_redondeo` de los pagos de ese pedido o cuenta va como redondeo del valor a pagar (`PayableRoundingAmount` en UBL). Ejemplo: total 100.000 pagado con 63.190 en tarjeta y 36.810 en efectivo (se cobran 36.800) → documento por 100.000 con redondeo −10 **(validar)**.

## Caja

```
esperado_efectivo = base
                  + Σ efectivo (monto + ajuste_redondeo + propina)
                  − Σ reversas y reembolsos en efectivo del turno
                  + entradas − salidas − pago_propinas − retiros_parciales

esperado_otro_medio = Σ (monto + propina) − Σ anulaciones y reembolsos de ese medio
diferencia          = contado − esperado     (por medio, con signo)
```

Ejemplo: base 200.000; venta en efectivo con saldo 36.810 (ajuste −10, propina 3.000); `pago_propinas` 20.000 → esperado **219.800**.

Un `PagoAnulado` o reembolso cae en el turno en que se registra, no en el del pago original. La reversa en efectivo de un pago anulado es lo que se cobró: `monto + ajuste_redondeo + propina`.

## Fondo de propinas

- Todas las propinas del día, de todos los medios, van a un fondo común (decisión del dueño).
- Cada `pago_propinas` indica de qué días del fondo sale y a quién se pagó (texto libre).
- El fondo lleva **saldo acumulado**: las propinas de tarjeta que se pagan otro día no dejan negativo el fondo de ese día.
- La propina de un pago anulado sale del fondo del día de la anulación.

## Día operativo e informes

- Un pedido pertenece al día operativo de su **primer cierre**. Si se reabre otro día, las diferencias van al día de la reapertura; el cierre Z de un día ya cerrado no cambia.
- Cada pago pertenece al turno y al día en que se registró.
- Identidades que siempre deben cumplirse (prueba de propiedades sobre servicios simulados):
  - `bruto − descuentos − anulaciones = neto`;
  - `Σ neto de líneas de los pedidos cerrados en el día = Σ monto (menos reembolsos de venta) de los pagos de esos mismos pedidos`, sin importar en qué día o turno se registró cada pago. La caja, en cambio, cuadra por turno de registro, y los abonos de mesas aún abiertas se muestran aparte como saldos abiertos;
  - `Σ cobrado = Σ monto + Σ ajuste_redondeo` (el ajuste es un renglón propio del cierre Z);
  - ventas por medio de pago = ventas por mesero (a quien agregó cada ítem, también tras mover o unir) = resumen = documentos DIAN.

## Precio copiado

- El celular copia en `ItemAgregado` el precio, los extras y el impuesto vigentes en su catálogo, con la `catalogo_version` y el `precio_canal_id` (happy hour, brunch).
- El hub compara esos valores con el **historial del catálogo** en esa versión (`apps/hub/src/precios.ts`) y, cuando existan las franjas horarias, con su propia hora. Cualquier diferencia → el ítem **se acepta** con conflicto `precio_distinto` para la caja: ya se pidió, quizá sin conexión, y no se pierde. La tarifa siempre se valida contra `Impuesto`. Una versión de catálogo que el hub no tiene también es `precio_distinto`.
- **Un producto con variantes exige `variante_id`**, y `precio_unitario` es el `precio` de esa variante. `producto.precio` de un producto con variantes (el de la más barata) solo sirve para mostrar. Ejemplo: Ramón Bilbao Crianza sin variante sería una botella de $129.900 cobrada a $30.900. La pantalla obliga a elegir, y el hub marca `precio_distinto` un ítem sin variante, con una variante de otro producto o con el precio de otra variante (pruebas en `apps/hub/src/precios.test.ts`).
- **Cada cambio del catálogo deja su `CatalogoCambiado`** en el historial: el editor y el seed escriben por el mismo camino (`apps/hub/src/acceso/registros.ts`).
- Lo que se revisa: el producto activo; la variante obligatoria si tiene, y de ese producto; el precio de la variante o del producto; el impuesto activo con su tipo y tarifa; cada opción activa, una sola vez, de un grupo activo enlazado al producto, con su precio extra. Un `precio_canal_id` todavía no es válido (los precios por canal llegan después).
- El historial empieza con la migración 3 (`historial_desde`): para una versión anterior solo se conoce el estado de cada registro en ese momento, y se compara contra él.
- **Pendiente:** `ItemModificadoTrasEnvio` también trae precios extra y no se revisa todavía (llega con la toma de pedido de la 1.3). Un evento guarda un solo conflicto: si ya tenía otro (p. ej. `pedido_cerrado`), el de precio no se anota.

## Datáfonos

- Conciliación: `Σ (monto + propina)` de los pagos contra el `total` aprobado de la transacción.
- El importador lee montos como texto con el **formato numérico configurado por proveedor** (separador de miles y decimal) y los convierte a enteros sin `parseFloat`; rechaza fracciones de peso.

## Casos de prueba de la tarea 0.5

Cada regla con caso normal, bordes y, donde aplique, prueba de propiedades (fast-check).

| Área | Casos |
|---|---|
| Redondeo | mitad hacia arriba; `a = 0`; denominador 1; valores máximos con `BigInt` |
| Mayor residuo | 100.000/3; 1 parte; total 0; más partes que pesos (2/3 → 1+1+0); pesos todos 0; desempate determinista. Propiedades: Σ partes = total, partes ≥ 0, cada parte a menos de 1 de lo exacto |
| Línea | 2 × 12.900; cantidad × (precio + extras); extra de $0; rechazo de cantidad 0, negativa, fraccionada o > 999 |
| Desglose fiscal | 40.900 → 3.787.037 + 302.963; 25.800; 16.000, 29.900, 200 (diferencia de 1 centésima); precio 0; exento; IVA 19 %; precio máximo. Propiedad: base + impuesto = neto × 100 |
| Descuentos | 15 % de 12.950 → 1.943; $5.000 al pedido → 3.801 + 1.199; varios sin cascada; cortesía 1 de 3; cortesía total + % al pedido sin negativos; descuento mayor que el neto → rechazo; pedido de $0; cambio de cantidad con descuento → exige retirarlo; dos descuentos de pedido que suman el 100 % con residuos empatados (12.900 + 12.950 + 12.950, 5 % y 95 %). Propiedad: Σ partes = descuento, ninguna línea < 0 |
| Propina | 100.000 → 9.259; 16.000 → 1.481; 2.500 → 231; con descuento → 4.483; tarifas mezcladas; reparto entre cuentas suma la total; con pago previo en `general` (5.556); división por monto libre; tasa 0 |
| División | partes iguales; 1 comensal; por ítems; por monto con `sin_asignar`; ítem compartido 1/3; varios compartidos; ítem agregado después; con pago previo; `DivisionDeshecha` con pagos → rechazo. Propiedad: Σ cuentas = total |
| Efectivo | tabla de ejemplos de arriba (36.850 frente a 36.851); saldo de $30 y de $50 → $0; saldo múltiplo de 100; pago mixto con tarjeta; cambio que pasa a propina; identidad de `recibido` |
| Pagos | monto 0 o mayor que el saldo → rechazo; sin turno → rechazo; doble pago; anulación en otro turno; reembolso parcial, mayor que lo pagado y con ajuste negativo; reembolso partido en venta y propina; cierre solo con saldo 0; anulación de ítem que dejaría saldo negativo → rechazo; anulación parcial (1 de 3) |
| Caja y fondo | esperado con ajuste, propina, `pago_propinas` y reversas (ejemplo 219.800); diferencia con signo; fondo con propinas que pasan de un día a otro |
| Informes | identidades de arriba sobre servicios simulados con reasignación, movimiento y unión de pedidos, abono antes del corte de día y cierre después, abono en una mesa aún abierta, y reapertura de otro día |
| Proyección | mismos eventos → mismo estado; `aplicarEvento` nunca lanza; los montos se leen del evento |
| Esquemas | negativos donde no corresponde, fracciones, enteros no seguros y montos sobre el límite → rechazo |
