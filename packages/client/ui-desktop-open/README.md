---
description: "Open a document handed over by the Capex desktop launcher in a Session-scoped preview without submitting a model request."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-desktop-open

English | [中文](README.zh.md)

## Summary

This client plugin consumes the `open` and `workspace` query parameters written by `/usr/bin/dsh-web`. It registers the file's directory as a Workspace, opens or creates a blank Session, and displays the file in the right Sidebar document preview. It sends no user message and starts no model turn.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

Mount this plugin only in the Capex bundle together with Workspace, Sidebar, document-preview, and settings services used by that composition. The launcher must provide absolute canonical paths. The plugin consumes the request once and removes both parameters from browser history.

Invalid or inaccessible paths leave the existing application usable and show a localized transient error.

<a id="understand-the-implementation"></a>
## Understand the implementation

The plugin waits until Workspace and Session snapshots are ready, then calls the ordinary Workspace Controller and `uiWorkspace.openWorkspace`. The Session is created or reused through existing navigation semantics. Its `beforeOpen` callback opens `fileAddressFor(sessionId, workspace, file)` through the right-Sidebar resource controller, so file authorization remains owned by the existing Workspace and document services.

<a id="model-experience"></a>
## Model Experience

None, as opening a document creates presentation state and a blank Session only; the model receives no file content or instruction.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **One launch request.** A second URL navigation replaces the first before activation; multi-file activation is outside this initial interface.
- **Broken sources remain broken.** A deleted or unreadable path reports its existing document-preview failure.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
