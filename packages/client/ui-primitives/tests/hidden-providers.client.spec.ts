import { describe, expect, it } from 'vitest'
import { HIDDEN_MODEL_PROVIDERS, isHiddenModelProvider } from '../src/hidden-providers.ts'

describe('hidden model providers', () => {
  it('hides the account and official routes only', () => {
    expect([...HIDDEN_MODEL_PROVIDERS]).toEqual(['deepseek-official', 'deepseek-account'])
    expect(isHiddenModelProvider('deepseek-official')).toBe(true)
    expect(isHiddenModelProvider('deepseek-account')).toBe(true)
    expect(isHiddenModelProvider('openai')).toBe(false)
    expect(isHiddenModelProvider('deepseek-route')).toBe(false)
  })
})
