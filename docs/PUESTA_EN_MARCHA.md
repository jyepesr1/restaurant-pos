# Puesta en marcha de un restaurante

Pasos para dejar Faro funcionando en el local, en orden, con lo que se debe ver en pantalla. Recoge lo que hoy está repartido en las secciones «Cómo probarlo» del [ROADMAP](ROADMAP.md).

**Para quién es hoy:** el piloto, **La Spritzzería**. El PC de caja es un Windows con el **instalador de Faro** (tarea 1.13): Faro corre como un servicio de Windows, arranca solo al prender el PC y no depende de ninguna ventana abierta.

**Lo que no cubre todavía:**
- **Otro restaurante:** solo La Spritzzería tiene sus datos listos. Un restaurante nuevo se instala con «Empezar de cero» y su carta y su plano se arman a mano en la caja; cargarlos de un archivo necesita una tarea propia.
- **Restaurar el PC de caja desde la nube** si se daña: tarea 1.12.
- **Editar la carta desde el panel:** tarea 1.11b. Hoy se edita en la caja.

## Qué se necesita

- **El PC de caja:** Windows 10 u 11 de 64 bits, prendido todo el servicio.
- **El instalador de Faro:** un archivo como `Faro-PC-de-caja-0.11.exe`, que te doy yo (por ejemplo en una memoria USB).
- **El router del local,** con un **Wi-Fi solo para el personal**. La app viaja sin cifrar dentro del local ([ADR-001](DECISIONES.md#adr-001--los-dispositivos-abren-la-app-por-la-ip-del-hub-con-http-y-sin-instalar-nada)), así que los clientes no deben estar en esa red.
- **Las impresoras** (Jaltech de 80 mm), conectadas por cable de red al router: una para cocina y otra para barra. La de precuentas puede ser una de esas o una tercera.
- **Los celulares de los meseros:** Android con Chrome o iPhone con Safari. No se instala nada.
- **Un gestor de contraseñas** para guardar:
  - la contraseña del administrador;
  - el **token de administración de Faro**: solo lo usa el dueño, para crear el restaurante en la nube y pedir códigos.

## 1. Instalar Faro en el PC de caja (una sola vez)

**Si ya tenías Faro funcionando en otro computador** (el Mac del piloto), primero trae sus datos, para no configurar todo otra vez:

1. En ese computador, cierra Faro: **Ctrl+C** en su ventana. Debe volver a aparecer la línea de comandos.
2. Copia la carpeta `restaurant-pos/apps/hub/data` completa a una memoria USB.
3. **No vuelvas a abrir Faro en ese computador.** Desde ahora la caja es el PC de Windows, con la misma conexión a la nube; dos cajas con los mismos datos se pisan.

Después, en el PC de caja:

1. Copia el instalador al escritorio y ábrelo con doble clic.
2. Windows dice **«Windows protegió su PC»**: toca **Más información** y luego **Ejecutar de todas formas**. Sale porque el instalador aún no tiene firma digital; es normal.
3. Windows pregunta **«¿Quieres permitir que esta aplicación haga cambios en el dispositivo?»**: toca **Sí**.
4. En **«Faro 0.11 para el PC de caja»**, toca **Siguiente**.
5. En **«Datos del restaurante»**:
   - si trajiste los datos: elige **«Traer los datos de otro PC de caja»**, toca **Buscar…**, elige la carpeta `data` de la memoria USB y toca **Siguiente**;
   - si es un restaurante nuevo: deja **«Empezar de cero»** y toca **Siguiente**.
6. En los componentes, deja todo marcado y toca **Instalar**:
   - **Que el PC no se duerma:** si el PC se duerme, los celulares pierden la caja y la cocina deja de imprimir;
   - **Abrir Faro al iniciar sesión:** la caja aparece sola al entrar a Windows.
7. Espera la barra. Al terminar:
   - **con «Empezar de cero»**, sale un mensaje con el **Usuario**, la **Contraseña** y el **PIN para autorizar** del administrador. Guárdalos en tu gestor de contraseñas (puedes copiar el mensaje con **Ctrl+C**) y toca **Aceptar**: no se vuelven a mostrar;
   - **con los datos traídos**, el administrador sigue con su contraseña de siempre.
8. Toca **Finalizar** con «Abrir Faro» marcado. Faro se abre en su propia ventana, sin barra de direcciones. Debes ver la pantalla de entrar a Faro, con usuario y contraseña o con PIN.

En el escritorio queda el ícono **Faro**, y en el menú Inicio la carpeta **Faro**, con **Nueva contraseña del administrador** y **Registros de Faro**.

## 2. Preparar la red del local (una sola vez)

1. **Dale una IP fija al PC de caja.** Entra a la configuración del router y busca «Reserva de DHCP» o «IP fija». Asígnale una IP al PC de caja, por ejemplo `192.168.1.20`. Si la IP cambia, los celulares dejan de encontrar la caja.
2. **Revisa la red de cada impresora.**
   1. Apágala.
   2. Mantén presionado el botón de avance de papel (FEED) y préndela sin soltarlo.
   3. Suéltalo cuando empiece a imprimir. Debes ver una hoja con **IP Address**, por ejemplo `192.168.1.87`. Anótala.
3. Compara: los tres primeros números de cada impresora deben coincidir con los del PC de caja (`192.168.1`). Si no coinciden, hay que cambiar la IP de la impresora con el programa de Jaltech: pídeme esos pasos aparte.

## 3. La dirección para los celulares

El servicio de Faro no tiene ventana propia: la dirección para los celulares sale dentro de Faro. En Faro, como administrador: **Personal y roles → Equipos**. Debes ver **«Para conectar un celular»** con una dirección como `http://192.168.1.20:4000`. Si sale más de una, usa la que empieza igual que la de las impresoras (paso 2).

Si cambia, revisa la reserva de IP del paso 2.

## 4. Si prendes, apagas o reinicias el PC

Faro arranca solo con Windows, aunque nadie inicie sesión: los celulares se conectan apenas el PC termina de prender. Cerrar la ventana de Faro en la caja **no** apaga Faro: el salón sigue funcionando y se vuelve a abrir con el ícono **Faro** del escritorio.

## 5. Configurar Faro en la caja

En el PC de caja abre Faro (el ícono **Faro** del escritorio) y entra con el usuario y la contraseña del administrador. Debes ver el salón y el menú a la izquierda.

Con los datos traídos del Mac, todo lo de este paso ya está hecho: solo revísalo. Lo nuevo es la impresora USB de la caja y el cajón monedero (pasos 9 y 10).

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
7. Toca **Imprimir prueba**. Debe salir una hoja «PRUEBA DE IMPRESIÓN», con la regla de números en una sola línea y las tildes y eñes bien. Si salen símbolos raros, toca **Editar**, elige **Con tildes de Windows**, guarda y prueba otra vez.
8. Repite los pasos 6 y 7 con la de barra («Barra», estación **Barra**). En **Si no responde, imprimir en**, elige la otra como respaldo.
9. **La impresora USB de la caja** (precuentas y cierre de caja). Primero instala su driver en Windows, con el programa de Jaltech, y revisa que aparezca en **Configuración → Bluetooth y dispositivos → Impresoras y escáneres**. Después, en Faro:
   1. **Cocina e impresoras → Agregar impresora.** Escribe «Caja» y no marques ninguna estación.
   2. En **Conexión**, toca **USB**. Debe salir la lista **«Impresora en Windows»**: toca la de la caja.
   3. Toca **Guardar** y luego **Imprimir prueba**. Debe salir la hoja «PRUEBA DE IMPRESIÓN».

   Si no aparece en la lista, instala el driver y toca **Buscar de nuevo**.

   Si la impresora está apagada o sin cable, Windows guarda lo que se mandó y lo imprime al volver: no pasa a la de respaldo.

### Caja y pagos

10. **Caja y pagos:**
   - **Medios de pago:** marca los que salen al cobrar (el efectivo siempre está). En **Medios propios** se agregan otros con su nombre: Sodexo, QR Bancolombia, Rappi…;
   - **Propina sugerida:** el porcentaje que sale en la precuenta, sobre la base sin impuestos. Es voluntaria: quien cobra la quita o la cambia;
   - **Justificar desde:** la diferencia de caja a partir de la cual se pide escribir por qué;
   - **Impresora de precuentas:** elige la de la caja (paso 9). Ahí también sale el cierre de caja;
   - **Cajón monedero:** elige **«Conectado a Caja»** y toca **Probar el cajón**: debe abrirse. Desde ahí se abre solo al cobrar o devolver en efectivo y al registrar una entrada o salida de caja; con tarjeta, no;
   - **Datáfonos:** agrega cada uno (por ejemplo Bold), para cuadrarlo al cerrar la caja.
11. **Marca del restaurante** (opcional): elige **La Spritzzería** para ver su marca en todos los equipos, o deja la de Faro. Los colores de estado (verde libre, ámbar en proceso, rojo demora) no cambian.

## 6. Conectar los celulares

1. Conecta el celular al **Wi-Fi del personal**.
2. Abre la dirección del paso 3, por ejemplo `http://192.168.1.20:4000`. Debes ver el teclado del PIN.
3. El mesero escribe su PIN. Debe ver el salón.
4. **Primera vez en un celular nuevo (opcional):** abre la misma dirección agregando `/diagnostics` y sigue los pasos de la pantalla. Revisa que la conexión con la caja aguante al bloquear la pantalla.

Quien cobra desde un celular o tablet toca «Caja, administración o reportes: entrar con usuario y contraseña». Ese equipo queda como caja y aparece en **Personal y roles → Equipos**, donde se puede retirar.

## 7. Conectar el PC de caja a la nube (una sola vez)

Con los datos traídos del Mac, este paso ya está hecho: la barra de la caja debe decir **«Nube al día»**. Para un PC nuevo:

Así cada venta queda guardada también en la nube y se ve desde el panel del dueño. En una terminal del computador donde tienes el proyecto (`nvm use 24` primero):

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
1. Prende el PC de caja. Faro arranca solo.
2. Si marcaste «Abrir Faro al iniciar sesión», la ventana de Faro se abre sola al entrar a Windows. Si no, abre el ícono **Faro** del escritorio.
3. Abre la caja con la base de efectivo.

**Al cerrar:** cierra la caja (sale el cierre impreso). Si la barra no dice «Nube al día», deja el PC prendido unos minutos más con internet para que termine de subir. Después puedes apagar el PC.

**Cuando haya una versión nueva de Faro:** te doy el instalador nuevo. Después del cierre de caja:
1. Ábrelo en el PC de caja, igual que la primera vez (pasos 1 a 3 de la sección 1).
2. Toca **Siguiente** e **Instalar**. No pregunta por los datos: los conserva. Faro se detiene unos segundos y vuelve a arrancar.
3. **Recarga Faro en cada equipo** (la caja, cada celular y cada tablet, también la pantalla de cocina): desliza hacia abajo en el celular, o pulsa **F5** en el PC. Así cada equipo toma la versión nueva. Uno que no se recargue puede sumar mal la caja: por ejemplo, contar un pago que el PC de caja no aplicó y no dejar cerrar la caja.

   Debes ver la pantalla de Faro como siempre. Si un equipo muestra el botón «Recargar la app», tócalo.

## Si algo falla

| Lo que pasa | Qué hacer |
|---|---|
| Se olvidó la contraseña del administrador | En el PC de caja, después del cierre: menú Inicio → **Faro → Nueva contraseña del administrador**; en la ventana de Windows que pide permiso, toca **Sí**. Faro se detiene unos segundos y la ventana muestra la contraseña nueva una sola vez (`Password: …`): guárdala y pulsa una tecla para cerrar |
| Un celular no abre la caja | Revisa que esté en el Wi-Fi del personal y que la dirección sea la del paso 3. Si la IP del PC cambió, falta la reserva del paso 2 |
| Ningún equipo abre Faro, ni la caja | En el PC de caja, menú Inicio → escribe **Servicios** → busca **Faro (PC de caja)**. Debe decir «En ejecución»; si no, clic derecho → **Iniciar**. Si no arranca, reinicia el PC y, si sigue igual, mándame los archivos de menú Inicio → **Faro → Registros de Faro** |
| Al instalar sale «Windows protegió su PC» | Es porque el instalador no tiene firma digital. Toca **Más información → Ejecutar de todas formas** |
| Al instalar dice «Faro quedó instalado pero no responde todavía» | Reinicia el PC. Si sigue igual, mándame los archivos de menú Inicio → **Faro → Registros de Faro** |
| Al instalar dice «No apareció la contraseña del administrador» | Cuando Faro funcione, menú Inicio → **Faro → Nueva contraseña del administrador** |
| La impresora USB no sale en la lista | Instala su driver en Windows y revisa que aparezca en **Configuración → Bluetooth y dispositivos → Impresoras y escáneres**. Luego, en Faro, toca **Buscar de nuevo** |
| Sale en ámbar «Windows ya no muestra…» | La impresora guardada ya no está en Windows (se desinstaló o cambió de nombre). Revisa el cable y el driver, o elige otra de la lista |
| «Probar el cajón» no lo abre | Revisa el cable del cajón al puerto de atrás de la impresora y que la impresora esté encendida. Si la impresora está apagada, el cajón no se abre después: hay que abrirlo con la llave |
| En **Equipos** no sale «Para conectar un celular» o dice «No pudimos leer la dirección» | Toca **Intentar de nuevo**. Si sigue, la dirección es la IP fija del paso 2 con `:4000` al final |
| Arriba sale en rojo «Barra no imprime» (o Cocina) | Revisa el cable de red y que la impresora tenga papel. Al volver, la comanda sale sola; mientras tanto va a la de respaldo |
| La barra dice «N cambios por subir · sin internet» | No es urgente: el salón sigue normal y los cambios suben solos al volver el internet |
| La barra dice en rojo «La nube no acepta esta caja» | El PC de caja fue desconectado de la nube. Pide un código nuevo (paso 7.2) y conéctalo otra vez: sube todo sin duplicar |
| La barra dice en rojo «N cambios sin subir · avisa a Faro» | La nube rechazó un cambio. Todo sigue guardado en el PC. Avisa a Faro |
| El panel dice «Usuario o contraseña incorrectos» | Revisa el usuario de la caja y que su rol tenga «Entrar desde fuera del local». Tras varios intentos fallidos pide esperar unos segundos |
| El panel dice «Sin noticias del restaurante» | El PC de caja está apagado o el local no tiene internet |
| Un equipo muestra en rojo «No se aplicó…» con «Entendido» | Otro equipo ya había cerrado esa cuenta. Haz lo que dice el aviso con el dinero (por ejemplo, si ya recibiste ese pago, devuélvelo al cliente) y toca «Entendido»; si hay varios, sale el siguiente («1 de 3»). Al cerrar la caja sale en «Movimientos no aplicados» y hay que escribir qué pasó |
| Al cerrar la caja dice «Esperando a que el PC de caja confirme N movimientos» | El equipo de caja tiene pagos o movimientos que el PC de caja aún no recibió. Revisa que esté conectado al Wi-Fi y que el PC de caja esté encendido; en cuanto los confirme, sigue el cierre. Si a los 20 segundos sigue igual, dice «Todavía no confirma»: mira el contador «sin confirmar» arriba y, si no baja, avisa al dueño |

## Pendiente para esta guía

- **Contacto de Faro** (WhatsApp o teléfono) para pedir códigos y para «avisa a Faro»: falta definirlo **(validar con el dueño)**.
- **Planes de pago antes de clientes reales:** Workers Paid (USD 5 al mes; la cuenta ya lo tiene desde el 2-nov-2026), porque el panel usa más CPU de la que permite el plan gratuito y necesita Durable Objects para el aviso en vivo; y Neon Launch, con 7 días para restaurar.
- **Firma digital del instalador:** antes de vender a otros restaurantes, para que Windows no muestre «Windows protegió su PC».
- **Actualizar sin el archivo:** hoy cada versión nueva es un instalador que hay que llevar al PC; que se actualice solo desde la nube queda para después.
