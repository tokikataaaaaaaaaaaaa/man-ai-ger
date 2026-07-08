# Man.Ai.ger 要件定義書

> 最終更新: 2026-07-08
> 参照プロトタイプ: `docs/dashboard-prototype.html`
> 本書と古い `CLAUDE.md` / `AGENTS.md` の記述が矛盾する場合は、本書を優先する。

---

## 1. プロダクトの目的

Man.Ai.ger は、ユーザー本人の代わりに仕事の現在地を保ち、Slack 上で自然に進捗確認・タスク化・延期・分解を促すローカルファーストのマネジメント AI である。

解決する課題:

1. TODO アプリに自分で入力し続けるのが続かない
2. Slack 上で発生した依頼・相談・メンションをタスクとして取りこぼす
3. 働きたくない、面倒、詰まった、先延ばししたい状態を、説教ではなく実行可能な次の一手に落としたい
4. 会社の機密情報を外部 SaaS に保存せず、社給機・会社 Slack・会社契約の LLM 利用範囲で完結したい

## 2. 確定した基本方針

### 2.1 Slack が主な対話面

- 入力、承認、修正、却下は Slack Bot との DM を主経路にする
- Slack の mention / DM / ボタン操作を観測し、必要に応じてタスク候補化する
- Web Dashboard は仕事の現在地を目視するための画面であり、直接 DB を更新する主入力面にしない
- Dashboard 上のアクションは、Slack Bot への相談・承認フローを開始するショートカットとして扱う

### 2.2 Dashboard は必須

Dashboard は「いま何を管理されているか」「自分が対応すべきものは何か」を一目で見る画面である。

最上部にはグローバルな日時・同期・更新ボタン等を置かない。最初に見せるべきものは `現在マネジメント中` のタスクである。

### 2.3 LLM は Codex App Server 一択

- コンテキスト管理と LLM 実行は Codex App Server を利用する
- 別 LLM CLI の実行経路は持たない
- Codex App Server が起動していない場合、このプロダクトの中核機能は利用できない
- そのため Dashboard / doctor で確認すべきサービス状態は `Codex App Server が利用可能か` と `Slack 連携が成立しているか` に絞る
- `slow` のような曖昧な診断表示は出さない。起動しているか、利用できるかを確認する

### 2.4 新しいデータ経路ゼロ

データが社給機の外に出てよいのは、会社 Slack と会社契約の LLM 実行面だけである。

- 外部 SaaS / 自前クラウドへの保存・送信をしない
- テレメトリ・アナリティクスを入れない
- Slack は Socket Mode を利用し、公開エンドポイントを持たない
- SQLite はローカル保存とする

### 2.5 初回オンボーディングは `manaiger init` が担当する

初回ユーザーに README を読み解かせ、`.env` を手でコピー・編集させる状態は製品として弱い。

Man.Ai.ger は CLI + local Dashboard の製品として配布する。初回起動前に `manaiger init` を実行すると、最低限起動できる状態まで対話的に設定できることを必須要件とする。

`manaiger init` の責務:

1. 設定ファイルを作成または更新する
2. データ保存先を決める
3. MVP の連携対象として Slack を有効化する
4. Slack Bot Token / Slack App Token を保存する
5. working hours の初期値を保存する
6. interaction spacing / recheck interval の初期値を保存する
7. SQLite DB を初期化できることを確認する
8. 最後に `manaiger doctor` / `manaiger start` / Dashboard URL の次アクションを表示する

初回オンボーディングで扱う設定:

| 設定 | 初期値 | 保存先 | 備考 |
|---|---:|---|---|
| データ保存先 | `~/.manaiger` | bootstrap `.env` の `MANAIGER_HOME` | 変更には再起動が必要 |
| Slack Bot Token | なし | bootstrap `.env` の `SLACK_BOT_TOKEN` | `xoxb-` 形式 |
| Slack App Token | なし | bootstrap `.env` の `SLACK_APP_TOKEN` | `xapp-` 形式 |
| 作業開始時刻 | `09:00` | DB settings `work_start` | Dashboard から日常変更可 |
| 作業終了時刻 | `18:00` | DB settings `work_end` | Dashboard から日常変更可 |
| 連続確認の最小間隔 | `20` 分 | DB settings `interaction_spacing_min` | Dashboard から日常変更可 |
| 未応答の再確認まで | `30` 分 | DB settings `recheck_after_min` | Dashboard から日常変更可 |

