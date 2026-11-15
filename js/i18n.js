/*
 * Language switch: 中文 is the main version, English is there for local MTEs. Every user-visible string is
 * written in place as L("中文", "English"), so both versions sit side by side in the code and a change
 * cannot forget one of them. Loaded before every other script.
 *
 * Static text in index.html carries its English in data-en (inner HTML) and data-en-<attr> (title,
 * aria-label, placeholder); applyStatic() swaps it, keeping the Chinese in data-zh*.
 * Only the interface is translated: names, notes and other data people typed stay as typed.
 */
(function () {
  const KEY = "llt800.lang";
  const ATTRS = ["title", "aria-label", "placeholder"];
  let lang = "zh";
  try {
    if (localStorage.getItem(KEY) === "en") lang = "en";
  } catch {
    /* no storage: Chinese */
  }

  function applyStatic(root) {
    const en = lang === "en";
    (root || document).querySelectorAll("[data-en]").forEach((el) => {
      if (el.dataset.zh === undefined) el.dataset.zh = el.innerHTML;
      el.innerHTML = en ? el.dataset.en : el.dataset.zh;
    });
    for (const a of ATTRS)
      (root || document).querySelectorAll(`[data-en-${a}]`).forEach((el) => {
        const keep = "zh" + a.replace(/-./g, (m) => m[1].toUpperCase()).replace(/^./, (c) => c.toUpperCase());
        if (el.dataset[keep] === undefined) el.dataset[keep] = el.getAttribute(a) || "";
        el.setAttribute(a, en ? el.getAttribute(`data-en-${a}`) : el.dataset[keep]);
      });
  }

  const I18N = {
    get lang() {
      return lang;
    },
    get en() {
      return lang === "en";
    },
    /** The string for the current language; English falls back to Chinese when it is not given. */
    L(zh, en) {
      return lang === "en" && en != null ? en : zh;
    },
    /** Locale for toLocaleString / Intl. */
    locale() {
      return lang === "en" ? "en-US" : "zh-TW";
    },
    set(next) {
      lang = next === "en" ? "en" : "zh";
      try {
        localStorage.setItem(KEY, lang);
      } catch {
        /* this page only */
      }
      document.documentElement.lang = lang === "en" ? "en" : "zh-Hant-TW";
      applyStatic();
    },
    applyStatic,
  };

  window.I18N = I18N;
  window.L = I18N.L;
  document.documentElement.lang = lang === "en" ? "en" : "zh-Hant-TW";
  if (lang === "en") document.addEventListener("DOMContentLoaded", () => applyStatic());
})();
