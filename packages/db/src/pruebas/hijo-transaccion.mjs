// Proceso hijo de las pruebas de persistencia: abre la base real, empieza una transacción con un
// INSERT de evento y avisa por stdout. Nunca confirma ni cierra: el padre lo termina con SIGKILL.
// Usa la misma apertura que el hub (abrirBase); Node 24 ejecuta el .ts quitando los tipos.
import { abrirBase } from '../node.ts'

const [, , ruta, restauranteId, eventoId] = process.argv
const db = abrirBase(ruta)

db.exec('BEGIN IMMEDIATE')
db.prepare(
  `INSERT INTO evento (restaurante_id, id, tipo, version_esquema, agregado_tipo, agregado_id,
     datos, usuario_id, dispositivo_id, hora_dispositivo, hora_estimada_hub, secuencia_base,
     secuencia, recibido_en, dia_operativo, contenido_hash)
   VALUES (?, ?, 'PedidoAbierto', 1, 'pedido', ?, '{}', ?, ?, 'h', 'h', 0, 2, 'h', '2026-10-24', 'x')`,
).run(restauranteId, eventoId, eventoId, eventoId, eventoId)

process.stdout.write('en-transaccion\n')
// Mantiene el proceso vivo con la transacción abierta hasta que lo maten.
setInterval(() => {}, 1 << 30)
