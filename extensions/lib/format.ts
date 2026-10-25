/**
 * The lines zen draws: an action's header, its result summary and the thinking
 * behind a row. Pure functions of the call, result and theme; no state.
 */

import { homedir } from "node:os";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { countNoun, headerOnly } from "./tools";

export const ACTION_HEADER_CHARS = 100;
export const RESULT_SUMMARY_CHARS = 120;
/** A command is kept whole so the row can use whatever width it has; only absurd lines are cut. */
export const COMMAND_CHARS = 400;
/** Longest prefix scanned for a gist; a first line longer than this is cut to a preview anyway. */
const GIST_SCAN = 4096;

/** An action header in two parts, so a width budget can cut the text and keep the structure. */
export interface ActionHeader {
	main: string;
	suffix: string;
}

/** The parts of a tool result that formatting reads. */
export interface Result {
	content: ReadonlyArray<{ type: string; text?: string }>;
	details?: unknown;
}

/** The parts of the render context a summary reads. */
export interface SummaryContext {
	isError: boolean;
	durationMs?: number;
}

/** Any message shape that can carry thinking blocks. */
export interface MaybeMessage {
	role: string;
	content?: unknown;
}

/** The parts of a content block zen reads. */
export interface ContentBlock {
	type: string;
	text?: string;
	thinking?: string;
	id?: string;
	name?: string;
}

export function cut(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The first non-empty line of a thinking block, stripped of markdown noise. */
export function gist(text: string): string {
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

export function shorten(path: string): string {
	const home = homedir();
	return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function argPath(args: Record<string, unknown>): string {
	const raw = args?.file_path ?? args?.path;
	return shorten(typeof raw === "string" ? raw : "");
}

export function outputOf(result: Result): string {
	return result.content.flatMap((block) => (block.type === "text" ? [block.text ?? ""] : [])).join("\n");
}

/** The output's non-blank lines. */
export function outputLines(result: Result): string[] {
	return outputOf(result)
		.trim()
		.split("\n")
		.filter((line) => line.trim());
}

export function diffStat(diff: string, theme: Theme): string {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) added++;
		else if (line.startsWith("-") && !line.startsWith("---")) removed++;
	}
	return `${theme.fg("success", `+${added}`)} ${theme.fg("error", `-${removed}`)}`;
}

/** A message's content blocks, empty when it has none. */
export function blocksOf(message: MaybeMessage): ReadonlyArray<ContentBlock> {
	return Array.isArray(message.content) ? (message.content as ReadonlyArray<ContentBlock>) : [];
}

/** Thinking a message carries, in one string. */
export function thinkingText(message: MaybeMessage): string {
	if (message.role !== "assistant") {
		return "";
	}
	return blocksOf(message)
		.filter((block) => block.type === "thinking" && block.thinking?.trim())
		.map((block) => (block.thinking ?? "").trim())
		.join("\n\n");
}

/** The one-line gist of a message's thinking, scanned without building the whole text. */
export function thinkingGist(message: MaybeMessage): string {
	if (message.role !== "assistant") {
		return "";
	}
	for (const block of blocksOf(message)) {
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

export function fallbackCall(toolName: string, args: unknown, theme: Theme): string {
	const pairs = Object.entries((args ?? {}) as Record<string, unknown>)
		.map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
		.join(" ");
	return pairs
		? `${theme.fg("toolTitle", theme.bold(toolName))} ${theme.fg("muted", cut(pairs, ACTION_HEADER_CHARS))}`
		: theme.fg("toolTitle", theme.bold(toolName));
}

export function actionHeader(toolName: string, raw: unknown, theme: Theme, argsComplete: boolean): ActionHeader {
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
		default:
			return { main: fallbackCall(toolName, args, theme), suffix: "" };
	}
}

export function resultSummary(toolName: string, result: Result, theme: Theme, context: SummaryContext): string {
	// A header-only tool already hides its result, so only its failure earns a line.
	if (headerOnly(toolName) && !context.isError) {
		return "";
	}

	const lines = outputLines(result);
	if (context.isError) {
		return theme.fg("error", cut(lines[0] ?? "failed", RESULT_SUMMARY_CHARS));
	}

	const details = (result.details ?? {}) as {
		calls?: unknown[];
		diff?: string;
		truncation?: { truncated?: boolean };
	};
	// One line of output is worth showing verbatim; more is only worth counting.
	const counted = (many: string) =>
		lines.length <= 1
			? cut(lines[0] ?? "", RESULT_SUMMARY_CHARS)
			: `${lines.length}${details.truncation?.truncated ? "+" : ""} ${many}`;
	const noun = countNoun(toolName) ?? "lines";
	const slow = context.durationMs !== undefined && context.durationMs >= 1000;
	const elapsed = slow ? theme.fg("muted", ` · ${(context.durationMs! / 1000).toFixed(1)}s`) : "";

	let plain = "";
	let styled: string | undefined;
	switch (toolName) {
		case "edit":
			styled = details.diff ? diffStat(details.diff, theme) : theme.fg("success", "applied");
			break;
		case "codemode": {
			const calls = details.calls?.length ?? 0;
			plain = calls ? `${calls} tool call${calls === 1 ? "" : "s"}` : counted(noun);
			break;
		}
		default:
			plain = counted(noun);
	}
	return (styled ?? theme.fg("muted", plain)) + elapsed;
}
