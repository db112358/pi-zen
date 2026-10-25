/**
 * Zen mode: one row per chapter.
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
import { Box, Container, getKeybindings, MouseRegion, Spacer, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { ChapterRow, ChatThinkingRow, RowFrame, ThinkingRows, entryLine } from "./lib/components";
import { actionHeader, blocksOf, fallbackCall, outputLines, resultSummary, type MaybeMessage } from "./lib/format";
import {
	background,
	beginThinking,
	byId,
	endChapter,
	entryForMessage,
	expandedAll,
	firstToolOf,
	foldThinking,
	invalidators,
	openChapters,
	rebuild as rebuildModel,
	refreshChapter,
	rowsShown,
	setExpandedAll,
	takingOver,
	toolEntry,
	type Background,
	type Chapter,
	type ToolEntry,
} from "./lib/model";
import { narrative } from "./lib/tools";

type Context = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];
type Result = Parameters<NonNullable<ToolRenderers["renderResult"]>>[0];
type ResultOptions = Parameters<NonNullable<ToolRenderers["renderResult"]>>[1];

/**
 * pi's `setThinkingRow` shape, so zen loads against a build without the hook. Its `expanded` is
 * thinking visibility, on by default, not whether the row is open.
 */
type ThinkingRowRenderer = (
	message: MaybeMessage,
	options: { expanded: boolean; outputPad: number },
	theme: Theme,
) => Component | undefined;

/** Lines a collapsed fallback row shows. */
const FALLBACK_LINES = 10;
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const STATE_FILE = join(AGENT_DIR, "extensions", "zen.json");

let zen = true;
/** Thinking gist on the working line, while the chapter has no row to draw it on. */
let workingGist: string | undefined;
/** Whether pi omits thinking, and whether zen draws the row in its place. */
let omitsThinking = false;
let useChatRow = false;
/** pi's `setThinkingRow`, when the installed build has one. */
let thinkingRowHook: ((renderer: ThinkingRowRenderer | undefined) => void) | undefined;
/** One purple row per message, kept across the rebuild every delta causes. */
let chatRows = new WeakMap<object, { pad: number; row: ChatThinkingRow }>();
/** Detaches the terminal-input listener that makes ctrl+o fold before it expands. */
let stopExpandKey: (() => void) | undefined;
let warnedAboutPatch = false;

/** Whether a message carries a tool call: the action that will draw its thinking. */
function carriesToolCall(message: MaybeMessage): boolean {
	return blocksOf(message).some((block) => block.type === "toolCall");
}

/** Whether the message holds only thinking so far, so the working line can stand in for it. */
function thinkingOnly(message: MaybeMessage): boolean {
	return !carriesToolCall(message) && !blocksOf(message).some((block) => block.type === "text" && block.text?.trim());
}

/**
 * Without the row hook a chapter's first thinking has no transcript row, so the working line carries
 * its gist until a tool call gives it one. Cut so the line cannot wrap.
 */
