/**
 * Zen mode: one row per run.
 *
 * Tool calls and thinking fold into a single row that follows the latest
 * action, so a long turn cannot bury the conversation in command output.
 * ctrl+o lists the actions of the chapter, one line each, and a row clicked on
 * its own shows the thinking behind it. An opened chapter folds from a chevron
 * at either end, and ctrl+o folds what is open before it expands everything.
 * Narrative tools (set_andon) are never folded: they head a new chapter and
 * read as a log of what the session did.
 * /zen off restores pi's own rendering.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Box, Container, getKeybindings, MouseRegion, Spacer, Text, truncateToWidth, visibleWidth, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";

type Context = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];
type Result = Parameters<NonNullable<ToolRenderers["renderResult"]>>[0];
type Background = "toolPendingBg" | "toolErrorBg" | "toolSuccessBg";

const HEADER_CHARS = 100;
const SUMMARY_CHARS = 120;
/** A command is kept whole so the row can use whatever width it has; only absurd lines are cut. */
const COMMAND_CHARS = 400;
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const STATE_FILE = join(AGENT_DIR, "extensions", "zen.json");

/** Tools that already hide their whole result when collapsed, so a summary would only add noise. */
const HEADER_ONLY = new Set(["read", "write"]);

/** Tools that head a chapter and keep their own row: their result is the narrative. */
const NARRATIVE = new Set(["set_andon"]);

/** A header in two parts, so a width budget can cut the text and keep the structure. */
interface Header {
	main: string;
	suffix: string;
}

/** One action: a tool call or a thinking block. */
interface Entry {
	id: string;
	kind: "tool" | "thinking";
	/** Chapter this entry belongs to; a narrative row stands alone. */
	run: Run | undefined;
	/** One line, styled: the part that may be cut, and the suffix that should survive. */
	header: Header;
	/** Styled result summary, tools only. */
	summary: string;
	/** Whether the row shows its thinking in full rather than as a one-line gist. */
	open?: boolean;
	/** Message the thinking came from, thinking only; the detail is read from it at render time. */
	message?: MaybeMessage;
	done: boolean;
	error: boolean;
}

/** Everything since the last user message or narrative row, drawn as one row. */
interface Run {
	entries: Entry[];
	/** Newest tool row; kept here so the chapter check stays O(1). */
	lastTool?: Entry;
	/** Whether this chapter alone is expanded into its rows, outside the ctrl+o list. */
	open?: boolean;
}

const byId = new Map<string, Entry>();
/** Redraw callbacks by tool call id; kept across rebuilds, which replace the entries. */
const invalidators = new Map<string, () => void>();
let current: Run | undefined;
let zen = true;
let thinkingId: string | undefined;
let thinkingCount = 0;
/** Whether the transcript shows tool output expanded, as opposed to one clicked row. */
let expandedAll = (): boolean => false;
/** Detaches the terminal-input listener that makes ctrl+o fold before it expands. */
let stopExpandKey: (() => void) | undefined;
let warnedAboutPatch = false;

function narrative(toolName: string): boolean {
	return NARRATIVE.has(toolName);
}

/** Whether rows are shown: the ctrl+o list, or one chapter opened on its own. */
function listMode(run: Run | undefined): boolean {
	return expandedAll() || run?.open === true;
}

function firstToolOf(run: Run): Entry | undefined {
	return run.entries.find((entry) => entry.kind === "tool");
}

/** Redraw every row of a chapter after its open state changed. */
function refreshRun(run: Run): void {
	for (const entry of run.entries) {
		invalidators.get(entry.id)?.();
	}
}

function toolEntry(toolCallId: string, standalone: boolean): Entry {
	const existing = byId.get(toolCallId);
	if (existing) {
		return existing;
	}
	const entry: Entry = { id: toolCallId, kind: "tool", run: undefined, header: { main: "", suffix: "" }, summary: "", done: false, error: false };
	if (standalone) {
		// A narrative row heads its own chapter and takes the thinking that led to it; left
		// behind, that thinking would have no row to draw it.
		const run: Run = { entries: [] };
		entry.run = run;
		if (current) {
			let split = current.entries.length;
			while (split > 0 && current.entries[split - 1].kind === "thinking") {
				split--;
			}
			for (const pending of current.entries.splice(split)) {
				pending.run = run;
				run.entries.push(pending);
			}
		}
		run.entries.push(entry);
		run.lastTool = entry;
		current = undefined;
	} else {
		const run = (current ??= { entries: [] });
		entry.run = run;
		run.entries.push(entry);
		// Move the marker first: the old row must redraw without the footer.
		const previous = run.lastTool;
		run.lastTool = entry;
		if (previous) invalidators.get(previous.id)?.();
	}
	byId.set(toolCallId, entry);
	return entry;
}

function thinkingEntry(id: string): Entry {
	const existing = byId.get(id);
	if (existing) {
		return existing;
	}
	const run = (current ??= { entries: [] });
	const entry: Entry = { id, kind: "thinking", run, header: { main: "", suffix: "" }, summary: "", done: true, error: false };
	run.entries.push(entry);
	byId.set(id, entry);
	return entry;
}

