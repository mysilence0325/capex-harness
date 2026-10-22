import { describe, expect, it } from 'vitest'
import { parseDoctorArgs } from '../src/doctor.ts'

describe('parseDoctorArgs', () => {
  it('defaults to the Web profile and report writing', () => {
    expect(parseDoctorArgs([])).toEqual({
      profile: 'web', json: false, quick: false, writeReport: true, patches: [],
    })
  })

  it('accepts explicit and repeated inspection inputs', () => {
    expect(parseDoctorArgs([
      '--profile=capex', '--model-url=http://model:3100/v1', '--patch', 'a.yml', '--patch=b.yml', '--json', '--quick',
    ])).toEqual({
      profile: 'capex',
      modelUrl: 'http://model:3100/v1',
      json: true,
      quick: true,
      writeReport: true,
      patches: ['a.yml', 'b.yml'],
    })
  })

  it('rejects invalid input', () => {
    for (const args of [['--profile'], ['--model-url='], ['--patch'], ['--unknown']]) {
      expect(() => parseDoctorArgs(args)).toThrow()
    }
  })
})
