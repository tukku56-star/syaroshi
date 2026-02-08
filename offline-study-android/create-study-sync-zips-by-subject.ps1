param(
    [Parameter(Mandatory = $true)]
    [string]$RootFolder,
    [string]$OutputDirectory = "",
    [ValidateSet("Optimal", "Fastest", "NoCompression")]
    [string]$CompressionLevel = "Fastest"
)

$ErrorActionPreference = "Stop"

$rootPath = (Resolve-Path -LiteralPath $RootFolder).Path
if (-not $OutputDirectory) {
    $OutputDirectory = Join-Path $rootPath "study-sync-split"
}
$outputPath = [System.IO.Path]::GetFullPath($OutputDirectory)
if (-not (Test-Path -LiteralPath $outputPath)) {
    New-Item -ItemType Directory -Path $outputPath | Out-Null
}

$skipNames = @(".git", ".github", "offline-study-android", "offline-study-app", "study-sync-split")
$extensions = @(".pdf", ".mp3", ".m4a", ".aac", ".wav", ".ogg")
$zipScript = Join-Path $PSScriptRoot "create-study-sync-zip.ps1"
if (-not (Test-Path -LiteralPath $zipScript)) {
    throw "Missing script: $zipScript"
}

$subjectDirs = @(
    Get-ChildItem -LiteralPath $rootPath -Directory |
        Where-Object { $skipNames -notcontains $_.Name } |
        Sort-Object Name
)

if ($subjectDirs.Count -eq 0) {
    throw "No subject folders found under '$rootPath'."
}

Write-Host "Output directory: $outputPath"
Write-Host "Subjects: $($subjectDirs.Count)"

foreach ($dir in $subjectDirs) {
    $supportedCount = @(
        Get-ChildItem -LiteralPath $dir.FullName -Recurse -File |
            Where-Object { $extensions -contains $_.Extension.ToLowerInvariant() }
    ).Count
    if ($supportedCount -eq 0) {
        Write-Host "Skip (no supported files): $($dir.Name)"
        continue
    }

    $zipName = "$($dir.Name).zip"
    $targetZip = Join-Path $outputPath $zipName
    Write-Host "Creating: $zipName"
    & $zipScript -SourceFolder $dir.FullName -OutputZip $targetZip -CompressionLevel $CompressionLevel
}

Write-Host "Done."
