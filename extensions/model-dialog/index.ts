/**
 * /m — floating model selector with search + favourites.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, matchesKey } from "@earendil-works/pi-tui";
import { showFloatingDialog } from "../../tui/floating-dialog";

const FAVORITES_PATH = join(homedir(), ".pi", "model-favorites.json");
const MAX_VISIBLE = 12;
const MAX_VISIBLE_FAVORITES = 5;

interface ModelItem {
  provider: string;
  id: string;
  name: string;
  model: Model<Api>;
  favorite: boolean;
}

export default function modelDialog(pi: ExtensionAPI) {
  pi.registerCommand("m", {
    description: "Select model (floating dialog)",
    handler: async (args, ctx) => {
      const model = await showModelDialog(ctx, args.trim() || undefined);
      if (model) await pi.setModel(model);
    },
  });
}

async function showModelDialog(
  ctx: ExtensionCommandContext,
  initialSearch = "",
): Promise<Model<Api> | null> {
  ctx.modelRegistry.refresh();

  const currentModel = ctx.model;
  const favorites = loadFavorites();
  const allItems = sortItems(
    ctx.modelRegistry.getAvailable().map((model) => ({
      provider: model.provider,
      id: model.id,
      name: model.name,
      model,
      favorite: favorites.has(modelKey(model)),
    })),
    currentModel,
  );

  let search = initialSearch;
  let items = getVisibleItems(allItems, search);
  let selected = initialSelectedIndex(items, currentModel);

  const setVisibleItems = (keepModel?: Model<Api>) => {
    items = getVisibleItems(allItems, search);
    if (keepModel) {
      const idx = items.findIndex((it) => isSameModel(keepModel, it.model));
      if (idx >= 0) selected = idx;
      else selected = clampIndex(selected, items.length);
      return;
    }
    selected = clampIndex(selected, items.length);
  };

  const toggleFavorite = () => {
    const item = items[selected];
    if (!item) return;

    const oldItems = [...items];
    const oldIndex = selected;
    const oldFavoriteState = item.favorite;

    item.favorite = !item.favorite;
    if (item.favorite) favorites.add(modelKey(item.model));
    else favorites.delete(modelKey(item.model));
    saveFavorites(favorites);
    sortItems(allItems, currentModel);

    const cursorTarget = findNeighborInSameOldSection(oldItems, oldIndex, oldFavoriteState) ?? item;
    setVisibleItems(cursorTarget.model);
  };

  return showFloatingDialog<Model<Api> | null>(ctx, {
    title: "Model",
    width: "60%",
    minWidth: 50,
    maxHeight: "80%",
    helpText: "↑↓ navigate • enter select • space filter • ctrl+f ★ fav • esc clear/arm • esc esc close",
    render: (_w, theme) => [
      renderSearchLine(search, theme),
      "",
      ...renderItems(items, selected, currentModel, theme),
      ...renderDetails(items[selected], theme),
      "",
    ],
    onInput: (data, close, tui) => {
      if (matchesKey(data, "ctrl+c")) {
        close(null);
        return;
      }

      if (matchesKey(data, "escape")) {
        if (search) {
          search = "";
          setVisibleItems(items[selected]?.model);
          tui.requestRender();
        }
        return;
      }

      if (matchesKey(data, "enter")) {
        close(items[selected]?.model ?? null);
        return;
      }

      if (matchesKey(data, "up") || matchesKey(data, "down")) {
        selected = moveSelection(selected, items.length, matchesKey(data, "down") ? 1 : -1);
        tui.requestRender();
        return;
      }

      if (matchesKey(data, "ctrl+f") || (matchesKey(data, "space") && !search)) {
        toggleFavorite();
        tui.requestRender();
        return;
      }

      if (matchesKey(data, "backspace")) {
        if (search) {
          search = search.slice(0, -1);
          setVisibleItems(items[selected]?.model);
          tui.requestRender();
        }
        return;
      }

      if (data.length === 1 && data >= " ") {
        search += data;
        setVisibleItems(items[selected]?.model);
        tui.requestRender();
      }
    },
  });
}

function renderSearchLine(search: string, theme: Theme): string {
  return search
    ? theme.fg("accent", `  ${search}`) + theme.fg("dim", "▏")
    : theme.fg("dim", "  type to filter…");
}

function renderItems(
  items: ModelItem[],
  selected: number,
  currentModel: Model<Api> | undefined,
  theme: Theme,
): string[] {
  if (items.length === 0) return [theme.fg("muted", "  No matching models")];

  const favorites = items.filter((it) => it.favorite);
  if (favorites.length === 0) return renderWindow(items, selected, currentModel, theme, MAX_VISIBLE);

  const normals = items.filter((it) => !it.favorite);
  const lines = renderFavoriteBlock(items, favorites, selected, currentModel, theme);
  if (normals.length === 0) return lines;

  const usedByFavorites = lines.length + 1;
  lines.push(theme.fg("dim", "  ─────"));
  lines.push(...renderNormalBlock(items, normals, selected, currentModel, theme, Math.max(3, MAX_VISIBLE - usedByFavorites)));
  return lines;
}

function renderFavoriteBlock(
  allVisible: ModelItem[],
  favorites: ModelItem[],
  selected: number,
  currentModel: Model<Api> | undefined,
  theme: Theme,
): string[] {
  const selectedItem = allVisible[selected];
  const selectedFavIndex = selectedItem?.favorite ? favorites.indexOf(selectedItem) : -1;
  const visibleCount = Math.min(MAX_VISIBLE_FAVORITES, favorites.length);
  const start = selectedFavIndex >= 0
    ? windowStart(selectedFavIndex, favorites.length, visibleCount)
    : 0;
  const end = Math.min(start + visibleCount, favorites.length);

  const lines: string[] = [];
  if (start > 0) lines.push(theme.fg("muted", `  … ${start} more favourites above`));
  for (let i = start; i < end; i++) {
    const item = favorites[i]!;
    lines.push(renderModelLine(item, allVisible[selected] === item, currentModel, theme));
  }
  if (end < favorites.length) lines.push(theme.fg("muted", `  … ${favorites.length - end} more favourites`));
  return lines;
}

function renderNormalBlock(
  allVisible: ModelItem[],
  normals: ModelItem[],
  selected: number,
  currentModel: Model<Api> | undefined,
  theme: Theme,
  maxVisible: number,
): string[] {
  const selectedItem = allVisible[selected];
  const selectedNormalIndex = selectedItem && !selectedItem.favorite ? normals.indexOf(selectedItem) : 0;
  const start = windowStart(Math.max(0, selectedNormalIndex), normals.length, maxVisible);
  const end = Math.min(start + maxVisible, normals.length);

  const lines = normals.slice(start, end).map((item) => renderModelLine(item, allVisible[selected] === item, currentModel, theme));
  if (start > 0 || end < normals.length) lines.push(theme.fg("muted", `  (${selected + 1}/${allVisible.length})`));
  return lines;
}

function renderWindow(
  items: ModelItem[],
  selected: number,
  currentModel: Model<Api> | undefined,
  theme: Theme,
  maxVisible: number,
): string[] {
  const start = windowStart(selected, items.length, maxVisible);
  const end = Math.min(start + maxVisible, items.length);
  const lines = items.slice(start, end).map((item, offset) => renderModelLine(item, start + offset === selected, currentModel, theme));
  if (start > 0 || end < items.length) lines.push(theme.fg("muted", `  (${selected + 1}/${items.length})`));
  return lines;
}

function renderModelLine(item: ModelItem, selected: boolean, currentModel: Model<Api> | undefined, theme: Theme): string {
  const prefix = selected ? "→ " : "  ";
  const star = item.favorite ? theme.fg("warning", "★ ") : "  ";
  const check = isSameModel(currentModel, item.model) ? theme.fg("success", " ✓") : "";
  const provider = theme.fg("muted", `[${item.provider}]`);
  const id = selected ? theme.fg("accent", item.id) : item.id;
  return `${selected ? theme.fg("accent", prefix) : prefix}${star}${id} ${provider}${check}`;
}

function renderDetails(item: ModelItem | undefined, theme: Theme): string[] {
  if (!item) return [];
  return ["", theme.fg("muted", `  ${item.name}  ctx:${formatK(item.model.contextWindow)}  max:${formatK(item.model.maxTokens)}`)];
}

function getVisibleItems(allItems: ModelItem[], search: string): ModelItem[] {
  if (!search) return allItems;
  const favorites = allItems.filter((it) => it.favorite);
  const normals = fuzzyFilter(
    allItems.filter((it) => !it.favorite),
    search,
    searchableText,
  );
  return [...favorites, ...normals];
}

function sortItems(items: ModelItem[], currentModel: Model<Api> | undefined): ModelItem[] {
  return items.sort((a, b) => {
    if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;

    const aCurrent = isSameModel(currentModel, a.model);
    const bCurrent = isSameModel(currentModel, b.model);
    if (aCurrent !== bCurrent) return aCurrent ? -1 : 1;

    return a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id);
  });
}

function findNeighborInSameOldSection(items: ModelItem[], index: number, favorite: boolean): ModelItem | undefined {
  return items.slice(index + 1).find((it) => it.favorite === favorite) ??
    items.slice(0, index).reverse().find((it) => it.favorite === favorite);
}

function initialSelectedIndex(items: ModelItem[], currentModel: Model<Api> | undefined): number {
  const currentIndex = items.findIndex((it) => isSameModel(currentModel, it.model));
  return currentIndex >= 0 ? currentIndex : 0;
}

function moveSelection(selected: number, length: number, delta: 1 | -1): number {
  if (length === 0) return 0;
  return (selected + delta + length) % length;
}

function clampIndex(index: number, length: number): number {
  return Math.min(Math.max(0, index), Math.max(0, length - 1));
}

function windowStart(selected: number, length: number, maxVisible: number): number {
  return Math.max(0, Math.min(selected - Math.floor(maxVisible / 2), length - maxVisible));
}

function searchableText(item: ModelItem): string {
  return `${item.id} ${item.provider} ${item.provider}/${item.id} ${item.name}`;
}

function modelKey(model: Model<Api>): string {
  return `${model.provider}/${model.id}`;
}

function isSameModel(a: Model<Api> | undefined | null, b: Model<Api> | undefined | null): boolean {
  return !!a && !!b && a.provider === b.provider && a.id === b.id;
}

function formatK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return `${n}`;
}

function loadFavorites(): Set<string> {
  try {
    const data = existsSync(FAVORITES_PATH) ? JSON.parse(readFileSync(FAVORITES_PATH, "utf8")) : [];
    return new Set(Array.isArray(data) ? data.filter((item) => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

function saveFavorites(favorites: Set<string>): void {
  try {
    mkdirSync(join(homedir(), ".pi"), { recursive: true });
    writeFileSync(FAVORITES_PATH, JSON.stringify([...favorites], null, 2));
  } catch {
    // Ignore persistence failures; dialog remains usable.
  }
}
