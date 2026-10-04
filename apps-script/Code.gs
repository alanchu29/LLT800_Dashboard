/**
 * LLT800_Dashboard - Google Apps Script backend.
 *
 * Bind this script to an EMPTY Google Sheet (Extensions > Apps Script), paste this file,
 * then Deploy > New deployment > Web app (Execute as: Me, Who has access: Anyone).
 * Sheets (Projects / PFAMs / Tasks / Employees / Trips / Ignored / Meta) are created on first save.
 *
 * Optional write protection: Project Settings > Script properties > EDIT_KEY = <secret>,
 * and type the same key in the dashboard's 設定 > 雲端同步 > 寫入金鑰.
 *
 * GET  ?action=ping|bundle[&callback=fn]        (JSONP when callback is given)
 * POST {action:"saveAll", data, baseVersion}    replace everything; optimistic lock on Meta.version
 *                                               (baseVersion null = overwrite whatever is there)
 */

var SCHEMA = {
  Projects: ['id', 'name', 'color', 'status', 'notes', 'srcKind', 'srcKey', 'pfamCap', 'link', 'linkName'],
  PFAMs: ['id', 'projectId', 'projectName', 'name', 'site', 'notes', 'srcKind', 'srcKey'],
  Tasks: ['id', 'pfamId', 'pfamName', 'name', 'phase', 'section', 'start', 'end', 'assignees', 'assigneeNames', 'lead', 'done',
    'notes', 'baseStart', 'baseEnd', 'srcKind', 'srcKey', 'srcAlt'],
  Employees: ['id', 'name', 'active'],
  Trips: ['id', 'empId', 'empName', 'start', 'end', 'location', 'purpose', 'projectId', 'notes'],
  Ignored: ['kind', 'key'],
  Meta: ['key', 'value']
};
// Columns written for people reading the sheet; ignored when loading.
var DISPLAY_ONLY = { projectName: 1, pfamName: 1, assigneeNames: 1, empName: 1 };
var DATE_COLS = { start: 1, end: 1, baseStart: 1, baseEnd: 1 };

// ---------------------------------------------------------------- HTTP entry points

function doGet(e) {
  var p = (e && e.parameter) || {};
  var out;
  try {
    if (p.action === 'bundle') out = bundle_();
    else out = { ok: true, service: 'LLT800_Dashboard', time: new Date().toISOString() };
  } catch (err) {
    out = { ok: false, error: String(err && err.message || err) };
  }
  return respond_(out, p.callback);
}

function doPost(e) {
  var out;
  var lock = LockService.getScriptLock();
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    checkKey_(body.key);
    lock.waitLock(30000);
    if (body.action === 'saveAll') out = saveAll_(body.data, body.baseVersion);
    else out = { ok: false, error: 'Unknown action: ' + body.action };
  } catch (err) {
    out = { ok: false, error: String(err && err.message || err) };
  } finally {
    try { lock.releaseLock(); } catch (ignore) {}
  }
  return respond_(out);
}

function respond_(obj, callback) {
  var json = JSON.stringify(obj);
  if (callback && /^[A-Za-z_$][\w$]*$/.test(callback)) {
    return ContentService.createTextOutput(callback + '(' + json + ')').setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

function checkKey_(key) {
  var want = PropertiesService.getScriptProperties().getProperty('EDIT_KEY');
  if (want && key !== want) throw new Error('寫入金鑰不正確（設定 > 雲端同步 > 寫入金鑰）');
}

// ---------------------------------------------------------------- read

function bundle_() {
  var meta = readMeta_();
  var version = Number(meta.version || 0);
  if (!version) return { ok: true, version: 0, savedAt: '', data: null };
  var projects = readRows_('Projects').map(function (r) {
    return { id: r.id, name: r.name, color: r.color, status: r.status || 'active', notes: r.notes, src: src_(r), pfamCap: Number(r.pfamCap) || 0, link: r.link || '', linkName: r.linkName || '' };
  });
  var pfams = readRows_('PFAMs').map(function (r) {
    return { id: r.id, projectId: r.projectId, name: r.name, site: r.site, notes: r.notes, src: src_(r) };
  });
  var tasks = readRows_('Tasks').map(function (r) {
    return {
      id: r.id, pfamId: r.pfamId, name: r.name, phase: r.phase, section: r.section, start: r.start, end: r.end,
      assignees: r.assignees ? String(r.assignees).split(',').filter(String) : [],
      lead: r.lead, done: String(r.done).toUpperCase() === 'TRUE', notes: r.notes, baseStart: r.baseStart, baseEnd: r.baseEnd, src: src_(r)
    };
  });
  var employees = readRows_('Employees').map(function (r) {
    return { id: r.id, name: r.name, active: r.active !== false && String(r.active).toUpperCase() !== 'FALSE' };
  });
  var trips = readRows_('Trips').map(function (r) {
    return { id: r.id, empId: r.empId, start: r.start, end: r.end || r.start, location: r.location, purpose: r.purpose, projectId: r.projectId, notes: r.notes };
  });
  var ignored = {};
  readRows_('Ignored').forEach(function (r) {
    (ignored[r.kind] = ignored[r.kind] || []).push(r.key);
  });
  var data = {
    schema: 1,
    settings: parse_(meta.settings, {}),
    source: parse_(meta.source, null),
    projects: projects, pfams: pfams, tasks: tasks, employees: employees, trips: trips,
    importIgnored: ignored
  };
  return { ok: true, version: version, savedAt: meta.savedAt || '', data: data };
}

function src_(r) {
  return r.srcKind ? { kind: r.srcKind, key: r.srcKey, alt: r.srcAlt || '' } : null;
}

function parse_(s, fallback) {
  try { return s ? JSON.parse(s) : fallback; } catch (e) { return fallback; }
}

function readMeta_() {
  var out = {};
  readRows_('Meta').forEach(function (r) { out[r.key] = r.value; });
  return out;
}

/** Rows of a sheet as objects keyed by its header row. Dates typed by hand in the sheet become yyyy-MM-dd. */
function readRows_(name) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh || sh.getLastRow() < 2) return [];
  var values = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getValues();
  var head = values[0].map(String);
  var tz = Session.getScriptTimeZone();
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (row.every(function (v) { return v === '' || v === null; })) continue;
    var o = {};
    for (var c = 0; c < head.length; c++) {
      if (!head[c] || DISPLAY_ONLY[head[c]]) continue;
      var v = row[c];
      if (v instanceof Date) v = Utilities.formatDate(v, tz, 'yyyy-MM-dd');
      else if (typeof v === 'boolean') v = v;
      else v = v === null || v === undefined ? '' : (DATE_COLS[head[c]] ? String(v).slice(0, 10) : v);
      o[head[c]] = typeof v === 'number' ? String(v) : v;
    }
    out.push(o);
  }
  return out;
}

