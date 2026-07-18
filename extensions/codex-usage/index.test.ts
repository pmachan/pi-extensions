import assert from "node:assert/strict";
import test from "node:test";
import { formatCodexUsage, usageColor } from "./index.ts";

test("formats remaining hourly and weekly Codex usage", () => {
  assert.equal(formatCodexUsage({
    rate_limit: {
      primary_window: { used_percent: 25, limit_window_seconds: 18_000 },
      secondary_window: { used_percent: "80", limit_window_seconds: 604_800 },
    },
  }), "5h:75% wk:20%");
  assert.equal(formatCodexUsage({
    rate_limit: { primary_window: { used_percent: 120 } },
  }), "5h:0%");
  assert.equal(formatCodexUsage({}), undefined);

  assert.deepEqual(
    [100, 80, 79, 60, 59, 40, 39, 20, 19, 0].map(usageColor),
    ["success", "success", "syntaxType", "syntaxType", "warning", "warning", "thinkingHigh", "thinkingHigh", "error", "error"],
  );
});
