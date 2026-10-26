import type { ControlAcceso } from '../hub/hub'

/** Control de acceso que deja pasar todo: para probar la sincronización sola. */
export const accesoLibre: ControlAcceso = {
  verify: () => ({ ok: true, authorizedById: null, autorizacionId: null }),
  registrarUso: () => {},
}
