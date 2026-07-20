# start-demo.ps1 - run Algo3 against the Delta India DEMO / TESTNET account.
# Fake money - safe for testing live order flow. Loads keys from .env.demo.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$envFile = Join-Path $PSScriptRoot '.env.demo'
if (-not (Test-Path $envFile)) {
  Write-Host "Missing .env.demo - copy .env.example to .env.demo and add your DEMO keys." -ForegroundColor Red
  exit 1
}
Get-Content $envFile | Where-Object { $_ -match '^\s*[^#].*=' } | ForEach-Object {
  $k, $v = $_ -split '=', 2
  Set-Item "env:$($k.Trim())" $v.Trim()
}
if (-not $env:PORT) { $env:PORT = '3011' }

Write-Host ">> Algo3 [DEMO / testnet]  host=$env:DELTA_HOST  ->  http://localhost:$($env:PORT)" -ForegroundColor Cyan
node index.js
