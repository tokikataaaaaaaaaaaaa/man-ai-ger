# Claude 用引き継ぎプロンプト

以下を Claude にそのまま貼る。

```text
Man.Ai.ger の続きの実装をお願いします。

作業ディレクトリは次です。

pwd:
/Users/parker/tokikata-agent-integrated/.worktrees/man-ai-ger-codex

まず以下を順番に読んで、これらを最新仕様として扱ってください。

1. docs/handoff-claude.md
2. docs/requirements.md
3. docs/architecture.md
4. docs/behavior-design.md
5. docs/dashboard-prototype.html

重要:
- LLM / context management は Codex App Server 一択です。別 LLM CLI 前提へ戻さないでください。
- Dashboard は必須です。docs/dashboard-prototype.html を UI の正として参照してください。
- Dashboard の最上部は「現在マネジメント中」です。抽象的なトップバー、手動 refresh、Mode/DB/Socket online などの不要な技術表示は戻さないでください。
- Dashboard は仕事の現在地を見る画面です。入力・承認・修正・却下は Slack Bot DM を主経路にしてください。
- Slack mention / DM からタスク候補を検出し、ユーザーに Slack DM で「タスク化する」「内容を修正」「タスク化しない」を提示してください。
- 状態ラベルは「タスク候補」「承認待ち」です。task_candidate / approval_required のような内部名を UI に出さないでください。
- 状態は色付きチップ、操作は色付きボタンとして見分けられる UI にしてください。
- Scheduler は朝夕固定ではなく、タスクの開始・途中・終了で interaction を起こしてください。
- 行動心理学の説明文を UI に直接出さず、裏側の対話設計に反映してください。
- HTML を修正したら必ず `open docs/dashboard-prototype.html` で表示確認してください。

まず現在の差分と既存実装を確認し、docs の最新仕様に沿って TDD/SDD で続きを実装してください。
既存の未コミット差分はユーザーまたは前工程の作業なので、不要に revert しないでください。
```
