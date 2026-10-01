<#
.SYNOPSIS
  Build, run, or package DeepSeek Harness from this source checkout.

.DESCRIPTION
  Modes:
    build      Build every face: native system, host libs, client bundles, Web dist, Desktop main bundle.
    dev        Build, then launch the Desktop application from source (no packaging, no runtime download).
    dir        Full unpacked Windows application (electron-builder --dir): fastest shippable output.
    installer  Windows installer (unsigned by default; -Signed selects the signed path).

  This checkout has no .git, so the build record needs an explicit commit hash: the script
  exports DSH_CLIENT_COMMIT_HASH (-CommitHash, default 0000000) before every pnpm step.

  dir/installer run the release pipeline: official build, npm packs of dsh/desktop-host/vendor,
  the bundled Node + Python runtime download, electron-builder, and a packaged-runtime smoke
  check. Expect 20+ minutes, network access, and several GB of free space.

.PARAMETER Mode
  build (default) | dev | dir | installer

.PARAMETER CommitHash
  7 to 40 hexadecimal characters recorded as the source commit. Used when .git is absent.

.PARAMETER Port
  Override the application port (default: 19387 for the Desktop shell, 3080 for Web).

.PARAMETER Signed
  With -Mode installer, use the signed Windows packaging path (needs the signing environment).

.PARAMETER SkipInstall
  Skip pnpm install and use the existing node_modules.

.EXAMPLE
  .\build-dsh.ps1
  Build every face with the fixes in this checkout.

.EXAMPLE
  .\build-dsh.ps1 -Mode dev
  Build and launch the Desktop application from source.

.EXAMPLE
  .\build-dsh.ps1 -Mode dir
  Produce an unpacked Windows application under apps\\desktop\\.desktop-build.
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
  # pnpm writes progress and warnings to stderr; ErrorActionPreference Stop would
  # turn those into terminating errors, so failures are read from the exit code.
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

# Two build records reject a missing or stale commit, and their resolvers call git when
# no explicit value is present: the client record takes 7-40 hex characters and the desktop
# release record needs exactly 40. Both are derived from -CommitHash on a git-less checkout.
$env:DSH_CLIENT_COMMIT_HASH = $CommitHash
$repeats = [math]::Ceiling(40 / $CommitHash.Length)
$env:DSH_DESKTOP_BUILD_COMMIT = ($CommitHash * $repeats).Substring(0, 40).ToLowerInvariant()
Write-Step "Repository $repo"
Write-Host "    mode: $Mode | commit hash: $CommitHash | desktop record: $($env:DSH_DESKTOP_BUILD_COMMIT) | node: $(node --version) | pnpm: $(pnpm --version)"

if ($Mode -eq 'dev') {
  $running = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue
  if ($running) {
    throw ('the Desktop application is running (pid ' + (($running | ForEach-Object { $_.Id }) -join ', ') +
      '); it holds the single-instance lock on the desktop profile. Quit it from the system tray and rerun.')
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
  Write-Host "    port override requested: $Port (set webserver.config.port in the profile patch; the Desktop shell defaults to 19387)" -ForegroundColor Yellow
}

# --- Mode-specific completion --------------------------------------------------------------
switch ($Mode) {
  'build' {
    Write-Step 'Build complete'
    Write-Host '    artifacts: packages/*/lib (bundles), apps/web/dist (shell), apps/desktop/lib (main bundle)'
  }
  'dev' {
    Write-Step 'Launching the Desktop application from source'
    Invoke-Pnpm @('run', 'start:desktop')
  }
  'dir' {
    Write-Step 'Packaging an unpacked Windows application'
    Invoke-Pnpm @('run', 'package:desktop:win:x64:dir')
    Write-Step 'Package complete'
    if (Test-Path $desktopBuildRoot) {
      Get-ChildItem $desktopBuildRoot -Recurse -Directory -Filter 'artifacts' -ErrorAction SilentlyContinue |
        ForEach-Object { Write-Host "    $($_.FullName)" }
    }
  }
  'installer' {
    $task = if ($Signed) { 'package:desktop:win:x64' } else { 'package:desktop:win:x64:unsigned' }
    Write-Step "Packaging a Windows installer ($task)"
    Invoke-Pnpm @('run', $task)
    Write-Step 'Installer complete'
    if (Test-Path $desktopBuildRoot) {
      Get-ChildItem $desktopBuildRoot -Recurse -File -Include '*.exe' -ErrorAction SilentlyContinue |
        ForEach-Object { Write-Host "    $($_.FullName)" }
    }
  }
}
