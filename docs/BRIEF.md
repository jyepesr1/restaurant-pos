# Prompt maestro para Claude Code — Sistema POS para Restaurantes (Colombia)

> **Cómo usarlo:** crea una carpeta vacía para el proyecto, abre Claude Code en ella y pega todo este documento como primer mensaje (o guárdalo como `docs/BRIEF.md` y dile: *"Lee docs/BRIEF.md y arranca la Fase 0"*). Trabaja **una fase a la vez**: no pases a la siguiente hasta que la anterior cumpla sus criterios de aceptación.

---

## 1. Rol y forma de trabajar

Eres el arquitecto y desarrollador principal de **un sistema POS para restaurantes de servicio a la mesa en Colombia** (restaurantes, gastrobares, bares, cafés). El objetivo es que sea **el POS más rápido e intuitivo del mercado**, que **nunca deje de operar si se cae internet** y que cumpla la normativa **DIAN**.

Reglas de trabajo:

1. **Antes de escribir código en cada fase**, entra en modo plan: resume lo que vas a construir, las decisiones técnicas y sus alternativas, los riesgos y las preguntas abiertas. Espera mi aprobación.
2. **Pregunta en vez de asumir** cuando algo de negocio sea ambiguo (impuestos, flujos de caja, permisos). Las decisiones técnicas de rutina tómalas tú y déjalas documentadas.
3. Yo no soy desarrollador de despliegue: cuando necesites que yo haga algo (instalar, configurar una impresora, crear una cuenta), dame **pasos numerados, uno por uno, con lo que debo ver en pantalla** en cada paso.
4. Mantén actualizados estos archivos:
   - `CLAUDE.md` — convenciones del proyecto, comandos, estructura.
   - `docs/ROADMAP.md` — fases, estado de cada feature (✅ / 🚧 / ⏳).
   - `docs/DECISIONES.md` — registro de decisiones de arquitectura (qué, por qué, alternativas descartadas).
   - `docs/MODELO_DATOS.md` — entidades y relaciones.
5. Cada feature termina con: tests pasando, datos de ejemplo (seed) para probarla, y una nota corta en el ROADMAP de cómo probarla manualmente.
6. **No inventes requisitos legales.** Todo lo tributario (DIAN, impuestos, propina) debe quedar **configurable** y marcado para validación con contador / proveedor tecnológico.

---

## 2. Visión del producto

### Principios no negociables

| Principio | Qué significa en la práctica |
|---|---|
| **Velocidad operativa** | Las acciones frecuentes (abrir mesa, agregar producto, enviar comanda, cobrar) en ≤ 3 toques. Respuesta de UI < 100 ms. Nunca bloquear la pantalla esperando red. |
| **Local-first / offline** | El salón sigue operando sin internet: pedidos, comandas, KDS, precuentas y cobro en efectivo. Sincroniza solo cuando vuelve la conexión. |
| **Cero pérdida de datos** | Toda operación se persiste localmente antes de mostrarse como hecha. Nada se borra: se anula con motivo y usuario. |
| **Trazabilidad total** | Cada cambio de un pedido (agregar, cancelar, mover, descuento, cortesía) queda en un log de auditoría con usuario, hora, dispositivo y motivo. |
| **Intuitivo sin capacitación** | Un mesero nuevo debe poder tomar un pedido en su primer turno. Botones grandes, colores con significado, cero menús escondidos para lo frecuente. |
| **Cumplimiento DIAN** | Documento equivalente electrónico POS y/o factura electrónica, notas de ajuste/crédito, numeración autorizada, contingencia. |

### Usuarios y dispositivos

- **Cajero / administrador de turno** → PC o tablet grande en caja (con impresora de recibos y cajón monedero).
- **Meseros** → celulares y tablets (Android/iOS) vía navegador (PWA instalable).
- **Cocina / barra** → pantallas KDS (tablet o TV con mini-PC) y/o impresoras de comandas por estación.
- **Dueño / gerente** → panel web desde cualquier lugar (reportes, inventario, configuración).

---

## 3. Arquitectura recomendada (valídala y propón ajustes en la Fase 0)

```
                 ┌─────────────────────────┐
                 │   NUBE (backoffice)      │  PostgreSQL + API
                 │ reportes, multi-sede,    │  panel del dueño
                 │ respaldo, integraciones  │  proveedor DIAN
                 └───────────▲─────────────┘
                             │ sync bidireccional (cuando hay internet)
┌────────────────────────────┴───────────────────────────────┐
│  HUB LOCAL del restaurante (PC de caja o mini-PC)           │
│  • Servidor local (API + WebSocket) en la red WiFi/LAN      │
│  • Base de datos local (SQLite) = fuente de verdad del salón │
│  • Cola de impresión ESC/POS (impresoras de red :9100/USB)   │
│  • Cola de documentos DIAN (envío + reintentos + contingencia)│
└──────▲──────────────▲───────────────▲───────────────▲──────┘
       │ LAN          │ LAN           │ LAN           │ LAN
   Tablets/cels    Caja (POS)     Pantallas KDS   Impresoras
   meseros (PWA)                  cocina/barra    cocina/barra/recibo
```