function lastEntry(run: Run): Entry | undefined {
	return run.entries[run.entries.length - 1];
}

/** Only the newest tool row of a chapter draws the chapter, so the rest fold away. */
function isChapterRow(entry: Entry): boolean {
	return entry.kind === "tool" && entry.run?.lastTool === entry;
}

/** Thinking drawn above a tool row: the blocks that came since the previous tool. */
function thinkingBefore(run: Run, entry: Entry): Entry[] {
	const index = run.entries.indexOf(entry);
	const out: Entry[] = [];
	for (let i = index - 1; i >= 0 && run.entries[i].kind === "thinking"; i--) {
		out.unshift(run.entries[i]);
	}
	return out;
}

/** Thinking with no tool after it hangs below the chapter's last tool row. */
function thinkingAfter(run: Run, entry: Entry): Entry[] {
	if (!isChapterRow(entry)) {
		return [];
	}
	const index = run.entries.indexOf(entry);
	const out: Entry[] = [];
	for (let i = index + 1; i < run.entries.length && run.entries[i].kind === "thinking"; i++) {
		out.push(run.entries[i]);
	}
	return out;
}

function tally(run: Run): { pending: number; failed: number } {
	let pending = 0;
	let failed = 0;
	for (const entry of run.entries) {
		if (!entry.done) pending++;
		if (entry.error) failed++;
	}
	return { pending, failed };
}

function background(pending: number, failed: number): Background {
	if (pending > 0) return "toolPendingBg";
	return failed > 0 ? "toolErrorBg" : "toolSuccessBg";
}

/** A chapter takes its colour from its latest result; failures it recovered from stay counted. */
function runBackground(run: Run): Background {
	if (run.entries.some((entry) => !entry.done)) return "toolPendingBg";
	return run.lastTool?.error ? "toolErrorBg" : "toolSuccessBg";
}

function expandHint(): string {
	const keys = getKeybindings().getKeys("app.tools.expand");
	return keys.length > 0 ? keys[0] : "ctrl+o";
}

/**
 * The one line an action takes, cut to `budget` cells. The suffix and the outcome are
 * structure worth keeping, so the action text is what gives way.
 */
function entryLine(entry: Entry, theme: Theme, budget: number): string {
	const separator = theme.fg("muted", " · ");
	const lead = entry.kind === "thinking" ? `${theme.fg("toolTitle", theme.bold("thinking"))} ` : "";
	let { main } = entry.header;
	const { suffix } = entry.header;
	let summary = entry.summary;
	const leadWidth = visibleWidth(lead);
	const room = Math.max(1, budget - leadWidth - visibleWidth(suffix) - (summary ? visibleWidth(separator) : 0));
	// A long outcome may not squeeze the action out of the row.
	const summaryRoom = Math.max(8, Math.floor(room * 0.4));
	if (summary && visibleWidth(summary) > summaryRoom) {
		summary = truncateToWidth(summary, summaryRoom, "…");
	}
	const mainRoom = Math.max(1, room - (summary ? visibleWidth(summary) : 0));
	if (visibleWidth(main) > mainRoom) {
		main = truncateToWidth(main, mainRoom, "…");
	}
	return `${lead}${main}${suffix}${summary ? separator + summary : ""}`;
}

/** A thinking action in full, for a row the user opened on its own. */
function thinkingDetail(entry: Entry, theme: Theme): string {
	const head = theme.fg("toolTitle", theme.bold("thinking"));
	const text = entry.message ? thinkingText(entry.message) : "";
	if (!text) {
		return head;
	}
	return `${head}\n${text
		.split("\n")
		.map((line) => theme.fg("muted", line))
		.join("\n")}`;
}

