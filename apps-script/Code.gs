/**
 * LLT800_Dashboard - Google Apps Script backend.
 *
 * Bind this script to an EMPTY Google Sheet (Extensions > Apps Script), paste this file,
 * then Deploy > New deployment > Web app (Execute as: Me, Who has access: Anyone).
 * Sheets (Projects / PFAMs / Tasks / Employees / Trips / Ignored / Meta) are created on first save.
 *
 * Write protection (required): Project Settings > Script properties > EDIT_KEY = <the edit password>.
 * Everyone can read; only a POST carrying that password can write, and with no EDIT_KEY set every write
 * is refused. The dashboard asks for it when someone turns on 編輯模式 (checked with action "auth").
 * Only the owner of this script can change it, so changing the password = editing that property.
 *
 * Every saved version is also kept as a JSON file in Drive (see SNAPSHOT_FOLDER), so a version someone
 * overwrote can be restored with the dashboard's 設定 > 還原 JSON 備份.
 *
 * GET  ?action=ping|bundle[&since=n][&callback=fn]   (JSONP when callback is given)
 *                                               since = the version the caller already has; when that is
 *                                               still the current one the reply is {unchanged:true} and no
 *                                               sheet is read
 * GET  ?action=collab[&since=rev]               MTE PFAM sync rows -> {rev, rows} or {rev, unchanged:true}
 * POST {action:"collabSave", row, baseRev}       add (no row.id) or change one row; no password (see COLLAB below)
 * POST {action:"collabDelete"|"collabRestore", id}
 * POST {action:"auth", key}                      check the edit password -> {ok:true} or {ok:false, authFailed:true}
 * POST {action:"saveAll", data, baseVersion, by, key}  replace everything; optimistic lock on Meta.version
 *                                               (baseVersion null = overwrite whatever is there)
 */

var SCHEMA = {
  Projects: ['id', 'name', 'color', 'status', 'notes', 'srcKind', 'srcKey', 'pfamCap', 'link', 'linkName'],
  PFAMs: ['id', 'projectId', 'projectName', 'name', 'site', 'notes', 'srcKind', 'srcKey'],
  Tasks: ['id', 'pfamId', 'pfamName', 'name', 'phase', 'section', 'start', 'end', 'assignees', 'assigneeNames', 'lead', 'done',
    'notes', 'baseStart', 'baseEnd', 'srcKind', 'srcKey', 'srcAlt'],
  Employees: ['id', 'name', 'active', 'ado'],
  Trips: ['id', 'empId', 'empName', 'start', 'end', 'location', 'purpose', 'projectId', 'notes'],
  Ignored: ['kind', 'key'],
  Meta: ['key', 'value'],
  Collab: ['id', 'project', 'pn', 'site', 'pod', 'start', 'end', 'owner', 'status', 'note', 'pfamId', 'deleted', 'updatedAt', 'rev'],
  CollabLog: ['at', 'action', 'id', 'row']
};
// Columns written for people reading the sheet; ignored when loading.
var DISPLAY_ONLY = { projectName: 1, pfamName: 1, assigneeNames: 1, empName: 1 };
var DATE_COLS = { start: 1, end: 1, baseStart: 1, baseEnd: 1 };

// ---------------------------------------------------------------- HTTP entry points

