/**
 * プロンプト構築 (architecture.md §3, behavior-design.md)。
 * SYSTEM_PROMPT は静的 (人格 + プロトコル + 出力契約)。
 * buildTurnPrompt が毎ターンの動的文脈を組み立てる (stateless 設計)。
 */
import type { WorkObject, WorkEvent, Turn } from "../db/types.js";
import { jaWeekday } from "../util/dates.js";

export const SYSTEM_PROMPT = `あなたは「Man.Ai.ger (マネイジャー)」。ユーザー専属の、共感コーチ型マネジメント AI です。
Slack の DM でユーザーの仕事の進捗に伴走します。

## 人格と原則
- 動機づけ面接 (MI) がベース。詰める上司ではなく、本人の言葉を引き出すコーチ
- 敬語ベースの温かく簡潔な日本語。絵文字は 1 メッセージ 0〜1 個まで
- 説教・圧・罪悪感の誘発・比較 (「みんなやってる」等) は絶対にしない
- 観測してから聞く: 知っている情報 (下の「仕事の現在地」) を述べてから差分だけ聞く。「進捗どうですか」と丸腰で聞かない
- タスクは必ず具体名で呼ぶ。「あのタスク」「例の件」は禁止
- 質問は 1 メッセージに 1 つ。メッセージは 3〜6 行以内
- 完了を迫らない。「5分だけ触る」「半分に切る」「ブロッカーだけ書く」の最小着手に全振りする

## タスク開始の確認 (start_check を受けたとき)
1. 対象タスクを具体名で示し、「最初に触るのはどこにしますか？」と 1 問だけ聞く
2. 決まったら set_plan で記録し、「では◯◯からですね」と短く締める
3. 着手できない空気なら、グダり介入プロトコルへ移る

## 途中の確認 (mid_check を受けたとき)
1. 対象タスクと (あれば) 予定していた一歩を示す
2. 「進んだ / 詰まった / 脱線した / 疲れた / 後でやる」を選びやすい形で 1 問だけ聞く
3. 進んだ → 短くねぎらい記録。詰まった → record_blocker で切り出す。脱線・疲れ・後でやる → 最小着手か defer_task に落とす

## 終了・締切前の確認 (end_check を受けたとき)
1. 今日扱っていたタスクを具体名で示す
2. 「完了 / 続ける / 延期する / ブロッカーあり」から選ばせる
3. 選択に応じて set_status / defer_task / record_blocker を発火し、必要なら明日の最初の一歩を 1 つだけ決める
- 前進ゼロでも責めない。事実として静かに扱う

## タスク追加のヒアリング (add_task を受けたとき)
1. 「まだ登録されていない仕事で、抱えているものはありますか？」を 1 問で聞く
2. 挙がった項目を create_task で登録する (締切や着手中である旨が分かれば due / set_status も使う)
3. 複数あっても一度に受け取ってよいが、聞き返しは 1 問だけに絞る
4. 登録したら件数を添えて短く締める

## 勤務開始のヒアリング (start_of_day を受けたとき)
1. 「今日取り組むこと」を 1 問で聞く。複数あれば挙げてもらってよい
2. 挙がったものを create_task で登録する (今日中に閉じたいものは due を今日にする)
3. 続けて「今日以外で、今のうちに拾っておきたいものはありますか？」を 1 問だけ聞く (due は null でよい)
4. 挙がったら create_task で登録し、「◯件、記録しました」で短く締める。無ければ無理に聞き出さない

## グダり介入 (抵抗・回避・自己否定が見えたとき)
Step 1: 感情を短く言い換えて受け止める (否定・正論・説教をしない)
Step 2: 本人の目的に戻す質問を 1 つ (例: 「これが片付くと何が一番ラクになりますか？」)
Step 3: 最小の一歩を 2 択で出す (「5分だけ触る」と「ブロッカーだけ書く」など)
Step 4: それでも無理なら defer_task (意図的延期) を記録し、「次は◯◯からにしましょう」で閉じる
- 3 往復以上粘らない。過去の未達を蒸し返さない

## 記録 (actions)
会話から仕事の構造を検出したら actions で記録します。ユーザーに入力作業をさせないこと。
- 新しいプロジェクトの話 → create_project
- 新しいタスク・作業の話 → create_task (どのプロジェクトか分かれば project を付ける)
- 着手した/終わった/詰まっている → set_status (todo/doing/blocked/done/deferred)
- 「何から始めるか」が決まった → set_plan (task と、「◯◯から着手」の形の要約)
- 詰まりの内容が言語化された → record_blocker
- 延期・後でやると決めた → defer_task (until は分かる場合のみ、reason は本人の言葉で)
- 構造化しにくい大事な発言 → note
記録は黙って行い、会話では自然に振る舞ってください (アプリが「📋 更新」脚注を自動表示します)。

## 出力契約 (最重要)
ツールやコマンドは一切使わず、本文として **次の JSON オブジェクトだけ** を出力してください。JSON の前後に文章を書かないでください。
{
  "reply": "ユーザーへ返す日本語テキスト",
  "actions": [
    {"type": "create_project", "name": "..."},
    {"type": "create_task", "name": "...", "project": "... または null", "due": "YYYY-MM-DD または null"},
    {"type": "set_status", "task": "...", "status": "todo|doing|blocked|done|deferred"},
    {"type": "set_plan", "task": "...", "summary": "..."},
    {"type": "record_blocker", "task": "...", "text": "..."},
    {"type": "defer_task", "task": "...", "until": "YYYY-MM-DD または null", "reason": "..."},
    {"type": "note", "text": "..."}
  ]
}
actions が無いターンは "actions": [] としてください。`;

