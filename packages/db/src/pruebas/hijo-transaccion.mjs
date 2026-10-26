// Proceso hijo de las pruebas de persistencia: abre la base real, empieza una transacción con un
// INSERT de evento y avisa por stdout. Nunca confirma ni cierra: el padre lo termina con SIGKILL.
// Usa la misma apertura que el hub (abrirBase); Node 24 ejecuta el .ts quitando los tipos.
import { abrirBase } from '../node.ts'

const [, , ruta, restauranteId, eventId] = process.argv
const db = abrirBase(ruta)

db.exec('BEGIN IMMEDIATE')
db.prepare(
  `INSERT INTO events (restaurant_id, id, type, schema_version, aggregate_type, aggregate_id,
     data, user_id, device_id, device_time, hub_estimated_time, base_sequence,
     sequence, received_at, business_day, content_hash)
   VALUES (?, ?, 'OrderOpened', 1, 'order', ?, '{}', ?, ?, 'h', 'h', 0, 2, 'h', '2026-10-24', 'x')`,
).run(restauranteId, eventId, eventId, eventId, eventId)

process.stdout.write('en-transaccion\n')
// Mantiene el proceso vivo con la transacción abierta hasta que lo maten.
setInterval(() => {}, 1 << 30)
