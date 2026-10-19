#!/usr/bin/env bash
# Build the local pi fork and install it as the pi that runs on this machine.
#
# The fork is github.com/db112358/pi, branch local/zen, checked out at
# ~/scratchpad/pi by default. Its model catalog
# is pinned by nix/model-catalog.json, so the build is reproducible: hydration
# uses that revision instead of whatever the live catalog says today, which is
# what lets a checkout type-check at all.
#
#   zen-install-pi.sh              rebuild and install
#   zen-install-pi.sh --no-build   install the existing build
#   zen-install-pi.sh --restore    put the stock release back
#
# Rebase onto a new upstream release by merging/replaying the local commits
# onto the tag; the tag carries its own catalog pin, and this script hydrates
# from it the next time the data does not match.
#
# `pi update` replaces the release, so re-run this after updating.
set -euo pipefail

CHECKOUT="${PI_FORK:-$HOME/scratchpad/pi}"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
CATALOG_TYPES="types=chat,image,classifier"

build=true
restore=false
for arg in "$@"; do
	case "$arg" in
		--no-build) build=false ;;
		--restore) restore=true ;;
		*) echo "unknown option: $arg" >&2; exit 2 ;;
	esac
done

RELEASE_VERSION="$(cat "$AGENT_DIR/install/current-version")"
PACKAGE="$AGENT_DIR/install/releases/$RELEASE_VERSION/node_modules/@earendil-works/pi-coding-agent"
FORK_DIST="$CHECKOUT/packages/coding-agent/dist"

[ -d "$PACKAGE" ] || { echo "no managed release at $PACKAGE" >&2; exit 1; }

if [ "$restore" = true ]; then
	[ -d "$PACKAGE/dist.orig" ] || { echo "no backup to restore (was the fork ever installed?)" >&2; exit 1; }
	rm -rf "$PACKAGE/dist" && mv "$PACKAGE/dist.orig" "$PACKAGE/dist"
	echo "restored the stock release $RELEASE_VERSION"
	exit 0
fi

# Provider data has to come from the pinned revision, not the live catalog: the
# source only type-checks against the catalog that shipped with its version.
hydrate_from_pin() {
	local pin revision catalog
	pin="$CHECKOUT/nix/model-catalog.json"
	[ -f "$pin" ] || { echo "no catalog pin at $pin" >&2; exit 1; }
	revision="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['revision'])" "$pin")"
	catalog="$(mktemp -t pi-model-catalog)"
	echo "hydrating model data from pinned catalog ${revision#sha256-}"
	curl -fsSL "https://pi.dev/api/models/revisions/$revision?$CATALOG_TYPES" -o "$catalog"
	local got
	got="sha256-$(shasum -a 256 "$catalog" | cut -d' ' -f1)"
	[ "$got" = "$revision" ] || { echo "catalog bytes do not match the pin ($got)" >&2; exit 1; }
	(cd "$CHECKOUT" && node packages/ai/scripts/hydrate-model-catalog.ts "$catalog")
	rm -f "$catalog"
}

if [ "$build" = true ]; then
	echo "building $CHECKOUT ($(git -C "$CHECKOUT" rev-parse --short HEAD) on $(git -C "$CHECKOUT" branch --show-current))"
	if ! npm --prefix "$CHECKOUT/packages/ai" run check:model-data >/dev/null 2>&1; then
		hydrate_from_pin
		(cd "$CHECKOUT" && npm run build:offline)
	fi
	# The coding-agent build type-checks against pi-tui's built declarations.
	(cd "$CHECKOUT" && npm --prefix packages/tui run build)
	(cd "$CHECKOUT" && npm --prefix packages/coding-agent run build)
fi

[ -d "$FORK_DIST" ] || { echo "no build at $FORK_DIST" >&2; exit 1; }

# The zen patches have to be in the bundle the CLI runs, or thinking rows come back.
if ! grep -q 'hiddenThinkingLabel===""' "$FORK_DIST"/bundle/chunks/*.js; then
	echo "the fork's build has no thinking-omission patch — did the rebase drop it?" >&2
	exit 1
fi

[ -d "$PACKAGE/dist.orig" ] || cp -R "$PACKAGE/dist" "$PACKAGE/dist.orig"
rm -rf "$PACKAGE/dist"
cp -R "$FORK_DIST" "$PACKAGE/dist"

echo "installed $CHECKOUT into release $RELEASE_VERSION"
echo "  backup: $PACKAGE/dist.orig   (restore with $0 --restore)"
echo "  version: $("$AGENT_DIR/bin/pi" --version)"
echo "restart pi to pick it up"
