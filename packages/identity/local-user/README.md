---
description: "Resolve the operating-system account that owns the running Harness process and publish its display name to the settings shell."
kind: "package-reference"
---

# @deepseek-ai/dsh-local-user

English | [中文](README.zh.md)

## Summary

This Host plugin identifies the operating-system account that owns the running Harness process. It publishes a versioned `__DSH_IDENTITY__` global for the settings shell to render when no account launcher is mounted. The browser receives no mutable credential or account data.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

Mount the plugin in a Web-oriented bundle that needs a local-user label. It injects one `global` row through `webserver/index-inject`; no route, Remote method, setting, or model-facing tool is added. `lookupTimeoutMs` bounds the NSS lookup and defaults to 2000.

The display name resolves in this order: the first GECOS field from `getent passwd <login>`, `USER_FULLNAME`, then the login name. The last fallback keeps the label populated on minimal images without `getent`.

<a id="understand-the-implementation"></a>
## Understand the implementation

The plugin resolves once during Host activation. Synchronous resolution matches the synchronous index-injection callback and avoids a first-request race; `getent` participates in NSS, so LDAP and domain accounts use the same path as local accounts. The payload records its source only for diagnostics and never reaches a model request.

<a id="model-experience"></a>
## Model Experience

None, as the identity is browser presentation data and never enters prompt assembly or a provider request.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Process identity, not browser identity.** Every browser connected to one Host sees the account that started the Host process.
- **No account switching.** Multi-user Host isolation would require per-principal identity data and is outside this package.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
