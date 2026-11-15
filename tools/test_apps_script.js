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
    appendRow(row) {
      cells.push(row.map(String));
    },
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
    getUuid: () => require("crypto").randomUUID(),
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
// Every write carries the edit password unless a test passes its own `key`.
const post = (body) => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify({ key: "secret", ...body }) } }).text);

// ---------------------------------------------------------------- tests
// No EDIT_KEY set: the backend fails closed, nobody can write or unlock edit mode.
let r = post({ action: "saveAll", data: seed, baseVersion: 0 });
assert.ok(!r.ok && r.authFailed && /EDIT_KEY/.test(r.error), "no EDIT_KEY -> every write refused");
assert.ok(post({ action: "auth" }).authFailed, "no EDIT_KEY -> auth refused");
props.EDIT_KEY = "secret";

r = get({ action: "ping" });
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

for (const key of [undefined, "", "Secret", "wrong"]) {
  r = post({ action: "saveAll", data: seed, baseVersion: 2, key });
  assert.ok(!r.ok && r.authFailed && /密碼不正確/.test(r.error), `wrong password rejected (${key})`);
}
assert.strictEqual(get({ action: "bundle" }).version, 2, "a rejected write changes nothing");
r = post({ action: "auth", key: "wrong" });
assert.ok(!r.ok && r.authFailed, "auth: wrong password");
assert.ok(post({ action: "auth" }).ok, "auth: right password");
// The old in-page password hash is never stored, published or snapshotted.
const withHash = JSON.parse(JSON.stringify(seed));
withHash.settings.editHash = "abc123";
r = post({ action: "saveAll", data: withHash, baseVersion: 2 });
assert.ok(r.ok && r.version === 3, "right password accepted");
assert.ok(!("editHash" in get({ action: "bundle" }).data.settings), "editHash stripped from the bundle");
assert.ok(!/editHash/.test(liveSnapshots().slice(-1)[0].content), "editHash stripped from the snapshot");

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

// 「ADO Task › 我的成員」的對應存在 employee.ado：舊版 Code.gs 的 Employees 只有 id/name/active，
// 一次雲端往返就會把對應洗掉（2026-10-20 的回報），所以這裡把它釘住。
{
  const withAdo = JSON.parse(JSON.stringify(seed));
  withAdo.employees = [
    { id: "e1", name: "朱小明", active: true, ado: "Dixon Chu WYHQ Wiwynn, Dixon_Chu@wiwynn.com" },
    { id: "e2", name: "林小華", active: true },
  ];
  // EDIT_KEY is set by the checks above, so this save has to carry it.
  const saved = post({ action: "saveAll", data: withAdo, baseVersion: null, key: "secret", by: "張三" });
  assert.ok(saved.ok, "the ado save went through");
  const back = get({ action: "bundle" }).data.employees;
  assert.strictEqual(back[0].ado, "Dixon Chu WYHQ Wiwynn, Dixon_Chu@wiwynn.com", "employee.ado survives the cloud round trip");
  assert.strictEqual(back[1].ado, "", "an employee without it gets the key back empty, never missing");
  assert.ok(back.every((e) => "ado" in e), "the key is always present, so the page can spot an old deployment");
}

// Only the newest SNAPSHOT_KEEP are kept (tiny dataset: this is about pruning, not round-tripping).
const tiny = { projects: [], pfams: [], tasks: [], employees: [], trips: [], settings: {} };
for (let i = 0; i < 35; i++) post({ action: "saveAll", data: tiny, baseVersion: null, key: "secret", by: "p" });
assert.strictEqual(liveSnapshots().length, ctx.SNAPSHOT_KEEP, `pruned to ${ctx.SNAPSHOT_KEEP}`);
const kept = liveSnapshots().map((f) => f.created);
assert.deepStrictEqual(kept, [...kept].sort((a, b) => a - b).slice(-kept.length), "kept ones are the newest");

