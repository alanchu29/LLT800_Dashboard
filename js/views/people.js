/* 出差紀錄: roster with trip stats (task details live in 人力資源), yearly trip days, a trip calendar; one person's detail. */
(function () {
  const E = window.Engine;
  const M = window.Model;
  const { esc, fmt, $ } = U;
  const D = (iso) => (iso ? E.toDay(iso) : null);

  /** Location -> color: the same colors as the PFAM site tags. */
  const locColors = () => Store.siteColors();

  function taskLine(t, today) {
    const k = M.status(t, today);
    const f = Store.pfam(t.pfamId);
    const p = f && Store.project(f.projectId);
    return `<li data-task="${t.id}" class="st-${k}"><span class="dot" style="--c:${p ? p.color : "#888"}"></span><span class="a-main">${esc(t.name)}<small>${esc(p ? p.name : "")} › ${esc(f ? f.name : "")}</small></span><span class="a-side"><span class="pill st-${k}">${M.STATUS[k].icon} ${M.STATUS[k].label}</span>${U.range(t.start, t.end)}</span></li>`;
  }

  /** KPI list, one line each: "● name ： N 天" (name left, days right). items: [[name, color, days]] */
  function distList(items) {
    if (!items.length) return `<span class="kpi-v">—</span>`;
    return `<ul class="dist">${items.map(([n, c, d]) => `<li><i style="background:${c}"></i><span class="d-name">${esc(n)}</span><span class="d-v"><b>${d}</b> ${L("天", "d")}</span></li>`).join("")}</ul>`;
  }

  function render(root, arg) {
    const data = Store.data;
    const today = U.today();
    const year = Store.ui.year || +E.fromDay(today).slice(0, 4);
    const stats = M.tripStats(data, year);
    const colors = locColors();
    const emps = [...data.employees].sort((a, b) => (b.active - a.active) || 0);
    const person = arg && Store.emp(arg);
    const yearTrips = data.trips.filter((r) => M.tripDaysInYear(r, year) > 0);
    const totalDays = [...stats.values()].reduce((n, s) => n + s.total, 0);
    const byLoc = new Map();
    for (const s of stats.values()) for (const [l, n] of s.byLocation) byLoc.set(l, (byLoc.get(l) || 0) + n);
    const locs = [...colors.keys()].filter((l) => byLoc.has(l));
    // Trip days per linked project (fixed project order; "" = no project linked).
    const byProj = new Map();
    for (const s of stats.values()) for (const [k, n] of s.byProject) byProj.set(k, (byProj.get(k) || 0) + n);
    const projKeys = [...Store.projects().map((p) => p.id), ""].filter((k) => byProj.has(k));
    const projName = (k) => (k ? (Store.project(k) || {}).name || L("(已刪除專案)", "(deleted project)") : L("未指定", "None"));
    const projColor = (k) => (k ? (Store.project(k) || {}).color || NO_PROJECT : NO_PROJECT);

    root.innerHTML = `
      <div class="page-head"><h2>${L("出差紀錄", "Trips")}</h2>
        <div class="seg year" role="group" aria-label="${L("年度", "Year")}"><button type="button" id="yPrev" aria-label="${L("前一年", "Previous year")}">‹</button><b>${L(`${year} 年`, `${year}`)}</b><button type="button" id="yNext" aria-label="${L("下一年", "Next year")}">›</button></div>
        <span class="grow"></span>
        <button class="btn edit-only" id="addEmp" type="button">${L("＋ 新增員工", "＋ Add person")}</button>
        <button class="btn primary edit-only" id="addTrip" type="button">${L("＋ 出差紀錄", "＋ Trip")}</button>
      </div>
      <div id="pDetail"></div>
      <section class="kpis small">
        <div class="kpi"><span class="kpi-l">${L(`${year} 出差總天數`, `${year} trip days`)}</span><span class="kpi-v">${totalDays}<small> ${L("天", "days")}</small></span><span class="kpi-s">${L("日曆天，跨年按天數拆分", "Calendar days, split at year end")}</span></div>
        <div class="kpi"><span class="kpi-l">${L("出差人次", "Trips")}</span><span class="kpi-v">${yearTrips.length}</span><span class="kpi-s">${L(`${stats.size} 人出過差`, `${stats.size} people traveled`)}</span></div>
        <div class="kpi"><span class="kpi-l">${L("專案分布", "By project")}</span>${distList(projKeys.map((k) => [projName(k), projColor(k), byProj.get(k)]))}</div>
        <div class="kpi"><span class="kpi-l">${L("地點分布", "By location")}</span>${distList(locs.map((l) => [l, colors.get(l), byLoc.get(l)]))}</div>
      </section>
      <section class="card"><header class="card-h"><h3>${L("出差中與即將出差", "On a trip and upcoming")}</h3><span class="muted">${L("今天起還沒結束的出差・點一筆可編輯", "Trips not over yet・click one to edit")}</span></header><div id="pUpcoming"></div></section>
      <section class="card"><header class="card-h"><h3>${L("名冊", "Roster")}</h3><span class="muted">${L(`出差統計與下次出差；每個人的任務明細在<a href="#/load">人力資源</a>`, `Trip stats and next trip; task details per person are in <a href="#/load">Workload</a>`)}</span></header><div id="pRoster"></div></section>
      <section class="card"><header class="card-h"><h3>${L(`${year} 年度出差天數`, `${year} trip days`)}</h3><div class="ptabs" role="tablist" aria-label="${L("分組", "Group by")}" id="statTabs"><button type="button" role="tab" data-stat="project">${L("依專案", "By project")}</button><button type="button" role="tab" data-stat="location">${L("依地點", "By location")}</button></div></header><div id="pStats"></div><div class="legend" id="pStatsLegend"></div></section>
      <section class="card"><header class="card-h"><h3>${L(`${year} 出差行事曆`, `${year} trip calendar`)}</h3><span class="muted">${L("顏色 = 地點", "Color = location")}${Store.editing ? L("・點出差條可編輯", "・click a trip bar to edit") : ""}</span></header><div id="pCal"></div>
        <div class="legend">${locs.map((l) => `<span class="lg"><i style="background:${colors.get(l)}"></i>${esc(l)}</span>`).join("")}</div></section>`;

    $("#yPrev").onclick = () => (Store.setUi({ year: year - 1 }), App.render());
    $("#yNext").onclick = () => (Store.setUi({ year: year + 1 }), App.render());
    $("#addEmp").onclick = () => Editors.employee(null);
    $("#addTrip").onclick = () => Editors.trip(null, { empId: person ? person.id : "" });

    renderUpcoming($("#pUpcoming"), colors, today);
    renderRoster($("#pRoster"), emps, stats, today, person);
    const drawStats = () => {
      U.$$("#statTabs [data-stat]").forEach((b) => {
        b.classList.toggle("on", b.dataset.stat === statMode);
        b.setAttribute("aria-selected", String(b.dataset.stat === statMode));
      });
      renderStats($("#pStats"), emps, stats, colors);
    };
    U.$$("#statTabs [data-stat]").forEach((b) => (b.onclick = () => ((statMode = b.dataset.stat), drawStats())));
    drawStats();
    renderCalendar($("#pCal"), emps, year, colors, today);
    if (person) renderDetail($("#pDetail"), person, year, stats.get(person.id), colors, today);
  }

  // 出差中與即將出差: every trip not yet over (independent of the year picker); ongoing ones first.
  function renderUpcoming(el, colors, today) {
    const list = Store.data.trips.filter((r) => D(r.end) >= today).sort((a, b) => a.start.localeCompare(b.start) || Store.empName(a.empId).localeCompare(Store.empName(b.empId)));
    if (!list.length) {
      el.innerHTML = `<p class="empty">${L("目前沒有出差中或已排定的出差。", "No current or planned trips.")}${Store.editing ? L("按「＋ 出差紀錄」新增。", " Use “＋ Trip” to add one.") : ""}</p>`;
      return;
    }
    el.innerHTML = `<ul class="trip-list">${list
      .map((r) => {
        const on = D(r.start) <= today;
        const days = D(r.end) - D(r.start) + 1;
        const wait = D(r.start) - today;
        const p = r.projectId && Store.project(r.projectId);
        const when = on ? `<b class="on-tag">${L(`出差中・第 ${today - D(r.start) + 1} / ${days} 天`, `On a trip・day ${today - D(r.start) + 1} / ${days}`)}</b>` : `<small class="muted">${wait === 1 ? L("明天出發", "Leaves tomorrow") : L(`${wait} 天後出發`, `Leaves in ${wait} days`)}</small>`;
        return `<li data-trip="${r.id}" class="${on ? "on" : ""}" title="${L("點一下編輯", "Click to edit")}"><span class="loc" style="--c:${colors.get((r.location || "").trim()) || "#8a8f98"}">${esc(r.location)}</span><span class="t-main"><span><a href="#/people/${r.empId}">${esc(Store.empName(r.empId))}</a> <small class="muted">${days} ${L("天", "d")}</small></span><small>${esc(r.purpose || "")}${p ? `${r.purpose ? "・" : ""}${esc(p.name)}` : ""}${r.notes ? `・${esc(r.notes)}` : ""}</small></span><span class="t-side">${when}${U.range(r.start, r.end)}</span></li>`;
      })
      .join("")}</ul>`;
    el.onclick = (ev) => {
      if (ev.target.closest("a")) return;
      const li = ev.target.closest("[data-trip]");
      if (li) Editors.trip(li.dataset.trip);
    };
  }

  function renderRoster(el, emps, stats, today, person) {
    if (!emps.length) {
      el.innerHTML = `<p class="empty">${L("名冊是空的。", "The roster is empty.")}${Store.editing ? L("按「＋ 新增員工」。", " Use “＋ Add person”.") : L("切換編輯模式後即可新增。", " Turn on Edit mode to add people.")}</p>`;
      return;
    }
    const rows = emps
      .map((e) => {
        const mine = Store.data.tasks.filter((t) => t.assignees.includes(e.id));
        const now = mine.filter((t) => M.status(t, today) === "active" || M.status(t, today) === "late");
        const lateN = now.filter((t) => M.status(t, today) === "late").length;
        const s = stats.get(e.id);
        const trip = Store.data.trips.filter((r) => r.empId === e.id && D(r.end) >= today).sort((a, b) => a.start.localeCompare(b.start))[0];
        const onTrip = trip && D(trip.start) <= today;
        return `<tr data-emp="${e.id}" class="${e.active ? "" : "gone"}${person && person.id === e.id ? " on" : ""}">
          <th>${esc(e.name)}${e.active ? "" : `<span class="tag ghost">${L("已離開", "Left")}</span>`}${onTrip ? `<span class="tag trip">${L("出差中", "On a trip")} · ${esc(trip.location)}</span>` : ""}</th>
          <td>${now.length ? `<b>${now.length}</b> ${L("件", "task(s)")}${lateN ? `・<b class="late">${L(`逾期 ${lateN}`, `${lateN} overdue`)}</b>` : ""}` : `<span class="muted">—</span>`}</td>
          <td class="num">${s ? `<b>${s.total}</b> ${L("天", "d")}<small class="muted">・${L(`${s.count} 次`, `${s.count}×`)}</small>` : `<span class="muted">0</span>`}</td>
          <td>${trip && !onTrip ? `${esc(trip.location)} <small class="muted">${fmt(trip.start, "short")}</small>` : `<span class="muted">—</span>`}</td>
        </tr>`;
      })
      .join("");
    el.innerHTML = `<div class="table-wrap"><table class="grid-table roster"><thead><tr><th>${L("姓名", "Name")}</th><th>${L("進行中 task", "Tasks in progress")}</th><th>${L("年度出差", "Trips this year")}</th><th>${L("下次出差", "Next trip")}</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    el.onclick = (ev) => {
      const tr = ev.target.closest("tr[data-emp]");
      if (tr) App.go("#/people/" + tr.dataset.emp);
    };
  }

  // 年度出差天數: split each person's days by project (default on every page load) or by location.
  let statMode = "project";
  const NO_PROJECT = "#9aa3ae";

  function renderStats(el, emps, stats, colors) {
    // Segments in a fixed order so a project / location keeps its color and position.
    const byProj = statMode === "project";
    const keys = byProj
      ? [...Store.projects().map((p) => p.id), ""].filter((k) => [...stats.values()].some((s) => s.byProject.has(k)))
      : [...colors.keys()].filter((l) => [...stats.values()].some((s) => s.byLocation.has(l)));
    const colorOf = (k) => (byProj ? (k ? (Store.project(k) || {}).color || NO_PROJECT : NO_PROJECT) : colors.get(k));
    const nameOf = (k) => (byProj ? (k ? (Store.project(k) || {}).name || L("(已刪除專案)", "(deleted project)") : L("未指定專案", "No project")) : k);
    const legend = U.$("#pStatsLegend");
    if (legend) legend.innerHTML = keys.map((k) => `<span class="lg"><i style="background:${colorOf(k)}"></i>${esc(nameOf(k))}</span>`).join("");
    const list = emps.filter((e) => stats.has(e.id) || e.active).map((e) => ({ e, s: stats.get(e.id) })).sort((a, b) => (b.s ? b.s.total : 0) - (a.s ? a.s.total : 0));
    const max = Math.max(1, ...list.map((x) => (x.s ? x.s.total : 0)));
    const top = Math.max(0, ...list.map((x) => (x.s ? x.s.total : 0))); // 冠軍 (ties all get the crown; none when nobody travelled)
    const CROWN = `<svg class="hb-crown" viewBox="0 0 24 24" aria-label="${L("冠軍", "Top")}"><path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z"/><circle cx="3" cy="7" r="1.6"/><circle cx="12" cy="4" r="1.6"/><circle cx="21" cy="7" r="1.6"/></svg>`;
    el.innerHTML = list.length
      ? `<div class="hbars">${list
          .map(({ e, s }) => {
            const m = s ? (byProj ? s.byProject : s.byLocation) : null;
            const segs = m
              ? keys
                  .filter((k) => m.has(k))
                  .map((k) => `<i style="width:${(m.get(k) / max) * 100}%;background:${colorOf(k)}" data-tip="${esc(L(`${e.name}・${nameOf(k)}：${m.get(k)} 天`, `${e.name}・${nameOf(k)}: ${m.get(k)} days`))}"></i>`)
                  .join("")
              : "";
            return `<a class="hbar" href="#/people/${e.id}"><span class="hb-name">${top && s && s.total === top ? CROWN : `<i class="hb-crown"></i>`}${esc(e.name)}</span><span class="hb-track">${segs}</span><span class="hb-v">${s ? s.total : 0}</span></a>`;
          })
          .join("")}</div>`
      : `<p class="empty">${L("沒有資料", "No data")}</p>`;
    el.onmousemove = (ev) => {
      const i = ev.target.closest("[data-tip]");
      if (i) U.tip.show(esc(i.dataset.tip), ev);
      else U.tip.hide();
    };
    el.onmouseleave = () => U.tip.hide();
  }

  function renderCalendar(el, emps, year, colors, today) {
    const from = E.toDay(`${year}-01-01`);
    const to = E.toDay(`${year}-12-31`);
    const tip = new Map();
    const rows = emps
      .filter((e) => e.active || Store.data.trips.some((r) => r.empId === e.id && M.tripDaysInYear(r, year)))
      .map((e) => {
        const trips = Store.data.trips.filter((r) => r.empId === e.id && M.tripDaysInYear(r, year));
        return {
          id: "e:" + e.id,
          kind: "person",
          label: `<a class="g-name" href="#/people/${e.id}">${esc(e.name)}</a>`,
          meta: trips.length ? `${trips.reduce((n, r) => n + M.tripDaysInYear(r, year), 0)} ${L("天", "days")}` : "",
          bars: trips.map((r) => {
            const p = r.projectId && Store.project(r.projectId);
            tip.set("r:" + r.id, `<b>${esc(e.name)}・${esc(r.location)}</b><div>${U.fmt(r.start, "wd")} – ${U.fmt(r.end, "wd")}・${D(r.end) - D(r.start) + 1} ${L("天", "days")}</div>${r.purpose ? `<div>${esc(r.purpose)}</div>` : ""}${p ? `<div class="muted">${esc(p.name)}</div>` : ""}${r.notes ? `<div class="tt-note">${esc(r.notes)}</div>` : ""}`);
            return { id: "r:" + r.id, start: D(r.start), end: D(r.end), color: colors.get((r.location || "其他").trim() || "其他") || "#8a8f98", text: r.location };
          }),
        };
      });
    Charts.gantt(el, rows, { from, to, zoom: "month", fit: true, today, labelHead: L("員工", "People"), outLabels: false, clipText: true, tip: (id) => tip.get(id), onBar: (id) => Store.editing && Editors.trip(id.slice(2)), scrollToToday: false });
  }

  function renderDetail(el, e, year, s, colors, today) {
    const mine = Store.data.tasks.filter((t) => t.assignees.includes(e.id));
    const cur = mine.filter((t) => ["active", "late"].includes(M.status(t, today))).sort((a, b) => a.end.localeCompare(b.end));
    const next = mine.filter((t) => M.status(t, today) === "future").sort((a, b) => a.start.localeCompare(b.start)).slice(0, 8);
    const trips = Store.data.trips.filter((r) => r.empId === e.id && M.tripDaysInYear(r, year)).sort((a, b) => b.start.localeCompare(a.start));
    el.innerHTML = `<section class="card detail">
      <header class="card-h"><h3>${esc(e.name)}${e.active ? "" : ` <span class="tag ghost">${L("已離開", "Left")}</span>`}</h3>
        <span class="muted">${L(`${mine.length} 個指派的 task・${year} 出差 ${s ? s.total : 0} 天`, `${mine.length} assigned task(s)・${s ? s.total : 0} trip days in ${year}`)}</span><span class="grow"></span>
        <button class="btn edit-only" id="editEmp" type="button">${L("編輯員工", "Edit person")}</button>
        <button class="btn edit-only" id="addTrip2" type="button">${L("＋ 出差", "＋ Trip")}</button>
        <a class="icon" href="#/people" aria-label="${L("關閉", "Close")}">✕</a></header>
      <div class="detail-grid">
        <div><h4>${L(`目前任務（${cur.length}）`, `Current tasks (${cur.length})`)}</h4>${cur.length ? `<ul class="tlist">${cur.map((t) => taskLine(t, today)).join("")}</ul>` : `<p class="muted">${L("目前沒有進行中的 task", "No task in progress")}</p>`}
          <h4>${L("即將開始", "Coming up")}</h4>${next.length ? `<ul class="tlist">${next.map((t) => taskLine(t, today)).join("")}</ul>` : `<p class="muted">${L("沒有排定的 task", "No planned task")}</p>`}</div>
        <div><h4>${L(`${year} 出差紀錄（${trips.length}）`, `${year} trips (${trips.length})`)}</h4>
          ${s ? `<div class="loc-split">${[...colors.keys()].filter((l) => s.byLocation.has(l)).map((l) => `<span><i style="background:${colors.get(l)}"></i>${esc(l)} ${s.byLocation.get(l)} ${L("天", "d")}</span>`).join("")}</div>` : ""}
          ${trips.length ? `<ul class="trip-list">${trips.map((r) => {
            const p = r.projectId && Store.project(r.projectId);
            return `<li data-trip="${r.id}"><span class="loc" style="--c:${colors.get((r.location || "").trim()) || "#8a8f98"}">${esc(r.location)}</span><span class="t-main">${U.range(r.start, r.end)} <small class="muted">${M.tripDaysInYear(r, year)} ${L("天", "d")}</small><small>${esc(r.purpose || "")}${p ? `・${esc(p.name)}` : ""}</small></span></li>`;
          }).join("")}</ul>` : `<p class="muted">${L("這一年沒有出差紀錄", "No trips this year")}</p>`}</div>
      </div></section>`;
    $("#editEmp").onclick = () => Editors.employee(e.id);
    $("#addTrip2").onclick = () => Editors.trip(null, { empId: e.id });
    el.onclick = (ev) => {
      const t = ev.target.closest("[data-task]");
      if (t) {
        const task = Store.task(t.dataset.task);
        if (Store.editing) return Editors.task(task.id);
        const f = Store.pfam(task.pfamId);
        ProjectsView.focus(f.id, task.id);
        return App.go("#/projects/" + f.projectId);
      }
      const r = ev.target.closest("[data-trip]");
      if (r && Store.editing) Editors.trip(r.dataset.trip);
    };
  }

  window.PeopleView = { render };
})();
