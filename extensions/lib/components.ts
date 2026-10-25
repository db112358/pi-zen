/**
 * The rows zen draws: a tool row's frame, a chapter's folded line, the thinking
 * rows beside an action, and the purple row that replaces omitted thinking. Each
 * reads the model's live entries at draw time and caches only the text it drew.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	Box,
	Text,
	getKeybindings,
	truncateToWidth,
	visibleWidth,
	type Component,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { thinkingText } from "./format";
import {
	byId,
	chapterBackground,
	expandedAll,
	isChapterRow,
	lastEntry,
	rowsShown,
	takingOver,
	tally,
	thinkingAfter,
	thinkingBefore,
	type Background,
	type Chapter,
	type Entry,
	type ThinkingEntry,
	type ToolEntry,
} from "./model";

function expandHint(): string {
	const keys = getKeybindings().getKeys("app.tools.expand");
	return keys.length > 0 ? keys[0] : "ctrl+o";
}

/**
 * The one line an action takes, cut to `budget` cells. The suffix and the outcome are
 * structure worth keeping, so the action text is what gives way.
 */
export function entryLine(entry: Entry, theme: Theme, budget: number): string {
	const separator = theme.fg("muted", " · ");
	const lead = entry.kind === "thinking" ? `${theme.fg("toolTitle", theme.bold("thinking"))} ` : "";
	let { main } = entry.actionHeader;
	const { suffix } = entry.actionHeader;
	let resultSummary = entry.kind === "tool" ? entry.resultSummary : "";
	const leadWidth = visibleWidth(lead);
	const room = Math.max(1, budget - leadWidth - visibleWidth(suffix) - (resultSummary ? visibleWidth(separator) : 0));
	// A long outcome may not squeeze the action out of the row.
	const resultRoom = Math.max(8, Math.floor(room * 0.4));
	if (resultSummary && visibleWidth(resultSummary) > resultRoom) {
		resultSummary = truncateToWidth(resultSummary, resultRoom, "…");
	}
	const mainRoom = Math.max(1, room - (resultSummary ? visibleWidth(resultSummary) : 0));
	if (visibleWidth(main) > mainRoom) {
		main = truncateToWidth(main, mainRoom, "…");
	}
	return `${lead}${main}${suffix}${resultSummary ? separator + resultSummary : ""}`;
}

/** A thinking action in full, for a row the user opened on its own. */
function thinkingDetail(entry: ThinkingEntry, theme: Theme): string {
	const head = theme.fg("toolTitle", theme.bold("thinking"));
	const text = thinkingText(entry.message);
	if (!text) {
		return head;
	}
	return `${head}\n${text
		.split("\n")
		.map((line) => theme.fg("muted", line))
		.join("\n")}`;
}

function chapterLine(chapter: Chapter, pending: number, failed: number, theme: Theme, width: number): string {
	const tail = lastEntry(chapter);
	const count = chapter.entries.length;
	const separator = theme.fg("muted", " · ");
	const marker = theme.fg("muted", "▶");
	const lead: string[] = [];
	if (count > 1) lead.push(theme.fg("muted", `${count} actions`));
	// A red chapter already says its latest action failed; the count is for the failures before it.
	if (failed > 0 && !chapter.lastTool?.error) lead.push(theme.fg("error", `${failed} failed`));
	const hint = count > 1 ? theme.fg("dim", expandHint()) : "";

	// The fixed parts get their space first; the action text takes what is left.
	const leadText = lead.join(separator);
	const fixed =
		visibleWidth(marker) +
		1 +
		(lead.length > 0 ? visibleWidth(leadText) + visibleWidth(separator) : 0) +
		(hint ? visibleWidth(separator) + visibleWidth(hint) : 0);
	const body = tail
		? entryLine(tail, theme, Math.max(8, width - fixed))
		: theme.fg("muted", pending > 0 ? "working" : "done");

	const parts = lead.length > 0 ? [...lead, body] : [body];
	if (hint) parts.push(hint);
	return `${marker} ${parts.join(separator)}`;
}

/**
 * A row's frame: the call and result slots each store their piece and the frame
 * redraws from what it has, so a row keeps its padding at both ends and the second
 * piece appears without either slot handing the other a component.
 */
export class RowFrame implements Component {
	private readonly frame: Box;
	private call?: Component;
	private result?: Component;
	private bg: Background = "toolPendingBg";

