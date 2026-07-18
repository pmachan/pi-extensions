import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const PROVIDER = "openai-codex";
const STATUS_KEY = "codex-usage";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const REFRESH_MS = 5 * 60 * 1000;
const WEEK_SECONDS = 7 * 24 * 60 * 60;

type JsonObject = Record<string, unknown>;

export default function codexUsage(pi: ExtensionAPI) {
  let lastRefresh = 0;
  let requestId = 0;

  const clear = (ctx: ExtensionContext) => {
    requestId++;
    ctx.ui.setStatus(STATUS_KEY, undefined);
  };

  const refresh = async (ctx: ExtensionContext, force = false) => {
    const model = ctx.model;
    if (model?.provider !== PROVIDER) {
      clear(ctx);
      return;
    }
    if (!force && Date.now() - lastRefresh < REFRESH_MS) return;

    const currentRequest = ++requestId;
    try {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) throw new Error(auth.error);

      const headers = new Headers(auth.headers);
      if (!headers.has("authorization") && auth.apiKey) {
        headers.set("authorization", `Bearer ${auth.apiKey}`);
      }
      if (!headers.has("user-agent")) headers.set("user-agent", "pi-codex-usage");

      const response = await fetch(USAGE_URL, {
        headers,
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`Codex usage request failed: ${response.status}`);

      const status = formatCodexUsage(await response.json(), (label, remaining) =>
        ctx.ui.theme.fg("muted", `${label}:`) +
        ctx.ui.theme.fg(usageColor(remaining), `${remaining}%`)
      );
      if (!status) throw new Error("Codex usage response contained no rate limits");
      if (currentRequest !== requestId) return;

      lastRefresh = Date.now();
      ctx.ui.setStatus(STATUS_KEY, status);
    } catch {
      if (currentRequest === requestId) ctx.ui.setStatus(STATUS_KEY, undefined);
    }
  };

  pi.on("session_start", (_event, ctx) => void refresh(ctx, true));
  pi.on("model_select", (_event, ctx) => void refresh(ctx, true));
  pi.on("message_end", (event, ctx) => {
    if (event.message.role === "assistant") void refresh(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => clear(ctx));
}

export function formatCodexUsage(
  payload: unknown,
  style: (label: string, remaining: number) => string = (label, remaining) => `${label}:${remaining}%`,
): string | undefined {
  const limits = asObject(asObject(payload)?.rate_limit);
  if (!limits) return undefined;

  const values = [
    formatWindow(limits.primary_window, "5h", style),
    formatWindow(limits.secondary_window, "wk", style),
  ].filter((value): value is string => Boolean(value));

  return values.length ? values.join(" ") : undefined;
}

export function usageColor(remaining: number): "success" | "syntaxType" | "warning" | "thinkingHigh" | "error" {
  if (remaining >= 80) return "success";
  if (remaining >= 60) return "syntaxType";
  if (remaining >= 40) return "warning";
  if (remaining >= 20) return "thinkingHigh";
  return "error";
}

function formatWindow(
  value: unknown,
  fallbackLabel: string,
  style: (label: string, remaining: number) => string,
): string | undefined {
  const window = asObject(value);
  const used = asNumber(window?.used_percent);
  if (used === undefined) return undefined;

  const seconds = asNumber(window?.limit_window_seconds);
  const label = seconds && seconds >= WEEK_SECONDS
    ? seconds === WEEK_SECONDS ? "wk" : `${Math.round(seconds / WEEK_SECONDS)}w`
    : seconds && seconds >= 3600 ? `${Math.round(seconds / 3600)}h`
    : fallbackLabel;
  const remaining = Math.round(100 - Math.min(100, Math.max(0, used)));
  return style(label, remaining);
}

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function asNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) ? number : undefined;
}
