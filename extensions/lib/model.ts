/**
 * The chapter model: entries grouped into chapters, plus the maps a row built
 * earlier reads at draw time. Nothing here renders.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { blocksOf, thinkingGist, type ActionHeader, type MaybeMessage } from "./format";

/** A row's colour: running, failed, or done. */
export type Background = "toolPendingBg" | "toolErrorBg" | "toolSuccessBg";

/** Tools that head a chapter and keep their own row: their result is the narrative. */
const NARRATIVE = new Set(["set_andon"]);

export function narrative(toolName: string): boolean {
	return NARRATIVE.has(toolName);
}

/** The fields both kinds of row carry. */
interface BaseEntry {
	id: string;
	/** Chapter this entry belongs to; a narrative row stands alone. */
	chapter: Chapter | undefined;
	/** One line, styled: the part that may be cut, and the suffix that should survive. */
	actionHeader: ActionHeader;
	/** Whether the row is open: thinking shown in full, or the tool's own row. */
	open?: boolean;
}

/** A tool call's row: what it ran, and the state of its result. */
export interface ToolEntry extends BaseEntry {
	kind: "tool";
	/** Styled result summary. */
	resultSummary: string;
	/** Narrative rows never take a thinking row over. */
	narrative: boolean;
	done: boolean;
	error: boolean;
}

/** A thinking block's row; it keeps the message so a delta costs one gist scan, not a text rebuild. */
export interface ThinkingEntry extends BaseEntry {
	kind: "thinking";
	message: MaybeMessage;
}

/** One action: a tool call or a thinking block. */
export type Entry = ToolEntry | ThinkingEntry;

/** Everything since the last user message or narrative row, drawn as one row. */
export interface Chapter {
	entries: Entry[];
	/** Newest tool row; kept here so the chapter check stays O(1). */
	lastTool?: ToolEntry;
	/** Whether this chapter alone is expanded into its rows, outside ctrl+o. */
	open?: boolean;
}

/** Whether an entry is a tool call's row. */
function isTool(entry: Entry): entry is ToolEntry {
	return entry.kind === "tool";
}

export const byId = new Map<string, Entry>();
/** Redraw callbacks by tool call id; a rebuild prunes the ids it did not keep. */
export const invalidators = new Map<string, () => void>();
let current: Chapter | undefined;
let thinkingId: string | undefined;
let thinkingCount = 0;
/** A message's thinking entry, so its chat row finds it after streaming. */
let messageEntries = new WeakMap<object, ThinkingEntry>();
/** Whether the transcript shows tool output expanded, as opposed to one clicked row. */
let expandReader = (): boolean => false;

/** Point the model at the live expand state, read at draw time. */
export function setExpandedAll(read: () => boolean): void {
	expandReader = read;
}

/** Whether the transcript shows tool output expanded, as opposed to one clicked row. */
export function expandedAll(): boolean {
	return expandReader();
}

/** Whether a chapter's rows are shown: every chapter expanded, or this one opened on its own. */
export function rowsShown(chapter: Chapter | undefined): boolean {
	return expandedAll() || chapter?.open === true;
}

export function firstToolOf(chapter: Chapter): ToolEntry | undefined {
	return chapter.entries.find(isTool);
}

/** Redraw every row of a chapter after its open state changed. */
export function refreshChapter(chapter: Chapter): void {
	for (const entry of chapter.entries) {
		invalidators.get(entry.id)?.();
	}
}

/** Chapters opened by hand, so one key can fold all of them. */
export function openChapters(): Chapter[] {
	const open = new Set<Chapter>();
	for (const entry of byId.values()) {
		if (entry.chapter?.open === true) {
			open.add(entry.chapter);
		}
	}
	return [...open];
}

export function toolEntry(toolCallId: string, standalone: boolean): ToolEntry {
	const existing = byId.get(toolCallId);
	if (existing?.kind === "tool") {
		return existing;
	}
	const entry: ToolEntry = { id: toolCallId, kind: "tool", chapter: undefined, actionHeader: { main: "", suffix: "" }, resultSummary: "", done: false, error: false, narrative: standalone };
	if (standalone) {
		// A narrative row heads its own chapter and takes the thinking that led to it, which
		// otherwise would only have the chat row to draw it.
		const chapter: Chapter = { entries: [] };
		entry.chapter = chapter;
		if (current) {
			let split = current.entries.length;
			while (split > 0 && current.entries[split - 1].kind === "thinking") {
				split--;
			}
			for (const pending of current.entries.splice(split)) {
				pending.chapter = chapter;
				chapter.entries.push(pending);
			}
		}
		chapter.entries.push(entry);
		chapter.lastTool = entry;
		current = undefined;
	} else {
		const chapter = (current ??= { entries: [] });
		entry.chapter = chapter;
		chapter.entries.push(entry);
		// Move the marker first: the old row must redraw without the footer.
		const previous = chapter.lastTool;
		chapter.lastTool = entry;
		if (previous) invalidators.get(previous.id)?.();
	}
	byId.set(toolCallId, entry);
	return entry;
}

