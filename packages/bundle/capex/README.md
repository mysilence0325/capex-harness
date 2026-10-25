---
description: "Offline Capex Web composition with local identity, desktop file opening, and bounded data maintenance."
kind: "package-bundle"
---

# @deepseek-ai/dsh-capex

English | [中文](README.zh.md)

## Summary

This bundle specializes the shipped Web composition for an offline Capex installation. It removes cloud-account consumers while retaining the local credential provider required for authenticated browser sessions. It supplies the `capexai` OpenAI-compatible provider and `DeepSeek Flash` default, and also mounts local identity, desktop file opening, and local data maintenance.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

Select the `capex` profile. Its ordered bundle layer is `dsh-base`, `dsh-web-app`, then this package. The layer disables cloud authorization, account providers, account Remote/UI, account models, and public web tools. It deliberately leaves `credentials-local` mounted because Web cookie signing uses it.

The resulting interface keeps model API-key configuration, workspace and Session persistence, Office preview, plugins from private registries or local tarballs, and local-user presentation. The `capexai` route uses the global `CAPEXAI_API_KEY` credential reference; users can add further providers in Settings.

On a shared Linux host, each OS account starts its own Host with `$HOME/.dsh`, a private runtime URL, and an independent loopback port. The Settings fallback names that Host's OS account, so switching desktop users also switches the displayed name and local data.

<a id="understand-the-implementation"></a>
## Understand the implementation

This is an ordinary bundle patch applied after the general Web layer. It does not change Session formats or the agent loop. The local-user row publishes process identity; desktop-open consumes a launch file argument; storage-maintenance is mounted by the Client Remote assembly and exposes local usage to the Settings shell. Cleanup remains an explicit command rather than an automatic policy. The Debian build titles the document and application frame `Capex Harness`. Its launcher uses the system default browser, preserves that desktop entry's arguments, requests app mode from Chromium-compatible browsers, and retains the installed QiAnXin launcher as a fallback. On X11, a click without a document focuses the current user's existing Capex window instead of opening another one.

<a id="model-experience"></a>
## Model Experience

None, as this bundle only composes Browser and Host plugins that own their own model-facing behavior and removes public web tools from the offline tool set.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Process identity within one account.** All browsers connected to one Host show the OS account that started it; multiple natural users sharing one OS login are not distinguished.

- **Window focus depends on the desktop protocol.** X11 uses `wmctrl` to restore and focus an existing window. Wayland compositors may reject another application's focus request, in which case the launcher creates a window normally.
- **Profile-local settings.** Model providers and the default model belong to the active profile; settings saved under the older `web` profile are not copied into `capex`.
- **Explicit file associations.** Installing the Debian package does not overwrite each user's default application.
- **Maintenance cleanup is explicit.** Session moves and trash purging never run automatically.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
