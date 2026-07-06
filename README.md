# Man.Ai.ger

プロアクティブに進捗を聞きに来るマネジメント AI。溜まった仕事文脈から、ワーカー AI (Claude Code 等) 向けの背景つき指示文を生成する。

- **ローカルファースト**: データは社給機の SQLite から出ない
- **新しいデータ経路ゼロ**: 会社 Slack (Socket Mode) と会社契約の LLM シート (`claude -p`) のみを使う
- **ワーカー AI は自作しない**: ブリーフィングを MCP で注入する側に立つ

要件: [docs/requirements.md](docs/requirements.md)
