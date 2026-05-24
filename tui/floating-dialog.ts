/**
 * FloatingDialog — reusable centered overlay component for pi extensions.
 *
 * Usage:
 *   import { showFloatingDialog } from "../../tui/floating-dialog";
 *
 *   const result = await showFloatingDialog(ctx, {
 *     title: "Model Scope",
 *     width: "60%",
 *     maxHeight: "80%",
 *     render: (width, theme) => [...lines],
 *     onInput: (data, close) => { ... },
 *   });
 */

import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, OverlayHandle, OverlayOptions, SizeValue, TUI } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Apply background color to a line, padding to full width. */
function applyBgToLine(line: string, width: number, bgFn: (text: string) => string): string {
  const pad = Math.max(0, width - visibleWidth(line));
  return bgFn(line + " ".repeat(pad));
}

export interface FloatingDialogOptions<T = void> {
  /** Dialog title shown in top border */
  title?: string;

  /** Width — number (cols) or percentage string like "60%" */
  width?: SizeValue;

  /** Min width in columns */
  minWidth?: number;

  /** Max height — number (rows) or percentage string like "80%" */
  maxHeight?: SizeValue;

  /** Help text shown at bottom (e.g. keybinding hints) */
  helpText?: string;

  /** Render content lines. Return array of strings fitting within `innerWidth`. */
  render: (innerWidth: number, theme: Theme) => string[];

  /** Handle keyboard input. Call `close(result)` to dismiss dialog. */
  onInput?: (data: string, close: (result: T) => void, tui: TUI) => void;

  /** Called on mount with tui ref for requestRender() */
  onMount?: (tui: TUI) => void;

  /** Called on dispose */
  onDispose?: () => void;

  /** Show fullscreen backdrop behind dialog (default: false) */
  backdrop?: boolean;

  /** Additional overlay options (anchor defaults to "center") */
  overlayOptions?: Partial<OverlayOptions>;
}

class FloatingDialogBackdrop implements Component {
  constructor(private tui: TUI, private theme: Theme) {}

  invalidate(): void {}

  render(width: number): string[] {
    const rows = Math.max(1, this.tui.terminal.rows);
    const line = this.theme.bg("toolPendingBg", " ".repeat(Math.max(1, width)));
    return Array.from({ length: rows }, () => line);
  }
}

export class FloatingDialog<T = void> implements Component {
  private opts: FloatingDialogOptions<T>;
  private theme: Theme;
  private tui: TUI;
  private done: (result: T) => void;
  private cachedWidth?: number;
  private cachedLines?: string[];

  private escArmedUntil: number = 0;
  private escTimer: NodeJS.Timeout | null = null;
  private backdropHandle?: OverlayHandle;

  constructor(tui: TUI, theme: Theme, done: (result: T) => void, opts: FloatingDialogOptions<T>) {
    this.tui = tui;
    this.theme = theme;
    this.done = done;
    this.opts = opts;
    if (opts.backdrop === true) {
      this.backdropHandle = tui.showOverlay(new FloatingDialogBackdrop(tui, theme), {
        anchor: "top-left",
        width: "100%",
        maxHeight: "100%",
        nonCapturing: true,
      });
    }
    opts.onMount?.(tui);
  }

  private armEsc(): void {
    this.escArmedUntil = Date.now() + 1500;
    if (this.escTimer) clearTimeout(this.escTimer);
    this.escTimer = setTimeout(() => {
      this.escArmedUntil = 0;
      this.invalidate();
      this.tui.requestRender();
    }, 1500);
  }

  private isEscArmed(): boolean {
    return Date.now() <= this.escArmedUntil;
  }

