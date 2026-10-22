// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { parseLocalIdentity } from '../src/client/local-identity.ts'

afterEach(() => { Reflect.deleteProperty(globalThis, '__DSH_IDENTITY__') })

describe('parseLocalIdentity', () => {
  it('accepts the current version and trims display fields', () => {
    expect(parseLocalIdentity({
      version: 1,
      login: ' user01 ',
      displayName: ' 张三 ',
      source: 'gecos',
      resolvedAt: '2026-10-22T00:00:00.000Z',
    })).toEqual({ login: 'user01', displayName: '张三' })
  })

  it('falls back to login when the display name is empty', () => {
    expect(parseLocalIdentity({ version: 1, login: 'user01', displayName: ' ' }))
      .toEqual({ login: 'user01', displayName: 'user01' })
  })

  it.each([
    undefined,
    null,
    [],
    { version: 2, login: 'user01', displayName: '张三' },
    { version: 1, login: 1, displayName: '张三' },
    { version: 1, login: '', displayName: '' },
  ])('rejects malformed or empty payload %#', value => {
    expect(parseLocalIdentity(value)).toBeUndefined()
  })
})
