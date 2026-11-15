/* App shell: router, header actions, toasts, the generic form dialog, edit mode and cloud sync. */
(function () {
  const { $, $$, esc } = U;
  const SCROLLERS = [".g-scroll", ".lc-scroll", ".heat-wrap", ".table-wrap"];
  /** [key, element] for every scrolling box in the page. */
  function scrollers(root) {
    const out = [];
    for (const sel of SCROLLERS)
      root.querySelectorAll(sel).forEach((sc, i) => {
        const host = sc.parentElement && sc.parentElement.id;
        out.push([host ? sel + "@" + host : sel + "#" + i, sc]);
      });
    return out;
  }

  const VIEWS = { overview: window.OverviewView, projects: window.ProjectsView, collab: window.CollabView, ado: window.AdoView, load: window.LoadView, people: window.PeopleView, links: window.LinksView, settings: window.SettingsView };

  const App = {
    route: { name: "overview", arg: "" },
    cloudBusy: false, // a background cloud refresh is in flight (header chip shows 更新中)

    // ------------------------------------------------------------ toasts
    toast(msg, kind, actions) {
      const el = document.createElement("div");
      el.className = "toast " + (kind || "");
      el.innerHTML = `<span>${esc(msg)}</span>`;
      for (const a of actions || []) {
        const b = document.createElement("button");
        b.className = "link";
        b.textContent = a.label;
        b.onclick = () => {
          el.remove();
          a.run();
        };
        el.appendChild(b);
      }
      $("#toasts").appendChild(el);
      // Mid-screen, so it is seen; a plain note goes in 3 s, one with a button or an error stays long
      // enough to act on, and none goes while the pointer is on it.
      const close = () => {
        el.classList.add("out");
        setTimeout(() => el.remove(), 200);
      };
      const life = kind === "error" ? 8000 : actions && actions.length ? 6000 : 3000;
      let timer = setTimeout(close, life);
      el.onmouseenter = () => clearTimeout(timer);
      el.onmouseleave = () => (timer = setTimeout(close, 1500));
    },

    // ------------------------------------------------------------ form dialog
    /**
     * fields: [{ key, label, type: text|date|number|select|textarea|color|people|check|swatch, options, value,
     *            required, more, hint, placeholder, list }]
     * Resolves { action: "save", values } | { action: "delete" } | { action: <extra button value> } | null
     * labels: optional { del, cancel } button texts (the MTE PFAM sync tab is bilingual).
     */
    form({ title, fields, del, extra, saveLabel, labels }) {
      labels = labels || {};
      if (this._closeForm) this._closeForm(); // a form still open is cancelled, never left half-bound
      const d = $("#dlgForm");
      $("#formTitle").textContent = title;
      const field = (f) => {
        const id = "fld_" + f.key;
        const v = f.value == null ? "" : f.value;
        let input;
        if (f.type === "select")
          input = `<select id="${id}" name="${f.key}">${f.options.map((o) => `<option value="${esc(o.value)}"${String(o.value) === String(v) ? " selected" : ""}>${esc(o.label)}</option>`).join("")}</select>`;
        else if (f.type === "textarea") input = `<textarea id="${id}" name="${f.key}" rows="3" placeholder="${esc(f.placeholder || "")}">${esc(v)}</textarea>`;
        else if (f.type === "check") input = `<label class="check"><input type="checkbox" id="${id}" name="${f.key}"${v ? " checked" : ""}> ${esc(f.text || "")}</label>`;
        else if (f.type === "people") {
          const sel = new Set(v || []);
          const list = Store.data.employees.filter((e) => e.active || sel.has(e.id));
          input = `<div class="people-pick" data-key="${f.key}">${
            list.length
              ? list.map((e) => `<label class="pchip${e.active ? "" : " gone"}"><input type="checkbox" value="${e.id}"${sel.has(e.id) ? " checked" : ""}><span>${esc(e.name)}</span></label>`).join("")
              : `<span class="muted">${L("名冊是空的，先到「設定 › 員工名冊」新增員工", "The roster is empty: add people under Settings › Roster first")}</span>`
          }</div>`;
        } else if (f.type === "swatch")
          input = `<div class="swatches" data-key="${f.key}">${f.options
            .map((c) => `<label class="sw" style="--c:${c}"><input type="radio" name="${f.key}" value="${c}"${c === v ? " checked" : ""}><span></span></label>`)
            .join("")}<input type="color" name="${f.key}__custom" value="${esc(v || "#2a78d6")}" title="${L("自訂顏色", "Custom color")}"></div>`;
        else
          input = `<input id="${id}" name="${f.key}" type="${f.type || "text"}" value="${esc(v)}"${f.required ? " required" : ""}${f.list ? ` list="${id}_l"` : ""}${f.min != null ? ` min="${f.min}"` : ""}${f.max != null ? ` max="${f.max}"` : ""} placeholder="${esc(f.placeholder || "")}" autocomplete="off">${
            f.list ? `<datalist id="${id}_l">${f.list.map((o) => `<option value="${esc(o)}">`).join("")}</datalist>` : ""
          }`;
        return `<div class="field${f.wide ? " wide" : ""}"><label for="${id}">${esc(f.label)}${f.required ? ' <b class="req">*</b>' : ""}</label>${input}${f.hint ? `<small class="muted">${esc(f.hint)}</small>` : ""}</div>`;
      };
      const main = fields.filter((f) => !f.more);
      const more = fields.filter((f) => f.more);
      $("#formBody").innerHTML = `<div class="form-grid">${main.map(field).join("")}</div>${
        more.length ? `<details class="more"><summary>${L("更多欄位", "More fields")}</summary><div class="form-grid">${more.map(field).join("")}</div></details>` : ""
      }<p class="form-err" id="formErr" hidden></p>`;
      $("#formFoot").innerHTML = `${del ? `<button class="btn danger" value="delete" formnovalidate>${esc(labels.del || L("刪除", "Delete"))}</button>` : ""}${(extra || [])
        .map((x) => `<button class="btn" value="${esc(x.value)}" formnovalidate>${esc(x.label)}</button>`)
        .join("")}<span class="grow"></span><button class="btn" value="cancel" formnovalidate>${esc(labels.cancel || L("取消", "Cancel"))}</button><button class="btn primary" value="save">${esc(saveLabel || L("儲存", "Save"))}</button>`;
      // A custom color clears the swatch radio.
      $$(".swatches", d).forEach((w) => {
        const c = w.querySelector('input[type="color"]');
        c.addEventListener("input", () => w.querySelectorAll('input[type="radio"]').forEach((r) => (r.checked = false)));
      });

      return new Promise((resolve) => {
        const form = d.querySelector("form");
        const onSubmit = (ev) => {
          const action = ev.submitter ? ev.submitter.value : "save";
          if (action === "save") {
            const values = {};
            for (const f of fields) {
              if (f.type === "people") values[f.key] = $$(`.people-pick[data-key="${f.key}"] input:checked`, d).map((i) => i.value);
              else if (f.type === "check") values[f.key] = form.elements[f.key].checked;
              else if (f.type === "swatch") {
                const r = form.querySelector(`input[name="${f.key}"]:checked`);
                values[f.key] = r ? r.value : form.elements[f.key + "__custom"].value;
              } else values[f.key] = String(form.elements[f.key].value).trim();
            }
            const err = fields.map((f) => f.validate && f.validate(values[f.key], values)).find(Boolean);
            if (err) {
              ev.preventDefault();
              const p = $("#formErr");
              p.textContent = err;
              p.hidden = false;
              return;
            }
            done({ action, values });
          } else done(action === "cancel" ? null : { action });
        };
        // Enter in a field means 儲存. Left to the browser it presses the form's first submit button, the header ✕,
        // which closes the dialog and drops the edit.
        const onKey = (ev) => {
          if (ev.key !== "Enter" || ev.isComposing || ev.target.tagName !== "INPUT") return;
          ev.preventDefault();
          form.requestSubmit($('#formFoot button[value="save"]'));
        };
        const onClose = () => !d.open && done(null); // ignore a late close event from the form this one replaced
        let settled = false;
        function done(v) {
          if (settled) return;
          settled = true;
          App._closeForm = null;
          form.removeEventListener("submit", onSubmit);
          form.removeEventListener("keydown", onKey);
          d.removeEventListener("close", onClose);
          if (d.open) d.close();
          resolve(v);
        }
        form.addEventListener("submit", onSubmit);
        form.addEventListener("keydown", onKey);
        d.addEventListener("close", onClose);
        App._closeForm = () => done(null);
        d.showModal();
        const first = d.querySelector(".form-grid input:not([type=checkbox]):not([type=radio]), .form-grid select");
        if (first) first.focus();
      });
    },

    // ------------------------------------------------------------ routing
    go(hash) {
      if (location.hash === hash) this.render();
      else location.hash = hash;
    },

    parseHash() {
      const [name, arg] = location.hash.replace(/^#\/?/, "").split("/");
      return { name: VIEWS[name] ? name : "overview", arg: decodeURIComponent(arg || "") };
    },

    render() {
      this.route = this.parseHash();
      $$("#tabs a").forEach((a) => a.classList.toggle("on", a.dataset.tab === this.route.name));
      U.tip.hide();
      const root = $("#view");
      const same = root.dataset.view === this.route.name;
      const scroll = same ? window.scrollY : 0;
      // Re-rendering the same page (fold / unfold, filters, picking a day, edits) keeps the scroll position of every
      // scrolling box too (Gantts, load chart, heat map, tables), so nothing jumps back to the top / to today.
      // Keyed by the box's container id, else by its kind and order on the page.
      const inner = new Map();
      if (same) for (const [key, sc] of scrollers(root)) inner.set(key, { top: sc.scrollTop, left: sc.scrollLeft });
      root.dataset.view = this.route.name;
      VIEWS[this.route.name].render(root, this.route.arg);
      for (const [key, sc] of scrollers(root)) {
        const was = inner.get(key);
        if (!was) continue;
        sc.scrollTop = was.top;
        if (!sc.dataset.newAnchor) sc.scrollLeft = was.left; // a newly picked day / focused task wins
      }
      if (scroll) window.scrollTo(0, scroll);
      this.refreshHeader();
    },

    // ------------------------------------------------------------ header
    refreshHeader() {
      const s = Store.data.settings;
      $("#appTitle").textContent = s.title || "LLT800 Dashboard";
      document.title = s.title || "LLT800 Dashboard";
      $("#footTitle").textContent = s.title || "LLT800 Dashboard";
      $("#btnUndo").disabled = !Store.canUndo;
      $("#btnRedo").disabled = !Store.canRedo;
      const e = $("#btnEdit");
      e.setAttribute("aria-pressed", String(Store.editing));
      e.textContent = Store.editing ? L("✎ 編輯中", "✎ Editing") : L("✎ 編輯模式", "✎ Edit mode");
      document.body.classList.toggle("editing", Store.editing);
      const chip = $("#syncChip");
      const sync = $("#btnSync");
      if (!Remote.active) {
        chip.className = "sync-chip local";
        chip.textContent = L("本機模式", "Local mode");
        sync.hidden = true;
      } else if (this.cloudBusy) {
        chip.className = "sync-chip busy";
        chip.textContent = L("雲端 · 更新中…", "Cloud · updating…");
        sync.hidden = !Store.meta.dirty;
      } else if (Store.meta.dirty) {
        chip.className = "sync-chip dirty";
        chip.textContent = L("雲端 · 有未同步修改", "Cloud · unsynced edits");
        sync.hidden = false;
      } else {
        chip.className = "sync-chip ok";
        chip.textContent = L("雲端 · 已同步", "Cloud · synced");
        sync.hidden = true;
      }
      $("#demoBanner").hidden = !(Store.data.source && Store.data.source.demo) || Store.ui.demoHidden;
    },

    async toggleEdit() {
      if (Store.editing) return Store.setEditing(false);
      if (!(await this.unlockEdit())) return;
      if (!(await this.freshenBeforeEdit())) return;
      Store.setEditing(true);
      this.toast(L("已進入編輯模式：點任何專案、task、員工或出差紀錄即可修改", "Edit mode on: click any project, task, person or trip to change it"));
    },

    /**
     * Cloud mode: only people with the edit password may change the shared data, and the Apps Script
     * backend is what checks it (EDIT_KEY), so a page tweak cannot get around it. A password this
     * computer remembers is re-checked first; when it no longer works (the owner changed EDIT_KEY) it
     * is forgotten and asked for again. Local mode has nothing shared to protect. True = allowed.
     */
    async unlockEdit() {
      if (!Remote.active) return true;
      let pw = Remote.config.key;
      let ask = L("輸入編輯密碼（沒有密碼的人只能觀看）", "Edit password (without it you can only view)");
      for (;;) {
        if (!pw) {
          pw = prompt(ask);
          if (pw == null) return false;
          if (!pw) continue;
        }
        $("#blockerSkip").onclick = () => this.blocker(false);
        this.blocker(true, L("正在確認編輯密碼…", "Checking the edit password…"));
        try {
          await Remote.auth(pw);
          return true;
        } catch (err) {
          if (!err.authFailed) {
            this.toast(L("無法確認編輯密碼：", "Could not check the edit password: ") + err.message, "error");
            return false;
          }
          const remembered = pw === Remote.config.key;
          Remote.forgetKey();
          if (!remembered) {
            this.toast(err.message, "error");
            return false;
          }
          pw = "";
          ask = L("這台電腦記住的編輯密碼已失效，請重新輸入", "The edit password saved on this computer no longer works. Enter it again");
        } finally {
          this.blocker(false);
        }
      }
    },

    /**
     * A tab left open all day holds an old base version, and saving on top of that is what overwrites
     * other people's work. So refresh right before edits start: on a day nobody else edited this costs
     * one "unchanged" reply. Returns false to call off entering edit mode.
     */
    async freshenBeforeEdit() {
      if (!Remote.active) return true;
      // Unsynced local edits must not be thrown away here; syncCloud() handles that conflict.
      if (Store.meta.dirty && !(Store.data.source && Store.data.source.demo)) return true;
      $("#blockerSkip").onclick = () => this.blocker(false);
      this.blocker(true, L("正在確認是雲端最新版本…", "Checking for the latest cloud version…"));
      try {
        const r = await Remote.load(Store.meta.cloudVersion || null);
        if (r.unchanged || !r.data) return true;
        if (Store.meta.dirty) return true; // edited while this read was out (the blocker can be skipped): keep the edits
        Store.replace(r.data, { cloudVersion: r.version, cloudAt: r.savedAt });
        this.toast(L(`已先載入雲端最新版本（版本 ${r.version}${r.by ? `，最後由 ${r.by} 修改` : ""}）再開始編輯`, `Loaded the latest cloud version first (v${r.version}${r.by ? `, last changed by ${r.by}` : ""})`));
        return true;
      } catch (err) {
        return confirm(
          L(
            `讀不到雲端最新版本：${err.message}\n\n現在編輯可能會覆蓋別人的修改。\n\n確定：仍要進入編輯模式\n取消：先不要編輯`,
            `Could not read the latest cloud version: ${err.message}\n\nEditing now may overwrite other people's changes.\n\nOK: edit anyway\nCancel: not now`
          )
        );
      } finally {
        this.blocker(false);
      }
    },

    /** Ask for edit mode before an editing action; true when allowed. */
    async requireEdit() {
      if (Store.editing) return true;
      await this.toggleEdit();
      return Store.editing;
    },

    // ------------------------------------------------------------ cloud
    blocker(on, msg) {
      $("#blocker").hidden = !on;
      if (msg) $("#blockerMsg").textContent = msg;
    },

    /**
     * Pull the cloud dataset.
     *   opts.background - the page load: keep the local data already on screen and refresh behind it
     *                     (the chip shows 更新中). A first visit has nothing to show, so it still waits.
     *   opts.force      - read the whole bundle even when our version looks current (設定 → 從雲端重新載入,
     *                     where the point is to throw local edits away).
     */
    async loadCloud(opts) {
      if (!Remote.active) return;
      opts = opts || {};
      const demo = !!(Store.data.source && Store.data.source.demo);
      const hasLocal = !!Store.meta.cloudVersion && !demo;
      const background = !!opts.background && hasLocal;
      let skipped = false;
      $("#blockerSkip").onclick = () => {
        skipped = true;
        this.blocker(false);
      };
      if (background) {
        this.cloudBusy = true;
        this.refreshHeader();
      } else {
        this.blocker(true, L("正在讀取雲端資料…", "Loading cloud data…"));
      }
      try {
        const r = await Remote.load(hasLocal && !opts.force ? Store.meta.cloudVersion : null);
        if (skipped) return;
        // The cloud is the source of truth: local data only wins when it holds real edits not yet synced.
        // Demo data (a first visit before cloud mode) never counts as unsynced edits.
        const dirty = Store.meta.dirty && !demo;
        if (r.unchanged) {
          // Our copy already is the current cloud version: nothing to load, nothing to re-render.
          if (r.savedAt) Store.meta.cloudAt = r.savedAt;
          Store.save();
          if (dirty) this.toast(L("這台電腦有尚未同步到雲端的修改", "This computer has edits not yet synced to the cloud"), "", [{ label: L("立即同步", "Sync now"), run: () => this.syncCloud() }]);
        } else if (!r.data) {
          this.toast(L("雲端試算表目前是空的。到「設定 → 雲端同步」按「上傳本機資料到雲端」即可開始共用。", "The cloud sheet is empty. Use Settings → Cloud sync → Upload this computer's data to start sharing."));
        } else if (dirty && r.version !== Store.meta.cloudVersion) {
          if (
            confirm(
              L(
                "雲端有其他人更新的新版本，而這台電腦也有尚未同步的修改。\n\n確定：載入雲端版本（捨棄本機修改）\n取消：保留本機修改，稍後再決定",
                "Someone saved a newer cloud version, and this computer has unsynced edits.\n\nOK: load the cloud version (drop the edits here)\nCancel: keep the edits here, decide later"
              )
            )
          )
            Store.replace(r.data, { cloudVersion: r.version, cloudAt: r.savedAt });
        } else if (dirty) {
          this.toast(L("這台電腦有尚未同步到雲端的修改", "This computer has edits not yet synced to the cloud"), "", [{ label: L("立即同步", "Sync now"), run: () => this.syncCloud() }]);
        } else {
          Store.replace(r.data, { cloudVersion: r.version, cloudAt: r.savedAt });
        }
        // An Apps Script older than the Employees `ado` column: Remote kept this browser's mapping,
        // but the cloud copy cannot hold it until Code.gs is redeployed.
        if (r.legacyAdo)
          this.toast(L("雲端後端是舊版（Employees 少了 ado 欄），ADO 帳號對應只留在這台電腦。請重新部署 apps-script/Code.gs。", "The cloud backend is outdated (Employees has no ado column): ADO accounts stay on this computer. Redeploy apps-script/Code.gs."), "error", [{ label: L("怎麼做", "How"), run: () => this.go("#/settings/cloud") }]);
      } catch (err) {
        this.toast(L("讀取雲端失敗，先顯示這台電腦上次的資料（可能不是最新）：", "Could not load the cloud data; showing this computer's last copy (may be out of date): ") + err.message, "error", [{ label: L("重試", "Retry"), run: () => this.loadCloud({ force: true }) }]);
      } finally {
        this.cloudBusy = false;
        this.blocker(false);
        this.refreshHeader();
      }
    },

    async syncCloud() {
      if (!Remote.active) return;
      if (!Remote.hasKey && !(await this.unlockEdit())) return;
      this.blocker(true, L("正在同步到雲端…", "Syncing to the cloud…"));
      try {
        let r = await Remote.save(Store.data, Store.meta.cloudVersion);
        if (r.conflict) {
          this.blocker(false);
          if (
            !confirm(
              L(
                `雲端已被其他人更新（雲端版本 ${r.version}，你的基準 ${Store.meta.cloudVersion}）。\n\n確定：用這台電腦的資料覆寫雲端\n取消：不同步（可到設定重新載入雲端版本）`,
                `Someone else updated the cloud (cloud v${r.version}, yours was based on v${Store.meta.cloudVersion}).\n\nOK: overwrite the cloud with this computer's data\nCancel: don't sync (reload the cloud version in Settings)`
              )
            )
          )
            return;
          this.blocker(true, L("正在同步到雲端…", "Syncing to the cloud…"));
          r = await Remote.save(Store.data, null, true);
        }
        Store.meta.cloudVersion = r.version;
        Store.meta.cloudAt = r.savedAt || new Date().toISOString();
        Store.meta.dirty = false;
        Store.save();
        this.toast(L("已同步到雲端", "Synced to the cloud"));
      } catch (err) {
        if (err.authFailed) {
          // The owner changed EDIT_KEY (or removed it): this computer may no longer write.
          Remote.forgetKey();
          Store.setEditing(false);
          this.toast(L("同步失敗：", "Sync failed: ") + err.message + L("。修改仍保留在這台電腦。", ". Your edits are still on this computer."), "error", [{ label: L("輸入密碼後同步", "Enter password and sync"), run: () => this.syncCloud() }]);
        } else this.toast(L("同步失敗：", "Sync failed: ") + err.message, "error");
      } finally {
        this.blocker(false);
        this.refreshHeader();
      }
    },

    /**
     * One-off cleanup asked for on 2026-10-04: tasks that ended before 2026-09-01 are old and finished.
     * Runs once per browser (remembered in Store.meta, not in the data, so 復原 does not re-trigger it).
     * A first version used 2026-10-01; browsers that ran it get September's tasks reopened.
     */
    oneTimeCleanup() {
      this.removeGen12Once();
      this.recolorIntelOnce();
      this.gen12LinkOnce();
      this.gen12LinkNameOnce();
      // On the demo data these one-off fixes still run, but without a message (first-time visitors don't need one).
      const quiet = !!(Store.data.source && Store.data.source.demo);
      const CUTOFF = "2026-09-01";
      const applied = Store.meta.doneBeforeApplied;
      if (applied === CUTOFF) return;
      Store.meta.doneBeforeApplied = CUTOFF;
      Store.save();
      if (applied && applied > CUTOFF) {
        const n = Store.commit((d) => {
          let k = 0;
          for (const t of d.tasks)
            if (t.done && t.end >= CUTOFF && t.end < applied) {
              t.done = false;
              k++;
            }
          return k;
        });
        if (!quiet) this.toast(L(`已更正：只有 9/1 以前結束的 task 設為已完成；9 月內結束的 ${n} 個 task 改回未完成`, `Corrected: only tasks that ended before 9/1 are done; ${n} task(s) ending in September reopened`), "", [{ label: L("復原", "Undo"), run: () => Store.undo() }]);
        return;
      }
      const n = Store.commit((d) => Convert.markDoneBefore(d, CUTOFF));
      if (n && !quiet) this.toast(L(`已把 2026/9/1 以前結束的 ${n} 個 task 設為已完成（舊資料）`, `Marked ${n} task(s) that ended before 2026/9/1 as done (old data)`), "", [{ label: L("復原", "Undo"), run: () => Store.undo() }]);
    },

    /** Gen12 AMD has its own dashboard (asked 2026-10-05): fill in its 外部系統連結 once, if empty. */
    gen12LinkOnce() {
      if (Store.meta.gen12Linked) return;
      Store.meta.gen12Linked = true;
      Store.save();
      Store.commit((d) => {
        const p = d.projects.find((x) => /^gen\s*12\s*amd$/i.test(x.name.trim()));
        if (p && !p.link) p.link = "https://alanchu29.github.io/Gen12AMD_pilot_dashboard/";
      });
    },

    /** Its button reads "Gen12 AMD Pilot Dashboard" (asked 2026-10-05), once, when the link is that site and unnamed. */
    gen12LinkNameOnce() {
      if (Store.meta.gen12LinkNamed) return;
      Store.meta.gen12LinkNamed = true;
      Store.save();
      Store.commit((d) => {
        for (const p of d.projects) if (/Gen12AMD_pilot_dashboard/i.test(p.link || "") && !p.linkName) p.linkName = "Gen12 AMD Pilot Dashboard";
      });
    },

    /** Gen12 Intel was green like Gen12 AMD (asked 2026-10-04): give it blue (or another unused, non-green color) once. */
    recolorIntelOnce() {
      if (Store.meta.intelRecolored) return;
      Store.meta.intelRecolored = true;
      Store.save();
      const GREENS = ["#008300", "#1baf7a"];
      Store.commit((d) => {
        for (const p of d.projects) {
          if (!/intel/i.test(p.name) || !GREENS.includes((p.color || "").toLowerCase())) continue;
          const used = new Set(d.projects.filter((x) => x !== p).map((x) => (x.color || "").toLowerCase()));
          p.color = Convert.PALETTE.find((c) => !GREENS.includes(c) && !used.has(c)) || "#2a78d6";
        }
      });
    },

    /** Gen12 AMD Pilot (from the removed Gen12 Excel import) duplicated MONICA's Gen12 AMD: remove it once per browser. */
    removeGen12Once() {
      if (Store.meta.gen12Removed) return;
      Store.meta.gen12Removed = true;
      Store.save();
      const names = Store.data.projects.filter((p) => p.src && p.src.kind === "gen12").map((p) => p.name);
      const r = Store.commit((d) => Convert.removeGen12(d));
      if (r && r.tasks && !(Store.data.source && Store.data.source.demo)) this.toast(L(`已移除與 Gen12 AMD 重複的「${names.join("、") || "Gen12 Excel 匯入資料"}」：${r.pfams} 個 PFAM、${r.tasks} 個 task`, `Removed "${names.join(", ") || "Gen12 Excel import"}", a duplicate of Gen12 AMD: ${r.pfams} PFAM(s), ${r.tasks} task(s)`), "", [{ label: L("復原", "Undo"), run: () => Store.undo() }]);
    },

    // ------------------------------------------------------------ boot
    init() {
      Store.init();
      // 編輯模式 survives a reload in the same tab, but in cloud mode only with a password on this computer.
      if (Store.editing && Remote.active && !Remote.hasKey) Store.setEditing(false);
      Store.on((what) => {
        if (what === "edit") {
          this.refreshHeader();
          this.render();
          return;
        }
        this.render();
      });
      window.addEventListener("hashchange", () => this.render());
      $("#btnLang").onclick = () => {
        I18N.set(I18N.en ? "zh" : "en");
        this.render();
        if (window.Help && Help.refresh) Help.refresh();
      };
      $("#btnUndo").onclick = () => Store.undo() || this.toast(L("沒有可以復原的動作", "Nothing to undo"));
      $("#btnRedo").onclick = () => Store.redo();
      $("#btnEdit").onclick = () => this.toggleEdit();
      $("#btnSync").onclick = () => this.syncCloud();
      $("#syncChip").onclick = () => this.go("#/settings/cloud");
      $("#demoHide").onclick = () => {
        Store.setUi({ demoHidden: true });
        this.refreshHeader();
      };
      $("#btnTheme").onclick = () => {
        const cur = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
        const next = cur === "dark" ? "light" : "dark";
        document.documentElement.dataset.theme = next;
        try {
          localStorage.setItem("llt800.theme", next);
        } catch {
          /* session only */
        }
        this.render();
      };
      document.addEventListener("keydown", (ev) => {
        if (ev.target.closest("input, textarea, select, [contenteditable]") || $("dialog[open]")) return;
        const k = ev.key.toLowerCase();
        if ((ev.ctrlKey || ev.metaKey) && k === "z" && !ev.shiftKey) {
          ev.preventDefault();
          Store.undo();
        } else if ((ev.ctrlKey || ev.metaKey) && (k === "y" || (k === "z" && ev.shiftKey))) {
          ev.preventDefault();
          Store.redo();
        }
      });
      $$("#dlgImport [data-close]").forEach((b) => (b.onclick = () => $("#dlgImport").close()));
      ImportUI.bind();
      Help.bind();
      this.render();
      this.loadCloud({ background: true }).then(() => this.oneTimeCleanup());
    },
  };

  window.App = App;
  document.addEventListener("DOMContentLoaded", () => App.init());
})();