function groupLine(run: Run, pending: number, failed: number, theme: Theme, width: number): string {
	const tail = lastEntry(run);
	const count = run.entries.length;
	const separator = theme.fg("muted", " · ");
	const marker = theme.fg("muted", "▶");
	const lead: string[] = [];
	if (count > 1) lead.push(theme.fg("muted", `${count} actions`));
	// A red chapter already says its latest action failed; the count is for the failures before it.
	if (failed > 0 && !run.lastTool?.error) lead.push(theme.fg("error", `${failed} failed`));
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
class RowFrame implements Component {
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
class ChapterRow implements Component {
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
		const run = entry?.run;
		if (!run) {
			return [];
		}
		const { pending, failed } = tally(run);
		// One line, always: the row must never wrap.
		// One cell of slack: a single-line row must never reach the terminal's last cell.
		const inner = Math.max(1, width - this.outputPad * 2 - 1);
		const content = this.contentOf(run, entry, pending, failed, inner);
		if (content === undefined) {
			return [];
		}
		// A folded chapter carries its outcome; bookends stay neutral so no action can repaint them.
		const bg = this.kind === "chapter" ? runBackground(run) : NEUTRAL_BG;
		this.frame.setBgFn((text) => this.theme.bg(bg, text));
		this.line.setText(keepBackground(truncateToWidth(content, inner, "…")));
		return this.frame.render(width);
	}

	private contentOf(run: Run, entry: Entry, pending: number, failed: number, width: number): string | undefined {
		switch (this.kind) {
			case "chapter":
				// Only the newest tool row draws the folded chapter; the rest keep their own rows.
				return isChapterRow(entry) ? groupLine(run, pending, failed, this.theme, width) : undefined;
			case "header":
				return foldLine(run, this.theme, width, true);
			case "footer":
				// The footer sits under the newest row and only while the chapter is open on its own.
				return run.open && !expandedAll() && run.lastTool === entry
					? foldLine(run, this.theme, width, false)
					: undefined;
		}
	}

	invalidate(): void {}
}

/** The fold line at either end of an opened chapter: the same row, pointing the way it folds. */
function foldLine(run: Run, theme: Theme, width: number, open: boolean): string {
	const separator = theme.fg("muted", " · ");
	const parts: string[] = [];
	if (run.entries.length > 1) parts.push(theme.fg("muted", `${run.entries.length} actions`));
	parts.push(theme.fg("dim", "click to collapse"));
	const line = `${theme.fg("muted", open ? "▼" : "▲")} ${parts.join(separator)}`;
	const hint = theme.fg("dim", expandHint());
	return visibleWidth(line) + visibleWidth(separator) + visibleWidth(hint) <= width ? line + separator + hint : line;
}

function cut(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Longest prefix scanned for a gist; a first line longer than this is cut to a preview anyway. */
const GIST_SCAN = 4096;

/** The first non-empty line of a thinking block, stripped of markdown noise. */
function gist(text: string): string {
	const window = text.length > GIST_SCAN ? text.slice(0, GIST_SCAN) : text;
	let start = 0;
	while (start < window.length) {
		let end = window.indexOf("\n", start);
		if (end === -1) end = window.length;
		const line = window.slice(start, end).replace(/^[#>*\-\s]+/, "").trim();
		if (line) return cut(line, 200);
		start = end + 1;
	}
	return "";
}

/** Whether a message carries thinking worth a row. */
function hasThinking(message: MaybeMessage): boolean {
	return (
		Array.isArray(message.content) &&
		(message.content as ReadonlyArray<{ type: string; thinking?: string }>).some(
			(block) => block.type === "thinking" && typeof block.thinking === "string" && /\S/.test(block.thinking),
		)
	);
}

/** The one-line gist of a message's thinking, scanned without building the whole text. */
function thinkingGist(message: MaybeMessage): string {
	if (message.role !== "assistant" || !Array.isArray(message.content)) {
		return "";
	}
	for (const block of message.content as ReadonlyArray<{ type: string; thinking?: string }>) {
		if (block.type !== "thinking" || !block.thinking) {
			continue;
		}
		const line = gist(block.thinking);
		if (line) {
			return line;
		}
	}
	return "";
}

function shorten(path: string): string {
	const home = homedir();
	return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function argPath(args: Record<string, unknown>): string {
	const raw = args?.file_path ?? args?.path;
	return shorten(typeof raw === "string" ? raw : "");
}

function outputOf(result: Result): string {
	return result.content.flatMap((block) => (block.type === "text" ? [block.text ?? ""] : [])).join("\n");
}

function diffStat(diff: string, theme: Theme): string {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) added++;
		else if (line.startsWith("-") && !line.startsWith("---")) removed++;
	}
	return `${theme.fg("success", `+${added}`)} ${theme.fg("error", `-${removed}`)}`;
}

function headerFor(toolName: string, raw: unknown, theme: Theme, argsComplete: boolean): Header {
	const args = (raw ?? {}) as Record<string, unknown>;
	const title = theme.fg("toolTitle", theme.bold(toolName));
	switch (toolName) {
		case "bash":
		case "powershell": {
			const command = typeof args.command === "string" ? args.command : "";
			const rows = command.split("\n").filter((line) => line.trim());
			const first = cut(rows[0] ?? "", COMMAND_CHARS);
			const rest = rows.length - 1;
			const prompt = toolName === "bash" ? "$" : ">";
			return {
				main: theme.fg("toolTitle", theme.bold(`${prompt} ${first || "..."}`)),
				suffix:
					(rest > 0 ? theme.fg("muted", `  (+${rest} lines)`) : "") +
					(typeof args.timeout === "number" ? theme.fg("muted", ` (timeout ${args.timeout}s)`) : ""),
			};
		}
		case "write": {
			const content = typeof args.content === "string" ? args.content : "";
			// Splitting a streaming file on every chunk is quadratic; count it once complete.
			const lines = argsComplete && content ? content.split("\n").length : 0;
			return {
				main: `${title} ${theme.fg("accent", argPath(args))}`,
				suffix: argsComplete ? theme.fg("muted", ` (${lines} lines)`) : "",
			};
		}
		case "edit":
			return { main: `${title} ${theme.fg("accent", argPath(args))}`, suffix: "" };
		case "read": {
			const offset = typeof args.offset === "number" ? args.offset : undefined;
			const limit = typeof args.limit === "number" ? args.limit : undefined;
			const range =
				offset === undefined && limit === undefined
					? ""
					: theme.fg("warning", `:${offset ?? 1}${limit === undefined ? "" : `-${(offset ?? 1) + limit - 1}`}`);
			return { main: `${title} ${theme.fg("accent", argPath(args))}`, suffix: range };
		}
		case "grep":
		case "find": {
			const pattern = typeof args.pattern === "string" ? args.pattern : "";
			const where = shorten(typeof args.path === "string" ? args.path : ".");
			const shown = toolName === "grep" ? `/${pattern}/` : pattern;
			return { main: `${title} ${theme.fg("accent", shown)} ${theme.fg("muted", `in ${where}`)}`, suffix: "" };
		}
		case "ls":
			return { main: `${title} ${theme.fg("accent", shorten(typeof args.path === "string" ? args.path : "."))}`, suffix: "" };
		case "codemode":
			return { main: title, suffix: "" };
		default: {
			const pairs = Object.entries(args)
				.map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
				.join(" ");
			return { main: pairs ? `${title} ${theme.fg("muted", cut(pairs, HEADER_CHARS))}` : title, suffix: "" };
		}
	}
}

function summary(toolName: string, result: Result, theme: Theme, context: Context): string {
	const output = outputOf(result).trim();
	const lines = output ? output.split("\n").filter((line) => line.trim()).length : 0;

	if (context.isError) {
		return theme.fg("error", cut(output.split("\n").find((line) => line.trim()) ?? "failed", SUMMARY_CHARS));
	}

	if (HEADER_ONLY.has(toolName)) {
		return "";
	}

	const details = (result.details ?? {}) as {
		calls?: unknown[];
		diff?: string;
		truncation?: { truncated?: boolean };
	};
	// One line of output is worth showing verbatim; more is only worth counting.
	const counted = (many: string) =>
		lines <= 1 ? cut(output, SUMMARY_CHARS) : `${lines}${details.truncation?.truncated ? "+" : ""} ${many}`;
	const slow = context.durationMs !== undefined && context.durationMs >= 1000;
	const elapsed = slow ? theme.fg("muted", ` · ${(context.durationMs! / 1000).toFixed(1)}s`) : "";

	let plain = "";
	let styled: string | undefined;
	switch (toolName) {
		case "edit":
			styled = details.diff ? diffStat(details.diff, theme) : theme.fg("success", "applied");
			break;
		case "grep":
			plain = counted("matches");
			break;
		case "find":
			plain = counted("files");
			break;
		case "ls":
			plain = counted("entries");
			break;
		case "codemode": {
			const calls = details.calls?.length ?? 0;
			plain = calls ? `${calls} tool call${calls === 1 ? "" : "s"}` : counted("lines");
			break;
		}
		default:
			plain = counted("lines");
	}
	return (styled ?? theme.fg("muted", plain)) + elapsed;
}

interface Slots {
	/** Output padding the cached components were built with; a change drops them. */
	pad: number;
	chapter?: ChapterRow;
	empty?: Container;
	row?: RowFrame;
	noteFallback?: Text;
	frame?: Box;
	expandedCall?: Text;
	expandedStack?: Container;
	expandedBefore?: ThinkingRows;
	expandedAfter?: ThinkingRows;
	/** The tool's own call and result components, shown while the action row is open. */
	nativeCall?: Component;
	nativeResult?: Component;
	/** Whether the tool frames its own rows; nesting it in ours would double the padding. */
	nativeSelfFramed?: boolean;
	/** Regions that consume clicks in the expanded list so a gap cannot fold the row away. */
	stackRegion?: MouseRegion;
	afterRegion?: MouseRegion;
	actionRegion?: MouseRegion;
	/** The action slot: the summary frame or the tool's own row while open. */
	actionBox?: Container;
	/** The summary row's click target, which opens the whole chapter. */
	chapterRegion?: MouseRegion;
	/** The opened chapter's header row and its click target, which folds it back. */
	runHeader?: ChapterRow;
	runHeaderRegion?: MouseRegion;
	runStack?: Container;
	/** Dark line between the opened chapter's header and its first row. */
	runGap?: Spacer;
	/** The opened chapter's footer row and its click target, the same fold at the other end. */
	runFooter?: ChapterRow;
	runFooterRegion?: MouseRegion;
	runFooterStack?: Container;
	/** Dark line before the footer, like the gap between rows. */
	footGap?: Spacer;
	narrativeStack?: Container;
	narrativeBefore?: ThinkingRows;
	narrativeRegion?: MouseRegion;
	/** Components owned by the tool's own renderers, handed back so their caches survive. */
	builtinCall?: Component;
	builtinResult?: Component;
}

function slots(context: Context): Slots {
	const state = context.state as { zen?: Slots };
	if (!state.zen || state.zen.pad !== context.outputPad) {
		state.zen = { pad: context.outputPad };
	}
	return state.zen;
}

/**
 * The builtin renderers clear their own clock interval; zen never calls them, so a toggle
 * mid-stream would otherwise leave the interval redrawing forever.
 */
function stopStaleTimer(context: Context): void {
	const state = context.state as { interval?: ReturnType<typeof setInterval> };
	if (state.interval) {
		clearInterval(state.interval);
		state.interval = undefined;
	}
}

function chapterRow(context: Context, theme: Theme): Component {
	const state = slots(context);
	state.chapter ??= new ChapterRow(context.toolCallId, theme, context.outputPad);
	return state.chapter;
}

/** Clicking a chapter's summary row opens the whole chapter into its rows. */
function chapterClick(context: Context, entryId: string, child: Component): Component {
	const state = slots(context);
	state.chapterRegion ??= new MouseRegion(child, (event) => {
		// Look the entry up: a rebuild replaces entries after this region was built.
		const run = byId.get(entryId)?.run;
		if (event.type !== "click" || event.button !== "left" || !run || listMode(run)) {
			return undefined;
		}
		run.open = true;
		refreshRun(run);
		return { handled: true };
	});
	return state.chapterRegion;
}

/** A fold target at either end of an opened chapter: clicking it folds the rows away again. */
function runFoldClick(
	context: Context,
	entryId: string,
	child: Component,
	slot: "runHeaderRegion" | "runFooterRegion",
): Component {
	const state = slots(context);
	state[slot] ??= new MouseRegion(child, (event) => {
		const run = byId.get(entryId)?.run;
		if (event.type !== "click" || event.button !== "left" || !run?.open) {
			return undefined;
		}
		run.open = false;
		refreshRun(run);
		return { handled: true };
	});
	return state[slot];
}

/** Render through the tool's own renderer, never handing it a frame we drew ourselves. */
function delegated(
	context: Context,
	slot: "builtinCall" | "builtinResult",
	render: (context: Context) => Component,
): Component {
	const state = slots(context);
	const component = render({ ...context, lastComponent: state[slot] });
	state[slot] = component;
	return component;
}

/** The action row's frame: the summary line, or the tool's own row while it is open. */
function actionFrame(context: Context, theme: Theme, entry: Entry): Box {
	const state = slots(context);
	state.frame ??= new Box(context.outputPad, 1);
	const frame = state.frame;
	frame.setBgFn((line) => theme.bg(background(context.isPartial ? 1 : 0, context.isError ? 1 : 0), line));
	frame.clear();
	if (entry.open && listMode(entry.run) && state.nativeCall) {
		frame.addChild(state.nativeCall);
		if (state.nativeResult) {
			frame.addChild(state.nativeResult);
		}
		return frame;
	}
	state.expandedCall ??= new Text("", 0, 0);
	const text = state.expandedCall as Text;
	text.setText(entryLine(entry, theme, Infinity));
	frame.addChild(text);
	return frame;
}

/** Thinking's own background, distinct from every tool state so it cannot read as part of an action. */
const THINKING_BG = "customMessageBg";

/**
 * The thinking rows above or below a tool row, each in its own frame. Redrawn from live state,
 * so a row follows streaming thinking and stops drawing the moment a later tool takes it over.
 */
class ThinkingRows implements Component {
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
		const run = entry?.run;
		if (!entry || !run) {
			return [];
		}
		const blocks = this.after ? thinkingAfter(run, entry) : thinkingBefore(run, entry);
		if (blocks.length === 0) {
			this.rows.clear();
			this.layout = [];
			return [];
		}
		const inner = Math.max(1, width - this.outputPad * 2 - 1);
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
			const content = this.contentOf(block, inner);
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
		const run = byId.get(this.entryId)?.run;
		if (event.type !== "click" || event.button !== "left" || !listMode(run)) {
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

	/** One line while the transcript is expanded, the full block when the row was clicked open. */
	private contentOf(block: Entry, inner: number): string {
		if (!listMode(block.run) || block.open) {
			return thinkingDetail(block, this.theme);
		}
		return keepBackground(truncateToWidth(entryLine(block, this.theme, inner), inner, "…"));
	}

	invalidate(): void {
		this.rows.clear();
		this.layout = [];
	}
}

/** Consumes clicks in the expanded list so a gap or padding line cannot fold the whole row away. */
function consumeClick(
	context: Context,
	run: Run | undefined,
	child: Component,
	slot: "stackRegion" | "afterRegion" | "narrativeRegion",
): Component {
	const state = slots(context);
	state[slot] ??= new MouseRegion(child, (event) => {
		if (event.type !== "click" || event.button !== "left" || !listMode(run)) {
			return undefined;
		}
		return { handled: true };
	});
	return state[slot];
}

/** One tool row expanded: thinking above in the call slot, thinking after in the result slot. */
function expandedRow(context: Context, theme: Theme, entry: Entry, top: boolean): Component {
	const state = slots(context);
	if (!top) {
		state.expandedAfter ??= new ThinkingRows(entry.id, theme, context.outputPad, true, () => context.invalidate());
		return consumeClick(context, entry.run, state.expandedAfter, "afterRegion");
	}
	// The action slot holds either the zen summary frame or the tool's own row while open.
	state.actionBox ??= new Container();
	const action = state.actionBox;
	action.clear();
	if (entry.open && listMode(entry.run) && state.nativeCall && state.nativeSelfFramed) {
		action.addChild(state.nativeCall);
		if (state.nativeResult) {
			action.addChild(state.nativeResult);
		}
	} else {
		action.addChild(actionFrame(context, theme, entry));
	}
	state.actionRegion ??= new MouseRegion(action, (event) => {
		if (event.type !== "click" || event.button !== "left" || !listMode(entry.run)) {
			return undefined;
		}
		entry.open = !entry.open;
		context.invalidate();
		return { handled: true };
	});
	state.expandedBefore ??= new ThinkingRows(entry.id, theme, context.outputPad, false, () => context.invalidate());
	state.expandedStack ??= new Container();
	state.expandedStack.clear();
	state.expandedStack.addChild(state.expandedBefore);
	state.expandedStack.addChild(state.actionRegion);
	return consumeClick(context, entry.run, state.expandedStack, "stackRegion");
}

function rowFrame(context: Context, theme: Theme): RowFrame {
	const state = slots(context);
	state.row ??= new RowFrame(theme, context.outputPad);
	return state.row;
}

/** Second line for a narrative tool without renderers of its own, reused so the frame's child stays stable. */
function noteFallback(context: Context, result: Result, options: { expanded: boolean }, theme: Theme): Component {
	const state = slots(context);
	state.noteFallback ??= new Text("", 0, 0);
	const lines = outputOf(result)
		.trim()
		.split("\n")
		.filter((line) => line.trim())
		.slice(0, options.expanded ? Number.MAX_SAFE_INTEGER : 10);
	state.noteFallback.setText(lines.map((line) => theme.fg("toolOutput", line)).join("\n"));
	return state.noteFallback;
}

function fallbackResult(result: Result, options: { expanded: boolean }, theme: Theme): Component {
	const lines = outputOf(result)
		.trim()
		.split("\n")
		.filter((line) => line.trim());
	const shown = options.expanded ? lines : lines.slice(0, 10);
	const body = shown.map((line) => theme.fg("toolOutput", line)).join("\n");
	const rest = shown.length < lines.length ? `\n${theme.fg("muted", `... (${lines.length - shown.length} more lines)`)}` : "";
	return new Text(body + rest, 0, 0);
}

function fallbackCall(toolName: string, args: unknown, theme: Theme): string {
	const pairs = Object.entries((args ?? {}) as Record<string, unknown>)
		.map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
		.join(" ");
	return pairs
		? `${theme.fg("toolTitle", theme.bold(toolName))} ${theme.fg("muted", cut(pairs, HEADER_CHARS))}`
		: theme.fg("toolTitle", theme.bold(toolName));
}

/** Any message shape that can carry thinking blocks. */
interface MaybeMessage {
	role: string;
	content?: unknown;
}

/** Thinking a message carries, in one string. */
function thinkingText(message: MaybeMessage): string {
	if (message.role !== "assistant" || !Array.isArray(message.content)) {
		return "";
	}
	return (message.content as ReadonlyArray<{ type: string; thinking?: string }>)
		.filter((block) => block.type === "thinking" && block.thinking?.trim())
		.map((block) => (block.thinking ?? "").trim())
		.join("\n\n");
}

/** Fold a message's thinking into the chapter, as the action that is running now. */
function trackThinking(message: MaybeMessage): void {
	if (message.role !== "assistant" || !thinkingId || !hasThinking(message)) {
		return;
	}
	const entry = thinkingEntry(thinkingId);
	// Keep the message: the detail is read from it at render time, so a long block costs
	// one first-line scan per delta instead of rebuilding the whole text.
	entry.message = message;
	entry.header = { main: thinkingGist(message), suffix: "" };
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		zen = readZen();
		expandedAll = ctx.mode === "tui" ? () => ctx.ui.getToolsExpanded() : () => false;
		rebuild(ctx);
		applyThinkingLabel(ctx);
		watchExpandKey(ctx);
	});

	pi.on("session_shutdown", () => {
		stopExpandKey?.();
		stopExpandKey = undefined;
	});

	// A tree jump replaces the transcript; the chapters have to follow it.
	pi.on("session_tree", (_event, ctx) => rebuild(ctx));

	pi.on("message_start", (event) => {
		// The user's message opens a chapter; an assistant message opens a thinking block.
		if (event.message.role === "user") {
			current = undefined;
			thinkingId = undefined;
			return;
		}
		if (event.message.role === "assistant") {
			thinkingId = `thinking-${++thinkingCount}`;
		}
	});

	pi.on("message_update", (event) => trackThinking(event.message));
	pi.on("message_end", (event) => trackThinking(event.message));

	pi.registerCommand("zen", {
		description: "Toggle zen mode (one row per run)",
		handler: async (args, ctx) => {
			const wanted = args.trim().toLowerCase();
			zen = wanted === "on" ? true : wanted === "off" ? false : !zen;
			writeZen(zen);
			rebuild(ctx);
			applyThinkingLabel(ctx);
			// Redraw every row in place: toggling the expand state twice forces it.
			try {
				const expanded = ctx.ui.getToolsExpanded();
				ctx.ui.setToolsExpanded(!expanded);
				ctx.ui.setToolsExpanded(expanded);
				// Writing a status is the only available nudge for a redraw; clearing one
				// leaves the footer untouched.
				ctx.ui.setStatus("zen", undefined);
			} catch {
				// No interactive UI: the setting still applies to the next session.
			}
			if (ctx.hasUI) {
				ctx.ui.notify(`Zen mode ${zen ? "on — one row per run" : "off — pi's own rendering"}`, "info");
			}
		},
	});

	pi.registerToolRenderer((toolName, next) => {
		const builtin = next();

		// Rows draw their own frames, so the shell has to be self; a tool that frames
		// itself keeps its own when zen is off.
		const selfFramed = builtin?.renderShell === "self";

		return {
			...builtin,
			renderShell: "self",
			renderCall(args, theme, context) {
				const render = builtin?.renderCall;
				if (!zen) {
					const component = render
						? delegated(context, "builtinCall", (ctx) => render(args, theme, ctx))
						: new Text(fallbackCall(toolName, args, theme), 0, 0);
					if (selfFramed) {
						return component;
					}
					const frame = rowFrame(context, theme);
					frame.setCall(component, background(context.isPartial ? 1 : 0, context.isError ? 1 : 0));
					return frame;
				}
				if (narrative(toolName)) {
					// A narrative tool keeps its own row: it is the log, not the work.
					const entry = toolEntry(context.toolCallId, true);
					const component = render
						? delegated(context, "builtinCall", (ctx) => render(args, theme, ctx))
						: new Text(fallbackCall(toolName, args, theme), 0, 0);
					let row = component;
					if (!selfFramed) {
						const frame = rowFrame(context, theme);
						frame.setCall(component, background(context.isPartial ? 1 : 0, context.isError ? 1 : 0));
						row = frame;
					}
					if (!context.expanded) {
						return row;
					}
					const state = slots(context);
					state.narrativeBefore ??= new ThinkingRows(entry.id, theme, context.outputPad, false, () => context.invalidate());
					state.narrativeStack ??= new Container();
					state.narrativeStack.clear();
					state.narrativeStack.addChild(state.narrativeBefore);
					state.narrativeStack.addChild(row);
					return consumeClick(context, entry.run, state.narrativeStack, "narrativeRegion");
				}
				const entry = toolEntry(context.toolCallId, false);
				entry.header = headerFor(toolName, args, theme, context.argsComplete);
				invalidators.set(context.toolCallId, context.invalidate);
				const run = entry.run;
				if (!context.expanded && run?.open !== true) {
					return chapterClick(context, entry.id, chapterRow(context, theme));
				}
				if (entry.open && listMode(run)) {
					// The row is open: its frame shows the tool's own call instead of the summary line.
					const state = slots(context);
					state.nativeCall = render
						? delegated(context, "builtinCall", (ctx) => render(args, theme, ctx))
						: new Text(fallbackCall(toolName, args, theme), 0, 0);
					state.nativeSelfFramed = selfFramed;
				}
				const row = expandedRow(context, theme, entry, true);
				if (run?.open && !expandedAll() && firstToolOf(run) === entry) {
					// An opened chapter gets a header row, which folds it back on click.
					const state = slots(context);
					state.runHeader ??= new ChapterRow(entry.id, theme, context.outputPad, "header");
					state.runStack ??= new Container();
					state.runStack.clear();
					state.runStack.addChild(runFoldClick(context, entry.id, state.runHeader, "runHeaderRegion"));
					state.runStack.addChild((state.runGap ??= new Spacer(1)));
					state.runStack.addChild(row);
					return state.runStack;
				}
				return row;
			},
			renderResult(result, options, theme, context) {
				const render = builtin?.renderResult;
				if (!zen) {
					const component = render
						? delegated(context, "builtinResult", (ctx) => render(result, options, theme, ctx))
						: fallbackResult(result, options, theme);
					if (selfFramed) {
						return component;
					}
					const state = slots(context);
					rowFrame(context, theme).setResult(component, background(context.isPartial ? 1 : 0, context.isError ? 1 : 0));
					return (state.empty ??= new Container());
				}
				if (narrative(toolName)) {
					toolEntry(context.toolCallId, true);
					const component = render
						? delegated(context, "builtinResult", (ctx) => render(result, options, theme, ctx))
						: noteFallback(context, result, options, theme);
					if (selfFramed) {
						return component;
					}
					// The call slot owns the frame; it redraws with this line on the next draw.
					const state = slots(context);
					rowFrame(context, theme).setResult(component, background(context.isPartial ? 1 : 0, context.isError ? 1 : 0));
					return (state.empty ??= new Container());
				}
				const entry = toolEntry(context.toolCallId, false);
				entry.done = !options.isPartial;
				entry.error = context.isError;
				entry.summary = summary(toolName, result, theme, context);
				invalidators.set(context.toolCallId, context.invalidate);
				// The builtin renderers clear their own clock interval; zen never calls them, so do it here.
				stopStaleTimer(context);
				if (context.expanded || entry.run?.open === true) {
					const state = slots(context);
					if (entry.open && listMode(entry.run)) {
						// The row is open: append the tool's own result under its call.
						state.nativeResult = render
							? delegated(context, "builtinResult", (ctx) => render(result, { ...options, expanded: true }, theme, ctx))
							: fallbackResult(result, { ...options, expanded: true }, theme);
						actionFrame(context, theme, entry);
					}
					const row = expandedRow(context, theme, entry, false);
					const run = entry.run;
					if (!run?.open || expandedAll() || run.lastTool !== entry) {
						return row;
					}
					state.runFooter ??= new ChapterRow(entry.id, theme, context.outputPad, "footer");
					state.runFooterStack ??= new Container();
					state.runFooterStack.clear();
					state.runFooterStack.addChild(row);
					state.runFooterStack.addChild((state.footGap ??= new Spacer(1)));
					state.runFooterStack.addChild(runFoldClick(context, entry.id, state.runFooter, "runFooterRegion"));
					return state.runFooterStack;
				}
				// The call slot draws the chapter row; this one stays empty so it is drawn once.
				const state = slots(context);
				state.empty ??= new Container();
				return state.empty;
			},
		};
	});
}

/** A collapsed thinking row is still a row; zen folds it, and restores it when off. */
function applyThinkingLabel(ctx: ExtensionContext): void {
	if (ctx.mode !== "tui") {
		return;
	}
	if (!zen) {
		ctx.ui.setHiddenThinkingLabel(undefined);
		return;
	}
	// An unpatched pi renders an empty label as a blank row, which is worse than the label.
	if (piOmitsHiddenThinking()) {
		ctx.ui.setHiddenThinkingLabel("");
		return;
	}
	ctx.ui.setHiddenThinkingLabel(undefined);
	if (!warnedAboutPatch) {
		warnedAboutPatch = true;
		ctx.ui.notify("zen: this pi has no thinking-omission patch; run zen-install-pi.sh, then restart pi", "warning");
	}
}

/** Whether the installed pi can drop a hidden thinking row instead of drawing a blank one. */
function piOmitsHiddenThinking(): boolean {
	try {
		const release = readFileSync(join(AGENT_DIR, "install", "current-version"), "utf8").trim();
		const module = join(
			AGENT_DIR,
			"install",
			"releases",
			release,
			"node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/assistant-message.js",
		);
		return readFileSync(module, "utf8").includes('hiddenThinkingLabel === ""');
	} catch {
		return false;
	}
}

/** Group the stored actions the way the transcript would have grouped them live. */
/** Chapters opened by hand, so one key can fold all of them. */
function openRuns(): Run[] {
	const open = new Set<Run>();
	for (const entry of byId.values()) {
		if (entry.run?.open === true) {
			open.add(entry.run);
		}
	}
	return [...open];
}

/**
 * ctrl+o folds what is open before it expands: with a chapter open, the key meant to hide it would
 * otherwise expand every chapter. Nothing opened by hand leaves the key to the core toggle.
 */
function watchExpandKey(ctx: ExtensionContext): void {
	if (ctx.mode !== "tui") {
		return;
	}
	stopExpandKey?.();
	stopExpandKey = ctx.ui.onTerminalInput((data) => {
		if (!zen || !getKeybindings().matches(data, "app.tools.expand")) {
			return undefined;
		}
		const open = openRuns();
		if (open.length === 0) {
			return undefined;
		}
		for (const run of open) {
			run.open = false;
			refreshRun(run);
		}
		if (expandedAll()) {
			ctx.ui.setToolsExpanded(false);
		}
		return { consume: true };
	});
}

function rebuild(ctx: ExtensionContext): void {
	byId.clear();
	current = undefined;
	thinkingId = undefined;
	for (const entry of ctx.sessionManager.buildContextEntries()) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "user") {
			current = undefined;
			continue;
		}
		if (message.role !== "assistant") continue;
		if (hasThinking(message)) {
			const thinking = thinkingEntry(`thinking-${++thinkingCount}`);
			thinking.message = message;
			thinking.header = { main: thinkingGist(message), suffix: "" };
		}
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content as ReadonlyArray<{ type: string; id?: string; name?: string }>) {
			if (block.type === "toolCall" && typeof block.id === "string") {
				toolEntry(block.id, narrative(block.name ?? ""));
			}
		}
	}
}

function readZen(): boolean {
	try {
		return (JSON.parse(readFileSync(STATE_FILE, "utf8")) as { enabled?: boolean }).enabled !== false;
	} catch {
		return true;
	}
}

function writeZen(enabled: boolean): void {
	try {
		mkdirSync(dirname(STATE_FILE), { recursive: true });
		writeFileSync(STATE_FILE, `${JSON.stringify({ enabled }, null, 2)}\n`);
	} catch {
		// A missing settings file only costs the preference.
	}
}
