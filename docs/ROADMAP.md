# Roadmap

Estados: ✅ terminado · 🚧 en curso · ⏳ pendiente · ⏭️ omitida

## Fase 0 — Fundaciones

| # | Tarea | Estado |
|---|---|---|
| 0.1 | Prueba de conexión en dispositivos reales | ✅ |
| 0.2 | Monorepo, herramientas y CI | ✅ |
| 0.3 | Documentos vivos (DECISIONES, MODELO_DATOS, SYNC, DINERO) | ✅ |
| 0.4 | Modelo de datos y migraciones | ✅ |
| 0.5 | Núcleo de dominio: dinero y eventos del pedido | ✅ |
| 0.6 | Motor de sincronización | ✅ |
| 0.7 | Autenticación con PIN, roles y permisos | ✅ |
| 0.8 | Seed con la carta de La Spritzzería | ✅ |
| 0.9 | Design system y bocetos de las 5 pantallas | ✅ |
| 0.10 | Pantalla mínima para la demo de sincronización | ✅ |
| 0.11 | Demo guiada | ⏭️ omitida |

**0.11 omitida por decisión del dueño (24-oct-2026):** se pasa directo a la Fase 1. La prueba de aceptación de la Fase 0 con dos navegadores (Playwright) se escribe al cierre de la Fase 1, junto con la de la 1.11.

## Fase 1 — MVP de salón (operar un servicio completo sin facturación electrónica)

Orden aprobado por el dueño el 24-oct-2026.

