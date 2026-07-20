# start-prod.ps1 - run Algo3 against the Delta India REAL / PRODUCTION account.
# REAL MONEY. The production key needs your public IPv4 whitelisted on Delta.
# Loads keys from .env.prod.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$envFile = Join-Path $PSScriptRoot '.env.prod'
if (-not (Test-Path $envFile)) {
  Write-Host "Missing .env.prod - copy .env.example to .env.prod and add your REAL keys." -ForegroundColor Red
  exit 1
}
Get-Content $envFile | Where-Object { $_ -match '^\s*[^#].*=' } | ForEach-Object {
  $k, $v = $_ -split '=', 2
  Set-Item "env:$($k.Trim())" $v.Trim()
}
if (-not $env:PORT) { $env:PORT = '3011' }

Write-Host ">> Algo3 [PRODUCTION / REAL MONEY]  host=$env:DELTA_HOST  ->  http://localhost:$($env:PORT)" -ForegroundColor Yellow
Write-Host "   If broker shows ip_not_whitelisted, whitelist your public IPv4: curl -4 https://api.ipify.org" -ForegroundColor DarkYellow
node index.js
