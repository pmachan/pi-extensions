import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { CustomEditor, type ExtensionAPI, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type EditorTheme,
  type OverlayHandle,
  type TUI,
} from "@earendil-works/pi-tui";
import { renderCavemanIndicator } from "./caveman.ts";

type PromptState = {
  text: string;
  showContextWindow: boolean;
};

type FooterDataLike = {
  getGitBranch?: () => string | null;
  onBranchChange?: (listener: () => void) => (() => void) | void;
};

const state: PromptState = {
  text: "",
  showContextWindow: false,
};

let promptOverlayHandle: OverlayHandle | undefined;
let footerDataRef: FooterDataLike | undefined;
let activeTui: TUI | undefined;
let activeCtx: any;
let gitWorktreeLabel: string | null = null;
let gitWorktreeCwd: string | undefined;
let getThinkingLevelRef: (() => string) | undefined;
let lastTokensPerSecond: number | null = null;
let messageStartTime: number | null = null;
let showTokensPerSecond = true;

function clearPromptOverlay(): void {
  promptOverlayHandle?.hide();
  promptOverlayHandle = undefined;
}

function writeTerminal(data: string): void {
  if (activeTui) {
    activeTui.terminal.write(data);
    return;
  }
  if (process.stdout.isTTY) process.stdout.write(data);
}

function setMouseReporting(enabled: boolean): void {
  writeTerminal(enabled ? "\x1b[?1000h\x1b[?1006h" : "\x1b[?1000l\x1b[?1006l");
}

function toggleContextWindow(): void {
  state.showContextWindow = !state.showContextWindow;
  activeTui?.requestRender();
}

