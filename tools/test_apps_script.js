#!/usr/bin/env node
/*
 * Runs apps-script/Code.gs against an in-memory mock of the Apps Script services and checks that
 * saveAll -> bundle round-trips the seed dataset, and that the version lock reports conflicts.
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
const sheets = {};
const ss = { getSheetByName: (n) => sheets[n] || null, insertSheet: (n) => (sheets[n] = makeSheet()) };
const props = {};
const ctx = {
  SpreadsheetApp: { getActiveSpreadsheet: () => ss },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] || null }) },
  ContentService: { MimeType: { JSON: "json", JAVASCRIPT: "js" }, createTextOutput: (t) => ({ text: t, setMimeType() { return this; } }) },
  Session: { getScriptTimeZone: () => "Asia/Taipei" },
  Utilities: { formatDate: (d) => d.toISOString().slice(0, 10) },
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

console.log(`apps script OK: ${seed.tasks.length} tasks, ${seed.trips.length} trips round-trip; conflict, key and date checks pass`);
