#!/usr/bin/env bash
# End-to-end click test for zen: runs the real pi in a tmux pane and injects SGR mouse
# sequences, so the full TUI dispatch path is exercised (press -> selection -> click).
#
#   zen-click-test.sh          run the test
#
# Needs tmux and python3. Uses a throwaway session in a temp dir, so it never touches
# the real sessions.
set -euo pipefail

PI="${PI_BIN:-$HOME/.pi/agent/bin/pi}"
NAME="zen-click-test-$$"
DIR="$(mktemp -d -t zen-click-test)"
cleanup() {
	tmux kill-session -t "$NAME" 2>/dev/null || true
	rm -rf "$DIR"
}
trap cleanup EXIT

command -v tmux >/dev/null || { echo "tmux is required" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }
[ -x "$PI" ] || { echo "no pi binary at $PI (set PI_BIN)" >&2; exit 1; }

python3 - "$DIR/session.jsonl" <<'PY'
import json, sys, time

now = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
ms = int(time.time() * 1000)

def entry(id, parent, message):
    return json.dumps({"type": "message", "id": id, "parentId": parent, "timestamp": now, "message": message})

usage = {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 0, "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}}
lines = [
    json.dumps({"type": "session", "version": 3, "id": "01a13ee6-1138-7780-8d10-c5c469797c5e", "timestamp": now, "cwd": "/tmp"}),
    entry("m1", None, {"role": "user", "content": [{"type": "text", "text": "click test"}], "timestamp": ms}),
    entry("m2", "m1", {"role": "assistant", "content": [
        {"type": "thinking", "thinking": "Plan the calls.\nZENCLICKTHINK detail.", "thinkingSignature": ""},
        {"type": "toolCall", "id": "call_bash", "name": "bash", "arguments": {"command": "printf 'ZENOUT-%s\\n' one two"}},
        {"type": "toolCall", "id": "call_write", "name": "write", "arguments": {"file_path": "/tmp/zen-click.txt", "content": "ZENWRITEOUT-1\nZENWRITEOUT-2"}},
    ], "api": "openai-responses", "provider": "openai", "model": "gpt-4o-mini", "usage": usage, "stopReason": "toolUse", "timestamp": ms}),
    entry("m3", "m2", {"role": "toolResult", "toolCallId": "call_bash", "toolName": "bash", "content": [{"type": "text", "text": "ZENOUT-one\nZENOUT-two"}], "details": {}, "isError": False, "durationMs": 5, "timestamp": ms}),
    entry("m4", "m3", {"role": "toolResult", "toolCallId": "call_write", "toolName": "write", "content": [{"type": "text", "text": "Wrote /tmp/zen-click.txt"}], "details": {}, "isError": False, "durationMs": 5, "timestamp": ms}),
    entry("m5", "m4", {"role": "assistant", "content": [{"type": "text", "text": "done"}], "api": "openai-responses", "provider": "openai", "model": "gpt-4o-mini", "usage": usage, "stopReason": "stop", "timestamp": ms}),
    entry("m6", "m5", {"role": "user", "content": [{"type": "text", "text": "second thought"}], "timestamp": ms}),
    entry("m7", "m6", {"role": "assistant", "content": [
        {"type": "thinking", "thinking": "Final reasoning.\nZENFINAL detail.", "thinkingSignature": ""},
        {"type": "text", "text": "ZENFINAL answer."},
    ], "api": "openai-responses", "provider": "openai", "model": "gpt-4o-mini", "usage": usage, "stopReason": "stop", "timestamp": ms}),
]
open(sys.argv[1], "w").write("\n".join(lines) + "\n")
PY

screen() { tmux capture-pane -t "$NAME" -p; }
row_of() { screen | grep -n "$1" | head -1 | cut -d: -f1 || true; }

click_row() {
	local y="$1"
	[ -n "$y" ] || { echo "FAIL: no row to click"; failures=$((failures + 1)); return; }
	local yhex=()
	for ((i = 0; i < ${#y}; i++)); do
		yhex+=("$(printf '%02x' "'${y:i:1}")")
	done
	tmux send-keys -t "$NAME" -H 1b 5b 3c 30 3b 31 30 3b "${yhex[@]}" 4d # press at column 10
	tmux send-keys -t "$NAME" -H 1b 5b 3c 30 3b 31 30 3b "${yhex[@]}" 6d # release
}

tmux new-session -d -s "$NAME" -x 120 -y 40 "cd $DIR && $PI --session $DIR/session.jsonl"
for _ in $(seq 1 60); do
	screen | grep -q "click test" && break
	sleep 0.5
done
screen | grep -q "click test" || { echo "pi did not start"; screen; exit 1; }

failures=0
check_row() {
	local label="$1" match="$2" marker="$3"
	local y
	y="$(row_of "$match")"
	[ -n "$y" ] || { echo "FAIL $label: row not found ($match)"; failures=$((failures + 1)); return; }
	if screen | grep -q "$marker"; then
		echo "FAIL $label: detail already visible before the click"
		failures=$((failures + 1))
		return
	fi
	click_row "$y"
	sleep 1
	if screen | grep -q "$marker"; then
		echo "ok   $label"
	else
		echo "FAIL $label: click did not open the row"
		failures=$((failures + 1))
	fi
}

# Clicking the chapter summary row expands the whole chapter into its rows.
# The chapter has to be on screen: grow the pane so rows added above it cannot push its header out.
tmux resize-window -t "$NAME" -x 120 -y 90
sleep 1
if screen | grep -q "▶"; then
	echo "ok   collapsed chapter shows the sideways chevron"
else
	echo "FAIL collapsed chapter has no chevron"
	failures=$((failures + 1))
fi
chapter_y="$(row_of "actions")"
[ -n "$chapter_y" ] || { echo "FAIL chapter row not found"; screen; exit 1; }
click_row "$chapter_y"
sleep 1
if screen | grep -q "thinking Plan the calls." && screen | grep -q "printf 'ZENOUT-%s" && screen | grep -q "write /tmp/zen-click.txt" && screen | grep -q "▼"; then
	echo "ok   chapter row expands into its rows (down chevron header)"
else
	echo "FAIL chapter row did not expand"
	screen
	failures=$((failures + 1))
fi

# The header folds it back.
header_y="$(row_of "▼")"
if [ -z "$header_y" ]; then
	echo "FAIL opened chapter has no down chevron header"
	screen
	failures=$((failures + 1))
else
	click_row "$header_y"
	sleep 1
	if screen | grep -q "ZENOUT-one"; then
		echo "FAIL chapter header did not fold the rows"
		screen
		failures=$((failures + 1))
	else
		echo "ok   chapter header folds it back"
	fi
fi

# The footer is the same fold target at the end of the list, where a long chapter is read.
chapter_y="$(row_of "actions")"
click_row "$chapter_y"
sleep 1
footer_y="$(row_of "▲")"
if [ -z "$footer_y" ]; then
	echo "FAIL opened chapter has no footer row"
	screen
	failures=$((failures + 1))
else
	click_row "$footer_y"
	sleep 1
	if screen | grep -q "ZENOUT-one"; then
		echo "FAIL footer did not fold the rows"
		screen
		failures=$((failures + 1))
	else
		echo "ok   footer folds the chapter back"
	fi
fi

# ctrl+o folds what is open instead of expanding every chapter.
chapter_y="$(row_of "actions")"
click_row "$chapter_y"
sleep 1
tmux send-keys -t "$NAME" C-o
sleep 1
if screen | grep -q "ZENOUT-one"; then
	echo "FAIL ctrl+o did not fold the open chapter"
	screen
	failures=$((failures + 1))
else
	echo "ok   ctrl+o folds the open chapter"
fi

# Reopen and check the individual rows.
chapter_y="$(row_of "actions")"
click_row "$chapter_y"
sleep 1
check_row "thinking row opens" "thinking Plan the calls." "ZENCLICKTHINK detail."
check_row "bash row opens" "printf 'ZENOUT-%s" "ZENOUT-one"
check_row "write row opens" "^ *write /tmp/zen-click.txt" "ZENWRITEOUT-1"

# After /reload the chat is rebuilt from stored history; the chapter must still expand.
tmux send-keys -t "$NAME" -l "/reload"
tmux send-keys -t "$NAME" Enter
sleep 5
# A run with no tool call keeps its purple thinking row through the rebuild.
if [ -z "$(row_of "thinking Final reasoning.")" ]; then
	echo "FAIL tool-less thinking row not on screen after /reload"
	screen
	failures=$((failures + 1))
else
	check_row "tool-less thinking row opens" "thinking Final reasoning." "ZENFINAL detail."
fi

reload_y="$(row_of "actions")"
click_row "$reload_y"
sleep 1
if screen | grep -q "thinking Plan the calls." && screen | grep -q "printf 'ZENOUT-%s"; then
	echo "ok   chapter expands after /reload"
else
	echo "FAIL chapter did not expand after /reload"
	screen
	failures=$((failures + 1))
fi

[ "$failures" -eq 0 ] && echo "all click checks passed" || echo "$failures click check(s) failed"
exit "$failures"