**Por qué hub local:** si se cae internet, los meseros, la cocina y la caja siguen hablando entre sí por la red local. Si además se cae el hub, cada dispositivo guarda en su base local (IndexedDB) y reenvía al reconectar.

### Stack sugerido (justifica si propones otro)

- **Monorepo TypeScript** (pnpm workspaces + Turborepo): `apps/pos` (PWA), `apps/hub` (servidor local), `apps/cloud` (API + backoffice), `packages/core` (lógica de negocio compartida y testeada), `packages/ui` (design system), `packages/printing`, `packages/dian`.
- **Frontend:** React + Vite + PWA (service worker), Tailwind, estado con Zustand/TanStack Query, almacenamiento local con IndexedDB (Dexie).
- **Editor de plano de mesas:** canvas (react-konva o similar) con arrastrar, rotar, redimensionar, ajuste a cuadrícula.
- **Hub local:** Node (Fastify) + SQLite + WebSocket; empaquetado como app de escritorio (Tauri o Electron) para tener acceso a impresoras USB/red y arrancar con Windows.
- **Nube:** PostgreSQL + la misma API; autenticación con roles.
- **Sincronización:** patrón *outbox* + log de eventos con IDs ULID generados en el dispositivo, número de versión por registro, sincronización por deltas e idempotente. Define y documenta la estrategia de conflictos (ej.: los pedidos son append-only por eventos; catálogo y configuración: gana la nube).
- **Dinero:** siempre enteros (pesos), nunca flotantes. Redondeo configurable.
- **Tests:** Vitest (lógica de negocio, cálculos de cuenta/impuestos/división), Playwright (flujos críticos end-to-end), pruebas de sync simulando cortes de red.

---

## 4. Módulos y features (inventario completo)

### 4.1 Plano del salón y mesas
- Editor visual por **zonas/pisos** (salón, terraza, barra, segundo piso) con mesas de forma real (redonda, cuadrada, rectangular, barra), tamaño, rotación, sillas, paredes, puertas y elementos decorativos para que el plano sea **realista**.
- Estados por color: libre, ocupada, con pedido enviado, precuenta impresa, por pagar, reservada, sucia/por limpiar.
- En cada mesa ocupada: tiempo transcurrido, total actual, mesero asignado, # comensales.
- **Unir mesas** (grupos grandes) y separarlas; **cambiar de mesa** un pedido completo.
- Vista lista alternativa (para celular) además del plano.
- Pedidos sin mesa: **para llevar, domicilio, barra/mostrador**.

### 4.2 Toma de pedidos (meseros y caja)
- Catálogo por categorías con **búsqueda instantánea**, favoritos/más vendidos y fotos opcionales.
- **Modificadores** (término de la carne, sin cebolla, adicionales con precio), combos, tamaños/variantes, notas libres.
- **Comensales/asientos**: asignar cada ítem a un comensal (sirve después para dividir la cuenta).
- **Tiempos/cursos**: entrada, fuerte, postre; "retener" y "marchar" (fire) un curso.
- Cantidades rápidas, duplicar ítem, deshacer el último cambio.
- Productos agotados se marcan en tiempo real en todos los dispositivos (86).

### 4.3 Operaciones sobre pedidos
- **Mover ítems entre mesas** (uno, varios o por comensal).
- **Cambiar mesa** completa y **unir cuentas**.
- **Cancelar/anular ítems** con motivo obligatorio (error del mesero, cliente cambió, demora, producto dañado) y distinguir si ya se había preparado (afecta inventario como merma o no).
- **Cancelar pedido completo** con permiso de supervisor (PIN).
- Descuentos (por ítem o total, % o valor) y **cortesías** con permiso y motivo.
- Reimprimir comanda; avisar a cocina de cambios/cancelaciones (comanda de anulación).
- Todo queda en el log de auditoría.

### 4.4 Comandas: impresoras y KDS
- **Ruteo por estación**: cada producto tiene una o varias estaciones (cocina caliente, fría, parrilla, barra, postres). Una orden se parte automáticamente en comandas por estación.
- **Impresoras térmicas ESC/POS** (58/80 mm) por red (IP:9100) y USB: formato claro (mesa, mesero, hora, comensal, modificadores resaltados, notas), comanda de modificación y de anulación, corte automático, **cola de impresión con reintentos y alerta si una impresora no responde** (con impresora de respaldo configurable).
- **KDS virtual**: tarjetas por orden con temporizador y colores por tiempo (verde/amarillo/rojo), estados (nuevo → en preparación → listo → entregado), filtro por estación, pantalla "expedidor/pase", agrupar ítems iguales, sonido al llegar orden, tocar para marcar listo, recuperar orden despachada por error.
- Notificación al mesero cuando un pedido está listo.
- Modo mixto: KDS + impresora en la misma estación.

