/** Register the local-data usage row in General Settings. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-storage-maintenance/remote'
import { en, zh, type StorageSettingsKey } from './locales.ts'
import { StorageUsageRow, type StorageUsageInjected } from './StorageUsageRow.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.storage': StorageSettingsKey
  }
}

const NS = 'settings.storage'

/** Services required for the settings row and its Host usage read. */
export const inject = ['slots', 'locale', 'remote', 'remote.storageMaintenance']

/**
 * Register read-only local-data usage.
 * @param ctx - browser plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'settings-storage: dictionaries')
  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'local-data',
    order: 80,
    locale: NS,
    inject: (): StorageUsageInjected => ({
      readUsage: async () => {
        const result = await ctx.remote.storageMaintenance.usage()
        if (!result.ok) throw new Error(result.error.message)
        return result.value
      },
    }),
  }, StorageUsageRow))
}
