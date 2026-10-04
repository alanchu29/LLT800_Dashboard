/*
 * Google Apps Script backend client (optional, see apps-script/Code.gs and README).
 * Reads use JSONP (a <script> tag), which works from file:// and is not blocked by third-party cookie
 * rules on the googleusercontent redirect. Writes use a text/plain POST (no CORS preflight).
 */
(function () {
  const LS_REMOTE = "llt800.remote.v1";
  const TIMEOUT_MS = 60000; // an idle Apps Script web app can take 10-30 s to cold-start
  // Built-in web app URL (ending in /exec). When set, every visitor starts in cloud mode. Leave empty for local mode.
  const DEFAULT_URL = "";

  function loadConfig() {
    let saved = {};
    try {
      saved = JSON.parse(localStorage.getItem(LS_REMOTE) || "{}");
    } catch {
      /* unreadable: defaults */
    }
    const c = Object.assign({ url: "", key: "", enabled: false }, saved);
    if (DEFAULT_URL && !c.url) {
      c.url = DEFAULT_URL;
      c.enabled = true;
    }
    return c;
  }

  const Remote = {
    config: loadConfig(),

    saveConfig(patch) {
      Object.assign(this.config, patch);
      try {
        localStorage.setItem(LS_REMOTE, JSON.stringify(this.config));
      } catch {
        /* session only */
      }
    },

    get active() {
      return !!(this.config.enabled && this.config.url);
    },

    jsonp(params, url) {
      url = url || this.config.url;
      return new Promise((resolve, reject) => {
        const cb = "__lltCb" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const qs = new URLSearchParams({ ...params, callback: cb, t: Date.now() });
        const s = document.createElement("script");
        const cleanup = () => {
          delete window[cb];
          s.remove();
          clearTimeout(timer);
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error("連線逾時：請確認 Apps Script 已部署為「所有人」可存取，且網址結尾是 /exec"));
        }, TIMEOUT_MS);
        window[cb] = (data) => {
          cleanup();
          resolve(data);
        };
        s.onerror = () => {
          cleanup();
          reject(new Error("無法連線到 Apps Script 網址"));
        };
        s.src = url + (url.includes("?") ? "&" : "?") + qs.toString();
        document.head.appendChild(s);
      });
    },

    async post(payload) {
      const res = await fetch(this.config.url, { method: "POST", body: JSON.stringify({ ...payload, key: this.config.key || "" }), redirect: "follow" });
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error("Apps Script 回傳格式錯誤：" + text.slice(0, 120));
      }
      if (!json.ok && !json.conflict) throw new Error(json.error || "Apps Script 回報錯誤");
      return json;
    },

    async ping(url) {
      const r = await this.jsonp({ action: "ping" }, url);
      if (!r || !r.ok) throw new Error((r && r.error) || "回應異常");
      return r;
    },

    /** -> { version, savedAt, data|null } */
    async load() {
      const r = await this.jsonp({ action: "bundle" });
      if (!r || !r.ok) throw new Error((r && r.error) || "讀取失敗");
      return r;
    },

    /** Whole-dataset save with an optimistic lock: -> { ok, version } or { conflict, version } */
    save(data, baseVersion, force) {
      return this.post({ action: "saveAll", data, baseVersion: force ? null : baseVersion });
    },
  };

  window.Remote = Remote;
})();
