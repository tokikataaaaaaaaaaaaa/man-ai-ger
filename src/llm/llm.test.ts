import { describe, it, expect } from "vitest";
import { extractJsonObject, parseLlmReply } from "./parse.js";
import { buildTurnPrompt, renderTree, SYSTEM_PROMPT, TURN_OUTPUT_SCHEMA } from "./prompts.js";
import type { TurnContext } from "./prompts.js";
import type { WorkObject } from "../db/types.js";

function obj(partial: Partial<WorkObject>): WorkObject {
  return {
    id: "id",
    type: "Task",
    name: "t",
    aliases: [],
    properties: {},
    status: "todo",
    due: null,
    createdAt: "",
    updatedAt: "",
    ...partial,
  };
}

describe("extractJsonObject", () => {
  it("素の JSON を取り出す", () => {
    expect(extractJsonObject('{"a":1}')).toBe('{"a":1}');
  });
  it("code fence を剥がす", () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });
  it("前後の散文を無視する", () => {
    expect(extractJsonObject('はい。\n{"a":{"b":2}}\n以上です')).toBe('{"a":{"b":2}}');
  });
  it("文字列内の波括弧に騙されない", () => {
    expect(extractJsonObject('{"reply":"今日は {} を使いました"}')).toBe(
      '{"reply":"今日は {} を使いました"}',
    );
  });
  it("JSON が無ければ null", () => {
    expect(extractJsonObject("こんにちは")).toBeNull();
  });
});

describe("parseLlmReply", () => {
  it("正常な応答をパースする", () => {
    const r = parseLlmReply(
      JSON.stringify({
        reply: "了解です",
        actions: [
          { type: "create_task", name: "設計書", project: "改修", due: "2026-07-01" },
          { type: "set_status", task: "調査", status: "done" },
        ],
      }),
    );
    expect(r?.reply).toBe("了解です");
    expect(r?.actions).toHaveLength(2);
    expect(r?.droppedActions).toBe(0);
  });

  it("壊れた action だけ捨て、正常な action は残す", () => {
    const r = parseLlmReply(
      JSON.stringify({
        reply: "ok",
        actions: [
          { type: "set_status", task: "調査", status: "無効な状態" },
          { type: "defer_task", task: "調査", until: null, reason: "今日は動けない" },
          { type: "unknown_action", foo: 1 },
        ],
      }),
    );
    expect(r?.actions).toEqual([
      { type: "defer_task", task: "調査", until: null, reason: "今日は動けない" },
    ]);
    expect(r?.droppedActions).toBe(2);
  });

  it("actions 欠落は空配列として扱う", () => {
    const r = parseLlmReply('{"reply":"こんにちは"}');
    expect(r?.actions).toEqual([]);
  });

  it("reply が無ければ null (フォールバックへ)", () => {
    expect(parseLlmReply('{"actions":[]}')).toBeNull();
    expect(parseLlmReply("JSON じゃない応答")).toBeNull();
    expect(parseLlmReply('{"reply":"   "}')).toBeNull();
  });

  it("due の形式が不正な create_task は捨てる", () => {
    const r = parseLlmReply(
      JSON.stringify({
        reply: "ok",
        actions: [{ type: "create_task", name: "x", due: "来週" }],
      }),
    );
    expect(r?.actions).toEqual([]);
    expect(r?.droppedActions).toBe(1);
  });
});

describe("prompts", () => {
  const ctx: TurnContext = {
    now: new Date("2026-06-29T09:00:00"),
    tree: [
      {
        project: obj({ type: "Project", name: "社内ダッシュボード改修", status: null }),
        tasks: [
          obj({ name: "API 設計", status: "doing" }),
          obj({ name: "画面実装", status: "todo", due: "2026-07-03" }),
        ],
      },
    ],
    todayTurns: [],
    recentEvents: [],
  };

  it("ツリーに具体名と状態が出る", () => {
    const s = renderTree(ctx.tree);
    expect(s).toContain("■ 社内ダッシュボード改修");
    expect(s).toContain("- API 設計 [進行中]");
    expect(s).toContain("- 画面実装 [未着手] 締切:2026-07-03");
  });

  it("start_check のプロンプトに日時と現在地が入る", () => {
    const p = buildTurnPrompt(ctx, {
      kind: "start_check",
      taskId: "t1",
      taskName: "API 設計",
    });
    expect(p).toContain("2026年6月29日 (月) 09:00");
    expect(p).toContain("API 設計");
    expect(p).toContain("開始予定時刻です");
  });

  it("user 入力がそのまま渡る", () => {
    const p = buildTurnPrompt(ctx, { kind: "user", text: "API設計、着手しました" });
    expect(p).toContain("ユーザーの発話: API設計、着手しました");
  });

  it("system prompt に出力契約と MI プロトコルがある", () => {
    expect(SYSTEM_PROMPT).toContain('"reply"');
    expect(SYSTEM_PROMPT).toContain("defer_task");
    expect(SYSTEM_PROMPT).toContain("グダり介入");
    expect(SYSTEM_PROMPT).toContain("5分");
  });

  it("日付参照表が曜日→日付を正しく並べる (締切換算の接地)", () => {
    const p = buildTurnPrompt(ctx, { kind: "user", text: "金曜締切で" });
    // ctx.now = 2026-06-29 (月) → 金曜日は 2026-07-03
    expect(p).toContain("今日: 2026-06-29 (月)");
    expect(p).toContain("金曜日: 2026-07-03 (金)");
    expect(p).toContain("日付参照表");
  });
});

describe("TURN_OUTPUT_SCHEMA (Codex strict JSON Schema 互換性)", () => {
  it("additionalProperties:false のオブジェクトは properties の全キーが required にある", () => {
    // Codex App Server (OpenAI 系 structured output) は additionalProperties:false の
    // オブジェクトに対し、properties の全キーを required に列挙することを要求する。
    // 一部のキーだけ required だと turn/start が 400 で拒否される (実運用で発生した回帰)。
    const violations: string[] = [];
    function walk(node: unknown, path: string): void {
      if (typeof node !== "object" || node === null) return;
      const schema = node as Record<string, unknown>;
      if (schema.type === "object" && schema.additionalProperties === false) {
        const properties = (schema.properties ?? {}) as Record<string, unknown>;
        const required = new Set((schema.required as string[] | undefined) ?? []);
        for (const key of Object.keys(properties)) {
          if (!required.has(key)) violations.push(`${path}.${key}`);
        }
      }
      for (const [key, value] of Object.entries(schema)) {
        if (key === "properties" && typeof value === "object" && value !== null) {
          for (const [propKey, propValue] of Object.entries(value)) {
            walk(propValue, `${path}.properties.${propKey}`);
          }
        } else if (key === "items") {
          walk(value, `${path}.items`);
        }
      }
    }
    walk(TURN_OUTPUT_SCHEMA, "$");
    expect(violations).toEqual([]);
  });
});
