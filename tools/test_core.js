#!/usr/bin/env node
/*
 * Checks the pure logic: department load, trip days, MONICA / Gen12 import and re-import.
 *   node tools/test_core.js [gen12.xlsx]
 * With an Excel path (default: the workbook next to the repos, if present) it also checks that the
 * browser Excel importer yields exactly the same tasks as the Gen12 seed.
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const E = require("../js/engine.js");
const M = require("../js/model.js");
const C = require("../js/convert.js");

const root = path.join(__dirname, "..");
const d = (iso) => E.toDay(iso);
let n = 0;
const ok = (name, fn) => {
  fn();
  n++;
  console.log("  ✓ " + name);
};

// ---------------------------------------------------------------- load
ok("load: one person with two tasks counts once; unassigned counts per PFAM", () => {
  const data = C.emptyData();
  data.employees = [{ id: "a", name: "A", active: true }, { id: "b", name: "B", active: true }, { id: "c", name: "C", active: false }];
  data.tasks = [
    { id: "1", pfamId: "f1", start: "2026-10-05", end: "2026-10-09", assignees: ["a"], done: false },
    { id: "2", pfamId: "f1", start: "2026-10-05", end: "2026-10-06", assignees: ["a"], done: false },
    { id: "3", pfamId: "f2", start: "2026-10-05", end: "2026-10-05", assignees: [], done: false },
    { id: "4", pfamId: "f2", start: "2026-10-05", end: "2026-10-05", assignees: [], done: false },
    { id: "5", pfamId: "f3", start: "2026-10-05", end: "2026-10-05", assignees: ["c"], done: false }, // left the team -> unassigned
  ];
  const days = M.load(data, d("2026-10-03"), d("2026-10-07"), { today: d("2026-10-01") });
  assert.deepStrictEqual(days.map((x) => E.fromDay(x.day)), ["2026-10-05", "2026-10-06", "2026-10-07"], "weekends skipped");
  const mon = days[0];
  assert.strictEqual(mon.head, 2);
  assert.strictEqual(mon.busy.size, 1);
  assert.strictEqual(mon.busy.get("a").length, 2);
  assert.strictEqual(mon.unassigned.size, 2, "f2 and f3");
  assert.strictEqual(mon.demand, 3);
  assert.ok(mon.alert, "1 busy + 2 unassigned >= 2 people");
  assert.deepStrictEqual(mon.idle.map((e) => e.id), ["b"]);
  assert.ok(!days[2].alert, "Wednesday: 1 of 2 busy");
});

ok("load: pct rule and project filter", () => {
  const data = C.emptyData();
  data.settings.alertMode = "pct";
  data.settings.alertPct = 50;
  data.employees = [{ id: "a", name: "A", active: true }, { id: "b", name: "B", active: true }];
  data.pfams = [{ id: "f1", projectId: "p1" }, { id: "f2", projectId: "p2" }];
  data.tasks = [
    { id: "1", pfamId: "f1", start: "2026-10-05", end: "2026-10-05", assignees: ["a"], done: false },
    { id: "2", pfamId: "f2", start: "2026-10-05", end: "2026-10-05", assignees: ["b"], done: false },
  ];
  const all = M.load(data, d("2026-10-05"), d("2026-10-05"), { today: 0 })[0];
  assert.strictEqual(all.busy.size, 2);
  const p1 = M.load(data, d("2026-10-05"), d("2026-10-05"), { today: 0, projectIds: new Set(["p1"]) })[0];
  assert.strictEqual(p1.busy.size, 1);
  assert.ok(p1.alert, "1/2 = 50% >= 50%");
});

ok("load: a finished task frees its people from today on, history stays", () => {
  const t = { start: "2026-10-01", end: "2026-10-20", done: true, assignees: ["a"] };
  const today = d("2026-10-10");
  assert.ok(M.occupies(t, d("2026-10-05"), today));
  assert.ok(!M.occupies(t, d("2026-10-12"), today));
  assert.strictEqual(M.status(t, today), "done");
  assert.strictEqual(M.status({ ...t, done: false }, d("2026-10-21")), "late");
});

// ---------------------------------------------------------------- trips
ok("trip days: calendar days, inclusive, split across New Year", () => {
  const tr = { start: "2026-12-29", end: "2027-01-03" };
  assert.strictEqual(M.tripDaysInYear(tr, 2026), 3);
  assert.strictEqual(M.tripDaysInYear(tr, 2027), 3);
  assert.strictEqual(M.tripDaysInYear({ start: "2026-03-07", end: "2026-03-07" }, 2026), 1);
  const data = { trips: [tr, { empId: "x", start: "2026-05-01", end: "2026-05-10", location: "MX" }].map((t) => ({ empId: "x", location: "LZ", ...t })) };
  const s = M.tripStats(data, 2026).get("x");
  assert.strictEqual(s.total, 13);
  assert.strictEqual(s.byLocation.get("MX"), 10);
  assert.strictEqual(s.byLocation.get("LZ"), 3);
});

// ---------------------------------------------------------------- MONICA import
ok("MONICA: import, then re-import keeps assignees / done and sets the baseline", () => {
  const json = {
    labels: { phaseList: [{ key: "BSL", label: "BSL", color: "#ff0" }] },
    tasks: [
      { project: "Gen10.6 MX", category: "Gen10", task: "", type: "BSL", start: "2026-05-07", end: "2026-05-22", pic: "Amy / Ben", site: "MX" },
      { project: "Gen10.6 MX", category: "Gen10", task: "", type: "Volume", start: "2026-05-25", end: "2026-05-27", pic: "", site: "MX" },
    ],
  };
  const data = C.emptyData();
  data.employees = [{ id: "e1", name: "amy", active: true }];
  const m = C.monicaItems(json);
  const c1 = C.apply(data, C.plan(data, "monica", m.items));
  assert.strictEqual(c1.added, 2);
  assert.deepStrictEqual(c1.unmatched, ["Ben"]);
  assert.strictEqual(data.projects.length, 1);
  assert.strictEqual(data.projects[0].name, "Gen10");
  assert.strictEqual(data.pfams[0].name, "Gen10.6 MX");
  assert.strictEqual(data.tasks[0].name, "BSL", "blank task name -> phase label");
  assert.deepStrictEqual(data.tasks[0].assignees, ["e1"]);
  data.tasks[1].assignees = ["e1"]; // assigned on the web
  data.tasks[1].done = true;

  json.tasks[1].end = "2026-05-29";
  const m2 = C.monicaItems(json);
  const pl = C.plan(data, "monica", m2.items);
  assert.deepStrictEqual(pl.rows.map((r) => r.status), ["same", "update"]);
  C.apply(data, pl);
  const t = data.tasks[1];
  assert.strictEqual(t.end, "2026-05-29");
  assert.strictEqual(t.baseEnd, "2026-05-27");
  assert.deepStrictEqual(t.assignees, ["e1"]);
  assert.strictEqual(t.done, true, "done flag kept");

  json.tasks.pop();
  const pl3 = C.plan(data, "monica", C.monicaItems(json).items);
  assert.strictEqual(pl3.gone.length, 1);
  assert.strictEqual(pl3.gone[0].on, false, "vanished tasks are kept unless ticked");
});

ok("old data with a progress % becomes done / not done", () => {
  const n = C.normalize({ tasks: [{ id: "a", pct: 100 }, { id: "b", pct: 60 }, { id: "c", done: true }] });
  assert.deepStrictEqual(n.tasks.map((t) => t.done), [true, false, true]);
  assert.ok(n.tasks.every((t) => !("pct" in t)));
});

ok("phases: Volume (old) and VB (new) are the same phase", () => {
  const n = C.normalize({ settings: { phases: [{ key: "Volume", label: "Volume" }, { key: "VB", label: "VB", color: "#b45309" }] }, tasks: [{ id: "a", phase: "Volume" }] });
  assert.deepStrictEqual(n.settings.phases.map((p) => p.key), ["VB"]);
  assert.strictEqual(n.tasks[0].phase, "VB");
  assert.strictEqual(C.resolvePhase(n, "Volume"), "VB");
});

ok("phases: old MONICA rack keys merge into the current ones, and stay aliases for imports", () => {
  const d0 = {
    settings: {
      phases: [
        { key: "1stscriptrack", label: "1st script rack", color: "#111" },
        { key: "BSL", label: "BSL", color: "#222" },
        { key: "DevelopmentTNRS", label: "1st rack (DEV)", color: "#333" },
        { key: "2ndvalidationrack", label: "2nd validation rack", color: "#444" },
      ],
    },
    tasks: [{ id: "a", phase: "1stscriptrack" }, { id: "b", phase: "DevelopmentTNRS" }, { id: "c", phase: "2ndvalidationrack" }],
  };
  const n = C.normalize(d0);
  assert.deepStrictEqual(n.settings.phases.map((p) => p.key), ["DevelopmentTNRS", "BSL", "PreGolden"], "merged phase keeps the earlier position");
  assert.deepStrictEqual(n.tasks.map((t) => t.phase), ["DevelopmentTNRS", "DevelopmentTNRS", "PreGolden"]);
  assert.strictEqual(n.settings.phases.find((p) => p.key === "PreGolden").label, "2nd rack (VLD)", "renamed when only the old one exists");
  assert.strictEqual(n.settings.phases.find((p) => p.key === "DevelopmentTNRS").color, "#333", "keeps the surviving phase's color");
  // An old MONICA file imported later lands on the merged phase, without re-adding the old phase.
  const items = C.monicaItems({ labels: { phaseList: [{ key: "1stscriptrack", label: "1st script rack" }] }, tasks: [{ project: "P", category: "S", type: "1stscriptrack", start: "2026-01-01", end: "2026-01-02" }] });
  assert.strictEqual(C.mergePhases(n, items.phases), 0);
  C.apply(n, C.plan(n, "monica", items.items));
  assert.strictEqual(n.tasks[n.tasks.length - 1].phase, "DevelopmentTNRS");
  // Manual merge from the settings page.
  C.mergePhase(n, "BSL", "PreGolden");
  assert.ok(!n.settings.phases.some((p) => p.key === "BSL"));
  assert.strictEqual(C.resolvePhase(n, "BSL"), "PreGolden");
});

ok("PIC names split on / \\ , 、 &", () => {
  assert.deepStrictEqual(C.splitNames("Brian\\Ryan"), ["Brian", "Ryan"]);
  assert.deepStrictEqual(C.splitNames("Ernie/Timothy、Nick & Haemon"), ["Ernie", "Timothy", "Nick", "Haemon"]);
});

ok("markDoneBefore: unfinished tasks that ended before the cutoff become done", () => {
  const data = { tasks: [{ end: "2026-09-30", done: false }, { end: "2026-10-01", done: false }, { end: "2026-08-01", done: true }, { end: "", done: false }] };
  assert.strictEqual(C.markDoneBefore(data, "2026-10-01"), 1);
  assert.deepStrictEqual(data.tasks.map((x) => x.done), [true, false, true, false]);
});

ok("import: unticked new tasks are remembered as ignored", () => {
  const data = C.emptyData();
  const items = C.monicaItems({ tasks: [{ project: "P", category: "S", type: "BSL", start: "2026-01-01", end: "2026-01-02" }] }).items;
  const pl = C.plan(data, "monica", items);
  pl.rows[0].on = false;
  C.apply(data, pl);
  assert.strictEqual(data.tasks.length, 0);
  assert.strictEqual(C.plan(data, "monica", items).rows[0].on, false);
});

// ---------------------------------------------------------------- Gen12
const gen12Seed = path.join(root, "../Gen12AMD_Pilot_gantt/data/seed.json");
if (fs.existsSync(gen12Seed)) {
  const ds = JSON.parse(fs.readFileSync(gen12Seed, "utf8"));
  const opts = { roles: "STE, MTE, TE", projKey: "gen12|X", projName: "X" };
  const g = C.gen12Items(ds, opts);

  ok("Gen12: 1st + 2nd builds merge into one PFAM; inherited 2nd sections not pre-selected", () => {
    const groups = C.gen12Groups(ds);
    const merged = groups.filter((x) => x.members.length > 1);
    assert.ok(merged.length > 0);
    for (const x of merged) assert.deepStrictEqual(x.members.map((m) => m.build), ["1st", "2nd"]);
    assert.ok(g.items.some((i) => i.inherited && !i.defaultOn));
    assert.ok(g.items.filter((i) => i.defaultOn).every((i) => C.leadMatches(i.lead, ["STE", "MTE", "TE"])));
    assert.strictEqual(new Set(g.items.map((i) => i.srcKey)).size, g.items.length, "source keys are unique");
  });

  ok("Gen12: imports into an existing project (Gen12 AMD); removing the old auto Pilot project never touches it", () => {
    const data = C.emptyData();
    data.projects.push({ id: "amd", name: "Gen12 AMD", color: "#000", status: "active", src: { kind: "monica", key: "monica|gen12 amd" } });
    const items = C.gen12Items(ds, { roles: data.settings.gen12Roles, projKey: "gen12|Gen12 AMD", projName: "Gen12 AMD" }).items;
    assert.strictEqual(data.settings.gen12Roles, "STE, TE");
    assert.ok(items.filter((i) => i.defaultOn).every((i) => C.leadMatches(i.lead, ["STE", "TE"])));
    assert.ok(!items.some((i) => i.defaultOn && C.leadMatches(i.lead, ["MTE"]) && !C.leadMatches(i.lead, ["STE", "TE"])), "MTE-only tasks are not pre-ticked");
    const r = C.apply(data, C.plan(data, "gen12", items), { projectId: "amd" });
    assert.strictEqual(r.projects, 0, "no new project");
    assert.ok(data.pfams.every((f) => f.projectId === "amd"));
    // An old auto-created Pilot project next to it.
    data.projects.push({ id: "pilot", name: "Gen12 AMD Pilot", src: { kind: "gen12", key: "gen12|Gen12 AMD Pilot" } });
    data.pfams.push({ id: "pf", projectId: "pilot", name: "x", src: { kind: "gen12", key: "gen12|x" } });
    data.tasks.push({ id: "pt", pfamId: "pf", name: "y", assignees: [], src: { kind: "gen12", key: "gen12|y" } });
    const n = data.tasks.length;
    const rm = C.removeGen12(data);
    assert.deepStrictEqual(rm, { tasks: 1, pfams: 1, projects: 1 });
    assert.strictEqual(data.tasks.length, n - 1);
    assert.ok(data.projects.some((p) => p.id === "amd"));
  });

  ok("Gen12: re-import of the same data changes nothing", () => {
    const data = C.emptyData();
    C.apply(data, C.plan(data, "gen12", g.items));
    const pl = C.plan(data, "gen12", C.gen12Items(ds, opts).items);
    assert.strictEqual(pl.rows.filter((r) => r.status === "update").length, 0);
    assert.strictEqual(pl.gone.length, 0);
    assert.ok(pl.rows.filter((r) => r.status === "new").every((r) => !r.on), "previously unticked stay unticked");
  });

  const xlsx = process.argv[2] || path.join(root, "../To MSFT_Wiwynn NPI Dashboard_C419E_Gen12.0_DV Pilot_and_Gen12.1_TTM_Pilot_with Lanai_20260923.xlsx");
  if (fs.existsSync(xlsx)) {
    ok("Gen12 Excel: browser importer gives the same tasks as the seed", () => {
      const XLSX = require("../js/vendor/xlsx.full.min.js");
      const Importer = require("../js/importer.js");
      const wb = XLSX.read(fs.readFileSync(xlsx), { type: "buffer", cellFormula: true, cellNF: true, cellDates: false });
      const fromXl = C.gen12Items(Importer.convert(XLSX, wb, path.basename(xlsx)), opts).items;
      const key = (i) => [i.srcKey, i.start, i.end, i.lead, i.defaultOn].join("|");
      assert.deepStrictEqual(fromXl.map(key), g.items.map(key));
    });
  } else console.log("  - (Excel check skipped: workbook not found)");
} else console.log("  - (Gen12 checks skipped: ../Gen12AMD_Pilot_gantt not found)");

console.log(`core OK: ${n} checks`);
