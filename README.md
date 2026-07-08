# Man.Ai.ger

共感コーチ型のマネジメント AI。**向こうから進捗を聞きに来ます。**

Slack の mention / DM からタスク候補を拾い、Slack DM で「タスク化しますか？」と確認します。
タスクの開始・途中・終了のタイミングで自動的に声をかけるので、あなたが TODO を手入力し続ける必要はありません。
やる気が出ない日は、詰めずに寄り添い、5 分の一歩に分解します。それでも無理な日は「休む日」として一緒に引きます。

- **ローカルファースト**: データはあなたのマシンの SQLite から出ません
- **新しいデータ経路ゼロ**: 外部通信は Slack と Codex App Server に限定します。API キーをアプリに持たせません
- **Dashboard**: daemon 起動中は `http://127.0.0.1:7799/` で仕事の現在地を一目で確認できます
- **行動科学ベース**: 動機づけ面接 / 実装意図 / 小さな勝利の可視化 (docs/behavior-design.md)

将来 (Phase B): 溜まった仕事文脈から、ワーカー AI (Claude Code 等) 向けの背景つき指示文を生成します。

---

## 30秒でわかる使い方

1. **朝、Dashboard で「勤務開始」を押す** → Slack に「今日取り組むことを教えてください」と来る → 返信するとタスクが自動登録される
2. **仕事の合間、Bot から声がかかる** → タスクの開始・途中・終了のタイミングで Slack DM が届く → 選択肢から選んで返信するだけ
3. **困ったら Dashboard の「AIへの相談」ボタンを押す** → 「やりたくない」「めんどくさい」など、今の気持ちに合うボタンを押すと Slack で相談が始まる

これが基本サイクルです。以下は詳しい説明です。

---

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

`slack-manifest.yaml` を使えば上記4手順だけで済みます。この manifest には以下のスコープ・イベントがすべて含まれています (社内ポリシーで manifest からの作成が禁止されている場合は、次項を見て手動で設定してください)。

**Bot Token Scopes** (OAuth & Permissions):

| Scope | 用途 |
|---|---|
| `chat:write` | DM の送信 |
| `im:history` | 自分宛て DM の受信 (`message.im` イベントに必要) |
| `im:write` | DM チャンネルを開く (`conversations.open`)。**これが無いと Bot からの最初の DM 送信に失敗します** |
| `channels:history` | Bot 参加済み public channel での owner mention 観測 |
| `groups:history` | Bot 参加済み private channel での owner mention 観測 |

**App-Level Token Scope** (Basic Information → App-Level Tokens):

| Scope | 用途 |
|---|---|
| `connections:write` | Socket Mode での接続 (Event Subscriptions / Interactivity を Request URL なしで受信する) |

**Event Subscriptions** (Subscribe to bot events):

| Event | 用途 |
|---|---|
| `message.im` | Bot への DM を受信する (必須) |
| `message.channels` | Bot が参加している public channel でのメッセージを観測する (owner mention 検出用) |
| `message.groups` | Bot が参加している private channel でのメッセージを観測する (owner mention 検出用) |

**Interactivity & Shortcuts**: 有効化が必要です (承認ボタン `タスク化する` / `内容を修正` / `タスク化しない` などのブロック操作に使います)。

<details>
<summary>手動で設定する場合 (manifest を使わないとき)</summary>

**OAuth & Permissions → Scopes → Bot Token Scopes** に上記5つの Scope を追加。

**Socket Mode を有効化** (Settings → Socket Mode):

1. **Enable Socket Mode** をオンにする
2. トークン名を入力して **Generate** → 上記の `connections:write` が自動で付く App-Level Token (`xapp-...`) が発行される
3. この画面をオンにしないと、Event Subscriptions が有効化できません

**Event Subscriptions を有効化** (Features → Event Subscriptions):

1. **Enable Events** をオンにする
2. **Subscribe to bot events** に上記3つの Event を追加
3. Socket Mode 使用時は Request URL の入力は不要です (Event Subscriptions は Socket Mode 経由で配信されます)

**Interactivity & Shortcuts を有効化** (Features → Interactivity & Shortcuts):

1. **Interactivity** をオンにする
2. こちらも Socket Mode 使用時は Request URL 不要です

