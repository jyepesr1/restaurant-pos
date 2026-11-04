# Design system de Faro

Cómo se ve Faro y por qué (ADR-014). La verdad está en el código: `src/styles.css` (tokens), `src/ui` (componentes) y `src/floor/FloorFrame.tsx` (marco). Este documento lo resume para quien diseña la próxima pantalla.

## Estilo

El de los POS modernos del mercado, con el máximo cuidado. Las referencias son RestroBit y Tasty Station: herramienta clara y conocida, sin adornos.

- La marca vive en los detalles:
  - el verde azulado en la acción principal y en lo elegido;
  - el logo del faro;
  - la letra Figtree.
- El color de estado dice qué pasa y nunca va solo: siempre con ícono y texto.

## Color

Estrategia contenida: neutros fríos y un acento. Todo par de texto y fondo cumple AA en claro y oscuro (`src/ui/contrast.test.ts`).

**Capas**

| Token | Para qué |
|---|---|
| `background` | El lienzo de la pantalla. |
| `surface` | Tarjetas, paneles, el plano. |
| `surface-2` | Lo hundido: campos, fondos de foto, la tarjeta de quién entró. |
| `sidebar` | La barra lateral y la superior. |
| `divider` | Separadores y bordes de tarjeta, que no son controles. |
| `border` | Borde de los controles (3:1). |
| `--shadow` (`shadow-float`) | Lo que flota: tarjetas elegidas, el panel del pedido, los cajones. |

**Tonos con significado.** Cada uno tiene `-strong` (fondo con texto blanco), `-soft` (fondo tenue) y `-text` (texto sobre el `-soft`):

| Tono | Significa |
|---|---|
| `action` | La acción principal y lo elegido. Verde azulado `#0f766e` en Faro; cambia con la marca del restaurante. |
| `free` | Verde: libre, listo, pagado. |
| `progress` | Ámbar: tomando pedido, en preparación, en espera. |
| `alert` | Rojo: demora, error, lo destructivo. |
| `neutral` | Gris: lo demás. |

Los tonos `free`, `progress` y `alert` **no cambian con la marca**.

## Letra

- **Una sola familia:** Figtree Variable, empaquetada para funcionar sin internet.
- **Escala fija:**
  - 14 px lo secundario;
  - 16 px el cuerpo;
  - 18 px productos y botones grandes;
  - 20 a 24 px títulos;
  - 30 a 36 px cifras grandes.
- Nada por debajo de 14 px.
- Cifras de dinero y tiempo en `.figures` (dígitos del mismo ancho).
- Títulos en peso 700 con `tracking-tight`.

## Formas

- **Esquinas:** `rounded-xl` en controles, `rounded-2xl` en tarjetas y paneles, `rounded-3xl` en la tarjeta de entrada y los cajones, `rounded-full` en etiquetas y chips.
- **Táctil:** todo lo que se toca mide al menos 48 × 48 px; los botones grandes, 56.
- **Íconos:** de trazo, en `src/ui/icons.tsx`, del mismo grosor; nunca emoji.

## Marco (`FloorFrame`)

- **Caja (≥ 1024 px):** barra lateral de 256 px con el logo del restaurante («con Faro»), quién entró y las secciones agrupadas (Servicio, Administración) según sus permisos. Salir va abajo.
- **Tablet (768 a 1023 px):** la misma barra, solo con íconos (80 px).
- **Celular:** barra superior con menú; la barra lateral se abre como cajón desde la izquierda.
- **Barra superior:** título de la pantalla, conexión y pendientes, acciones de la pantalla y modo oscuro. En el celular cabe en una fila: «Solo red local» se abrevia «Local»; el modo oscuro también está en el menú.
- **Lo que no se aplicó** (tarea 1.7b): una franja roja al pie de la barra superior (es parte de ella, así que no se va al bajar), en todas las pantallas (`alert-soft` con borde superior `alert-strong`, ícono de advertencia, «No se aplicó (lo hizo Ana)» y el texto), con lo que este equipo hizo y el PC de caja guardó sin aplicar. **De a uno**: si hay varios dice «1 de 3» y al tocar «Entendido» sale el siguiente en el mismo lugar (el foco se queda en la franja). No se va solo (no es un aviso de 5 s): es dinero que quizá haya que devolver. Vuelve si se cierra la app sin tocarlo, y se quita solo si el PC de caja (restaurado de un respaldo) al final sí lo aplicó. Tras un cobro o una anulación de pago que no se aplicó, la cuenta dice «No se cobró: la cuenta ya estaba cerrada. Mira el aviso de arriba.» («No se anuló el pago…» para una anulación) y el foco va a la franja.

## Panel del dueño en la nube (`panel.html`, tarea 1.11c)

Es otra entrada de la app, con su propio marco (`src/panel/PanelFrame.tsx`) y sin barra lateral:

- **Barra superior:**
  - el logo del restaurante (o el faro), su nombre y, debajo, quién entró;
  - modo oscuro;
  - «Salir», con texto visible también en el celular.
- **Celular (< 768 px):** las secciones van en una **barra inferior fija**, al alcance del pulgar:
  - **Hoy · Salón · Cocina · Alertas · Más**, con ícono y texto, de 56 px de alto («Más» abre Caja y Reportes en un cajón; cada pestaña muestra solo si el rol tiene su permiso);
  - un nombre largo se corta (`truncate`) en vez de empujar las otras pestañas fuera de la pantalla;
  - respeta la zona segura del teléfono (`env(safe-area-inset-bottom)`);
  - el contenido deja espacio abajo para que la barra no lo tape.
