/* Edit dialogs for every record type (project, PFAM, task, employee, trip). All writes go through Store.commit. */
(function () {
  const uid = Convert.uid;
  const dateOrder = (v, all) => (all.start && all.end && all.end < all.start ? "結束日不能早於開始日" : "");

  function projectOptions(withNone) {
    const list = Store.projects().map((p) => ({ value: p.id, label: p.name + (p.status === "archived" ? "（封存）" : "") }));
    return withNone ? [{ value: "", label: "—" }].concat(list) : list;
  }

  /** 廠區 choices: the settings' list, then sites other PFAMs already use (and the current one), plus "未指定". */
  function siteOptions(current) {
    const list = [...Store.data.settings.sites];
    for (const x of [...Store.data.pfams.map((f) => f.site), current].sort()) if (x && !list.includes(x)) list.push(x);
    return [{ value: "", label: "（未指定）" }].concat(list.map((x) => ({ value: x, label: x })));
  }

  const Editors = {
    async project(id) {
      if (!(await App.requireEdit())) return;
      const p = id ? Store.project(id) : null;
      if (id && !p) return App.toast("這筆資料已經被其他人刪除了", "error");
      const r = await App.form({
        title: p ? "編輯 Project" : "新增 Project",
        del: !!p,
        fields: [
          { key: "name", label: "名稱", required: true, value: p ? p.name : "", wide: true },
          { key: "color", label: "顏色", type: "swatch", options: Convert.PALETTE, value: p ? p.color : Convert.projectColor(Store.data), wide: true },
          { key: "status", label: "狀態", type: "select", options: [{ value: "active", label: "進行中" }, { value: "archived", label: "封存" }], value: p ? p.status : "active" },
          { key: "pfamCap", label: "PFAM 負載警戒上限", type: "number", min: 0, value: p && p.pfamCap ? p.pfamCap : "", placeholder: "不設定", hint: "總覽與專案甘特（這個 Project 或全部專案）中，這個 Project 同時進行的 PFAM 超過此數的日子標紅；空白 = 不設定" },
          { key: "link", label: "外部系統連結", type: "url", value: p && p.link ? p.link : "", placeholder: "https://…", wide: true, hint: "這個 Project 另有自己的系統時填網址；專案甘特的標題旁會出現「開啟」按鈕", validate: (v) => (v && !/^https?:\/\/\S+$/i.test(v) ? "請填 http:// 或 https:// 開頭的網址" : "") },
          { key: "linkName", label: "連結名稱", value: p && p.linkName ? p.linkName : "", placeholder: "例如 Gen12 AMD Pilot Dashboard（空白＝開啟 <Project> 系統）", wide: true },
          { key: "notes", label: "備註", type: "textarea", value: p ? p.notes : "", wide: true },
        ],
      });
      if (!r) return;
      if (r.action === "delete") {
        const nf = Store.pfamsOf(id).length;
        const nt = Store.tasksOfProject(id).length;
        if (!confirm(`刪除 Project「${p.name}」？\n底下 ${nf} 個 PFAM、${nt} 個 task 會一起刪除。`)) return;
        Store.commit((d) => {
          const fids = new Set(d.pfams.filter((f) => f.projectId === id).map((f) => f.id));
          d.tasks = d.tasks.filter((t) => !fids.has(t.pfamId));
          d.pfams = d.pfams.filter((f) => f.projectId !== id);
          d.projects = d.projects.filter((x) => x.id !== id);
          for (const tr of d.trips) if (tr.projectId === id) tr.projectId = "";
        });
        App.go("#/projects");
        return;
      }
      const v = r.values;
      v.pfamCap = Math.max(0, Math.floor(Number(v.pfamCap) || 0));
      let newId = id;
      Store.commit((d) => {
        if (p) Object.assign(d.projects.find((x) => x.id === id), v);
        else d.projects.push({ id: (newId = uid("j")), ...v, src: null });
      });
      if (!p) App.go("#/projects/" + newId);
    },

    async pfam(id, defaults) {
      if (!(await App.requireEdit())) return;
      const f = id ? Store.pfam(id) : null;
      if (id && !f) return App.toast("這筆資料已經被其他人刪除了", "error");
      const projectId = f ? f.projectId : (defaults && defaults.projectId) || "";
      if (!Store.data.projects.length) return App.toast("請先新增 Project", "error");
      const builtin = Convert.isOthers(f);
      const r = await App.form({
        title: f ? "編輯 PFAM" : "新增 PFAM",
        del: !!f && !builtin,
        fields: builtin
          ? [
              { key: "name", label: "PFAM 名稱", value: f.name, wide: true, hint: "每個 Project 內建的 PFAM：放不屬於其他 PFAM 的工作，永遠顯示、不能改名或刪除" },
              { key: "notes", label: "備註", type: "textarea", value: f.notes, wide: true },
            ]
          : [
          { key: "name", label: "PFAM 名稱", required: true, value: f ? f.name : "", wide: true },
          { key: "projectId", label: "所屬 Project", type: "select", options: projectOptions(), value: projectId },
          // A select (not a datalist: that only suggests entries matching the current value)
          { key: "site", label: "廠區", type: "select", options: siteOptions(f ? f.site : ""), value: f ? f.site : "", hint: "清單在「設定 › 一般 › 廠區 / 出差地點清單」" },
          { key: "notes", label: "備註", type: "textarea", value: f ? f.notes : "", wide: true },
        ],
      });
      if (!r) return;
      if (r.action === "delete") {
        const nt = Store.tasksOf(id).length;
        if (!confirm(`刪除 PFAM「${f.name}」${nt ? `與底下 ${nt} 個 task` : ""}？`)) return;
        Store.commit((d) => {
          d.tasks = d.tasks.filter((t) => t.pfamId !== id);
          d.pfams = d.pfams.filter((x) => x.id !== id);
        });
        return;
      }
      const newId = f ? id : uid("f");
      if (builtin) r.values = { notes: r.values.notes };
      else if (Convert.normName(r.values.name) === "others") return App.toast("「Others」是每個 Project 內建的 PFAM，請換一個名稱", "error");
      Store.commit((d) => {
        if (f) Object.assign(d.pfams.find((x) => x.id === id), r.values);
        else d.pfams.push({ id: newId, ...r.values, src: null });
      });
      if (!f) {
        // Show the new (still empty) PFAM and offer its first task.
        ProjectsView.focus(newId, "");
        if (App.route.name === "projects") App.render();
        App.toast(`已新增 PFAM「${r.values.name}」`, "", [{ label: "新增 task", run: () => Editors.task(null, { pfamId: newId }) }]);
      }
    },

    async task(id, defaults) {
      if (!(await App.requireEdit())) return;
      const t = id ? Store.task(id) : null;
      if (id && !t) return App.toast("這筆資料已經被其他人刪除了", "error");
      const pfams = Store.data.pfams;
      if (!pfams.length) return App.toast("請先新增 PFAM", "error");
      const base = t || { pfamId: (defaults && defaults.pfamId) || pfams[0].id, start: "", end: "", assignees: [], done: false, phase: "", section: "", lead: "", notes: "", baseStart: "", baseEnd: "", ...(defaults || {}) };
      const pfOpts = pfams.map((f) => {
        const p = Store.project(f.projectId);
        return { value: f.id, label: `${p ? p.name + " › " : ""}${f.name}` };
      });
      const r = await App.form({
        title: t ? "編輯 task" : "新增 task",
        del: !!t,
        extra: t ? [{ value: "dup", label: "複製一份" }] : [],
        fields: [
          { key: "name", label: "Task 名稱", required: true, value: base.name || "", wide: true },
          { key: "pfamId", label: "PFAM", type: "select", options: pfOpts, value: base.pfamId, wide: true },
          { key: "start", label: "開始", type: "date", required: true, value: base.start },
          { key: "end", label: "結束", type: "date", required: true, value: base.end, validate: dateOrder },
          { key: "assignees", label: "指派人（可多選）", type: "people", value: base.assignees, wide: true },
          { key: "done", label: "狀態", type: "check", text: "已完成", value: !!base.done },
          {
            key: "phase",
            label: "Phase",
            type: "select",
            options: [{ value: "", label: "—" }].concat(Store.data.settings.phases.map((p) => ({ value: p.key, label: p.label }))),
            value: base.phase,
          },
          { key: "section", label: "Section（分段）", value: base.section, more: true },
          { key: "lead", label: "LEAD 角色", value: base.lead, more: true, placeholder: "例如 STE, TE" },
          { key: "baseStart", label: "基準開始", type: "date", value: base.baseStart, more: true },
          { key: "baseEnd", label: "基準結束", type: "date", value: base.baseEnd, more: true, hint: "有基準日時，甘特圖顯示延遲 ▲ / 提前 ▼" },
          { key: "notes", label: "備註", type: "textarea", value: base.notes, more: true, wide: true },
        ],
      });
      if (!r) return;
      if (r.action === "delete") {
        if (!confirm(`刪除 task「${t.name}」？`)) return;
        Store.commit((d) => (d.tasks = d.tasks.filter((x) => x.id !== id)));
        return;
      }
      if (r.action === "dup") {
        Store.commit((d) => {
          const i = d.tasks.findIndex((x) => x.id === id);
          d.tasks.splice(i + 1, 0, { ...JSON.parse(JSON.stringify(t)), id: uid("t"), name: t.name + "（複製）", src: null });
        });
        return;
      }
      const v = r.values;
      Store.commit((d) => {
        if (t) Object.assign(d.tasks.find((x) => x.id === id), v);
        else {
          // New tasks go after the last task of their PFAM.
          const nt = { id: uid("t"), ...v, src: null };
          let at = -1;
          d.tasks.forEach((x, i) => x.pfamId === v.pfamId && (at = i));
          if (at < 0) d.tasks.push(nt);
          else d.tasks.splice(at + 1, 0, nt);
        }
      });
    },

    async employee(id) {
      if (!(await App.requireEdit())) return;
      const e = id ? Store.emp(id) : null;
      if (id && !e) return App.toast("這筆資料已經被其他人刪除了", "error");
      const r = await App.form({
        title: e ? "編輯員工" : "新增員工",
        del: !!e,
        fields: [
          { key: "name", label: "姓名", required: true, value: e ? e.name : "", wide: true, validate: (v) => (Store.data.employees.some((x) => x.id !== id && Convert.normName(x.name) === Convert.normName(v)) ? "名冊裡已經有同名的人" : "") },
          { key: "active", label: "狀態", type: "check", text: "在職（計入部門人力）", value: e ? e.active : true, hint: "離開部門後取消勾選：不再計入總人數，歷史 task 與出差紀錄保留" },
        ],
      });
      if (!r) return;
      if (r.action === "delete") {
        const nt = Store.data.tasks.filter((t) => t.assignees.includes(id)).length;
        const nr = Store.data.trips.filter((x) => x.empId === id).length;
        if (!confirm(`刪除「${e.name}」？${nt ? `\n會從 ${nt} 個 task 的指派中移除。` : ""}${nr ? `\n${nr} 筆出差紀錄會一起刪除。` : ""}\n\n只是離開部門的話，建議改用「在職」勾選，保留歷史紀錄。`)) return;
        Store.commit((d) => {
          for (const t of d.tasks) t.assignees = t.assignees.filter((x) => x !== id);
          d.trips = d.trips.filter((x) => x.empId !== id);
          d.employees = d.employees.filter((x) => x.id !== id);
        });
        if (App.route.name === "people") App.go("#/people");
        return;
      }
      Store.commit((d) => {
        if (e) Object.assign(d.employees.find((x) => x.id === id), r.values);
        else d.employees.push({ id: uid("e"), ...r.values });
      });
    },

    async trip(id, defaults) {
      if (!(await App.requireEdit())) return;
      const tr = id ? Store.data.trips.find((x) => x.id === id) : null;
      if (id && !tr) return App.toast("這筆資料已經被其他人刪除了", "error");
      if (!Store.data.employees.length) return App.toast("請先新增員工", "error");
      const base = tr || { empId: (defaults && defaults.empId) || Store.activeEmployees()[0]?.id || Store.data.employees[0].id, start: "", end: "", location: "", purpose: "", projectId: "", notes: "" };
      const r = await App.form({
        title: tr ? "編輯出差紀錄" : "新增出差紀錄",
        del: !!tr,
        fields: [
          { key: "empId", label: "員工", type: "select", options: Store.data.employees.filter((e) => e.active || e.id === base.empId).map((e) => ({ value: e.id, label: e.name })), value: base.empId },
          { key: "location", label: "地點", required: true, value: base.location, list: Store.data.settings.sites, placeholder: "MX / LZ / CZ…" },
          { key: "start", label: "出發", type: "date", required: true, value: base.start },
          { key: "end", label: "返回", type: "date", required: true, value: base.end, validate: dateOrder },
          { key: "purpose", label: "目的", value: base.purpose, wide: true },
          { key: "projectId", label: "關聯專案", type: "select", options: projectOptions(true), value: base.projectId },
          { key: "notes", label: "備註", type: "textarea", value: base.notes, more: true, wide: true },
        ],
      });
      if (!r) return;
      if (r.action === "delete") {
        if (!confirm("刪除這筆出差紀錄？")) return;
        Store.commit((d) => (d.trips = d.trips.filter((x) => x.id !== id)));
        return;
      }
      Store.commit((d) => {
        if (tr) Object.assign(d.trips.find((x) => x.id === id), r.values);
        else d.trips.push({ id: uid("r"), ...r.values });
        d.trips.sort((a, b) => a.start.localeCompare(b.start));
      });
    },
  };

  window.Editors = Editors;
})();
