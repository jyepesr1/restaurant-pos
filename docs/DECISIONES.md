# Decisiones de arquitectura

Cada decisión dice qué se decidió, por qué, qué alternativas se descartaron y qué evidencia la respalda. Las decisiones que dependen del contador o de un proveedor quedan marcadas **(validar)**.

---

## ADR-001 · Los dispositivos abren la app por la IP del hub, con HTTP y sin instalar nada

**Fecha:** 23-oct-2026 · **Estado:** aceptada · **Tarea:** Fase 0.1

### Decisión

- Meseros, caja y KDS abren la app en el navegador con la dirección del hub en la red local (`http://<IP del hub>:4000`). No se instala nada en los dispositivos.
- El primer acceso es con un QR que muestra la caja; después, un acceso directo en la pantalla de inicio.
- Condiciones en cada restaurante: **IP fija del hub** (reserva en el router) y **Wi-Fi solo para el personal**, porque con HTTP el tráfico va sin cifrar.
- La caja corre en el mismo PC del hub (`localhost`), que el navegador sí considera seguro.

### Por qué

El dueño pidió explícitamente que nadie tenga que instalar nada y que sea rápido de usar. La app del navegador por IP cumple con eso y la prueba en celulares reales confirmó que lo esencial funciona.

### Alternativas descartadas

| Alternativa | Por qué no |
|---|---|
| App nativa (Capacitor) | Exige instalar en cada equipo. Queda como opción futura solo si el piloto la pide (avisos con el celular bloqueado). |
| HTTPS con certificado real + DNS local | Exige configurar el DNS del router en cada restaurante; sin internet el nombre no resuelve. |
| Opción de Chrome "tratar origen como seguro" | Solo Chrome, equipo por equipo; no sirve para producción. |

### Evidencia (prueba del 23-oct-2026, hub en el Mac, mismo Wi-Fi)

Herramienta: pantalla **Diagnóstico del dispositivo** (`/diagnostico`).

| | Android Mesero 1 (Chrome 155) | iPhone Caja (Safari 27.0.1) |
|---|---|---|
| Abre por IP y funciona | ✅ | ✅ |
| Datos locales (IndexedDB) | ✅ | ✅ |
| Tiempo de respuesta | 27 ms típico, 430 ms máx. | 11–17 ms |
| Vibración | ✅ | ✕ (Safari no la permite) |
| Notificaciones, pantalla encendida, instalar | ✕ (esperado por HTTP) | ✕ (esperado por HTTP) |
| Almacenamiento persistente (`navigator.storage.persist`) | ✕ (requiere HTTPS) | ✕ (requiere HTTPS) |
| Conexión con la página oculta (pantalla bloqueada, según quien probó) | **Se corta ~5 s después de ocultarse**, siempre (5 de 5: 4,8–5,2 s); al volver llega además otro cierre | Se corta; Safari avisa el cierre **al volver** |
| Página descartada por el navegador | No, ni tras 12 min bloqueado | No, ni tras 17 min bloqueado |
| Reconexión al volver | 2–4 s con la versión vieja (un caso de 30 s); **la versión corregida no se ha probado en Android** | 24 ms; 1,4 s cuando el cierre llegó justo después de volver |
| Reloj del equipo frente al hub | **~59 s atrasado** (¹) | No medido |

(¹) No está en el archivo de resultados: sale de comparar la hora en que el hub registró la carga de la página (registro del hub) con la hora del evento «carga» según el celular. La herramienta todavía no mide el desfase sola.

Notas sobre la prueba:
- Las versiones salen del navegador: el user agent de Chrome siempre dice «Android 10» y el de Safari congela la versión de iOS, así que no son la versión real del sistema.
- La herramienta registra que la página se ocultó, no si fue por bloquear la pantalla o por cambiar de app; según quien probó, fue bloqueando la pantalla.
- El Android usó la primera versión de la herramienta (no se recargó la página); el iPhone, una versión intermedia. El comportamiento de los navegadores medido es válido; los tiempos de reconexión del Android son anteriores a la corrección.
- Las pruebas automáticas recompilaban la app en la misma carpeta que servía el hub; ya usan su propia carpeta (`.e2e/`).

