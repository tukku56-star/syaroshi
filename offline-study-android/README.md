# 社労士ネイティブAndroidアプリ

`https://tukku56-star.github.io/syaroshi/` を WebView で開く Android アプリです。  
`教材ファイル追加` のファイル選択（Google Drive含む）に対応しています。

## 使い方

1. PowerShellで移動
   - `cd g:\マイドライブ\2026資料\offline-study-android`
2. APKビルド
   - `.\build-apk.ps1`
3. 端末へインストール（USBデバッグ接続済み）
   - `.\build-apk.ps1 -Install`

## 出力

- `offline-study-android\app\build\outputs\apk\debug\app-debug.apk`

## 備考

- SDK既定パスは FEアプリ（`FE_dojo`）の `.tooling/android-sdk` を参照しています。
- Gradle既定パスは FEアプリ（`FE_dojo`）の `_gradle_tmp/gradle-8.5/bin/gradle.bat` を参照しています。
- SDKの場所が違う場合は `-SdkDir` で指定できます。
  - 例: `.\build-apk.ps1 -SdkDir "D:\Android\Sdk"`
- Gradleの場所が違う場合は `-GradleBat` で指定できます。
  - 例: `.\build-apk.ps1 -GradleBat "D:\gradle\bin\gradle.bat"`
