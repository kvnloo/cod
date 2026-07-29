# Autoresearch trial contract

1. Pursue exactly one focused hypothesis in this trial.
2. Modify only the allowlisted paths in the trial prompt.
3. Do not alter benchmarks, capture shots, evaluator scripts, quality gates, or Git configuration.
3a. Do not alter any protected path listed in the trial prompt or the external baseline state.
4. Keep track-specific work behind the target quality preset. Never degrade the guard preset to improve the target.
5. Do not stage, commit, merge, rebase, create branches, or push. Leave a cleanly reviewable uncommitted diff for the harness.
5a. The proposal runs in a disposable sandbox; only validated allowlisted regular files are imported into the experiment worktree.
6. Run the smallest relevant verification needed for the hypothesis, but do not self-accept. The external evaluator decides KEEP or REVERT.
7. Exit nonzero if blocked. Do not attempt a second hypothesis or launch background processes.
