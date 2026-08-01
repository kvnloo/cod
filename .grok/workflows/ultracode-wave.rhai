let meta = #{
    name: "ultracode-wave",
    description: "Grok ultracode for cod: orchestrate prompt.md wave loops (measure, audit, package, fix, critique) until hard playtest gates pass",
    when_to_use: "After Claude handoff or any time prompt.md quality loop should run with the main thread only orchestrating",
    phases: [
        #{ title: "Measure", detail: "playtest hard gates on real GPU; report failures" },
        #{ title: "Audit", detail: "parallel domain auditors (read-only), visual and non-visual" },
        #{ title: "Synthesize", detail: "merge findings into disjoint file-ownership packages" },
        #{ title: "Fix", detail: "one agent per package, numeric acceptance gates" },
        #{ title: "Land", detail: "typecheck + re-measure; commit only if gates improve" },
        #{ title: "Critique", detail: "independent critics re-measure; refuse self-grade" },
        #{ title: "Loop", detail: "repeat on remaining hard fails until pass or max rounds" },
    ],
};

// --- schemas ----------------------------------------------------------------

let measure_schema = #{
    "type": "object",
    "required": ["pass", "hard_failed", "report_path", "notes"],
    "properties": #{
        "pass": #{ "type": "boolean" },
        "hard_failed": #{
            "type": "array",
            "maxItems": 20,
            "items": #{
                "type": "object",
                "required": ["id", "measured", "target"],
                "properties": #{
                    "id": #{ "type": "string" },
                    "measured": #{ "type": "string" },
                    "target": #{ "type": "string" },
                },
            },
        },
        "advisory_failed": #{
            "type": "array",
            "maxItems": 12,
            "items": #{ "type": "string" },
        },
        "report_path": #{ "type": "string" },
        "notes": #{ "type": "string" },
    },
};

let findings_schema = #{
    "type": "object",
    "required": ["domain", "findings"],
    "properties": #{
        "domain": #{ "type": "string" },
        "findings": #{
            "type": "array",
            "maxItems": 10,
            "items": #{
                "type": "object",
                "required": ["file", "line", "severity", "issue", "mode"],
                "properties": #{
                    "file": #{ "type": "string" },
                    "line": #{ "type": "number" },
                    "severity": #{ "type": "string" },
                    "issue": #{ "type": "string" },
                    "mode": #{ "type": "string" },
                    "fix_hint": #{ "type": "string" },
                },
            },
        },
    },
};

let packages_schema = #{
    "type": "object",
    "required": ["packages", "deferred", "rationale"],
    "properties": #{
        "packages": #{
            "type": "array",
            "maxItems": 6,
            "items": #{
                "type": "object",
                "required": ["id", "title", "owned_files", "findings", "acceptance"],
                "properties": #{
                    "id": #{ "type": "string" },
                    "title": #{ "type": "string" },
                    "owned_files": #{
                        "type": "array",
                        "maxItems": 24,
                        "items": #{ "type": "string" },
                    },
                    "findings": #{
                        "type": "array",
                        "maxItems": 12,
                        "items": #{ "type": "string" },
                    },
                    "acceptance": #{ "type": "string" },
                    "verify_cmd": #{ "type": "string" },
                },
            },
        },
        "deferred": #{
            "type": "array",
            "maxItems": 20,
            "items": #{ "type": "string" },
        },
        "rationale": #{ "type": "string" },
    },
};

let fix_schema = #{
    "type": "object",
    "required": ["id", "changed", "files_touched", "summary", "self_check"],
    "properties": #{
        "id": #{ "type": "string" },
        "changed": #{ "type": "boolean" },
        "files_touched": #{
            "type": "array",
            "maxItems": 24,
            "items": #{ "type": "string" },
        },
        "summary": #{ "type": "string" },
        "self_check": #{ "type": "string" },
        "blocked": #{ "type": "string" },
    },
};

let critique_schema = #{
    "type": "object",
    "required": ["verdict", "still_failing", "now_at_bar", "evidence"],
    "properties": #{
        "verdict": #{ "type": "string" },
        "still_failing": #{
            "type": "array",
            "maxItems": 16,
            "items": #{ "type": "string" },
        },
        "now_at_bar": #{
            "type": "array",
            "maxItems": 16,
            "items": #{ "type": "string" },
        },
        "evidence": #{ "type": "string" },
        "next_wave_priority": #{ "type": "string" },
    },
};

