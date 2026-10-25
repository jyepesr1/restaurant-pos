import { describe, expect, it } from 'vitest'
import { montarAcceso } from './montaje'
import { montarApi } from './montaje-api'
import { contrasenaCoincide, huellaContrasena, normalizarUsuario } from './secretos'

// Contraseñas y usuarios con textos difíciles: Unicode (NFC/NFD), muy largos, vacíos, con espacios
// y mayúsculas. Lo que se guarda y lo que se escribe al entrar deben coincidir sin sorpresas.

const entrar = (m: ReturnType<typeof montarAcceso>, usuario: string, contrasena: string, n = 1) =>
  m.acceso.entrar({ usuario, contrasena }, null, `10.0.0.${n}`)

describe('contraseñas con Unicode', () => {
  const NFC = 'contraseña-ñandú-ñ'
  const NFD = NFC.normalize('NFD')

  it('la misma contraseña escrita en NFC o NFD entra igual, la guarde como la guarde', () => {
    expect(NFC).not.toBe(NFD)
    for (const [guardada, escrita] of [
      [NFC, NFD],
      [NFD, NFC],
      [NFC, NFC],
      [NFD, NFD],
    ] as const) {
      const m = montarAcceso()
      m.acceso.crearUsuario({
        nombre: 'Rosa',
        rolId: m.roles.cajero,
        usuario: 'rosa',
        contrasena: guardada,
      })
      expect(entrar(m, 'rosa', escrita), `${guardada.length} -> ${escrita.length}`).toMatchObject({
        ok: true,
      })
    }
  })

  it('mayúsculas y minúsculas en la contraseña SÍ se distinguen', () => {
    const m = montarAcceso()
    m.acceso.crearUsuario({
      nombre: 'Rosa',
      rolId: m.roles.cajero,
      usuario: 'rosa',
      contrasena: 'ClaveSecreta1',
    })
    expect(entrar(m, 'rosa', 'clavesecreta1')).toMatchObject({ ok: false })
    expect(entrar(m, 'rosa', 'CLAVESECRETA1', 2)).toMatchObject({ ok: false })
    expect(entrar(m, 'rosa', 'ClaveSecreta1', 3)).toMatchObject({ ok: true })
  })

  it('emoji, escrituras no latinas, espacios al inicio y al final y caracteres de control se guardan y sirven tal cual', () => {
    const raras = [
      '🔑🔑🔑🔑🔑🔑🔑🔑',
      '密码密码密码密码密码',
      'пароль-пароль',
      '  con espacios  ',
      'tab\tinterno\ty\nsalto',
      'nulo\u0000dentro-xx',
      '​cero​ancho​1',
      'a'.repeat(8),
    ]
    for (const [i, clave] of raras.entries()) {
      const m = montarAcceso()
      m.acceso.crearUsuario({
        nombre: 'Rosa',
        rolId: m.roles.cajero,
        usuario: 'rosa',
        contrasena: clave,
      })
      expect(entrar(m, 'rosa', clave, i + 1), JSON.stringify(clave)).toMatchObject({ ok: true })
      // Sin los espacios de los lados NO es la misma contraseña: no se recorta.
      if (clave !== clave.trim())
        expect(entrar(m, 'rosa', clave.trim(), 99)).toMatchObject({ ok: false })
    }
  })

  it('«ﬁ» (ligadura), «Å» (angstrom) y «Ⅷ» no se confunden con sus parecidos: NFC no los une', () => {
    // NFC, no NFKC: «ﬁlete-seguro» y «filete-seguro» son contraseñas distintas.
    const m = montarAcceso()
    m.acceso.crearUsuario({
      nombre: 'Rosa',
      rolId: m.roles.cajero,
      usuario: 'rosa',
      contrasena: 'ﬁlete-seguro',
    })
    expect(entrar(m, 'rosa', 'filete-seguro')).toMatchObject({ ok: false })
    expect(entrar(m, 'rosa', 'ﬁlete-seguro', 2)).toMatchObject({ ok: true })
  })

  it('una contraseña con medio emoji (sustituto suelto) no tumba al hub: entra o falla, pero no lanza', () => {
    const m = montarAcceso()
    const suelta = 'clave-\ud83d-suelta'
    expect(() =>
      m.acceso.crearUsuario({
        nombre: 'Rosa',
        rolId: m.roles.cajero,
        usuario: 'rosa',
        contrasena: suelta,
      }),
    ).not.toThrow()
    expect(() => entrar(m, 'rosa', suelta)).not.toThrow()
    expect(() => entrar(m, 'rosa', 'otra-\ud83d-clave', 2)).not.toThrow()
  })

  // Lo encontró qa-pruebas en la 1.3b y ya está corregido: el largo mínimo (8) se mide en unidades UTF-16 de la contraseña tal como se
  // escribió, antes de normalizar a NFC (secretos.ts `esContrasenaValida`, servicio.ts
  // `fijarContrasena`). Siete letras «ñ» sueltas en NFD miden 14 y pasan, aunque son 7 caracteres;
  // las mismas siete en NFC miden 7 y se rechazan. La regla depende de cómo escribe el teclado.
  it('el mínimo de 8 caracteres es el mismo para NFC y NFD', () => {
    const m = montarAcceso()
    const siete = 'ñññññññ'
    const crear = (c: string, usuario: string) => () =>
      m.acceso.crearUsuario({ nombre: 'Rosa', rolId: m.roles.cajero, usuario, contrasena: c })
    expect(crear(siete, 'rosa1')).toThrow(/al menos 8/)
    expect(crear(siete.normalize('NFD'), 'rosa2')).toThrow(/al menos 8/)
  })

  it('el mínimo y el máximo exactos: 7 no, 8 sí; 200 sí, 201 no', () => {
    const m = montarAcceso()
    const crear = (c: string, usuario: string) => () =>
      m.acceso.crearUsuario({ nombre: 'Rosa', rolId: m.roles.cajero, usuario, contrasena: c })
    expect(crear('1234567', 'uno')).toThrow(/al menos 8/)
    expect(crear('12345678', 'dos')).not.toThrow()
    expect(crear('x'.repeat(200), 'tres')).not.toThrow()
    expect(crear('x'.repeat(201), 'cuatro')).toThrow(/al menos 8/)
    expect(crear('', 'cinco')).toThrow(/al menos 8/)
  })

  it('un fallo al fijar la contraseña no deja a la persona creada a medias', () => {
    const m = montarAcceso()
    const antes = Number(m.db.prepare('SELECT count(*) AS n FROM usuario').get()?.n)
    expect(() =>
      m.acceso.crearUsuario({
        nombre: 'Rosa',
        rolId: m.roles.cajero,
        usuario: 'rosa',
        contrasena: 'corta',
      }),
    ).toThrow()
    expect(Number(m.db.prepare('SELECT count(*) AS n FROM usuario').get()?.n)).toBe(antes)
    expect(
      Number(
        m.db
          .prepare("SELECT count(*) AS n FROM usuario_credencial WHERE nombre_usuario = 'rosa'")
          .get()?.n,
      ),
    ).toBe(0)
  })
})

