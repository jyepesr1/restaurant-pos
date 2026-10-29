import { Button } from '../ui/Button'
import { useNotify } from '../ui/toasts'
import { rulesOf } from './checks'
import { floor, useFloor } from './context'
import { FloorFrame } from './FloorFrame'
import { MAX_DAYS, type Period } from './periods'
import { downloadCsv, ReportsBody, useReports } from './ReportsView'

// Basic reports (task 1.9, docs/KPIS.md): sales, payment methods, waiters, products,
// voids and register closes for a day or a period. Only for whoever has «Ver todos los
// reportes». Everything comes from the hub, calculated with @pos/core; here it is only shown
// (the content is in ReportsView.tsx, shared with the owner's cloud panel).

const fromHub = (p: Period | null) => floor.report(p)
const reprintClose = (shiftId: string) => floor.reprintClose(shiftId)

export function Reports() {
  const notify = useNotify()
  const { catalog, session } = useFloor()
  const rules = rulesOf(catalog)
  const state = useReports(fromHub)
  const { shown } = state

  const download = () => {
    if (!shown) return
    notify(`Descargaste ${downloadCsv(shown, rules, catalog?.restaurant.name ?? '')}`)
  }

  return (
    <FloorFrame
      title="Reportes"
      actions={
        shown && (
          <Button icon="receipt" onClick={download}>
            Descargar CSV
          </Button>
        )
      }
    >
      <div className="mx-auto flex max-w-6xl flex-col gap-4 p-4 md:p-6">
        <ReportsBody
          state={state}
          rules={rules}
          maxDays={MAX_DAYS}
          reprint={{
            onReprint: reprintClose,
            canSelectPrinter: !!session?.permissions.includes('manage_devices'),
          }}
        />
      </div>
    </FloorFrame>
  )
}