// --- args -------------------------------------------------------------------
// max_rounds: wave iterations (default 4)
// max_packages: packages per wave (default 4)
// dry_run: measure+audit+synthesize only
// skip_measure: reuse latest playtest report without re-running
// no_commit: land phase typechecks but does not git commit

let max_rounds = 4;
let max_packages = 4;
let dry_run = false;
let skip_measure = false;
let no_commit = false;

if args != () {
    if args.max_rounds != () { max_rounds = args.max_rounds; }
    if args.max_packages != () { max_packages = args.max_packages; }
    if args.dry_run == true { dry_run = true; }
    if args.skip_measure == true { skip_measure = true; }
    if args.no_commit == true { no_commit = true; }
}

if max_rounds < 1 { max_rounds = 1; }
if max_rounds > 12 { max_rounds = 12; }
if max_packages < 1 { max_packages = 1; }
if max_packages > 6 { max_packages = 6; }

// Fixed audit domains — always cover visual AND non-visual (prompt.md doctrine).
// Order is stable; contents of each prompt adapt to hard_failed from measure.
let audit_domains = [
    "combat-hitboxes-ttk",
    "perf-frame-shadows",
    "gunfeel-feedback-juice",
    "movement-skill-expression",
    "ai-lethality-pacing",
    "animation-death-av-sync",
];

let history = [];
let round = 0;
let all_hard_pass = false;
let last_failed_fp = "";
let stall_streak = 0;

log("ultracode-wave start: max_rounds=" + max_rounds.to_string()
    + " max_packages=" + max_packages.to_string()
    + " dry_run=" + if dry_run { "true" } else { "false" }
    + " — GROK ultracode orchestrator; children do the work");

