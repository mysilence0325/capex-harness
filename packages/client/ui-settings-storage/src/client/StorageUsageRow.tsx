/** General Settings row showing bounded local-data usage. */
import { useEffect, useState } from 'react'
import type { StorageUsage } from '@deepseek-ai/dsh-storage-maintenance/types'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './StorageUsageRow.module.css'

/** Injected usage read. */
export interface StorageUsageInjected {
  readonly readUsage: () => Promise<StorageUsage>
}

/** Row props assembled by the settings slot runtime. */
export type StorageUsageRowProps = PropsRuntime<'settings.general.item'>
  & PropsLocale<'settings.storage'>
  & InjectFace<StorageUsageInjected>

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GiB`
}

/**
 * Read and present storage usage without offering a destructive action.
 * @param props - usage reader and localized copy.
 * @returns the General Settings row.
 */
export function StorageUsageRow({ readUsage, t }: StorageUsageRowProps) {
  const [usage, setUsage] = useState<StorageUsage>()
  const [failed, setFailed] = useState(false)
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let current = true
    setLoading(true)
    setFailed(false)
    void readUsage().then((value) => {
      if (current) setUsage(value)
    }, () => {
      if (current) setFailed(true)
    }).finally(() => {
      if (current) setLoading(false)
    })
    return () => { current = false }
  }, [readUsage, revision])
  const bytes = (id: StorageUsage['categories'][number]['id']): string =>
    formatBytes(usage?.categories.find(item => item.id === id)?.bytes ?? 0)
  return <div className={css.row}>
    <div className={css.copy}>
      <div className={css.title}>{t('title')}</div>
      <div className={css.description}>{usage === undefined ? t('description') : t('total', { size: formatBytes(usage.totalBytes) })}</div>
      {usage !== undefined && <div className={css.metrics}>
        <span>{t('sessions', { size: bytes('sessions') })}</span>
        <span>{t('attachments', { size: bytes('attachments') })}</span>
        <span>{t('cache', { size: bytes('cache') })}</span>
        <span>{t('trash', { size: bytes('trash') })}</span>
      </div>}
      <div className={css.hint}>{t('cleanHint')}</div>
      {failed && <div role="alert" className={css.error}>{t('failed')}</div>}
    </div>
    <button type="button" className={css.refresh} disabled={loading} onClick={() => { setRevision(value => value + 1) }}>
      {loading ? t('loading') : t('refresh')}
    </button>
  </div>
}
