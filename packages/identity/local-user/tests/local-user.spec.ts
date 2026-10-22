import { describe, expect, it } from 'vitest'
import { resolveLocalUserIdentity } from '../src/index.ts'

const now = () => new Date('2026-10-22T00:00:00.000Z')

describe('resolveLocalUserIdentity', () => {
  it('uses the first GECOS field before environment and login fallbacks', () => {
    const identity = resolveLocalUserIdentity({
      env: { USER_FULLNAME: 'Environment Name' },
      readUserInfo: () => ({ username: 'user01' }),
      queryPasswd: login => `${login}:x:1001:1001:张三,财务部,,:/home/user01:/bin/bash\n`,
      now,
    })
    expect(identity).toEqual({
      version: 1,
      login: 'user01',
      displayName: '张三',
      source: 'gecos',
      resolvedAt: '2026-10-22T00:00:00.000Z',
    })
  })

  it('uses USER_FULLNAME when GECOS is empty', () => {
    const identity = resolveLocalUserIdentity({
      env: { USER_FULLNAME: ' Environment Name ' },
      readUserInfo: () => ({ username: 'user01' }),
      queryPasswd: login => `${login}:x:1001:1001::/home/user01:/bin/bash\n`,
      now,
    })
    expect(identity.displayName).toBe('Environment Name')
    expect(identity.source).toBe('env')
  })

  it('falls back to the login name when NSS lookup is unavailable', () => {
    const identity = resolveLocalUserIdentity({
      env: {},
      readUserInfo: () => ({ username: 'user01' }),
      queryPasswd: () => { throw new Error('getent unavailable') },
      now,
    })
    expect(identity.displayName).toBe('user01')
    expect(identity.source).toBe('login')
  })

  it('falls back to an environment login when os.userInfo throws', () => {
    const identity = resolveLocalUserIdentity({
      env: { USER: 'env-login' },
      readUserInfo: () => { throw new Error('no passwd entry') },
      queryPasswd: () => { throw new Error('no NSS') },
      now,
    })
    expect(identity.login).toBe('env-login')
    expect(identity.displayName).toBe('env-login')
  })

  it('preserves a full-width space in a GECOS display name', () => {
    const identity = resolveLocalUserIdentity({
      env: {},
      readUserInfo: () => ({ username: 'user01' }),
      queryPasswd: () => 'user01:x:1:1:张\u3000三:/home/user01:/bin/sh\n',
      now,
    })
    expect(identity.displayName).toBe('张\u3000三')
  })
})

describe('identity injection', () => {
  it('publishes one versioned global row', async () => {
    const { applyIdentity, LOCAL_USER_IDENTITY_GLOBAL } = await import('../src/index.ts')
    const listeners: ((rows: object[]) => void)[] = []
    applyIdentity({
      on: (_event: string, listener: (rows: object[]) => void) => { listeners.push(listener) },
    } as never, {
      version: 1, login: 'user01', displayName: '张三', source: 'gecos', resolvedAt: '2026-10-22T00:00:00.000Z',
    })
    const rows: object[] = []
    for (const listener of listeners) listener(rows)
    expect(rows).toEqual([{
      kind: 'global',
      name: LOCAL_USER_IDENTITY_GLOBAL,
      value: expect.objectContaining({ displayName: '张三', login: 'user01' }),
    }])
  })
})
