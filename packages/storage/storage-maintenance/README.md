---
description: "Measure local Harness data and move selected Sessions, unreferenced attachments, and caches into a recoverable maintenance batch."
kind: "package-reference"
---

# @deepseek-ai/dsh-storage-maintenance

English | [中文](README.zh.md)

## Summary

This host package measures local data and provides the shared dry-run, move, restore, and purge operations used by `dsh clean`. Session moves use the persistence provider's controlled relocation; ordinary execution never removes committed Session generations.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

Mount the host plugin to expose `storageMaintenance.usage` to Settings. The CLI uses the exported maintenance functions with the JSONL persistence provider. `createMaintenancePlan` is read-only. `applyMaintenancePlan` moves only selected archived Sessions, old unreferenced attachment objects, and regenerable request-image caches under `$DSH_HOME/trash/maintenance/<batch>/`. `restoreMaintenanceBatch` reverses the complete batch and `purgeMaintenanceTrash` is the only permanent removal step.

<a id="understand-the-implementation"></a>
## Understand the implementation

Eligibility uses the Workspace archive set and the newest file time in each Session directory. Reference discovery reads every kept Session log through the persistence API. Session directories move atomically by rename through `SessionPersistence.relocate`; attachment and cache trees move by same-filesystem rename. Every batch carries a versioned manifest with absolute source and target paths. The code refuses paths outside the selected Harness home and never follows symlinks while measuring usage.

<a id="model-experience"></a>
## Model Experience

None, as storage usage and maintenance operate on local files and create no Session events, prompt context, or tools.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No opaque Session deletion.** Permanent removal requires purging a stopped maintenance batch.
- **No live maintenance.** `--apply` must not run while the Web Host is active.
- **Reference scanning is intentionally conservative.** Unreadable kept Sessions fail the plan instead of risking attachment deletion.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
