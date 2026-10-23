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
6. **Pendiente:** confirmar en Android la reconexión de menos de 1 s con la versión corregida, y repetir con el hub en el PC de caja (Windows 11) cuando exista el instalador del hub (Fase 1); la prueba con el hub en el Mac ya valida la parte del navegador.