// ---------------------------------------------------------------- MTE PFAM sync (no password)
{
  // No key at all; lang:"en" so the checks below can match the English messages.
  const open = (body) => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify({ lang: "en", ...body }) } }).text);
  r = get({ action: "collab" });
  assert.deepStrictEqual([r.ok, r.rev, r.rows], [true, 0, []], "collab starts empty");
  assert.strictEqual(JSON.stringify(r.fields), JSON.stringify(["project", "pfam", "type", "pn", "site", "pod", "rk", "start", "end", "owner", "status", "note"]), "collab reports its fields (must match COLLAB_FIELDS in js/remote.js)");
  const dataVersion = get({ action: "bundle" }).version;

  const row = { project: "Gen11", pfam: "Gen11.1 MM34 FTB", type: "closedloop", pn: "PN-1", site: "MX", pod: "Pod 3", rk: "RK-001, RK-256", start: "2026-11-01", end: "2026-11-20", owner: "both", status: "doing", note: "need 2 people" };
  r = open({ action: "collabSave", row });
  assert.ok(r.ok && r.row.id && r.row.rev === 1 && r.rev === 1, "anyone can add a row, without the edit password");
  const id = r.row.id;
  assert.strictEqual(get({ action: "bundle" }).version, dataVersion, "collab writes never touch the department data");
  assert.ok(get({ action: "collab", since: "1" }).unchanged, "?since= current rev -> unchanged");

  r = get({ action: "collab" });
  assert.strictEqual(r.rows.length, 1);
  const back = r.rows[0];
  for (const k of Object.keys(row)) assert.strictEqual(back[k], row[k], `collab round trip: ${k}`);
  assert.strictEqual(back.deleted, false);

  r = open({ action: "collabSave", row: { ...back, note: "mine" }, baseRev: 1 });
  assert.ok(r.ok && r.row.rev === 2 && r.row.note === "mine", "edit with the current row rev");
  r = open({ action: "collabSave", row: { ...back, note: "stale" }, baseRev: 1 });
  assert.ok(!r.ok && r.conflict && r.row.note === "mine" && r.row.rev === 2, "stale row rev -> conflict, with the newer row");

  // Checked and capped on the server.
  assert.ok(/Project is required/.test(open({ action: "collabSave", row: { ...row, project: "  " } }).error), "project required");
  assert.ok(/Task type is required/.test(open({ action: "collabSave", row: { ...row, type: "golden" } }).error), "unknown task type refused");
  assert.strictEqual(open({ action: "collabSave", lang: "zh", row: { ...row, pn: "" } }).error, "L10 PN 必填", "messages are in Chinese unless the page asks for English");
  assert.ok(/L10 PN is required/.test(open({ action: "collabSave", row: { ...row, pn: " " } }).error), "L10 PN required");
  assert.ok(/PFAM is required/.test(open({ action: "collabSave", row: { ...row, pfam: "" } }).error), "pfam required");
  assert.ok(/Site/.test(open({ action: "collabSave", row: { ...row, site: "" } }).error), "site required");
  assert.ok(/before/.test(open({ action: "collabSave", row: { ...row, start: "2026-11-20", end: "2026-11-01" } }).error), "end before start");
  r = open({ action: "collabSave", row: { ...row, pfam: "=HYPERLINK(\"x\")", owner: "boss", status: "?", start: "soon", note: "x".repeat(5000) } });
  assert.ok(r.ok, "odd values are cleaned, not fatal");
  const odd = get({ action: "collab" }).rows.find((x) => x.id === r.row.id);
  assert.deepStrictEqual([odd.owner, odd.status, odd.start, odd.note.length], ["both", "todo", "", 2000], "unknown values fall back, long text is capped");
  assert.strictEqual(odd.pfam, "=HYPERLINK(\"x\")", "a formula-looking value reads back as typed");
  const pfamCol = sheets.Collab._cells()[0].indexOf("pfam");
  assert.ok(sheets.Collab._cells().slice(1).every((c) => !String(c[pfamCol]).startsWith("=")), "but is never stored as a formula");

  // Delete only flags the row; anyone can restore it.
  r = open({ action: "collabDelete", id });
  assert.ok(r.ok && r.row.deleted, "delete flags");
  assert.ok(get({ action: "collab" }).rows.find((x) => x.id === id).deleted, "deleted row is still there");
  r = open({ action: "collabRestore", id });
  assert.ok(r.ok && !r.row.deleted, "restore");
  assert.ok(/not found/.test(open({ action: "collabDelete", id: "nope" }).error), "unknown id");

  const log = sheets.CollabLog._cells();
  assert.strictEqual(JSON.stringify(log[0]), JSON.stringify(["at", "action", "id", "row"]), "log header");
  assert.strictEqual(log.length - 1, 5, "every successful change is logged");
  assert.ok(log.slice(1).map((l) => l[1]).join() === "collabSave,collabSave,collabSave,collabDelete,collabRestore");

  // The open door is only for collab actions: saveAll still needs the password.
  assert.ok(open({ action: "saveAll", data: seed, baseVersion: null }).authFailed, "saveAll without the password is still refused");
  // A whole-dataset save leaves the collab rows alone.
  post({ action: "saveAll", data: seed, baseVersion: null });
  assert.strictEqual(get({ action: "collab" }).rows.length, 2, "saveAll does not wipe Collab");
  assert.strictEqual(open({ action: "collabSave", row: { ...row, owner: "local" } }).row.owner, "both", "the first version's owner \"local\" is now \"both\"");
  r = open({ action: "collabSave", row: { ...row, rk: " RK-001 RK-256\uFF0Crk-001\nRK-300;; " } });
  assert.strictEqual(r.row.rk, "RK-001, RK-256, RK-300", "RK location: split on commas / spaces / lines, repeats dropped");
  open({ action: "collabDelete", id: r.row.id });
}

console.log(`apps script OK: ${seed.tasks.length} tasks, ${seed.trips.length} trips round-trip; conflict, password, date, ?since=, employee.ado, snapshot, prune and MTE PFAM sync checks pass`);
