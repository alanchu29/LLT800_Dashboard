/*
 * 專案甘特: project cards on top ("全部專案" first), then the Gantt (or table) of the selected scope and,
 * under it, the people allocation on the same time axis.
 *   全部專案 : Project rows -> PFAM rows -> tasks (PFAMs start folded)
 *   one project: PFAM rows -> tasks
 */
(function () {
  const E = window.Engine;
  const M = window.Model;
  const { esc, fmt, $ } = U;
  const D = (iso) => (iso ? E.toDay(iso) : null);
  const ALL = "all";
  let scrolledTo = "";
  let pflOpen = true; // 同時進行的 PFAM band above the dates: open on every page load (the toggle hides it until reload)
  let pin = null; // day picked on the band (session only)
  let pinOnly = true; // with a pinned day: list only the PFAMs / tasks running that day // the focused task / PFAM already brought into view (scroll only once per focus)
  const NO_SITE = "-"; // 廠區 filter value for PFAMs without a site
  const isOthers = (f) => Convert.isOthers(f);
  // Shown period (Gantt, table and people allocation only show tasks overlapping it).
  const PERIODS = [
    ["m2p3", () => L("前 2 週 + 後 3 月", "Last 2 wk + next 3 mo"), (t) => [t - 14, t + 91]],
    ["p6", () => L("未來 6 個月", "Next 6 months"), (t) => [t, t + 183]],
    ["year", () => L("今年", "This year"), (t) => {
      const y = E.fromDay(t).slice(0, 4);
      return [E.toDay(`${y}-01-01`), E.toDay(`${y}-12-31`)];
    }],
  ];

  function period(today) {
    const ui = Store.ui;
    if (ui.projPeriod === "custom" && ui.projFrom && ui.projTo && ui.projTo >= ui.projFrom) return { key: "custom", from: D(ui.projFrom), to: D(ui.projTo) };
    const p = PERIODS.find((x) => x[0] === ui.projPeriod) || PERIODS[0];
    const [from, to] = p[2](today);
    return { key: p[0], from, to };
  }

  /**
   * The period the Gantt actually shows: the picked period, stretched to hold a focused task
   * (opened from 需要注意 / 專案總覽 / 出差紀錄). The cards and the panel both count over this.
   */
  function shownWin(today, projects) {
    const win = period(today);
    const focus = Store.ui.focusTask ? Store.task(Store.ui.focusTask) : null;
    const inScope = focus && focus.start && focus.end && projects.some((p) => Store.pfamsOf(p.id).some((f) => f.id === focus.pfamId));
    if (inScope) {
      if (D(focus.start) < win.from) (win.from = D(focus.start) - 7), (win.extended = true);
      if (D(focus.end) > win.to) (win.to = D(focus.end) + 7), (win.extended = true);
      win.focusDay = D(focus.start);
      win.focus = focus;
    }
    return win;
  }

  const STATUS_EN = { done: "Done", late: "Overdue", active: "In progress", future: "Not started", nodate: "No dates" };

  function statusPill(k) {
    const s = M.STATUS[k];
    const label = L(s.label, STATUS_EN[k]);
    return `<span class="pill st-${k}" title="${label}">${s.icon} ${label}</span>`;
  }

  function delta(t) {
    if (!t.baseEnd || !t.end) return "";
    const d = D(t.end) - D(t.baseEnd);
    if (!d) return `<span class="delta same" title="${L("與基準相同", "Same as baseline")}">±0</span>`;
    return `<span class="delta ${d > 0 ? "late" : "early"}" title="${L(`結束日相對基準 ${fmt(t.baseEnd, "short")}`, `End vs. baseline ${fmt(t.baseEnd, "short")}`)}">${d > 0 ? "▲" : "▼"}${Math.abs(d)}d</span>`;
  }

  function names(ids) {
    return ids.map((id) => esc(Store.empName(id))).join(L("、", ", "));
  }

  // ---------------------------------------------------------------- fold state
  /** Folded rows per scope: ui.fold[scope][id] = true (folded) / false (open); missing = the default. */
  function foldState(scope, defaults) {
    const saved = (Store.ui.fold && Store.ui.fold[scope]) || {};
    return {
      folded: (id, kind) => (id in saved ? saved[id] : defaults(kind, id)),
      set(patch) {
        Store.setUi({ fold: { ...(Store.ui.fold || {}), [scope]: { ...saved, ...patch } } });
        App.render();
      },
    };
  }

  // ---------------------------------------------------------------- page
  function render(root, arg) {
    const data = Store.data;
    const ui = Store.ui;
    const today = U.today();
    const all = Store.projects();
    const shown = all.filter((p) => ui.showArchived || p.status !== "archived");
    let pid = arg === ALL || (arg && Store.project(arg)) ? arg : ui.projectId === ALL || (ui.projectId && Store.project(ui.projectId)) ? ui.projectId : ALL;
    if (pid !== ui.projectId) Store.setUi({ projectId: pid });

    // The cards count the same shown period as the panel below (same rules), so their numbers match it.
    const cardWin = shownWin(today, pid === ALL ? shown : [Store.project(pid)].filter(Boolean));
    const inCardWin = (t) => t.start && t.end && D(t.start) <= cardWin.to && D(t.end) >= cardWin.from;
    const winNums = (p) => {
      const fs = Store.pfamsOf(p.id);
      const ts = fs.flatMap((f) => Store.tasksOf(f.id));
      return {
        pfams: fs.filter((f) => {
          const ft = Store.tasksOf(f.id);
          return !ft.length || isOthers(f) || ft.some(inCardWin);
        }).length,
        tasks: ts.filter(inCardWin),
        allPfams: fs.length,
        allTasks: ts.length,
      };
    };
    const winNote = (n) => L(`顯示期間 ${U.range(cardWin.from, cardWin.to)} 內的數量；全部 ${n.allPfams} PFAM・${n.allTasks} task`, `Counts within the shown period ${U.range(cardWin.from, cardWin.to)}; total ${n.allPfams} PFAM · ${n.allTasks} task`);
    const card = (p) => {
      const n = winNums(p);
      const late = n.tasks.filter((t) => M.status(t, today) === "late").length;
      const act = n.tasks.filter((t) => M.status(t, today) === "active").length;
      return `<a class="pcard${p.id === pid ? " on" : ""}${p.status === "archived" ? " archived" : ""}" href="#/projects/${p.id}" style="--c:${p.color}" title="${esc(winNote(n))}">
        <span class="pc-name"><i class="dot"></i>${esc(p.name)}${p.status === "archived" ? `<span class="tag ghost">${L("封存", "Archived")}</span>` : ""}</span>
        <span class="pc-nums">${n.pfams} PFAM・${n.tasks.length} task</span>
        <span class="pc-st">${act ? L(`<b>${act}</b> 進行中`, `<b>${act}</b> in progress`) : `<span class="muted">${L("無進行中", "None in progress")}</span>`}${late ? L(`・<b class="late">${late}</b> 逾期`, ` · <b class="late">${late}</b> overdue`) : ""}</span>
      </a>`;
    };
    const allNums = shown.map(winNums);
    const liveTasks = allNums.flatMap((n) => n.tasks);
    const allLate = liveTasks.filter((t) => M.status(t, today) === "late").length;
    const allCard = shown.length
      ? `<a class="pcard all${pid === ALL ? " on" : ""}" href="#/projects/all" title="${esc(
          L(
            `顯示期間 ${U.range(cardWin.from, cardWin.to)} 內的數量；全部 ${allNums.reduce((x, n) => x + n.allPfams, 0)} PFAM・${allNums.reduce((x, n) => x + n.allTasks, 0)} task`,
            `Counts within the shown period ${U.range(cardWin.from, cardWin.to)}; total ${allNums.reduce((x, n) => x + n.allPfams, 0)} PFAM · ${allNums.reduce((x, n) => x + n.allTasks, 0)} task`
          )
        )}">
          <span class="pc-name"><span class="dots">${shown.slice(0, 8).map((p) => `<i class="dot" style="--c:${p.color}"></i>`).join("")}</span>${L("全部專案", "All projects")}</span>
          <span class="pc-nums">${allNums.filter((n) => n.pfams).length} Project・${allNums.reduce((x, n) => x + n.pfams, 0)} PFAM・${liveTasks.length} task</span>
          <span class="pc-st">${L("一併檢視時程與人力分配", "Schedule and assignments together")}${allLate ? L(`・<b class="late">${allLate}</b> 逾期`, ` · <b class="late">${allLate}</b> overdue`) : ""}</span>
        </a>`
      : "";
    const archivedN = all.filter((p) => p.status === "archived").length;

    root.innerHTML = `
      <div class="page-head"><h2>${L("專案甘特", "Project Gantt")}</h2>
        <span class="grow"></span>
        ${archivedN ? `<label class="check small"><input type="checkbox" id="showArch"${ui.showArchived ? " checked" : ""}> ${L("顯示封存", "Show archived")} (${archivedN})</label>` : ""}
        <button class="btn edit-only" id="addProject" type="button">${L("＋ 新增 Project", "＋ New Project")}</button>
      </div>
      <div class="pcards">${allCard}${shown.map(card).join("") || `<p class="empty">${L("還沒有專案。", "No projects yet. ")}${Store.editing ? L("按右上「新增 Project」開始。", "Click “New Project” at the top right to start.") : L("切換「編輯模式」後即可新增，或到「設定」匯入 MONICA 資料。", "Turn on Edit mode to add one, or import MONICA data in Settings.")}</p>`}</div>
      <section class="card" id="projBody"></section>
      <section class="card" id="allocBody" hidden></section>`;

    $("#addProject").onclick = () => Editors.project(null);
    const sa = $("#showArch");
    if (sa)
      sa.onchange = () => {
        Store.setUi({ showArchived: sa.checked });
        App.render();
      };
    if (pid === ALL && shown.length) renderScope($("#projBody"), $("#allocBody"), null, shown, today);
    else if (pid !== ALL && Store.project(pid)) renderScope($("#projBody"), $("#allocBody"), Store.project(pid), [Store.project(pid)], today);
    else $("#projBody").hidden = true;
  }

  /** proj = null for 全部專案; projects = the projects in scope. */
  function renderScope(el, allocEl, proj, projects, today) {
    const ui = Store.ui;
    const multi = !proj;
    // 廠區 filter: only PFAMs of that site (and, in 全部專案, only projects that have one).
    const siteColors = Store.siteColors();
    const scopePfams = projects.flatMap((p) => Store.pfamsOf(p.id));
    const siteList = [...siteColors.keys()].filter((s) => scopePfams.some((f) => f.site === s));
    const noSite = scopePfams.some((f) => !f.site);
    const site = ui.filterSite && (siteList.includes(ui.filterSite) || (ui.filterSite === NO_SITE && noSite)) ? ui.filterSite : "";
    const siteOk = (f) => !site || isOthers(f) || (site === NO_SITE ? !f.site : f.site === site);
    const scopes = projects.map((p) => ({ proj: p, pfams: Store.pfamsOf(p.id).filter(siteOk) })).filter((s) => !multi || !site || s.pfams.some((f) => !isOthers(f)));
    const pfams = scopes.flatMap((s) => s.pfams);
    const tasksAll = pfams.flatMap((f) => Store.tasksOf(f.id));
    const emps = [...new Set(tasksAll.flatMap((t) => t.assignees))].map((id) => Store.emp(id)).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
    const who = ui.filterEmp && emps.some((e) => e.id === ui.filterEmp) ? ui.filterEmp : "";
    const openOnly = !!ui.openOnly;
    const view = ui.projView || "gantt";
    const big = tasksAll.length > 120;
    const fold = foldState(multi ? ALL : proj.id, (kind) => (kind === "pfam" ? multi || big : false));
    // A task opened from elsewhere (需要注意, 專案總覽, 出差紀錄) is always shown: the period stretches to include
    // it and the filters let it through. Leaving this scope or picking a period drops the focus.
    const win = shownWin(today, projects);
    const focus = ui.focusTask ? Store.task(ui.focusTask) : null;
    const focusHere = !!win.focus && tasksAll.includes(focus);
    if (ui.focusTask && !focusHere) Store.setUi({ focusTask: "" });
    const inWin = (t) => t.start && t.end && D(t.start) <= win.to && D(t.end) >= win.from;
    if (pin != null && (pin < win.from || pin > win.to)) pin = null;
    const pinned = pin != null && pinOnly;
    const onPin = (t) => !pinned || M.occupies(t, pin, today); // same rule as the band's count
    const keep = (t) => (focusHere && t === focus) || (inWin(t) && (!who || t.assignees.includes(who)) && (!openOnly || M.status(t, today) !== "done") && onPin(t));
    // Header numbers follow the shown period: its tasks, the PFAMs listed (with tasks in it, or none yet).
    const winTasks = tasksAll.filter(inWin);
    const winPfams = pfams.filter((f) => {
      const ts = Store.tasksOf(f.id);
      return !ts.length || isOthers(f) || ts.some(inWin);
    });
    const winProjects = projects.filter((p) => winPfams.some((f) => f.projectId === p.id));
    const dc = M.doneCount(winTasks);
    const sp = M.span(winTasks);
    const people = new Set(winTasks.flatMap((t) => t.assignees));

    el.hidden = false;
    el.style.setProperty("--c", multi ? "var(--brand)" : proj.color);
    const title = multi
      ? `<div class="proj-title"><div><h3>${L("全部專案", "All projects")}</h3><p class="muted">${L(
          `${winProjects.length} 個 Project・${winPfams.length} 個 PFAM・${winTasks.length} 個 task・${people.size} 人參與${sp.start != null ? `・${U.range(sp.start, sp.end)}` : ""}・已完成 ${dc.done} / ${dc.total}`,
          `${winProjects.length} Project · ${winPfams.length} PFAM · ${winTasks.length} task · ${people.size} people${sp.start != null ? ` · ${U.range(sp.start, sp.end)}` : ""} · Done ${dc.done} / ${dc.total}`
        )}</p></div></div>`
      : `<div class="proj-title"><i class="dot big"></i><div><h3>${esc(proj.name)}</h3>
          <p class="muted">${L(
            `${winPfams.length} 個 PFAM・${winTasks.length} 個 task・${people.size} 人參與・${sp.start != null ? U.range(sp.start, sp.end) : "期間內無 task"}・已完成 ${dc.done} / ${dc.total}`,
            `${winPfams.length} PFAM · ${winTasks.length} task · ${people.size} people · ${sp.start != null ? U.range(sp.start, sp.end) : "no task in the period"} · Done ${dc.done} / ${dc.total}`
          )}${proj.notes ? `・${esc(proj.notes)}` : ""}</p></div></div>`;
    el.innerHTML = `
      <header class="proj-h">${title}
        <div class="proj-actions">
          ${!multi && proj.link ? `<a class="hbtn ext-link" href="${esc(proj.link)}" target="_blank" rel="noopener" title="${esc(proj.link)}">${esc(proj.linkName || L(`開啟 ${proj.name} 系統`, `Open ${proj.name} system`))}<svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3h4v4M13 3 7.5 8.5M12 9.5V13H3V4h3.5"/></svg></a>` : ""}
          ${multi ? "" : `<button class="btn edit-only" id="editProject" type="button">${L("編輯 Project", "Edit Project")}</button><button class="btn edit-only" id="addPfam" type="button">＋ PFAM</button>`}
          <button class="btn primary edit-only" id="addTask" type="button">＋ task</button>
        </div>
      </header>
      <div class="toolbar">
        <div class="seg" role="group" aria-label="${L("期間", "Period")}">${PERIODS.map(([k, l]) => `<button type="button" data-period="${k}" class="${win.key === k ? "on" : ""}">${l()}</button>`).join("")}</div>
        <label class="field-inline">${L("從", "From")} <input type="date" id="pFrom" value="${E.fromDay(win.from)}"></label>
        <label class="field-inline">${L("到", "To")} <input type="date" id="pTo" value="${E.fromDay(win.to)}"></label>
        ${focusHere ? `<span class="focus-note">📍 ${L("定位：", "Focus: ")}${esc(focus.name)}${win.extended ? L("（已延伸期間以顯示此 task）", " (period extended to show this task)") : ""}<button class="link" id="clearFocus" type="button">${L("清除定位", "Clear focus")}</button></span>` : ""}
        <div class="seg" role="group" aria-label="${L("檢視", "View")}">${[["gantt", L("甘特圖", "Gantt")], ["table", L("表格", "Table")]].map(([k, l]) => `<button type="button" data-view="${k}" class="${view === k ? "on" : ""}">${l}</button>`).join("")}</div>
        ${view === "gantt" ? `<div class="seg" role="group" aria-label="${L("時間尺度", "Time scale")}">${[["day", L("日", "Day")], ["week", L("週", "Week")], ["month", L("月", "Month")]].map(([k, l]) => `<button type="button" data-zoom="${k}" class="${ui.zoom === k ? "on" : ""}">${l}</button>`).join("")}</div>` : ""}
        ${siteList.length + (noSite ? 1 : 0) > 1 || site ? `<label class="field-inline">${L("廠區", "Site")} <select id="fSite"><option value="">${L("全部", "All")}</option>${siteList.map((s) => `<option value="${esc(s)}"${s === site ? " selected" : ""}>${esc(s)}</option>`).join("")}${noSite ? `<option value="${NO_SITE}"${site === NO_SITE ? " selected" : ""}>${L("未指定", "None")}</option>` : ""}</select></label>` : ""}
        <label class="field-inline">${L("負責人", "Owner")} <select id="fEmp"><option value="">${L("全部", "All")}</option>${emps.map((e) => `<option value="${e.id}"${e.id === who ? " selected" : ""}>${esc(e.name)}</option>`).join("")}</select></label>
        <label class="check small"><input type="checkbox" id="fOpen"${openOnly ? " checked" : ""}> ${L("隱藏已完成", "Hide done")}</label>
        <span class="grow"></span>
        ${view === "gantt" ? `<div class="hctl"><button class="hbtn pfl-toggle" id="pflToggle" type="button"></button><button class="hbtn" id="foldToggle" type="button"></button></div>` : ""}
      </div>
      <div id="projPin"></div><div id="projView"></div>
      <div class="legend" id="projLegend"></div>`;

    if (!multi) {
      $("#editProject").onclick = () => Editors.project(proj.id);
      $("#addPfam").onclick = () => Editors.pfam(null, { projectId: proj.id });
    }
    $("#addTask").onclick = () => {
      if (!pfams.length) return proj ? Editors.pfam(null, { projectId: proj.id }) : App.toast(L("請先新增 PFAM", "Add a PFAM first"), "error");
      const f = Store.pfam(ui.focusPfam);
      Editors.task(null, { pfamId: f && pfams.includes(f) ? f.id : pfams[0].id });
    };
    el.querySelectorAll("[data-period]").forEach((b) => (b.onclick = () => (Store.setUi({ projPeriod: b.dataset.period, focusTask: "" }), App.render())));
    // Typing dates = a custom period (kept until a preset is picked).
    const setCustom = () => {
      const a = $("#pFrom").value;
      const b = $("#pTo").value;
      if (!a || !b) return;
      if (b < a) return App.toast(L("結束日不能早於開始日", "The end date can't be before the start date"), "error");
      Store.setUi({ projPeriod: "custom", projFrom: a, projTo: b, focusTask: "" });
      App.render();
    };
    $("#pFrom").onchange = setCustom;
    $("#pTo").onchange = setCustom;
    if ($("#clearFocus")) $("#clearFocus").onclick = () => (Store.setUi({ focusTask: "" }), App.render());
    el.querySelectorAll("[data-view]").forEach((b) => (b.onclick = () => (Store.setUi({ projView: b.dataset.view }), App.render())));
    el.querySelectorAll("[data-zoom]").forEach((b) => (b.onclick = () => (Store.setUi({ zoom: b.dataset.zoom }), App.render())));
    $("#fEmp").onchange = (ev) => (Store.setUi({ filterEmp: ev.target.value }), App.render());
    if ($("#fSite")) $("#fSite").onchange = (ev) => (Store.setUi({ filterSite: ev.target.value }), App.render());
    $("#fOpen").onchange = (ev) => (Store.setUi({ openOnly: ev.target.checked }), App.render());
    // One toggle: anything folded -> "全部展開"; everything open -> fold the PFAMs.
    if ($("#foldToggle")) {
      const anyFolded = (multi && projects.some((p) => fold.folded(p.id, "proj"))) || pfams.some((f) => fold.folded(f.id, "pfam"));
      $("#foldToggle").innerHTML = anyFolded ? `${PfamBand.ICON.expand}<span>${L("全部展開", "Expand all")}</span>` : `${PfamBand.ICON.collapse}<span>${multi ? L("收合 PFAM", "Collapse PFAMs") : L("全部收合", "Collapse all")}</span>`;
      $("#foldToggle").onclick = () =>
        fold.set(anyFolded ? Object.fromEntries([...projects.map((p) => [p.id, false]), ...pfams.map((f) => [f.id, false])]) : Object.fromEntries(pfams.map((f) => [f.id, true])));
    }

    // 同時進行的 PFAM over the shown period (the PFAMs in scope, 廠區 filter included), limit = headcount.
    let pfl = null;
    if (view === "gantt") {
      // 全部專案: limit = headcount, plus each project's own 警戒上限; one project: its own 警戒上限 (set in 編輯 Project; none = no line)
      const capOpts = multi ? { projCaps: true } : { cap: Number(proj.pfamCap) || 0, capLabel: L(`警戒 ${Number(proj.pfamCap) || 0} 個`, `Alert ${Number(proj.pfamCap) || 0}`), capNote: L(`未設定警戒上限${Store.editing ? "（編輯 Project 可設定）" : ""}`, `No alert limit${Store.editing ? " (set in Edit Project)" : ""}`) };
      pfl = PfamBand.build(scopes.map((s) => s.proj), win.from, win.to, today, { pfamIds: site ? new Set(pfams.map((f) => f.id)) : null, ...capOpts });
      PfamBand.button($("#pflToggle"), pfl, pflOpen, () => {
        pflOpen = !pflOpen;
        App.render();
      });
      // Click a day on the band: pin it and list what runs that day.
      pfl.band.pinned = pin;
      pfl.band.onPick = (day) => {
        pin = pin === day ? null : day;
        pinOnly = true;
        App.render();
      };
      PfamBand.pinBar($("#projPin"), pfl, pin, pinOnly, {
        only: (v) => ((pinOnly = v), App.render()),
        clear: () => ((pin = null), App.render()),
      });
    }
    if (!pfams.some((f) => !isOthers(f)) && site) {
      $("#projView").innerHTML = `<p class="empty">${L(`沒有${site === NO_SITE ? "未指定廠區" : `廠區「${esc(site)}」`}的 PFAM。`, `No PFAM ${site === NO_SITE ? "without a site" : `at site “${esc(site)}”`}.`)}</p>`;
      allocEl.hidden = true;
      return;
    }
    if (!pfams.length) {
      $("#projView").innerHTML = `<p class="empty">${multi ? L("還沒有 PFAM。", "No PFAMs yet.") : `${L("這個 Project 還沒有 PFAM。", "This Project has no PFAMs yet. ")}${Store.editing ? L("按「＋ PFAM」新增。", "Click “＋ PFAM” to add one.") : L("切換編輯模式後即可新增。", "Turn on Edit mode to add one.")}`}</p>`;
      allocEl.hidden = true;
      return;
    }
    let range = null;
    // PFAMs without any task yet are always listed (so new ones show up and can get their first task).
    const emptyPfams = pfams.filter((f) => !Store.tasksOf(f.id).length).length;
    if (!tasksAll.some(keep) && !emptyPfams) {
      $("#projView").innerHTML = `<p class="empty">${L(`這段期間（${U.range(win.from, win.to)}）沒有符合條件的 task。可以改選其他期間。`, `No matching task in this period (${U.range(win.from, win.to)}). Try another period.`)}</p>`;
      $("#projLegend").innerHTML = "";
      renderAllocation(allocEl, proj, scopes.map((s) => s.proj), { from: win.from, to: win.to, zoom: ui.zoom || "week" }, today, site ? new Set(pfams.map((f) => f.id)) : null);
      return;
    }
    if (view === "table") renderTable($("#projView"), scopes, keep, today, multi, siteColors);
    else range = renderGantt($("#projView"), scopes, keep, fold, today, multi, win, siteColors, pflOpen && pfl ? pfl.band : null, pinned);
    if (!range) range = { from: win.from, to: win.to, zoom: ui.zoom || "week" };

    const phases = Store.data.settings.phases.filter((p) => tasksAll.some((t) => t.phase === p.key));
    $("#projLegend").innerHTML =
      view === "gantt"
        ? `${multi ? `<span class="muted">${L("Project 條＝專案色；task 條＝Phase 色", "Project bar = project color; task bar = Phase color")}</span>` : ""}<span class="lg"><i class="lg-summary"></i>${L("PFAM 期間（收合時）", "PFAM span (folded)")}</span>${phases.map((p) => `<span class="lg"><i style="background:${p.color}"></i>${esc(p.label)}</span>`).join("")}${
            tasksAll.some((t) => !t.phase) ? `<span class="lg"><i style="background:var(--nophase)"></i>${L("未指定 Phase", "No Phase")}</span>` : ""
          }<span class="lg"><i class="lg-base"></i>${L("基準", "Baseline")}</span><span class="lg"><i class="lg-done"></i>${L("已完成", "Done")}</span><span class="lg"><i class="lg-late"></i>${L("逾期", "Overdue")}</span>`
        : "";

    renderAllocation(allocEl, proj, scopes.map((s) => s.proj), range, today, site ? new Set(pfams.map((f) => f.id)) : null);
  }

  // ---------------------------------------------------------------- gantt
  function renderGantt(el, scopes, keep, fold, today, multi, win, siteColors, band, pinned) {
    const ui = Store.ui;
    const rows = [];
    const tipFor = new Map();
    const hol = M.holidays(Store.data);

    for (const { proj, pfams } of scopes) {
      const pts = pfams.flatMap((f) => Store.tasksOf(f.id));
      if (multi) {
        const hasEmpty = !pfams.length || pfams.some((f) => !Store.tasksOf(f.id).length);
        if (!pts.some(keep) && (pinned || !hasEmpty)) continue;
        const s = M.span(pts);
        const folded = fold.folded(proj.id, "proj") && !pinned;
        const late = pts.filter((t) => M.status(t, today) === "late").length;
        const ppl = new Set(pts.flatMap((t) => t.assignees));
        rows.push({
          id: "p:" + proj.id,
          kind: "proj",
          cls: folded ? "collapsed" : "",
          label: `<button class="tw" type="button" aria-label="${L("展開/收合", "Expand/collapse")}" aria-expanded="${!folded}">${folded ? "▸" : "▾"}</button><i class="dot" style="--c:${proj.color}"></i><span class="g-name" title="${L("點一下展開 / 收合", "Click to expand / collapse")}">${esc(proj.name)}</span><a class="open-link" href="#/projects/${proj.id}" title="${L("開啟這個專案", "Open this project")}">${L("開啟 ›", "Open ›")}</a>`,
          meta: L(`${pfams.length} PFAM・${ppl.size} 人${late ? `・<b class="late">${late} 逾期</b>` : ""}`, `${pfams.length} PFAM · ${ppl.size} ppl${late ? ` · <b class="late">${late} overdue</b>` : ""}`),
          // Span bars only when folded: open, the rows below already show the same span.
          bars: folded ? [{ id: "p:" + proj.id, start: s.start, end: s.end, color: proj.color, text: "" }] : [],
        });
        tipFor.set("p:" + proj.id, `<b>${esc(proj.name)}</b><div>${U.range(s.start, s.end)}${L(`・${pfams.length} 個 PFAM・${pts.length} 個 task`, ` · ${pfams.length} PFAM · ${pts.length} task(s)`)}</div><div>${L(`已完成 ${M.doneCount(pts).done} / ${pts.length}`, `Done ${M.doneCount(pts).done} / ${pts.length}`)}</div>${ppl.size ? `<div class="muted">${names([...ppl])}</div>` : ""}`);
        if (folded) continue;
      }
      for (const f of pfams) {
        const ts = Store.tasksOf(f.id);
        const vis = ts.filter(keep);
        if (!vis.length && (pinned || (ts.length && !isOthers(f)))) continue; // has tasks, none in this period / filter ("Others" always stays, except "只看這天")
        const s = M.span(ts);
        const isCol = fold.folded(f.id, "pfam") && !pinned && !(ui.focusTask && ts.some((t) => t.id === ui.focusTask));
        const ppl = [...new Set(ts.flatMap((t) => t.assignees))];
        const late = ts.filter((t) => M.status(t, today) === "late").length;
        rows.push({
          id: "f:" + f.id,
          kind: "group",
          rc: proj.color,
          cls: (isCol ? "collapsed" : "") + (ui.focusPfam === f.id ? " focus" : "") + (multi ? " nested" : ""),
          label: `<button class="tw" type="button" aria-label="${L("展開/收合", "Expand/collapse")}" aria-expanded="${!isCol}">${isCol ? "▸" : "▾"}</button><span class="g-name" title="${esc(f.name)}${L("（點一下展開 / 收合）", " (click to expand / collapse)")}">${esc(f.name)}</span>${Store.siteTag(f.site, siteColors)}<button class="mini edit-only" type="button" data-editpfam="${f.id}" title="${L("編輯 PFAM", "Edit PFAM")}">✎</button><button class="mini edit-only" type="button" data-addtask="${f.id}" title="${L("在這個 PFAM 新增 task", "Add a task to this PFAM")}">＋</button>`,
          meta: !ts.length ? `<span class="muted">${L(`尚無 task${Store.editing ? "，按 ＋ 新增" : ""}`, `No task yet${Store.editing ? ", click ＋ to add" : ""}`)}</span>` : `${ts.length} task${late ? L(`・<b class="late">${late} 逾期</b>`, ` · <b class="late">${late} overdue</b>`) : ""}`,
          bars: isCol ? [{ id: "f:" + f.id, start: s.start, end: s.end, color: "var(--summary)", text: "" }] : [],
        });
        tipFor.set("f:" + f.id, `<b>${esc(f.name)}</b>${multi ? `<div class="muted">${esc(proj.name)}</div>` : ""}<div>${U.range(s.start, s.end)}${L(`・${ts.length} 個 task${late ? `・${late} 逾期` : ""}`, ` · ${ts.length} task(s)${late ? ` · ${late} overdue` : ""}`)}</div>${ppl.length ? `<div>${names(ppl)}</div>` : `<div class="muted">${L("尚未指派", "Not assigned yet")}</div>`}${f.notes ? `<div>${esc(f.notes)}</div>` : ""}`);
        if (isCol) continue;
        let sec = null;
        for (const t of vis) {
          if (t.section && t.section !== sec) {
            sec = t.section;
            rows.push({ id: "s:" + f.id + sec, kind: "sub", rc: proj.color, cls: multi ? "nested" : "", label: `<span class="g-sec">${esc(sec)}</span>`, bars: [] });
          }
          const k = M.status(t, today);
          const ph = Store.phase(t.phase);
          rows.push({
            id: "t:" + t.id,
            kind: "task",
            rc: proj.color,
            cls: `st-${k}` + (ui.focusTask === t.id ? " focus" : "") + (multi ? " nested" : ""),
            label: `<span class="g-name" title="${esc(t.name)}">${esc(t.name)}</span>${delta(t)}`,
            meta: t.assignees.length ? names(t.assignees) : `<span class="tag ghost">${L("未指派", "Unassigned")}</span>`,
            bars: [{ id: "t:" + t.id, start: D(t.start), end: D(t.end), color: ph ? ph.color : "var(--nophase)", cls: `st-${k}`, text: "", base: t.baseStart ? { start: D(t.baseStart), end: D(t.baseEnd) } : null }],
          });
          tipFor.set(
            "t:" + t.id,
            `<b>${esc(t.name)}</b>${statusPill(k)}${multi ? `<div class="muted">${esc(proj.name)} › ${esc(f.name)}</div>` : ""}<div>${U.fmt(t.start, "wd")} – ${U.fmt(t.end, "wd")}・${L(`${M.workdays(t.start, t.end, hol)} 個工作天`, `${M.workdays(t.start, t.end, hol)} workdays`)}</div>
             ${t.baseStart ? `<div class="muted">${L("基準", "Baseline")} ${U.range(t.baseStart, t.baseEnd)} ${delta(t)}</div>` : ""}
             <div>${L("指派：", "Assigned: ")}${t.assignees.length ? names(t.assignees) : L("未指派", "Unassigned")}</div>
             ${ph ? `<div class="muted">Phase${L("：", ": ")}${esc(ph.label)}</div>` : ""}${t.lead ? `<div class="muted">LEAD${L("：", ": ")}${esc(t.lead)}</div>` : ""}${t.notes ? `<div class="tt-note">${esc(t.notes)}</div>` : ""}
             ${Store.editing ? `<div class="tt-hint">${L("點一下編輯", "Click to edit")}</div>` : ""}`
          );
        }
      }
    }
    const zoom = ui.zoom || "week";
    const r = { from: win.from, to: win.to };
    Charts.gantt(el, rows, {
      from: r.from,
      to: r.to,
      zoom,
      fit: true,
      today,
      scrollToDay: pin != null ? pin : win.focusDay,
      band,
      marks: pin != null ? [{ day: pin, cls: "pin", title: L("標記日", "Marked day") }] : [],
      labelHead: `${multi ? "Project / PFAM / task" : "PFAM / task"}<span class="muted">${L("指派", "Assigned")}</span>`,
      tip: (id) => tipFor.get(id),
      onBar: (id) => {
        if (id.startsWith("t:") && Store.editing) Editors.task(id.slice(2));
        else if (id.startsWith("f:") && Store.editing) Editors.pfam(id.slice(2));
        else if (id.startsWith("p:")) App.go("#/projects/" + id.slice(2));
      },
      onLabel: (rowId, ev) => {
        if (ev.target.closest("a")) return; // "開啟 ›" link
        const add = ev.target.closest("[data-addtask]");
        if (add) return Editors.task(null, { pfamId: add.dataset.addtask });
        const ed = ev.target.closest("[data-editpfam]");
        if (ed) {
          Store.setUi({ focusPfam: ed.dataset.editpfam });
          return Editors.pfam(ed.dataset.editpfam);
        }
        const id = rowId.slice(2);
        // Anywhere on a Project / PFAM label (arrow or name) folds / unfolds it.
        if (rowId.startsWith("p:")) return fold.set({ [id]: !fold.folded(id, "proj") });
        if (rowId.startsWith("f:")) return fold.set({ [id]: !fold.folded(id, "pfam") });
        if (rowId.startsWith("t:")) {
          if (Store.editing) Editors.task(id);
          else App.toast(L("切換到「編輯模式」才能修改", "Turn on Edit mode to make changes"));
        }
      },
    });
    // Bring a newly focused task (or PFAM) into view once; later re-renders keep the highlight but don't scroll.
    const key = ui.focusTask || ui.focusPfam || "";
    if (key && key !== scrolledTo) {
      const target = el.querySelector(".g-row.task.focus") || el.querySelector(".g-row.group.focus");
      if (target) {
        scrolledTo = key;
        setTimeout(() => {
          target.scrollIntoView({ block: "center", behavior: "smooth" });
          target.classList.add("flash");
        }, 50);
      }
    }
    return { from: r.from, to: r.to, zoom };
  }

  // ---------------------------------------------------------------- table
  function renderTable(el, scopes, keep, today, multi, siteColors) {
    const rows = [];
    for (const { proj, pfams } of scopes) {
      const pr = [];
      for (const f of pfams) {
        const all = Store.tasksOf(f.id);
        const ts = all.filter(keep);
        if (!ts.length && all.length && !isOthers(f)) continue;
        pr.push(`<tr class="grp"><th colspan="7">${esc(f.name)} ${Store.siteTag(f.site, siteColors)}<button class="mini edit-only" type="button" data-addtask="${f.id}">＋ task</button>${all.length ? "" : ` <span class="muted small">${L("尚無 task", "No task yet")}</span>`}</th></tr>`);
        for (const t of ts) {
          const k = M.status(t, today);
          const ph = Store.phase(t.phase);
          pr.push(`<tr data-task="${t.id}" class="st-${k}">
            <td>${esc(t.name)}${t.section ? `<small class="muted"> · ${esc(t.section)}</small>` : ""}</td>
            <td>${ph ? `<span class="phase" style="--c:${ph.color}">${esc(ph.label)}</span>` : ""}</td>
            <td class="num">${U.fmt(t.start, "yy")}</td><td class="num">${U.fmt(t.end, "yy")} ${delta(t)}</td>
            <td>${t.assignees.length ? names(t.assignees) : `<span class="tag ghost">${L("未指派", "Unassigned")}</span>`}</td>
            <td>${statusPill(k)}</td><td class="muted small">${esc(t.lead || "")}</td></tr>`);
        }
      }
      if (multi && pr.length) rows.push(`<tr class="proj-grp"><th colspan="7" style="--c:${proj.color}"><i class="dot"></i>${esc(proj.name)}</th></tr>`);
      rows.push(...pr);
    }
    el.innerHTML = `<div class="table-wrap"><table class="grid-table"><thead><tr><th>Task</th><th>Phase</th><th>${L("開始", "Start")}</th><th>${L("結束", "End")}</th><th>${L("指派", "Assigned")}</th><th>${L("狀態", "Status")}</th><th>LEAD</th></tr></thead><tbody>${rows.join("") || `<tr><td colspan="7" class="empty">${L("沒有符合條件的 task", "No matching task")}</td></tr>`}</tbody></table></div>`;
    el.onclick = (ev) => {
      const add = ev.target.closest("[data-addtask]");
      if (add) return Editors.task(null, { pfamId: add.dataset.addtask });
      const tr = ev.target.closest("tr[data-task]");
      if (tr && Store.editing) Editors.task(tr.dataset.task);
    };
  }

  // ---------------------------------------------------------------- people allocation
  /**
   * Under the Gantt: every person's tasks on the same time axis (scrolls together with the Gantt), one row per PFAM.
   */
  function renderAllocation(el, proj, projects, range, today, pfamIds) {
    const multi = !proj;
    const sel = new Set(projects.map((p) => p.id));
    const zoom = (range && range.zoom) || Store.ui.zoom || "week";
    const r = range || Charts.rangeFor(projects.map((p) => M.span(Store.tasksOfProject(p.id))), today, zoom);
    el.hidden = false;
    el.innerHTML = `
      <header class="card-h"><h3>${L("人力分配", "Assignments")}</h3>
        <span class="muted">${multi ? L("所有專案的 task 依人排列・顏色 = 專案・紅色底線 = 超出部門人力的日子", "All projects' tasks by person · color = project · red underline = days over department headcount") : L("參與這個專案的人・顏色 = Phase", "People on this project · color = Phase")}${range ? L("・與上方甘特圖同一時間軸", " · same time axis as the Gantt above") : ""}</span>
        <a class="hbtn ghost" href="#/load">${L("完整人力資源", "Full Workload")}${PfamBand.ICON.arrow}</a></header>
      <div id="allocPeople"></div>
      ${multi ? `<div class="legend">${projects.map((p) => `<span class="lg"><i style="background:${p.color}"></i>${esc(p.name)}</span>`).join("")}</div>` : ""}`;

    // Alert days only make sense for the whole department.
    const days = multi ? M.load(Store.data, r.from, r.to, { today, projectIds: sel, pfamIds, isOthers: Convert.isOthers }) : [];
    LoadView.renderPeople($("#allocPeople"), days, sel, r.from, r.to, today, { zoom, fit: true, involvedOnly: !multi, byPhase: !multi, pfamIds });

    // Keep the people timeline scrolled with the Gantt above.
    const a = document.querySelector("#projView .g-scroll");
    const b = el.querySelector("#allocPeople .g-scroll");
    if (a && b) {
      b.scrollLeft = a.scrollLeft;
      let lock = false;
      const link = (src, dst) =>
        src.addEventListener("scroll", () => {
          if (lock) return;
          lock = true;
          dst.scrollLeft = src.scrollLeft;
          requestAnimationFrame(() => (lock = false));
        });
      link(a, b);
      link(b, a);
    }
  }

  /** Open a task (or PFAM) from another page: highlighted, scrolled into view, period stretched if needed. */
  function focus(pfamId, taskId) {
    scrolledTo = "";
    Store.setUi({ focusPfam: pfamId, focusTask: taskId || "" });
  }

  window.ProjectsView = { render, focus };
})();
