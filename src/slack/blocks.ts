/**
 * Block Kit の生成と検証 (architecture.md §6)。
 * すべてのブロックはここのビルダー経由で作り、単体テストで Slack の制約を守る。
 *
 * 設計: ボタン = 定型ユーザー入力 (押下 = その value をユーザー発話として扱う)。
 * 選択アーキテクチャ (behavior-design §4): 質問には常に低摩擦の定型回答を添える。
 */

export interface SlackBlock {
  type: string;
  [key: string]: unknown;
}

// Slack の制約 (https://api.slack.com/reference/block-kit)
const SECTION_TEXT_MAX = 3000;
const BUTTON_TEXT_MAX = 75;
const BUTTON_VALUE_MAX = 2000;
const ACTIONS_ELEMENTS_MAX = 25;
const BLOCKS_MAX = 50;

/** 長文を安全に section ブロック列へ (改行を優先して分割)。 */
export function textBlocks(text: string): SlackBlock[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > SECTION_TEXT_MAX - 100) {
    const window = rest.slice(0, SECTION_TEXT_MAX - 100);
    const cut = Math.max(window.lastIndexOf("\n"), Math.floor(window.length * 0.8));
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  chunks.push(rest);
  return chunks
    .filter((c) => c.trim().length > 0)
    .map((c) => ({
      type: "section",
      text: { type: "mrkdwn", text: c },
    }));
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export interface QuickReply {
  /** ボタンに表示する文字列。 */
  label: string;
  /** 押下時にユーザー発話として扱うテキスト。省略時は label と同じ。 */
  value?: string;
}

export type CandidateDecision = "approve" | "revise" | "reject";

export interface CandidateCommand {
  decision: CandidateDecision;
  candidateId: string;
}

/** 定型回答ボタンの actions ブロック。空配列なら null。 */
export function quickReplyBlock(replies: QuickReply[]): SlackBlock | null {
  const items = replies.slice(0, ACTIONS_ELEMENTS_MAX);
  if (items.length === 0) return null;
  return {
    type: "actions",
    elements: items.map((r, i) => ({
      type: "button",
      action_id: `quick_reply_${i}`,
      text: { type: "plain_text", text: truncate(r.label, BUTTON_TEXT_MAX), emoji: true },
      value: truncate(r.value ?? r.label, BUTTON_VALUE_MAX),
    })),
  };
}

/** タスク選択用: タスク候補ボタン (最大 4) + 「他のこと」。 */
export function taskChoiceQuickReplies(taskNames: string[]): QuickReply[] {
  const tasks = taskNames.slice(0, 4).map((name) => ({
    label: truncate(name, 24),
    value: `今日は「${name}」を進めます`,
  }));
  if (tasks.length === 0) return [];
  return [...tasks, { label: "他のこと", value: "今日は別のことをやります" }];
}

/** 補足確認用の定型回答。 */
export function recapQuickReplies(): QuickReply[] {
  return [
    { label: "特になし", value: "特になし" },
    { label: "今日は休みにする", value: "今日は休みにします" },
  ];
}

function candidateValue(decision: CandidateDecision, candidateId: string): string {
  return `manaiger:candidate:${decision}:${candidateId}`;
}

/** タスク候補の承認ボタン。表示名に内部状態名を出さない。 */
export function candidateDecisionQuickReplies(candidateId: string): QuickReply[] {
  return [
    { label: "タスク化する", value: candidateValue("approve", candidateId) },
    { label: "内容を修正", value: candidateValue("revise", candidateId) },
    { label: "タスク化しない", value: candidateValue("reject", candidateId) },
  ];
}

export function parseCandidateCommand(value: string): CandidateCommand | null {
  const m = /^manaiger:candidate:(approve|revise|reject):(.+)$/.exec(value);
  if (!m) return null;
  return { decision: m[1] as CandidateDecision, candidateId: m[2]! };
}

/**
 * LLM の通常返信に添える低摩擦な定型回答。
 * LLM 出力を信用しすぎず、文面から安全な候補だけを決定論的に付ける。
 */
export function followUpQuickReplies(text: string, taskNames: string[] = []): QuickReply[] {
  if (/補足|特になし|今日の動き|リキャップ/.test(text)) return recapQuickReplies();

  if (/どれ|どの/.test(text) && taskNames.length > 0) {
    return taskChoiceQuickReplies(taskNames);
  }

  if (/最初の一歩|5分|５分|何から|いつ頃|着手|ブロッカー|休む日/.test(text)) {
    return [
      { label: "5分だけ触る", value: "5分だけ触ります" },
      { label: "ブロッカーを書く", value: "ブロッカーを書きます" },
      { label: "今日は休みにする", value: "今日は休みにします" },
    ];
  }

  return [];
}

/** 押下済みメッセージの置き換え: ボタンを消し、選択内容を context として残す。 */
export function pressedBlocks(original: SlackBlock[], chosenLabel: string): SlackBlock[] {
  const withoutActions = original.filter((b) => b.type !== "actions");
  return [
    ...withoutActions,
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `✔️ ${truncate(chosenLabel, 140)}` }],
    },
  ];
}

/** テストとランタイム両方で使う制約チェック。違反の説明を返す (空 = OK)。 */
export function validateBlocks(blocks: SlackBlock[]): string[] {
  const errors: string[] = [];
  if (blocks.length > BLOCKS_MAX) errors.push(`blocks が ${BLOCKS_MAX} を超えています`);
  for (const b of blocks) {
    if (b.type === "section") {
      const t = (b as { text?: { text?: string } }).text?.text ?? "";
      if (t.length > SECTION_TEXT_MAX) errors.push(`section text が ${SECTION_TEXT_MAX} 字を超過`);
      if (t.trim().length === 0) errors.push("空の section");
    }
    if (b.type === "actions") {
      const els = (b as { elements?: unknown[] }).elements ?? [];
      if (els.length === 0) errors.push("空の actions");
      if (els.length > ACTIONS_ELEMENTS_MAX) errors.push("actions の要素が多すぎます");
      for (const el of els as { text?: { text?: string }; value?: string; action_id?: string }[]) {
        if ((el.text?.text ?? "").length > BUTTON_TEXT_MAX) errors.push("button text 超過");
        if ((el.value ?? "").length > BUTTON_VALUE_MAX) errors.push("button value 超過");
        if (!el.action_id) errors.push("action_id が無い button");
      }
    }
  }
  return errors;
}
