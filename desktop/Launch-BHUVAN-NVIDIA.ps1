$ErrorActionPreference = 'Stop'
$projectDirectory = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$frontendReady = $false
$frontPage = $null
try {
  $frontPage = Invoke-WebRequest -Uri 'http://127.0.0.1:5173/' -TimeoutSec 3
  if ($frontPage.Content -notmatch '<title>BHUVAN') { throw 'Port 5173 serves another application. Close that application or use a different BHUVAN port.' }
  $frontendReady = $true
} catch {
  if ($frontPage) { throw }
}
if (-not $frontendReady) {
  $nodeExecutable = (Get-Command node -ErrorAction Stop).Source
  $viteScript = Join-Path $PSScriptRoot 'start-frontend.mjs'
  Start-Process -FilePath $nodeExecutable -ArgumentList ('"'+$viteScript+'"') -WorkingDirectory $projectDirectory -WindowStyle Hidden -RedirectStandardOutput (Join-Path $PSScriptRoot 'frontend.log') -RedirectStandardError (Join-Path $PSScriptRoot 'frontend-errors.log')
}
$backendReady = $false
try { $backendReady = (Invoke-RestMethod -Uri 'http://127.0.0.1:8000/health' -TimeoutSec 3).status -eq 'ok' } catch {}
if (-not $backendReady) {
  $backendDirectory = Join-Path $projectDirectory 'backend'
  $pythonExecutable = Join-Path $backendDirectory '.venv\Scripts\python.exe'
  if (-not (Test-Path -LiteralPath $pythonExecutable)) { throw 'The backend Python environment is missing. Install backend requirements first.' }
  Start-Process -FilePath $pythonExecutable -ArgumentList @('-m','uvicorn','main:app','--host','127.0.0.1','--port','8000','--no-access-log') -WorkingDirectory $backendDirectory -WindowStyle Hidden -RedirectStandardOutput (Join-Path $PSScriptRoot 'backend.log') -RedirectStandardError (Join-Path $PSScriptRoot 'backend-errors.log')
}
for ($attempt = 0; $attempt -lt 30; $attempt++) {
  try { if ((Invoke-WebRequest -Uri 'http://127.0.0.1:5173/' -TimeoutSec 2).Content -match '<title>BHUVAN') { break } } catch {}
  Start-Sleep -Milliseconds 500
}
$runtimeExecutable = Join-Path $PSScriptRoot 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path -LiteralPath $runtimeExecutable)) { throw 'Install the desktop runtime with npm install --prefix desktop followed by node desktop/node_modules/electron/install.js.' }
$runtimeExecutable = [System.IO.Path]::GetFullPath($runtimeExecutable)
$gpuRegistry = 'HKCU:\Software\Microsoft\DirectX\UserGpuPreferences'
New-Item -Path $gpuRegistry -Force | Out-Null
$oldPreference = (Get-ItemProperty -LiteralPath $gpuRegistry).PSObject.Properties[$runtimeExecutable].Value
$preferenceBackup = Join-Path $PSScriptRoot 'gpu-preference-before.json'
if (-not (Test-Path -LiteralPath $preferenceBackup)) {
  @{ executable = $runtimeExecutable; previous = $oldPreference } | ConvertTo-Json | Set-Content -LiteralPath $preferenceBackup
}
New-ItemProperty -LiteralPath $gpuRegistry -Name $runtimeExecutable -Value 'GpuPreference=2;' -PropertyType String -Force | Out-Null
$previousNodeMode = $env:ELECTRON_RUN_AS_NODE
try {
  $env:ELECTRON_RUN_AS_NODE = $null
  # This is the user's interactive workspace; service helpers above stay hidden.
  $desktopWindowStyle = if ($env:BHUVAN_GPU_VERIFY_ONLY -eq '1') { 'Hidden' } else { 'Normal' }
  Start-Process -FilePath $runtimeExecutable -ArgumentList ('"' + $PSScriptRoot + '"') -WorkingDirectory $PSScriptRoot -WindowStyle $desktopWindowStyle
} finally { $env:ELECTRON_RUN_AS_NODE = $previousNodeMode }
