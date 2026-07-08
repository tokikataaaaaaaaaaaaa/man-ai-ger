import { describe, expect, it } from "vitest";
import { isOwnerMention } from "./app.js";

describe("Slack owner mention detection", () => {
  it("Slack mention token だけを owner mention として扱う", () => {
    expect(isOwnerMention("<@U123> レビューできますか？", "U123")).toBe(true);
    expect(isOwnerMention("@U123 レビューできますか？", "U123")).toBe(false);
    expect(isOwnerMention("<@U999> レビューできますか？", "U123")).toBe(false);
  });
});
