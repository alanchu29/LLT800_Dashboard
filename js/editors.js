/* Edit dialogs for every record type (project, PFAM, task, employee, trip, link). All writes go through Store.commit. */
(function () {
  const uid = Convert.uid;
  const dateOrder = (v, all) => (all.start && all.end && all.end < all.start ? L("結束日不能早於開始日", "The end date cannot be before the start date") : "");

  function projectOptions(withNone) {
    const list = Store.projects().map((p) => ({ value: p.id, label: p.name + (p.status === "archived" ? L("（封存）", " (archived)") : "") }));
    return withNone ? [{ value: "", label: "—" }].concat(list) : list;
  }

  /** 廠區 choices: the settings' list, then sites other PFAMs already use (and the current one), plus "未指定". */
  function siteOptions(current) {
    const list = [...Store.data.settings.sites];
    for (const x of [...Store.data.pfams.map((f) => f.site), current].sort()) if (x && !list.includes(x)) list.push(x);
    return [{ value: "", label: L("（未指定）", "(none)") }].concat(list.map((x) => ({ value: x, label: x })));
  }

  const Editors = {
    async project(id) {
      if (!(await App.requireEdit())) return;
      const p = id ? Store.project(id) : null;
      if (id && !p) return App.toast(L("這筆資料已經被其他人刪除了", "Someone else already deleted this"), "error");
      const r = await App.form({
        title: p ? L("編輯 Project", "Edit Project") : L("新增 Project", "Add Project"),
        del: !!p,
        fields: [
          { key: "name", label: L("名稱", "Name"), required: true, value: p ? p.name : "", wide: true },
          { key: "color", label: L("顏色", "Color"), type: "swatch", options: Convert.PALETTE, value: p ? p.color : Convert.projectColor(Store.data), wide: true },
          { key: "status", label: L("狀態", "Status"), type: "select", options: [{ value: "active", label: L("進行中", "In progress") }, { value: "archived", label: L("封存", "Archived") }], value: p ? p.status : "active" },
          { key: "pfamCap", label: L("PFAM 負載警戒上限", "PFAM alert limit"), type: "number", min: 0, value: p && p.pfamCap ? p.pfamCap : "", placeholder: L("不設定", "None"), hint: L("總覽與專案甘特（這個 Project 或全部專案）中，這個 Project 同時進行的 PFAM 超過此數的日子標紅；空白 = 不設定", "In Overview and Project Gantt, days when this Project has more PFAMs running at once turn red; blank = none") },
          { key: "link", label: L("外部系統連結", "External system link"), type: "url", value: p && p.link ? p.link : "", placeholder: "https://…", wide: true, hint: L("這個 Project 另有自己的系統時填網址；專案甘特的標題旁會出現「開啟」按鈕", "If this Project has its own system, enter its URL; an “Open” button appears next to the Project Gantt title"), validate: (v) => (v && !/^https?:\/\/\S+$/i.test(v) ? L("請填 http:// 或 https:// 開頭的網址", "Enter a URL starting with http:// or https://") : "") },
          { key: "linkName", label: L("連結名稱", "Link name"), value: p && p.linkName ? p.linkName : "", placeholder: L("例如 Gen12 AMD Pilot Dashboard（空白＝開啟 <Project> 系統）", "e.g. Gen12 AMD Pilot Dashboard (blank = Open <Project> system)"), wide: true },
          { key: "notes", label: L("備註", "Notes"), type: "textarea", value: p ? p.notes : "", wide: true },
        ],
      });
      if (!r) return;
      if (r.action === "delete") {
        const nf = Store.pfamsOf(id).length;
        const nt = Store.tasksOfProject(id).length;
        if (!confirm(L(`刪除 Project「${p.name}」？\n底下 ${nf} 個 PFAM、${nt} 個 task 會一起刪除。`, `Delete Project “${p.name}”?\nIts ${nf} PFAM(s) and ${nt} task(s) will be deleted too.`))) return;
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
      if (id && !f) return App.toast(L("這筆資料已經被其他人刪除了", "Someone else already deleted this"), "error");
      const projectId = f ? f.projectId : (defaults && defaults.projectId) || "";
      if (!Store.data.projects.length) return App.toast(L("請先新增 Project", "Add a Project first"), "error");
      const builtin = Convert.isOthers(f);
      const r = await App.form({
        title: f ? L("編輯 PFAM", "Edit PFAM") : L("新增 PFAM", "Add PFAM"),
        del: !!f && !builtin,
        fields: builtin
          ? [
              { key: "name", label: L("PFAM 名稱", "PFAM name"), value: f.name, wide: true, hint: L("每個 Project 內建的 PFAM：放不屬於其他 PFAM 的工作，永遠顯示、不能改名或刪除", "Built into every Project for work that fits no other PFAM; always shown, cannot be renamed or deleted") },
              { key: "notes", label: L("備註", "Notes"), type: "textarea", value: f.notes, wide: true },
            ]
          : [
          { key: "name", label: L("PFAM 名稱", "PFAM name"), required: true, value: f ? f.name : "", wide: true },
          { key: "projectId", label: L("所屬 Project", "Project"), type: "select", options: projectOptions(), value: projectId },
          // A select (not a datalist: that only suggests entries matching the current value)
          { key: "site", label: L("廠區", "Site"), type: "select", options: siteOptions(f ? f.site : ""), value: f ? f.site : "", hint: L("清單在「設定 › 一般 › 廠區 / 出差地點清單」", "The list is in Settings › General › Sites / trip locations") },
          { key: "notes", label: L("備註", "Notes"), type: "textarea", value: f ? f.notes : "", wide: true },
        ],
      });
      if (!r) return;
      if (r.action === "delete") {
        const nt = Store.tasksOf(id).length;
        if (!confirm(L(`刪除 PFAM「${f.name}」${nt ? `與底下 ${nt} 個 task` : ""}？`, `Delete PFAM “${f.name}”${nt ? ` and its ${nt} task(s)` : ""}?`))) return;
        Store.commit((d) => {
          d.tasks = d.tasks.filter((t) => t.pfamId !== id);
          d.pfams = d.pfams.filter((x) => x.id !== id);
        });
        return;
      }
      const newId = f ? id : uid("f");
      if (builtin) r.values = { notes: r.values.notes };
      else if (Convert.normName(r.values.name) === "others") return App.toast(L("「Others」是每個 Project 內建的 PFAM，請換一個名稱", "“Others” is built into every Project; pick another name"), "error");
      Store.commit((d) => {
        if (f) Object.assign(d.pfams.find((x) => x.id === id), r.values);
        else d.pfams.push({ id: newId, ...r.values, src: null });
      });
      if (!f) {
        // Show the new (still empty) PFAM and offer its first task.
        ProjectsView.focus(newId, "");
        if (App.route.name === "projects") App.render();
        App.toast(L(`已新增 PFAM「${r.values.name}」`, `Added PFAM “${r.values.name}”`), "", [{ label: L("新增 task", "Add task"), run: () => Editors.task(null, { pfamId: newId }) }]);
      }
    },

    async task(id, defaults) {
      if (!(await App.requireEdit())) return;
      const t = id ? Store.task(id) : null;
      if (id && !t) return App.toast(L("這筆資料已經被其他人刪除了", "Someone else already deleted this"), "error");
      const pfams = Store.data.pfams;
      if (!pfams.length) return App.toast(L("請先新增 PFAM", "Add a PFAM first"), "error");
      const base = t || { pfamId: (defaults && defaults.pfamId) || pfams[0].id, start: "", end: "", assignees: [], done: false, phase: "", section: "", lead: "", notes: "", baseStart: "", baseEnd: "", ...(defaults || {}) };
      const pfOpts = pfams.map((f) => {
        const p = Store.project(f.projectId);
        return { value: f.id, label: `${p ? p.name + " › " : ""}${f.name}` };
      });
      const r = await App.form({
        title: t ? L("編輯 task", "Edit task") : L("新增 task", "Add task"),
        del: !!t,
        extra: t ? [{ value: "dup", label: L("複製一份", "Duplicate") }] : [],
        fields: [
          { key: "name", label: L("Task 名稱", "Task name"), required: true, value: base.name || "", wide: true },
          { key: "pfamId", label: "PFAM", type: "select", options: pfOpts, value: base.pfamId, wide: true },
          { key: "start", label: L("開始", "Start"), type: "date", required: true, value: base.start },
          { key: "end", label: L("結束", "End"), type: "date", required: true, value: base.end, validate: dateOrder },
          { key: "assignees", label: L("指派人（可多選）", "Assigned to (one or more)"), type: "people", value: base.assignees, wide: true },
          { key: "done", label: L("狀態", "Status"), type: "check", text: L("已完成", "Done"), value: !!base.done },
          {
            key: "phase",
            label: "Phase",
            type: "select",
            options: [{ value: "", label: "—" }].concat(Store.data.settings.phases.map((p) => ({ value: p.key, label: p.label }))),
            value: base.phase,
          },
          { key: "section", label: L("Section（分段）", "Section"), value: base.section, more: true },
          { key: "lead", label: L("LEAD 角色", "LEAD role"), value: base.lead, more: true, placeholder: L("例如 STE, TE", "e.g. STE, TE") },
          { key: "baseStart", label: L("基準開始", "Baseline start"), type: "date", value: base.baseStart, more: true },
          { key: "baseEnd", label: L("基準結束", "Baseline end"), type: "date", value: base.baseEnd, more: true, hint: L("有基準日時，甘特圖顯示延遲 ▲ / 提前 ▼", "With baseline dates the Gantt shows late ▲ / early ▼") },
          { key: "notes", label: L("備註", "Notes"), type: "textarea", value: base.notes, more: true, wide: true },
        ],
      });
      if (!r) return;
      if (r.action === "delete") {
        if (!confirm(L(`刪除 task「${t.name}」？`, `Delete task “${t.name}”?`))) return;
        Store.commit((d) => (d.tasks = d.tasks.filter((x) => x.id !== id)));
        return;
      }
      if (r.action === "dup") {
        Store.commit((d) => {
          const i = d.tasks.findIndex((x) => x.id === id);
          d.tasks.splice(i + 1, 0, { ...JSON.parse(JSON.stringify(t)), id: uid("t"), name: t.name + L("（複製）", " (copy)"), src: null });
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
      if (id && !e) return App.toast(L("這筆資料已經被其他人刪除了", "Someone else already deleted this"), "error");
      const r = await App.form({
        title: e ? L("編輯員工", "Edit person") : L("新增員工", "Add person"),
        del: !!e,
        fields: [
          { key: "name", label: L("姓名", "Name"), required: true, value: e ? e.name : "", wide: true, validate: (v) => (Store.data.employees.some((x) => x.id !== id && Convert.normName(x.name) === Convert.normName(v)) ? L("名冊裡已經有同名的人", "Someone in the roster already has this name") : "") },
          { key: "active", label: L("狀態", "Status"), type: "check", text: L("在職（計入部門人力）", "Active (counts as department manpower)"), value: e ? e.active : true, hint: L("離開部門後取消勾選：不再計入總人數，歷史 task 與出差紀錄保留", "Untick when they leave: no longer counted, past tasks and trips are kept") },
          // "ADO Task" pairs work items with the roster by name; this field is for the cases where the
          // ADO display name differs (英文名、姓在前、或用信箱).
          { key: "ado", label: L("ADO 帳號", "ADO account"), value: e ? e.ado || "" : "", wide: true, more: true, placeholder: "Dixon Chu, dixon.chu@wiwynn.com", hint: L("ADO 上的顯示名稱或信箱，多個用逗號分隔。姓名就對得上的話留空即可。", "Display name or email on ADO, comma-separated. Leave blank if the name already matches.") },
        ],
      });
      if (!r) return;
      if (r.action === "delete") {
        const nt = Store.data.tasks.filter((t) => t.assignees.includes(id)).length;
        const nr = Store.data.trips.filter((x) => x.empId === id).length;
        if (
          !confirm(
            L(
              `刪除「${e.name}」？${nt ? `\n會從 ${nt} 個 task 的指派中移除。` : ""}${nr ? `\n${nr} 筆出差紀錄會一起刪除。` : ""}\n\n只是離開部門的話，建議改用「在職」勾選，保留歷史紀錄。`,
              `Delete “${e.name}”?${nt ? `\nThey will be removed from ${nt} task(s).` : ""}${nr ? `\n${nr} trip(s) will be deleted too.` : ""}\n\nIf they only left the department, untick “Active” instead to keep the history.`
            )
          )
        )
          return;
        Store.commit((d) => {
          for (const t of d.tasks) t.assignees = t.assignees.filter((x) => x !== id);
          d.trips = d.trips.filter((x) => x.empId !== id);
          d.employees = d.employees.filter((x) => x.id !== id);
        });
        if (App.route.name === "people") App.go("#/people");
        return;
      }
      Store.commit((d) => {
        let target;
        if (e) target = Object.assign(d.employees.find((x) => x.id === id), r.values);
        else d.employees.push((target = { id: uid("e"), ...r.values }));
        if (!target.ado) delete target.ado; // an empty ADO 帳號 stays out of the data
      });
    },

    async trip(id, defaults) {
      if (!(await App.requireEdit())) return;
      const tr = id ? Store.data.trips.find((x) => x.id === id) : null;
      if (id && !tr) return App.toast(L("這筆資料已經被其他人刪除了", "Someone else already deleted this"), "error");
      if (!Store.data.employees.length) return App.toast(L("請先新增員工", "Add a person first"), "error");
      const base = tr || { empId: (defaults && defaults.empId) || Store.activeEmployees()[0]?.id || Store.data.employees[0].id, start: "", end: "", location: "", purpose: "", projectId: "", notes: "" };
      const r = await App.form({
        title: tr ? L("編輯出差紀錄", "Edit trip") : L("新增出差紀錄", "Add trip"),
        del: !!tr,
        fields: [
          { key: "empId", label: L("員工", "Person"), type: "select", options: Store.data.employees.filter((e) => e.active || e.id === base.empId).map((e) => ({ value: e.id, label: e.name })), value: base.empId },
          { key: "location", label: L("地點", "Location"), required: true, value: base.location, list: Store.data.settings.sites, placeholder: "MX / LZ / CZ…" },
          { key: "start", label: L("出發", "Depart"), type: "date", required: true, value: base.start },
          { key: "end", label: L("返回", "Return"), type: "date", required: true, value: base.end, validate: dateOrder },
          { key: "purpose", label: L("目的", "Purpose"), value: base.purpose, wide: true },
          { key: "projectId", label: L("關聯專案", "Project"), type: "select", options: projectOptions(true), value: base.projectId },
          { key: "notes", label: L("備註", "Notes"), type: "textarea", value: base.notes, more: true, wide: true },
        ],
      });
      if (!r) return;
      if (r.action === "delete") {
        if (!confirm(L("刪除這筆出差紀錄？", "Delete this trip?"))) return;
        Store.commit((d) => (d.trips = d.trips.filter((x) => x.id !== id)));
        return;
      }
      Store.commit((d) => {
        if (tr) Object.assign(d.trips.find((x) => x.id === id), r.values);
        else d.trips.push({ id: uid("r"), ...r.values });
        d.trips.sort((a, b) => a.start.localeCompare(b.start));
      });
    },

    async link(id, defaults) {
      if (!(await App.requireEdit())) return;
      const links = Store.data.settings.links;
      const l = id ? links.find((x) => x.id === id) : null;
      if (id && !l) return App.toast(L("這筆資料已經被其他人刪除了", "Someone else already deleted this"), "error");
      const base = l || { title: "", url: "", group: (defaults && defaults.group) || "", note: "" };
      const r = await App.form({
        title: l ? L("編輯連結", "Edit link") : L("新增連結", "Add link"),
        del: !!l,
        fields: [
          { key: "title", label: L("名稱", "Name"), required: true, value: base.title, wide: true, placeholder: L("例如 Monica ADO Board", "e.g. Monica ADO Board") },
          { key: "url", label: L("網址", "URL"), type: "url", required: true, value: base.url, wide: true, placeholder: "https://…", validate: (v) => (/^https?:\/\/\S+$/i.test(v) ? "" : L("請填 http:// 或 https:// 開頭的網址", "Enter a URL starting with http:// or https://")) },
          { key: "group", label: L("分類", "Group"), value: base.group, list: [...new Set(links.map((x) => x.group).filter(Boolean))], placeholder: L("例如 ADO、文件、工具（空白＝其他）", "e.g. ADO, Docs, Tools (blank = Others)") },
          { key: "note", label: L("說明", "Description"), value: base.note, wide: true, placeholder: L("一句話說明用途（選填）", "What it is for, in one line (optional)") },
        ],
      });
      if (!r) return;
      if (r.action === "delete") {
        if (!confirm(L(`刪除連結「${l.title}」？`, `Delete link “${l.title}”?`))) return;
        Store.commit((d) => (d.settings.links = d.settings.links.filter((x) => x.id !== id)));
        return;
      }
      const v = { title: r.values.title.trim(), url: r.values.url.trim(), group: r.values.group.trim(), note: r.values.note.trim() };
      Store.commit((d) => {
        if (l) Object.assign(d.settings.links.find((x) => x.id === id), v);
        else d.settings.links.push({ id: uid("l"), ...v });
      });
    },
  };

  window.Editors = Editors;
})();