describe('contraseñas muy largas o vacías al entrar', () => {
  function conRosa() {
    const m = montarAcceso()
    m.acceso.crearUsuario({
      nombre: 'Rosa',
      rolId: m.roles.cajero,
      usuario: 'rosa',
      contrasena: 'clave-correcta-1',
    })
    return m
  }

  it('vacía: falla como cualquier contraseña errada y cuenta como intento', () => {
    const m = conRosa()
    for (let i = 1; i <= 3; i++)
      expect(entrar(m, 'rosa', '', i)).toMatchObject({
        ok: false,
        codigo: 'credenciales_incorrectas',
      })
    expect(entrar(m, 'rosa', 'clave-correcta-1', 9)).toMatchObject({ ok: false, codigo: 'espera' })
  })

  it('de un megabyte: falla sin colgar al hub ni lanzar', () => {
    const m = conRosa()
    const r = entrar(m, 'rosa', 'a'.repeat(1_000_000))
    expect(r).toMatchObject({ ok: false, codigo: 'credenciales_incorrectas' })
  })

  it('la API corta lo que pasa de 200 con 400, sin contar como fallo ni tocar la cuenta', async () => {
    const api = montarApi()
    for (const largo of [201, 1000, 100_000]) {
      const r = await api.post('/api/entrar', {
        usuario: api.admin().usuario,
        contrasena: 'a'.repeat(largo),
      })
      expect(r.statusCode).toBe(400)
    }
    // Ni un fallo anotado: la contraseña buena entra de inmediato.
    expect((await api.post('/api/entrar', api.admin())).statusCode).toBe(201)
  })

  // Lo encontró qa-pruebas en la 1.3b y ya está corregido: `conContrasena` (servicio.ts) recorta lo escrito a 200 caracteres antes de
  // comparar (`contrasena.slice(0, 200)`). Quien llama al servicio sin pasar por la API (o una
  // ruta futura sin el límite de zod) entra con la contraseña de 200 caracteres más cualquier
  // cola. Esperaba rechazarla: una contraseña más larga que el máximo no puede ser la guardada.
  it('contraseña de 200 caracteres más una cola no entra', () => {
    const m = montarAcceso()
    const clave = 'k'.repeat(200)
    m.acceso.crearUsuario({
      nombre: 'Rosa',
      rolId: m.roles.cajero,
      usuario: 'rosa',
      contrasena: clave,
    })
    expect(entrar(m, 'rosa', clave)).toMatchObject({ ok: true })
    expect(entrar(m, 'rosa', `${clave}-cola-que-no-es-parte`, 2)).toMatchObject({ ok: false })
  })

  it('la huella de una contraseña vacía nunca coincide con una guardada ni lanza', () => {
    const huella = huellaContrasena('algo-correcto', 1)
    expect(contrasenaCoincide('', huella)).toBe(false)
    expect(contrasenaCoincide('algo-correcto', '')).toBe(false)
    expect(contrasenaCoincide('algo-correcto', 'scrypt$1$8$1$$')).toBe(false)
    expect(contrasenaCoincide('algo-correcto', 'scrypt$99$8$1$AAAA$AAAA')).toBe(false)
    expect(contrasenaCoincide('algo-correcto', 'md5$1$8$1$AAAA$AAAA')).toBe(false)
    expect(contrasenaCoincide('algo-correcto', huella.replace(/\$\d+\$/, '$0$'))).toBe(false)
  })

  it('dos huellas de la misma contraseña son distintas (sal), y ambas la aceptan', () => {
    const a = huellaContrasena('misma-clave-1', 1)
    const b = huellaContrasena('misma-clave-1', 1)
    expect(a).not.toBe(b)
    expect(contrasenaCoincide('misma-clave-1', a)).toBe(true)
    expect(contrasenaCoincide('misma-clave-1', b)).toBe(true)
  })

  it('en la base queda solo la huella: la contraseña no está en ningún lugar', () => {
    const m = conRosa()
    for (const t of ['usuario_credencial', 'usuario', 'sesion']) {
      const filas = JSON.stringify(m.db.prepare(`SELECT * FROM ${t}`).all())
      expect(filas).not.toContain('clave-correcta-1')
    }
    expect(
      m.db
        .prepare(
          "SELECT contrasena_huella AS h FROM usuario_credencial WHERE nombre_usuario = 'rosa'",
        )
        .get()?.h,
    ).toMatch(/^scrypt\$1\$8\$1\$/)
  })
})

