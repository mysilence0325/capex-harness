/** `dsh doctor`: bounded local installation and deployment diagnostics. */
import { execFile } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, rm, statfs, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { composeEntries, getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { collectConfigDumpLayers } from './dump-config.ts'
import { prepareProfile } from './profile-boot.ts'

const execFileAsync = promisify(execFile)

/** One doctor outcome. */
export interface DoctorCheck {
  readonly id: string
  readonly status: 'pass' | 'warn' | 'fail' | 'skip'
  readonly summary: string
  readonly detail?: string
}

/** Stable machine-readable doctor report. */
export interface DoctorReport {
  readonly version: 1
  readonly status: 'ok' | 'warn' | 'fail'
  readonly startedAt: string
  readonly durationMs: number
  readonly versionInfo: string
  readonly profile: string
  readonly checks: readonly DoctorCheck[]
}

/** Parsed doctor command. */
export interface DoctorOptions {
  readonly profile: string
  readonly modelUrl?: string
  readonly json: boolean
  readonly quick: boolean
  readonly writeReport: boolean
  readonly patches: readonly string[]
}

/** Parse the doctor's stable option surface. */
export function parseDoctorArgs(args: readonly string[]): DoctorOptions {
  let profile = 'web'
  let modelUrl: string | undefined
  let json = false
  let quick = false
  let writeReport = true
  const patches: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string
    if (arg === '--json') json = true
    else if (arg === '--quick') quick = true
    else if (arg === '--no-report') writeReport = false
    else if (arg === '--write-report') writeReport = true
    else if (arg === '--profile' || arg === '--model-url' || arg === '--patch') {
      const value = args[++index]
      if (value === undefined || value === '') throw new Error(`doctor: ${arg} needs a value`)
      if (arg === '--profile') profile = value
      else if (arg === '--model-url') modelUrl = value
      else patches.push(value)
    } else if (arg.startsWith('--profile=')) {
      profile = arg.slice('--profile='.length)
      if (profile === '') throw new Error('doctor: --profile needs a value')
    } else if (arg.startsWith('--model-url=')) {
      modelUrl = arg.slice('--model-url='.length)
      if (modelUrl === '') throw new Error('doctor: --model-url needs a value')
    } else if (arg.startsWith('--patch=')) {
      const value = arg.slice('--patch='.length)
      if (value === '') throw new Error('doctor: --patch needs a value')
      patches.push(value)
    }
    else if (arg === '--help' || arg === '-h') {
      printDoctorHelp()
      process.exit(0)
    } else throw new Error(`doctor: unknown argument ${JSON.stringify(arg)}`)
  }
  if (profile === '') throw new Error('doctor: --profile needs a value')
  return { profile, ...(modelUrl === undefined ? {} : { modelUrl }), json, quick, writeReport, patches }
}

function printDoctorHelp(): void {
  process.stdout.write([
    'Usage: dsh doctor [options]',
    '',
    'Check the local Capex Harness installation and deployment.',
    '',
    'Options:',
    '  --profile <name>       Profile whose model configuration is inspected (default: web)',
    '  --patch <file>         Additional profile patch layer (repeatable)',
    '  --model-url <url>      Explicit OpenAI-compatible base URL to probe',
    '  --quick                Skip model and Office conversion probes',
    '  --json                 Print one machine-readable report',
    '  --no-report            Do not write the JSON report under DSH_HOME/logs',
    '  -h, --help             Show this help',
    '',
  ].join('\n'))
}

function collectHttpUrls(value: unknown, output: Set<string>): void {
  if (typeof value === 'string') {
    if (/^https?:\/\//u.test(value)) output.add(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectHttpUrls(item, output)
    return
  }
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) collectHttpUrls(item, output)
  }
}

/** Discover literal model endpoints without evaluating JavaScript expressions. */
export function discoverModelUrls(profile: string, patches: readonly string[] = []): readonly string[] {
  const loaded = prepareProfile(profile)
  const layers = collectConfigDumpLayers(loaded, false, patches)
  const entries = composeEntries(layers.map(layer => layer.patches))
  const urls = new Set<string>()
  for (const entry of entries) {
    if (entry.id !== 'llm-pi-ai') continue
    collectHttpUrls(entry.config, urls)
  }
  return [...urls]
}

function check(id: string, status: DoctorCheck['status'], summary: string, detail?: string): DoctorCheck {
  return { id, status, summary, ...(detail === undefined ? {} : { detail }) }
}

async function checkPath(path: string, mode: number): Promise<void> {
  await access(path, mode)
}

