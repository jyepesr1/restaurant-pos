// Child process for the persistence tests: opens the real database, starts a transaction with an
// event INSERT and reports on stdout. It never commits or closes: the parent ends it with SIGKILL.
// Uses the same opening as the hub (openDatabase); Node 24 runs the .ts by stripping the types.
import { openDatabase } from '../node.ts'

const [, , route, restaurantId, eventId] = process.argv
const db = openDatabase(route)

db.exec('BEGIN IMMEDIATE')
db.prepare(
  `INSERT INTO events (restaurant_id, id, type, schema_version, aggregate_type, aggregate_id,
     data, user_id, device_id, device_time, hub_estimated_time, base_sequence,
     sequence, received_at, business_day, content_hash)
   VALUES (?, ?, 'OrderOpened', 1, 'order', ?, '{}', ?, ?, 'h', 'h', 0, 2, 'h', '2026-10-24', 'x')`,
).run(restaurantId, eventId, eventId, eventId, eventId)

process.stdout.write('in-transaction\n')
// Keeps the process alive with the transaction open until it is killed.
setInterval(() => {}, 1 << 30)
