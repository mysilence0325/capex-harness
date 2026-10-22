import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  convertOfficeFile,
  helpAdvertisesConversion,
  parseConvertArguments,
  validateConvertedFile,
  wpsBinaryFor,
} from '../office-convert.mjs'

const temporaryDirectories: string[] = []
const original = {
  DSH_WPS_DIR: process.env.DSH_WPS_DIR,
  DSH_BUNDLED_OFFICE_CLI: process.env.DSH_BUNDLED_OFFICE_CLI,
  DSH_BUNDLED_OFFICE_NODE: process.env.DSH_BUNDLED_OFFICE_NODE,
  PATH: process.env.PATH,
}

async function temporary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-office-convert-test-'))
  temporaryDirectories.push(root)
  return root
}

async function fakeLibreOffice(root: string): Promise<string> {
  const cli = join(root, 'libreoffice-cli.mjs')
  await writeFile(cli, [
    "import { writeFileSync } from 'node:fs'",
    "const output = process.argv[process.argv.indexOf('--output') + 1]",
    "writeFileSync(output, '%PDF-1.4\\n')",
    '',
  ].join('\n'))
  return cli
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true })
  for (const [name, value] of Object.entries(original)) {
    if (value === undefined) Reflect.deleteProperty(process.env, name)
    else process.env[name] = value
  }
})

describe('office conversion arguments', () => {
  it('parses every supported option and defaults to auto', () => {
    expect(parseConvertArguments(['--input', 'legacy.wps', '--output', 'modern.docx'])).toEqual({
      help: false, input: 'legacy.wps', output: 'modern.docx', engine: 'auto',
    })
    expect(parseConvertArguments(['--help']).help).toBe(true)
    expect(parseConvertArguments(['--engine', 'libreoffice']).engine).toBe('libreoffice')
  })

  it('rejects missing values and unknown arguments', () => {
    expect(() => parseConvertArguments(['--input'])).toThrow('requires a value')
    expect(() => parseConvertArguments(['--engine', 'wps-office'])).toThrow('--engine must be one of')
    expect(() => parseConvertArguments(['--verbose'])).toThrow('unknown argument')
  })
})

describe('WPS discovery', () => {
  it('requires both documented non-interactive switches', () => {
    expect(helpAdvertisesConversion('--headless --convert-to pdf')).toBe(true)
    expect(helpAdvertisesConversion('--headless')).toBe(false)
    expect(helpAdvertisesConversion('--convert-to pdf')).toBe(false)
  })

  it('selects the family executable from DSH_WPS_DIR', async () => {
    const root = await temporary()
    await writeFile(join(root, 'et'), '#!/bin/sh\n')
    expect(wpsBinaryFor('workbook.et', { ...process.env, PATH: '', DSH_WPS_DIR: root })).toBe(join(root, 'et'))
    expect(wpsBinaryFor('document.wps', { ...process.env, PATH: '', DSH_WPS_DIR: root })).toBeUndefined()
  })
})

describe('converted output validation', () => {
  it('accepts PDF and OOXML signatures and rejects empty or wrong formats', async () => {
    const root = await temporary()
    const pdf = join(root, 'ok.pdf')
    const docx = join(root, 'ok.docx')
    const empty = join(root, 'empty.pdf')
    const wrong = join(root, 'wrong.pdf')
    await writeFile(pdf, '%PDF-1.7\n')
    await writeFile(docx, 'PK\u0003\u0004')
    await writeFile(empty, '')
    await writeFile(wrong, 'not a pdf')
    expect(() => { validateConvertedFile(pdf, 'pdf') }).not.toThrow()
    expect(() => { validateConvertedFile(docx, 'docx') }).not.toThrow()
    expect(() => { validateConvertedFile(empty, 'pdf') }).toThrow('produced no file')
    expect(() => { validateConvertedFile(wrong, 'pdf') }).toThrow('invalid PDF')
  })
})

describe('LibreOffice fallback', () => {
  it('converts through the configured LibreOffice CLI when WPS is unavailable', async () => {
    const root = await temporary()
    const cli = await fakeLibreOffice(root)
    const input = join(root, 'input.docx')
    const output = join(root, 'result.pdf')
    await writeFile(input, 'PK\u0003\u0004')
    process.env.DSH_WPS_DIR = join(root, 'missing-wps')
    process.env.PATH = ''
    process.env.DSH_BUNDLED_OFFICE_CLI = cli
    process.env.DSH_BUNDLED_OFFICE_NODE = process.execPath
    expect(convertOfficeFile({ input, output, engine: 'auto' })).toEqual({ engine: 'libreoffice', output })
    expect(await readFile(output, 'utf8')).toBe('%PDF-1.4\n')
  })

  it.skipIf(process.platform === 'win32')('falls back after a failing WPS conversion', async () => {
    const root = await temporary()
    const wps = join(root, 'wps')
    const cli = await fakeLibreOffice(root)
    await writeFile(wps, [
      '#!/bin/sh',
      'if [ "$1" = "--help" ]; then',
      '  printf "%s\\n" "--headless --convert-to"',
      '  exit 0',
      'fi',
      'exit 7',
      '',
    ].join('\n'))
    await chmod(wps, 0o755)
    const input = join(root, 'input.wps')
    const output = join(root, 'result.pdf')
    await writeFile(input, 'wps')
    process.env.DSH_WPS_DIR = root
    process.env.PATH = ''
    process.env.DSH_BUNDLED_OFFICE_CLI = cli
    process.env.DSH_BUNDLED_OFFICE_NODE = process.execPath
    expect(convertOfficeFile({ input, output, engine: 'auto' })).toEqual({ engine: 'libreoffice', output })
  })

  it.skipIf(process.platform === 'win32')('publishes a headless WPS conversion when the probe succeeds', async () => {
    const root = await temporary()
    const wps = join(root, 'wps')
    await writeFile(wps, [
      '#!/bin/sh',
      'if [ "$1" = "--help" ]; then',
      '  printf "%s\\n" "--headless --convert-to"',
      '  exit 0',
      'fi',
      'outdir=',
      'target=',
      'input=',
      'while [ "$#" -gt 0 ]; do',
      '  case "$1" in',
      '    --convert-to) target=$2; shift 2 ;;',
      '    --outdir) outdir=$2; shift 2 ;;',
      '    *) input=$1; shift ;;',
      '  esac',
      'done',
      'base=${input##*/}',
      'base=${base%.*}',
      'printf "%s\\n" "%PDF-1.4" > "$outdir/$base.$target"',
      '',
    ].join('\n'))
    await chmod(wps, 0o755)
    const input = join(root, 'input.wps')
    const output = join(root, 'result.pdf')
    await writeFile(input, 'wps')
    process.env.DSH_WPS_DIR = root
    process.env.PATH = ''
    expect(convertOfficeFile({ input, output, engine: 'auto' })).toEqual({ engine: 'wps', output })
    expect(await readFile(output, 'utf8')).toBe('%PDF-1.4\n')
  })
})
