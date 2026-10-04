/*
 * Import dialogs: MONICA JSON, Gen12 PFAM Excel, and restoring a JSON backup.
 * Both imports show a preview (new / updated / unchanged / no longer in the file) where tasks can be
 * ticked one by one; unticked new tasks are remembered and stay unticked on the next import.
 * Gen12 tasks go into the "Gen12 AMD" project by default (pre-ticked: LEAD has STE or TE).
 */
(function () {
  const { esc, $, $$, fmt } = U;
  let xlsxLoading = null;
  let ctx = null; // { kind, items, plan, phases, fileName, createEmployees, showSame, (gen12) ds, projectId, newName, roles, roleOnly }

  /** SheetJS is ~880 KB: load it only when someone imports. Works from file:// too. */
  function loadXlsx() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    if (!xlsxLoading)
      xlsxLoading = new Promise((resolve, reject) => {
        const el = document.createElement("script");
        el.src = "js/vendor/xlsx.full.min.js";
        el.onload = () => resolve(window.XLSX);
        el.onerror = () => {
          xlsxLoading = null;
          reject(new Error("無法載入 js/vendor/xlsx.full.min.js"));
        };
        document.head.appendChild(el);
      });
    return xlsxLoading;
  }

  /** Default Gen12 target: the "Gen12 AMD" project (else a project that already holds Gen12 imports). */
  function gen12Target() {
    const d = Store.data;
    const exact = d.projects.find((p) => Convert.normName(p.name) === "gen12 amd");
    if (exact) return exact.id;
    const has = d.projects.find((p) => d.pfams.some((f) => f.projectId === p.id && f.src && f.src.kind === "gen12"));
    return has ? has.id : "";
  }

  // ------------------------------------------------------------------ planning
  function replan() {
    const d = Store.data;
    if (ctx.kind === "gen12") {
      const target = ctx.projectId ? Store.project(ctx.projectId) : null;
      const projName = target ? target.name : ctx.newName || "Gen12 AMD";
      const res = Convert.gen12Items(ctx.ds, { roles: ctx.roles, projKey: "gen12|" + projName, projName });
      ctx.items = res.items;
      ctx.noDate = res.noDate;
      const pfIds = new Set(d.pfams.filter((f) => target && f.projectId === target.id).map((f) => f.id));
      ctx.plan = Convert.plan(d, "gen12", ctx.items, { scope: (t) => pfIds.has(t.pfamId) });
      return;
    }
    // A file with only some Series must not offer to delete the other Series' tasks.
    const keys = new Set(ctx.items.map((i) => i.projKey));
    const names = new Set(ctx.items.map((i) => Convert.normName(i.projName)));
    const inFile = new Set(d.projects.filter((p) => (p.src && keys.has(p.src.key)) || names.has(Convert.normName(p.name))).map((p) => p.id));
    const pfIds = new Set(d.pfams.filter((f) => inFile.has(f.projectId)).map((f) => f.id));
    ctx.plan = Convert.plan(d, "monica", ctx.items, { scope: (t) => pfIds.has(t.pfamId) });
  }

  // ------------------------------------------------------------------ dialog
  function render() {
    const pl = ctx.plan;
    const rows = pl.rows;
    const by = (s) => rows.filter((r) => r.status === s);
    const fresh = by("new");
    const upd = by("update");
    const same = by("same");
    const onN = fresh.filter((r) => r.on).length;
    const goneOn = pl.gone.filter((g) => g.on).length;
    const isG = ctx.kind === "gen12";

    // Group rows by PFAM in file order.
    const groups = new Map();
    rows.forEach((r, i) => {
      if (r.status === "same" && !ctx.showSame) return;
      if (isG && ctx.roleOnly && r.status === "new" && !r.item.roleMatch) return;
      const k = r.item.pfamKey;
      if (!groups.has(k)) groups.set(k, { name: r.item.pfamName, series: r.item.projName, list: [] });
      groups.get(k).list.push(i);
    });

    const dates = (r) => {
      const it = r.item;
      if (r.status === "update" && (r.task.start !== it.start || r.task.end !== it.end))
        return `<span class="muted">${fmt(r.task.start, "yy")}–${fmt(r.task.end, "short")}</span> → <b>${fmt(it.start, "yy")}–${fmt(it.end, "short")}</b>`;
      return `${fmt(it.start, "yy")} – ${fmt(it.end, "short")}`;
    };
    const tag = (r) =>
      r.status === "new" ? `<span class="tag imp-new">新</span>` : r.status === "update" ? `<span class="tag imp-upd">更新</span>` : `<span class="tag ghost">無變動</span>`;
    const phaseLabel = (key) => {
      const k = Convert.resolvePhase(Store.data, key);
      return (k && (Store.phase(k) || {}).label) || ((ctx.phases || []).find((p) => p.key === key) || {}).label || key;
    };
    const groupHtml = [...groups.values()]
      .map((g) => {
        const newIdx = g.list.filter((i) => rows[i].status === "new");
        const onIn = newIdx.filter((i) => rows[i].on).length;
        return `<details class="imp-group"${groups.size <= 3 || onIn ? " open" : ""}>
          <summary><label class="check" onclick="event.stopPropagation()"><input type="checkbox" data-grp="${esc(newIdx.join(","))}"${newIdx.length && onIn === newIdx.length ? " checked" : ""}${newIdx.length ? "" : " disabled"}></label>
            <b>${esc(g.name)}</b><span class="muted">${isG ? "" : esc(g.series)}${newIdx.length ? `・新 ${onIn}/${newIdx.length} 勾選` : ""}${g.list.length - newIdx.length ? `・更新/無變動 ${g.list.length - newIdx.length}` : ""}</span></summary>
          <table class="imp-table"><tbody>${g.list
            .map((i) => {
              const r = rows[i];
              const it = r.item;
              return `<tr class="${r.status}${it.inherited ? " inh" : ""}"><td class="c"><input type="checkbox" data-row="${i}"${r.on ? " checked" : ""}${r.status === "new" ? "" : " disabled"}></td>
                <td>${tag(r)} ${esc(it.name)}${it.section ? `<small class="muted"> · ${esc(it.section)}</small>` : ""}${it.inherited ? ` <span class="tag ghost" title="2nd build 中從 1st build 複製的區段">沿用 1st</span>` : ""}</td>
                <td class="muted small">${esc(it.lead || (it.phase ? phaseLabel(it.phase) : ""))}</td>
                <td class="num small">${dates(r)}</td>
                <td class="small">${r.task && r.task.assignees.length ? `<span class="muted">保留指派：</span>${esc(r.task.assignees.map((id) => Store.empName(id)).join("、"))}` : it.assignNames && it.assignNames.length ? esc(it.assignNames.join("、")) : ""}</td></tr>`;
            })
            .join("")}</tbody></table></details>`;
      })
      .join("");

    const goneHtml = pl.gone.length
      ? `<section class="imp-sec"><h4><label class="check"><input type="checkbox" data-goneall${goneOn === pl.gone.length ? " checked" : ""}> 新檔裡已經沒有（${pl.gone.length}）</label><span class="muted">預設保留；勾選＝刪除</span></h4><table class="imp-table"><tbody>${pl.gone
          .map((g, i) => {
            const t = g.task;
            return `<tr><td class="c"><input type="checkbox" data-gone="${i}"${g.on ? " checked" : ""}></td><td>${esc(t.name)} <small class="muted">${esc((Store.pfam(t.pfamId) || {}).name || "")}</small></td><td class="num small">${U.range(t.start, t.end)}</td><td class="small">${esc(t.assignees.map((id) => Store.empName(id)).join("、"))}</td></tr>`;
          })
          .join("")}</tbody></table></section>`
      : "";

    const projOpts = Store.data.projects.map((p) => `<option value="${p.id}"${p.id === ctx.projectId ? " selected" : ""}>${esc(p.name)}</option>`).join("");
    const options = isG
      ? `<div class="imp-opts">
          <label class="field-inline">匯入到 <select id="impProj"><option value=""${ctx.projectId ? "" : " selected"}>＋ 新 Project</option>${projOpts}</select></label>
          ${ctx.projectId ? "" : `<input id="impNewName" value="${esc(ctx.newName)}" placeholder="新 Project 名稱">`}
          <label class="field-inline">預設勾選的 LEAD 角色 <input id="impRoles" value="${esc(ctx.roles)}" class="w-roles"></label>
          <button class="btn small" id="impReselect" type="button">依角色重新勾選</button>
          <label class="check small"><input type="checkbox" id="impRoleOnly"${ctx.roleOnly ? " checked" : ""}> 只列出 LEAD 符合的新 task</label>
          <label class="check small"><input type="checkbox" id="impSame"${ctx.showSame ? " checked" : ""}> 顯示無變動</label>
        </div>`
      : `<div class="imp-opts">
          <label class="check small"><input type="checkbox" id="impCreate"${ctx.createEmployees ? " checked" : ""}> PIC 比對不到名冊時，自動新增為員工</label>
          <label class="check small"><input type="checkbox" id="impSame"${ctx.showSame ? " checked" : ""}> 顯示無變動</label>
        </div>`;
    $("#impTitle").textContent = (isG ? "匯入 Gen12 PFAM Excel" : "匯入 MONICA JSON") + "：" + ctx.fileName;
    $("#impBody").innerHTML = `
      ${options}
      <div class="imp-chips">
        <span class="imp-chip c-new"><b>${onN}</b> / ${fresh.length} 個新 task 勾選</span>
        <span class="imp-chip c-update"><b>${upd.length}</b> 個更新日期／名稱</span>
        <span class="imp-chip c-same"><b>${same.length}</b> 個無變動</span>
        ${pl.gone.length ? `<span class="imp-chip c-gone"><b>${goneOn}</b> / ${pl.gone.length} 個將刪除</span>` : ""}
      </div>
      <p class="muted small">${isG ? `同一 PFAM 的 1st + 2nd build 合併為一個 PFAM；2nd build 中「沿用 1st」的區段不預先勾選，避免重複計算。${ctx.noDate ? `${ctx.noDate} 個沒有日期（TBD）的 task 已略過。` : ""}` : "Series → Project、project → PFAM；task 名稱空白時以 Phase 名稱代替。"}
        更新的 task 會保留網頁上的指派、完成狀態與備註，舊日期成為基準（甘特圖顯示 ▲▼）。</p>
      ${groupHtml || `<p class="imp-nothing">沒有需要顯示的項目</p>`}
      ${goneHtml}`;
    $("#impSummary").textContent = `將新增 ${onN}、更新 ${upd.length}${goneOn ? `、刪除 ${goneOn}` : ""}`;
  }

  function onChange(ev) {
    const t = ev.target;
    if (t.dataset.row) ctx.plan.rows[+t.dataset.row].on = t.checked;
    else if (t.dataset.grp !== undefined) {
      for (const i of t.dataset.grp.split(",").filter(Boolean)) ctx.plan.rows[+i].on = t.checked;
    } else if (t.dataset.gone) ctx.plan.gone[+t.dataset.gone].on = t.checked;
    else if (t.dataset.goneall !== undefined) ctx.plan.gone.forEach((g) => (g.on = t.checked));
    else if (t.id === "impProj") {
      ctx.projectId = t.value;
      replan();
    } else if (t.id === "impNewName") {
      ctx.newName = t.value.trim();
      replan();
    } else if (t.id === "impRoles") ctx.roles = t.value;
    else if (t.id === "impRoleOnly") ctx.roleOnly = t.checked;
    else if (t.id === "impSame") ctx.showSame = t.checked;
    else if (t.id === "impCreate") ctx.createEmployees = t.checked;
    else return;
    const open = new Set($$("#impBody details[open] summary b").map((b) => b.textContent));
    const scroll = $("#impBody").scrollTop;
    render();
    $$("#impBody details").forEach((dd) => open.has(dd.querySelector("summary b").textContent) && (dd.open = true));
    $("#impBody").scrollTop = scroll;
  }

  function apply() {
    if (!ctx) return;
    const pl = ctx.plan;
    let counts;
    const isG = ctx.kind === "gen12";
    Store.commit((d) => {
      Convert.migratePhases(d); // old rack phase keys -> current ones before matching the file's phases
      if (ctx.phases) Convert.mergePhases(d, ctx.phases);
      Convert.migratePhases(d);
      if (d.source && d.source.demo) d.source.demo = false;
      counts = Convert.apply(d, pl, { projectId: isG && ctx.projectId ? ctx.projectId : undefined, createEmployees: ctx.createEmployees });
      if (isG) d.settings.gen12Roles = ctx.roles;
    });
    $("#dlgImport").close();
    const msg = `已匯入 ${ctx.fileName}：新增 ${counts.added}、更新 ${counts.updated}${counts.removed ? `、刪除 ${counts.removed}` : ""} 個 task${counts.projects ? `，新 Project ${counts.projects}` : ""}${counts.pfams ? `、新 PFAM ${counts.pfams}` : ""}`;
    App.toast(msg, "", [{ label: "復原", run: () => Store.undo() }]);
    if (counts.unmatched.length) App.toast(`PIC 比對不到名冊：${counts.unmatched.join("、")}（可勾選「自動新增為員工」重新匯入，或到設定 → 員工名冊新增後再匯入）`, "error");
    ctx = null;
  }

  function open(next) {
    ctx = { showSame: false, roleOnly: false, createEmployees: false, ...next };
    replan();
    render();
    $("#dlgImport").showModal();
  }

  function openMonica(json, fileName) {
    const m = Convert.monicaItems(json);
    open({ kind: "monica", items: m.items, phases: m.phases, fileName });
  }

  function openGen12(ds, fileName) {
    open({ kind: "gen12", ds, fileName, projectId: gen12Target(), newName: "Gen12 AMD", roles: Store.data.settings.gen12Roles || "STE, TE" });
  }

  async function pickXlsx(file) {
    App.toast(`讀取 ${file.name}…`);
    try {
      const XLSX = await loadXlsx();
      const wb = XLSX.read(await file.arrayBuffer(), { type: "array", cellFormula: true, cellNF: true, cellDates: false });
      openGen12(Importer.convert(XLSX, wb, file.name), file.name);
    } catch (err) {
      console.error(err);
      App.toast("讀取 Excel 失敗：" + err.message, "error");
    }
  }

  /** One JSON picker for all formats: our backup, a MONICA export, or a Gen12 dataset. */
  async function pickJson(file, expect) {
    let json;
    try {
      json = JSON.parse(await U.readFile(file));
    } catch (err) {
      return App.toast("不是有效的 JSON：" + err.message, "error");
    }
    try {
      if (json && Array.isArray(json.tasks) && (json.labels || (json.tasks[0] && "category" in json.tasks[0]))) return openMonica(json, file.name);
      if (json && Array.isArray(json.pfams) && json.calendars) return openGen12(json, file.name);
      const data = json && json.data && json.data.projects ? json.data : json && json.projects ? json : null;
      if (!data) return App.toast(expect === "monica" ? "這不是 MONICA 匯出的 JSON" : "看不出這是哪一種 JSON（支援：本系統備份、MONICA 匯出、Gen12 資料）", "error");
      if (!confirm(`用「${file.name}」還原？目前全部資料會被取代（可按 ↶ 復原）。\n\n${data.projects.length} 個 Project、${(data.tasks || []).length} 個 task、${(data.employees || []).length} 位員工`)) return;
      Store.replace(data, { keepUndo: true, dirty: true });
      App.toast("已還原備份");
    } catch (err) {
      console.error(err);
      App.toast("匯入失敗：" + err.message, "error");
    }
  }

  function bind() {
    const take = (id, fn) =>
      $(id).addEventListener("change", (ev) => {
        const f = ev.target.files[0];
        ev.target.value = "";
        if (f) fn(f);
      });
    take("#fileXlsx", pickXlsx);
    take("#fileMonica", (f) => pickJson(f, "monica"));
    take("#fileJson", (f) => pickJson(f, "backup"));
    const d = $("#dlgImport");
    d.addEventListener("change", onChange);
    d.addEventListener("click", (ev) => {
      if (ev.target.id !== "impReselect") return;
      replan();
      render();
    });
    $("#impApply").onclick = apply;
  }

  window.ImportUI = { bind, openMonica, openGen12 };
})();