### Consecuencias para el diseño

1. **La conexión se pierde cada vez que se bloquea la pantalla**, en Android y en iPhone. La app no puede depender de estar conectada en segundo plano: al volver a la pantalla debe reconectar **de inmediato** (también si el cierre llega justo después de volver) y ponerse al día desde su último número de evento. Objetivo: menos de 1 s (cumplido en iPhone; falta confirmarlo en Android).
2. **Nunca ordenar por el reloj del dispositivo.** El orden de los eventos lo da el número de secuencia del hub; la hora del dispositivo es solo informativa.
3. **El navegador no descartó la página** en bloqueos largos, así que el estado en memoria suele sobrevivir; igual todo se persiste en IndexedDB antes de mostrarse como hecho.
4. **Los datos locales no son permanentes.** Sin HTTPS no se puede pedir almacenamiento persistente, así que el navegador puede borrar IndexedDB si le falta espacio, y Safari borra los datos de sitios que no se abren en varios días. Por eso **el hub es la fuente de verdad** y el celular solo guarda una copia de trabajo: cada evento se muestra como hecho al guardarse en el celular, pero se sigue reenviando al hub hasta que este lo confirme, y el celular avisa si tiene eventos sin confirmar.
5. **Sin avisos con el celular bloqueado** (sin notificaciones del sistema por HTTP). El aviso de "pedido listo" funciona solo con la app abierta; en iPhone, sin vibración.
6. **Sin service worker** (requiere HTTPS): si el hub está caído y el usuario cierra la app o el navegador la descarta, no vuelve a abrir hasta que el hub responda. Se acepta: lo normal es estar conectado al hub, y el modo sin conexión es solo un respaldo para caídas de la red (aclaración del dueño).
7. **Pendiente:** confirmar en Android la reconexión de menos de 1 s con la versión corregida, y repetir con el hub en el PC de caja (Windows 11) cuando exista el instalador del hub (Fase 1); la prueba con el hub en el Mac ya valida la parte del navegador.

---

## ADR-002 · Monorepo TypeScript con la lógica de negocio compartida

**Fecha:** 23-oct-2026 · **Estado:** aceptada · **Tarea:** Fase 0.2

### Decisión

- Un solo repositorio con pnpm workspaces y Turborepo. TypeScript estricto en todo (Node 24 LTS, TypeScript 7).
- `apps/pos` (app del navegador para meseros, caja y KDS), `apps/hub` (servidor local), `packages/core` (lógica de negocio pura, sin dependencias de navegador ni de Node).
- Los paquetes se crean en la tarea que los necesita (`ui`, `sync`, `db`, `printing`, `dian`, `payments`, `apps/cloud`), no antes.
- Herramientas: Biome (lint y formato), Vitest (unitarias), Playwright (de punta a punta, perfiles celular Android y caja), GitHub Actions.

### Por qué

La misma función que aplica un evento al estado de un pedido debe correr idéntica en el celular (para mostrarlo al instante), en el hub (autoridad) y en la nube (reportes). Un solo lenguaje y un solo paquete `core` lo garantizan.

### Alternativas descartadas

| Alternativa | Por qué no |
|---|---|
| Hub en Go o Rust | Un binario más robusto, pero duplica la lógica de negocio en dos lenguajes. |
| Nx | Más pesado que Turborepo para este tamaño. |
| ESLint + Prettier | Dos herramientas y más lentas; Biome hace ambas cosas. |

---

## ADR-003 · El hub es un servicio de Windows en el PC de caja

**Fecha:** 23-oct-2026 · **Estado:** aceptada · **Tarea:** Fase 0 (instalador en Fase 1)

### Decisión

- El hub es un proceso Node (Fastify + WebSocket + SQLite) instalado como **servicio de Windows** en el PC de caja del restaurante (Windows 11 en el piloto). Arranca con el equipo y no depende de ninguna ventana abierta.
- La caja usa la misma app en Chrome o Edge en modo aplicación sobre `localhost`.
- El cajón monedero se abre con un comando ESC/POS a la impresora; las impresoras USB se usan por la cola de Windows en modo RAW.
- Requisitos del equipo: sin suspensión, Windows Update fuera del horario de servicio y, **recomendado antes del piloto, una UPS** para el PC de caja, el router y las impresoras (hoy no hay).

