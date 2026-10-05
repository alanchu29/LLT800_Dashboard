/*
 * 同時進行的 PFAM: the band chart drawn above a Gantt's date rows (Charts.gantt opts.band) and the pill button
 * that shows / hides it, shared by 總覽 › 專案總覽 and 專案甘特.
 *   count  : a PFAM counts once on a workday when any of its tasks runs; in "Others" every task counts as one
 *   limit  : the active headcount
 */
(function () {
  const M = window.Model;
  const { esc, fmt } = U;

  const svg = (w, body) => `<svg width="${w}" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
  const ICON = {
    arrow: svg(14, '<path d="M3 8h9M8.5 4.5 12 8l-3.5 3.5"/>'),
    chev: svg(12, '<path d="M4 6l4 4 4-4"/>'),
    collapse: svg(14, '<path d="M5 3l3 3 3-3M5 13l3-3 3 3"/>'),
    expand: svg(14, '<path d="M5 6l3-3 3 3M5 10l3 3 3-3"/>'),
  };

  /**
   * projects: in stack order (their colors); opts.pfamIds: only these PFAMs (e.g. a 廠區 filter);
   * opts.cap / opts.capLabel / opts.capNote: a custom limit (a project's 警戒上限; 0 = none) instead of the headcount;
   * opts.projCaps: also flag a day when any project runs more PFAMs than its own 警戒上限 (全部專案).
   * -> { band (for Charts.gantt), spark, chips (button html), overN }
   */
  function build(projects, from, to, today, opts) {
    opts = opts || {};
    const days = M.pfamLoad(Store.data, from, to, { today, projectIds: new Set(projects.map((p) => p.id)), pfamIds: opts.pfamIds, isOthers: Convert.isOthers });
    const custom = opts.cap != null;
    // Default limit: the people who count as manpower (active, minus 設定 › 不計入人力的人員 such as the manager).
    const head = Store.workforce().length;
    const cap = custom ? opts.cap : head;
    const capLabel = custom ? opts.capLabel || `警戒 ${cap} 個` : `人力上限 ${cap}`;
    const overWord = custom ? "超過警戒" : "超過人力";
    // Per day: PFAMs per project, and the projects over their own 警戒上限 (opts.projCaps only).
    for (const d of days) {
      d.per = new Map();
      for (const u of d.units.values()) d.per.set(u.projectId, (d.per.get(u.projectId) || 0) + 1);
      d.projOver = opts.projCaps ? projects.filter((p) => p.pfamCap > 0 && (d.per.get(p.id) || 0) > p.pfamCap) : [];
    }
    const byDay = new Map(days.map((d) => [d.day, d]));
    const ahead = days.filter((d) => d.day >= today);
    const nowD = ahead[0];
    let peak = null;
    for (const d of ahead) if (!peak || d.total > peak.total) peak = d;
    const overN = cap ? ahead.filter((d) => d.total > cap).length : 0;
    const projOverN = ahead.filter((d) => d.projOver.length).length;

    // Button: a sparkline of the coming workdays, then today / peak / over-headcount chips.
    const next = ahead.slice(0, 22);
    const top = Math.max(...next.map((d) => d.total), 1);
    const sMax = top >= cap * 0.5 ? Math.max(cap, top) : top; // far below the limit: scale to the data (like the band)
    const spark = next.length
      ? `<svg class="spark" width="${next.length * 3}" height="16" aria-hidden="true">${next
          .map((d, i) => {
            const h = Math.max((d.total / sMax) * 15, d.total ? 2 : 1);
            return `<rect x="${i * 3}" y="${16 - h}" width="2" height="${h}" rx="0.5"${(cap && d.total > cap) || d.projOver.length ? ' class="over"' : d.total ? "" : ' class="zero"'}/>`;
          })
          .join("")}</svg>`
      : "";
    const chips =
      (nowD ? `<span class="chip-n" title="${nowD.day === today ? "今天" : `下一個工作天 ${fmt(nowD.day, "full")}`}">目前 <b>${nowD.total}</b></span>` : "") +
      (peak && peak.total ? `<span class="chip-n" title="今天起到期間結束最多">峰值 <b>${peak.total}</b><small>${fmt(peak.day, "short")}</small></span>` : "") +
      (overN ? `<span class="chip-n warn" title="同時進行的 PFAM 多於${capLabel}${custom ? "" : `（計入人力的在職人數）`}">${overWord} <b>${overN}</b> 天</span>` : "") +
      (projOverN ? `<span class="chip-n warn" title="有 Project 同時進行的 PFAM 多於它自己的警戒上限（編輯 Project 設定）">專案超過警戒 <b>${projOverN}</b> 天</span>` : "");

    const band = {
      title: "同時進行的 PFAM",
      sub: `同一 PFAM 只算 1・Others 每個 task 算 1${custom ? "" : `<br>人力上限＝計入人力的在職 ${head} 人`}<br>點柱子＝只看那天的 task`,
      cap,
      capLabel,
      capNote: !cap ? opts.capNote || "" : "",
      days: days.map((d) => ({ day: d.day, total: d.total, warn: d.projOver.length > 0, segs: projects.filter((p) => d.per.has(p.id)).map((p) => ({ color: p.color, n: d.per.get(p.id), over: d.projOver.includes(p) })) })),
      tip: (day) => (byDay.has(day) ? tip(byDay.get(day), projects, cap, capLabel) : ""),
    };
    return { band, spark, chips, overN, cap, capLabel, overWord, at: (day) => byDay.get(day) };
  }

  /**
   * The bar shown above a Gantt when a day is picked on the band: date, PFAM / task counts, over the limit,
   * "只看這天" toggle and clear. on: { only(checked), clear() }
   */
  function pinBar(el, b, day, only, on) {
    if (!el) return;
    if (day == null) {
      el.innerHTML = "";
      return;
    }
    const d = b.at(day);
    const n = d ? d.total : 0;
    const tasks = d ? new Set([...d.units.values()].flatMap((u) => u.tasks.map((t) => t.id))).size : 0;
    const over = b.cap && n > b.cap;
    const projOver = d ? d.projOver : [];
    el.innerHTML = `<div class="pin-bar${over || projOver.length ? " over" : ""}">
        <span class="pin-day">📌 ${fmt(day, "full")}</span>
        <span>同時 <b>${n}</b> 個 PFAM・<b>${tasks}</b> 個 task</span>
        ${over ? `<span class="chip-n warn">${b.overWord} ${n - b.cap} 個（${b.capLabel}）</span>` : ""}
        ${projOver.map((p) => `<span class="chip-n warn">${esc(p.name)} ${d.per.get(p.id)} 個・超過警戒 ${d.per.get(p.id) - p.pfamCap} 個（警戒 ${p.pfamCap} 個）</span>`).join("")}
        <label class="check small"><input type="checkbox" data-pin="only"${only ? " checked" : ""}> 只看這天進行中的 PFAM / task</label>
        <span class="grow"></span>
        <button class="hbtn ghost" type="button" data-pin="clear">✕ 取消標記</button>
      </div>`;
    el.querySelector('[data-pin="only"]').onchange = (ev) => on.only(ev.target.checked);
    el.querySelector('[data-pin="clear"]').onclick = () => on.clear();
  }

  function tip(d, projects, cap, capLabel) {
    const by = new Map();
    for (const u of d.units.values()) {
      if (!by.has(u.projectId)) by.set(u.projectId, []);
      by.get(u.projectId).push(u);
    }
    const rows = projects
      .filter((p) => by.has(p.id))
      .map((p) => {
        const us = by.get(p.id);
        const names = us.map((u) => (u.others ? `${u.pfam.name}：${u.tasks[0].name}` : u.pfam.name));
        const pOver = d.projOver.includes(p);
        return `<div class="tt-sec"><i class="dot" style="--c:${p.color}"></i> ${esc(p.name)}・${us.length} 個${pOver ? `<span class="late">（超過警戒 ${p.pfamCap} 個）</span>` : ""}</div>${names
          .slice(0, 8)
          .map((x) => `<div class="tt-row"><span>${esc(x)}</span></div>`)
          .join("")}${names.length > 8 ? `<div class="muted">…還有 ${names.length - 8} 個</div>` : ""}`;
      })
      .join("");
    return `<b>${fmt(d.day, "full")}</b><div class="tt-big">同時 ${d.total} 個 PFAM${cap && d.total > cap ? `<span class="late">（超過${capLabel}）</span>` : ""}</div>${rows || `<div class="muted">沒有進行中的 PFAM</div>`}`;
  }

  /** Fill the toggle button (a .hbtn) for the current state; onToggle() flips it. */
  function button(el, b, open, onToggle) {
    if (!el) return;
    el.innerHTML = `${b.spark}<span>PFAM 負載</span>${b.chips}<span class="chev">${ICON.chev}</span>`;
    el.setAttribute("aria-pressed", String(open));
    el.title = open ? "收起同時進行的 PFAM 柱狀圖" : "在日期列上方展開同時進行的 PFAM 柱狀圖";
    el.onclick = onToggle;
  }

  window.PfamBand = { build, button, pinBar, ICON };
})();
