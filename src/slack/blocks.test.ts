import { describe, it, expect } from "vitest";
import {
  textBlocks,
  candidateDecisionQuickReplies,
  quickReplyBlock,
  parseCandidateCommand,
  taskChoiceQuickReplies,
  recapQuickReplies,
  followUpQuickReplies,
  pressedBlocks,
  validateBlocks,
  type SlackBlock,
} from "./blocks.js";

describe("textBlocks", () => {
  it("短文は 1 section", () => {
    const b = textBlocks("おはようございます");
    expect(b).toHaveLength(1);
    expect(validateBlocks(b)).toEqual([]);
  });

  it("3000 字超は分割され、すべて制約内", () => {
    const long = "あ".repeat(7000) + "\n" + "い".repeat(100);
    const b = textBlocks(long);
    expect(b.length).toBeGreaterThan(1);
    expect(validateBlocks(b)).toEqual([]);
    // 内容が失われない
    const joined = b.map((x) => (x as { text: { text: string } }).text.text).join("");
    expect(joined.replace(/\n/g, "")).toBe(long.replace(/\n/g, ""));
  });
});

describe("quickReply", () => {
  it("タスク選択: タスク 4 件 + 他のこと。長い名前は切り詰める", () => {
    const replies = taskChoiceQuickReplies([
      "とても長い名前のタスクでボタンには収まらないはずのもの何文字あるでしょうか",
      "B",
      "C",
      "D",
      "E (5つ目は出ない)",
    ]);
    expect(replies).toHaveLength(5); // 4 tasks + 他のこと
    expect(replies[4]?.label).toBe("他のこと");
    const block = quickReplyBlock(replies)!;
    expect(validateBlocks([block])).toEqual([]);
  });

  it("タスクゼロならボタン無し", () => {
    expect(taskChoiceQuickReplies([])).toEqual([]);
    expect(quickReplyBlock([])).toBeNull();
  });

  it("補足確認: 特になし / 休みにする", () => {
    const block = quickReplyBlock(recapQuickReplies())!;
    expect(validateBlocks([block])).toEqual([]);
    const values = (block.elements as { value: string }[]).map((e) => e.value);
    expect(values).toContain("特になし");
    expect(values).toContain("今日は休みにします");
  });

  it("action_id は要素ごとに一意", () => {
    const block = quickReplyBlock(recapQuickReplies())!;
    const ids = (block.elements as { action_id: string }[]).map((e) => e.action_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("通常返信: 最初の一歩を聞く文には低摩擦ボタンを付ける", () => {
    const replies = followUpQuickReplies("最初の一歩は何から始めますか？");
    expect(replies.map((r) => r.label)).toEqual([
      "5分だけ触る",
      "ブロッカーを書く",
      "今日は休みにする",
    ]);
    expect(validateBlocks([quickReplyBlock(replies)!])).toEqual([]);
  });

  it("通常返信: タスク選択の文にはタスク候補ボタンを付ける", () => {
    const replies = followUpQuickReplies("今日はどれを動かしますか？", ["API 設計", "画面実装"]);
    expect(replies.map((r) => r.label)).toEqual(["API 設計", "画面実装", "他のこと"]);
  });

  it("通常返信: 補足確認の文には夕方用ボタンを付ける", () => {
    const replies = followUpQuickReplies("補足はありますか？");
    expect(replies.map((r) => r.label)).toEqual(["特になし", "今日は休みにする"]);
  });

  it("タスク候補: 表示ラベルは日本語の判断だけにする", () => {
    const replies = candidateDecisionQuickReplies("candidate-1");
    expect(replies.map((r) => r.label)).toEqual([
      "タスク化する",
      "内容を修正",
      "タスク化しない",
    ]);
    expect(replies.map((r) => r.label).join(" ")).not.toMatch(/task_candidate|approval_required|Slack option/);
    expect(validateBlocks([quickReplyBlock(replies)!])).toEqual([]);
  });

  it("タスク候補: button value は内部コマンドとして parse できる", () => {
    const replies = candidateDecisionQuickReplies("candidate-1");
    expect(parseCandidateCommand(replies[0]!.value!)).toEqual({
      decision: "approve",
      candidateId: "candidate-1",
    });
    expect(parseCandidateCommand(replies[1]!.value!)).toEqual({
      decision: "revise",
      candidateId: "candidate-1",
    });
    expect(parseCandidateCommand(replies[2]!.value!)).toEqual({
      decision: "reject",
      candidateId: "candidate-1",
    });
    expect(parseCandidateCommand("タスク化する")).toBeNull();
  });
});

describe("pressedBlocks", () => {
  it("actions を消して選択内容を context に残す", () => {
    const original: SlackBlock[] = [
      ...textBlocks("今日はどれを動かしますか？"),
      quickReplyBlock(recapQuickReplies())!,
    ];
    const after = pressedBlocks(original, "特になし");
    expect(after.some((b) => b.type === "actions")).toBe(false);
    expect(after.some((b) => b.type === "context")).toBe(true);
    expect(validateBlocks(after)).toEqual([]);
  });
});