### Por qué

Si el hub cae, el salón se detiene (no imprimen comandas ni llega nada al KDS). Un servicio sobrevive a que cierren la ventana y arranca solo.

### Alternativas descartadas

| Alternativa | Por qué no |
|---|---|
| Electron | Si el cajero cierra la ventana, se cae el salón. Se revisa solo si un periférico lo exige. |
| Tauri | Su backend es Rust; correr Node exige un proceso aparte, sin beneficio. |
| Mini-PC dedicado | Más robusto, pero el dueño eligió usar el PC de caja actual. |

### Riesgo abierto

Un corte de luz sin UPS apaga todo el salón. SQLite en modo WAL protege la base, pero no la operación.

---

## ADR-004 · Dinero en pesos enteros; decimales solo dentro del cálculo fiscal

**Fecha:** 23-oct-2026 · **Estado:** aceptada · **(validar)** con contador y proveedor DIAN

### Decisión

- **Todo monto operativo es un entero de pesos**: precios, totales, descuentos en valor, pagos, propinas, base de caja, arqueos y reportes. Nunca `number` con fracciones.
- **Porcentajes en puntos básicos enteros** (1 % = 100; 8 % = 800): tarifas de impuesto, descuentos y propina sugerida.
- **Repartos por mayor residuo**: al dividir una cuenta, un ítem compartido o prorratear un descuento, las partes suman exactamente el total ($100.000 ÷ 3 = 33.334 + 33.333 + 33.333).
- Los precios de carta **incluyen el impuesto** (INC en el piloto, confirmado en la carta de La Spritzzería).
- El desglose fiscal (base gravable e impuesto, que la DIAN pide con 2 decimales) se calcula **solo al generar el documento electrónico**, con enteros escalados en **centésimas de peso**, y no cambia lo que paga el cliente.
- Tarifas, reglas de redondeo y qué entra en la base son configurables, nunca cableadas. La propina va fuera de la base gravable.

### Por qué

El peso colombiano no usa centavos en la operación; los flotantes generan descuadres. El desglose de un precio con impuesto incluido sí produce fracciones, así que se aísla en el módulo fiscal.

### Alternativas descartadas

| Alternativa | Por qué no |
|---|---|
| Centavos en todo el sistema | Nadie ve ni cobra centavos; complica toda la operación por un cálculo que solo necesita el documento DIAN. |
| `number` con decimales o librería decimal en todo | Riesgo de flotantes y de redondeos inconsistentes entre pantallas y reportes. |

### Reglas de cálculo

Las fórmulas exactas, con ejemplos y la lista de pruebas de la tarea 0.5, están en [DINERO.md](DINERO.md). Resumen:

| Tema | Regla |
|---|---|
| Desglose fiscal | En centésimas, por línea neta: `base = redondeo(neto × 100 × 10000 / (10000 + tarifa))`, `impuesto = neto × 100 − base`. El impuesto del ítem se copia al venderlo. |
| Descuentos | En pesos con impuesto incluido, fijados al aplicarse; el del pedido se reparte por mayor residuo sobre el neto de las líneas; ninguna línea queda negativa. |
| División | Montos fijos en el evento, calculados sobre el saldo; lo agregado después va a "sin asignar". |
| Propina sugerida | 10 % sobre la base sin INC, neta de descuentos, con un solo redondeo (decisión del dueño). Va a un fondo común. |
| Efectivo | El pago que deja el saldo en 0 se redondea a $100 (al más cercano; la mitad a favor del cliente); la diferencia queda en `ajuste_redondeo` (decisión del dueño). |
| Redondeo | A la mitad hacia arriba, configurable. Todo con enteros y `BigInt`, un solo redondeo por cálculo. |

### Pendiente de validar

