$ErrorActionPreference = 'Stop'
$savedPreference = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'gpu-preference-before.json') -Raw | ConvertFrom-Json
$gpuRegistry = 'HKCU:\Software\Microsoft\DirectX\UserGpuPreferences'
if ($null -eq $savedPreference.previous) {
  Remove-ItemProperty -LiteralPath $gpuRegistry -Name $savedPreference.executable -ErrorAction SilentlyContinue
} else {
  New-ItemProperty -LiteralPath $gpuRegistry -Name $savedPreference.executable -Value $savedPreference.previous -PropertyType String -Force | Out-Null
}
