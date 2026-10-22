---
description: "Read-only local-data usage summary in General Settings, backed by the storage-maintenance Remote."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-storage

English | [中文](README.zh.md)

## Summary

This plugin adds a General Settings row that reports Session, attachment, cache, trash, and total local-data usage. It refreshes on demand and tells the user how to inspect reclaimable data with `dsh clean`; it exposes no destructive GUI action.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

Mount it with `storage-maintenance`, Settings, localization, and Remote services. The row loads current usage after General Settings opens and retries through its Refresh button. Failures retain the explanation and do not block other settings.

<a id="understand-the-implementation"></a>
## Understand the implementation

The row calls `storageMaintenance.usage` through the generated Remote namespace and formats byte totals locally. It owns only presentation state: loading, failure, and the latest accepted usage. Cleanup remains CLI-owned and recoverable.

<a id="model-experience"></a>
## Model Experience

None, as usage is browser presentation data and never enters a prompt or model tool.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No destructive action.** Permanent deletion remains explicit in the terminal.
- **Manual refresh.** The row does not poll the filesystem while Settings remains open.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