function showWorkingGist(ctx: ExtensionContext, gist: string | undefined): void {
	// Plain text: the resets truncation adds would end the row's colour early.
	const text =
		gist === undefined
			? undefined
			: `thinking ${truncateToWidth(gist, Math.max(20, (process.stdout.columns ?? 80) - 16), "…").replace(/\u001b\[0m/g, "")}`;
	if (ctx.mode !== "tui" || workingGist === text) {
		return;
	}
	workingGist = text;
	ctx.ui.setWorkingMessage(text);
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
	/** Regions that consume clicks in the expanded rows so a gap cannot fold the row away. */
	stackRegion?: MouseRegion;
	afterRegion?: MouseRegion;
	actionRegion?: MouseRegion;
	/** The action slot: the action frame or the tool's own row while open. */
	actionBox?: Container;
	/** The folded chapter row's click target, which opens the whole chapter. */
	chapterRegion?: MouseRegion;
	/** The opened chapter's header row and its click target, which folds it back. */
	chapterHeader?: ChapterRow;
	chapterHeaderRegion?: MouseRegion;
	chapterStack?: Container;
	/** Dark line between the opened chapter's header and its first row. */
	chapterGap?: Spacer;
	/** The opened chapter's footer row and its click target, the same fold at the other end. */
	chapterFooter?: ChapterRow;
	chapterFooterRegion?: MouseRegion;
	chapterFooterStack?: Container;
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

/** Clicking a chapter's folded row opens the whole chapter into its rows. */
function chapterClick(context: Context, entryId: string, child: Component): Component {
	const state = slots(context);
	state.chapterRegion ??= new MouseRegion(child, (event) => {
		// Look the entry up: a rebuild replaces entries after this region was built.
		const chapter = byId.get(entryId)?.chapter;
		if (event.type !== "click" || event.button !== "left" || !chapter || rowsShown(chapter)) {
			return undefined;
		}
		chapter.open = true;
		refreshChapter(chapter);
		return { handled: true };
	});
	return state.chapterRegion;
}

/** A fold target at either end of an opened chapter: clicking it folds the rows away again. */
function chapterFoldClick(
	context: Context,
	entryId: string,
	child: Component,
	slot: "chapterHeaderRegion" | "chapterFooterRegion",
): Component {
	const state = slots(context);
	state[slot] ??= new MouseRegion(child, (event) => {
		const chapter = byId.get(entryId)?.chapter;
		if (event.type !== "click" || event.button !== "left" || !chapter?.open) {
			return undefined;
		}
		chapter.open = false;
		refreshChapter(chapter);
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

interface NativeAction {
	call: Component;
	result?: Component;
	/** Whether the tool frames its own rows; nesting it in ours would double the padding. */
	selfFramed: boolean;
}

/** Whether the open row shows the tool's own call and result in place of the zen action line. */
function showsNative(entry: ToolEntry): boolean {
	return entry.open === true && rowsShown(entry.chapter);
}

/** The tool's own call and result, once the call slot has built them. */
function nativeAction(context: Context, entry: ToolEntry): NativeAction | undefined {
	const state = slots(context);
	return showsNative(entry) && state.nativeCall
		? { call: state.nativeCall, result: state.nativeResult, selfFramed: state.nativeSelfFramed === true }
		: undefined;
}

/** The action row's frame: the action line, or the tool's own row while it is open. */
function actionFrame(context: Context, theme: Theme, entry: ToolEntry): Box {
	const state = slots(context);
	state.frame ??= new Box(context.outputPad, 1);
	const frame = state.frame;
	frame.setBgFn((line) => theme.bg(rowBackground(context), line));
	frame.clear();
	const native = nativeAction(context, entry);
	if (native) {
		frame.addChild(native.call);
		if (native.result) {
			frame.addChild(native.result);
		}
		return frame;
	}
	state.expandedCall ??= new Text("", 0, 0);
	const text = state.expandedCall as Text;
	text.setText(entryLine(entry, theme, Infinity));
	frame.addChild(text);
	return frame;
}

/** Whether the message's first tool call draws its thinking on a chapter row, not a narrative one. */
function carriesChapterToolCall(message: MaybeMessage): boolean {
	const first = blocksOf(message).find((block) => block.type === "toolCall");
	return first !== undefined && !narrative(first.name ?? "");
}

/**
 * The row pi draws for a message whose thinking it omits, while no chapter row has taken it over.
 * It ignores `expanded`, which is thinking visibility and on by default: honouring it would unfold
 * every chat row and unpin the gist. Only a click opens one.
 */
function chatThinkingRow(
	message: MaybeMessage,
	options: { expanded: boolean; outputPad: number },
	theme: Theme,
): Component | undefined {
	const entry = entryForMessage(message);
	if (!zen || !entry || takingOver(entry.chapter) || carriesChapterToolCall(message)) {
		return undefined;
	}
	let cached = chatRows.get(message);
	if (!cached || cached.pad !== options.outputPad) {
		cached = { pad: options.outputPad, row: new ChatThinkingRow(entry.id, theme, options.outputPad, refreshChatRow) };
		chatRows.set(message, cached);
	}
	return cached.row;
}

/** Redraw the chat's thinking rows: they have no invalidator to hand pi. */
function refreshChatRow(): void {
	thinkingRowHook?.(useChatRow ? chatThinkingRow : undefined);
}

/** Consumes clicks in the expanded rows so a gap or padding line cannot fold the whole row away. */
function consumeClick(
	context: Context,
	chapter: Chapter | undefined,
	child: Component,
	slot: "stackRegion" | "afterRegion" | "narrativeRegion",
): Component {
	const state = slots(context);
	state[slot] ??= new MouseRegion(child, (event) => {
		if (event.type !== "click" || event.button !== "left" || !rowsShown(chapter)) {
			return undefined;
		}
		return { handled: true };
	});
	return state[slot];
}

/** Fill a cached container from its children, in place so a pre-rebuild component keeps drawing it. */
function restack(container: Container, children: Component[]): Container {
	container.clear();
	for (const child of children) {
		container.addChild(child);
	}
	return container;
}

/** One tool row expanded: thinking above in the call slot, thinking after in the result slot. */
function expandedRow(context: Context, theme: Theme, entry: ToolEntry, top: boolean): Component {
	const state = slots(context);
	if (!top) {
		state.expandedAfter ??= new ThinkingRows(entry.id, theme, context.outputPad, true, () => context.invalidate());
		return consumeClick(context, entry.chapter, state.expandedAfter, "afterRegion");
	}
	// The action slot holds either the zen action frame or the tool's own row while open.
	state.actionBox ??= new Container();
	const action = state.actionBox;
	const native = nativeAction(context, entry);
	action.clear();
	if (native?.selfFramed) {
		action.addChild(native.call);
		if (native.result) {
			action.addChild(native.result);
		}
	} else {
		action.addChild(actionFrame(context, theme, entry));
	}
	state.actionRegion ??= new MouseRegion(action, (event) => {
		if (event.type !== "click" || event.button !== "left" || !rowsShown(entry.chapter)) {
			return undefined;
		}
		entry.open = !entry.open;
		context.invalidate();
		return { handled: true };
	});
	state.expandedBefore ??= new ThinkingRows(entry.id, theme, context.outputPad, false, () => context.invalidate());
	state.expandedStack ??= new Container();
	return consumeClick(
		context,
		entry.chapter,
		restack(state.expandedStack, [state.expandedBefore, state.actionRegion]),
		"stackRegion",
	);
}

function rowFrame(context: Context, theme: Theme): RowFrame {
	const state = slots(context);
	state.row ??= new RowFrame(theme, context.outputPad);
	return state.row;
}

/** Pending while the action runs, red when it failed. */
function rowBackground(context: Context): Background {
	return background(context.isPartial ? 1 : 0, context.isError ? 1 : 0);
}

/** The tool's own call component, or zen's fallback line when it ships no renderer. */
function builtinCall(
	context: Context,
	args: unknown,
	theme: Theme,
	toolName: string,
	render: ToolRenderers["renderCall"],
): Component {
	return render
		? delegated(context, "builtinCall", (ctx) => render(args, theme, ctx))
		: new Text(fallbackCall(toolName, args, theme), 0, 0);
}

/** The tool's own result component, or the fallback the caller builds when it ships no renderer. */
function builtinResult(
	context: Context,
	result: Result,
	options: ResultOptions,
	theme: Theme,
	render: ToolRenderers["renderResult"],
	fallback: () => Component,
): Component {
	return render
		? delegated(context, "builtinResult", (ctx) => render(result, options, theme, ctx))
		: fallback();
}

/** The call slot returns zen's frame, or the builtin's own row when it frames itself. */
function framedCall(context: Context, theme: Theme, component: Component, selfFramed: boolean): Component {
	if (selfFramed) {
		return component;
	}
	const frame = rowFrame(context, theme);
	frame.setCall(component, rowBackground(context));
	return frame;
}

/** The result joins the call slot's frame; this slot stays empty so the row draws once. */
function framedResult(context: Context, theme: Theme, component: Component, selfFramed: boolean): Component {
	if (selfFramed) {
		return component;
	}
	rowFrame(context, theme).setResult(component, rowBackground(context));
	return emptySlot(context);
}

/** The empty result slot, reused so a row's tree stays stable. */
function emptySlot(context: Context): Component {
	const state = slots(context);
	return (state.empty ??= new Container());
}

function shownLines(result: Result, expanded: boolean): { shown: string[]; hidden: number } {
	const lines = outputLines(result);
	const shown = expanded ? lines : lines.slice(0, FALLBACK_LINES);
	return { shown, hidden: lines.length - shown.length };
}

/** Shown lines, styled as tool output. */
function outputBody(shown: string[], theme: Theme): string {
	return shown.map((line) => theme.fg("toolOutput", line)).join("\n");
}

/** Second line for a narrative tool without renderers of its own, reused so the frame's child stays stable. */
function noteFallback(context: Context, result: Result, options: { expanded: boolean }, theme: Theme): Component {
	const state = slots(context);
	state.noteFallback ??= new Text("", 0, 0);
	state.noteFallback.setText(outputBody(shownLines(result, options.expanded).shown, theme));
	return state.noteFallback;
}

function fallbackResult(result: Result, options: { expanded: boolean }, theme: Theme): Component {
	const { shown, hidden } = shownLines(result, options.expanded);
	const rest = hidden > 0 ? `\n${theme.fg("muted", `... (${hidden} more lines)`)}` : "";
	return new Text(outputBody(shown, theme) + rest, 0, 0);
}

/** Fold a message's thinking into the chapter and keep the working line in step. */
function trackThinking(message: MaybeMessage, ctx: ExtensionContext): void {
	const entry = foldThinking(message);
	if (!entry) {
		return;
	}
	// A later message trails a chapter row that draws its thinking; with the hook pi draws the row itself.
	const carried =
		zen && omitsThinking && !useChatRow && !entry.chapter?.lastTool && thinkingOnly(message) ? entry.actionHeader.main : "";
	showWorkingGist(ctx, carried || undefined);
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		zen = readZen();
		// Renders may outlive the ctx; the ui object does not go stale.
		const ui = ctx.mode === "tui" ? ctx.ui : undefined;
		setExpandedAll(ui ? () => ui.getToolsExpanded() : () => false);
		applyZenUI(ctx);
		watchExpandKey(ctx);
	});

	pi.on("session_shutdown", () => {
		stopExpandKey?.();
		stopExpandKey = undefined;
		// The UI goes away with the session; only the cached text has to forget it.
		workingGist = undefined;
	});

	// A tree jump replaces the transcript; the chapters have to follow it.
	pi.on("session_tree", (_event, ctx) => rebuild(ctx));

	pi.on("message_start", (event) => {
		// The user's message opens a chapter; an assistant message opens a thinking block.
		if (event.message.role === "user") {
			endChapter();
			return;
		}
		if (event.message.role === "assistant") {
			beginThinking();
		}
	});

	pi.on("message_update", (event, ctx) => trackThinking(event.message, ctx));
	pi.on("message_end", (event, ctx) => trackThinking(event.message, ctx));
	// Each model request starts from a clean line; the first thinking sets it again.
	pi.on("turn_start", (_event, ctx) => showWorkingGist(ctx, undefined));
	pi.on("agent_end", (_event, ctx) => showWorkingGist(ctx, undefined));

	pi.registerCommand("zen", {
		description: "Toggle zen mode (one row per chapter)",
		handler: async (args, ctx) => {
			const wanted = args.trim().toLowerCase();
			zen = wanted === "on" ? true : wanted === "off" ? false : !zen;
			writeZen(zen);
			applyZenUI(ctx);
			nudgeRedraw(ctx);
			if (ctx.hasUI) {
				ctx.ui.notify(`Zen mode ${zen ? "on — one row per chapter" : "off — pi's own rendering"}`, "info");
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
				// Zen off and a narrative tool both draw the tool's own row; only the log takes the thinking.
				if (!zen || narrative(toolName)) {
					const entry = zen ? toolEntry(context.toolCallId, true) : undefined;
					const row = framedCall(context, theme, builtinCall(context, args, theme, toolName, render), selfFramed);
					// With the hook the chat row above already draws it.
					if (!entry || !context.expanded || useChatRow) {
						return row;
					}
					const state = slots(context);
					state.narrativeBefore ??= new ThinkingRows(entry.id, theme, context.outputPad, false, () => context.invalidate());
					state.narrativeStack ??= new Container();
					return consumeClick(
						context,
						entry.chapter,
						restack(state.narrativeStack, [state.narrativeBefore, row]),
						"narrativeRegion",
					);
				}
				const entry = toolEntry(context.toolCallId, false);
				entry.actionHeader = actionHeader(toolName, args, theme, context.argsComplete);
				invalidators.set(context.toolCallId, context.invalidate);
				const chapter = entry.chapter;
				if (!context.expanded && chapter?.open !== true) {
					return chapterClick(context, entry.id, chapterRow(context, theme));
				}
				if (showsNative(entry)) {
					const state = slots(context);
					state.nativeCall = builtinCall(context, args, theme, toolName, render);
					state.nativeSelfFramed = selfFramed;
				}
				const row = expandedRow(context, theme, entry, true);
				if (chapter?.open && !expandedAll() && firstToolOf(chapter) === entry) {
					// An opened chapter gets a header row, which folds it back on click.
					const state = slots(context);
					state.chapterHeader ??= new ChapterRow(entry.id, theme, context.outputPad, "header");
					state.chapterGap ??= new Spacer(1);
					state.chapterStack ??= new Container();
					return restack(state.chapterStack, [
						chapterFoldClick(context, entry.id, state.chapterHeader, "chapterHeaderRegion"),
						state.chapterGap,
						row,
					]);
				}
				return row;
			},
			renderResult(result, options, theme, context) {
				const render = builtin?.renderResult;
				const narrativeRow = zen && narrative(toolName);
				if (!zen || narrativeRow) {
					if (narrativeRow) toolEntry(context.toolCallId, true);
					const fallback = narrativeRow
						? () => noteFallback(context, result, options, theme)
						: () => fallbackResult(result, options, theme);
					return framedResult(context, theme, builtinResult(context, result, options, theme, render, fallback), selfFramed);
				}
				const entry = toolEntry(context.toolCallId, false);
				entry.done = !options.isPartial;
				entry.error = context.isError;
				entry.resultSummary = resultSummary(toolName, result, theme, context);
				invalidators.set(context.toolCallId, context.invalidate);
				// The builtin renderers clear their own clock interval; zen never calls them, so do it here.
				stopStaleTimer(context);
				if (context.expanded || entry.chapter?.open === true) {
					const state = slots(context);
					if (showsNative(entry)) {
						// Append the tool's own result under its call.
						const nativeOptions = { ...options, expanded: true };
						const fallback = () => fallbackResult(result, nativeOptions, theme);
						state.nativeResult = builtinResult(context, result, nativeOptions, theme, render, fallback);
						actionFrame(context, theme, entry);
					}
					const row = expandedRow(context, theme, entry, false);
					const chapter = entry.chapter;
					if (!chapter?.open || expandedAll() || chapter.lastTool !== entry) {
						return row;
					}
					state.chapterFooter ??= new ChapterRow(entry.id, theme, context.outputPad, "footer");
					state.footGap ??= new Spacer(1);
					state.chapterFooterStack ??= new Container();
					return restack(state.chapterFooterStack, [
						row,
						state.footGap,
						chapterFoldClick(context, entry.id, state.chapterFooter, "chapterFooterRegion"),
					]);
				}
				// The call slot draws the chapter row; this one stays empty so it is drawn once.
				return emptySlot(context);
			},
		};
	});
}

/** A collapsed thinking row is still a row; zen folds it, and restores it when off. */
function applyThinkingLabel(ctx: ExtensionContext): void {
	omitsThinking = zen && ctx.mode === "tui" && piOmitsHiddenThinking();
	if (ctx.mode !== "tui") {
		return;
	}
	if (!zen) {
		ctx.ui.setHiddenThinkingLabel(undefined);
		return;
	}
	// An unpatched pi renders an empty label as a blank row, which is worse than the label.
	if (omitsThinking) {
		ctx.ui.setHiddenThinkingLabel("");
		return;
	}
	ctx.ui.setHiddenThinkingLabel(undefined);
	if (!warnedAboutPatch) {
		warnedAboutPatch = true;
		ctx.ui.notify("zen: this pi has no thinking-omission patch; run zen-install-pi.sh, then restart pi", "warning");
	}
}

/** Hand pi the purple row that replaces omitted thinking, when the installed build has the hook. */
function applyThinkingRow(ctx: ExtensionContext): void {
	if (ctx.mode !== "tui") {
		return;
	}
	const ui = ctx.ui as typeof ctx.ui & {
		setThinkingRow?: (renderer: ThinkingRowRenderer | undefined) => void;
	};
	thinkingRowHook = ui.setThinkingRow ? (renderer) => ui.setThinkingRow?.(renderer) : undefined;
	useChatRow = omitsThinking && thinkingRowHook !== undefined;
	thinkingRowHook?.(useChatRow ? chatThinkingRow : undefined);
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

/** Rebuild the model and apply zen's rendering to the live UI. */
function applyZenUI(ctx: ExtensionContext): void {
	rebuild(ctx);
	applyThinkingLabel(ctx);
	applyThinkingRow(ctx);
	showWorkingGist(ctx, undefined);
}

/** Redraw every row in place: toggling the expand state twice forces it. */
function nudgeRedraw(ctx: ExtensionContext): void {
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
	// The listener can outlive the ctx; the ui object does not go stale.
	const ui = ctx.ui;
	stopExpandKey = ui.onTerminalInput((data) => {
		if (!zen || !getKeybindings().matches(data, "app.tools.expand")) {
			return undefined;
		}
		const open = openChapters();
		if (open.length === 0) {
			return undefined;
		}
		for (const chapter of open) {
			chapter.open = false;
			refreshChapter(chapter);
		}
		if (expandedAll()) {
			ui.setToolsExpanded(false);
		}
		return { consume: true };
	});
}

/** Rebuild the model; the chat rows go with the messages a tree jump replaces. */
function rebuild(ctx: ExtensionContext): void {
	rebuildModel(ctx);
	chatRows = new WeakMap();
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
