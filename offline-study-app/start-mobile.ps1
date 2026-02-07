param(
  [int]$Port = 4173
)

Set-Location -Path $PSScriptRoot
.\start-local.ps1 -Port $Port -Bind "0.0.0.0"
