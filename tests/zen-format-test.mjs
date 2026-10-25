// Table tests for the exported formatting helpers: format.ts's pure functions, entryLine from
// components.ts and the colour helpers model.ts keeps pure. A new edge is one row.
import { homedir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
	ACTION_HEADER_CHARS,
	COMMAND_CHARS,
	RESULT_SUMMARY_CHARS,
	actionHeader,
	blocksOf,
	cut,
	diffStat,
	fallbackCall,
	gist,
	outputLines,
	outputOf,
	resultSummary,
	shorten,
	thinkingGist,
	thinkingText,
} = await jiti.import(new URL("../extensions/lib/format.ts", import.meta.url).pathname);
const { entryLine } = await jiti.import(new URL("../extensions/lib/components.ts", import.meta.url).pathname);
const { chapterBackground, tally } = await jiti.import(new URL("../extensions/lib/model.ts", import.meta.url).pathname);

// ANSI styling so visibleWidth measures text, not markup; assertions compare the stripped text.
const theme = {
	fg: (token, text) => `\x1b[38;5;${((token.length * 7) % 150) + 20}m${text}\x1b[39m`,
	bold: (text) => `\x1b[1m${text}\x1b[22m`,
};
const strip = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");
const assistant = (content) => ({ role: "assistant", content });
const textBlock = (text) => ({ type: "text", text });
const output = (...lines) => ({ content: [textBlock(lines.join("\n"))] });
const toolResult = (...blocks) => ({ content: blocks });
const summary = (toolName, result, context = {}) =>
	strip(resultSummary(toolName, result, theme, { isError: false, ...context }));
const header = (toolName, args, argsComplete = true) => {
	const { main, suffix } = actionHeader(toolName, args, theme, argsComplete);
	return { main: strip(main), suffix: strip(suffix) };
};
const entry = (over = {}) => ({
	id: "entry",
	kind: "tool",
	chapter: undefined,
	actionHeader: { main: "", suffix: "" },
	resultSummary: "",
	done: true,
	error: false,
	...over,
});
const chapterOf = (...entries) => ({ entries, lastTool: entries.at(-1) });
/** An entry shaped as the renderer keeps it: styled action text, suffix and outcome. */
const styledEntry = (main, resultSummary = "", suffix = "", over = {}) =>
	entry({
		actionHeader: { main: theme.fg("toolTitle", theme.bold(main)), suffix: suffix && theme.fg("muted", suffix) },
		resultSummary: resultSummary && theme.fg("muted", resultSummary),
		...over,
	});

let failures = 0;
function check(name, ok, extra = "") {
	if (ok) console.log(`ok   ${name}`);
	else {
		failures++;
		console.log(`FAIL ${name}${extra ? `\n     ${extra.replace(/\n/g, "\n     ")}` : ""}`);
	}
}

/** Run a table: each row says what it does, how to produce the value, and the value expected. */
function runTable(title, rows) {
	console.log(`\n# ${title}`);
	for (const { name, actual, expect } of rows) {
		const got = actual();
		check(name, JSON.stringify(got) === JSON.stringify(expect), `expected ${JSON.stringify(expect)}\n     got      ${JSON.stringify(got)}`);
	}
}

runTable("cut — width edges", [
	{ name: "shorter than the limit is left alone", actual: () => cut("ab", 3), expect: "ab" },
	{ name: "exactly the limit is left alone", actual: () => cut("abc", 3), expect: "abc" },
	{ name: "one cell over is cut, ellipsis included", actual: () => cut("abcd", 3), expect: "ab…" },
	{ name: "the result never exceeds the limit", actual: () => { const line = cut("x".repeat(500), 40); return [line.length, line.endsWith("…")]; }, expect: [40, true] },
	{ name: "a limit of one is just the ellipsis", actual: () => cut("ab", 1), expect: "…" },
	{ name: "flattening counts against the limit", actual: () => cut("  a\n\tb  ", 3), expect: "a b" },
]);

