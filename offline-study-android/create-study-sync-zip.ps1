param(
    [Parameter(Mandatory = $true)]
    [string]$SourceFolder,
    [string]$OutputZip = (Join-Path $PSScriptRoot "study-sync.zip")
)

$ErrorActionPreference = "Stop"

$extensions = @(".pdf", ".mp3", ".m4a", ".aac", ".wav", ".ogg")

$sourcePath = (Resolve-Path -LiteralPath $SourceFolder).Path
if (-not (Test-Path -LiteralPath $sourcePath -PathType Container)) {
    throw "SourceFolder is not a directory: $SourceFolder"
}

$outputPath = [System.IO.Path]::GetFullPath($OutputZip)
$outputDir = Split-Path -Parent $outputPath
if ($outputDir -and -not (Test-Path -LiteralPath $outputDir)) {
    New-Item -ItemType Directory -Path $outputDir | Out-Null
}
if (Test-Path -LiteralPath $outputPath) {
    Remove-Item -LiteralPath $outputPath -Force
}

$files = @(
    Get-ChildItem -LiteralPath $sourcePath -Recurse -File |
        Where-Object { $extensions -contains $_.Extension.ToLowerInvariant() }
)

if ($files.Count -eq 0) {
    throw "No supported files found in '$sourcePath'."
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open($outputPath, [System.IO.Compression.ZipArchiveMode]::Create)
$sourceUri = New-Object System.Uri(($sourcePath.TrimEnd('\') + '\'))
try {
    foreach ($file in $files) {
        $fileUri = New-Object System.Uri($file.FullName)
        $relativePath = [System.Uri]::UnescapeDataString($sourceUri.MakeRelativeUri($fileUri).ToString()).Replace('\', '/')
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $zip,
            $file.FullName,
            $relativePath,
            [System.IO.Compression.CompressionLevel]::Optimal
        ) | Out-Null
    }
}
finally {
    $zip.Dispose()
}

Write-Host "Created: $outputPath"
Write-Host "Included files: $($files.Count)"
