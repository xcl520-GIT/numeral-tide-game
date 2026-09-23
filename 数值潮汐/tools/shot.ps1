# ============================================================
# shot.ps1 - take a deterministic screenshot of 数值潮汐 via probe_shot.html
#
# ASCII-only on purpose: PowerShell 5.1 parses a BOM-less UTF-8 script as
# GBK, so non-ASCII source here would break silently. Keep this file ASCII.
#
# Why a wrapper (three traps it encodes):
#   1) --screenshot WITHOUT --window-size gives a 754x487 image, not the
#      1380x880 client area of the exe. Always pass --window-size.
#   2) --screenshot WITH --virtual-time-budget never writes the file and
#      never exits. --dump-dom WITH it hangs the same way on a page that
#      has a running animation loop (dump file stays 0 bytes and locked).
#      -> this script passes virtual time to NEITHER run.
#   3) A leftover msedge instance owns the user-data-dir; the new process
#      hands the URL over and exits, so output is 0 bytes and the page
#      looks broken. -> kill msedge first, then wait.
#
# The page URL is built with [System.Uri] so the non-ASCII project path is
# percent-encoded correctly instead of hand-escaped.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File tools\shot.ps1 -shot bag
#   powershell -ExecutionPolicy Bypass -File tools\shot.ps1 -shot play -walk 120 -seed 7
#   ... -shot relic -o E:\out\relic.png -report
# ============================================================
param(
  [Parameter(Mandatory = $true)][string]$shot,
  [string]$o = '',
  [int]$w = 1380,
  [int]$h = 880,
  [int]$walk = 60,
  [string]$cls = 'warlord',
  [string]$diff = 'standard',
  [string]$seed = '20260922',
  [string]$page = '',
  [double]$bail = 0.30,
  [double]$hurt = 0.75,
  [int]$bag = 7,
  [string]$prof = "$env:TEMP\edgeprof_smoke",
  [switch]$report
)

$ErrorActionPreference = 'Continue'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
if (-not (Test-Path $edge)) { Write-Host "NO EDGE: $edge"; exit 1 }

if (-not $o) { $o = "$env:TEMP\tide_shots\$shot.png" }
$oDir = Split-Path -Parent $o
if (-not (Test-Path $oDir)) { New-Item -ItemType Directory -Force -Path $oDir | Out-Null }

# [System.Uri] handles the percent-encoding of the non-ASCII path for us.
$url = ([System.Uri]"$PSScriptRoot\probe_shot.html").AbsoluteUri
$url += "?shot=$shot&w=$w&h=$h&walk=$walk&cls=$cls&diff=$diff&seed=$seed&bail=$bail&hurt=$hurt&bag=$bag"
if ($page) { $url += "&page=$page" }

$common = @(
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--allow-file-access-from-files', "--user-data-dir=$prof", "--window-size=$w,$h"
)

function Stop-Edge {
  Get-Process msedge -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 3
}

function Run-Edge([string[]]$extra, [string]$dumpTo) {
  Stop-Edge
  $a = $common + $extra + @($url)
  if ($dumpTo) {
    $p = Start-Process -FilePath $edge -ArgumentList $a -PassThru -NoNewWindow -Wait `
         -RedirectStandardOutput $dumpTo -RedirectStandardError "$dumpTo.err"
  } else {
    $p = Start-Process -FilePath $edge -ArgumentList $a -PassThru -NoNewWindow -Wait
  }
  Start-Sleep -Seconds 2
  return $p
}

# ---- 1) the screenshot -------------------------------------
if (Test-Path $o) { Remove-Item $o -Force -ErrorAction SilentlyContinue }
Run-Edge @("--screenshot=$o") $null | Out-Null
if (-not (Test-Path $o)) { Write-Host "FAIL: no screenshot written"; exit 1 }
$kb = [math]::Round((Get-Item $o).Length / 1KB, 1)
Write-Host "png  $o  ($kb KB)"

# ---- 2) the observation report (no virtual time!) ----------
if ($report) {
  $dump = "$oDir\$shot.dump.html"
  if (Test-Path $dump) { Remove-Item $dump -Force -ErrorAction SilentlyContinue }
  Run-Edge @('--dump-dom') $dump | Out-Null
  if (-not (Test-Path $dump) -or (Get-Item $dump).Length -eq 0) {
    Write-Host "FAIL: empty dump (leftover msedge? rerun)"; exit 1
  }
  $t = [System.IO.File]::ReadAllText($dump, [System.Text.Encoding]::UTF8)
  $m = [regex]::Match($t, '(?s)<pre id="out">(.*?)</pre>')
  if ($m.Success) {
    $body = $m.Groups[1].Value -replace '&lt;', '<' -replace '&gt;', '>' -replace '&amp;', '&'
    Write-Host "--- report ---"
    Write-Host $body
    if ($body -notmatch 'RESULT=OK') { Write-Host "!! page reported a problem" }
    if ($body -match '!!') { Write-Host "!! geometry out of viewport somewhere" }
  } else {
    Write-Host "!! no report block found in dump"
  }
}

Stop-Edge