	constructor(
		private readonly theme: Theme,
		outputPad: number,
	) {
		this.frame = new Box(outputPad, 1);
	}

	setCall(component: Component, bg: Background): void {
		this.call = component;
		this.bg = bg;
	}

	setResult(component: Component, bg: Background): void {
		this.result = component;
		this.bg = bg;
	}

	render(width: number): string[] {
		this.frame.setBgFn((text) => this.theme.bg(this.bg, text));
		this.frame.clear();
		if (this.call) {
			this.frame.addChild(this.call);
		}
		if (this.result) {
			this.frame.addChild(this.result);
		}
		return this.frame.render(width);
	}

	invalidate(): void {}
}

/**
 * `truncateToWidth` closes a cut with SGR 0, which is fine at the end of a line but not in the
 * middle of one: SGR 0 clears the row's background, so everything after the cut loses it. Keep
 * every other reset and drop the background reset.
 */
function keepBackground(line: string): string {
	return line.replace(/\u001b\[0m/g, "\u001b[22m\u001b[23m\u001b[24m\u001b[25m\u001b[27m\u001b[28m\u001b[29m\u001b[39m");
}

/** Neutral row colour for chrome that shows no tool state. */
const NEUTRAL_BG = "toolPendingBg";

/** Redrawn from live state, so a row folds away as soon as a later one exists. */
export class ChapterRow implements Component {
	private readonly frame: Box;
	private readonly line = new Text("", 0, 0);

	/**
	 * `chapter` stands for a folded chapter. `header` and `footer` bookend an opened one with the
	 * same fold line, so neither reads as an action.
	 */
	constructor(
		private readonly entryId: string,
		private readonly theme: Theme,
		private readonly outputPad: number,
		private readonly kind: "chapter" | "header" | "footer" = "chapter",
	) {
		this.frame = new Box(outputPad, 1);
		this.frame.addChild(this.line);
	}

	render(width: number): string[] {
		const entry = byId.get(this.entryId);
		if (entry?.kind !== "tool" || !entry.chapter) {
			return [];
		}
		const chapter = entry.chapter;
		const { pending, failed } = tally(chapter);
		// One line, always: the row must never wrap.
		const inner = innerWidth(width, this.outputPad);
		const content = this.contentOf(chapter, entry, pending, failed, inner);
		if (content === undefined) {
			return [];
		}
		// A folded chapter carries its outcome; bookends stay neutral so no action can repaint them.
		const bg = this.kind === "chapter" ? chapterBackground(chapter) : NEUTRAL_BG;
		this.frame.setBgFn((text) => this.theme.bg(bg, text));
		this.line.setText(keepBackground(truncateToWidth(content, inner, "…")));
		return this.frame.render(width);
	}

	private contentOf(chapter: Chapter, entry: ToolEntry, pending: number, failed: number, width: number): string | undefined {
		switch (this.kind) {
			case "chapter":
				// Only the newest tool row draws the folded chapter; the rest keep their own rows.
				return isChapterRow(entry) ? chapterLine(chapter, pending, failed, this.theme, width) : undefined;
			case "header":
				return foldLine(chapter, this.theme, width, true);
			case "footer":
				// The footer sits under the newest row and only while the chapter is open on its own.
				return chapter.open && !expandedAll() && chapter.lastTool === entry
					? foldLine(chapter, this.theme, width, false)
					: undefined;
		}
	}

	invalidate(): void {}
}

/** The fold line at either end of an opened chapter: the same row, pointing the way it folds. */
function foldLine(chapter: Chapter, theme: Theme, width: number, open: boolean): string {
	const separator = theme.fg("muted", " · ");
	const parts: string[] = [];
	if (chapter.entries.length > 1) parts.push(theme.fg("muted", `${chapter.entries.length} actions`));
	parts.push(theme.fg("dim", "click to collapse"));
	const line = `${theme.fg("muted", open ? "▼" : "▲")} ${parts.join(separator)}`;
	const hint = theme.fg("dim", expandHint());
	return visibleWidth(line) + visibleWidth(separator) + visibleWidth(hint) <= width ? line + separator + hint : line;
}

/** Thinking's own background, distinct from every tool state so it cannot read as part of an action. */
const THINKING_BG = "customMessageBg";

/** A row's drawing width: padding at both ends, and a cell of slack so a line never fills the terminal. */
function innerWidth(width: number, outputPad: number): number {
	return Math.max(1, width - outputPad * 2 - 1);
}

/** A thinking block as its row shows it: the one-line gist, or the whole block once it is open. */
function thinkingRowContent(entry: ThinkingEntry, theme: Theme, width: number, full: boolean): string {
	return full
		? thinkingDetail(entry, theme)
		: keepBackground(truncateToWidth(entryLine(entry, theme, width), width, "…"));
}

/**
 * The thinking rows above or below a tool row, each in its own frame. Redrawn from live state,
 * so a row follows streaming thinking and stops drawing the moment a later tool takes it over.
 */
export class ThinkingRows implements Component {
	private readonly rows = new Map<string, { text: Text; content: string }>();
	/** Clickable line ranges of the last render, so a click picks its own block. */
	private layout: Array<{ id: string; top: number; bottom: number }> = [];

	constructor(
		private readonly entryId: string,
		private readonly theme: Theme,
		private readonly outputPad: number,
		private readonly after: boolean,
		private readonly rerender: () => void,
	) {}

	render(width: number): string[] {
		const entry = byId.get(this.entryId);
		const chapter = entry?.chapter;
		if (!entry || !chapter) {
			return [];
		}
		const blocks = this.after ? thinkingAfter(chapter, entry) : thinkingBefore(chapter, entry);
		if (blocks.length === 0) {
			this.rows.clear();
			this.layout = [];
			return [];
		}
		const inner = innerWidth(width, this.outputPad);
		const live = new Set(blocks.map((block) => block.id));
		for (const id of this.rows.keys()) {
			if (!live.has(id)) {
				this.rows.delete(id);
			}
		}
		const out: string[] = [];
		const layout: Array<{ id: string; top: number; bottom: number }> = [];
		for (const block of blocks) {
			// A dark line keeps the block from reading as part of the row beside it.
			if (this.after) out.push("");
			const top = out.length;
			const content = thinkingRowContent(block, this.theme, inner, block.open === true || !rowsShown(block.chapter));
			let row = this.rows.get(block.id);
			if (!row) {
				row = { text: new Text("", this.outputPad, 1, (line) => this.theme.bg(THINKING_BG, line)), content: "" };
				this.rows.set(block.id, row);
			}
			if (row.content !== content) {
				row.text.setText(content);
				row.content = content;
			}
			out.push(...row.text.render(width));
			layout.push({ id: block.id, top, bottom: out.length });
			if (!this.after) out.push("");
		}
		this.layout = layout;
		return out;
	}

	/** A click on a thinking block opens its full text; anywhere else the row keeps its own behaviour. */
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const chapter = byId.get(this.entryId)?.chapter;
		if (event.type !== "click" || event.button !== "left" || !rowsShown(chapter)) {
			return undefined;
		}
		const hit = this.layout.find((range) => event.y >= range.top && event.y < range.bottom);
		const block = hit ? byId.get(hit.id) : undefined;
		if (!block) {
			return undefined;
		}
		block.open = !block.open;
		this.rerender();
		return { handled: true };
	}

	invalidate(): void {
		this.rows.clear();
		this.layout = [];
	}
}

