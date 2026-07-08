# Man.Ai.ger アーキテクチャ

> 最終更新: 2026-07-08
> スコープ: Phase A1 = Slack Bot + local daemon + Dashboard prototype。
> SDD: 本書の契約に沿って TDD で実装する。

---

## 1. プロセス構成

```text
manaiger daemon (単一 Node プロセス, 社給機で常駐)
  ├ SlackMessenger      : Bolt + Socket Mode
  ├ SlackEventIngestor  : mention / DM / block_actions を観測
  ├ Scheduler           : task start / checkpoint / end の発火判定
  ├ Agent               : context 構築 → Codex App Server → actions 適用 → Slack 返信
  ├ DashboardSnapshot   : Dashboard 用 read model を生成
  └ SQLite              : ~/.manaiger/manaiger.db (env で変更可)

Codex App Server
  └ Man.Ai.ger の LLM / context management 実行面。未起動なら中核機能は利用不可。

Dashboard
  └ local web UI。仕事の現在地を read-only で表示し、操作は Slack Bot フローへ渡す。
```

- 単一ユーザー前提
- Slack は Socket Mode を使い、公開エンドポイントを持たない
- Dashboard は直接 Task を作成・更新しない
- Dashboard のボタンは Slack Bot への相談・承認フローを始める intent として扱う
- 二重起動防止のため、daemon は SQLite に pid + heartbeat を保存する

## 2. データスキーマ

```sql
objects   (id TEXT PK, type TEXT, domain TEXT, name TEXT, aliases TEXT/*json*/,
           properties TEXT/*json*/, status TEXT NULL,
           due TEXT NULL, created_at TEXT, updated_at TEXT)
links     (id TEXT PK, predicate TEXT, from_id TEXT, to_id TEXT, created_at TEXT)
events    (id INTEGER PK AUTOINC, ts TEXT, kind TEXT, summary TEXT, payload TEXT/*json*/)
turns     (id INTEGER PK AUTOINC, date TEXT, role TEXT, content TEXT, at TEXT)
settings  (key TEXT PK, value TEXT)
```

`objects.type`:

- `Project`
- `Task`
- `Person`
- `Org`
- `Note`

Task status:

- `todo`
- `doing`
- `blocked`
- `done`
- `deferred`

主な `events.kind`:

- `slack_message_observed`
- `task_candidate_detected`
- `task_candidate_approved`
- `task_candidate_rejected`
- `task_created`
- `task_status`
- `task_updated`
- `plan_set`
- `checkpoint_sent`
- `day_off`
- `note`

events には before / after と source を残す。Dashboard に出す状態は DB から作る read model であり、UI 側の一時状態に依存しない。

## 3. LLM 契約

### 3.1 実行面

- LLM / context management は Codex App Server を利用する
- 別 LLM CLI 依存は持たない
- raw API key を扱わない
- `manaiger doctor` は Codex App Server の利用可能性を確認する
- Dashboard の Service 表示も `Codex App Server: available / unavailable` の粒度に留める
- `slow` のような推測ステータスは表示しない

### 3.2 1ターン処理

```text
Slack input / scheduled interaction / dashboard intent
  → turns に user または system intent を記録
  → DB から context を構築
  → Codex App Server に依頼
  → JSON 出力を parse / validate
  → actions を DB に適用
  → Slack DM へ返信
  → Dashboard snapshot が更新される
```

### 3.3 出力契約

```jsonc
{
  "reply": "ユーザーへ返す日本語テキスト",
  "actions": [
    { "type": "create_project", "name": "..." },
    { "type": "create_task", "project": "...", "name": "...", "due": "YYYY-MM-DD|null" },
    { "type": "set_status", "task": "...", "status": "todo|doing|blocked|done|deferred" },
    { "type": "set_plan", "task": "...", "summary": "..." },
    { "type": "record_blocker", "task": "...", "text": "..." },
    { "type": "defer_task", "task": "...", "until": "ISO datetime|null", "reason": "..." },
    { "type": "note", "text": "..." }
  ]
}
```

