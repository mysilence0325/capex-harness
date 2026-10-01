<#
.SYNOPSIS
  Build, run, or package DeepSeek Harness from this source checkout.

.DESCRIPTION
  Modes:
    build      Build every face: native system, host libs, client bundles, Web dist, Desktop main bundle.
    dev        Build, then launch the Desktop application from source (no packaging, no runtime download).
    dir        Unpacked Windows application (electron-builder --dir): the fastest shippable output.
    installer  Windows installer (unsigned by default; -Signed selects the signed path).

  Both build records need a source commit. A checkout with .git supplies it; otherwise
  -CommitHash supplies the client record (7-40 hex) and its repetition the 40-character
  desktop record. Desktop packaging always reads the checkout with git, so it needs a
  repository: run "git init" and commit once when the tree was extracted without .git.

  dir/installer run the release pipeline: official build, npm packs of dsh/desktop-host/vendor,
  a native system build, the bundled Node + Python runtime download, electron-builder, and a
  packaged-runtime smoke check. Expect 20+ minutes, network access, and several GB free.
  Windows packaging also needs apps/desktop/.env.windows (copy the .example beside it).

.PARAMETER Mode
  build (default) | dev | dir | installer

.PARAMETER CommitHash
  7 to 40 hexadecimal characters used when .git is absent.

.PARAMETER Port
  Informational: override the application port in the profile patch (Desktop defaults to 19387).

.PARAMETER Signed
  With -Mode installer, use the signed Windows packaging path (needs the signing environment).

.PARAMETER SkipInstall
  Skip pnpm install and use the existing node_modules.

.EXAMPLE
  .\build-dsh.ps1
.EXAMPLE
  .\build-dsh.ps1 -Mode dev
.EXAMPLE
  .\build-dsh.ps1 -Mode dir
#>
[CmdletBinding()]
param(
  [ValidateSet('build', 'dev', 'dir', 'installer')]
  [string] $Mode = 'build',
  [ValidatePattern('^[0-9a-fA-F]{7,40}$')]
  [string] $CommitHash = '0000000',
  [int] $Port = 0,
  [switch] $Signed,
  [switch] $SkipInstall
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repo = $PSScriptRoot
$desktopBuildRoot = Join-Path $repo 'apps\desktop\.desktop-build'

function Write-Step([string] $message) {
  Write-Host ''
  Write-Host "==> $message" -ForegroundColor Cyan
}

function Invoke-Pnpm([string[]] $arguments) {
  Write-Host ("    pnpm " + ($arguments -join ' ')) -ForegroundColor DarkGray
  # pnpm writes progress and warnings to stderr, and ErrorActionPreference Stop would turn
  # those into terminating errors; failures are read from the exit code instead.
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & pnpm @arguments } finally { $ErrorActionPreference = $previous }
  if ($LASTEXITCODE -ne 0) { throw "pnpm $($arguments -join ' ') failed with exit code $LASTEXITCODE" }
}

# --- Preconditions -------------------------------------------------------------------------
$manifest = Join-Path $repo 'package.json'
if (-not (Test-Path $manifest)) { throw "not a repository root: $manifest is missing" }
$name = (Get-Content $manifest -Raw | ConvertFrom-Json).name
if ($name -ne '@deepseek-ai/dsh-root') { throw "unexpected root package: $name" }
foreach ($tool in @('node', 'pnpm')) {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "$tool is not on PATH" }
}

# --- Build identity ------------------------------------------------------------------------
$gitCommit = $null
if (Test-Path (Join-Path $repo '.git')) {
  $gitCommit = (& git -C $repo rev-parse HEAD 2>$null | Select-Object -First 1)
}
if ($gitCommit -match '^[0-9a-fA-F]{40}$') {
  $env:DSH_CLIENT_COMMIT_HASH = $gitCommit.Substring(0, 7).ToLowerInvariant()
  $env:DSH_DESKTOP_BUILD_COMMIT = $gitCommit.ToLowerInvariant()
  $identity = "git $($env:DSH_CLIENT_COMMIT_HASH)"
} else {
  $repeats = [math]::Ceiling(40 / $CommitHash.Length)
  $env:DSH_CLIENT_COMMIT_HASH = $CommitHash
  $env:DSH_DESKTOP_BUILD_COMMIT = ($CommitHash * $repeats).Substring(0, 40).ToLowerInvariant()
  $identity = "explicit $CommitHash (no .git in this checkout)"
}
Write-Step "Repository $repo"
Write-Host "    mode: $Mode | source: $identity | node: $(node --version) | pnpm: $(pnpm --version)"

if ($Mode -eq 'dev') {
  $running = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
  if ($running.Count -gt 0) {
    $pids = ($running | ForEach-Object { $_.Id }) -join ', '
    throw "the Desktop application is running (pid $pids) and holds the single-instance lock on the desktop profile; quit it from the system tray and rerun"
  }
}

if (-not $SkipInstall) {
  Write-Step 'Installing workspace dependencies'
  Invoke-Pnpm @('install', '--frozen-lockfile')
}

# --- Build ---------------------------------------------------------------------------------
Write-Step 'Building every face (native system, host libs, client bundles, Web dist, Desktop bundle)'
Invoke-Pnpm @('run', 'build')

if ($Port -ne 0) {
  Write-Host "    port $Port requested: set webserver.config.port in the profile patch; the Desktop shell defaults to 19387" -ForegroundColor Yellow
}

switch ($Mode) {
  'build' {
    Write-Step 'Build complete'
    Write-Host '    artifacts: packages/*/lib (plugin bundles), apps/web/dist (Web shell), apps/desktop/lib (Desktop main bundle)'
  }
  'dev' {
    Write-Step 'Launching the Desktop application from source'
    Invoke-Pnpm @('run', 'start:desktop')
  }
  'dir' {
    # Local packaging is unsigned: the signed path validates the certificate environment.
    Write-Step 'Packaging an unpacked Windows application (unsigned)'
    Invoke-Pnpm @('--filter', '@deepseek-ai/dsh-desktop', 'run', 'package:dir', '--', '--unsigned')
    Write-Step 'Package complete'
    if (Test-Path $desktopBuildRoot) {
      Get-ChildItem $desktopBuildRoot -Recurse -Directory -Filter 'artifacts' -ErrorAction SilentlyContinue |
        ForEach-Object { Write-Host "    $($_.FullName)" }
    }
  }
  'installer' {
    $forward = if ($Signed) { @() } else { @('--', '--unsigned') }
    $label = if ($Signed) { 'signed' } else { 'unsigned' }
    Write-Step "Packaging a Windows installer ($label)"
    Invoke-Pnpm (@('--filter', '@deepseek-ai/dsh-desktop', 'run', 'package') + $forward)
    Write-Step 'Installer complete'
    if (Test-Path $desktopBuildRoot) {
      Get-ChildItem $desktopBuildRoot -Recurse -File -Include '*.exe' -ErrorAction SilentlyContinue |
        ForEach-Object { Write-Host "    $($_.FullName)" }
    }
  }
}
