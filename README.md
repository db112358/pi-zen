# pi-zen

Zen mode for [pi](https://github.com/earendil-works/pi): one row per run.

Tool calls and thinking fold into a single row that follows the latest action, so a long turn
cannot bury the conversation in command output.

- **Chapter row** — everything since the last user message is one `▶ N actions · …` line.
- **First thinking** — a run with no action yet shows its thinking as the same purple row in the
  transcript, until the first tool call gives the chapter a row. A narrative row (`set_andon`)
  never takes that row over: it stays above the card.
- **Click it** — the chapter opens into one summary row per action and thinking block, closed by
  a `▼` row above and an `▲` row below; either one folds it back, so a long chapter never strands
  the fold target at the top.
- **Click a row** — thinking rows toggle between a one-line gist and the full text; action rows
  open the tool's own detail (command output, diff, file content).
- **ctrl+o** — the same list for every chapter at once. While a chapter is open, ctrl+o folds it
  first instead of expanding everything.
- **`/zen on|off`** — toggle zen rendering; the choice persists across sessions.

## Requirements

Zen needs a pi that can omit hidden thinking blocks: `setHiddenThinkingLabel("")` leaves the
block out instead of drawing a blank row, a thinking-only message reserves no spacer, and
`ctx.ui.setThinkingRow()` lets zen draw the run's purple thinking row in its place. Without the
row hook the gist rides the working line instead.

That patch lives on the `local/zen` branch of [db112358/pi](https://github.com/db112358/pi).
Without it zen still loads, but warns once and falls back to pi's default thinking label.

Build the patched pi with [`scripts/zen-install-pi.sh`](scripts/zen-install-pi.sh); it swaps the
fork's dist into the managed release and `--restore` puts the stock release back. `pi update`
replaces the release, so re-run the script afterwards.

## Install

```sh
pi install git:github.com/db112358/pi-zen
```

Or clone and symlink for development:

```sh
git clone https://github.com/db112358/pi-zen
cd pi-zen
./install.fish
```

## Layout

```
extensions/zen.ts         the extension: settings, lifecycle and tool renderers
extensions/lib/format.ts  pure formatting: action lines, result summaries, thinking text
extensions/lib/model.ts   the chapter model: entries, grouping, shared maps, rebuild
scripts/                  fork install and patch helpers
tests/zen-harness.mjs     component-level checks (fake pi, no terminal)
tests/zen-real-test.mjs   smoke test against the installed builtin renderers
tests/zen-click-test.sh   end-to-end: real pi under tmux with injected SGR mouse events
```

## Tests

```sh
npm test            # harness + real-builtin checks
npm run test:click  # needs tmux; also covers /reload
```