// ---------------------------------------------------------------------------
// OUTER WAVE LOOP
// ---------------------------------------------------------------------------
while round < max_rounds {
    round += 1;
    let round_s = round.to_string();
    log("======== WAVE " + round_s + " / " + max_rounds.to_string() + " ========");

    // ---- MEASURE -----------------------------------------------------------
    phase("Measure");
    let measure_prompt = "";
    measure_prompt += "You are the MEASURE agent for Operation Blackout (repo: current cwd).\n";
    measure_prompt += "Doctrine lives in prompt.md and docs/PLAYTEST.md. Screenshots are NOT sufficient.\n\n";
    measure_prompt += "HARD RULES:\n";
    measure_prompt += "1) Use shell tools. Do not invent gate numbers.\n";
    measure_prompt += "2) Read any existing report first for context:\n";
    measure_prompt += "   - shots/gpc-combat/playtest-default.json (post-gameplay critic)\n";
    measure_prompt += "   - shots/playtest/report.json\n";
    measure_prompt += "3) ";
    if skip_measure {
        measure_prompt += "SKIP_MEASURE is set: do NOT re-run playtest. Parse the newest existing report only.\n";
    } else {
        measure_prompt += "Run a fresh playtest on the real GPU:\n";
        measure_prompt += "   node tools/playtest.mjs --json shots/playtest/report-wave" + round_s + ".json\n";
        measure_prompt += "   If build already exists and you need speed: node tools/playtest.mjs --no-build --json shots/playtest/report-wave" + round_s + ".json\n";
        measure_prompt += "   Prefer a FULL build on round 1. Use --no-build only if dist-gp-h is fresh and typecheck is clean.\n";
        measure_prompt += "   Ensure GPU path (harness must show ANGLE NVIDIA / real GPU, not llvmpipe).\n";
    }
    measure_prompt += "4) List EVERY hard gate that fails with measured vs target.\n";
    measure_prompt += "5) Known open hard fails at Grok handoff (30e0515): frame-p99, frame-spikes, hitbox-zones, ttk-lethal.\n";
    measure_prompt += "6) report_path must be a real path you read.\n";
    measure_prompt += "7) notes: one paragraph on what the numbers mean for the next wave.\n";

    let measure = agent(measure_prompt, #{
        label: "measure-w" + round_s,
        capability_mode: "execute",
        output_schema: measure_schema,
    });

    let hard_failed = [];
    let report_path = "shots/playtest/report.json";
    let measure_notes = "";
    let wave_pass = false;

    if measure != () && measure.success && measure.output != () {
        wave_pass = measure.output.pass == true;
        if measure.output.hard_failed != () {
            hard_failed = measure.output.hard_failed;
        }
        if measure.output.report_path != () {
            report_path = measure.output.report_path;
        }
        if measure.output.notes != () {
            measure_notes = measure.output.notes;
        }
    } else {
        log("Measure agent failed or returned unusable output — treating as all-critical fail and continuing with known open gates");
        hard_failed = [
            #{ id: "frame-p99", measured: "unknown", target: "<=16.7" },
            #{ id: "frame-spikes", measured: "unknown", target: "==0" },
            #{ id: "hitbox-zones", measured: "unknown", target: ">=3" },
            #{ id: "ttk-lethal", measured: "unknown", target: "==0" },
        ];
        measure_notes = "measure failed; using handoff open gates";
    }

    let fail_ids = [];
    for g in hard_failed {
        if g.id != () {
            fail_ids.push(g.id);
        }
    }
    let fail_blob = json_encode(hard_failed);
    let fail_fp = fingerprint(fail_blob);
    log("Wave " + round_s + " measure: pass=" + if wave_pass { "true" } else { "false" }
        + " hard_failed=" + fail_ids.len().to_string()
        + " report=" + report_path);

    if wave_pass {
        all_hard_pass = true;
        history.push(#{
            round: round,
            pass: true,
            hard_failed: fail_ids,
            notes: measure_notes,
        });
        log("All hard gates green — stopping loop");
        break;
    }

    if fail_fp == last_failed_fp {
        stall_streak += 1;
        log("Stall streak: same hard_failed fingerprint (" + stall_streak.to_string() + ")");
    } else {
        stall_streak = 0;
        last_failed_fp = fail_fp;
    }
    if stall_streak >= 2 {
        log("Two consecutive waves with identical hard fails — pausing for human (no_progress)");
        await_user("no_progress", "ultracode-wave stalled: hard gates unchanged for 2 waves. Inspect diffs/playtest, then /workflow resume to continue or stop.");
        stall_streak = 0;
    }

    if dry_run && round > 1 {
        log("dry_run: measured only after first synthesize — stopping");
        break;
    }

    // ---- AUDIT -------------------------------------------------------------
    phase("Audit");
    log("Audit fan-out: " + audit_domains.len().to_string() + " domains (read-only)");

    let audit_jobs = [];
    for domain in audit_domains {
        let ap = "";
        ap += "You are a HARSH read-only auditor for Operation Blackout.\n";
        ap += "Repo root = cwd. Domain = " + domain + ".\n";
        ap += "Wave = " + round_s + ".\n\n";
        ap += "CONTEXT — hard gates currently failing (from measure; untrusted until you re-check code):\n";
        ap += fail_blob + "\n\n";
        ap += "Measure notes: " + measure_notes + "\n";
        ap += "Report path: " + report_path + "\n\n";
        ap += "MANDATORY:\n";
        ap += "1) Read prompt.md verification doctrine (modes 1-7, categories A-J) and docs/PLAYTEST.md.\n";
        ap += "2) Use grep/read_file on REAL source. Cite file:line for every finding.\n";
        ap += "3) Prefer non-visual structural bugs that screenshots cannot show.\n";
        ap += "4) mode field must be one of: still-frame | motion-clip | played-session | sustained-profile | event-trace | loop-analysis | blind-ab.\n";
        ap += "5) severity: blocker | major | minor.\n";
        ap += "6) Empty findings is valid ONLY after you inspected the code for this domain and found nothing actionable.\n";
        ap += "7) Do NOT edit files. Do NOT run long GPU sessions unless needed to read an existing report.\n\n";
        ap += "DOMAIN FOCUS for " + domain + ":\n";
        if domain == "combat-hitboxes-ttk" {
            ap += "Living-enemy hitbox zones (physics raycast still returns single chest), entityId on character proxies,";
            ap += " ttk-lethal failures (smg/pistol at range), Combat.ts zoneAtPoint vs CharacterController single capsule,";
            ap += " damage model wiring through Ballistics.damageResolver.\n";
        }
        if domain == "perf-frame-shadows" {
            ap += "frame-p99 / frame-spikes. Shadow atlas cost (70% draw calls historically). Shadows.ts cascade audit API.";
            ap += " Quality presets, capture=1 exposure flush lie, tools/perf-session.mjs / gpc-perf*.mjs evidence.\n";
        }
        if domain == "gunfeel-feedback-juice" {
            ap += "Hitmarkers, hitstop, camera kick, kill confirm, muzzle/brass placement, damage indicators,";
            ap += " input-to-response <=50ms claims, tools/g2-gunfeel.mjs and gpc-feel.mjs.\n";
        }
        if domain == "movement-skill-expression" {
            ap += "Apex movement exists but holding W still wins down a corridor. Skill gap: optimal vs naive path times.";
            ap += " Slide-jump chaining payoff, air-strafe value, mantle usefulness, wall-bounce.\n";
        }
        if domain == "ai-lethality-pacing" {
            ap += "AI stack vs BotFallback, time-to-first-contact, engagement frequency, suppression self-hits,";
            ap += " tools/g4-aiprobe.mjs / gpc-combat.mjs evidence.\n";
        }
        if domain == "animation-death-av-sync" {
            ap += "Death clip compile, footsliding, AV sync on impacts/reload, last-stand loop, tools/gpc-death.mjs.\n";
        }

        audit_jobs.push(#{
            prompt: ap,
            label: "audit:" + domain + ":w" + round_s,
            capability_mode: "read-only",
            output_schema: findings_schema,
        });
    }

    let audit_results = parallel(audit_jobs);
    let all_findings = [];
    let audits_ok = 0;
    let di = 0;
    for r in audit_results {
        if r != () && r.success && r.output != () && r.output.findings != () {
            audits_ok += 1;
            for f in r.output.findings {
                let row = f;
                // stamp domain for synthesizer
                if r.output.domain != () {
                    // cannot add fields freely if schema-locked on child; pack into issue prefix via string in synth input
                }
                all_findings.push(#{
                    domain: if r.output.domain != () { r.output.domain } else { audit_domains[di] },
                    file: if f.file != () { f.file } else { "" },
                    line: if f.line != () { f.line } else { 0 },
                    severity: if f.severity != () { f.severity } else { "major" },
                    issue: if f.issue != () { f.issue } else { "" },
                    mode: if f.mode != () { f.mode } else { "played-session" },
                    fix_hint: if f.fix_hint != () { f.fix_hint } else { "" },
                });
            }
        }
        di += 1;
    }
    log("Audit: " + audits_ok.to_string() + "/" + audit_domains.len().to_string()
        + " domains returned; " + all_findings.len().to_string() + " raw findings");

    if all_findings.len() == 0 {
        log("Zero findings from audits — cannot synthesize packages; pausing");
        await_user("verification", "ultracode-wave wave " + round_s + ": audits returned no findings while hard gates still fail. Resume after inspecting measure output, or stop.");
        history.push(#{
            round: round,
            pass: false,
            hard_failed: fail_ids,
            findings: 0,
            packages: 0,
            notes: "audit empty",
        });
        continue;
    }

    // ---- SYNTHESIZE --------------------------------------------------------
    phase("Synthesize");
    let findings_json = json_encode(all_findings);
    // Cap size for prompt — keep first 40 findings if huge
    let synth_prompt = "";
    synth_prompt += "You are the WAVE COORDINATOR synthesizer for Operation Blackout.\n";
    synth_prompt += "Merge audit findings into fix packages with STRICTLY DISJOINT file ownership.\n";
    synth_prompt += "Two packages must NEVER share a file path. Verified by construction.\n\n";
    synth_prompt += "Hard gates still failing:\n" + fail_blob + "\n\n";
    synth_prompt += "Audit findings (JSON, untrusted claims — re-rank by how far a blind A/B or playtest moves):\n";
    synth_prompt += findings_json + "\n\n";
    synth_prompt += "RULES:\n";
    synth_prompt += "1) Max " + max_packages.to_string() + " packages this wave. Prefer finishable packages over mega-packages.\n";
    synth_prompt += "2) Rank by player-felt impact: hitbox-zones, ttk-lethal, frame spikes, then juice/movement skill gap.\n";
    synth_prompt += "3) Each package: id (p1..), title, owned_files (exclusive paths under src/ or tools/), findings (verbatim issue strings), acceptance (numeric gates), verify_cmd (runnable).\n";
    synth_prompt += "4) owned_files must be real repo paths that auditors cited or that are the only place to fix the issue.\n";
    synth_prompt += "5) deferred: findings intentionally not in this wave.\n";
    synth_prompt += "6) Do not assign Shadows.ts and Glsl.ts to different packages if both must change for one shadow bug — one package owns both.\n";
    synth_prompt += "7) Size the wave to FINISH. Partial mid-edit trees are failures.\n";
    synth_prompt += "8) Write a short copy of the package plan to shots/playtest/WAVE-" + round_s + "-PACKAGES.md using a shell redirect or write tool.\n";

    let synth = agent(synth_prompt, #{
        label: "synthesize-w" + round_s,
        capability_mode: "read-write",
        output_schema: packages_schema,
    });

    let packages = [];
    if synth != () && synth.success && synth.output != () && synth.output.packages != () {
        // Enforce max_packages and basic disjointness in script
        let claimed = [];
        let dropped_overlap = 0;
        for p in synth.output.packages {
            if packages.len() >= max_packages {
                break;
            }
            if p.owned_files == () || p.id == () {
                continue;
            }
            let overlap = false;
            for f in p.owned_files {
                for c in claimed {
                    if f == c { overlap = true; }
                }
            }
            if overlap {
                dropped_overlap += 1;
            } else {
                for f in p.owned_files { claimed.push(f); }
                packages.push(p);
            }
        }
        if dropped_overlap > 0 {
            log("Dropped " + dropped_overlap.to_string() + " package(s) for file-ownership overlap");
        }
    }

    log("Synthesize: " + packages.len().to_string() + " packages admitted");
    if packages.len() == 0 {
        log("No packages — pausing");
        await_user("verification", "ultracode-wave wave " + round_s + ": synthesizer produced no usable disjoint packages. Resume to retry or stop.");
        history.push(#{
            round: round,
            pass: false,
            hard_failed: fail_ids,
            findings: all_findings.len(),
            packages: 0,
            notes: "no packages",
        });
        continue;
    }

    if dry_run {
        log("dry_run: stopping after synthesize");
        history.push(#{
            round: round,
            pass: false,
            hard_failed: fail_ids,
            findings: all_findings.len(),
            packages: packages.len(),
            notes: "dry_run",
        });
        break;
    }

    // ---- FIX (parallel, disjoint ownership — no worktree isolation) --------
    phase("Fix");
    let fix_jobs = [];
    for p in packages {
        let owned = if p.owned_files != () { json_encode(p.owned_files) } else { "[]" };
        let findings_s = if p.findings != () { json_encode(p.findings) } else { "[]" };
        let title = if p.title != () { p.title } else { p.id };
        let acceptance = if p.acceptance != () { p.acceptance } else { "typecheck clean; relevant playtest gate moves" };
        let verify_cmd = if p.verify_cmd != () { p.verify_cmd } else { "npx tsc --noEmit" };

        let fp = "";
        fp += "You are a FIX agent for Operation Blackout wave " + round_s + " package " + p.id + ".\n";
        fp += "Title: " + title + "\n\n";
        fp += "YOU OWN THESE FILES EXCLUSIVELY (edit ONLY these paths; do not touch others):\n";
        fp += owned + "\n\n";
        fp += "Findings to fix (verbatim):\n" + findings_s + "\n\n";
        fp += "Acceptance criteria (numeric where possible):\n" + acceptance + "\n\n";
        fp += "Verify command to run yourself before finishing:\n" + verify_cmd + "\n\n";
        fp += "ALSO run: npx tsc --noEmit  (must be clean for your touched files / project).\n\n";
        fp += "RULES:\n";
        fp += "1) Read every owned file before editing. Use the mode that would expose the failure (play/session/profile — not stills alone).\n";
        fp += "2) Prefer minimal surgical fixes. No drive-by refactors outside owned_files.\n";
        fp += "3) Do not git commit. Land agent commits.\n";
        fp += "4) If blocked (need a file you do not own), set changed=false and blocked=reason.\n";
        fp += "5) self_check must quote command output / numbers, not vibes.\n";
        fp += "6) Design target: Apex movement, CoD gunfeel/healing, higher TTK; no Apex medkits.\n";

        fix_jobs.push(#{
            prompt: fp,
            label: "fix:" + p.id + ":w" + round_s,
            capability_mode: "execute",
            output_schema: fix_schema,
        });
    }

    let fix_results = parallel(fix_jobs);
    let fixes_changed = 0;
    let fix_summaries = [];
    let fi = 0;
    for fr in fix_results {
        let pid = if fi < packages.len() { packages[fi].id } else { "p?" };
        if fr != () && fr.success && fr.output != () {
            if fr.output.changed == true {
                fixes_changed += 1;
            }
            fix_summaries.push(#{
                id: if fr.output.id != () { fr.output.id } else { pid },
                changed: fr.output.changed == true,
                summary: if fr.output.summary != () { fr.output.summary } else { "" },
                self_check: if fr.output.self_check != () { fr.output.self_check } else { "" },
                blocked: if fr.output.blocked != () { fr.output.blocked } else { "" },
            });
        } else {
            fix_summaries.push(#{
                id: pid,
                changed: false,
                summary: "fix agent failed",
                self_check: "",
                blocked: "agent failure",
            });
        }
        fi += 1;
    }
    log("Fix: " + fixes_changed.to_string() + " package(s) reported changes");

    // ---- LAND --------------------------------------------------------------
    phase("Land");
    let land_prompt = "";
    land_prompt += "You are the LAND agent for Operation Blackout wave " + round_s + ".\n";
    land_prompt += "Fix package results (JSON):\n" + json_encode(fix_summaries) + "\n\n";
    land_prompt += "Steps (use shell):\n";
    land_prompt += "1) git status && git diff --stat\n";
    land_prompt += "2) npx tsc --noEmit — MUST be clean. If not, fix ONLY trivial type errors you can attribute to this wave, or report failure.\n";
    land_prompt += "3) Re-run playtest:\n";
    land_prompt += "   node tools/playtest.mjs --json shots/playtest/report-wave" + round_s + "-post.json\n";
    land_prompt += "   (use --no-build only if you just built; prefer rebuild if src changed)\n";
    land_prompt += "4) Compare hard gates to pre-wave fails: " + fail_blob + "\n";
    land_prompt += "5) ";
    if no_commit {
        land_prompt += "NO_COMMIT set: do not git commit. Leave working tree dirty if needed.\n";
    } else {
        land_prompt += "If typecheck clean AND at least one hard gate improved or a clear structural fix landed,\n";
        land_prompt += "create ONE git commit with message starting: 'Wave " + round_s + " ultracode:' and listing gate deltas.\n";
        land_prompt += "Do NOT push. Do NOT commit if nothing meaningful changed.\n";
    }
    land_prompt += "6) Return measure schema: pass, hard_failed, report_path, notes summarizing gate deltas.\n";

    let land = agent(land_prompt, #{
        label: "land-w" + round_s,
        capability_mode: "execute",
        output_schema: measure_schema,
    });

    let post_failed = hard_failed;
    let post_pass = false;
    let post_notes = "";
    let post_report = report_path;
    if land != () && land.success && land.output != () {
        post_pass = land.output.pass == true;
        if land.output.hard_failed != () { post_failed = land.output.hard_failed; }
        if land.output.notes != () { post_notes = land.output.notes; }
        if land.output.report_path != () { post_report = land.output.report_path; }
    }

    // ---- CRITIQUE ----------------------------------------------------------
    phase("Critique");
    let post_blob = json_encode(post_failed);
    let critique_jobs = [];

    let c1 = "";
    c1 += "You are an independent PLAYTEST CRITIC. Do not trust fix agents.\n";
    c1 += "Wave " + round_s + ". Read " + post_report + " and/or re-run:\n";
    c1 += "  node tools/playtest.mjs --no-build --json shots/playtest/report-wave" + round_s + "-critic.json\n";
    c1 += "Pre-wave fails: " + fail_blob + "\nPost-land claims: " + post_blob + "\n";
    c1 += "Verdict: PASS | PARTIAL | FAIL. still_failing / now_at_bar from HARD gates only.\n";
    c1 += "evidence must quote measured numbers. next_wave_priority = single top priority.\n";
    critique_jobs.push(#{
        prompt: c1,
        label: "critic-playtest-w" + round_s,
        capability_mode: "execute",
        output_schema: critique_schema,
    });

    let c2 = "";
    c2 += "You are an independent HARSH PRODUCT CRITIC for a CoD-feel FPS with Apex movement.\n";
    c2 += "Wave " + round_s + ". Read git diff against previous commit and playtest reports under shots/playtest/.\n";
    c2 += "Focus on: does it PLAY better? Hitboxes? Lethality? Stutter? Does movement skill pay off?\n";
    c2 += "Do not praise lighting stills. verdict PASS|PARTIAL|FAIL. Quote evidence.\n";
    critique_jobs.push(#{
        prompt: c2,
        label: "critic-product-w" + round_s,
        capability_mode: "execute",
        output_schema: critique_schema,
    });

    let critiques = parallel(critique_jobs);
    let critique_notes = [];
    for cr in critiques {
        if cr != () && cr.success && cr.output != () {
            critique_notes.push(#{
                verdict: if cr.output.verdict != () { cr.output.verdict } else { "FAIL" },
                still_failing: if cr.output.still_failing != () { cr.output.still_failing } else { [] },
                now_at_bar: if cr.output.now_at_bar != () { cr.output.now_at_bar } else { [] },
                evidence: if cr.output.evidence != () { cr.output.evidence } else { "" },
                next_wave_priority: if cr.output.next_wave_priority != () { cr.output.next_wave_priority } else { "" },
            });
        }
    }

    history.push(#{
        round: round,
        pass: post_pass,
        hard_failed: fail_ids,
        post_failed: post_failed,
        findings: all_findings.len(),
        packages: packages.len(),
        fixes_changed: fixes_changed,
        notes: post_notes,
        critiques: critique_notes,
    });

    if post_pass {
        all_hard_pass = true;
        log("Post-land measure reports all hard gates pass");
        break;
    }

    // Update fail fingerprint from post state for stall detection next iter
    let post_fp = fingerprint(json_encode(post_failed));
    if post_fp == fail_fp {
        // no improvement in fail set
        log("Wave " + round_s + " did not clear any hard-fail identity");
    }

    phase("Loop");
    log("Wave " + round_s + " complete — remaining hard fails: " + json_encode(post_failed));
    // feed post fails into next measure by continuing loop (measure will re-run)
}

// ---- FINAL REPORT ----------------------------------------------------------
phase("Loop");
let report = "";
report += "# ultracode-wave final report\n\n";
report += "Checkpoint handoff: GROK IS TAKING OVER FROM CLAUDE CODE (30e0515).\n";
report += "all_hard_pass: " + if all_hard_pass { "true" } else { "false" } + "\n";
report += "rounds_run: " + round.to_string() + " / " + max_rounds.to_string() + "\n\n";
report += "## History\n\n";
report += "```json\n" + json_encode(history) + "\n```\n";
report += "\n## Doctrine\n";
report += "Main thread orchestrates only. Children measure with playtest (not stills),\n";
report += "audit in parallel, fix under disjoint ownership, critics re-measure.\n";

let report_path_out = write_scratch_file("ultracode-wave-report.md", report);

let summary = "ultracode-wave finished rounds=" + round.to_string()
    + " hard_pass=" + if all_hard_pass { "true" } else { "false" }
    + " — see scratch report";

complete(#{
    summary: summary,
    all_hard_pass: all_hard_pass,
    rounds: round,
    max_rounds: max_rounds,
    history: history,
    report_path: report_path_out,
});