describe('usuario con mayúsculas, espacios y otros disfraces', () => {
  it('el usuario se guarda en minúsculas y sin espacios a los lados, y entra con cualquier forma', () => {
    const m = montarAcceso()
    m.acceso.crearUsuario({
      nombre: 'Rosa',
      rolId: m.roles.cajero,
      usuario: '  RoSa.Perez  ',
      contrasena: 'clave-correcta-1',
    })
    expect(
      m.db
        .prepare(
          "SELECT nombre_usuario AS u FROM usuario_credencial WHERE nombre_usuario LIKE 'rosa%'",
        )
        .get()?.u,
    ).toBe('rosa.perez')
    let n = 0
    for (const escrito of [
      'rosa.perez',
      'ROSA.PEREZ',
      'Rosa.Perez',
      ' rosa.perez',
      'rosa.perez  ',
      '\trosa.perez\n',
      ' rosa.perez ',
      '﻿rosa.perez',
    ])
      expect(entrar(m, escrito, 'clave-correcta-1', ++n), JSON.stringify(escrito)).toMatchObject({
        ok: true,
      })
  })

  it('espacios o puntos en el medio, tildes y caracteres raros no son un usuario válido (ni al crear ni al entrar)', () => {
    for (const malo of [
      'ro sa',
      'rosa!',
      'ro/sa',
      'ro\\sa',
      'rosa@x.co',
      'ab',
      'a'.repeat(41),
      '',
      '   ',
      'ｒｏｓａ',
      'ro\u0000sa',
      "ro'sa",
      'rosa;--',
    ]) {
      expect(normalizarUsuario(malo), JSON.stringify(malo)).toBeNull()
      const m = montarAcceso()
      expect(() =>
        m.acceso.crearUsuario({
          nombre: 'Rosa',
          rolId: m.roles.cajero,
          usuario: malo,
          contrasena: 'clave-correcta-1',
        }),
      ).toThrow(/3 a 40/)
    }
  })

  it('la mayúscula no crea un segundo usuario: «Rosa» y «rosa» chocan', () => {
    const m = montarAcceso()
    m.acceso.crearUsuario({
      nombre: 'Rosa',
      rolId: m.roles.cajero,
      usuario: 'rosa',
      contrasena: 'clave-correcta-1',
    })
    expect(() =>
      m.acceso.crearUsuario({
        nombre: 'Otra',
        rolId: m.roles.cajero,
        usuario: ' ROSA ',
        contrasena: 'clave-correcta-2',
      }),
    ).toThrow(/Ya hay alguien con el usuario «rosa»/)
  })

  it('la espera por cuenta es la misma escriban «ADMIN», «admin» o « Admin »', () => {
    const m = montarAcceso()
    const usuario = m.personas.admin.usuario as string
    const escritos = [usuario.toUpperCase(), usuario, ` ${usuario} `]
    for (const [i, u] of escritos.entries())
      expect(entrar(m, u, 'mala-clave-xx', i + 1)).toMatchObject({
        codigo: 'credenciales_incorrectas',
      })
    expect(entrar(m, usuario, 'mala-clave-xx', 9)).toMatchObject({ codigo: 'espera' })
  })

  it('el signo Kelvin (K) se pliega a «k» al normalizar: entra igual que la letra normal, sin abrir otra cuenta', () => {
    const m = montarAcceso()
    m.acceso.crearUsuario({
      nombre: 'Kira',
      rolId: m.roles.cajero,
      usuario: 'kira',
      contrasena: 'clave-correcta-1',
    })
    expect(normalizarUsuario('Kira')).toBe('kira')
    expect(entrar(m, 'Kira', 'clave-correcta-1')).toMatchObject({ ok: true })
    // Y crear «Kira» con el signo Kelvin choca con la existente en vez de duplicarla.
    expect(() =>
      m.acceso.crearUsuario({
        nombre: 'Falsa',
        rolId: m.roles.cajero,
        usuario: 'Kira',
        contrasena: 'clave-correcta-2',
      }),
    ).toThrow(/Ya hay alguien/)
  })

  it('las tildes se pliegan: «José», «JOSÉ» y «jose» (en NFC o NFD) son el mismo usuario', () => {
    const m = montarAcceso()
    m.acceso.crearUsuario({
      nombre: 'José',
      rolId: m.roles.cajero,
      usuario: 'José',
      contrasena: 'clave-correcta-1',
    })
    expect(normalizarUsuario('Ñandú')).toBe('nandu')
    let n = 0
    for (const escrito of ['jose', 'JOSÉ', 'José', 'Jose\u0301', ' josé '])
      expect(entrar(m, escrito, 'clave-correcta-1', ++n), JSON.stringify(escrito)).toMatchObject({
        ok: true,
      })
    expect(() =>
      m.acceso.crearUsuario({
        nombre: 'Otro',
        rolId: m.roles.cajero,
        usuario: 'jose',
        contrasena: 'clave-correcta-2',
      }),
    ).toThrow(/Ya hay alguien/)
  })

  it('un usuario de 40 caracteres justos sirve; de 41, no; de 3, sí; de 2, no', () => {
    expect(normalizarUsuario('a'.repeat(40))).toBe('a'.repeat(40))
    expect(normalizarUsuario('a'.repeat(41))).toBeNull()
    expect(normalizarUsuario('abc')).toBe('abc')
    expect(normalizarUsuario('ab')).toBeNull()
    expect(normalizarUsuario('a.b-c_9')).toBe('a.b-c_9')
  })

  it('por la API, el usuario con mayúsculas y espacios entra y la respuesta trae el nombre real', async () => {
    const api = montarApi()
    const r = await api.post('/api/entrar', {
      usuario: `  ${(api.personas.admin.usuario as string).toUpperCase()}  `,
      contrasena: api.admin().contrasena,
    })
    expect(r.statusCode).toBe(201)
    expect(r.json().usuario.nombre).toBe('Administrador')
  })
})
