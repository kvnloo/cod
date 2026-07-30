#!/bin/sh
# Isolated build for the sun-exposure agent: HEAD's tree for every file another
# agent might be mid-edit on, plus this agent's three working files. Keeps the
# capture loop from being poisoned by someone else's half-applied change.
set -e
cd /workspace/zer0/products/cod
BD=.w4a-iso
rm -rf "$BD/src"
git archive HEAD src | tar -x -C "$BD"
cp src/render/Sky.ts "$BD/src/render/Sky.ts"
cp src/render/Exposure.ts "$BD/src/render/Exposure.ts"
cp src/world/World.ts "$BD/src/world/World.ts"
cd "$BD"
npx vite build --outDir /workspace/zer0/products/cod/dist-w4a --emptyOutDir "$@"
