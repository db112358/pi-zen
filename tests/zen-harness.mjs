// Throwaway harness: drives zen.ts with a fake pi and asserts on rendered rows.
import { Container, KeybindingsManager, MouseRegion, setKeybindings, Text, visibleWidth } from "@earendil-works/pi-tui";
import { createJiti } from "jiti";

// The installed pi registers this binding; the harness has to as well for the key to be known.
setKeybindings(new KeybindingsManager({ "app.tools.expand": { defaultKeys: "ctrl+o" } }));

const ZEN = new URL("../extensions/zen.ts", import.meta.url).pathname;
// No module cache: each import re-evaluates zen.ts, while pi-tui stays shared.
const jiti = createJiti(import.meta.url, { moduleCache: false });

const CODES = { customMessageBg: 100, toolPendingBg: 101, toolSuccessBg: 102, toolErrorBg: 103 };
const theme = {
	fg: (token, text) => `\x1b[38;5;${((token.length * 7) % 150) + 20}m${text}\x1b[39m`,
	bg: (token, text) => `\x1b[48;5;${CODES[token] ?? 199}m${text}\x1b[49m`,
	bold: (text) => `\x1b[1m${text}\x1b[22m`,
};

/** A fresh zen module and fake pi, so one scenario cannot see another's module state. */
async function freshZen() {
	const mod = await jiti.import(ZEN);
	let expandedTools = false;
	let workingMessage;
	const handlers = new Map();
	const inputHandlers = new Set();
	const pi = {
		on: (event, handler) => handlers.set(event, handler),
		registerCommand: () => {},
		registerToolRenderer: (resolver) => {
			pi.resolver = resolver;
		},
	};
	mod.default(pi);

	const sessionManager = { buildContextEntries: () => [] };
	const ui = {
		getToolsExpanded: () => expandedTools,
		setToolsExpanded: (v) => {
			expandedTools = v;
		},
		setHiddenThinkingLabel: () => {},
		setWorkingMessage: (message) => {
			workingMessage = message;
		},
		notify: () => {},
		setStatus: () => {},
		onTerminalInput: (handler) => {
			inputHandlers.add(handler);
			return () => inputHandlers.delete(handler);
		},
	};
	const ctx = { mode: "tui", ui, sessionManager, hasUI: true };

	return {
		handlers,
		ui,
		ctx,
		sessionManager,
		resolver: pi.resolver,
		get expandedTools() {
			return expandedTools;
		},
		set expandedTools(value) {
			expandedTools = value;
		},
		get workingMessage() {
			return workingMessage;
		},
		/** Start a session, as pi does. */
		reset() {
			handlers.get("session_start")({}, ctx);
		},
		startAssistant() {
			handlers.get("message_start")({ message: assistant([]) });
		},
		update(message) {
			handlers.get("message_update")({ message }, ctx);
		},
		end(message) {
			handlers.get("message_end")({ message }, ctx);
		},
		/** Press a key the way the TUI does, returning whether an extension consumed it. */
		pressKey(data) {
			for (const handler of inputHandlers) {
				if (handler(data)?.consume) return true;
			}
			return false;
		},
	};
}

