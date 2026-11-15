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
  // Labels are getters / functions: the language can change without a reload.
  const DIM_LABEL = {
    get assignee() {
      return L("負責人", "Owner");
    },
    get type() {
      return L("類型", "Type");
    },
    get state() {
      return L("狀態", "State");
    },
    get tag() {
      return L("專案標籤", "Project tag");
    },
    get ageBucket() {
      return L("停滯區間", "Stalled for");
    },
  };
  const QUICK_LABEL = {
    get stale() {
      return L(`停滯 > ${A.STALE_DAYS - 1} 天`, `Stalled > ${A.STALE_DAYS - 1} days`);
    },
    get noNoise() {
      return L("排除 Worklog / Release Note", "Hide Worklog / Release Note");
    },
    get done() {
      return L("含已完成", "Include done");
    },
  };
  // Whose items: a roster name, any other name, or nobody - disjoint, so at most one is on.
  const SCOPES = () => [["", L("全部", "All")], ["roster", L("名冊成員", "Roster")], ["outside", L("名冊外", "Not on roster")], ["unassigned", L("未指派", "Unassigned")]];
  /** The model's placeholder values stay the filter keys (they match data); only how they read changes. */
  const shownVal = (k) =>
    ({ [A.UNASSIGNED]: L("(未指派)", "(Unassigned)"), "(無狀態)": L("(無狀態)", "(No state)"), "(無類型)": L("(無類型)", "(No type)"), "(無標籤)": L("(無標籤)", "(No tag)") })[k] ?? k;
  const FACET_LIMIT = 12; // chips a facet shows before 更多

  // Filters, sort and the open person live in this module: they are a way of looking at the page,
  // not data, so they survive re-renders but not a reload.
  const F = { search: "", assignee: [], type: [], state: [], tag: [], age: "", from: "", to: "", quick: {}, group: "", sort: "ageDays", dir: "desc" };
  // 我的成員 has its own filter: it narrows the members' items by kind, not by person, and should not
  // be undone by a trip to the board (nor leak into it, except through 在看板中查看).
  const M = { search: "", type: [], state: [], tag: [], age: "", quick: {} };
  const M_DIMS = ["type", "state", "tag"];
  const M_QUICK = {
    get stale() {
      return QUICK_LABEL.stale;
    },
    get noNoise() {
      return QUICK_LABEL.noNoise;
    },
  };
  const moreOpen = new Set(); // facets showing every value ("m:" + dim for 我的成員)
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
    if (!k || SCOPES().some(([s]) => s === k)) for (const [s] of SCOPES()) if (s) F.quick[s] = false;
    if (k) F.quick[k] = on;
  }

  const mFiltering = () => !!(M.search || M.age || M_DIMS.some((d) => M[d].length) || Object.values(M.quick).some(Boolean));

  function mClear() {
    M.search = M.age = "";
    M.quick = {};
    for (const d of M_DIMS) M[d] = [];
  }

  function toggleValue(dim, value, S) {
    const sel = (S || F)[dim];
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
  const shortOf = (k) => shownVal(A.shortName(k));

  const stateTag = (r) => `<span class="ado-state ph-${r.phase}" title="${esc(PHASE.get(r.phase).label)}">${esc(shownVal(r.state))}</span>`;

  function ageCell(r) {
    if (r.ageDays < 0) return `<span class="muted">—</span>`;
    const tone = r.closed ? "" : (A.bucket(r.ageBucket) || {}).tone || ""; // days since it was closed: nothing to warn about
    return `<span class="ado-age${tone ? " t-" + tone : ""}">${r.ageDays}</span>`;
  }

  const idLink = (r) => (r.link ? `<a href="${esc(r.link)}" target="_blank" rel="noopener">${esc(r.id)}</a>` : esc(r.id));

  const tagChips = (r) => r.tags.slice(0, 4).map((t) => `<span class="ado-tag">${esc(t)}</span>`).join("");

  /** Horizontal bars (the 出差天數 pattern): [{ key, value }] with click-to-filter. */
  function bars(pairs, opts) {
    if (!pairs.length) return `<p class="muted">${L("沒有資料", "No data")}</p>`;
    const list = opts.limit ? pairs.slice(0, opts.limit) : pairs;
    const max = Math.max(1, ...list.map((p) => p.value));
    const sel = opts.selected || [];
    return `<div class="hbars">${list
      .map(
        (p) => `<button type="button" class="hbar${sel.includes(p.key) ? " on" : ""}" data-pick="${esc(opts.dim)}" data-val="${esc(p.key)}" title="${esc(opts.label ? opts.label(p.key) : shownVal(p.key))}">
          <span class="hb-name">${esc(opts.label ? opts.label(p.key) : shownVal(p.key))}</span>
          <span class="hb-track"><i style="width:${(p.value / max) * 100}%;background:${opts.color || "var(--s1)"}"></i></span>
          <span class="hb-v">${p.value}</span></button>`
      )
      .join("")}${opts.limit && pairs.length > opts.limit ? `<p class="muted ado-more">${L(`其餘 ${pairs.length - opts.limit} 項未顯示`, `${pairs.length - opts.limit} more not shown`)}</p>` : ""}</div>`;
  }

  /** One item as a list row: used in the member detail and in 名冊外的負責人. */
  function itemLine(r) {
    return `<li><span class="a-main"><span class="ado-line">${idLink(r)} ${esc(r.title)}</span><small>${esc(shownVal(r.type))}${r.area ? " · " + esc(r.area) : ""}</small></span>
      <span class="a-side">${stateTag(r)}${ageCell(r)}<small class="muted">${r.changed ? U.fmt(r.changed, "short") : "—"}</small></span></li>`;
  }

  /** A search box that filters as you type. A re-render replaces the box, so the caret goes back where it was. */
  function bindSearch(sel, set) {
    $(sel).oninput = U.debounce((ev) => {
      const at = ev.target.selectionStart;
      set(ev.target.value);
      redraw();
      const s = $(sel);
      if (!s) return;
      s.focus();
      try {
        s.setSelectionRange(at, at);
      } catch {
        /* type=search may refuse selection in some browsers */
      }
    }, 250);
  }

  // ------------------------------------------------------------------ page
  function render(root, arg) {
    const tab = arg === "members" ? "members" : "board";
    const snap = rows();
    const cfg = Ado.cfg();

    root.innerHTML = `
      <div class="page-head"><h2>ADO Task</h2>
        <div class="seg" role="group" aria-label="${L("檢視", "View")}">
          <button type="button" data-tab="board" class="${tab === "board" ? "on" : ""}">${L("看板", "Board")}</button>
          <button type="button" data-tab="members" class="${tab === "members" ? "on" : ""}">${L("我的成員", "My members")}</button>
        </div>
        <span class="grow"></span>
        <button class="btn primary" id="adoFetch" type="button">${snap ? L("⟳ 重新擷取", "⟳ Fetch again") : L("⟳ 從 ADO 擷取", "⟳ Fetch from ADO")}</button>
        <button class="btn" id="adoCsv" type="button">${L("載入 CSV…", "Load CSV…")}</button>
        <button class="btn" id="adoCfg" type="button">${L("ADO 設定", "ADO settings")}</button>
      </div>
      <p class="ado-src muted">${
        snap
          ? `${esc(snap.source || `${cfg.org} / ${cfg.project}`)}・${L("擷取於", "fetched")} <b>${esc(new Date(snap.at).toLocaleString(I18N.locale(), { hour12: false }))}</b>・${L(`${snap.rows.length} 筆未完成`, `${snap.rows.length} open`)}${
              snap.done.length ? L(`、${snap.done.length} 筆已完成（勾「含已完成」才會顯示）`, `, ${snap.done.length} done (shown with "Include done")`) : ""
            }・${L(`停滯天數以 ${esc(snap.day)} 為基準`, `days stalled counted to ${esc(snap.day)}`)}`
          : L(`尚未擷取資料。資料只存在這台電腦，不會寫入部門資料或雲端。`, `Nothing fetched yet. The data stays on this computer; it is never written to the department data or the Cloud.`)
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
        App.toast(L(`找不到 PAT（${Ado.patFile()}）：請手動輸入，或選 .ado_pat 檔`, `No PAT found (${Ado.patFile()}): type one in, or pick the .ado_pat file`), "", [
          { label: L("輸入 PAT", "Enter PAT"), run: () => openConfig() },
          { label: L("載入 PAT 檔…", "Load PAT file…"), run: () => $("#adoPatFile").click() },
        ]);
      return;
    }
    if (snap && snap.day === E.fromDay(U.today())) return;
    fetchNow({ auto: true });
  }

  function renderEmpty(el, cfg) {
    const tokens = `<a href="https://dev.azure.com/${esc(cfg.org)}/_usersSettings/tokens" target="_blank" rel="noopener">Personal Access Tokens</a>`;
    const where = `<b>${esc(cfg.org)} / ${esc(cfg.project)}</b>`;
    const file = `<code>${esc(Ado.patFile())}</code>`;
    const ps = `<code>powershell -ExecutionPolicy Bypass -File tools\\ado_pat.ps1</code>`;
    el.innerHTML = `<section class="card"><header class="card-h"><h3>${L("先把 ADO 的工作項目拉進來", "First, bring in the ADO work items")}</h3></header>
      <ol class="h-steps ado-steps">
        <li>${L(`到 ${tokens} 建一組 PAT，scope 只要勾 <b>Work Items (Read)</b>。`, `Create a PAT under ${tokens}; the only scope it needs is <b>Work Items (Read)</b>.`)}</li>
        <li>${L(
          `按右上角 <b>⟳ 從 ADO 擷取</b>，貼上 PAT 即可。預設查 ${where} 的未完成項目（可在「ADO 設定」改）。`,
          `Press <b>⟳ Fetch from ADO</b> (top right) and paste the PAT. By default it reads the open items of ${where} (change it in "ADO settings").`
        )}</li>
        <li>${L(
          `不想每次貼：把 PAT 存成單獨一行放在 ${file}，跑一次 ${ps}，之後每次開這一頁都會自動擷取。也可以直接按下面的 <b>載入 PAT 檔…</b> 選那個檔案。`,
          `To stop pasting it: save the PAT as a single line in ${file} and run ${ps} once; from then on this page fetches by itself whenever it opens. Or press <b>Load PAT file…</b> below and pick that file.`
        )}</li>
        <li>${L(`沒有 PAT 也可以用 <b>載入 CSV…</b> 丟 ADO Queries 匯出的檔案。`, `No PAT? Use <b>Load CSV…</b> with a file exported from ADO Queries.`)}</li>
      </ol>
      <p class="muted">${L(
        "PAT 預設只記在這個分頁（勾「記住」才會存在這台電腦），而且只會送到 dev.azure.com。擷取回來的項目同樣只存在這台電腦。",
        'By default the PAT is kept in this tab only (tick "Remember" to store it on this computer), and it is only ever sent to dev.azure.com. Fetched items also stay on this computer.'
      )}</p>
      <div class="row-end"><button class="btn" id="adoPat2" type="button">${L("載入 PAT 檔…", "Load PAT file…")}</button><button class="btn" id="adoCsv2" type="button">${L("載入 CSV…", "Load CSV…")}</button><button class="btn primary" id="adoFetch2" type="button">${L("⟳ 從 ADO 擷取", "⟳ Fetch from ADO")}</button></div></section>`;
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
    const scopeOn = (SCOPES().find(([s]) => s && F.quick[s]) || [""])[0];

    const kpi = (label, value, note, opts) =>
      `<${opts.act ? "button" : "div"} class="kpi${opts.tone ? " " + opts.tone : ""}${opts.on ? " on" : ""}"${opts.act ? ` type="button" data-kpi="${opts.act}"` : ""}>
        <span class="kpi-l">${esc(label)}</span><span class="kpi-v">${value}</span><span class="kpi-s">${note}</span></${opts.act ? "button" : "div"}>`;

    el.innerHTML = `
      <section class="kpis small ado-kpis">
        ${kpi(L("未完成項目", "Open items"), snap.rows.length, anyFilter() ? L(`篩選後 <b>${list.length}</b> 筆`, `<b>${list.length}</b> after filters`) : L("點下方條件可篩選", "Click a condition below to filter"), { act: "clear", on: !anyFilter() })}
        ${kpi(
          L("名冊成員的項目", "Roster members' items"),
          mine,
          L(`${pair.byEmp.size} 位成員・名冊 ${Store.data.employees.filter((e) => e.active).length} 人`, `${pair.byEmp.size} members · roster ${Store.data.employees.filter((e) => e.active).length} people`),
          { act: "roster", on: !!F.quick.roster }
        )}
        ${kpi(L("未指派", "Unassigned"), unassigned, L("沒有 Assigned To", "No Assigned To"), { act: "unassigned", on: !!F.quick.unassigned })}
        ${kpi(QUICK_LABEL.stale, stale, L(`占 ${stalePool.length ? Math.round((stale / stalePool.length) * 100) : 0}%`, `${stalePool.length ? Math.round((stale / stalePool.length) * 100) : 0}% of items`), { act: "stale", on: !!F.quick.stale, tone: stale ? "bad" : "good" })}
      </section>

      <section class="card ado-filters">
        <div class="toolbar wrap">
          <label class="field-inline grow"><span>${L("搜尋", "Search")}</span><input type="search" id="fSearch" value="${esc(F.search)}" placeholder="${L("標題、ID、負責人、料號…（多個字詞是 AND）", "Title, ID, owner, part no.… (several words = AND)")}" autocomplete="off"></label>
          <label class="field-inline"><span>${L("停滯", "Stalled")}</span><select id="fAge">
            <option value="">${L("全部", "All")}</option>
            ${A.AGE_BUCKETS.map((b) => `<option value="${b.key}"${F.age === b.key ? " selected" : ""}>${esc(b.label)}</option>`).join("")}
          </select></label>
          <label class="field-inline"><span>${L("更新日期", "Updated")}</span><input type="date" id="fFrom" value="${esc(F.from)}" aria-label="${L("最後更新起", "Last updated from")}"> – <input type="date" id="fTo" value="${esc(F.to)}" aria-label="${L("最後更新迄", "Last updated to")}"></label>
        </div>
        <div class="ado-fgrid">
          <span class="fl">${L("負責人範圍", "Whose items")}</span>
          <div class="fv"><div class="seg small" role="group" aria-label="${L("負責人範圍", "Whose items")}">${SCOPES().map(
            ([k, label]) => `<button type="button" data-scope="${k}" class="${scopeOn === k ? "on" : ""}" aria-pressed="${scopeOn === k}">${esc(label)}</button>`
          ).join("")}</div>
            ${Object.keys(QUICK_LABEL)
              .map(
                (k) =>
                  `<button type="button" class="chip${F.quick[k] ? " on" : ""}${k === "done" && !doneHits ? " zero" : ""}" style="--c:var(--brand)" data-quick="${k}" aria-pressed="${!!F.quick[k]}"${
                    k === "done"
                      ? ` title="${L(
                          `State 為 Done / Closed / Resolved… 的項目（擷取時只帶最近 ${esc(Ado.cfg().doneDays)} 天內有更新的）`,
                          `Items whose State is Done / Closed / Resolved… (a fetch only brings those updated in the last ${esc(Ado.cfg().doneDays)} days)`
                        )}"`
                      : ""
                  }>${F.quick[k] ? "✓ " : ""}${esc(QUICK_LABEL[k])}${k === "done" ? ` <b>${doneHits}</b>` : ""}</button>`
              )
              .join("")}</div>
          ${A.DIMS.map((dim) => facetRow(dim, all, f)).join("")}
        </div>
        <div class="ado-result"><span>${L(`顯示 <b>${list.length}</b> / ${all.length} 筆`, `Showing <b>${list.length}</b> / ${all.length}`)}</span>${anyFilter() ? `<button class="btn small" id="fClear" type="button">${L("清除全部篩選", "Clear all filters")}</button>` : ""}</div>
      </section>

      <details class="card fold-card" id="adoCharts" ${Store.ui.adoChartsOpen === false ? "" : "open"}>
        <summary class="card-h"><h3>${L("分布概況", "Breakdown")}</h3><span class="muted">${L("點長條即可套用篩選", "Click a bar to filter")}</span></summary>
        <div class="ado-charts">
          <div><h4>${L(`各負責人（${A.tally(list, "assignee").size} 人）`, `By owner (${A.tally(list, "assignee").size} people)`)}</h4>${bars(A.toSortedPairs(A.tally(list, "assignee")), { dim: "assignee", selected: F.assignee, limit: 14, label: shortOf })}</div>
          <div><h4>${L("狀態", "State")}</h4>${bars(A.toSortedPairs(A.tally(list, "state")), { dim: "state", selected: F.state, color: "var(--s7)" })}</div>
          <div><h4>${L("類型", "Type")}</h4>${bars(A.toSortedPairs(A.tally(list, "type")), { dim: "type", selected: F.type, color: "var(--s3)", limit: 10 })}</div>
          <div><h4>${L("停滯天數", "Days stalled")}</h4>${bars(
            A.AGE_BUCKETS.map((b) => ({ key: b.key, value: list.filter((r) => r.ageBucket === b.key).length })).filter((p) => p.value),
            { dim: "age", color: "var(--s2)", label: (k) => (A.bucket(k) || {}).label || k, selected: F.age ? [F.age] : [] }
          )}</div>
        </div>
      </details>

      <section class="card">
        <header class="card-h"><h3>${L("項目清單", "Item list")}</h3><span class="muted">${L(`${list.length} 筆`, `${list.length}`)}${anyFilter() ? L(`（共 ${all.length}）`, ` (of ${all.length})`) : ""}</span><span class="grow"></span>
          <label class="field-inline"><span>${L("分組", "Group")}</span><select id="fGroup">
            <option value="">${L("不分組", "No grouping")}</option>
            ${["assignee", "type", "state", "tag", "ageBucket"].map((d) => `<option value="${d}"${F.group === d ? " selected" : ""}>${L(`依${esc(DIM_LABEL[d])}`, `By ${esc(DIM_LABEL[d])}`)}</option>`).join("")}
          </select></label>
          <button class="btn small" id="adoExport" type="button">${L("匯出 CSV", "Export CSV")}</button>
          <button class="btn small" id="adoMd" type="button">${L("複製 Markdown", "Copy Markdown")}</button></header>
        <div id="adoTable"></div>
      </section>`;

    // ---- filter inputs
    bindSearch("#fSearch", (v) => (F.search = v));
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
      const md = [L("| ID | 負責人 | 狀態 | 停滯 | 標題 |", "| ID | Owner | State | Stalled | Title |"), "|---|---|---|---|---|"]
        .concat(list.map((r) => `| ${r.id} | ${r.assignee} | ${r.state} | ${r.ageDays < 0 ? "—" : r.ageDays + "d"} | ${String(r.title).replace(/\|/g, "\\|")} |`))
        .join("\n");
      try {
        await navigator.clipboard.writeText(md);
        App.toast(L(`已複製 ${list.length} 筆（Markdown 表格）`, `Copied ${list.length} items (Markdown table)`));
      } catch {
        App.toast(L("瀏覽器不允許複製，請改用「匯出 CSV」", 'The browser does not allow copying; use "Export CSV" instead'), "error");
      }
    };

    renderTable($("#adoTable"), list, pair, F.quick.done ? 0 : doneHits);
  }

  /**
   * One facet as a label + chips row: every value with its count after the other filters. A picked
   * value stays even when the others bring it to 0, so it can always be un-picked where it was picked.
   */
  function facetRow(dim, all, f, S, moreKey) {
    S = S || F;
    moreKey = moreKey || dim;
    const counts = A.facet(all, f, dim);
    const sel = S[dim];
    for (const v of sel) if (!counts.has(v)) counts.set(v, 0);
    const pairs = A.toSortedPairs(counts);
    if (!pairs.length) return "";
    const showAll = moreOpen.has(moreKey) || pairs.length <= FACET_LIMIT + 2; // never hide just one or two
    const shown = showAll ? pairs : pairs.filter((p, i) => i < FACET_LIMIT || sel.includes(p.key));
    const hidden = pairs.length - shown.length;
    const chip = (p) => {
      const on = sel.includes(p.key);
      return `<button type="button" class="chip${on ? " on" : ""}${p.value ? "" : " zero"}" style="--c:var(--brand)" data-pick="${dim}" data-val="${esc(p.key)}" title="${esc(shownVal(p.key))}" aria-pressed="${on}">${on ? "✓ " : ""}${esc(
        dim === "assignee" ? shortOf(p.key) : shownVal(p.key)
      )} <b>${p.value}</b></button>`;
    };
    return `<span class="fl">${esc(DIM_LABEL[dim])}${sel.length ? ` <span class="count">${sel.length}</span>` : ""}</span>
      <div class="fv chips">${shown.map(chip).join("")}${
        hidden
          ? `<button type="button" class="chip more" data-more="${moreKey}">${L(`+${hidden} 更多`, `+${hidden} more`)}</button>`
          : moreOpen.has(moreKey) && pairs.length > FACET_LIMIT + 2
            ? `<button type="button" class="chip more" data-more="${moreKey}">${L("收合", "Less")}</button>`
            : ""
      }</div>`;
  }

  const SORTS = () => [
    ["id", "ID", "col-id"],
    ["assignee", L("負責人", "Owner"), ""],
    ["type", L("類型", "Type"), ""],
    ["state", L("狀態", "State"), ""],
    ["changed", L("最後更新", "Updated"), ""],
    ["ageDays", L("停滯", "Stalled"), "num"],
    ["title", L("標題", "Title"), ""],
  ];

  /** doneHits: finished items the same filter would match - worth saying when the list is empty without them. */
  function renderTable(el, list, pair, doneHits) {
    if (!list.length) {
      const doneChip = `<button type="button" class="chip" style="--c:var(--brand)" data-quick="done">${QUICK_LABEL.done} <b>${doneHits}</b></button>`;
      el.innerHTML = `<p class="empty">${L("沒有符合條件的未完成項目。", "No open items match.")}${
        doneHits
          ? L(`${doneChip} 可以看已完成的。`, ` ${doneChip} shows the done ones.`)
          : anyFilter()
            ? L("試著放寬或清除篩選。", " Try loosening or clearing the filters.")
            : ""
      }</p>`;
      return;
    }
    const head = SORTS().map(
      ([k, label, cls]) =>
        `<th class="${cls} sortable${F.sort === k ? " sorted" : ""}" data-sort="${k}" aria-sort="${F.sort === k ? (F.dir === "asc" ? "ascending" : "descending") : "none"}">${esc(label)}${
          F.sort === k ? `<span class="caret">${F.dir === "asc" ? "▲" : "▼"}</span>` : ""
        }</th>`
    ).join("");
    const row = (r) => {
      const empId = pair.empOf.get(r.assignee);
      return `<tr>
        <td class="col-id">${idLink(r)}</td>
        <td class="col-who" title="${esc(shownVal(r.assignee))}">${r.unassigned ? `<span class="muted">${esc(shownVal(r.who))}</span>` : esc(r.who)}${
          empId || r.unassigned
            ? ""
            : `<a class="tag ghost" href="#/ado/members" title="${L("名冊裡找不到這個 ADO 帳號：到「我的成員」對應", 'This ADO account is not on the roster: pair it under "My members"')}">${L("名冊外", "Not on roster")}</a>`
        }</td>
        <td>${esc(shownVal(r.type))}</td>
        <td>${stateTag(r)}</td>
        <td class="num">${r.changed ? esc(U.fmt(r.changed, "yy")) : "—"}</td>
        <td class="num">${ageCell(r)}</td>
        <td class="col-title">${r.link ? `<a href="${esc(r.link)}" target="_blank" rel="noopener">${esc(r.title)}</a>` : esc(r.title)}${tagChips(r)}</td>
      </tr>`;
    };
    const groups = A.group(list, F.group);
    const label = (k) => (F.group === "ageBucket" ? (A.bucket(k) || {}).label || k : F.group === "assignee" ? shortOf(k) : shownVal(k));
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

    // The members' items through 我的成員's own filter: empId -> the rows that pass (all of them when no filter is on).
    const filtering = mFiltering();
    const mf = { ...M, assignee: [] };
    const pool = [...pair.byEmp.values()].flat();
    const shown = new Map([...pair.byEmp].map(([id, rs]) => [id, filtering ? A.filter(rs, mf) : rs]));
    const hits = [...shown.values()].reduce((n, rs) => n + rs.length, 0);
    const hitMembers = [...shown.values()].filter((rs) => rs.length).length;
    // Like the board's KPI: every other condition applied, only 停滯 itself left out.
    const stale = A.filter(pool, { ...mf, quick: { ...M.quick, stale: false } }).filter((r) => r.stale).length;

    el.innerHTML = `
      <section class="kpis small ado-kpis">
        <div class="kpi"><span class="kpi-l">${L("名冊成員的 ADO 項目", "Roster members' ADO items")}</span><span class="kpi-v">${matched}</span><span class="kpi-s">${L(
          `${withWork} / ${emps.filter((e) => e.active).length} 位在職成員手上有項目`,
          `${withWork} / ${emps.filter((e) => e.active).length} active members have items`
        )}</span></div>
        <div class="kpi"><span class="kpi-l">${L("未指派", "Unassigned")}</span><span class="kpi-v">${unassigned.length}</span><span class="kpi-s">${L("沒有 Assigned To（不含 Worklog / Release Note）", "No Assigned To (Worklog / Release Note not counted)")}</span></div>
        <button type="button" class="kpi ${stale ? "bad" : "good"}${M.quick.stale ? " on" : ""}" data-mquick="stale"><span class="kpi-l">${esc(QUICK_LABEL.stale)}</span><span class="kpi-v">${stale}</span><span class="kpi-s">${L(
          "成員手上最久沒更新的項目・點一下篩選",
          "Members' items untouched the longest · click to filter"
        )}</span></button>
      </section>

      <section class="card ado-filters">
        <div class="toolbar wrap">
          <label class="field-inline grow"><span>${L("搜尋", "Search")}</span><input type="search" id="mSearch" value="${esc(M.search)}" placeholder="${L("在成員的項目裡找：標題、ID、料號…（多個字詞是 AND）", "Search members' items: title, ID, part no.… (several words = AND)")}" autocomplete="off"></label>
          <label class="field-inline"><span>${L("停滯", "Stalled")}</span><select id="mAge">
            <option value="">${L("全部", "All")}</option>
            ${A.AGE_BUCKETS.map((b) => `<option value="${b.key}"${M.age === b.key ? " selected" : ""}>${esc(b.label)}</option>`).join("")}
          </select></label>
        </div>
        <div class="ado-fgrid">
          <span class="fl">${L("快捷", "Quick")}</span>
          <div class="fv">${Object.keys(M_QUICK)
            .map((k) => `<button type="button" class="chip${M.quick[k] ? " on" : ""}" style="--c:var(--brand)" data-mquick="${k}" aria-pressed="${!!M.quick[k]}">${M.quick[k] ? "✓ " : ""}${esc(M_QUICK[k])}</button>`)
            .join("")}</div>
          ${M_DIMS.map((dim) => facetRow(dim, pool, mf, M, "m:" + dim)).join("")}
        </div>
        <div class="ado-result"><span>${
          filtering
            ? L(`符合 <b>${hits}</b> / ${pool.length} 筆，分屬 <b>${hitMembers}</b> 位成員`, `<b>${hits}</b> / ${pool.length} match, across <b>${hitMembers}</b> members`)
            : L(
                `成員手上共 <b>${pool.length}</b> 筆；選類型 / 狀態 / 專案標籤，就能找出是哪些成員的`,
                `<b>${pool.length}</b> items in members' hands; pick a type / state / project tag to see whose they are`
              )
        }</span>${
          filtering
            ? `<span class="grow"></span><button class="btn small" id="mToBoard" type="button" title="${L("用同樣的條件、只看名冊成員", "Same conditions, roster members only")}">${L("在看板中查看", "View on board")}</button><button class="btn small" id="mClear" type="button">${L("清除篩選", "Clear filters")}</button>`
            : ""
        }</div>
      </section>

      <section class="card"><header class="card-h"><h3>${L("成員的 ADO 任務", "Members' ADO tasks")}</h3>
        <span class="muted">${filtering ? L("只列有符合項目的成員・", "Only members with matching items · ") : ""}${L("依 ADO 項目數排序・點一列展開明細", "Sorted by ADO item count · click a row for details")}${Store.editing ? "" : L("・對應 ADO 帳號需要編輯模式", " · pairing ADO accounts needs Edit mode")}</span>
        ${
          pair.firstName.size
            ? `<span class="grow"></span><button class="btn small" id="mPin" type="button" title="${L(
                "把「依名字」比對到的 ADO 名稱寫進各人的「ADO 帳號」欄位，之後就不再依賴名字",
                'Write the ADO names matched "by first name" into each person\'s "ADO account" field, so the pairing no longer relies on the name'
              )}">${L(`固定目前比對（${pair.firstName.size}）`, `Keep current matches (${pair.firstName.size})`)}</button>`
            : ""
        }</header>
        <div id="mTable"></div></section>
      <div id="mDetail"></div>
      ${filtering ? `<section class="card"><header class="card-h"><h3>${L("符合的項目", "Matching items")}</h3><span class="muted">${L(`${hits} 筆・依成員分組`, `${hits} · grouped by member`)}</span></header><div id="mHits"></div></section>` : ""}

      <details class="card fold-card" id="mOutsideFold" ${Store.ui.adoOutsideOpen ? "open" : ""}>
        <summary class="card-h"><h3>${L(`名冊外的負責人（${pair.unmatched.size}）`, `Owners not on the roster (${pair.unmatched.size})`)}</h3><span class="muted">${L("ADO 上有項目，但名冊裡找不到對應的人", "They have items on ADO but nobody on the roster matches")}</span></summary>
        <div id="mOutside"></div></details>

      ${
        unassigned.length
          ? `<section class="card"><header class="card-h"><h3>${L(`未指派的項目（${unassigned.length}）`, `Unassigned items (${unassigned.length})`)}</h3><span class="muted">${L("ADO 上沒有 Assigned To，誰都不會收到", "No Assigned To on ADO, so nobody gets them")}</span>
              <span class="grow"></span><button class="btn small" id="mGoUn" type="button">${L("在看板中查看", "View on board")}</button></header>
              <ul class="tlist ado-items">${A.sort(unassigned, "ageDays", "desc").slice(0, 12).map(itemLine).join("")}</ul>
              ${unassigned.length > 12 ? `<p class="muted">${L(`其餘 ${unassigned.length - 12} 筆請到看板查看`, `${unassigned.length - 12} more on the board`)}</p>` : ""}</section>`
          : ""
      }`;

    bindSearch("#mSearch", (v) => (M.search = v));
    $("#mAge").onchange = (ev) => ((M.age = ev.target.value), redraw());
    if ($("#mClear")) $("#mClear").onclick = () => (mClear(), redraw());
    if ($("#mToBoard"))
      $("#mToBoard").onclick = () => {
        clearAll();
        F.search = M.search;
        F.age = M.age;
        for (const d of M_DIMS) F[d] = M[d].slice();
        F.quick = { ...M.quick, roster: true };
        App.go("#/ado");
      };
    el.onclick = (ev) => {
      const q = ev.target.closest("[data-mquick]");
      if (q) return ((M.quick[q.dataset.mquick] = !M.quick[q.dataset.mquick]), redraw());
      const more = ev.target.closest("[data-more]");
      if (more) {
        const d = more.dataset.more;
        if (!moreOpen.delete(d)) moreOpen.add(d);
        return redraw();
      }
      const pick = ev.target.closest("[data-pick]");
      if (pick) toggleValue(pick.dataset.pick, pick.dataset.val, M);
    };

    renderMemberTable($("#mTable"), emps, pair, shown, filtering);
    if ($("#mPin")) $("#mPin").onclick = () => pinMatches(pair);
    renderOutside($("#mOutside"), pair);
    $("#mOutsideFold").ontoggle = (ev) => Store.setUi({ adoOutsideOpen: ev.target.open });
    if (openEmp) renderMemberDetail($("#mDetail"), openEmp, pair, shown, filtering);
    if ($("#mHits")) renderHits($("#mHits"), emps, shown);
    if ($("#mGoUn"))
      $("#mGoUn").onclick = () => {
        clearAll();
        F.quick.unassigned = true;
        F.quick.noNoise = true;
        App.go("#/ado");
      };
  }

  /** shown: empId -> the member's items after 我的成員's filter; filtering: a filter is on (members without a hit drop out). */
  function renderMemberTable(el, emps, pair, shown, filtering) {
    const list = emps
      .map((e) => ({ e, rs: shown.get(e.id) || [], total: (pair.byEmp.get(e.id) || []).length }))
      .filter((x) => (filtering ? x.rs.length : x.e.active || x.rs.length))
      .sort((a, b) => b.rs.length - a.rs.length);
    if (!list.length) {
      el.innerHTML = `<p class="empty">${
        filtering ? L("沒有成員手上有符合條件的項目，試著放寬或清除篩選。", "No member has matching items; try loosening or clearing the filters.") : L("名冊裡沒有在職成員。", "No active members on the roster.")
      }</p>`;
      el.onclick = null;
      return;
    }
    const maxN = Math.max(1, ...list.map((x) => x.rs.length));
    const rows = list
      .map(({ e, rs, total }) => {
        const stale = rs.filter((r) => r.stale).length;
        const last = rs.map((r) => r.changed).filter(Boolean).sort().pop();
        const segs = A.PHASES.map((p) => rs.filter((r) => r.phase === p.key).length)
          .map((n, i) => (n ? `<i class="ph-${A.PHASES[i].key}" style="width:${(n / maxN) * 100}%" title="${L(`${esc(A.PHASES[i].label)}：${n}`, `${esc(A.PHASES[i].label)}: ${n}`)}"></i>` : ""))
          .join("");
        const aliases = A.aliasesOf(e);
        // Matched only because the given name picked out one person on each side: worth saying, since
        // 名冊 keeps first names and ADO shows "Dixon Chu WYHQ Wiwynn".
        const guessed = rs.length && [...pair.empOf.entries()].every(([n, id]) => id !== e.id || pair.firstName.has(n));
        return `<tr data-emp="${e.id}" class="${e.active ? "" : "gone"}${openEmp === e.id ? " on" : ""}">
          <th>${esc(e.name)}${e.active ? "" : `<span class="tag ghost">${L("已離開", "Left")}</span>`}${
            guessed
              ? `<span class="tag ghost" title="${L(
                  "名冊只有名字，是用名字對上 ADO 顯示名稱的。要固定下來可以在「ADO 帳號」欄填完整名稱。",
                  'The roster has only a first name, so it was matched to the ADO display name by that. To make it stick, enter the full name in the "ADO account" field.'
                )}">${L("依名字", "By first name")}</span>`
              : ""
          }${
            rs.length
              ? ""
              : aliases.length
                ? `<span class="tag ghost" title="${L("已設定 ADO 帳號，但目前沒有未完成項目", "ADO account set, but no open items right now")}">${L("無項目", "No items")}</span>`
                : `<span class="tag ghost" title="${L("靠姓名比對不到 ADO 帳號，可在編輯員工填「ADO 帳號」", 'No ADO account matches the name; fill in "ADO account" when editing the person')}">${L("未對應", "Not paired")}</span>`
          }</th>
          <td class="num">${rs.length ? `<b>${rs.length}</b>` : `<span class="muted">0</span>`}${filtering && total !== rs.length ? `<small class="muted"> / ${total}</small>` : ""}</td>
          <td class="ado-mini"><span class="hb-track">${segs}</span></td>
          <td class="num">${stale ? `<b class="late">${stale}</b>` : `<span class="muted">—</span>`}</td>
          <td class="num">${last ? esc(U.fmt(last, "yy")) : `<span class="muted">—</span>`}</td>
        </tr>`;
      })
      .join("");
    el.innerHTML = `<div class="table-wrap"><table class="grid-table roster ado-members">
      <thead><tr><th>${L("姓名", "Name")}</th><th class="num">${L("ADO 項目", "ADO items")}</th><th>${L("狀態分布", "By state")}</th><th class="num">${esc(QUICK_LABEL.stale)}</th><th class="num">${L("最後更新", "Updated")}</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
      <div class="legend">${A.PHASES.map((p) => `<span class="lg"><i class="ph-${p.key}"></i>${esc(p.label)}</span>`).join("")}</div>`;
    el.onclick = (ev) => {
      const tr = ev.target.closest("tr[data-emp]");
      if (!tr) return;
      openEmp = openEmp === tr.dataset.emp ? "" : tr.dataset.emp;
      redraw();
    };
  }

  function renderMemberDetail(el, empId, pair, shown, filtering) {
    const e = Store.emp(empId);
    if (!e) {
      openEmp = "";
      return;
    }
    const total = (pair.byEmp.get(empId) || []).length;
    const rs = A.sort(shown.get(empId) || [], "ageDays", "desc");
    const names = [...pair.empOf.entries()].filter(([, id]) => id === empId).map(([n]) => n);
    el.innerHTML = `<section class="card detail">
      <header class="card-h"><h3>${esc(e.name)}</h3>
        <span class="muted">${filtering ? L(`符合篩選 ${rs.length} / ${total} 筆`, `${rs.length} / ${total} match the filters`) : L(`${rs.length} 筆 ADO 未完成項目`, `${rs.length} open ADO items`)}${
          names.length
            ? L("・對應 ADO 帳號：", " · ADO accounts: ") + names.map((n) => esc(n) + (pair.firstName.has(n) ? L("（依名字比對）", " (matched by first name)") : "")).join(L("、", ", "))
            : ""
        }</span><span class="grow"></span>
        <button class="btn small" id="mFilter" type="button">${L("在看板中只看他／她", "Show only them on the board")}</button>
        <button class="btn small edit-only" id="mAlias" type="button">${L("設定 ADO 帳號", "Set ADO account")}</button>
        <button class="icon" id="mClose" type="button" aria-label="${L("關閉", "Close")}">✕</button></header>
      ${
        rs.length
          ? `<ul class="tlist ado-items">${rs.map(itemLine).join("")}</ul>`
          : filtering && total
            ? `<p class="muted">${L(`他／她的 ${total} 筆項目都不符合目前的篩選。`, `None of their ${total} items match the current filters.`)}</p>`
            : `<p class="muted">${L("目前沒有未完成的 ADO 項目。", "No open ADO items right now.")}${A.aliasesOf(e).length ? "" : L("若實際上有，請設定他／她的 ADO 帳號。", " If they do have some, set their ADO account.")}</p>`
      }
      </section>`;
    $("#mClose").onclick = () => ((openEmp = ""), redraw());
    $("#mFilter").onclick = () => {
      clearAll();
      F.assignee = names.slice();
      App.go("#/ado");
    };
    $("#mAlias").onclick = () => Editors.employee(empId);
  }

  /** 我的成員 with a filter on: the matching items, one group per member (most hits first), oldest first inside. */
  function renderHits(el, emps, shown) {
    const groups = emps
      .map((e) => ({ e, rs: A.sort(shown.get(e.id) || [], "ageDays", "desc") }))
      .filter((g) => g.rs.length)
      .sort((a, b) => b.rs.length - a.rs.length);
    if (!groups.length) {
      el.innerHTML = `<p class="empty">${L("沒有符合條件的項目。", "No items match.")}</p>`;
      return;
    }
    const row = (r) => `<tr>
        <td class="col-id">${idLink(r)}</td>
        <td>${esc(shownVal(r.type))}</td>
        <td>${stateTag(r)}</td>
        <td class="num">${r.changed ? esc(U.fmt(r.changed, "yy")) : "—"}</td>
        <td class="num">${ageCell(r)}</td>
        <td class="col-title">${r.link ? `<a href="${esc(r.link)}" target="_blank" rel="noopener">${esc(r.title)}</a>` : esc(r.title)}${tagChips(r)}</td>
      </tr>`;
    const bodies = groups
      .map(
        (g) =>
          `<tbody class="ado-grp"><tr class="grp"><th colspan="6">${esc(g.e.name)}${g.e.active ? "" : `<span class="tag ghost">${L("已離開", "Left")}</span>`} <span class="count">${g.rs.length}</span></th></tr>${g.rs.map(row).join("")}</tbody>`
      )
      .join("");
    el.innerHTML = `<div class="table-wrap"><table class="grid-table ado-table">
      <thead><tr><th class="col-id">ID</th><th>${L("類型", "Type")}</th><th>${L("狀態", "State")}</th><th class="num">${L("最後更新", "Updated")}</th><th class="num">${L("停滯", "Stalled")}</th><th>${L("標題", "Title")}</th></tr></thead>${bodies}</table></div>`;
  }

  function renderOutside(el, pair) {
    const list = [...pair.unmatched.entries()].sort((a, b) => b[1].length - a[1].length);
    if (!list.length) {
      el.innerHTML = `<p class="empty">${L("每個 ADO 負責人都對應到名冊裡的人了。", "Every ADO owner is paired with someone on the roster.")}</p>`;
      return;
    }
    el.innerHTML = `<div class="row-end ado-bulk"><span class="muted grow">${L(
      "一個一個點太慢的話，用批次對應一次做完（每個人都會先填好最可能的人選，你只要確認）。",
      "Too slow one by one? Pair them all at once (each one comes pre-filled with the likeliest person; you only confirm)."
    )}</span>
      <button class="btn primary" id="mBatch" type="button">${L(`批次對應…（${list.length}）`, `Pair all… (${list.length})`)}</button></div>
      <div class="table-wrap"><table class="grid-table"><thead><tr><th>${L("ADO 負責人", "ADO owner")}</th><th>${L("帳號", "Account")}</th><th class="num">${L("項目", "Items")}</th><th class="num">${L("停滯", "Stalled")}</th><th></th></tr></thead><tbody>
      ${list
        .map(([name, rs]) => {
          const p = pair.people.find((x) => x.name === name) || {};
          return `<tr><th>${esc(A.shortName(name))}${A.shortName(name) === name ? "" : `<small class="muted"> ${esc(name)}</small>`}</th><td class="muted">${esc(p.email || "—")}</td><td class="num"><b>${rs.length}</b></td>
            <td class="num">${rs.filter((r) => r.stale).length || `<span class="muted">—</span>`}</td>
            <td class="ado-acts"><button class="btn small" data-see="${esc(name)}" type="button">${L("查看", "View")}</button><button class="btn small primary" data-map="${esc(name)}" type="button">${L("對應到員工", "Pair with person")}</button></td></tr>`;
        })
        .join("")}</tbody></table></div>
      <p class="muted">${L(
        "「對應到員工」會把這個 ADO 名稱寫進該員工的 <b>ADO 帳號</b>欄位（屬於部門資料，會同步到雲端給大家共用）。不是部門同事的話就不用處理。",
        '"Pair with person" writes this ADO name into that person\'s <b>ADO account</b> field (department data: it syncs to the Cloud for everyone). Skip anyone who is not a colleague.'
      )}</p>`;
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
    if (!emps.length) return App.toast(L("名冊是空的，先到「設定 › 員工名冊」新增員工", 'The roster is empty; add people under "Settings › Roster" first'), "error");
    const MAX = 25; // a dialog longer than this is unreadable; the rest come in the next round
    const list = names.slice(0, MAX);
    const options = [{ value: "", label: L("— 略過（不是部門同事）—", "— Skip (not a colleague) —") }].concat(emps.map((e) => ({ value: e.id, label: e.name })));
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
        label: L(`${A.shortName(name)}（${(pair.unmatched.get(name) || []).length} 件）`, `${A.shortName(name)} (${(pair.unmatched.get(name) || []).length} items)`),
        type: "select",
        options,
        value: best ? best.empId : "",
        wide: true,
        hint: who.email || name,
      };
    });
    const r = await App.form({
      title: L(`批次對應 ${list.length} 位 ADO 負責人`, `Pair ${list.length} ADO owners`),
      saveLabel: L("全部套用", "Apply all"),
      fields,
    });
    if (!r || r.action !== "save") return;
    const picked = list.map((name, i) => [r.values["m" + i], name]).filter(([empId]) => empId);
    if (!picked.length) return App.toast(L("沒有選到任何人，沒有變更", "Nobody picked; nothing changed"));
    writeAliases(picked);
    App.toast(
      L(`已對應 ${picked.length} 位${names.length > MAX ? `，還有 ${names.length - MAX} 位可以再跑一次` : ""}`, `Paired ${picked.length}${names.length > MAX ? `; ${names.length - MAX} more left for another round` : ""}`),
      "",
      [{ label: L("復原", "Undo"), run: () => Store.undo() }]
    );
  }

  /** Turn the given-name guesses into real 帳號 entries, so the pairing no longer leans on the name. */
  async function pinMatches(pair) {
    if (!(await App.requireEdit())) return;
    const pairs = [...pair.firstName].map((name) => [pair.empOf.get(name), name]).filter(([empId]) => empId);
    if (!pairs.length) return;
    writeAliases(pairs);
    App.toast(L(`已把 ${pairs.length} 筆「依名字」的比對寫進員工的 ADO 帳號`, `Wrote ${pairs.length} "by first name" matches into the people's ADO accounts`), "", [
      { label: L("復原", "Undo"), run: () => Store.undo() },
    ]);
  }

  async function mapToEmployee(name) {
    if (!(await App.requireEdit())) return;
    const emps = Store.data.employees.filter((e) => e.active);
    if (!emps.length) return App.toast(L("名冊是空的，先到「設定 › 員工名冊」新增員工", 'The roster is empty; add people under "Settings › Roster" first'), "error");
    const r = await App.form({
      title: L(`把「${name}」對應到員工`, `Pair "${name}" with a person`),
      fields: [
        { key: "empId", label: L("員工", "Person"), type: "select", options: emps.map((e) => ({ value: e.id, label: e.name })), wide: true },
        {
          key: "note",
          label: L("記住對應", "Remember pairing"),
          type: "check",
          text: L("寫入該員工的「ADO 帳號」欄位", 'Write it into the person\'s "ADO account" field'),
          value: true,
          wide: true,
          hint: L("不勾選就只是這次用這個名稱篩選看板，不會改到部門資料", "Unticked, it only filters the board by this name this time; department data is not changed"),
        },
      ],
      saveLabel: L("對應", "Pair"),
    });
    if (!r || r.action !== "save") return;
    if (!r.values.note) {
      // A one-off pairing: treat it like a filter instead of changing shared data.
      clearAll();
      F.assignee = [name];
      return App.go("#/ado");
    }
    writeAliases([[r.values.empId, name]]);
    App.toast(L(`已把「${name}」對應到 ${Store.empName(r.values.empId)}`, `Paired "${name}" with ${Store.empName(r.values.empId)}`), "", [{ label: L("復原", "Undo"), run: () => Store.undo() }]);
  }

  // ------------------------------------------------------------------ fetching
  /** opts.auto: the fetch nobody asked for (page load) - it reports, but never opens a dialog. */
  async function fetchNow(opts) {
    opts = opts || {};
    const cfg = Ado.cfg();
    const from = Ado.patSource();
    if (!Ado.pat()) return opts.auto ? undefined : openConfig();
    $("#blockerSkip").onclick = () => App.blocker(false);
    App.blocker(
      true,
      opts.auto
        ? L(`正在向 ADO 擷取（PAT 來自 ${from === "file" ? Ado.patFile() : "這個瀏覽器"}）…`, `Fetching from ADO (PAT from ${from === "file" ? Ado.patFile() : "this browser"})…`)
        : L("正在向 ADO 擷取…", "Fetching from ADO…")
    );
    try {
      const r = await Ado.fetchItems({ ...cfg, pat: Ado.pat(), onProgress: (m) => App.blocker(true, m) });
      const s = saveSnapshot(r.records, `${cfg.org} / ${cfg.project}`);
      App.toast(L(`已擷取 ${s.rows.length} 筆未完成項目${s.done.length ? `、${s.done.length} 筆已完成` : ""}`, `Fetched ${s.rows.length} open items${s.done.length ? `, ${s.done.length} done` : ""}`));
      redraw();
    } catch (err) {
      const where =
        err.kind === "auth" && from === "file"
          ? L(
              `（PAT 來自 ${Ado.patFile()}，可能已過期，請更新那個檔案後重跑 tools\\ado_pat.ps1）`,
              ` (the PAT comes from ${Ado.patFile()} and may have expired: update that file, then run tools\\ado_pat.ps1 again)`
            )
          : "";
      App.toast(L("擷取失敗：", "Fetch failed: ") + err.message + where, "error", [
        err.kind === "auth" ? { label: L("重新輸入 PAT", "Re-enter PAT"), run: () => openConfig() } : { label: L("重試", "Retry"), run: () => fetchNow() },
      ]);
    } finally {
      App.blocker(false);
    }
  }

  /** The PAT out of a file the viewer picks (typically the same %USERPROFILE%\\.ado_pat). */
  async function readPatFile(file) {
    try {
      const pat = Ado.cleanPat(await U.readFile(file));
      if (!/^[A-Za-z0-9._-]{20,}$/.test(pat))
        return App.toast(L(`${file.name} 裡看不到像 PAT 的內容（應該是單獨一行英數字）`, `${file.name} holds nothing that looks like a PAT (it should be one line of letters and digits)`), "error");
      Ado.setPat(pat, false); // only this tab: the file itself is the place it is kept
      App.toast(L(`已讀取 ${file.name} 的 PAT（只記在這個分頁）`, `Read the PAT from ${file.name} (kept in this tab only)`));
      fetchNow();
    } catch (err) {
      App.toast(L("讀取 PAT 檔失敗：", "Could not read the PAT file: ") + err.message, "error");
    }
  }

  async function loadCsv(file) {
    try {
      const records = Ado.parseCsv(await U.readFile(file));
      if (!records.length) return App.toast(L("這個 CSV 裡沒有資料列", "This CSV has no data rows"), "error");
      const probe = A.normalise(records, { today: E.fromDay(U.today()) });
      if (!probe.rows.length && !probe.done.length)
        return App.toast(L("認不出這個 CSV 的欄位（需要 ID / Title / State 等 ADO 匯出欄位）", "Cannot recognise this CSV's columns (it needs ADO export columns such as ID / Title / State)"), "error");
      saveSnapshot(records, file.name);
      App.toast(
        L(
          `已載入 ${probe.rows.length} 筆未完成項目${probe.done.length ? `、${probe.done.length} 筆已完成（勾「含已完成」才會顯示）` : ""}`,
          `Loaded ${probe.rows.length} open items${probe.done.length ? `, ${probe.done.length} done (shown with "Include done")` : ""}`
        )
      );
      redraw();
    } catch (err) {
      App.toast(L("讀取 CSV 失敗：", "Could not read the CSV: ") + err.message, "error");
    }
  }

  /** -> the snapshot as the page now reads it. */
  function saveSnapshot(records, source) {
    snapshot = null; // force a re-normalise on the next render
    const at = new Date().toISOString();
    if (Ado.writeCache(records, { source, at })) return rows();
    // Too big (or no quota) for localStorage: keep it in memory for this page only.
    snapshot = { ...snapOf(records, at, source + L("（未存入本機）", " (not saved locally)")), memory: true };
    App.toast(
      L("資料量太大，這次的擷取結果只留在這個分頁，重新整理後需要再擷取一次。", "Too much data: this fetch stays in this tab only, so after a reload you need to fetch again.") +
        (Ado.cfg().doneDays > 0 ? L("可在「ADO 設定」把已完成項目的天數調小。", ' Lower the done-item days in "ADO settings".') : "")
    );
    return snapshot;
  }

  /** Connection settings and the PAT. The PAT never goes into the dataset, the URL or a log. */
  async function openConfig() {
    const cfg = Ado.cfg();
    const r = await App.form({
      title: L("ADO 連線設定", "ADO connection"),
      saveLabel: L("儲存並擷取", "Save and fetch"),
      extra: [{ value: "file", label: L("從 .ado_pat 檔載入", "Load from .ado_pat file") }].concat(Ado.patRemembered() || Ado.pat() ? [{ value: "forget", label: L("清除已存的 PAT", "Clear saved PAT") }] : []),
      fields: [
        { key: "org", label: L("組織", "Organization"), value: cfg.org, required: true },
        { key: "project", label: L("專案", "Project"), value: cfg.project, required: true },
        {
          key: "pat",
          label: "PAT",
          type: "password",
          value: Ado.pat(),
          wide: true,
          required: true,
          hint:
            {
              file: L(`目前的 PAT 來自 ${Ado.patFile()}（tools/ado_pat.ps1 產生），開這一頁就會自動擷取。`, `The current PAT comes from ${Ado.patFile()} (made by tools/ado_pat.ps1); this page fetches by itself when it opens.`),
              remembered: L("目前的 PAT 存在這台電腦。", "The current PAT is stored on this computer."),
              session: L("目前的 PAT 只記在這個分頁。", "The current PAT is kept in this tab only."),
              none: L(`還沒有 PAT。可貼上，或按「從 .ado_pat 檔載入」選 ${Ado.patFile()}。`, `No PAT yet. Paste one, or press "Load from .ado_pat file" and pick ${Ado.patFile()}.`),
            }[Ado.patSource()] +
            L(
              " 在 ADO 的 User settings → Personal access tokens 建立，scope 只要勾 Work Items (Read)；只會送到 dev.azure.com。",
              " Create it in ADO under User settings → Personal access tokens with only the Work Items (Read) scope; it is only sent to dev.azure.com."
            ),
        },
        {
          key: "remember",
          label: L("PAT 保存方式", "Keep PAT"),
          type: "check",
          text: L("記住 PAT（存在這台電腦）", "Remember PAT (store on this computer)"),
          value: Ado.patRemembered(),
          hint: L("不勾選只記在這個分頁，關掉就消失；共用電腦建議不要勾", "Unticked, it lives in this tab only and is gone when it closes; leave it unticked on a shared computer"),
        },
        {
          key: "doneDays",
          label: L("已完成項目（天）", "Done items (days)"),
          type: "number",
          min: 0,
          value: cfg.doneDays,
          more: true,
          hint: L(
            "一併擷取最近幾天內有更新的已完成項目（Done / Closed…），看板勾「含已完成」才會顯示；0 = 只擷取未完成。天數越大資料越多。",
            'Also fetch done items (Done / Closed…) updated within this many days; the board shows them with "Include done". 0 = open items only. More days, more data.'
          ),
        },
        { key: "where", label: L("額外條件（WIQL）", "Extra condition (WIQL)"), value: cfg.where, more: true, wide: true, placeholder: "[System.AreaPath] UNDER 'Monica\\Gen11'" },
        {
          key: "queryId",
          label: L("已存查詢 GUID", "Saved query GUID"),
          value: cfg.queryId,
          more: true,
          wide: true,
          hint: L("填了就改用 ADO 上存好的查詢，忽略上面的額外條件", "When filled, the saved ADO query is used instead and the extra condition above is ignored"),
        },
      ],
    });
    if (!r) return;
    if (r.action === "file") return $("#adoPatFile").click();
    if (r.action === "forget") {
      Ado.forgetPat();
      return App.toast(
        Ado.pat()
          ? L(`已清除瀏覽器裡的 PAT；${Ado.patFile()} 提供的那一組仍然有效（要停用請刪掉 data/ado_pat.js）`, `Cleared the PAT in the browser; the one from ${Ado.patFile()} still works (delete data/ado_pat.js to stop it)`)
          : L("已清除這台電腦上儲存的 PAT", "Cleared the PAT stored on this computer")
      );
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
