// ultracode-wave — endless (until double-blind chooses US)
//
// SOURCE OF TRUTH: prompt.md. Agents read_file it. Do not restate gates here.
// STOP CONDITION: mode-7 double-blind critics prefer our build (not playtest green).
// Playtest hard pass is NECESSARY but NOT SUFFICIENT — never exit on it alone.
// Children: LOW effort. Session orchestrator: high.
//
// Launch example:
//   /workflow ultracode-wave {"max_rounds":48,"max_packages":4}
//   agent_budget: 1024

let meta = #{
    name: "ultracode-wave",
    description: "Endless ultracode until double-blind A/B picks our FPS; prompt.md A-J + shots every wave",
    when_to_use: "Overnight quality loop; stop only when blind critics choose us",
    phases: [
        #{ title: "Measure", detail: "playtest + capture shots + contact sheet" },
        #{ title: "Audit", detail: "prompt.md categories A-J (low effort)" },
        #{ title: "Synthesize", detail: "disjoint packages" },
        #{ title: "Fix", detail: "package fixers" },
        #{ title: "Land", detail: "typecheck + re-measure + re-capture" },
        #{ title: "Critique", detail: "category critics + double-blind mode-7 panel" },
        #{ title: "Loop", detail: "never stop on playtest alone; only on blind win" },
    ],
};

let measure_schema = #{
    "type": "object",
    "required": ["pass", "hard_failed", "report_path", "shot_dir", "sheet_path", "modes_used", "notes"],
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
        "shot_dir": #{ "type": "string" },
        "sheet_path": #{ "type": "string" },
        "modes_used": #{ "type": "array", "maxItems": 7, "items": #{ "type": "number" } },
        "notes": #{ "type": "string" },
        "black_frame": #{ "type": "boolean" },
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

// Mode 7 double-blind: labels hidden; must pick A or B with one-second gut + reasons.
// ours_wins=true only if critic believes the labeled-later OUR shot is the AAA CoD-class one.
let blind_schema = #{
    "type": "object",
    "required": ["critic_id", "preferred_label", "ours_wins", "confidence", "reasons", "modes_used"],
    "properties": #{
        "critic_id": #{ "type": "string" },
        "preferred_label": #{ "type": "string" },
        "ours_wins": #{ "type": "boolean" },
        "confidence": #{ "type": "string" },
        "reasons": #{ "type": "array", "maxItems": 8, "items": #{ "type": "string" } },
        "modes_used": #{ "type": "array", "maxItems": 7, "items": #{ "type": "number" } },
        "still_looks_like_prototype": #{ "type": "boolean" },
    },
};

// --- args ---
let max_rounds = 48;
let max_packages = 4;
let dry_run = false;
let skip_measure = false;
let no_commit = false;
// require this many blind critics to all set ours_wins=true
let blind_votes = 3;

if args != () {
    if args.max_rounds != () { max_rounds = args.max_rounds; }
    if args.max_packages != () { max_packages = args.max_packages; }
    if args.dry_run == true { dry_run = true; }
    if args.skip_measure == true { skip_measure = true; }
    if args.no_commit == true { no_commit = true; }
    if args.blind_votes != () { blind_votes = args.blind_votes; }
}
if max_rounds < 1 { max_rounds = 1; }
if max_rounds > 96 { max_rounds = 96; }
if max_packages < 1 { max_packages = 1; }
if max_packages > 6 { max_packages = 6; }
if blind_votes < 2 { blind_votes = 2; }
if blind_votes > 5 { blind_votes = 5; }

let categories = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];

let low = "";
low += "REASONING EFFORT: low. TOKEN-MIN. Tools > talk. Schema only; no essays.\n";
low += "Worker agent — not orchestrator.\n";

let doctrine = "";
doctrine += "LAW: read_file prompt.md (modes 1-7, categories A-J, how to run a wave).\n";
doctrine += "Also docs/PLAYTEST.md and docs/VISUAL-BAR.md when using stills.\n";
doctrine += "Playtest green is NOT done. Mode 7 double-blind must prefer US over a real CoD reference or we keep looping.\n";
doctrine += "If a capture is mostly black / empty / menu-only, that is a BLOCKER not a pass.\n";
doctrine += "git status/diff first. Claude already shipped foundation→gameplay; do not thrash WIP randomly.\n";

