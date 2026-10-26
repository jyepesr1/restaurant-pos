import { describe, expect, it } from 'vitest'
import { setupApi } from './api-setup'
import { normalizeUsername, passwordHash, passwordMatches } from './secrets'
import { setupAccess } from './setup'

// Passwords and usernames with tricky text: Unicode (NFC/NFD), very long, empty, with spaces
// and uppercase. What is saved and what is typed when signing in must match with no surprises.

const signIn = (m: ReturnType<typeof setupAccess>, user: string, password: string, n = 1) =>
  m.access.signIn({ user, password }, null, `10.0.0.${n}`)

describe('passwords with Unicode', () => {
  const NFC = 'contraseña-ñandú-ñ'
  const NFD = NFC.normalize('NFD')

  it('the same password typed in NFC or NFD signs in the same, however it was saved', () => {
    expect(NFC).not.toBe(NFD)
    for (const [saved, typed] of [
      [NFC, NFD],
      [NFD, NFC],
      [NFC, NFC],
      [NFD, NFD],
    ] as const) {
      const m = setupAccess()
      m.access.createUser({
        name: 'Rosa',
        roleId: m.roles.cashier,
        user: 'rosa',
        password: saved,
      })
      expect(signIn(m, 'rosa', typed), `${saved.length} -> ${typed.length}`).toMatchObject({
        ok: true,
      })
    }
  })

  it('uppercase and lowercase in the password ARE distinguished', () => {
    const m = setupAccess()
    m.access.createUser({
      name: 'Rosa',
      roleId: m.roles.cashier,
      user: 'rosa',
      password: 'ClaveSecreta1',
    })
    expect(signIn(m, 'rosa', 'clavesecreta1')).toMatchObject({ ok: false })
    expect(signIn(m, 'rosa', 'CLAVESECRETA1', 2)).toMatchObject({ ok: false })
    expect(signIn(m, 'rosa', 'ClaveSecreta1', 3)).toMatchObject({ ok: true })
  })

  it('emoji, non-Latin scripts, leading and trailing spaces and control characters are saved and work as is', () => {
    const oddTexts = [
      '🔑🔑🔑🔑🔑🔑🔑🔑',
      '密码密码密码密码密码',
      'пароль-пароль',
      '  con espacios  ',
      'tab\tinterno\ty\nsalto',
      'nulo\u0000dentro-xx',
      '​cero​ancho​1',
      'a'.repeat(8),
    ]
    for (const [i, key] of oddTexts.entries()) {
      const m = setupAccess()
      m.access.createUser({
        name: 'Rosa',
        roleId: m.roles.cashier,
        user: 'rosa',
        password: key,
      })
      expect(signIn(m, 'rosa', key, i + 1), JSON.stringify(key)).toMatchObject({ ok: true })
      // Without the surrounding spaces it is NOT the same password: it is not trimmed.
      if (key !== key.trim()) expect(signIn(m, 'rosa', key.trim(), 99)).toMatchObject({ ok: false })
    }
  })

  it('«ﬁ» (ligature), «Å» (angstrom) and «Ⅷ» are not confused with their look-alikes: NFC does not merge them', () => {
    // NFC, not NFKC: «ﬁlete-seguro» and «filete-seguro» are different passwords.
    const m = setupAccess()
    m.access.createUser({
      name: 'Rosa',
      roleId: m.roles.cashier,
      user: 'rosa',
      password: 'ﬁlete-seguro',
    })
    expect(signIn(m, 'rosa', 'filete-seguro')).toMatchObject({ ok: false })
    expect(signIn(m, 'rosa', 'ﬁlete-seguro', 2)).toMatchObject({ ok: true })
  })

  it('a password with half an emoji (lone surrogate) does not bring the hub down: it signs in or fails, but does not throw', () => {
    const m = setupAccess()
    const loose = 'clave-\ud83d-suelta'
    expect(() =>
      m.access.createUser({
        name: 'Rosa',
        roleId: m.roles.cashier,
        user: 'rosa',
        password: loose,
      }),
    ).not.toThrow()
    expect(() => signIn(m, 'rosa', loose)).not.toThrow()
    expect(() => signIn(m, 'rosa', 'otra-\ud83d-clave', 2)).not.toThrow()
  })

  // Found by qa-pruebas in 1.3b and already fixed: the minimum length (8) was measured in UTF-16
  // units of the password as typed, before normalizing to NFC (secrets.ts `isValidPassword`,
  // service.ts `setPassword`). Seven loose «ñ» letters in NFD measure 14 and pass, even though
  // they are 7 characters; the same seven in NFC measure 7 and are rejected. The rule depended on
  // how the keyboard types.
  it('the 8-character minimum is the same for NFC and NFD', () => {
    const m = setupAccess()
    const seven = 'ñññññññ'
    const create = (c: string, user: string) => () =>
      m.access.createUser({ name: 'Rosa', roleId: m.roles.cashier, user, password: c })
    expect(create(seven, 'rosa1')).toThrow(/al menos 8/)
    expect(create(seven.normalize('NFD'), 'rosa2')).toThrow(/al menos 8/)
  })

  it('the exact minimum and maximum: 7 no, 8 yes; 200 yes, 201 no', () => {
    const m = setupAccess()
    const create = (c: string, user: string) => () =>
      m.access.createUser({ name: 'Rosa', roleId: m.roles.cashier, user, password: c })
    expect(create('1234567', 'uno')).toThrow(/al menos 8/)
    expect(create('12345678', 'dos')).not.toThrow()
    expect(create('x'.repeat(200), 'tres')).not.toThrow()
    expect(create('x'.repeat(201), 'cuatro')).toThrow(/al menos 8/)
    expect(create('', 'cinco')).toThrow(/al menos 8/)
  })

  it('a failure setting the password does not leave the person half created', () => {
    const m = setupAccess()
    const before = Number(m.db.prepare('SELECT count(*) AS n FROM users').get()?.n)
    expect(() =>
      m.access.createUser({
        name: 'Rosa',
        roleId: m.roles.cashier,
        user: 'rosa',
        password: 'corta',
      }),
    ).toThrow()
    expect(Number(m.db.prepare('SELECT count(*) AS n FROM users').get()?.n)).toBe(before)
    expect(
      Number(
        m.db.prepare("SELECT count(*) AS n FROM user_credentials WHERE username = 'rosa'").get()?.n,
      ),
    ).toBe(0)
  })
})

