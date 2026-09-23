# ============================================================
# Run a page in headless Edge and print the test output.
# (ASCII-only on purpose: PowerShell 5.1 needs a BOM to parse a
#  UTF-8 script with non-ASCII source, and a BOM-less save would
#  silently break it. Keep this file ASCII.)
#
# Why this wrapper exists - three traps it encodes:
#   1) A previous Edge instance OWNS the user-data-dir. A new launch
#      hands the URL to the running instance and exits, so --dump-dom
#      prints 0 bytes and it looks like the page is broken.
#      -> kill msedge first, wait, then launch.
#   2) The output file is still held open when the process exits,
#      so reading immediately either throws or returns 0 bytes.
#      -> wait for the flush before reading.
#   3) A fresh --user-data-dir triggers Edge's first-run flow, which
#      swallows --dump-dom output entirely.
#      -> always reuse the same profile directory.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File tools\run_page.ps1 -url "<file url>" -budget 200000 -grep "FAIL|result"
# ============================================================
param(
  [Parameter(Mandatory = $true)][string]$url,
  [int]$budget = 150000,
  [string]$out = "$env:TEMP\tide_page_out.html",
  [string]$grep = '',
  [switch]$dumpRaw
)

$ErrorActionPreference = 'Continue'
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$prof = "$env:TEMP\edgeprof_smoke"

Get-Process msedge -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3

$a = @(
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--allow-file-access-from-files', "--user-data-dir=$prof",
  "--virtual-time-budget=$budget", '--dump-dom', $url
)
$p = Start-Process -FilePath $edge -ArgumentList $a -RedirectStandardOutput $out -RedirectStandardError "$out.err" -PassThru -NoNewWindow
if (-not $p.WaitForExit($budget + 240000)) { Write-Host 'TIMEOUT'; $p.Kill() }

# Let the process actually flush the file before we touch it.
Start-Sleep -Milliseconds 2000
Get-Process msedge -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

if (-not (Test-Path -LiteralPath $out)) { Write-Host 'NO OUTPUT FILE'; exit 1 }
$size = (Get-Item -LiteralPath $out).Length
Write-Host "bytes=$size"
if ($size -eq 0) { Write-Host 'EMPTY OUTPUT (see the .err file next to it)'; exit 1 }

$t = [System.IO.File]::ReadAllText($out, [System.Text.Encoding]::UTF8)
$b = $t -replace '(?s)^.*?<pre[^>]*>', '' -replace '(?s)</pre>.*$', ''
$b = $b -replace '&lt;', '<' -replace '&gt;', '>' -replace '&amp;', '&'

if ($dumpRaw) { Write-Host $b; exit 0 }

$L = $b -split "`n"
$okN = ($L | Where-Object { $_ -match '^\s+ok\s' }).Count
$badN = ($L | Where-Object { $_ -match '^\s+FAIL' }).Count
Write-Host "ok=$okN  FAIL=$badN"
if ($grep) { $L | Where-Object { $_ -match $grep } | ForEach-Object { $_ } }
