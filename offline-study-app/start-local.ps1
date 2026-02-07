param(
  [int]$Port = 4173,
  [string]$Bind = "0.0.0.0",
  [switch]$NoOpen
)

Set-Location -Path $PSScriptRoot

function Get-LanIPv4 {
  try {
    return Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
      Where-Object {
        $_.IPAddress -notlike "127.*" -and
        $_.IPAddress -notlike "169.254.*" -and
        $_.PrefixOrigin -ne "WellKnown"
      } |
      Select-Object -ExpandProperty IPAddress -Unique
  } catch {
    return @()
  }
}

$py = Get-Command py -ErrorAction SilentlyContinue
$python = Get-Command python -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "Server start:"
Write-Host ("  Local  : http://localhost:{0}/" -f $Port)

if ($Bind -eq "0.0.0.0" -or $Bind -eq "::" -or $Bind -eq "*") {
  $ips = Get-LanIPv4
  foreach ($ip in $ips) {
    Write-Host ("  Mobile : http://{0}:{1}/" -f $ip, $Port)
  }
  if ($ips.Count -eq 0) {
    Write-Host "  Mobile : LAN IP not found. localhost only."
  }
} else {
  Write-Host "  Bind   : $Bind"
}

if (-not $NoOpen) {
  Start-Process "http://localhost:$Port/"
}

if ($py) {
  py -m http.server $Port --bind $Bind
  exit $LASTEXITCODE
}

if ($python) {
  python -m http.server $Port --bind $Bind
  exit $LASTEXITCODE
}

Write-Error "Python launcher (py) or python was not found."
exit 1
