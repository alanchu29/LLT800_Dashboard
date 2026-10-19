/*
 * Azure DevOps: REST calls straight from the page, plus the local bookkeeping around them
 * (connection settings, the PAT, the cached snapshot and CSV in / out).
 *
 * dev.azure.com answers with `Access-Control-Allow-Origin: *` and allows the `authorization`
 * header, so a PAT-authenticated fetch is not blocked by CORS - no proxy and no server involved.
 * If every request suddenly fails with "Failed to fetch", re-check that header before blaming
 * the network.
 *
 * Nothing here touches Store: ADO data is a read-only snapshot of another system, so it lives in
 * this browser (localStorage) and is never written into the department dataset or the cloud sheet.
 */
(function () {
  const API = "7.1";
  const BATCH = 200; // workitemsbatch takes at most 200 ids per call
  const LS_CFG = "llt800.ado.cfg.v1";
  const LS_CACHE = "llt800.ado.cache.v1";
  const LS_PAT = "llt800.ado.pat"; // only when the user ticks 記住
  const SS_PAT = "llt800.ado.pat"; // the default: gone when the tab closes
  const CACHE_LIMIT = 4 * 1024 * 1024; // a snapshot bigger than this is not worth a quota error

  /** The CSV header of a manual ADO export, so a fetch and an export land on the same columns. */
  const HEADER = ["Assigned To", "ID", "Work Item Type", "State", "Changed Date", "Created Date", "Tags", "Area Path", "Iteration Path", "Title", "Link"];

  const FIELDS = [
    "System.Id",
    "System.AssignedTo",
    "System.WorkItemType",
    "System.State",
    "System.ChangedDate",
    "System.CreatedDate",
    "System.Title",
    "System.Tags",
    "System.AreaPath",
    "System.IterationPath",
  ];

  /** States that mean "finished" - the WIQL asks ADO to leave these out. */
  const CLOSED = ["Done", "Closed", "Removed", "Resolved", "Completed", "Complete", "Cancelled", "Canceled", "Abandoned", "Rejected", "Inactive"];

  const DEFAULTS = { org: "Manufacturing-Test-Engineering", project: "Monica", where: "", queryId: "" };

  const read = (store, key, fb) => {
    try {
      const v = store.getItem(key);
      return v ? JSON.parse(v) : fb;
    } catch {
      return fb;
    }
  };
  const write = (store, key, v) => {
    try {
      store.setItem(key, JSON.stringify(v));
      return true;
    } catch {
      return false;
    }
  };
  const drop = (store, key) => {
    try {
      store.removeItem(key);
    } catch {
      /* private mode */
    }
  };

  /** An error the UI can react to: kind is auth | network | empty | http | parse. */
  function adoError(message, kind) {
    const e = new Error(message);
    e.kind = kind || "other";
    return e;
  }

  async function call(url, pat, payload) {
    const init = { method: payload ? "POST" : "GET", headers: { Authorization: "Basic " + btoa(":" + pat), Accept: "application/json" } };
    if (payload) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(payload);
    }
    let res;
    let text;
    try {
      res = await fetch(url, init);
      text = await res.text();
    } catch (err) {
      // A wrong org / project also lands here: its 404 carries no CORS header, so the browser
      // rejects the response before JS can read the status.
      throw adoError(`連不到 dev.azure.com — 請確認組織／專案名稱、網路、VPN 或 proxy。（${err && err.message ? err.message : "network error"}）`, "network");
    }
    // A rejected PAT comes back as 203 + the HTML sign-in page, not a 401.
    if (res.status === 203 || text.startsWith("<")) throw adoError("PAT 被拒絕 — 可能打錯、過期，或沒有 Work Items (Read) 權限。", "auth");
    if (res.status === 401 || res.status === 403) throw adoError(`沒有權限讀取這個專案（HTTP ${res.status}）。`, "auth");
    if (!res.ok) {
      let detail = "";
      try {
        detail = JSON.parse(text).message || "";
      } catch {
        detail = text.slice(0, 200);
      }
      throw adoError(`ADO 回應 HTTP ${res.status}${detail ? "：" + detail : ""}`, "http");
    }
    try {
      return JSON.parse(text);
    } catch {
      throw adoError("ADO 回了無法解析的內容。", "parse");
    }
  }

  const q = (s) => String(s).replace(/'/g, "''");

  function buildWiql(project, where) {
    const parts = [`[System.TeamProject] = '${q(project)}'`, `[System.State] NOT IN (${CLOSED.map((s) => `'${q(s)}'`).join(", ")})`];
    if (where) parts.push(`(${where})`);
    return `SELECT [System.Id] FROM WorkItems WHERE ${parts.join(" AND ")} ORDER BY [System.ChangedDate] ASC`;
  }

  const person = (v) => (v && typeof v === "object" ? v.displayName || v.uniqueName || "" : v || "");
  const day = (v) => (v ? String(v).slice(0, 10) : "");

  /** Work items -> records keyed by the export header (one shape for the API and for a CSV). */
  function toRecords(items, org, project) {
    const base = `https://dev.azure.com/${org}/${project}/_workitems/edit/`;
    return items
      .map((item) => {
        const f = item.fields || {};
        const id = item.id || f["System.Id"] || "";
        const who = f["System.AssignedTo"];
        return {
          "Assigned To": person(who) || "(Unassigned)",
          ID: String(id),
          "Work Item Type": f["System.WorkItemType"] || "",
          State: f["System.State"] || "",
          "Changed Date": day(f["System.ChangedDate"]),
          "Created Date": day(f["System.CreatedDate"]),
          Tags: f["System.Tags"] || "",
          "Area Path": f["System.AreaPath"] || "",
          "Iteration Path": f["System.IterationPath"] || "",
          Title: f["System.Title"] || "",
          Link: base + id,
          // Not part of the export header (so it stays out of the CSV), but it is the surest way to
          // pair an ADO account with someone on the roster.
          Email: (who && typeof who === "object" && who.uniqueName) || "",
        };
      })
      .sort((a, b) => String(a["Assigned To"]).localeCompare(String(b["Assigned To"])) || String(a["Changed Date"]).localeCompare(String(b["Changed Date"])));
  }

  // ------------------------------------------------------------------ CSV (RFC 4180, BOM + CRLF tolerant)
  function parseCsv(text) {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const rows = [];
    let row = [];
    let field = "";
    let quoted = false; // this field started with a quote
    let inQuotes = false;
    const endField = () => {
      row.push(field);
      field = "";
      quoted = false;
    };
    const endRow = () => {
      endField();
      if (!(row.length === 1 && row[0] === "")) rows.push(row); // skip blank lines
      row = [];
    };
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c !== '"') field += c;
        else if (text[i + 1] === '"') (field += '"'), i++;
        else inQuotes = false;
        continue;
      }
      if (c === '"' && field === "" && !quoted) (inQuotes = true), (quoted = true);
      else if (c === ",") endField();
      else if (c === "\n") endRow();
      else if (c !== "\r") field += c;
    }
    if (field !== "" || row.length) endRow();
    if (!rows.length) return [];
    const header = rows[0].map((h) => h.trim());
    return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? "").trim()])));
  }

  const cell = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const toCsv = (header, records) => [header.map(cell).join(",")].concat(records.map((r) => header.map((h) => cell(r[h])).join(","))).join("\r\n");

  const Ado = {
    HEADER,
    CLOSED,
    DEFAULTS,
    buildWiql,
    toRecords,
    parseCsv,
    toCsv,

    // ------------------------------------------------------------ settings & PAT
    cfg() {
      return { ...DEFAULTS, ...read(localStorage, LS_CFG, {}) };
    },
    setCfg(patch) {
      write(localStorage, LS_CFG, { ...this.cfg(), ...patch });
    },

    /** The PAT for this tab: the session copy first, then the one the user asked to remember. */
    pat() {
      try {
        return sessionStorage.getItem(SS_PAT) || localStorage.getItem(LS_PAT) || "";
      } catch {
        return "";
      }
    },
    patRemembered() {
      try {
        return !!localStorage.getItem(LS_PAT);
      } catch {
        return false;
      }
    },
    /** Never log this, never put it in the URL, never send it anywhere but dev.azure.com. */
    setPat(pat, remember) {
      try {
        sessionStorage.setItem(SS_PAT, pat);
      } catch {
        /* private mode: the PAT then lives only in this render */
      }
      if (remember) write(localStorage, LS_PAT, pat) || window.App?.toast("瀏覽器拒絕儲存 PAT，這次只記在這個分頁。", "error");
      else drop(localStorage, LS_PAT);
    },
    forgetPat() {
      drop(localStorage, LS_PAT);
      drop(sessionStorage, SS_PAT);
    },

    // ------------------------------------------------------------ snapshot cache
    /** { records, source, at, dropped } or null; survives a reload so the tab is never empty twice. */
    readCache() {
      const c = read(localStorage, LS_CACHE, null);
      return c && Array.isArray(c.records) ? c : null;
    },
    writeCache(records, meta) {
      const payload = { records, ...meta };
      const text = JSON.stringify(payload);
      if (text.length > CACHE_LIMIT) return false;
      try {
        localStorage.setItem(LS_CACHE, text);
        return true;
      } catch {
        return false;
      }
    },
    clearCache() {
      drop(localStorage, LS_CACHE);
    },

    // ------------------------------------------------------------ fetch
    /**
     * Open work items of one project.
     * opts: { org, project, pat, where, queryId, onProgress } -> { records }
     * A saved query (queryId) replaces the generated WIQL, extra conditions and all.
     */
    async fetchOpenItems(opts) {
      const say = opts.onProgress || (() => {});
      const base = `https://dev.azure.com/${encodeURIComponent(opts.org)}/${encodeURIComponent(opts.project)}`;
      say("查詢未完成項目…");
      const res = opts.queryId
        ? await call(`${base}/_apis/wit/wiql/${encodeURIComponent(opts.queryId)}?api-version=${API}`, opts.pat)
        : await call(`${base}/_apis/wit/wiql?api-version=${API}`, opts.pat, { query: buildWiql(opts.project, opts.where || "") });

      // A tree / one-hop query answers with relations instead of a flat list.
      const raw = res.workItemRelations ? res.workItemRelations.filter((r) => r.target).map((r) => r.target.id) : (res.workItems || []).map((w) => w.id);
      const ids = [...new Set(raw)];
      if (!ids.length) throw adoError("查詢結果是空的 — 沒有符合條件的未完成項目。", "empty");

      const items = [];
      // Sequential on purpose: a big board must not open dozens of parallel requests.
      for (let i = 0; i < ids.length; i += BATCH) {
        const chunk = ids.slice(i, i + BATCH);
        say(`取得欄位 ${Math.min(i + BATCH, ids.length)} / ${ids.length}…`);
        const r = await call(`${base}/_apis/wit/workitemsbatch?api-version=${API}`, opts.pat, { ids: chunk, fields: FIELDS });
        items.push(...(r.value || []));
      }
      return { records: toRecords(items, opts.org, opts.project) };
    },
  };

  window.Ado = Ado;
})();
