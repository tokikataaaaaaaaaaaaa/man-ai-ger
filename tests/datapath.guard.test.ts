/**
 * データ経路の保証 (requirements.md §5 DoD-5, architecture.md §7)。
 *
 * Man.Ai.ger の絶対原則: データが社給機の外に出てよいのは
 *   1) 会社 Slack (@slack/bolt 経由)
 *   2) Codex App Server (codex app-server の child_process 経由)
 * のみ。src/ に外部送信コードが紛れ込んだらこのテストが落ちる。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "..", "src");

function allSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...allSourceFiles(p));
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

const FORBIDDEN: { pattern: RegExp; reason: string }[] = [
  { pattern: /\bfetch\s*\(/, reason: "fetch による外部送信" },
  { pattern: /\baxios\b/, reason: "axios による外部送信" },
  { pattern: /from\s+["']node:https?["']/, reason: "http(s) モジュールの直接使用" },
  { pattern: /require\(["']https?["']\)/, reason: "http(s) モジュールの直接使用" },
  { pattern: /\bfirebase\b/i, reason: "Firebase (Di.Ai.ry のスタック) の混入" },
  { pattern: /https:\/\/(?!api\.slack\.com)/, reason: "slack 以外の URL リテラル" },
  { pattern: /\bWebSocket\s*\(/, reason: "生 WebSocket の使用 (Slack SDK 以外)" },
];

describe("データ経路ガード", () => {
  const files = allSourceFiles(SRC);

  it("src/ にソースファイルが存在する (スキャンが空振りしていない)", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  for (const { pattern, reason } of FORBIDDEN) {
    it(`禁止: ${reason} (${pattern})`, () => {
      const violations: string[] = [];
      for (const f of files) {
        const content = readFileSync(f, "utf8");
        for (const [i, line] of content.split("\n").entries()) {
          if (pattern.test(line)) violations.push(`${f}:${i + 1}: ${line.trim()}`);
        }
      }
      expect(violations, violations.join("\n")).toEqual([]);
    });
  }

  it("依存パッケージが許可リスト内のみ", () => {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, "..", "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    const allowed = new Set(["@slack/bolt", "better-sqlite3", "commander", "zod"]);
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      expect(allowed.has(dep), `未許可の依存: ${dep}`).toBe(true);
    }
  });
});