// ---------------------------------------------------------------- write

function saveAll_(data, baseVersion) {
  if (!data || !data.projects) throw new Error('資料格式錯誤');
  var meta = readMeta_();
  var current = Number(meta.version || 0);
  if (baseVersion !== null && baseVersion !== undefined && Number(baseVersion) !== current) {
    return { ok: false, conflict: true, version: current };
  }
  var projName = {}, pfamName = {}, empName = {};
  data.projects.forEach(function (p) { projName[p.id] = p.name; });
  data.pfams.forEach(function (f) { pfamName[f.id] = f.name; });
  data.employees.forEach(function (e) { empName[e.id] = e.name; });
  var s = function (x) { return x && x.src ? x.src : {}; };

  writeRows_('Projects', data.projects.map(function (p) {
    return [p.id, p.name, p.color, p.status || 'active', p.notes || '', s(p).kind || '', s(p).key || '', p.pfamCap || '', p.link || '', p.linkName || ''];
  }));
  writeRows_('PFAMs', data.pfams.map(function (f) {
    return [f.id, f.projectId, projName[f.projectId] || '', f.name, f.site || '', f.notes || '', s(f).kind || '', s(f).key || ''];
  }));
  writeRows_('Tasks', data.tasks.map(function (t) {
    var a = t.assignees || [];
    return [t.id, t.pfamId, pfamName[t.pfamId] || '', t.name, t.phase || '', t.section || '', t.start || '', t.end || '',
      a.join(','), a.map(function (id) { return empName[id] || id; }).join('、'), t.lead || '', !!t.done, t.notes || '',
      t.baseStart || '', t.baseEnd || '', s(t).kind || '', s(t).key || '', s(t).alt || ''];
  }));
  writeRows_('Employees', data.employees.map(function (e) { return [e.id, e.name, e.active !== false]; }));
  writeRows_('Trips', (data.trips || []).map(function (r) {
    return [r.id, r.empId, empName[r.empId] || '', r.start || '', r.end || '', r.location || '', r.purpose || '', r.projectId || '', r.notes || ''];
  }));
  var ign = [];
  var ii = data.importIgnored || {};
  Object.keys(ii).forEach(function (k) { (ii[k] || []).forEach(function (key) { ign.push([k, key]); }); });
  writeRows_('Ignored', ign);

  var version = current + 1;
  var savedAt = new Date().toISOString();
  writeRows_('Meta', [
    ['version', version],
    ['savedAt', savedAt],
    ['settings', JSON.stringify(data.settings || {})],
    ['source', JSON.stringify(data.source || null)]
  ]);
  return { ok: true, version: version, savedAt: savedAt };
}

/** Replace a sheet's content (header + rows). Text format keeps dates and ids exactly as sent. */
function writeRows_(name, rows) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  var head = SCHEMA[name];
  sh.clearContents();
  var all = [head].concat(rows);
  var range = sh.getRange(1, 1, all.length, head.length);
  range.setNumberFormat('@');
  range.setValues(all.map(function (r) {
    return r.map(function (v) { return typeof v === 'boolean' || typeof v === 'number' ? String(v) : v; });
  }));
  sh.setFrozenRows(1);
}
