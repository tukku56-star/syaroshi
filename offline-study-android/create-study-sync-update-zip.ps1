param(
  [Parameter(Mandatory = $true)]
  [string]$RootFolder,

  [Parameter(Mandatory = $true)]
  [string]$SubjectFolderName,

  [string]$OutputZip = "",

  [datetime]$Since = ([datetime]::MinValue),

  [ValidateSet("Optimal", "Fastest", "NoCompression")]
  [string]$CompressionLevel = "Fastest"
)

$ErrorActionPreference = "Stop"

$extensions = @(".pdf", ".mp3", ".m4a", ".aac", ".wav", ".ogg")

function ShouldSkipAudio([string]$nameOrPath) {
  if ([string]::IsNullOrWhiteSpace($nameOrPath)) { return $false }
  $normalized = ($nameOrPath -replace "\s+", "")
  return (
    $normalized.Contains("1.5倍速") -or
    $normalized.Contains("2倍速") -or
    $normalized.Contains("1.5x") -or
    $normalized.Contains("2x") -or
    $normalized.Contains("【1.5倍速】") -or
    $normalized.Contains("【2倍速】")
  )
}

$rootPath = (Resolve-Path -LiteralPath $RootFolder).Path
$subjectPath = Join-Path $rootPath $SubjectFolderName
if (-not (Test-Path -LiteralPath $subjectPath -PathType Container)) {
  throw "Subject folder not found: $subjectPath"
}

if (-not $OutputZip) {
  $stamp = (Get-Date -Format "yyyyMMdd-HHmmss")
  $OutputZip = Join-Path $rootPath ("study-sync-update-{0}-{1}.zip" -f $SubjectFolderName, $stamp)
}

$outputPath = [System.IO.Path]::GetFullPath($OutputZip)
$outputDir = Split-Path -Parent $outputPath
if ($outputDir -and -not (Test-Path -LiteralPath $outputDir)) {
  New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
}
if (Test-Path -LiteralPath $outputPath) {
  throw "OutputZip already exists (choose a new name): $outputPath"
}

Write-Host "Root:     $rootPath"
Write-Host "Subject:  $subjectPath"
Write-Host "Since:    $Since"
Write-Host "Output:   $outputPath"

$diskFiles = @(
  Get-ChildItem -LiteralPath $subjectPath -Recurse -File |
    Where-Object {
      $extensions -contains $_.Extension.ToLowerInvariant() -and
      ($Since -eq [datetime]::MinValue -or $_.LastWriteTime -ge $Since) -and
      (-not (ShouldSkipAudio $_.FullName))
    }
)

$zipFiles = @(
  Get-ChildItem -LiteralPath $subjectPath -Recurse -File -Filter *.zip |
    Where-Object { $Since -eq [datetime]::MinValue -or $_.LastWriteTime -ge $Since }
)

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$compression = [System.Enum]::Parse([System.IO.Compression.CompressionLevel], $CompressionLevel)
$zip = [System.IO.Compression.ZipFile]::Open($outputPath, [System.IO.Compression.ZipArchiveMode]::Create)
$seen = [System.Collections.Generic.HashSet[string]]::new()
$sourceUri = New-Object System.Uri(($subjectPath.TrimEnd('\') + '\'))

$addedDisk = 0
$addedInner = 0
$skippedInner = 0

try {
  foreach ($file in $diskFiles) {
    $fileUri = New-Object System.Uri($file.FullName)
    $relativePath = [System.Uri]::UnescapeDataString($sourceUri.MakeRelativeUri($fileUri).ToString()).Replace('\', '/')
    if ([string]::IsNullOrWhiteSpace($relativePath)) { continue }
    $entryName = ("{0}/{1}" -f $SubjectFolderName, $relativePath)
    if (-not $seen.Add($entryName)) { continue }

    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
      $zip,
      $file.FullName,
      $entryName,
      $compression
    ) | Out-Null
    $addedDisk++
  }

  foreach ($zipFile in $zipFiles) {
    $inner = $null
    try {
      $inner = [System.IO.Compression.ZipFile]::OpenRead($zipFile.FullName)
      foreach ($entry in $inner.Entries) {
        $name = ($entry.FullName -replace "\\\\", "/").TrimStart("/")
        if ([string]::IsNullOrWhiteSpace($name)) { continue }
        if ($name.EndsWith("/")) { continue }

        $ext = [System.IO.Path]::GetExtension($name).ToLowerInvariant()
        if ($extensions -notcontains $ext) { continue }
        if ($ext -ne ".pdf" -and $ext -ne ".mp3" -and $ext -ne ".m4a" -and $ext -ne ".aac" -and $ext -ne ".wav" -and $ext -ne ".ogg") {
          continue
        }
        if ($ext -ne ".pdf" -and (ShouldSkipAudio $name)) {
          $skippedInner++
          continue
        }

        $outName = ("{0}/{1}" -f $SubjectFolderName, $name)
        if (-not $seen.Add($outName)) { continue }

        $outEntry = $zip.CreateEntry($outName, $compression)
        $inStream = $null
        $outStream = $null
        try {
          $inStream = $entry.Open()
          $outStream = $outEntry.Open()
          $inStream.CopyTo($outStream)
        }
        finally {
          if ($outStream) { $outStream.Dispose() }
          if ($inStream) { $inStream.Dispose() }
        }

        $addedInner++
      }
    }
    catch {
      # Ignore broken zip packages so the update can continue.
      Write-Warning ("Skip inner zip (open failed): {0} ({1})" -f $zipFile.FullName, $_.Exception.Message)
    }
    finally {
      if ($inner) { $inner.Dispose() }
    }
  }
}
finally {
  $zip.Dispose()
}

Write-Host ""
Write-Host "=== summary ==="
Write-Host ("disk files added: {0}" -f $addedDisk)
Write-Host ("inner zip entries added: {0}" -f $addedInner)
Write-Host ("inner zip entries skipped (speed variants): {0}" -f $skippedInner)
Write-Host ("total entries: {0}" -f $seen.Count)
Write-Host ("created: {0}" -f $outputPath)

