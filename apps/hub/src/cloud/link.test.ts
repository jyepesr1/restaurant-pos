import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newId } from '@pos/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LINK_FILE, readLink, saveLink } from './link'

// The file with this register PC's link to the cloud (task 1.11): saved whole or not at all,
// readable only by the hub's user, and a damaged file is the same as never having connected.

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hub-link-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const link = (fields = {}) => ({
  hubId: newId(),
  credential: 'credencial-secreta',
  registeredAt: '2026-10-29T15:00:00.000Z',
  ...fields,
})
const file = () => join(dir, LINK_FILE)
const mode = (route: string) => statSync(route).mode & 0o777

describe('saving and reading', () => {
  it('what is saved is what is read', () => {
    const saved = link()
    saveLink(dir, saved)
    expect(readLink(dir)).toEqual(saved)
  })

  it('a link without credential (the attempt before the cloud answers) is kept as it is', () => {
    const saved = link({ credential: null, registeredAt: null })
    saveLink(dir, saved)
    expect(readLink(dir)).toEqual(saved)
  })

  it('without a file there is no link', () => {
    expect(readLink(dir)).toBeNull()
  })

  it('a folder that does not exist reads as no link', () => {
    expect(readLink(join(dir, 'no-existe'))).toBeNull()
  })

  it('saving again replaces the content', () => {
    saveLink(dir, link({ credential: 'una' }))
    const second = link({ credential: 'dos' })
    saveLink(dir, second)
    expect(readLink(dir)).toEqual(second)
  })
})

describe('permissions', () => {
  it('the file is readable and writable only by the hub user', () => {
    saveLink(dir, link())
    expect(mode(file())).toBe(0o600)
  })

  it('stays 0600 when it is saved again', () => {
    saveLink(dir, link())
    saveLink(dir, link({ credential: 'otra' }))
    expect(mode(file())).toBe(0o600)
  })

  it('stays 0600 when an older file had looser permissions', () => {
    saveLink(dir, link())
    chmodSync(file(), 0o644)
    saveLink(dir, link({ credential: 'otra' }))
    expect(mode(file())).toBe(0o600)
  })

  it('stays 0600 even if a leftover temporary file from a cut had looser permissions', () => {
    writeFileSync(`${file()}.tmp`, 'basura', { mode: 0o644 })
    chmodSync(`${file()}.tmp`, 0o644)
    saveLink(dir, link())
    expect(mode(file())).toBe(0o600)
  })

  it('leaves no temporary file behind', () => {
    saveLink(dir, link())
    expect(readdirSync(dir)).toEqual([LINK_FILE])
  })
})

describe('a damaged file', () => {
  const damaged: [string, string][] = [
    ['empty', ''],
    ['half written', '{"hub_id":"01ARZ3NDEKTSV4RRFFQ69G5FAV","credent'],
    ['not JSON', 'esto no es JSON'],
    ['JSON null', 'null'],
    ['JSON array', '[]'],
    ['an extra field', JSON.stringify({ ...raw(), extra: 1 })],
    ['hub_id too short', JSON.stringify({ ...raw(), hub_id: 'corto' })],
    ['hub_id missing', JSON.stringify({ credential: 'x', registered_at: null })],
    ['hub_id as a number', JSON.stringify({ ...raw(), hub_id: 12 })],
    ['empty credential', JSON.stringify({ ...raw(), credential: '' })],
    ['credential too long', JSON.stringify({ ...raw(), credential: 'x'.repeat(201) })],
    ['credential as a number', JSON.stringify({ ...raw(), credential: 5 })],
    ['registered_at as a number', JSON.stringify({ ...raw(), registered_at: 5 })],
    ['binary garbage', '\u0000\u0001\u0002�'],
  ]
  for (const [name, content] of damaged) {
    it(`${name} reads as no link and does not throw`, () => {
      writeFileSync(file(), content)
      expect(() => readLink(dir)).not.toThrow()
      expect(readLink(dir)).toBeNull()
    })
  }

  it('can be written over afterwards', () => {
    writeFileSync(file(), 'basura')
    const fresh = link()
    saveLink(dir, fresh)
    expect(readLink(dir)).toEqual(fresh)
    expect(mode(file())).toBe(0o600)
  })

  it('a leftover temporary file does not count as the link', () => {
    writeFileSync(`${file()}.tmp`, JSON.stringify(raw()))
    expect(existsSync(file())).toBe(false)
    expect(readLink(dir)).toBeNull()
  })

  it('a power cut between writing and renaming leaves the previous link intact', () => {
    const before = link()
    saveLink(dir, before)
    // What a cut leaves: the new content in the temporary file, the rename not done.
    writeFileSync(`${file()}.tmp`, JSON.stringify({ ...raw(), credential: 'nueva' }))
    expect(readLink(dir)).toEqual(before)
    expect(readFileSync(file(), 'utf8')).toContain('credencial-secreta')
  })
})

function raw() {
  return {
    hub_id: newId(),
    credential: 'credencial-secreta',
    registered_at: '2026-10-29T15:00:00.000Z',
  }
}
