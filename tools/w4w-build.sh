#!/bin/sh
# Private build helper for the view-model pass.
#
# Other agents are iterating in the same tree and one of them currently has a
# hard-coded diagnostic (DEBUG_SHADOW) in src/render/MaterialPatch.ts that
# replaces the whole frame with a red/green mask. That file is not mine to
# edit, so this builds from a throw-away mirror with the flag forced off and
# writes the bundle back into the repo's dist-w4w.
set -e
ROOT=/workspace/zer0/products/cod
MIR=/tmp/claude-1000/-workspace-zer0-products-cod/572583e0-c99f-4e97-a15b-009edac54737/scratchpad/mirror-w4w

mkdir -p "$MIR"
rsync -a --delete \
  --exclude node_modules --exclude shots --exclude 'dist*' --exclude .git \
  "$ROOT/" "$MIR/"
ln -sfn "$ROOT/node_modules" "$MIR/node_modules"
# W4W_HEAD=1 rolls every module except src/weapons back to the last commit, so
# the view model can be judged against a stable world instead of against nine
# other agents' half-applied edits.
if [ -n "$W4W_HEAD" ]; then
  rm -rf "$MIR/src"
  (cd "$ROOT" && git archive HEAD src | tar -x -C "$MIR")
  rm -rf "$MIR/src/weapons"
  cp -r "$ROOT/src/weapons" "$MIR/src/weapons"
fi
sed -i 's/^const DEBUG_SHADOW = true;/const DEBUG_SHADOW = false;/' "$MIR/src/render/MaterialPatch.ts"
# W4W_NODOF=1 kills depth of field in the *mirror only*, so the view model can
# be judged on its own detail rather than on someone else's bokeh kernel.
if [ -n "$W4W_NODOF" ]; then
  sed -i 's/^  dof: true,/  dof: false,/' "$MIR/src/core/Settings.ts"
  sed -i 's/dofQuality: 1.5,/dofQuality: 1.5, dof: false,/' "$MIR/src/core/Settings.ts"
fi
cd "$MIR"
npx vite build --outDir "$ROOT/dist-w4w" --emptyOutDir 2>&1 | tail -3
