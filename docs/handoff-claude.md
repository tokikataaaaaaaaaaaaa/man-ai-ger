# Claude 引き継ぎメモ

> 作成日: 2026-07-08
> 対象 worktree: `/Users/parker/tokikata-agent-integrated/.worktrees/man-ai-ger-codex`

---

## 1. まず読むもの

Claude に貼るプロンプトは `docs/claude-handoff-prompt.md` にある。

この順で読む。

1. `docs/requirements.md`
2. `docs/architecture.md`
3. `docs/behavior-design.md`
4. `docs/dashboard-prototype.html`

`CLAUDE.md` / `AGENTS.md` を含め、LLM / context management は Codex App Server 一択として扱う。

## 2. 最新の確定事項

- Dashboard は必須
- Dashboard の最上部は `現在マネジメント中`
- Dashboard は仕事の現在地を目視する画面であり、自由入力チャットを増やさない
- 入力・承認・修正・却下は Slack Bot DM を主経路にする
- Dashboard のボタンは Slack Bot フローを開始する intent として扱う
- Slack mention / DM からタスク候補を検出し、ユーザーに Slack DM で確認する
- タスク候補の状態表示は `タスク候補` / `承認待ち`
- 状態は色付きチップ、操作は色付きボタンとして表示する
- LLM / context management は Codex App Server 一択
- 別 LLM CLI の実行経路は追加しない
- Scheduler は朝夕固定ではなく、タスクの開始・途中・終了で interaction を起こす

## 3. Prototype の現在地

参照 HTML:

```text
docs/dashboard-prototype.html
```

開くコマンド:

```sh
open docs/dashboard-prototype.html
```

ただし、実行時の cwd は worktree root にする。

```sh
cd /Users/parker/tokikata-agent-integrated/.worktrees/man-ai-ger-codex
open docs/dashboard-prototype.html
```

現在の prototype は静的 HTML。実アプリ実装時はこの構成をデザイン原案として使う。

## 4. 実装優先順位

1. Codex App Server client の interface と doctor を安定させる
2. Slack mention / DM から task candidate を作る flow と test を追加する
3. Slack DM の承認ボタンを `タスク化する` / `内容を修正` / `タスク化しない` にする
4. Scheduler を `start_check` / `mid_check` / `end_check` ベースに更新する
5. Dashboard を静的 HTML から local web UI へ進める
6. Dashboard snapshot API または read model を作る
7. Visual QA と guard test を通す

## 5. UI で戻してはいけないもの

- 抽象的なトップバー
- 手動 refresh 前提の UI
- `runtime` と `schedule` を同格に大きく扱う表示
- `Socket online` / `DB` / `Mode` など、ユーザー判断に直結しない技術表示
- `slow` のような根拠が曖昧なステータス
- `task_candidate` / `approval_required` などの内部名
- `Slack option: 追加` のような実装都合のボタン名
- 行動心理学の説明文を画面に直接出すこと

## 6. 期待する確認

- `pnpm test`
- データ経路 guard
- Slack Block Kit 制約テスト
- Dashboard の desktop / mobile スクリーンショット確認
- HTML または実アプリをブラウザで開いて、テキストのはみ出し・重なり・ボタンと状態の混同がないことを確認

HTML を修正したら、必ず `open docs/dashboard-prototype.html` で開き直す。
