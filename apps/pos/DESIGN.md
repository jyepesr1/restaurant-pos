# Design system de Faro

Cómo se ve Faro y por qué (ADR-014). La verdad está en el código: `src/estilos.css` (tokens), `src/ui` (componentes) y `src/sala/MarcoSala.tsx` (marco). Este documento lo resume para quien diseña la próxima pantalla.

## Estilo

El de los POS modernos del mercado, con el máximo cuidado. Las referencias son RestroBit y Tasty Station: herramienta clara y conocida, sin adornos.

- La marca vive en los detalles:
  - el verde azulado en la acción principal y en lo elegido;
  - el logo del faro;
  - la letra Figtree.
- El color de estado dice qué pasa y nunca va solo: siempre con ícono y texto.

## Color

Estrategia contenida: neutros fríos y un acento. Todo par de texto y fondo cumple AA en claro y oscuro (`src/ui/contraste.test.ts`).

**Capas**

| Token | Para qué |
|---|---|
| `fondo` | El lienzo de la pantalla. |
| `superficie` | Tarjetas, paneles, el plano. |
| `superficie-2` | Lo hundido: campos, fondos de foto, la tarjeta de quién entró. |
| `lateral` | La barra lateral y la superior. |
| `linea` | Separadores y bordes de tarjeta, que no son controles. |
| `borde` | Borde de los controles (3:1). |
| `sombra` (`shadow-flota`) | Lo que flota: tarjetas elegidas, el panel del pedido, los cajones. |

**Tonos con significado.** Cada uno tiene `-fuerte` (fondo con texto blanco), `-suave` (fondo tenue) y `-texto` (texto sobre el suave):

| Tono | Significa |
|---|---|
| `accion` | La acción principal y lo elegido. Verde azulado `#0f766e` en Faro; cambia con la marca del restaurante. |
| `libre` | Verde: libre, listo, pagado. |
| `proceso` | Ámbar: tomando pedido, en preparación, en espera. |
| `alerta` | Rojo: demora, error, lo destructivo. |
| `neutro` | Gris: lo demás. |

Los tonos `libre`, `proceso` y `alerta` **no cambian con la marca**.

## Letra

- **Una sola familia:** Figtree Variable, empaquetada para funcionar sin internet.
- **Escala fija:**
  - 14 px lo secundario;
  - 16 px el cuerpo;
  - 18 px productos y botones grandes;
  - 20 a 24 px títulos;
  - 30 a 36 px cifras grandes.
- Nada por debajo de 14 px.
- Cifras de dinero y tiempo en `.cifras` (dígitos del mismo ancho).
- Títulos en peso 700 con `tracking-tight`.

## Formas

- **Esquinas:** `rounded-xl` en controles, `rounded-2xl` en tarjetas y paneles, `rounded-3xl` en la tarjeta de entrada y los cajones, `rounded-full` en etiquetas y chips.
- **Táctil:** todo lo que se toca mide al menos 48 × 48 px; los botones grandes, 56.
- **Íconos:** de trazo, en `src/ui/iconos.tsx`, del mismo grosor; nunca emoji.

## Marco (`MarcoSala`)

- **Caja (≥ 1024 px):** barra lateral de 256 px con el logo del restaurante («con Faro»), quién entró y las secciones agrupadas (Servicio, Administración) según sus permisos. Salir va abajo.
- **Tablet (768 a 1023 px):** la misma barra, solo con íconos (80 px).
- **Celular:** barra superior con menú; la barra lateral se abre como cajón desde la izquierda.
- **Barra superior:** título de la pantalla, conexión y pendientes, acciones de la pantalla y modo oscuro.

## Pantallas

- **Salón:**
  - pestañas de zona;
  - Plano o Lista en un control de dos;
  - leyenda de estados con cuántas mesas hay de cada uno;
  - el plano con sus sillas (`Sillas`), mesas teñidas del color de su estado;
  - a la derecha (abajo en el celular), los pedidos abiertos en tarjetas del color de su estado y los botones de pedidos sin mesa.
- **Toma de pedido:**
  - tarjetas de producto con foto (4:3) o, sin foto, el ícono de su estación;
  - el precio y el «+»;
  - `×N` cuando ya va en el pedido;
  - el panel del pedido a la derecha con productos, total y Enviar;
  - en lo que está en cocina, «Entregar» por línea y «Todo entregado».
- **Estados de la mesa**, de lo más urgente a lo menos: tomando pedido (ámbar), listo para llevar (verde, ícono servir), en preparación (ámbar), servida (gris), libre (verde).
- **Pedidos en cocina** (caja): tarjetas por comanda del color de su demora (verde a tiempo, ámbar y rojo según los minutos del local), con «Listo» y «Reimprimir»; abajo, lo listo para llevar con «Recuperar». Arriba, la alerta de impresoras que no imprimen, con lo que espera y «Descartar».
- **Pantalla de cocina**: sin barra lateral, para una tablet o un televisor; letra más grande, un solo botón «Listo» por tarjeta, reloj, conexión y sonido.
- **Cocina e impresoras**: cómo recibe cada estación, las impresoras con su prueba y su panel de edición, las pantallas y los minutos del ámbar y el rojo.
- **Marca del restaurante:** una muestra de cada marca, fuera del tema actual, y «Usar».

## Marca del restaurante

`data-marca` en `<html>` (`src/ui/marca.ts`) cambia:
- las superficies;
- la letra;
- el tono `accion` y `--marca`;
- el logo: el del restaurante en lugar del faro (`.logo-marca` y `.logo-faro`);
- la firma bajo la barra superior.

Una marca nueva es un bloque `:root[data-marca="…"]` en claro y otro en oscuro, con todos los tokens de color, más su entrada en `MARCAS` (`src/ui/marca.ts` y `packages/core/src/config.ts`). La prueba de contraste debe incluirla.
