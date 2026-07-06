# Man.Ai.ger 要件定義書 (founding)

> 作成日: 2026-06-28
> ai-knows-me-v2 (Di.Ai.ry) から分岐したプロダクト。
> 分岐理由: 会社の機密情報を扱うため、個人 Firebase / Discord のスタックでは
> 企業利用が不可能。ローカルファースト + 承認済みチャネルのみの別スタックとする。

---

## 1. 解決する課題

1. **自分を管理し続けるのがしんどい** — 進捗管理は他人にされないと回らない。TODO アプリは意志力頼みで続かない
2. **実務を自分の手でやりたくない** — ワーカー AI (Claude Code 等) は既にあるが、**毎回背景説明のプロンプトを書くのが苦痛**。文脈を渡せないと裁量も渡せない
3. **会社の機密を外部 SaaS に置けない** — 既存の管理ツール/AI メモリはデータが他人のクラウドに載る

## 2. プロダクトアーク

```
Phase A: マネジメント AI
  向こうから進捗を聞きに来る PM (会社 Slack DM)。
  プロジェクト・タスク・障害・意思決定・関係者が
  ローカルのオントロジーに構造化されて溜まる。
        ↓ 文脈が溜まった先に
Phase B: ワーカー AI へのブリーフィング生成
  「これやっといて」→ 背景・制約・過去の決定を全部載せた指示文を生成
  → Claude Code 等の既存ワーカー AI に渡す (MCP で直接注入)。
  ワーカー AI は自作しない。
        ↓ さらにその先に
Phase C: 企業展開 (方向性のみ)
  裁量の統制層。段階的 confirm = アクション権限、
  ローカル events = 監査ログ。
```

**構造的な強み**: Phase B の価値 (プロンプトの背景説明が不要になる) が Phase A を使い続ける理由になる。文脈は使うほど溜まり、指示文の質が上がる。

## 3. アーキテクチャ — 「新しいデータ経路ゼロ」

会社が既に承認したチャネルだけで完結させる。これが承認ストーリーの全て。

```
[会社 Slack DM] ←Socket Mode→ [ローカル daemon (社給機)]
                                 ├ SQLite (オントロジー / 会話ログ / events)
                                 └ LLM 呼び出し = BYO エージェント CLI
                                    (claude -p --resume / codex exec 等、会社契約のシート)
                                        ↕
                               [Claude Code MCP server] ← Phase B ブリーフィング注入
```

| 経路 | 通る場所 | 承認状態 |
|---|---|---|
| 保存 | 社給機のローカル SQLite | 社内デバイス。外部保存なし |
| 対話 UI | 会社 Slack (Socket Mode = 公開サーバー不要) | 機密を話す場として承認済み |
| LLM | 会社契約の Claude Code / Codex シート (`claude -p` 等) | データ経路・課金とも承認済み |

### 設計原則

- **ローカルファースト**: サーバーを持たない。全データは社給機に残る
- **BYO エージェント CLI**: LLM は raw API キーでなく、会社が契約している
  エージェント CLI (claude / codex) を headless 実行して使う。ベンダー中立
- **MCP が配送口**: Phase B は MCP server として Claude Code の中に住む。
  ワーカー AI と同じ場所にマネジメント AI がいる

### 既知の弱点

- **プロアクティブ性は daemon 稼働が前提**。ラップトップが閉じている朝は DM を打てない。
  対策: launchd 常駐 + 「その日最初の起動時にスタンドアップ」フォールバック

## 4. Di.Ai.ry (ai-knows-me-v2) からの移植資産

コードは共有しない (スタックが違う)。設計・ロジックを移植する:

| 資産 | 移植方法 |
|---|---|
| オントロジー設計 (Object Type + Link + 12 domain) | スキーマを SQLite に移植。Task 型を追加 (status: todo/doing/blocked/done, due) |
| プロンプトの作法 (具体名で聞く / 進捗ベース / 深掘り1回 / 締めの定型) | system prompt を移植し「進捗詰め」に特化 |
| custom tool パターン (record_event / upsert_object / link_object) | CLI の tool 機構 or 構造化出力で同等を実装 |
| elicit スケジューラ (朝夕の時刻管理) | launchd + ローカル cron に移植 |
| daily_logs (全往復の生ログ) | SQLite テーブルとして最初から設計に含める |
| トレーサビリティ (derived_from / before→after) | 同スキーマを踏襲 (Phase C の監査ログの種) |

## 5. Phase A: MVP の Definition of Done

1. 会社 Slack の DM で、Bot が毎朝/夕、進行中の Project/Task を**具体名で**聞いてくる
2. 返信から Task の状態・進捗が自動更新され、履歴 (events) に痕跡が残る
3. `manaiger status` (CLI) または Slack で、プロジェクト/タスクの現在地が一覧できる
4. 1〜2 週間使うと、自分の仕事の全体像がローカルのオントロジーに構造化されている
5. **データが社給機の外に出るのは「会社 Slack」と「会社契約の LLM シート」のみ**であることをコードで保証 (外部への fetch を持たない)

## 6. Phase B: ブリーフィング生成 (A 成熟後に詳細化)

- 入口: Slack で「○○の指示文を作って」/ Claude Code から MCP tool 呼び出し
- 出力: 対象 Project の背景・制約・過去の意思決定・ユーザーの好みを集約した指示文
- 成否指標: 生成した指示文を**そのまま Claude Code に貼って (or MCP 経由で) 作業が成立する**こと

## 7. スコープ外 (現時点)

- ワーカー AI の自作
- チーム利用・マルチユーザー (まず本人 1 人)
- SSO / 権限モデル / 集中管理 (Phase C)
- 課金設計 (価値検証後)

## 8. 技術スタック (案)

| 領域 | 採用 |
|---|---|
| 言語 | TypeScript (Node.js) |
| 保存 | SQLite (better-sqlite3) |
| Slack | Bolt for JS + Socket Mode |
| LLM | BYO エージェント CLI (`claude -p` を第一対応、codex は後続) |
| スケジューラ | launchd (macOS) → 将来 Windows/Linux 対応 |
| MCP | @modelcontextprotocol/sdk (Phase B) |
| テスト | Vitest |
