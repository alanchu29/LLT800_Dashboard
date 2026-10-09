/* 總覽 (home): KPI tiles, -7..+30 days per project, people heat map (next month), upcoming trips, things that need attention. */
(function () {
  const E = window.Engine;
  const M = window.Model;
  const { esc, fmt } = U;
  const D = (iso) => (iso ? E.toDay(iso) : null);
  const HEAT_DAYS = 30; // 人力熱度: today .. today + 30
  const TRIP_DAYS = 60; // 近期出差: on a trip now or leaving within 60 days
  const SOON_BEFORE = 7; // 專案總覽: today - 7 ..
  const SOON_AFTER = 30; //            .. today + 30

  const ICON = PfamBand.ICON;

  function kpi(label, value, sub, cls, href) {
    const attr = !href ? "" : href.startsWith("scroll:") ? `href="javascript:void 0" onclick="document.getElementById('${href.slice(7)}').scrollIntoView({behavior:'smooth'})"` : `href="${href}"`;
    return `<a class="kpi ${cls || ""}" ${attr}><span class="kpi-l">${label}</span><span class="kpi-v">${value}</span><span class="kpi-s">${sub || ""}</span></a>`;
  }

  function people(ids) {
    if (!ids.length) return `<span class="tag ghost">未指派</span>`;
    return ids.map((id) => `<span class="pname${Store.emp(id) && !Store.emp(id).active ? " gone" : ""}">${esc(Store.empName(id))}</span>`).join("");
  }

  function render(root) {
    const data = Store.data;
    const today = U.today();
    const ws = M.weekStart(today);
    const live = Store.liveProjects();
    const liveIds = new Set(live.map((p) => p.id));
    const livePfam = new Set(data.pfams.filter((f) => liveIds.has(f.projectId)).map((f) => f.id));
    const tasks = data.tasks.filter((t) => livePfam.has(t.pfamId));
    const st = new Map(tasks.map((t) => [t.id, M.status(t, today)]));

    // KPIs
    const activeProjects = live.filter((p) => Store.tasksOfProject(p.id).some((t) => st.get(t.id) === "active"));
    const weekTasks = tasks.filter((t) => st.get(t.id) !== "done" && D(t.start) <= ws + 6 && D(t.end) >= ws);
    const late = tasks.filter((t) => st.get(t.id) === "late").sort((a, b) => a.end.localeCompare(b.end));
    const loadDays = M.load(data, today, today + HEAT_DAYS, { today, projectIds: liveIds });
    const now = loadDays.find((d) => d.day >= today);
    const [yy, mm] = E.fromDay(today).split("-");
    const mStart = E.toDay(`${yy}-${mm}-01`);
    const mEnd = E.toDay(new Date(Date.UTC(+yy, +mm, 0)).toISOString().slice(0, 10));
    const monthTrips = data.trips.filter((r) => D(r.start) <= mEnd && D(r.end) >= mStart);

    const kpis = [
      kpi("進行中專案", activeProjects.length, `共 ${live.length} 個未封存專案`, "", "#/projects"),
      kpi("本週進行中 task", weekTasks.length, `${fmt(ws, "short")} – ${fmt(ws + 6, "short")}`, "", "#/projects"),
      kpi("逾期 task", late.length, late.length ? "過了結束日仍未完成" : "沒有逾期", late.length ? "bad" : "good", late.length ? "scroll:overview-attn" : ""),
      now
        ? kpi(
            now.day === today ? "今日忙碌人數" : `${fmt(now.day, "wd")} 忙碌人數`,
            `${now.busy.size}<small>/${now.head}</small>`,
            now.alert ? "⚠ 超出部門人力" : `${now.idle.length} 人有空${now.unassigned.size ? `・${now.unassigned.size} 個 PFAM 未指派` : ""}`,
            now.alert ? "bad" : "",
            "#/load"
          )
        : kpi("今日忙碌人數", "—", "", "", "#/load"),
      kpi("本月出差", `${monthTrips.length}<small> 人次</small>`, `${new Set(monthTrips.map((r) => r.empId)).size} 人・${+mm} 月`, "", "#/people"),
    ].join("");

    root.innerHTML = `
      <p class="ov-date muted">${fmt(today, "full")}</p>
      <section class="kpis">${kpis}</section>
      <section class="card ov-attn" id="overview-attn" hidden><header class="card-h"><h3><span class="attn-ic">⚠</span>需要注意</h3><span class="muted" id="ovAttnSum"></span></header><div id="ovAttn"></div></section>
      <section class="card"><header class="card-h"><h3>專案總覽</h3><span class="muted">${fmt(today - SOON_BEFORE, "wd")} – ${fmt(today + SOON_AFTER, "wd")}（前 7 天到後 30 天）未完成的 PFAM 與 task</span>
        <div class="hctl"><button class="hbtn pfl-toggle" id="pflToggle" type="button"></button><button class="hbtn" id="soonToggle" type="button"></button><a class="hbtn ghost" href="#/projects/all">專案甘特${ICON.arrow}</a></div></header>
        <div id="ovPin"></div><div id="ovSoon"></div></section>
      <div class="ov-grid">
        <section class="card ov-heat"><header class="card-h"><h3>人力熱度</h3><div class="ptabs" role="tablist" aria-label="計算方式" id="heatTabs"><button type="button" role="tab" data-heat="pfam">PFAM</button><button type="button" role="tab" data-heat="task">Task</button></div><span class="muted">未來一個月（${fmt(today, "short")} – ${fmt(today + HEAT_DAYS, "short")}）・每格 = 當天手上的 <span id="heatUnit"></span> 數</span><a class="hbtn ghost" href="#/load">人力資源${ICON.arrow}</a></header><div id="ovHeat"></div></section>
        <section class="card ov-trips"><header class="card-h"><h3>近期出差</h3><span class="muted">出差中與未來 60 天</span><a class="hbtn ghost" href="#/people">出差紀錄${ICON.arrow}</a></header><div id="ovTrips"></div></section>
      </div>`;

    renderSoon(U.$("#ovSoon"), live, today, st);
    renderAttention(U.$("#ovAttn"), tasks, st, today, late);
    const drawHeat = () => {
      U.$$("#heatTabs [data-heat]").forEach((b) => {
        b.classList.toggle("on", b.dataset.heat === heatMode);
        b.setAttribute("aria-selected", String(b.dataset.heat === heatMode));
      });
      U.$("#heatUnit").textContent = heatMode === "pfam" ? "PFAM" : "task";
      renderHeat(U.$("#ovHeat"), loadDays, today);
    };
    U.$$("#heatTabs [data-heat]").forEach((b) => (b.onclick = () => ((heatMode = b.dataset.heat), drawHeat())));
    drawHeat();
    renderTrips(U.$("#ovTrips"), today);
  }

  /**
   * The next two weeks, per project: Project -> PFAM -> task rows on a day axis that fills the card.
   * Only unfinished tasks overlapping [today - SOON_BEFORE, today + SOON_AFTER] (overdue ones included). Rows fold like the project Gantt; the fold state lasts until the page is reloaded (a reload starts fully expanded).
   */
  // 同時進行的 PFAM 數: a band above the 專案總覽 date rows (same days); open on every page load.
  let pflOpen = true; // open on every page load (the toggle hides it until reload)
  let pin = null; // day picked on the band (session only)
  let pinOnly = true; // with a pinned day: list only the PFAMs / tasks running that day

  let soonFold = {}; // 專案總覽 folded rows: kept while the page is open, not saved (a reload starts expanded)

  function renderSoon(el, live, today, st) {
    const from = today - SOON_BEFORE;
    const to = today + SOON_AFTER;
    const hol = M.holidays(Store.data);
    const saved = soonFold;
    const setFold = (patch) => {
      soonFold = { ...saved, ...patch };
      App.render();
    };
    const shown = []; // project / PFAM ids listed now (only these count for the toggle)
    const who = (ids) => esc(ids.map((id) => Store.empName(id)).join("、"));
    if (pin != null && (pin < from || pin > to)) pin = null;
    // A pinned day lists what the band counted that day (done tasks included for past days), else unfinished tasks in the window.
    const pinned = pin != null && pinOnly;
    const soon = (t) => (pinned ? !!(t.start && t.end) && M.occupies(t, pin, today) : st.get(t.id) !== "done" && t.start && t.end && D(t.start) <= to && D(t.end) >= from);
    const rows = [];
    const tip = new Map();
    const siteColors = Store.siteColors();
    let nTasks = 0;
    for (const p of live) {
      const pf = Store.pfamsOf(p.id)
        .map((f) => ({ f, ts: Store.tasksOf(f.id).filter(soon).sort((a, b) => a.start.localeCompare(b.start)) }))
        .filter((x) => x.ts.length)
        .sort((a, b) => a.ts[0].start.localeCompare(b.ts[0].start));
      if (!pf.length) continue;
      const pts = pf.flatMap((x) => x.ts);
      nTasks += pts.length;
      const ppl = [...new Set(pts.flatMap((t) => t.assignees))];
      const pFold = !!saved[p.id] && !(pin != null && pinOnly);
      shown.push(p.id);
      const ps = M.span(pts);
      rows.push({
        id: "p:" + p.id,
        kind: "proj",
        label: `<button class="tw" type="button" aria-label="展開/收合" aria-expanded="${!pFold}">${pFold ? "▸" : "▾"}</button><i class="dot" style="--c:${p.color}"></i><span class="g-name" title="點一下展開 / 收合">${esc(p.name)}</span><a class="open-link" href="#/projects/${p.id}" title="到專案甘特">開啟 ›</a>`,
        meta: `${pf.length} PFAM・${pts.length} task・${ppl.length} 人`,
        // Span bars only when folded: open, the rows below already show the same span.
        bars: pFold ? [{ id: "p:" + p.id, start: ps.start, end: ps.end, color: p.color }] : [],
      });
      tip.set("p:" + p.id, `<b>${esc(p.name)}</b><div>期間內 ${pf.length} 個 PFAM、${pts.length} 個 task</div>${ppl.length ? `<div class="muted">${who(ppl)}</div>` : ""}`);
      if (pFold) continue;
      for (const { f, ts } of pf) {
        const fFold = !!saved[f.id] && !(pin != null && pinOnly);
        shown.push(f.id);
        const fs = M.span(ts);
        rows.push({
          id: "f:" + f.id,
          kind: "group",
          rc: p.color,
          cls: "nested",
          label: `<button class="tw" type="button" aria-label="展開/收合" aria-expanded="${!fFold}">${fFold ? "▸" : "▾"}</button><span class="g-name" title="${esc(f.name)}（點一下展開 / 收合）">${esc(f.name)}</span>${Store.siteTag(f.site, siteColors)}`,
          meta: `${ts.length} task`,
          bars: fFold ? [{ id: "f:" + f.id, start: fs.start, end: fs.end, color: "var(--summary)" }] : [],
        });
        tip.set("f:" + f.id, `<b>${esc(f.name)}</b><div class="muted">${esc(p.name)}</div>${ts.map((t) => `<div class="tt-row"><span>${esc(t.name)}</span><small>${U.range(t.start, t.end)}</small></div>`).join("")}`);
        if (fFold) continue;
        for (const t of ts) {
          const k = st.get(t.id);
          const ph = Store.phase(t.phase);
          const inDays = D(t.start) - today;
          const when =
            k === "active" ? `<span class="pill st-active">進行中</span>`
            : k === "late" ? `<span class="pill st-late">逾期 ${today - D(t.end)} 天</span>`
            : k === "done" ? `<span class="pill st-done">已完成</span>`
            : `<span class="pill st-future">${inDays === 1 ? "明天" : `${inDays} 天後`}開始</span>`;
          rows.push({
            id: "t:" + t.id,
            kind: "task",
            rc: p.color,
            cls: "nested st-" + k,
            label: `<span class="g-name" title="${esc(t.name)}">${esc(t.name)}</span>${when}`,
            meta: t.assignees.length ? who(t.assignees) : `<span class="tag ghost">未指派</span>`,
            bars: [{ id: "t:" + t.id, start: D(t.start), end: D(t.end), color: ph ? ph.color : "var(--nophase)", cls: "st-" + k, text: t.name }],
          });
          tip.set(
            "t:" + t.id,
            `<b>${esc(t.name)}</b><div class="muted">${esc(p.name)} › ${esc(f.name)}</div><div>${U.fmt(t.start, "wd")} – ${U.fmt(t.end, "wd")}・${M.workdays(t.start, t.end, hol)} 個工作天</div>` +
              `<div>指派：${t.assignees.length ? who(t.assignees) : "未指派"}</div>${ph ? `<div class="muted">Phase：${esc(ph.label)}</div>` : ""}` +
              `${t.notes ? `<div class="tt-note">${esc(t.notes)}</div>` : ""}<div class="tt-hint">${Store.editing ? "點一下編輯" : "點一下到專案甘特"}</div>`
          );
        }
      }
    }
    // One toggle: anything folded -> "全部展開"; everything open -> "只看 Project".
    const anyFolded = shown.some((id) => saved[id]);
    const tg = U.$("#soonToggle");
    tg.innerHTML = anyFolded ? `${ICON.expand}<span>全部展開</span>` : `${ICON.collapse}<span>只看 Project</span>`;
    tg.onclick = () => {
      if (anyFolded) soonFold = {};
      else soonFold = Object.fromEntries(live.map((p) => [p.id, true]));
      App.render();
    };
    const pfl = PfamBand.build(live, from, to, today, { projCaps: true }); // also flag projects over their own 警戒上限
    PfamBand.button(U.$("#pflToggle"), pfl, pflOpen, () => {
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
    PfamBand.pinBar(U.$("#ovPin"), pfl, pin, pinOnly, {
      only: (v) => ((pinOnly = v), App.render()),
      clear: () => ((pin = null), App.render()),
    });
    if (!rows.length) {
      el.innerHTML = `<p class="empty">${live.length ? (pin != null && pinOnly ? "這天沒有進行中的 task。" : "這段期間沒有未完成的 task。") : `還沒有專案。<a href="#/projects">到「專案甘特」新增</a>，或到「設定」匯入 MONICA 資料。`}</p>`;
      return;
    }
    const goTask = (id) => {
      const t = Store.task(id);
      if (Store.editing) return Editors.task(id);
      const f = Store.pfam(t.pfamId);
      ProjectsView.focus(f.id, t.id);
      App.go("#/projects/" + f.projectId);
    };
    const toggle = (id) => setFold({ [id]: !saved[id] });
    Charts.gantt(el, rows, {
      from,
      to,
      zoom: "day",
      fit: true,
      today,
      scrollToToday: false,
      band: pflOpen ? pfl.band : null,
      marks: pin != null ? [{ day: pin, cls: "pin", title: "標記日" }] : [],
      labelHead: `Project / PFAM / task<span class="muted">${nTasks} 個 task・指派</span>`,
      tip: (id) => tip.get(id),
      onBar: (id) => (id.startsWith("t:") ? goTask(id.slice(2)) : toggle(id.slice(2))),
      onLabel: (rowId, ev) => {
        if (ev.target.closest("a")) return; // "開啟 ›" link
        if (rowId.startsWith("t:")) return goTask(rowId.slice(2));
        toggle(rowId.slice(2));
      },
    });
  }

  const UNASSIGNED_DAYS = 91; // 需要注意 › 未指派: tasks running now or starting within ~3 months

  const ATTN_N = 5;
  let attnAll = false;

  function renderAttention(el, tasks, st, today, late) {
    const activeIds = new Set(Store.activeEmployees().map((e) => e.id));
    const soon = today + UNASSIGNED_DAYS; // same horizon as the project Gantt's "後 3 月"
    const unassigned = tasks.filter((t) => st.get(t.id) !== "done" && t.start && D(t.start) <= soon && D(t.end) >= today && !t.assignees.some((id) => activeIds.has(id)));
    const byPfam = new Map();
    for (const t of unassigned) {
      if (!byPfam.has(t.pfamId)) byPfam.set(t.pfamId, []);
      byPfam.get(t.pfamId).push(t);
    }
    const gone = tasks.filter((t) => st.get(t.id) !== "done" && t.assignees.some((id) => Store.emp(id) && !Store.emp(id).active));
    const pf = (t) => {
      const f = Store.pfam(t.pfamId);
      return f ? f.name : "";
    };
    const section = (title, n, cls, body, empty) => `<div class="attn ${cls}"><h4>${title} <span class="count">${n}</span></h4>${n ? body : `<p class="muted small">${empty}</p>`}</div>`;
    // On top of the page: 5 per group, the rest behind "顯示全部".
    const lim = attnAll ? Infinity : ATTN_N;
    const more = (n, unit) => (n > ATTN_N ? `<button class="link small attn-more" type="button" data-attn-more>${attnAll ? "收起" : `顯示全部（還有 ${n - ATTN_N} ${unit}）`}</button>` : "");
    const lateBody = `<ul>${late
      .slice(0, lim)
      .map((t) => `<li data-task="${t.id}"><span class="a-main">${esc(t.name)}<small>${esc(pf(t))}</small></span><span class="a-side"><b class="late">逾期 ${today - D(t.end)} 天</b>${people(t.assignees)}</span></li>`)
      .join("")}</ul>${more(late.length, "個")}`;
    const unBody = `<ul>${[...byPfam.entries()]
      .sort((a, b) => a[1][0].start.localeCompare(b[1][0].start))
      .slice(0, lim)
      .map(([fid, ts]) => {
        const f = Store.pfam(fid);
        const first = ts.reduce((m, t) => (t.start < m ? t.start : m), ts[0].start);
        return `<li data-pfam="${fid}"><span class="a-main">${esc(f ? f.name : "")}<small>${esc(ts.slice(0, 2).map((t) => t.name).join("、"))}${ts.length > 2 ? ` 等 ${ts.length} 個 task` : ""}</small></span><span class="a-side">${D(first) <= today ? "進行中" : fmt(first, "short") + " 開始"}</span></li>`;
      })
      .join("")}</ul>${more(byPfam.size, "個 PFAM")}`;
    const goneBody = `<ul>${gone
      .slice(0, 6)
      .map((t) => `<li data-task="${t.id}"><span class="a-main">${esc(t.name)}<small>${esc(pf(t))}</small></span><span class="a-side">${people(t.assignees)}</span></li>`)
      .join("")}</ul>`;
    // Sits above 專案總覽 as a reminder; only the groups with something in them, and hidden when all are empty.
    const card = el.closest("section");
    const total = late.length + byPfam.size + gone.length;
    card.hidden = !total;
    if (!total) return;
    U.$("#ovAttnSum").textContent = `共 ${total} 項・點一下到專案甘特查看`;
    el.innerHTML =
      (late.length ? section("逾期 task", late.length, "a-late", lateBody, "") : "") +
      (byPfam.size ? section("未指派（進行中或 3 個月內開始）", byPfam.size, "a-un", unBody, "") : "") +
      (gone.length ? section("指派給已離開的人", gone.length, "a-gone", goneBody, "") : "");
    el.onclick = (ev) => {
      if (ev.target.closest("[data-attn-more]")) return (attnAll = !attnAll), App.render();
      const li = ev.target.closest("li");
      if (!li) return;
      const t = li.dataset.task && Store.task(li.dataset.task);
      const f = t ? Store.pfam(t.pfamId) : li.dataset.pfam && Store.pfam(li.dataset.pfam);
      if (f) {
        ProjectsView.focus(f.id, t ? t.id : "");
        App.go("#/projects/" + f.projectId);
      }
    };
  }

  // 人力熱度 tabs: "pfam" (default on every page load) = distinct PFAMs a person works in that day (each "Others"
  // task counts as one, like the PFAM load); "task" = tasks.
  let heatMode = "pfam";
  const heatUnits = (ts) => {
    const m = new Map(); // key -> { pfam, tasks }
    for (const t of ts) {
      const f = Store.pfam(t.pfamId);
      const key = Convert.isOthers(f) ? "t:" + t.id : t.pfamId;
      if (!m.has(key)) m.set(key, { pfam: f, tasks: [] });
      m.get(key).tasks.push(t);
    }
    return [...m.values()];
  };

  /** Next month, one column per workday: each cell = PFAMs (or tasks) the person has that day; the top row = department load. */
  function renderHeat(el, days, today) {
    const byPfam = heatMode === "pfam";
    const count = (ts) => (byPfam ? heatUnits(ts).length : ts.length);
    const emps = Store.workforce();
    if (!emps.length) {
      el.innerHTML = `<p class="empty">名冊是空的。<a href="#/people">到「出差紀錄」新增員工</a>。</p>`;
      return;
    }
    if (!days.length) {
      el.innerHTML = `<p class="empty">未來一個月沒有工作日。</p>`;
      return;
    }
    const lvl = (n) => (n >= 4 ? 5 : n); // 4 件以上 = darkest step
    const wk = (d) => (E.weekday(d.day) === 1 ? " wk" : "");
    let lastMon = "";
    const head = `<tr><th></th>${days
      .map((d) => {
        const iso = E.fromDay(d.day);
        const mon = iso.slice(5, 7);
        const showMon = mon !== lastMon;
        lastMon = mon;
        return `<th class="${d.day === today ? "now" : ""}${wk(d)}">${showMon ? `<small>${+mon}月</small>` : ""}${+iso.slice(8)}<em>${U.WD[E.weekday(d.day)]}</em></th>`;
      })
      .join("")}</tr>`;
    const deptRow = `<tr class="dept"><th>部門負載<small>忙碌 / 在職</small></th>${days
      .map((d) => {
        // Green while demand (busy + unassigned PFAMs) stays within the headcount (deeper as it fills up), red above it.
        const over = d.demand > d.head;
        const r = d.head ? d.demand / d.head : 0;
        const cls = over ? "alert" : `ok ok${r >= 0.8 ? 3 : r >= 0.5 ? 2 : 1}`;
        return `<td class="${cls}${wk(d)}" data-day="${d.day}">${d.busy.size}${d.unassigned.size ? `<small>+${d.unassigned.size}</small>` : ""}${over ? "<b>⚠</b>" : ""}</td>`;
      })
      .join("")}</tr>`;
    const rows = emps
      .map((e) => {
        const cells = days
          .map((d) => {
            const n = count(d.busy.get(e.id) || []);
            return `<td class="h${lvl(n)}${wk(d)}" data-emp="${e.id}" data-day="${d.day}">${n || ""}</td>`;
          })
          .join("");
        return `<tr><th><a href="#/people/${e.id}">${esc(e.name)}</a></th>${cells}</tr>`;
      })
      .join("");
    el.innerHTML = `<div class="heat-wrap"><table class="heat daily"><thead>${head}</thead><tbody>${deptRow}${rows}</tbody></table></div>
      <div class="legend"><span>當天 ${byPfam ? "PFAM" : "task"} 數</span>${[1, 2, 3, 5].map((n) => `<span class="lg"><i class="h${n}"></i>${n === 5 ? "4+" : n}</span>`).join("")}<span class="sep"></span><span class="lg"><i class="lg-ok"></i>部門負載在人力內</span><span class="lg-alert">⚠ 超出在職人數</span><span class="muted">「+n」＝未指派 PFAM 數</span></div>`;
    const byDay = new Map(days.map((d) => [d.day, d]));
    const t = el.querySelector("table");
    t.addEventListener("mousemove", (ev) => {
      const td = ev.target.closest("td[data-day]");
      if (!td) return U.tip.hide();
      const d = byDay.get(+td.dataset.day);
      if (!td.dataset.emp) return U.tip.show(Charts.loadTip(d), ev);
      const ts = d.busy.get(td.dataset.emp) || [];
      if (byPfam) {
        const us = heatUnits(ts);
        return U.tip.show(
          `<b>${esc(Store.empName(td.dataset.emp))}</b>・${fmt(d.day, "full")}<div class="tt-big">${us.length ? `${us.length} 個 PFAM・${ts.length} 件 task` : "空閒"}</div>${us
            .slice(0, 8)
            .map((u) => `<div class="tt-row"><span>${esc(u.pfam ? u.pfam.name : "")}</span><small>${esc(u.tasks.map((x) => x.name).join("、"))}</small></div>`)
            .join("")}${us.length > 8 ? `<div class="muted">…共 ${us.length} 個</div>` : ""}`,
          ev
        );
      }
      U.tip.show(
        `<b>${esc(Store.empName(td.dataset.emp))}</b>・${fmt(d.day, "full")}<div class="tt-big">${ts.length ? `${ts.length} 件 task` : "空閒"}</div>${ts
          .slice(0, 8)
          .map((x) => `<div class="tt-row"><span>${esc(x.name)}</span><small>${esc((Store.pfam(x.pfamId) || {}).name || "")}</small></div>`)
          .join("")}${ts.length > 8 ? `<div class="muted">…共 ${ts.length} 件</div>` : ""}`,
        ev
      );
    });
    t.addEventListener("mouseleave", () => U.tip.hide());
  }

  function renderTrips(el, today) {
    const list = Store.data.trips.filter((r) => D(r.end) >= today && D(r.start) <= today + TRIP_DAYS).sort((a, b) => a.start.localeCompare(b.start));
    if (!list.length) {
      el.innerHTML = `<p class="empty">出差中與未來 60 天都沒有出差紀錄。</p>`;
      return;
    }
    el.innerHTML = `<ul class="trip-list">${list
      .map((r) => {
        const on = D(r.start) <= today;
        const p = r.projectId && Store.project(r.projectId);
        return `<li class="${on ? "on" : ""}"><span class="loc">${esc(r.location)}</span><span class="t-main"><a href="#/people/${r.empId}">${esc(Store.empName(r.empId))}</a><small>${esc(r.purpose || "")}${p ? `・${esc(p.name)}` : ""}</small></span><span class="t-side">${on ? `<b class="on-tag">出差中</b>` : ""}${U.range(r.start, r.end)}</span></li>`;
      })
      .join("")}</ul>`;
  }

  window.OverviewView = { render };
})();
