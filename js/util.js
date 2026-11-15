/* Shared browser helpers: dates, formatting, DOM shortcuts. */
(function () {
  const E = window.Engine;
  const WD_ZH = ["日", "一", "二", "三", "四", "五", "六"];
  const WD_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  /** Weekday names in the current language (I18N, js/i18n.js). */
  const wd = () => (window.I18N && I18N.en ? WD_EN : WD_ZH);

  function fmt(day, style) {
    if (day == null) return "";
    if (typeof day === "string") day = E.toDay(day);
    const [y, m, d] = E.fromDay(day).split("-");
    if (style === "short") return `${+m}/${+d}`;
    if (style === "yy") return `${y.slice(2)}/${m}/${d}`;
    if (style === "full") return `${y}/${m}/${d} (${wd()[E.weekday(day)]})`;
    if (style === "wd") return `${+m}/${+d} (${wd()[E.weekday(day)]})`;
    return `${y}/${m}/${d}`;
  }

  /** "10/5 – 10/9"; dates outside the current year carry it ("26/12/29 – 27/1/3"). */
  function range(a, b) {
    if (!a && !b) return "—";
    const y = String(new Date().getFullYear());
    const one = (d) => {
      if (d == null || d === "") return "";
      const iso = typeof d === "string" ? d : E.fromDay(d);
      return iso.slice(0, 4) === y ? fmt(iso, "short") : `${iso.slice(2, 4)}/${fmt(iso, "short")}`;
    };
    return `${one(a)} – ${one(b)}`;
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => [...(root || document).querySelectorAll(sel)];

  function debounce(fn, ms) {
    let t;
    return (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...a), ms);
    };
  }

  function today() {
    const d = new Date();
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return E.toDay(iso);
  }

  function download(name, text, type) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: type || "application/json" }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function readFile(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsText(file);
    });
  }

  /** Readable text color on a hex background. */
  function inkOn(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
    if (!m) return "#fff";
    const n = parseInt(m[1], 16);
    const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
    return lum > 0.62 ? "#1a1a19" : "#fff";
  }

  /** Floating tooltip shared by every chart. */
  const tip = {
    el: null,
    show(html, ev) {
      if (!this.el) {
        this.el = document.createElement("div");
        this.el.className = "tooltip";
        document.body.appendChild(this.el);
      }
      this.el.innerHTML = html;
      this.el.hidden = false;
      this.move(ev);
    },
    move(ev) {
      if (!this.el || this.el.hidden) return;
      const pad = 14;
      const r = this.el.getBoundingClientRect();
      let x = ev.clientX + pad;
      let y = ev.clientY + pad;
      if (x + r.width > innerWidth - 8) x = ev.clientX - r.width - pad;
      if (y + r.height > innerHeight - 8) y = Math.max(8, ev.clientY - r.height - pad);
      this.el.style.left = x + "px";
      this.el.style.top = y + "px";
    },
    hide() {
      if (this.el) this.el.hidden = true;
    },
  };

  window.U = {
    fmt, range, esc, $, $$, debounce, today, download, readFile, inkOn, tip,
    get WD() {
      return wd();
    },
  };
})();
