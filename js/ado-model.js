/*
 * ADO work items: normalisation, derived fields, filtering, grouping, and pairing an ADO account
 * with someone on the department roster.
 *
 * Pure functions over plain records (browser: window.AdoModel, Node: require) so tools/test_core.js
 * can check them. No DOM, no localStorage: anything that needs those lives in js/views/ado.js.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AdoModel = api;
})(typeof self !== "undefined" ? self : this, function () {
  /** Columns are matched by alias, never by position: a manual export and the REST API differ. */
  const FIELD_ALIASES = {
    assignee: ["assignedto", "assignee", "owner", "assignedtodisplayname"],
    email: ["email", "assignedtoemail", "uniquename", "mail"],
    id: ["id", "workitemid", "workitem"],
    type: ["workitemtype", "type"],
    state: ["state", "status"],
    changed: ["changeddate", "changed", "lastupdated", "lastchangeddate"],
    created: ["createddate", "created"],
    title: ["title", "subject"],
    link: ["link", "url", "weburl"],
    rawTags: ["tags", "tag"],
    area: ["areapath", "area"],
    iteration: ["iterationpath", "iteration", "sprint"],
    priority: ["priority"],
  };

  /** Rows in these states are dropped on load, so a full-board export still reads as open items. */
  const CLOSED_STATES = ["done", "closed", "removed", "resolved", "completed", "complete", "cancelled", "canceled", "abandoned", "rejected", "inactive"];

  /** Bookkeeping item types: real work, but noise in a workload view - the 排除 shortcut hides them. */
  const NOISE_TYPES = ["worklog", "release note"];

  const SITE_CODES = ["WYHQ", "WYMX", "WYMY", "WYMTN", "WYMUS", "WYLZ", "WYUS", "WCZ", "WYSZ", "WYTN"];

  /**
   * Tokens an ADO display name carries besides the person's name: ADO shows them as
   * "Dixon Chu WYHQ Wiwynn", so the site and the company are dropped from the tail before matching.
   */
  const NAME_NOISE = new Set(["wiwynn", "inc", "corp", "corporation", "ltd", "co", "hq", ...SITE_CODES.map((c) => c.toLowerCase())]);

  const UNASSIGNED = "(未指派)";

  /** Four phases, so a board with a dozen states still reads at a glance. Add states here, not to the CSS. */
  const PHASES = [
    { key: "backlog", label: "待辦", match: ["to do", "todo", "new", "open", "proposed", "approved"] },
    { key: "doing", label: "進行中", match: ["doing", "active", "in progress", "committed", "fine tuning"] },
    { key: "review", label: "審查/驗證", match: ["review", "internal review", "qe review", "verifying", "verify", "testing"] },
    { key: "release", label: "待發布", match: ["release", "released", "verified", "ready"] },
  ];

  const AGE_BUCKETS = [
    { key: "0-30", label: "≤30 天", min: 0, max: 30, tone: "" },
    { key: "31-90", label: "31–90 天", min: 31, max: 90, tone: "warn" },
    { key: "91-180", label: "91–180 天", min: 91, max: 180, tone: "serious" },
    { key: "181-365", label: "181–365 天", min: 181, max: 365, tone: "critical" },
    { key: "366-99999", label: "> 365 天", min: 366, max: 99999, tone: "critical" },
  ];

  const STALE_DAYS = 31; // what the 停滯 shortcut and the KPI mean by "stalled": a month without an update

  const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const key = (s) => String(s ?? "").toLowerCase().trim();

  function buildFieldMap(header) {
    const map = {};
    for (const h of header) {
      const k = norm(h);
      for (const field of Object.keys(FIELD_ALIASES)) if (!map[field] && FIELD_ALIASES[field].includes(k)) map[field] = h;
    }
    return map;
  }

  /** yyyy-mm-dd, m/d/yyyy (ADO's en-US export) or anything Date understands -> yyyy-mm-dd. */
  function parseDay(s) {
    if (!s) return "";
    const t = String(s).trim();
    let m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(t);
    if (!m) {
      const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(t);
      if (us) m = [t, us[3], us[1], us[2]];
    }
    if (m) return `${m[1]}-${String(+m[2]).padStart(2, "0")}-${String(+m[3]).padStart(2, "0")}`;
    const d = new Date(t);
    return isNaN(d.getTime()) ? "" : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  const daysBetween = (fromIso, toIso) => Math.max(0, Math.round((Date.parse(toIso + "T00:00:00Z") - Date.parse(fromIso + "T00:00:00Z")) / 86400000));

  function phaseOf(state) {
    const s = key(state);
    const hit = PHASES.find((p) => p.match.includes(s));
    if (hit) return hit.key;
    if (/review|verif|test/.test(s)) return "review";
    if (/doing|active|progress|tuning/.test(s)) return "doing";
    if (/release|ready/.test(s)) return "release";
    return "backlog";
  }

  const bucketOf = (days) => (AGE_BUCKETS.find((b) => days >= b.min && days <= b.max) || AGE_BUCKETS[AGE_BUCKETS.length - 1]).key;
  const bucket = (k) => AGE_BUCKETS.find((b) => b.key === k) || null;

  /** Project tags: every leading [..] group of the title, Gen tokens and site codes anywhere, plus ADO Tags. */
  function tagsOf(title, rawTags) {
    const out = [];
    const seen = new Set();
    const add = (t) => {
      const s = String(t ?? "").trim().replace(/^[#/,]+|[#/,]+$/g, "");
      if (!s || s.length > 24 || seen.has(s.toLowerCase())) return;
      seen.add(s.toLowerCase());
      out.push(s);
    };
    const head = /^(\s*\[[^\]]*\])+/.exec(title || "");
    if (head) for (const g of head[0].match(/\[[^\]]*\]/g) || []) g.slice(1, -1).split(/[/,;|]+/).forEach(add);
    for (const g of String(title || "").match(/\bGen\s?\d+(?:\.\d+)?\b/gi) || []) add(g.replace(/\s+/g, ""));
    for (const code of SITE_CODES) if (new RegExp(`\\b${code}\\b`, "i").test(title || "")) add(code);
    String(rawTags || "").split(/[;,]/).forEach(add);
    return out;
  }

  /** The most frequent original spelling per case-folded value, so "To do" and "To Do" collapse into one. */
  function canonicaliser(rows, field) {
    const tally = new Map();
    for (const r of rows) {
      const k = key(r[field]);
      if (!k) continue;
      if (!tally.has(k)) tally.set(k, new Map());
      const m = tally.get(k);
      m.set(r[field], (m.get(r[field]) || 0) + 1);
    }
    const best = new Map();
    for (const [k, m] of tally) best.set(k, [...m.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))[0][0]);
    return (v) => best.get(key(v)) || v;
  }

  /**
   * Records (from the REST call or a CSV) -> rows with derived fields.
   * opts.today: yyyy-mm-dd, the day stalling is measured against (once per load, not per render).
   */
  function normalise(records, opts) {
    opts = opts || {};
    const today = opts.today || new Date().toISOString().slice(0, 10);
    // The union of keys, not those of the first record: a REST row only carries Email when the
    // work item has an assignee, and a hand-made CSV can be ragged too.
    const header = [...new Set(records.flatMap((r) => Object.keys(r)))];
    const fm = buildFieldMap(header);
    const get = (rec, field) => (fm[field] ? String(rec[fm[field]] ?? "").trim() : "");
    const rows = [];
    let dropped = 0;

    for (const rec of records) {
      const state = get(rec, "state");
      if (CLOSED_STATES.includes(key(state))) {
        dropped++;
        continue;
      }
      const id = get(rec, "id").replace(/\D/g, "");
      const title = get(rec, "title");
      if (!id && !title) continue;
      const changed = parseDay(get(rec, "changed"));
      const ageDays = changed ? daysBetween(changed, today) : -1;
      let assignee = get(rec, "assignee");
      let email = get(rec, "email");
      // A manual export can hold "Name <mail@x.com>" in one column.
      const inline = /^(.*?)[<(]\s*([^\s<>()]+@[^\s<>()]+)\s*[>)]$/.exec(assignee);
      if (inline) {
        assignee = inline[1].trim();
        email = email || inline[2];
      }
      if (!assignee || /^\(?unassigned\)?$/i.test(assignee)) assignee = UNASSIGNED;
      rows.push({
        id,
        idNum: Number(id) || 0,
        assignee,
        who: shortName(assignee),
        email,
        type: get(rec, "type"),
        state,
        changed,
        created: parseDay(get(rec, "created")),
        ageDays,
        ageBucket: bucketOf(ageDays < 0 ? 99999 : ageDays),
        title,
        link: get(rec, "link"),
        tags: tagsOf(title, get(rec, "rawTags")),
        area: get(rec, "area"),
        iteration: get(rec, "iteration"),
        priority: get(rec, "priority"),
      });
    }

    const canonState = canonicaliser(rows, "state");
    const canonType = canonicaliser(rows, "type");
    for (const r of rows) {
      r.state = canonState(r.state) || "(無狀態)";
      r.type = canonType(r.type) || "(無類型)";
      r.phase = phaseOf(r.state);
      r.isNoise = NOISE_TYPES.includes(key(r.type));
      r.unassigned = r.assignee === UNASSIGNED;
      r.stale = r.ageDays >= STALE_DAYS || r.ageDays < 0;
      r.search = [r.id, r.assignee, r.type, r.state, r.title, r.tags.join(" "), r.area, r.iteration].join(" ").toLowerCase();
    }
    return { rows, dropped, fieldMap: fm, today };
  }

  // ------------------------------------------------------------------ filtering
  const DIMS = ["assignee", "type", "state", "tag"];

  const valuesFor = (row, dim) => (dim === "tag" ? (row.tags.length ? row.tags : ["(無標籤)"]) : [row[dim]]);

  /**
   * One row against the filter. skipDim is left out so facet() can count "what this option would give"
   * with every other condition applied.
   * f: { search, assignee[], type[], state[], tag[], age, from, to, quick: {stale, unassigned, noNoise, roster},
   *      extra(row) }
   */
  function matches(row, f, skipDim) {
    if (f.search) for (const t of f.search.toLowerCase().split(/\s+/).filter(Boolean)) if (!row.search.includes(t)) return false;
    for (const dim of DIMS) {
      if (dim === skipDim) continue;
      const sel = f[dim];
      if (!sel || !sel.length) continue;
      if (!valuesFor(row, dim).some((v) => sel.includes(v))) return false;
    }
    if (f.age) {
      const [lo, hi] = f.age.split("-").map(Number);
      if (row.ageDays < lo || row.ageDays > hi) return false;
    }
    if (f.from && (!row.changed || row.changed < f.from)) return false;
    if (f.to && (!row.changed || row.changed > f.to)) return false;
    const quick = f.quick || {};
    if (quick.stale && !row.stale) return false;
    if (quick.unassigned && !row.unassigned) return false;
    if (quick.noNoise && row.isNoise) return false;
    // Predicates that need data outside the model (the roster match) come in through extra.
    if (f.extra && !f.extra(row)) return false;
    return true;
  }

  const filter = (rows, f) => rows.filter((r) => matches(r, f, null));

  /** Counts for one dimension with every other filter applied (facet counts). */
  function facet(rows, f, dim) {
    const counts = new Map();
    for (const r of rows) {
      if (!matches(r, f, dim)) continue;
      for (const v of valuesFor(r, dim)) counts.set(v, (counts.get(v) || 0) + 1);
    }
    return counts;
  }

  function tally(rows, dim) {
    const counts = new Map();
    for (const r of rows) for (const v of valuesFor(r, dim)) counts.set(v, (counts.get(v) || 0) + 1);
    return counts;
  }

  const COLLATOR = typeof Intl !== "undefined" && Intl.Collator ? new Intl.Collator(["zh-Hant", "en"], { numeric: true }) : { compare: (a, b) => String(a).localeCompare(String(b)) };

  /** Descending by count, then by name, so a chart keeps a stable order. */
  const toSortedPairs = (counts) => [...counts.entries()].map(([k, v]) => ({ key: k, value: v })).sort((a, b) => b.value - a.value || COLLATOR.compare(a.key, b.key));

  function sort(rows, field, dir) {
    const mul = dir === "desc" ? -1 : 1;
    return rows.slice().sort((a, b) => {
      let x = a[field];
      let y = b[field];
      if (field === "id") (x = a.idNum), (y = b.idNum);
      if (typeof x === "number" && typeof y === "number") return (x - y) * mul;
      return COLLATOR.compare(String(x), String(y)) * mul;
    });
  }

  /** [{ key, rows }] - biggest group first, except 停滯區間 which keeps its natural order. */
  function group(rows, dim) {
    if (!dim) return [{ key: "", rows }];
    const buckets = new Map();
    for (const r of rows)
      for (const k of dim === "tag" ? valuesFor(r, "tag") : [r[dim]]) {
        if (!buckets.has(k)) buckets.set(k, []);
        buckets.get(k).push(r);
      }
    const keys =
      dim === "ageBucket"
        ? AGE_BUCKETS.map((b) => b.key).filter((k) => buckets.has(k))
        : [...buckets.keys()].sort((a, b) => buckets.get(b).length - buckets.get(a).length || COLLATOR.compare(a, b));
    return keys.map((k) => ({ key: k, rows: buckets.get(k) }));
  }

  // ------------------------------------------------------------------ roster pairing
  /** Fold a name for comparison: drop (notes) and 【註】, punctuation to spaces, keep CJK. */
  function fold(s) {
    return String(s ?? "")
      .toLowerCase()
      .replace(/[([（【][^)\]）】]*[)\]）】]/g, " ")
      .replace(/[^a-z0-9㐀-鿿]+/g, " ")
      .trim();
  }

  /** The name as a person reads it: "Dixon Chu WYHQ Wiwynn" -> "Dixon Chu". Filtering still uses the full one. */
  function shortName(name) {
    const t = String(name ?? "").trim().split(/\s+/).filter(Boolean);
    while (t.length > 2 && NAME_NOISE.has(fold(t[t.length - 1]))) t.pop();
    return t.join(" ") || String(name ?? "");
  }

  /** Folded name tokens, with a trailing site / company tail dropped ("Dixon Chu WYHQ Wiwynn"). */
  function nameTokens(text) {
    const t = fold(text).split(/\s+/).filter(Boolean);
    while (t.length > 2 && NAME_NOISE.has(t[t.length - 1])) t.pop();
    return t;
  }

  /**
   * Every key an identity may be recognised by, so that one person written four different ways still
   * lands on one roster entry:
   *   the whole name ("dixonchu"), its token-sorted form ("Chu, Dixon" = "Dixon Chu"),
   *   first + last ("Timothy PH Lee" = "Timothy Lee", for middle initials),
   *   the first two tokens (an unknown suffix after the name), and all of the above from an email's
   *   local part, which is the surest of the lot ("Dixon_Chu@wiwynn.com").
   */
  function identityKeys(name, email) {
    const out = new Set();
    const add = (s) => s && s.length > 1 && out.add(s);
    const pair = (a, b) => {
      add(a + b);
      add([a, b].sort().join(""));
    };
    const push = (text) => {
      const t = nameTokens(text);
      if (!t.length) return;
      add(t.join(""));
      if (t.length > 1) add(t.slice().sort().join(""));
      if (t.length > 2) {
        pair(t[0], t[t.length - 1]);
        pair(t[0], t[1]);
      }
    };
    push(name);
    const local = String(email ?? "").split("@")[0];
    if (local) push(local);
    return [...out];
  }

  /** employee.ado -> the names / mailboxes it lists. Split on commas only: a name has spaces in it. */
  const aliasesOf = (emp) => String(emp.ado ?? "").split(/[,;、，]+/).map((x) => x.trim()).filter(Boolean);

  /**
   * Who on the roster an unpaired ADO person most likely is, best first. Used to pre-fill 批次對應,
   * never to pair on its own: every suggestion is confirmed by a person.
   * Scores shared name tokens (the mail's local part counts too), with the given name and the
   * surname weighted, so "Ryan Chu WYHQ Wiwynn" suggests "Ryan Chu" ahead of "Ryan Lin".
   */
  function rankCandidates(name, email, employees) {
    const mine = new Set([...nameTokens(name), ...nameTokens(String(email ?? "").split("@")[0] || "")].filter(Boolean));
    if (!mine.size) return [];
    const first = nameTokens(name)[0] || "";
    const last = nameTokens(name).slice(-1)[0] || "";
    return employees
      .map((e) => {
        const theirs = [e.name, ...aliasesOf(e)].flatMap(nameTokens);
        const set = new Set(theirs.filter(Boolean));
        let score = 0;
        for (const t of set) if (mine.has(t)) score += 3;
        if (first && set.has(first)) score += 2;
        if (last && set.has(last)) score += 2;
        // A roster "Dixon" against "dixonchu": one being the start of the other still counts for something.
        if (!score) for (const t of set) for (const m of mine) if (t.length > 2 && m.length > 2 && (t.startsWith(m) || m.startsWith(t))) score += 1;
        return { empId: e.id, score };
      })
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score);
  }

  /**
   * Pair ADO assignees with the roster.
   *   byEmp     Map(empId -> rows)            tasks of each matched person
   *   empOf     Map(assignee name -> empId)   how each ADO name was resolved
   *   unmatched Map(assignee name -> rows)    ADO people not on the roster (未指派 excluded)
   *   people    [{ name, email, rows, empId, byFirstName }] one entry per ADO assignee
   *   firstName Set(assignee name)            the ones only the given-name pass could place
   * An employee's ADO 帳號 field (emp.ado, comma separated names or emails) wins over a name match,
   * and a full-name match wins over the given-name pass below.
   */
  function matchRoster(rows, employees) {
    const index = new Map(); // identity key -> empId
    for (const e of employees) for (const a of aliasesOf(e)) for (const k of identityKeys(a, a)) if (!index.has(k)) index.set(k, e.id);
    for (const e of employees) for (const k of identityKeys(e.name, "")) if (!index.has(k)) index.set(k, e.id);

    const people = new Map(); // assignee name -> { name, email, rows, empId }
    for (const r of rows) {
      if (!people.has(r.assignee)) people.set(r.assignee, { name: r.assignee, email: r.email || "", rows: [], empId: "" });
      const p = people.get(r.assignee);
      p.rows.push(r);
      if (!p.email && r.email) p.email = r.email;
    }

    const byEmp = new Map();
    const empOf = new Map();
    const unmatched = new Map();
    for (const p of people.values()) {
      if (p.name === UNASSIGNED) continue;
      const empId = identityKeys(p.name, p.email).map((k) => index.get(k)).find(Boolean) || "";
      p.empId = empId;
      if (empId) {
        empOf.set(p.name, empId);
        if (!byEmp.has(empId)) byEmp.set(empId, []);
        byEmp.get(empId).push(...p.rows);
      } else unmatched.set(p.name, p.rows);
    }

    /*
     * Second pass, for a roster kept on given names only ("Dixon") against ADO's full display names
     * ("Dixon Chu WYHQ Wiwynn"). Accepted only when that given name picks out exactly one person on
     * each side and the employee has nothing else yet, so two Ryans can never collapse into one -
     * those stay unmatched and are mapped by hand in 「名冊外的負責人」.
     */
    const firstName = new Set();
    const given = (text) => nameTokens(text)[0] || "";
    const byGivenEmp = new Map();
    for (const e of employees) {
      if (byEmp.has(e.id)) continue;
      const g = given(e.name);
      if (!g) continue;
      if (!byGivenEmp.has(g)) byGivenEmp.set(g, []);
      byGivenEmp.get(g).push(e.id);
    }
    const byGivenAdo = new Map();
    for (const name of unmatched.keys()) {
      const g = given(name);
      if (!g) continue;
      if (!byGivenAdo.has(g)) byGivenAdo.set(g, []);
      byGivenAdo.get(g).push(name);
    }
    for (const [g, names] of byGivenAdo) {
      const cands = byGivenEmp.get(g) || [];
      if (names.length !== 1 || cands.length !== 1) continue;
      const name = names[0];
      const empId = cands[0];
      empOf.set(name, empId);
      byEmp.set(empId, unmatched.get(name));
      unmatched.delete(name);
      firstName.add(name);
      const p = people.get(name);
      if (p) {
        p.empId = empId;
        p.byFirstName = true;
      }
    }

    return { byEmp, empOf, unmatched, firstName, people: [...people.values()] };
  }

  return {
    FIELD_ALIASES,
    CLOSED_STATES,
    NOISE_TYPES,
    PHASES,
    AGE_BUCKETS,
    STALE_DAYS,
    UNASSIGNED,
    DIMS,
    normalise,
    parseDay,
    phaseOf,
    bucketOf,
    bucket,
    tagsOf,
    matches,
    filter,
    facet,
    tally,
    toSortedPairs,
    sort,
    group,
    fold,
    rankCandidates,
    shortName,
    nameTokens,
    identityKeys,
    aliasesOf,
    matchRoster,
  };
});
