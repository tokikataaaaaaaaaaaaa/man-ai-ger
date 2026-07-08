import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db/client.js";
import { getSetting, setSetting } from "../db/settings.js";
import {
  applyInitConfig,
  maskSecret,
  readInitRuntimeDefaults,
  updateDotEnvFile,
  validateInitConfig,
  type InitConfig,
} from "./init.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "manaiger-init-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function validConfig(patch: Partial<InitConfig> = {}): InitConfig {
  return {
    home: join(dir, "home"),
    slackBotToken: "xoxb-valid-token",
    slackAppToken: "xapp-valid-token",
    workStart: "09:30",
    workEnd: "18:30",
    interactionSpacingMin: 20,
    recheckAfterMin: 30,
    dashboardPort: 7799,
    codexPath: "codex",
    codexModel: null,
    ...patch,
  };
}

describe("onboarding init", () => {
  it(".env の未知キーとコメントを保ったまま管理キーだけ更新する", () => {
    const envPath = join(dir, ".env");
    writeFileSync(
      envPath,
      [
        "# user comment",
        "CUSTOM_VALUE=keep",
        "SLACK_BOT_TOKEN=xoxb-old        # old inline hint",
        "MANAIGER_CODEX_MODEL=gpt-old",
      ].join("\n"),
    );

    updateDotEnvFile(envPath, {
      MANAIGER_HOME: join(dir, "home with space"),
      SLACK_BOT_TOKEN: "xoxb-new",
      SLACK_APP_TOKEN: "xapp-new",
      MANAIGER_DASHBOARD_PORT: "7799",
      MANAIGER_CODEX_PATH: "codex",
      MANAIGER_CODEX_MODEL: null,
    });

    const text = readFileSync(envPath, "utf8");
    expect(text).toContain("# user comment");
    expect(text).toContain("CUSTOM_VALUE=keep");
    expect(text).toContain('MANAIGER_HOME="');
    expect(text).toContain("SLACK_BOT_TOKEN=xoxb-new");
    expect(text).toContain("SLACK_APP_TOKEN=xapp-new");
    expect(text).not.toContain("xoxb-old");
    expect(text).not.toContain("MANAIGER_CODEX_MODEL=gpt-old");
  });

  it("bootstrap .env と DB settings を作成する", () => {
    const bootstrapEnvPath = join(dir, "bootstrap", ".env");
    const result = applyInitConfig(validConfig(), { bootstrapEnvPath });

    expect(result.home).toBe(join(dir, "home"));
    expect(result.envPath).toBe(bootstrapEnvPath);
    expect(result.dbPath).toBe(join(dir, "home", "manaiger.db"));
    expect(result.maskedSlackBotToken).toBe("xoxb-********ken");
    expect(existsSync(bootstrapEnvPath)).toBe(true);

    const envText = readFileSync(bootstrapEnvPath, "utf8");
    expect(envText).toContain(`MANAIGER_HOME=${join(dir, "home")}`);
    expect(envText).toContain("SLACK_BOT_TOKEN=xoxb-valid-token");
    expect(envText).toContain("SLACK_APP_TOKEN=xapp-valid-token");
    expect(envText).toContain("MANAIGER_DASHBOARD_PORT=7799");
    expect(envText).toContain("MANAIGER_CODEX_PATH=codex");

    const db = openDb(result.dbPath);
    expect(getSetting(db, "work_start")).toBe("09:30");
    expect(getSetting(db, "work_end")).toBe("18:30");
    expect(getSetting(db, "interaction_spacing_min")).toBe("20");
    expect(getSetting(db, "recheck_after_min")).toBe("30");
    db.close();
    expect(statSync(bootstrapEnvPath).mode & 0o777).toBe(0o600);
  });

  it("不正な token / 時刻 / 分数 / port を拒否する", () => {
    const validation = validateInitConfig(
      validConfig({
        slackBotToken: "bad",
        slackAppToken: "bad",
        workStart: "25:00",
        interactionSpacingMin: 0,
        dashboardPort: 70000,
      }),
    );

    expect(validation.ok).toBe(false);
    expect(validation.errors).toEqual([
      "SLACK_BOT_TOKEN は xoxb- で始まる値にしてください",
      "SLACK_APP_TOKEN は xapp- で始まる値にしてください",
      "作業開始時刻は HH:MM 形式にしてください",
      "連続確認の最小間隔は 1-240 分で指定してください",
      "Dashboard port は 1-65535 の整数で指定してください",
    ]);
  });

  it("init 再実行時のデフォルトは既存 DB settings を使う", () => {
    const dbPath = join(dir, "home", "manaiger.db");
    const db = openDb(dbPath);
    setSetting(db, "work_start", "10:00");
    setSetting(db, "work_end", "19:00");
    setSetting(db, "interaction_spacing_min", "60");
    setSetting(db, "recheck_after_min", "45");
    db.close();

    expect(readInitRuntimeDefaults(dbPath)).toEqual({
      workStart: "10:00",
      workEnd: "19:00",
      interactionSpacingMin: 60,
      recheckAfterMin: 45,
    });
  });

  it("secret は全文表示しない", () => {
    expect(maskSecret("xoxb-abcdefghijklmnopqrstuvwxyz")).toBe("xoxb-***********************xyz");
    expect(maskSecret("short")).toBe("*****");
  });
});