Con el contador y el proveedor DIAN: granularidad del desglose (línea o documento); si el impuesto calculado como diferencia (que a veces difiere en 1 centésima de base × tarifa) es aceptado; trato fiscal de cortesías y descuentos al pedido; cómo va un ítem compartido (1/3 de botella) en el documento; si la propina aparece en el documento y su tope legal; cómo se informa el redondeo del efectivo.

---

## ADR-005 · Los pedidos son eventos que solo se agregan; nada se borra

**Fecha:** 23-oct-2026 · **Estado:** aceptada

### Decisión

- Todo cambio de un pedido (abrir, agregar, enviar a cocina, anular, mover, descontar, cobrar, cerrar, reabrir) es un **evento** que se agrega a la tabla `Evento` y nunca se edita ni se borra.
- El estado actual del pedido, sus ítems, cuentas y pagos es una **proyección**: se calcula aplicando los eventos en orden con una función pura de `packages/core`, y se puede reconstruir en cualquier momento.
- Cada evento lleva usuario, dispositivo, hora del dispositivo y, si aplica, quién lo autorizó y el motivo. Así la auditoría sale sola.
- Las entidades transaccionales (pagos, movimientos de caja e inventario, documentos fiscales) tampoco se borran: se anulan con otro registro.
- El catálogo y la configuración no se borran: se archivan (`activo = false`).
- Los eventos tienen versión de esquema; cuando un esquema cambie se agrega una conversión de la versión vieja a la nueva, nunca se reescriben eventos guardados.

### Por qué

Cumple a la vez la trazabilidad total del brief, la sincronización sin pérdida (dos dispositivos pueden agregar eventos al mismo pedido sin pisarse) y reportes que siempre cuadran (todos salen de los mismos eventos).

### Alternativas descartadas

| Alternativa | Por qué no |
|---|---|
| Tablas editables + bitácora aparte | La bitácora y el estado pueden divergir; sincronizar ediciones concurrentes obliga a elegir un ganador y perder cambios. |
| CRDT (Yjs, Automerge) | Resuelven texto colaborativo, no reglas de dinero (no se puede "fusionar" un pago duplicado). |

---

## ADR-006 · IDs ULID del dispositivo; el orden lo da la secuencia del hub

**Fecha:** 23-oct-2026 · **Estado:** aceptada · **Evidencia:** ADR-001 (reloj del Android ~59 s atrasado)

### Decisión

