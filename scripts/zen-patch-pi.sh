#!/usr/bin/env bash
# Let an empty hidden-thinking label omit the thinking row entirely.
#
# Superseded by zen-install-pi.sh, which installs the whole fork; this stays for
# the case where the fork cannot be built (the live model catalog drifting past
# the source). It patches only the thinking row, not the message spacer.
#
# zen folds thinking into its action line, so pi must be able to drop the
# collapsed row instead of leaving a blank one behind. This patches the
# installed release in place; `pi update` replaces the files, so re-run it
# afterwards. Safe to run twice.
set -euo pipefail

VERSION="$(cat "$HOME/.pi/agent/install/current-version")"
RELEASE="$HOME/.pi/agent/install/releases/$VERSION/node_modules/@earendil-works/pi-coding-agent/dist"
BUNDLE="$RELEASE/bundle/chunks"
MODULE="$RELEASE/modes/interactive/components/assistant-message.js"

patch_file() {
	local file="$1" find="$2" replace="$3"
	[ -f "$file" ] || { echo "missing: $file"; return 1; }
	if grep -qF "$replace" "$file"; then
		echo "already patched: ${file##*/}"
		return 0
	fi
	grep -qF "$find" "$file" || { echo "anchor not found in ${file##*/} — pi changed, re-check the patch"; return 1; }
	[ -f "$file.orig" ] || cp "$file" "$file.orig"
	python3 - "$file" "$find" "$replace" <<'PY'
import sys
path, find, replace = sys.argv[1], sys.argv[2], sys.argv[3]
text = open(path).read()
assert text.count(find) == 1, f"anchor appears {text.count(find)} times"
open(path, "w").write(text.replace(find, replace, 1))
PY
	echo "patched: ${file##*/} (backup: ${file##*/}.orig)"
}

status=0
# The bundled build is what the CLI runs; the unbundled module is what the SDK and tests load.
for chunk in "$BUNDLE"/*.js; do
	if grep -qF "hiddenThinkingLabel" "$chunk"; then
		patch_file "$chunk" \
			'if(i--,thinkingBlocks.length===0)continue;' \
			'if(i--,thinkingBlocks.length===0)continue;if((this.thinkingVisibilityOverrides.get(thinkingRunIndex)??this.hideThinkingBlock)&&this.hiddenThinkingLabel==="")continue;' || status=1
	fi
done

patch_file "$MODULE" \
	'const thinkingComponent = hidden' \
	'if (hidden && this.hiddenThinkingLabel === "") {
					continue;
				}
				const thinkingComponent = hidden' || status=1

exit $status
