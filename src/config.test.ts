import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDotEnv } from "./config.js";

const ENV_KEYS = [
  "MANAIGER_HOME",
  "MANAIGER_CODEX_MODEL",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
] as const;

const savedEnv = new Map<string, string | undefined>();
let dirs: string[] = [];

beforeEach(() => {
  dirs = [];
  for (const key of ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  const home = mkdtempSync(join(tmpdir(), "manaiger-home-"));
  dirs.push(home);
  process.env.MANAIGER_HOME = home;
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("loadDotEnv", () => {
  it("unquoted inline comment を値から除外し、quoted # は保持する", () => {
    const cwd = mkdtempSync(join(tmpdir(), "manaiger-cwd-"));
    dirs.push(cwd);
    writeFileSync(
      join(cwd, ".env"),
      [
        "SLACK_BOT_TOKEN=xoxb-real        # OAuth & Permissions",
        "SLACK_APP_TOKEN=xapp-real # App-Level Token",
        "MANAIGER_CODEX_MODEL=\"gpt-5 # prod\"",
      ].join("\n"),
    );

    loadDotEnv(cwd);

    expect(process.env.SLACK_BOT_TOKEN).toBe("xoxb-real");
    expect(process.env.SLACK_APP_TOKEN).toBe("xapp-real");
    expect(process.env.MANAIGER_CODEX_MODEL).toBe("gpt-5 # prod");
  });
});
