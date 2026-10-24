// Tarea 0.7: el comprobante de supervisor queda atado al contenido exacto del evento que se
// autorizó y a la sesión que lo pidió (ADR-008). Sin datos previos que conservar: la tabla
// estaba vacía hasta esta tarea, pero la columna lleva un valor por defecto por si acaso.

export const sql = `
ALTER TABLE autorizacion ADD COLUMN contenido_hash TEXT NOT NULL DEFAULT '';
ALTER TABLE autorizacion ADD COLUMN sesion_id TEXT NOT NULL DEFAULT '';
`
