import type { Theme } from "@earendil-works/pi-coding-agent";

export type CavemanLevel = "off" | "lite" | "full" | "ultra" | "micro";
export type ActiveCavemanLevel = Exclude<CavemanLevel, "off">;

export const CAVEMAN_ICON = "🪨";
export const CAVEMAN_PRESENCE_ENTRY = "caveman-installed";
export const CAVEMAN_LEVEL_ENTRY = "caveman-level";
export const CAVEMAN_ACTIVE_LEVELS = new Set<ActiveCavemanLevel>(["lite", "full", "ultra", "micro"]);

export function isActiveCavemanLevel(level: CavemanLevel | null): level is ActiveCavemanLevel {
  return level !== null && CAVEMAN_ACTIVE_LEVELS.has(level as ActiveCavemanLevel);
}

export function getCavemanPromptState(context: any): { activeLevel: ActiveCavemanLevel | null } {
  let level: CavemanLevel | null = null;

  for (const entry of context?.sessionManager?.getEntries?.() ?? []) {
    if (entry.type !== "custom") continue;
    if (entry.customType === CAVEMAN_PRESENCE_ENTRY) continue;
    if (entry.customType !== CAVEMAN_LEVEL_ENTRY) continue;
    const persistedLevel = (entry.data as { level?: unknown })?.level;
    if (persistedLevel === "off" || persistedLevel === "lite" || persistedLevel === "full" || persistedLevel === "ultra" || persistedLevel === "micro") {
      level = persistedLevel;
    }
  }

  return { activeLevel: isActiveCavemanLevel(level) ? level : null };
}

export function renderCavemanIndicator(context: any, theme: Theme): string | null {
  const caveman = getCavemanPromptState(context);
  if (caveman.activeLevel == null) return null;
  return theme.fg("warning", `${CAVEMAN_ICON} ${caveman.activeLevel.toUpperCase()}`);
}
