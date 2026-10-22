/**
 * POSIX command wrappers installed under `/usr/bin`.
 *
 * The wrappers keep the install root and the resource cache out of the shipped
 * applications: each command passes them as environment to the payload it
 * starts, and an operator-supplied value always wins.
 */

import { DEB_INSTALL_ROOT } from './debian.ts'

/** One wrapper file written into the package tree. */
export interface PayloadCommandFile {
  /** Absolute path inside the package tree. */
  readonly path: string
  /** File content, including the shebang. */
  readonly content: string
}

const RESOURCE_CACHE_LINE = 'DSH_RESOURCE_CACHE="${DSH_RESOURCE_CACHE:-$DSH_ROOT/resources}"'

/**
 * The package serves an intranet deployment: nothing may leave for the
 * upstream telemetry collector, whatever a profile row says. An operator value
 * still wins so a connected build host can opt back in.
 */
const TELEMETRY_LINE = 'DSH_TELEMETRY_DISABLED="${DSH_TELEMETRY_DISABLED:-1}"'
const OFFICE_CONVERT_LINE = [
  'DSH_BUNDLED_OFFICE_CONVERT="${DSH_BUNDLED_OFFICE_CONVERT:-/usr/bin/dsh-office-convert}"',
  'if [ ! -x "$DSH_BUNDLED_OFFICE_CONVERT" ]; then DSH_BUNDLED_OFFICE_CONVERT=; fi',
].join('\n')
const PYTHON_WHEELHOUSE_LINE = 'DSH_WHEELHOUSE="${DSH_WHEELHOUSE:-$DSH_ROOT/wheelhouse}"'
const PIP_OFFLINE_LINES = [
  'PIP_NO_INDEX="${PIP_NO_INDEX:-1}"',
  'PIP_FIND_LINKS="${PIP_FIND_LINKS:-$DSH_WHEELHOUSE}"',
].join('\n')

function header(purpose: string): string {
  return [
    '#!/bin/sh',
    `# ${purpose}`,
    'set -eu',
    `DSH_ROOT=${DEB_INSTALL_ROOT}`,
  ].join('\n')
}

/**
 * `dsh` command that runs the CLI closure built from source on the bundled Node.js.
 *
 * `--expose-internals` satisfies the vendored loader and the HMR service, which
 * is the same requirement the Electron desktop shell meets.
 * @returns Wrapper content.
 */
export function dshCommand(): string {
  return [
    header('dsh CLI: source-built closure on the bundled Node.js runtime.'),
    RESOURCE_CACHE_LINE,
    TELEMETRY_LINE,
    OFFICE_CONVERT_LINE,
    'export DSH_ROOT DSH_RESOURCE_CACHE DSH_TELEMETRY_DISABLED DSH_BUNDLED_OFFICE_CONVERT',
    'exec "$DSH_ROOT/node/bin/node" --expose-internals '
      + '"$DSH_ROOT/dsh/runtime/node/runtime-bootstrap.mjs" "$@"',
    '',
  ].join('\n')
}

/**
 * `dsh-sdk` command that runs the console script of the packaged runtime wheel.
 *
 * The wheel rejects an empty `DSH_HOME`; the wrapper supplies the interactive
 * default so a login shell needs no exported value.
 * @returns Wrapper content.
 */
export function dshSdkCommand(): string {
  return [
    header('dsh from the packaged Python runtime wheel; the wheel requires DSH_HOME.'),
    RESOURCE_CACHE_LINE,
    'DSH_HOME="${DSH_HOME:-$HOME/.dsh}"',
    TELEMETRY_LINE,
    OFFICE_CONVERT_LINE,
    'export DSH_ROOT DSH_RESOURCE_CACHE DSH_HOME DSH_TELEMETRY_DISABLED DSH_BUNDLED_OFFICE_CONVERT',
    'exec "$DSH_ROOT/python/bin/dsh" "$@"',
    '',
  ].join('\n')
}

/**
 * `dsh-python` command that runs the bundled CPython interpreter.
 * @returns Wrapper content.
 */
export function dshPythonCommand(): string {
  return [
    header('Bundled CPython with deepseek-harness-sdk installed.'),
    RESOURCE_CACHE_LINE,
    PYTHON_WHEELHOUSE_LINE,
    PIP_OFFLINE_LINES,
    'export DSH_ROOT DSH_RESOURCE_CACHE DSH_WHEELHOUSE PIP_NO_INDEX PIP_FIND_LINKS',
    'exec "$DSH_ROOT/python/bin/python3.12" "$@"',
    '',
  ].join('\n')
}

/**
 * `dsh-pip` command that installs from the offline wheelhouse.
 *
 * An active virtual environment owns the target interpreter; without one the
 * bundled CPython is the target. `PIP_*` and `DSH_WHEELHOUSE` remain
 * operator-overridable for a private package source.
 * @returns Wrapper content.
 */
export function dshPipCommand(): string {
  return [
    header('Offline pip over the bundled CPython or the active virtual environment.'),
    PYTHON_WHEELHOUSE_LINE,
    PIP_OFFLINE_LINES,
    'export DSH_WHEELHOUSE PIP_NO_INDEX PIP_FIND_LINKS',
    'if [ -n "${VIRTUAL_ENV:-}" ] && [ -x "$VIRTUAL_ENV/bin/python" ]; then',
    '  python="$VIRTUAL_ENV/bin/python"',
    'else',
    '  python="$DSH_ROOT/python/bin/python3.12"',
    'fi',
    'exec "$python" -m pip "$@"',
    '',
  ].join('\n')
}

/**
 * `dsh-office-convert` command that runs the payload converter on the bundled Node.js.
 * @returns Wrapper content.
 */
export function dshOfficeConvertCommand(): string {
  return [
    header('Office and legacy WPS conversion through WPS or LibreOffice Kit.'),
    RESOURCE_CACHE_LINE,
    'export DSH_ROOT DSH_RESOURCE_CACHE',
    'exec "$DSH_ROOT/node/bin/node" "$DSH_ROOT/share/office-convert.mjs" "$@"',
    '',
  ].join('\n')
}

/**
 * Wrapper files for one package layout.
 * @param options - `pythonOnly` omits the Node.js CLI, which that layout does not ship.
 * @returns Wrapper files in installation order.
 */
export function payloadCommandFiles(options: { readonly pythonOnly: boolean }): readonly PayloadCommandFile[] {
  return [
    ...(options.pythonOnly ? [] : [{ path: '/usr/bin/dsh', content: dshCommand() }]),
    { path: '/usr/bin/dsh-sdk', content: dshSdkCommand() },
    { path: '/usr/bin/dsh-python', content: dshPythonCommand() },
    { path: '/usr/bin/dsh-pip', content: dshPipCommand() },
    ...(options.pythonOnly ? [] : [{ path: '/usr/bin/dsh-office-convert', content: dshOfficeConvertCommand() }]),
  ]
}
