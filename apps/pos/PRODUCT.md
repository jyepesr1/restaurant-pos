# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Meseros**: celular o tablet en la mano, en hora pico, con una mano, de pie entre mesas. Toman pedidos por persona y curso, los envían a cocina y barra, marcan agotados. Muchos son nuevos: deben poder usarlo en su primer turno sin capacitación.
- **Caja / administrador de turno**: PC o tablet grande en la caja, con impresora de recibos y cajón. Ve el salón completo, cobra, divide cuentas, abre y cierra caja.
- **Cocina y barra**: pantallas KDS (tablet o TV) o comandas impresas por estación.
- **Dueño / administrador del restaurante**: configura carta, plano, personal, roles y permisos; ve reportes. No es técnico.
- **Reportes / contador**: solo informes.

## Product Purpose

Un POS para restaurantes de servicio a la mesa (restaurantes, gastrobares, bares, cafés) que sea el más rápido e intuitivo del mercado, que nunca deje de operar si se cae internet y que cumpla la normativa DIAN. Es un producto SaaS propio para vender a muchos restaurantes; La Spritzzería (Envigado) es solo el primer cliente y piloto.

Éxito: un mesero nuevo toma un pedido en su primer turno; un servicio completo de 2 horas corre sin internet sin perder nada; el dueño siente que el sistema es suyo.

## Positioning

Frente a Toteat, Fudo y Vendty, cuatro cosas juntas:

- **Nunca se cae**: un hub local en el PC de la caja mantiene salón, cocina y caja hablando por el Wi-Fi aunque no haya internet; cada celular guarda lo suyo si se cae el hub.
- **El más rápido**: lo frecuente en 3 toques o menos, respuesta de pantalla inmediata (se guarda en el equipo antes de mostrarse).
- **Con mi marca**: cada restaurante puede, si quiere, vestir el POS con sus colores, tipografía y logo; sin hacerlo, se ve con la identidad del producto.
- **Control total**: nada se borra; cada anulación, descuento o cambio queda con quién, desde qué equipo, cuándo y por qué.

## Operating Context

- Mercado: **Colombia primero** (DIAN, datáfonos Bold y Redeban, pesos enteros), luego el resto de Latinoamérica de habla hispana. Interfaz en español.
- Se abre desde el navegador por la IP del hub en la red local (HTTP), sin instalar nada. Meseros entran con PIN; caja, administración y reportes con usuario y contraseña (ADR-013).
- Salones con luz baja o mucha luz; pantallas de celulares de gama media; uso con una mano; interrupciones constantes.
- Multirestaurante: todo es por restaurante (`restaurant_id`); la nube (Fase 2) atenderá a muchos clientes.

## Capabilities and Constraints

- Ya construido: entrar por rol, plano de mesas editable, carta con variantes y modificadores, toma de pedido por persona y curso (retener y marchar), agotados en tiempo real, pedidos para llevar/domicilio/barra, personal y roles con permisos dinámicos, sincronización offline.
- Viene en Fase 1: comandas ESC/POS y KDS, mover/unir/anular, precuenta y división, pagos y propina, caja, datáfonos, reportes.
- Stack: React 19 + Vite + Tailwind 4 en `apps/pos`; las fuentes van empaquetadas (funciona sin internet). Design system en `apps/pos/src/ui` y tokens en `apps/pos/src/styles.css`.
- Colores con significado fijo en todo el producto, sin importar la marca del restaurante: verde libre, ámbar en proceso, rojo demora o peligro; nunca solo color.
- Nada tributario cableado; todo lo DIAN queda marcado para validar.
- **Nombre del producto: Faro** (decisión del dueño, 25-oct-2026). Pendiente validar marca registrada (SIC) y dominio antes de usarlo en público; una búsqueda rápida no encontró otro POS de la región con ese nombre.

## Brand Commitments

- El producto se llama **Faro** y tiene marca propia, distinta de La Spritzzería: lo que no se apaga y guía (nunca se cae, control total).
- La personalización por restaurante es **opcional**: un restaurante sin configurar se ve con la marca del producto.
- La Spritzzería quiere verse **con sus colores** (paleta Bagno, League Gothic y Alegreya Sans, su logo), según `la-spritzzeria-menu/DESIGN.md` y las direcciones de `/mockups`.
- Herramientas internas (editor de carta, plano, personal) se sienten como herramienta, no como marketing.
- **Estilo elegido por el dueño (25-oct-2026): el estándar de los POS modernos del mercado, hecho con el máximo cuidado**, a la altura de sus referencias RestroBit y Tasty Station (conceptos de Dribbble):
  - barra lateral con secciones;
  - modo claro y oscuro;
  - la carta como cuadrícula de tarjetas con foto y «+»;
  - el pedido en un panel a la derecha con totales y botones de acción;
  - estados en tarjetas de color;
  - el plano con sillas;
  - cobro en ventana con métodos y teclado.
- **Color de la marca Faro: verde azulado.** Un restaurante sin marca propia ve Faro así.
- **Fotos de productos opcionales**: sin foto, la tarjeta muestra un ícono de su categoría.

## Evidence on Hand

- Carta real del piloto: `docs/datos/carta-la-spritzzeria.yaml` (98 productos).
- Bocetos navegables y direcciones visuales de la tarea 0.9 en `/mockups`.
- No hay clientes, testimonios, precios ni cifras de mercado: no inventarlos.

## Product Principles

1. **El servicio no se detiene**: ninguna pantalla espera a la red; lo guardado se muestra al instante.
2. **Un toque menos gana**: lo frecuente al alcance del pulgar; lo raro, a un panel de distancia.
3. **El color dice estado, la marca dice quién**: la identidad del restaurante nunca cambia el significado de un color de estado.
4. **Nada se pierde, todo se explica**: cada acción deja rastro y cada error dice qué hacer.
5. **Sin capacitación**: textos de restaurante, no de sistemas.

## Accessibility & Inclusion

- WCAG 2.2 AA en claro y oscuro (contraste medido por prueba), objetivos táctiles de al menos 48 px, foco visible, lectores de pantalla en paneles y avisos.
- Uso con una mano en celular; teclado completo en la caja.