MVP の onboarding では、連携サービスの選択肢を Slack のみに固定する。Atlassian / Discord / Teams / GitHub などの追加 connector や MCP 登録は、初回設定を重くし、外部データ経路の安全性確認も増やすため MVP には含めない。

設定ファイルの原則:

- インストール済み CLI では、作業ディレクトリに依存しない bootstrap 設定を使う
- bootstrap 設定の既定位置は `~/.manaiger/.env`
- `MANAIGER_HOME` を別ディレクトリにした場合も、CLI が次回起動時にその値を発見できること
- 既存 `.env` を更新する場合、未知のキーやコメントを破壊しない
- secret 値はログや Dashboard に全文表示しない
- `init` は Slack や Codex に機密データを送信しない。到達性確認は `doctor` が担当する
- working hours / interaction timing は `.env` からも fallback として読めるが、`init` と Dashboard は DB settings に保存する

Dashboard settings との分担:

- `init`: 起動前に必要な bootstrap と認証情報を揃える
- Dashboard `/settings`: 起動後に日常的に変えたい運用値だけを編集する
- Dashboard で直接変更しないもの: データ保存先、Slack token、Dashboard port、Codex CLI path、Codex model
- Dashboard ではこれらの起動時設定を read-only で表示し、変更には再起動や `.env` 編集が必要であることを示す

将来の connector 方針:

- Slack 以外の外部サービスは、ユーザーが onboarding で明示的に opt-in した場合だけ有効化する
- connector は `event ingestion` と `read-only context source` を分けて設計する
- Teams / Discord の mention 取り込みは event ingestion として扱う
- Atlassian / GitHub / Confluence などの参照は、まず read-only context source として扱う
- connector を追加するたびに、`doctor`、Dashboard Service 表示、データ経路ガード、secret マスキングを更新する

## 3. Dashboard 要件

プロトタイプは `docs/dashboard-prototype.html` を参照する。

### 3.1 画面に残す情報

1. `現在マネジメント中`
   - 現在 AI が管理対象としている Project / Task
   - 進捗、次の介入時刻、次に確認する内容
   - `AIへの相談` の導線

2. タスク分類カード
   - `タスク候補`
   - `本日締め切り`
   - `期限すぎ`
   - `進行中`
   - `未着手`

3. Slack Context
   - Slack 上で起きている mention / DM / bot の提案を read-only mirror として表示する
   - Dashboard で会話本文を編集しない
   - 承認・修正・却下は Slack DM 側で実行する

4. Service
   - `Slack連携`
   - `Codex App Server`
   - `最終同期`

### 3.2 画面から削る情報

以下は Dashboard の主要 UI には置かない。

- 曖昧なトップバー全般
- `仕事の現在地` のような抽象的な見出し
- 手動 refresh ボタン。通常は自動同期でよい
- `Mode`、`DB`、`Socket online` など、ユーザーの意思決定に直結しない技術表示
- `slow` のように判断根拠が不明な状態
- `runtime` と `schedule` を同格の大きさで見せる表示
- 行動心理学の説明文そのもの。理論は UI の裏側で使い、画面に説明しない

### 3.3 状態とボタンの区別

状態はボタンに見せない。色付きの状態チップとして表示する。

確定状態ラベル:

- `タスク候補`
- `承認待ち`

操作は明確にボタンとして見せる。各分類カードのボタンは以下を基本とする。

| カード | ボタン |
|---|---|
| タスク候補 | `AIと判断` |
| 本日締め切り | `AIに進捗報告`, `AIに延期報告` |
| 期限すぎ | `AIに進捗報告`, `AIに延期報告` |
| 進行中 | `AIに進捗報告`, `AIに延期報告` |
| 未着手 | `AIに進捗報告`, `AIに開始報告` |

Slack のタスク候補承認フローでは、ボタン名をユーザーの判断として読める言葉にする。

- `タスク化する`
- `内容を修正`
- `タスク化しない`

`Slack option: 追加` のような実装都合のラベルは使わない。

## 4. Slack mention からタスク化するフロー

対象 use case:

