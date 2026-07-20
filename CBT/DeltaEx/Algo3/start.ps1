# start.ps1 - run Algo3 with BOTH Delta accounts loaded (Demo + Live).
# The UI picks Demo (testnet) or Live (production) per session. Loads .env.local.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$envFile = Join-Path $PSScriptRoot '.env.local'
if (-not (Test-Path $envFile)) {
  Write-Host "Missing .env.local - copy .env.example to .env.local and add both accounts' keys." -ForegroundColor Red
  exit 1
}
Get-Content $envFile | Where-Object { $_ -match '^\s*[^#].*=' } | ForEach-Object {
  $k, $v = $_ -split '=', 2
  Set-Item "env:$($k.Trim())" $v.Trim()
}
if (-not $env:PORT) { $env:PORT = '3011' }

Write-Host ">> Algo3 [Demo + Live]  ->  http://localhost:$($env:PORT)" -ForegroundColor Cyan
Write-Host "   Pick Demo (testnet) or Live (production) in the UI Controls panel." -ForegroundColor DarkCyan
node index.js
