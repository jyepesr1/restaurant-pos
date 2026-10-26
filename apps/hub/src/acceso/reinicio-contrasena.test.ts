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
    hubs = hubEnCarpeta(join(carpeta, 'data'))
  })
  afterEach(() => {
    hubs.apagar()
    rmSync(carpeta, { recursive: true, force: true })
  })

  function conGente() {
    const h = hubs.spinUp()
    const cashier = h.access.crearUsuario({
      name: 'Carlos',
      rolId: h.roles.cashier,
      user: 'carlos',
      password: 'clave-de-carlos',
    })
    const reports = h.access.crearUsuario({
      name: 'Rita',
      rolId: h.roles.reports,
      user: 'rita',
      password: 'clave-de-rita-1',
    })
    const ana = h.access.crearUsuario({ name: 'Ana', rolId: h.roles.waiter })
    return { h, cashier, reports, ana }
  }

  const entra = (h: ReturnType<typeof hubs.spinUp>, user: string, password: string, n = 1) =>
    h.access.entrar({ user, password }, null, `10.0.0.${n}`)

  it('con la clave perdida, todos los que entran con contraseña siguen entrando (admin, cajero y reportes)', () => {
    const { h } = conGente()
    const admin = { user: h.admin.user as string, password: h.admin.password as string }
    hubs.apagar()
    rmSync(join(carpeta, 'data', ARCHIVO_CLAVE))

    const d = hubs.spinUp()
    expect(d.claveNueva).toBe(true)
    expect(entra(d, admin.user, admin.password, 1)).toMatchObject({ ok: true })
    expect(entra(d, 'carlos', 'clave-de-carlos', 2)).toMatchObject({
      ok: true,
      user: { name: 'Carlos' },
    })
    expect(entra(d, 'rita', 'clave-de-rita-1', 3)).toMatchObject({
      ok: true,
      user: { name: 'Rita' },
    })
    // El administrador recibió un PIN nuevo para autorizar y no se le dio otra contraseña.
    expect(d.admin.pin).toMatch(/^\d{4}$/)
    expect(d.admin.password).toBeNull()
    expect(d.admin.avisos.join(' ')).toMatch(/clave de los PIN/)
  })

  it('con la clave perdida, el PIN del mesero y el de autorizar del cajero dejan de servir hasta regenerarlos', () => {
    const { h, cashier, ana } = conGente()
    hubs.apagar()
    rmSync(join(carpeta, 'data', ARCHIVO_CLAVE))
    const d = hubs.spinUp()
    expect(d.access.entrar({ pin: ana.pin }, null, '10.0.1.1')).toMatchObject({
      ok: false,
      code: 'wrong_pin',
    })

    // El administrador regenera el de Ana (entra) y el del cajero (autoriza).
    const pinAna = d.access.regenerarPin(ana.userId)
    const pinCarlos = d.access.regenerarPin(cashier.userId)
    const sesionAna = d.access.entrar({ pin: pinAna }, null, '10.0.1.2')
    if (!sesionAna.ok || !sesionAna.device) throw new Error('Ana no entró')
    const connection = d.access.authenticate(sesionAna.device.token) as never
    const oldOne = d.access.autorizar(connection, {
      sesionId: sesionAna.sesionId,
      secret: sesionAna.secret,
      pin: cashier.pin,
      action: 'void_sent_item',
      agregadoId: '0'.repeat(26),
      eventId: '1'.repeat(26),
      fingerprint: 'a'.repeat(64),
    })
    if (cashier.pin !== pinCarlos) expect(oldOne).toMatchObject({ ok: false })
    const fresh = d.access.autorizar(connection, {
      sesionId: sesionAna.sesionId,
      secret: sesionAna.secret,
      pin: pinCarlos,
      action: 'void_sent_item',
      agregadoId: '0'.repeat(26),
      eventId: '2'.repeat(26),
      fingerprint: 'b'.repeat(64),
    })
    expect(fresh).toMatchObject({ ok: true, supervisor: { name: 'Carlos' } })
    void h
  })

  it('la clave perdida no cambia nada de las contraseñas guardadas: las huellas siguen idénticas', () => {
    const { h } = conGente()
    const huellas = () =>
      JSON.stringify(
        h.db
          .prepare('SELECT user_id, username, password_hash FROM user_credentials ORDER BY user_id')
          .all(),
      )
    const before = huellas()
    hubs.apagar()
    rmSync(join(carpeta, 'data', ARCHIVO_CLAVE))
    const d = hubs.spinUp()
    expect(
      JSON.stringify(
        d.db
          .prepare('SELECT user_id, username, password_hash FROM user_credentials ORDER BY user_id')
          .all(),
      ),
    ).toBe(before)
  })

  it('reiniciar muchas veces sin perder la clave: las contraseñas y el administrador siguen y no aparece uno nuevo', () => {
    conGente()
    for (let i = 0; i < 4; i++) {
      hubs.apagar()
      const d = hubs.spinUp()
      expect(d.claveNueva).toBe(false)
      expect(d.admin).toEqual({ pin: null, user: null, password: null, avisos: [] })
      expect(entra(d, 'carlos', 'clave-de-carlos', i + 1)).toMatchObject({ ok: true })
    }
    const d = hubs.spinUp()
    expect(
      Number(d.db.prepare("SELECT count(*) AS n FROM users WHERE name = 'Administrador'").get()?.n),
    ).toBe(1)
  })

  it('una contraseña guardada con un costo sigue sirviendo si el hub cambia el costo para las nuevas', () => {
    const { h } = conGente()
    const { key } = cargarClave(join(carpeta, 'data'))
    const mas_caro = new ServicioAcceso({
      db: h.db,
      restauranteId: h.restauranteId,
      key,
      costoContrasena: 6,
    })
    expect(
      mas_caro.entrar({ user: 'carlos', password: 'clave-de-carlos' }, null, '10.0.2.1'),
    ).toMatchObject({ ok: true })
    // Las nuevas se guardan con el costo nuevo, y conviven con las viejas.
    const newOne = mas_caro.crearUsuario({
      name: 'Nueva',
      rolId: h.roles.reports,
      user: 'nueva',
      password: 'clave-de-nueva-1',
    })
    expect(
      h.db
        .prepare('SELECT password_hash AS h FROM user_credentials WHERE user_id = ?')
        .get(newOne.userId)?.h,
    ).toMatch(/^scrypt\$6\$/)
    expect(
      mas_caro.entrar({ user: 'nueva', password: 'clave-de-nueva-1' }, null, '10.0.2.2'),
    ).toMatchObject({ ok: true })
    expect(
      h.access.entrar({ user: 'nueva', password: 'clave-de-nueva-1' }, null, '10.0.2.3'),
    ).toMatchObject({ ok: true })
  })

  it('los fallos de contraseña se olvidan al reiniciar (la espera vive en memoria): el aviso al administrador no', () => {
    const { h } = conGente()
    for (let i = 0; i < 4; i++) entra(h, 'carlos', `mala-clave-${i}`, i + 1)
    expect(entra(h, 'carlos', 'clave-de-carlos', 9)).toMatchObject({ ok: false, code: 'wait' })
    hubs.apagar()
    const d = hubs.spinUp()
    expect(entra(d, 'carlos', 'clave-de-carlos', 9)).toMatchObject({ ok: true })
  })
})
