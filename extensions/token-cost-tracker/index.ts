import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

type TokenCostEntry = {
  ts: string;
  sessionFile?: string;
  provider?: string;
  model?: string;
  thinkingLevel?: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
  inputCost?: number;
  outputCost?: number;
  cacheReadCost?: number;
  cacheWriteCost?: number;
  inputPricePerM?: number;
  outputPricePerM?: number;
  cacheReadPricePerM?: number;
  cacheWritePricePerM?: number;
};

const LOG_PATH = process.env.PI_TOKEN_COST_LOG ?? join(homedir(), ".pi", "token-cost.jsonl");

function ensureLogDir() {
  mkdirSync(dirname(LOG_PATH), { recursive: true });
}

function readEntries(): TokenCostEntry[] {
  if (!existsSync(LOG_PATH)) return [];
  return readFileSync(LOG_PATH, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as TokenCostEntry];
      } catch {
        return [];
      }
    });
}

function summarize(entries: TokenCostEntry[]) {
  return entries.reduce(
    (acc, e) => {
      acc.input += e.input || 0;
      acc.output += e.output || 0;
      acc.cacheRead += e.cacheRead || 0;
      acc.cacheWrite += e.cacheWrite || 0;
      acc.totalTokens += e.totalTokens || 0;
      acc.cost += e.cost || 0;
      acc.inputCost += e.inputCost ?? priceToCost(e.input, e.inputPricePerM) ?? 0;
      acc.outputCost += e.outputCost ?? priceToCost(e.output, e.outputPricePerM) ?? 0;
      acc.cacheReadCost += e.cacheReadCost ?? priceToCost(e.cacheRead, e.cacheReadPricePerM) ?? 0;
      acc.cacheWriteCost += e.cacheWriteCost ?? priceToCost(e.cacheWrite, e.cacheWritePricePerM) ?? 0;
      acc.inputPriceWeighted += (e.inputPricePerM ?? 0) * (e.input || 0);
      acc.outputPriceWeighted += (e.outputPricePerM ?? 0) * (e.output || 0);
      acc.cacheReadPriceWeighted += (e.cacheReadPricePerM ?? 0) * (e.cacheRead || 0);
      acc.cacheWritePriceWeighted += (e.cacheWritePricePerM ?? 0) * (e.cacheWrite || 0);
      acc.inputPriceTokens += e.inputPricePerM == null ? 0 : e.input || 0;
      acc.outputPriceTokens += e.outputPricePerM == null ? 0 : e.output || 0;
      acc.cacheReadPriceTokens += e.cacheReadPricePerM == null ? 0 : e.cacheRead || 0;
      acc.cacheWritePriceTokens += e.cacheWritePricePerM == null ? 0 : e.cacheWrite || 0;
      return acc;
    },
    {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: 0,
      inputCost: 0,
      outputCost: 0,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      inputPriceWeighted: 0,
      outputPriceWeighted: 0,
      cacheReadPriceWeighted: 0,
      cacheWritePriceWeighted: 0,
      inputPriceTokens: 0,
      outputPriceTokens: 0,
      cacheReadPriceTokens: 0,
      cacheWritePriceTokens: 0,
    },
  );
}

function groupEntries(entries: TokenCostEntry[], keyFn: (entry: TokenCostEntry) => string) {
  const groups = new Map<string, TokenCostEntry[]>();
  for (const e of entries) {
    const key = keyFn(e);
    groups.set(key, [...(groups.get(key) || []), e]);
  }
  return groups;
}

function summarizeByModel(entries: TokenCostEntry[]) {
  const byModel = groupEntries(entries, (e) => `${e.provider || "unknown"}/${e.model || "unknown"}`);

  return [...byModel.entries()]
    .map(([model, rows]) => ({ model, responses: rows.length, entries: rows, ...summarize(rows) }))
    .sort((a, b) => b.cost - a.cost);
}

function summarizeByThinking(entries: TokenCostEntry[]) {
  const order = ["off", "minimal", "low", "medium", "high", "xhigh", "unknown"];
  const byThinking = groupEntries(entries, (e) => e.thinkingLevel || "unknown");

  return [...byThinking.entries()]
    .map(([thinking, rows]) => ({ thinking, responses: rows.length, ...summarize(rows) }))
    .sort((a, b) => {
      const ai = order.indexOf(a.thinking);
      const bi = order.indexOf(b.thinking);
      if (ai !== bi) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
      return b.cost - a.cost;
    });
}

function fmtTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

function priceToCost(tokens: number, pricePerM?: number) {
  return pricePerM == null ? undefined : (tokens * pricePerM) / 1_000_000;
}

function fmtPrice(cost: number, tokens: number, fallbackPricePerM?: number) {
  // Prefer effective price from actual recorded cost. This handles tiered/long-context
  // pricing when the provider/pi reports split costs. Fall back to configured model
  // list price only when no actual split cost is available.
  if (tokens && cost) return `$${((cost / tokens) * 1_000_000).toFixed(2)}`;
  if (fallbackPricePerM != null) return `$${fallbackPricePerM.toFixed(2)}`;
  return "n/a";
}

function pad(value: string, width: number, align: "left" | "right" = "left") {
  const s = value.length > width ? `${value.slice(0, Math.max(0, width - 1))}…` : value;
  const spaces = " ".repeat(Math.max(0, width - s.length));
  return align === "right" ? spaces + s : s + spaces;
}

