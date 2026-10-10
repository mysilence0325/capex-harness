/**
 * The floor lane's API verdict: how one engine's readings answer the contract
 * the floor declares. The floor release ships none of those APIs and a newer
 * engine ships some, so the check has to tell an install the shell performed
 * apart from an implementation the engine already had — a distinction the
 * checked-in lane can only read from `--engine-native`.
 */
import { describe, expect, it } from 'vitest'
import { CLIENT_FLOOR_APIS } from '../client-browser-floor.ts'
import { judgeFloorApis } from './steps.ts'

/**
 * One page's floor-API readings, answering natively for the named APIs.
 * @param native - contract names the engine's own implementation answers.
 * @param absent - contract names the page did not resolve at all.
 * @returns the probe-shaped records, in contract order.
 */
function readings(native: readonly string[] = [], absent: readonly string[] = []): readonly unknown[] {
  return CLIENT_FLOOR_APIS.map(name => ({
    name,
    present: !absent.includes(name),
    kind: 'function',
    native: native.includes(name),
  }))
}

describe('floor API verdict', () => {
  it('passes on the floor, where the shell installs every API', () => {
    const verdict = judgeFloorApis(readings(), [])
    expect(verdict.faults).toEqual([])
    expect(verdict.native).toEqual([])
    expect(verdict.installed).toHaveLength(CLIENT_FLOOR_APIS.length)
  })

  it('passes on a newer engine whose own implementations are declared', () => {
    const owned = ['Object.hasOwn', 'Array.prototype.at', 'structuredClone']
    const verdict = judgeFloorApis(readings(owned), owned)
    expect(verdict.faults).toEqual([])
    expect(verdict.native).toEqual([...owned].sort())
    expect(verdict.installed).toHaveLength(CLIENT_FLOOR_APIS.length - owned.length)
  })

  it('reads the declaration as a set, not as a sequence', () => {
    const owned = ['structuredClone', 'Object.hasOwn']
    expect(judgeFloorApis(readings(owned), [...owned].reverse()).faults).toEqual([])
  })

  it('fails on a declaration that misses an engine-native API, naming both lists', () => {
    const verdict = judgeFloorApis(readings(['Object.hasOwn']), [])
    expect(verdict.faults).toHaveLength(1)
    expect(verdict.faults[0]).toContain('read back as [Object.hasOwn]')
    expect(verdict.faults[0]).toContain('declares []')
    expect(verdict.faults[0]).toContain('copy the read-back list into the flag')
  })

  it('fails on a declared name outside the contract', () => {
    const verdict = judgeFloorApis(readings(), ['Array.prototype.toSpliced'])
    expect(verdict.faults).toEqual(['--engine-native names APIs outside the floor contract: Array.prototype.toSpliced'])
  })

  it('fails on an API the page never resolved', () => {
    const verdict = judgeFloorApis(readings([], ['RegExp.escape']), [])
    expect(verdict.missing).toEqual(['RegExp.escape'])
    expect(verdict.faults).toEqual(['absent: RegExp.escape'])
  })

  it('fails on readings that do not cover the whole contract', () => {
    const verdict = judgeFloorApis(readings().slice(0, 3), [])
    expect(verdict.faults).toEqual(['read 3 of ' + String(CLIENT_FLOOR_APIS.length) + ' names'])
  })
})