function doGet(e) {
  var p = (e && e.parameter) || {};
  var out;
  try {
    if (p.action === 'bundle') out = bundle_(p.since);
    else if (p.action === 'collab') out = collabGet_(p.since);
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
    if (COLLAB_ACTIONS[body.action]) {
      // Open to everyone by design: these can only touch the Collab sheet, never the department data.
      lock.waitLock(30000);
      out = collabPost_(body);
      return respond_(out);
    }
    checkKey_(body.key);
    if (body.action === 'auth') {
      out = { ok: true };
    } else {
      lock.waitLock(30000);
      if (body.action === 'saveAll') out = saveAll_(body.data, body.baseVersion, body.by);
      else out = { ok: false, error: 'Unknown action: ' + body.action };
    }
  } catch (err) {
    out = { ok: false, error: String(err && err.message || err) };
    if (err && err.authFailed) out.authFailed = true;
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

/** Fails closed: no EDIT_KEY means nobody can write, so a forgotten setup never leaves the data open. */
function checkKey_(key) {
  var want = PropertiesService.getScriptProperties().getProperty('EDIT_KEY');
  var err;
  if (!want) err = new Error('雲端尚未設定編輯密碼（Apps Script 指令碼屬性 EDIT_KEY），目前不接受任何修改');
  else if (typeof key !== 'string' || key !== want) err = new Error('編輯密碼不正確');
  if (!err) return;
  err.authFailed = true;
  throw err;
}

/** The old in-page password hash (settings.editHash) is no longer used; never store or publish it. */
function publicSettings_(settings) {
  var s = {};
  Object.keys(settings || {}).forEach(function (k) { if (k !== 'editHash') s[k] = settings[k]; });
  return s;
}

// ---------------------------------------------------------------- read

function bundle_(since) {
  var meta = readMeta_();
  var version = Number(meta.version || 0);
  if (!version) return { ok: true, version: 0, savedAt: '', data: null };
  // The caller already has this version: skip reading every sheet (most page loads, on a day nobody edits).
  if (since !== null && since !== undefined && since !== '' && Number(since) === version) {
    return { ok: true, version: version, savedAt: meta.savedAt || '', by: meta.lastBy || '', unchanged: true };
  }
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
    // ado: the ADO display names / mailboxes this person owns, for the ADO Task page. Always sent,
    // even empty, so the page can tell a deployment that still lacks the column from an empty value.
    return { id: r.id, name: r.name, active: r.active !== false && String(r.active).toUpperCase() !== 'FALSE', ado: r.ado || '' };
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
    settings: publicSettings_(parse_(meta.settings, {})),
    source: parse_(meta.source, null),
    projects: projects, pfams: pfams, tasks: tasks, employees: employees, trips: trips,
    importIgnored: ignored
  };
  return { ok: true, version: version, savedAt: meta.savedAt || '', by: meta.lastBy || '', data: data };
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

function saveAll_(data, baseVersion, by) {
  if (!data || !data.projects) throw new Error('資料格式錯誤');
  data.settings = publicSettings_(data.settings); // also keeps it out of the Drive snapshot
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
  writeRows_('Employees', data.employees.map(function (e) { return [e.id, e.name, e.active !== false, e.ado || '']; }));
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
    ['lastBy', by || ''],
    ['settings', JSON.stringify(data.settings)],
    ['source', JSON.stringify(data.source || null)]
  ]);
  snapshot_(data, version, savedAt, by);
  return { ok: true, version: version, savedAt: savedAt, by: by || '' };
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

// ---------------------------------------------------------------- snapshots

// A copy of every saved version, so an overwrite is recoverable. Set a SNAPSHOT_FOLDER_ID script
// property to keep them in a folder of your choice; otherwise one is created on the first save.
var SNAPSHOT_FOLDER = 'LLT800_Dashboard 快照';
var SNAPSHOT_KEEP = 30;

/**
 * Keep the dataset just saved as a Drive JSON file, in the same shape as the dashboard's
 * 匯出 JSON 備份: recovery is download the file > 設定 > 資料 > 還原 JSON 備份.
 * Insurance must not break the thing it insures, so a failure here is logged and the save still succeeds.
 */
function snapshot_(data, version, savedAt, by) {
  try {
    var folder = snapshotFolder_();
    var stamp = Utilities.formatDate(new Date(savedAt), Session.getScriptTimeZone(), 'yyyyMMdd-HHmm');
    var who = String(by || '').replace(/[^\w\u4e00-\u9fff]+/g, '') || 'unknown';
    var body = JSON.stringify({ app: 'LLT800_Dashboard', exportedAt: savedAt, version: version, by: by || '', data: data });
    folder.createFile('llt800-v' + version + '-' + stamp + '-' + who + '.json', body, 'application/json');
    pruneSnapshots_(folder);
  } catch (err) {
    console.warn('snapshot failed: ' + String((err && err.message) || err));
  }
}

/** The snapshot folder: SNAPSHOT_FOLDER_ID when set, else one named SNAPSHOT_FOLDER (its id is remembered). */
function snapshotFolder_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('SNAPSHOT_FOLDER_ID');
  if (id) {
    try {
      return DriveApp.getFolderById(id);
    } catch (err) {
      /* trashed, or no longer ours: fall through and make a new one */
    }
  }
  var it = DriveApp.getFoldersByName(SNAPSHOT_FOLDER);
  var folder = it.hasNext() ? it.next() : DriveApp.createFolder(SNAPSHOT_FOLDER);
  props.setProperty('SNAPSHOT_FOLDER_ID', folder.getId());
  return folder;
}

/** Trash all but the newest SNAPSHOT_KEEP snapshots, oldest first (version numbers do not sort as text). */
function pruneSnapshots_(folder) {
  var files = [];
  var it = folder.getFiles();
  while (it.hasNext()) {
    var f = it.next();
    if (/^llt800-v\d+-/.test(f.getName())) files.push(f);
  }
  if (files.length <= SNAPSHOT_KEEP) return;
  files.sort(function (a, b) { return a.getDateCreated() - b.getDateCreated(); });
  files.slice(0, files.length - SNAPSHOT_KEEP).forEach(function (f) { f.setTrashed(true); });
}

// ---------------------------------------------------------------- MTE PFAM sync (open to everyone)

/*
 * The MTE PFAM sync tab is shared with local MTEs, so it is writable WITHOUT the edit password. That is
 * safe only because it is walled off: its rows live in their own sheet (Collab), every write is one row,
 * every field is checked and capped here, a delete only flags the row (anyone can restore it), and every
 * change is appended to CollabLog. COLLAB_REV (a script property) moves on each write, so a reader that
 * is already current gets {unchanged:true} without the sheet being read.
 */
