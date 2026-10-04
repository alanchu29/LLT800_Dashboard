/*
 * 人力資源: how many people have work on each workday (busy / headcount), who is free, and every person's
 * task timeline. Load = active employees with at least one task that day; unassigned PFAMs add demand.
 */
(function () {
  const E = window.Engine;
  const M = window.Model;
  const { esc, fmt, $ } = U;
  const D = (iso) => (iso ? E.toDay(iso) : null);

  const PRESETS = [
    ["m2p3", "前 2 週 + 後 3 月", (t) => [t - 14, t + 91]], // same default window as 專案甘特
    ["p6", "未來 6 個月", (t) => [t, t + 183]],
    ["year", "今年", (t) => {
      const y = E.fromDay(t).slice(0, 4);
      return [E.toDay(`${y}-01-01`), E.toDay(`${y}-12-31`)];
    }],
  ];

  function range(today) {
    const ui = Store.ui;
    if (ui.loadPreset === "custom" && ui.loadFrom && ui.loadTo && ui.loadTo >= ui.loadFrom) return [D(ui.loadFrom), D(ui.loadTo)];
    const p = PRESETS.find((x) => x[0] === ui.loadPreset) || PRESETS[0];
    return p[2](today);
  }

  /** Lanes so overlapping tasks of one person don't hide each other. */
  function lanes(tasks) {
    const out = [];
    for (const t of [...tasks].sort((a, b) => a.start.localeCompare(b.start))) {
      const s = D(t.start);
      let lane = out.find((l) => l.end < s);
      if (!lane) out.push((lane = { end: -Infinity, tasks: [] }));
      lane.tasks.push(t);
      lane.end = D(t.end);
    }
    return out;
  }

  function render(root) {
    const data = Store.data;
    const ui = Store.ui;
    const today = U.today();
    const [from, to] = range(today);
    const projects = Store.liveProjects();
    const sel = ui.loadProjects && ui.loadProjects.length ? new Set(ui.loadProjects.filter((id) => Store.project(id))) : new Set(projects.map((p) => p.id));
    const days = M.load(data, from, to, { today, projectIds: sel });
    const alerts = days.filter((d) => d.alert);
    const peak = days.reduce((m, d) => (!m || d.demand > m.demand ? d : m), null);
    const avg = days.length ? days.reduce((n, d) => n + d.busy.size, 0) / days.length : 0;
    const pinned = ui.loadPin != null && ui.loadPin >= from && ui.loadPin <= to ? ui.loadPin : null;
    const s = data.settings;
    const rule = s.alertMode === "pct" ? `忙碌人數 ≥ 在職人數的 ${s.alertPct}%` : "忙碌人數 + 未指派 PFAM ≥ 在職人數（沒有人空著）";

    root.innerHTML = `
      <div class="page-head"><h2>人力資源</h2><span class="muted">每天有 task 在身上的人數（一人同時多件只算 1 人，只算工作日）</span></div>
      <div class="toolbar wrap">
        <div class="seg" role="group" aria-label="期間">${PRESETS.map(([k, l]) => `<button type="button" data-preset="${k}" class="${(PRESETS.some((x) => x[0] === ui.loadPreset) ? ui.loadPreset : ui.loadPreset === "custom" ? "" : "m2p3") === k ? "on" : ""}">${l}</button>`).join("")}</div>
        <label class="field-inline">從 <input type="date" id="lFrom" value="${E.fromDay(from)}"></label>
        <label class="field-inline">到 <input type="date" id="lTo" value="${E.fromDay(to)}"></label>
        <span class="grow"></span>
        <span class="muted small">標紅規則：${esc(rule)}　<a class="link" href="#/settings">修改</a></span>
      </div>
      <div class="chips" id="lProj" aria-label="計入的專案">
        <span class="muted small">計入專案：</span>
        ${projects.map((p) => `<button type="button" class="chip${sel.has(p.id) ? " on" : ""}" data-p="${p.id}" style="--c:${p.color}"><i class="dot"></i>${esc(p.name)}</button>`).join("")}
        <button class="link" type="button" id="lAll">全選</button>
      </div>
      <section class="kpis small">
        <div class="kpi ${alerts.length ? "bad" : "good"}"><span class="kpi-l">超出人力的工作天</span><span class="kpi-v">${alerts.length}<small> / ${days.length} 天</small></span><span class="kpi-s">${alerts.length ? `最早 ${fmt(alerts.find((d) => d.day >= today)?.day ?? alerts[0].day, "wd")}` : "期間內人力足夠"}</span></div>
        <div class="kpi"><span class="kpi-l">平均忙碌人數</span><span class="kpi-v">${avg.toFixed(1)}<small> / ${days[0] ? days[0].head : 0}</small></span><span class="kpi-s">期間內工作日平均</span></div>
        <div class="kpi"><span class="kpi-l">最忙的一天</span><span class="kpi-v">${peak ? peak.busy.size : 0}${peak && peak.unassigned.size ? `<small>+${peak.unassigned.size}</small>` : ""}</span><span class="kpi-s">${peak ? fmt(peak.day, "full") : "—"}</span></div>
      </section>
      <section class="card"><header class="card-h"><h3>每日忙碌人數</h3><span class="muted">點一下柱子標記該日，下方顯示誰忙誰空</span></header>
        <div id="lChart" class="lc-box"></div>
        <div class="legend"><span class="lg"><i class="lg-busy"></i>忙碌人數</span><span class="lg"><i class="lg-unas"></i>未指派 PFAM（各需 1 人）</span><span class="lg"><i class="lg-head"></i>在職人數</span><span class="lg lg-alert">⚠ 超出部門人力</span></div>
      </section>
      <div id="lPin"></div>
      <section class="card"><header class="card-h"><h3>每人工作</h3><span class="muted">目前任務（PFAM › task，依結束日）與下一個 task・只算上方勾選的專案・點 task 到專案甘特</span></header><div id="lWork"></div></section>
      <section class="card"><header class="card-h"><h3>每人時間軸</h3><span class="muted">顏色 = 專案・紅色底線 = 超出人力的日子</span></header><div id="lPeople"></div></section>`;

    root.querySelectorAll("[data-preset]").forEach((b) => (b.onclick = () => (Store.setUi({ loadPreset: b.dataset.preset }), App.render())));
    const setCustom = () => {
      const a = $("#lFrom").value;
      const b = $("#lTo").value;
      if (a && b && b >= a) {
        Store.setUi({ loadPreset: "custom", loadFrom: a, loadTo: b });
        App.render();
      }
    };
    $("#lFrom").onchange = setCustom;
    $("#lTo").onchange = setCustom;
    $("#lProj").onclick = (ev) => {
      const b = ev.target.closest("[data-p]");
      if (ev.target.id === "lAll") return Store.setUi({ loadProjects: [] }), App.render();
      if (!b) return;
      const next = new Set(sel);
      if (next.has(b.dataset.p)) next.delete(b.dataset.p);
      else next.add(b.dataset.p);
      if (!next.size) return App.toast("至少要計入一個專案");
      Store.setUi({ loadProjects: next.size === projects.length ? [] : [...next] });
      App.render();
    };

    Charts.loadChart($("#lChart"), days, {
      height: 240,
      today,
      pinned,
      tip: Charts.loadTip,
      onPick: (day) => {
        Store.setUi({ loadPin: ui.loadPin === day ? null : day });
        App.render();
      },
    });
    renderPin($("#lPin"), pinned != null ? days.find((d) => d.day === pinned) : null);
    renderPeople($("#lPeople"), days, sel, from, to, pinned, today, { fit: true }); // stretch to the card width
    renderWork($("#lWork"), sel, today);
  }

  /** One roster task line: project dot, "PFAM › task", and its end (current) or start (next) date. */
  function rosterTask(t, today, when) {
    const f = Store.pfam(t.pfamId);
    const p = f && Store.project(f.projectId);
    const late = M.status(t, today) === "late";
    const date = when === "end" ? (late ? `<b class="late">逾期 ${today - D(t.end)} 天</b>` : `～${fmt(t.end, "short")}（${D(t.end) === today ? "今天結束" : `剩下 ${D(t.end) - today} 天`}）`) : `${fmt(t.start, "short")} 開始（還有 ${D(t.start) - today} 天）`;
    return `<li title="${esc(`${p ? p.name + " › " : ""}${f ? f.name + " › " : ""}${t.name}`)}"><i class="dot" style="--c:${p ? p.color : "#888"}"></i><span class="rt-pf">${esc(f ? f.name : "")}</span><span class="rt-sep">›</span><span class="rt-t">${esc(t.name)}</span><small class="muted">${date}</small></li>`;
  }

  /** 每人工作: per person (manpower only) the tasks running now and the next one, in the selected projects. */
  function renderWork(el, sel, today) {
    const pfamOk = new Set(Store.data.pfams.filter((f) => sel.has(f.projectId)).map((f) => f.id));
    const emps = Store.workforce();
    if (!emps.length) {
      el.innerHTML = `<p class="empty">沒有計入人力的員工。<a href="#/settings/emps">到「設定」管理名冊</a>。</p>`;
      return;
    }
    const rows = emps
      .map((e) => {
        const mine = Store.data.tasks.filter((t) => t.assignees.includes(e.id) && pfamOk.has(t.pfamId) && t.start && t.end);
        const now = mine.filter((t) => ["active", "late"].includes(M.status(t, today))).sort((a, b) => a.end.localeCompare(b.end));
        const next = mine.filter((t) => M.status(t, today) === "future").sort((a, b) => a.start.localeCompare(b.start))[0];
        return `<tr>
          <th><a href="#/people/${e.id}">${esc(e.name)}</a></th>
          <td>${now.length ? `<ul class="rt-list">${now.map((t) => rosterTask(t, today, "end").replace("<li ", `<li data-task="${t.id}" `)).join("")}</ul>` : `<span class="muted">—</span>`}</td>
          <td>${next ? `<ul class="rt-list">${rosterTask(next, today, "start").replace("<li ", `<li data-task="${next.id}" `)}</ul>` : `<span class="muted">—</span>`}</td>
        </tr>`;
      })
      .join("");
    el.innerHTML = `<div class="table-wrap"><table class="grid-table roster work"><thead><tr><th>姓名</th><th>目前任務</th><th>下一個 task</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    el.onclick = (ev) => {
      const li = ev.target.closest("li[data-task]");
      if (!li) return;
      const t = Store.task(li.dataset.task);
      const f = t && Store.pfam(t.pfamId);
      if (!f) return;
      ProjectsView.focus(f.id, t.id);
      App.go("#/projects/" + f.projectId);
    };
  }

  function renderPin(el, d) {
    if (!d) {
      el.innerHTML = "";
      return;
    }
    const busy = [...d.busy.entries()].sort((a, b) => Store.empName(a[0]).localeCompare(Store.empName(b[0])));
    el.innerHTML = `<section class="card pin-card${d.alert ? " alert" : ""}">
      <header class="card-h"><h3>📌 ${fmt(d.day, "full")}</h3><span class="muted">忙碌 ${d.busy.size} / ${d.head} 人${d.unassigned.size ? `・未指派 ${d.unassigned.size} 個 PFAM` : ""}</span>${d.alert ? `<b class="late">⚠ 超出部門人力</b>` : ""}<button class="link" id="unpin" type="button">取消標記</button></header>
      <div class="pin-grid">
        <div><h4>空閒（${d.idle.length}）</h4>${d.idle.length ? `<div class="namecloud">${d.idle.map((e) => `<a class="pname free" href="#/people/${e.id}">${esc(e.name)}</a>`).join("")}</div>` : `<p class="muted">沒有人空著</p>`}
          ${d.unassigned.size ? `<h4>未指派</h4><ul class="plain">${[...d.unassigned.entries()].map(([fid, ts]) => `<li><b>${esc((Store.pfam(fid) || {}).name || "")}</b> <small class="muted">${esc(ts.map((t) => t.name).join("、"))}</small></li>`).join("")}</ul>` : ""}</div>
        <div><h4>忙碌（${d.busy.size}）</h4><ul class="plain">${busy.map(([id, ts]) => `<li><a href="#/people/${id}">${esc(Store.empName(id))}</a> <small class="muted">${esc(ts.map((t) => `${t.name}（${(Store.pfam(t.pfamId) || {}).name || ""}）`).join("、"))}</small></li>`).join("")}</ul></div>
      </div></section>`;
    $("#unpin").onclick = () => (Store.setUi({ loadPin: null }), App.render());
  }

  /**
   * One row per active employee with their tasks (lanes for overlaps), then unassigned work per PFAM.
   * Also used under the project Gantt. opts: { zoom, involvedOnly (skip people without tasks in range),
   * byPhase (color bars by phase instead of project), scrollToToday }
   */
  function renderPeople(el, days, sel, from, to, pinned, today, opts) {
    opts = opts || {};
    const pfamOk = opts.pfamIds || new Set(Store.data.pfams.filter((f) => sel.has(f.projectId)).map((f) => f.id));
    const tasks = Store.data.tasks.filter((t) => pfamOk.has(t.pfamId) && t.start && t.end && D(t.end) >= from && D(t.start) <= to);
    const rows = [];
    const tip = new Map();
    const barOf = (t) => {
      const p = Store.projectOfTask(t);
      const k = M.status(t, today);
      tip.set(
        "t:" + t.id,
        `<b>${esc(t.name)}</b><div>${esc(p ? p.name : "")} › ${esc((Store.pfam(t.pfamId) || {}).name || "")}</div><div>${U.range(t.start, t.end)}・${M.STATUS[k].label}</div>${t.assignees.length > 1 ? `<div class="muted">共同：${t.assignees.map((id) => esc(Store.empName(id))).join("、")}</div>` : ""}`
      );
      const ph = opts.byPhase && Store.phase(t.phase);
      return { id: "t:" + t.id, start: D(t.start), end: D(t.end), color: ph ? ph.color : opts.byPhase ? "var(--nophase)" : p ? p.color : "#888", cls: `st-${k}`, text: t.name };
    };
    const pinDay = pinned != null ? days.find((d) => d.day === pinned) : null;
    for (const e of Store.workforce()) {
      const mine = tasks.filter((t) => t.assignees.includes(e.id));
      if (opts.involvedOnly && !mine.length) continue;
      const free = pinDay && !pinDay.busy.has(e.id);
      const nowN = mine.filter((t) => M.occupies(t, today, today)).length;
      // A header row per person, then one row per PFAM (more when tasks of one PFAM overlap), bars named by task.
      rows.push({
        id: "e:" + e.id,
        kind: "person",
        cls: "hdr" + (free ? " free" : ""),
        label: `<a class="g-name" href="#/people/${e.id}">${esc(e.name)}</a>${free ? `<span class="tag free">空閒</span>` : ""}`,
        meta: mine.length ? `${nowN ? `今天 ${nowN} 件・` : ""}${mine.length} 件・${new Set(mine.map((t) => t.pfamId)).size} 個 PFAM` : `<span class="muted">期間內沒有 task</span>`,
        bars: [],
      });
      const byPf = new Map();
      for (const t of [...mine].sort((a, b) => a.start.localeCompare(b.start))) {
        if (!byPf.has(t.pfamId)) byPf.set(t.pfamId, []);
        byPf.get(t.pfamId).push(t);
      }
      for (const [fid, ts] of byPf) {
        const f = Store.pfam(fid);
        const p = f && Store.project(f.projectId);
        lanes(ts).forEach((l, i) =>
          rows.push({
            id: "e:" + e.id + ":" + fid + ":" + i,
            kind: "lane",
            cls: "pf" + (i ? " cont" : ""),
            label: i ? "" : `<i class="dot" style="--c:${p ? p.color : "#888"}"></i><span class="g-name" title="${esc(`${p ? p.name + " › " : ""}${f ? f.name : ""}`)}">${esc(f ? f.name : "")}</span>`,
            meta: i || ts.length < 2 ? "" : `${ts.length} 件`,
            bars: l.tasks.map(barOf),
          })
        );
      }
    }
    // Unassigned work, one row per PFAM.
    const activeIds = new Set(Store.workforce().map((e) => e.id));
    const un = tasks.filter((t) => !t.assignees.some((id) => activeIds.has(id)) && M.status(t, today) !== "done");
    const byPfam = new Map();
    for (const t of un) {
      if (!byPfam.has(t.pfamId)) byPfam.set(t.pfamId, []);
      byPfam.get(t.pfamId).push(t);
    }
    if (byPfam.size) {
      rows.push({ id: "un", kind: "sub", label: `<span class="g-sec">未指派（${byPfam.size} 個 PFAM）</span>`, bars: [] });
      for (const [fid, ts] of byPfam) {
        lanes(ts).forEach((l, i) =>
          rows.push({ id: "u:" + fid + ":" + i, kind: i ? "lane" : "person", cls: "unassigned", label: i ? "" : `<span class="g-name">${esc((Store.pfam(fid) || {}).name || "")}</span>`, meta: i ? "" : `${ts.length} 件`, bars: l.tasks.map(barOf) })
        );
      }
    }
    const marks = days.filter((d) => d.alert).map((d) => ({ day: d.day, cls: "alert", title: "超出部門人力" }));
    if (pinned != null) marks.push({ day: pinned, cls: "pin", title: "標記日" });
    Charts.gantt(el, rows, {
      from,
      to,
      zoom: opts.zoom || (to - from > 200 ? "month" : "week"),
      scrollToToday: opts.scrollToToday,
      fit: opts.fit,
      today,
      labelHead: "員工",
      outLabels: false,
      clipText: true,
      marks,
      tip: (id) => tip.get(id),
      onBar: (id) => Store.editing && Editors.task(id.slice(2)),
    });
  }

  window.LoadView = { render, renderPeople };
})();
