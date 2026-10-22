import { describe, expect, it } from 'vitest'
import { DEB_INSTALL_ROOT } from '../debian.ts'
import {
  dshCommand,
  dshOfficeConvertCommand,
  dshPipCommand,
  dshPythonCommand,
  dshSdkCommand,
  payloadCommandFiles,
} from '../wrappers.ts'

describe('dshCommand', () => {
  const command = dshCommand()

  it('starts with a POSIX sh shebang and fails fast', () => {
    expect(command.startsWith('#!/bin/sh\n')).toBe(true)
    expect(command).toContain('set -eu\n')
  })

  it('pins the install root and the resource cache default', () => {
    expect(command).toContain(`DSH_ROOT=${DEB_INSTALL_ROOT}\n`)
    expect(command).toContain('DSH_RESOURCE_CACHE="${DSH_RESOURCE_CACHE:-$DSH_ROOT/resources}"\n')
  })

  it('runs the deployed closure on the bundled Node.js with internals exposed', () => {
    expect(command).toContain('exec "$DSH_ROOT/node/bin/node" --expose-internals "$DSH_ROOT/dsh/runtime/node/runtime-bootstrap.mjs" "$@"')
  })

  it('forwards a caller-supplied resource cache', () => {
    expect(command).toContain('${DSH_RESOURCE_CACHE:-')
  })

  it('keeps telemetry off unless the operator opts in', () => {
    expect(command).toContain('DSH_TELEMETRY_DISABLED="${DSH_TELEMETRY_DISABLED:-1}"')
    expect(command).toContain('export DSH_ROOT DSH_RESOURCE_CACHE DSH_TELEMETRY_DISABLED DSH_BUNDLED_OFFICE_CONVERT')
  })

  it('exports the packaged office converter for the Web and SDK profiles', () => {
    expect(command).toContain('DSH_BUNDLED_OFFICE_CONVERT="${DSH_BUNDLED_OFFICE_CONVERT:-/usr/bin/dsh-office-convert}"')
  })
})

describe('dshSdkCommand', () => {
  it('supplies the DSH_HOME the runtime wheel requires', () => {
    expect(dshSdkCommand()).toContain('DSH_HOME="${DSH_HOME:-$HOME/.dsh}"')
  })

  it('executes the console script installed by the runtime wheel', () => {
    expect(dshSdkCommand()).toContain('exec "$DSH_ROOT/python/bin/dsh" "$@"')
  })

  it('keeps telemetry off for the Python runtime too', () => {
    expect(dshSdkCommand()).toContain('DSH_TELEMETRY_DISABLED="${DSH_TELEMETRY_DISABLED:-1}"')
    expect(dshSdkCommand()).toContain('export DSH_ROOT DSH_RESOURCE_CACHE DSH_HOME DSH_TELEMETRY_DISABLED DSH_BUNDLED_OFFICE_CONVERT')
  })
})

describe('dshPythonCommand', () => {
  it('executes the bundled interpreter', () => {
    expect(dshPythonCommand()).toContain('exec "$DSH_ROOT/python/bin/python3.12" "$@"')
  })

  it('points pip at the offline wheelhouse while preserving overrides', () => {
    const command = dshPythonCommand()
    expect(command).toContain('DSH_WHEELHOUSE="${DSH_WHEELHOUSE:-$DSH_ROOT/wheelhouse}"')
    expect(command).toContain('PIP_NO_INDEX="${PIP_NO_INDEX:-1}"')
    expect(command).toContain('PIP_FIND_LINKS="${PIP_FIND_LINKS:-$DSH_WHEELHOUSE}"')
  })
})

describe('dshPipCommand', () => {
  it('prefers the active virtual environment and otherwise uses the bundled Python', () => {
    const command = dshPipCommand()
    expect(command).toContain('if [ -n "${VIRTUAL_ENV:-}" ] && [ -x "$VIRTUAL_ENV/bin/python" ]; then')
    expect(command).toContain('python="$VIRTUAL_ENV/bin/python"')
    expect(command).toContain('python="$DSH_ROOT/python/bin/python3.12"')
    expect(command).toContain('exec "$python" -m pip "$@"')
  })

  it('uses the same offline wheelhouse defaults', () => {
    expect(dshPipCommand()).toContain('PIP_FIND_LINKS="${PIP_FIND_LINKS:-$DSH_WHEELHOUSE}"')
  })
})

describe('dshOfficeConvertCommand', () => {
  it('runs the payload converter on the bundled Node.js', () => {
    expect(dshOfficeConvertCommand()).toContain(
      'exec "$DSH_ROOT/node/bin/node" "$DSH_ROOT/share/office-convert.mjs" "$@"',
    )
  })
})

describe('payloadCommandFiles', () => {
  it('installs the CLI, SDK, and interpreter commands for a full package', () => {
    expect(payloadCommandFiles({ pythonOnly: false }).map(file => file.path))
      .toEqual(['/usr/bin/dsh', '/usr/bin/dsh-sdk', '/usr/bin/dsh-python', '/usr/bin/dsh-pip', '/usr/bin/dsh-office-convert'])
  })

  it('omits the Node.js CLI for a python-only package', () => {
    expect(payloadCommandFiles({ pythonOnly: true }).map(file => file.path))
      .toEqual(['/usr/bin/dsh-sdk', '/usr/bin/dsh-python', '/usr/bin/dsh-pip'])
  })

  it('ends every wrapper with one newline', () => {
    for (const file of payloadCommandFiles({ pythonOnly: false })) {
      expect(file.content.endsWith('\n')).toBe(true)
      expect(file.content.endsWith('\n\n')).toBe(false)
    }
  })
})