設定後、**Install App** から (再) インストールしてスコープ変更を反映させてください。

</details>

### 2. 起動する

```bash
nvm use
pnpm install
pnpm cli init            # 保存先、Slack token、作業時間を対話的に設定
pnpm cli doctor           # ✅ が並ぶことを確認
pnpm dev                  # daemon をフォアグラウンド起動
```

起動すると、次のように出ます。

```
Man.Ai.ger が起動しました。Slack で Bot に DM を送ると、その人がオーナーとして登録されます。
Dashboard: http://127.0.0.1:7799/
```

Slack で **Man.Ai.ger に DM を送ってください** (アプリの「メッセージ」タブ)。
最初に DM した人がオーナーとして登録され、以後はタスクの開始・途中・終了に合わせて Bot から声がかかります。

> Slack トークンをまだ設定していなくても、daemon は Dashboard だけを起動します。左下の「Slack連携」の表示が「未設定」になっているので、後からいつでも `.env` を編集して起動し直せます。

### 3. 常駐させる (任意)

```bash
bash scripts/setup-launchd.sh   # macOS launchd に登録 (ログイン時に自動起動)
```

> ラップトップがスリープ中は発話できません。起動後、未送信の interaction には自動で追いつきます。

---

## Dashboard の見方

`http://127.0.0.1:7799/` (`MANAIGER_DASHBOARD_PORT` で変更可)。サイドバーに4つの画面があります。

### ダッシュボード (トップ画面)

| エリア | 内容 |
|---|---|
| **現在マネジメント中** | 今どのタスクを進めているか、次にいつ確認が来るかを表示 |
| **勤務開始 / タスク追加ボタン** | 押すと Slack DM で会話が始まる (下記) |
| **AIへの相談** | 「やりたくない」「めんどくさい」「タスク分解して」「ブロッカーまとめて」「今やらなくていい」— 今の気持ちに近いボタンを押すと Slack で相談が始まる |
| **5つの分類カード** | タスク候補 / 本日締め切り / 期限すぎ / 進行中 / 未着手。それぞれに「AIに進捗報告」等のボタンがあり、押すと Slack DM が届く |
| **Slack Context** | mention から拾ったタスク候補を確認専用で表示 (承認・修正・却下は Slack 側で行う) |

**「勤務開始」ボタン**: 今日/将来やることをまだ登録していないとき、Slack で「今日取り組むことを教えてください」と聞かれます。答えるとタスクとして自動登録されます。

**「タスク追加」ボタン**: 既に抱えている未登録の仕事があるとき、Slack で「まだ登録されていない仕事はありますか？」と聞かれます。

> Dashboard のボタンは全て **Slack DM への入口** です。実際の会話・承認・修正は Slack 側で行います。Dashboard は「今どうなっているか」を見る画面だと考えてください。

### タスク

登録されているタスクをプロジェクト別の一覧で確認できます。状態 (未着手・進行中・ブロック中・延期中・完了) と締切が一目でわかります。

### 会話ログ

Bot との会話を日別に振り返れます。何を話してタスクがどう更新されたか、あとから確認したいときに使います。

### 設定

作業開始/終了時刻・連続確認の最小間隔・未応答の再確認までの4項目は、この画面から直接編集して保存できます (SQLite に即反映され、次の確認判定から使われます)。オーナーや保存先など起動時に決まる設定は表示のみで、変更するには `.env` を編集して再起動してください。

---

## Slack でのやりとり

- **mention されたとき**: 会話の内容からタスクになりそうなものを見つけると、Bot が「このmentionをタスク化しますか？」と DM で提案します。`タスク化する` / `内容を修正` / `タスク化しない` から選べます
- **開始時**: 「何から始めるか」まで決めます
- **途中確認**: 進捗、詰まり、脱線、疲れを確認します
- **終了時**: 完了、継続、延期、ブロッカー化のどれかに整理します
- **やる気が出ない日**: 正直にそう書いてください。詰めません

```bash
pnpm cli status                     # ターミナルから現在地を見る
pnpm cli config                     # interaction 設定を見る
pnpm cli init                       # 初期設定を作成・更新する
pnpm cli dashboard --port 4317      # daemon を起動せず Dashboard だけ単体で確認したいとき
```

---

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