runTable("gist — the first line of a block", [
	{ name: "skips blank lines", actual: () => gist("\n \n second\nthird"), expect: "second" },
	{ name: "strips markdown noise and leading space", actual: () => gist("> *  quoted plan"), expect: "quoted plan" },
	{ name: "no text at all is empty", actual: () => gist(" \n\t\n"), expect: "" },
	{ name: "a very long first line is cut to 200 cells", actual: () => { const line = gist("x".repeat(500)); return [line.length, line.endsWith("…")]; }, expect: [200, true] },
]);

runTable("shorten — home paths", [
	{ name: "a path under home shortens to ~", actual: () => shorten(join(homedir(), "notes", "x.md")), expect: "~/notes/x.md" },
	{ name: "another path is unchanged", actual: () => shorten("/tmp/x.ts"), expect: "/tmp/x.ts" },
]);

runTable("output lines — multi-line output", [
	{ name: "text blocks are joined with a newline", actual: () => outputOf(toolResult(textBlock("a"), textBlock("b"))), expect: "a\nb" },
	{ name: "blocks that are not text are ignored", actual: () => outputOf(toolResult({ type: "image", text: "ignored" }, textBlock("kept"))), expect: "kept" },
	{ name: "blank lines are dropped, spaces inside a line are kept", actual: () => outputLines(toolResult(textBlock("one\n\n  two  \n\t\nthree"))), expect: ["one", "  two  ", "three"] },
	{ name: "whitespace-only output has no lines", actual: () => outputLines(toolResult(textBlock(" \n "))), expect: [] },
	{ name: "blocks split lines as one list", actual: () => outputLines(toolResult(textBlock("a"), textBlock("b"))), expect: ["a", "b"] },
]);

runTable("blocksOf — content access", [
	{ name: "an array of blocks is read", actual: () => blocksOf(assistant([{ type: "text", text: "a" }])).length, expect: 1 },
	{ name: "a non-array content has no blocks", actual: () => blocksOf({ role: "assistant", content: "a" }), expect: [] },
]);

runTable("thinking — text and gist", [
	{
		name: "thinking blocks join with a blank line and are trimmed",
		actual: () =>
			thinkingText(
				assistant([
					{ type: "thinking", thinking: " first " },
					{ type: "text", text: "ignored" },
					{ type: "thinking", thinking: "second\nline" },
				]),
			),
		expect: "first\n\nsecond\nline",
	},
	{ name: "a user message carries no thinking", actual: () => thinkingText({ role: "user", content: [{ type: "thinking", thinking: "secret" }] }), expect: "" },
	{ name: "blank thinking blocks are dropped", actual: () => thinkingText(assistant([{ type: "thinking", thinking: "   " }, { type: "thinking", thinking: "kept" }])), expect: "kept" },
	{
		name: "the gist is the first block with text",
		actual: () => thinkingGist(assistant([{ type: "thinking", thinking: "\n \n" }, { type: "thinking", thinking: "## second block\nmore" }])),
		expect: "second block",
	},
	{ name: "a user message has no thinking gist", actual: () => thinkingGist({ role: "user", content: [{ type: "thinking", thinking: "secret" }] }), expect: "" },
]);

runTable("diffStat — added and removed lines", [
	{ name: "counts changes, not the file headers", actual: () => strip(diffStat("--- a/x\n+++ b/x\n-old\n+new\n+more\n context", theme)), expect: "+2 -1" },
	{ name: "a diff with no changes counts zero", actual: () => strip(diffStat("--- a\n+++ b", theme)), expect: "+0 -0" },
]);