/** Codex App Server の outputSchema (turn の最終応答を契約に固定する)。 */
export const TURN_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    reply: { type: "string" },
    actions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: [
              "create_project",
              "create_task",
              "set_status",
              "set_plan",
              "record_blocker",
              "defer_task",
              "note",
            ],
          },
          name: { type: ["string", "null"] },
          project: { type: ["string", "null"] },
          due: { type: ["string", "null"] },
          task: { type: ["string", "null"] },
          status: { type: ["string", "null"] },
          summary: { type: ["string", "null"] },
          text: { type: ["string", "null"] },
          until: { type: ["string", "null"] },
          reason: { type: ["string", "null"] },
        },
        required: [
          "type",
          "name",
          "project",
          "due",
          "task",
          "status",
          "summary",
          "text",
          "until",
          "reason",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["reply", "actions"],
  additionalProperties: false,
};

// --- 動的文脈 ---------------------------------------------------------------

export interface ProjectTree {
  project: WorkObject;
  tasks: WorkObject[];
}

export interface TurnContext {
  now: Date;
  /** Project → 配下 Task。無所属タスクは name="Inbox" の擬似プロジェクトに入れて渡す。 */
  tree: ProjectTree[];
  todayTurns: Turn[];
  recentEvents: WorkEvent[];
}

export type TurnInput =
  | { kind: "user"; text: string }
  | { kind: "start_check"; taskId: string; taskName: string }
  | { kind: "mid_check"; taskId: string; taskName: string }
  | { kind: "end_check"; taskId: string; taskName: string }
  | {
      kind: "recheck";
      taskId: string;
      taskName: string;
      originalKind: "start_check" | "mid_check" | "end_check";
    }
  | { kind: "add_task" }
  | { kind: "start_of_day" };

export const STATUS_LABEL: Record<string, string> = {
  todo: "未着手",
  doing: "進行中",
  blocked: "ブロック中",
  done: "完了",
  deferred: "延期中",
};

export function renderTree(tree: ProjectTree[]): string {
  if (tree.length === 0) return "(まだ何も記録されていません — 初日です)";
  const lines: string[] = [];
  for (const { project, tasks } of tree) {
    lines.push(`■ ${project.name}`);
    if (tasks.length === 0) lines.push("  (タスクなし)");
    for (const t of tasks) {
      const status = STATUS_LABEL[t.status ?? "todo"] ?? t.status ?? "";
      const due = t.due ? ` 締切:${t.due}` : "";
      lines.push(`  - ${t.name} [${status}]${due}`);
    }
  }
  // プロンプト肥大化対策: 40 行まで
  return lines.slice(0, 40).join("\n");
}

function renderTurns(turns: Turn[]): string {
  if (turns.length === 0) return "(今日はまだ会話していません)";
  return turns
    .map((t) => `${t.role === "user" ? "ユーザー" : "あなた"}: ${t.content}`)
    .join("\n");
}

function renderEvents(events: WorkEvent[]): string {
  if (events.length === 0) return "(なし)";
  return events.map((e) => `- ${e.ts.slice(0, 16)} ${e.summary}`).join("\n");
}

function renderInput(input: TurnInput): string {
  switch (input.kind) {
    case "user":
      return `ユーザーの発話: ${input.text}`;
    case "start_check":
      return `(システム: タスク「${input.taskName}」の開始予定時刻です。開始確認プロトコルに従って、あなたから声をかけてください)`;
    case "mid_check":
      return `(システム: タスク「${input.taskName}」の途中確認の時刻です。途中確認プロトコルに従って、あなたから声をかけてください)`;
    case "end_check":
      return `(システム: タスク「${input.taskName}」の終了予定・締切前の確認時刻です。終了確認プロトコルに従って、あなたから声をかけてください)`;
    case "recheck":
      return `(システム: タスク「${input.taskName}」の前回確認に未応答です。再確認は1回だけです。責めずに、今の状態を選びやすい短い確認を送ってください)`;
    case "add_task":
      return `(システム: ユーザーが「タスク追加」を押しました。タスク追加のヒアリングプロトコルに従って、あなたから声をかけてください)`;
    case "start_of_day":
      return `(システム: ユーザーが「勤務開始」を押しました。勤務開始のヒアリングプロトコルに従って、あなたから声をかけてください)`;
  }
}

/** 曜日→日付の変換ミス (「金曜締切」の誤算) を防ぐ 7 日分の参照表。 */
export function renderCalendar(now: Date): string {
  const lines: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const label = i === 0 ? "今日" : i === 1 ? "明日" : `${jaWeekday(d)}曜日`;
    lines.push(`${label}: ${iso} (${jaWeekday(d)})`);
  }
  return lines.join(" / ");
}

export function buildTurnPrompt(ctx: TurnContext, input: TurnInput): string {
  const d = ctx.now;
  const dateLine = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 (${jaWeekday(d)}) ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return [
    `## 今の日時\n${dateLine}\n日付参照表 (締切の due を決めるときは必ずこの表で換算): ${renderCalendar(d)}`,
    `## 仕事の現在地\n${renderTree(ctx.tree)}`,
    `## 今日のこれまでの会話\n${renderTurns(ctx.todayTurns)}`,
    `## 今日の記録 (events)\n${renderEvents(ctx.recentEvents)}`,
    `---\n${renderInput(input)}`,
  ].join("\n\n");
}
