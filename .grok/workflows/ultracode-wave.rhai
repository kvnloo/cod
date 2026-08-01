// ultracode-wave — Grok-side Claude ultracode for Operation Blackout
//
// SOURCE OF TRUTH: prompt.md (and docs/PLAYTEST.md, docs/VISUAL-BAR.md).
// Agents must read_file those files. Do NOT restate gates/modes/categories here.
//
// Effort: children = LOW (token-min). Session/orchestrator = high.
// Launch: /workflow ultracode-wave {...}  agent_budget 512
// Watch:  /workflows

let meta = #{
    name: "ultracode-wave",
    description: "Ultracode wave loop for cod: read prompt.md, fan out categories A-J, measure with playtest, fix, critique",
    when_to_use: "Continue prompt.md quality loop; main thread only orchestrates",
    phases: [
        #{ title: "Measure", detail: "playtest (+ perf); report hard gates from docs/PLAYTEST.md" },
        #{ title: "Audit", detail: "one low-effort agent per prompt.md category A-J" },
        #{ title: "Synthesize", detail: "disjoint packages from findings; size to finish" },
        #{ title: "Fix", detail: "one agent per package; verify with the mode prompt.md requires" },
        #{ title: "Land", detail: "typecheck + re-measure; optional commit" },
        #{ title: "Critique", detail: "independent re-measure per doctrine; no self-grade" },
        #{ title: "Loop", detail: "repeat until hard gates pass or max_rounds" },
    ],
};

// --- schemas (shape only; content rules live in prompt.md) ---

let measure_schema = #{
    "type": "object",
    "required": ["pass", "hard_failed", "report_path", "modes_used", "notes"],
    "properties": #{
        "pass": #{ "type": "boolean" },
        "hard_failed": #{
            "type": "array", "maxItems": 20,
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
        "advisory_failed": #{ "type": "array", "maxItems": 12, "items": #{ "type": "string" } },
        "report_path": #{ "type": "string" },
        "modes_used": #{
            "type": "array", "maxItems": 7, "items": #{ "type": "number" },
            "description": "prompt.md verification mode numbers 1-7 actually used this measure",
        },
        "notes": #{ "type": "string" },
    },
};

let findings_schema = #{
    "type": "object",
    "required": ["category", "findings", "modes_used"],
    "properties": #{
        "category": #{ "type": "string" },
        "modes_used": #{ "type": "array", "maxItems": 7, "items": #{ "type": "number" } },
        "findings": #{
            "type": "array", "maxItems": 10,
            "items": #{
                "type": "object",
                "required": ["file", "line", "severity", "issue", "mode"],
                "properties": #{
                    "file": #{ "type": "string" },
                    "line": #{ "type": "number" },
                    "severity": #{ "type": "string" },
                    "issue": #{ "type": "string" },
                    "mode": #{ "type": "number" },
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
            "type": "array", "maxItems": 6,
            "items": #{
                "type": "object",
                "required": ["id", "title", "owned_files", "findings", "acceptance", "categories"],
                "properties": #{
                    "id": #{ "type": "string" },
                    "title": #{ "type": "string" },
                    "owned_files": #{ "type": "array", "maxItems": 24, "items": #{ "type": "string" } },
                    "findings": #{ "type": "array", "maxItems": 12, "items": #{ "type": "string" } },
                    "acceptance": #{ "type": "string" },
                    "verify_cmd": #{ "type": "string" },
                    "categories": #{ "type": "array", "maxItems": 10, "items": #{ "type": "string" } },
                },
            },
        },
        "deferred": #{ "type": "array", "maxItems": 20, "items": #{ "type": "string" } },
        "rationale": #{ "type": "string" },
    },
};

let fix_schema = #{
    "type": "object",
    "required": ["id", "changed", "files_touched", "summary", "self_check", "modes_used"],
    "properties": #{
        "id": #{ "type": "string" },
        "changed": #{ "type": "boolean" },
        "files_touched": #{ "type": "array", "maxItems": 24, "items": #{ "type": "string" } },
        "summary": #{ "type": "string" },
        "self_check": #{ "type": "string" },
        "modes_used": #{ "type": "array", "maxItems": 7, "items": #{ "type": "number" } },
        "blocked": #{ "type": "string" },
    },
};

