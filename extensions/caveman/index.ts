/**
 * pi-caveman — why use many token when few do trick
 *
 * Copied from https://github.com/jonjonrankin/pi-caveman/blob/main/extensions/caveman.ts
 * for local use without external package install.
 *
 * Wenyan options removed. I dont need them.
 *
 * Commands:
 *   /caveman [level]  Toggle caveman mode or set intensity
 *   /caveman stop     Disable caveman mode (aliases: off, quit)
 *   /caveman config   Open settings dialog (default level, status bar toggle)
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";

const LEVELS = ["off", "lite", "full", "ultra", "micro"] as const;
const STOP_ALIASES = new Set(["off", "stop", "quit"]);
type Level = (typeof LEVELS)[number];

function isLevel(value: unknown): value is Level {
	return typeof value === "string" && LEVELS.includes(value as Level);
}

const CAVEMAN_COMMAND_OPTIONS = [
	{ value: "lite", label: "lite", description: "Professional, no fluff" },
	{ value: "full", label: "full", description: "Classic caveman" },
	{ value: "ultra", label: "ultra", description: "Maximum compression" },
	{ value: "micro", label: "micro", description: "Experimental prompt-minimized mode" },
	{ value: "off", label: "off", description: "Disable caveman mode" },
	{ value: "stop", label: "stop", description: "Disable caveman mode" },
	{ value: "quit", label: "quit", description: "Disable caveman mode" },
	{ value: "config", label: "config", description: "Open settings dialog" },
] as const;

interface CavemanConfig {
	defaultLevel: Level;
	showStatus: boolean;
}

const CONFIG_PATH = join(homedir(), ".pi", "agent", "caveman.json");
const DEFAULT_CONFIG: CavemanConfig = { defaultLevel: "full", showStatus: true };
let saveConfigQueue: Promise<void> = Promise.resolve();

async function loadConfig(): Promise<CavemanConfig> {
	try {
		const raw = await readFile(CONFIG_PATH, "utf8");
		const parsed = JSON.parse(raw);
		return {
			defaultLevel: isLevel(parsed.defaultLevel) ? parsed.defaultLevel : DEFAULT_CONFIG.defaultLevel,
			showStatus: typeof parsed.showStatus === "boolean" ? parsed.showStatus : DEFAULT_CONFIG.showStatus,
		};
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

async function saveConfig(config: CavemanConfig): Promise<void> {
	const snapshot = JSON.stringify(config, null, 2) + "\n";
	saveConfigQueue = saveConfigQueue.then(async () => {
		await mkdir(join(homedir(), ".pi", "agent"), { recursive: true });
		await writeFile(CONFIG_PATH, snapshot, "utf8");
	});
	return saveConfigQueue;
}

const CAVEMAN_ICON = "🪨";

const BASE = `IMPORTANT: You are in CAVEMAN MODE. Respond terse like smart caveman. All technical substance stay. Only fluff die.

Rules:
- Drop articles (a/an/the), filler (just/really/basically/actually/simply), hedging
- Fragments OK. Short synonyms preferred. Technical terms exact
- Code blocks unchanged. Errors quoted exact
- Pattern: [thing] [action] [reason]. [next step].

Bad: "Sure! I'd be happy to help you with that. The issue you're experiencing is likely caused by..."
Good: "Bug in auth middleware. Token expiry check use \`<\` not \`<=\`. Fix:"`;

const MICRO_PROMPT = `# Token efficiency
Respond like smart caveman. Cut all filler, keep technical substance.
- Drop articles (a, an, the), filler (just, really, basically, actually).
- Drop pleasantries (sure, certainly, happy to).
- No hedging. Fragments fine. Short synonyms.
- Technical terms stay exact. Code blocks unchanged.
- Pattern: [thing] [action] [reason]. [next step].`;

const INTENSITY: Record<Exclude<Level, "off" | "micro">, string> = {
	lite: `No filler/hedging. Keep articles + full sentences. Professional but tight.
Example: "Your component re-renders because you create a new object reference each render. Wrap it in \`useMemo\`."`,

	full: `Drop articles, fragments OK, short synonyms.
Example: "New object ref each render. Inline object prop = new ref = re-render. Wrap in \`useMemo\`."`,

	ultra: `Abbreviate (DB/auth/config/req/res/fn/impl), strip conjunctions, arrows for causality (X → Y).
Example: "Inline obj prop → new ref → re-render. \`useMemo\`."`,
};

const SAFETY = `Auto-clarity: drop caveman for security warnings, irreversible action confirmations, or when user is confused. Resume after.
Boundaries: write normal code. Only compress explanations. "stop caveman" or "normal mode" reverts.`;

const CAVEMAN_PRESENCE_ENTRY = "caveman-installed";
const CAVEMAN_LEVEL_ENTRY = "caveman-level";

export default function caveman(pi: ExtensionAPI) {
	let level: Level = "off";
	let config: CavemanConfig = { ...DEFAULT_CONFIG };
	let configLoadPromise: Promise<void> | null = null;

	const ensureConfigLoaded = async () => {
		if (!configLoadPromise) {
			configLoadPromise = (async () => {
				config = await loadConfig();
				if (level === "off" && config.defaultLevel !== "off") {
					level = config.defaultLevel;
				}
			})();
		}
		await configLoadPromise;
	};

	function syncStatus(ctx: Pick<ExtensionContext, "ui">) {
		if (level === "off" || !config.showStatus) {
			ctx.ui.setStatus("caveman", undefined);
			return;
		}

		ctx.ui.setStatus("caveman", ctx.ui.theme.fg("warning", `${CAVEMAN_ICON} ${level.toUpperCase()}`));
	}

	pi.on("session_start", async (_event, ctx) => {
		await ensureConfigLoaded();

		let hasPresenceEntry = false;
		let sessionLevel: Level | null = null;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom") continue;
			if (entry.customType === CAVEMAN_PRESENCE_ENTRY) {
				hasPresenceEntry = true;
				continue;
			}
			if (entry.customType === CAVEMAN_LEVEL_ENTRY) {
				const persistedLevel = (entry.data as { level?: unknown })?.level;
				sessionLevel = isLevel(persistedLevel) ? persistedLevel : null;
			}
		}

		if (!hasPresenceEntry) {
			pi.appendEntry(CAVEMAN_PRESENCE_ENTRY, { installed: true });
		}

		if (sessionLevel !== null) {
			level = sessionLevel;
		} else if (config.defaultLevel !== "off") {
			level = config.defaultLevel;
			pi.appendEntry(CAVEMAN_LEVEL_ENTRY, { level });
		}

		syncStatus(ctx);
	});

	pi.registerCommand("caveman", {
		description: "Toggle caveman mode, set level, use stop/off/quit to disable, or 'config' to open settings",
		getArgumentCompletions: (prefix: string) => {
			const normalized = prefix.trim().toLowerCase();
			const items = CAVEMAN_COMMAND_OPTIONS.filter((item) => item.value.startsWith(normalized));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const arg = args?.trim().toLowerCase();

			if (arg === "config") {
				await openConfig(ctx);
				return;
			}

			if (!arg) {
				level = level === "off" ? "full" : "off";
			} else if (STOP_ALIASES.has(arg)) {
				level = "off";
			} else if (isLevel(arg)) {
				level = arg;
			} else {
				ctx.ui.notify(`Unknown: "${arg}". Use: ${LEVELS.join(", ")}, stop, quit, or config`, "error");
				return;
			}

			pi.appendEntry(CAVEMAN_LEVEL_ENTRY, { level });
			syncStatus(ctx);

			ctx.ui.notify(level === "off" ? "Caveman mode off." : `Caveman: ${level.toUpperCase()}`, "info");
		},
	});

	async function openConfig(ctx: ExtensionContext) {
		await ensureConfigLoaded();

		await ctx.ui.custom((_tui, theme, _kb, done) => {
			const items: SettingItem[] = [
				{
					id: "defaultLevel",
					label: "Default level for new sessions",
					currentValue: config.defaultLevel,
					values: [...LEVELS],
				},
				{
					id: "showStatus",
					label: "Show status bar",
					currentValue: config.showStatus ? "on" : "off",
					values: ["on", "off"],
				},
			];

			const container = new Container();
			container.addChild(new Text(theme.fg("accent", theme.bold(" Caveman Config")), 0, 0));
			container.addChild(new Text(theme.fg("dim", " Saved to ~/.pi/agent/caveman.json"), 0, 0));
			container.addChild(new Text(theme.fg("dim", " Default level applies to future sessions."), 0, 0));
			container.addChild(new Text("", 0, 0));

			const applySettingChange = (id: string, newValue: string) => {
				if (id === "defaultLevel" && isLevel(newValue)) {
					config.defaultLevel = newValue;
				} else if (id === "showStatus") {
					config.showStatus = newValue === "on";
				}
				saveConfig(config);
				syncStatus(ctx);
			};

			const settingsList = new SettingsList(
				items,
				Math.min(items.length + 2, 10),
				getSettingsListTheme(),
				applySettingChange,
				() => done(undefined),
			);

			container.addChild(settingsList);
			container.addChild(new Text(theme.fg("dim", " ←→/hl/tab change • ↑↓/jk move • esc close"), 0, 0));

			const cycleSelectedValue = (direction: -1 | 1) => {
				const selectedIndex = (settingsList as unknown as { selectedIndex: number }).selectedIndex;
				const item = items[selectedIndex];
				if (!item?.values?.length) return;

				const currentIndex = item.values.indexOf(item.currentValue);
				const nextIndex = (currentIndex + direction + item.values.length) % item.values.length;
				const newValue = item.values[nextIndex]!;
				item.currentValue = newValue;
				settingsList.updateValue(item.id, newValue);
				applySettingChange(item.id, newValue);
			};

			return {
				render: (w: number) => container.render(w),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					if (data === "j") data = "\u001b[B";
					else if (data === "k") data = "\u001b[A";
					else if (data === "h") {
						cycleSelectedValue(-1);
						_tui.requestRender();
						return;
					} else if (data === "l" || data === "\u001b[C" || data === "\t") {
						cycleSelectedValue(1);
						_tui.requestRender();
						return;
					} else if (data === "\u001b[D") {
						cycleSelectedValue(-1);
						_tui.requestRender();
						return;
					}

					settingsList.handleInput?.(data);
					_tui.requestRender();
				},
			};
		});
	}

	pi.on("before_agent_start", async (event) => {
		await ensureConfigLoaded();
		if (level === "off") return;
		if (level === "micro") {
			return {
				systemPrompt: `${event.systemPrompt}\n\n${MICRO_PROMPT}`,
			};
		}
		return {
			systemPrompt: `${event.systemPrompt}\n\n${BASE}\n\n${INTENSITY[level]}\n\n${SAFETY}`,
		};
	});
}
