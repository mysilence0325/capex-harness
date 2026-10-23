import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'

interface TestModel {
  readonly id?: string
  readonly name?: string
  readonly contextWindow?: number
  readonly maxTokens?: number
  readonly input?: readonly string[]
  readonly reasoningEfforts?: Readonly<Record<string, string | null>>
}

interface TestProvider {
  readonly displayName?: string
  readonly apiKeyEnv?: string
  readonly api?: string
  readonly baseURL?: string
  readonly models?: readonly TestModel[]
}

interface TestPatch {
  readonly id?: string
  readonly name?: string
  readonly disabled?: boolean | null
  readonly insert?: readonly TestPatch[]
  readonly config?: {
    readonly provider?: string
    readonly model?: string
    readonly providers?: Readonly<Record<string, TestProvider>>
  }
}

const patchFile = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))
const patches: readonly TestPatch[] = loadOverlayPatches('capex-test', patchFile)

describe('Capex offline composition', () => {
  it.each([
    'authorization',
    'deepseek-account',
    'llm-deepseek-account',
    'account-controller',
    'ui-settings-account',
    'web-search-deepseek',
    'web-deepseek-api',
    'web-fetch-http',
    'tool-web',
  ])('disables %s', (id) => {
    expect(patches.some(row => row.id === id && row.disabled === true)).toBe(true)
  })

  it('keeps the local credential provider needed for Web authentication', () => {
    expect(patches.some(row => row.id === 'credentials')).toBe(false)
  })

  it('mounts the local identity and maintenance surfaces', () => {
    const inserted = patches.flatMap(row => row.insert ?? [])
    for (const [id, name] of [
      ['local-user', '@deepseek-ai/dsh-local-user'],
      ['desktop-open', '@deepseek-ai/dsh-client-ui-desktop-open'],
      ['storage-maintenance', '@deepseek-ai/dsh-storage-maintenance'],
      ['ui-settings-storage', '@deepseek-ai/dsh-client-ui-settings-storage'],
    ] as const) {
      expect(inserted.some(row => row.id === id && row.name === name)).toBe(true)
    }
  })

  it('configures the Capex model gateway and its default model', () => {
    const provider = patches.find(row => row.id === 'llm-pi-ai')?.config?.providers?.['capexai']
    expect(provider).toEqual({
      displayName: 'capexai',
      apiKeyEnv: 'CAPEXAI_API_KEY',
      api: 'openai-completions',
      baseURL: 'http://15.11.40.44:3100/v1',
      models: [{
        id: 'deepseek-flash',
        name: 'DeepSeek Flash',
        contextWindow: 131072,
        maxTokens: 4096,
        input: ['text', 'image'],
        reasoningEfforts: {
          off: null,
          low: 'low',
          medium: 'medium',
          high: 'high',
          xhigh: 'xhigh',
          max: 'max',
        },
      }],
    })
    expect(patches.find(row => row.id === 'agent-default-model')?.config).toEqual({
      provider: 'capexai',
      model: 'deepseek-flash',
    })
  })

  it('keeps model credentials out of the shipped profile patch', () => {
    expect(readFileSync(patchFile, 'utf8')).not.toMatch(/\bsk-[A-Za-z0-9_-]{16,}\b/)
  })
})
