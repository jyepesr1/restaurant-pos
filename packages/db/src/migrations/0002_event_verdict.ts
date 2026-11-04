// The hub's verdict on an event (task 1.7b, docs/SYNC.md#rechazos-cuarentena-y-conflictos): 1 if
// it saved it as a conflict its order does not apply (an order already closed, an item already
// voided…), so its money counts nowhere. Every event saved before this migration stays at 0: it
// reads back exactly as it was saved, and closings and Z reports of that history reprint the same.
// The column is set on insert and never changes: the table's triggers still forbid updates.
export const sql = `
ALTER TABLE events ADD COLUMN unapplied INTEGER NOT NULL DEFAULT 0 CHECK (unapplied IN (0, 1));
`
