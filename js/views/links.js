/*
 * 常用連結: the links the department keeps going back to, grouped. They live in settings.links (department
 * data, synced to the cloud sheet like everything else) and are edited in 編輯模式.
 */
(function () {
  const { esc, $, $$ } = U;
  const OTHER = "其他";

  const hostOf = (url) => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  };

  /** A stable palette color per name, for the letter badge. */
  function colorOf(name) {
    let h = 0;
    for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    return Convert.PALETTE[h % Convert.PALETTE.length];
  }

  /** One link as a full-width row: badge, name + host, then the description in the rest of the row. */
  function tile(l) {
    const name = l.title || hostOf(l.url);
    const search = [l.title, l.url, l.note, l.group].join(" ").toLowerCase();
    return `<div class="lk-tile" data-search="${esc(search)}">
      <a class="lk-main" href="${esc(l.url)}" target="_blank" rel="noopener" title="${esc(l.url)}">
        <span class="lk-ico" style="--c:${colorOf(name)}" aria-hidden="true">${esc([...name][0].toUpperCase())}</span>
        <span class="lk-text"><b>${esc(name)}</b><small>${esc(hostOf(l.url))}</small></span>
        <span class="lk-note">${l.note ? esc(l.note) : ""}</span>
        <span class="lk-go" aria-hidden="true">↗</span>
      </a>
      <button class="mini edit-only lk-edit" type="button" data-edit="${esc(l.id)}" aria-label="編輯「${esc(name)}」">✎</button>
    </div>`;
  }

  function render(root) {
    const links = Store.data.settings.links;
    const groups = new Map();
    for (const l of links) {
      const g = l.group || OTHER;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(l);
    }
    // 其他 (no group) after the named groups.
    const order = [...groups.keys()].filter((g) => g !== OTHER).concat(groups.has(OTHER) ? [OTHER] : []);

    const section = (g, list) => `<section class="card lk-group">
      <header class="card-h"><h3>${esc(g)}</h3><span class="count">${list.length}</span><span class="grow"></span>
        <button class="btn small edit-only" type="button" data-add="${esc(g === OTHER ? "" : g)}">＋ 加到這一類</button></header>
      <div class="lk-list">${list.map(tile).join("")}</div></section>`;

    root.innerHTML = `
      <div class="page-head"><h2>常用連結</h2>
        <label class="field-inline lk-search"><span>搜尋</span><input type="search" id="lkSearch" placeholder="名稱、網址、說明…" autocomplete="off"></label>
        <span class="grow"></span>
        <button class="btn primary edit-only" id="lkAdd" type="button">＋ 新增連結</button>
      </div>
      ${
        links.length
          ? order.map((g) => section(g, groups.get(g))).join("")
          : `<section class="card"><p class="empty">還沒有連結。${Store.editing ? "按右上角「＋ 新增連結」加第一個。" : "進入<b>編輯模式</b>後按「＋ 新增連結」，連結會同步給部門所有人。"}</p></section>`
      }
      <p class="muted lk-none" id="lkNone" hidden>沒有符合的連結。</p>`;

    $("#lkAdd").onclick = () => Editors.link(null);
    root.onclick = (ev) => {
      const ed = ev.target.closest("[data-edit]");
      if (ed) return Editors.link(ed.dataset.edit);
      const add = ev.target.closest("[data-add]");
      if (add) return Editors.link(null, { group: add.dataset.add });
    };
    // Filter in place, so typing never re-renders (and never loses the caret).
    $("#lkSearch").oninput = (ev) => {
      const terms = ev.target.value.toLowerCase().split(/\s+/).filter(Boolean);
      let any = false;
      $$(".lk-group", root).forEach((sec) => {
        let shown = 0;
        $$(".lk-tile", sec).forEach((t) => {
          const hit = terms.every((w) => t.dataset.search.includes(w));
          t.hidden = !hit;
          if (hit) shown++;
        });
        sec.hidden = !shown;
        if (shown) any = true;
      });
      $("#lkNone").hidden = any || !$$(".lk-group", root).length;
    };
  }

  window.LinksView = { render };
})();