### 4.5 Precuenta, división y cobro
- **Precuenta** imprimible y visible en pantalla (con propina sugerida configurable).
- **Dividir la cuenta**:
  - por ítems seleccionados (el cliente escoge qué paga),
  - por comensal/asiento,
  - en partes iguales (N personas),
  - por monto libre,
  - dividir **un mismo ítem** entre varias personas (ej. una botella entre 3).
- **Pagos parciales y mixtos**: efectivo + tarjeta + transferencia/QR (Nequi, Daviplata, Bre-B) + bonos; cálculo de cambio.
- Propina **voluntaria**: preguntar si se incluye, % sugerido configurable, registrarla separada de la venta y por mesero.
- Saldo pendiente visible hasta cerrar la mesa; la mesa no se libera mientras haya saldo.
- Reabrir una cuenta cerrada solo con permiso (genera nota de ajuste si ya se emitió documento DIAN).

### 4.6 Facturación electrónica (Colombia)
- Integración mediante **proveedor tecnológico autorizado por la DIAN** vía API (diseña un adaptador intercambiable `packages/dian` para poder cambiar de proveedor). No conectar directo al web service de la DIAN en el MVP.
- Documentos: **documento equivalente electrónico tiquete POS**, **factura electrónica de venta** (cuando el cliente pide factura a su nombre/NIT), **notas de ajuste / notas crédito** para anulaciones y devoluciones.
- Manejo de **resoluciones de numeración** por tipo de documento y por caja (prefijo, rango, vigencia) con alertas antes de agotarse o vencer.
- Datos del adquiriente opcionales/obligatorios según el caso; consumidor final por defecto; búsqueda rápida de clientes frecuentes por NIT/cédula.
- **Cola de envío** con reintentos, estados (pendiente, enviado, aceptado, rechazado), y **modo contingencia** cuando no hay internet: el cobro nunca se detiene y los documentos se transmiten al reconectar dentro de los plazos que defina la norma (dejarlo configurable y validar con el proveedor).
- Representación gráfica en el ticket: CUFE/CUDE, QR, datos de la resolución.
- Envío del documento al correo/WhatsApp del cliente.
- **Comprobante de informe diario** por caja/dispositivo al cierre.
- Impuestos **configurables por producto**: impuesto nacional al consumo (restaurantes), IVA, exento; y la propina fuera de la base gravable. Todas las tarifas editables desde configuración; **validar con contador** antes de producción.

### 4.7 Productos, recetas e inventario
- Catálogo: categorías, productos, variantes, modificadores, combos, precios por canal (salón, domicilio, apps) y por horario (happy hour).
- **Insumos** con unidad de compra y unidad de uso (ej. compro bulto de 50 kg, uso gramos) y factor de conversión.
- **Recetas y sub-recetas** (ej. salsa de la casa usada en varios platos), rendimiento y % de merma.
- **Descuento automático de inventario** al vender (por receta), incluyendo modificadores que agregan o quitan insumos.
- **Costeo**: costo teórico por plato, % de food cost, margen; alerta cuando un plato queda por debajo del margen objetivo.
- Bodegas/almacenes (bodega principal, cocina, barra) y **traslados** entre ellas.
- Entradas por compra, salidas por merma/consumo interno/cortesía, **conteo físico** y ajuste con comparación teórico vs real.
- Stock mínimo y alertas; sugerido de compra.
- Proveedores y órdenes de compra (fase posterior).
- Producto agotado automático cuando falta un insumo crítico (opcional).

### 4.8 Caja y turnos
- Apertura de caja con base, **arqueo** por denominaciones, entradas/salidas de efectivo con motivo, cierre con diferencia (sobrante/faltante).
- Cierre Z / informe de turno: ventas por medio de pago, por mesero, propinas, descuentos, anulaciones, impuestos.
- Múltiples cajas por restaurante.
- Apertura de cajón monedero desde la impresora.

### 4.9 Usuarios, roles y seguridad
- Roles: administrador, gerente, cajero, mesero, cocina/barra, contador (solo lectura de reportes).
- **Login rápido con PIN** de 4–6 dígitos en dispositivos compartidos; cambio rápido de usuario.
- Permisos granulares: anular, descontar, cortesía, reabrir cuenta, abrir cajón, ver reportes, editar precios.
- Autorización de supervisor "en el momento" (PIN del gerente sin cerrar sesión del mesero).
- Registro de entrada/salida del personal (marcación de turno).

### 4.10 Reportes y dashboards (módulo estrella — debe superar a Vendty, Siigo y Loggro)

**Principio:** cada reporte responde una pregunta de negocio concreta y lleva a una acción. Nada de tablas por llenar pantalla. Todos los reportes salen de la misma capa de datos (eventos del pedido + pagos + inventario), para que los números **siempre cuadren entre sí**.

