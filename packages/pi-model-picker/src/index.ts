/**
 * Model Picker Extension
 *
 * Usage:
 *   /models               — open the categorized picker
 *   /model-favorites      — favorites-only picker
 *   /model-quick-switch   — compact favorites palette
 *   Ctrl+Alt+M            — open model picker
 *   Ctrl+Alt+F            — open favorites picker
 *   Ctrl+Alt+P            — quick-switch palette
 *   Ctrl+Alt+N            — cycle favorite models
 *   Ctrl+Alt+1..9         — jump to quick slots
 *
 * Note: /model is a built-in pi command and cannot be overridden.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Input, Key, Text, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Api, Model } from "@earendil-works/pi-ai";

function providerLabel(id: string): string {
	return id
		.split("-")
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

function fmtCtx(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(0)}M`;
	if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(0)}k`;
	return String(tokens);
}

function modelKey(model: Pick<Model<Api>, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

function getAgentDir(): string {
	const envDir = process.env.PI_CODING_AGENT_DIR;
	if (!envDir) return join(homedir(), ".pi", "agent");
	if (envDir === "~") return homedir();
	if (envDir.startsWith("~/")) return join(homedir(), envDir.slice(2));
	return envDir;
}

const STATE_PATH = join(getAgentDir(), "pi-model-picker", "favorites.json");

type FavoritesState = {
	favorites: string[];
};

function loadState(): FavoritesState {
	try {
		if (!existsSync(STATE_PATH)) return { favorites: [] };
		const data = JSON.parse(readFileSync(STATE_PATH, "utf-8")) as Partial<FavoritesState> & { favorites?: unknown };
		const favorites = Array.isArray(data.favorites)
			? [...new Set(data.favorites.filter((v): v is string => typeof v === "string"))]
			: [];
		return { favorites };
	} catch {
		return { favorites: [] };
	}
}

function saveState(state: FavoritesState): void {
	mkdirSync(dirname(STATE_PATH), { recursive: true });
	writeFileSync(
		STATE_PATH,
		JSON.stringify({ favorites: [...new Set(state.favorites)] }, null, 2) + "\n",
	);
}

function getFavoriteSet(state: FavoritesState): Set<string> {
	return new Set(state.favorites);
}

function toggleFavoriteState(model: Pick<Model<Api>, "provider" | "id">, state: FavoritesState): boolean {
	const key = modelKey(model);
	if (state.favorites.includes(key)) {
		state.favorites = state.favorites.filter((entry) => entry !== key);
		saveState(state);
		return false;
	}
	state.favorites.push(key);
	saveState(state);
	return true;
}

function getQuickSlotModels(models: Model<Api>[], state: FavoritesState): Model<Api>[] {
	const byKey = new Map(models.map((m) => [modelKey(m), m]));
	return state.favorites.map((key) => byKey.get(key)).filter((m): m is Model<Api> => Boolean(m));
}

type PickerMode = "providers" | "favorites" | "palette";

interface ModelPickerOptions {
	allModels: Model<Api>[];
	currentModel: Model<Api> | undefined;
	state: FavoritesState;
	mode: PickerMode;
	onSelect: (model: Model<Api>) => void;
	onCancel: () => void;
	onToggleFavorite: (model: Model<Api>) => void;
	onStateChanged?: () => void;
}

class ModelPickerComponent {
	focused = false;
	private categories: string[] = [];
	private catIndex = 0;
	private rowIndex = 0;
	private byCategory = new Map<string, Model<Api>[]>();
	private searchTerms = new Map<string, string>();
	private searchInput: Input;
	private filteredRows: Model<Api>[] = [];

	constructor(private opts: ModelPickerOptions) {
		this.searchInput = new Input();
		this.searchInput.focused = true;
		this.searchInput.onEscape = () => opts.onCancel();
		this.searchInput.onSubmit = () => {
			const selected = this.filteredRows[this.rowIndex];
			if (selected) opts.onSelect(selected);
		};
		this.rebuild();
		const cur = opts.currentModel;
		if (cur) {
			const idx = this.filteredRows.findIndex((m) => m.id === cur.id && m.provider === cur.provider);
			this.rowIndex = Math.max(0, idx);
		}
	}

	set focusedState(v: boolean) {
		this.focused = v;
		this.searchInput.focused = v;
	}

	private isFavorite(model: Pick<Model<Api>, "provider" | "id">): boolean {
		return getFavoriteSet(this.opts.state).has(modelKey(model));
	}

	private rebuild(): void {
		this.byCategory = this.buildCategories();
		this.categories = Array.from(this.byCategory.keys());
		const cur = this.opts.currentModel;
		const currentCategory = this.categories[this.catIndex];
		let startCat = currentCategory;
		if (!startCat || !this.byCategory.has(startCat)) {
			startCat = this.opts.mode === "providers"
				? (cur && this.byCategory.has(cur.provider) ? cur.provider : this.categories[0])
				: this.categories[0];
		}
		this.catIndex = Math.max(0, this.categories.indexOf(startCat ?? ""));
		const catKey = this.categories[this.catIndex] ?? "";
		this.searchInput.setValue(this.searchTerms.get(catKey) ?? "");
		this.applyFilter();
	}

	private buildCategories(): Map<string, Model<Api>[]> {
		const cur = this.opts.currentModel;
		if (this.opts.mode === "palette") {
			const favorites = getQuickSlotModels(this.opts.allModels, this.opts.state);
			return favorites.length > 0 ? new Map([["Favorites", favorites]]) : new Map();
		}

		const map = new Map<string, Model<Api>[]>();
		const models = this.opts.mode === "favorites"
			? this.opts.allModels.filter((m) => this.isFavorite(m))
			: this.opts.allModels;
		for (const m of models) {
			if (!map.has(m.provider)) map.set(m.provider, []);
			map.get(m.provider)!.push(m);
		}
		for (const [, arr] of map) {
			arr.sort((a, b) => {
				const aFav = this.isFavorite(a) ? -1 : 0;
				const bFav = this.isFavorite(b) ? -1 : 0;
				if (aFav !== bFav) return aFav - bFav;
				const aCur = cur && a.id === cur.id && a.provider === cur.provider ? -1 : 0;
				const bCur = cur && b.id === cur.id && b.provider === cur.provider ? -1 : 0;
				if (aCur !== bCur) return aCur - bCur;
				return a.name.localeCompare(b.name);
			});
		}
		return new Map(
			[...map.entries()].sort(([aKey], [bKey]) => {
				const aCur = this.opts.mode === "providers" && cur && aKey === cur.provider ? -1 : 0;
				const bCur = this.opts.mode === "providers" && cur && bKey === cur.provider ? -1 : 0;
				if (aCur !== bCur) return aCur - bCur;
				return aKey.localeCompare(bKey);
			}),
		);
	}

	private applyFilter(): void {
		const catKey = this.categories[this.catIndex] ?? "";
		const source = this.byCategory.get(catKey) ?? [];
		const query = (this.searchTerms.get(catKey) ?? "").toLowerCase().trim();
		this.filteredRows = !query
			? source
			: source.filter((m) =>
				m.name.toLowerCase().includes(query) ||
				m.id.toLowerCase().includes(query) ||
				m.provider.toLowerCase().includes(query),
			);
		this.rowIndex = Math.min(this.rowIndex, Math.max(0, this.filteredRows.length - 1));
	}

	private switchCategory(delta: number): void {
		if (this.categories.length === 0) return;
		const oldKey = this.categories[this.catIndex] ?? "";
		this.searchTerms.set(oldKey, this.searchInput.getValue());
		this.catIndex = (this.catIndex + delta + this.categories.length) % this.categories.length;
		const newKey = this.categories[this.catIndex] ?? "";
		this.searchInput.setValue(this.searchTerms.get(newKey) ?? "");
		this.rowIndex = 0;
		this.applyFilter();
	}

	private refresh(): void {
		this.rebuild();
		this.opts.onStateChanged?.();
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.up)) {
			if (this.filteredRows.length === 0) return;
			this.rowIndex = this.rowIndex === 0 ? this.filteredRows.length - 1 : this.rowIndex - 1;
			return;
		}
		if (matchesKey(data, Key.down)) {
			if (this.filteredRows.length === 0) return;
			this.rowIndex = this.rowIndex === this.filteredRows.length - 1 ? 0 : this.rowIndex + 1;
			return;
		}
		if (matchesKey(data, Key.ctrl("f"))) {
			const selected = this.filteredRows[this.rowIndex];
			if (selected) {
				this.opts.onToggleFavorite(selected);
				this.refresh();
			}
			return;
		}

		if (matchesKey(data, Key.tab)) {
			this.switchCategory(1);
			return;
		}
		if (matchesKey(data, Key.shift("tab"))) {
			this.switchCategory(-1);
			return;
		}
		if (matchesKey(data, Key.left) && this.searchInput.getValue() === "") {
			this.switchCategory(-1);
			return;
		}
		if (matchesKey(data, Key.right) && this.searchInput.getValue() === "") {
			this.switchCategory(1);
			return;
		}
		const before = this.searchInput.getValue();
		this.searchInput.handleInput(data);
		const after = this.searchInput.getValue();
		if (before !== after) {
			const catKey = this.categories[this.catIndex] ?? "";
			this.searchTerms.set(catKey, after);
			this.rowIndex = 0;
			this.applyFilter();
		}
	}

	render(width: number, theme: any): string[] {
		const lines: string[] = [];
		lines.push(this.renderTabs(width, theme));
		lines.push(theme.fg("border", "─".repeat(width)));
		const prompt = theme.fg("muted", "  Search: ");
		const promptW = visibleWidth("  Search: ");
		const inputLines = this.searchInput.render(width - promptW);
		lines.push(prompt + (inputLines[0] ?? ""));
		lines.push(theme.fg("border", "─".repeat(width)));

		const maxVisible = this.opts.mode === "palette" ? 14 : 10;
		const half = Math.floor(maxVisible / 2);
		const rows = this.filteredRows;
		const start = Math.max(0, Math.min(this.rowIndex - half, rows.length - maxVisible));
		const visible = rows.slice(start, start + maxVisible);
		if (rows.length === 0) {
			const query = this.searchInput.getValue();
			const msg = query ? `  No models match "${query}"` : "  No models in this category";
			lines.push(theme.fg("muted", msg));
		} else {
			for (let i = 0; i < visible.length; i++) {
				const model = visible[i]!;
				const absIdx = start + i;
				const isSelected = absIdx === this.rowIndex;
				const isCurrent = this.opts.currentModel?.id === model.id && this.opts.currentModel?.provider === model.provider;
				lines.push(this.renderRow(model, isSelected, isCurrent, width, theme));
			}
			if (rows.length > maxVisible) {
				const shown = `${start + 1}–${Math.min(start + maxVisible, rows.length)} of ${rows.length}`;
				lines.push(theme.fg("dim", "  " + shown));
			}
		}

		lines.push(theme.fg("border", "─".repeat(width)));
		const help = this.opts.mode === "palette"
			? "↑↓ navigate · search favorites · enter select · esc cancel"
			: "↑↓ navigate · Tab/← → category · Ctrl+F favorite · enter select";
		lines.push(theme.fg("dim", truncateToWidth("  " + help, width)));
		return lines;
	}

	private renderTabs(width: number, theme: any): string {
		const total = this.categories.length;
		if (total === 0) {
			return theme.fg("muted", truncateToWidth("  No favorite models yet", width));
		}
		const active = this.catIndex;
		const arrowW = 4;
		const sepW = 1;
		const availForTabs = width - arrowW;
		let lo = active;
		let hi = active;
		let used = visibleWidth(` ${this.categories[active]!} `);
		while (true) {
			let expanded = false;
			if (hi + 1 < total) {
				const w = sepW + visibleWidth(` ${this.categories[hi + 1]!} `);
				if (used + w <= availForTabs) { hi++; used += w; expanded = true; }
			}
			if (lo - 1 >= 0) {
				const w = sepW + visibleWidth(` ${this.categories[lo - 1]!} `);
				if (used + w <= availForTabs) { lo--; used += w; expanded = true; }
			}
			if (!expanded) break;
		}
		const segments: string[] = [];
		for (let i = lo; i <= hi; i++) {
			const raw = this.categories[i]!;
			const label = ` ${this.opts.mode === "providers" || this.opts.mode === "favorites" ? providerLabel(raw) : raw} `;
			segments.push(i === active ? theme.fg("accent", theme.bold(label)) : theme.fg("muted", label));
		}
		const tabPart = segments.join(theme.fg("dim", "│"));
		const leftPart = lo > 0 ? theme.fg("dim", "◀ ") : "  ";
		const rightPart = hi < total - 1 ? theme.fg("dim", " ▶") : "  ";
		return truncateToWidth(leftPart + tabPart + rightPart, width);
	}

	private renderRow(model: Model<Api>, isSelected: boolean, isCurrent: boolean, width: number, theme: any): string {
		const prefix = isSelected ? "▶ " : "  ";
		const ctxStr = fmtCtx(model.contextWindow);
		const tags: string[] = [];
		if (model.reasoning) tags.push("thinking");
		if (model.input.includes("image")) tags.push("vision");
		const right = `${ctxStr}${tags.length > 0 ? `  ${tags.join(" ")}` : ""}`;
		const curMark = isCurrent ? " ●" : "";
		const favMark = this.isFavorite(model) ? " ★" : "";
		const nameAvail = width - visibleWidth(prefix) - visibleWidth(right) - visibleWidth(curMark) - visibleWidth(favMark) - 2;
		const nameTrunc = truncateToWidth(model.name, Math.max(nameAvail, 10));
		const gap = " ".repeat(Math.max(0, width - visibleWidth(prefix + nameTrunc + curMark + favMark) - visibleWidth(right)));
		if (isSelected) return theme.fg("accent", prefix + nameTrunc + curMark + favMark) + gap + theme.fg("accent", theme.bold(right));
		if (isCurrent) return theme.fg("success", prefix + nameTrunc + curMark + favMark) + gap + theme.fg("muted", right);
		return theme.fg("text", prefix + nameTrunc + favMark) + gap + theme.fg("dim", right);
	}

	invalidate(): void {
		this.searchInput.invalidate();
	}
}

export default function modelPickerExtension(pi: ExtensionAPI) {
	function getAvailableModels(ctx: ExtensionContext): Model<Api>[] {
		ctx.modelRegistry.refresh();
		return ctx.modelRegistry.getAvailable();
	}

	async function setSelectedModel(model: Model<Api>, ctx: ExtensionContext): Promise<void> {
		const success = await pi.setModel(model);
		if (!success) ctx.ui.notify(`No API key for ${model.provider}/${model.id}`, "error");
		else ctx.ui.notify(`Model: ${model.name}`, "info");
	}

	async function cycleFavorite(ctx: ExtensionContext): Promise<void> {
		const state = loadState();
		const favoriteModels = getQuickSlotModels(getAvailableModels(ctx), state);
		if (favoriteModels.length === 0) {
			ctx.ui.notify("No favorite models available. Open /models and press Ctrl+F to mark favorites.", "warning");
			return;
		}
		const currentKey = ctx.model ? modelKey(ctx.model) : "";
		const currentIndex = favoriteModels.findIndex((m) => modelKey(m) === currentKey);
		const next = favoriteModels[(currentIndex + 1) % favoriteModels.length]!;
		await setSelectedModel(next, ctx);
	}

	async function switchQuickSlot(ctx: ExtensionContext, slot: number): Promise<void> {
		const state = loadState();
		const model = getQuickSlotModels(getAvailableModels(ctx), state)[slot - 1];
		if (!model) {
			ctx.ui.notify(`Quick slot ${slot} is empty. Add favorites first.`, "warning");
			return;
		}
		await setSelectedModel(model, ctx);
	}

	async function openPicker(ctx: ExtensionContext, mode: PickerMode = "providers") {
		const allModels = getAvailableModels(ctx);
		if (allModels.length === 0) {
			ctx.ui.notify("No models available", "warning");
			return;
		}
		const state = loadState();
		let pickerRef: ModelPickerComponent | undefined;
		const selected = await ctx.ui.custom<Model<Api> | null>((tui, theme, _kb, done) => {
			const refresh = () => {
				pickerRef?.invalidate();
				tui.requestRender();
			};
			pickerRef = new ModelPickerComponent({
				allModels,
				currentModel: ctx.model ?? undefined,
				state,
				mode,
				onSelect: (m) => done(m),
				onCancel: () => done(null),
				onStateChanged: refresh,
				onToggleFavorite: (m) => {
					const added = toggleFavoriteState(m, state);
					ctx.ui.notify(`${added ? "Favorited" : "Unfavorited"}: ${m.name}`, "info");
				},
			});
			pickerRef.focusedState = true;
			const header = new Container();
			header.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			const title = mode === "palette" ? "  Quick Switch" : mode === "favorites" ? "  Favorite Models" : "  Select Model";
			header.addChild(new Text(theme.fg("accent", theme.bold(title)), 0, 0));
			const footer = new DynamicBorder((s: string) => theme.fg("accent", s));
			return {
				focused: true,
				render(width: number): string[] {
					return [...header.render(width), ...pickerRef!.render(width, theme), ...footer.render(width)];
				},
				invalidate() {
					header.invalidate();
					pickerRef!.invalidate();
				},
				handleInput(data: string) {
					pickerRef!.handleInput(data);
					tui.requestRender();
				},
			};
		}, { overlay: true });
		if (!selected) return;
		await setSelectedModel(selected, ctx);
	}

	pi.registerCommand("models", {
		description: "Select model by provider category with search",
		handler: async (_args, ctx) => openPicker(ctx, "providers"),
	});
	pi.registerCommand("model-favorites", {
		description: "Show favorite models",
		handler: async (_args, ctx) => openPicker(ctx, "favorites"),
	});
	pi.registerCommand("model-quick-switch", {
		description: "Open compact quick-switch palette for favorites",
		handler: async (_args, ctx) => openPicker(ctx, "palette"),
	});
	pi.registerCommand("model-next-favorite", {
		description: "Switch to the next favorite model",
		handler: async (_args, ctx) => cycleFavorite(ctx),
	});

	pi.registerShortcut(Key.ctrlAlt("m"), { description: "Open categorized model picker", handler: async (ctx) => openPicker(ctx, "providers") });
	pi.registerShortcut(Key.ctrlAlt("f"), { description: "Open favorite model picker", handler: async (ctx) => openPicker(ctx, "favorites") });
	pi.registerShortcut(Key.ctrlAlt("p"), { description: "Open quick-switch palette", handler: async (ctx) => openPicker(ctx, "palette") });
	pi.registerShortcut(Key.ctrlAlt("n"), { description: "Switch to next favorite model", handler: async (ctx) => cycleFavorite(ctx) });
	for (const slot of [1, 2, 3, 4, 5, 6, 7, 8, 9] as const) {
		pi.registerShortcut(Key.ctrlAlt(String(slot) as "1"), {
			description: `Switch to quick-slot ${slot}`,
			handler: async (ctx) => switchQuickSlot(ctx, slot),
		});
	}
}