- **Desde 768 px:** las mismas secciones van como pestañas en la barra superior y la inferior desaparece.
- **Estado de los datos:** un bloque `rounded-xl` arriba de las cifras (no una pastilla: en el celular angosto el texto largo se parte bien):
  - «Actualizado 9:41 p. m.» en neutro;
  - «Faltan N datos del local por llegar» en ámbar;
  - «Sin noticias del restaurante desde…» con una segunda línea («Puede que la caja esté apagada o sin internet. Las cifras son de las 9:38 p. m.»), o «Sin conexión a internet: no llegan datos del restaurante», en rojo, con la nube tachada y las cifras fechadas («Ventas hasta las 9:38 p. m.»);
  - cuando la lectura falla, «Intentar ahora» (48 px) en el mismo bloque;
  - antes de la primera respuesta, «Leyendo…» y, a los 5 s, «Tarda más de lo normal»; si falla, el aviso va una sola vez (sin la línea de estado encima).
- **«En vivo»:** pequeño y en gris junto al título: «En vivo» con un punto del color del texto, «Conectando…» o «Se actualiza cada 15 s». Nunca en verde (verde es libre y listo).
- **Alertas:** cada fila lleva su tipo en palabras («Anulación», «Cortesía», «No aplicado»…). Rojo para lo que sacó dinero, descuadró la caja o es dinero que el PC de caja no aplicó; ámbar, «para revisar», para descuentos, cortesías y cuentas reabiertas. Una leyenda arriba de la lista lo dice.
- **Comparación con el mismo día de la semana pasada a la misma hora:** flecha y porcentaje. La subida va en verde; la bajada, en neutro con su flecha (no es una alarma).

## Pantallas

- **Salón:**
  - pestañas de zona;
  - Plano o Lista en un control de dos;
  - leyenda de estados con cuántas mesas hay de cada uno;
  - el plano con sus sillas (`Seats`), mesas teñidas del color de su estado;
  - a la derecha (abajo en el celular), los pedidos abiertos en tarjetas del color de su estado y los botones de pedidos sin mesa.
- **Toma de pedido:**
  - tarjetas de producto con foto (4:3) o, sin foto, el ícono de su estación;
  - el precio y el «+»;
  - `×N` cuando ya va en el pedido;
  - el panel del pedido a la derecha con productos, total y «Enviar N» (N en unidades);
  - arriba del panel, «Nota del pedido» (para todo el pedido);
  - cada línea sin enviar dice «Toca para nota»; su panel trae cantidad, persona y nota (para una sola unidad se escribe en la nota: «1 sin hielo»). La nota se aplica al cerrar el panel;
  - agregar y + / − no muestran aviso (el número cambia a la vista); quitar una línea sí deja Deshacer;
  - «Curso» solo se ve si el restaurante usa cursos (apagado por defecto);
  - en lo que está en cocina, «Entregar» por línea y «Todo entregado».
- **Estados de la mesa**, de lo más urgente a lo menos: tomando pedido (ámbar), listo para llevar (verde, ícono servir), pidió la cuenta (acción, ícono recibo: hay precuenta o un pago parcial), en preparación (ámbar), servida (gris), libre (verde).
- **Cuenta y cobro** (tarea 1.6): la precuenta a la izquierda y, a la derecha, cómo se paga (una cuenta, partes iguales, por productos) con un «Cobrar» por cuenta. El cobro va en panel lateral: monto, medio, propina sugerida ya marcada y, en efectivo, billetes rápidos con el cambio grande. Registrar dinero pide confirmar. Al quedar el saldo en 0 se muestra «Pagado y cerrado» con el cambio a entregar.
- **Pedidos en cocina** (caja): tarjetas por comanda del color de su demora (a tiempo sin color, solo con borde; ámbar y rojo según los minutos del local), con «Listo» y «Reimprimir»; abajo, lo listo para llevar, en verde, con «Volver a cocina». En cocina el verde es solo «listo». Arriba, la alerta de impresoras que no imprimen, con lo que espera y «Descartar».
- **Pantalla de cocina**: sin barra lateral, para una tablet o un televisor; letra más grande, un solo botón «Listo» por tarjeta, reloj, conexión y sonido. La nota del pedido va en un recuadro neutro con lápiz y el rótulo «Para todo el pedido», sin el color de la demora.
- **Cocina e impresoras**: cómo recibe cada estación, las impresoras con su prueba y su panel de edición, las pantallas, los minutos del ámbar y el rojo, y «Usar cursos».
- **Marca del restaurante:** una muestra de cada marca, fuera del tema actual, y «Usar».

## Marca del restaurante

`data-brand` en `<html>` (`src/ui/brand.ts`) cambia:
- las superficies;
- la letra;
- el tono `action` y `--brand`;
- el logo: el del restaurante en lugar del faro (`.brand-logo`);
- la firma bajo la barra superior (`.brand-signature`).

Una marca nueva es un bloque `:root[data-brand="…"]` en claro y otro en oscuro, con todos los tokens de color, más su entrada en `BRANDS` (`src/ui/brand.ts` y `packages/core/src/config.ts`). La prueba de contraste debe incluirla.
