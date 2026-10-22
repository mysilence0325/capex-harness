/** Local-data settings row copy. */
export const zh = {
  title: '本地数据',
  description: '会话、附件、缓存与维护回收站占用',
  refresh: '刷新',
  loading: '正在统计…',
  failed: '无法读取本地数据占用，请重试',
  total: '合计 {size}',
  sessions: '会话 {size}',
  attachments: '附件 {size}',
  cache: '缓存 {size}',
  trash: '回收站 {size}',
  cleanHint: '在终端运行 dsh clean 预览可回收的数据',
} satisfies Record<string, string>

/** Message keys for the local-data settings row. */
export type StorageSettingsKey = keyof typeof zh

/** English local-data settings messages. */
export const en = {
  title: 'Local data',
  description: 'Space used by Sessions, attachments, caches, and maintenance trash',
  refresh: 'Refresh',
  loading: 'Measuring…',
  failed: 'Could not read local data usage. Please try again.',
  total: 'Total {size}',
  sessions: 'Sessions {size}',
  attachments: 'Attachments {size}',
  cache: 'Cache {size}',
  trash: 'Trash {size}',
  cleanHint: 'Run dsh clean in a terminal to preview reclaimable data',
} satisfies Record<StorageSettingsKey, string>