function thinkingEntry(id: string, message: MaybeMessage): ThinkingEntry {
	const actionHeader = { main: thinkingGist(message), suffix: "" };
	const existing = byId.get(id);
	if (existing?.kind === "thinking") {
		// Streaming replaces the message the detail is read from, and its gist.
		existing.message = message;
		existing.actionHeader = actionHeader;
		return existing;
	}
	const chapter = (current ??= { entries: [] });
	const entry: ThinkingEntry = { id, kind: "thinking", chapter, actionHeader, message };
	chapter.entries.push(entry);
	byId.set(id, entry);
	return entry;
}

/** A user message ends the chapter: the next tool or thinking opens a new one. */
export function endChapter(): void {
	current = undefined;
	thinkingId = undefined;
}

/** An assistant message opens the thinking block a later tool row will draw. */
export function beginThinking(): void {
	thinkingId = `thinking-${++thinkingCount}`;
}

/** Fold a message's thinking into the chapter, as the action that is running now. */
export function foldThinking(message: MaybeMessage): ThinkingEntry | undefined {
	if (message.role !== "assistant" || !thinkingId || !hasThinking(message)) {
		return undefined;
	}
	const entry = thinkingEntry(thinkingId, message);
	messageEntries.set(message, entry);
	return entry;
}

/** A message's thinking entry, for the row pi draws in place of its thinking. */
export function entryForMessage(message: MaybeMessage): ThinkingEntry | undefined {
	return messageEntries.get(message);
}

export function lastEntry(chapter: Chapter): Entry | undefined {
	return chapter.entries[chapter.entries.length - 1];
}

/** The tool that has taken a chapter's thinking over; narrative rows never do. */
export function takingOver(chapter: Chapter | undefined): ToolEntry | undefined {
	const last = chapter?.lastTool;
	return last?.narrative ? undefined : last;
}

/** Only the newest tool row of a chapter draws the chapter, so the rest fold away. */
export function isChapterRow(entry: Entry): entry is ToolEntry {
	return isTool(entry) && entry.chapter?.lastTool === entry;
}

/** Thinking drawn above a tool row: the blocks that came since the previous tool. */
export function thinkingBefore(chapter: Chapter, entry: Entry): ThinkingEntry[] {
	const index = chapter.entries.indexOf(entry);
	const out: ThinkingEntry[] = [];
	for (let i = index - 1; i >= 0; i--) {
		const prev = chapter.entries[i];
		if (prev.kind !== "thinking") break;
		out.unshift(prev);
	}
	return out;
}

/** Thinking with no tool after it hangs below the chapter's last tool row. */
export function thinkingAfter(chapter: Chapter, entry: Entry): ThinkingEntry[] {
	if (!isChapterRow(entry)) {
		return [];
	}
	const index = chapter.entries.indexOf(entry);
	const out: ThinkingEntry[] = [];
	for (let i = index + 1; i < chapter.entries.length; i++) {
		const next = chapter.entries[i];
		if (next.kind !== "thinking") break;
		out.push(next);
	}
	return out;
}

/** Only a tool call can be pending or failed; thinking is finished as it is drawn. */
export function tally(chapter: Chapter): { pending: number; failed: number } {
	let pending = 0;
	let failed = 0;
	for (const entry of chapter.entries) {
		if (!isTool(entry)) continue;
		if (!entry.done) pending++;
		if (entry.error) failed++;
	}
	return { pending, failed };
}

export function background(pending: number, failed: number): Background {
	if (pending > 0) return "toolPendingBg";
	return failed > 0 ? "toolErrorBg" : "toolSuccessBg";
}

/** A chapter takes its colour from its latest result; failures it recovered from stay counted. */
export function chapterBackground(chapter: Chapter): Background {
	if (chapter.entries.some((entry) => isTool(entry) && !entry.done)) return "toolPendingBg";
	return chapter.lastTool?.error ? "toolErrorBg" : "toolSuccessBg";
}

/** Whether a message carries thinking worth a row. */
function hasThinking(message: MaybeMessage): boolean {
	return blocksOf(message).some(
		(block) => block.type === "thinking" && typeof block.thinking === "string" && /\S/.test(block.thinking),
	);
}

/** Rebuild the chapters the way the transcript grouped them live. */
export function rebuild(ctx: ExtensionContext): void {
	byId.clear();
	messageEntries = new WeakMap();
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
			messageEntries.set(message, thinkingEntry(`thinking-${++thinkingCount}`, message));
		}
		for (const block of blocksOf(message)) {
			if (block.type === "toolCall" && typeof block.id === "string") {
				toolEntry(block.id, narrative(block.name ?? ""));
			}
		}
	}
	// Redraw callbacks follow entries; drop the ids the rebuild did not keep.
	for (const id of invalidators.keys()) {
		if (!byId.has(id)) {
			invalidators.delete(id);
		}
	}
}