let critique_schema = #{
    "type": "object",
    "required": ["category", "verdict", "still_failing", "now_at_bar", "evidence", "modes_used"],
    "properties": #{
        "category": #{ "type": "string" },
        "verdict": #{ "type": "string" },
        "still_failing": #{ "type": "array", "maxItems": 12, "items": #{ "type": "string" } },
        "now_at_bar": #{ "type": "array", "maxItems": 12, "items": #{ "type": "string" } },
        "evidence": #{ "type": "string" },
        "modes_used": #{ "type": "array", "maxItems": 7, "items": #{ "type": "number" } },
        "next_wave_priority": #{ "type": "string" },
    },
};

// --- args ---
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

// prompt.md check categories — fan out one agent each. Text is in the file.
let categories = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];

// Low-effort worker preamble (session stays high; children save tokens)
let low = "";
low += "REASONING EFFORT: low. TOKEN-MIN. Tools > talk. Return schema only; no essays.\n";
low += "You are a worker, not the orchestrator. Do not invent multi-wave plans.\n";

// Doctrine pointer — always read the file; never rely on this summary alone
let doctrine = "";
doctrine += "LAW: read_file prompt.md (verification doctrine: modes 1-7 + categories A-J + how to run a wave).\n";
doctrine += "Also read_file docs/PLAYTEST.md for hard/advisory playtest gates and instruments.\n";
doctrine += "Also read_file docs/VISUAL-BAR.md only when using mode 1 (still frame).\n";
doctrine += "RULE from prompt.md: no quality claim without the method that would expose its failure.\n";
doctrine += "Git history: Claude already shipped ~2 days (foundation→7B→gameplay 1d521e1). Do not redo polish waves.\n";
doctrine += "git status / git diff first — finish uncommitted WIP rather than thrashing it.\n";

let history = [];
let round = 0;
let all_hard_pass = false;
let last_failed_fp = "";
let stall_streak = 0;

log("ultracode-wave: children=LOW effort; doctrine=prompt.md categories A-J; max_rounds="
    + max_rounds.to_string() + " max_packages=" + max_packages.to_string());

