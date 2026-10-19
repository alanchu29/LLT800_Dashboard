/*
 * ADO Task: the department's open Azure DevOps work items, in two readings of the same snapshot.
 *   看板     - every open item, with facet filters, distribution bars and a sortable list
 *   我的成員 - the same items paired with the 員工名冊, so each member's ADO workload is visible
 *              next to the department's own tasks, and ADO accounts nobody on the roster owns stand out
 *
 * The snapshot comes from js/ado.js (REST or a CSV) and lives in this browser only - it is another
 * system's data, so it is never written into the department dataset or the cloud sheet. The one thing
 * that does belong to the dataset is the pairing: employee.ado, set in 編輯員工 or from this page.
 */
(function () {
  const A = window.AdoModel;
  const M = window.Model;
  const E = window.Engine;
  const { $, $$, esc } = U;

  const PHASE = new Map(A.PHASES.map((p) => [p.key, p]));
  const DIM_LABEL = { assignee: "負責人", type: "類型", state: "狀態", tag: "專案標籤", ageBucket: "停滯區間" };
  const QUICK_LABEL = { stale: `停滯 > ${A.STALE_DAYS - 1} 天`, unassigned: "未指派", noNoise: "排除 Worklog / Release Note", roster: "只看名冊成員", outside: "只看名冊外" };

  // Filters, sort and the open person live in this module: they are a way of looking at the page,
  // not data, so they survive re-renders but not a reload.
  const F = { search: "", assignee: [], type: [], state: [], tag: [], age: "", from: "", to: "", quick: {}, group: "", sort: "ageDays", dir: "desc" };
  let openEmp = "";
  let snapshot = null; // { at, records } -> memoised normalise() result, see rows()

  const redraw = () => App.render();

  /** The cached snapshot, normalised once per fetch (ageDays is measured against the day it is read). */
  function rows() {
    const cache = Ado.readCache();
    // A snapshot too big for localStorage lives in this module for the rest of the visit.
    if (!cache) return snapshot && snapshot.memory ? snapshot : null;
    if (!snapshot || snapshot.at !== cache.at || snapshot.day !== E.fromDay(U.today())) {
      const r = A.normalise(cache.records, { today: E.fromDay(U.today()) });
      snapshot = { at: cache.at, day: r.today, source: cache.source || "", rows: r.rows, dropped: r.dropped + (cache.dropped || 0) };
    }
    return snapshot;
  }

  const activeDims = () => A.DIMS.filter((d) => F[d].length);
  const anyFilter = () => !!(F.search || F.age || F.from || F.to || activeDims().length || Object.values(F.quick).some(Boolean));

  function clearAll() {
    F.search = "";
    F.age = F.from = F.to = "";
    F.quick = {};
    for (const d of A.DIMS) F[d] = [];
  }

  function toggleValue(dim, value) {
    const sel = F[dim];
    const i = sel.indexOf(value);
    if (i < 0) sel.push(value);
    else sel.splice(i, 1);
    redraw();
  }

  /** The filter the list and the bars use; roster / outside need the pairing, so they come in as extra. */
  function effective(pair) {
    const f = { ...F };
    const { roster, outside } = F.quick;
    if (roster || outside) {
      const names = new Set(pair.empOf.keys());
      f.extra = (r) => (roster ? names.has(r.assignee) : !names.has(r.assignee) && !r.unassigned);
    }
    return f;
  }

  // ------------------------------------------------------------------ small pieces of markup
  const stateTag = (r) => `<span class="ado-state ph-${r.phase}" title="${esc(PHASE.get(r.phase).label)}">${esc(r.state)}</span>`;

  function ageCell(r) {
    if (r.ageDays < 0) return `<span class="muted">—</span>`;
    const tone = (A.bucket(r.ageBucket) || {}).tone || "";
    return `<span class="ado-age${tone ? " t-" + tone : ""}">${r.ageDays}</span>`;
  }

  const idLink = (r) => (r.link ? `<a href="${esc(r.link)}" target="_blank" rel="noopener">${esc(r.id)}</a>` : esc(r.id));

  const tagChips = (r) => r.tags.slice(0, 4).map((t) => `<span class="ado-tag">${esc(t)}</span>`).join("");

  /** Horizontal bars (the 出差天數 pattern): [{ key, value }] with click-to-filter. */
  function bars(pairs, opts) {
    if (!pairs.length) return `<p class="muted">沒有資料</p>`;
    const list = opts.limit ? pairs.slice(0, opts.limit) : pairs;
    const max = Math.max(1, ...list.map((p) => p.value));
    const sel = opts.selected || [];
    return `<div class="hbars">${list
      .map(
        (p) => `<button type="button" class="hbar${sel.includes(p.key) ? " on" : ""}" data-pick="${esc(opts.dim)}" data-val="${esc(p.key)}" title="${esc(opts.label ? opts.label(p.key) : p.key)}">
          <span class="hb-name">${esc(opts.label ? opts.label(p.key) : p.key)}</span>
          <span class="hb-track"><i style="width:${(p.value / max) * 100}%;background:${opts.color || "var(--s1)"}"></i></span>
          <span class="hb-v">${p.value}</span></button>`
      )
      .join("")}${opts.limit && pairs.length > opts.limit ? `<p class="muted ado-more">其餘 ${pairs.length - opts.limit} 項未顯示</p>` : ""}</div>`;
  }

  /** One item as a list row: used in the member detail and in 名冊外的負責人. */
  function itemLine(r) {
    return `<li><span class="a-main"><span class="ado-line">${idLink(r)} ${esc(r.title)}</span><small>${esc(r.type)}${r.area ? " · " + esc(r.area) : ""}</small></span>
      <span class="a-side">${stateTag(r)}${ageCell(r)}<small class="muted">${r.changed ? U.fmt(r.changed, "short") : "—"}</small></span></li>`;
  }

  // ------------------------------------------------------------------ page
  function render(root, arg) {
    const tab = arg === "members" ? "members" : "board";
    const snap = rows();
    const cfg = Ado.cfg();

    root.innerHTML = `
      <div class="page-head"><h2>ADO Task</h2>
        <div class="seg" role="group" aria-label="檢視">
          <button type="button" data-tab="board" class="${tab === "board" ? "on" : ""}">看板</button>
          <button type="button" data-tab="members" class="${tab === "members" ? "on" : ""}">我的成員</button>
        </div>
        <span class="grow"></span>
        <button class="btn primary" id="adoFetch" type="button">${snap ? "⟳ 重新擷取" : "⟳ 從 ADO 擷取"}</button>
        <button class="btn" id="adoCsv" type="button">載入 CSV…</button>
        <button class="btn" id="adoCfg" type="button">ADO 設定</button>
      </div>
      <p class="ado-src muted">${
        snap
          ? `${esc(snap.source || `${cfg.org} / ${cfg.project}`)}・擷取於 <b>${esc(new Date(snap.at).toLocaleString("zh-TW", { hour12: false }))}</b>・${snap.rows.length} 筆未完成${
              snap.dropped ? `（已濾掉 ${snap.dropped} 筆結案）` : ""
            }・停滯天數以 ${esc(snap.day)} 為基準`
          : `尚未擷取資料。資料只存在這台電腦，不會寫入部門資料或雲端。`
      }</p>
      <div id="adoBody"></div>
      <input type="file" id="adoFile" accept=".csv,text/csv" hidden>`;

    $$("[data-tab]", root).forEach((b) => (b.onclick = () => App.go("#/ado" + (b.dataset.tab === "members" ? "/members" : ""))));
    $("#adoFetch").onclick = () => fetchNow();
    $("#adoCsv").onclick = () => $("#adoFile").click();
    $("#adoCfg").onclick = () => openConfig();
    $("#adoFile").onchange = async (ev) => {
      const file = ev.target.files[0];
      if (file) await loadCsv(file);
      ev.target.value = "";
    };

    const body = $("#adoBody");
    if (!snap) return renderEmpty(body, cfg);
    const pair = A.matchRoster(snap.rows, Store.data.employees);
    if (tab === "members") renderMembers(body, snap, pair);
    else renderBoard(body, snap, pair);
  }

  function renderEmpty(el, cfg) {
    el.innerHTML = `<section class="card"><header class="card-h"><h3>先把 ADO 的工作項目拉進來</h3></header>
      <ol class="h-steps ado-steps">
        <li>到 <a href="https://dev.azure.com/${esc(cfg.org)}/_usersSettings/tokens" target="_blank" rel="noopener">Personal Access Tokens</a> 建一組 PAT，scope 只要勾 <b>Work Items (Read)</b>。</li>
        <li>按右上角 <b>⟳ 從 ADO 擷取</b>，貼上 PAT 即可。預設查 <b>${esc(cfg.org)} / ${esc(cfg.project)}</b> 的未完成項目（可在「ADO 設定」改）。</li>
        <li>沒有 PAT 也可以用 <b>載入 CSV…</b> 丟 ADO Queries 匯出的檔案。</li>
      </ol>
      <p class="muted">PAT 預設只記在這個分頁（勾「記住」才會存在這台電腦），而且只會送到 dev.azure.com。擷取回來的項目同樣只存在這台電腦。</p>
      <div class="row-end"><button class="btn" id="adoCsv2" type="button">載入 CSV…</button><button class="btn primary" id="adoFetch2" type="button">⟳ 從 ADO 擷取</button></div></section>`;
    $("#adoFetch2").onclick = () => fetchNow();
    $("#adoCsv2").onclick = () => $("#adoFile").click();
  }

  // ------------------------------------------------------------------ 看板
  function renderBoard(el, snap, pair) {
    const all = snap.rows;
    const f = effective(pair);
    const list = A.sort(A.filter(all, f), F.sort, F.dir);
    const rosterNames = new Set(pair.empOf.keys());
    const mine = all.filter((r) => rosterNames.has(r.assignee)).length;
    const outside = all.filter((r) => !rosterNames.has(r.assignee) && !r.unassigned).length;
    const stale = all.filter((r) => r.stale).length;
    const mid = A.median(all.filter((r) => r.ageDays >= 0).map((r) => r.ageDays));

    const kpi = (label, value, note, opts) =>
      `<${opts.act ? "button" : "div"} class="kpi${opts.tone ? " " + opts.tone : ""}${opts.on ? " on" : ""}"${opts.act ? ` type="button" data-kpi="${opts.act}"` : ""}>
        <span class="kpi-l">${esc(label)}</span><span class="kpi-v">${value}</span><span class="kpi-s">${note}</span></${opts.act ? "button" : "div"}>`;

    el.innerHTML = `
      <section class="kpis small ado-kpis">
        ${kpi("未完成項目", all.length, anyFilter() ? `篩選後 <b>${list.length}</b> 筆` : "點下方條件可篩選", { act: "clear", on: !anyFilter() })}
        ${kpi("名冊成員的項目", mine, `${pair.byEmp.size} 位成員・名冊 ${Store.data.employees.filter((e) => e.active).length} 人`, { act: "roster", on: !!F.quick.roster })}
        ${kpi("名冊外負責人", outside, `${pair.unmatched.size} 個未對應帳號`, { act: "outside", on: !!F.quick.outside, tone: pair.unmatched.size ? "" : "good" })}
        ${kpi("未指派", all.filter((r) => r.unassigned).length, "沒有 Assigned To", { act: "unassigned", on: !!F.quick.unassigned })}
        ${kpi(`停滯 > ${A.STALE_DAYS - 1} 天`, stale, `占 ${all.length ? Math.round((stale / all.length) * 100) : 0}%`, { act: "stale", on: !!F.quick.stale, tone: stale ? "bad" : "good" })}
        ${kpi("停滯中位數", mid, "天未更新", { tone: mid > 90 ? "bad" : "" })}
      </section>

      <section class="card ado-filters">
        <div class="toolbar wrap">
          <label class="field-inline grow"><span>搜尋</span><input type="search" id="fSearch" value="${esc(F.search)}" placeholder="標題、ID、負責人、料號…（多個字詞是 AND）" autocomplete="off"></label>
          <label class="field-inline"><span>停滯</span><select id="fAge">
            <option value="">全部</option>
            ${A.AGE_BUCKETS.map((b) => `<option value="${b.key}"${F.age === b.key ? " selected" : ""}>${esc(b.label)}</option>`).join("")}
            <option value="181-99999"${F.age === "181-99999" ? " selected" : ""}>超過 180 天</option>
          </select></label>
          <label class="field-inline"><span>更新日期</span><input type="date" id="fFrom" value="${esc(F.from)}" aria-label="最後更新起"> – <input type="date" id="fTo" value="${esc(F.to)}" aria-label="最後更新迄"></label>
          <label class="field-inline"><span>分組</span><select id="fGroup">
            <option value="">不分組</option>
            ${["assignee", "type", "state", "tag", "ageBucket"].map((d) => `<option value="${d}"${F.group === d ? " selected" : ""}>依${esc(DIM_LABEL[d])}</option>`).join("")}
          </select></label>
        </div>
        <div class="chips ado-quick">
          <span class="muted">快捷</span>
          ${Object.keys(QUICK_LABEL).map((k) => `<button type="button" class="chip${F.quick[k] ? " on" : ""}" style="--c:var(--brand)" data-quick="${k}">${esc(QUICK_LABEL[k])}</button>`).join("")}
        </div>
        ${A.DIMS.map((dim) => facetGroup(dim, all, f)).join("")}
        ${anyFilter() ? `<div class="ado-applied"><span class="muted">已套用</span>${appliedChips()}<button class="btn small" id="fClear" type="button">全部清除</button></div>` : ""}
      </section>

      <details class="card fold-card" id="adoCharts" ${Store.ui.adoChartsOpen === false ? "" : "open"}>
        <summary class="card-h"><h3>分布概況</h3><span class="muted">點長條即可套用篩選</span></summary>
        <div class="ado-charts">
          <div><h4>各負責人（${A.tally(list, "assignee").size} 人）</h4>${bars(A.toSortedPairs(A.tally(list, "assignee")), { dim: "assignee", selected: F.assignee, limit: 14 })}</div>
          <div><h4>狀態</h4>${bars(A.toSortedPairs(A.tally(list, "state")), { dim: "state", selected: F.state, color: "var(--s7)" })}</div>
          <div><h4>類型</h4>${bars(A.toSortedPairs(A.tally(list, "type")), { dim: "type", selected: F.type, color: "var(--s3)", limit: 10 })}</div>
          <div><h4>停滯天數</h4>${bars(
            A.AGE_BUCKETS.map((b) => ({ key: b.key, value: list.filter((r) => r.ageBucket === b.key).length })).filter((p) => p.value),
            { dim: "age", color: "var(--s2)", label: (k) => (A.bucket(k) || {}).label || k, selected: F.age ? [F.age] : [] }
          )}</div>
        </div>
      </details>

      <section class="card">
        <header class="card-h"><h3>項目清單</h3><span class="muted">${list.length} 筆${anyFilter() ? `（共 ${all.length}）` : ""}</span><span class="grow"></span>
          <button class="btn small" id="adoExport" type="button">匯出 CSV</button>
          <button class="btn small" id="adoMd" type="button">複製 Markdown</button></header>
        <div id="adoTable"></div>
      </section>`;

    // ---- filter inputs
    // A re-render replaces the box, so put the caret back where it was.
    $("#fSearch").oninput = U.debounce((ev) => {
      const at = ev.target.selectionStart;
      F.search = ev.target.value;
      redraw();
      const s = $("#fSearch");
      if (!s) return;
      s.focus();
      try {
        s.setSelectionRange(at, at);
      } catch {
        /* type=search may refuse selection in some browsers */
      }
    }, 250);
    $("#fAge").onchange = (ev) => ((F.age = ev.target.value), redraw());
    $("#fFrom").onchange = (ev) => ((F.from = ev.target.value), redraw());
    $("#fTo").onchange = (ev) => ((F.to = ev.target.value), redraw());
    $("#fGroup").onchange = (ev) => ((F.group = ev.target.value), redraw());
    $("#adoCharts").ontoggle = (ev) => Store.setUi({ adoChartsOpen: ev.target.open });
    if ($("#fClear")) $("#fClear").onclick = () => (clearAll(), redraw());

    el.onclick = (ev) => {
      const q = ev.target.closest("[data-quick]");
      if (q) {
        const k = q.dataset.quick;
        F.quick[k] = !F.quick[k];
        if (F.quick.roster && F.quick.outside) F.quick[k === "roster" ? "outside" : "roster"] = false; // mutually exclusive
        return redraw();
      }
      const kpiBtn = ev.target.closest("[data-kpi]");
      if (kpiBtn) {
        const k = kpiBtn.dataset.kpi;
        if (k === "clear") return (clearAll(), redraw());
        F.quick[k] = !F.quick[k];
        if (F.quick.roster && F.quick.outside) F.quick[k === "roster" ? "outside" : "roster"] = false;
        return redraw();
      }
      const pick = ev.target.closest("[data-pick]");
      if (pick) {
        if (pick.dataset.pick === "age") {
          F.age = F.age === pick.dataset.val ? "" : pick.dataset.val;
          return redraw();
        }
        return toggleValue(pick.dataset.pick, pick.dataset.val);
      }
      const off = ev.target.closest("[data-off]");
      if (off) {
        const [kind, val] = [off.dataset.off, off.dataset.val || ""];
        if (kind === "quick") F.quick[val] = false;
        else if (kind === "search") F.search = "";
        else if (kind === "age") F.age = "";
        else if (kind === "from") F.from = "";
        else if (kind === "to") F.to = "";
        else F[kind] = F[kind].filter((v) => v !== val);
        return redraw();
      }
    };

    $("#adoExport").onclick = () => {
      const header = Ado.HEADER.concat("Age");
      const recs = list.map((r) => ({
        "Assigned To": r.assignee,
        ID: r.id,
        "Work Item Type": r.type,
        State: r.state,
        "Changed Date": r.changed,
        "Created Date": r.created,
        Tags: r.tags.join("; "),
        "Area Path": r.area,
        "Iteration Path": r.iteration,
        Title: r.title,
        Link: r.link,
        Age: r.ageDays,
      }));
      U.download(`ado_${snap.day}.csv`, "﻿" + Ado.toCsv(header, recs), "text/csv;charset=utf-8");
    };
    $("#adoMd").onclick = async () => {
      const md = ["| ID | 負責人 | 狀態 | 停滯 | 標題 |", "|---|---|---|---|---|"]
        .concat(list.map((r) => `| ${r.id} | ${r.assignee} | ${r.state} | ${r.ageDays < 0 ? "—" : r.ageDays + "d"} | ${String(r.title).replace(/\|/g, "\\|")} |`))
        .join("\n");
      try {
        await navigator.clipboard.writeText(md);
        App.toast(`已複製 ${list.length} 筆（Markdown 表格）`);
      } catch {
        App.toast("瀏覽器不允許複製，請改用「匯出 CSV」", "error");
      }
    };

    renderTable($("#adoTable"), list, pair);
  }

  /** One foldable facet: every value of a dimension with its count after the other filters. */
  function facetGroup(dim, all, f) {
    const counts = A.facet(all, f, dim);
    const pairs = A.toSortedPairs(counts);
    const sel = F[dim];
    if (!pairs.length) return "";
    return `<details class="ado-facet"${sel.length ? " open" : ""}>
      <summary>${esc(DIM_LABEL[dim])} <span class="count">${sel.length ? `${sel.length} / ${pairs.length}` : pairs.length}</span></summary>
      <div class="chips">${pairs
        .map((p) => `<button type="button" class="chip${sel.includes(p.key) ? " on" : ""}" style="--c:var(--brand)" data-pick="${dim}" data-val="${esc(p.key)}">${esc(p.key)} <b>${p.value}</b></button>`)
        .join("")}</div></details>`;
  }

  function appliedChips() {
    const out = [];
    const chip = (kind, label, val) => `<button type="button" class="ado-chip" data-off="${kind}" data-val="${esc(val || "")}">${esc(label)} <span aria-hidden="true">✕</span></button>`;
    if (F.search) out.push(chip("search", `搜尋：${F.search}`));
    for (const dim of A.DIMS) for (const v of F[dim]) out.push(chip(dim, `${DIM_LABEL[dim]}：${v}`, v));
    if (F.age) out.push(chip("age", `停滯：${(A.bucket(F.age) || { label: "超過 180 天" }).label}`));
    if (F.from) out.push(chip("from", `更新 ≥ ${F.from}`));
    if (F.to) out.push(chip("to", `更新 ≤ ${F.to}`));
    for (const k of Object.keys(F.quick)) if (F.quick[k]) out.push(chip("quick", QUICK_LABEL[k], k));
    return `<div class="ado-chips">${out.join("")}</div>`;
  }

  const SORTS = [
    ["id", "ID", "col-id"],
    ["assignee", "負責人", ""],
    ["type", "類型", ""],
    ["state", "狀態", ""],
    ["changed", "最後更新", ""],
    ["ageDays", "停滯", "num"],
    ["title", "標題", ""],
  ];

  function renderTable(el, list, pair) {
    if (!list.length) {
      el.innerHTML = `<p class="empty">沒有符合條件的項目。${anyFilter() ? "試著放寬或清除篩選。" : ""}</p>`;
      return;
    }
    const head = SORTS.map(
      ([k, label, cls]) =>
        `<th class="${cls} sortable${F.sort === k ? " sorted" : ""}" data-sort="${k}" aria-sort="${F.sort === k ? (F.dir === "asc" ? "ascending" : "descending") : "none"}">${esc(label)}${
          F.sort === k ? `<span class="caret">${F.dir === "asc" ? "▲" : "▼"}</span>` : ""
        }</th>`
    ).join("");
    const row = (r) => {
      const empId = pair.empOf.get(r.assignee);
      return `<tr>
        <td class="col-id">${idLink(r)}</td>
        <td class="col-who">${r.unassigned ? `<span class="muted">${esc(r.assignee)}</span>` : esc(r.assignee)}${
          empId ? `<a class="tag" href="#/ado/members" title="名冊成員">名冊</a>` : r.unassigned ? "" : `<span class="tag ghost" title="名冊裡找不到這個 ADO 帳號">名冊外</span>`
        }</td>
        <td>${esc(r.type)}</td>
        <td>${stateTag(r)}</td>
        <td class="num">${r.changed ? esc(U.fmt(r.changed, "yy")) : "—"}</td>
        <td class="num">${ageCell(r)}</td>
        <td class="col-title">${r.link ? `<a href="${esc(r.link)}" target="_blank" rel="noopener">${esc(r.title)}</a>` : esc(r.title)}${tagChips(r)}</td>
      </tr>`;
    };
    const groups = A.group(list, F.group);
    const label = (k) => (F.group === "ageBucket" ? (A.bucket(k) || {}).label || k : k);
    const bodies = groups
      .map((g) =>
        F.group
          ? `<tbody class="ado-grp"><tr class="grp"><th colspan="7">${esc(label(g.key))} <span class="count">${g.rows.length}</span></th></tr>${g.rows.map(row).join("")}</tbody>`
          : `<tbody>${g.rows.map(row).join("")}</tbody>`
      )
      .join("");
    el.innerHTML = `<div class="table-wrap"><table class="grid-table ado-table"><thead><tr>${head}</tr></thead>${bodies}</table></div>`;
    $$("th[data-sort]", el).forEach(
      (th) =>
        (th.onclick = () => {
          const k = th.dataset.sort;
          if (F.sort === k) F.dir = F.dir === "asc" ? "desc" : "asc";
          else {
            F.sort = k;
            F.dir = k === "ageDays" || k === "changed" ? "desc" : "asc";
          }
          redraw();
        })
    );
  }

  // ------------------------------------------------------------------ 我的成員
  function renderMembers(el, snap, pair) {
    const today = U.today();
    const emps = [...Store.data.employees].sort((a, b) => b.active - a.active || 0);
    const matched = [...pair.byEmp.values()].reduce((n, rs) => n + rs.length, 0);
    const outsideRows = [...pair.unmatched.values()].reduce((n, rs) => n + rs.length, 0);
    const unassigned = snap.rows.filter((r) => r.unassigned);
    const withWork = emps.filter((e) => (pair.byEmp.get(e.id) || []).length).length;

    el.innerHTML = `
      <section class="kpis small">
        <div class="kpi"><span class="kpi-l">名冊成員的 ADO 項目</span><span class="kpi-v">${matched}</span><span class="kpi-s">${withWork} / ${emps.filter((e) => e.active).length} 位在職成員手上有項目</span></div>
        <div class="kpi${pair.unmatched.size ? " bad" : " good"}"><span class="kpi-l">名冊外的負責人</span><span class="kpi-v">${pair.unmatched.size}<small> 人</small></span><span class="kpi-s">${outsideRows} 筆項目・需要對應或確認</span></div>
        <div class="kpi"><span class="kpi-l">未指派</span><span class="kpi-v">${unassigned.length}</span><span class="kpi-s">ADO 上沒有 Assigned To</span></div>
        <div class="kpi"><span class="kpi-l">停滯 > ${A.STALE_DAYS - 1} 天</span><span class="kpi-v">${[...pair.byEmp.values()].flat().filter((r) => r.stale).length}</span><span class="kpi-s">成員手上最久沒更新的項目</span></div>
      </section>

      <section class="card"><header class="card-h"><h3>成員的 ADO 任務</h3>
        <span class="muted">依 ADO 項目數排序・點一列展開明細${Store.editing ? "" : "・對應 ADO 帳號需要編輯模式"}</span></header>
        <div id="mTable"></div></section>
      <div id="mDetail"></div>

      <section class="card"><header class="card-h"><h3>名冊外的負責人</h3><span class="muted">ADO 上有項目，但名冊裡找不到對應的人</span></header>
        <div id="mOutside"></div></section>

      ${
        unassigned.length
          ? `<section class="card"><header class="card-h"><h3>未指派的項目（${unassigned.length}）</h3><span class="muted">ADO 上沒有 Assigned To，誰都不會收到</span>
              <span class="grow"></span><button class="btn small" id="mGoUn" type="button">在看板中查看</button></header>
              <ul class="tlist ado-items">${A.sort(unassigned, "ageDays", "desc").slice(0, 12).map(itemLine).join("")}</ul>
              ${unassigned.length > 12 ? `<p class="muted">其餘 ${unassigned.length - 12} 筆請到看板查看</p>` : ""}</section>`
          : ""
      }`;

    renderMemberTable($("#mTable"), emps, pair, today);
    renderOutside($("#mOutside"), pair);
    if (openEmp) renderMemberDetail($("#mDetail"), openEmp, pair, today);
    if ($("#mGoUn"))
      $("#mGoUn").onclick = () => {
        clearAll();
        F.quick.unassigned = true;
        App.go("#/ado");
      };
  }

  function renderMemberTable(el, emps, pair, today) {
    const list = emps
      .map((e) => ({ e, rs: pair.byEmp.get(e.id) || [] }))
      .filter((x) => x.e.active || x.rs.length)
      .sort((a, b) => b.rs.length - a.rs.length);
    const maxN = Math.max(1, ...list.map((x) => x.rs.length));
    const rows = list
      .map(({ e, rs }) => {
        const stale = rs.filter((r) => r.stale).length;
        const own = Store.data.tasks.filter((t) => t.assignees.includes(e.id) && ["active", "late"].includes(M.status(t, today)));
        const last = rs.map((r) => r.changed).filter(Boolean).sort().pop();
        const segs = A.PHASES.map((p) => rs.filter((r) => r.phase === p.key).length)
          .map((n, i) => (n ? `<i class="ph-${A.PHASES[i].key}" style="width:${(n / maxN) * 100}%" title="${esc(A.PHASES[i].label)}：${n}"></i>` : ""))
          .join("");
        const aliases = A.aliasesOf(e);
        return `<tr data-emp="${e.id}" class="${e.active ? "" : "gone"}${openEmp === e.id ? " on" : ""}">
          <th>${esc(e.name)}${e.active ? "" : `<span class="tag ghost">已離開</span>`}${
            rs.length ? "" : aliases.length ? `<span class="tag ghost" title="已設定 ADO 帳號，但目前沒有未完成項目">無項目</span>` : `<span class="tag ghost" title="靠姓名比對不到 ADO 帳號，可在編輯員工填「ADO 帳號」">未對應</span>`
          }</th>
          <td class="num">${rs.length ? `<b>${rs.length}</b>` : `<span class="muted">0</span>`}</td>
          <td class="ado-mini"><span class="hb-track">${segs}</span></td>
          <td class="num">${stale ? `<b class="late">${stale}</b>` : `<span class="muted">—</span>`}</td>
          <td class="num">${own.length ? `${own.length} 件` : `<span class="muted">—</span>`}</td>
          <td class="num">${last ? esc(U.fmt(last, "yy")) : `<span class="muted">—</span>`}</td>
        </tr>`;
      })
      .join("");
    el.innerHTML = `<div class="table-wrap"><table class="grid-table roster ado-members">
      <thead><tr><th>姓名</th><th class="num">ADO 項目</th><th>狀態分布</th><th class="num">停滯 > ${A.STALE_DAYS - 1} 天</th><th class="num">部門 task 進行中</th><th class="num">最後更新</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
      <div class="legend">${A.PHASES.map((p) => `<span class="lg"><i class="ph-${p.key}"></i>${esc(p.label)}</span>`).join("")}</div>`;
    el.onclick = (ev) => {
      const tr = ev.target.closest("tr[data-emp]");
      if (!tr) return;
      openEmp = openEmp === tr.dataset.emp ? "" : tr.dataset.emp;
      redraw();
    };
  }

  function renderMemberDetail(el, empId, pair, today) {
    const e = Store.emp(empId);
    if (!e) {
      openEmp = "";
      return;
    }
    const rs = A.sort(pair.byEmp.get(empId) || [], "ageDays", "desc");
    const names = [...pair.empOf.entries()].filter(([, id]) => id === empId).map(([n]) => n);
    const own = Store.data.tasks.filter((t) => t.assignees.includes(empId) && ["active", "late"].includes(M.status(t, today)));
    el.innerHTML = `<section class="card detail">
      <header class="card-h"><h3>${esc(e.name)}</h3>
        <span class="muted">${rs.length} 筆 ADO 未完成項目${names.length ? `・對應帳號：${names.map(esc).join("、")}` : ""}</span><span class="grow"></span>
        <button class="btn small" id="mFilter" type="button">在看板中只看他／她</button>
        <button class="btn small edit-only" id="mAlias" type="button">設定 ADO 帳號</button>
        <button class="icon" id="mClose" type="button" aria-label="關閉">✕</button></header>
      <div class="detail-grid">
        <div><h4>ADO 未完成項目（${rs.length}）</h4>
          ${rs.length ? `<ul class="tlist ado-items">${rs.map(itemLine).join("")}</ul>` : `<p class="muted">目前沒有未完成的 ADO 項目。${A.aliasesOf(e).length ? "" : "若實際上有，請設定他／她的 ADO 帳號。"}</p>`}</div>
        <div><h4>部門 task（進行中 ${own.length}）</h4>
          ${
            own.length
              ? `<ul class="tlist">${own
                  .map((t) => {
                    const f = Store.pfam(t.pfamId);
                    const p = f && Store.project(f.projectId);
                    const k = M.status(t, today);
                    return `<li class="st-${k}"><span class="dot" style="--c:${p ? p.color : "#888"}"></span><span class="a-main">${esc(t.name)}<small>${esc(p ? p.name : "")} › ${esc(f ? f.name : "")}</small></span><span class="a-side"><span class="pill st-${k}">${M.STATUS[k].icon} ${M.STATUS[k].label}</span>${U.range(t.start, t.end)}</span></li>`;
                  })
                  .join("")}</ul>`
              : `<p class="muted">甘特圖上沒有進行中的 task</p>`
          }
          <p class="muted ado-note">ADO 項目來自 Azure DevOps，部門 task 來自這個 dashboard；兩邊是各自獨立的紀錄，這裡只是放在一起看他／她實際的負擔。</p>
          <p><a href="#/load">人力資源 ›</a> <a href="#/people/${esc(empId)}">出差紀錄 ›</a></p></div>
      </div></section>`;
    $("#mClose").onclick = () => ((openEmp = ""), redraw());
    $("#mFilter").onclick = () => {
      clearAll();
      F.assignee = names.slice();
      App.go("#/ado");
    };
    $("#mAlias").onclick = () => Editors.employee(empId);
  }

  function renderOutside(el, pair) {
    const list = [...pair.unmatched.entries()].sort((a, b) => b[1].length - a[1].length);
    if (!list.length) {
      el.innerHTML = `<p class="empty">每個 ADO 負責人都對應到名冊裡的人了。</p>`;
      return;
    }
    el.innerHTML = `<div class="table-wrap"><table class="grid-table"><thead><tr><th>ADO 負責人</th><th>帳號</th><th class="num">項目</th><th class="num">停滯</th><th></th></tr></thead><tbody>
      ${list
        .map(([name, rs]) => {
          const p = pair.people.find((x) => x.name === name) || {};
          return `<tr><th>${esc(name)}</th><td class="muted">${esc(p.email || "—")}</td><td class="num"><b>${rs.length}</b></td>
            <td class="num">${rs.filter((r) => r.stale).length || `<span class="muted">—</span>`}</td>
            <td class="ado-acts"><button class="btn small" data-see="${esc(name)}" type="button">查看</button><button class="btn small primary" data-map="${esc(name)}" type="button">對應到員工</button></td></tr>`;
        })
        .join("")}</tbody></table></div>
      <p class="muted">「對應到員工」會把這個 ADO 名稱寫進該員工的 <b>ADO 帳號</b>欄位（屬於部門資料，會同步到雲端給大家共用）。不是部門同事的話就不用處理。</p>`;
    el.onclick = (ev) => {
      const see = ev.target.closest("[data-see]");
      if (see) {
        clearAll();
        F.assignee = [see.dataset.see];
        return App.go("#/ado");
      }
      const map = ev.target.closest("[data-map]");
      if (map) mapToEmployee(map.dataset.map);
    };
  }

  /** Write an ADO display name into one employee's 帳號 list (an edit of department data). */
  async function mapToEmployee(name) {
    if (!(await App.requireEdit())) return;
    const emps = Store.data.employees.filter((e) => e.active);
    if (!emps.length) return App.toast("名冊是空的，先到「設定 › 員工名冊」新增員工", "error");
    const r = await App.form({
      title: `把「${name}」對應到員工`,
      fields: [
        { key: "empId", label: "員工", type: "select", options: emps.map((e) => ({ value: e.id, label: e.name })), wide: true },
        { key: "note", label: "記住對應", type: "check", text: "寫入該員工的「ADO 帳號」欄位", value: true, wide: true, hint: "不勾選就只是這次用這個名稱篩選看板，不會改到部門資料" },
      ],
      saveLabel: "對應",
    });
    if (!r || r.action !== "save") return;
    if (!r.values.note) {
      // A one-off pairing: treat it like a filter instead of changing shared data.
      clearAll();
      F.assignee = [name];
      return App.go("#/ado");
    }
    Store.commit((d) => {
      const e = d.employees.find((x) => x.id === r.values.empId);
      if (!e) return;
      const list = A.aliasesOf(e);
      if (!list.some((a) => A.fold(a) === A.fold(name))) list.push(name);
      e.ado = list.join(", ");
    });
    App.toast(`已把「${name}」對應到 ${Store.empName(r.values.empId)}`, "", [{ label: "復原", run: () => Store.undo() }]);
  }

  // ------------------------------------------------------------------ fetching
  async function fetchNow() {
    const cfg = Ado.cfg();
    if (!Ado.pat()) return openConfig();
    $("#blockerSkip").onclick = () => App.blocker(false);
    App.blocker(true, "正在向 ADO 擷取…");
    try {
      const r = await Ado.fetchOpenItems({ ...cfg, pat: Ado.pat(), onProgress: (m) => App.blocker(true, m) });
      saveSnapshot(r.records, `${cfg.org} / ${cfg.project}`);
      App.toast(`已擷取 ${r.records.length} 筆未完成項目`);
      redraw();
    } catch (err) {
      App.toast("擷取失敗：" + err.message, "error", err.kind === "auth" ? [{ label: "重新輸入 PAT", run: () => openConfig() }] : [{ label: "重試", run: () => fetchNow() }]);
    } finally {
      App.blocker(false);
    }
  }

  async function loadCsv(file) {
    try {
      const records = Ado.parseCsv(await U.readFile(file));
      if (!records.length) return App.toast("這個 CSV 裡沒有資料列", "error");
      const probe = A.normalise(records, { today: E.fromDay(U.today()) });
      if (!probe.rows.length && !probe.dropped) return App.toast("認不出這個 CSV 的欄位（需要 ID / Title / State 等 ADO 匯出欄位）", "error");
      saveSnapshot(records, file.name);
      App.toast(`已載入 ${probe.rows.length} 筆未完成項目${probe.dropped ? `（濾掉 ${probe.dropped} 筆結案）` : ""}`);
      redraw();
    } catch (err) {
      App.toast("讀取 CSV 失敗：" + err.message, "error");
    }
  }

  function saveSnapshot(records, source) {
    snapshot = null; // force a re-normalise on the next render
    const ok = Ado.writeCache(records, { source, at: new Date().toISOString() });
    if (!ok) {
      // Too big (or no quota) for localStorage: keep it in memory for this page only.
      const r = A.normalise(records, { today: E.fromDay(U.today()) });
      snapshot = { at: new Date().toISOString(), day: r.today, source: source + "（未存入本機）", rows: r.rows, dropped: r.dropped, memory: true };
      App.toast("資料量太大，這次的擷取結果只留在這個分頁，重新整理後需要再擷取一次。");
    }
  }

  /** Connection settings and the PAT. The PAT never goes into the dataset, the URL or a log. */
  async function openConfig() {
    const cfg = Ado.cfg();
    const r = await App.form({
      title: "ADO 連線設定",
      saveLabel: "儲存並擷取",
      extra: Ado.patRemembered() || Ado.pat() ? [{ value: "forget", label: "清除已存的 PAT" }] : [],
      fields: [
        { key: "org", label: "組織", value: cfg.org, required: true },
        { key: "project", label: "專案", value: cfg.project, required: true },
        { key: "pat", label: "PAT", type: "password", value: Ado.pat(), wide: true, required: true, hint: "在 ADO 的 User settings → Personal access tokens 建立，scope 只要勾 Work Items (Read)。只會送到 dev.azure.com。" },
        { key: "remember", label: "PAT 保存方式", type: "check", text: "記住 PAT（存在這台電腦）", value: Ado.patRemembered(), hint: "不勾選只記在這個分頁，關掉就消失；共用電腦建議不要勾" },
        { key: "where", label: "額外條件（WIQL）", value: cfg.where, more: true, wide: true, placeholder: "[System.AreaPath] UNDER 'Monica\\Gen11'" },
        { key: "queryId", label: "已存查詢 GUID", value: cfg.queryId, more: true, wide: true, hint: "填了就改用 ADO 上存好的查詢，忽略上面的額外條件" },
      ],
    });
    if (!r) return;
    if (r.action === "forget") {
      Ado.forgetPat();
      return App.toast("已清除這台電腦上儲存的 PAT");
    }
    if (r.action !== "save") return;
    const { pat, remember, ...rest } = r.values;
    Ado.setCfg(rest);
    Ado.setPat(pat, remember);
    fetchNow();
  }

  /** 設定 › ADO Task: drop everything this browser keeps about ADO (snapshot, settings' PAT). */
  function forget() {
    Ado.clearCache();
    Ado.forgetPat();
    snapshot = null;
  }

  /** What 設定 shows about this browser's ADO state. */
  function status() {
    const snap = rows();
    return { cfg: Ado.cfg(), count: snap ? snap.rows.length : 0, at: snap ? snap.at : "", pat: Ado.patRemembered() ? "remembered" : Ado.pat() ? "session" : "none" };
  }

  window.AdoView = { render, openConfig, forget, status };
})();