runTable("fallbackCall — an unknown tool's arguments", [
	{ name: "no arguments leaves the tool name", actual: () => strip(fallbackCall("mystery", undefined, theme)), expect: "mystery" },
	{ name: "arguments become key=value pairs", actual: () => strip(fallbackCall("mystery", { a: 1, b: "two" }, theme)), expect: "mystery a=1 b=two" },
	{
		name: "pairs are cut at the header budget",
		actual: () => {
			const pairs = strip(fallbackCall("mystery", { command: "x".repeat(ACTION_HEADER_CHARS * 2) }, theme)).slice("mystery ".length);
			return [pairs.length, pairs.endsWith("…")];
		},
		expect: [ACTION_HEADER_CHARS, true],
	},
]);

runTable("actionHeader — one line per tool", [
	{ name: "bash shows its command", actual: () => header("bash", { command: "echo hi" }), expect: { main: "$ echo hi", suffix: "" } },
	{ name: "bash counts the lines it does not show", actual: () => header("bash", { command: "one\n\n \ntwo\nthree" }), expect: { main: "$ one", suffix: "  (+2 lines)" } },
	{ name: "bash appends a timeout", actual: () => header("bash", { command: "sleep 5", timeout: 30 }), expect: { main: "$ sleep 5", suffix: " (timeout 30s)" } },
	{ name: "bash keeps a long suffix", actual: () => header("bash", { command: Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n") }), expect: { main: "$ line 0", suffix: "  (+4999 lines)" } },
	{ name: "bash shows an ellipsis before the command arrives", actual: () => header("bash", {}), expect: { main: "$ ...", suffix: "" } },
	{
		name: "a very long command is cut at the command budget",
		actual: () => {
			const { main } = header("bash", { command: "x".repeat(COMMAND_CHARS * 2) });
			return [main.length, main.endsWith("…")];
		},
		expect: [COMMAND_CHARS + 2, true],
	},
	{ name: "powershell has its own prompt", actual: () => header("powershell", { command: "Get-ChildItem" }), expect: { main: "> Get-ChildItem", suffix: "" } },
	{ name: "write counts lines once the arguments are complete", actual: () => header("write", { file_path: "/tmp/a.txt", content: "one\ntwo\nthree" }), expect: { main: "write /tmp/a.txt", suffix: " (3 lines)" } },
	{ name: "write waits for complete arguments before counting", actual: () => header("write", { file_path: "/tmp/a.txt", content: "one\ntwo" }, false), expect: { main: "write /tmp/a.txt", suffix: "" } },
	{ name: "write shortens a home path", actual: () => header("write", { file_path: join(homedir(), "a.txt"), content: "one\ntwo" }), expect: { main: "write ~/a.txt", suffix: " (2 lines)" } },
	{ name: "edit shows its path", actual: () => header("edit", { file_path: "/tmp/e.txt" }), expect: { main: "edit /tmp/e.txt", suffix: "" } },
	{ name: "read shows no range without offset or limit", actual: () => header("read", { file_path: "/tmp/x.ts" }), expect: { main: "read /tmp/x.ts", suffix: "" } },
	{ name: "read shows a lone offset as a point", actual: () => header("read", { file_path: "/tmp/x.ts", offset: 10 }), expect: { main: "read /tmp/x.ts", suffix: ":10" } },
	{ name: "read turns offset and limit into a range", actual: () => header("read", { file_path: "/tmp/x.ts", offset: 10, limit: 5 }), expect: { main: "read /tmp/x.ts", suffix: ":10-14" } },
	{ name: "read defaults the range start to 1", actual: () => header("read", { file_path: "/tmp/x.ts", limit: 5 }), expect: { main: "read /tmp/x.ts", suffix: ":1-5" } },
	{ name: "grep wraps the pattern and names the place", actual: () => header("grep", { pattern: "TODO", path: "/tmp/src" }), expect: { main: "grep /TODO/ in /tmp/src", suffix: "" } },
	{ name: "grep defaults to the current directory", actual: () => header("grep", { pattern: "x" }), expect: { main: "grep /x/ in .", suffix: "" } },
	{ name: "find shows the pattern bare", actual: () => header("find", { pattern: "**/*.ts", path: "/tmp" }), expect: { main: "find **/*.ts in /tmp", suffix: "" } },
	{ name: "ls shows its directory", actual: () => header("ls", { path: "/tmp" }), expect: { main: "ls /tmp", suffix: "" } },
	{ name: "ls defaults to the current directory", actual: () => header("ls", {}), expect: { main: "ls .", suffix: "" } },
	{ name: "codemode is just its name", actual: () => header("codemode", {}), expect: { main: "codemode", suffix: "" } },
	{ name: "an unknown tool falls back to its arguments", actual: () => header("mystery", { a: 1 }), expect: { main: "mystery a=1", suffix: "" } },
]);

runTable("resultSummary — width edges and multi-line output", [
	{ name: "read hides a result it would only repeat", actual: () => summary("read", output("file contents")), expect: "" },
	{ name: "write hides a successful result", actual: () => summary("write", output("wrote file")), expect: "" },
	{ name: "read still reports a failure", actual: () => summary("read", output("no such file"), { isError: true }), expect: "no such file" },
	{ name: "an error shows its first line only", actual: () => summary("bash", output("command failed", "second line"), { isError: true }), expect: "command failed" },
	{ name: "an error with no output says failed", actual: () => summary("bash", toolResult(), { isError: true }), expect: "failed" },
	{
		name: "a long error line is cut to the summary budget",
		actual: () => {
			const line = summary("bash", output("e".repeat(RESULT_SUMMARY_CHARS * 2)), { isError: true });
			return [line.length, line.endsWith("…")];
		},
		expect: [RESULT_SUMMARY_CHARS, true],
	},
	{
		name: "a long single line is cut to the summary budget",
		actual: () => {
			const line = summary("bash", output("s".repeat(500)));
			return [line.length, line.endsWith("…")];
		},
		expect: [RESULT_SUMMARY_CHARS, true],
	},
	{ name: "one output line is shown verbatim", actual: () => summary("bash", output("hello world")), expect: "hello world" },
	{ name: "multi-line output is only counted", actual: () => summary("bash", output("one", "two", "three")), expect: "3 lines" },
	{ name: "blank lines are not counted", actual: () => summary("bash", output("one", "", " ", "two")), expect: "2 lines" },
	{ name: "a truncated result marks its count as a floor", actual: () => summary("bash", { content: [textBlock("a\nb")], details: { truncation: { truncated: true } } }), expect: "2+ lines" },
	{ name: "no output says nothing", actual: () => summary("bash", toolResult()), expect: "" },
	{ name: "grep counts matches", actual: () => summary("grep", output("a", "b", "c")), expect: "3 matches" },
	{ name: "find counts files", actual: () => summary("find", output("a", "b")), expect: "2 files" },
	{ name: "ls counts entries", actual: () => summary("ls", output("a", "b", "c", "d")), expect: "4 entries" },
	{ name: "edit shows its diff stat", actual: () => summary("edit", { content: [], details: { diff: "--- a\n+++ b\n-old\n+new\n+newer" } }), expect: "+2 -1" },
	{ name: "an edit without a diff says applied", actual: () => summary("edit", toolResult()), expect: "applied" },
	{ name: "codemode counts its tool calls", actual: () => summary("codemode", { content: [], details: { calls: [{}, {}] } }), expect: "2 tool calls" },
	{ name: "one codemode call is singular", actual: () => summary("codemode", { content: [], details: { calls: [{}] } }), expect: "1 tool call" },
	{ name: "codemode without calls counts its output", actual: () => summary("codemode", output("a", "b")), expect: "2 lines" },
	{ name: "a fast result shows no elapsed time", actual: () => summary("bash", output("done"), { durationMs: 999 }), expect: "done" },
	{ name: "a slow result appends its time", actual: () => summary("bash", output("done"), { durationMs: 1234 }), expect: "done · 1.2s" },
	{ name: "a slow edit appends its time to the diff stat", actual: () => summary("edit", { content: [], details: { diff: "+new" } }, { durationMs: 2000 }), expect: "+1 -0 · 2.0s" },
	{ name: "an error does not append elapsed time", actual: () => summary("bash", output("boom"), { isError: true, durationMs: 5000 }), expect: "boom" },
]);

// A chapter that failed and then recovered: the newest result decides the colour, the failure stays
// counted for the folded line.
runTable("recovered failures — chapter colour and tally", [
	{ name: "the latest failure makes the chapter red", actual: () => chapterBackground(chapterOf(entry({ error: true }))), expect: "toolErrorBg" },
	{ name: "a recovered chapter shows its latest success", actual: () => chapterBackground(chapterOf(entry({ error: true }), entry())), expect: "toolSuccessBg" },
	{ name: "a recovered chapter still counts the failure", actual: () => tally(chapterOf(entry({ error: true }), entry())), expect: { pending: 0, failed: 1 } },
	{ name: "an action still running keeps the chapter pending", actual: () => chapterBackground(chapterOf(entry({ done: false }))), expect: "toolPendingBg" },
]);

runTable("entryLine — the width budget", [
	{ name: "keeps the whole line when it fits", actual: () => { const line = entryLine(styledEntry("bash", "3 lines"), theme, 20); return [strip(line), visibleWidth(line)]; }, expect: ["bash · 3 lines", 14] },
	{ name: "fills the budget exactly without cutting", actual: () => { const line = entryLine(styledEntry("cmd", "out"), theme, 9); return [strip(line), visibleWidth(line)]; }, expect: ["cmd · out", 9] },
	{ name: "one cell over cuts the action, not the outcome", actual: () => { const line = entryLine(styledEntry("cmd", "out"), theme, 8); return [strip(line), visibleWidth(line)]; }, expect: ["c… · out", 8] },
	{ name: "a long action gives way to its outcome", actual: () => { const line = entryLine(styledEntry("a long action", "done"), theme, 12); return [strip(line), visibleWidth(line)]; }, expect: ["a lo… · done", 12] },
	{ name: "a long outcome is squeezed before the action is", actual: () => { const [main, outcome] = strip(entryLine(styledEntry("a long action name", "s".repeat(100)), theme, 40)).split(" · "); return [main, outcome.length, outcome.endsWith("…")]; }, expect: ["a long action name", 14, true] },
	{ name: "the outcome keeps at least eight cells", actual: () => { const line = entryLine(styledEntry("cmd", "0123456789"), theme, 12); return [strip(line), visibleWidth(line)]; }, expect: ["… · 0123456…", 12] },
	{ name: "a long suffix is kept whole", actual: () => { const line = entryLine(styledEntry("x".repeat(100), "", " (+4999 lines)"), theme, 20); return [strip(line), visibleWidth(line)]; }, expect: ["xxxxx… (+4999 lines)", 20] },
	{ name: "the suffix is never cut, even past the budget", actual: () => { const line = entryLine(styledEntry("cmd", "", " (+4999 lines)"), theme, 10); return [strip(line), visibleWidth(line)]; }, expect: ["… (+4999 lines)", 15] },
	{ name: "a thinking row is led by its label", actual: () => { const line = entryLine(styledEntry("Plan", "", "", { kind: "thinking" }), theme, 20); return [strip(line), visibleWidth(line)]; }, expect: ["thinking Plan", 13] },
	{ name: "a thinking row carries no outcome", actual: () => strip(entryLine(styledEntry("Plan", "3 lines", "", { kind: "thinking" }), theme, 20)), expect: "thinking Plan" },
	{ name: "no result means no separator", actual: () => strip(entryLine(styledEntry("bash"), theme, 20)), expect: "bash" },
]);

console.log(failures === 0 ? "\nall format checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
