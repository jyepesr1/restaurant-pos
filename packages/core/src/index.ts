export { firmarEvento, huellaAutorizable, igualesSinFiltrarTiempo } from './acceso/firma'
export {
  type ClaveRol,
  DESCRIPCION_PERMISOS,
  esPermiso,
  PERMISOS,
  PERMISOS_CON_CONTRASENA,
  PERMISOS_DE_COBRO,
  PERMISOS_PANTALLA,
  type Permiso,
  permisoPara,
  ROLES_DE_FABRICA,
  ROLES_RETIRADOS,
  SOLO_DESDE_CAJA,
} from './acceso/permisos'
export { jsonCanonico, PROFUNDIDAD_MAXIMA } from './canonico'
export {
  type CategoriaCarta,
  CON_SABOR,
  CON_TERMINO,
  convertirCarta,
  type Estacion,
  type GrupoCarta,
  type ProductoCarta,
  reglasSinPlato,
  TERMINO,
} from './catalogo/carta'
export { ConfigRestaurante, configCompleta, MARCAS } from './config'
export * from './dinero'
export * from './eventos/comun'
export {
  Aceptacion,
  agregadoDe,
  CopiaItem,
  type DatosAceptacion,
  type EventoAplicable,
  type EventoNuevo,
  type EventoPedido,
  EventoPedidoNuevo,
  type ResultadoValidacion,
  TIPOS_CON_MOTIVO,
  TIPOS_EVENTO_PEDIDO,
  TIPOS_EVENTO_PRODUCTO,
  type TipoEventoPedido,
  validarEventoNuevo,
} from './eventos/pedido'
export { esIdValido, nuevoId } from './id'
export {
  afectaAPedido,
  aplicarEvento,
  type Problema,
  type Resultado,
  reconstruir,
  type TipoProblema,
} from './pedido/aplicar'
export type {
  Cuenta,
  DescuentoPedido,
  EstadoItem,
  EstadoPedido,
  ItemPedido,
  ModificadorItem,
  Pago,
} from './pedido/estado'
export {
  descuentoDeItem,
  precioUnidad,
  saldoCuenta,
  type TotalesItem,
  type TotalesPedido,
  tienePagosVigentes,
  totalesItem,
  totalesPedido,
} from './pedido/totales'
export { diaOperativo } from './tiempo'
