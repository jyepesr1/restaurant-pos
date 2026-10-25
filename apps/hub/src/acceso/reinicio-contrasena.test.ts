import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { hubEnCarpeta } from './montaje-hub'
import { ARCHIVO_CLAVE, cargarClave } from './secretos'
import { ServicioAcceso } from './servicio'

// Reinicio del hub y clave de los PIN perdida (ADR-008, ADR-013): las contraseñas no dependen de
// la clave; los PIN sí, y se regeneran.

describe('contraseñas tras reiniciar el hub o perder la clave de los PIN', () => {
  let carpeta = ''
  let hubs: ReturnType<typeof hubEnCarpeta>
  beforeEach(() => {
    carpeta = mkdtempSync(join(tmpdir(), 'pos-reinicio-clave-'))
    hubs = hubEnCarpeta(join(carpeta, 'datos'))
  })
  afterEach(() => {
    hubs.apagar()
    rmSync(carpeta, { recursive: true, force: true })
  })

  function conGente() {
    const h = hubs.levantar()
    const cajero = h.acceso.crearUsuario({
      nombre: 'Carlos',
      rolId: h.roles.cajero,
      usuario: 'carlos',
      contrasena: 'clave-de-carlos',
    })
    const reportes = h.acceso.crearUsuario({
      nombre: 'Rita',
      rolId: h.roles.reportes,
      usuario: 'rita',
      contrasena: 'clave-de-rita-1',
    })
    const ana = h.acceso.crearUsuario({ nombre: 'Ana', rolId: h.roles.mesero })
    return { h, cajero, reportes, ana }
  }

  const entra = (h: ReturnType<typeof hubs.levantar>, usuario: string, contrasena: string, n = 1) =>
    h.acceso.entrar({ usuario, contrasena }, null, `10.0.0.${n}`)

  it('con la clave perdida, todos los que entran con contraseña siguen entrando (admin, cajero y reportes)', () => {
    const { h } = conGente()
    const admin = { usuario: h.admin.usuario as string, contrasena: h.admin.contrasena as string }
    hubs.apagar()
    rmSync(join(carpeta, 'datos', ARCHIVO_CLAVE))

    const d = hubs.levantar()
    expect(d.claveNueva).toBe(true)
    expect(entra(d, admin.usuario, admin.contrasena, 1)).toMatchObject({ ok: true })
    expect(entra(d, 'carlos', 'clave-de-carlos', 2)).toMatchObject({
      ok: true,
      usuario: { nombre: 'Carlos' },
    })
    expect(entra(d, 'rita', 'clave-de-rita-1', 3)).toMatchObject({
      ok: true,
      usuario: { nombre: 'Rita' },
    })
    // El administrador recibió un PIN nuevo para autorizar y no se le dio otra contraseña.
    expect(d.admin.pin).toMatch(/^\d{4}$/)
    expect(d.admin.contrasena).toBeNull()
    expect(d.admin.avisos.join(' ')).toMatch(/clave de los PIN/)
  })

  it('con la clave perdida, el PIN del mesero y el de autorizar del cajero dejan de servir hasta regenerarlos', () => {
    const { h, cajero, ana } = conGente()
    hubs.apagar()
    rmSync(join(carpeta, 'datos', ARCHIVO_CLAVE))
    const d = hubs.levantar()
    expect(d.acceso.entrar({ pin: ana.pin }, null, '10.0.1.1')).toMatchObject({
      ok: false,
      codigo: 'pin_incorrecto',
    })

    // El administrador regenera el de Ana (entra) y el del cajero (autoriza).
    const pinAna = d.acceso.regenerarPin(ana.usuarioId)
    const pinCarlos = d.acceso.regenerarPin(cajero.usuarioId)
    const sesionAna = d.acceso.entrar({ pin: pinAna }, null, '10.0.1.2')
    if (!sesionAna.ok || !sesionAna.equipo) throw new Error('Ana no entró')
    const conexion = d.acceso.autenticar(sesionAna.equipo.token) as never
    const viejo = d.acceso.autorizar(conexion, {
      sesionId: sesionAna.sesionId,
      secreto: sesionAna.secreto,
      pin: cajero.pin,
      accion: 'anular_item_enviado',
      agregadoId: '0'.repeat(26),
      eventoId: '1'.repeat(26),
      huella: 'a'.repeat(64),
    })
    if (cajero.pin !== pinCarlos) expect(viejo).toMatchObject({ ok: false })
    const nuevo = d.acceso.autorizar(conexion, {
      sesionId: sesionAna.sesionId,
      secreto: sesionAna.secreto,
      pin: pinCarlos,
      accion: 'anular_item_enviado',
      agregadoId: '0'.repeat(26),
      eventoId: '2'.repeat(26),
      huella: 'b'.repeat(64),
    })
    expect(nuevo).toMatchObject({ ok: true, supervisor: { nombre: 'Carlos' } })
    void h
  })

  it('la clave perdida no cambia nada de las contraseñas guardadas: las huellas siguen idénticas', () => {
    const { h } = conGente()
    const huellas = () =>
      JSON.stringify(
        h.db
          .prepare(
            'SELECT usuario_id, nombre_usuario, contrasena_huella FROM usuario_credencial ORDER BY usuario_id',
          )
          .all(),
      )
    const antes = huellas()
    hubs.apagar()
    rmSync(join(carpeta, 'datos', ARCHIVO_CLAVE))
    const d = hubs.levantar()
    expect(
      JSON.stringify(
        d.db
          .prepare(
            'SELECT usuario_id, nombre_usuario, contrasena_huella FROM usuario_credencial ORDER BY usuario_id',
          )
          .all(),
      ),
    ).toBe(antes)
  })

  it('reiniciar muchas veces sin perder la clave: las contraseñas y el administrador siguen y no aparece uno nuevo', () => {
    conGente()
    for (let i = 0; i < 4; i++) {
      hubs.apagar()
      const d = hubs.levantar()
      expect(d.claveNueva).toBe(false)
      expect(d.admin).toEqual({ pin: null, usuario: null, contrasena: null, avisos: [] })
      expect(entra(d, 'carlos', 'clave-de-carlos', i + 1)).toMatchObject({ ok: true })
    }
    const d = hubs.levantar()
    expect(
      Number(
        d.db.prepare("SELECT count(*) AS n FROM usuario WHERE nombre = 'Administrador'").get()?.n,
      ),
    ).toBe(1)
  })

  it('una contraseña guardada con un costo sigue sirviendo si el hub cambia el costo para las nuevas', () => {
    const { h } = conGente()
    const { clave } = cargarClave(join(carpeta, 'datos'))
    const mas_caro = new ServicioAcceso({
      db: h.db,
      restauranteId: h.restauranteId,
      clave,
      costoContrasena: 6,
    })
    expect(
      mas_caro.entrar({ usuario: 'carlos', contrasena: 'clave-de-carlos' }, null, '10.0.2.1'),
    ).toMatchObject({ ok: true })
    // Las nuevas se guardan con el costo nuevo, y conviven con las viejas.
    const nueva = mas_caro.crearUsuario({
      nombre: 'Nueva',
      rolId: h.roles.reportes,
      usuario: 'nueva',
      contrasena: 'clave-de-nueva-1',
    })
    expect(
      h.db
        .prepare('SELECT contrasena_huella AS h FROM usuario_credencial WHERE usuario_id = ?')
        .get(nueva.usuarioId)?.h,
    ).toMatch(/^scrypt\$6\$/)
    expect(
      mas_caro.entrar({ usuario: 'nueva', contrasena: 'clave-de-nueva-1' }, null, '10.0.2.2'),
    ).toMatchObject({ ok: true })
    expect(
      h.acceso.entrar({ usuario: 'nueva', contrasena: 'clave-de-nueva-1' }, null, '10.0.2.3'),
    ).toMatchObject({ ok: true })
  })

  it('los fallos de contraseña se olvidan al reiniciar (la espera vive en memoria): el aviso al administrador no', () => {
    const { h } = conGente()
    for (let i = 0; i < 4; i++) entra(h, 'carlos', `mala-clave-${i}`, i + 1)
    expect(entra(h, 'carlos', 'clave-de-carlos', 9)).toMatchObject({ ok: false, codigo: 'espera' })
    hubs.apagar()
    const d = hubs.levantar()
    expect(entra(d, 'carlos', 'clave-de-carlos', 9)).toMatchObject({ ok: true })
  })
})