async function checkModel(url: string): Promise<DoctorCheck> {
  try {
    const endpoint = new URL('models', url.endsWith('/') ? url : `${url}/`)
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(3_000) })
    if (response.status === 200 || response.status === 401) {
      return check('model', 'pass', `Model endpoint responded with HTTP ${String(response.status)}`, endpoint.href)
    }
    return check('model', 'fail', `Model endpoint returned HTTP ${String(response.status)}`, endpoint.href)
  } catch (error) {
    return check('model', 'fail', 'Model endpoint is unreachable', error instanceof Error ? error.message : String(error))
  }
}

async function checkFonts(): Promise<DoctorCheck> {
  if (process.platform !== 'linux') return check('fonts', 'skip', 'Font probe applies to Linux')
  const fonts = ['仿宋', '仿宋_GB2312', '楷体', '方正小标宋', '黑体', '宋体', '微软雅黑', 'Noto Sans CJK SC']
  const missing: string[] = []
  for (const font of fonts) {
    try {
      const { stdout } = await execFileAsync('fc-match', ['-f', '%{family}\n%{file}', font], { timeout: 2_000 })
      const [matched = '', file = ''] = stdout.split('\n')
      if (file.trim() === '' || matched.trim() === '') missing.push(font)
    } catch {
      return check('fonts', 'fail', 'fontconfig is unavailable', 'install fontconfig and the required Chinese fonts')
    }
  }
  return missing.length === 0
    ? check('fonts', 'pass', 'Required Chinese font families resolve locally')
    : check('fonts', 'fail', 'Some Chinese font families do not resolve', missing.join(', '))
}