**Capacidades transversales (aplican a todos los reportes):**
- Filtros: rango de fechas, sede, caja, turno, zona/salón, mesero, canal (salón, para llevar, domicilio, apps), categoría, medio de pago, franja horaria, día de la semana.
- **Comparativos automáticos**: vs período anterior, vs mismo día de la semana pasada, vs mismo mes del año anterior, con variación % y flecha de tendencia.
- **Drill-down**: del total → al día → a la mesa → al pedido → al evento exacto (quién, cuándo, en qué dispositivo).
- Exportar a Excel, CSV y PDF; imprimir en impresora térmica los de cierre.
- **Reportes programados**: envío automático por correo/WhatsApp (cierre diario, semanal, mensual).
- Definir el "día operativo" configurable (ej. de 6 a. m. a 5:59 a. m. para bares que cierran de madrugada).
- Ventas brutas, netas (descuentos y anulaciones restados), impuestos y propinas siempre separados.
- Permisos por rol: el mesero solo ve lo suyo; el contador ve fiscal; el dueño ve todo.

**Catálogo de reportes por categoría:**

| Categoría | Reportes |
|---|---|
| **Ventas** | Resumen de ventas (bruto, neto, impuestos, propinas, # cuentas, # comensales, ticket promedio, gasto por comensal); ventas por hora / día / día de semana / mes (mapa de calor); por canal; por zona del salón (barra vs terraza); por mesa; tendencia y proyección del mes. |
| **Productos y menú** | Mezcla de productos (cantidades, ventas, % del total); por categoría; por modificador (qué adicionales se venden y cuánto suman); más y menos vendidos; productos sin ventas en N días; **ingeniería de menú** (matriz popularidad × margen: estrella, caballo de batalla, rompecabezas, perro); combos. |
| **Personal / meseros** | Ventas por mesero; ticket promedio por mesero; comensales y mesas atendidas; ventas adicionales (upsell) por mesero; propinas por mesero y reparto; anulaciones, descuentos y cortesías por mesero; horas trabajadas vs ventas (ventas por hora-hombre). |
| **Caja y medios de pago** | Cierre de turno (Z) por caja; ventas por medio de pago (efectivo, tarjeta por franquicia, Nequi, Daviplata, Bre-B, transferencia, bonos); arqueo esperado vs contado (sobrante/faltante) con historial; entradas y salidas de efectivo; **conciliación con datáfonos** (ver 4.12); histórico de descuadres por cajero. |
| **Control y pérdidas** | Anulaciones (antes y después de enviar a cocina, antes y después de precuenta); descuentos y cortesías con motivo y autorizador; cuentas reabiertas; cambios de precio manuales; ítems borrados; aperturas de cajón sin venta; ranking de usuarios con más eventos sensibles. |
| **Cocina / operación** | Tiempo promedio de preparación por estación y por plato; pedidos demorados (sobre el umbral); tiempo total de la mesa (abrir → pagar); rotación de mesas por franja; ocupación del salón por hora; productos agotados (86) y cuánto tiempo. |
| **Inventario y costos** | Inventario valorizado; consumo teórico vs real (diferencia = merma/robo); food cost % y bebida cost % por período; costo y margen por plato; mermas por motivo; compras por proveedor e insumo; variación de precios de proveedores; alertas de stock mínimo; rotación de insumos. |
| **Fiscal / DIAN** | Documentos electrónicos emitidos por tipo, estado (aceptado/rechazado/pendiente) y consecutivo; notas de ajuste/crédito; impuestos por tarifa; comprobante de informe diario por caja; consumo de numeración de cada resolución; exportación para el contador. |
| **Clientes** (fase 4) | Clientes nuevos vs recurrentes; frecuencia y gasto por cliente; clientes inactivos; desempeño de cupones y fidelización. |
| **Canales externos** (fase 4) | Ventas por app de domicilio con comisión cobrada y margen real del canal. |
| **Multi-sede** (fase 5) | Comparativo entre sedes de todos los KPIs anteriores. |

**Dashboards por rol (vistas en tiempo real, una sola pantalla, sin scroll en escritorio):**
- **Dueño / gerente:** ventas de hoy vs mismo día semana pasada, ventas en curso (mesas abiertas), ticket promedio, comensales, top 5 productos, food cost del mes, alertas (descuadres, anulaciones raras, stock bajo, documentos DIAN rechazados, impresora caída). Versión móvil prioritaria.
- **Jefe de salón:** mapa de mesas con tiempo de ocupación, mesas demoradas, rendimiento de meseros del turno.
- **Cocina:** tiempos por estación en vivo, cola de pedidos, platos demorados.
- **Cajero:** turno actual: esperado por medio de pago, conciliación con datáfono en vivo.
- **Contador:** resumen fiscal del mes y estado de documentos electrónicos.

**KPIs clave con su fórmula documentada** (escríbelas en `docs/KPIS.md` para que todos los reportes usen exactamente la misma definición): ventas brutas, ventas netas, ticket promedio, gasto por comensal, rotación de mesas, food cost %, margen de contribución por plato, % de anulaciones, % de descuentos, ventas por hora-hombre, tiempo promedio de mesa, tiempo promedio de cocina.

**Implementación:** las métricas se calculan en tablas de agregados que se actualizan con cada evento (no recalcular todo al abrir un reporte); los dashboards en vivo se actualizan por WebSocket; los reportes deben abrir en < 2 s con un año de datos.

### 4.11 Features de fases avanzadas
- **Menú QR y pedido desde la mesa** por el cliente (con aprobación del mesero) y pago desde el celular.
- Reservas y lista de espera con asignación en el plano.
- Domicilios y para llevar: datos del cliente, zonas y costos de envío, estado del domicilio, domiciliario.
- Integración con apps de domicilios (Rappi, DiDi Food, etc.) centralizando los pedidos en el mismo KDS.
- **Pagar y dividir desde el celular del cliente**: QR en la precuenta → cada comensal escoge sus ítems y paga (tarjeta, Nequi, Bre-B); la mesa se cierra sola cuando el saldo llega a cero.
- Clientes y **fidelización sin app** (identificación por número de celular; puntos, cupones, historial de consumo, cumpleaños).
- Menú QR multi-idioma (turistas) con alérgenos, sincronizado con productos agotados.
- Pantalla de cara al cliente (total y propina).
- Multi-sede con catálogo central y precios por sede.
- Integración contable (exportar a Siigo/Alegra/World Office u otro).
- Nómina/turnos del personal y reparto de propinas por reglas.
- API abierta documentada para integraciones de terceros.
- **Hardware libre**: funcionar en cualquier Android/iPad/PC y con impresoras térmicas genéricas (sin amarrar al cliente a un hardware propio).

### 4.12 Datáfonos y conciliación de pagos con tarjeta (cero descuadres)

**Objetivo:** que al cierre de turno el sistema diga automáticamente si lo que registró el POS como "pago con tarjeta / QR" coincide transacción por transacción con lo que realmente aprobó el datáfono, y señale exactamente cuáles no cuadran.

Diseña un **adaptador intercambiable por proveedor** (`packages/payments`) con una interfaz común (`iniciarCobro`, `consultarEstado`, `anular`, `listarTransacciones(rango)`, `recibirWebhook`) y tres niveles de integración. Cada restaurante configura, por datáfono, qué nivel usa.

**Nivel 1 — Sin integración (funciona con cualquier datáfono, va en Fase 1)**
- Al cobrar con tarjeta, el cajero registra: datáfono/terminal, franquicia, últimos 4 dígitos, **número de aprobación** y número de recibo (los 2 últimos obligatorios y configurables).
- Validaciones: número de aprobación no repetido en el día, monto igual al saldo cobrado.
- En el cierre, conciliación asistida: el cajero ingresa el total del reporte de cierre del datáfono (y opcionalmente el # de transacciones) y el sistema compara.
- **Importar el reporte del datáfono** (Excel/CSV descargado del portal del proveedor — por ejemplo el portal de Bold o la plataforma de Voucher Digital de Redeban) y conciliar automáticamente. Construye un importador con mapeo de columnas configurable, porque cada proveedor exporta distinto. Pídeme archivos de ejemplo reales antes de construirlo; no inventes formatos.

**Nivel 2 — Bold (API Integrations + webhooks)**
- **Nuestros datáfonos Bold son Smart Pro**, el modelo compatible con API Integrations. Esta integración es **prioritaria**.
- Bold tiene una API oficial (documentación en developers.bold.co, sección API Integrations) para que el sistema **envíe el monto al datáfono** y este inicie el cobro solo: el cajero no digita el valor y el resultado (aprobado/rechazado, número de aprobación, franquicia, tarjeta enmascarada) vuelve al POS y se asocia al pago automáticamente. Según su documentación está en **beta**: verifica condiciones actuales antes de construir. Tiene **ambiente de pruebas (sandbox)** para simular transacciones sin dinero real; desarrolla y prueba ahí primero.
- Requisitos según Bold: cuenta Bold habilitada, llaves de integración de API (distintas a las de botón de pagos), cada datáfono seleccionado en la lista de conexiones API del panel de Bold, y el datáfono encendido con la app abierta o en segundo plano. Dame la guía paso a paso para obtener las llaves y habilitar los datáfonos.
- La API funciona por internet: si no hay conexión, el POS cae automáticamente al registro manual (Nivel 1) y concilia después con el webhook.
- Flujo de UI: en la pantalla de cobro, botón "Cobrar con Bold" → elegir datáfono (recordar el último usado por caja) → el monto viaja solo → pantalla de espera con monto grande y contador → resultado. Botones "Cancelar" y "Registrar manual" siempre visibles. Nunca crear un pago duplicado si la respuesta llega tarde (idempotencia por referencia de cobro).
- Bold también ofrece **webhooks** que notifican las transacciones (con datos como número de aprobación, ID del datáfono y tarjeta enmascarada) incluyendo, según su documentación, ventas hechas en datáfonos no integrados, con un retraso que puede ser de varios minutos. Úsalo para **conciliación automática casi en tiempo real** aunque el cobro no haya salido desde el POS.
- El webhook llega a la nube; el hub local recibe el resultado cuando hay internet. Verifica la firma/origen de cada webhook.
- Si el datáfono no responde o se cae internet: pasar a Nivel 1 (registro manual) sin bloquear el cobro.

**Nivel 3 — Redeban (datáfono integrado a caja)**
- Redeban maneja datáfonos fijos con conexión USB/serial para integración con caja registradora. El monto viaja al datáfono y la respuesta (aprobación, RRN, franquicia, tarjeta enmascarada, terminal, recibo, cuotas) vuelve al POS.
- Requiere el **protocolo/kit de integración que entrega Redeban** al comercio o desarrollador (normalmente a través del banco o del área comercial de Redeban) y poner el datáfono en modo integrado. No lo implementes adivinando el protocolo: diseña la interfaz, deja un simulador para pruebas y documenta en `docs/` qué hay que solicitar a Redeban.
- Arquitectura: un **agente local por caja** (servicio de Windows dentro del hub local o de la app de escritorio) que habla con el datáfono por USB/serial y expone una API local al POS.
- Evaluar también la plataforma de Voucher Digital de Redeban como fuente para importar transacciones (Nivel 1).

**Otros proveedores** (Credibanco, Wompi, Mercado Pago, etc.) y pagos QR/Bre-B: mismo adaptador; agregarlos según demanda.

**Motor de conciliación (común a los 3 niveles)**
- Emparejar cada pago con tarjeta del POS con una transacción del datáfono por: número de aprobación → si no, monto + terminal + ventana de tiempo (± N minutos configurable).
- Estados por transacción: ✅ conciliada · ⚠️ solo en POS (se registró pero el datáfono no la tiene) · ⚠️ solo en datáfono (cobro no registrado en el POS) · ⚠️ diferencia de monto · ⚠️ duplicada · anulada/reversada.
- Manejo de propinas cobradas en el datáfono, anulaciones del mismo día y pagos divididos en varias tarjetas.
- **Pantalla de cierre de turno**: resumen por datáfono y franquicia, lista de descuadres con acción sugerida (asignar a una cuenta, marcar como error con motivo, escalar al gerente). El cierre puede completarse con descuadre, pero queda marcado, con justificación obligatoria y visible en reportes.
- Alerta en vivo al cajero si un cobro aprobado no tiene pago asociado en el POS (posible fuga).
- Fase posterior: conciliar contra el **abono en banco/cuenta del proveedor** (liquidación), mostrando comisiones y retenciones descontadas, para saber cuánto entra realmente.

### 4.13 Inteligencia artificial (capa opcional, nunca en el camino crítico)

**Reglas:** el salón opera 100 % sin IA ni internet; la IA corre en la nube (Claude API) y se activa por restaurante; **toda acción que mueva dinero, precios o inventario requiere confirmación humana**; registrar cada sugerencia y si fue aceptada o rechazada para medir su valor real; controlar el costo de IA por restaurante; nunca enviar datos personales de clientes que no sean necesarios.

| Feature | Qué hace | Fase |
|---|---|---|
| **Onboarding con foto** | Foto de la carta → categorías, productos, precios y modificadores para revisar; foto o dibujo del salón → propuesta de plano de mesas. | 2 |
| **Lectura de facturas de proveedores** | Facturas electrónicas XML de proveedores (llegan al correo) → entrada de inventario y costo actualizado, sin IA (lectura directa del XML). Remisiones en papel → foto + OCR. Alerta si sube el costo y afecta el margen de un plato. | 2 |
| **Resumen diario por WhatsApp/correo** | Al cierre: ventas vs comparativo, food cost, descuadres, anomalías y una recomendación concreta. | 3 |
| **Asistente del dueño** | Preguntas en lenguaje natural sobre los reportes ("¿qué mesero anuló más este mes?") y acciones con confirmación ("sube 5 % las bebidas"). Respeta permisos del usuario. | 3 |
| **Detección de anomalías** | Patrones de fraude o error: anulaciones tras precuenta, descuentos concentrados, efectivo atípico, descuadres repetidos con datáfono. | 3 |
| **Ingeniería de menú asistida** | Recomendaciones sobre la matriz popularidad × margen: qué subir, rediseñar o retirar. | 3 |
| **KDS con ritmo (pacing)** | Calcula cuándo marchar cada plato para que la mesa salga junta; predice demoras. | 3 |
| **Pedidos por WhatsApp** | Agente que toma el pedido, confirma, envía link de pago y lo inyecta al KDS. | 4 |
| **Dictado por voz del mesero** | El mesero dicta el pedido en español colombiano y el ticket se arma para su confirmación, usando los nombres de la carta propia. | 4 |
| **Sugerencias al mesero** | Chips discretos: mesa sin bebidas, maridajes, postre pendiente. | 4 |
| **Pronóstico de demanda** | Ventas esperadas por día/franja cruzando historial, clima, festivos, quincenas, partidos y eventos → lista de preparación, sugerido de compra y personal. Requiere 2–3 meses de historial. | 5 |
| **Marketing automático** | Campañas a clientes inactivos o por cumpleaños, con medición de retorno. | 5 |

No priorizar: precios dinámicos, agente de voz telefónico, chatbots genéricos sin función operativa.

---

## 5. UX: reglas de agilidad (aplican a TODA pantalla)

1. La pantalla inicial del mesero es el **plano de mesas**; la del cajero, el plano + cuentas por cobrar.
2. Flujo de pedido ideal: tocar mesa → tocar productos → "Enviar" (3 pasos). Modificadores en un panel lateral, no en ventanas emergentes en cascada.
3. Botones táctiles mínimo 48×48 px, texto legible a un brazo de distancia, modo oscuro para bar/noche.
4. Colores con significado constante (verde = libre/listo, ámbar = en proceso/espera, rojo = demora/alerta, azul = acción principal).
5. Confirmaciones solo para acciones destructivas o de dinero; para lo demás, **deshacer** durante unos segundos.
6. Búsqueda tolerante a tildes y errores ("hamburgesa" encuentra "Hamburguesa").
7. Indicador permanente de estado de conexión (en línea / solo red local / sin conexión) y de impresoras.
8. Atajos de teclado en caja (F-keys, Enter para cobrar).
9. Feedback inmediato (vibración/sonido opcional) al enviar comandas.
10. Diseñar primero para celular del mesero y tablet de caja; probar con una mano.
11. Accesibilidad: contraste AA, no depender solo del color (íconos + texto).

Antes de construir pantallas en la Fase 1, propón un **design system** (colores, tipografía, componentes base) y wireframes de: plano de mesas, toma de pedido, KDS, precuenta/división, cobro.

---

## 6. Modelo de datos (punto de partida — complétalo en Fase 0)

Entidades mínimas: `Restaurante`, `Sede`, `Zona`, `Mesa` (posición, forma, tamaño, rotación, capacidad), `ElementoPlano`, `Usuario`, `Rol`, `Permiso`, `Dispositivo`, `Caja`, `TurnoCaja`, `MovimientoCaja`, `Categoria`, `Producto`, `Variante`, `GrupoModificador`, `Modificador`, `Combo`, `Estacion`, `Impresora`, `Insumo`, `Unidad`, `Receta`, `RecetaItem`, `Bodega`, `MovimientoInventario`, `ConteoFisico`, `Proveedor`, `Cliente`, `Pedido` (canal, mesa, comensales, estado), `PedidoItem` (comensal, curso, estado, estación), `PedidoItemModificador`, `EventoPedido` (log append-only), `Comanda`, `Cuenta` (subcuentas al dividir), `Pago`, `Datafono` (proveedor, terminal, nivel de integración), `TransaccionDatafono` (aprobación, RRN, franquicia, tarjeta enmascarada, monto, propina, fecha/hora, origen: manual/importada/webhook/integrada), `Conciliacion` y `ConciliacionItem` (estado, justificación), `Propina`, `Descuento`, `DocumentoElectronico` (tipo, numeración, CUFE/CUDE, estado DIAN, XML/PDF), `ResolucionNumeracion`, `Impuesto`, `Auditoria`, `ColaSync`.

Reglas:
- IDs ULID generados en el dispositivo (funciona offline sin colisiones).
- Campos `creado_en`, `actualizado_en`, `version`, `dispositivo_id`, `usuario_id` en todo lo sincronizable.
- Nada de borrado físico en entidades transaccionales.

---

## 7. Fases de desarrollo

> Cada fase entrega algo **usable en un restaurante real**. Al cerrar cada fase: demo guiada, tests, seed, y actualización de ROADMAP y DECISIONES.

### Fase 0 — Fundaciones (sin features visibles todavía)
- Validar arquitectura y stack; documentar en `DECISIONES.md`.
- Monorepo, linters, formato, tests, CI básico.
- Modelo de datos inicial + migraciones + seed de un restaurante de ejemplo (20 mesas en 2 zonas, 60 productos, 3 estaciones, 5 usuarios).
- Motor de sincronización mínimo (outbox + eventos) con tests de corte de red.
- Autenticación con PIN y roles.
- Design system + wireframes de las 5 pantallas clave.
- **Aceptación:** dos dispositivos simulados crean pedidos offline y al reconectar ambos ven lo mismo sin duplicados.

### Fase 1 — MVP de salón (operar un servicio completo sin facturación electrónica)
- Editor de plano + vista operativa de mesas.
- Catálogo con modificadores, variantes y estaciones.
- Toma de pedidos por comensal y curso desde celular/tablet (PWA en la red local).
- Enviar comanda → impresora ESC/POS por estación + KDS básico.
- Mover ítems, cambiar/unir mesas, cancelar con motivo y permiso.
- Precuenta, división (ítems, comensal, partes iguales, monto, ítem compartido), pagos mixtos, propina voluntaria.
- Apertura/cierre de caja y arqueo.
- Datáfonos **Nivel 1** (registro manual de aprobación + conciliación asistida en el cierre).
- Reportes básicos: cierre de turno (Z), ventas por medio de pago, por mesero, por producto, anulaciones y descuentos; `docs/KPIS.md` con las fórmulas.
- Funciona completo **sin internet** (solo red local).
- **Aceptación:** simular un servicio de 2 horas con 3 meseros, 1 cajero y 2 estaciones sin internet; cero pedidos perdidos; cada acción frecuente en ≤ 3 toques; el cierre de turno detecta un pago con tarjeta mal registrado sembrado a propósito.

### Fase 2 — Cumplimiento DIAN + inventario
- Adaptador de proveedor tecnológico (con uno real elegido conmigo y un *mock* para pruebas).
- Documento equivalente POS, factura electrónica, notas, resoluciones, contingencia, informe diario.
- Insumos, recetas, sub-recetas, descuento automático, mermas, bodegas, conteo físico, costeo y food cost.
- **Cobro integrado con Bold Smart Pro** (API Integrations, Nivel 2) + **webhooks de Bold** para conciliación casi en tiempo real + importador de reportes de datáfono (Nivel 1 automático, para Redeban).
- IA: onboarding con foto de la carta; lectura de XML de facturas de proveedores.
- Reportes fiscales y de inventario/costos.
- **Aceptación:** documentos aceptados en el ambiente de habilitación del proveedor; inventario teórico cuadra con las ventas del seed; conciliación automática de un archivo de datáfono real con ≥ 1 descuadre detectado correctamente; cobro de punta a punta con Bold Smart Pro en sandbox (aprobado, rechazado, cancelado y respuesta tardía sin duplicar el pago).

### Fase 3 — Cocina avanzada, reportes completos y control
- KDS completo (tiempos, colores, expedidor, cursos, recall, notificación al mesero) + pacing con IA.
- **Catálogo completo de reportes (4.10)**, comparativos, drill-down, reportes programados y dashboards por rol en la nube (móvil primero).
- Cobro integrado con **Redeban** (Nivel 3) si ya se tiene el kit de Redeban.
- IA: resumen diario por WhatsApp, asistente del dueño, detección de anomalías, ingeniería de menú asistida.
- **Aceptación:** todos los reportes cuadran entre sí (ventas del resumen = suma por medio de pago = suma por mesero = documentos DIAN); dashboards abren en < 2 s con 1 año de datos.

### Fase 4 — Canales y cliente
- Para llevar y domicilios propios; integración con apps de domicilios.
- Menú QR multi-idioma / pedido desde la mesa / **pago y división desde el celular del cliente**.
- Reservas y lista de espera; clientes y fidelización sin app; pantalla al cliente.
- IA: pedidos por WhatsApp, dictado por voz del mesero, sugerencias al mesero.

### Fase 5 — Escala e inteligencia
- Multi-sede, compras y proveedores, integración contable, conciliación contra abonos bancarios (comisiones y retenciones).
- IA: pronóstico de demanda, sugerido de compra y de personal, marketing automático.
- Nómina/turnos y reglas de reparto de propinas.

---

## 8. Calidad, seguridad y operación
- Tests obligatorios para toda la lógica de dinero: totales, impuestos, descuentos, divisiones, propinas, redondeos (incluye casos borde: dividir $100.000 entre 3).
- Pruebas de resiliencia: apagar el hub a mitad de un pedido, desconectar una impresora, perder internet durante un cobro.
- Respaldo automático diario de la base local + respaldo en la nube.
- Datos personales de clientes según la Ley 1581 de 2012 (habeas data): consentimiento y finalidad.
- Contraseñas/PIN con hash; tokens por dispositivo revocables.
- Actualizaciones del sistema sin interrumpir el servicio (avisar y aplicar al cierre).
- Guía de instalación para el restaurante (hub, impresoras, red WiFi, tablets) escrita para alguien no técnico, con capturas o diagramas.

---

## 9. Primera tarea

1. Lee todo este documento.
2. Devuélveme en modo plan:
   - tu propuesta de arquitectura y stack (confirmando o ajustando la sección 3) con alternativas y riesgos,
   - las **preguntas** que necesitas que yo responda antes de empezar (tipo de restaurantes objetivo, hardware disponible, proveedor DIAN, modelo exacto de los datáfonos Redeban (los Bold son Smart Pro), si será SaaS para vender a otros restaurantes o para uno propio, etc.),
   - el plan detallado de la **Fase 0** con tareas y criterios de aceptación.
3. No escribas código hasta que yo apruebe el plan.