- JSON は zod で検証する
- 検証失敗時は actions を捨て、reply だけ使う
- reply も取れなければ定型フォールバックを返す
- action 適用は 1 件ずつ独立に記録し、失敗した action も events に残す

## 4. Slack 層

- Bolt + Socket Mode
- 購読対象: `message.im`, mention 系イベント, `block_actions`
- Bot 自身の発話、他 Bot、不要なスレッド返信は無視する
- オーナー以外のユーザーからの DM は単一ユーザー製品として丁重に断る

### 4.1 Slack mention タスク候補化

```text
mention / DM 受信
  → task candidate 判定
  → Dashboard read model に「タスク候補」「承認待ち」を反映
  → Bot がユーザー DM で提案
  → [タスク化する] [内容を修正] [タスク化しない]
  → 承認された場合だけ Task 作成
```

ボタンは内部ラベルを出さない。

- OK: `タスク化する`
- OK: `内容を修正`
- OK: `タスク化しない`
- NG: `Slack option: 追加`
- NG: `task_candidate`
- NG: `approval_required`

## 5. Scheduler

30 秒ごとに tick し、DB 上の scheduled interaction を見る。

固定の morning / evening だけにしない。デフォルトは Task ごとに次を生成する。

| 種類 | 発火タイミング | 目的 |
|---|---|---|
| `start_check` | planned_start | 最初の一歩を決める |
| `mid_check` | planned_start と planned_end の中間 | 進捗、詰まり、脱線、疲れを確認する |
| `end_check` | planned_end または due 前 | 完了、継続、延期、ブロッカー化を決める |

ルール:

- 発火済み interaction は events で重複防止する
- スリープ復帰時は「時刻一致」ではなく「予定時刻を過ぎて未送信」で判定する
- 未応答の再確認は 1 回まで
- オーナー Slack ID 未確定の間は送信しない

## 6. Dashboard

Dashboard は local web UI として実装する。現在の視覚仕様は `docs/dashboard-prototype.html` を正とする。

役割:

- 現在マネジメント中の Task を最上部に表示する
- `タスク候補` / `本日締め切り` / `期限すぎ` / `進行中` / `未着手` をカードで表示する
- Slack Context を read-only mirror として表示する
- 状態は色付きチップ、操作は色付きボタンとして明確に区別する
- Dashboard からの操作は Slack Bot に渡し、DB の最終更新は Slack Bot フローで確定する

## 7. CLI

```text
manaiger start    : daemon をフォアグラウンド起動
manaiger status   : Project / Task の現在地を表示
manaiger doctor   : Slack 連携、Codex App Server、DB 書込、単一インスタンスを検査
manaiger config   : working hours / interaction 設定を表示・変更
```

`doctor` は利用可否を確認する。速度や品質を曖昧に診断しない。

## 8. データ経路の保証

ガードテストで `src/` を走査し、以下を検出したら失敗させる。

- `fetch(`
- `axios`
- `http.request`
- 許可外の `https://`
- `firebase`
- analytics / telemetry 系 SDK

Slack と Codex App Server 以外の外部通信を増やさない。

## 9. テスト戦略

| 層 | 方法 |
|---|---|
| db | SQLite (:memory:) で CRUD / transaction / events を検証 |
| llm | Codex App Server client は interface 化し、unit test は fake client で実行 |
| agent | FakeLlm / FakeCodexClient で actions 適用・fallback・脚注生成を検証 |
| scheduler | 固定時刻注入で start / mid / end / sleep recovery / duplicate prevention を検証 |
| slack | Block Kit builder の制約、button value、owner filtering を検証 |
| dashboard | snapshot API と static prototype の visual regression を確認 |
| e2e | Slack mention → candidate → approval → task creation → dashboard update を再生 |
| guard | データ経路スキャンを CI 相当に実行 |
