# Build the three faces this deployment needs: host libs, client bundles, Web dist.
#
# scripts/build.ts is deliberately not used:
#   * build:native-system produces Windows .node binaries that must not ship to a
#     Linux container;
#   * the desktop bundle only serves Electron.
# Neither affects the Web GUI.
#
# Binaries are called directly instead of through `pnpm exec`: inside this
# script's pipeline pnpm misreads exec as recursive mode
# (ERR_PNPM_RECURSIVE_EXEC_NO_PACKAGE).
#
# This file is ASCII-only on purpose. Windows PowerShell 5.1 reads .ps1 files as
# ANSI unless they carry a BOM, which corrupts non-ASCII literals.
#
#   .\build-local.ps1                 # locate the checkout automatically
#   .\build-local.ps1 -Repo D:\src\dsh
[CmdletBinding()]
param([string] $Repo = '')

$ErrorActionPreference = 'Continue'

function Resolve-Checkout([string] $explicit) {
  $candidates = @()
  if ($explicit -ne '') { $candidates += $explicit }
  # Inside the repository: <repo>/deploy/multi-tenant -> <repo>.
  $candidates += (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
  # Beside a standalone working copy of this deployment project.
  $candidates += (Join-Path (Split-Path -Parent $PSScriptRoot) 'deepseek-harness-dsh-v0.2.0-rc.2')
  $candidates += $PSScriptRoot
  foreach ($candidate in $candidates) {
    $manifest = Join-Path $candidate 'package.json'
    if (-not (Test-Path $manifest)) { continue }
    if ((Get-Content $manifest -Raw | ConvertFrom-Json).name -eq '@deepseek-ai/dsh-root') { return $candidate }
  }
  throw 'DSH checkout not found; pass -Repo <path to the checkout root>'
}

$repo = Resolve-Checkout $Repo
$log = Join-Path $PSScriptRoot 'build-local.log'
Set-Location $repo
Remove-Item $log -ErrorAction SilentlyContinue

function Step([string] $name, [scriptblock] $body) {
  $started = Get-Date
  "=== $name ($($started.ToString('HH:mm:ss'))) ===" | Tee-Object -FilePath $log -Append
  & $body 2>&1 | Tee-Object -FilePath $log -Append | Select-Object -Last 2
  if ($LASTEXITCODE -ne 0) {
    "!! $name FAILED exit=$LASTEXITCODE" | Tee-Object -FilePath $log -Append
    exit 1
  }
  "    ok $([int]((Get-Date) - $started).TotalSeconds)s" | Tee-Object -FilePath $log -Append
}

"checkout: $repo" | Tee-Object -FilePath $log -Append

Step 'tsc host'      { node --max-old-space-size=4096 .\node_modules\typescript\bin\tsc -b tsconfig.host.json }
Step 'tsdown host'   { & .\node_modules\.bin\tsdown.cmd --env.DSH_BUILD_FACE host }
Step 'tsc client'    { node .\node_modules\typescript\bin\tsc -b tsconfig.client.json }
Step 'tsdown client' { & .\node_modules\.bin\tsdown.cmd --env.DSH_BUILD_FACE client }
Step 'web dist'      { & pnpm --filter '@deepseek-ai/dsh-web-frontend' run build }

"=== BUILD OK ===" | Tee-Object -FilePath $log -Append
Get-Item 'apps\web\dist\index.html','packages\client\ui-chat\lib\client.js','apps\cli\lib\bin.js' |
  ForEach-Object { "  {0,-16} {1}  {2} B" -f $_.Name, $_.LastWriteTime, $_.Length } |
  Tee-Object -FilePath $log -Append