- Todo registro sincronizable tiene un ID **ULID** generado en el dispositivo que lo crea (`packages/core`, forma canónica en mayúsculas). Funciona sin conexión y sin colisiones.
- El **hub asigna un número de secuencia** a cada evento que acepta, consecutivo por restaurante. Ese número es el orden oficial.
- La hora del dispositivo nunca ordena. La hora oficial de recepción es la del hub (`recibido_en`); para el día operativo de un evento que llega tarde se usa la hora del dispositivo corregida con el desfase que conoce el hub, acotada a una ventana de 12 h ([SYNC.md](SYNC.md#sobre-del-evento)).
- Los números visibles para las personas (número de comanda, de pedido del día) los asigna el hub al aceptar el evento y viajan en sus `asignaciones`. Un dispositivo sin hub muestra un número provisional (`P` + iniciales del dispositivo + contador local, p. ej. `P-AM1-3`) que se reemplaza al confirmar.
- **Los consecutivos DIAN solo los asigna la caja dueña de la resolución**, nunca un celular.

### Alternativas descartadas

| Alternativa | Por qué no |
|---|---|
| UUID v4 | Sin componente de tiempo: peores índices y depuración. (El ULID tampoco ordena entre dispositivos; para eso está la secuencia del hub.) |
| UUID v7 | Equivalente a ULID; ULID ya estaba en el brief y se lee mejor. |
| Ordenar por hora del dispositivo | Los relojes de los celulares no son confiables (medido). |

---

## ADR-007 · Sincronización propia, con el mismo protocolo en dos niveles

**Fecha:** 23-oct-2026 · **Estado:** aceptada · **Detalle:** [SYNC.md](SYNC.md)

### Decisión

- Mismo mecanismo entre **dispositivo ↔ hub** (Fase 0) y **hub ↔ nube** (Fase 2): cola local de salida, envío idempotente por ID, secuencia asignada por quien recibe y lectura de lo nuevo desde el último número conocido.
- El hub es la autoridad del salón y funciona sin nube.
- Conflictos: los eventos que no se contradicen se conservan todos; los que no se pueden fusionar solos no se descartan, se **marcan para que los resuelva una persona** en caja.

### Alternativas descartadas

| Alternativa | Por qué no |
|---|---|
| PowerSync, ElectricSQL, Zero, Replicache | Suponen un servidor central en la nube; aquí la autoridad es el hub local y debe operar sin internet. |
| CRDT | Ver ADR-005. |

---

## ADR-008 · Inicio de sesión solo con PIN generado por el sistema

**Fecha:** 23-oct-2026 · **Estado:** aceptada

### Decisión

- El usuario entra **solo con su PIN** de **4 dígitos** (decisión del dueño del 24-oct-2026: un toque menos; se le ofrecieron 6). Con diez mil combinaciones, lo que protege es que **solo un dispositivo emparejado puede probar PIN**, la espera creciente y el aviso al administrador; los PIN triviales (`0000`, `1234`, `9876`) no se generan.
- Como el PIN identifica a la persona, debe ser único en el restaurante. Para que un PIN repetido no delate el de otro, **el sistema genera los PIN al azar**; el administrador no los escoge.
- El PIN se verifica **en el hub**, que abre una sesión. El hub guarda solo una huella del PIN con clave secreta (HMAC-SHA256), en tablas que **solo existen en el hub** y nunca se sincronizan. Con un millón de combinaciones, un hash lento no protege a quien tenga la base y la clave; lo que protege es que la clave no salga del hub y que el respaldo se cifre.
- La clave HMAC vive en la carpeta de datos del hub y va dentro del respaldo (que se protege como dato sensible); sin ella, restaurar el hub obliga a regenerar todos los PIN.
- Unicidad entre usuarios activos; al desactivar un usuario su PIN se libera. El administrador regenera el PIN de quien lo olvide.
- Espera creciente tras intentos fallidos **por dispositivo** (dos errores sin espera; luego 2, 4, 8… s hasta 60 s), también para el PIN de supervisor; para aprobar un emparejamiento, por IP. Por restaurante no se bloquea, para que un celular no deje sin acceso a todo el local: con 20 fallos en 10 minutos se avisa al administrador. La auditoría guarda conteos, nunca el PIN escrito.
- Un PIN que no existe y uno que existe pero no tiene el permiso dan **la misma respuesta**: así nadie descubre que un PIN es de alguien del restaurante.
- El hub **no confía** en el usuario, dispositivo ni restaurante que diga el evento: los compara con la sesión y el token, y si no cuadran rechaza el evento.
- Cada dispositivo se empareja con un QR de un solo uso (vence en 5 min, aprobado con PIN de administrador) y recibe un **token propio y revocable**.
- Autorización de supervisor en el momento: el gerente escribe su PIN en el dispositivo del mesero sin cerrarle la sesión; el hub emite un **comprobante de un solo uso** para ese evento exacto (su huella SHA-256) y esa sesión, y el evento lo lleva. El supervisor debe tener el permiso y no puede autorizarse a sí mismo.
- Cada evento va firmado (HMAC) con un secreto de sesión que el hub deriva de su clave: nadie crea eventos a nombre de otro con un `sesion_id` viejo. Las operaciones con hash corren en JavaScript puro (`@noble/hashes`) porque por HTTP el navegador no ofrece `crypto.subtle`.
- Aprobar un emparejamiento se hace desde un equipo ya emparejado (la caja); solo el primero de un hub nuevo se aprueba sin token.
- Sin conexión con el hub no hay inicio de sesión nuevo ni autorizaciones: el dispositivo conserva la sesión abierta y las acciones que piden supervisor esperan a que vuelva la red.
- Riesgo aceptado: con HTTP (ADR-001) el PIN viaja sin cifrar por el Wi-Fi; por eso debe ser una red solo del personal.
- Al instalar, el hub crea el usuario «Administrador» y muestra su PIN **una sola vez** en la ventana del hub. Si la salida no es una ventana (servicio de Windows con log a archivo), lo deja en `pin-administrador.txt` en la carpeta de datos, solo legible por el hub, para leerlo y borrarlo.
- Riesgo conocido: si alguien reemplaza el archivo de la clave por otra clave válida, el hub no lo detecta; ningún PIN funciona y hay que regenerarlos como si se hubiera perdido.

**Implementación (tarea 0.7):** permisos y roles de fábrica en `packages/core/src/acceso`; emparejamiento, PIN, sesiones, comprobantes y revocación en `apps/hub/src/acceso` (API HTTP del hub); el hub de sincronización los consulta en cada evento a través de `ControlAcceso`.

Detalle del protocolo en [SYNC.md](SYNC.md#seguridad).

### Alternativas descartadas

| Alternativa | Por qué no |
|---|---|
| Tocar el nombre o la foto y luego el PIN | Más seguro y permite PIN repetidos; el dueño prefirió un toque menos. |
| Verificar el PIN en el celular | Un PIN de 6 dígitos (un millón de combinaciones) se adivina en minutos si su hash está en el teléfono. |
| PIN de 6 dígitos | Cien veces más difícil de adivinar; el dueño prefirió 4 por rapidez. Se puede revisar si el piloto muestra intentos sospechosos. |

---

## ADR-009 · Nube en Cloudflare (desde la Fase 2)

**Fecha:** 23-oct-2026 · **Estado:** aceptada (se implementa en la Fase 2)

### Decisión

- La nube corre en **Cloudflare Workers** con un **Durable Object con SQLite por restaurante**: el mismo dialecto SQL que el hub, WebSocket para dashboards en vivo, y webhooks (Bold) y tareas programadas incluidos.
- La nube recibe los eventos del hub con el protocolo de ADR-007.

### Alternativas descartadas

| Alternativa | Por qué no |
|---|---|
| Postgres administrado + API Node | Estándar y portable, pero otro dialecto SQL distinto al del hub; el dueño eligió Cloudflare. |

### Riesgo abierto

Más amarre a un proveedor. Los reportes comparativos entre sedes (Fase 5) necesitarán otra capa de datos.

---

## ADR-010 · Idioma: dominio en español, técnica en inglés

**Fecha:** 23-oct-2026 · **Estado:** aceptada

- Entidades, eventos y reglas de negocio en español (`Pedido`, `Comanda`, `ItemAnulado`, `aplicarEvento`).
- Infraestructura y utilidades técnicas en inglés (`useSyncStatus`, `retryWithBackoff`) cuando no hay un término de negocio.
- Interfaz, documentación y mensajes de commit en español.

---

## ADR-011 · Reglas de operación acordadas para el piloto

**Fecha:** 23-oct-2026 · **Estado:** aceptada

Reglas de negocio confirmadas por el dueño; todas quedan configurables por restaurante.

Dos de ellas cambian lo que dice el brief:
- §4.5 pedía registrar la propina "por mesero": ahora va a un **fondo común**.
- §2 pide cobrar en efectivo "sin internet", y eso se mantiene, porque el hub funciona sin internet. Lo que no se puede es cobrar **sin el hub**, que corre en el mismo PC de la caja.

| Regla | Cómo queda |
|---|---|
| Quién cierra mesas | **Solo el cajero** (permiso `cerrar_mesa`). |
| Quién registra pagos | **Solo el cajero**, en efectivo y con datáfono. El mesero lleva el efectivo o el voucher a caja de inmediato. Los meseros no manejan saldo propio. |
| Bloqueo de mesa por mesero | Opcional por restaurante. La mesa queda asignada a quien la abrió; los demás meseros la ven sin poder modificarla. **Reasignan el cajero y el gerente.** Toda reasignación queda auditada. |
| Día operativo | Configurable; por defecto de 6:00 a. m. a 5:59 a. m. (una venta a la 1 a. m. cuenta para el día anterior). El piloto a veces cierra pasada la medianoche. |
| Propinas | Se suman en un **fondo común** del día; el equipo decide cómo repartirlas (también van para cocina y caja). Las de tarjeta se pueden pagar en efectivo desde la caja (queda como salida) o acumular, según el día. |
| Propina sugerida | 10 % sobre la base sin INC. |
| Redondeo del efectivo | A $100, con el ajuste registrado. |
| Ventas por mesero (reportes) | A quien agregó cada ítem, aunque la mesa se reasigne después (valor por defecto; configurable). |
| Modo normal | Conectado al hub por la red local. Sin conexión es solo un respaldo: se toman pedidos, pero no se cobra, no se autoriza ni se edita el catálogo hasta que vuelva la red. |
| Estaciones del piloto | Cocina y barra. |
| Productos con opciones | Un solo producto con opciones (Ramón Bilbao copa o botella con su precio; Té Hatsu con sabor obligatorio sin costo). |
| Modificadores | Término de la carne, quitar ingredientes, adicionales con precio y notas libres. La lista real con precios se pide antes de la Fase 1. |

---

## ADR-012 · Base del hub: SQLite incluido en Node, tablas estrictas y migraciones en código

**Fecha:** 24-oct-2026 · **Estado:** aceptada · **Tarea:** Fase 0.4

### Decisión

- El hub usa **`node:sqlite`**, el SQLite que trae Node 24 (versión 3.50), detrás de una interfaz mínima (`BaseSqlite` en `packages/db`). Lo cumple también `better-sqlite3`, así que cambiar de motor es un cambio de un archivo.
- **Todas las tablas son `STRICT`**: SQLite rechaza un número con decimales en una columna `INTEGER`. Junto con los `CHECK` de rango (precio entre 0 y $100.000.000, tarifa entre 0 y 10.000 puntos básicos, cantidad de 1 a 999), la regla de los pesos enteros (ADR-004) también la hace cumplir la base.
- **Las tablas de eventos no se pueden editar, borrar ni reemplazar**: disparadores abortan `UPDATE`, `DELETE` e `INSERT OR REPLACE` (este último no dispara los de borrado en SQLite), y la secuencia de eventos debe ser contigua (ADR-005).
- **El catálogo no se borra**: las tablas versionadas rechazan `DELETE`; se archiva con `activo = 0`. Archivar un usuario libera su PIN.
- Restricciones de coherencia fiscal: un impuesto `exento` no puede tener tarifa.
- **Migraciones en TypeScript con el SQL en texto**, numeradas y aplicadas al arrancar el hub, cada una en su transacción. El runner guarda la huella de cada migración y se niega a arrancar si una ya aplicada cambió. Una base más nueva que la aplicación no se abre. Las migraciones que reconstruyen tablas apagan las claves foráneas y verifican las referencias antes de confirmar.
- Configuración de la base: modo WAL (verificado al abrir), `synchronous = FULL` (sin UPS, no perder la última transacción confirmada), claves foráneas activas. El hub la abre **en exclusiva**: un segundo hub sobre la misma carpeta de datos no arranca. Una sola conexión por proceso, porque `node:sqlite` es síncrono. El costo de `FULL` (una escritura a disco por evento) se mide en la 0.6.
- La base vive en la carpeta de datos del hub (`pos.sqlite`).
- Las consultas se escriben en SQL con funciones tipadas en cada paquete; un generador de consultas (Kysely o Drizzle) se reconsidera si en la 0.6 el SQL a mano se vuelve repetitivo.

### Por qué

`node:sqlite` no necesita compilar un módulo nativo, lo que simplifica el instalador para Windows (Fase 1). El mismo SQL sirve en la nube (Durable Objects usa SQLite, ADR-009).

### Alternativas descartadas

| Alternativa | Por qué no |
|---|---|
| `better-sqlite3` | Maduro y rápido, pero es un módulo nativo que hay que compilar o distribuir por plataforma. Queda como plan B detrás de la misma interfaz. |
| Archivos `.sql` para las migraciones | No funcionan donde no hay sistema de archivos (la nube). |
| ORM (Prisma) | Pesado para el hub y oculta el SQL que queremos controlar. |

### Riesgo abierto

`node:sqlite` todavía figura como experimental en Node 24: su API podría cambiar. Lo mitiga la interfaz `BaseSqlite` y las pruebas del esquema.
