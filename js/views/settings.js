/* 設定: general options, phases, holidays, sites, edit password, data import / export, cloud sync. */
(function () {
  const { esc, $, $$ } = U;
  let empsOpen = false; // 員工名冊 starts folded; stays open while you work in it (until the page reloads)
  let holYear = 0; // year shown in the 假日 card (0 = this year)

  // A date in a pasted holiday line: yyyy-mm-dd / yyyy/m/d / yyyy.m.d, or m/d (year taken from context).
  const HOL_D = String.raw`(?:\d{4}[-/.])?\d{1,2}[-/.]\d{1,2}`;
  const HOL_LINE = new RegExp(String.raw`(${HOL_D})(?:\s*[~～至到]\s*(${HOL_D}))?`);
  const HOL_MAX_RANGE = 31;

  /** "2026/2/14" or "2/14" (with year y) -> "2026-02-14"; null when it is not a real date. */
  function holDate(txt, y) {
    const p = txt.split(/[-/.]/).map(Number);
    const [yy, m, d] = p.length === 3 ? p : [y, ...p];
    const iso = `${yy}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    return window.Engine.fromDay(window.Engine.toDay(iso)) === iso ? iso : null;
  }

  /**
   * Pasted text -> { add: [{ date, name }], bad: [line] }. One holiday or range per line, the name before or after
   * the date ("2026-10-10 國慶日", "春節 2026/2/14~2/22"). Weekends inside a range are skipped (already days off).
   */
  function parseHolidays(text, year) {
    const E = window.Engine;
    const add = [];
    const bad = [];
    for (const line of text.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)) {
      const m = line.match(HOL_LINE);
      const a = m && holDate(m[1], year);
      let b = m && m[2] ? holDate(m[2], a ? +a.slice(0, 4) : year) : a;
      if (a && b && b < a && m[2].split(/[-/.]/).length === 2) b = holDate(m[2], +a.slice(0, 4) + 1); // "12/31~1/2": into next year
      if (!a || !b || b < a || E.toDay(b) - E.toDay(a) >= HOL_MAX_RANGE) {
        bad.push(line);
        continue;
      }
      const name = line.replace(m[0], " ").replace(/^[\s,，、:：-]+|[\s,，、:：-]+$/g, "").replace(/\s+/g, " ");
      for (let d = E.toDay(a); d <= E.toDay(b); d++) if (a === b || E.weekday(d) % 6) add.push({ date: E.fromDay(d), name });
    }
    return { add, bad };
  }

  /** yyyy-mm-01 of the previous month (default of 批次標記完成). */
  function firstOfLastMonth() {
    const [y, m] = window.Engine.fromDay(U.today()).split("-").map(Number);
    return m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, "0")}-01`;
  }

  function render(root, arg) {
    const s = Store.data.settings;
    const d = Store.data;
    const lock = Store.editing ? "" : " disabled";
    if (arg === "emps") empsOpen = true;
    const E = window.Engine;
    if (!holYear) holYear = +E.fromDay(U.today()).slice(0, 4);
    const hols = s.holidays.filter((h) => h.date.startsWith(holYear + "-"));
    const isWeekend = (iso) => E.weekday(E.toDay(iso)) % 6 === 0;
    const holOnWeekdays = hols.filter((h) => !isWeekend(h.date)).length;
    root.innerHTML = `
      <div class="page-head"><h2>設定</h2>${Store.editing ? "" : `<span class="muted">切換「編輯模式」後才能修改設定與匯入資料</span>`}</div>
      <div class="set-grid">
        <section class="card"><header class="card-h"><h3>一般</h3></header>
          <div class="form-grid">
            <div class="field wide"><label for="sTitle">Dashboard 標題</label><input id="sTitle" value="${esc(s.title)}"${lock}></div>
            <div class="field wide"><label>人力資源標紅規則</label>
              <label class="check"><input type="radio" name="sAlert" value="full"${s.alertMode !== "pct" ? " checked" : ""}${lock}> 沒有人空著：忙碌人數 + 未指派 PFAM ≥ 在職人數</label>
              <label class="check"><input type="radio" name="sAlert" value="pct"${s.alertMode === "pct" ? " checked" : ""}${lock}> 忙碌人數 ≥ 在職人數的 <input id="sPct" type="number" min="1" max="100" value="${s.alertPct}" class="w-num"${lock}> %</label>
            </div>
            <div class="field wide"><label for="sRoles">Gen12 Excel 匯入預設勾選的 LEAD 角色</label><input id="sRoles" value="${esc(s.gen12Roles || "STE, TE")}"${lock}><small class="muted">以逗號分隔；LEAD 欄含其中任一角色的 task 會預先勾選，匯入時仍可逐項調整</small></div>
            <div class="field wide"><label for="sNotCounted">不計入人力的人員</label><input id="sNotCounted" value="${esc(s.notCounted || "")}" placeholder="例如 Dixon"${lock}><small class="muted">以逗號分隔的姓名（如主管）；不算進忙碌 / 在職人數、人力熱度與 PFAM 負載的人力上限，仍可被指派 task</small></div>
            <div class="field wide"><label for="sSites">廠區 / 出差地點清單</label><input id="sSites" value="${esc(s.sites.join(", "))}"${lock}><small class="muted">PFAM 廠區與出差地點的下拉建議；順序也決定出差地點的顏色</small></div>
          </div>
          <div class="row-end"><button class="btn primary edit-only" id="saveGeneral" type="button">儲存</button></div>
        </section>

        <section class="card"><header class="card-h"><h3>Phase 清單</h3><span class="muted">task 的分類與甘特圖顏色（同 MONICA）</span></header>
          <table class="grid-table phases"><thead><tr><th>顏色</th><th>名稱 / 代碼</th><th class="num">task</th><th class="edit-only">合併到</th><th></th></tr></thead><tbody>
          ${s.phases
            .map((p, i) => {
              const n = d.tasks.filter((t) => t.phase === p.key).length;
              return `<tr data-i="${i}"><td><input type="color" value="${esc(p.color)}" data-f="color"${lock}></td><td><input value="${esc(p.label)}" data-f="label"${lock}><small class="ph-key muted" title="${(p.aliases || []).length ? "也接受舊代碼：" + esc(p.aliases.join(", ")) : ""}">${esc(p.key)}${(p.aliases || []).length ? `・＋${p.aliases.length} 個舊代碼` : ""}</small></td><td class="num">${n}</td>
                <td class="edit-only"><select data-merge="${i}"><option value="">—</option>${s.phases.filter((x) => x.key !== p.key).map((x) => `<option value="${esc(x.key)}">${esc(x.label)}</option>`).join("")}</select></td>
                <td><button class="mini edit-only" type="button" data-del="${i}" title="刪除">✕</button></td></tr>`;
            })
            .join("")}
          </tbody></table>
          <div class="row-end"><input id="newPhase" placeholder="新 Phase 名稱" class="edit-only"><button class="btn edit-only" id="addPhase" type="button">＋ 新增</button><button class="btn primary edit-only" id="savePhases" type="button">儲存</button></div>
        </section>

        <section class="card" id="set-hol"><header class="card-h"><h3>假日</h3><div class="seg year" role="group" aria-label="年度"><button type="button" id="hPrev" aria-label="前一年">‹</button><b>${holYear} 年</b><button type="button" id="hNext" aria-label="下一年">›</button></div></header>
          <p class="muted small">週末以外的放假日（國定假日、公司休假）。假日不算工作日：忙碌人數、人力熱度、PFAM 負載與「n 個工作天」都會扣掉，甘特圖以灰底標示。</p>
          <table class="grid-table hols"><thead><tr><th>日期</th><th>名稱</th><th></th></tr></thead><tbody>
          ${hols.length ? hols
            .map((h) => `<tr class="${isWeekend(h.date) ? "muted" : ""}"><td>${U.fmt(h.date, "full")}</td><td>${esc(h.name)}${isWeekend(h.date) ? ` <small class="muted">（週末，不影響計算）</small>` : ""}</td><td class="num"><button class="mini edit-only" type="button" data-delhol="${h.date}" title="刪除">✕</button></td></tr>`)
            .join("") : `<tr><td colspan="3" class="empty">${holYear} 年還沒有設定假日</td></tr>`}
          </tbody></table>
          ${hols.length ? `<div class="row-end hol-sum"><span class="muted small">${holYear} 年共 ${hols.length} 天，其中 ${holOnWeekdays} 天在週一～五</span><button class="btn edit-only" id="hClear" type="button">清除 ${holYear} 年</button></div>` : ""}
          <div class="hol-add edit-only">
            <input type="date" id="hDate" aria-label="日期"><input id="hName" placeholder="名稱，例如 國慶日" aria-label="名稱"><button class="btn" id="hAdd" type="button">＋ 新增</button>
          </div>
          <details class="hol-bulk edit-only"><summary>批次貼上…</summary>
            <textarea id="hBulk" rows="6" placeholder="一行一筆，日期在前或在後都可以&#10;2026-10-10 國慶日&#10;2026/2/14~2/22 春節&#10;10/10 國慶日（沒寫年份 = ${holYear} 年）"></textarea>
            <p class="muted small">用 ~ 表示連續假期（期間內的週末會略過，最長 ${HOL_MAX_RANGE} 天）；已存在的日期會更新名稱。</p>
            <div class="row-end"><button class="btn primary" id="hBulkAdd" type="button">加入</button></div>
          </details>
        </section>

        <section class="card"><header class="card-h"><h3>編輯密碼</h3></header>
          <p class="muted small">設定後，切換「編輯模式」需要輸入密碼。這只用來防止誤改，資料本身仍是公開可讀的。</p>
          <p>目前：<b>${s.editHash ? "已設定" : "未設定"}</b></p>
          <div class="row-end"><button class="btn edit-only" id="setPw" type="button">${s.editHash ? "變更密碼" : "設定密碼"}</button>${s.editHash ? `<button class="btn edit-only" id="clearPw" type="button">移除密碼</button>` : ""}</div>
        </section>

        <section class="card" id="set-data"><header class="card-h"><h3>資料</h3></header>
          <p class="muted small">目前：${d.projects.length} 個 Project、${d.pfams.length} 個 PFAM、${d.tasks.length} 個 task、${d.employees.length} 位員工、${d.trips.length} 筆出差${d.source && d.source.demo ? "（示範資料）" : ""}</p>
          <div class="btn-list">
            <button class="btn edit-only" id="impMonica" type="button">⤓ 匯入 MONICA JSON…</button>
            <button class="btn edit-only" id="impGen12" type="button">⤓ 匯入 Gen12 PFAM Excel…</button>
            <button class="btn" id="expJson" type="button">⤒ 匯出 JSON 備份</button>
            <button class="btn edit-only" id="impJson" type="button">還原 JSON 備份…</button>
          </div>
          <p class="muted small">MONICA：Series → Project、project → PFAM、Phase 帶入 task；同一份資料再匯入會更新日期並保留網頁上的指派。<br>Gen12 Excel：匯入到「Gen12 AMD」，1st + 2nd build 合併為一個 PFAM，預設勾選 LEAD 含「${esc(s.gen12Roles || "STE, TE")}」的 task，其餘可自行勾選。</p>
          <div class="batch-done edit-only">
            <b>批次標記完成</b>
            <span>結束日早於 <input type="date" id="bdDate" value="${firstOfLastMonth()}"> 的未完成 task，全部設為已完成</span>
            <span class="muted small" id="bdCount"></span>
            <button class="btn" id="bdApply" type="button">套用</button>
          </div>
          <div class="btn-list danger-zone">
            <button class="btn edit-only" id="loadDemo" type="button">載入示範資料</button>
            <button class="btn danger edit-only" id="clearDemo" type="button">清空專案與員工資料</button>
          </div>
        </section>

        <section class="card" id="set-cloud"><header class="card-h"><h3>Google Sheet 雲端同步</h3><span class="muted">選用</span></header>
          <p class="muted small">把 <code>apps-script/Code.gs</code> 部署成 Web App 後貼上網址（結尾 /exec），全部門共用同一份資料。步驟見 README。這個設定只存在這台電腦的瀏覽器。</p>
          <div class="form-grid">
            <div class="field wide"><label for="cUrl">Apps Script 網址</label><input id="cUrl" type="url" value="${esc(Remote.config.url)}" placeholder="https://script.google.com/macros/s/…/exec"></div>
            <div class="field"><label for="cKey">寫入金鑰（選填）</label><input id="cKey" value="${esc(Remote.config.key)}" placeholder="與 EDIT_KEY 相同"></div>
            <div class="field"><label>&nbsp;</label><label class="check"><input type="checkbox" id="cOn"${Remote.config.enabled ? " checked" : ""}> 啟用雲端模式</label></div>
          </div>
          <p class="small">${Remote.active ? `雲端版本 ${Store.meta.cloudVersion || "—"}${Store.meta.cloudAt ? `・最後同步 ${esc(Store.meta.cloudAt.slice(0, 16).replace("T", " "))}` : ""}${Store.meta.dirty ? "・<b>有未同步修改</b>" : ""}` : "目前是本機模式：資料只存在這個瀏覽器。"}</p>
          <div class="btn-list">
            <button class="btn" id="cTest" type="button">測試連線</button>
            <button class="btn primary" id="cSave" type="button">儲存設定</button>
            <button class="btn" id="cPull" type="button"${Remote.active ? "" : " disabled"}>從雲端重新載入</button>
            <button class="btn" id="cPush" type="button"${Remote.active ? "" : " disabled"}>上傳本機資料到雲端</button>
          </div>
        </section>

        <details class="card wide-card fold-card" id="set-emps"${empsOpen ? " open" : ""}><summary class="card-h"><h3>員工名冊</h3><span class="muted">${d.employees.filter((e) => e.active).length} 位在職${d.employees.some((e) => !e.active) ? `・${d.employees.filter((e) => !e.active).length} 位已離開` : ""}・點一下展開 / 收合</span></summary>
          <div class="emp-grid">
            <div>
              <table class="grid-table emps"><thead><tr><th>#</th><th>姓名</th><th>在職</th><th class="num">指派 task</th><th class="num">出差紀錄</th><th></th></tr></thead><tbody>
              ${d.employees.length ? d.employees
                .map((e, i) => {
                  const nt = d.tasks.filter((t) => t.assignees.includes(e.id)).length;
                  const nr = d.trips.filter((r) => r.empId === e.id).length;
                  return `<tr data-emp="${e.id}" class="${e.active ? "" : "gone"}"><td class="muted small">${i + 1}</td>
                    <td><input value="${esc(e.name)}" data-f="name"${lock}></td>
                    <td><label class="check"><input type="checkbox" data-f="active"${e.active ? " checked" : ""}${lock}> ${e.active ? "在職" : "已離開"}</label></td>
                    <td class="num">${nt}</td><td class="num">${nr}</td>
                    <td><button class="mini edit-only" type="button" data-delemp="${e.id}" title="刪除">✕</button></td></tr>`;
                })
                .join("") : `<tr><td colspan="6" class="empty">名冊是空的，從右邊輸入員工姓名。</td></tr>`}
              </tbody></table>
              <p class="muted small">${d.employees.filter((e) => e.active).length} 位在職・${d.employees.filter((e) => !e.active).length} 位已離開。離開部門請取消「在職」（不再計入人力，保留歷史 task 與出差紀錄）；刪除會把此人從 task 指派中移除，並刪除其出差紀錄。</p>
              <div class="row-end"><button class="btn primary edit-only" id="saveEmps" type="button"${d.employees.length ? "" : " disabled"}>儲存名冊變更</button></div>
            </div>
            <div class="emp-add edit-only">
              <label for="newEmps"><b>新增員工</b></label>
              <textarea id="newEmps" rows="7" placeholder="一行一位，或用逗號分隔&#10;例如：&#10;王小明&#10;陳大文, 林美玲"></textarea>
              <div class="row-end"><button class="btn" id="addEmps" type="button">＋ 加入名冊</button></div>
              <p class="muted small">名冊裡已有的姓名會略過（不分大小寫）。</p>
            </div>
          </div>
        </details>
      </div>`;

    $("#set-emps").addEventListener("toggle", (ev) => (empsOpen = ev.target.open));
    if (arg) setTimeout(() => (document.getElementById("set-" + arg) || {}).scrollIntoView?.({ block: "start", behavior: "smooth" }), 30);

    // ---- employees
    $("#addEmps").onclick = () => {
      const names = $("#newEmps").value.split(/[\n,，、;]+/).map((x) => x.trim()).filter(Boolean);
      if (!names.length) return $("#newEmps").focus();
      const have = new Set(d.employees.map((e) => Convert.normName(e.name)));
      const add = [];
      let dup = 0;
      for (const n of names) {
        const k = Convert.normName(n);
        if (have.has(k)) dup++;
        else {
          have.add(k);
          add.push(n);
        }
      }
      if (add.length) Store.commit((dd) => add.forEach((name) => dd.employees.push({ id: Convert.uid("e"), name, active: true })));
      App.toast(`已加入 ${add.length} 位${dup ? `，略過 ${dup} 位已在名冊中的姓名` : ""}`);
    };
    $("#saveEmps").onclick = () => {
      const rows = $$("table.emps tbody tr[data-emp]").map((tr) => ({
        id: tr.dataset.emp,
        name: tr.querySelector('[data-f="name"]').value.trim(),
        active: tr.querySelector('[data-f="active"]').checked,
      }));
      if (rows.some((r) => !r.name)) return App.toast("姓名不能空白", "error");
      const keys = rows.map((r) => Convert.normName(r.name));
      const dupName = rows.find((r, i) => keys.indexOf(keys[i]) !== i);
      if (dupName) return App.toast(`名冊裡有重複的姓名：${dupName.name}`, "error");
      Store.commit((dd) => {
        for (const r of rows) Object.assign(dd.employees.find((e) => e.id === r.id), { name: r.name, active: r.active });
      });
      App.toast("已儲存名冊");
    };
    root.querySelectorAll("[data-delemp]").forEach(
      (b) =>
        (b.onclick = () => {
          const id = b.dataset.delemp;
          const e = Store.emp(id);
          const nt = d.tasks.filter((t) => t.assignees.includes(id)).length;
          const nr = d.trips.filter((r) => r.empId === id).length;
          if (!confirm(`刪除「${e.name}」？${nt ? `\n會從 ${nt} 個 task 的指派中移除。` : ""}${nr ? `\n${nr} 筆出差紀錄會一起刪除。` : ""}\n\n只是離開部門的話，建議取消「在職」，保留歷史紀錄。`)) return;
          Store.commit((dd) => {
            for (const t of dd.tasks) t.assignees = t.assignees.filter((x) => x !== id);
            dd.trips = dd.trips.filter((x) => x.empId !== id);
            dd.employees = dd.employees.filter((x) => x.id !== id);
          });
        })
    );

    // ---- holidays
    const setHolidays = (fn) =>
      Store.commit((dd) => {
        const byDate = new Map(dd.settings.holidays.map((h) => [h.date, h.name]));
        fn(byDate);
        dd.settings.holidays = Convert.cleanHolidays([...byDate].map(([date, name]) => ({ date, name })));
      });
    $("#hPrev").onclick = () => {
      holYear--;
      App.render();
    };
    $("#hNext").onclick = () => {
      holYear++;
      App.render();
    };
    $("#hAdd").onclick = () => {
      const date = $("#hDate").value;
      if (!date) return $("#hDate").focus();
      const name = $("#hName").value.trim();
      holYear = +date.slice(0, 4);
      setHolidays((m) => m.set(date, name));
      App.toast(`已加入假日 ${U.fmt(date, "full")}${name ? " " + name : ""}`);
    };
    $("#hBulkAdd").onclick = () => {
      const { add, bad } = parseHolidays($("#hBulk").value, holYear);
      if (!add.length) return App.toast(bad.length ? `看不懂的日期：${bad[0]}` : "請先貼上假日", bad.length ? "error" : "");
      holYear = +add[0].date.slice(0, 4);
      setHolidays((m) => add.forEach((h) => m.set(h.date, h.name)));
      App.toast(`已加入 ${add.length} 天假日${bad.length ? `；略過 ${bad.length} 行看不懂的：${bad.slice(0, 3).join("、")}` : ""}`, bad.length ? "error" : "");
    };
    if ($("#hClear"))
      $("#hClear").onclick = () => {
        if (!confirm(`刪除 ${holYear} 年的 ${hols.length} 天假日？（可按 ↶ 復原）`)) return;
        setHolidays((m) => hols.forEach((h) => m.delete(h.date)));
      };
    root.querySelectorAll("[data-delhol]").forEach((b) => (b.onclick = () => setHolidays((m) => m.delete(b.dataset.delhol))));

    $("#saveGeneral").onclick = () => {
      const sites = $("#sSites").value.split(/[,，、\s]+/).map((x) => x.trim()).filter(Boolean);
      Store.commit((d) => {
        Object.assign(d.settings, {
          title: $("#sTitle").value.trim() || "LLT800 Dashboard",
          alertMode: root.querySelector('input[name="sAlert"]:checked').value,
          alertPct: Math.max(1, Math.min(100, Number($("#sPct").value) || 90)),
          sites,
          notCounted: $("#sNotCounted").value.trim(),
          gen12Roles: $("#sRoles").value.trim() || "STE, TE",
        });
      });
      App.toast("已儲存設定");
    };

    const phaseRows = () =>
      $$("table.phases tbody tr").map((tr) => {
        const p = s.phases[+tr.dataset.i];
        return { ...p, label: tr.querySelector('[data-f="label"]').value.trim() || p.label, color: tr.querySelector('[data-f="color"]').value };
      });
    $("#savePhases").onclick = () => {
      Store.commit((d) => (d.settings.phases = phaseRows()));
      App.toast("已儲存 Phase");
    };
    $("#addPhase").onclick = () => {
      const label = $("#newPhase").value.trim();
      if (!label) return $("#newPhase").focus();
      const key = label.replace(/\s+/g, "") + (s.phases.some((p) => p.key === label.replace(/\s+/g, "")) ? "_" + Date.now().toString(36).slice(-3) : "");
      Store.commit((d) => {
        d.settings.phases = phaseRows();
        d.settings.phases.push({ key, label, color: Convert.PALETTE[d.settings.phases.length % Convert.PALETTE.length] });
      });
    };
    root.querySelectorAll("[data-merge]").forEach(
      (sel) =>
        (sel.onchange = () => {
          const from = s.phases[+sel.dataset.merge];
          const to = s.phases.find((x) => x.key === sel.value);
          if (!to) return;
          const n = d.tasks.filter((t) => t.phase === from.key).length;
          if (!confirm(`把「${from.label}」合併到「${to.label}」？\n${n} 個 task 會改成「${to.label}」，「${from.label}」從清單移除；之後匯入的檔案若用「${from.label}」的代碼，也會歸到「${to.label}」。`)) {
            sel.value = "";
            return;
          }
          Store.commit((dd) => Convert.mergePhase(dd, from.key, to.key));
          App.toast(`已合併：${from.label} → ${to.label}`);
        })
    );
    root.querySelectorAll("[data-del]").forEach(
      (b) =>
        (b.onclick = () => {
          const p = s.phases[+b.dataset.del];
          const n = d.tasks.filter((t) => t.phase === p.key).length;
          if (n && !confirm(`有 ${n} 個 task 使用「${p.label}」，刪除後這些 task 會變成未指定 Phase。確定？`)) return;
          Store.commit((dd) => {
            dd.settings.phases = dd.settings.phases.filter((x) => x.key !== p.key);
            for (const t of dd.tasks) if (t.phase === p.key) t.phase = "";
          });
        })
    );

    $("#setPw").onclick = () => {
      const a = prompt("輸入新的編輯密碼");
      if (!a) return;
      if (prompt("再輸入一次確認") !== a) return App.toast("兩次輸入不一致", "error");
      Store.commit((d) => (d.settings.editHash = U.hash(a)));
      App.toast("已設定編輯密碼");
    };
    if ($("#clearPw")) $("#clearPw").onclick = () => confirm("移除編輯密碼？") && Store.commit((d) => (d.settings.editHash = ""));

    const bdCount = () => {
      const c = $("#bdDate").value;
      const n = c ? d.tasks.filter((t) => !t.done && t.end && t.end < c).length : 0;
      $("#bdCount").textContent = `（目前符合 ${n} 個）`;
      return n;
    };
    bdCount();
    $("#bdDate").onchange = bdCount;
    $("#bdApply").onclick = () => {
      const c = $("#bdDate").value;
      const n = bdCount();
      if (!n) return App.toast("沒有符合的 task");
      if (!confirm(`把結束日早於 ${c} 的 ${n} 個未完成 task 全部設為已完成？（可按 ↶ 復原）`)) return;
      Store.commit((dd) => Convert.markDoneBefore(dd, c));
      App.toast(`已將 ${n} 個 task 設為已完成`, "", [{ label: "復原", run: () => Store.undo() }]);
    };
    $("#impMonica").onclick = () => $("#fileMonica").click();
    $("#impJson").onclick = () => $("#fileJson").click();
    $("#impGen12").onclick = () => $("#fileXlsx").click();
    $("#expJson").onclick = () => {
      const stamp = new Date().toISOString().slice(0, 10);
      U.download(`LLT800_backup_${stamp}.json`, JSON.stringify({ app: "LLT800_Dashboard", exportedAt: new Date().toISOString(), data: Store.data }, null, 1));
    };
    $("#loadDemo").onclick = () => {
      if (!confirm("用示範資料取代目前全部資料？（可按 ↶ 復原）")) return;
      Store.replace(JSON.parse(JSON.stringify(window.LLT_SEED)), { keepUndo: true, dirty: true });
      Store.setUi({ demoHidden: false, projectId: "" });
    };
    $("#clearDemo").onclick = () => {
      if (!confirm("清空所有 Project、PFAM、task、員工與出差紀錄？\n設定（Phase、廠區、密碼）會保留。可按 ↶ 復原。")) return;
      const next = Convert.emptyData();
      next.settings = JSON.parse(JSON.stringify(Store.data.settings));
      Store.replace(next, { keepUndo: true, dirty: true });
      Store.setUi({ projectId: "" });
      App.toast("已清空，可以開始建立正式資料");
    };

    const cfg = () => ({ url: $("#cUrl").value.trim(), key: $("#cKey").value.trim(), enabled: $("#cOn").checked });
    $("#cTest").onclick = async () => {
      const c = cfg();
      if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(c.url)) return App.toast("網址應以 https://script.google.com/ 開頭", "error");
      try {
        const r = await Remote.ping(c.url);
        App.toast(`連線成功（${r.service || "Apps Script"}）`);
      } catch (err) {
        App.toast("連線失敗：" + err.message, "error");
      }
    };
    $("#cSave").onclick = () => {
      const c = cfg();
      if (c.enabled && !c.url) return App.toast("請先填 Apps Script 網址", "error");
      const was = Remote.active;
      Remote.saveConfig(c);
      App.toast(c.enabled ? "已啟用雲端模式" : "已切回本機模式");
      if (!was && Remote.active) App.loadCloud();
      App.render();
    };
    $("#cPull").onclick = async () => {
      if (Store.meta.dirty && !confirm("本機有尚未同步的修改，重新載入會捨棄它們。確定？")) return;
      Store.meta.dirty = false;
      await App.loadCloud();
    };
    $("#cPush").onclick = async () => {
      if (!confirm("用這台電腦的資料覆寫雲端？")) return;
      App.blocker(true, "正在上傳…");
      try {
        const r = await Remote.save(Store.data, null, true);
        Object.assign(Store.meta, { cloudVersion: r.version, cloudAt: r.savedAt || new Date().toISOString(), dirty: false });
        Store.save();
        App.toast("已上傳到雲端");
      } catch (err) {
        App.toast("上傳失敗：" + err.message, "error");
      } finally {
        App.blocker(false);
        App.render();
      }
    };
  }

  window.SettingsView = { render };
})();