describe('very long or empty passwords when signing in', () => {
  function withRosa() {
    const m = setupAccess()
    m.access.createUser({
      name: 'Rosa',
      roleId: m.roles.cashier,
      user: 'rosa',
      password: 'clave-correcta-1',
    })
    return m
  }

  it('empty: fails like any wrong password and counts as an attempt', () => {
    const m = withRosa()
    for (let i = 1; i <= 3; i++)
      expect(signIn(m, 'rosa', '', i)).toMatchObject({
        ok: false,
        code: 'invalid_credentials',
      })
    expect(signIn(m, 'rosa', 'clave-correcta-1', 9)).toMatchObject({ ok: false, code: 'wait' })
  })

  it('one megabyte: fails without hanging the hub or throwing', () => {
    const m = withRosa()
    const r = signIn(m, 'rosa', 'a'.repeat(1_000_000))
    expect(r).toMatchObject({ ok: false, code: 'invalid_credentials' })
  })

  it('the API cuts anything over 200 with 400, without counting it as a failure or touching the account', async () => {
    const api = setupApi()
    for (const length of [201, 1000, 100_000]) {
      const r = await api.post('/api/sign-in', {
        user: api.admin().user,
        password: 'a'.repeat(length),
      })
      expect(r.statusCode).toBe(400)
    }
    // Not a single failure recorded: the right password signs in immediately.
    expect((await api.post('/api/sign-in', api.admin())).statusCode).toBe(201)
  })

  // Found by qa-pruebas in 1.3b and already fixed: `withPassword` (service.ts) cut what was typed
  // to 200 characters before comparing (`password.slice(0, 200)`). Whoever calls the service
  // without going through the API (or a future route without the zod limit) signed in with the
  // 200-character password plus any tail. Expected to reject it: a password longer than the
  // maximum cannot be the saved one.
  it('a 200-character password plus a tail does not sign in', () => {
    const m = setupAccess()
    const key = 'k'.repeat(200)
    m.access.createUser({
      name: 'Rosa',
      roleId: m.roles.cashier,
      user: 'rosa',
      password: key,
    })
    expect(signIn(m, 'rosa', key)).toMatchObject({ ok: true })
    expect(signIn(m, 'rosa', `${key}-cola-que-no-es-parte`, 2)).toMatchObject({ ok: false })
  })

  it('the fingerprint of an empty password never matches a saved one and does not throw', () => {
    const fingerprint = passwordHash('algo-correcto', 1)
    expect(passwordMatches('', fingerprint)).toBe(false)
    expect(passwordMatches('algo-correcto', '')).toBe(false)
    expect(passwordMatches('algo-correcto', 'scrypt$1$8$1$$')).toBe(false)
    expect(passwordMatches('algo-correcto', 'scrypt$99$8$1$AAAA$AAAA')).toBe(false)
    expect(passwordMatches('algo-correcto', 'md5$1$8$1$AAAA$AAAA')).toBe(false)
    expect(passwordMatches('algo-correcto', fingerprint.replace(/\$\d+\$/, '$0$'))).toBe(false)
  })

  it('two fingerprints of the same password are different (salt), and both accept it', () => {
    const a = passwordHash('misma-clave-1', 1)
    const b = passwordHash('misma-clave-1', 1)
    expect(a).not.toBe(b)
    expect(passwordMatches('misma-clave-1', a)).toBe(true)
    expect(passwordMatches('misma-clave-1', b)).toBe(true)
  })

  it('only the fingerprint stays in the database: the password is nowhere', () => {
    const m = withRosa()
    for (const t of ['user_credentials', 'users', 'sessions']) {
      const rows = JSON.stringify(m.db.prepare(`SELECT * FROM ${t}`).all())
      expect(rows).not.toContain('clave-correcta-1')
    }
    expect(
      m.db.prepare("SELECT password_hash AS h FROM user_credentials WHERE username = 'rosa'").get()
        ?.h,
    ).toMatch(/^scrypt\$1\$8\$1\$/)
  })
})

