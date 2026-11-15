/*
 * Google Apps Script backend client (optional, see apps-script/Code.gs and README).
 * Reads use JSONP (a <script> tag), which works from file:// and is not blocked by third-party cookie
 * rules on the googleusercontent redirect. Writes use a text/plain POST (no CORS preflight).
 */
(function () {
  const LS_REMOTE = "llt800.remote.v1";
  const TIMEOUT_MS = 60000; // an idle Apps Script web app can take 10-30 s to cold-start
  // Built-in web app URL (ending in /exec). When set, every visitor starts in cloud mode. Leave empty for local mode.
  const DEFAULT_URL = "https://script.google.com/macros/s/AKfycbwkR2lRkMVl3OUGtNI2yisjHym40KBtKB0iTIDJVG6dybovRnncNp7MJ_BQHBcvqf1C/exec";

  function loadConfig() {
    let saved = {};
    try {
      saved = JSON.parse(localStorage.getItem(LS_REMOTE) || "{}");
    } catch {
      /* unreadable: defaults */
    }
    const c = Object.assign({ url: "", key: "", enabled: false, who: "" }, saved);
    if (DEFAULT_URL && !c.url) {
      c.url = DEFAULT_URL;
      c.enabled = true;
    }
    return c;
  }

  /**
   * A deployment older than the Employees sheet's `ado` column drops employee.ado on every save, so
   * loading the cloud copy would silently wipe the roster's ADO 帳號 (「ADO Task › 我的成員」的對應).
   * Until Code.gs is redeployed, keep what this browser holds and tell the caller. The current backend
   * always sends the key, empty or not, so this never fires against it.
   */
  function keepAdoFromOldBackend(employees) {
    if (!employees.length || employees.some((e) => "ado" in e)) return false;
    const mine = new Map((window.Store && Store.data ? Store.data.employees : []).filter((e) => e.ado).map((e) => [e.id, e.ado]));
    if (!mine.size) return false;
    for (const e of employees) if (mine.has(e.id)) e.ado = mine.get(e.id);
    return true;
  }

  // The MTE PFAM sync fields this page sends; a backend that lacks any of them would silently drop it.
  const COLLAB_FIELDS = ["project", "pfam", "type", "pn", "site", "pod", "start", "end", "owner", "status", "note"];

  const OUTDATED = "雲端後端版本較舊，部分欄位會存不進去：請把最新的 apps-script/Code.gs 重新部署（新版本）。The cloud backend is outdated: some fields will not be saved.";

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

    /** A rejected password throws an Error with .authFailed set, so callers can ask for it again. */
    async post(payload) {
      const res = await fetch(this.config.url, { method: "POST", body: JSON.stringify({ key: this.config.key || "", ...payload }), redirect: "follow" });
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error("Apps Script 回傳格式錯誤：" + text.slice(0, 120));
      }
      if (!json.ok && !json.conflict) {
        const err = new Error(json.error || "Apps Script 回報錯誤");
        if (json.authFailed) err.authFailed = true;
        throw err;
      }
      return json;
    },

    /**
     * Check an edit password with the backend (which alone decides who may write) and remember it on
     * this computer when it is right. Throws (err.authFailed when the password is wrong).
     */
    async auth(key) {
      await this.post({ action: "auth", key });
      this.saveConfig({ key });
    },

    /** Forget the edit password this computer remembers: back to read-only. */
    forgetKey() {
      this.saveConfig({ key: "" });
    },

    get hasKey() {
      return !!this.config.key;
    },

    async ping(url) {
      const r = await this.jsonp({ action: "ping" }, url);
      if (!r || !r.ok) throw new Error((r && r.error) || "回應異常");
      return r;
    },

    /**
     * Read the cloud dataset. Pass the version we already hold as `since` and the backend answers
     * { unchanged: true } without reading the sheets when nothing has changed since.
     * -> { version, savedAt, by, data|null } or { version, savedAt, by, unchanged: true }
     */
    async load(since) {
      const params = { action: "bundle" };
      if (since) params.since = since;
      const r = await this.jsonp(params);
      if (!r || !r.ok) throw new Error((r && r.error) || "讀取失敗");
      if (r.data && Array.isArray(r.data.employees)) r.legacyAdo = keepAdoFromOldBackend(r.data.employees);
      return r;
    },

    /**
     * MTE PFAM sync rows. `since` = the rev we hold -> { rev, rows } or { rev, unchanged: true }.
     * A deployment from before the tab (no rev) throws err.oldBackend; one that has the tab but lacks a
     * field this page sends (it would drop it on save) still answers, flagged r.outdated.
     */
    async collabLoad(since) {
      const params = { action: "collab" };
      if (since) params.since = since;
      const r = await this.jsonp(params);
      if (!r || !r.ok) throw new Error((r && r.error) || "讀取失敗 Load failed");
      if (!("rev" in r)) {
        const err = new Error(OUTDATED);
        err.oldBackend = true;
        throw err;
      }
      r.outdated = !r.fields || COLLAB_FIELDS.some((f) => !r.fields.includes(f));
      if (r.outdated) r.outdatedMsg = OUTDATED;
      return r;
    },

    /** Open to everyone: never sends the edit password. -> { ok, row, rev } or { conflict, row, rev } */
    collabPost(payload) {
      return this.post({ ...payload, key: undefined });
    },

    /** Whole-dataset save with an optimistic lock: -> { ok, version } or { conflict, version } */
    save(data, baseVersion, force) {
      return this.post({ action: "saveAll", data, baseVersion: force ? null : baseVersion, by: this.config.who || "" });
    },
  };

  window.Remote = Remote;
})();
