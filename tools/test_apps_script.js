#!/usr/bin/env node
/*
 * Runs apps-script/Code.gs against an in-memory mock of the Apps Script services and checks that
 * saveAll -> bundle round-trips the seed dataset, that the version lock reports conflicts, that
 * ?since= skips the read when nothing changed, and that every save leaves a Drive snapshot.
 *   node tools/test_apps_script.js
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const Convert = require("../js/convert.js");

const root = path.join(__dirname, "..");
const seedSrc = fs.readFileSync(path.join(root, "data/seed.js"), "utf8");
const seed = JSON.parse(seedSrc.slice(seedSrc.indexOf("=") + 1).trim().replace(/;$/, ""));

// ---------------------------------------------------------------- mock services
function makeSheet() {
  let cells = []; // 2D array of strings (text format)
  return {
    clearContents() { cells = []; },
    getLastRow() { return cells.length; },
    getLastColumn() { return cells.reduce((m, r) => Math.max(m, r.length), 0); },
    getRange(r, c, nr, nc) {
      return {
        setNumberFormat() { return this; },
        setValues(v) {
          assert.strictEqual(v.length, nr, "row count");
          v.forEach((row, i) => {
            assert.strictEqual(row.length, nc, "column count");
            cells[r - 1 + i] = cells[r - 1 + i] || [];
            row.forEach((x, j) => {
              assert.ok(typeof x === "string", `cell must be text, got ${typeof x} (${x})`);
              cells[r - 1 + i][c - 1 + j] = x;
            });
          });
        },
        getValues() {
          const out = [];
          for (let i = 0; i < nr; i++) out.push(Array.from({ length: nc }, (_, j) => ((cells[r - 1 + i] || [])[c - 1 + j] ?? "")));
          return out;
        },
      };
    },
    setFrozenRows() {},
    _cells: () => cells,
  };
}
// Drive (snapshots): one in-memory folder.
let fileSeq = 0;
const driveFiles = [];
const snapFolder = {
  getId: () => "snapFolder",
  createFile(name, content) {
    const f = { name, content, created: ++fileSeq, trashed: false, getName: () => name, getDateCreated: () => f.created, setTrashed: (t) => (f.trashed = t) };
    driveFiles.push(f);
    return f;
  },
  getFiles() {
    const live = driveFiles.filter((f) => !f.trashed);
    let i = 0;
    return { hasNext: () => i < live.length, next: () => live[i++] };
  },
};
const liveSnapshots = () => driveFiles.filter((f) => !f.trashed);

const sheets = {};
const ss = { getSheetByName: (n) => sheets[n] || null, insertSheet: (n) => (sheets[n] = makeSheet()) };
const props = {};
const ctx = {
  SpreadsheetApp: { getActiveSpreadsheet: () => ss },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] || null, setProperty: (k, v) => (props[k] = v) }) },
  DriveApp: {
    getFolderById: (id) => {
      if (id === "snapFolder") return snapFolder;
      throw new Error("no such folder");
    },
    getFoldersByName: () => ({ hasNext: () => false }),
    createFolder: () => snapFolder,
  },
  ContentService: { MimeType: { JSON: "json", JAVASCRIPT: "js" }, createTextOutput: (t) => ({ text: t, setMimeType() { return this; } }) },
  Session: { getScriptTimeZone: () => "Asia/Taipei" },
  Utilities: {
    formatDate: (d, tz, fmt) => {
      const p = (n) => String(n).padStart(2, "0");
      return String(fmt)
        .replace("yyyy", d.getUTCFullYear())
        .replace("MM", p(d.getUTCMonth() + 1))
        .replace("dd", p(d.getUTCDate()))
        .replace("HH", p(d.getUTCHours()))
        .replace("mm", p(d.getUTCMinutes()));
    },
  },
  console,
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(root, "apps-script/Code.gs"), "utf8"), ctx);

const get = (q) => JSON.parse(ctx.doGet({ parameter: q }).text);
const post = (body) => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(body) } }).text);

// ---------------------------------------------------------------- tests
let r = get({ action: "ping" });
assert.ok(r.ok && r.service === "LLT800_Dashboard");
const jsonp = ctx.doGet({ parameter: { action: "ping", callback: "cb_1" } }).text;
assert.ok(jsonp.startsWith("cb_1(") && jsonp.endsWith(")"), "JSONP wrapper");

r = get({ action: "bundle" });
assert.deepStrictEqual([r.ok, r.version, r.data], [true, 0, null], "empty sheet");

r = post({ action: "saveAll", data: seed, baseVersion: 0 });
assert.ok(r.ok && r.version === 1, "first save -> v1");

r = get({ action: "bundle" });
assert.strictEqual(r.version, 1);
// Compare after the app's own normalisation (it fills defaults the same way on both sides).
const strip = (d) => {
  const n = Convert.normalize(JSON.parse(JSON.stringify(d)));
  delete n.schema;
  for (const k of ["projects", "pfams", "tasks", "employees", "trips"]) n[k] = n[k].map((x) => JSON.parse(JSON.stringify(x, (key, v) => (v === undefined ? undefined : v))));
  // Absent optional fields come back as "" from the sheet.
  for (const t of n.tasks) for (const f of ["phase", "section", "lead", "notes", "baseStart", "baseEnd"]) t[f] = t[f] || "";
  for (const p of n.projects) p.notes = p.notes || "";
  for (const f of n.pfams) for (const k of ["site", "notes"]) f[k] = f[k] || "";
  for (const t of n.trips) for (const k of ["notes", "purpose", "projectId"]) t[k] = t[k] || "";
  for (const x of [...n.projects, ...n.pfams, ...n.tasks]) if (x.src) x.src = { kind: x.src.kind, key: x.src.key, alt: x.src.alt || "" };
  return n;
};
assert.deepStrictEqual(strip(r.data), strip(seed), "round trip");

r = post({ action: "saveAll", data: seed, baseVersion: 0 });
assert.ok(r.conflict && r.version === 1, "stale base version -> conflict");
r = post({ action: "saveAll", data: seed, baseVersion: null });
assert.ok(r.ok && r.version === 2, "forced save");

props.EDIT_KEY = "secret";
r = post({ action: "saveAll", data: seed, baseVersion: 2 });
assert.ok(!r.ok && /金鑰/.test(r.error), "wrong key rejected");
r = post({ action: "saveAll", data: seed, baseVersion: 2, key: "secret" });
assert.ok(r.ok && r.version === 3, "right key accepted");

// A date typed by hand in the sheet (a Date object) is read back as yyyy-MM-dd.
const tasks = sheets.Tasks;
const head = tasks._cells()[0];
tasks._cells()[1][head.indexOf("start")] = vm.runInContext("new Date(Date.UTC(2026, 9, 5))", ctx);
r = get({ action: "bundle" });
assert.strictEqual(r.data.tasks[0].start, "2026-10-05");


// ---------------------------------------------------------------- conditional read (?since=)
r = get({ action: "bundle" });
const cur = r.version;
r = get({ action: "bundle", since: cur });
assert.ok(r.ok && r.unchanged && !r.data && r.version === cur, "since = current version -> unchanged, no data");
r = get({ action: "bundle", since: cur - 1 });
assert.ok(r.ok && !r.unchanged && r.data, "stale since -> full bundle");
r = get({ action: "bundle", since: "" });
assert.ok(r.ok && r.data, "blank since -> full bundle");

// ---------------------------------------------------------------- snapshots + lastBy
const before = liveSnapshots().length;
assert.ok(before >= 3, `每次 save 都留一份快照 (got ${before})`);
r = post({ action: "saveAll", data: seed, baseVersion: cur, key: "secret", by: "張三" });
assert.ok(r.ok && r.by === "張三", "saveAll records who");
const snap = liveSnapshots()[liveSnapshots().length - 1];
assert.strictEqual(liveSnapshots().length, before + 1, "one snapshot per save");
assert.ok(/^llt800-v\d+-\d{8}-\d{4}-張三\.json$/.test(snap.getName()), `snapshot name: ${snap.getName()}`);
assert.ok(snap.getName().startsWith(`llt800-v${r.version}-`), "snapshot name carries the version");
// The snapshot is in 匯出 JSON 備份 shape, so 還原 JSON 備份 accepts it as-is.
const restored = JSON.parse(snap.content);
assert.strictEqual(restored.app, "LLT800_Dashboard");
assert.deepStrictEqual(strip(restored.data), strip(seed), "snapshot restores the dataset");
r = get({ action: "bundle" });
assert.strictEqual(r.by, "張三", "bundle reports the last editor");

// Only the newest SNAPSHOT_KEEP are kept (tiny dataset: this is about pruning, not round-tripping).
const tiny = { projects: [], pfams: [], tasks: [], employees: [], trips: [], settings: {} };
for (let i = 0; i < 35; i++) post({ action: "saveAll", data: tiny, baseVersion: null, key: "secret", by: "p" });
assert.strictEqual(liveSnapshots().length, ctx.SNAPSHOT_KEEP, `pruned to ${ctx.SNAPSHOT_KEEP}`);
const kept = liveSnapshots().map((f) => f.created);
assert.deepStrictEqual(kept, [...kept].sort((a, b) => a - b).slice(-kept.length), "kept ones are the newest");

console.log(`apps script OK: ${seed.tasks.length} tasks, ${seed.trips.length} trips round-trip; conflict, key, date, ?since=, snapshot and prune checks pass`);
