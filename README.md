# Man.Ai.ger

共感コーチ型のマネジメント AI。**向こうから進捗を聞きに来ます。**

Slack の mention / DM からタスク候補を拾い、ユーザーに Slack DM で確認します。
タスクの開始・途中・終了に合わせて進捗を聞くので、あなたが TODO を手入力し続ける必要はありません。
やる気が出ない日は、詰めずに寄り添い、5 分の一歩に分解します。それでも無理な日は「休む日」として一緒に引きます。

- **ローカルファースト**: データはあなたのマシンの SQLite から出ません
- **新しいデータ経路ゼロ**: 外部通信は Slack と Codex App Server に限定します。API キーをアプリに持たせません
- **Dashboard**: daemon 起動中は `http://127.0.0.1:7799/` で仕事の現在地を一目で確認できます (読み取り専用。操作は Slack Bot DM に渡されます)
- **行動科学ベース**: 動機づけ面接 / 実装意図 / 小さな勝利の可視化 (docs/behavior-design.md)

将来 (Phase B): 溜まった仕事文脈から、ワーカー AI (Claude Code 等) 向けの背景つき指示文を生成します。

## 必要なもの

1. macOS + Node.js 22 LTS + pnpm
2. Codex App Server が利用できること
3. Slack ワークスペース (無料プランで OK。個人用でも会社用でも)

## セットアップ (10 分)

### 1. Slack App を作る (初回のみ)

1. https://api.slack.com/apps → **Create New App** → **From a manifest**
2. ワークスペースを選び、リポジトリの `slack-manifest.yaml` の中身を貼り付けて作成
3. **Basic Information → App-Level Tokens** → Generate Token (`connections:write` スコープ) → `xapp-...` を控える
4. **Install App** → ワークスペースにインストール → **OAuth & Permissions** の `xoxb-...` (Bot User OAuth Token) を控える

### 2. 起動する

```bash
nvm use
pnpm install
pnpm cli init            # 保存先、Slack token、作業時間を対話的に設定
pnpm cli doctor          # ✅ が並ぶことを確認
pnpm dev                 # daemon をフォアグラウンド起動
```

Slack で **Man.Ai.ger に DM を送ってください** (アプリの「メッセージ」タブ)。
最初に DM した人がオーナーとして登録され、以後はタスクの開始・途中・終了に合わせて Bot から声がかかります。

`manaiger init` は `~/.manaiger/.env` を作成し、Slack token などの起動前設定を保存します。
working hours / interaction spacing / recheck interval は SQLite settings に保存されます。

### 3. 常駐させる (任意)

```bash
bash scripts/setup-launchd.sh   # macOS launchd に登録 (ログイン時に自動起動)
```

> ラップトップがスリープ中は発話できません。起動後、未送信の interaction には自動で追いつきます。

## 使い方

- **Slack mention**: Bot がタスク候補を提案し、`タスク化する` / `内容を修正` / `タスク化しない` で確認します
- **開始時**: 「何から始めるか」まで決めます
- **途中確認**: 進捗、詰まり、脱線、疲れを確認します
- **終了時**: 完了、継続、延期、ブロッカー化のどれかに整理します
- **やる気が出ない日**: 正直にそう書いてください。詰めません
- **Dashboard**: `http://127.0.0.1:7799/` (`MANAIGER_DASHBOARD_PORT` で変更可)。`現在マネジメント中` / タスク分類 / Slack Context を確認できます

```bash
pnpm cli status                     # ターミナルから現在地を見る
pnpm cli config                     # interaction 設定を見る
pnpm cli init                       # 初期設定を作成・更新する
```

## 会社 PC への展開

コード・手順は同一で、環境依存物は `.env` だけです (docs/requirements.md §3):

1. 会社 PC に clone → `pnpm install`
2. Slack 管理者に `slack-manifest.yaml` を提示して承認を得る → 会社ワークスペースで "From a manifest" で作成 → トークンを `.env` へ
3. Codex App Server を会社環境で利用可能にする
4. データ (SQLite) は移しません。私用の文脈と会社の文脈は混ぜないのが本製品の原則です

## 設計ドキュメント

- [docs/requirements.md](docs/requirements.md) — 要件・アーキテクチャ原則
- [docs/behavior-design.md](docs/behavior-design.md) — 行動科学ベースの対話設計
- [docs/architecture.md](docs/architecture.md) — モジュール構成・契約
- [docs/handoff-claude.md](docs/handoff-claude.md) — Claude への引き継ぎメモ
- [docs/dashboard-prototype.html](docs/dashboard-prototype.html) — Dashboard 原案

## 開発

```bash
pnpm test        # 全テスト (LLM/Slack はモック)
pnpm typecheck
pnpm demo        # 1 日分の会話デモを生成
```

`better-sqlite3` は Node の native addon なので、Node のメジャーバージョンを切り替えたら `pnpm install` を再実行してください。