1. Slack でユーザー宛の mention / DM が発生する
2. Bot が内容を読み、タスク候補にすべきか判定する
3. タスク候補なら Dashboard の `Slack Context` に `タスク候補` / `承認待ち` として表示する
4. Bot がユーザー DM で確認する
5. Bot はタスク名、Project、期限を提案する
6. ユーザーが `タスク化する` / `内容を修正` / `タスク化しない` を選ぶ
7. 承認された場合だけ Task を作成し、events に痕跡を残す

例:

```text
#backend / Tanaka
請求APIの認証方式、今日中に決めたいです。レビューできますか？

Man.Ai.ger DM
このmentionをタスク化しますか？
提案: 「請求APIの認証方式を決める」
Project: 請求書システム改修
Due: 今日18:00

[タスク化する] [内容を修正] [タスク化しない]
```

## 5. 進捗管理の介入設計

朝 9:00 / 夕 18:00 だけでは、プロアクティブなマネジメントとして弱い。

デフォルトは、タスクごとに次の 3 点で interaction を起こす。

1. 開始予定時刻
   - 「何から始めるか」を確認する
   - 着手できない場合は最小の一歩に落とす

2. 途中確認
   - 進捗、詰まり、脱線、疲れを確認する
   - 未応答なら 1 回だけ再確認し、それでも無理なら延期候補に回す

3. 終了予定時刻 / 締切前
   - 完了、継続、延期、ブロッカー化を選ばせる
   - 責めずに次の状態へ整理する

開始・途中・終了の時刻は Task properties の `planned_start` / `planned_mid` / `planned_end` で上書き可能にする。初期値は working hours とタスクの期限から自動生成する。

連続 interaction の最小間隔と未応答時の再確認までの時間は設定可能にする。初期値はそれぞれ 20 分、30 分とする。

## 6. 働きたくない時のコーチング

ユーザーが `やりたくない`、`めんどくさい`、`タスク分解して`、`ブロッカーまとめて`、`今やらなくていい` のどれかを選ぶ、または Slack に同様の気持ちを書くと、Bot が Slack DM で対応する。

Dashboard の `AIへの相談` は、この Slack Bot フローを開始する導線である。

相談入口は LLM 不通時でも沈黙しないよう、Bot が deterministic に受け止め文と次の選択肢を返す。相談の発生は `coaching_intent` event として保存する。

介入の原則:

- 説教しない
- 完了を迫らない
- 5 分着手、半分に切る、ブロッカーだけ書く、意図的延期のどれかに落とす
- ユーザーの自己効力感を壊さない
- やらない判断も、計画された延期として記録できるようにする

## 7. MVP の Definition of Done

1. `manaiger init` で初回起動に必要な設定を作成できる
2. Slack mention / DM からタスク候補を検出できる
3. Bot がタスク名・Project・期限を提案し、ユーザーが Slack DM で承認・修正・却下できる
4. Task の状態が SQLite に保存され、events に履歴が残る
5. Dashboard で `現在マネジメント中` と 5 種のタスク分類を確認できる
6. Dashboard `/settings` で working hours / interaction timing を変更できる
7. タスク開始・途中・終了の interaction がスケジュールされる
8. 働きたくない時の相談フローが Slack Bot で成立する
9. Codex App Server 未起動時に中核機能が使えないことを明示できる
10. 外部データ経路が Slack と Codex App Server 以外に増えていないことをテストで保証する

## 8. スコープ外

- Dashboard 上で自由入力チャットを実装すること
- Web 画面から直接 Task を作成・更新すること
- Dashboard から Slack token やデータ保存先を変更すること
- チーム利用・マルチユーザー
- Jira / GitHub 連携
- 課金設計
- ワーカー AI の自作

## 9. 開発候補バックログ

MVP 完了後の候補:

1. Integration registry
   - Slack / Atlassian / Discord / Teams / GitHub などを登録可能な connector として扱う
   - onboarding で明示的に選択された connector だけを有効化する

2. Read-only context connector
   - Atlassian Jira / Confluence / GitHub issue / GitHub PR などを、タスク判断の文脈として読む
   - 初期段階では書き込みや自動更新をしない

3. Event ingestion connector
   - Discord / Teams の mention / DM / chat を Slack mention と同様にタスク候補化する
   - polling / webhook / socket のどれを使うかは connector ごとに決める

4. Connector security model
   - connector ごとに必要 scope、保存する secret、外部送信されるデータ、doctor の確認項目を明文化する
   - Dashboard では有効/無効と接続可否だけを表示し、secret は表示しない