/**
 * A chapter whose thinking no tool row has taken over draws the same purple row the expanded rows
 * show. It reads live state, so it streams in place and folds away on the next draw. It always draws
 * the gist until a click opens it: `expanded` is thinking visibility, not row expansion.
 */
export class ChatThinkingRow implements Component {
	private readonly text: Text;
	private content = "";

	constructor(
		private readonly entryId: string,
		private readonly theme: Theme,
		private readonly outputPad: number,
		private readonly rerender: () => void,
	) {
		this.text = new Text("", outputPad, 1, (line) => theme.bg(THINKING_BG, line));
	}

	render(width: number): string[] {
		const entry = byId.get(this.entryId);
		if (entry?.kind !== "thinking" || takingOver(entry.chapter)) {
			return [];
		}
		const content = thinkingRowContent(entry, this.theme, innerWidth(width, this.outputPad), entry.open === true);
		if (content !== this.content) {
			this.text.setText(content);
			this.content = content;
		}
		return this.text.render(width);
	}

	/** A click opens the full thinking, as in an expanded chapter. */
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const entry = byId.get(this.entryId);
		if (event.type !== "click" || event.button !== "left" || entry?.kind !== "thinking") {
			return undefined;
		}
		entry.open = !entry.open;
		this.rerender();
		return { handled: true };
	}

	invalidate(): void {
		this.text.invalidate();
	}
}
