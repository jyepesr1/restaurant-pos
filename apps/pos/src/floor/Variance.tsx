import { pesos } from '../ui/format'
import { Label } from '../ui/Label'

// The cash variance of a register close, shared by the register and the reports.

/** «Cuadra», «Sobran $X» or «Faltan $X», with its icon. */
export function Variance({ value }: { value: number }) {
  if (value === 0)
    return (
      <Label tone="free" icon="check">
        Cuadra
      </Label>
    )
  return value > 0 ? (
    <Label tone="progress" icon="more">
      {`Sobran ${pesos(value)}`}
    </Label>
  ) : (
    <Label tone="warning" icon="minus">
      {`Faltan ${pesos(-value)}`}
    </Label>
  )
}
