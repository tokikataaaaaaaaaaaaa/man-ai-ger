/**
 * 1 日デモ (UX 検証用)。
 * FakeLlm の決定的な応答で、会話全体を HTML に描画する。
 *
 * 実行: pnpm demo
 * 出力: demo-out/transcript.json, demo-out/demo.html
 */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../src/db/client.js";
import { FakeLlm } from "../src/llm/types.js";
import { processTurn } from "../src/agent/run-turn.js";
import { followUpQuickReplies } from "../src/slack/blocks.js";
import type { TurnInput } from "../src/llm/prompts.js";

const OUT = join(import.meta.dirname, "..", "demo-out");
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const db = openDb(join(OUT, "demo.db"));

const reply = (text: string, actions: unknown[] = []): string => JSON.stringify({ reply: text, actions });
const llm = new FakeLlm([
  reply("ありがとうございます。「請求書システム改修」の「API 設計」を今日の管理対象にします。", [
    { type: "create_project", name: "請求書システム改修" },
    { type: "create_task", name: "API 設計", project: "請求書システム改修", due: null },
    { type: "set_status", task: "API 設計", status: "doing" },
  ]),
  reply("「API 設計」の開始時間です。最初に触るのはどこにしますか？"),
  reply("今日は気が乗らない日なんですね。5分だけエンドポイント一覧を見るのと、ブロッカーだけ書くのならどちらが楽ですか？"),
  reply("ブロッカーを記録しました。次は認証方式の候補を2つに絞るところからにしましょう。", [
    { type: "record_blocker", task: "API 設計", text: "認証方式の候補が多く決めきれていない" },
  ]),
  reply("「API 設計」の締め時間です。今日は継続、延期、ブロッカー化のどれにしますか？"),
  reply("延期として記録しました。次は明日の午前に認証方式の候補比較から再開しましょう。", [
    { type: "defer_task", task: "API 設計", until: null, reason: "認証方式の候補比較を明日に回す" },
  ]),
]);

interface Entry {
  who: "user" | "coach";
  time: string;
  text: string;
  buttons?: string[];
}
const transcript: Entry[] = [];

function at(hhmm: string): Date {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date();
  d.setHours(h ?? 0, m ?? 0, 0, 0);
  return d;
}

async function turn(time: string, input: TurnInput): Promise<void> {
  if (input.kind === "user") {
    transcript.push({ who: "user", time, text: input.text });
    console.log(`\n[user ${time}] ${input.text}`);
  }
  const { text } = await processTurn({ db, llm, now: () => at(time) }, input, async () => {});
  const buttons = followUpQuickReplies(text).map((r) => r.label);
  transcript.push({
    who: "coach",
    time,
    text,
    ...(buttons.length > 0 ? { buttons } : {}),
  });
  console.log(`[coach ${time}] ${text}${buttons.length > 0 ? `\n  [buttons] ${buttons.join(" / ")}` : ""}`);
}

await turn("09:00", {
  kind: "user",
  text: "請求書システム改修の API 設計を今日進めます",
});
await turn("09:05", { kind: "start_check", taskId: "demo-task", taskName: "API 設計" });
await turn("09:08", { kind: "user", text: "正直やりたくないです。めんどくさいです" });
await turn("09:12", { kind: "user", text: "ブロッカーだけ書きます。認証方式の候補が多くて決めきれません" });
await turn("17:30", { kind: "end_check", taskId: "demo-task", taskName: "API 設計" });
await turn("17:33", { kind: "user", text: "今日は延期にします。明日の午前に候補比較からやります" });

writeFileSync(join(OUT, "transcript.json"), JSON.stringify(transcript, null, 2));

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderText(t: string): string {
  return esc(t)
    .split("\n")
    .map((line) =>
      line.startsWith("📋") ? `<div class="footnote">${line}</div>` : `<div>${line || "&nbsp;"}</div>`,
    )
    .join("");
}

const rows = transcript
  .map((entry) => {
    const buttons = entry.buttons
      ? `<div class="buttons">${entry.buttons.map((b) => `<span class="btn">${esc(b)}</span>`).join("")}</div>`
      : "";
    return `
    <div class="msg ${entry.who}">
      <div class="avatar">${entry.who === "coach" ? "MA" : "You"}</div>
      <div class="body">
        <div class="meta"><b>${entry.who === "coach" ? "Man.Ai.ger" : "ユーザー"}</b> <span>${entry.time}</span></div>
        <div class="text">${renderText(entry.text)}</div>
        ${buttons}
      </div>
    </div>`;
  })
  .join("\n");

const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Man.Ai.ger — 1日デモ</title>
<style>
  body { font-family: -apple-system, "Hiragino Sans", sans-serif; background: #f6f7f4; margin: 0; padding: 24px 12px; color: #1f2522; }
  .wrap { max-width: 680px; margin: 0 auto; }
  h1 { font-size: 18px; margin: 0 0 6px; }
  .sub { color: #65716b; font-size: 12.5px; margin-bottom: 20px; }
  .msg { display: flex; gap: 10px; margin: 14px 0; }
  .avatar { font-size: 12px; font-weight: 800; width: 36px; height: 36px; background: #fff; border: 1px solid #d9ded7; border-radius: 8px; display: grid; place-items: center; flex: none; }
  .meta { font-size: 12px; color: #65716b; margin-bottom: 3px; }
  .meta span { color: #7c8780; margin-left: 6px; font-weight: normal; }
  .text { background: #fff; border: 1px solid #d9ded7; border-radius: 8px; padding: 10px 13px; font-size: 14px; line-height: 1.65; }
  .msg.user .text { background: #e7effb; border-color: #cddcf0; }
  .footnote { color: #3a433e; font-size: 12px; background: #f1f4ef; border-radius: 6px; padding: 2px 8px; margin-top: 6px; display: inline-block; }
  .buttons { margin-top: 8px; display: flex; gap: 6px; flex-wrap: wrap; }
  .btn { border: 1px solid #c7e1d6; border-radius: 6px; padding: 4px 10px; font-size: 12.5px; background: #e6f1ec; color: #1f5d49; font-weight: 700; }
</style></head><body><div class="wrap">
<h1>Man.Ai.ger — 1 日の会話デモ</h1>
<div class="sub">FakeLlm による決定的デモ。実 LLM の契約検証は scripts/smoke-llm.ts で Codex App Server に対して行う。</div>
${rows}
</div></body></html>`;

writeFileSync(join(OUT, "demo.html"), html);
console.log(`\n書き出し: ${join(OUT, "demo.html")}`);
