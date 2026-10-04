/*
 * Data conversion and import planning. Pure functions over plain data objects, so the same code
 * runs in the browser (window.Convert) and in Node (tools/build_seed.js, tools/test_core.js).
 *
 * Importers turn a source file into "items" (one per task), then plan() compares them with the
 * current data and apply() writes the result:
 *   - MONICA JSON   : Series -> Project, project -> PFAM, Phase -> task phase (task name = phase label if blank)
 *   - Gen12 Excel   : sheets grouped like the Gen12 dashboard (1st + 2nd build merged) -> PFAMs of the chosen
 *                     project (default Gen12 AMD); tasks pre-ticked when LEAD has STE or TE, the user picks the rest
 * Re-imports match tasks by task.src.key: dates are updated (old dates become the baseline),
 * while assignees, done flags and notes typed on the web are kept.
 */
(function (root, factory) {
  const api = factory(root.Engine || (typeof require === "function" ? require("./engine.js") : null));
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Convert = api;
})(typeof self !== "undefined" ? self : this, function (E) {
  const PALETTE = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];
  // MONICA's current phase keys (export 2026-10-04). Older MONICA files used other keys for the same
  // phases (three racks + volume build); those are kept as aliases so either file lands on the same phase.
  const PHASE_RENAMES = [
    ["1stscriptrack", { key: "DevelopmentTNRS", label: "1st rack (DEV)" }],
    ["2ndvalidationrack", { key: "PreGolden", label: "2nd rack (VLD)" }],
    ["3rdFPYrack", { key: "GoldenFPY", label: "3rd rack (FPY)" }],
    ["Volume", { key: "VB", label: "VB" }],
  ];
  const DEFAULT_PHASES = [
    { key: "DevelopmentTNRS", label: "1st rack (DEV)", color: "#2a78d6", aliases: ["1stscriptrack"] },
    { key: "PreGolden", label: "2nd rack (VLD)", color: "#4a3aa7", aliases: ["2ndvalidationrack"] },
    { key: "GoldenFPY", label: "3rd rack (FPY)", color: "#1baf7a", aliases: ["3rdFPYrack"] },
    { key: "BSL", label: "BSL", color: "#eda100" },
    { key: "VB", label: "VB", color: "#e87ba4", aliases: ["Volume"] },
  ];
  const DEFAULT_SITES = ["MX", "LZ", "MY", "CZ", "TN", "HQ"];

  let seq = 0;
  function uid(prefix) {
    seq = (seq + 1) % 1296;
    return prefix + Date.now().toString(36) + seq.toString(36).padStart(2, "0") + Math.random().toString(36).slice(2, 5);
  }
  const clean = (s) => String(s == null ? "" : s).trim();
  const normName = (s) => clean(s).toLowerCase().replace(/\s+/g, " ");

  function emptyData() {
    return {
      schema: 1,
      settings: {
        title: "LLT800 Dashboard",
        phases: DEFAULT_PHASES.map((p) => ({ ...p, aliases: [...(p.aliases || [])] })),
        sites: DEFAULT_SITES.slice(),
        alertMode: "full", // "full": busy + unassigned PFAMs >= headcount; "pct": busy / headcount >= alertPct
        alertPct: 90,
        notCounted: "Dixon", // names left out of manpower counts (busy / headcount, 人力熱度, PFAM limit)
        editHash: "",
        gen12Roles: "STE, TE",
      },
      projects: [],
      pfams: [],
      tasks: [],
      employees: [],
      trips: [],
      importIgnored: { gen12: [], monica: [] },
    };
  }

  /** Fill in anything an older or hand-made dataset is missing. */
  function normalize(d) {
    const base = emptyData();
    const out = { ...base, ...d, settings: { ...base.settings, ...(d && d.settings) } };
    for (const k of ["projects", "pfams", "tasks", "employees", "trips"]) out[k] = Array.isArray(out[k]) ? out[k] : [];
    out.importIgnored = { gen12: [], monica: [], ...(d && d.importIgnored) };
    for (const t of out.tasks) {
      t.assignees = Array.isArray(t.assignees) ? t.assignees : [];
      // Tasks are just done / not done (older data had a progress %).
      t.done = t.done != null ? t.done === true || t.done === "true" : (Number(t.pct) || 0) >= 100;
      delete t.pct;
    }
    for (const e of out.employees) if (e.active === undefined) e.active = true;
    for (const p of out.projects) {
      p.pfamCap = Math.max(0, Math.floor(Number(p.pfamCap) || 0)); // 專案甘特 PFAM 負載警戒上限 (0 = none)
      p.link = /^https?:\/\/\S+$/i.test(String(p.link || "").trim()) ? String(p.link).trim() : ""; // 外部系統連結 (http/https only)
      p.linkName = String(p.linkName || "").trim(); // its button label ("" = 開啟 <project> 系統)
    }
    migratePhases(out);
    // Colors go straight into style attributes: keep only #rgb / #rrggbb (anything else gets a palette color).
    const HEX = /^#[0-9a-f]{3}([0-9a-f]{3})?$/i;
    out.projects.forEach((p, i) => { if (!HEX.test(p.color || "")) p.color = PALETTE[i % PALETTE.length]; });
    out.settings.phases.forEach((p, i) => { if (!HEX.test(p.color || "")) p.color = PALETTE[i % PALETTE.length]; });
    ensureOthers(out);
    return out;
  }

  /** Color for a new project: the first palette color no project uses yet (then cycle). */
  function projectColor(data) {
    const used = new Set(data.projects.map((p) => (p.color || "").toLowerCase()));
    return PALETTE.find((c) => !used.has(c)) || PALETTE[data.projects.length % PALETTE.length];
  }

  // Every project has a built-in "Others" PFAM (catch-all for work outside the regular PFAMs). It is always
  // listed in the project Gantt, sorts last and cannot be deleted. A PFAM already called "Others" counts as it.
  const OTHERS = "Others";
  const isOthers = (f) => !!f && ((f.src && f.src.kind === "builtin") || normName(f.name) === "others");
  /** Add the missing "Others" PFAMs (id derived from the project, so every browser creates the same one). */
  function ensureOthers(data) {
    const has = new Set(data.pfams.filter(isOthers).map((f) => f.projectId));
    let n = 0;
    for (const p of data.projects) {
      if (has.has(p.id)) continue;
      data.pfams.push({ id: "fo_" + p.id, projectId: p.id, name: OTHERS, site: "", notes: "", src: { kind: "builtin", key: "others" } });
      n++;
    }
    return n;
  }

  /** Old MONICA rack phases -> the current keys: merged into the new phase if both exist, else renamed. */
  function migratePhases(d) {
    const ph = (d.settings.phases = (d.settings.phases || []).map((p) => ({ ...p, aliases: Array.isArray(p.aliases) ? p.aliases : [] })));
    for (const [oldKey, to] of PHASE_RENAMES) {
      const old = ph.find((p) => p.key === oldKey);
      if (!old) continue;
      if (ph.some((p) => p.key === to.key)) mergePhase(d, oldKey, to.key);
      else {
        for (const t of d.tasks) if (t.phase === oldKey) t.phase = to.key;
        old.aliases = [...new Set([...old.aliases, oldKey])];
        old.key = to.key;
        old.label = to.label;
      }
    }
  }

  /**
   * Remove the projects the first Gen12 import created on its own ("Gen12 AMD Pilot", src.kind gen12): their
   * imported tasks, then their imported PFAMs / the project once empty. Hand-made rows are kept, and Gen12 tasks
   * imported into other projects (e.g. Gen12 AMD) are never touched. Returns { tasks, pfams, projects }.
   */
  function removeGen12(data) {
    const g = (x) => x && x.src && x.src.kind === "gen12";
    const auto = new Set(data.projects.filter(g).map((p) => p.id));
    const autoPf = new Set(data.pfams.filter((f) => auto.has(f.projectId)).map((f) => f.id));
    const before = { tasks: data.tasks.length, pfams: data.pfams.length, projects: data.projects.length };
    data.tasks = data.tasks.filter((t) => !(g(t) && autoPf.has(t.pfamId)));
    const used = new Set(data.tasks.map((t) => t.pfamId));
    data.pfams = data.pfams.filter((f) => !((g(f) || isOthers(f)) && autoPf.has(f.id)) || used.has(f.id));
    const usedP = new Set(data.pfams.map((f) => f.projectId));
    const gone = new Set(data.projects.filter((p) => g(p) && !usedP.has(p.id)).map((p) => p.id));
    data.projects = data.projects.filter((p) => !gone.has(p.id));
    for (const tr of data.trips) if (gone.has(tr.projectId)) tr.projectId = "";
    return { tasks: before.tasks - data.tasks.length, pfams: before.pfams - data.pfams.length, projects: before.projects - data.projects.length };
  }

  /** Mark every unfinished task that ended before cutoff (yyyy-mm-dd, exclusive) as done. Returns how many. */
  function markDoneBefore(data, cutoff) {
    let n = 0;
    for (const t of data.tasks)
      if (!t.done && t.end && t.end < cutoff) {
        t.done = true;
        n++;
      }
    return n;
  }

  /** Phase key (or an alias of one) -> the key of the phase in the settings; "" when unknown. */
  function resolvePhase(data, key) {
    if (!key) return "";
    const p = data.settings.phases.find((x) => x.key === key) || data.settings.phases.find((x) => (x.aliases || []).includes(key));
    return p ? p.key : "";
  }

  /** Merge phase fromKey into toKey: tasks are re-tagged, fromKey (and its aliases) become aliases of toKey. */
  function mergePhase(data, fromKey, toKey) {
    const ph = data.settings.phases;
    const from = ph.find((p) => p.key === fromKey);
    const to = ph.find((p) => p.key === toKey);
    if (!from || !to || from === to) return 0;
    let n = 0;
    for (const t of data.tasks)
      if (t.phase === fromKey) {
        t.phase = toKey;
        n++;
      }
    to.aliases = [...new Set([...(to.aliases || []), fromKey, ...(from.aliases || [])])];
    // The merged phase takes the earlier of the two places in the list.
    const at = Math.min(ph.indexOf(from), ph.indexOf(to));
    const rest = ph.filter((p) => p !== from && p !== to);
    rest.splice(at, 0, to);
    data.settings.phases = rest;
    return n;
  }

  /** "Amy / Ben, Cindy" -> ["Amy", "Ben", "Cindy"] */
  function splitNames(s) {
    return clean(s)
      .split(/[\/\\,，、&;]+/)
      .map((x) => x.trim())
      .filter(Boolean);
  }

  /** Does a LEAD cell ("STE, TE" / "PD, NPI, QA, IE, TE") contain one of the roles (whole tokens)? */
  function leadMatches(lead, roles) {
    if (!lead || !roles.length) return false;
    const toks = String(lead).toUpperCase().split(/[,\/、;&+\s]+/).filter(Boolean);
    return roles.some((r) => toks.includes(r));
  }

  function parseRoles(text) {
    return String(text || "")
      .split(/[,\/、;\s]+/)
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
  }

  // ------------------------------------------------------------------ MONICA JSON
  /** MONICA export -> { items, phases }  (phases = the file's phase list, to add missing ones) */
  function monicaItems(json) {
    if (!json || !Array.isArray(json.tasks)) throw new Error("不是 MONICA 匯出的 JSON（缺少 tasks 陣列）");
    const labels = json.labels || {};
    const phases = (labels.phaseList || []).map((p) => ({ key: p.key, label: p.label || p.key, color: p.color }));
    const phaseLabel = new Map(phases.map((p) => [p.key, p.label]));
    const items = [];
    const seen = new Map();
    for (const r of json.tasks) {
      const series = clean(r.category) || "未分類";
      const pfam = clean(r.project);
      if (!pfam || !r.start || !r.end) continue;
      const type = clean(r.type);
      const name = clean(r.task) || phaseLabel.get(type) || type || "(未命名)";
      let key = ["monica", normName(series), normName(pfam), type, normName(r.task)].join("|");
      // The same row twice in one file: keep both, numbered.
      const n = (seen.get(key) || 0) + 1;
      seen.set(key, n);
      if (n > 1) key += "#" + n;
      items.push({
        projKey: "monica|" + normName(series),
        projName: series,
        pfamKey: "monica|" + normName(series) + "|" + normName(pfam),
        pfamName: pfam,
        site: clean(r.site),
        srcKey: key,
        name,
        phase: type,
        section: "",
        lead: "",
        start: r.start,
        end: r.end,
        done: false,
        notes: "",
        assignNames: splitNames(r.pic),
        defaultOn: true,
      });
    }
    return { items, phases, title: json.title || "" };
  }

  // ------------------------------------------------------------------ Gen12 Excel
  // Sheet classification and 1st/2nd grouping, same rules as Gen12AMD_Pilot_gantt (js/util.js tags, js/groups.js).
  function tags(p) {
    const s = p.sheet;
    const gen = (s.match(/^(1\d\.\d)/) || (p.title || "").match(/GEN\s*(1\d\.\d)/i) || [])[1] || "其他";
    let site = (s.match(/(?:^|_)(LZ|MX)(?=[_( ]|$)/) || [])[1];
    if (!site) site = /MX/i.test(p.site) ? "MX" : /LZ/i.test(p.site) ? "LZ" : "";
    const phase = /pre\s*ga/i.test(s) ? "Pre GA" : /1st/i.test(s) ? "1st" : /2nd/i.test(s) ? "2nd" : "其他";
    const skuTok = (s.match(/_(D?[HML][HML])(?=[_( ]|$)/) || [])[1];
    const sku = skuTok ? (skuTok.startsWith("D") ? "GPD-" + skuTok.slice(1) : "GP-" + skuTok) : /lanai/i.test(s) ? "Lanai" : /DV/.test(s) ? "DV" : "";
    return { gen, site, phase, sku };
  }
  function variantOf(sheet) {
    if (/lanai/i.test(sheet)) return "Lanai";
    const m = sheet.match(/\((PV\d+\s*Op\d+)\)/i);
    return m ? m[1].replace(/\s+/, " ").replace(/op/i, "Op") : "";
  }
  const BUILD_ORDER = { "1st": 1, "2nd": 2 };
  function autoKey(p) {
    const t = tags(p);
    if (!BUILD_ORDER[t.phase] || !t.sku) return null;
    return [t.gen, t.sku, variantOf(p.sheet)].join("|");
  }
  function soloName(p) {
    const t = tags(p);
    if (!t.sku || t.phase === "其他") return p.sheet;
    const v = variantOf(p.sheet);
    return `Gen ${t.gen} ${t.sku}${v ? " · " + v : ""} · ${t.phase}`;
  }

  /** Gen12 dataset (Importer.convert output or Gen12 seed) -> PFAM groups: [{key, name, site, members:[{p, build}]}] */
  function gen12Groups(ds) {
    const visible = ds.pfams.filter((p) => !p.hidden);
    const byKey = new Map();
    for (const p of visible) {
      const k = autoKey(p);
      if (!k) continue;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(p);
    }
    const groupOf = new Map();
    for (const [k, list] of byKey) {
      const seen = new Set();
      const members = [];
      for (const p of list) {
        const b = tags(p).phase;
        if (seen.has(b)) continue; // one sheet per build; extras stay standalone
        seen.add(b);
        members.push({ p, build: b });
      }
      if (members.length < 2) continue;
      members.sort((a, b) => BUILD_ORDER[a.build] - BUILD_ORDER[b.build]);
      const [gen, sku, variant] = k.split("|");
      const g = { key: "gen12|" + k, name: `Gen ${gen} ${sku}${variant ? " · " + variant : ""}`, members };
      for (const m of members) groupOf.set(m.p, g);
    }
    const out = [];
    const done = new Set();
    for (const p of visible) {
      const g = groupOf.get(p);
      if (g) {
        if (!done.has(g)) {
          done.add(g);
          out.push(g);
        }
      } else out.push({ key: "gen12|sheet|" + p.xlSheet, name: soloName(p), members: [{ p, build: tags(p).phase }] });
    }
    for (const g of out) g.site = tags(g.members[0].p).site;
    return out;
  }

  /**
   * Gen12 dataset -> { items, noDate } for one target project.
   * In 2nd builds every section except the volume build was copied from the 1st build ("same as 1st"):
   * those tasks are listed but never pre-selected, so the same work is not counted twice.
   */
  function gen12Items(ds, opts) {
    if (!E) throw new Error("engine.js is required for the Gen12 import");
    const roles = parseRoles(opts.roles);
    const items = [];
    let noDate = 0;
    for (const g of gen12Groups(ds)) {
      g.members.forEach((m, mi) => {
        const p = m.p;
        const s = E.schedule(p, ds.calendars);
        const wbs = E.wbsMap(p);
        let section = "";
        let inherited = false;
        for (const t of p.tasks) {
          if (t.type === "section") {
            section = t.name;
            inherited = mi > 0 && !/volume/i.test(t.name);
            continue;
          }
          const r = s.rows.get(t.id) || {};
          if (r.start == null || r.end == null) {
            noDate++;
            continue;
          }
          const sheet = p.xlSheet || p.sheet;
          items.push({
            projKey: opts.projKey,
            projName: opts.projName,
            pfamKey: g.key,
            pfamName: g.name,
            site: g.site,
            srcKey: `gen12|${sheet}|${wbs.get(t.id)}|${normName(t.name)}`,
            altKey: `gen12|${sheet}|${normName(t.name)}`,
            name: t.name,
            phase: "",
            section: (g.members.length > 1 ? m.build + " · " : "") + section,
            lead: t.lead || "",
            start: E.fromDay(r.start),
            end: E.fromDay(r.end),
            done: (Number(t.pct) || 0) >= 100,
            notes: t.notes || "",
            assignNames: [],
            roleMatch: leadMatches(t.lead, roles),
            inherited,
            defaultOn: leadMatches(t.lead, roles) && !inherited,
            sheet,
            build: m.build,
          });
        }
      });
    }
    return { items, noDate };
  }

  // ------------------------------------------------------------------ plan / apply
  /**
   * Compare incoming items with the data.
   * scope(task) decides which existing tasks of this source can be reported as "gone".
   * Returns { kind, rows: [{status: new|update|same, item, task?, on}], gone: [{task, on}] }
   */
  function plan(data, kind, items, opts) {
    opts = opts || {};
    const ignored = new Set((data.importIgnored || {})[kind] || []);
    const mine = data.tasks.filter((t) => t.src && t.src.kind === kind);
    const byKey = new Map(mine.map((t) => [t.src.key, t]));
    // Pass 1: exact source keys.
    const used = new Set();
    const match = items.map((item) => {
      const t = byKey.get(item.srcKey);
      if (!t || used.has(t.id)) return null;
      used.add(t.id);
      return t;
    });
    // Pass 2 (rows inserted / renumbered in the source): same sheet + name, only when that name is unique
    // among both the unmatched incoming items and the unmatched existing tasks.
    const count = (list, f) => list.reduce((m, x) => (f(x) ? m.set(f(x), (m.get(f(x)) || 0) + 1) : m), new Map());
    const altIn = count(items.filter((_, i) => !match[i]), (x) => x.altKey);
    const restTasks = mine.filter((t) => !used.has(t.id));
    const altOld = count(restTasks, (t) => t.src.alt);
    items.forEach((item, i) => {
      if (match[i] || !item.altKey || altIn.get(item.altKey) !== 1 || altOld.get(item.altKey) !== 1) return;
      const t = restTasks.find((x) => x.src.alt === item.altKey);
      used.add(t.id);
      match[i] = t;
    });
    const rows = items.map((item, i) => {
      const task = match[i];
      if (!task) return { status: "new", item, on: item.defaultOn && !ignored.has(item.srcKey) };
      used.add(task.id);
      const changed = task.start !== item.start || task.end !== item.end || task.name !== item.name || (task.lead || "") !== item.lead || (task.section || "") !== item.section;
      return { status: changed ? "update" : "same", item, task, on: true };
    });
    const inScope = opts.scope || (() => true);
    const gone = mine.filter((t) => !used.has(t.id) && inScope(t)).map((task) => ({ task, on: false })); // never deleted unless ticked
    return { kind, rows, gone };
  }

  /** Write a plan into data (mutates). Returns counts. */
  function apply(data, pl, opts) {
    opts = opts || {};
    const kind = pl.kind;
    const counts = { added: 0, updated: 0, removed: 0, projects: 0, pfams: 0, unmatched: [] };
    const empByName = new Map(data.employees.map((e) => [normName(e.name), e]));
    const resolve = (names) => {
      const ids = [];
      for (const n of names) {
        let e = empByName.get(normName(n));
        if (!e && opts.createEmployees) {
          e = { id: uid("e"), name: n, active: true };
          data.employees.push(e);
          empByName.set(normName(n), e);
        }
        if (e) ids.push(e.id);
        else if (!counts.unmatched.includes(n)) counts.unmatched.push(n);
      }
      return ids;
    };
    const projFor = (item) => {
      if (opts.projectId) return data.projects.find((p) => p.id === opts.projectId);
      let p = data.projects.find((x) => x.src && x.src.kind === kind && x.src.key === item.projKey) || data.projects.find((x) => normName(x.name) === normName(item.projName));
      if (!p) {
        p = { id: uid("j"), name: item.projName, color: projectColor(data), status: "active", notes: "", src: { kind, key: item.projKey } };
        data.projects.push(p);
        counts.projects++;
      }
      return p;
    };
    const pfamFor = (item) => {
      const proj = projFor(item);
      let f = data.pfams.find((x) => x.projectId === proj.id && x.src && x.src.kind === kind && x.src.key === item.pfamKey) || data.pfams.find((x) => x.projectId === proj.id && normName(x.name) === normName(item.pfamName));
      if (!f) {
        f = { id: uid("f"), projectId: proj.id, name: item.pfamName, site: item.site || "", notes: "", src: { kind, key: item.pfamKey } };
        data.pfams.push(f);
        counts.pfams++;
      }
      return f;
    };

    const ignored = new Set((data.importIgnored || {})[kind] || []);
    for (const r of pl.rows) {
      const it = r.item;
      if (r.status === "new") {
        if (!r.on) {
          ignored.add(it.srcKey);
          continue;
        }
        ignored.delete(it.srcKey);
        const f = pfamFor(it);
        data.tasks.push({
          id: uid("t"),
          pfamId: f.id,
          name: it.name,
          phase: resolvePhase(data, it.phase) || it.phase || "",
          section: it.section || "",
          start: it.start,
          end: it.end,
          assignees: resolve(it.assignNames || []),
          lead: it.lead || "",
          done: !!it.done,
          notes: it.notes || "",
          baseStart: "",
          baseEnd: "",
          src: { kind, key: it.srcKey, alt: it.altKey || "" },
        });
        counts.added++;
      } else if (r.status === "update") {
        const t = r.task;
        if (t.start !== it.start || t.end !== it.end) {
          t.baseStart = t.start;
          t.baseEnd = t.end;
        }
        Object.assign(t, { name: it.name, start: it.start, end: it.end, lead: it.lead || "", section: it.section || "" });
        if (it.phase) t.phase = resolvePhase(data, it.phase) || it.phase;
        t.src = { kind, key: it.srcKey, alt: it.altKey || "" };
        if (!t.assignees.length && it.assignNames && it.assignNames.length) t.assignees = resolve(it.assignNames);
        counts.updated++;
      }
    }
    const drop = new Set(pl.gone.filter((g) => g.on).map((g) => g.task.id));
    if (drop.size) {
      data.tasks = data.tasks.filter((t) => !drop.has(t.id));
      counts.removed = drop.size;
    }
    data.importIgnored = { ...(data.importIgnored || {}), [kind]: [...ignored] };
    return counts;
  }

  /** Add phases from an imported file that the settings don't have yet. */
  function mergePhases(data, phases) {
    let n = 0;
    for (const p of phases || []) {
      if (!p.key || resolvePhase(data, p.key)) continue; // known, possibly under another key (alias)
      data.settings.phases.push({ key: p.key, label: p.label || p.key, color: p.color || PALETTE[data.settings.phases.length % PALETTE.length], aliases: [] });
      n++;
    }
    return n;
  }

  return { PALETTE, emptyData, normalize, uid, splitNames, parseRoles, leadMatches, monicaItems, gen12Groups, gen12Items, plan, apply, mergePhases, mergePhase, resolvePhase, migratePhases, markDoneBefore, removeGen12, normName, isOthers, ensureOthers, OTHERS, projectColor };
});
