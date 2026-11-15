/*
 * MTE PFAM sync: the running PFAMs HQ and local MTEs share, and which of them need local help.
 * Unlike every other tab, anyone may add, change or delete rows: no 編輯模式, no password. The rows are
 * NOT department data (Store.data): they live in the Collab sheet and each one is saved to the cloud by
 * itself the moment it is saved here (Remote.collabPost), with a per-row rev so two people saving the
 * same row find out. The page re-reads every minute while open, and when its browser tab comes back.
 * Bilingual (中文 English) because local MTEs read it too.
 */
(function () {
  const { esc, $ } = U;
  const LS_CACHE = "llt800.collab.v1"; // { rev, rows }: shown at once on the next visit, then refreshed
  const LS_UI = "llt800.collab.ui.v1"; // { site, owner } filters, per browser
  const POLL_MS = 60000;

  const OWNER = { hq: ["HQ 自行執行", "HQ runs it"], local: ["需要 local MTE 支援", "Needs local MTE"] };
  const TYPE = { npi: ["NPI pilot"], closedloop: ["Closed loop"], vb: ["VB"] };
  const STATUS = { todo: ["待執行", "To do"], doing: ["執行中", "In progress"], done: ["完成", "Done"] };
  const bi = (pair) => `${pair[0]} ${pair[1]}`;

  const read = (key, fallback) => {
    try {
      return JSON.parse(localStorage.getItem(key)) || fallback;
    } catch {
      return fallback;
    }
  };
  const write = (key, v) => {
    try {
      localStorage.setItem(key, JSON.stringify(v));
    } catch {
      /* private window / full: fine, this is only a cache */
    }
  };

  const cache = read(LS_CACHE, {});
  const state = { rev: Number(cache.rev) || 0, rows: Array.isArray(cache.rows) ? cache.rows : [], at: 0, tried: false, loading: false, error: "", oldBackend: false, outdated: "" };
  let timer = 0;

  const onPage = () => window.App && App.route.name === "collab";
  const rerender = () => onPage() && App.render();

  /** Re-read the rows; `full` skips the "unchanged" shortcut. */
  async function refresh(full) {
    if (!Remote.active || state.loading) return;
    state.loading = true;
    state.tried = true;
    const was = state.rev;
    try {
      const r = await Remote.collabLoad(full ? null : state.rev);
      if (!r.unchanged) state.rows = r.rows;
      state.rev = r.rev;
      state.error = "";
      state.oldBackend = false;
      state.outdated = r.outdated ? r.outdatedMsg : "";
      write(LS_CACHE, { rev: state.rev, rows: state.rows });
      state.at = Date.now();
      if (!r.unchanged || was !== r.rev) return rerender();
      const at = $("#cbAt");
      if (at && onPage()) at.textContent = stamp();
    } catch (err) {
      state.error = err.message;
      state.oldBackend = !!err.oldBackend;
      rerender();
    } finally {
      state.loading = false;
    }
  }

  function ensurePolling() {
    if (timer) return;
    timer = setInterval(() => {
      if (!onPage()) {
        clearInterval(timer);
        timer = 0;
        return;
      }
      if (!document.hidden) refresh();
    }, POLL_MS);
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && onPage() && Date.now() - state.at > 5000) refresh();
  });

  const stamp = () => (state.at ? `更新於 Updated ${new Date(state.at).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", hour12: false })}` : "讀取中… Loading…");
  const when = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d)) return "";
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  // ------------------------------------------------------------ choices

  /** Project names to pick from: the department's active projects (plus the row's own, if it is gone since). */
  function projectChoices(current) {
    const names = Store.data.projects.filter((p) => (p.status || "active") === "active").map((p) => p.name);
    return current && !names.includes(current) ? [current, ...names] : names;
  }

  /** The department's site list first (its order), then any other site in use. */
  function siteOrder(extra) {
    const out = [...Store.data.settings.sites];
    const more = [...Store.data.pfams.map((f) => f.site), ...state.rows.map((r) => r.site), ...(extra || [])].filter((s) => s && !out.includes(s));
    return out.concat([...new Set(more)].sort());
  }

  // ------------------------------------------------------------ saving

  async function send(payload) {
    $("#blockerSkip").onclick = () => App.blocker(false);
    App.blocker(true, "儲存中… Saving…");
    try {
      return await Remote.collabPost(payload);
    } catch (err) {
      App.toast("儲存失敗 Save failed: " + err.message, "error");
      return null;
    } finally {
      App.blocker(false);
    }
  }

  /** Put a row the backend sent back in place; `rev` one past ours means nobody else wrote meanwhile. */
  function apply(row, rev) {
    const i = state.rows.findIndex((r) => r.id === row.id);
    if (i < 0) state.rows.push(row);
    else state.rows[i] = row;
    if (rev === state.rev + 1) {
      state.rev = rev;
      write(LS_CACHE, { rev: state.rev, rows: state.rows });
    } else setTimeout(() => refresh(true));
  }

  async function save(row, baseRev) {
    let r = await send({ action: "collabSave", row, baseRev });
    if (!r) return;
    if (r.conflict) {
      const mine = confirm(
        "這一列剛被別人改過。\nSomeone else just changed this row.\n\n確定 OK：用我的內容覆蓋 Overwrite with mine\n取消 Cancel：放棄我的修改，載入對方的內容 Discard mine, load theirs"
      );
      if (!mine) {
        const i = state.rows.findIndex((x) => x.id === r.row.id);
        if (i >= 0) state.rows[i] = r.row;
        App.toast("已載入最新內容 Loaded the latest version");
        return rerender();
      }
      r = await send({ action: "collabSave", row, baseRev: r.row.rev });
      if (!r) return;
      if (r.conflict) {
        App.toast("又被別人改了，請重新編輯 Changed again, please edit once more", "error");
        return refresh(true);
      }
    }
    apply(r.row, r.rev);
    App.toast("已儲存 Saved");
    rerender();
  }

  async function setDeleted(id, del) {
    const r = await send({ action: del ? "collabDelete" : "collabRestore", id });
    if (!r) return;
    apply(r.row, r.rev);
    App.toast(del ? "已刪除，可在「已刪除」復原 Deleted (restorable below)" : "已復原 Restored", "", del ? [{ label: "復原 Undo", run: () => setDeleted(id, false) }] : []);
    rerender();
  }

  // ------------------------------------------------------------ editor

  async function edit(id) {
    const row = id ? state.rows.find((r) => r.id === id) : null;
    if (id && !row) return;
    const ui = read(LS_UI, {});
    const projects = projectChoices(row && row.project);
    const sites = siteOrder(row ? [row.site] : []);
    const v = row || { owner: "hq", status: "todo", site: ui.site && ui.site !== "*" ? ui.site : "" };
    const fields = [
      {
        key: "project", label: "Project", type: "select", required: true, value: v.project,
        options: [{ value: "", label: "— 請選擇 Select —" }, ...projects.map((p) => ({ value: p, label: p }))],
        validate: (x) => (x ? "" : "請選擇 Project Please pick a project"),
      },
      { key: "pfam", label: "PFAM", required: true, value: v.pfam, placeholder: "例如 e.g. Gen11.1 MM34 FTB" },
      {
        key: "type", label: "Task 類型 Task type", type: "select", required: true, value: v.type,
        options: [{ value: "", label: "— 請選擇 Select —" }, ...Object.keys(TYPE).map((k) => ({ value: k, label: TYPE[k][0] }))],
        validate: (x) => (x ? "" : "請選擇 Task 類型 Please pick a task type"),
      },
      {
        key: "site", label: "廠區 Site", type: "select", required: true, value: v.site,
        options: [{ value: "", label: "— 請選擇 Select —" }, ...sites.map((s) => ({ value: s, label: s }))],
        validate: (x) => (x ? "" : "請選擇廠區 Please pick a site"),
      },
      { key: "pn", label: "L10 PN", required: true, value: v.pn },
      { key: "pod", label: "Pod 位置 Pod location", value: v.pod },
      { key: "owner", label: "執行方 Owner", type: "select", value: v.owner, options: Object.keys(OWNER).map((k) => ({ value: k, label: bi(OWNER[k]) })) },
      { key: "start", label: "開始 Start", type: "date", value: v.start },
      { key: "end", label: "結束 End", type: "date", value: v.end, validate: (x, all) => (x && all.start && x < all.start ? "結束日早於開始日 End is before start" : "") },
      { key: "status", label: "狀態 Status", type: "select", value: v.status, options: Object.keys(STATUS).map((k) => ({ value: k, label: bi(STATUS[k]) })) },
      { key: "note", label: "備註 Note", type: "textarea", wide: true, value: v.note },
    ];
    const pending = App.form({
      title: row ? "編輯 PFAM Edit PFAM" : "新增 PFAM Add PFAM",
      fields,
      del: !!row,
      saveLabel: "儲存 Save",
      labels: { del: "刪除 Delete", cancel: "取消 Cancel" },
    });
    const res = await pending;
    if (!res) return;
    if (res.action === "delete") {
      if (confirm("刪除這一列？之後可在「已刪除」復原。\nDelete this row? It can be restored from Deleted.")) setDeleted(row.id, true);
      return;
    }
    await save({ ...res.values, id: row ? row.id : "" }, row ? row.rev : 0);
  }

  // ------------------------------------------------------------ render

  const pill = (cls, pair) => `<span class="cb-pill ${cls}">${esc(pair[0])}<small>${esc(pair[1])}</small></span>`;

  function table(rows, opts) {
    // Fixed column widths, so the per-site cards line up under each other.
    const head = `<tr><th class="w-proj">Project</th><th class="w-pfam">PFAM</th><th class="w-type">類型 Type</th>${opts.site ? '<th class="w-site">廠區 Site</th>' : ""}<th class="w-pn">L10 PN</th><th class="w-pod">Pod 位置 Pod</th><th class="w-sch">Schedule</th><th class="w-own">執行方 Owner</th><th class="w-st">狀態 Status</th><th>備註 Note</th><th class="w-upd">${opts.deleted ? "刪除於 Deleted" : "更新 Updated"}</th>${opts.deleted ? '<th class="w-act"></th>' : ""}</tr>`;
    const body = rows
      .map(
        (r) => `<tr${opts.deleted ? "" : ` data-row="${esc(r.id)}" tabindex="0"`} class="cb-row st-${esc(r.status)}">
          <td>${esc(r.project)}</td><td><b>${esc(r.pfam)}</b></td><td>${TYPE[r.type] ? esc(TYPE[r.type][0]) : '<span class="muted">—</span>'}</td>${opts.site ? `<td>${esc(r.site)}</td>` : ""}<td>${esc(r.pn)}</td><td>${esc(r.pod)}</td>
          <td class="nowrap">${r.start || r.end ? esc(U.range(r.start, r.end || r.start)) : '<span class="muted">—</span>'}</td>
          <td>${pill("cb-o-" + r.owner, OWNER[r.owner] || OWNER.hq)}</td><td>${pill("cb-s-" + r.status, STATUS[r.status] || STATUS.todo)}</td>
          <td class="cb-note" title="${esc(r.note)}">${esc(r.note)}</td><td class="muted small nowrap">${esc(when(r.updatedAt))}</td>
          ${opts.deleted ? `<td><button class="btn small" type="button" data-restore="${esc(r.id)}">復原 Restore</button></td>` : ""}</tr>`
      )
      .join("");
    return `<div class="table-wrap"><table class="grid-table cb-table"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
  }

  /** By start date; rows without one last. */
  const byStart = (a, b) => (a.start || "9999").localeCompare(b.start || "9999") || (a.project || "").localeCompare(b.project || "") || (a.pfam || "").localeCompare(b.pfam || "");

  function render(root) {
    const head = `<div class="page-head"><h2>MTE PFAM sync</h2>
      <span class="muted">HQ 與 local MTE 共同維護，所有人都能新增、修改、刪除・Shared with local MTEs: everyone can add, edit and delete</span></div>`;
    if (!Remote.active) {
      root.innerHTML = `${head}<section class="card"><p class="empty">這一頁需要啟用雲端同步才能使用。<br>This page needs cloud sync. <a href="#/settings/cloud">設定 → 雲端同步 Settings</a></p></section>`;
      return;
    }
    ensurePolling();
    if (!state.tried) refresh();

    const ui = Object.assign({ site: "*", owner: "*" }, read(LS_UI, {}));
    const live = state.rows.filter((r) => !r.deleted);
    const pass = (r) => (ui.site === "*" || r.site === ui.site) && (ui.owner === "*" || r.owner === ui.owner);
    const open = live.filter((r) => r.status !== "done");
    const shown = open.filter(pass);
    const done = live.filter((r) => r.status === "done" && pass(r)).sort(byStart);
    const gone = state.rows.filter((r) => r.deleted).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const order = siteOrder();
    const sitesInUse = order.filter((s) => open.some((r) => r.site === s) || s === ui.site);
    const needLocal = open.filter((r) => r.owner === "local").length;

    const seg = (key, opts) =>
      `<div class="seg" role="group">${opts.map(([val, label]) => `<button type="button" data-${key}="${esc(val)}" class="${ui[key] === val ? "on" : ""}">${esc(label)}</button>`).join("")}</div>`;

    const groups = order
      .filter((s) => shown.some((r) => r.site === s))
      .map((s) => {
        const list = shown.filter((r) => r.site === s).sort(byStart);
        const nl = list.filter((r) => r.owner === "local").length;
        return `<section class="card cb-group"><header class="card-h"><h3>${esc(s)}</h3><span class="count">${list.length}</span>${nl ? `<span class="cb-need">${nl} 需要 local 支援 need local</span>` : ""}</header>${table(list, {})}</section>`;
      })
      .join("");

    root.innerHTML = `<div id="cbPage">${head}
      <div class="cb-bar">
        <span class="cb-lbl">廠區 Site</span>${seg("site", [["*", "全部 All"], ...sitesInUse.map((s) => [s, s])])}
        <span class="cb-lbl">執行方 Owner</span>${seg("owner", [["*", "全部 All"], ["hq", "HQ"], ["local", "需 local 支援 Local"]])}
        <span class="grow"></span>
        <span class="muted small" id="cbAt">${esc(stamp())}</span>
        <button class="btn" type="button" id="cbRefresh" title="重新讀取 Reload">⟳</button>
        <button class="btn primary" type="button" id="cbAdd">＋ 新增 PFAM Add</button>
      </div>
      ${state.outdated && !state.error ? `<p class="cb-err">${esc(state.outdated)}</p>` : ""}
      ${state.error ? `<p class="cb-err">${state.oldBackend ? "" : "讀取失敗，以下是這台電腦上次的資料 Could not load, showing the last copy on this computer: "}${esc(state.error)}</p>` : ""}
      <p class="small cb-sum">執行中 / 待執行 Open: <b>${open.length}</b>・需要 local 支援 Need local: <b>${needLocal}</b></p>
      ${groups || `<section class="card"><p class="empty">${open.length ? "沒有符合篩選的 PFAM。No PFAM matches the filter." : "目前沒有執行中的 PFAM。按「＋ 新增 PFAM」加第一筆。<br>No running PFAM yet. Use “＋ Add” to add one."}</p></section>`}
      ${done.length ? `<details class="card fold-card"><summary class="card-h"><h3>已完成 Done</h3><span class="count">${done.length}</span></summary>${table(done, { site: true })}</details>` : ""}
      ${gone.length ? `<details class="card fold-card"><summary class="card-h"><h3>已刪除 Deleted</h3><span class="count">${gone.length}</span><span class="muted">任何人都能復原 Anyone can restore</span></summary>${table(gone, { site: true, deleted: true })}</details>` : ""}
    </div>`;

    const page = $("#cbPage");
    page.onclick = (ev) => {
      const t = ev.target;
      const f = t.closest("[data-site], [data-owner]");
      if (f) {
        const key = f.dataset.site !== undefined ? "site" : "owner";
        write(LS_UI, Object.assign(ui, { [key]: f.dataset[key] }));
        return App.render();
      }
      const rs = t.closest("[data-restore]");
      if (rs) return setDeleted(rs.dataset.restore, false);
      if (t.closest("#cbAdd")) return edit(null);
      if (t.closest("#cbRefresh")) return refresh(true);
      const tr = t.closest("tr[data-row]");
      if (tr) edit(tr.dataset.row);
    };
    page.onkeydown = (ev) => {
      const tr = ev.target.closest && ev.target.closest("tr[data-row]");
      if (tr && (ev.key === "Enter" || ev.key === " ")) {
        ev.preventDefault();
        edit(tr.dataset.row);
      }
    };
  }

  window.CollabView = { render };
})();