function tableRow(label: string, responses: number, stats: ReturnType<typeof summarize>) {
  const inputPricePerM = stats.inputPriceTokens ? stats.inputPriceWeighted / stats.inputPriceTokens : undefined;
  const outputPricePerM = stats.outputPriceTokens ? stats.outputPriceWeighted / stats.outputPriceTokens : undefined;
  const cacheReadPricePerM = stats.cacheReadPriceTokens
    ? stats.cacheReadPriceWeighted / stats.cacheReadPriceTokens
    : undefined;
  const cacheWritePricePerM = stats.cacheWritePriceTokens
    ? stats.cacheWritePriceWeighted / stats.cacheWritePriceTokens
    : undefined;
  return `${pad(label, 36)} ${pad(String(responses), 5, "right")} ${pad(fmtTokens(stats.input), 8, "right")} ${pad(fmtTokens(stats.cacheRead), 8, "right")} ${pad(fmtTokens(stats.cacheWrite), 8, "right")} ${pad(fmtTokens(stats.output), 8, "right")} ${pad(fmtPrice(stats.inputCost, stats.input, inputPricePerM), 9, "right")} ${pad(fmtPrice(stats.cacheReadCost, stats.cacheRead, cacheReadPricePerM), 9, "right")} ${pad(fmtPrice(stats.cacheWriteCost, stats.cacheWrite, cacheWritePricePerM), 9, "right")} ${pad(fmtPrice(stats.outputCost, stats.output, outputPricePerM), 10, "right")} ${pad(`$${stats.cost.toFixed(4)}`, 9, "right")}`;
}

function modelTable(entries: TokenCostEntry[]) {
  const rows = summarizeByModel(entries);
  const header = `${pad("model / thinking", 36)} ${pad("resp", 5, "right")} ${pad("in", 8, "right")} ${pad("c-r", 8, "right")} ${pad("c-w", 8, "right")} ${pad("out", 8, "right")} ${pad("$/1M in", 9, "right")} ${pad("$/1M c-r", 9, "right")} ${pad("$/1M c-w", 9, "right")} ${pad("$/1M out", 10, "right")} ${pad("cost", 9, "right")}`;
  const sep = "─".repeat(header.length);
  const lines = [header, sep];

  for (const r of rows) {
    lines.push(tableRow(r.model, r.responses, r));
    for (const t of summarizeByThinking(r.entries)) {
      lines.push(tableRow(`  └ ${t.thinking}`, t.responses, t));
    }
  }

  return lines.join("\n");
}

function startOfDay(d = new Date()) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function startOfMonth(d = new Date()) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

export default function (pi: ExtensionAPI) {
  ensureLogDir();

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setStatus("token-cost", `cost log: ${LOG_PATH}`);
  });

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;

    const m = event.message as AssistantMessage;
    if (!m.usage) return;

    const cost = (m.usage as any).cost ?? {};
    const modelCost = (ctx.model as any)?.cost ?? {};
    const input = m.usage.input ?? 0;
    const output = m.usage.output ?? 0;
    const cacheRead = m.usage.cacheRead ?? 0;
    const cacheWrite = m.usage.cacheWrite ?? 0;
    const inputCost = cost.input ?? priceToCost(input, modelCost.input) ?? 0;
    const outputCost = cost.output ?? priceToCost(output, modelCost.output) ?? 0;
    const cacheReadCost = cost.cacheRead ?? priceToCost(cacheRead, modelCost.cacheRead) ?? 0;
    const cacheWriteCost = cost.cacheWrite ?? priceToCost(cacheWrite, modelCost.cacheWrite) ?? 0;
    const entry: TokenCostEntry = {
      ts: new Date().toISOString(),
      sessionFile: ctx.sessionManager.getSessionFile() ?? undefined,
      provider: m.provider,
      model: m.model,
      thinkingLevel: pi.getThinkingLevel(),
      input,
      output,
      cacheRead,
      cacheWrite,
      totalTokens: m.usage.totalTokens ?? input + output + cacheRead + cacheWrite,
      cost: cost.total ?? inputCost + outputCost + cacheReadCost + cacheWriteCost,
      inputCost,
      outputCost,
      cacheReadCost,
      cacheWriteCost,
      inputPricePerM: modelCost.input,
      outputPricePerM: modelCost.output,
      cacheReadPricePerM: modelCost.cacheRead,
      cacheWritePricePerM: modelCost.cacheWrite,
    };

    appendFileSync(LOG_PATH, `${JSON.stringify(entry)}\n`);
    ctx.ui.setStatus("token-cost", `tokens ${fmtTokens(entry.totalTokens)} $${entry.cost.toFixed(4)}`);
  });

  pi.registerCommand("token-cost", {
    description: "Show persisted token/cost totals: /token-cost [today|month|all|path]",
    handler: async (args, ctx) => {
      const scope = (args || "month").trim().toLowerCase();
      if (scope === "path") {
        ctx.ui.notify(LOG_PATH, "info");
        return;
      }

      const now = new Date();
      const since = scope === "today" ? startOfDay(now) : scope === "all" ? undefined : startOfMonth(now);
      const entries = readEntries().filter((e) => !since || new Date(e.ts) >= since);
      const s = summarize(entries);

      ctx.ui.notify(
        `Token cost (${scope || "month"}): ${entries.length} responses, ` +
          `↑${fmtTokens(s.input)} c-r ${fmtTokens(s.cacheRead)} c-w ${fmtTokens(s.cacheWrite)} ↓${fmtTokens(s.output)}, ` +
          `${fmtTokens(s.totalTokens)} tokens, $${s.cost.toFixed(4)}\n\n` +
          `${modelTable(entries)}\n\nlog: ${LOG_PATH}`,
        "info",
      );
    },
  });
}
