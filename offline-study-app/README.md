# 社労士オフライン学習アプリ

`member.studying.jp` の代替ではなく、手元のPDF/音声をオフラインで回すためのローカル学習アプリです。

## できること

- 学習フォルダを再帰スキャンして `PDF` / `音声` を自動分類
- 科目・教材種別・キーワード検索
- PDF閲覧、音声再生
- 今日の学習キュー（完了チェック付き）
- 教材ごとのメモ保存（ローカル保存）
- PWAインストール（対応ブラウザのみ）

## 使い方（PC）

1. PowerShellでアプリフォルダへ移動
   - `cd g:\マイドライブ\2026資料\offline-study-app`
2. ローカルサーバーを起動
   - `.\start-local.ps1`
3. ブラウザで `http://localhost:4173` を開く
4. `学習フォルダ接続` を押して `g:\マイドライブ\2026資料` を選択
5. スキャン完了後、教材を選んで学習開始

## 使い方（スマホ）

1. PCとスマホを同じWi-Fiに接続
2. PCで `.\start-mobile.ps1` を実行
3. 表示された `Mobile : http://<PCのIP>:4173/` をスマホで開く
4. スマホ側では `教材ファイル追加` からPDF/音声を読み込む

## 1タップ起動（ホーム画面追加）

- Android (Chrome/Edge):
  1. アプリ画面上部の `アプリとしてインストール` を押す
  2. 追加後はホーム画面アイコンから起動
- iPhone/iPad (Safari):
  1. 共有ボタンを押す
  2. `ホーム画面に追加` を選ぶ
  3. 追加後はホーム画面アイコンから起動

## HTTPS公開（GitHub Pages）

Android の「アプリとしてインストール」を安定して出すには `HTTPS` が必要です。  
このリポジトリには `GitHub Pages` 自動デプロイを追加済みです（`.github/workflows/deploy-pages.yml`）。

1. GitHubへこのリポジトリを push
2. GitHub リポジトリの `Settings` → `Pages`
3. `Build and deployment` を `GitHub Actions` に設定
4. `Actions` タブで `Deploy Offline Study App to GitHub Pages` が成功するのを待つ
5. 公開URL（例: `https://<ユーザー名>.github.io/<リポジトリ名>/`）を Android で開く
6. Chrome/Edge の `アプリとしてインストール` を実行

## Google Drive運用

あなたの運用方針どおり、教材管理は `PC + Google Drive` でOKです。

1. PCでPDF/音声をGoogle Driveへ更新
2. Androidアプリ（PWA）で `教材ファイル追加`
3. 追加元で `Google Drive` を選択して取り込む

## 重要

- ローカルサーバー方式はそのまま残しています（PC利用も従来どおり）。
- スマホブラウザではフォルダ丸ごと選択が使えない場合があるため、`教材ファイル追加` を併用してください。

## ブラウザ要件

- 推奨: Chrome / Edge（File System Access API対応）
- 非対応ブラウザでは `学習フォルダ接続` が使えない場合があります。その場合は `教材ファイル追加` を使ってください

## 注意

- 本アプリはローカル教材管理用です。STUDYingのWeb機能（問題演習進捗同期など）は再現しません。
- `offline-study-app` フォルダ名はスキャン除外対象です。変更すると自分自身をスキャン対象に含む場合があります。