| # | Tarea | Estado |
|---|---|---|
| 1.1 | Catálogo completo: editor, variantes, modificadores, estaciones y catálogo sincronizado | ✅ |
| 1.2 | Editor de plano y vista operativa de mesas | ✅ |
| 1.3 | Toma de pedido por comensal y curso | ✅ |
| 1.3b | Acceso por rol ([ADR-013](DECISIONES.md#adr-013--acceso-por-rol-meseros-con-pin-desde-la-ip-caja-con-usuario-y-contraseña)): meseros con PIN desde la IP sin emparejar; caja, administración y reportes con usuario y contraseña; roles y permisos que decide cada restaurante | ✅ |
| 1.3c | Marca del producto (**Faro**, [ADR-014](DECISIONES.md#adr-014--faro-nombre-identidad-y-estilo-del-producto)) y rediseño: barra lateral, salón con sillas y pedidos abiertos, carta en tarjetas con foto opcional, marca opcional por restaurante | ✅ |
| 1.4 | Comandas: impresora ESC/POS por estación y KDS básico ([ADR-015](DECISIONES.md#adr-015--comandas-impresas-por-estación-pantalla-de-cocina-opcional-y-entrega-por-el-mesero)): comanda impresa por estación con cola y respaldo, pantalla de cocina opcional, «Entregado» del mesero y «Pedidos en cocina» en la caja | ✅ |
| 1.5 | Mover ítems, cambiar y unir mesas, anular con motivo y permiso | ✅ |
| 1.6 | Precuenta, división, pagos mixtos y propina | ✅ |
| 1.7 | Apertura, cierre y arqueo de caja | ✅ |
| 1.8 | Datáfonos nivel 1 y conciliación en el cierre | ✅ (por totales; el importador espera un reporte real de Bold) |
| 1.9 | Reportes básicos y `docs/KPIS.md` | ⏳ |
| 1.10 | Hub en el PC de caja (Windows) | ⏳ |
| 1.11 | Prueba de aceptación: servicio de 2 horas sin internet (y la e2e de la Fase 0) | ⏳ |

### 0.1 — Prueba de conexión en dispositivos reales ✅

Pantalla **Diagnóstico del dispositivo** en `/diagnostico` (queda como herramienta para instalar restaurantes). Comprueba en cada celular o tablet abierto por IP con HTTP:
- canal en tiempo real con el hub (WebSocket con latidos, reconexión y detección de conexión muerta) y tiempo de respuesta;
- qué pasa al bloquear la pantalla: si la conexión sobrevive y si el navegador recarga la página solo;
- datos locales (IndexedDB), vibración, sonido, pantalla encendida y notificaciones.

Los resultados se envían al hub y quedan en `apps/hub/datos/diagnosticos.jsonl` (máximo 5 MB).

**Resultado:** la app funciona por IP con HTTP en Android (Chrome) y en iPhone (Safari) sin instalar nada. Decisión, evidencia y consecuencias para el diseño en [ADR-001](DECISIONES.md#adr-001--los-dispositivos-abren-la-app-por-la-ip-del-hub-con-http-y-sin-instalar-nada). Lo más importante: la conexión se pierde cada vez que se bloquea la pantalla y el reloj de los celulares no es confiable.

**Queda pendiente:**
- Confirmar en Android la reconexión de menos de 1 s con la versión corregida (el Android probó la versión anterior).
- Fase 1: repetir la prueba con el hub en el PC de caja (Windows 11), cuando exista el instalador del hub.

**Cómo probarlo a mano:**

1. Inicia el hub: `pnpm --filter @pos/app build && pnpm --filter @pos/hub start`. Debes ver `Hub en marcha` y la dirección `http://192.168…:4000`.
2. En el celular, conectado al mismo Wi-Fi, abre esa dirección agregando `/diagnostico`. Debes ver **Diagnóstico del dispositivo** y **✓ Conectado** en «Canal en tiempo real».
3. Sigue los cuatro pasos numerados de la pantalla. Al enviar debes ver **✓ Resultados enviados**.

## Antes de probar cualquier tarea

En cada terminal nueva, desde la carpeta del proyecto:

1. Escribe `nvm use 24`. Debes ver `Now using node v24…`.
2. Solo la primera vez: escribe `corepack enable pnpm`. No muestra nada; es normal.

### 1.4 — Comandas impresas y pantalla de cocina ✅

Decisiones del dueño del 25-oct-2026 ([ADR-015](DECISIONES.md#adr-015--comandas-impresas-por-estación-pantalla-de-cocina-opcional-y-entrega-por-el-mesero)). En La Spritzzería la cocina no tiene pantalla: trabaja con la comanda en papel. Las impresoras son **Jaltech POS 80** de red (cable al router).

**Cómo llega cada pedido:**
- **Cada estación decide** en **Cocina e impresoras**: impresora, pantalla o las dos. Si una no tiene ninguna, la pantalla lo advierte.
- **Comanda impresa:**
  - lleva estación, mesa o canal, número de comanda del día, pedido, mesero, hora y personas;
  - los productos van por curso, con las opciones resaltadas y las notas en negro;
  - avisa los cursos que siguen en espera;
  - también hay comanda de reimpresión, de anulación y de cambio.
- **Si la impresora no responde:**
  - se reintenta sola (espera creciente hasta 30 s, sin rendirse);
  - a los 3 fallos la comanda sale por la **impresora de respaldo**, si tiene;
  - todos los equipos ven arriba en rojo «Cocina no imprime»;
  - en «Pedidos en cocina» se ve por qué y lo que espera, y la caja puede descartar una comanda atascada.
- **Si se va la luz justo después de enviar**, la comanda igual sale al volver: se guarda con el pedido, en la misma transacción.
- **Tildes y eñes**: cada impresora tiene su tabla de caracteres (Latina, Windows o sin tildes). La página de prueba muestra cuál sirve.

**Quién marca qué:**
- **Sin pantalla en cocina**, el mesero toca **Entregar** al llevar el plato, o **Todo entregado**. Se puede deshacer unos segundos.
- **Pedidos en cocina** (nueva sección):
  - lo enviado que falta entregar, por estación;
  - el tiempo desde el envío y su color: sin color a tiempo (solo borde), ámbar desde 10 minutos, rojo desde 20 (se cambian); el verde queda para «Listo para llevar»;
  - quien puede marcar toca **Listo** si cocina avisa, y el mesero de la mesa recibe un aviso en su celular;
  - **Reimprimir** una comanda.
- **Pantalla de cocina (opcional)**:
  - el administrador entra con su usuario en una tablet, va a **Cocina e impresoras** y la **convierte**;
  - desde ahí muestra solo las comandas de sus estaciones, con sonido, y el cocinero solo toca **Listo**;
  - lo marcado por error se recupera;
  - se quita retirándola en **Personal y roles, Equipos**.
- **Salón**: dos estados nuevos de mesa, **Listo para llevar** (verde) y **Servida** (gris).

**Por dentro:**
- `packages/printing` (nuevo): la comanda en líneas del ancho de la impresora (48 caracteres en 80 mm) y en bytes ESC/POS.
  - Un nombre de producto nunca puede mandarle órdenes a la impresora: se quitan los bytes de control.
- **Migración 6**:
  - tablas `impresora` y `trabajo_impresion` (la cola, que no se borra);
  - columnas `dispositivo.estacion_ids`, `usuario.pantalla` y `rol.oculto`.
- **Hub**:
  - numera las comandas por día operativo (`asignaciones.numeros_comanda`);
  - arma los trabajos dentro de la transacción del evento (`alGuardar`), y si falla el evento igual se acepta;
  - avisa el estado de las impresoras por WebSocket (`impresoras`).
- **La pantalla de cocina** marca a nombre de un usuario técnico propio. Solo puede marcar listo y agotados, no sale en Personal y no entra con PIN ni contraseña.
- **Impresora de prueba**: `pnpm --filter @pos/hub impresora-prueba` muestra en la ventana cada comanda, para probar sin papel.

Revisado por `revisor-codigo`, `qa-pruebas` y `revisor-ux`. Se corrigieron, entre otros:
- **Hub**:
  - una impresora caída con respaldo nunca volvía: ahora se vuelve a probar al vencer su espera y, si responde, imprime lo suyo;
  - la dirección de una impresora servía para tantear la red: ahora solo IP privadas y puertos 9100 a 9109;
  - el PC de la caja no se puede convertir en pantalla;
  - una comanda que no se arma ya no se pierde en silencio: todos los equipos ven la alerta 15 minutos, y lo armado a medias se deshace;
  - una estación archivada ya no impide guardar una impresora o una pantalla;
  - una impresora archivada sin respaldo hacía girar la cola cuatro veces por segundo;
  - la página de prueba ya no sale por otra impresora y se descarta sola a los 5 minutos;
  - el orden de la cola no depende del reloj del PC;
  - descartar deja también el equipo;
  - con solo el temporizador, la comanda de una impresora caída nunca llegaba al respaldo;
  - la caja no veía por qué no salía lo de una impresora archivada;
  - anular o cambiar un plato que se pasó a otra mesa no le llegaba a la cocina;
  - un envío que no imprimía nada gastaba un número de comanda (la cocina veía #1 y #3);
  - una IP con ceros a la izquierda («010.0.0.1») salía fuera de la red del local;
  - un registro de la cola no se puede reemplazar.
- **Pantalla**:
  - la pantalla de cocina no mostraba las impresoras caídas;
  - su letra era pequeña para verse de lejos;
  - el sonido podía no sonar en una tablet hasta tocarla: ahora lo dice;
  - la tablet se apagaba sola;
  - su reloj adelantado pintaba todo de ámbar: los tiempos se miden con la hora del hub;
  - mostraba todas las estaciones mientras no sabía las suyas;
  - en el celular, «Entregar» queda a un toque en la barra de abajo;
  - el mesero ya no ve «Listo» (es de la cocina o la caja);
  - el aviso de listo no se repite al cambiar de mesero;
  - USB ya no se puede elegir;
  - textos técnicos (IP, tabla de caracteres, ámbar y rojo) en palabras del restaurante;
  - «A tiempo» va sin color, solo con borde (decisión del dueño): en cocina el verde es solo «Listo para llevar»;
  - un equipo que vuelve a entrar en un hub reinstalado se quedaba con la carta del hub anterior.

**Pruebas:**
- **Hub:** 1.111.
  - Comandas: numeración por día y sin saltos, lo ya enviado por otro equipo, envíos tardíos, los cuatro tipos de comanda, dos restaurantes en la misma base.
  - Cola: reintentos, respaldo y vuelta de la principal, archivadas, reinicio con trabajos pendientes, una impresora caída no frena la sincronización.
  - Las 8 rutas con su matriz de permisos y datos inválidos.
  - Pantalla de cocina: sus permisos, el rol oculto y retirarla.
  - TCP real contra una impresora de prueba.
- **App:** 630. Lo que está en cocina, la demora, los estados de mesa, convertir en pantalla, que no se cierre por inactividad y el aviso de impresoras.
- **Impresión:** 49, con propiedades al azar: ninguna línea pasa del ancho y ningún texto produce un byte de control.
- **Base:** 353 (más la `it.fails` de la 1.3b), con la migración 6 sobre una base real de la versión 5.
- **Núcleo:** 345.
- **Sincronización:** 170.

**Queda pendiente:**
- **Impresoras USB**: la de la caja es para recibos y cajón (1.6 y 1.7). La impresión por USB llega con el instalador de Windows (1.10).
- **El timbre de la impresora** (algunas Jaltech de cocina traen zumbador): no se usa todavía.
- **Agrupar productos iguales** y la pantalla de expedidor: Fase 3 (KDS completo).
- **Tiempo por mesa** en el plano con los colores de cocina: en una tarea siguiente.
- **Volver a usar una pantalla** sin retirarla («Dejar de ser pantalla» desde la propia tablet con la contraseña del administrador): hoy se retira desde la caja y la tablet entra de nuevo.
- **Agotados desde la pantalla de cocina**: el permiso existe; falta el botón.
- **«Todo entregado» entrega también lo que cocina no marcó listo**, a propósito: en el piloto nadie marca listo.
- **Volver a cocina algo entregado** pasados los 5 s del Deshacer.
- **El aviso de listo** no lleva al pedido; falta un contador «Listos para llevar» en el salón del celular.
- **Indicador permanente de impresoras** (también cuando están bien): hoy solo se ve cuando una falla.
- **Rendimiento**: «Pedidos en cocina» y el aviso de listo releen los eventos del equipo por separado.

**Cómo probarlo:**

Antes, con las impresoras:

1. Conecta cada Jaltech con su cable de red al router del local y préndela.
2. Saca su hoja de configuración: apágala, mantén presionado el botón de avance de papel (FEED) y préndela sin soltarlo; suéltalo cuando empiece a imprimir. Debes ver una hoja con una línea **IP Address**, por ejemplo `192.168.1.87`. Anótala.
3. En el PC de la caja, abre **Configuración → Red e Internet → Propiedades** y mira la **Dirección IPv4**, por ejemplo `192.168.1.20`. Los tres primeros números deben coincidir con los de la impresora (`192.168.1`). Si no coinciden (por ejemplo, la impresora dice `192.168.123.100`), hay que cambiar la IP de la impresora con el programa de Jaltech: avísame y te doy esos pasos aparte.

En el hub:

4. Cierra el hub si está abierto (**Ctrl+C**) y arráncalo con la versión nueva:

```bash
pnpm --filter @pos/app build && pnpm --filter @pos/hub start
```

   Debes ver «Base de datos actualizada a la versión 6».
5. En el PC de la caja entra como administrador. En la barra lateral toca **Cocina e impresoras**. Debes ver Cocina y Barra con «No le llega nada».
6. Toca **Agregar impresora**. Escribe «Cocina», toca la estación **Cocina**, deja «Cable de red», escribe la IP del paso 2, deja el puerto 9100 y 80 mm, y toca **Guardar**. Debe salir en la lista con «Lista».
7. Toca **Prueba**. La impresora de la cocina debe sacar una hoja «PRUEBA DE IMPRESIÓN»: la regla de números debe ocupar una sola línea y las tildes y eñes deben verse bien. Si salen símbolos raros, toca **Editar**, elige **Windows (1252)**, guarda y prueba otra vez.
8. Repite los pasos 6 y 7 con la de barra («Barra», estación **Barra**). En **Si no responde, imprimir en** puedes elegir la otra como respaldo.
9. En el celular de un mesero abre una mesa, agrega un plato y una bebida y toca **Enviar**. En la cocina debe salir la comanda del plato y en la barra la de la bebida, con la mesa y el número de comanda.
10. En la caja toca **Pedidos en cocina**. Deben estar las dos comandas, blancas con borde (a tiempo) y con su tiempo.
11. En el celular abre la misma mesa. Al lado de cada producto debe haber **Entregar**. Toca **Todo entregado**. En la caja, las comandas deben desaparecer de «Pedidos en cocina» y la mesa debe quedar **Servida** en el salón.
12. Desconecta el cable de red de la impresora de barra y envía otra bebida. En unos segundos, arriba debe salir en rojo «Barra no imprime». Vuelve a conectar el cable: la comanda debe salir sola y la alerta debe desaparecer.

Opcional, la pantalla de cocina:

13. En una tablet, entra con el usuario del administrador, ve a **Cocina e impresoras**, elige **Cocina** en «Usar este equipo como pantalla de cocina» y toca **Convertir este equipo → Convertir**. Debe quedar la pantalla con las comandas de cocina. Toca **Listo** en una: en el celular del mesero debe salir «Mesa N: listo para llevar».
14. Para quitarla: en la caja, **Personal y roles → Equipos**, toca **Retirar** en «Pantalla cocina».

### 1.5 — Mover, cambiar y unir mesas, anular y cancelar ✅

Decisiones del dueño del 25-oct-2026 ([ADR-011](DECISIONES.md#adr-011--reglas-de-operación-acordadas-para-el-piloto)).

**Lo nuevo en el pedido** (botón **Mesa y pedido**, arriba del pedido):
- **Cambiar de mesa**: todo el pedido pasa a una mesa libre. Si la cocina ya tiene algo, recibe «CAMBIO DE MESA» con la mesa nueva y la anterior.
- **Unir mesas** para un grupo grande: se eligen mesas libres y quedan ocupadas con el mismo pedido. Se ve «Mesa 5 + 6». En el plano, las mesas del grupo llevan un halo de su color y una franja las une (si la franja cruzaría otra mesa, quedan solo los halos). La principal lleva el tiempo y el total, y la otra dice «con la 5»; si está en otra zona, «con la 5 (Terraza)». Se sueltan en el mismo panel.
- **Mover productos** a otra mesa: uno, varios o «Todo de P1». Si la mesa tiene pedido se suman a ese; si está libre, se abre uno. Pide conexión. Lo que ya estaba en cocina sale como «CAMBIO DE MESA».
- **Cancelar el pedido**: con motivo; sin el permiso, con el PIN de quien autoriza. La cocina recibe «ANULAR» de lo que tenía y la mesa queda libre.

**Lo nuevo en un plato ya enviado** (tocar la línea):
- **Anular**: cuántas unidades, el motivo (lista o «Otro») y si la cocina ya lo hizo (merma). El mesero, sin el permiso, pide el **PIN del cajero o del administrador** en su celular. La cocina recibe «ANULAR».
- **Cambiar la nota**: la cocina recibe una comanda «CAMBIO».

**Por dentro:**
- Eventos nuevos `MesasUnidas` y `MesasSeparadas` en el pedido (un grupo ocupa varias mesas).
- El hub no deja abrir, cambiarse ni unir una mesa que otro pedido ocupa, contando también las mesas unidas.
- El motor arma eventos con motivo, con el pedido relacionado (al mover) y con el comprobante del supervisor: la huella del evento se firma en el hub con su PIN (ADR-008).
- Comandas nuevas: «CAMBIO DE MESA» y la anulación de un pedido cancelado.
- La lista de pedidos del equipo y «Pedidos en cocina» siguen a los productos que pasan de un pedido a otro.
- «Todo entregado» y «Entregar» cuentan unidades.

Revisado por `revisor-codigo`, `qa-pruebas` y `revisor-ux`. Se corrigieron:
- **App:**
  - mover productos los quitaba del origen pero no aparecían en el destino (la lista de pedidos agrupaba solo por el pedido principal del evento);
  - «Pedidos en cocina» perdía los platos que pasaban a otra mesa;
  - anular proponía todas las unidades: ahora una;
  - el PIN del cajero frenaba la toma de pedido mientras se comprobaba: ahora va aparte, con el mismo teclado de entrar (al cuarto dígito se envía, con la espera tras intentos);
  - la nota cambiada de un plato enviado se perdía al cerrar: ahora sale como «CAMBIO»; uno ya entregado no la cambia;
  - avisos falsos sin conexión;
  - cambiar de mesa y unir sin conexión podían perder lo tomado después: ahora piden conexión;
  - «Cancelar el pedido» era ambiguo: ahora está aparte, como zona de peligro, con «Volver» y «Sí, cancelarlo», y no se ofrece si hay pagos;
  - unir mesas se puede antes del primer producto;
  - soltar una mesa unida no se podía deshacer en el panel.
- **Hub:**
  - un pedido que quedó vacío al pasar todo a otra mesa seguía ocupando la suya;
  - reimprimir una comanda cuyos platos se movieron no imprimía nada;
  - reabrir una cuenta cuya mesa ya tenía otro pedido, o agregar a un pedido vaciado cuya mesa tomó otro, dejaba dos pedidos en la mesa: ahora el hub revisa cualquier evento que vuelva a ocupar una mesa.
- **Salón:** cada mesa unida mostraba el mismo total y parecían dos cuentas; la franja quedaba tapada entre mesas pegadas.
- **Hub y app:** quitar un producto que aún no se enviaba soltaba la mesa; ahora solo la sueltan pasar todo a otra mesa o anularlo todo.
- **Hub:** un aviso de dos pedidos en la mesa tapaba el de precio distinto; ahora van juntos.

**Pruebas:** 241 nuevas (núcleo 80, sincronización 43, impresión 4, hub 53, app 61), todas pasan.

**Queda pendiente:**
- **Juntar dos cuentas en una** (`PedidosUnidos`): el núcleo lo soporta, sin pantalla; al hacerlo, la nota del pedido de origen debe pasar al destino.
- **Mover solo una unidad** de una línea de varias: hoy se mueve la línea entera.
- Un pedido que queda vacío al mover todo sigue abierto sin productos (la mesa se ve libre).
- Mesas unidas de zonas distintas no llevan franja en el plano: solo el halo y «con la 5 (Terraza)».
- El plano con mesas unidas no tiene prueba automática (necesita el ancho real de la pantalla): queda para Playwright (1.11).
- El hub no revisa que la mesa exista al abrir o cambiarse (solo que esté libre).
- Un celular con una versión vieja de la app no conoce `MesasUnidas`: hay que actualizar todos los equipos a la vez.

**Cómo probarlo:**

1. Cierra el hub (**Ctrl+C**) y arráncalo con la versión nueva:

```bash
pnpm --filter @pos/app build && pnpm --filter @pos/hub start
```

2. En el celular, entra con el PIN de un mesero, abre la mesa 3, agrega 2 Aperol y toca **Enviar 2**.
3. Abre otra vez la mesa 3 y el pedido, y toca la línea de Aperol. Debe decir que ya salió a cocina, con **Anular**. Tócalo: elige 1, el motivo «El cliente cambió», y en **PIN de quien autoriza** escribe el PIN para autorizar del administrador. Toca **Anular 1**. Debe quedar 1 Aperol; en la barra sale una comanda «ANULAR».
4. Toca **Mesa y pedido → Unir mesas**, elige la 4 y toca **Guardar**. El título debe decir «Mesa 3 + 4». En el salón, la 3 y la 4 tienen un halo naranja y una franja las une; la 3 tiene el total y la 4 dice «con la 3».
5. **Mesa y pedido → Cambiar de mesa**, elige la 10 y toca **Pasar a la mesa 10**. El título dice «Mesa 10 + 4»; la 3 queda libre y la barra recibe «CAMBIO DE MESA».
6. Agrega y envía otro producto, y luego **Mesa y pedido → Mover productos**: elígelo, elige la mesa 8 y toca **Mover 1 a la mesa 8**. La mesa 8 debe mostrarlo.
7. Abre la mesa 8, **Mesa y pedido → Cancelar el pedido**, elige un motivo, escribe el PIN del administrador y toca **Cancelar el pedido**. La mesa 8 queda libre.
8. Toca un plato enviado, cambia su nota y toca **Enviar el cambio a cocina**: sale una comanda «CAMBIO».

### 1.8 — Conciliación de datáfonos y apps en el cierre ✅

Decisiones del dueño del 26-oct-2026 ([ADR-011](DECISIONES.md#adr-011--reglas-de-operación-acordadas-para-el-piloto)).

**Lo nuevo** (al cerrar la caja):
- Con el conteo del efectivo, el cajero escribe lo que dicen los demás cierres: **el total del cierre de Bold** (con propinas) y **lo que llegó por cada app** (Nequi, Daviplata, Bre-B, transferencia y los medios propios). También a ciegas.
- En el resultado, por medio: lo registrado, lo que dice su cierre y si **cuadra, sobra o falta**. Si el datáfono tiene más que lo registrado, se cobró algo que no se registró en el POS.
- Desde el umbral (el mismo del efectivo) hay que justificar.
- El hub no acepta un cierre cuyos medios no cuadren con los que él calcula.

Revisado por `revisor-codigo`, `auditor-dinero`, `revisor-ux` y `qa-pruebas`. Se corrigió:
- la pantalla de la caja mostraba al cajero lo cobrado en efectivo y en cada medio, y así podía saber lo esperado antes de contar: ahora solo ve cuántos pagos hay (los montos los ve quien tiene permiso de reportes);
- un medio con solo devoluciones no se podía cerrar en negativo;
- un campo vacío contaba como $0: ahora los medios con cobros deben tener su cierre escrito;
- lo esperado cambiaba en pantalla si entraba un pago después del conteo: ahora queda fijo y avisa;
- cerrar no pedía confirmar, y «Volver a contar» borraba todo;
- un medio propio archivado salía como «Otro».

**Pruebas:** 188 nuevas (núcleo 83, sincronización 55, app 50), todas pasan.

**Queda pendiente:**
- **Importar el reporte de Bold** (Excel o CSV) y conciliar pago por pago: hace falta un archivo de ejemplo real descargado del portal de Bold (el brief pide no inventar el formato).
- Varios turnos por día: el cierre de Bold es del día; si hay cambio de cajero, hay que repartirlo.
- Restaurantes con datáfonos de varios proveedores: hoy se escribe la suma de sus cierres en una sola línea.
- Integración con Bold por API (nivel 2) y Redeban (nivel 3).
- Guardar un borrador del conteo si se sale de la pantalla o se recarga.

**Cómo probarlo:**

1. Arranca el hub con la versión nueva:

```bash
pnpm --filter @pos/app build && pnpm --filter @pos/hub start
```

2. Abre la caja, cobra una mesa con **Tarjeta crédito** y otra con **Nequi**.
3. Toca **Cerrar la caja**. Debajo del efectivo aparecen «Cierre de Bold (total con propinas)» y «Llegó por Nequi», sin mostrar lo registrado.
4. Escribe el total de Bold igual a lo cobrado con tarjeta y en Nequi $1.000 menos.
5. Toca **Guardar el conteo**: Bold debe decir «Cuadra» y Nequi «Faltan $1.000», y se pide escribir por qué.
6. Escribe el motivo y toca **Cerrar la caja**.

### 1.7 — Apertura, cierre y arqueo de caja ✅

Decisiones del dueño del 26-oct-2026 ([ADR-011](DECISIONES.md#adr-011--reglas-de-operación-acordadas-para-el-piloto)).

**Lo nuevo** (en **Caja**, en el computador de la caja):
- **Movimientos de efectivo:** «Entrada», «Salida» (con motivo: compra, pago a proveedor u otro) y «Pago de propinas» (a quién se entregaron). Cada uno pide confirmar y queda en la lista del turno.
- **Cerrar la caja con arqueo ciego:**
  - se cuentan billetes y monedas por denominación; en la caja se escribe el número y Enter pasa al siguiente;
  - «Guardar el conteo» lo deja registrado, y solo entonces se ve lo que debería haber (base + efectivo cobrado + entradas − salidas − propinas pagadas), lo contado y si **cuadra, sobra o falta**;
  - desde $1.000 de diferencia hay que escribir por qué (se cambia en **Caja y pagos → Cierre de caja**); por debajo es opcional;
  - «Volver a contar» empieza de cero; el conteo anterior queda guardado;
  - si quedan mesas abiertas, las nombra con su saldo y deja cerrar: lo que se cobre después cae en el próximo turno;
  - «Otros medios» muestra lo cobrado con tarjeta, Nequi y demás, para revisarlo con su cierre.
- Una caja abierta de un día anterior lo avisa para cerrarla.

**Por dentro:**
- Eventos `MovimientoCajaRegistrado`, `ArqueoRegistrado` y `TurnoCerrado` (agregado `turno_caja`), solo desde la caja y con sus permisos.
- `cuadreDeTurno` en `@pos/core` calcula el cuadre igual en el hub y en la caja.
- El hub no acepta un cierre que no cuadre con lo suyo: sin el último conteo, con pagos o movimientos después del conteo, con otro esperado o sin la justificación. Después del cierre, ese turno no recibe pagos.

Revisado por `revisor-codigo`, `auditor-dinero`, `revisor-ux` y `qa-pruebas`. Se corrigió:
- el aviso de una salida grande mostraba lo esperado y rompía el arqueo ciego;
- el hub aceptaba cerrar con un conteo que no era el último o anterior a un pago;
- faltaba el billete de $1.000;
- el día del pago de propinas usaba el reloj y las 6 a. m. del equipo, no los del restaurante;
- un reembolso de otro turno perdía su medio;
- un cierre pendiente mostraba la caja cerrada antes de que el hub lo aceptara;
- «Volver» borraba el conteo;
- los movimientos no pedían confirmar;
- el cierre no avisaba sin conexión;
- con el teclado, Tab caía en − y +.

**Pruebas:** 261 nuevas (núcleo 121, sincronización 66, hub 39, app 35), todas pasan.

**Queda pendiente:**
- **Corregir un movimiento equivocado** (anularlo con motivo): necesita un evento nuevo.
- **Cerrar una caja huérfana** (si se cambia el PC de caja con un turno abierto) desde otro equipo, con el PIN del administrador.
- El pago de propinas no se controla contra el **fondo de propinas por día** ni deja elegir los días: llega con los reportes (1.9).
- **Imprimir el cierre** y guardarlo para verlo después: llega con el cierre Z (1.9).
- Avisar en el cierre de pagos que quedaron en cuarentena o rechazados.
- Retiros parciales durante el turno.

**Cómo probarlo:**

1. Cierra el hub (**Ctrl+C**) y arráncalo con la versión nueva:

```bash
pnpm --filter @pos/app build && pnpm --filter @pos/hub start
```

2. En el PC de la caja entra con el usuario de **Caja** y abre la caja con 200.000 de base (en **Caja**).
3. Cobra una mesa en efectivo (por ejemplo 46.350 con propina): en **Caja** debe aparecer en «Cobrado en este turno».
4. Toca **Entrada**, escribe 50.000, elige «Cambio para la caja», **Registrar** y **Sí, registrar**. Debe salir en «Movimientos de efectivo».
5. Toca **Cerrar la caja**. Escribe cuántos billetes y monedas hay (Enter pasa al siguiente). No debe verse cuánto debería haber.
6. Toca **Guardar el conteo**: ahora se ve «Debería haber», «Contado» y si cuadra. Si la diferencia es de $1.000 o más, escribe por qué.
7. Toca **Cerrar la caja**. Debes ver el resultado y el formulario para abrirla de nuevo. Intenta cobrar: la cuenta pide abrir la caja.

### 1.6 — Precuenta, división, pagos mixtos y propina ✅

Decisiones del dueño del 26-oct-2026 ([ADR-011](DECISIONES.md#adr-011--reglas-de-operación-acordadas-para-el-piloto)).

**Lo nuevo:**
- **Cuenta** (botón junto a «Enviar», o tocar en la caja una mesa que «pidió la cuenta»):
  - la precuenta en pantalla con el **impuesto discriminado** (base sin impuestos, INC 8 %, total), lo ya pagado, el saldo y la propina;
  - la propina se cambia ahí mismo (sugerida, 5 %, sin propina u otro valor) y así sale en la precuenta y en el cobro;
  - «Imprimir precuenta» si hay impresora elegida; si no, «Pidió la cuenta». Las dos marcan la mesa «Pidió la cuenta» hasta que se agregue algo nuevo.
- **Dividir:** en partes iguales o por productos (un producto que tocan varias cuentas se reparte entre ellas). Cada cuenta se cobra aparte, con su precuenta. «Deshacer la división» mientras ninguna cuenta tenga pagos.
- **Cobrar** (solo el cajero, en la caja, con la caja abierta y conexión):
  - valor del pago (pagos parciales);
  - medio: efectivo, tarjeta crédito, tarjeta débito, Nequi, Daviplata, Bre-B, transferencia y los **medios propios** del restaurante;
  - propina: la sugerida ya marcada con su porcentaje, 5 %, sin propina u otro valor en pesos o en porcentaje;
  - solo en efectivo: lo que entrega el cliente, el cambio y «Deja el cambio de propina»; con los medios digitales se cobra lo justo;
  - con tarjeta no se pide el datáfono (los de un mismo proveedor tienen un solo cierre; solo se elige el proveedor si hay varios) ni el número de aprobación;
  - confirmar antes de registrar; el pago se muestra cobrado solo cuando el hub lo acepta;
  - al quedar el saldo en 0 la mesa se cierra sola y se ve el cambio a entregar. Si el cierre falla, «Cerrar la mesa».
  - Atajos en la caja: F2 efectivo, F3 crédito, F4 débito, Enter cobra, Esc vuelve.
- **Caja:** abrir la caja con la base y ver lo cobrado en el turno por medio, con el total. El cierre con arqueo es la 1.7.
- **Caja y pagos** (administración): medios de pago (prender y apagar; crear los propios), propina sugerida (sin propina, 5 %, 8 % o 10 %), impresora de precuentas y datáfonos (el seed crea dos Bold).

**Por dentro:**
- Evento `TurnoAbierto` (agregado `turno_caja`). El hub no deja abrir dos turnos en la misma caja y rechaza pagos, anulaciones y reembolsos sin turno abierto, de otra caja, con un medio apagado, con un datáfono archivado o con otra regla de redondeo.
- Migración 7: tabla `datafono` y la cola de impresión acepta precuentas.
- La propina de un pago parcial es la diferencia entre la pendiente antes y después: las partes suman la propina entera. La de una cuenta pagada en parte es la parte de su propina que falta.
- La precuenta impresa la arma el hub con el pedido (no confía en los montos del equipo).

Revisado por `revisor-codigo`, `auditor-dinero`, `revisor-ux` y `qa-pruebas`. Se corrigió:
- el cobro mostraba pagado lo que el hub todavía no aceptaba;
- sin cierre automático la mesa quedaba en saldo 0 sin salida;
- una cuenta pagada en parte mostraba la propina completa;
- los pagos parciales sumaban $1 de más de propina;
- el resumen del turno no ponía las anulaciones en el turno donde se hacen;
- el hub no revisaba el medio ni el datáfono;
- los botones de cobrar quedaban fuera del pulgar en el celular;
- se habían perdido los atajos de teclado;
- la mesa seguía en «Pidió la cuenta» al pedir más;
- `/api/caja/medios` respondía error del servidor con «otro»;
- dividir por productos fallaba si otro equipo anulaba un producto asignado;
- un `TurnoAbierto` podía nombrar un pedido y quedar en su historia;
- las opciones de un plato salían sin sangría en la precuenta.

**Pruebas:** 589 nuevas (núcleo 92, sincronización 60, base 35, hub 205, impresión 49, app 148), todas pasan.

**Queda pendiente:**
- **Anular un pago de una mesa ya cerrada** (pide reabrir la cuenta con permiso): hoy no hay pantalla para reabrir. Mientras tanto, revisar antes de confirmar.
- Dividir por **monto libre** y **fracciones** (1/3 de botella), y «usar las personas del pedido» para dividir por productos de un toque.
- **Cerrar la caja** con arqueo (1.7). Mientras tanto, el turno no se cierra: una caja abierta ayer sigue abierta.
- El orden de los medios de pago al cobrar es fijo.
- Bonos de regalo con saldo.
- La propina impresa en la precuenta no tiene tope en el hub (es la que se eligió) — (validar) con el contador si debe tenerlo.
- Abrir la caja no espera la respuesta del hub: un segundo turno rechazado se ve como «sin confirmar» hasta recargar.

**Cómo probarlo:**

1. Cierra el hub (**Ctrl+C**) y arráncalo con la versión nueva (la base pasa a la versión 7):

```bash
pnpm --filter @pos/app build && pnpm --filter @pos/hub start
```

2. Con el hub cerrado una vez, carga los datáfonos de ejemplo (no toca el personal):

```bash
pnpm seed -- --sin-personal
```

3. En el PC de la caja entra con el usuario y la contraseña de **Caja**. En el menú toca **Caja**, escribe la base (por ejemplo 200.000) y toca **Abrir con $200.000**. Debes ver «Caja abierta desde las…».
4. En un celular, un mesero abre la mesa 5, agrega dos productos y los envía. Toca **Cuenta**: debes ver la base sin impuestos, el INC 8 %, el total y la propina sugerida del 10 %.
5. Toca **Cambiar** junto a la propina y elige **Sin propina**: la última línea pasa a «A pagar». Vuelve a elegir la sugerida.
6. En la caja, toca la mesa 5 en el salón: se abre la cuenta. Elige **Partes iguales**, deja 2 personas y toca **Dividir en 2**.
7. En **Persona 1** toca **Cobrar**, deja **Efectivo**, escribe 100.000 en «El cliente entrega» y toca **Cobrar** y **Sí, registrar**. Debe quedar «Pagada» y el cambio a entregar.
8. En **Persona 2** toca **Cobrar**, elige **Tarjeta crédito** (no aparece «El cliente entrega» ni se pregunta el datáfono) y registra. Debes ver «Pagado y cerrado» y, en el salón, la mesa 5 libre.
9. En **Caja** debes ver lo cobrado por efectivo y por tarjeta, con sus propinas.
10. En **Caja y pagos** (con el administrador) agrega un medio propio, por ejemplo «Sodexo»: debe salir al cobrar.

### Ajustes del pedido en el celular (25-oct-2026) ✅

Pedidos del dueño al probar la 1.4 en su iPhone:
- **Pista para la nota**: cada línea sin enviar dice «Toca para nota»; al tocarla se abre su panel.
- **Nota para una sola unidad**: se escribe en la nota de la línea («1 sin hielo»); el campo lo sugiere cuando hay varias. (Se probó separar la unidad en su propia línea, con un botón y luego con «Solo para 1»; el dueño prefirió quitarlo: en la nota se especifica.) La nota se aplica al cerrar el panel, no al salir del campo.
- **Sin avisos al agregar**: agregar un producto o tocar + y − ya no muestra «Aperol Spritz: 3 · Deshacer» (estorbaba al tomar pedidos); el número cambia a la vista y se corrige con «−». Quitar una línea completa sí deja Deshacer, porque se pierden su nota y sus opciones.
- **Nota del pedido**: arriba del pedido, «Nota del pedido» (alergias, cumpleaños). Sale resaltada en cada comanda y en la pantalla de cocina. Si cambia o se quita con platos ya en cocina, sale en papel una comanda «NOTA NUEVA» a cada estación con algo pendiente (una alergia no puede quedar solo en pantalla). Evento nuevo `NotaPedidoCambiada`.
- **«Enviar» cuenta unidades**: 3 Aperol dicen «Enviar 3», no «Enviar 1».
- **El encabezado del celular cabe en una fila**: «Solo red local» se abrevia «Local»; el modo oscuro sigue arriba y también está en el menú.
- **Cursos apagados**: «Curso», «Retener» y «Marchar» ya no se ven. Se prenden en **Cocina e impresoras → Cursos** si un restaurante los usa ([ADR-011](DECISIONES.md#adr-011--reglas-de-operación-acordadas-para-el-piloto)).

Revisado por `revisor-codigo`, `qa-pruebas` y `revisor-ux`. Se corrigieron:
- guardar la nota del pedido vacía en una mesa libre la ocupaba;
- con el pedido ya cerrado, la nota se perdía sin aviso;
- cambiar la nota con platos en cocina no llegaba al papel;
- la nota del pedido no sale en anulaciones ni cambios;
- con cursos apagados, un curso elegido antes seguía aplicándose;
- en la cocina, la nota tomaba el color de la demora.
- la impresora cambiaba las comillas «» por «?».

**Pruebas:** 137 nuevas, todas pasan.
- **Núcleo:** 384. La nota con propiedades al azar; se rechaza con el pedido cerrado.
- **Hub:** 1.171. Comanda con la nota y «NOTA NUEVA» por estación; `/api/cocina/cursos` con su matriz de permisos.
- **App:** unidades por enviar; la nota del pedido sobre el motor y sin conexión.

**Queda pendiente:**
- cambiar la nota de **un plato** ya enviado: llega con la 1.5 (comanda de cambio);
- notas rápidas en botones («sin hielo», «sin cebolla»);
- en el celular, el panel de la línea se abre encima del panel del pedido (dos niveles);
- **unir pedidos (1.5)**: hoy la nota del pedido de origen se pierde al unirlo; al construir «unir» en la 1.5, la nota del origen debe pasar al destino (una alergia no se puede perder).

**Cómo probarlo:**

1. Cierra el hub (**Ctrl+C**) y arráncalo con la versión nueva:

```bash
pnpm --filter @pos/app build && pnpm --filter @pos/hub start
```

2. En el celular abre una mesa y toca 3 veces **Aperol Spritz**. Abajo debe decir **Enviar 3**.
3. Toca **Pedido (3)**. Debajo de «Aperol Spritz» debe decir «Toca para nota». Tócalo: el campo de la nota sugiere «1 sin hielo…».
4. Escribe «1 sin hielo» en la nota y cierra el panel con la ✕. La línea debe mostrar «1 sin hielo». Al agregar o tocar + y − no debe salir ningún aviso.
5. Toca **Nota del pedido**, escribe «Cumpleaños, traer vela» y toca **Guardar**. Debe verse arriba del pedido.
6. Toca **Enviar 3**. En la impresora de barra debe salir la comanda con «NOTA DEL PEDIDO: Cumpleaños, traer vela» en negro, y «NOTA: 1 sin hielo».
7. Cambia la nota del pedido a «Alérgico al maní» y guárdala. En la barra debe salir otra comanda, «NOTA NUEVA», con esa nota.
8. Arriba, el encabezado debe ocupar una sola fila, con «Local» y el modo oscuro.

### 1.3c — Faro: marca del producto y rediseño ✅

Decisión del dueño del 25-oct-2026 ([ADR-014](DECISIONES.md#adr-014--faro-nombre-identidad-y-estilo-del-producto)). El POS es un producto propio para muchos restaurantes; La Spritzzería es el primer cliente.

**La marca del producto:**
- **Nombre: Faro.** Falta validar la marca registrada (SIC) y el dominio antes de usarlo en público.
- **Color:** verde azulado. **Letra:** Figtree, empaquetada para funcionar sin internet.
- **Logo:** un faro, también como ícono de la pestaña.
- Lo que hace y para quién está en `apps/pos/PRODUCT.md`; cómo se ve, en `apps/pos/DESIGN.md`.

**Marca opcional por restaurante:**
- Un restaurante sin configurar se ve como Faro.
- Quien administra el personal elige la marca en **Marca del restaurante**: hoy, Faro o La Spritzzería (sus colores, sus letras y su logo). Se puede deshacer.
- La marca se guarda en el hub y llega a todos los equipos con la carta.
- **Los colores de estado no cambian con la marca**: verde libre, ámbar en proceso, rojo demora. Hay una prueba que lo exige.

**Pantallas nuevas:**
- **Marco:**
  - en la caja, barra lateral con el logo, quién entró y las secciones (Servicio; Administración: Carta, Plano del salón, Personal y roles, Marca del restaurante), según los permisos;
  - en la tablet, la barra solo con íconos;
  - en el celular, un menú que se abre desde la izquierda.
- **Salón:**
  - pestañas de zona, Plano o Lista, y la leyenda con cuántas mesas hay de cada estado;
  - las mesas con sus sillas y teñidas del color de su estado;
  - los pedidos abiertos en tarjetas a la derecha (abajo en el celular), con los botones de pedidos sin mesa.
- **Toma de pedido:**
  - la carta como tarjetas con foto o, sin foto, el ícono de su estación (copa la barra, plato la cocina);
  - el precio, el «+» y `×N` si ya va en el pedido;
  - el pedido en un panel a la derecha con el total grande.
- **Fotos de productos (opcionales):**
  - en **Carta**, cada producto tiene Subir foto, Cambiar y Quitar;
  - el celular achica la foto antes de mandarla (800 px);
  - el hub la guarda en `datos/fotos`.

**Por dentro:**
- Tokens de color en `apps/pos/src/estilos.css`; una marca nueva es un bloque `data-marca` en claro y oscuro, más su entrada en `MARCAS`.
- `marca` en la configuración del restaurante (por defecto `faro`); `POST /api/restaurante/marca`.
- Fotos:
  - `POST /api/catalogo/fotos` (permiso de editar la carta, máximo 1 MB, solo WebP, JPEG o PNG comprobados por su contenido);
  - se sirven en `/fotos/…` con el nombre sacado de su contenido;
  - el token se revisa antes de leer la foto.
- **Seed:** a La Spritzzería le pone su marca si no tenía una.

Revisado por `revisor-codigo`, `qa-pruebas` y `revisor-ux`. El skill de diseño usado (Impeccable) trae dos revisores propios que no están disponibles aquí: los reemplazó `revisor-ux`, y `DESIGN.md` se escribió a mano. Se corrigieron, entre otros:
- **Hub**:
  - la foto se escribía a medias si el hub se cerraba en medio (ahora se escribe aparte y se renombra);
  - el hub leía una foto de hasta 2 MB antes de saber si el equipo podía subirla;
  - faltaba `nosniff` al servir las fotos.
- **Pantalla**:
  - la marca parpadeaba al entrar;
  - en la tablet la carta salía en una columna angosta;
  - los avisos tapaban el panel del pedido;
  - en el celular los pedidos abiertos tapaban el salón;
  - la marca de La Spritzzería cambiaba los colores de estado;
  - el menú del celular no devolvía el foco ni bloqueaba lo de atrás;
  - el control Plano/Lista medía menos de 48 px;
  - textos técnicos.

**Pruebas:**
- **Hub:** 779.
  - Fotos con nombres raros y rutas que intentan salir de la carpeta.
  - El tipo se saca del contenido, no de lo que dice el equipo.
  - Límite de 1 MB exacto.
  - Dos subidas iguales al tiempo.
  - Producto de otro restaurante.
  - Carpeta perdida y reinicio del hub.
  - Sesiones inválidas y equipos retirados.
  - Marca con dos restaurantes en la misma base.
  - El seed respeta la marca elegida.
- **App:** 531.
  - Sillas con propiedades aleatorias: la cuenta exacta, ninguna dentro de la mesa, ninguna encima de otra.
  - Contraste de todas las marcas, también sobre la barra lateral.
  - La lista de marcas de la app coincide con la del hub y con `estilos.css`.
  - Subir foto y cambiar marca sin red, con sesión vencida y con respuestas raras.
- **Base:** 288 (más la `it.fails` de la 1.3b).
- **Núcleo:** 345.
- **Sincronización:** 112.

**Queda pendiente:**
- **Copia de seguridad**: la carpeta `datos/fotos` debe entrar en la copia del hub cuando se haga (1.10).
- **Tablet**: la barra lateral muestra solo íconos, sin nombres.
- **Celular**: los paneles dentro de paneles (opciones de un producto) se apilan.
- Más de 6 personas en un pedido; el tiempo a partir del cual la demora sale en rojo; atajos de teclado y un salto al contenido para la caja; los nombres P1, P2 de las personas.
- Detalles menores:
  - un esqueleto mientras carga;
  - el aviso de zona vacía;
  - los comensales en la tarjeta de la mesa;
  - el texto alternativo de la foto y pedir confirmación antes de quitarla;
  - el ícono por categoría en vez de por estación.
- **Sillas encimadas en planos grandes**: con un salón de más de unos 18 m visto en un celular, o una barra con más de 3 puestos, las sillas se tocan. Solo es dibujo.
- **Marca que vuelve un momento**: si a un equipo le llega tarde una carta vieja, ve la marca anterior hasta el siguiente aviso, que la corrige sola.
- **scrypt asíncrono** (de la 1.3b).

**Cómo probarlo:**

1. En la ventana del hub, ciérralo con **Ctrl+C**. Debes volver a ver la línea de comandos.
2. Escribe `pnpm seed`. Debe terminar sin error. Desde ahora La Spritzzería tiene su marca.
3. Compila y arranca:

```bash
pnpm --filter @pos/app build && pnpm --filter @pos/hub start
```

4. En el PC de la caja abre la dirección del hub. La pestaña debe mostrar el faro y la pantalla de entrar una tarjeta blanca. Entra con el usuario del administrador.
5. Debes ver la barra lateral con el logo de La Spritzzería, tu nombre y las secciones. En el salón, las mesas con sus sillas y, a la derecha, los pedidos abiertos.
6. En la barra lateral toca **Marca del restaurante** y luego **Usar** en Faro. Todo debe pasar a verde azulado con el logo del faro, y salir un aviso con **Deshacer**. Toca **Deshacer**: vuelve La Spritzzería.
7. Toca **Carta**, abre un producto y toca **Subir foto**. Elige una foto del PC. Debe verse en el producto.
8. Vuelve al **Salón** y abre una mesa libre. El producto debe salir con su foto; los demás, con el ícono de copa o de plato. Toca uno: el `×1` aparece en la tarjeta y el producto en el panel de la derecha, con el total.
9. En el celular abre la misma dirección y entra con un PIN de mesero. Debe verse con la marca que elegiste. Toca el menú de arriba a la izquierda: se abre la barra lateral. Ciérrala con la ✕.
10. En el salón del celular, los pedidos abiertos van debajo de las mesas. Abre una mesa: abajo debe salir la barra con las unidades y el total.

### 1.3b — Acceso por rol ✅

Decisión del dueño del 24-oct-2026 ([ADR-013](DECISIONES.md#adr-013--acceso-por-rol-meseros-con-pin-desde-la-ip-caja-con-usuario-y-contraseña)). Reemplaza el emparejamiento de la 0.7: **ya no hay que emparejar ningún celular**.

**Entrar:**
- **Meseros**: abren la IP del hub en el celular y escriben su PIN. El hub registra el celular la primera vez.
- **Caja, administración y reportes**: entran con **usuario y contraseña** desde cualquier equipo del local. El hub recuerda en cada equipo cómo se entró la última vez.
- **Quien puede cobrar, manejar la caja, editar la carta, ver reportes o administrar entra siempre con contraseña**, aunque su rol se cambie. Su PIN no le sirve para entrar: con él aprueba anulaciones y descuentos en el celular de un mesero.
- **Contraseña errada**: la misma respuesta si el usuario no existe. Tras varios intentos hay una espera, que por usuario dura como máximo 10 s.

**Personal y roles** (botón en el salón, para quien puede administrar el personal):
- **Personas**:
  - alta con nombre, rol y cómo entra (PIN, o usuario y contraseña); el PIN se muestra una sola vez;
  - **Nuevo PIN**, archivar (con confirmación) y volver a activar.
- **Roles**:
  - los de fábrica (Administrador, Cajero, Reportes y Mesero) y los que cree el restaurante;
  - **los permisos de cada rol se marcan uno por uno**;
  - los de fábrica no se renombran ni se archivan.
- **Equipos**: cada equipo con su último uso y quién lo usó; **Retirar** uno perdido o robado.
- **Protecciones**:
  - siempre queda al menos una persona que puede administrar, con contraseña;
  - avisa si solo hay una;
  - pide confirmar antes de quitarte tu propio acceso y antes de salir con cambios sin guardar.

**Por dentro:**
- `POST /api/entrar` (PIN o usuario y contraseña, con o sin token) y `/api/personal/…`.
- Contraseñas con scrypt en la migración 5, solo en el hub. Usuarios únicos por restaurante.
- Un hub de antes conserva lo suyo:
  - Contador pasa a ser Reportes;
  - Gerente y Cocina quedan como roles propios;
  - el administrador recibe usuario y contraseña al arrancar.
- **Seed**: «Caja» y «Reportes» con usuario y contraseña, y tres meseros con PIN.
- **Si se pierde la contraseña del administrador**: `pnpm restablecer-admin` en el PC del hub, con el hub cerrado.
- **«Simular corte»** ahora solo se ve en desarrollo o abriendo la app una vez con `?demo=1` (`?demo=0` lo quita).

Revisado por `revisor-codigo`, `qa-pruebas` y `revisor-ux`. Se corrigieron, entre otros:
- **Seguridad**:
  - un rol de caja o de administración podía entrar solo con PIN;
  - el tiempo de respuesta delataba qué usuarios existían;
  - probar contraseñas dejaba al administrador afuera hasta 60 s;
  - cualquier celular podía crear códigos de emparejamiento de caja;
  - el arranque y `restablecer-admin` no filtraban por restaurante;
  - `restablecer-admin` perdía el PIN que regeneraba;
  - reactivar a alguien cuyo PIN tenía otra persona daba un error 500.
- **Pantalla**:
  - archivar no pedía confirmación;
  - el PIN nuevo se perdía con un toque afuera;
  - cambiar a «Con su PIN» borraba la contraseña sin avisar;
  - no se podía retirar un celular perdido;
  - los errores se escondían en el botón;
  - los mensajes hablaban de «hub» y de «emparejar».

**Pruebas:**
- **Hub:** 701.
  - Fuerza bruta de PIN y contraseña, rotando IP.
  - Tiempos iguales para usuarios que existen y que no.
  - Contraseñas con Unicode.
  - Dos restaurantes en la misma base, sin cruces.
  - Carreras al quitar el último administrador.
  - Roles viejos convertidos.
  - Reinicio y pérdida de la clave de los PIN.
  - `restablecer-admin` como proceso real.
- **App:** 463, con el motor sin conexión, con un token falso y con uno retirado.
- **Base:** 288, con la migración 5 y las transacciones anidadas. Una más falla a propósito (`it.fails`): documenta lo del savepoint.
- **Núcleo:** 341.
- **Sincronización:** 112.

**Queda pendiente:**
- **El hub espera mientras comprueba**: comprobar una contraseña (scrypt, unos 50 ms) detiene al hub mientras tanto. Si el piloto muestra lentitud por intentos masivos desde el Wi-Fi, se pasa a scrypt asíncrono.
- **Equipos de más**:
  - cada vez que alguien entra desde un navegador sin datos guardados (modo privado, datos borrados) se registra un equipo nuevo;
  - no hay tope ni limpieza automática;
  - se ven y se retiran en Equipos.
- **Permisos que cambian**: si cambian los permisos de un rol, quien ya está trabajando ve los botones nuevos al volver a entrar. El hub aplica lo nuevo de inmediato.
- **Pantalla de cocina**: cómo entra (sin rol Cocina de fábrica) se decidió en la 1.4: la convierte el administrador ([ADR-015](DECISIONES.md#adr-015--comandas-impresas-por-estación-pantalla-de-cocina-opcional-y-entrega-por-el-mesero)).
- **Roles de un hub ya instalado**: un hub que ya existía conserva los permisos de sus roles. En el tuyo, el Cajero no tiene anular ni descontar hasta que los marques en **Personal y roles**.
- **Pasos viejos**: los de las tareas 0.7 y 0.10 que dicen «emparejar» ahora son «entrar».
- **Transacciones anidadas sin savepoint**: si una transacción de adentro falla y quien la llama atrapa el error y sigue, lo que alcanzó a escribir queda. Ningún código lo hace hoy y el comentario de `enTransaccion` lo advierte; hay una prueba `it.fails` que lo documenta.
- **Doble envío del formulario**: guardar dos veces seguidas una persona nueva crea dos personas. Se archiva la repetida.
- **Retirar no es para siempre**: un celular retirado que borra sus datos puede volver a entrar como equipo nuevo, si alguien sabe un PIN válido.

**Cómo probarlo:**

1. Cierra el hub si está abierto (**Ctrl+C**). Escribe `pnpm seed` y anota lo que muestra:
   - **Administrador**: usuario y contraseña;
   - **Caja** y **Reportes**: usuario y contraseña;
   - **Mesero 1, 2 y 3**: su PIN.

   Si tu base ya tenía el seed, solo verás «Caja» y «Reportes» con contraseña nueva. La del administrador sale al arrancar el hub en el paso 2.
2. Compila y arranca:

```bash
pnpm --filter @pos/app build && pnpm --filter @pos/hub start
```

   Si el administrador todavía entraba con PIN, la ventana muestra «Administrador (para entrar a la caja)» con su usuario y contraseña. Anótalos.
3. En el PC de la caja abre la dirección del hub. Debes ver **Entrar** con Usuario y Contraseña. Escribe una contraseña errada: debe decir «Usuario o contraseña incorrectos» y conservar el usuario. Luego entra con la del administrador: debes ver el salón y el botón **Personal y roles**.
4. Toca **Personal y roles → Roles → Cajero**. Marca «Anular lo ya enviado a cocina» y «Dar descuentos», y toca **Guardar**. Debe decir «Guardaste el rol Cajero».
5. En **Personas**, toca **Persona nueva**, escribe «Pedro», deja el rol Mesero y «Con su PIN», y toca **Guardar**. Debe salir el PIN de Pedro en grande. Toca **Ya lo anoté**.
6. Toca otra vez **Persona nueva**, escribe «Laura» y elige el rol **Cajero**. Debe pasar sola a «Con usuario y contraseña», con el usuario «laura». Escribe una contraseña de al menos 8 caracteres y guarda. Debe salir su PIN, explicado como PIN para aprobar anulaciones y descuentos.
7. En el celular, conectado al Wi-Fi del local, abre la misma dirección. Debes ver el teclado del PIN. Escribe el de Pedro: debes ver el salón, sin los botones de la carta ni de personal.
8. En el celular toca **Salir**, luego «Caja, administración o reportes: entrar con usuario y contraseña», y entra como «laura». Debe entrar. Este celular ahora cuenta como caja.
9. En la caja, abre **Personal y roles → Equipos**. Debes ver el celular con «Último uso: Laura». Toca **Retirar** y confirma. En el celular, la app debe decir que el equipo no puede entrar.
10. Abre a Pedro y toca **Archivar**: debe preguntar antes. Confirma. En el celular su PIN ya no entra.

### 1.3 — Toma de pedido por comensal y curso ✅

**Toma de pedido** (tocar una mesa en el salón):
- Arriba: buscador tolerante a errores, **Favoritos** (lo marcado así en la carta), **Lo más pedido** (lo que más se ha pedido en este equipo) y las categorías.
- **¿Cuántas personas?** con botones del 1 al 6 al sentar la mesa; después se ajusta con − y + en el pedido. Fuera del salón no se cuentan personas.
- **Para** (Mesa, P1, P2…) y **Curso** (Sin curso, Entrada, Fuerte, Postre) valen para todo lo que se agregue después. En el celular cada fila se desliza.
- Tocar un producto lo agrega. El mismo producto, para la misma persona y el mismo curso, **suma a su línea**. Cada toque deja un aviso con **Deshacer**.
- Productos con opciones o tamaños abren un panel con cantidad y nota para cocina. Si solo hay una cosa que elegir, tocarla ya lo agrega.
- En el buscador, **Esc** lo borra y **Enter** agrega el producto si queda uno solo.
- **El ticket** va agrupado por curso: − y + en cada línea (dos toques seguidos cuentan dos), y al tocar la línea se cambia cantidad, persona, curso o nota, o se duplica o quita.
- **Retener** un curso: el fuerte espera mientras la entrada sale. **Enviar** manda lo pendiente; lo retenido sale al tocar **Marchar**.
- **Agotados (86)**: quien tiene el permiso `agotar_producto` (admin y cajero) toca **Agotados** y luego los productos. Se ve al instante en todos los equipos, también sin conexión para quien lo marcó, y se puede deshacer. Un producto con tamaños deja agotar uno solo.
- **Pedidos sin mesa**: en el salón, **Para llevar**, **Domicilio** y **Barra** abren un pedido con número del día. Los abiertos se ven ahí con su total y su mesero.

**Por dentro:**
- Agotar y volver a ofrecer son eventos `ProductoAgotado` y `ProductoDisponible` del producto (no de un pedido), firmados y ordenados por el hub como los demás ([SYNC.md](SYNC.md)).
- Lo agotado y lo más pedido se calculan en cada equipo a partir de los eventos que tiene guardados.

Revisado por `revisor-codigo`, `qa-pruebas`, `revisor-ux` y `auditor-dinero`. Se corrigieron, entre otros:
- **en el hub:** un evento de producto podía nombrar un pedido y contarse como suyo; dos variables con el mismo nombre impedían correr las pruebas;
- **al tocar:** − y + usaban la cantidad de la pantalla, así que dos toques rápidos contaban uno; sumar a una línea retenida o con otro precio la mezclaba;
- **en «Lo más pedido»:** no contaba lo sumado a una línea y contaba lo quitado;
- **en la pantalla:** el aviso decía «el entrada»; la nota se perdía al cerrar el panel; el foco saltaba al título cuando un pedido para llevar recibía su número.

**Pruebas:**
- **Núcleo:** 340.
- **Sincronización:** 112, con lotes mixtos sin conexión, caída del hub a mitad de lote y convergencia entre equipos.
- **Hub:** 528, con WebSocket de verdad. Un mesero no puede agotar: el hub lo rechaza y su equipo deja de verlo agotado.
- **App:** 435.
- **Base:** 270.

**Queda pendiente:**
- **Acceso:** el acceso por rol (meseros con PIN desde la IP, sin emparejar; caja con usuario y contraseña) es la tarea 1.3b.
- **Lo que el hub todavía no revisa:**
  - el precio de un cambio después de enviado (`ItemModificadoTrasEnvio`);
  - un producto agotado que se agrega desde un equipo que no lo sabía. Lo acepta: el aviso es solo en la pantalla.
- **Datos:**
  - el ítem no guarda la versión de la carta con que se agregó, así que Deshacer y Duplicar la buscan en los eventos guardados;
  - «Lo más pedido» es por equipo: cada uno cuenta lo que ha visto.
- **Agotar por tamaño:** no se probó a mano, porque la carta del piloto no tiene productos con tamaños (botella y copa son productos aparte).
- **Código:** la lógica de la pantalla de pedido vive dentro del componente y no tiene pruebas unitarias propias. Conviene separarla en archivos más pequeños.

**Cómo probarlo:**

1. Cierra el hub si está abierto (**Ctrl+C**). Si la base no tiene la carta (el salón dice «Todavía no hay mesas»), escribe `pnpm seed` y anota los PIN que muestra.
2. Compila y arranca:

```bash
pnpm --filter @pos/app build && pnpm --filter @pos/hub start
```

   Debes ver `Hub en marcha` y las direcciones.
3. En la caja, entra con el PIN del administrador o del cajero y toca una mesa libre. Debes ver **¿Cuántas personas?** con botones del 1 al 6. Toca **2**: arriba del ticket debe decir «2 personas» y aparecen **Para: Mesa, P1, P2**.
4. Toca **P1**, luego **Entrada**, y toca dos veces un producto. En el ticket, bajo «Entrada», debe quedar una línea con 2 y «P1 · sin enviar».
5. Toca **P2**, luego **Fuerte**, y toca otro producto. Debe aparecer bajo «Fuerte».
6. En la línea de la entrada toca **−**: debe quedar en 1. En «Fuerte» toca **Retener**: debe decir «Fuerte · espera» y, abajo, que «Enviar» no lo manda.
7. Toca **Enviar 1**. Debes volver al salón con «Enviado a cocina y barra (1)». Abre la mesa otra vez y toca **Marchar 1**: debe decir «Enviado el fuerte (1)» y las dos líneas «enviado».
8. Toca **Agotados** y un producto: debe verse tachado con «Agotado» y un aviso con **Deshacer**. Toca **Deshacer** y luego **Listo**.
9. En el celular, con el mesero, abre la misma mesa: si agotaste algo, debe verse agotado y no deja agregarlo.
10. Vuelve al salón y toca **Para llevar**. Agrega algo: el título debe cambiar a «Para llevar #N» y, en el salón, el pedido debe aparecer junto a los botones con su total.

### 1.2 — Editor de plano y vista operativa de mesas ✅

**Salón** (la pantalla inicial):
- Cada zona o piso con sus mesas en su lugar real y su forma, a escala de la pantalla. Se ven también las paredes, puertas, plantas, el mostrador y los textos.
- En cada mesa ocupada: estado, tiempo desde que se abrió y total; el mesero, si la mesa se ve grande.
- **Ver en lista**: la misma información en filas. Es la vista por defecto en el celular y se recuerda en cada equipo.
- Si quedó un pedido abierto en una mesa que ya no está en el plano, aparece un aviso para la caja.

**Editor del plano** (botón **Editar plano**, para quien puede editar la carta):
- **Zonas:** salón, terraza, segundo piso, con su piso.
- **Mesas:** cuadradas, redondas, rectangulares o puestos de barra, con nombre y puestos. **Varias a la vez…** pone N mesas iguales en filas con los números siguientes; un salón de 25 mesas son unos pocos toques.
- **Elementos:** paredes, puertas, plantas, el mostrador y textos.
- **Edición:**
  - se arrastra para mover y la esquina cambia el tamaño;
  - se gira de 15 en 15 o 90°, y se duplica;
  - todo va a una cuadrícula de 10 cm;
  - con el teclado: las flechas mueven, la R gira y Ctrl+Z deshace.
- **Deshacer**, **Descartar** (pregunta antes) y **Guardar**. Al cambiar de zona, volver, salir o recargar con cambios, pregunta. Ahí se puede **Guardar y seguir**.
- Las mesas quitadas de una zona se pueden **volver a poner**.

**En el hub:**
- Zonas, mesas y elementos se editan con la misma API que la carta, con el permiso `editar_catalogo`. La tabla `elemento_plano` llega con la migración 4.
- **Reglas:**
  - dos mesas activas no se llaman igual, ni en zonas distintas;
  - no se archiva una mesa con un pedido abierto, ni una zona con mesas activas.
- La carta que reciben los equipos trae la geometría de cada mesa, los elementos y el personal (solo id y nombre, para mostrar el mesero).
- Un equipo con una carta guardada por la versión anterior de la app la completa en vez de quedar en blanco. Este error apareció al probar.

Revisado por `revisor-codigo`, `qa-pruebas` y `revisor-ux`. Se corrigieron, entre otros:
- los campos de medidas no dejaban escribir números de varias cifras;
- cambiar el tamaño de algo girado iba en la dirección equivocada;
- un pedido en una mesa archivada no se veía en ninguna parte;
- «Salir» y «Descartar» borraban los cambios sin preguntar;
- dibujar 25 mesas costaba más de 50 toques;
- mesas y el control de tamaño por debajo de 48 px;
- textos por debajo de 14 px;
- el foco se perdía al agregar o quitar;
- al llenarse la primera fila, las mesas nuevas se apilaban en una sola columna y con unas 80 mesas el hub rechazaba el guardado;
- el hub no veía repetidos los nombres de mesa con tildes o eñes («Ñandú» y «ñandú»).

**Pruebas:**
- **Hub:** 508. Incluyen el hub de verdad como proceso: un pedido abierto por WebSocket impide archivar su mesa, también tras reiniciar el hub. También el seed después de dibujar el salón.
- **App:** 387, con propiedades al azar: mover, girar y medir siempre quedan en la cuadrícula y dentro de los límites; guardar y volver a abrir da lo mismo.
- **Base:** 270, con la migración 4 sobre una base con datos.

**Queda pendiente:**
- Unir y separar mesas, y los estados precuenta, por pagar, sucia y reservada: tareas 1.5 y 1.6.
- Pedidos sin mesa (para llevar, domicilio, barra) y los comensales: tarea 1.3.
- Color de demora por tiempo en la mesa: los tiempos de cocina ya existen (1.4); falta pintarlos en el plano.
- El gesto de «atrás» del celular dentro de la app no pregunta por cambios sin guardar (recargar y cerrar la pestaña sí). El borrador del editor no se guarda en el equipo: si se cae el navegador, se pierde lo no guardado.
- Una zona archivada no se puede volver a mostrar desde la pantalla todavía.
- No avisa si dos mesas quedan una encima de otra.

**Cómo probarlo:**

1. Cierra el hub si está abierto (**Ctrl+C**) y arráncalo de nuevo:

```bash
pnpm --filter @pos/app build && pnpm --filter @pos/hub start
```

   Debes ver `Base de datos actualizada a la versión 4.` y `Hub en marcha`.
2. En la caja, entra con tu PIN de administrador o de gerente. En el salón debes ver las 25 mesas en cuadrícula. Toca **Editar plano**.
3. Toca **Nueva zona**, escribe «Terraza» como nombre, toca **Varias a la vez…**, elige **Redonda**, deja 10 y 5 por fila, y toca **Agregar 10**. Debes ver dos filas de mesas redondas con los números 26 a 35.
4. Arrastra la mesa 26 a otro lugar y toca **Guardar**. Debes ver «Guardaste Terraza».
5. Vuelve al salón (flecha arriba a la izquierda). Debes ver las pestañas **Salón** y **Terraza**. En Terraza, las mesas en su lugar.
6. En el celular, abre la app: debe verse en lista, con las mesas de las dos zonas. Toca **Ver plano** para ver el dibujo.
7. Toma un pedido en la mesa 5 y vuelve: en el plano, la mesa 5 debe verse en ámbar con el tiempo y el total.
8. En el editor, elige la mesa 5, toca **Quitar del plano** y **Guardar**. Debe decir que la mesa 5 tiene un pedido abierto.

### 1.1 — Catálogo completo ✅

**Editor de la carta** en la caja (botón **Carta** en el salón, para quien tenga permiso de editar la carta o los precios):
- **Productos:** nombre, descripción, categoría, impuesto y precio; **tamaños** con su precio (copa y botella); los grupos de opciones que pide; archivar y volver a poner en la carta. Búsqueda tolerante y lista de archivados.
- **Grupos de opciones:** término de la carne, sabor o adicionales con precio extra, con cuántas se pueden y se deben elegir. Un grupo sirve para varios productos; la lista dice cuáles lo usan.
- **Categorías y estaciones:** a qué estación va cada categoría (cocina o barra).
- Con solo el permiso **editar_precios** se ve todo, pero solo se cambian precios.
- Un precio mal escrito («53,900», «1.5») no se guarda. Al cerrar un panel con cambios, pregunta antes de descartarlos.

**En el hub:**
- `POST /api/catalogo/cambios`: los cambios de un guardado se aplican todos o ninguno, con la sesión y el permiso.
- No deja dejar la carta rota: nada activo apunta a algo archivado. No se archiva un impuesto o una categoría con productos activos, ni una estación con categorías activas. Archivar un grupo lo quita de sus productos.
- Repetir el mismo guardado (un reintento tras un corte) no cambia nada ni avisa a nadie.
- **Historial de la carta** (`catalogo_cambio`, migración 3): cada cambio queda con cómo estaba, cómo quedó, quién y desde qué equipo. El seed escribe por el mismo camino.
- **Aviso a los equipos:** al guardar, el hub manda `catalogo` y cada equipo trae la carta nueva sin recargar. También la trae al reconectarse.
- **Revisión del precio copiado:** cada ítem que llega se compara con la carta en la versión que vio el equipo. Si algo no cuadra, el ítem se acepta (ya se pidió, quizá sin conexión) y queda como conflicto `precio_distinto` para la caja. Se revisan:
  - el producto;
  - la copa o botella obligatoria;
  - los precios y el impuesto;
  - que cada opción sea de ese producto y no venga repetida.

Revisado por `revisor-codigo`, `qa-pruebas`, `auditor-dinero` y `revisor-ux`. Se corrigieron, entre otros:
- un precio mal escrito se guardaba con el último número válido («53,900» quedaba en $53), y «1.5» se leía como 15;
- cerrar el panel descartaba los cambios sin preguntar;
- se podía archivar un impuesto o una categoría en uso y sus productos desaparecían de la carta sin aviso;
- una respuesta vieja de la carta podía pisar una más nueva en el equipo;
- abrir y guardar sin tocar nada mandaba cambios si había un tamaño archivado en medio;
- archivar un producto y tocar uno de sus tamaños en el mismo guardado hacía que el hub lo rechazara todo;
- un adicional de otro producto o repetido pasaba sin conflicto;
- el Deshacer de «Quitar» en la toma de pedido marcaba un precio distinto falso.

**Pruebas:** 450 en el hub y 320 en la app. Incluyen:
- la migración sobre una base con datos;
- 300 cambios seguidos del mismo producto;
- un guardado de 200 cambios;
- el aviso por WebSocket, que no llega a equipos revocados;
- propiedades con datos al azar: guardar un borrador y volverlo a abrir da lo mismo.

**Queda pendiente:**
- Cambiar las opciones de un ítem ya enviado (`ItemModificadoTrasEnvio`) todavía no se revisa contra la carta: llega con la toma de pedido de la 1.3.
- Un evento guarda un solo conflicto: si ya tenía otro, el de precio no se anota.
- Agotar un producto (86) llega en la 1.3.
- Sin Deshacer al guardar en el editor; Enter no guarda. Los dos grupos «Sabor» (Té Hatsu y Soda Hatsu) se llaman igual en los botones del producto: conviene renombrarlos desde el editor.
- Editar la carta pide conexión con el hub; sin ella, el cambio no se guarda y el panel lo dice.
- Los modificadores reales con precio (quitar ingredientes, adicionales) los puede cargar el restaurante desde el editor.

**Cómo probarlo:**

1. Cierra el hub si está abierto (**Ctrl+C** en su terminal) y arráncalo de nuevo:

```bash
pnpm --filter @pos/app build && pnpm --filter @pos/hub start
```

   Debes ver `Base de datos actualizada a la versión 3.` y `Hub en marcha`.
2. En la caja, entra con tu PIN de administrador o de gerente. En el salón debes ver el botón **Carta**. Tócalo.
3. Toca **Pinsa**, cambia el precio a `22.900` y toca **Guardar**. Debes ver «Guardaste Pinsa» y el precio nuevo en la lista.
4. En el celular, abre una mesa: la Pinsa debe decir **$22.900** sin recargar la página.
5. En la caja, vuelve a abrir la Pinsa, escribe `22,900` en el precio. Debes ver «Hay un precio mal escrito» y el botón sin poder tocarse. Toca la **X** y luego **Descartar**.
6. En **Grupos de opciones**, toca **Nuevo grupo de opciones**: nombre «Adicionales», máximo 2, opción «Tocineta» con precio extra `4.000`. Guarda.
7. Abre la **Spritz Burguer**, toca **Adicionales** en «Grupos de opciones que se piden» y guarda. En el celular, al tocar la hamburguesa debe aparecer «Adicionales» con «Tocineta + $4.000».

### 0.10 — Pantalla mínima para la demo de sincronización ✅

La app ya no muestra la página de inicio con "Conectado al hub". Al abrirla se empareja el equipo, se entra con el PIN y se toman pedidos reales, que se sincronizan con el hub. Es la pantalla que usa la prueba de aceptación de la Fase 0.

**En el hub:**
- WebSocket de sincronización en `/api/sync/ws`:
  - latido cada 5 s;
  - mensajes de hasta 1 MB;
  - cierra la conexión que no saluda en 10 s.
- `GET /api/catalogo` (solo con un equipo emparejado): mesas, estaciones y la carta vigentes, con los minutos de inactividad de la sesión.
- La instancia del hub se guarda en el archivo `hub-instancia` de la carpeta de datos. Si el hub se reinstala, los equipos lo notan y reenvían lo suyo.

**En la app** (`apps/pos/src/sala`):
- **Emparejar:**
  - el primer equipo (la caja) se aprueba con el PIN del administrador;
  - los demás escriben el código que muestra la caja en **Aprobar un equipo**.
- **Entrar con PIN:** el PIN lo comprueba el hub, así que hace falta conexión para entrar, pero no para trabajar después. La sesión se cierra en el equipo tras 30 minutos sin uso (configurable) y lo explica al pedir el PIN.
- **Salón:** las 25 mesas del piloto, con su estado, su total y "sin confirmar" si algo no ha llegado al hub.
- **Pedido:**
  - tocar productos y **Enviar**;
  - copa o botella y término de la carne en el panel lateral;
  - Deshacer al agregar y al quitar;
  - una comanda por estación (cocina o barra).
- **Barra superior:** estado de la conexión, cuántas acciones faltan por confirmar y el interruptor **Simular corte**, que corta la conexión con el hub como si se cayera el Wi-Fi.
- **Persistir antes de mostrar:** cada toque se guarda en el equipo (IndexedDB) antes de verse. Sin conexión, el aviso dice "Guardado: llega a cocina cuando vuelva la conexión", no "Enviado".
- Cada evento va firmado con el secreto de la sesión (ADR-008).

Revisado por `revisor-codigo`, `qa-pruebas`, `revisor-ux` y `auditor-dinero`. Se corrigieron, entre otros:
- al arrancar podían quedar dos conexiones abiertas y cada pendiente se enviaba en dos lotes;
- **Enviar** justo después de tocar un producto dejaba ese producto sin enviar;
- un fallo al agregar el primer producto dejaba un pedido vacío en la mesa;
- un grupo obligatorio se daba por cumplido con una opción de otro producto, y se podía cobrar sin el extra;
- el recorte silencioso de opciones de más cobraba distinto de lo que mostraba el botón;
- con cada latido del hub la pantalla releía todos los pedidos;
- la pantalla de "equipo rechazado" prometía que lo pendiente llegaría al hub, y no es así;
- "Simular corte" no cortaba la entrada con PIN.

**Pruebas** (245 unitarias en `apps/pos`, 296 en el hub):
- **Hub:** el WebSocket de punta a punta (emparejar dos equipos, entrar con PIN, un pedido firmado que llega confirmado y el otro equipo lo recibe), mensajes de más de 1 MB, conexiones que se cortan o no saludan, equipos revocados estando conectados, y el catálogo.
- **App:**
  - el almacén de IndexedDB se porta igual que el de memoria con el que se probó la sincronización;
  - dos equipos sin conexión crean pedidos y, al volver, ven lo mismo sin duplicados, contra un hub que exige la firma;
  - hub caído a mitad de un lote, hub reiniciado, token inválido o revocado, reloj del hub desfasado dos horas y la sesión que vence por falta de uso;
  - el armado de ítems y comandas, con el precio del botón igual al que queda guardado;
  - la proyección de mesas.

**Queda pendiente:**
- **Pruebas e2e:** por pedido tuyo se dejan para el final. Falta escribir el escenario 14 con dos navegadores. `tests/e2e/estado-hub.spec.ts` y `conexion-hub.spec.ts` revisaban la página de inicio que ya no existe: quedan apartadas hasta reescribirlas sobre el indicador nuevo.
- Los mensajes del hub solo se descartan si no tienen `tipo`; validar cada tipo con su esquema llega cuando el hub deje de ser solo de la red local.
- Si se sale sin conexión, la sesión queda abierta en el hub hasta que otra persona entre en ese equipo. No es grave: el secreto ya se borró del equipo.
- Dos pestañas de la app en el mismo equipo comparten la base y pueden desordenar la vista local. El hub no duplica nada.
- Un producto cuyo impuesto esté archivado no aparece en la carta, y por ahora no hay aviso.
- No hay búsqueda en la carta de la demo; las categorías bastan. La búsqueda tolerante de los bocetos llega con la toma de pedido de la Fase 1.
- No se piden los comensales: el pedido se abre con 0.

**Cómo probarlo con un celular y la caja:**

1. Si el hub está abierto, ciérralo con **Ctrl+C** en su terminal.
2. Compila la app y arranca el hub:

```bash
pnpm --filter @pos/app build && pnpm --filter @pos/hub start
```

   Debes ver `Hub en marcha` y una dirección como `http://192.168…:4000`.
3. En la caja (o en tu computador), abre esa dirección. Debes ver **Emparejar este equipo**.
4. Toca **Es el primer equipo**, deja el nombre «Caja» y el tipo **Caja**, y escribe el PIN del administrador: el que mostró el hub la primera vez que arrancó (si arrancó sin ventana, está en `apps/hub/datos/pin-administrador.txt`). Debes pasar a **Escribe tu PIN**.
5. Escribe tu PIN (o el del administrador). Debes ver **Salón** con las 25 mesas libres y, arriba, **Solo red local**.
6. Toca **Aprobar un equipo**, escribe «Celular» como nombre, deja **Celular o tablet de mesero** y escribe el PIN del administrador. Debes ver un código de 8 letras.
7. En el celular, conectado al mismo Wi-Fi, abre la misma dirección, toca **Tengo un código**, escríbelo y toca **Emparejar**. Debes ver **Escribe tu PIN**. Escribe el PIN de un mesero. Debes ver el mismo salón.
8. En el celular, toca **Simular corte**. Arriba debe aparecer **Sin conexión** en rojo.
9. Toca la mesa 5, agrega dos productos y toca **Enviar**. Debes ver «Guardado (2): llega a cocina cuando vuelva la conexión», la mesa 5 en ámbar con «sin confirmar» y, arriba, **4 sin confirmar** (abrir el pedido, los dos productos y el envío).
10. En la caja, mientras tanto, toma un pedido en la mesa 6. La mesa 5 debe seguir libre en la caja.
11. En el celular, toca otra vez **Simular corte** para volver. En pocos segundos debe desaparecer «sin confirmar». Las dos pantallas deben mostrar las mesas 5 y 6 ocupadas con los mismos totales, sin pedidos repetidos.
12. Recarga la página en el celular: todo debe seguir igual, sin pedir el PIN otra vez.

### 0.9 — Design system y bocetos de las 5 pantallas ✅

**Aprobados por el dueño el 24-oct-2026.**

**Dirección visual elegida: neutra** (24-oct-2026): gris claro, letra del sistema, azul en la acción principal y sin logo. Las direcciones con la marca de La Spritzzería quedan como opción para cuando cada restaurante configure la suya (Fase 1).

**Direcciones visuales con la marca de La Spritzzería** (tomada de su carta web, `la-spritzzeria-menu/DESIGN.md`: paleta Bagno, League Gothic y Alegreya Sans, y el logo). Se eligen en `/bocetos` y cambian todas las pantallas:
- **Bagno:** el mundo de la carta. Suelo de arena, marino que escribe y actúa, toldo a rayas bajo la barra, logo en su insignia, títulos, números de mesa y precios en League Gothic. En modo oscuro pasa a Noche.
- **Taller:** como el panel de administración de la carta. Gris neutro, letra del sistema y el naranja de marca solo en la acción principal. Respeta la decisión del dueño de que las herramientas internas se vean como herramienta.
- **Noche en la terraza:** Bagno oscuro siempre, para el bar de noche y la cocina.
- **Neutra:** la base sin marca que vería otro restaurante.

El significado de los colores de estado no cambia con la marca: verde libre, ámbar en proceso, rojo demora. El ámbar de estado es mostaza, para que no se confunda con el naranja Aperol. Las cuatro cumplen contraste AA en claro y oscuro, y la prueba las mide todas. Las fuentes van empaquetadas en la app (funciona sin internet) y solo se descargan si se elige una marca que las use.

**Design system** (`apps/pos/src/estilos.css` y `apps/pos/src/ui`), según la sección 5 del brief:
- **Colores con significado fijo:** verde = libre o listo, ámbar = en proceso, rojo = demora o alerta, azul = acción principal, gris = lo demás. Siempre con ícono y texto, nunca solo color.
- **Contraste y tamaños:** contraste AA en claro y en oscuro, que una prueba automática mide en cada cambio. Botones de al menos 48 px.
- **Modo oscuro:** sigue al sistema, se puede elegir y se recuerda. Se aplica antes de pintar para que no haya destello blanco.
- **Componentes:**
  - botón;
  - etiqueta de estado;
  - opciones que se eligen tocando;
  - **panel lateral** (sube desde abajo en el celular y sale por la derecha en tablet y caja);
  - **avisos con Deshacer** (hasta tres a la vez);
  - **teclado PIN** de 4 dígitos;
  - **indicador de conexión** y de impresoras;
  - **búsqueda tolerante** («hamburgesa» encuentra la Spritz Burguer; «quatro formagi», la Quattro Formaggi).

**Bocetos navegables** en `/bocetos`, con la carta real (98 productos) y los cálculos de dinero reales de `packages/core`:
- **Plano de mesas:** estados con color, ícono y texto, y tiempo y saldo en cada mesa. Plano o lista. En tablet y caja, las cuentas abiertas al lado.
- **Toma de pedido:**
  - tocar mesa → tocar producto → Enviar, en 3 toques;
  - el mismo producto suma a su línea;
  - copa o botella, sabor y término con un toque en el panel lateral;
  - deshacer lo agregado o quitado;
  - anular lo ya enviado, con motivo y confirmación;
  - botón «Cuenta».
- **Cocina y barra (KDS):** tarjetas por mesa y estación, tiempo desde el envío (a tiempo, atención a los 10 min, demora a los 20). Tocar un ítem lo marca listo; «Todo listo» deja la mesa «Lista para servir» en el plano.
- **Precuenta y división:** propina sugerida sobre la base sin INC, en partes iguales o por ítems (con ítems compartidos). Cada cuenta tiene su propina y su botón para cobrarla.
- **Cobro:**
  - efectivo con redondeo a $100 y cambio;
  - propina en efectivo sugerida redondeada y editable (tu decisión), con «deja el cambio de propina»;
  - tarjeta con número de aprobación;
  - pagos parciales por cuenta;
  - confirmación antes de registrar;
  - atajos F2, F3, Enter y Esc;
  - la mesa se cierra sola al quedar en $0.

Revisado por `revisor-ux`, `revisor-codigo`, `auditor-dinero` y `qa-pruebas`. Se corrigieron, entre otros:
- escribir notas hacía perder el foco en cada letra;
- el teclado del PIN se trababa con dos errores iguales seguidos;
- Enter sobre «Cancelar» registraba el pago;
- no había forma de pedir la cuenta desde el celular;
- quitar una cuenta en la división hacía caer la pantalla;
- dividir usaba el total en vez del saldo;
- el tiempo de una comanda se reiniciaba al enviar otra;
- la propina en efectivo daba totales imposibles de pagar con billetes.

**Pruebas:** 95 unitarias en `apps/pos` (contraste AA, búsqueda, formatos, y división y cobro con pruebas de propiedades). Hay además unas 185 pruebas de navegador en `tests/e2e/bocetos.spec.ts`, cada una en celular y en caja. En su última corrida pasaron 370 de 371; la única falla era un error real (dos paneles abiertos), que ya quedó corregido. Por pedido tuyo, la corrida completa de las pruebas e2e se deja para el final.

**Decisiones abiertas para cuando revises:**
- «Por cobrar» va en gris; el revisor de UX propone ámbar.
- Modo oscuro automático de noche, o solo siguiendo al sistema.
- Sonido al enviar una comanda.

**Ojo para la Fase 1:** los datos de los bocetos viven en memoria y se simplifican, porque los ítems se borran y los pagos no son eventos. No son el modelo: allí todo es un evento (ADR-005). Las reglas de término y sabor de la carta (`CON_TERMINO`, `CON_SABOR`) deben pasar a la configuración del catálogo.

**Cómo verlo en tu celular y tu tablet:**

1. En la terminal, compila la app y arranca el hub:

```bash
pnpm --filter @pos/app build && pnpm --filter @pos/hub start
```

   Debes ver `Hub en marcha` y una dirección como `http://192.168…:4000`.
2. En el celular, conectado al mismo Wi-Fi, abre esa dirección agregando `/bocetos`. Debes ver **Bocetos del POS** con seis tarjetas.
3. Prueba el flujo del mesero: **Plano de mesas** → toca una mesa libre → toca un producto → **Enviar**. Debes volver al plano con la mesa en «En preparación».
4. Abre **Cocina y barra**, toca **Todo listo** en esa mesa y vuelve al plano: la mesa debe decir «Listo para servir».
5. En la tablet, abre **Precuenta y división** → **Partes iguales** → **Cobrar** en la cuenta 1 → **Cobrar** → **Confirmar**. Debes volver a la precuenta con «Ya pagado».
6. Toca el ícono de la luna arriba a la derecha: todo debe pasar a modo oscuro y quedarse así al recargar.

### 0.8 — Seed con la carta de La Spritzzería ✅

Comando `pnpm seed` (código en `apps/hub/src/seed`). Lee [la carta](datos/carta-la-spritzzeria.yaml) y carga en la base del hub:
- el restaurante «La Spritzzería» (sede Envigado), con la configuración del piloto (esquema `ConfigRestaurante` en `packages/core/src/config.ts`);
- un salón con **25 mesas** en cuadrícula: es provisional, el plano real se dibuja con el editor (Fase 1);
- las estaciones **Cocina** y **Barra**: la comida va a cocina y las bebidas a barra;
- el impuesto **INC 8 %**, **(validar)** con el contador;
- **15 categorías y 98 productos** (los 100 platos de la carta). Según ADR-011:
  - copa y botella del Ramón Bilbao son un solo producto con dos opciones;
  - el sabor del Té Hatsu y de la Soda Hatsu es obligatorio y sin costo;
  - la hamburguesa y la Tagliata llevan el término de la carne;
- **personal de ejemplo**: Gerente, Caja, Mesero 1 a 3, Cocina y Barra, cada uno con su PIN. Son cuentas para el piloto: el restaurante pone luego los nombres reales. `pnpm seed --sin-personal` no las crea.

**Reglas al volver a correrlo:**
- da siempre el mismo resultado: cada registro tiene un identificador estable y lo que ya está igual no se toca;
- solo cambia lo que cambió en la carta;
- lo que ya no está en la carta, o quedó «no disponible», se archiva (nunca se borra);
- lo que cambió una persona (con el futuro editor) se respeta;
- el impuesto se crea una sola vez: si el contador lo cambia, el seed no lo devuelve;
- cada persona conserva su PIN; quien se archive no vuelve;
- todo va en una sola transacción: si algo falla o se corta, no queda nada a medias.

Revisado por `revisor-codigo`, `qa-pruebas` (unas 50 pruebas: repetir el seed, varios hubs, cambios en la carta, procesos cortados a mitad y un pedido real con lo sembrado) y `auditor-dinero` (ningún precio se pierde ni cambia; sin decimales). Corregido, entre otros:
- los PIN se podían perder si la carga fallaba a mitad;
- un plato renombrado o quitado de la carta quedaba activo y duplicado;
- un plato «no disponible» se cargaba como vendible;
- volver a correr el seed devolvía el impuesto al 8 % aunque se hubiera cambiado;
- un sabor repetido en la carta hacía que cada corrida cambiara la base;
- la configuración aceptaba una propina sugerida por encima del 10 % (tope legal, **(validar)** con el contador) y un desglose fiscal que aún no existe.

**Queda para otras tareas:**
- `CatalogoCambiado` en cada cambio del catálogo, antes de validar precios copiados (`precio_distinto`, Fase 1);
- que el hub exija elegir la variante en un producto con copa y botella (Fase 1, ver [DINERO.md](DINERO.md#precio-copiado));
- los modificadores reales con precio (quitar ingredientes, adicionales), que el restaurante enviará antes de la Fase 1;
- el plano real del salón y los nombres reales del personal.

**Cómo probarlo a mano:**

1. Cierra el hub si está abierto (Ctrl+C en su ventana). El seed necesita la base solo para él.
2. Carga los datos:

```bash
pnpm seed
```

   Debes ver `Datos de La Spritzzería cargados en …`, una línea por tabla (por ejemplo `producto  98 nuevos, 0 cambiados, 0 iguales`) y, al final, `PIN nuevos:` con un PIN de 4 dígitos para cada persona. Anótalos.

3. Vuelve a correr el mismo comando. Ahora todas las líneas deben decir `0 nuevos, 0 cambiados` y al final `No se creó personal nuevo: cada quien conserva su PIN.`
4. Si quieres probarlo sin tocar tu hub, usa una carpeta aparte: `DIR_DATOS=/tmp/hub-piloto pnpm seed`.

### 0.7 — Autenticación con PIN, roles y permisos ✅

Según [ADR-008](DECISIONES.md#adr-008--inicio-de-sesión-solo-con-pin-generado-por-el-sistema) y [SYNC.md](SYNC.md#seguridad):
- **Permisos y roles** (`packages/core/src/acceso`): las 24 claves de permiso, los 6 roles de fábrica con la matriz de [MODELO_DATOS.md](MODELO_DATOS.md#permisos) y qué permiso pide cada tipo de evento. Pagos y cierres solo desde un dispositivo de caja.
- **Acceso en el hub** (`apps/hub/src/acceso`):
  - PIN de **4 dígitos** (decisión del dueño) generados al azar, únicos entre usuarios activos, guardados solo como HMAC con la clave del hub.
  - Emparejar un equipo con un código de un solo uso (5 minutos), aprobado con el PIN del administrador desde la caja.
  - Sesión con PIN; espera creciente tras errores (hasta 60 s) y aviso al administrador.
  - Comprobante de supervisor para un evento exacto.
  - Revocar un equipo.
  - API HTTP: `/api/emparejamientos`, `/api/emparejar`, `/api/sesiones`, `/api/sesiones/cerrar`, `/api/autorizaciones` y `/api/dispositivos/:id/revocar`.
- **En cada evento**, el hub de sincronización comprueba la sesión, la firma del evento, el permiso del rol al recibirlo (o el comprobante) y el tipo de equipo.
- **Al instalar**, el hub crea el restaurante, los roles y el usuario «Administrador», y muestra su PIN una sola vez.

Criterios cumplidos, con pruebas que recorren el hub completo: un dispositivo revocado es rechazado (no lee el salón y lo nuevo que envía no entra); un mesero no puede anular sin autorización; cada autorización deja registro de quién la dio (`autorizado_por_id` en el evento y el comprobante usado).

Revisado por `revisor-codigo` y `qa-pruebas` (unas 140 pruebas nuevas: la matriz completa de roles por evento, carreras de comprobantes, fuerza bruta, reinicios del hub y entradas raras a la API). Corregido, entre otros:
- **Grave:** un empleado podía alternar su propio PIN con PIN ajenos para que la espera nunca empezara y probar los diez mil PIN en minutos. Ahora un acierto no borra los fallos.
- Desde cualquier equipo de la red, cambiando de IP, se podía probar el PIN del administrador para emparejar. Ahora solo desde la caja.
- Un comprobante de supervisor servía para otro contenido del mismo evento (otro ítem, otro valor de descuento). Ahora está atado a la huella del evento exacto.
- En un celular compartido, alguien podía crear eventos a nombre del mesero anterior con su sesión ya cerrada. Ahora cada evento va firmado.
- Un mesero podía abaratar un ítem ya enviado cambiando sus modificadores. Ahora eso pide autorización.
- El trabajo hecho sin conexión antes de que archivaran a un usuario se perdía. Ahora va a cuarentena.
- El PIN del administrador podía quedar escrito en un archivo de log. Ahora, si no hay ventana, va a un archivo aparte para borrar.

Agrega la migración 2 (comprobante atado al contenido) y la dependencia `@noble/hashes` (SHA-256 en JavaScript puro, porque por HTTP el navegador no ofrece el suyo).

**Queda para otras tareas:**
- pantallas de PIN, emparejamiento con QR y administración de usuarios (0.9 y 0.10; mientras tanto, los usuarios se crean desde el código y el seed de la 0.8);
- conectar la API y la firma de eventos en la app, y la sala de sincronización por WebSocket en el hub (0.10);
- auditoría como eventos `AccionAuditada` y aviso de intentos en la pantalla de caja (Fase 1).

**Cómo probarlo a mano:**

1. Corre las pruebas:

```bash
pnpm --filter @pos/hub test
```

   Debes ver `Tests 206 passed` en verde.

2. Para ver el arranque de un hub recién instalado sin tocar los datos del tuyo (por ejemplo, los resultados de los celulares de la tarea 0.1), detén el hub si está abierto y arranca uno con una carpeta de datos aparte:

```bash
DIR_DATOS=/tmp/hub-nuevo pnpm --filter @pos/hub start
```

   En la ventana debes ver `PIN del administrador: ` seguido de 4 dígitos, y `Hub en marcha`.

3. Detén ese hub con Ctrl+C y repite el mismo comando. Esta vez **no** debe aparecer el PIN: se muestra una sola vez.

### 0.6 — Motor de sincronización ✅

Paquete `packages/sync`, según [SYNC.md](SYNC.md):
- **Hub** (`HubSync`): valida, detecta duplicados por id y contenido, aplica el evento a los pedidos que toca, decide rechazo, conflicto o aceptación según si el dispositivo estaba al día, numera, calcula el día operativo y guarda, un evento por transacción. `SalaSync` atiende las conexiones y difunde lo aceptado. Almacén en memoria y sobre SQLite (`@pos/sync/sqlite`).
- **Dispositivo** (`ClienteSync`): guarda cada evento como pendiente, envía lotes de 100 (uno a la vez), aplica lo confirmado, avanza el cursor solo de forma contigua (pide lo que falte ante un hueco), rechaza en cascada lo que dependía de un rechazo y, si el hub se restauró, reenvía todo.
- **Conexión** (`GestorConexion`): reconecta al instante al volver a la pantalla, abandona intentos colgados a los 4 s, descarta canales mudos (3 s tras volver, 15 s sin latidos) y reintenta con espera de 1 a 5 s.

Escenarios probados con red simulada (el hub sobre SQLite real): pedidos sin conexión en dos dispositivos, ítems al mismo pedido, misma mesa (un solo conflicto, también al reenviar), respuesta perdida, hub caído a mitad de un lote y antes de responder, reloj desfasado 5 horas, rechazo en cascada, hueco en lo recibido, hub restaurado de un respaldo, dispositivo con datos borrados, 150 eventos pendientes y dispositivo revocado (cuarentena). Además: casos borde del protocolo (mensajes fuera de orden, `traer` de varias páginas, cortes con un lote en vuelo) y una prueba de propiedades que genera cientos de historias al azar con cortes, pérdidas, duplicados y caídas del hub, y exige que al final todos vean lo mismo y nada se pierda.

Revisado por `revisor-codigo` y `qa-pruebas`; corregido, entre otros:
- al reenviar a un hub restaurado de un respaldo, el hub tomaba como distintos los eventos que el respaldo ya tenía y **se perdía un ítem**;
- un evento rechazado que se reenviaba dos veces, o uno malformado sin id, hacía fallar al hub a mitad del lote;
- un evento enorme o muy anidado podía agotar la memoria del hub;
- al cortarse y volver la conexión muy rápido, el dispositivo podía quedar con un lote que nunca se respondía;
- el dispositivo no corregía su reloj con la hora del hub;
- un dispositivo revocado seguía recibiendo los pedidos del salón;
- los eventos del mismo dispositivo contaban como "no conocidos", lo que convertía en conflicto errores que debían rechazarse.

**Queda para otras tareas:** sesiones, tokens y revocación reales (0.7); WebSocket real en el hub con límite de tamaño, almacén IndexedDB con índices y prueba Playwright con dos navegadores (0.10); foto inicial, conflictos como eventos, pedido de rescate, `afecta`, bloqueo de mesas, filtros por tipo de dispositivo y proyecciones guardadas en la base para que el hub arranque rápido con años de datos (Fase 1). Ver el detalle en [SYNC.md](SYNC.md).

**Cómo probarlo a mano:** ejecuta `pnpm --filter @pos/sync test`. Debes ver todas las pruebas en verde.

### 0.5 — Núcleo de dominio: dinero y eventos del pedido ✅

En `packages/core`, el mismo código para celular, hub y nube:
- **Dinero** (`src/dinero/`): redondeo, reparto por mayor residuo, línea, descuentos, desglose fiscal, propina sobre la base, redondeo del efectivo y efectivo esperado de caja, tal como los define [DINERO.md](DINERO.md).
- **Eventos del pedido** (`src/eventos/`): los 31 tipos de la versión 1 con su esquema Zod; `validarEventoNuevo` devuelve los errores en español y nunca lanza.
- **Reductor** (`src/pedido/`): `aplicarEvento` aplica cada evento al estado del pedido y devuelve un `problema` cuando no puede (por ejemplo `saldo_negativo` o `pedido_dividido`); `totalesPedido` calcula bruto, anulado, descuentos, neto, pagado y saldo.

Pruebas: los ejemplos de DINERO.md, cada regla del reductor y pruebas de propiedades (miles de casos al azar) que exigen que las partes sumen el total, que ninguna línea quede negativa y que con cualquier secuencia de eventos el reductor no falle, sea determinista y nunca deje saldo negativo. La prueba de propiedades encontró un error real (quitar un ítem sin enviar en un pedido ya pagado dejaba saldo negativo), ya corregido. Cobertura exigida: 90 % (actual: 98,8 %).

Revisado por `revisor-codigo`, `qa-pruebas` y `auditor-dinero`; corregido, entre otros: un ajuste de redondeo sin límite que permitía cerrar un pedido sin cobrar, anular un pago ya reembolsado (se devolvía dos veces), unir pedidos perdiendo descuentos, copias de ítems movidos que no coincidían con el original, eventos aplicados dos veces y acciones de cocina bloqueadas con la mesa ya pagada. Los esquemas ahora son estrictos (un campo de más se rechaza).

**Queda para la Fase 1** (con caja y turnos): diferencia de arqueo por medio, efectivo esperado de otros medios, fondo de propinas con saldo entre días e informes cruzados (por medio = por mesero = documentos DIAN).

**Cómo probarlo a mano:** ejecuta `pnpm --filter @pos/core test`. Debes ver todas las pruebas en verde y la tabla de cobertura sin el mensaje `ERROR: Coverage`.

### 0.4 — Base de datos y migraciones ✅

Paquete `packages/db`: migración inicial con las tablas de la Fase 0 de [MODELO_DATOS.md](MODELO_DATOS.md), sobre el SQLite incluido en Node ([ADR-012](DECISIONES.md#adr-012--base-del-hub-sqlite-incluido-en-node-tablas-estrictas-y-migraciones-en-código)). El hub abre la base y aplica las migraciones al arrancar.

Lo que hace cumplir la propia base:
- montos y tarifas enteros y dentro de rango (un decimal o un negativo se rechazan);
- eventos que no se pueden editar ni borrar;
- un PIN único entre usuarios activos;
- claves foráneas activas.

- el catálogo no se borra (se archiva) y archivar un usuario libera su PIN;
- un `INSERT OR REPLACE` tampoco puede reescribir eventos, y la secuencia es contigua;
- un solo hub por carpeta de datos (apertura exclusiva).

Las pruebas además exigen que toda tabla esté clasificada en una categoría y que las de catálogo tengan las columnas comunes. Incluyen un proceso que muere a mitad de una transacción: al reabrir no queda nada a medias.

**Queda para la 0.6:** la cola de salida y el cursor viven en IndexedDB del dispositivo (no en esta base); la unicidad del número de pedido del día se aplica al asignarlo.

**Cómo probarlo a mano:**

1. Ejecuta `pnpm --filter @pos/db test`. Debes ver todas las pruebas en verde.
2. Inicia el hub (`pnpm --filter @pos/app build && pnpm --filter @pos/hub start`). La primera vez debe decir `Base de datos actualizada a la versión 1.`; las siguientes, `Base de datos en la versión 1.`
3. La base queda en `apps/hub/datos/pos.sqlite`.

### 0.3 — Documentos vivos ✅

- [DECISIONES.md](DECISIONES.md): ADR-001 a ADR-011, con alternativas descartadas y lo que queda **(validar)** con el contador o el proveedor DIAN.
- [MODELO_DATOS.md](MODELO_DATOS.md): entidades por fase, tipos (todo entero), una sola tabla de eventos, catálogo de eventos v1, matriz de permisos por rol y configuración del restaurante.
- [SYNC.md](SYNC.md): protocolo dispositivo ↔ hub (modo normal conectado, sin conexión como respaldo), rechazos, cuarentena y conflictos, seguridad de sesiones y PIN, fallas, y 14 escenarios de aceptación para la 0.6.
- [DINERO.md](DINERO.md): fórmulas exactas de descuentos, desglose fiscal, propina, división, pagos, efectivo, caja y fondo de propinas, con la lista de pruebas para la 0.5.

Revisado dos veces por `revisor-codigo` y `auditor-dinero`; sus hallazgos están incorporados.

**Decisiones del dueño en esta tarea:** propina sugerida sobre la base sin INC; propinas en un fondo común; efectivo redondeado a $100; propinas de tarjeta pagadas desde caja o acumuladas según el día; sin conexión es solo un respaldo.

**Pendiente de validar con el contador y el proveedor DIAN** (no bloquea la Fase 0): ver "Pendiente de validar" en ADR-004.

**Cómo revisarlo:** abre los cuatro documentos en GitHub (cuando el repositorio esté subido) o en el editor; los diagramas se ven en GitHub.

### 0.2 — Monorepo, herramientas y CI ✅

Monorepo pnpm + Turborepo con `apps/pos`, `apps/hub` y `packages/core`; Biome, TypeScript estricto, Vitest, Playwright y GitHub Actions (`.github/workflows/ci.yml`).

**Cómo probarlo a mano:**

1. En la carpeta del proyecto, ejecuta `pnpm install` y luego `pnpm check`. Debes ver `Tasks: 6 successful, 6 total` al final.
2. Ejecuta `pnpm test:e2e`. Debes ver `62 passed` y `2 skipped`.
3. Ejecuta `pnpm --filter @pos/app build && pnpm --filter @pos/hub start`. Debes ver `Hub en marcha` y una o más direcciones `http://192.168…:4000`.
4. Abre esa dirección en el navegador del computador. Debes ver "POS" y el indicador verde **✓ Conectado al hub**.
5. Detén el hub con `Ctrl+C`. En unos 3 segundos el indicador cambia a rojo **✕ Sin conexión con el hub**.

Las pruebas e2e compilan la app en `.e2e/app` y guardan datos en `.e2e/datos`, para no tocar un hub de desarrollo que esté sirviendo a celulares reales.

El CI de GitHub corre cuando el repositorio se suba a GitHub (pendiente: se verificará en la primera corrida).