function resolveGitWorktreeLabel(cwd: string): string | null {
  let dir = cwd;

  while (true) {
    const gitPath = join(dir, ".git");
    if (existsSync(gitPath)) {
      try {
        const gitStat = statSync(gitPath);
        if (gitStat.isDirectory()) return "primary";

        if (gitStat.isFile()) {
          const content = readFileSync(gitPath, "utf8").trim();
          if (!content.startsWith("gitdir: ")) return null;

          const gitDir = resolve(dir, content.slice(8).trim());
          return basename(dirname(gitDir)) === "worktrees" ? basename(gitDir) : "primary";
        }
      } catch {
        return null;
      }

      return null;
    }

    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function refreshGitWorktreeLabel(cwd: string | undefined, force = false): void {
  if (!force && gitWorktreeCwd === cwd) return;
  gitWorktreeCwd = cwd;
  gitWorktreeLabel = cwd ? resolveGitWorktreeLabel(cwd) : null;
}

function formatCompactNumber(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return "–";
  if (value < 1000) return `${value}`;
  if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
  return `${Math.round(value / 1000)}k`;
}

function joinLeftRight(left: string, right: string, width: number): string {
  const rightWidth = visibleWidth(right);
  if (rightWidth >= width) return truncateToWidth(right, width);

  const leftWidth = visibleWidth(left);
  const gap = width - leftWidth - rightWidth;
  if (gap >= 1) return left + " ".repeat(gap) + right;

  const leftAvailable = Math.max(0, width - rightWidth - 1);
  const truncatedLeft = truncateToWidth(left, leftAvailable, "");
  const finalGap = Math.max(1, width - visibleWidth(truncatedLeft) - rightWidth);
  return truncatedLeft + " ".repeat(finalGap) + right;
}

function isSubscriptionProvider(context: any): boolean {
  const model = context?.model;
  if (!model) return false;
  return !!context?.modelRegistry?.isUsingOAuth?.(model);
}

function getThinkingLevel(): string {
  return getThinkingLevelRef?.() ?? "off";
}

function renderThinkingLevel(theme: Theme, thinking: string): string {
  const label = thinking;
  switch (thinking) {
    case "minimal":
      return theme.fg("thinkingMinimal", label);
    case "low":
      return theme.fg("thinkingLow", label);
    case "medium":
      return theme.fg("thinkingMedium", label);
    case "high":
      return theme.fg("thinkingHigh", label);
    case "xhigh":
      return theme.fg("thinkingXhigh", label);
    default:
      return theme.fg("thinkingOff", "thinking:off");
  }
}

function getFooterRenderData(ctx: any, theme: Theme): { left: string; usageText: string; right: string } {
  const context = ctx ?? activeCtx;
  refreshGitWorktreeLabel(context?.cwd);

  const modelName = context?.model?.name || context?.model?.id || "no model";
  const provider = context?.model?.provider ? `${context.model.provider}` : "offline";
  const providerLabel = isSubscriptionProvider(context) ? `${provider} (sub)` : provider;
  const thinking = getThinkingLevel();
  const branch = footerDataRef?.getGitBranch?.() || "no-git";
  const worktreeSuffix = branch === "no-git" ? "" : ` (${gitWorktreeLabel ?? "primary"})`;
  const usage = context?.getContextUsage?.();
  const cavemanIndicator = renderCavemanIndicator(context ?? activeCtx, theme);

  let tokensIn = 0;
  let tokensOut = 0;
  let cost = 0;
  for (const entry of context?.sessionManager?.getBranch?.() ?? []) {
    if (entry.type === "message" && entry.message.role === "assistant") {
      const usage = (entry.message as AssistantMessage).usage;
      tokensIn += usage?.input ?? 0;
      tokensOut += usage?.output ?? 0;
      cost += usage?.cost?.total ?? 0;
    }
  }

  const modelProvider = theme.fg("text", modelName) + theme.fg("muted", ` ${providerLabel}`);
  const left = [
    cavemanIndicator,
    modelProvider,
    renderThinkingLevel(theme, thinking),
    theme.fg("muted", ` ${branch}${worktreeSuffix}`),
  ].filter(Boolean).join("  ");

  const contextWindowText = state.showContextWindow && usage?.contextWindow ? `/${formatCompactNumber(usage.contextWindow)}` : "";
  const usageText = usage?.tokens == null
    ? theme.fg("dim", `◇ --${contextWindowText}`)
    : theme.fg("success", "◆") + theme.fg("muted", ` ${formatCompactNumber(usage.tokens)}${contextWindowText}${usage?.percent != null ? ` (${usage.percent.toFixed(0)}%)` : ""}`);
  const tokensInOut = (tokensIn > 0 || tokensOut > 0)
    ? theme.fg("muted", `  ↑${formatCompactNumber(tokensIn)} ↓${formatCompactNumber(tokensOut)}`)
    : "";
  const tpsText = showTokensPerSecond && lastTokensPerSecond != null
    ? theme.fg("text", `  ${lastTokensPerSecond.toFixed(1)} t/s`)
    : "";
  const costText = cost > 0 ? theme.fg("dim", `  $${cost.toFixed(2)}`) : "";
  const right = usageText + tokensInOut + tpsText + costText;

  return { left, usageText, right };
}

function renderFooterLine(ctx: any, theme: Theme, width: number): string {
  const { left, right } = getFooterRenderData(ctx, theme);
  return joinLeftRight(left, right, width);
}

class HelixPromptEditor extends CustomEditor {
  constructor(
    tui: TUI,
    editorTheme: EditorTheme,
    keybindings: KeybindingsManager,
    private promptState: PromptState,
  ) {
    super(tui, editorTheme, keybindings);
    this.syncState();
  }

  override invalidate(): void {
    super.invalidate();
  }

  private syncState(): void {
    this.promptState.text = this.getText();
  }

  renderVisible(width: number): string[] {
    // Keep prompt state in sync with async editor updates (e.g. autocomplete
    // acceptance) and render fresh every time. Tab-triggered completion updates
    // happen after handleInput returns, so caching here can leave the prompt stuck.
    this.syncState();
    return super.render(width);
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      const wasBusy = activeCtx?.isIdle ? !activeCtx.isIdle() : false;
      super.handleInput(data);
      this.syncState();
      if (wasBusy) activeTui?.setFocus(this);
      activeTui?.requestRender();
      return;
    }

    super.handleInput(data);
    this.syncState();
  }

  render(width: number): string[] {
    return this.renderVisible(width).map(() => "");
  }
}

class FixedPromptOverlay implements Component {
  constructor(
    private editor: HelixPromptEditor,
    private getTheme: () => Theme,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const theme = this.getTheme();
    return [
      ...this.editor.renderVisible(width),
      renderFooterLine(activeCtx, theme, width),
    ];
  }
}

function enableHelixPrompt(ctx: any): void {
  if (!ctx.hasUI) return;

  activeCtx = ctx;
  footerDataRef = undefined;
  refreshGitWorktreeLabel(ctx.cwd, true);

  ctx.ui.setEditorComponent((tui: TUI, editorTheme: EditorTheme, keybindings: KeybindingsManager) => {
    activeTui = tui;
    clearPromptOverlay();
    // Keep terminal-native mouse behavior intact so text selection and scroll work.
    setMouseReporting(false);

    const editor = new HelixPromptEditor(tui, editorTheme, keybindings, state);
    promptOverlayHandle = tui.showOverlay(new FixedPromptOverlay(editor, () => ctx.ui.theme), {
      width: "100%",
      anchor: "bottom-left",
      nonCapturing: true,
    });

    return editor;
  });

  ctx.ui.setWidget(
    "helix-prompt-shortcuts",
    () => ({
      invalidate() {},
      render(): string[] {
        return [""];
      },
    }),
    { placement: "belowEditor" },
  );

  ctx.ui.setFooter((tui: TUI, _theme: Theme, footerData: any) => {
    footerDataRef = footerData;
    const unsub = footerData.onBranchChange?.(() => {
      refreshGitWorktreeLabel(ctx.cwd, true);
      tui.requestRender();
    });

    return {
      dispose() {
        if (footerDataRef === footerData) footerDataRef = undefined;
        unsub?.();
      },
      invalidate() {},
      render(): string[] {
        return [""];
      },
    };
  });
}



export default function promptBar(pi: ExtensionAPI) {
  getThinkingLevelRef = () => pi.getThinkingLevel();

  pi.on("session_shutdown", () => {
    clearPromptOverlay();
    setMouseReporting(false);
    footerDataRef = undefined;
    activeCtx = undefined;
    gitWorktreeLabel = null;
    gitWorktreeCwd = undefined;
  });

  pi.on("session_start", (_event, ctx) => {
    enableHelixPrompt(ctx);
  });

  pi.on("message_start", (event) => {
    if (event.message.role === "assistant") {
      messageStartTime = Date.now();
    }
  });

  pi.on("message_end", (event) => {
    if (event.message.role === "assistant" && messageStartTime != null) {
      const msg = event.message as AssistantMessage;
      const hasTextContent = msg.content?.some((block: any) => block.type === "text" && block.text?.trim());
      const elapsed = (Date.now() - messageStartTime) / 1000;
      const output = msg.usage?.output ?? 0;
      if (elapsed > 0 && output > 0 && hasTextContent) {
        lastTokensPerSecond = output / elapsed;
      }
      messageStartTime = null;
      activeTui?.requestRender();
    }
  });

  pi.on("model_select", (_event, ctx) => {
    if (!ctx.hasUI) return;
    activeCtx = ctx;
    activeTui?.requestRender();
  });

  pi.registerShortcut("alt+c", {
    description: "Toggle prompt bar context window",
    handler: () => {
      toggleContextWindow();
    },
  });

  pi.registerShortcut("alt+s", {
    description: "Toggle tokens/second display",
    handler: () => {
      showTokensPerSecond = !showTokensPerSecond;
      activeTui?.requestRender();
    },
  });

}