function assistant(content) {
	return { role: "assistant", content };
}
function context(over = {}) {
	return {
		args: {},
		toolCallId: "x",
		invalidate: () => {},
		lastComponent: undefined,
		state: {},
		cwd: "/tmp",
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
		durationMs: undefined,
		outputPad: 1,
		...over,
	};
}

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const flat = (lines) => lines.map(strip).join("\n");
const hasBg = (lines, token) => lines.some((l) => l.includes(`\x1b[48;5;${CODES[token]}m`));
const bgOf = (line) => Number((line.match(/\x1b\[48;5;(\d+)m/) ?? [])[1] ?? 0);
const bgSeq = (lines) => lines.map(bgOf);

let failures = 0;
function check(name, cond, extra = "") {
	if (cond) console.log(`ok   ${name}`);
	else {
		failures++;
		console.log(`FAIL ${name}${extra ? `\n     ${extra.replace(/\n/g, "\n     ")}` : ""}`);
	}
}

// ---------------------------------------------------------------------------
// Scenario 1: thinking before a narrative tool survives, on its own frame.
{
	const h = await freshZen();
	h.expandedTools = true;
	h.reset();
	h.startAssistant();
	const msgA = assistant([
		{ type: "thinking", thinking: "Let me start by understanding the context. The user wants a review." },
		{ type: "toolCall", id: "call-andon", name: "set_andon", arguments: { title: "Review zen" } },
		{ type: "toolCall", id: "call-bash", name: "bash", arguments: { command: "ls -la /tmp" } },
	]);
	h.update(msgA);
	h.end(msgA);

	const andon = h.resolver("set_andon", () => undefined);
	const bash = h.resolver("bash", () => undefined);

	const andonCtx = context({ toolCallId: "call-andon", args: { title: "Review zen" }, expanded: true });
	const andonLines = andon.renderCall({ title: "Review zen" }, theme, andonCtx).render(80);
	check("narrative expanded shows the thinking that led to it", flat(andonLines).includes("Let me start by understanding"), flat(andonLines));
	check("narrative thinking has its own background", hasBg(andonLines, "customMessageBg"));
	check("narrative action keeps a tool background", hasBg(andonLines, "toolSuccessBg"), flat(andonLines));
	check("narrative action still rendered", flat(andonLines).includes("Review zen"), flat(andonLines));

	// collapsed narrative row shows no thinking
	const andonCollapsedCtx = context({ toolCallId: "call-andon", args: { title: "Review zen" }, expanded: false });
	const andonCollapsed = flat(andon.renderCall({ title: "Review zen" }, theme, andonCollapsedCtx).render(80));
	check("collapsed narrative row hides thinking", !andonCollapsed.includes("Let me start by understanding"), andonCollapsed);

	// the bash row that follows does not inherit the thinking
	const bashCtx = context({ toolCallId: "call-bash", args: { command: "ls -la /tmp" }, expanded: true });
	const bashLines = bash.renderCall({ command: "ls -la /tmp" }, theme, bashCtx).render(80);
	check("following tool does not show the narrative thinking", !flat(bashLines).includes("Let me start by understanding"), flat(bashLines));
	check("following tool still renders its action", flat(bashLines).includes("ls -la /tmp"), flat(bashLines));
}

// ---------------------------------------------------------------------------
// Scenario 2: trailing thinking is live, then migrates to the next tool.
{
	const h = await freshZen();
	h.expandedTools = true;
	h.reset();
	// A finished action for the next message's thinking to trail.
	h.startAssistant();
	const msgA = assistant([
		{ type: "thinking", thinking: "Check the tree before reading." },
		{ type: "toolCall", id: "call-bash", name: "bash", arguments: { command: "ls -la /tmp" } },
	]);
	h.update(msgA);

	const bash = h.resolver("bash", () => undefined);
	const bashCtx = context({ toolCallId: "call-bash", args: { command: "ls -la /tmp" }, expanded: true });
	bash.renderCall({ command: "ls -la /tmp" }, theme, bashCtx);
	const bashResult = { content: [{ type: "text", text: "total 0" }], details: {}, isError: false, durationMs: 5 };
	const bashAfter = bash.renderResult(bashResult, { expanded: true, isPartial: false }, theme, bashCtx);
	check("no trailing thinking before any exists", bashAfter.render(80).length === 0);

	h.startAssistant();
	const msgB = assistant([
		{ type: "thinking", thinking: "Now let me look at the renderer.\nIt renders rows with detail." },
		{ type: "toolCall", id: "call-read", name: "read", arguments: { file_path: "/tmp/x.ts" } },
	]);
	h.update(msgB);

	const trailing = bashAfter.render(80);
	check("trailing thinking appears live without re-running the renderer", flat(trailing).includes("Now let me look at the renderer"), flat(trailing));
	check("trailing thinking has its own background", hasBg(trailing, "customMessageBg"), flat(trailing));
	check("trailing thinking starts with a dark gap", bgSeq(trailing)[0] === 0, JSON.stringify(bgSeq(trailing)));
	check("trailing thinking block is padded", JSON.stringify(bgSeq(trailing)) === JSON.stringify([0, 100, 100, 100]), JSON.stringify(bgSeq(trailing)));

	const read = h.resolver("read", () => undefined);
	const readCtx = context({ toolCallId: "call-read", args: { file_path: "/tmp/x.ts" }, expanded: true });
	const readComponent = read.renderCall({ file_path: "/tmp/x.ts" }, theme, readCtx);
	const readComp = readComponent.render(80);
	check("next tool shows the thinking above it", flat(readComp).includes("Now let me look at the renderer"), flat(readComp));
	check("thinking block is padded and gapped from the action", JSON.stringify(bgSeq(readComp)) === JSON.stringify([100, 100, 100, 0, 102, 102, 102]), JSON.stringify(bgSeq(readComp)));

	// A click in the expanded list opens the detail; the row must not fold away.
	const clickEvent = { type: "click", button: "left", x: 5, y: 1, screenX: 5, screenY: 1, width: 80, height: 7, shift: false, alt: false, ctrl: false, clickCount: 1 };
	let outerToggled = false;
	const outer = new MouseRegion(readComponent, () => {
		outerToggled = true;
		return { handled: true };
	});
	const clickResult = outer.handleMouse(clickEvent);
	check("expanded click is consumed by the thinking region", outerToggled === false && clickResult?.handled === true, JSON.stringify(clickResult));
	const clicked = flat(readComponent.render(80));
	check("expanded click opens the full thinking", clicked.includes("with detail."), clicked);
	check("expanded click keeps the row expanded", clicked.includes("x.ts"), clicked);
	readComponent.handleMouse(clickEvent);
	const toggledBack = flat(readComponent.render(80));
	check("second click returns to the summary", !toggledBack.includes("with detail.") && toggledBack.includes("Now let me look at the renderer"), toggledBack);
	readComponent.handleMouse(clickEvent);
	check("previous row drops the thinking it handed over", bashAfter.render(80).length === 0);
	check("next tool keeps its own action", flat(readComp).includes("x.ts"), flat(readComp));
}

// ---------------------------------------------------------------------------
// Scenario 3: collapsed chapter row is still drawn by the newest tool.
{
	const h = await freshZen();
	h.expandedTools = false;
	h.reset();
	h.startAssistant();
	h.update(
		assistant([
			{ type: "thinking", thinking: "Plan the read.\nMore plan detail." },
			{ type: "toolCall", id: "call-read", name: "read", arguments: { file_path: "/tmp/x.ts" } },
		]),
	);
	const read = h.resolver("read", () => undefined);
	const chapter = flat(read.renderCall({ file_path: "/tmp/x.ts" }, theme, context({ toolCallId: "call-read", args: { file_path: "/tmp/x.ts" }, expanded: false })).render(80));
	check("chapter row shows the collapsed chevron and action", chapter.includes("▶") && chapter.includes("read"), chapter);
}

// ---------------------------------------------------------------------------
// Scenario 4: clicked row (ctrl+o off) shows the full thinking detail.
{
	const h = await freshZen();
	h.expandedTools = false;
	h.reset();
	h.startAssistant();
	h.update(
		assistant([
			{ type: "thinking", thinking: "Now let me look at the renderer.\nIt renders rows with detail." },
			{ type: "toolCall", id: "call-read", name: "read", arguments: { file_path: "/tmp/x.ts" } },
		]),
	);
	const read = h.resolver("read", () => undefined);
	const detailCtx = context({ toolCallId: "call-read", args: { file_path: "/tmp/x.ts" }, expanded: true });
	const detailComponent = read.renderCall({ file_path: "/tmp/x.ts" }, theme, detailCtx);
	const detailLines = flat(detailComponent.render(80));
	check("clicked row shows full thinking detail", detailLines.includes("with detail."), detailLines);
	let folded = false;
	const outerDetail = new MouseRegion(detailComponent, () => {
		folded = true;
		return { handled: true };
	});
	outerDetail.handleMouse({ type: "click", button: "left", x: 5, y: 1, screenX: 5, screenY: 1, width: 80, height: 7, shift: false, alt: false, ctrl: false, clickCount: 1 });
	check("collapsed-list click still folds the row", folded === true);
}

// ---------------------------------------------------------------------------
// Scenario 5: write header counts lines only once args are complete.
{
	const h = await freshZen();
	h.expandedTools = true;
	h.reset();
	const write = h.resolver("write", () => undefined);
	const big = "line\n".repeat(1000);
	const writeCtx = context({ toolCallId: "call-write", args: { file_path: "/tmp/big.txt", content: big }, expanded: false, argsComplete: false });
	write.renderCall({ file_path: "/tmp/big.txt", content: big }, theme, writeCtx);
	const writeDone = flat(write.renderCall({ file_path: "/tmp/big.txt", content: big }, theme, { ...writeCtx, argsComplete: true }).render(80));
	check("write shows the line count when complete", writeDone.includes("(1001 lines)"), writeDone);
}

// ---------------------------------------------------------------------------
// Scenario 6: a stale builtin timer is cleared when zen handles the result.
{
	const h = await freshZen();
	h.expandedTools = true;
	h.reset();
	const bash = h.resolver("bash", () => undefined);
	const timerCtx = context({ toolCallId: "call-timer", args: { command: "sleep 5" }, expanded: false });
	bash.renderCall({ command: "sleep 5" }, theme, timerCtx);
	timerCtx.state.interval = setInterval(() => {}, 60_000);
	bash.renderResult({ content: [], details: {}, isError: false }, { expanded: false, isPartial: true }, theme, timerCtx);
	check("stale builtin timer cleared", timerCtx.state.interval === undefined);
}

// ---------------------------------------------------------------------------
// Scenario 7: thinking deltas stay cheap.
{
	const h = await freshZen();
	h.reset();
	h.startAssistant();
	const chunk = "The model is reasoning about the tool execution component and its rendering. ".repeat(3);
	let text = "";
	const t0 = performance.now();
	for (let i = 0; i < 2000; i++) {
		text += chunk;
		h.update(assistant([{ type: "thinking", thinking: text }]));
	}
	const t1 = performance.now();
	check("2000 thinking deltas stay under 500ms", t1 - t0 < 500, `${(t1 - t0).toFixed(0)}ms for ${text.length} chars`);
}

// ---------------------------------------------------------------------------
// Scenario 8: rebuild from stored messages groups thinking the same way.
{
	const h = await freshZen();
	const storedUser = { role: "user", content: [{ type: "text", text: "review" }] };
	const storedAssistant = assistant([
		{ type: "thinking", thinking: "Stored reasoning about the review." },
		{ type: "toolCall", id: "call-stored-andon", name: "set_andon", arguments: { title: "Stored" } },
		{ type: "toolCall", id: "call-stored-bash", name: "bash", arguments: { command: "echo hi" } },
	]);
	h.expandedTools = true;
	h.handlers.get("session_start")(
		{},
		{
			...h.ctx,
			sessionManager: {
				buildContextEntries: () => [
					{ type: "message", message: storedUser },
					{ type: "message", message: storedAssistant },
				],
			},
		},
	);
	const storedAndonCtx = context({ toolCallId: "call-stored-andon", args: { title: "Stored" }, expanded: true });
	const storedAndon = flat(h.resolver("set_andon", () => undefined).renderCall({ title: "Stored" }, theme, storedAndonCtx).render(80));
	check("rebuilt narrative row keeps its thinking", storedAndon.includes("Stored reasoning about the review"), storedAndon);
	const storedBashCtx = context({ toolCallId: "call-stored-bash", args: { command: "echo hi" }, expanded: true });
	const storedBash = flat(h.resolver("bash", () => undefined).renderCall({ command: "echo hi" }, theme, storedBashCtx).render(80));
	check("rebuilt following tool has no thinking", !storedBash.includes("Stored reasoning"), storedBash);
}

// ---------------------------------------------------------------------------
// Scenario 9: an action row opens its own detail; the thinking row stays put.
{
	const h = await freshZen();
	h.expandedTools = true;
	h.reset();
	h.startAssistant();
	const msgAct = assistant([
		{ type: "thinking", thinking: "Plan the action.\nMore plan detail." },
		{ type: "toolCall", id: "call-act", name: "read", arguments: { file_path: "/tmp/y.ts" } },
	]);
	h.update(msgAct);
	const read = h.resolver("read", () => undefined);
	const actCtx = context({ toolCallId: "call-act", args: { file_path: "/tmp/y.ts" }, expanded: true });
	const actComp = read.renderCall({ file_path: "/tmp/y.ts" }, theme, actCtx);
	const actResult = { content: [{ type: "text", text: "file body line one\nfile body line two" }], details: {}, isError: false, durationMs: 3 };
	read.renderResult(actResult, { expanded: true, isPartial: false }, theme, actCtx);
	check("action detail hidden before the click", !flat(actComp.render(80)).includes("file body line one"), flat(actComp.render(80)));
	const actionClick = { type: "click", button: "left", x: 5, y: 5, screenX: 5, screenY: 5, width: 80, height: 7, shift: false, alt: false, ctrl: false, clickCount: 1 };
	let outerActionToggled = false;
	const outerAction = new MouseRegion(actComp, () => {
		outerActionToggled = true;
		return { handled: true };
	});
	const actionResult = outerAction.handleMouse(actionClick);
	check("action click is consumed", outerActionToggled === false && actionResult?.handled === true, JSON.stringify(actionResult));
	read.renderCall({ file_path: "/tmp/y.ts" }, theme, actCtx);
	read.renderResult(actResult, { expanded: true, isPartial: false }, theme, actCtx);
	const openedAction = flat(actComp.render(80));
	check("action click opens the tool detail", openedAction.includes("file body line one"), openedAction);
	check("action click leaves the thinking as a summary", !openedAction.includes("More plan detail."), openedAction);
	outerAction.handleMouse(actionClick);
	read.renderCall({ file_path: "/tmp/y.ts" }, theme, actCtx);
	read.renderResult(actResult, { expanded: true, isPartial: false }, theme, actCtx);
	check("second action click hides the detail", !flat(actComp.render(80)).includes("file body line one"));
}

// ---------------------------------------------------------------------------
// Scenario 10: a builtin whose content lives in the call renderer (write-like) still opens.
{
	const h = await freshZen();
	h.expandedTools = true;
	h.reset();
	h.startAssistant();
	const msgWrite = assistant([
		{ type: "toolCall", id: "call-write", name: "write", arguments: { file_path: "/tmp/w.txt", content: "first line\nsecond line" } },
	]);
	h.update(msgWrite);
	const writeBuiltin = {
		renderShell: "default",
		renderCall: (args) => new Text(`write ${args.file_path} preview ${args.content}`, 0, 0),
		renderResult: () => new Container(),
	};
	const writeResolver = h.resolver("write", () => writeBuiltin);
	const writeDetailCtx = context({ toolCallId: "call-write", args: { file_path: "/tmp/w.txt", content: "first line\nsecond line" }, expanded: true });
	const writeArgs = { file_path: "/tmp/w.txt", content: "first line\nsecond line" };
	const writeComp = writeResolver.renderCall(writeArgs, theme, writeDetailCtx);
	writeResolver.renderResult({ content: [], details: {}, isError: false }, { expanded: true, isPartial: false }, theme, writeDetailCtx);
	check("write content hidden before click", !flat(writeComp.render(80)).includes("preview first line"), flat(writeComp.render(80)));
	writeComp.handleMouse({ type: "click", button: "left", x: 5, y: 1, screenX: 5, screenY: 1, width: 80, height: 3, shift: false, alt: false, ctrl: false, clickCount: 1 });
	writeResolver.renderCall(writeArgs, theme, writeDetailCtx);
	writeResolver.renderResult({ content: [], details: {}, isError: false }, { expanded: true, isPartial: false }, theme, writeDetailCtx);
	check("write content shown when the row opens", flat(writeComp.render(80)).includes("preview first line"), flat(writeComp.render(80)));
}

// ---------------------------------------------------------------------------
// Scenario 11: clicking the chapter summary opens the whole chapter into its rows.
{
	const h = await freshZen();
	h.expandedTools = false;
	h.reset();
	h.startAssistant();
	const msgRun = assistant([
		{ type: "thinking", thinking: "Chapter plan.\nChapter detail." },
		{ type: "toolCall", id: "call-b1", name: "bash", arguments: { command: "echo one" } },
		{ type: "toolCall", id: "call-w1", name: "write", arguments: { file_path: "/tmp/r.txt", content: "run body" } },
	]);
	h.update(msgRun);
	const bashR = h.resolver("bash", () => undefined);
	const writeR = h.resolver("write", () => undefined);
	const bashArgs = { command: "echo one" };
	const runWriteArgs = { file_path: "/tmp/r.txt", content: "run body" };
	const bashRes = { content: [{ type: "text", text: "one" }], details: {}, isError: false };
	const runWriteRes = { content: [], details: {}, isError: false };
	const bCtx = context({ toolCallId: "call-b1", args: bashArgs, expanded: false });
	const wCtx = context({ toolCallId: "call-w1", args: runWriteArgs, expanded: false });
	const reBash = () => {
		bashR.renderCall(bashArgs, theme, bCtx);
		bashR.renderResult(bashRes, { expanded: false, isPartial: false }, theme, bCtx);
	};
	const reWrite = () => {
		writeR.renderCall(runWriteArgs, theme, wCtx);
		writeR.renderResult(runWriteRes, { expanded: false, isPartial: false }, theme, wCtx);
	};
	bCtx.invalidate = reBash;
	wCtx.invalidate = reWrite;
	reBash();
	reWrite();
	const chapterRegion = writeR.renderCall(runWriteArgs, theme, wCtx);
	check("chapter row shows the collapsed chevron", flat(chapterRegion.render(80)).includes("▶"), flat(chapterRegion.render(80)));
	const chapterClick = { type: "click", button: "left", x: 5, y: 1, screenX: 5, screenY: 1, width: 80, height: 4, shift: false, alt: false, ctrl: false, clickCount: 1 };
	let outerChapterToggled = false;
	const outerChapter = new MouseRegion(chapterRegion, () => {
		outerChapterToggled = true;
		return { handled: true };
	});
	const chapterResult = outerChapter.handleMouse(chapterClick);
	check("chapter click is consumed", outerChapterToggled === false && chapterResult?.handled === true, JSON.stringify(chapterResult));
	const firstComp = bashR.renderCall(bashArgs, theme, bCtx);
	const lastComp = writeR.renderCall(runWriteArgs, theme, wCtx);
	const firstOpen = flat(firstComp.render(80));
	const lastOpen = flat(lastComp.render(80));
	check("opened chapter header shows the expanded chevron", firstOpen.includes("▼") && firstOpen.includes("actions"), firstOpen);
	check("opened chapter shows the thinking summary", firstOpen.includes("Chapter plan.") && !firstOpen.includes("Chapter detail."), firstOpen);
	check("opened chapter shows both actions", firstOpen.includes("echo one") && lastOpen.includes("write /tmp/r.txt"), `${firstOpen}\n---\n${lastOpen}`);

	// Detail toggles still work inside the opened chapter.
	const rowClick = { ...chapterClick, height: 10 };
	const thinkOpen = flat(firstComp.render(80));
	firstComp.handleMouse({ ...rowClick, y: 4 });
	check("thinking opens inside the chapter", flat(firstComp.render(80)).includes("Chapter detail."), thinkOpen);
	firstComp.handleMouse({ ...rowClick, y: 4 });

	// Clicking the header folds the chapter back to its summary row.
	firstComp.handleMouse({ ...rowClick, y: 1 });
	const foldedChapter = flat(writeR.renderCall(runWriteArgs, theme, wCtx).render(80));
	check("chapter header folds it back", foldedChapter.includes("actions") && !foldedChapter.includes("echo one"), foldedChapter);
}

// ---------------------------------------------------------------------------
// Scenario 12: an open chapter folds from its footer as well as its header.
{
	const h = await freshZen();
	h.expandedTools = false;
	h.reset();
	h.startAssistant();
	const footMsg = assistant([
		{ type: "toolCall", id: "call-f1", name: "bash", arguments: { command: "echo one" } },
		{ type: "toolCall", id: "call-f2", name: "bash", arguments: { command: "echo two" } },
	]);
	h.update(footMsg);
	const bashF = h.resolver("bash", () => undefined);
	const f1Args = { command: "echo one" };
	const f2Args = { command: "echo two" };
	const fRes = { content: [{ type: "text", text: "out" }], details: {}, isError: false };
	const f1Ctx = context({ toolCallId: "call-f1", args: f1Args, expanded: false });
	const f2Ctx = context({ toolCallId: "call-f2", args: f2Args, expanded: false });
	const reF1 = () => {
		bashF.renderCall(f1Args, theme, f1Ctx);
		bashF.renderResult(fRes, { expanded: false, isPartial: false }, theme, f1Ctx);
	};
	const reF2 = () => {
		bashF.renderCall(f2Args, theme, f2Ctx);
		bashF.renderResult(fRes, { expanded: false, isPartial: false }, theme, f2Ctx);
	};
	f1Ctx.invalidate = reF1;
	f2Ctx.invalidate = reF2;
	reF1();
	reF2();

	const fClick = { type: "click", button: "left", x: 5, y: 1, screenX: 5, screenY: 1, width: 80, height: 4, shift: false, alt: false, ctrl: false, clickCount: 1 };
	bashF.renderCall(f2Args, theme, f2Ctx).handleMouse(fClick);
	reF1();
	reF2();

	const openLast = bashF.renderResult(fRes, { expanded: false, isPartial: false }, theme, f2Ctx);
	const openLastLines = flat(openLast.render(80));
	check("open chapter ends with a fold row", openLastLines.includes("▲") && openLastLines.includes("collapse"), openLastLines);
	check("footer counts the chapter's actions", openLastLines.includes("2 actions"), openLastLines);

	// Header and footer are the same row: one padded neutral line, not the tool's colours.
	const footerRegion = openLast.children.at(-1);
	const footerLines = footerRegion.render(80);
	const headerLines = bashF.renderCall(f1Args, theme, f1Ctx).render(80).slice(0, 3);
	const headerLine = flat(headerLines).split("\n");
	check(
		"header is the fold row, not the action it ends with",
		headerLine[1].includes("▼") && headerLine[1].includes("click to collapse") && !flat(headerLines).includes("echo two"),
		flat(headerLines),
	);
	check(
		"header and footer share the row background",
		JSON.stringify(bgSeq(headerLines)) === JSON.stringify(bgSeq(footerLines)),
		`${JSON.stringify(bgSeq(headerLines))} vs ${JSON.stringify(bgSeq(footerLines))}`,
	);
	check("bookends are neutral rather than tool-coloured", bgOf(footerLines[1]) === CODES.toolPendingBg, String(bgOf(footerLines[1])));
	check("footer is one padded line like the header", footerLines.length === 3 && flat(footerLines).split("\n")[1].includes("▲") && flat(footerLines).split("\n")[1].includes("click to collapse"), flat(footerLines));
	check(
		"footer is gapped from the action above it",
		JSON.stringify(bgSeq(openLast.render(80)).slice(-4)) === JSON.stringify([0, CODES.toolPendingBg, CODES.toolPendingBg, CODES.toolPendingBg]),
		JSON.stringify(bgSeq(openLast.render(80)).slice(-4)),
	);

	openLast.children.at(-1).handleMouse({ ...fClick, y: 3 });
	reF1();
	reF2();
	const foldedByFooter = flat(bashF.renderCall(f2Args, theme, f2Ctx).render(80));
	check("footer folds the chapter back", foldedByFooter.includes("▶") && !foldedByFooter.includes("echo one"), foldedByFooter);

	// The footer follows the newest row: a chapter that grows moves it.
	bashF.renderCall(f2Args, theme, f2Ctx).handleMouse(fClick);
	reF1();
	reF2();
	h.startAssistant();
	h.update(assistant([{ type: "toolCall", id: "call-f3", name: "bash", arguments: { command: "echo three" } }]));
	const f3Args = { command: "echo three" };
	const f3Ctx = context({ toolCallId: "call-f3", args: f3Args, expanded: false });
	f3Ctx.invalidate = () => {
		bashF.renderCall(f3Args, theme, f3Ctx);
		bashF.renderResult(fRes, { expanded: false, isPartial: false }, theme, f3Ctx);
	};
	f3Ctx.invalidate();
	const oldLast = flat(bashF.renderResult(fRes, { expanded: false, isPartial: false }, theme, f2Ctx).render(80));
	check("footer leaves the row it no longer ends", !oldLast.includes("collapse"), oldLast);
	const newLast = flat(bashF.renderResult(fRes, { expanded: false, isPartial: false }, theme, f3Ctx).render(80));
	check("footer moves to the newest row", newLast.includes("collapse") && newLast.includes("3 actions"), newLast);
}

// ---------------------------------------------------------------------------
// Scenario 13: ctrl+o folds what is open instead of expanding everything.
{
	const h = await freshZen();
	h.expandedTools = false;
	h.reset();
	h.startAssistant();
	const f1Args = { command: "echo one" };
	const f2Args = { command: "echo two" };
	const fRes = { content: [{ type: "text", text: "out" }], details: {}, isError: false };
	h.update(
		assistant([
			{ type: "toolCall", id: "call-k1", name: "bash", arguments: f1Args },
			{ type: "toolCall", id: "call-k2", name: "bash", arguments: f2Args },
		]),
	);
	const bashK = h.resolver("bash", () => undefined);
	const k1Ctx = context({ toolCallId: "call-k1", args: f1Args, expanded: false });
	const k2Ctx = context({ toolCallId: "call-k2", args: f2Args, expanded: false });
	const reK1 = () => {
		bashK.renderCall(f1Args, theme, k1Ctx);
		bashK.renderResult(fRes, { expanded: false, isPartial: false }, theme, k1Ctx);
	};
	const reK2 = () => {
		bashK.renderCall(f2Args, theme, k2Ctx);
		bashK.renderResult(fRes, { expanded: false, isPartial: false }, theme, k2Ctx);
	};
	k1Ctx.invalidate = reK1;
	k2Ctx.invalidate = reK2;
	reK1();
	reK2();

	const fClick = { type: "click", button: "left", x: 5, y: 1, screenX: 5, screenY: 1, width: 80, height: 4, shift: false, alt: false, ctrl: false, clickCount: 1 };
	check("ctrl+o is left to the core toggle when nothing is open", h.pressKey("\x0f") === false);

	bashK.renderCall(f2Args, theme, k2Ctx).handleMouse(fClick);
	reK1();
	reK2();
	const consumed = h.pressKey("\x0f");
	reK1();
	reK2();
	const afterKey = flat(bashK.renderCall(f2Args, theme, k2Ctx).render(80));
	check("ctrl+o folds an open chapter instead of expanding", consumed === true && afterKey.includes("▶") && !afterKey.includes("echo one"), afterKey);
	check("ctrl+o leaves the global expand state alone", h.expandedTools === false);

	// Under expand-all the same key collapses both the list and the chapter behind it.
	bashK.renderCall(f2Args, theme, k2Ctx).handleMouse(fClick);
	reK1();
	reK2();
	h.expandedTools = true;
	const consumedAll = h.pressKey("\x0f");
	reK1();
	reK2();
	const afterAll = flat(bashK.renderCall(f2Args, theme, k2Ctx).render(80));
	check("ctrl+o under expand-all collapses it", consumedAll === true && h.expandedTools === false, String(h.expandedTools));
	check("and folds the chapter it had open", afterAll.includes("▶"), afterAll);
}

// ---------------------------------------------------------------------------
// Scenario 14: a folded chapter is coloured by its latest result.
{
	const h = await freshZen();
	h.expandedTools = false;
	h.reset();
	h.startAssistant();
	h.update(
		assistant([
			{ type: "toolCall", id: "call-r1", name: "bash", arguments: { command: "false" } },
			{ type: "toolCall", id: "call-r2", name: "bash", arguments: { command: "true" } },
		]),
	);
	const bashColour = h.resolver("bash", () => undefined);
	const r1Ctx = context({ toolCallId: "call-r1", args: { command: "false" }, expanded: false, isError: true });
	const r2Ctx = context({ toolCallId: "call-r2", args: { command: "true" }, expanded: false });
	bashColour.renderCall({ command: "false" }, theme, r1Ctx);
	bashColour.renderResult({ content: [], details: {}, isError: true }, { expanded: false, isPartial: false }, theme, r1Ctx);
	const failedRun = bashColour.renderCall({ command: "false" }, theme, r1Ctx).render(80);
	check("a chapter ending in a failure is red", bgOf(failedRun[1]) === CODES.toolErrorBg, String(bgOf(failedRun[1])));

	bashColour.renderCall({ command: "true" }, theme, r2Ctx);
	bashColour.renderResult({ content: [], details: {}, isError: false }, { expanded: false, isPartial: false }, theme, r2Ctx);
	const recoveredRun = bashColour.renderCall({ command: "true" }, theme, r2Ctx).render(80);
	check("a chapter that recovered shows its latest success", bgOf(recoveredRun[1]) === CODES.toolSuccessBg, String(bgOf(recoveredRun[1])));
	check("...and still counts the failure it survived", flat(recoveredRun).includes("1 failed"), flat(recoveredRun));

	bashColour.renderResult({ content: [], details: {}, isError: false }, { expanded: false, isPartial: true }, theme, r2Ctx);
	const runningRun = bashColour.renderCall({ command: "true" }, theme, r2Ctx).render(80);
	check("a running action keeps the chapter pending", bgOf(runningRun[1]) === CODES.toolPendingBg, String(bgOf(runningRun[1])));
}

// ---------------------------------------------------------------------------
// Scenario 15: a new action must not leave a stale footer gap (double blank line) behind.
{
	const h = await freshZen();
	h.expandedTools = false;
	h.reset();
	h.startAssistant();
	h.update(assistant([{ type: "toolCall", id: "call-g1", name: "bash", arguments: { command: "echo one" } }]));
	const bashG = h.resolver("bash", () => undefined);
	const gRes = { content: [{ type: "text", text: "out" }], details: {}, isError: false };
	const g1Args = { command: "echo one" };
	const g2Args = { command: "echo two" };
	const g1Ctx = context({ toolCallId: "call-g1", args: g1Args, expanded: false });
	const g2Ctx = context({ toolCallId: "call-g2", args: g2Args, expanded: false });
	let g1Result;
	const reG1 = () => {
		bashG.renderCall(g1Args, theme, g1Ctx);
		g1Result = bashG.renderResult(gRes, { expanded: false, isPartial: false }, theme, g1Ctx);
	};
	g1Ctx.invalidate = reG1;
	reG1();
	bashG.renderCall(g1Args, theme, g1Ctx).handleMouse({ type: "click", button: "left", x: 5, y: 1, screenX: 5, screenY: 1, width: 80, height: 4, shift: false, alt: false, ctrl: false, clickCount: 1 });
	g1Result = bashG.renderResult(gRes, { expanded: false, isPartial: false }, theme, g1Ctx);
	check("opened row ends with the fold footer", flat(g1Result.render(80)).includes("collapse"), flat(g1Result.render(80)));

	h.startAssistant();
	h.update(
		assistant([
			{ type: "thinking", thinking: "Next plan." },
			{ type: "toolCall", id: "call-g2", name: "bash", arguments: g2Args },
		]),
	);
	bashG.renderCall(g2Args, theme, g2Ctx);
	check("old row drops its footer gap when the next action starts", g1Result.render(80).length === 0, JSON.stringify(bgSeq(g1Result.render(80))));
}

// ---------------------------------------------------------------------------
// Scenario 16: a run that begins with thinking has no row to draw it on yet, so the working
// line carries the gist until the first tool call gives the chapter a row.
{
	const h = await freshZen();
	h.reset();
	check("no working gist before anything streams", h.workingMessage === undefined, String(h.workingMessage));
	h.startAssistant();
	h.update(assistant([{ type: "thinking", thinking: "First look at the board.\nHidden detail." }]));
	check("the first thinking rides the working line", h.workingMessage === "thinking First look at the board.", String(h.workingMessage));
	h.startAssistant();
	h.update(
		assistant([
			{ type: "thinking", thinking: "First look at the board.\nHidden detail." },
			{ type: "toolCall", id: "call-w", name: "bash", arguments: { command: "ls" } },
		]),
	);
	check("the working line clears once a tool call arrives", h.workingMessage === undefined, String(h.workingMessage));
	h.startAssistant();
	h.update(assistant([{ type: "thinking", thinking: "First look at the board.\nHidden detail." }]));
	h.startAssistant();
	h.update(assistant([{ type: "thinking", thinking: "First look at the board.\nHidden detail." }, { type: "text", text: "answer" }]));
	check("the working line clears when the answer starts", h.workingMessage === undefined, String(h.workingMessage));
	h.startAssistant();
	h.update(assistant([{ type: "thinking", thinking: "x".repeat(300) }]));
	check("a long gist is cut to one row", visibleWidth(String(h.workingMessage)) <= 76, `${visibleWidth(String(h.workingMessage))} cells`);
	h.handlers.get("turn_start")({}, h.ctx);
	check("a new turn starts from a clean line", h.workingMessage === undefined, String(h.workingMessage));
}

// ---------------------------------------------------------------------------
// Scenario 17: with pi's thinking-row hook, a run with no action draws the same purple row in the
// transcript, and the working line stays out of the way.
{
	const h = await freshZen();
	const chatRenderers = [];
	const hookedCtx = {
		...h.ctx,
		ui: {
			...h.ui,
			setThinkingRow: (renderer) => {
				chatRenderers.push(renderer);
			},
		},
	};
	h.handlers.get("session_start")({}, hookedCtx);
	h.expandedTools = false;
	h.startAssistant();
	const chatMsg = assistant([{ type: "thinking", thinking: "Chat row plan.\nChat row detail." }]);
	h.update(chatMsg);
	const chatRenderer = chatRenderers.at(-1);
	const chatRow = chatRenderer(chatMsg, { expanded: false, outputPad: 1 }, theme);
	const chatLines = chatRow.render(80);
	check("chat row shows the thinking gist", flat(chatLines).includes("thinking Chat row plan."), flat(chatLines));
	check("chat row is purple", hasBg(chatLines, "customMessageBg"), JSON.stringify(bgSeq(chatLines)));
	check("chat row replaces the working line", h.workingMessage === undefined, String(h.workingMessage));
	chatRow.handleMouse({ type: "click", button: "left", x: 5, y: 2, screenX: 5, screenY: 2, width: 80, height: 5, shift: false, alt: false, ctrl: false, clickCount: 1 });
	check("chat row opens the full thinking", flat(chatRow.render(80)).includes("Chat row detail."), flat(chatRow.render(80)));
	h.startAssistant();
	const chatToolMsg = assistant([
		{ type: "thinking", thinking: "Chat row plan." },
		{ type: "toolCall", id: "call-chat", name: "bash", arguments: { command: "ls" } },
	]);
	h.update(chatToolMsg);
	check(
		"a message with a tool call gets no chat row",
		chatRenderer(chatToolMsg, { expanded: false, outputPad: 1 }, theme) === undefined,
		"row still returned",
	);
	h.resolver("bash", () => undefined).renderCall({ command: "ls" }, theme, context({ toolCallId: "call-chat", args: { command: "ls" }, expanded: false }));
	check(
		"the chat row folds away once the run has a tool action",
		chatRenderer(chatMsg, { expanded: false, outputPad: 1 }, theme) === undefined,
		"row still returned",
	);

	// A reload rebuilds the entries; a stored run with no action keeps its row.
	const storedChat = assistant([
		{ type: "thinking", thinking: "Stored chat plan." },
		{ type: "text", text: "stored answer" },
	]);
	h.handlers.get("session_start")(
		{},
		{
			...hookedCtx,
			sessionManager: { buildContextEntries: () => [{ type: "message", message: storedChat }] },
		},
	);
	const storedChatRow = chatRenderers.at(-1)(storedChat, { expanded: false, outputPad: 1 }, theme);
	check(
		"a stored tool-less run keeps its chat row",
		storedChatRow !== undefined && flat(storedChatRow.render(80)).includes("Stored chat plan."),
		String(storedChatRow && flat(storedChatRow.render(80))),
	);

	// A narrative tool heads its own chapter but keeps the chat row that led to it.
	h.handlers.get("session_start")({}, hookedCtx);
	h.startAssistant();
	const andonMsg = assistant([
		{ type: "thinking", thinking: "Andon plan." },
		{ type: "toolCall", id: "call-chat-andon", name: "set_andon", arguments: { title: "Task" } },
	]);
	h.update(andonMsg);
	const andonRenderer = h.resolver("set_andon", () => undefined);
	const andonChatCtx = context({ toolCallId: "call-chat-andon", args: { title: "Task" }, expanded: false });
	andonRenderer.renderCall({ title: "Task" }, theme, andonChatCtx);
	const andonChatRow = chatRenderers.at(-1)(andonMsg, { expanded: false, outputPad: 1 }, theme);
	check(
		"a narrative tool keeps the chat row that led to it",
		andonChatRow !== undefined && flat(andonChatRow.render(80)).includes("Andon plan."),
		String(andonChatRow && flat(andonChatRow.render(80))),
	);
	const andonExpanded = flat(andonRenderer.renderCall({ title: "Task" }, theme, { ...andonChatCtx, expanded: true }).render(80));
	check("the expanded narrative row does not repeat it", !andonExpanded.includes("Andon plan."), andonExpanded);

	// A chapter tool still takes the row over.
	h.startAssistant();
	const chapterMsg = assistant([
		{ type: "thinking", thinking: "Chapter plan." },
		{ type: "toolCall", id: "call-chat-bash", name: "bash", arguments: { command: "ls" } },
	]);
	h.update(chapterMsg);
	check(
		"a chapter tool call still folds the chat row away",
		chatRenderers.at(-1)(chapterMsg, { expanded: false, outputPad: 1 }, theme) === undefined,
		"row still returned",
	);
}

// ---------------------------------------------------------------------------
// Scenario 18: rows crossing a session replacement must not touch the old ctx.
{
	const h = await freshZen();
	let stale = false;
	const staleError = "stale extension ctx";
	const replacementCtx = {
		get mode() {
			if (stale) throw new Error(staleError);
			return "tui";
		},
		get ui() {
			if (stale) throw new Error(staleError);
			return h.ui;
		},
		sessionManager: h.sessionManager,
		hasUI: true,
	};
	h.handlers.get("session_start")({}, replacementCtx);
	h.expandedTools = true;
	h.startAssistant();
	const staleMsg = assistant([
		{ type: "thinking", thinking: "Plan before the row." },
		{ type: "toolCall", id: "call-stale", name: "read", arguments: { file_path: "/tmp/stale.ts" } },
	]);
	h.update(staleMsg);
	const staleRead = h.resolver("read", () => undefined);
	const staleCtx = context({ toolCallId: "call-stale", args: { file_path: "/tmp/stale.ts" }, expanded: true });
	const staleRow = staleRead.renderCall({ file_path: "/tmp/stale.ts" }, theme, staleCtx);
	staleRead.renderResult({ content: [], details: {}, isError: false }, { expanded: true, isPartial: false }, theme, staleCtx);
	check("row renders before the ctx goes stale", flat(staleRow.render(80)).includes("Plan before the row"), flat(staleRow.render(80)));
	stale = true;
	let staleFailure;
	let afterReplacement = [];
	try {
		afterReplacement = staleRow.render(80);
	} catch (error) {
		staleFailure = error;
	}
	check("row still renders after the ctx goes stale", staleFailure === undefined, String(staleFailure));
	check("row keeps its thinking after the ctx goes stale", flat(afterReplacement).includes("Plan before the row"), flat(afterReplacement));
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