async function checkOffice(): Promise<DoctorCheck> {
  if (process.platform !== 'linux') return check('office', 'skip', 'Office conversion probe applies to the Linux package')
  const directory = await mkdtemp(join(tmpdir(), 'dsh-doctor-office-'))
  try {
    const input = join(directory, 'input.docx')
    const output = join(directory, 'output.pdf')
    await execFileAsync('dsh-python', ['-c', [
      'from docx import Document',
      `d=Document(); d.add_paragraph("doctor"); d.save(${JSON.stringify(input)})`,
    ].join('\n')], { timeout: 15_000 })
    const started = Date.now()
    await execFileAsync('dsh-office-convert', ['--input', input, '--output', output], {
      timeout: 15_000,
      env: { ...process.env, DSH_OFFICE_CONVERT_TIMEOUT_MS: '15000' },
    })
    const signature = (await readFile(output)).subarray(0, 5).toString('utf8')
    if (signature !== '%PDF-') return check('office', 'fail', 'Office conversion produced no PDF')
    return check('office', 'pass', 'Office conversion smoke passed', `${String(Date.now() - started)}ms`)
  } catch (error) {
    return check('office', 'fail', 'Office conversion smoke failed', error instanceof Error ? error.message : String(error))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function checkTempAndSpawn(): Promise<DoctorCheck> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-doctor-temp-'))
  try {
    await writeFile(join(directory, 'probe'), 'ok', { mode: 0o600 })
    await execFileAsync(process.execPath, ['-e', 'process.exit(0)'], { timeout: 5_000 })
    return check('process', 'pass', 'Temporary storage and subprocess execution are available')
  } catch (error) {
    return check('process', 'fail', 'Temporary storage or subprocess execution is blocked',
      `A security agent may be restricting this process. ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function checkProxy(url: string | undefined): DoctorCheck {
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy
  if (proxy === undefined || proxy === '') return check('proxy', 'pass', 'No outbound HTTP proxy is set')
  if (url === undefined) return check('proxy', 'warn', 'An HTTP proxy is set; verify it excludes the model host', proxy.replace(/\/\/[^/@]+@/u, '//***@'))
  const host = new URL(url).hostname
  const noProxy = (process.env.NO_PROXY ?? process.env.no_proxy ?? '').split(',').map(value => value.trim())
  const excluded = noProxy.some(value => value === '*' || value === host || host.endsWith(value.replace(/^\./u, '')))
  return excluded
    ? check('proxy', 'pass', 'The model host is excluded from the configured proxy')
    : check('proxy', 'warn', 'A proxy is set and does not explicitly exclude the model host', host)
}

function localeCopy(): boolean {
  return (process.env.LC_ALL ?? process.env.LC_MESSAGES ?? process.env.LANG ?? '').toLowerCase().startsWith('zh')
}

function renderReport(report: DoctorReport): string {
  const zh = localeCopy()
  const labels = { pass: zh ? '通过' : 'PASS', warn: zh ? '警告' : 'WARN', fail: zh ? '失败' : 'FAIL', skip: zh ? '跳过' : 'SKIP' }
  const lines = [`dsh doctor ${report.status.toUpperCase()}`, '']
  for (const item of report.checks) {
    lines.push(`[${labels[item.status]}] ${item.id}: ${item.summary}`)
    if (item.detail !== undefined) lines.push(`  ${item.detail}`)
  }
  lines.push('', `${zh ? '耗时' : 'Duration'}: ${String(report.durationMs)}ms`)
  return `${lines.join('\n')}\n`
}

/**
 * Run the doctor and return its exit status.
 * @param args - arguments after `doctor`.
 * @returns 0 without failures, 1 when any check fails.
 */
export async function runDoctor(args: readonly string[]): Promise<number> {
  let options: DoctorOptions
  try { options = parseDoctorArgs(args) } catch (error) {
    process.stderr.write(`dsh: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
  const started = Date.now()
  const versionInfo = getDshRuntimeVersion()
  const home = resolveDshHome()
  const urls = new Set<string>()
  if (options.modelUrl !== undefined) urls.add(options.modelUrl)
  else {
    try {
      for (const url of discoverModelUrls(options.profile, options.patches)) urls.add(url)
    } catch {
      // The profile may be absent on a maintenance-only machine; the report names that state below.
    }
  }
  const checks: DoctorCheck[] = []
  checks.push(check('installation', 'pass', `Running dsh ${versionInfo} on ${process.platform}/${process.arch}`,
    process.execPath))
  try {
    await checkPath(home, fsConstants.R_OK | fsConstants.W_OK)
    checks.push(check('home', 'pass', 'Harness home is readable and writable', home))
  } catch (error) {
    checks.push(check('home', 'fail', 'Harness home is not writable', error instanceof Error ? error.message : String(error)))
  }
  const tokenFile = process.env.XDG_STATE_HOME === undefined
    ? (process.env.HOME === undefined ? undefined : join(process.env.HOME, '.local', 'state', 'capex-harness', 'web-url'))
    : join(process.env.XDG_STATE_HOME, 'capex-harness', 'web-url')
  if (tokenFile === undefined) checks.push(check('token', 'skip', 'No local state directory is available'))
  else {
    try {
      const value = (await readFile(tokenFile, 'utf8')).trim()
      new URL(value)
      checks.push(check('token', 'pass', 'Authenticated launch URL is present', tokenFile))
    } catch (error) {
      checks.push(check('token', 'warn', 'Authenticated launch URL is absent; the app may simply not be running',
        error instanceof Error ? error.message : String(error)))
    }
  }
  checks.push(checkProxy([...urls][0]))
  checks.push(await checkFonts())
  checks.push(await checkTempAndSpawn())
  try {
    if (process.platform === 'linux') {
      const root = process.env.DSH_ROOT ?? '/usr/lib/capex-harness'
      const info = await statfs(root === '' ? '/' : root)
      const available = info.bavail * info.bsize
      checks.push(available >= 5 * 1024 * 1024 * 1024
        ? check('disk', 'pass', 'At least 5 GiB is available', `${(available / 1024 / 1024 / 1024).toFixed(1)} GiB`)
        : check('disk', 'fail', 'Less than 5 GiB is available', `${(available / 1024 / 1024 / 1024).toFixed(1)} GiB`))
    } else checks.push(check('disk', 'skip', 'Disk threshold is enforced on the Linux package'))
  } catch (error) {
    checks.push(check('disk', 'fail', 'Could not measure available disk space', error instanceof Error ? error.message : String(error)))
  }
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  checks.push(timezone === 'Asia/Shanghai'
    ? check('locale', 'pass', 'Time zone is Asia/Shanghai')
    : check('locale', 'warn', `Time zone is ${timezone}`))
  if (options.quick) {
    checks.push(check('model', 'skip', 'Skipped by --quick'))
    checks.push(check('office', 'skip', 'Skipped by --quick'))
  } else if (urls.size === 0) {
    checks.push(check('model', 'fail', 'No literal model endpoint was found; pass --model-url or configure the profile'))
  } else {
    for (const [index, url] of [...urls].entries()) {
      const result = await checkModel(url)
      checks.push({ ...result, id: index === 0 ? 'model' : `model-${String(index + 1)}` })
    }
  }
  if (!options.quick) checks.push(await checkOffice())
  const status = checks.some(item => item.status === 'fail') ? 'fail' : checks.some(item => item.status === 'warn') ? 'warn' : 'ok'
  const report: DoctorReport = {
    version: 1,
    status,
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    versionInfo,
    profile: options.profile,
    checks,
  }
  if (options.writeReport) {
    const path = join(home, 'logs', `doctor-${report.startedAt.replaceAll(':', '-')}.json`)
    try {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      await writeFile(path, `${JSON.stringify(report, undefined, 2)}\n`, { mode: 0o600 })
      if (!options.json) process.stdout.write(`report: ${path}\n`)
    } catch (error) {
      if (!options.json) process.stderr.write(`dsh: could not write doctor report: ${String(error)}\n`)
    }
  }
  process.stdout.write(options.json ? `${JSON.stringify(report, undefined, 2)}\n` : renderReport(report))
  return status === 'fail' ? 1 : 0
}
