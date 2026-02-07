param(
  [string]$SdkDir = "C:\\Users\\admin\\.gemini\\antigravity\\scratch\\fe_siken_export\\output\\FE_dojo\\.tooling\\android-sdk",
  [string]$GradleBat = "C:\\Users\\admin\\.gemini\\antigravity\\scratch\\fe_siken_export\\output\\FE_dojo\\_gradle_tmp\\gradle-8.5\\bin\\gradle.bat",
  [switch]$Install
)

Set-Location -Path $PSScriptRoot

if (-not (Test-Path $SdkDir)) {
  Write-Error "Android SDK not found: $SdkDir"
  exit 1
}

$escaped = $SdkDir.Replace("\", "\\")
"sdk.dir=$escaped" | Set-Content -Path ".\\local.properties" -Encoding ascii

$env:ANDROID_HOME = $SdkDir
$env:ANDROID_SDK_ROOT = $SdkDir

if (Test-Path $GradleBat) {
  & $GradleBat --project-dir $PSScriptRoot assembleDebug
} else {
  cmd /c gradlew.bat assembleDebug
}

if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

$apkPath = Join-Path $PSScriptRoot "app\\build\\outputs\\apk\\debug\\app-debug.apk"
Write-Host ""
Write-Host "APK: $apkPath"

if (-not $Install) {
  exit 0
}

$adb = Get-Command adb -ErrorAction SilentlyContinue
if ($adb) {
  & $adb.Source install -r $apkPath
  exit $LASTEXITCODE
}

$sdkAdb = Join-Path $SdkDir "platform-tools\\adb.exe"
if (Test-Path $sdkAdb) {
  & $sdkAdb install -r $apkPath
  exit $LASTEXITCODE
}

Write-Error "adb not found."
exit 1
