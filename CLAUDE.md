# Man.Ai.ger

## Project Overview

プロアクティブに進捗を聞きに来るマネジメント AI。溜まった仕事文脈からワーカー AI (Claude Code 等) 向けのブリーフィングを生成する。詳細は `docs/requirements.md`。

ai-knows-me-v2 (Di.Ai.ry) からの分岐プロダクト。**企業の機密を扱える**ことが存在理由。

## 絶対原則 — 新しいデータ経路ゼロ

データが社給機の外に出てよいのは **会社 Slack** と **会社契約の LLM シート (claude -p 等)** のみ。

- 外部 SaaS / 自前クラウドへの保存・送信を書かない (Firebase 含む)
- LLM は raw API キーでなく BYO エージェント CLI (`claude -p`) を headless 実行
- Slack は Socket Mode (公開エンドポイントを持たない)
- テレメトリ・アナリティクスを仕込まない

## Tech Stack

- TypeScript (Node.js) / SQLite (better-sqlite3) / Slack Bolt (Socket Mode)
- LLM: `claude -p --resume` (第一対応)。codex は後続
- スケジューラ: launchd (macOS 先行)
- MCP: Phase B で @modelcontextprotocol/sdk
- テスト: Vitest (TDD)

## Coding Conventions

- TDD (テスト先行)。実装変更後、コミット前に必ず全テスト通過を確認
- Think Before Coding / Simplicity First / Surgical Changes / Goal-Driven Execution
- **ソースコード・テスト・ドキュメントに実在の個人情報・社名・機密を書かない** (OSS 化可能性)
- オントロジー設計・プロンプトの作法は ai-knows-me-v2 の実績を移植する (docs/requirements.md §4)

## Definition of Done (Phase A)

1. 会社 Slack DM で Bot が朝夕、Project/Task を具体名で聞いてくる
2. 返信から Task の状態・進捗が自動更新され、events に痕跡が残る
3. CLI または Slack でプロジェクト/タスクの現在地が一覧できる
4. 1〜2 週間でタスクの全体像がローカルのオントロジーに構造化される
5. 外部へのデータ経路が Slack と LLM シートのみであることをコードで保証