var COLLAB_ACTIONS = { collabSave: 1, collabDelete: 1, collabRestore: 1 };
var COLLAB_FIELDS = ['project', 'pn', 'site', 'pod', 'start', 'end', 'owner', 'status', 'note', 'pfamId'];
var COLLAB_OWNERS = { hq: 1, local: 1 };
var COLLAB_STATUS = { todo: 1, doing: 1, done: 1 };
var COLLAB_MAX = { text: 200, note: 2000, live: 500, total: 3000 };
// A leading = + - @ would make Sheets read the cell as a formula; a zero-width space keeps it text.
var COLLAB_GUARD = '\u200B';

function collabRev_() {
  return Number(PropertiesService.getScriptProperties().getProperty('COLLAB_REV') || 0);
}

function collabGet_(since) {
  var rev = collabRev_();
  if (since !== null && since !== undefined && since !== '' && Number(since) === rev) return { ok: true, rev: rev, unchanged: true };
  return { ok: true, rev: rev, rows: readCollab_() };
}

function readCollab_() {
  return readRows_('Collab').map(function (r) {
    var o = { id: String(r.id) };
    COLLAB_FIELDS.forEach(function (f) {
      var v = r[f] === undefined || r[f] === null ? '' : String(r[f]);
      o[f] = v.charAt(0) === COLLAB_GUARD ? v.slice(1) : v;
    });
    o.deleted = String(r.deleted).toUpperCase() === 'TRUE';
    o.updatedAt = String(r.updatedAt || '');
    o.rev = Number(r.rev) || 0;
    return o;
  });
}

function writeCollab_(rows) {
  var g = function (v) { return /^[=+\-@]/.test(v) ? COLLAB_GUARD + v : v; };
  writeRows_('Collab', rows.map(function (r) {
    return [r.id].concat(COLLAB_FIELDS.map(function (f) { return g(r[f] || ''); }), [!!r.deleted, r.updatedAt || '', r.rev || 0]);
  }));
}

/** The fields of a row as sent, checked and capped. Throws (in both languages: local MTEs read these). */
function cleanCollab_(r) {
  r = r || {};
  var s = function (v, max) {
    return String(v === undefined || v === null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u200B]/g, '').trim().slice(0, max);
  };
  var day = function (v) {
    v = s(v, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '';
  };
  var out = {
    project: s(r.project, COLLAB_MAX.text), pn: s(r.pn, COLLAB_MAX.text), site: s(r.site, 40), pod: s(r.pod, COLLAB_MAX.text),
    start: day(r.start), end: day(r.end),
    owner: COLLAB_OWNERS[r.owner] ? r.owner : 'hq', status: COLLAB_STATUS[r.status] ? r.status : 'todo',
    note: s(r.note, COLLAB_MAX.note), pfamId: s(r.pfamId, 40)
  };
  if (!out.project) throw new Error('Project / Model 必填 (required)');
  if (!out.site) throw new Error('廠區必填 Site is required');
  if (out.start && out.end && out.end < out.start) throw new Error('結束日早於開始日 End date is before the start date');
  return out;
}

function collabPost_(body) {
  var rows = readCollab_();
  var live = rows.filter(function (r) { return !r.deleted; }).length;
  var find = function (id) {
    for (var i = 0; i < rows.length; i++) if (rows[i].id === String(id || '')) return rows[i];
    throw new Error('找不到這一列（可能已被移除）Row not found');
  };
  var row;
  if (body.action === 'collabSave') {
    var clean = cleanCollab_(body.row);
    if (body.row && body.row.id) {
      row = find(body.row.id);
      // Someone saved this row since the caller read it: hand back theirs and let the caller decide.
      if (Number(body.baseRev) !== row.rev) return { ok: false, conflict: true, row: row, rev: collabRev_() };
      COLLAB_FIELDS.forEach(function (f) { row[f] = clean[f]; });
    } else {
      if (live >= COLLAB_MAX.live) throw new Error('已達 ' + COLLAB_MAX.live + ' 列上限 Row limit reached');
      if (rows.length >= COLLAB_MAX.total) throw new Error('已刪除的列太多，請聯絡 HQ 清理 Too many deleted rows, ask HQ to clean up');
      row = clean;
      row.id = 'c' + Utilities.getUuid().replace(/-/g, '').slice(0, 12);
      row.deleted = false;
      row.rev = 0;
      rows.push(row);
    }
  } else {
    row = find(body.id);
    var del = body.action === 'collabDelete';
    if (!del && row.deleted && live >= COLLAB_MAX.live) throw new Error('已達 ' + COLLAB_MAX.live + ' 列上限 Row limit reached');
    row.deleted = del;
  }
  row.rev += 1;
  row.updatedAt = new Date().toISOString();
  writeCollab_(rows);
  collabLog_(body.action, row);
  var rev = collabRev_() + 1;
  PropertiesService.getScriptProperties().setProperty('COLLAB_REV', String(rev));
  return { ok: true, row: row, rev: rev };
}

/** One line per change, never rewritten: who broke what can always be looked up and put back. */
function collabLog_(action, row) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName('CollabLog');
  if (!sh) {
    sh = ss.insertSheet('CollabLog');
    sh.appendRow(SCHEMA.CollabLog);
    sh.setFrozenRows(1);
  }
  sh.appendRow([row.updatedAt, action, row.id, JSON.stringify(row)]);
}
