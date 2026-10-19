/*
 * Rendering helpers shared by the views:
 *   Charts.gantt()     timeline with a sticky label column (projects page, people timelines)
 *   Charts.loadTip()   tooltip for one day's load (who is busy, who is free)
 * Bars and cells carry data-tip ids; the caller supplies tooltip HTML through opts.tip(id).
 */
(function () {
  const E = window.Engine;
  const { esc, fmt } = U;
  const ZOOM = { day: 22, week: 6, month: 2.2 };

  function monthStarts(from, to) {
    const out = [];
    const [y0, m0] = E.fromDay(from).split("-").map(Number);
    let y = y0;
    let m = m0;
    for (;;) {
      const d = E.toDay(`${y}-${String(m).padStart(2, "0")}-01`);
      if (d > to) break;
      out.push({ day: d, y, m });
      m++;
      if (m > 12) {
        m = 1;
        y++;
      }
    }
    return out;
  }

  /**
   * rows: [{ id, kind: "group"|"task"|"sub", label (html), meta (html), bars: [{ id, start, end, color, cls, text, base: {start,end} }], cls, rc (row accent color) }]
   * opts: { from, to, zoom, today, labelHead, tip(barId) -> html, onBar(barId, ev), onLabel(rowId, ev), marks: [{day, cls, title}],
   *         holidays (Map day -> name; default settings.holidays), fit (stretch the days to fill the container width), outLabels, clipText, scrollToToday, scrollToDay,
   *         band: { title, sub, height, cap, capLabel, capNote, days: [{ day, total, segs: [{ color, n }] }], tip(day) -> html,
   *                 pinned (day), onPick(day) } }
   * band = a stacked daily column chart drawn in the header above the date rows, on the same x axis.
   */
  const anchors = new Map(); // container id -> last scrollToDay

  function gantt(el, rows, opts) {
    let ppd = ZOOM[opts.zoom] || ZOOM.week;
    if (opts.fit) {
      const lw = parseFloat(getComputedStyle(el).getPropertyValue("--label-w")) || 340;
      ppd = Math.max(ppd, (el.clientWidth - lw - 20) / (opts.to - opts.from + 1)); // 20: borders + a vertical scrollbar
    }
    const from = opts.from;
    const to = opts.to;
    const W = Math.round((to - from + 1) * ppd);
    const x = (d) => Math.round((d - from) * ppd);
    const months = monthStarts(from, to);
    const hol = opts.holidays || window.Model.holidays(Store.data);
    // Holidays on weekdays get a band like the weekend (day and week zoom); weekends already have one in day zoom.
    let holBands = "";
    if (opts.zoom !== "month")
      for (const d of hol.keys()) if (d >= from && d <= to && E.weekday(d) % 6) holBands += `<i class="g-we" style="left:${x(d)}px;width:${Math.max(ppd, 2)}px"></i>`;

    // Header: months, then weeks (Mondays) or days.
    let top = "";
    months.forEach((mo, i) => {
      const a = Math.max(mo.day, from);
      const b = i + 1 < months.length ? months[i + 1].day : to + 1;
      const w = x(b) - x(a);
      top += `<div class="g-m" style="left:${x(a)}px;width:${w}px">${w > 46 ? `${mo.y}/${String(mo.m).padStart(2, "0")}` : w > 22 ? mo.m : ""}</div>`;
    });
    let sub = "";
    if (opts.zoom === "day") {
      for (let d = from; d <= to; d++) {
        const wd = E.weekday(d);
        const txt = ppd >= 46 ? `${fmt(d, "short")} ${U.WD[wd]}` : E.fromDay(d).slice(8).replace(/^0/, "");
        const off = hol.has(d);
        sub += `<div class="g-d${wd === 0 || wd === 6 || off ? " we" : ""}${d === opts.today ? " now" : ""}" style="left:${x(d)}px;width:${ppd}px"${off ? ` title="${esc(hol.get(d) || "假日")}"` : ""}>${txt}</div>`;
      }
    } else if (opts.zoom === "week") {
      for (let d = from; d <= to; d++) if (E.weekday(d) === 1) sub += `<div class="g-w" style="left:${x(d)}px">${fmt(d, "short")}</div>`;
    }

    // Background grid: month lines, weekend bands (day zoom), holiday bands, today line, extra marks.
    let grid = months.filter((m) => m.day > from).map((m) => `<i class="g-ml" style="left:${x(m.day)}px"></i>`).join("");
    if (opts.zoom === "day") for (let d = from; d <= to; d++) if (E.weekday(d) === 6) grid += `<i class="g-we" style="left:${x(d)}px;width:${ppd * 2}px"></i>`;
    grid += holBands;
    for (const mk of opts.marks || []) if (mk.day >= from && mk.day <= to) grid += `<i class="g-mark ${mk.cls || ""}" style="left:${x(mk.day)}px;width:${Math.max(ppd, 2)}px" title="${esc(mk.title || "")}"></i>`;
    // The today line goes in .g-front (over the bars), not in the grid behind them.
    let front = "";
    if (opts.today >= from && opts.today <= to) {
      front = `<i class="g-today" style="left:${x(opts.today) + ppd / 2}px"></i>`;
      if (opts.zoom !== "day") sub += `<b class="g-now" style="left:${x(opts.today) + ppd / 2}px">今天</b>`;
    }

    // Optional band chart above the date rows (same x axis as the bars).
    let band = "";
    if (opts.band) {
      const B = opts.band;
      const BH = B.height || 112;
      const padT = 16;
      const top = Math.max(...B.days.map((d) => d.total), 1);
      // Far below the limit (e.g. one project): scale to the data and only name the limit.
      const showCap = B.cap && top >= B.cap * 0.5;
      const maxV = Math.max(showCap ? B.cap : 0, top);
      const step = maxV <= 6 ? 1 : maxV <= 14 ? 2 : 5;
      const yMax = Math.ceil(maxV / step) * step;
      const yb = (v) => padT + (BH - padT - 3) * (1 - v / yMax);
      let g = months.filter((m) => m.day > from).map((m) => `<i class="g-ml" style="left:${x(m.day)}px"></i>`).join("");
      let ticks = "";
      for (let v = 0; v <= yMax; v += step) {
        g += `<i class="gb-grid" style="top:${yb(v)}px"></i>`;
        ticks += `<span class="gb-tick" style="top:${yb(v)}px">${v}</span>`;
      }
      for (let d = from; d <= to; d++) if (E.weekday(d) === 6) g += `<i class="g-we" style="left:${x(d)}px;width:${ppd * 2}px"></i>`;
      g += holBands;
      const cw = (d) => Math.max(x(d + 1) - x(d), 1); // day cell width: columns tile edge to edge
      for (const d of B.days) {
        if (d.day < from || d.day > to) continue;
        const over = showCap && d.total > B.cap;
        // Over the limit: the whole day gets a red wash and the part above the limit turns red.
        if (over) g += `<i class="gb-overbg" style="left:${x(d.day)}px;width:${cw(d.day)}px"></i>`;
        if (B.pinned === d.day) g += `<i class="gb-pin" style="left:${x(d.day)}px;width:${cw(d.day)}px"></i>`;
        let acc = 0;
        for (const sg of d.segs) {
          // A project over its own 警戒上限 (sg.over): its segment gets a thick red frame and "!!" goes on top of the column.
          g += `<i class="gb-seg${sg.over ? " over" : ""}" style="left:${x(d.day)}px;width:${cw(d.day)}px;top:${yb(acc + sg.n)}px;height:${Math.max(yb(acc) - yb(acc + sg.n), 1)}px;background:${sg.color}"></i>`;
          acc += sg.n;
        }
        if (over) g += `<i class="gb-over" style="left:${x(d.day)}px;width:${cw(d.day)}px;top:${yb(d.total)}px;height:${Math.max(yb(B.cap) - yb(d.total), 1)}px"></i>`;
        const val = d.total && ppd >= 16;
        if (val) g += `<span class="gb-val${over || d.warn ? " over" : ""}" style="left:${x(d.day)}px;width:${cw(d.day)}px;top:${yb(d.total) - 15}px">${d.total}</span>`;
        if (d.warn) g += `<span class="gb-warn" style="left:${x(d.day)}px;width:${cw(d.day)}px;top:${yb(d.total) - (val ? 28 : 15)}px">!!</span>`;
        g += `<i class="gb-hit${B.onPick ? " pick" : ""}" data-bday="${d.day}" style="left:${x(d.day)}px;width:${cw(d.day)}px"></i>`;
      }
      if (showCap) g += `<i class="gb-cap" style="top:${yb(B.cap)}px"></i>`;
      if (opts.today >= from && opts.today <= to) g += `<i class="g-today" style="left:${x(opts.today) + ppd / 2}px"></i>`;
      band = `<div class="g-hrow g-bandrow"><div class="g-corner gb-corner" style="height:${BH}px"><span class="gb-title">${B.title || ""}</span>${B.sub ? `<span class="gb-sub">${B.sub}</span>` : ""}${
        showCap ? `<span class="gb-caplab" style="top:${yb(B.cap)}px">${B.capLabel || `上限 ${B.cap}`}</span>` : B.cap ? `<span class="gb-sub">上限：${B.capLabel || B.cap}（遠高於目前）</span>` : B.capNote ? `<span class="gb-sub">${B.capNote}</span>` : ""
      }${ticks}</div><div class="g-band" style="width:${W}px;height:${BH}px">${g}</div></div>`;
    }

    const bar = (b, kind) => {
      if (b.start == null || b.end == null) return "";
      const s = Math.max(b.start, from);
      const e = Math.min(b.end, to);
      if (e < s) return "";
      const left = x(s);
      const w = Math.max(x(e + 1) - left, 3);
      let base = "";
      if (b.base && b.base.start != null && b.base.end != null) {
        const bs = Math.max(b.base.start, from);
        const be = Math.min(b.base.end, to);
        if (be >= bs) base = `<i class="g-base" style="left:${x(bs)}px;width:${Math.max(x(be + 1) - x(bs), 2)}px"></i>`;
      }
      const ink = U.inkOn(b.color);
      // clipText: the name always goes inside (cut with "…") once the bar is wide enough for a few letters
      const inside = b.text && (opts.clipText ? w >= 26 : w > b.text.length * 7 + 16);
      return `${base}<div class="g-bar ${kind} ${b.cls || ""}" data-bar="${esc(b.id)}" style="left:${left}px;width:${w}px;--c:${b.color || "var(--s1)"};--bink:${ink}">${
        inside ? `<span>${esc(b.text)}</span>` : ""
      }</div>${!inside && b.text && kind !== "group" && opts.outLabels !== false ? `<span class="g-out" style="left:${left + w + 6}px">${esc(b.text)}</span>` : ""}`;
    };

    const body = rows
      .map(
        (r) => `<div class="g-row ${r.kind} ${r.cls || ""}" data-row="${esc(r.id)}"${r.rc ? ` style="--rc:${r.rc}"` : ""}>
          <div class="g-label">${r.label}${r.meta ? `<span class="g-meta">${r.meta}</span>` : ""}</div>
          <div class="g-track" style="width:${W}px">${(r.bars || []).map((b) => bar(b, r.kind)).join("")}</div>
        </div>`
      )
      .join("");

    el.innerHTML = `<div class="g-scroll"><div class="gantt" style="--W:${W}px">
      <div class="g-head">${band}<div class="g-hrow"><div class="g-corner">${opts.labelHead || ""}</div><div class="g-scale" style="width:${W}px"><div class="g-mrow">${top}</div><div class="g-srow">${sub}</div></div></div></div>
      <div class="g-body"><div class="g-grid" style="width:${W}px">${grid}</div>${body || `<div class="g-empty">沒有資料</div>`}<div class="g-front" style="width:${W}px">${front}</div></div>
    </div></div>`;

    const sc = el.querySelector(".g-scroll");
    // Start scrolled so today sits about a fifth into the view.
    // Start scrolled to a given day (a focused task) or to today.
    const anchor = opts.scrollToDay != null ? opts.scrollToDay : opts.scrollToToday !== false ? opts.today : null;
    // Only a new scrollToDay (a picked day, a focused task) should move a re-rendered Gantt sideways.
    if (opts.scrollToDay != null && anchors.get(el.id) !== opts.scrollToDay) sc.dataset.newAnchor = "1";
    if (el.id) anchors.set(el.id, opts.scrollToDay);
    if (anchor != null && anchor >= from && anchor <= to) sc.scrollLeft = Math.max(0, x(anchor) - (sc.clientWidth - 340) * (opts.scrollToDay != null ? 0.15 : 0.35));

    sc.addEventListener("mousemove", (ev) => {
      const bd = ev.target.closest("[data-bday]");
      if (bd && opts.band && opts.band.tip) return U.tip.show(opts.band.tip(+bd.dataset.bday), ev);
      const b = ev.target.closest("[data-bar]");
      if (b && opts.tip) {
        const html = opts.tip(b.dataset.bar);
        if (html) return U.tip.show(html, ev);
      }
      U.tip.hide();
    });
    sc.addEventListener("mouseleave", () => U.tip.hide());
    sc.addEventListener("click", (ev) => {
      const bd = ev.target.closest("[data-bday]");
      if (bd && opts.band && opts.band.onPick) return opts.band.onPick(+bd.dataset.bday);
      const b = ev.target.closest("[data-bar]");
      if (b && opts.onBar) return opts.onBar(b.dataset.bar, ev);
      const l = ev.target.closest(".g-label");
      if (l && opts.onLabel) opts.onLabel(l.parentElement.dataset.row, ev);
    });
    return { x, ppd };
  }

  /** Default range for a set of day spans: a little before the first and after the last. */
  function rangeFor(spans, today, zoom) {
    let a = Infinity;
    let b = -Infinity;
    for (const s of spans) {
      if (s.start != null) a = Math.min(a, s.start);
      if (s.end != null) b = Math.max(b, s.end);
    }
    if (!isFinite(a)) {
      a = today - 14;
      b = today + 90;
    }
    const pad = zoom === "day" ? 3 : zoom === "week" ? 10 : 20;
    return { from: a - pad, to: Math.max(b + pad, a + 30) };
  }

  /** Tooltip body for one load day (the 人力熱度 department row). */
  function loadTip(d) {
    const busy = [...d.busy.entries()]
      .map(([id, ts]) => ({ name: Store.empName(id), ts }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const un = [...d.unassigned.values()].map((u) => ({ f: u.pfam, ts: u.tasks }));
    const line = (ts) => esc(ts.slice(0, 2).map((t) => t.name).join("、") + (ts.length > 2 ? ` 等 ${ts.length} 件` : ""));
    return `<b>${fmt(d.day, "full")}</b>
      <div class="tt-big">忙碌 ${d.busy.size} / ${d.head} 人${d.unassigned.size ? `　＋ 未指派 ${d.unassigned.size} 個 PFAM` : ""}</div>
      ${d.alert ? `<div class="tt-alert">⚠ 超出部門人力</div>` : ""}
      ${busy.length ? `<div class="tt-sec">忙碌</div>${busy.slice(0, 10).map((b) => `<div class="tt-row"><span>${esc(b.name)}</span><small>${line(b.ts)}</small></div>`).join("")}${busy.length > 10 ? `<div class="muted">…還有 ${busy.length - 10} 人</div>` : ""}` : ""}
      ${un.length ? `<div class="tt-sec">未指派</div>${un.slice(0, 6).map((u) => `<div class="tt-row"><span>${esc((u.f && u.f.name) || "?")}</span><small>${line(u.ts)}</small></div>`).join("")}` : ""}
      <div class="tt-sec">空閒</div><div>${d.idle.length ? esc(d.idle.map((e) => e.name).join("、")) : "沒有人空著"}</div>`;
  }

  window.Charts = { ZOOM, gantt, rangeFor, loadTip, monthStarts };
})();
