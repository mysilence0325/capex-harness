---
description: "Offline Capex Web composition with local identity, desktop file opening, and bounded data maintenance."
kind: "package-bundle"
---

# @deepseek-ai/dsh-capex

English | [中文](README.zh.md)

## Summary

This bundle specializes the shipped Web composition for an offline Capex installation. It removes cloud-account consumers while retaining the local credential provider required for authenticated browser sessions. It also mounts local identity, desktop file opening, and local data maintenance.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

Select the `capex` profile. Its ordered bundle layer is `dsh-base`, `dsh-web-app`, then this package. The layer disables cloud authorization, account providers, account Remote/UI, account models, and public web tools. It deliberately leaves `credentials-local` mounted because Web cookie signing uses it.

The resulting interface keeps model API-key configuration, workspace and Session persistence, Office preview, plugins from private registries or local tarballs, and local-user presentation.

<a id="understand-the-implementation"></a>
## Understand the implementation

This is an ordinary bundle patch applied after the general Web layer. It does not change Session formats or the agent loop. The local-user row publishes process identity; desktop-open consumes a launch file parameter; storage-maintenance exposes local usage to the Settings shell. Cleanup remains an explicit command rather than an automatic policy.

<a id="model-experience"></a>
## Model Experience

None, as this bundle only composes Browser and Host plugins that own their own model-facing behavior and removes public web tools from the offline tool set.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Process identity.** All browsers connected to the Host show the account that started it.
- **Explicit file associations.** Installing the Debian package does not overwrite each user's default application.
- **Maintenance cleanup is explicit.** Session moves and trash purging never run automatically.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
