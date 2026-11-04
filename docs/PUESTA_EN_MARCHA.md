# Puesta en marcha de un restaurante

Pasos para dejar Faro funcionando en el local, en orden, con lo que se debe ver en pantalla. Recoge lo que hoy está repartido en las secciones «Cómo probarlo» del [ROADMAP](ROADMAP.md).

**Para quién es hoy:** el piloto, **La Spritzzería**. El PC de caja corre el proyecto desde una terminal, porque el instalador para Windows llega con la tarea 1.13. Cuando exista, esta guía se reescribe para él.

**Lo que no cubre todavía:**
- **Otro restaurante:** solo La Spritzzería tiene sus datos listos (`pnpm seed`). Un restaurante nuevo, con su carta y su plano desde cero, necesita una tarea propia.
- **Restaurar el PC de caja desde la nube** si se daña: tarea 1.12.
- **Editar la carta desde el panel:** tarea 1.11b. Hoy se edita en la caja.

## Qué se necesita

- **El PC de caja:** queda prendido todo el servicio. Hoy es un computador con el proyecto (probado en Mac).
- **El router del local,** con un **Wi-Fi solo para el personal**. La app viaja sin cifrar dentro del local ([ADR-001](DECISIONES.md#adr-001--los-dispositivos-abren-la-app-por-la-ip-del-hub-con-http-y-sin-instalar-nada)), así que los clientes no deben estar en esa red.
- **Las impresoras** (Jaltech de 80 mm), conectadas por cable de red al router: una para cocina y otra para barra. La de precuentas puede ser una de esas o una tercera.
- **Los celulares de los meseros:** Android con Chrome o iPhone con Safari. No se instala nada.
- **Un gestor de contraseñas** para guardar:
  - la contraseña del administrador;
  - el **token de administración de Faro**: solo lo usa el dueño, para crear el restaurante en la nube y pedir códigos.

## 1. Preparar el PC de caja (una sola vez)

1. Instala **nvm** siguiendo https://github.com/nvm-sh/nvm#installing-and-updating. Cierra la terminal y abre otra. Escribe `nvm --version`: debes ver un número como `0.40.1`.
2. Descarga el proyecto y entra a su carpeta:

```bash
git clone git@github.com:jyepesr1/restaurant-pos.git
```

```bash
cd restaurant-pos
```

3. Instala Node 24 y actívalo:

```bash
nvm install 24
```

   Debes ver `Now using node v24…`.
4. Activa pnpm. No muestra nada; es normal:

```bash
corepack enable pnpm
```

5. Instala las dependencias:

```bash
pnpm install
```

   Debes ver al final `Done in …`.
6. **Que el PC no se duerma.** En la configuración de energía, apaga el reposo automático mientras está conectado a la corriente. Si el PC se duerme, el salón pierde la conexión.

## 2. Preparar la red del local (una sola vez)

1. **Dale una IP fija al PC de caja.** Entra a la configuración del router y busca «Reserva de DHCP» o «IP fija». Asígnale una IP al PC de caja, por ejemplo `192.168.1.20`. Si la IP cambia, los celulares dejan de encontrar la caja.
2. **Revisa la red de cada impresora.**
   1. Apágala.
   2. Mantén presionado el botón de avance de papel (FEED) y préndela sin soltarlo.
   3. Suéltalo cuando empiece a imprimir. Debes ver una hoja con **IP Address**, por ejemplo `192.168.1.87`. Anótala.
3. Compara: los tres primeros números de cada impresora deben coincidir con los del PC de caja (`192.168.1`). Si no coinciden, hay que cambiar la IP de la impresora con el programa de Jaltech: pídeme esos pasos aparte.

## 3. Cargar la carta, el salón y el personal de La Spritzzería

En una terminal, en la carpeta del proyecto, escribe primero `nvm use 24`. Con el PC de caja cerrado (si estaba abierto, **Ctrl+C** en su ventana):

```bash
pnpm seed
```

Debes ver:
- **la primera vez**, «New PINs and passwords» con el usuario y la contraseña del **Administrador**. Guárdalos en tu gestor de contraseñas: no se vuelven a mostrar;
- `Loaded La Spritzzería's data into …`;
- una línea por tabla, por ejemplo `products  98 new, 0 changed, 0 unchanged`;
- al final, el usuario y la contraseña de **Caja** y de **Reportes**, y el PIN de **Mesero 1, 2 y 3**. Son **cuentas de ejemplo** para probar: en el paso 5 se reemplazan por la gente real.

Los PIN y contraseñas también quedan en un archivo `pins-….txt`, en la carpeta de datos (`apps/hub/data`). El mensaje dice dónde: cuando los hayas guardado, **borra ese archivo**.

Se puede repetir sin duplicar nada. La segunda vez, las líneas dicen `0 new, 0 changed`, lo editado a mano se respeta y al final dice «No new staff was created: everyone keeps their PIN».

## 4. Prender el PC de caja

```bash
pnpm --filter @pos/app build && pnpm --filter @pos/hub start
```

Debes ver:
- `Database at version 1.`;
- `Hub running`;
- la dirección para los celulares, por ejemplo `http://192.168.1.20:4000`.

Si el administrador aún no tenía contraseña, aquí aparece «Admin (to sign in at the register)» con su usuario y contraseña. Guárdalos igual que en el paso 3. Si se pierden, ver «Si algo falla».

Esta ventana debe quedar abierta: cerrarla apaga Faro en el local.

## 5. Configurar Faro en la caja

En el PC de caja abre `http://localhost:4000` y entra con el usuario y la contraseña del administrador. Debes ver el salón y el menú a la izquierda.

### Personal y roles

1. **Personal y roles → Personas → Persona nueva**, una por cada persona real:
   - los **meseros**, con el rol Mesero y «Con su PIN». Al guardar sale su PIN en grande: dáselo a esa persona y toca **Ya lo anoté**;
   - quien **cobra**, con el rol Cajero y «Con usuario y contraseña», con una contraseña de al menos 8 caracteres.
2. Archiva las cuentas de ejemplo (**Caja**, **Reportes**, **Mesero 1, 2 y 3**): ábrela y toca **Archivar**.
3. En **Roles → Administrador**, revisa que esté marcado **«Entrar desde fuera del local»**. Es lo que deja entrar al panel del dueño (paso 8). Se lo puedes dar también a otro rol, por ejemplo a un gerente o al contador.

### El salón y la carta

4. **Plano del salón:** revisa que las zonas y las mesas sean las del local. Para mover una mesa, toca **Editar plano**, arrástrala y toca **Guardar**.
5. **Carta:** revisa precios y productos. La carta trae el **INC del 8 %**: **validar con el contador** antes de cobrar de verdad.

### Las impresoras

6. **Cocina e impresoras → Agregar impresora.**
   1. Escribe «Cocina» y toca la estación **Cocina**.
   2. Deja «Cable de red» y escribe la IP que anotaste en el paso 2.
   3. Deja el puerto 9100 y 80 mm.
   4. Toca **Guardar**. Debe salir en la lista con «Lista».
7. Toca **Prueba**. Debe salir una hoja «PRUEBA DE IMPRESIÓN», con la regla de números en una sola línea y las tildes y eñes bien. Si salen símbolos raros, toca **Editar**, elige **Windows (1252)**, guarda y prueba otra vez.
8. Repite los pasos 6 y 7 con la de barra («Barra», estación **Barra**). En **Si no responde, imprimir en**, elige la otra como respaldo.

### Caja y pagos

9. **Caja y pagos:**
   - **Medios de pago:** marca los que salen al cobrar (el efectivo siempre está). En **Medios propios** se agregan otros con su nombre: Sodexo, QR Bancolombia, Rappi…;
   - **Propina sugerida:** el porcentaje que sale en la precuenta, sobre la base sin impuestos. Es voluntaria: quien cobra la quita o la cambia;
   - **Justificar desde:** la diferencia de caja a partir de la cual se pide escribir por qué;
   - **Impresora de precuentas:** elige una. Ahí también sale el cierre de caja;
   - **Datáfonos:** agrega cada uno (por ejemplo Bold), para cuadrarlo al cerrar la caja.
10. **Marca del restaurante** (opcional): elige **La Spritzzería** para ver su marca en todos los equipos, o deja la de Faro. Los colores de estado (verde libre, ámbar en proceso, rojo demora) no cambian.

## 6. Conectar los celulares

1. Conecta el celular al **Wi-Fi del personal**.
2. Abre la dirección del paso 4, por ejemplo `http://192.168.1.20:4000`. Debes ver el teclado del PIN.
3. El mesero escribe su PIN. Debe ver el salón.
4. **Primera vez en un celular nuevo (opcional):** abre la misma dirección agregando `/diagnostics` y sigue los pasos de la pantalla. Revisa que la conexión con la caja aguante al bloquear la pantalla.

Quien cobra desde un celular o tablet toca «Caja, administración o reportes: entrar con usuario y contraseña». Ese equipo queda como caja y aparece en **Personal y roles → Equipos**, donde se puede retirar.

## 7. Conectar el PC de caja a la nube (una sola vez)

Así cada venta queda guardada también en la nube y se ve desde el panel del dueño. En otra terminal, en la carpeta del proyecto (`nvm use 24` primero):

1. **Crea el restaurante en la nube.** Para La Spritzzería ya está hecho; repetirlo no hace daño:

```bash
CLOUD_URL=https://faro-api.johanyepes.workers.dev pnpm --filter @pos/cloud admin restaurant
```

   Pega el token de administración (no se ve al pegarlo) y presiona Enter. Debes ver «was already in the cloud» (o «Done: "La Spritzzería" was created in the cloud»).
2. **Pide un código para el PC de caja:**

```bash
CLOUD_URL=https://faro-api.johanyepes.workers.dev pnpm --filter @pos/cloud admin code
```

   Pega otra vez el token. Debes ver un código como `K7PM-QX2R-9DHT` y hasta cuándo sirve (24 horas). Sirve para un solo PC.
3. En la caja, como administrador: **Copia en la nube**. Escribe el código y toca **Conectar a la nube**. Debes ver «El PC de caja quedó conectado a la nube» y, en segundos, **«Nube al día»** en la barra de arriba.

Desde ahí la caja sube cada cambio sola. Sin internet, el salón sigue igual: la barra dice «N cambios por subir · sin internet», en gris, y los sube al volver.

## 8. Entrar al panel del dueño

1. En tu celular, con datos móviles o cualquier internet, abre:

```
https://faro-api.johanyepes.workers.dev/r/la-spritzzeria
```

   Debes ver **«Tu restaurante desde cualquier lugar»**, con el restaurante ya escrito.
2. Escribe el usuario y la contraseña del administrador (los mismos de la caja) y toca **Entrar**. Debes ver **Hoy**, con las ventas del día comparadas con el mismo día de la semana pasada a esta hora.
3. En **Reportes** están los mismos informes de la caja, de hasta 14 días.

El panel se actualiza solo, en segundos, cuando algo cambia en el local (Salón, Cocina, Caja y Alertas). Si el local lleva más de 2 minutos sin enviar datos, dice «Sin noticias del restaurante desde las…».

## 9. Prueba antes del primer servicio

Hazla con una mesa de prueba, de principio a fin:

1. En la caja, entra con un usuario que cobre y abre la caja en **Caja**, con la base de efectivo.
2. Desde un celular, abre una mesa, pide un plato y una bebida, y toca **Enviar**. La comanda del plato debe salir en la cocina y la de la bebida en la barra.
3. En la caja, cobra la mesa. Debe salir la precuenta si la pides, y la mesa debe quedar libre.
4. En tu celular, en el panel, las ventas de **Hoy** deben subir en menos de 20 s.
5. En la caja, toca **Cerrar la caja**, cuenta el efectivo y cierra. Debe salir el papel **«CIERRE DE CAJA»**.
6. **Prueba sin internet:** desconecta el internet del router (no el Wi-Fi). Toma otro pedido: la comanda debe salir igual y la barra debe decir «1 cambio por subir · sin internet». Vuelve a conectar: en menos de 30 s debe decir «Nube al día».

## Cada día

**Al abrir:**
1. Prende el PC de caja y abre una terminal en la carpeta del proyecto.
2. Escribe `nvm use 24`.
3. Prende Faro:

```bash
pnpm --filter @pos/hub start
```

   Debes ver `Hub running`.
4. Abre la caja con la base de efectivo.

**Al cerrar:** cierra la caja (sale el cierre impreso). Después puedes cerrar Faro con **Ctrl+C**. Si la barra no dice «Nube al día», déjalo prendido unos minutos más con internet para que termine de subir.

**Cuando haya una versión nueva de Faro**, con Faro cerrado:
1. `git pull`
2. `pnpm install`
3. Prende Faro con el comando del paso 4, el que compila (`pnpm --filter @pos/app build && pnpm --filter @pos/hub start`).
4. **Recarga Faro en cada equipo** (la caja, cada celular y cada tablet, también la pantalla de cocina): abre el navegador donde está Faro y desliza hacia abajo en el celular, o pulsa **F5** en el PC. Así cada equipo toma la versión nueva. Uno que no se recargue puede sumar mal la caja: por ejemplo, contar un pago que el PC de caja no aplicó y no dejar cerrar la caja.

   Debes ver la pantalla de Faro como siempre. Si un equipo muestra el botón «Recargar la app», tócalo.

## Si algo falla

| Lo que pasa | Qué hacer |
|---|---|
| Se olvidó la contraseña del administrador | Con Faro cerrado, `pnpm reset-admin`. Muestra una contraseña nueva una sola vez: guárdala |
| Un celular no abre la caja | Revisa que esté en el Wi-Fi del personal y que la dirección sea la del paso 4. Si la IP del PC cambió, falta la reserva del paso 2 |
| Arriba sale en rojo «Barra no imprime» (o Cocina) | Revisa el cable de red y que la impresora tenga papel. Al volver, la comanda sale sola; mientras tanto va a la de respaldo |
| La barra dice «N cambios por subir · sin internet» | No es urgente: el salón sigue normal y los cambios suben solos al volver el internet |
| La barra dice en rojo «La nube no acepta esta caja» | El PC de caja fue desconectado de la nube. Pide un código nuevo (paso 7.2) y conéctalo otra vez: sube todo sin duplicar |
| La barra dice en rojo «N cambios sin subir · avisa a Faro» | La nube rechazó un cambio. Todo sigue guardado en el PC. Avisa a Faro |
| El panel dice «Usuario o contraseña incorrectos» | Revisa el usuario de la caja y que su rol tenga «Entrar desde fuera del local». Tras varios intentos fallidos pide esperar unos segundos |
| El panel dice «Sin noticias del restaurante» | El PC de caja está apagado, Faro está cerrado o el local no tiene internet |
| Un equipo muestra en rojo «No se aplicó…» con «Entendido» | Otro equipo ya había cerrado esa cuenta. Haz lo que dice el aviso con el dinero (por ejemplo, si ya recibiste ese pago, devuélvelo al cliente) y toca «Entendido»; si hay varios, sale el siguiente («1 de 3»). Al cerrar la caja sale en «Movimientos no aplicados» y hay que escribir qué pasó |
| Al cerrar la caja dice «Esperando a que el PC de caja confirme N movimientos» | El equipo de caja tiene pagos o movimientos que el PC de caja aún no recibió. Revisa que esté conectado al Wi-Fi y que el PC de caja esté encendido; en cuanto los confirme, sigue el cierre. Si a los 20 segundos sigue igual, dice «Todavía no confirma»: mira el contador «sin confirmar» arriba y, si no baja, avisa al dueño |

## Pendiente para esta guía

- **Contacto de Faro** (WhatsApp o teléfono) para pedir códigos y para «avisa a Faro»: falta definirlo **(validar con el dueño)**.
- **Planes de pago antes de clientes reales:** Workers Paid (USD 5 al mes; la cuenta ya lo tiene desde el 2-nov-2026), porque el panel usa más CPU de la que permite el plan gratuito y necesita Durable Objects para el aviso en vivo; y Neon Launch, con 7 días para restaurar.
- **Instalador para Windows** (1.13): reemplaza los pasos 1 y 4 y el «Cada día».