let history = [];
let round = 0;
let blind_win = false;
let last_failed_fp = "";
let stall_streak = 0;

log("ultracode-wave ENDLESS: stop only when " + blind_votes.to_string()
    + " double-blind critics prefer US. max_rounds=" + max_rounds.to_string()
    + " children=LOW. Playtest-alone NEVER ends the loop.");

while round < max_rounds {
    round += 1;
    let round_s = round.to_string();
    let label = "wave" + round_s;
    log("======== WAVE " + round_s + " / " + max_rounds.to_string() + " (blind_win="
        + if blind_win { "true" } else { "false" } + ") ========");

    // ---- MEASURE: playtest + REAL SCREENSHOTS --------------------------------
    phase("Measure");
    let mp = "";
    mp += low;
    mp += doctrine;
    mp += "TASK: MEASURE wave " + round_s + " with modes 1+3 (+4 if time).\n";
    mp += "1) git status && git diff --stat\n";
    mp += "2) read_file prompt.md + docs/PLAYTEST.md\n";
    if skip_measure {
        mp += "3) SKIP_MEASURE: parse latest reports only; still VERIFY shot_dir exists with non-black PNGs.\n";
    } else {
        mp += "3) PLAYTEST mode 3: node tools/playtest.mjs --json shots/playtest/report-" + label + ".json\n";
        mp += "   Full build if src dirty. GPU must be hardware NVIDIA.\n";
        mp += "4) CAPTURE mode 1 (MANDATORY every wave — do not skip):\n";
        mp += "   node tools/capture.mjs --label " + label + " --quality high --no-build\n";
        mp += "   (omit --no-build if you rebuilt for playtest into a different dist; ensure capture serves the same build)\n";
        mp += "   Prefer: build once to dist-wave, then playtest and capture both use that dist/port if harness allows.\n";
        mp += "5) CONTACT SHEET: node tools/contactsheet.mjs --label " + label + "\n";
        mp += "   Also copy/symlink sheet to shots/_sheets/preview.png and shots/preview/ for humans.\n";
        mp += "6) Open 2-3 PNGs or use file sizes; if frames are near-black (like a pure HUD void), set black_frame=true.\n";
    }
    mp += "7) List hard fails. pass=true only if playtest hard gates green — still NOT loop exit.\n";
    mp += "8) shot_dir e.g. shots/" + label + "  sheet_path e.g. shots/_sheets/preview.png\n";
    mp += "9) modes_used must include 1 and 3 when you captured+played.\n";

    let measure = agent(mp, #{
        label: "measure-w" + round_s,
        capability_mode: "execute",
        output_schema: measure_schema,
    });

    let hard_failed = [];
    let report_path = "shots/playtest/report-" + label + ".json";
    let shot_dir = "shots/" + label;
    let sheet_path = "shots/_sheets/preview.png";
    let measure_notes = "";
    let playtest_pass = false;
    let black_frame = false;
    let modes_used = [];

    if measure != () && measure.success && measure.output != () {
        playtest_pass = measure.output.pass == true;
        if measure.output.hard_failed != () { hard_failed = measure.output.hard_failed; }
        if measure.output.report_path != () { report_path = measure.output.report_path; }
        if measure.output.shot_dir != () { shot_dir = measure.output.shot_dir; }
        if measure.output.sheet_path != () { sheet_path = measure.output.sheet_path; }
        if measure.output.notes != () { measure_notes = measure.output.notes; }
        if measure.output.modes_used != () { modes_used = measure.output.modes_used; }
        if measure.output.black_frame == true { black_frame = true; }
    } else {
        measure_notes = "measure agent failed";
        hard_failed = [#{ id: "measure-failed", measured: "n/a", target: "ok" }];
    }

    let fail_ids = [];
    for g in hard_failed {
        if g.id != () { fail_ids.push(g.id); }
    }
    if black_frame {
        fail_ids.push("black-frame-capture");
        playtest_pass = false;
    }
    let fail_blob = json_encode(hard_failed);
    let fail_fp = fingerprint(fail_blob + if black_frame { "|black" } else { "" });
    log("Measure playtest_pass=" + if playtest_pass { "true" } else { "false" }
        + " black_frame=" + if black_frame { "true" } else { "false" }
        + " hard=" + fail_ids.len().to_string()
        + " shots=" + shot_dir + " sheet=" + sheet_path);

    // NEVER break on playtest_pass alone — only after blind panel below.

    if fail_fp == last_failed_fp {
        stall_streak += 1;
    } else {
        stall_streak = 0;
        last_failed_fp = fail_fp;
    }
    // Do not await_user on stall overnight — log and keep pushing different packages
    if stall_streak >= 3 {
        log("STALL: same fail fingerprint " + stall_streak.to_string()
            + " waves — synthesizer must pick NEW packages / deeper roots");
    }
    if dry_run && round > 1 { break; }

    // ---- AUDIT A-J -----------------------------------------------------------
    phase("Audit");
    let audit_jobs = [];
    for cat in categories {
        let ap = "";
        ap += low;
        ap += doctrine;
        ap += "AUDIT category " + cat + " only (prompt.md). Wave " + round_s + ".\n";
        ap += "Hard fails: " + fail_blob + "\n";
        ap += "Notes: " + measure_notes + "\n";
        ap += "Report: " + report_path + "  Shots: " + shot_dir + "  Sheet: " + sheet_path + "\n";
        ap += "black_frame=" + if black_frame { "true" } else { "false" } + "\n";
        ap += "1) read_file prompt.md category " + cat + "\n";
        ap += "2) Use the mode that exposes failure. LOOK at PNGs under " + shot_dir + " when mode 1 applies.\n";
        ap += "3) file:line findings. category=\"" + cat + "\". mode=1..7 number.\n";
        ap += "4) Do not edit. Empty findings only after real inspection.\n";
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
    log("Audit " + audits_ok.to_string() + "/10 cats, findings=" + all_findings.len().to_string());

    // Force a black-frame finding if capture failed
    if black_frame {
        all_findings.push(#{
            category: "J",
            file: shot_dir,
            line: 0,
            severity: "blocker",
            issue: "Capture produced black/empty frames — not a valid still for mode 1 or mode 7",
            mode: 1,
            fix_hint: "Fix camera/session/boot so capture.mjs writes lit gameplay frames",
        });
    }

    if all_findings.len() == 0 && !playtest_pass {
        // invent nothing — push synthetic package pressure via known fails
        all_findings.push(#{
            category: "E",
            file: "docs/PLAYTEST.md",
            line: 1,
            severity: "blocker",
            issue: "Hard gates still failing but auditors returned empty — re-investigate fails: " + fail_blob,
            mode: 3,
            fix_hint: "Re-run playtest and fix failing gates",
        });
    }

    // ---- SYNTHESIZE ----------------------------------------------------------
    phase("Synthesize");
    let sp = "";
    sp += low;
    sp += doctrine;
    sp += "SYNTHESIZE wave " + round_s + ". Max " + max_packages.to_string() + " DISJOINT packages.\n";
    sp += "playtest_pass=" + if playtest_pass { "true" } else { "false" } + " (NOT done).\n";
    sp += "Fails: " + fail_blob + "\nFindings:\n" + json_encode(all_findings) + "\n";
    sp += "Rank by mode-7 blind A/B impact + playtest. Size to finish. Write shots/playtest/WAVE-" + round_s + "-PACKAGES.md\n";
    if stall_streak >= 2 {
        sp += "STALL: prior waves did not move fails — pick DIFFERENT root causes / files.\n";
    }

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
    log("Packages: " + packages.len().to_string());
    if packages.len() == 0 {
        log("No packages — looping measure again next wave with forced visual/perf packages");
        history.push(#{ round: round, playtest_pass: playtest_pass, blind_win: false, findings: all_findings.len(), packages: 0 });
        continue;
    }
    if dry_run { break; }

    // ---- FIX -----------------------------------------------------------------
    phase("Fix");
    let fix_jobs = [];
    for p in packages {
        let owned = if p.owned_files != () { json_encode(p.owned_files) } else { "[]" };
        let findings_s = if p.findings != () { json_encode(p.findings) } else { "[]" };
        let cats = if p.categories != () { json_encode(p.categories) } else { "[]" };
        let title = if p.title != () { p.title } else { p.id };
        let acceptance = if p.acceptance != () { p.acceptance } else { "prompt.md gates" };
        let verify_cmd = if p.verify_cmd != () { p.verify_cmd } else { "npx tsc --noEmit" };
        let fp = "";
        fp += low;
        fp += doctrine;
        fp += "FIX " + p.id + " " + title + " wave " + round_s + " cats=" + cats + "\n";
        fp += "OWNED ONLY:\n" + owned + "\nFINDINGS:\n" + findings_s + "\nACCEPT:\n" + acceptance + "\n";
        fp += "Verify: " + verify_cmd + " ; npx tsc --noEmit\nNo commit. modes_used required.\n";
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
            });
        } else {
            fix_summaries.push(#{ id: pid, changed: false, summary: "fail", self_check: "", modes_used: [] });
        }
        fi += 1;
    }
    log("Fixes changed=" + fixes_changed.to_string());

    // ---- LAND + re-capture ---------------------------------------------------
    phase("Land");
    let post_label = label + "-post";
    let lp = "";
    lp += low;
    lp += doctrine;
    lp += "LAND wave " + round_s + ". Fixes: " + json_encode(fix_summaries) + "\n";
    lp += "1) git status && git diff --stat\n";
    lp += "2) npx tsc --noEmit\n";
    lp += "3) node tools/playtest.mjs --json shots/playtest/report-" + post_label + ".json\n";
    lp += "4) node tools/capture.mjs --label " + post_label + " --quality high --no-build\n";
    lp += "5) node tools/contactsheet.mjs --label " + post_label + "\n";
    lp += "   Update shots/_sheets/preview.png from the new sheet (cp).\n";
    lp += "6) black_frame if captures are void/black.\n";
    if no_commit {
        lp += "7) NO_COMMIT\n";
    } else {
        lp += "7) Commit if structural/gate/visual progress: 'Wave " + round_s + " ultracode: …' no push\n";
    }
    lp += "8) Return measure schema with shot_dir/sheet_path for POST captures.\n";

    let land = agent(lp, #{
        label: "land-w" + round_s,
        capability_mode: "execute",
        output_schema: measure_schema,
    });

    let post_failed = hard_failed;
    let post_pass = false;
    let post_notes = "";
    let post_report = report_path;
    let post_shot = "shots/" + post_label;
    let post_sheet = sheet_path;
    let post_black = black_frame;
    if land != () && land.success && land.output != () {
        post_pass = land.output.pass == true;
        if land.output.hard_failed != () { post_failed = land.output.hard_failed; }
        if land.output.notes != () { post_notes = land.output.notes; }
        if land.output.report_path != () { post_report = land.output.report_path; }
        if land.output.shot_dir != () { post_shot = land.output.shot_dir; }
        if land.output.sheet_path != () { post_sheet = land.output.sheet_path; }
        if land.output.black_frame == true { post_black = true; post_pass = false; }
    }

    // ---- CATEGORY CRITIQUE + MODE-7 DOUBLE BLIND -----------------------------
    phase("Critique");
    let post_blob = json_encode(post_failed);
    let crit_cats = ["E", "H", "B", "A", "D", "F"];
    let critique_jobs = [];
    for cat in crit_cats {
        let cp = "";
        cp += low;
        cp += doctrine;
        cp += "CRITIC category " + cat + " wave " + round_s + ". Independent re-measure.\n";
        cp += "Pre: " + fail_blob + " Post: " + post_blob + "\n";
        cp += "Report: " + post_report + " Shots: " + post_shot + "\n";
        cp += "read_file prompt.md category " + cat + ". Re-run tools as needed. No trust of fixers.\n";
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
                evidence: if cr.output.evidence != () { cr.output.evidence } else { "" },
                still_failing: if cr.output.still_failing != () { cr.output.still_failing } else { [] },
            });
        }
    }

    // Double-blind panel — ONLY path to loop exit when combined with playtest_pass
    let blind_jobs = [];
    let bi = 0;
    while bi < blind_votes {
        bi += 1;
        let bp = "";
        bp += low;
        bp += doctrine;
        bp += "DOUBLE-BLIND MODE 7 critic #" + bi.to_string() + " wave " + round_s + ".\n";
        bp += "1) read_file prompt.md mode 7 (Blind A/B against reference).\n";
        bp += "2) Look at OUR current shots in " + post_shot + " and sheet " + post_sheet + ".\n";
        bp += "3) Look at a STRONG reference set if present (shots/preview/ from earlier AAA-target captures,\n";
        bp += "   or public CoD MW-style reference mental model). Prefer file comparison when two dirs exist.\n";
        bp += "4) Mentally shuffle labels: you must NOT prefer ours because it is ours.\n";
        bp += "5) preferred_label = which image set looks more like a shipping CoD-class FPS in one second.\n";
        bp += "6) AFTER choosing, set ours_wins=true ONLY if the set you preferred is the OUR post-wave capture\n";
        bp += "   (" + post_shot + "). If reference/preview looks better, ours_wins=false.\n";
        bp += "7) If OUR frames are black, empty, washed, or clearly prototype, ours_wins=false and still_looks_like_prototype=true.\n";
        bp += "8) critic_id=blind-" + bi.to_string() + " confidence=low|med|high. reasons=concrete visual bullets.\n";
        bp += "9) modes_used must include 7 and usually 1.\n";
        bp += "DEFAULT TO ours_wins=false unless the one-second gut says OUR set wins cold.\n";
        blind_jobs.push(#{
            prompt: bp,
            label: "blind-" + bi.to_string() + "-w" + round_s,
            capability_mode: "read-only",
            output_schema: blind_schema,
        });
    }
    let blinds = parallel(blind_jobs);
    let ours_votes = 0;
    let blind_notes = [];
    for br in blinds {
        if br != () && br.success && br.output != () {
            let win = br.output.ours_wins == true;
            if win { ours_votes += 1; }
            blind_notes.push(#{
                critic_id: if br.output.critic_id != () { br.output.critic_id } else { "?" },
                ours_wins: win,
                preferred_label: if br.output.preferred_label != () { br.output.preferred_label } else { "" },
                confidence: if br.output.confidence != () { br.output.confidence } else { "" },
                reasons: if br.output.reasons != () { br.output.reasons } else { [] },
                still_looks_like_prototype: br.output.still_looks_like_prototype == true,
            });
        }
    }
    let blind_unanimous = ours_votes >= blind_votes;
    // Require playtest hard pass AND non-black AND unanimous blind win
    blind_win = blind_unanimous && post_pass && !post_black;

    log("Blind panel ours_votes=" + ours_votes.to_string() + "/" + blind_votes.to_string()
        + " post_pass=" + if post_pass { "true" } else { "false" }
        + " post_black=" + if post_black { "true" } else { "false" }
        + " STOP=" + if blind_win { "YES" } else { "NO keep looping" });

    history.push(#{
        round: round,
        playtest_pass: post_pass,
        black_frame: post_black,
        hard_failed: fail_ids,
        post_failed: post_failed,
        findings: all_findings.len(),
        packages: packages.len(),
        fixes_changed: fixes_changed,
        shot_dir: post_shot,
        sheet_path: post_sheet,
        critiques: critique_notes,
        blind: blind_notes,
        blind_win: blind_win,
        notes: post_notes,
    });

    if blind_win {
        log("DOUBLE-BLIND + PLAYTEST: critics chose US. Ending loop.");
        break;
    }

    phase("Loop");
    log("Wave " + round_s + " incomplete for ship bar — continue");
}

phase("Loop");
let report = "";
report += "# ultracode-wave\n\n";
report += "Stop rule: double-blind mode-7 ALL prefer US + playtest hard pass + non-black captures.\n";
report += "blind_win: " + if blind_win { "true" } else { "false" } + "\n";
report += "rounds: " + round.to_string() + "/" + max_rounds.to_string() + "\n\n";
report += "```json\n" + json_encode(history) + "\n```\n";
let report_path_out = write_scratch_file("ultracode-wave-report.md", report);

complete(#{
    summary: "ultracode-wave rounds=" + round.to_string()
        + " blind_win=" + if blind_win { "true" } else { "false" },
    blind_win: blind_win,
    rounds: round,
    history: history,
    report_path: report_path_out,
});
