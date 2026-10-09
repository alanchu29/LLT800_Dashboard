/*
 * Derived numbers: task status, project spans, department load, trip days.
 * Pure functions over plain data (browser: window.Model, Node: require) so tools/test_core.js can check them.
 * Days are integers (UTC day numbers, see engine.js toDay/fromDay).
 */
(function (root, factory) {
  const api = factory(root.Engine || (typeof require === "function" ? require("./engine.js") : null));
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Model = api;
})(typeof self !== "undefined" ? self : this, function (E) {
  const D = (iso) => (iso ? E.toDay(iso) : null);

  const STATUS = {
    done: { label: "已完成", icon: "✓" },
    late: { label: "逾期", icon: "!" },
    active: { label: "進行中", icon: "●" },
    future: { label: "未開始", icon: "○" },
    nodate: { label: "無日期", icon: "–" },
  };

  /** done: ticked as finished; late: past its end and not done; active / future by dates. */
  function status(t, today) {
    if (t.done) return "done";
    const s = D(t.start);
    const e = D(t.end);
    if (s == null || e == null) return "nodate";
    if (today > e) return "late";
    if (today >= s) return "active";
    return "future";
  }

  /**
   * Does the task occupy its people on this day? Inside its dates, except finished tasks no longer
   * hold anyone from today on (a task closed early frees its people).
   */
  function occupies(t, day, today) {
    const s = D(t.start);
    const e = D(t.end);
    if (s == null || e == null || day < s || day > e) return false;
    return !(t.done && day >= today);
  }

  /** settings.holidays as day number -> name (a Map, so it also works as the holiday set of E.isWorkday). */
  function holidays(data) {
    const list = (data && data.settings && data.settings.holidays) || [];
    return new Map(list.filter((h) => h && h.date).map((h) => [E.toDay(h.date), h.name || ""]));
  }

  /** Workdays (Mon–Fri, minus hol) in [start, end], both yyyy-mm-dd; 0 when a date is missing. */
  function workdays(start, end, hol) {
    const s = D(start);
    const e = D(end);
    if (s == null || e == null) return 0;
    let n = 0;
    for (let d = s; d <= e; d++) if (E.isWorkday(d, hol)) n++;
    return n;
  }

  function span(tasks) {
    let a = Infinity;
    let b = -Infinity;
    for (const t of tasks) {
      const s = D(t.start);
      const e = D(t.end);
      if (s != null) a = Math.min(a, s);
      if (e != null) b = Math.max(b, e);
    }
    return { start: isFinite(a) ? a : null, end: isFinite(b) ? b : null };
  }

  /** "已完成 n / total" */
  function doneCount(tasks) {
    return { done: tasks.filter((t) => t.done).length, total: tasks.length };
  }

  /** Monday of the week containing day. */
  function weekStart(day) {
    const w = E.weekday(day);
    return day - ((w + 6) % 7);
  }

  /**
   * Department load for each workday in [from, to] (weekends and settings.holidays skipped).
   * busy       = active employees with at least one task on that day (counted once however many tasks)
   * unassigned = PFAMs with a task on that day that has no active assignee (each such PFAM needs at least one person)
   * alert      = demand reaches the headcount ("full") or busy share reaches alertPct ("pct")
   */
  /** Active people who count as manpower: active and not named in settings.notCounted (e.g. the manager). */
  function workforce(data) {
    const skip = new Set(
      String((data.settings && data.settings.notCounted) || "")
        .split(/[,，、;]+/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    );
    return data.employees.filter((e) => {
      const n = String(e.name || "").trim().toLowerCase();
      return e.active && !skip.has(n) && !skip.has(n.split(/[\s(（]/)[0]);
    });
  }

  function load(data, from, to, opts) {
    opts = opts || {};
    const today = opts.today;
    const active = workforce(data);
    const activeIds = new Set(active.map((e) => e.id));
    const head = active.length;
    const pfamOk = opts.pfamIds || (opts.projectIds ? new Set(data.pfams.filter((f) => opts.projectIds.has(f.projectId)).map((f) => f.id)) : null);
    const tasks = data.tasks.filter((t) => t.start && t.end && (!pfamOk || pfamOk.has(t.pfamId)));
    const mode = (data.settings && data.settings.alertMode) || "full";
    const pct = Number((data.settings && data.settings.alertPct) || 90);
    const hol = holidays(data);
    const days = [];
    for (let d = from; d <= to; d++) {
      if (!E.isWorkday(d, hol)) continue;
      const busy = new Map(); // empId -> [task]
      const unassigned = new Map(); // pfamId -> [task]
      for (const t of tasks) {
        if (!occupies(t, d, today)) continue;
        const who = t.assignees.filter((id) => activeIds.has(id));
        if (!who.length) {
          if (!unassigned.has(t.pfamId)) unassigned.set(t.pfamId, []);
          unassigned.get(t.pfamId).push(t);
        }
        for (const id of who) {
          if (!busy.has(id)) busy.set(id, []);
          busy.get(id).push(t);
        }
      }
      const demand = busy.size + unassigned.size;
      const alert = head > 0 && (mode === "pct" ? (busy.size / head) * 100 >= pct : demand >= head);
      days.push({ day: d, busy, unassigned, head, demand, alert, idle: active.filter((e) => !busy.has(e.id)) });
    }
    return days;
  }

  /** Inclusive calendar days of [s, e] that fall in [a, b]. */
  function overlapDays(s, e, a, b) {
    const lo = Math.max(s, a);
    const hi = Math.min(e, b);
    return hi >= lo ? hi - lo + 1 : 0;
  }

  /** Calendar days of a trip inside a calendar year (a trip across New Year is split). */
  function tripDaysInYear(trip, year) {
    const s = D(trip.start);
    const e = D(trip.end) ?? s;
    if (s == null) return 0;
    return overlapDays(s, e, E.toDay(`${year}-01-01`), E.toDay(`${year}-12-31`));
  }

  /** Per employee: { total, byLocation: Map } for one year. */
  function tripStats(data, year) {
    const out = new Map();
    for (const tr of data.trips) {
      const n = tripDaysInYear(tr, year);
      if (!n) continue;
      if (!out.has(tr.empId)) out.set(tr.empId, { total: 0, count: 0, byLocation: new Map(), byProject: new Map() });
      const s = out.get(tr.empId);
      s.total += n;
      s.count++;
      const loc = (tr.location || "其他").trim() || "其他";
      s.byLocation.set(loc, (s.byLocation.get(loc) || 0) + n);
      const pid = tr.projectId || ""; // "" = no project linked
      s.byProject.set(pid, (s.byProject.get(pid) || 0) + n);
    }
    return out;
  }

  /**
   * Concurrent PFAMs per workday (holidays skipped) in [from, to]: a PFAM counts once when any of its tasks runs that day; in a
   * catch-all PFAM (opts.isOthers(pfam), i.e. "Others") every task counts as one PFAM of its own.
   * opts: { today, projectIds (Set, optional), pfamIds (Set, optional), isOthers(pfam) }
   * -> [{ day, units: Map(key -> { pfam, projectId, tasks, others }), total }]
   */
  function pfamLoad(data, from, to, opts) {
    opts = opts || {};
    const pf = new Map(data.pfams.map((f) => [f.id, f]));
    const tasks = data.tasks.filter(
      (t) => t.start && t.end && pf.has(t.pfamId) && (!opts.projectIds || opts.projectIds.has(pf.get(t.pfamId).projectId)) && (!opts.pfamIds || opts.pfamIds.has(t.pfamId))
    );
    const hol = holidays(data);
    const days = [];
    for (let d = from; d <= to; d++) {
      if (!E.isWorkday(d, hol)) continue;
      const units = new Map();
      for (const t of tasks) {
        if (!occupies(t, d, opts.today)) continue;
        const f = pf.get(t.pfamId);
        const others = !!(opts.isOthers && opts.isOthers(f));
        const key = others ? "t:" + t.id : f.id;
        if (!units.has(key)) units.set(key, { pfam: f, projectId: f.projectId, tasks: [], others });
        units.get(key).tasks.push(t);
      }
      days.push({ day: d, units, total: units.size });
    }
    return days;
  }

  return { STATUS, status, occupies, holidays, workdays, span, doneCount, weekStart, workforce, load, pfamLoad, overlapDays, tripDaysInYear, tripStats };
});
