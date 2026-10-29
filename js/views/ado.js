/*
 * ADO Task: the department's open Azure DevOps work items, in two readings of the same snapshot.
 *   看板     - every open item (recently finished ones too, with 含已完成), with facet filters,
 *              distribution bars and a sortable list
 *   我的成員 - the same items paired with the 員工名冊, so each member's ADO workload is visible
 *              and ADO accounts nobody on the roster owns stand out
 *
 * The snapshot comes from js/ado.js (REST or a CSV) and lives in this browser only - it is another
 * system's data, so it is never written into the department dataset or the cloud sheet. The one thing
 * that does belong to the dataset is the pairing: employee.ado, set in 編輯員工 or from this page.
 */
(function () {
  const A = window.AdoModel;
  const E = window.Engine;
  const { $, $$, esc } = U;

  const PHASE = new Map(A.PHASES.concat(A.DONE_PHASE).map((p) => [p.key, p]));
  const DIM_LABEL = { assignee: "負責人", type: "類型", state: "狀態", tag: "專案標籤", ageBucket: "停滯區間" };
  const QUICK_LABEL = { stale: `停滯 > ${A.STALE_DAYS - 1} 天`, noNoise: "排除 Worklog / Release Note", done: "含已完成" };
  // Whose items: a roster name, any other name, or nobody - disjoint, so at most one is on.
  const SCOPES = [["", "全部"], ["roster", "名冊成員"], ["outside", "名冊外"], ["unassigned", "未指派"]];
  const FACET_LIMIT = 12; // chips a facet shows before 更多

  // Filters, sort and the open person live in this module: they are a way of looking at the page,
  // not data, so they survive re-renders but not a reload.
  const F = { search: "", assignee: [], type: [], state: [], tag: [], age: "", from: "", to: "", quick: {}, group: "", sort: "ageDays", dir: "desc" };
  const moreOpen = new Set(); // facets showing every value
  let openEmp = "";
  let autoTried = false; // the one automatic fetch per visit (see maybeAutoFetch)
  let snapshot = null; // { at, records } -> memoised normalise() result, see rows()

  const redraw = () => App.render();

  /** rows: open items (what every workload view counts), done: closed ones, all: both (看板 with 含已完成). */
  function snapOf(records, at, source) {
    const r = A.normalise(records, { today: E.fromDay(U.today()) });
    return { at, day: r.today, source, rows: r.rows, done: r.done, all: r.rows.concat(r.done) };
  }

  /** The cached snapshot, normalised once per fetch (ageDays is measured against the day it is read). */
  function rows() {
    const cache = Ado.readCache();
    // A snapshot too big for localStorage lives in this module for the rest of the visit.
    if (!cache) return snapshot && snapshot.memory ? snapshot : null;
    if (!snapshot || snapshot.at !== cache.at || snapshot.day !== E.fromDay(U.today())) snapshot = snapOf(cache.records, cache.at, cache.source || "");
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

  /** A quick toggle or a scope ("" = every scope off). */
  function toggleQuick(k) {
    const on = !!k && !F.quick[k];
    if (!k || SCOPES.some(([s]) => s === k)) for (const [s] of SCOPES) if (s) F.quick[s] = false;
    if (k) F.quick[k] = on;
  }

  function toggleValue(dim, value) {
    const sel = F[dim];
    const i = sel.indexOf(value);
    if (i < 0) sel.push(value);
    else sel.splice(i, 1);
    redraw();
  }

  /**
   * The filter the list and the bars use; roster / outside need the pairing, so they come in as extra.
   * quick: the toggles to apply (default: all of F.quick) - the KPIs leave their own out.
   */
  function effective(pair, quick) {
    const f = { ...F, quick: quick || F.quick };
    const { roster, outside } = f.quick;
    if (roster || outside) {
      const names = new Set(pair.empOf.keys());
      f.extra = (r) => (roster ? names.has(r.assignee) : !names.has(r.assignee) && !r.unassigned);
    }
    return f;
  }

  // ------------------------------------------------------------------ small pieces of markup
  /** ADO display name -> how it is shown ("Dixon Chu WYHQ Wiwynn" -> "Dixon Chu"); the full name stays the filter value. */
  const shortOf = (k) => A.shortName(k);

  const stateTag = (r) => `<span class="ado-state ph-${r.phase}" title="${esc(PHASE.get(r.phase).label)}">${esc(r.state)}</span>`;

  function ageCell(r) {
    if (r.ageDays < 0) return `<span class="muted">—</span>`;
    const tone = r.closed ? "" : (A.bucket(r.ageBucket) || {}).tone || ""; // days since it was closed: nothing to warn about
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
              snap.done.length ? `、${snap.done.length} 筆已完成（勾「含已完成」才會顯示）` : ""
            }・停滯天數以 ${esc(snap.day)} 為基準`
          : `尚未擷取資料。資料只存在這台電腦，不會寫入部門資料或雲端。`
      }</p>
      <div id="adoBody"></div>
      <input type="file" id="adoFile" accept=".csv,text/csv" hidden>
      <input type="file" id="adoPatFile" hidden>`;

    $$("[data-tab]", root).forEach((b) => (b.onclick = () => App.go("#/ado" + (b.dataset.tab === "members" ? "/members" : ""))));
    $("#adoFetch").onclick = () => fetchNow();
    $("#adoCsv").onclick = () => $("#adoFile").click();
    $("#adoCfg").onclick = () => openConfig();
    $("#adoFile").onchange = async (ev) => {
      const file = ev.target.files[0];
      if (file) await loadCsv(file);
      ev.target.value = "";
    };
    $("#adoPatFile").onchange = async (ev) => {
      const file = ev.target.files[0];
      if (file) await readPatFile(file);
      ev.target.value = "";
    };

    const body = $("#adoBody");
    if (!snap) renderEmpty(body, cfg);
    else {
      // 我的成員 is a workload: open items only. The board pairs whatever it lists, so a finished item's
      // owner is not marked 名冊外 just for having nothing open.
      const pair = A.matchRoster(tab === "board" && F.quick.done ? snap.all : snap.rows, Store.data.employees);
      if (tab === "members") renderMembers(body, snap, pair);
      else renderBoard(body, snap, pair);
    }
    maybeAutoFetch(snap);
  }

  /**
   * Opening this page with a PAT already in hand (typically %USERPROFILE%\.ado_pat via
   * tools/ado_pat.ps1) fetches by itself, once per visit: nothing to paste, nothing to press.
   * Today's snapshot is good enough, so a second visit in the same day costs no request.
   * Without a PAT anywhere, say so once and leave it at that.
   */
  function maybeAutoFetch(snap) {
    if (autoTried) return;
    autoTried = true;
    if (!Ado.pat()) {
      if (!snap)
        App.toast(`找不到 PAT（${Ado.patFile()}）：請手動輸入，或選 .ado_pat 檔`, "", [
          { label: "輸入 PAT", run: () => openConfig() },
          { label: "載入 PAT 檔…", run: () => $("#adoPatFile").click() },
        ]);
      return;
    }
    if (snap && snap.day === E.fromDay(U.today())) return;
    fetchNow({ auto: true });
  }

  function renderEmpty(el, cfg) {
    el.innerHTML = `<section class="card"><header class="card-h"><h3>先把 ADO 的工作項目拉進來</h3></header>
      <ol class="h-steps ado-steps">
        <li>到 <a href="https://dev.azure.com/${esc(cfg.org)}/_usersSettings/tokens" target="_blank" rel="noopener">Personal Access Tokens</a> 建一組 PAT，scope 只要勾 <b>Work Items (Read)</b>。</li>
        <li>按右上角 <b>⟳ 從 ADO 擷取</b>，貼上 PAT 即可。預設查 <b>${esc(cfg.org)} / ${esc(cfg.project)}</b> 的未完成項目（可在「ADO 設定」改）。</li>
        <li>不想每次貼：把 PAT 存成單獨一行放在 <code>${esc(Ado.patFile())}</code>，跑一次 <code>powershell -ExecutionPolicy Bypass -File tools\\ado_pat.ps1</code>，之後每次開這一頁都會自動擷取。也可以直接按下面的 <b>載入 PAT 檔…</b> 選那個檔案。</li>
        <li>沒有 PAT 也可以用 <b>載入 CSV…</b> 丟 ADO Queries 匯出的檔案。</li>
      </ol>
      <p class="muted">PAT 預設只記在這個分頁（勾「記住」才會存在這台電腦），而且只會送到 dev.azure.com。擷取回來的項目同樣只存在這台電腦。</p>
      <div class="row-end"><button class="btn" id="adoPat2" type="button">載入 PAT 檔…</button><button class="btn" id="adoCsv2" type="button">載入 CSV…</button><button class="btn primary" id="adoFetch2" type="button">⟳ 從 ADO 擷取</button></div></section>`;
    $("#adoFetch2").onclick = () => fetchNow();
    $("#adoCsv2").onclick = () => $("#adoFile").click();
    $("#adoPat2").onclick = () => $("#adoPatFile").click();
  }

  // ------------------------------------------------------------------ 看板
  function renderBoard(el, snap, pair) {
    const all = F.quick.done ? snap.all : snap.rows;
    const f = effective(pair);
    const list = A.sort(A.filter(all, f), F.sort, F.dir);
    const rosterNames = new Set(pair.empOf.keys());
    // A KPI counts like a facet chip: every other filter applied, only its own toggle left out, so the
    // cards follow what the board shows (名冊成員 under 名冊外 is 0, as the list would be).
    const without = (key) => A.filter(all, effective(pair, { ...F.quick, [key]: false }));
    const mine = without("roster").filter((r) => rosterNames.has(r.assignee)).length;
    const unassigned = without("unassigned").filter((r) => r.unassigned).length;
    const stalePool = without("stale");
    const stale = stalePool.filter((r) => r.stale).length;
    // Like a facet chip: the finished items 含已完成 would add under every other filter.
    const doneHits = A.filter(snap.done, effective(pair, { ...F.quick, done: true })).length;
    const scopeOn = (SCOPES.find(([s]) => s && F.quick[s]) || [""])[0];

    const kpi = (label, value, note, opts) =>
      `<${opts.act ? "button" : "div"} class="kpi${opts.tone ? " " + opts.tone : ""}${opts.on ? " on" : ""}"${opts.act ? ` type="button" data-kpi="${opts.act}"` : ""}>
        <span class="kpi-l">${esc(label)}</span><span class="kpi-v">${value}</span><span class="kpi-s">${note}</span></${opts.act ? "button" : "div"}>`;

    el.innerHTML = `
      <section class="kpis small ado-kpis">
        ${kpi("未完成項目", snap.rows.length, anyFilter() ? `篩選後 <b>${list.length}</b> 筆` : "點下方條件可篩選", { act: "clear", on: !anyFilter() })}
        ${kpi("名冊成員的項目", mine, `${pair.byEmp.size} 位成員・名冊 ${Store.data.employees.filter((e) => e.active).length} 人`, { act: "roster", on: !!F.quick.roster })}
        ${kpi("未指派", unassigned, "沒有 Assigned To", { act: "unassigned", on: !!F.quick.unassigned })}
        ${kpi(`停滯 > ${A.STALE_DAYS - 1} 天`, stale, `占 ${stalePool.length ? Math.round((stale / stalePool.length) * 100) : 0}%`, { act: "stale", on: !!F.quick.stale, tone: stale ? "bad" : "good" })}
      </section>

      <section class="card ado-filters">
        <div class="toolbar wrap">
          <label class="field-inline grow"><span>搜尋</span><input type="search" id="fSearch" value="${esc(F.search)}" placeholder="標題、ID、負責人、料號…（多個字詞是 AND）" autocomplete="off"></label>
          <label class="field-inline"><span>停滯</span><select id="fAge">
            <option value="">全部</option>
            ${A.AGE_BUCKETS.map((b) => `<option value="${b.key}"${F.age === b.key ? " selected" : ""}>${esc(b.label)}</option>`).join("")}
          </select></label>
          <label class="field-inline"><span>更新日期</span><input type="date" id="fFrom" value="${esc(F.from)}" aria-label="最後更新起"> – <input type="date" id="fTo" value="${esc(F.to)}" aria-label="最後更新迄"></label>
        </div>
        <div class="ado-fgrid">
          <span class="fl">負責人範圍</span>
          <div class="fv"><div class="seg small" role="group" aria-label="負責人範圍">${SCOPES.map(
            ([k, label]) => `<button type="button" data-scope="${k}" class="${scopeOn === k ? "on" : ""}" aria-pressed="${scopeOn === k}">${esc(label)}</button>`
          ).join("")}</div>
            ${Object.keys(QUICK_LABEL)
              .map(
                (k) =>
                  `<button type="button" class="chip${F.quick[k] ? " on" : ""}${k === "done" && !doneHits ? " zero" : ""}" style="--c:var(--brand)" data-quick="${k}" aria-pressed="${!!F.quick[k]}"${
                    k === "done" ? ` title="State 為 Done / Closed / Resolved… 的項目（擷取時只帶最近 ${esc(Ado.cfg().doneDays)} 天內有更新的）"` : ""
                  }>${F.quick[k] ? "✓ " : ""}${esc(QUICK_LABEL[k])}${k === "done" ? ` <b>${doneHits}</b>` : ""}</button>`
              )
              .join("")}</div>
          ${A.DIMS.map((dim) => facetRow(dim, all, f)).join("")}
        </div>
        <div class="ado-result"><span>顯示 <b>${list.length}</b> / ${all.length} 筆</span>${anyFilter() ? `<button class="btn small" id="fClear" type="button">清除全部篩選</button>` : ""}</div>
      </section>

      <details class="card fold-card" id="adoCharts" ${Store.ui.adoChartsOpen === false ? "" : "open"}>
        <summary class="card-h"><h3>分布概況</h3><span class="muted">點長條即可套用篩選</span></summary>
        <div class="ado-charts">
          <div><h4>各負責人（${A.tally(list, "assignee").size} 人）</h4>${bars(A.toSortedPairs(A.tally(list, "assignee")), { dim: "assignee", selected: F.assignee, limit: 14, label: shortOf })}</div>
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
          <label class="field-inline"><span>分組</span><select id="fGroup">
            <option value="">不分組</option>
            ${["assignee", "type", "state", "tag", "ageBucket"].map((d) => `<option value="${d}"${F.group === d ? " selected" : ""}>依${esc(DIM_LABEL[d])}</option>`).join("")}
          </select></label>
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
      const q = ev.target.closest("[data-quick],[data-scope]");
      if (q) return (toggleQuick(q.dataset.quick ?? q.dataset.scope), redraw());
      const kpiBtn = ev.target.closest("[data-kpi]");
      if (kpiBtn) {
        const k = kpiBtn.dataset.kpi;
        if (k === "clear") return (clearAll(), redraw());
        return (toggleQuick(k), redraw());
      }
      const more = ev.target.closest("[data-more]");
      if (more) {
        const d = more.dataset.more;
        if (!moreOpen.delete(d)) moreOpen.add(d);
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

    renderTable($("#adoTable"), list, pair, F.quick.done ? 0 : doneHits);
  }

  /**
   * One facet as a label + chips row: every value with its count after the other filters. A picked
   * value stays even when the others bring it to 0, so it can always be un-picked where it was picked.
   */
  function facetRow(dim, all, f) {
    const counts = A.facet(all, f, dim);
    const sel = F[dim];
    for (const v of sel) if (!counts.has(v)) counts.set(v, 0);
    const pairs = A.toSortedPairs(counts);
    if (!pairs.length) return "";
    const showAll = moreOpen.has(dim) || pairs.length <= FACET_LIMIT + 2; // never hide just one or two
    const shown = showAll ? pairs : pairs.filter((p, i) => i < FACET_LIMIT || sel.includes(p.key));
    const hidden = pairs.length - shown.length;
    const chip = (p) => {
      const on = sel.includes(p.key);
      return `<button type="button" class="chip${on ? " on" : ""}${p.value ? "" : " zero"}" style="--c:var(--brand)" data-pick="${dim}" data-val="${esc(p.key)}" title="${esc(p.key)}" aria-pressed="${on}">${on ? "✓ " : ""}${esc(
        dim === "assignee" ? shortOf(p.key) : p.key
      )} <b>${p.value}</b></button>`;
    };
    return `<span class="fl">${esc(DIM_LABEL[dim])}${sel.length ? ` <span class="count">${sel.length}</span>` : ""}</span>
      <div class="fv chips">${shown.map(chip).join("")}${
        hidden ? `<button type="button" class="chip more" data-more="${dim}">+${hidden} 更多</button>` : moreOpen.has(dim) && pairs.length > FACET_LIMIT + 2 ? `<button type="button" class="chip more" data-more="${dim}">收合</button>` : ""
      }</div>`;
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

  /** doneHits: finished items the same filter would match - worth saying when the list is empty without them. */
  function renderTable(el, list, pair, doneHits) {
    if (!list.length) {
      el.innerHTML = `<p class="empty">沒有符合條件的未完成項目。${
        doneHits ? `<button type="button" class="chip" style="--c:var(--brand)" data-quick="done">含已完成 <b>${doneHits}</b></button> 可以看已完成的。` : anyFilter() ? "試著放寬或清除篩選。" : ""
      }</p>`;
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
        <td class="col-who" title="${esc(r.assignee)}">${r.unassigned ? `<span class="muted">${esc(r.who)}</span>` : esc(r.who)}${
          empId || r.unassigned ? "" : `<a class="tag ghost" href="#/ado/members" title="名冊裡找不到這個 ADO 帳號：到「我的成員」對應">名冊外</a>`
        }</td>
        <td>${esc(r.type)}</td>
        <td>${stateTag(r)}</td>
        <td class="num">${r.changed ? esc(U.fmt(r.changed, "yy")) : "—"}</td>
        <td class="num">${ageCell(r)}</td>
        <td class="col-title">${r.link ? `<a href="${esc(r.link)}" target="_blank" rel="noopener">${esc(r.title)}</a>` : esc(r.title)}${tagChips(r)}</td>
      </tr>`;
    };
    const groups = A.group(list, F.group);
    const label = (k) => (F.group === "ageBucket" ? (A.bucket(k) || {}).label || k : F.group === "assignee" ? shortOf(k) : k);
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
    const emps = [...Store.data.employees].sort((a, b) => b.active - a.active || 0);
    const matched = [...pair.byEmp.values()].reduce((n, rs) => n + rs.length, 0);
    const unassigned = snap.rows.filter((r) => r.unassigned && !r.isNoise); // a Release Note with no owner is normal
    const withWork = emps.filter((e) => (pair.byEmp.get(e.id) || []).length).length;

    el.innerHTML = `
      <section class="kpis small">
        <div class="kpi"><span class="kpi-l">名冊成員的 ADO 項目</span><span class="kpi-v">${matched}</span><span class="kpi-s">${withWork} / ${emps.filter((e) => e.active).length} 位在職成員手上有項目</span></div>
        <div class="kpi"><span class="kpi-l">未指派</span><span class="kpi-v">${unassigned.length}</span><span class="kpi-s">沒有 Assigned To（不含 Worklog / Release Note）</span></div>
        <div class="kpi"><span class="kpi-l">停滯 > ${A.STALE_DAYS - 1} 天</span><span class="kpi-v">${[...pair.byEmp.values()].flat().filter((r) => r.stale).length}</span><span class="kpi-s">成員手上最久沒更新的項目</span></div>
      </section>

      <section class="card"><header class="card-h"><h3>成員的 ADO 任務</h3>
        <span class="muted">依 ADO 項目數排序・點一列展開明細${Store.editing ? "" : "・對應 ADO 帳號需要編輯模式"}</span>
        ${pair.firstName.size ? `<span class="grow"></span><button class="btn small" id="mPin" type="button" title="把「依名字」比對到的 ADO 名稱寫進各人的「ADO 帳號」欄位，之後就不再依賴名字">固定目前比對（${pair.firstName.size}）</button>` : ""}</header>
        <div id="mTable"></div></section>
      <div id="mDetail"></div>

      <details class="card fold-card" id="mOutsideFold" ${Store.ui.adoOutsideOpen ? "open" : ""}>
        <summary class="card-h"><h3>名冊外的負責人（${pair.unmatched.size}）</h3><span class="muted">ADO 上有項目，但名冊裡找不到對應的人</span></summary>
        <div id="mOutside"></div></details>

      ${
        unassigned.length
          ? `<section class="card"><header class="card-h"><h3>未指派的項目（${unassigned.length}）</h3><span class="muted">ADO 上沒有 Assigned To，誰都不會收到</span>
              <span class="grow"></span><button class="btn small" id="mGoUn" type="button">在看板中查看</button></header>
              <ul class="tlist ado-items">${A.sort(unassigned, "ageDays", "desc").slice(0, 12).map(itemLine).join("")}</ul>
              ${unassigned.length > 12 ? `<p class="muted">其餘 ${unassigned.length - 12} 筆請到看板查看</p>` : ""}</section>`
          : ""
      }`;

    renderMemberTable($("#mTable"), emps, pair);
    if ($("#mPin")) $("#mPin").onclick = () => pinMatches(pair);
    renderOutside($("#mOutside"), pair);
    $("#mOutsideFold").ontoggle = (ev) => Store.setUi({ adoOutsideOpen: ev.target.open });
    if (openEmp) renderMemberDetail($("#mDetail"), openEmp, pair);
    if ($("#mGoUn"))
      $("#mGoUn").onclick = () => {
        clearAll();
        F.quick.unassigned = true;
        F.quick.noNoise = true;
        App.go("#/ado");
      };
  }

  function renderMemberTable(el, emps, pair) {
    const list = emps
      .map((e) => ({ e, rs: pair.byEmp.get(e.id) || [] }))
      .filter((x) => x.e.active || x.rs.length)
      .sort((a, b) => b.rs.length - a.rs.length);
    const maxN = Math.max(1, ...list.map((x) => x.rs.length));
    const rows = list
      .map(({ e, rs }) => {
        const stale = rs.filter((r) => r.stale).length;
        const last = rs.map((r) => r.changed).filter(Boolean).sort().pop();
        const segs = A.PHASES.map((p) => rs.filter((r) => r.phase === p.key).length)
          .map((n, i) => (n ? `<i class="ph-${A.PHASES[i].key}" style="width:${(n / maxN) * 100}%" title="${esc(A.PHASES[i].label)}：${n}"></i>` : ""))
          .join("");
        const aliases = A.aliasesOf(e);
        // Matched only because the given name picked out one person on each side: worth saying, since
        // 名冊 keeps first names and ADO shows "Dixon Chu WYHQ Wiwynn".
        const guessed = rs.length && [...pair.empOf.entries()].every(([n, id]) => id !== e.id || pair.firstName.has(n));
        return `<tr data-emp="${e.id}" class="${e.active ? "" : "gone"}${openEmp === e.id ? " on" : ""}">
          <th>${esc(e.name)}${e.active ? "" : `<span class="tag ghost">已離開</span>`}${guessed ? `<span class="tag ghost" title="名冊只有名字，是用名字對上 ADO 顯示名稱的。要固定下來可以在「ADO 帳號」欄填完整名稱。">依名字</span>` : ""}${
            rs.length ? "" : aliases.length ? `<span class="tag ghost" title="已設定 ADO 帳號，但目前沒有未完成項目">無項目</span>` : `<span class="tag ghost" title="靠姓名比對不到 ADO 帳號，可在編輯員工填「ADO 帳號」">未對應</span>`
          }</th>
          <td class="num">${rs.length ? `<b>${rs.length}</b>` : `<span class="muted">0</span>`}</td>
          <td class="ado-mini"><span class="hb-track">${segs}</span></td>
          <td class="num">${stale ? `<b class="late">${stale}</b>` : `<span class="muted">—</span>`}</td>
          <td class="num">${last ? esc(U.fmt(last, "yy")) : `<span class="muted">—</span>`}</td>
        </tr>`;
      })
      .join("");
    el.innerHTML = `<div class="table-wrap"><table class="grid-table roster ado-members">
      <thead><tr><th>姓名</th><th class="num">ADO 項目</th><th>狀態分布</th><th class="num">停滯 > ${A.STALE_DAYS - 1} 天</th><th class="num">最後更新</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
      <div class="legend">${A.PHASES.map((p) => `<span class="lg"><i class="ph-${p.key}"></i>${esc(p.label)}</span>`).join("")}</div>`;
    el.onclick = (ev) => {
      const tr = ev.target.closest("tr[data-emp]");
      if (!tr) return;
      openEmp = openEmp === tr.dataset.emp ? "" : tr.dataset.emp;
      redraw();
    };
  }

  function renderMemberDetail(el, empId, pair) {
    const e = Store.emp(empId);
    if (!e) {
      openEmp = "";
      return;
    }
    const rs = A.sort(pair.byEmp.get(empId) || [], "ageDays", "desc");
    const names = [...pair.empOf.entries()].filter(([, id]) => id === empId).map(([n]) => n);
    el.innerHTML = `<section class="card detail">
      <header class="card-h"><h3>${esc(e.name)}</h3>
        <span class="muted">${rs.length} 筆 ADO 未完成項目${names.length ? `・對應 ADO 帳號：${names.map((n) => esc(n) + (pair.firstName.has(n) ? "（依名字比對）" : "")).join("、")}` : ""}</span><span class="grow"></span>
        <button class="btn small" id="mFilter" type="button">在看板中只看他／她</button>
        <button class="btn small edit-only" id="mAlias" type="button">設定 ADO 帳號</button>
        <button class="icon" id="mClose" type="button" aria-label="關閉">✕</button></header>
      ${rs.length ? `<ul class="tlist ado-items">${rs.map(itemLine).join("")}</ul>` : `<p class="muted">目前沒有未完成的 ADO 項目。${A.aliasesOf(e).length ? "" : "若實際上有，請設定他／她的 ADO 帳號。"}</p>`}
      </section>`;
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
    el.innerHTML = `<div class="row-end ado-bulk"><span class="muted grow">一個一個點太慢的話，用批次對應一次做完（每個人都會先填好最可能的人選，你只要確認）。</span>
      <button class="btn primary" id="mBatch" type="button">批次對應…（${list.length}）</button></div>
      <div class="table-wrap"><table class="grid-table"><thead><tr><th>ADO 負責人</th><th>帳號</th><th class="num">項目</th><th class="num">停滯</th><th></th></tr></thead><tbody>
      ${list
        .map(([name, rs]) => {
          const p = pair.people.find((x) => x.name === name) || {};
          return `<tr><th>${esc(A.shortName(name))}${A.shortName(name) === name ? "" : `<small class="muted"> ${esc(name)}</small>`}</th><td class="muted">${esc(p.email || "—")}</td><td class="num"><b>${rs.length}</b></td>
            <td class="num">${rs.filter((r) => r.stale).length || `<span class="muted">—</span>`}</td>
            <td class="ado-acts"><button class="btn small" data-see="${esc(name)}" type="button">查看</button><button class="btn small primary" data-map="${esc(name)}" type="button">對應到員工</button></td></tr>`;
        })
        .join("")}</tbody></table></div>
      <p class="muted">「對應到員工」會把這個 ADO 名稱寫進該員工的 <b>ADO 帳號</b>欄位（屬於部門資料，會同步到雲端給大家共用）。不是部門同事的話就不用處理。</p>`;
    $("#mBatch").onclick = () => batchMap([...pair.unmatched.keys()], pair);
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
  /** Append ADO display names to each employee's 帳號 list in one commit. pairs: [[empId, adoName]] */
  function writeAliases(pairs) {
    Store.commit((d) => {
      for (const [empId, name] of pairs) {
        const e = d.employees.find((x) => x.id === empId);
        if (!e) continue;
        const list = A.aliasesOf(e);
        if (!list.some((a) => A.fold(a) === A.fold(name))) list.push(name);
        e.ado = list.join(", ");
      }
    });
  }

  /**
   * Everyone still unpaired, in one dialog: a dropdown per ADO person, pre-filled with the likeliest
   * member, 略過 for the ones who are not colleagues. One confirmation instead of N.
   */
  async function batchMap(names, pair) {
    if (!(await App.requireEdit())) return;
    const emps = Store.data.employees.filter((e) => e.active);
    if (!emps.length) return App.toast("名冊是空的，先到「設定 › 員工名冊」新增員工", "error");
    const MAX = 25; // a dialog longer than this is unreadable; the rest come in the next round
    const list = names.slice(0, MAX);
    const options = [{ value: "", label: "— 略過（不是部門同事）—" }].concat(emps.map((e) => ({ value: e.id, label: e.name })));
    // Members who already own ADO items, plus the ones this dialog has already suggested: a member is
    // pre-filled at most once, so two "Chang"s never both default to the same person.
    const taken = new Set(emps.filter((e) => (pair.byEmp.get(e.id) || []).length).map((e) => e.id));
    const fields = list.map((name, i) => {
      const who = pair.people.find((x) => x.name === name) || {};
      const ranked = A.rankCandidates(name, who.email || "", emps);
      // Someone who already owns ADO items is probably not this person as well - unless the match is strong.
      const best = ranked.find((c) => !taken.has(c.empId));
      if (best) taken.add(best.empId);
      return {
        key: "m" + i,
        label: `${A.shortName(name)}（${(pair.unmatched.get(name) || []).length} 件）`,
        type: "select",
        options,
        value: best ? best.empId : "",
        wide: true,
        hint: who.email || name,
      };
    });
    const r = await App.form({
      title: `批次對應 ${list.length} 位 ADO 負責人`,
      saveLabel: "全部套用",
      fields,
    });
    if (!r || r.action !== "save") return;
    const picked = list.map((name, i) => [r.values["m" + i], name]).filter(([empId]) => empId);
    if (!picked.length) return App.toast("沒有選到任何人，沒有變更");
    writeAliases(picked);
    App.toast(`已對應 ${picked.length} 位${names.length > MAX ? `，還有 ${names.length - MAX} 位可以再跑一次` : ""}`, "", [{ label: "復原", run: () => Store.undo() }]);
  }

  /** Turn the given-name guesses into real 帳號 entries, so the pairing no longer leans on the name. */
  async function pinMatches(pair) {
    if (!(await App.requireEdit())) return;
    const pairs = [...pair.firstName].map((name) => [pair.empOf.get(name), name]).filter(([empId]) => empId);
    if (!pairs.length) return;
    writeAliases(pairs);
    App.toast(`已把 ${pairs.length} 筆「依名字」的比對寫進員工的 ADO 帳號`, "", [{ label: "復原", run: () => Store.undo() }]);
  }

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
    writeAliases([[r.values.empId, name]]);
    App.toast(`已把「${name}」對應到 ${Store.empName(r.values.empId)}`, "", [{ label: "復原", run: () => Store.undo() }]);
  }

  // ------------------------------------------------------------------ fetching
  /** opts.auto: the fetch nobody asked for (page load) - it reports, but never opens a dialog. */
  async function fetchNow(opts) {
    opts = opts || {};
    const cfg = Ado.cfg();
    const from = Ado.patSource();
    if (!Ado.pat()) return opts.auto ? undefined : openConfig();
    $("#blockerSkip").onclick = () => App.blocker(false);
    App.blocker(true, opts.auto ? `正在向 ADO 擷取（PAT 來自 ${from === "file" ? Ado.patFile() : "這個瀏覽器"}）…` : "正在向 ADO 擷取…");
    try {
      const r = await Ado.fetchItems({ ...cfg, pat: Ado.pat(), onProgress: (m) => App.blocker(true, m) });
      const s = saveSnapshot(r.records, `${cfg.org} / ${cfg.project}`);
      App.toast(`已擷取 ${s.rows.length} 筆未完成項目${s.done.length ? `、${s.done.length} 筆已完成` : ""}`);
      redraw();
    } catch (err) {
      const where = err.kind === "auth" && from === "file" ? `（PAT 來自 ${Ado.patFile()}，可能已過期，請更新那個檔案後重跑 tools\\ado_pat.ps1）` : "";
      App.toast("擷取失敗：" + err.message + where, "error", [
        err.kind === "auth" ? { label: "重新輸入 PAT", run: () => openConfig() } : { label: "重試", run: () => fetchNow() },
      ]);
    } finally {
      App.blocker(false);
    }
  }

  /** The PAT out of a file the viewer picks (typically the same %USERPROFILE%\\.ado_pat). */
  async function readPatFile(file) {
    try {
      const pat = Ado.cleanPat(await U.readFile(file));
      if (!/^[A-Za-z0-9._-]{20,}$/.test(pat)) return App.toast(`${file.name} 裡看不到像 PAT 的內容（應該是單獨一行英數字）`, "error");
      Ado.setPat(pat, false); // only this tab: the file itself is the place it is kept
      App.toast(`已讀取 ${file.name} 的 PAT（只記在這個分頁）`);
      fetchNow();
    } catch (err) {
      App.toast("讀取 PAT 檔失敗：" + err.message, "error");
    }
  }

  async function loadCsv(file) {
    try {
      const records = Ado.parseCsv(await U.readFile(file));
      if (!records.length) return App.toast("這個 CSV 裡沒有資料列", "error");
      const probe = A.normalise(records, { today: E.fromDay(U.today()) });
      if (!probe.rows.length && !probe.done.length) return App.toast("認不出這個 CSV 的欄位（需要 ID / Title / State 等 ADO 匯出欄位）", "error");
      saveSnapshot(records, file.name);
      App.toast(`已載入 ${probe.rows.length} 筆未完成項目${probe.done.length ? `、${probe.done.length} 筆已完成（勾「含已完成」才會顯示）` : ""}`);
      redraw();
    } catch (err) {
      App.toast("讀取 CSV 失敗：" + err.message, "error");
    }
  }

  /** -> the snapshot as the page now reads it. */
  function saveSnapshot(records, source) {
    snapshot = null; // force a re-normalise on the next render
    const at = new Date().toISOString();
    if (Ado.writeCache(records, { source, at })) return rows();
    // Too big (or no quota) for localStorage: keep it in memory for this page only.
    snapshot = { ...snapOf(records, at, source + "（未存入本機）"), memory: true };
    App.toast(`資料量太大，這次的擷取結果只留在這個分頁，重新整理後需要再擷取一次。${Ado.cfg().doneDays > 0 ? "可在「ADO 設定」把已完成項目的天數調小。" : ""}`);
    return snapshot;
  }

  /** Connection settings and the PAT. The PAT never goes into the dataset, the URL or a log. */
  async function openConfig() {
    const cfg = Ado.cfg();
    const r = await App.form({
      title: "ADO 連線設定",
      saveLabel: "儲存並擷取",
      extra: [{ value: "file", label: "從 .ado_pat 檔載入" }].concat(Ado.patRemembered() || Ado.pat() ? [{ value: "forget", label: "清除已存的 PAT" }] : []),
      fields: [
        { key: "org", label: "組織", value: cfg.org, required: true },
        { key: "project", label: "專案", value: cfg.project, required: true },
        {
          key: "pat",
          label: "PAT",
          type: "password",
          value: Ado.pat(),
          wide: true,
          required: true,
          hint:
            { file: `目前的 PAT 來自 ${Ado.patFile()}（tools/ado_pat.ps1 產生），開這一頁就會自動擷取。`, remembered: "目前的 PAT 存在這台電腦。", session: "目前的 PAT 只記在這個分頁。", none: `還沒有 PAT。可貼上，或按「從 .ado_pat 檔載入」選 ${Ado.patFile()}。` }[Ado.patSource()] +
            " 在 ADO 的 User settings → Personal access tokens 建立，scope 只要勾 Work Items (Read)；只會送到 dev.azure.com。",
        },
        { key: "remember", label: "PAT 保存方式", type: "check", text: "記住 PAT（存在這台電腦）", value: Ado.patRemembered(), hint: "不勾選只記在這個分頁，關掉就消失；共用電腦建議不要勾" },
        {
          key: "doneDays",
          label: "已完成項目（天）",
          type: "number",
          min: 0,
          value: cfg.doneDays,
          more: true,
          hint: "一併擷取最近幾天內有更新的已完成項目（Done / Closed…），看板勾「含已完成」才會顯示；0 = 只擷取未完成。天數越大資料越多。",
        },
        { key: "where", label: "額外條件（WIQL）", value: cfg.where, more: true, wide: true, placeholder: "[System.AreaPath] UNDER 'Monica\\Gen11'" },
        { key: "queryId", label: "已存查詢 GUID", value: cfg.queryId, more: true, wide: true, hint: "填了就改用 ADO 上存好的查詢，忽略上面的額外條件" },
      ],
    });
    if (!r) return;
    if (r.action === "file") return $("#adoPatFile").click();
    if (r.action === "forget") {
      Ado.forgetPat();
      return App.toast(Ado.pat() ? `已清除瀏覽器裡的 PAT；${Ado.patFile()} 提供的那一組仍然有效（要停用請刪掉 data/ado_pat.js）` : "已清除這台電腦上儲存的 PAT");
    }
    if (r.action !== "save") return;
    const { pat, remember, ...rest } = r.values;
    rest.doneDays = Math.max(0, Math.floor(Number(rest.doneDays) || 0));
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
    return { cfg: Ado.cfg(), count: snap ? snap.rows.length : 0, at: snap ? snap.at : "", pat: Ado.patSource(), patFile: Ado.patFile() };
  }

  /** Open items per roster member (empId -> rows), or null without a snapshot: 人力資源 › 每人工作 shows the count. */
  function byEmployee() {
    const snap = rows();
    return snap ? A.matchRoster(snap.rows, Store.data.employees).byEmp : null;
  }

  /** 我的成員 with one person's detail open. */
  function openMember(empId) {
    openEmp = empId;
    App.go("#/ado/members");
  }

  window.AdoView = { render, openConfig, forget, status, byEmployee, openMember, itemLine };
})();
