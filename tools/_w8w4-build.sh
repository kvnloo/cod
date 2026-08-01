#!/bin/sh
# W4 (surfaces) private build helper.
#
# Other packages are editing the same tree this wave, so every number this
# package reports is measured on an isolated worktree pinned to HEAD with only
# W4's four owned files copied in on top. That is the only way a material
# measurement taken now is comparable with one taken in an hour.
set -e
ROOT=/workspace/zer0/products/cod
WT=/tmp/claude-1000/-workspace-zer0-products-cod/572583e0-c99f-4e97-a15b-009edac54737/scratchpad/wt-w4

if [ "$1" != "--pristine" ]; then
  cp "$ROOT/src/material/DetailMaps.ts"      "$WT/src/material/DetailMaps.ts"
  cp "$ROOT/src/material/MaterialLibrary.ts" "$WT/src/material/MaterialLibrary.ts"
  cp "$ROOT/src/material/MaterialShaders.ts" "$WT/src/material/MaterialShaders.ts"
  cp "$ROOT/src/world/MatCatalog.ts"         "$WT/src/world/MatCatalog.ts"
fi
cd "$WT"
npx vite build --outDir "$ROOT/dist-w8-w4" --emptyOutDir 2>&1 | tail -3
