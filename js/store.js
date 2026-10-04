/*
 * App state: the dataset, its local copy (localStorage), undo/redo, edit mode and cloud bookkeeping.
 * Every change goes through Store.commit(fn) so it is saved, undoable and marked for cloud sync.
 */
(function () {
  const LS_DATA = "llt800.data.v1";
  const LS_META = "llt800.meta.v1";
  const LS_UI = "llt800.ui.v1";
  const SS_EDIT = "llt800.edit";
  const UNDO_MAX = 40;

  const read = (k, fb) => {
    try {
      const v = localStorage.getItem(k);
      return v ? JSON.parse(v) : fb;
    } catch {
      return fb;
    }
  };
  const write = (k, v) => {
    try {
      localStorage.setItem(k, JSON.stringify(v));
      return true;
    } catch {
      return false;
    }
  };

  const listeners = new Set();
  const undo = [];
  const redo = [];

  const Store = {
    data: null,
    meta: { cloudVersion: 0, dirty: false, cloudAt: "" },
    ui: {},
    editing: false,

    init() {
      const saved = read(LS_DATA, null);
      this.data = Convert.normalize(saved || JSON.parse(JSON.stringify(window.LLT_SEED || Convert.emptyData())));
      this.meta = Object.assign(this.meta, read(LS_META, {}));
      this.ui = Object.assign({ zoom: "week", year: new Date().getFullYear(), showArchived: false }, read(LS_UI, {}));
      try {
        this.editing = sessionStorage.getItem(SS_EDIT) === "1";
      } catch {
        this.editing = false;
      }
    },

    on(fn) {
      listeners.add(fn);
    },
    emit(what) {
      for (const fn of listeners) fn(what || "data");
    },

    save() {
      if (!write(LS_DATA, this.data)) window.App && App.toast("瀏覽器儲存空間不足，修改沒有存到本機。請匯出 JSON 備份。", "error");
      write(LS_META, this.meta);
    },

    /** Apply a change: fn(data) mutates the dataset. */
    commit(fn, opts) {
      const before = JSON.stringify(this.data);
      const res = fn(this.data);
      Convert.ensureOthers(this.data); // new projects get their "Others" PFAM
      if (JSON.stringify(this.data) === before) return res;
      undo.push(before);
      if (undo.length > UNDO_MAX) undo.shift();
      redo.length = 0;
      this.meta.dirty = true;
      this.save();
      if (!(opts && opts.silent)) this.emit("data");
      return res;
    },

    undo() {
      if (!undo.length) return false;
      redo.push(JSON.stringify(this.data));
      this.data = Convert.normalize(JSON.parse(undo.pop()));
      this.meta.dirty = true;
      this.save();
      this.emit("data");
      return true;
    },
    redo() {
      if (!redo.length) return false;
      undo.push(JSON.stringify(this.data));
      this.data = Convert.normalize(JSON.parse(redo.pop()));
      this.meta.dirty = true;
      this.save();
      this.emit("data");
      return true;
    },
    get canUndo() {
      return undo.length > 0;
    },
    get canRedo() {
      return redo.length > 0;
    },

    /** Replace everything (cloud load, JSON restore). keepUndo lets the user step back from an import. */
    replace(data, opts) {
      opts = opts || {};
      if (opts.keepUndo) {
        undo.push(JSON.stringify(this.data));
        redo.length = 0;
      } else {
        undo.length = 0;
        redo.length = 0;
      }
      this.data = Convert.normalize(data);
      if (opts.cloudVersion != null) this.meta.cloudVersion = opts.cloudVersion;
      this.meta.dirty = !!opts.dirty;
      if (opts.cloudAt) this.meta.cloudAt = opts.cloudAt;
      this.save();
      this.emit("data");
    },

    setUi(patch) {
      Object.assign(this.ui, patch);
      write(LS_UI, this.ui);
    },

    setEditing(on) {
      this.editing = on;
      try {
        sessionStorage.setItem(SS_EDIT, on ? "1" : "0");
      } catch {
        /* session only */
      }
      this.emit("edit");
    },

    // ---------------------------------------------------------------- lookups
    project(id) {
      return this.data.projects.find((p) => p.id === id) || null;
    },
    pfam(id) {
      return this.data.pfams.find((p) => p.id === id) || null;
    },
    task(id) {
      return this.data.tasks.find((t) => t.id === id) || null;
    },
    emp(id) {
      return this.data.employees.find((e) => e.id === id) || null;
    },
    empName(id) {
      const e = this.emp(id);
      return e ? e.name : "(已刪除)";
    },
    /**
     * A project's PFAMs by the start of their first task (PFAMs without dated tasks after those, in list order);
     * the built-in "Others" always last.
     */
    pfamsOf(projectId) {
      const list = this.data.pfams.filter((f) => f.projectId === projectId);
      const first = new Map(list.map((f) => [f.id, "9999"]));
      for (const t of this.data.tasks) if (first.has(t.pfamId) && t.start && t.start < first.get(t.pfamId)) first.set(t.pfamId, t.start);
      const idx = new Map(list.map((f, i) => [f.id, i]));
      const byStart = (a, b) => (first.get(a.id) < first.get(b.id) ? -1 : first.get(a.id) > first.get(b.id) ? 1 : idx.get(a.id) - idx.get(b.id));
      return list.filter((f) => !Convert.isOthers(f)).sort(byStart).concat(list.filter(Convert.isOthers));
    },
    /**
     * A PFAM's tasks in display order: by start date (then end date, then the Phase order in the settings).
     * Tasks of one section stay together; sections follow their earliest task. Tasks without dates go last.
     */
    tasksOf(pfamId) {
      const ph = new Map(this.data.settings.phases.map((p, i) => [p.key, i]));
      const ts = this.data.tasks.filter((t) => t.pfamId === pfamId);
      const first = new Map(); // section -> earliest start
      for (const t of ts) {
        const k = t.section || "";
        const v = t.start || "9999";
        if (!first.has(k) || v < first.get(k)) first.set(k, v);
      }
      const idx = new Map(ts.map((t, i) => [t, i]));
      const key = (t) => [first.get(t.section || ""), t.section || "", t.start || "9999", t.end || "9999"];
      return ts.sort((a, b) => {
        const ka = key(a);
        const kb = key(b);
        for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
        return (ph.has(a.phase) ? ph.get(a.phase) : 99) - (ph.has(b.phase) ? ph.get(b.phase) : 99) || idx.get(a) - idx.get(b);
      });
    },
    tasksOfProject(projectId) {
      const ids = new Set(this.pfamsOf(projectId).map((f) => f.id));
      return this.data.tasks.filter((t) => ids.has(t.pfamId));
    },
    projectOfTask(t) {
      const f = this.pfam(t.pfamId);
      return f ? this.project(f.projectId) : null;
    },
    phase(key) {
      return this.data.settings.phases.find((p) => p.key === key) || null;
    },
    activeEmployees() {
      return this.data.employees.filter((e) => e.active);
    },
    /** Active people who count as manpower (settings › 不計入人力的人員 left out, e.g. the manager). */
    workforce() {
      return Model.workforce(this.data);
    },
    /** All projects in list order, with a catch-all project ("Others" / "其他") moved to the end. */
    projects() {
      const last = (p) => (/^(others?|其他|其它)$/i.test((p.name || "").trim()) ? 1 : 0);
      return this.data.projects.map((p, i) => [p, i]).sort((a, b) => last(a[0]) - last(b[0]) || a[1] - b[1]).map((x) => x[0]);
    },
    /** Projects not archived, in list order. */
    liveProjects() {
      return this.projects().filter((p) => p.status !== "archived");
    },
    /**
     * Site / trip location -> color. The settings' site list comes first (its order picks the color), then any
     * other site or location in the data, alphabetically, so a site has the same color on every page.
     */
    siteColors() {
      const order = [...this.data.settings.sites];
      const extra = new Set();
      for (const f of this.data.pfams) if (f.site && !order.includes(f.site)) extra.add(f.site);
      for (const r of this.data.trips) {
        const l = (r.location || "其他").trim() || "其他";
        if (!order.includes(l)) extra.add(l);
      }
      order.push(...[...extra].sort());
      const P = Convert.PALETTE;
      return new Map(order.map((l, i) => [l, i < P.length ? P[i] : "#8a8f98"]));
    },
    /** A PFAM's site as a colored tag ("" when it has none). */
    siteTag(site, colors) {
      if (!site) return "";
      const c = (colors || this.siteColors()).get(site) || "#8a8f98";
      return `<span class="tag site" style="--c:${c}">${U.esc(site)}</span>`;
    },
  };

  window.Store = Store;
})();