describe('username with uppercase, spaces and other disguises', () => {
  it('the username is saved lowercase and without surrounding spaces, and signs in with any form', () => {
    const m = setupAccess()
    m.access.createUser({
      name: 'Rosa',
      roleId: m.roles.cashier,
      user: '  RoSa.Perez  ',
      password: 'clave-correcta-1',
    })
    expect(
      m.db.prepare("SELECT username AS u FROM user_credentials WHERE username LIKE 'rosa%'").get()
        ?.u,
    ).toBe('rosa.perez')
    let n = 0
    for (const written of [
      'rosa.perez',
      'ROSA.PEREZ',
      'Rosa.Perez',
      ' rosa.perez',
      'rosa.perez  ',
      '\trosa.perez\n',
      ' rosa.perez ',
      '﻿rosa.perez',
    ])
      expect(signIn(m, written, 'clave-correcta-1', ++n), JSON.stringify(written)).toMatchObject({
        ok: true,
      })
  })

  it('spaces or dots in the middle, accents and odd characters are not a valid username (neither on create nor on sign-in)', () => {
    for (const badCase of [
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
      expect(normalizeUsername(badCase), JSON.stringify(badCase)).toBeNull()
      const m = setupAccess()
      expect(() =>
        m.access.createUser({
          name: 'Rosa',
          roleId: m.roles.cashier,
          user: badCase,
          password: 'clave-correcta-1',
        }),
      ).toThrow(/3 a 40/)
    }
  })

  it('uppercase does not create a second user: «Rosa» and «rosa» clash', () => {
    const m = setupAccess()
    m.access.createUser({
      name: 'Rosa',
      roleId: m.roles.cashier,
      user: 'rosa',
      password: 'clave-correcta-1',
    })
    expect(() =>
      m.access.createUser({
        name: 'Otra',
        roleId: m.roles.cashier,
        user: ' ROSA ',
        password: 'clave-correcta-2',
      }),
    ).toThrow(/Ya hay alguien con el usuario «rosa»/)
  })

  it('the per-account delay is the same whether they type «ADMIN», «admin» or « Admin »', () => {
    const m = setupAccess()
    const user = m.people.admin.user as string
    const writtenVariants = [user.toUpperCase(), user, ` ${user} `]
    for (const [i, u] of writtenVariants.entries())
      expect(signIn(m, u, 'mala-clave-xx', i + 1)).toMatchObject({
        code: 'invalid_credentials',
      })
    expect(signIn(m, user, 'mala-clave-xx', 9)).toMatchObject({ code: 'wait' })
  })

  it('the Kelvin sign (K) folds to «k» when normalizing: signs in the same as the normal letter, without opening another account', () => {
    const m = setupAccess()
    m.access.createUser({
      name: 'Kira',
      roleId: m.roles.cashier,
      user: 'kira',
      password: 'clave-correcta-1',
    })
    expect(normalizeUsername('Kira')).toBe('kira')
    expect(signIn(m, 'Kira', 'clave-correcta-1')).toMatchObject({ ok: true })
    // And creating «Kira» with the Kelvin sign clashes with the existing one instead of
    // duplicating it.
    expect(() =>
      m.access.createUser({
        name: 'Falsa',
        roleId: m.roles.cashier,
        user: 'Kira',
        password: 'clave-correcta-2',
      }),
    ).toThrow(/Ya hay alguien/)
  })

  it('accents fold: «José», «JOSÉ» and «jose» (in NFC or NFD) are the same user', () => {
    const m = setupAccess()
    m.access.createUser({
      name: 'José',
      roleId: m.roles.cashier,
      user: 'José',
      password: 'clave-correcta-1',
    })
    expect(normalizeUsername('Ñandú')).toBe('nandu')
    let n = 0
    for (const written of ['jose', 'JOSÉ', 'José', 'Jose\u0301', ' josé '])
      expect(signIn(m, written, 'clave-correcta-1', ++n), JSON.stringify(written)).toMatchObject({
        ok: true,
      })
    expect(() =>
      m.access.createUser({
        name: 'Otro',
        roleId: m.roles.cashier,
        user: 'jose',
        password: 'clave-correcta-2',
      }),
    ).toThrow(/Ya hay alguien/)
  })

  it('a username of exactly 40 characters works; 41, no; 3, yes; 2, no', () => {
    expect(normalizeUsername('a'.repeat(40))).toBe('a'.repeat(40))
    expect(normalizeUsername('a'.repeat(41))).toBeNull()
    expect(normalizeUsername('abc')).toBe('abc')
    expect(normalizeUsername('ab')).toBeNull()
    expect(normalizeUsername('a.b-c_9')).toBe('a.b-c_9')
  })

  it('through the API, the username with uppercase and spaces signs in and the response has the real name', async () => {
    const api = setupApi()
    const r = await api.post('/api/sign-in', {
      user: `  ${(api.people.admin.user as string).toUpperCase()}  `,
      password: api.admin().password,
    })
    expect(r.statusCode).toBe(201)
    expect(r.json().user.name).toBe('Administrador')
  })
})
