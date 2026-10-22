#!/usr/bin/env node
/** Convert Office and legacy WPS files with a headless WPS when available, then LibreOffice Kit. */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, extname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ENGINES = ['auto', 'wps', 'libreoffice']
const TARGETS = new Set(['pdf', 'docx', 'xlsx', 'pptx'])
const FAMILIES = [
  { binary: 'wps', extensions: new Set(['.wps', '.doc', '.docx', '.rtf', '.odt']) },
  { binary: 'et', extensions: new Set(['.et', '.xls', '.xlsx', '.xlsb', '.ods']) },
  { binary: 'wpp', extensions: new Set(['.dps', '.ppt', '.pptx', '.odp']) },
]
/** Conversion budget; emulated build hosts need far more than a native run. */
const CONVERSION_TIMEOUT_MS = conversionTimeout()

function conversionTimeout() {
  const raw = process.env.DSH_OFFICE_CONVERT_TIMEOUT_MS
  if (raw === undefined || raw === '') return 120_000
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('DSH_OFFICE_CONVERT_TIMEOUT_MS must be a positive number of milliseconds')
  }
  return value
}
const HELP_TIMEOUT_MS = 5_000

function usage() {
  return [
    'Usage: dsh-office-convert --input <file> --output <file> [--engine auto|wps|libreoffice]',
    '',
    'The output extension selects pdf, docx, xlsx, or pptx. auto tries a headless WPS',
    'that advertises --convert-to, then falls back to LibreOffice Kit.',
  ].join('\n')
}

/**
 * Read the command line without accepting an unknown engine or target.
 * @param {readonly string[]} argv - Arguments after the executable.
 * @returns {{ help: boolean, input?: string, output?: string, engine: 'auto' | 'wps' | 'libreoffice' }}
 */
export function parseConvertArguments(argv) {
  let input
  let output
  let engine = 'auto'
  let help = false
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') {
      help = true
      continue
    }
    if (argument === '--input' || argument === '--output' || argument === '--engine') {
      const value = argv[index + 1]
      if (value === undefined || value === '' || value.startsWith('--')) {
        throw new Error(`${argument} requires a value`)
      }
      index += 1
      if (argument === '--input') input = value
      else if (argument === '--output') output = value
      else {
        if (!ENGINES.includes(value)) throw new Error(`--engine must be one of ${ENGINES.join(', ')}`)
        engine = value
      }
      continue
    }
    throw new Error(`unknown argument: ${argument}`)
  }
  return { help, ...(input === undefined ? {} : { input }), ...(output === undefined ? {} : { output }), engine }
}

/**
 * Select the WPS executable for an input family.
 * @param {string} input - Source filename.
 * @param {NodeJS.ProcessEnv} environment - Operator environment.
 * @returns {string | undefined} Executable path, or undefined when the family is unsupported.
 */
export function wpsBinaryFor(input, environment) {
  const extension = extname(input).toLowerCase()
  const family = FAMILIES.find(candidate => candidate.extensions.has(extension))
  if (family === undefined) return undefined
  const directories = [
    environment.DSH_WPS_DIR,
    '/opt/kingsoft/wps-office/office6',
  ].filter((value) => typeof value === 'string' && value !== '')
  for (const directory of directories) {
    const candidate = executableIn(directory, family.binary)
    if (candidate !== undefined) return candidate
  }
  return pathExecutable(family.binary, environment)
}

function executableIn(directory, name) {
  for (const candidate of [name, `${name}.exe`, `${name}.cmd`]) {
    const path = join(directory, candidate)
    try {
      if (statSync(path).isFile()) return path
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  return undefined
}

function pathExecutable(name, environment) {
  for (const directory of (environment.PATH ?? '').split(delimiter)) {
    if (directory === '') continue
    const candidate = executableIn(directory, name)
    if (candidate !== undefined) return candidate
  }
  return undefined
}

/**
 * A WPS version is eligible only when its own help advertises a non-interactive conversion.
 * @param {string} help - Combined stdout and stderr from `--help`.
 * @returns {boolean} Whether both required switches are documented.
 */
export function helpAdvertisesConversion(help) {
  return help.includes('--convert-to') && help.includes('--headless')
}

function scrubEnvironment(environment) {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !/(?:KEY|SECRET|TOKEN|PASSWORD)/iu.test(name)))
}

function resultText(result) {
  return [result.stdout, result.stderr].filter(value => typeof value === 'string' && value.trim() !== '').join('\n').trim()
}

function wpsSupportsConversion(binary) {
  const result = spawnSync(binary, ['--help'], {
    encoding: 'utf8',
    timeout: HELP_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    env: scrubEnvironment(process.env),
  })
  return result.error === undefined && result.signal == null && result.status === 0
    && helpAdvertisesConversion(resultText(result))
}

/**
 * Validate the file a converter published.
 * @param {string} path - Candidate output.
 * @param {'pdf' | 'docx' | 'xlsx' | 'pptx'} target - Expected output format.
 * @returns {void}
 * @throws When the file is empty, missing its format signature, or not a regular file.
 */
export function validateConvertedFile(path, target) {
  const entry = statSync(path)
  if (!entry.isFile() || entry.size === 0) throw new Error(`converter produced no file at ${path}`)
  const header = readFileSync(path).subarray(0, 8)
  if (target === 'pdf' && header.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new Error(`converter produced an invalid PDF at ${path}`)
  }
  if (target !== 'pdf' && header.subarray(0, 2).toString('binary') !== 'PK') {
    throw new Error(`converter produced an invalid Office package at ${path}`)
  }
}

