import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as RemoteAssembly from '../src/client/index.ts'

const contexts = new Set<Context>()

afterEach(async () => {
  await Promise.all([...contexts].map(async (ctx) => { await ctx.fiber.dispose() }))
  contexts.clear()
})

describe('Remote Client assembly', () => {
  it('mounts local storage maintenance for Settings', async () => {
    const ctx = new Context()
    contexts.add(ctx)
    const packages: string[] = []
    ctx.provide('remote', {
      $mount: vi.fn(async (contribution: { readonly package: string }) => {
        packages.push(contribution.package)
        return async () => {}
      }),
    } as never)

    await ctx.plugin(RemoteAssembly)

    expect(packages).toContain('@deepseek-ai/dsh-storage-maintenance')
  })
})
