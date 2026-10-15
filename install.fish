#!/usr/bin/env fish
# Install zen: symlink its extension into ~/.pi/agent/extensions. Idempotent.
# Safe to re-run after moving the repo.

set -l repo (cd (dirname (status filename)); and pwd)
set -l ext_dir ~/.pi/agent/extensions

# Type resolution for the editor and tests: point node_modules at the active release.
if not test -e $repo/node_modules
    set -l active (readlink $ext_dir/node_modules)
    if test -n "$active"
        ln -sfn "$active" $repo/node_modules
        echo "zen: node_modules -> $active"
    else
        echo "zen: no active pi node_modules; run 'dbe pi install-types' after installing pi" >&2
    end
end

mkdir -p $ext_dir
for f in extensions/zen.ts scripts/zen-install-pi.sh scripts/zen-patch-pi.sh
    set -l target $ext_dir/(basename $f)
    if test -f $target; and not test -L $target
        mv $target $target.bak
        echo "zen: backed up $target -> $target.bak"
    end
    ln -sfn $repo/$f $target
    echo "zen: $target -> $repo/$f"
end
