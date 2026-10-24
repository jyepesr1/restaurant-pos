import type { ControlAcceso } from '../hub/hub'

/** Control de acceso que deja pasar todo: para probar la sincronización sola. */
export const accesoLibre: ControlAcceso = {
  verificar: () => ({ ok: true, autorizadoPorId: null, autorizacionId: null }),
  registrarUso: () => {},
}
