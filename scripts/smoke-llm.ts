/**
 * Codex App Server での契約検証 (手動 smoke)。
 * 実行: pnpm exec tsx scripts/smoke-llm.ts
 */
import { CodexAppServerClient } from "../src/llm/codex.js";
import { SYSTEM_PROMPT, buildTurnPrompt } from "../src/llm/prompts.js";
import { parseLlmReply } from "../src/llm/parse.js";

const llm = new CodexAppServerClient({
  model: process.env.MANAIGER_CODEX_MODEL ?? undefined,
  cwd: process.env.MANAIGER_HOME ?? "/tmp",
});

const ctx = {
  now: new Date(),
  tree: [
    {
      project: { id: "p1", type: "Project" as const, name: "社内ダッシュボード改修", aliases: [], properties: {}, status: null, due: null, createdAt: "", updatedAt: "" },
      tasks: [
        { id: "t1", type: "Task" as const, name: "API 設計", aliases: [], properties: {}, status: "doing" as const, due: null, createdAt: "", updatedAt: "" },
      ],
    },
  ],
  todayTurns: [],
  recentEvents: [],
};

try {
  const raw = await llm.complete(SYSTEM_PROMPT, buildTurnPrompt(ctx, { kind: "user", text: "API設計おわった！次は画面実装。金曜締切で今週やる" }));
  console.log("=== raw ===");
  console.log(raw);
  const parsed = parseLlmReply(raw);
  console.log("=== parsed ===");
  console.log(JSON.stringify(parsed, null, 2));
  if (!parsed) { console.error("SMOKE FAIL: parse null"); process.exit(1); }
  console.log("SMOKE OK");
} finally {
  llm.stop();
}
