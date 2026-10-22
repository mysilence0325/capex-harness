/** Public local-data usage and recoverable maintenance records. */

/** Size of one local data category. */
export interface StorageUsageCategory {
  readonly id: 'sessions' | 'attachments' | 'cache' | 'trash' | 'storages' | 'profiles' | 'logs' | 'other'
  readonly bytes: number
}

/** Point-in-time usage of one Harness home. */
export interface StorageUsage {
  readonly version: 1
  readonly home: string
  readonly totalBytes: number
  readonly categories: readonly StorageUsageCategory[]
  readonly measuredAt: string
}

/** One item selected by a cleanup dry run. */
export interface MaintenanceItem {
  readonly kind: 'session' | 'attachment' | 'cache'
  /** Absolute source path after apply; a stable session:<id> marker before then. */
  readonly source: string
  readonly target: string
  readonly bytes: number
  readonly reason: string
  readonly sessionId?: string
}

/** Recoverable cleanup plan written into its batch directory. */
export interface MaintenanceManifest {
  readonly version: 1
  readonly batch: string
  readonly createdAt: string
  readonly cutoff: string
  readonly home: string
  readonly items: readonly MaintenanceItem[]
}

/** Result of applying, restoring, or purging maintenance data. */
export interface MaintenanceResult {
  readonly batch: string
  readonly completed: readonly string[]
  readonly failed: readonly { readonly source: string; readonly message: string }[]
  readonly reclaimedBytes?: number
}