function findInDirectory(root, suffix, depth = 0) {
  if (depth > 8) return undefined
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isFile() && path.endsWith(suffix)) return path
    if (entry.isDirectory()) {
      const found = findInDirectory(path, suffix, depth + 1)
      if (found !== undefined) return found
    }
  }
  return undefined
}

function libreOfficeCli(environment) {
  if (environment.DSH_BUNDLED_OFFICE_CLI !== undefined && environment.DSH_BUNDLED_OFFICE_CLI !== '') {
    return environment.DSH_BUNDLED_OFFICE_CLI
  }
  const cache = environment.DSH_RESOURCE_CACHE
  if (cache === undefined || cache === '') throw new Error('LibreOffice Kit CLI is unavailable: DSH_RESOURCE_CACHE is unset')
  const cli = findInDirectory(cache, '/@deepseek-ai/libreoffice-kit/lib/cli.js')
  if (cli === undefined) throw new Error(`LibreOffice Kit CLI is missing under ${cache}`)
  return cli
}

function libreOfficeNode(environment) {
  if (environment.DSH_BUNDLED_OFFICE_NODE !== undefined && environment.DSH_BUNDLED_OFFICE_NODE !== '') {
    return environment.DSH_BUNDLED_OFFICE_NODE
  }
  if (environment.DSH_ROOT !== undefined && environment.DSH_ROOT !== '') return join(environment.DSH_ROOT, 'node', 'bin', 'node')
  return process.execPath
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: CONVERSION_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    env: scrubEnvironment(process.env),
  })
  if (result.error !== undefined) throw new Error(`${basename(command)} failed: ${result.error.message}`)
  if (result.signal != null) throw new Error(`${basename(command)} terminated with ${result.signal}`)
  if (result.status !== 0) throw new Error(`${basename(command)} exited ${String(result.status)}: ${resultText(result)}`)
}

function convertedOutput(directory, source, target) {
  const expected = join(directory, `${basename(source, extname(source))}.${target}`)
  if (existsSync(expected)) return expected
  const matches = readdirSync(directory).filter(name => name.toLowerCase() === basename(expected).toLowerCase())
  if (matches.length !== 1) throw new Error(`converter wrote no ${target} output for ${basename(source)}`)
  return join(directory, matches[0])
}

function publish(source, output, target) {
  validateConvertedFile(source, target)
  mkdirSync(dirname(output), { recursive: true })
  const temporary = `${output}.tmp-${process.pid}`
  try {
    copyFileSync(source, temporary)
    renameSync(temporary, output)
  } catch (error) {
    rmSync(temporary, { force: true })
    if (error.code !== 'EEXIST' && error.code !== 'EPERM') throw error
    rmSync(output, { force: true })
    renameSync(temporary, output)
  }
  validateConvertedFile(output, target)
}

function convertWithWps(binary, input, output, directory, target) {
  if (!wpsSupportsConversion(binary)) throw new Error(`WPS at ${binary} does not advertise headless conversion`)
  run(binary, ['--headless', '--convert-to', target, '--outdir', directory, input], directory)
  const converted = convertedOutput(directory, input, target)
  publish(converted, output, target)
}

function convertWithLibreOffice(input, output, directory, target) {
  const cli = libreOfficeCli(process.env)
  const node = libreOfficeNode(process.env)
  const converted = join(directory, basename(output))
  run(node, [cli, 'convert', '--input', input, '--output', converted], directory)
  publish(converted, output, target)
}

/**
 * Convert one input file. `auto` reports the selected engine after either a successful WPS run
 * or its fallback; explicit `wps` surfaces a WPS failure instead of hiding it.
 * @param {{ input: string, output: string, engine?: 'auto' | 'wps' | 'libreoffice' }} options - Paths and engine.
 * @returns {{ engine: 'wps' | 'libreoffice', output: string }} The engine that published the file.
 */
export function convertOfficeFile(options) {
  const input = resolve(options.input)
  const output = resolve(options.output)
  const engine = options.engine ?? 'auto'
  if (!existsSync(input)) throw new Error(`input file does not exist: ${input}`)
  if (input === output) throw new Error('input and output must be different files')
  const target = extname(output).slice(1).toLowerCase()
  if (!TARGETS.has(target)) throw new Error(`output extension must be one of ${[...TARGETS].join(', ')}`)
  const directory = mkdtempSync(join(tmpdir(), 'dsh-office-convert-'))
  try {
    let wpsFailure
    if (engine !== 'libreoffice') {
      const binary = wpsBinaryFor(input, process.env)
      if (binary !== undefined) {
        try {
          convertWithWps(binary, input, output, directory, target)
          return { engine: 'wps', output }
        } catch (error) {
          wpsFailure = error instanceof Error ? error.message : String(error)
          if (engine === 'wps') throw error
          console.error(`dsh-office-convert: WPS unavailable, falling back to LibreOffice: ${wpsFailure}`)
        }
      } else if (engine === 'wps') {
        throw new Error(`no WPS executable handles ${extname(input) || 'this input'}`)
      }
    }
    convertWithLibreOffice(input, output, directory, target)
    return { engine: 'libreoffice', output }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const options = parseConvertArguments(process.argv.slice(2))
    if (options.help) {
      console.log(usage())
      process.exitCode = 0
    } else {
      if (options.input === undefined || options.output === undefined) throw new Error(usage())
      console.log(JSON.stringify(convertOfficeFile({ input: options.input, output: options.output, engine: options.engine })))
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
