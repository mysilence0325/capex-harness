# Build the runtime image overlay from this checkout: build the three faces, prove the
# browser floor, pack the overlay, and print the next command.
#
# Steps:
#   1. build-local.ps1  host libs + client bundles + Web dist (the proven recipe; it
#                       deliberately skips the native addon and the desktop bundle).
#   2. verify-client-browser-floor   scans the bytes that actually ship
#                       (packages/client/*/lib/client*.js, packages/client/web/lib/**,
#                       apps/web/dist/**) for constructs and APIs the browser floor
#                       lacks. This is the evidence that the bundle runs on the floor.
#   3. make-image-overlay.mjs --all-lib   mirrors the built artifacts into the container
#                       install layout (every package with lib/, plus apps/web/dist).
#   4. tar -czf   one archive to upload.
#
# Usage:
#   .\build-image.ps1                 # locate the checkout automatically
#   .\build-image.ps1 -Repo D:\src\dsh -Out D:\tmp
#   .\build-image.ps1 -SkipBuild      # repack only; requires the build outputs
#
# This file is ASCII-only on purpose: Windows PowerShell 5.1 reads .ps1 files as ANSI
# unless they carry a BOM, which corrupts non-ASCII literals.
[CmdletBinding()]
param(
  [string] $Repo = '',
  [string] $Out = '',
  [switch] $SkipBuild
)

$ErrorActionPreference = 'Continue'

function Resolve-Checkout([string] $explicit) {
  $candidates = @()
  if ($explicit -ne '') { $candidates += $explicit }
  $candidates += (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
  $candidates += $PSScriptRoot
  foreach ($candidate in $candidates) {
    $manifest = Join-Path $candidate 'package.json'
    if (-not (Test-Path $manifest)) { continue }
    if ((Get-Content $manifest -Raw | ConvertFrom-Json).name -eq '@deepseek-ai/dsh-root') { return $candidate }
  }
  throw 'DSH checkout not found; pass -Repo <path to the checkout root>'
}

$repo = Resolve-Checkout $Repo
if ($Out -eq '') { $Out = Join-Path $repo 'deploy\multi-tenant' }
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmss')
$overlayDir = Join-Path $Out 'image-overlay'
$archive = Join-Path $Out "image-overlay-$stamp.tar.gz"
$log = Join-Path $Out 'build-image.log'

Set-Location $repo
Remove-Item $log -ErrorAction SilentlyContinue
function Note([string] $text) { $text | Tee-Object -FilePath $log -Append }

Note "checkout: $repo"
Note "overlay:  $overlayDir"
Note "archive:  $archive"

if (-not $SkipBuild) {
  Note '=== build (delegating to build-local.ps1) ==='
  & (Join-Path $PSScriptRoot 'build-local.ps1') -Repo $repo
  if ($LASTEXITCODE -ne 0) { Note '!! build-local.ps1 failed'; exit 1 }

  Note '=== browser floor gate (verify-client-browser-floor) ==='
  $tsx = Join-Path $repo 'node_modules\.bin\tsx.cmd'
  if (Test-Path $tsx) {
    & $tsx 'scripts/verify-client-browser-floor.ts'
  } else {
    & pnpm run verify-client-browser-floor
  }
  if ($LASTEXITCODE -ne 0) {
    Note '!! the built client artifacts do not satisfy the browser floor'
    exit 1
  }
  Note '    floor gate passed'
} else {
  Note '=== build skipped (-SkipBuild) ==='
}

Note '=== overlay ==='
& node 'deploy/multi-tenant/bin/make-image-overlay.mjs' --src . --out $overlayDir --all-lib
if ($LASTEXITCODE -ne 0) { Note '!! make-image-overlay failed'; exit 1 }
$manifestPath = Join-Path $overlayDir 'manifest.json'
if (-not (Test-Path $manifestPath)) { Note '!! overlay has no manifest.json'; exit 1 }
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
Note ("    packages={0} approxMiB={1} source={2}" -f $manifest.packages, [math]::Round($manifest.approxBytes / 1MB, 1), $manifest.source)
Note ("    frontendIndexSha256={0}" -f $manifest.frontendIndexSha256)

Note '=== pack ==='
Remove-Item $archive -ErrorAction SilentlyContinue
& tar -czf $archive -C $overlayDir .
if ($LASTEXITCODE -ne 0) { Note '!! tar failed'; exit 1 }
$size = (Get-Item $archive).Length
$sha = (Get-FileHash $archive -Algorithm SHA256).Hash.ToLower()
Note ("    {0}  {1:N1} MiB" -f $archive, ($size / 1MB))
Note ("    sha256 {0}" -f $sha)

Note ''
Note '=== next: upload and publish on the deployment host ==='
Note ("  scp `"{0}`" root@<主机>:/tmp/" -f $archive)
Note "  ssh root@<主机> 'cd /home/dsh-mt && bin/publish-and-verify.sh /tmp/$(Split-Path -Leaf $archive) --switch --mock'"
Note '  (内网那台机器改用 --smoke http://15.11.40.44:3100 <key> deepseek-v4-flash --expect <词>)'
Note ''
Note '=== BUILD OK ==='
