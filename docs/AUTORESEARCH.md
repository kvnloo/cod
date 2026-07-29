# Dual-track autoresearch pipeline

This project runs independent Karpathy-style optimization loops for two product faces:

- **Performance** optimizes the existing `low` preset for frame rate and frame pacing.
- **Cinematic** optimizes the existing `cinematic` preset against `docs/VISUAL-BAR.md` while preserving a performance floor.

Each loop gets its own Git branch and worktree. A proposal agent makes one uncommitted change, the evaluator measures the real game in hardware WebGL, and the pinned `hermes-autoresearch` harness commits improvements or reverts rejected trials. Neither loop pushes or promotes automatically.

## Safety model

- Source edits are restricted to `src/`; agents cannot edit evaluators or benchmarks.
- Performance changes must preserve the cinematic guard preset.
- Cinematic changes must preserve the low guard preset.
- Typecheck and production build are hard gates.
- Cinematic evaluation uses deterministic 1440p shots plus a strict visual judge and a 30 fps floor; incremental gains may accumulate from the current baseline until the loop reaches its 60/100 target.
- The visual judge runs from an ignored scratch directory, and a repository fingerprint proves it made no product edits.
- The current branch HEAD is re-baselined before every harness invocation, so restarting a loop cannot accept a regression from its last committed best state.
- Baselines live under Git's private metadata, are bound to repository/branch/HEAD identity, and are hashed across proposal execution.
- Capture APIs, profiling, quality mapping, renderer statistics, and boot wiring are protected from trial edits; exact shot names and camera definitions are frozen by the baseline.
- Proposal completion verifies HEAD, branch, repository, index, baseline hash, and protected paths before evaluation.
- Proposal agents run in a Bubblewrap sandbox backed by a disposable clone and private PID namespace. The real repository and shared Git metadata are read-only; detached descendants die with the namespace, and only independently enumerated, non-ignored, allowlisted regular files are copied back.
- The proposal importer rejects symlinks, commits/staging, protected files, repository-policy files, ignored source injection, and newly introduced capture/debug/URL/environment-conditioned code.
- Evaluators reject inherited `BLACKOUT_URL` values and refuse to reuse an unowned server already listening on their assigned port.
- Runs, captures, generated configs, and the Python environment are ignored by Git.

## Commands

```bash
npm run autoresearch -- bootstrap       # install the pinned Python harness
npm run autoresearch -- status          # inspect branches, worktrees, baselines
npm run autoresearch -- setup all       # create isolated loop worktrees
npm run autoresearch -- baseline all    # measure frozen baselines
npm run autoresearch -- run performance
npm run autoresearch -- run cinematic
```

Run `setup` only from a clean committed `feat/autoresearch-pipeline` branch so each child worktree contains this pipeline. `run all` executes loops serially by default because concurrent GPU benchmarks contaminate one another.

## Agent and visual-judge overrides

Both default to the configured Hermes CLI:

```bash
export AR_AGENT_COMMAND_JSON='["hermes", "chat", "-q"]'
export AR_VISUAL_JUDGE_COMMAND_JSON='["hermes", "chat", "-q"]'
```

The command array must accept the generated prompt as its final argument. The cinematic judge must be able to inspect local PNG files and return a final one-line JSON object containing a numeric `score`.

## Promotion

Accepted trials stay on `autoresearch/performance` or `autoresearch/cinematic`. Review metrics and diffs before selectively merging or cherry-picking into an integration branch. A later balanced loop can evaluate both tracks and prepare the user-facing preset release; this pipeline deliberately does not merge specialist branches automatically.
