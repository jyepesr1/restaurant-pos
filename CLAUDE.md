# POS para restaurantes (Colombia)

Sistema POS para restaurantes de servicio a la mesa. El brief completo está en `docs/BRIEF.md`; las decisiones de arquitectura en `docs/DECISIONES.md` y el estado de cada fase en `docs/ROADMAP.md`.

Restaurante piloto: **La Spritzzería** (Envigado). Su carta real está en `docs/datos/carta-la-spritzzeria.yaml`.

## Convenciones

- **Idioma**: el dominio va en español (`Pedido`, `Comanda`, `Mesa`, eventos como `ItemAnulado`); la parte técnica en inglés (`useSyncStatus`, `retryWithBackoff`). Interfaz, documentación y mensajes de commit en español.
- **Dinero**: pesos enteros en todo el sistema. Los decimales solo existen dentro del cálculo fiscal DIAN, con aritmética exacta. Repartos por mayor residuo.
- **IDs**: ULID generados en el dispositivo.
- **Nada se borra** en entidades transaccionales: se anula con motivo, usuario y dispositivo.
- **Todo cambio de un pedido es un evento** append-only con usuario, dispositivo y hora.
- **Persistir antes de mostrar**: una operación se muestra como hecha solo después de guardarse localmente.
- **Nada tributario cableado**: tarifas, redondeos y reglas DIAN son configurables y quedan marcados para validar con contador.
- El usuario no es desarrollador de despliegue: todo lo que deba hacer él va en pasos numerados con lo que debe ver en pantalla.

## Flujo de trabajo

Los subagentes del proyecto están en `.claude/agents/`.

| Subagente | Cuándo usarlo |
|---|---|
| `revisor-codigo` | Al terminar **cada** tarea, antes del commit. Revisa los cambios buscando errores, seguridad y desorden. Solo lectura. |
| `qa-pruebas` | Al terminar **cada** tarea, antes del commit. Escribe y ejecuta pruebas (Vitest, Playwright, cortes de red y caída del hub) y devuelve solo lo que falló. |
| `auditor-dinero` | Cuando una tarea toque dinero: totales, impuestos, descuentos, divisiones, propinas, redondeos, caja o conciliación de datáfonos. Solo lectura. |
| `revisor-ux` | Cuando una tarea agregue o cambie pantallas o componentes de interfaz. Revisa contra la sección 5 del brief. Solo lectura. |
| `investigador-integraciones` | Antes de escribir código de integración con Bold, Redeban, el proveedor DIAN u otro servicio externo. Resume la documentación oficial en `docs/integraciones/`. |

### Regla al terminar cada tarea

1. Pasar el trabajo por `revisor-codigo` y `qa-pruebas`, en paralelo.
2. Si la tarea toca dinero, pasarlo también por `auditor-dinero`. Si toca pantallas, por `revisor-ux`.
3. Corregir lo que encuentren (o dejar registrado en `docs/ROADMAP.md` por qué no se corrige).
4. Confirmar que `pnpm check` pasa.
5. Hacer un commit con un mensaje claro en español: qué cambió y por qué.
6. Actualizar `docs/ROADMAP.md` con el estado de la tarea y cómo probarla manualmente.

No hacer push ni abrir PR sin que el usuario lo pida.

## Estructura y comandos

Se completan en la tarea 0.2 de la Fase 0.