  handleInput(data: string): void {
    // Any non-ESC key cancels pending ESC close
    if (!matchesKey(data, "escape") && this.isEscArmed()) {
      this.escArmedUntil = 0;
      if (this.escTimer) clearTimeout(this.escTimer);
      this.escTimer = null;
      this.invalidate();
    }

    // Double-ESC to close (visual arm indicator in title)
    if (matchesKey(data, "escape")) {
      if (this.isEscArmed()) {
        this.done(undefined as T);
        return;
      }
      // Arm ESC, but still forward key to onInput so dialogs can use ESC for UX (e.g. clear search)
      this.armEsc();
      this.opts.onInput?.(data, (result) => this.done(result), this.tui);
      this.invalidate();
      this.tui.requestRender();
      return;
    }

    if (this.opts.onInput) {
      this.opts.onInput(data, (result) => this.done(result), this.tui);
    } else {
      // Default: Ctrl+C closes
      if (matchesKey(data, "ctrl+c")) {
        this.done(undefined as T);
      }
    }

    // Always invalidate cache after input — state may have changed
    this.invalidate();
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const th = this.theme;
    const innerW = Math.max(1, width - 2);
    const lines: string[] = [];
    const bgFn = (text: string) => th.bg("toolPendingBg", text);

    // ─── Top border with title (center) and ESC X (right) ───
    const titleStr = this.opts.title ? ` ${this.opts.title} ` : "";
    const escStr = " ESC ";
    const escStyled = this.isEscArmed() ? th.fg("accent", escStr) : th.fg("dim", escStr);
    const titleW = visibleWidth(titleStr);
    const escW = visibleWidth(escStr);
    const leftPad = Math.floor((innerW - titleW) / 2);
    const rightFill = Math.max(0, innerW - titleW - leftPad);
    // Place ESC indicator at end of right fill, overlapping dashes
    const rightDashes = Math.max(0, rightFill - escW);
    lines.push(
      applyBgToLine(
        th.fg("border", "╭" + "─".repeat(leftPad)) +
          th.fg("accent", titleStr) +
          th.fg("border", "─".repeat(rightDashes)) +
          escStyled +
          th.fg("border", "╮"),
        width,
        bgFn,
      ),
    );

    // ─── Content ───
    const contentLines = this.opts.render(innerW - 2, th); // -2 for 1ch padding each side
    for (const line of contentLines) {
      const padded = ` ${line}`;
      lines.push(
        applyBgToLine(
          th.fg("border", "│") +
            truncateToWidth(padded, innerW, "…", true) +
            th.fg("border", "│"),
          width,
          bgFn,
        ),
      );
    }

    // ─── Help text ───
    if (this.opts.helpText) {
      lines.push(
        applyBgToLine(
          th.fg("border", "├" + "─".repeat(innerW) + "┤"),
          width,
          bgFn,
        ),
      );
      const helpPadded = ` ${th.fg("dim", this.opts.helpText)}`;
      lines.push(
        applyBgToLine(
          th.fg("border", "│") +
            truncateToWidth(helpPadded, innerW, "…", true) +
            th.fg("border", "│"),
          width,
          bgFn,
        ),
      );
    }

    // ─── Bottom border ───
    lines.push(applyBgToLine(th.fg("border", "╰" + "─".repeat(innerW) + "╯"), width, bgFn));

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  dispose(): void {
    if (this.escTimer) clearTimeout(this.escTimer);
    this.escTimer = null;
    this.backdropHandle?.hide();
    this.backdropHandle = undefined;
    this.opts.onDispose?.();
  }
}

/**
 * Show a centered floating dialog. Returns result when closed.
 *
 * @example
 * ```ts
 * const picked = await showFloatingDialog<string | null>(ctx, {
 *   title: "Pick Something",
 *   width: "50%",
 *   helpText: "↑↓ navigate • enter select • esc cancel",
 *   render: (w, theme) => items.map((it, i) =>
 *     i === selected ? theme.fg("accent", `> ${it}`) : `  ${it}`
 *   ),
 *   onInput: (data, close, tui) => {
 *     if (matchesKey(data, "escape")) close(null);
 *     if (matchesKey(data, "enter")) close(items[selected]);
 *     tui.requestRender();
 *   },
 * });
 * ```
 */
export async function showFloatingDialog<T = void>(
  ctx: ExtensionCommandContext,
  opts: FloatingDialogOptions<T>,
): Promise<T> {
  return ctx.ui.custom<T>(
    (tui, theme, _kb, done) => new FloatingDialog<T>(tui, theme, done, opts),
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: opts.width ?? "60%",
        minWidth: opts.minWidth ?? 40,
        maxHeight: opts.maxHeight ?? "80%",
        ...opts.overlayOptions,
      },
    },
  );
}