while round < max_rounds {
    round += 1;
    let round_s = round.to_string();
    log("======== WAVE " + round_s + " / " + max_rounds.to_string() + " ========");

    // ---- MEASURE -----------------------------------------------------------
    phase("Measure");
    let mp = "";
    mp += low;
    mp += doctrine;
    mp += "TASK: MEASURE wave " + round_s + ".\n";
    mp += "1) git status && git diff --stat\n";
    mp += "2) Read prompt.md how-to-run-a-wave + docs/PLAYTEST.md gates.\n";
    if skip_measure {
        mp += "3) SKIP_MEASURE: parse newest shots/playtest/*.json and shots/gpc-combat/playtest-default.json only.\n";
    } else {
        mp += "3) Run mode 3 instrument: node tools/playtest.mjs --json shots/playtest/report-wave" + round_s + ".json\n";
        mp += "   Prefer full build if src dirty. GPU must be real NVIDIA (not llvmpipe) per prompt.md category J.\n";
        mp += "4) If time: mode 4 tools/perf-session.mjs --no-build --presets high (or read existing shots/gpc-combat/perf*.json).\n";
    }
    mp += "5) List every HARD gate fail with measured vs target from docs/PLAYTEST.md.\n";
    mp += "6) modes_used = which prompt.md mode numbers (1-7) you actually used.\n";

    let measure = agent(mp, #{
        label: "measure-w" + round_s,
        capability_mode: "execute",
        output_schema: measure_schema,
    });

    let hard_failed = [];
    let report_path = "shots/playtest/report.json";
    let measure_notes = "";
    let wave_pass = false;
    let modes_used = [];

    if measure != () && measure.success && measure.output != () {
        wave_pass = measure.output.pass == true;
        if measure.output.hard_failed != () { hard_failed = measure.output.hard_failed; }
        if measure.output.report_path != () { report_path = measure.output.report_path; }
        if measure.output.notes != () { measure_notes = measure.output.notes; }
        if measure.output.modes_used != () { modes_used = measure.output.modes_used; }
    } else {
        log("Measure failed — continuing with empty fail list forces full A-J audit");
        measure_notes = "measure agent failed";
    }

    let fail_ids = [];
    for g in hard_failed {
        if g.id != () { fail_ids.push(g.id); }
    }
    let fail_blob = json_encode(hard_failed);
    let fail_fp = fingerprint(fail_blob);
    log("Measure pass=" + if wave_pass { "true" } else { "false" }
        + " hard_failed=" + fail_ids.len().to_string()
        + " modes=" + json_encode(modes_used)
        + " report=" + report_path);

    if wave_pass {
        all_hard_pass = true;
        history.push(#{ round: round, pass: true, hard_failed: fail_ids, notes: measure_notes });
        break;
    }

    if fail_fp == last_failed_fp {
        stall_streak += 1;
    } else {
        stall_streak = 0;
        last_failed_fp = fail_fp;
    }
    if stall_streak >= 2 {
        await_user("no_progress", "ultracode-wave: hard fails unchanged 2 waves. Resume or stop.");
        stall_streak = 0;
    }
    if dry_run && round > 1 { break; }

    // ---- AUDIT: one agent per prompt.md category A-J -----------------------
    phase("Audit");
    log("Audit fan-out: categories A-J from prompt.md (10 low-effort agents)");

    let audit_jobs = [];
    for cat in categories {
        let ap = "";
        ap += low;
        ap += doctrine;
        ap += "TASK: AUDIT only category " + cat + " from prompt.md Check categories section.\n";
        ap += "Wave " + round_s + ". category field in output MUST be \"" + cat + "\".\n";
        ap += "Hard fails from measure (context only): " + fail_blob + "\n";
        ap += "Measure notes: " + measure_notes + "\n";
        ap += "Report: " + report_path + "\n";
        ap += "STEPS:\n";
        ap += "1) read_file prompt.md — your category's bullets and its required verification mode.\n";
        ap += "2) Use the instrument that would expose failure (mode 1-7 table in prompt.md). Prefer existing tools/reports over new long runs when sufficient.\n";
        ap += "3) grep/read_file real src + git diff. Cite file:line.\n";
        ap += "4) findings[].mode = mode number 1-7 you used for that finding.\n";
        ap += "5) modes_used = list of mode numbers you used. Empty findings OK only after real inspection of category " + cat + ".\n";
        ap += "6) Do not edit files. Do not audit other categories.\n";

        audit_jobs.push(#{
            prompt: ap,
            label: "audit-" + cat + "-w" + round_s,
            capability_mode: "read-only",
            output_schema: findings_schema,
        });
    }

    let audit_results = parallel(audit_jobs);
    let all_findings = [];
    let audits_ok = 0;
    let covered = [];
    let di = 0;
    for r in audit_results {
        let cat_fallback = categories[di];
        if r != () && r.success && r.output != () {
            audits_ok += 1;
            let cat = if r.output.category != () { r.output.category } else { cat_fallback };
            covered.push(cat);
            if r.output.findings != () {
                for f in r.output.findings {
                    all_findings.push(#{
                        category: cat,
                        file: if f.file != () { f.file } else { "" },
                        line: if f.line != () { f.line } else { 0 },
                        severity: if f.severity != () { f.severity } else { "major" },
                        issue: if f.issue != () { f.issue } else { "" },
                        mode: if f.mode != () { f.mode } else { 0 },
                        fix_hint: if f.fix_hint != () { f.fix_hint } else { "" },
                    });
                }
            }
        }
        di += 1;
    }
    log("Audit: " + audits_ok.to_string() + "/10 categories returned; "
        + all_findings.len().to_string() + " findings; covered=" + json_encode(covered));

    if audits_ok < 10 {
        log("WARN: not all A-J auditors returned — fail-open on missing slots, but synthesizer must not claim full coverage");
    }

    if all_findings.len() == 0 {
        await_user("verification", "Wave " + round_s + ": A-J audits returned zero findings while gates fail. Resume after inspect.");
        history.push(#{ round: round, pass: false, hard_failed: fail_ids, findings: 0, packages: 0 });
        continue;
    }

    // ---- SYNTHESIZE --------------------------------------------------------
    phase("Synthesize");
    let sp = "";
    sp += low;
    sp += doctrine;
    sp += "TASK: SYNTHESIZE wave " + round_s + " packages from A-J findings.\n";
    sp += "Hard fails: " + fail_blob + "\n";
    sp += "Findings JSON:\n" + json_encode(all_findings) + "\n";
    sp += "RULES from prompt.md how-to-run-a-wave:\n";
    sp += "- Rank by how far playtest / blind A/B moves, not stills alone.\n";
    sp += "- Max " + max_packages.to_string() + " packages; STRICTLY DISJOINT owned_files.\n";
    sp += "- Size to finish. Include categories[] each package serves.\n";
    sp += "- acceptance must name numeric gates from prompt.md / docs/PLAYTEST.md.\n";
    sp += "- Prefer finishing uncommitted WIP that already targets a finding.\n";
    sp += "- Write shots/playtest/WAVE-" + round_s + "-PACKAGES.md briefly.\n";

    let synth = agent(sp, #{
        label: "synth-w" + round_s,
        capability_mode: "read-write",
        output_schema: packages_schema,
    });

    let packages = [];
    if synth != () && synth.success && synth.output != () && synth.output.packages != () {
        let claimed = [];
        for p in synth.output.packages {
            if packages.len() >= max_packages { break; }
            if p.owned_files == () || p.id == () { continue; }
            let overlap = false;
            for f in p.owned_files {
                for c in claimed {
                    if f == c { overlap = true; }
                }
            }
            if !overlap {
                for f in p.owned_files { claimed.push(f); }
                packages.push(p);
            }
        }
    }
    log("Packages admitted: " + packages.len().to_string());

    if packages.len() == 0 {
        await_user("verification", "Wave " + round_s + ": no disjoint packages. Resume or stop.");
        history.push(#{ round: round, pass: false, hard_failed: fail_ids, findings: all_findings.len(), packages: 0 });
        continue;
    }
    if dry_run {
        history.push(#{ round: round, pass: false, hard_failed: fail_ids, findings: all_findings.len(), packages: packages.len(), notes: "dry_run" });
        break;
    }

    // ---- FIX ---------------------------------------------------------------
    phase("Fix");
    let fix_jobs = [];
    for p in packages {
        let owned = if p.owned_files != () { json_encode(p.owned_files) } else { "[]" };
        let findings_s = if p.findings != () { json_encode(p.findings) } else { "[]" };
        let cats = if p.categories != () { json_encode(p.categories) } else { "[]" };
        let title = if p.title != () { p.title } else { p.id };
        let acceptance = if p.acceptance != () { p.acceptance } else { "see prompt.md gates" };
        let verify_cmd = if p.verify_cmd != () { p.verify_cmd } else { "npx tsc --noEmit" };

        let fp = "";
        fp += low;
        fp += doctrine;
        fp += "TASK: FIX package " + p.id + " (" + title + ") wave " + round_s + ".\n";
        fp += "Categories: " + cats + "\n";
        fp += "OWNED FILES ONLY:\n" + owned + "\n";
        fp += "Findings:\n" + findings_s + "\n";
        fp += "Acceptance:\n" + acceptance + "\n";
        fp += "Verify: " + verify_cmd + " && npx tsc --noEmit\n";
        fp += "Use the verification mode(s) prompt.md requires for these categories — not stills alone.\n";
        fp += "Do not git commit. modes_used = mode numbers you actually ran.\n";

        fix_jobs.push(#{
            prompt: fp,
            label: "fix-" + p.id + "-w" + round_s,
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
            if fr.output.changed == true { fixes_changed += 1; }
            fix_summaries.push(#{
                id: if fr.output.id != () { fr.output.id } else { pid },
                changed: fr.output.changed == true,
                summary: if fr.output.summary != () { fr.output.summary } else { "" },
                self_check: if fr.output.self_check != () { fr.output.self_check } else { "" },
                modes_used: if fr.output.modes_used != () { fr.output.modes_used } else { [] },
                blocked: if fr.output.blocked != () { fr.output.blocked } else { "" },
            });
        } else {
            fix_summaries.push(#{ id: pid, changed: false, summary: "agent failed", self_check: "", modes_used: [], blocked: "fail" });
        }
        fi += 1;
    }
    log("Fixes changed: " + fixes_changed.to_string());

    // ---- LAND --------------------------------------------------------------
    phase("Land");
    let lp = "";
    lp += low;
    lp += doctrine;
    lp += "TASK: LAND wave " + round_s + ".\n";
    lp += "Fix results: " + json_encode(fix_summaries) + "\n";
    lp += "1) git status && git diff --stat\n";
    lp += "2) npx tsc --noEmit\n";
    lp += "3) node tools/playtest.mjs --json shots/playtest/report-wave" + round_s + "-post.json\n";
    lp += "4) Compare hard gates to: " + fail_blob + "\n";
    if no_commit {
        lp += "5) NO_COMMIT — do not git commit.\n";
    } else {
        lp += "5) If meaningful gate/structural progress: one commit 'Wave " + round_s + " ultracode: …'. No push.\n";
    }
    lp += "6) modes_used for this land measure. Return measure schema.\n";

    let land = agent(lp, #{
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

    // ---- CRITIQUE: re-check categories that had findings (cap 6) ------------
    phase("Critique");
    let post_blob = json_encode(post_failed);
    let crit_cats = [];
    for p in packages {
        if p.categories != () {
            for c in p.categories {
                let seen = false;
                for e in crit_cats {
                    if e == c { seen = true; }
                }
                if !seen && crit_cats.len() < 6 { crit_cats.push(c); }
            }
        }
    }
    // Always include E and H (combat + perf) if room
    for must in ["E", "H"] {
        let seen = false;
        for e in crit_cats {
            if e == must { seen = true; }
        }
        if !seen && crit_cats.len() < 6 { crit_cats.push(must); }
    }
    if crit_cats.len() == 0 {
        crit_cats = ["E", "H", "B"];
    }

    let critique_jobs = [];
    for cat in crit_cats {
        let cp = "";
        cp += low;
        cp += doctrine;
        cp += "TASK: independent CRITIC for category " + cat + " only. Do not trust fix agents.\n";
        cp += "Wave " + round_s + ". category=\"" + cat + "\".\n";
        cp += "Pre fails: " + fail_blob + "\nPost claims: " + post_blob + "\n";
        cp += "Report: " + post_report + "\n";
        cp += "1) read_file prompt.md category " + cat + " gates.\n";
        cp += "2) Re-measure with the mode that would expose failure (playtest/perf tools as needed).\n";
        cp += "3) verdict PASS|PARTIAL|FAIL. evidence = numbers. modes_used required.\n";
        cp += "4) now_at_bar only what you re-measured green. still_failing for the rest.\n";

        critique_jobs.push(#{
            prompt: cp,
            label: "critic-" + cat + "-w" + round_s,
            capability_mode: "execute",
            output_schema: critique_schema,
        });
    }

    let critiques = parallel(critique_jobs);
    let critique_notes = [];
    for cr in critiques {
        if cr != () && cr.success && cr.output != () {
            critique_notes.push(#{
                category: if cr.output.category != () { cr.output.category } else { "?" },
                verdict: if cr.output.verdict != () { cr.output.verdict } else { "FAIL" },
                still_failing: if cr.output.still_failing != () { cr.output.still_failing } else { [] },
                now_at_bar: if cr.output.now_at_bar != () { cr.output.now_at_bar } else { [] },
                evidence: if cr.output.evidence != () { cr.output.evidence } else { "" },
                modes_used: if cr.output.modes_used != () { cr.output.modes_used } else { [] },
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
        categories_audited: covered,
    });

    if post_pass {
        all_hard_pass = true;
        break;
    }
    phase("Loop");
    log("Wave " + round_s + " done; remaining: " + json_encode(post_failed));
}

phase("Loop");
let report = "";
report += "# ultracode-wave\n\n";
report += "Doctrine: prompt.md (modes 1-7, categories A-J). Children low-effort.\n";
report += "all_hard_pass: " + if all_hard_pass { "true" } else { "false" } + "\n";
report += "rounds: " + round.to_string() + "/" + max_rounds.to_string() + "\n\n";
report += "```json\n" + json_encode(history) + "\n```\n";

let report_path_out = write_scratch_file("ultracode-wave-report.md", report);
complete(#{
    summary: "ultracode-wave rounds=" + round.to_string()
        + " hard_pass=" + if all_hard_pass { "true" } else { "false" },
    all_hard_pass: all_hard_pass,
    rounds: round,
    history: history,
    report_path: report_path_out,
});
