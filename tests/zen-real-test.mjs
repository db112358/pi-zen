// Smoke test against the installed builtin renderers: an opened write row shows its content and
// an opened edit row (self-framed) shows its diff without double framing. Run from this directory.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const release = readFileSync(join(AGENT_DIR, "install", "current-version"), "utf8").trim();
const dist = join(AGENT_DIR, "install", "releases", release, "node_modules/@earendil-works/pi-coding-agent/dist");

const jiti = createJiti(import.meta.url);
const themeMod = await jiti.import(`${dist}/modes/interactive/theme/theme.js`);
themeMod.initTheme("dark");
const theme = themeMod.theme;
const { createAllToolRenderers } = await jiti.import(`${dist}/core/tools/renderers/index.js`);
const builtins = createAllToolRenderers();

const mod = await jiti.import(new URL("../extensions/zen.ts", import.meta.url).pathname);
let expandedTools = true;
const handlers = new Map();
const pi = {
	on: (event, handler) => handlers.set(event, handler),
	registerCommand: () => {},
	registerToolRenderer: (resolver) => {
		pi.resolver = resolver;
	},
};
mod.default(pi);
const ctx = {
	mode: "tui",
	ui: {
		getToolsExpanded: () => expandedTools,
		setHiddenThinkingLabel: () => {},
		notify: () => {},
		setStatus: () => {},
	},
	sessionManager: { buildContextEntries: () => [] },
	hasUI: true,
};
handlers.get("session_start")({}, ctx);

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const flat = (lines) => lines.map(strip).join("\n");
const click = { type: "click", button: "left", x: 5, y: 1, screenX: 5, screenY: 1, width: 100, height: 6, shift: false, alt: false, ctrl: false, clickCount: 1 };
let failures = 0;
const check = (name, ok, extra = "") => {
	if (ok) console.log(`ok   ${name}`);
	else {
		failures++;
		console.log(`FAIL ${name}${extra ? `\n${extra}` : ""}`);
	}
};

function toolRow(toolName, args, result, builtin) {
	handlers.get("message_start")({ message: { role: "assistant", content: [] } });
	handlers.get("message_update")({
		message: { role: "assistant", content: [{ type: "toolCall", id: `${toolName}-1`, name: toolName, arguments: args }] },
	});
	const renderers = pi.resolver(toolName, () => builtin);
	const context = {
		args,
		toolCallId: `${toolName}-1`,
		invalidate: () => {},
		lastComponent: undefined,
		state: {},
		cwd: "/tmp",
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: true,
		showImages: false,
		isError: false,
		durationMs: undefined,
		outputPad: 1,
	};
	const component = renderers.renderCall(args, theme, context);
	renderers.renderResult(result, { expanded: true, isPartial: false }, theme, context);
	component.handleMouse(click);
	renderers.renderCall(args, theme, context);
	renderers.renderResult(result, { expanded: true, isPartial: false }, theme, context);
	return flat(component.render(100));
}

const writeArgs = { file_path: "/tmp/w.txt", content: "first line of the file\nsecond line of the file" };
const writeRow = toolRow("write", writeArgs, { content: [], details: {}, isError: false }, builtins.write);
check("opened write row shows the file content", writeRow.includes("first line of the file"), writeRow);

const editArgs = { file_path: "/tmp/e.txt", edits: [{ oldText: "old", newText: "new" }] };
const editRow = toolRow("edit", editArgs, { content: [{ type: "text", text: "ok" }], details: { diff: "--- a\n+++ b\n-old\n+new" }, isError: false }, { ...builtins.edit, renderShell: "self" });
check("opened edit row shows the diff", editRow.includes("-old") && editRow.includes("+new"), editRow);
check("self-framed edit row keeps a single indent", editRow.includes("\n edit ") && !editRow.includes("\n  edit "), editRow);

const bashArgs = { command: "echo hello" };
const bashRow = toolRow("bash", bashArgs, { content: [{ type: "text", text: "hello\nworld" }], details: {}, isError: false }, builtins.bash);
check("opened bash row shows the output", bashRow.includes("hello") && bashRow.includes("world"), bashRow);

console.log(failures === 0 ? "\nall real-builtin checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
