/*
 * 人力資源: how many workdays are over the department's headcount, what each person works on now and next, and every person's
 * task timeline. Load = active employees with at least one task that day; unassigned PFAMs add demand.
 */
(function () {
  const E = window.Engine;
  const M = window.Model;
  const { esc, fmt, $ } = U;
  const D = (iso) => (iso ? E.toDay(iso) : null);
  let openEmp = ""; // 每人工作: whose detail is open (a way of looking, not data)

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
    const days = M.load(data, from, to, { today, projectIds: sel, isOthers: Convert.isOthers });
    const alerts = days.filter((d) => d.alert);
    const peak = days.reduce((m, d) => (!m || d.demand > m.demand ? d : m), null);
    const avg = days.length ? days.reduce((n, d) => n + d.busy.size, 0) / days.length : 0;
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
      <section class="card"><header class="card-h"><h3>每人工作</h3><span class="muted">目前任務（PFAM › task，依結束日）與下一個 task・只算上方勾選的專案・點 task 到專案甘特・點人名看明細</span></header><div id="lWork"></div></section>
      <div id="lDetail"></div>
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

    renderPeople($("#lPeople"), days, sel, from, to, today, { fit: true }); // stretch to the card width
    renderWork($("#lWork"), $("#lDetail"), sel, today);
  }

  /** One roster task line: project dot, "PFAM › task", and its end (current) or start (next) date. */
  function rosterTask(t, today, when) {
    const f = Store.pfam(t.pfamId);
    const p = f && Store.project(f.projectId);
    const late = M.status(t, today) === "late";
    const date = when === "end" ? (late ? `<b class="late">逾期 ${today - D(t.end)} 天</b>` : `～${fmt(t.end, "short")}（${D(t.end) === today ? "今天結束" : `剩下 ${D(t.end) - today} 天`}）`) : `${fmt(t.start, "short")} 開始（還有 ${D(t.start) - today} 天）`;
    return `<li title="${esc(`${p ? p.name + " › " : ""}${f ? f.name + " › " : ""}${t.name}`)}"><i class="dot" style="--c:${p ? p.color : "#888"}"></i><span class="rt-pf">${esc(f ? f.name : "")}</span><span class="rt-sep">›</span><span class="rt-t">${esc(t.name)}</span><small class="muted">${date}</small></li>`;
  }

  /** The open ADO items of one person; a click opens the same person's detail as the name does. */
  function adoCell(e, ado) {
    const rs = ado.get(e.id) || [];
    if (!rs.length) return `<span class="muted">—</span>`;
    const stale = rs.filter((r) => r.stale).length;
    return `<button type="button" class="link" data-open="${e.id}" title="看他的 ADO 未完成項目"><b>${rs.length}</b></button>${stale ? ` <small class="late" title="超過 ${AdoModel.STALE_DAYS - 1} 天沒更新">停滯 ${stale}</small>` : ""}`;
  }

  /** Click on a task line -> that task on the project Gantt. */
  function goTask(ev) {
    const li = ev.target.closest("li[data-task]");
    if (!li) return;
    const t = Store.task(li.dataset.task);
    const f = t && Store.pfam(t.pfamId);
    if (!f) return;
    ProjectsView.focus(f.id, t.id);
    App.go("#/projects/" + f.projectId);
  }

  /** 每人工作: per person (manpower only) the tasks running now and the next one, in the selected projects. */
  function renderWork(el, detailEl, sel, today) {
    const pfamOk = new Set(Store.data.pfams.filter((f) => sel.has(f.projectId)).map((f) => f.id));
    const emps = Store.workforce();
    if (!emps.length) {
      el.innerHTML = `<p class="empty">沒有計入人力的員工。<a href="#/settings/emps">到「設定」管理名冊</a>。</p>`;
      detailEl.innerHTML = "";
      return;
    }
    const ado = AdoView.byEmployee(); // null until this browser has an ADO snapshot: the column is left out
    const nowOf = (e) =>
      Store.data.tasks
        .filter((t) => t.assignees.includes(e.id) && pfamOk.has(t.pfamId) && t.start && t.end && ["active", "late"].includes(M.status(t, today)))
        .sort((a, b) => a.end.localeCompare(b.end));
    const rows = emps
      .map((e) => {
        const now = nowOf(e);
        const next = Store.data.tasks
          .filter((t) => t.assignees.includes(e.id) && pfamOk.has(t.pfamId) && t.start && t.end && M.status(t, today) === "future")
          .sort((a, b) => a.start.localeCompare(b.start))[0];
        return `<tr class="${openEmp === e.id ? "on" : ""}">
          <th><button type="button" class="link wk-name" data-open="${e.id}" aria-expanded="${openEmp === e.id}">${esc(e.name)}</button></th>
          <td>${now.length ? `<ul class="rt-list">${now.map((t) => rosterTask(t, today, "end").replace("<li ", `<li data-task="${t.id}" `)).join("")}</ul>` : `<span class="muted">—</span>`}</td>
          <td>${next ? `<ul class="rt-list">${rosterTask(next, today, "start").replace("<li ", `<li data-task="${next.id}" `)}</ul>` : `<span class="muted">—</span>`}</td>
          ${ado ? `<td class="num">${adoCell(e, ado)}</td>` : ""}
        </tr>`;
      })
      .join("");
    el.innerHTML = `<div class="table-wrap"><table class="grid-table roster work"><thead><tr><th>姓名</th><th>目前任務</th><th>下一個 task</th>${
      ado ? `<th class="num" title="ADO 上指派給他、尚未完成的工作項目（ADO Task 頁最近一次擷取）">ADO 未完成</th>` : ""
    }</tr></thead><tbody>${rows}</tbody></table></div>`;
    el.onclick = (ev) => {
      const b = ev.target.closest("[data-open]");
      if (!b) return goTask(ev);
      openEmp = openEmp === b.dataset.open ? "" : b.dataset.open;
      App.render();
      if (openEmp) $("#lDetail").scrollIntoView({ behavior: "smooth", block: "nearest" });
    };

    const e = openEmp && emps.find((x) => x.id === openEmp);
    if (!e) {
      openEmp = "";
      detailEl.innerHTML = "";
      return;
    }
    renderDetail(detailEl, e, nowOf(e), ado, today);
  }

  /** One person: open ADO items next to the department tasks running now (the same pair as the row above, in full). */
  function renderDetail(el, e, now, ado, today) {
    const rs = ado ? AdoModel.sort(ado.get(e.id) || [], "ageDays", "desc") : [];
    el.innerHTML = `<section class="card detail">
      <header class="card-h"><h3>${esc(e.name)}</h3>
        <span class="muted">${ado ? `${rs.length} 筆 ADO 未完成項目・` : ""}${now.length} 件進行中的部門 task</span><span class="grow"></span>
        ${ado ? `<button class="btn small" id="dAdo" type="button">在 ADO Task 查看</button>` : ""}
        <a class="btn small" href="#/people/${esc(e.id)}">出差紀錄 ›</a>
        <button class="icon" id="dClose" type="button" aria-label="關閉">✕</button></header>
      <div class="detail-grid">
        <div><h4>ADO 未完成項目${ado ? `（${rs.length}）` : ""}</h4>${
          !ado
            ? `<p class="muted">這台電腦還沒有 ADO 資料，<a href="#/ado">到 ADO Task 擷取</a>。</p>`
            : rs.length
              ? `<ul class="tlist ado-items">${rs.map(AdoView.itemLine).join("")}</ul>`
              : `<p class="muted">目前沒有未完成的 ADO 項目。${AdoModel.aliasesOf(e).length ? "" : "若實際上有，請在編輯員工設定他的 ADO 帳號。"}</p>`
        }</div>
        <div><h4>部門 task（進行中 ${now.length}）</h4>${
          now.length
            ? `<ul class="tlist">${now
                .map((t) => {
                  const f = Store.pfam(t.pfamId);
                  const p = f && Store.project(f.projectId);
                  const k = M.status(t, today);
                  return `<li class="st-${k}" data-task="${t.id}"><span class="dot" style="--c:${p ? p.color : "#888"}"></span><span class="a-main">${esc(t.name)}<small>${esc(p ? p.name : "")} › ${esc(f ? f.name : "")}</small></span><span class="a-side"><span class="pill st-${k}">${M.STATUS[k].icon} ${M.STATUS[k].label}</span>${U.range(t.start, t.end)}</span></li>`;
                })
                .join("")}</ul>`
            : `<p class="muted">上方勾選的專案裡沒有進行中的 task</p>`
        }</div>
      </div></section>`;
    $("#dClose").onclick = () => ((openEmp = ""), App.render());
    if ($("#dAdo")) $("#dAdo").onclick = () => AdoView.openMember(e.id);
    el.onclick = goTask;
  }

  /**
   * One row per active employee with their tasks (lanes for overlaps), then unassigned work per PFAM.
   * Also used under the project Gantt. opts: { zoom, involvedOnly (skip people without tasks in range),
   * byPhase (color bars by phase instead of project), scrollToToday }
   */
  function renderPeople(el, days, sel, from, to, today, opts) {
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
    for (const e of Store.workforce()) {
      const mine = tasks.filter((t) => t.assignees.includes(e.id));
      if (opts.involvedOnly && !mine.length) continue;
      const nowN = mine.filter((t) => M.occupies(t, today, today)).length;
      // A header row per person, then one row per PFAM (more when tasks of one PFAM overlap), bars named by task.
      rows.push({
        id: "e:" + e.id,
        kind: "person",
        cls: "hdr",
        label: `<a class="g-name" href="#/people/${e.id}">${esc(e.name)}</a>`,
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
    // Unassigned work, one row per PFAM ("Others": one row per 2 tasks, counted like 同時進行的 PFAM).
    const activeIds = new Set(Store.workforce().map((e) => e.id));
    const un = tasks.filter((t) => !t.assignees.some((id) => activeIds.has(id)) && M.status(t, today) !== "done");
    const byPfam = M.pfamUnits(un, (t) => Store.pfam(t.pfamId) || { id: t.pfamId, projectId: "" }, Convert.isOthers);
    if (byPfam.size) {
      rows.push({ id: "un", kind: "sub", label: `<span class="g-sec">未指派（${byPfam.size} 個 PFAM）</span>`, bars: [] });
      for (const [key, u] of byPfam) {
        lanes(u.tasks).forEach((l, i) =>
          rows.push({ id: "u:" + key + ":" + i, kind: i ? "lane" : "person", cls: "unassigned", label: i ? "" : `<span class="g-name">${esc(u.pfam.name || "")}</span>`, meta: i ? "" : `${u.tasks.length} 件`, bars: l.tasks.map(barOf) })
        );
      }
    }
    const marks = days.filter((d) => d.alert).map((d) => ({ day: d.day, cls: "alert", title: "超出部門人力" }));
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
