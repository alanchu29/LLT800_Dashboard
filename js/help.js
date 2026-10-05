/* 使用說明: the "？ 使用說明" button in the top bar opens a centred dialog explaining every page. Also opens with "?". */
(function () {
  const { $, $$, esc } = U;

  // [id, nav label, html]. Kept short: what each page answers, then how to use it.
  const page = (hash, label) => `<button class="link h-go" type="button" data-go="${hash}">前往${esc(label)} ›</button>`;
  const k = (s) => `<span class="h-key">${s}</span>`;

  const SECTIONS = [
    [
      "intro",
      "系統簡介",
      () => `
      <p class="h-lead"><b>${esc(Store.data.settings.title || "LLT800 Dashboard")}</b> 是部門的工作總覽：一頁看完部門承接的專案、各 PFAM 的時程、誰在忙什麼，以及誰在出差。</p>
      <div class="h-pages">
        <a href="#/overview"><b>總覽</b><span>今天要注意什麼、接下來一個月的工作與人力</span></a>
        <a href="#/projects"><b>專案甘特</b><span>Project → PFAM → task 的時程與指派</span></a>
        <a href="#/load"><b>人力資源</b><span>每天有幾個人在忙、每個人手上的工作</span></a>
        <a href="#/people"><b>出差紀錄</b><span>誰在出差、年度出差天數</span></a>
        <a href="#/settings"><b>設定</b><span>員工名冊、Phase、匯入匯出、雲端同步</span></a>
      </div>
      <h4>資料的三個層級</h4>
      <ul>
        <li><b>Project</b>（專案，例如 Gen12 AMD）→ <b>PFAM</b>（專案底下的機種 / 組態）→ <b>task</b>（有起訖日、指派人、Phase 的工作）。</li>
        <li>Project 與 PFAM 的期間由底下 task 的最早開始日與最晚結束日自動算出，不需要另外填。</li>
        <li>每個 Project 都有一個內建的 <b>Others</b> PFAM，放不屬於任何 PFAM 的工作。</li>
      </ul>`,
    ],
    [
      "start",
      "快速上手",
      () => `
      <ol class="h-steps">
        <li><b>只是查看：</b>直接切換上方分頁即可，不需要任何設定。資料會自動從雲端載入（讀取中可按「先看本機資料」）。</li>
        <li><b>要新增或修改：</b>按右上角 ${k("✎ 編輯模式")}（設定了密碼的話需要輸入），橫幅底部會出現黃線。之後點 task、PFAM、員工或出差紀錄即可編輯。</li>
        <li><b>改錯了：</b>按 ${k("↶")} / ${k("↷")} 或 ${k("Ctrl+Z")} / ${k("Ctrl+Y")} 復原、重做。</li>
        <li><b>分享給部門：</b>雲端模式下，修改後右上角會出現 ${k("⇪ 同步到雲端")}，按一下才會寫入雲端，其他人重新整理就看得到。</li>
      </ol>
      <h4>右上角的按鈕</h4>
      <dl class="h-defs">
        <dt>${k("本機模式")} / ${k("雲端 · 已同步")}</dt><dd>資料存放位置；黃點表示有尚未同步的修改。點一下前往雲端同步設定。</dd>
        <dt>${k("◐")}</dt><dd>切換深色 / 淺色，會記住你的選擇。</dd>
        <dt>${k("？ 使用說明")}</dt><dd>開啟這份說明，也可以在任何頁面按 ${k("?")} 鍵。</dd>
      </dl>`,
    ],
    [
      "overview",
      "總覽",
      () => `
      <p>首頁，回答「今天有什麼要注意、接下來一個月忙不忙」。</p>
      <ul>
        <li><b>KPI 卡片：</b>進行中專案、本週進行中 task、逾期 task、今日忙碌人數、本月出差。點卡片會到對應的頁面。</li>
        <li><b>需要注意：</b>逾期、未指派、指派給已離開員工的 task。點 task 會跳到專案甘特並標示它。全部處理完後這區會自動隱藏。</li>
        <li><b>專案總覽：</b>前 7 天到後 30 天內未完成的 PFAM 與 task，依 Project 分組，點標題可展開 / 收合。</li>
        <li><b>同時進行的 PFAM：</b>專案總覽上方的柱狀圖，每個工作天有幾個 PFAM 同時在進行。超過部門人數的日子標紅；點一根柱子只看那天的 task。</li>
        <li><b>人力熱度：</b>未來一個月每人每天手上的 PFAM 數（或切到 Task 分頁看 task 數），顏色越深越忙；最上面一列是部門忙碌人數。</li>
        <li><b>近期出差：</b>正在出差與未來 60 天內的出差。</li>
      </ul>
      ${page("#/overview", "總覽")}`,
    ],
    [
      "projects",
      "專案甘特",
      () => `
      <p>看所有案子的時程與誰負責。上方卡片選「<b>全部專案</b>」（預設）或單一 Project。</p>
      <h4>看圖</h4>
      <ul>
        <li>點 Project / PFAM 的箭頭或名稱展開 / 收合；「開啟 ›」進入單一專案。</li>
        <li>task 條依 <b>Phase</b> 上色（灰色＝未指定 Phase），紅色直線是今天。重新匯入後日期有變動的 task 會顯示 <span class="late">▲ 延遲</span> / <span class="early">▼ 提前</span>（與基準日比較）。</li>
        <li><b>期間：</b>「前 2 週 + 後 3 月」（預設）、「未來 6 個月」、「今年」，或在「從 / 到」輸入任意日期；時間尺度可切換 日 / 週 / 月。</li>
        <li><b>篩選：</b>廠區、負責人、隱藏已完成；也可切換成<b>表格</b>檢視。</li>
        <li><b>PFAM 負載：</b>甘特上方的柱狀圖，每天同時進行的 PFAM 數，超過上限的日子整欄紅底。點柱子標記該日，甘特只顯示那天進行中的工作。</li>
        <li><b>人力分配：</b>甘特下方每人一條時間軸，條上直接寫 task 名稱，與上方甘特同步左右捲動。</li>
      </ul>
      <h4>編輯（需編輯模式）</h4>
      <ul>
        <li>右上「＋ 新增 Project」；進入單一專案後有「編輯 Project」「＋ PFAM」「＋ task」。</li>
        <li>滑過 PFAM 列會出現 ${k("✎")}（編輯 PFAM）與 ${k("＋")}（在這個 PFAM 新增 task）。</li>
        <li>點 task 條或表格中的 task 列即可修改日期、指派人（可多選）、Phase，或勾選<b>已完成</b>。</li>
        <li>Project 可設定「PFAM 負載警戒上限」與「外部系統連結」（例如 Gen12 AMD 的排程網站）。</li>
      </ul>
      ${page("#/projects", "專案甘特")}`,
    ],
    [
      "load",
      "人力資源",
      () => `
      <p>回答「部門人力夠不夠、每個人在做什麼」。</p>
      <ul>
        <li><b>每日忙碌人數：</b>每個工作日「忙碌人數 / 在職人數」的柱狀圖。滑過柱子看誰忙、誰有空；點一下標記該日。上方可選期間與要計入的專案。</li>
        <li><b>每人工作：</b>每個人目前的 task（剩幾天或已逾期）與下一個 task，點 task 跳到專案甘特。</li>
        <li><b>每人時間軸：</b>每個人所有 task 的甘特圖。</li>
      </ul>
      ${page("#/load", "人力資源")}`,
    ],
    [
      "trips",
      "出差紀錄",
      () => `
      <ul>
        <li><b>名冊：</b>每人是否出差中、進行中 task 數、年度出差天數、下次出差；點姓名看這個人的詳細資料與 task。</li>
        <li><b>年度出差天數：</b>可切換「依專案」或「依地點」統計；用 ‹ › 切換年度。</li>
        <li><b>出差行事曆：</b>整年的出差分布。</li>
        <li><b>新增出差</b>（需編輯模式）：按「＋ 出差紀錄」，填員工、地點、出發 / 返回日、目的與關聯專案。</li>
      </ul>
      <p class="muted">出差天數以日曆天計算（含週末，出發與返回日都算），跨年的出差會拆到兩個年度。出差不會計入人力負載。</p>
      ${page("#/people", "出差紀錄")}`,
    ],
    [
      "settings",
      "設定與資料",
      () => `
      <ul>
        <li><b>員工名冊：</b>開始使用前先輸入部門成員（一行一位或用逗號分隔）。員工離職時取消「在職」即可，歷史紀錄會保留。</li>
        <li><b>不計入人力的人員：</b>例如主管，不算進忙碌 / 在職人數與人力上限。</li>
        <li><b>Phase 清單、廠區 / 地點清單、標紅規則、編輯密碼</b>（密碼只用來防止誤改）。</li>
      </ul>
      <h4>匯入與備份（在「設定 → 資料」，需編輯模式）</h4>
      <dl class="h-defs">
        <dt>匯入 MONICA JSON</dt><dd>MONICA 匯出的 JSON：Series → Project、project → PFAM。PIC 會依姓名對應到員工名冊。</dd>
        <dt>匯入 Gen12 PFAM Excel</dt><dd>NPI Dashboard Excel，在瀏覽器內解析、不會上傳。預設勾選 LEAD 含 STE / TE 的 task，可逐項調整。</dd>
        <dt>重新匯入新版</dt><dd>只更新日期，<b>保留網頁上的指派、完成狀態與備註</b>；舊日期成為基準（▲▼）。新檔中消失的 task 預設保留。</dd>
        <dt>批次標記完成</dt><dd>把某天以前結束的未完成 task 一次設為已完成，整理舊資料用。</dd>
        <dt>匯出 / 還原 JSON 備份</dt><dd>整份資料的備份檔；換電腦或清除瀏覽器資料前建議先匯出。</dd>
      </dl>
      <p class="muted">所有匯入都會先顯示預覽，套用後也能按「復原」。</p>
      ${page("#/settings", "設定")}`,
    ],
    [
      "terms",
      "名詞與計算",
      () => `
      <dl class="h-defs">
        <dt>在職人數</dt><dd>在職員工扣掉「不計入人力的人員」。</dd>
        <dt>忙碌人數</dt><dd>當天手上有任何進行中 task 的人數；一個人有好幾件 task 也只算 1 人。只算工作日（週一～五）。</dd>
        <dt>未指派</dt><dd>當天有 task 沒指派人的 PFAM，每個 PFAM 算需要 1 人。</dd>
        <dt>標紅</dt><dd>預設「沒有人空著」：忙碌人數 + 未指派 PFAM ≥ 在職人數；也可在設定改成「忙碌人數 ≥ 在職人數的 N%」。</dd>
        <dt>同時進行的 PFAM</dt><dd>同一 PFAM 的多個 task 只算 1；Others 的每個 task 各算 1。</dd>
        <dt>task 狀態</dt><dd>只有「已完成 / 未完成」。過了結束日仍未完成＝<span class="late">逾期</span>；其餘依日期為進行中或未開始。已完成的 task 從今天起不再佔用人力。</dd>
        <dt>基準 ▲ ▼</dt><dd>重新匯入時舊的日期成為基準；▲ 表示比基準晚（延遲），▼ 表示比基準早。</dd>
      </dl>`,
    ],
    [
      "faq",
      "常見問題",
      () => `
      <dl class="h-faq">
        <dt>在專案甘特點 task 沒反應？</dt><dd>要先開啟右上角 ${k("✎ 編輯模式")} 才能修改；查看模式下只能瀏覽。</dd>
        <dt>我改的東西別人看不到？</dt><dd>雲端模式下修改會先存在你的瀏覽器，要按 ${k("⇪ 同步到雲端")} 才會寫入。若別人先同步過，系統會詢問要覆寫雲端還是保留本機。</dd>
        <dt>畫面一直顯示「正在讀取雲端資料」？</dt><dd>Google 雲端有時需要 10–30 秒。可按「先看本機資料」，顯示的是這台電腦上次的資料，可能不是最新。</dd>
        <dt>看到「示範資料」橫幅？</dt><dd>員工、指派與出差都是假的。到「設定 → 資料」可以清空後建立正式資料，或匯入 MONICA / Gen12 檔案。</dd>
        <dt>從別頁點 task 跳過來後，甘特期間變了？</dt><dd>為了讓那個 task 一定看得到，期間會自動延伸；按「清除定位」回到原本期間。</dd>
        <dt>資料公開嗎？</dt><dd>雲端資料是公開可讀的（包括出差紀錄），寫入才需要金鑰；請勿放入機密資訊。</dd>
      </dl>`,
    ],
  ];

  const Help = {
    open(sectionId) {
      const d = $("#dlgHelp");
      $("#helpNav").innerHTML = SECTIONS.map(([id, label]) => `<button type="button" data-sec="${id}">${esc(label)}</button>`).join("");
      $("#helpBody").innerHTML = SECTIONS.map(([id, label, html]) => `<section class="h-sec" id="help-${id}"><h3>${esc(label)}</h3>${html()}</section>`).join("");
      if (!d.open) d.showModal();
      this.spy();
      const target = sectionId && $("#help-" + sectionId);
      $("#helpBody").scrollTop = target ? target.offsetTop : 0;
      this.mark(sectionId || SECTIONS[0][0]);
    },

    /** Highlights the nav entry of the section at the top of the scrolling body. */
    mark(id) {
      const nav = $("#helpNav");
      $$("[data-sec]", nav).forEach((b) => b.classList.toggle("on", b.dataset.sec === id));
      // On a phone the nav is one horizontal row: keep the current entry in view.
      const on = $(".on", nav);
      if (on && nav.scrollWidth > nav.clientWidth) {
        const l = on.offsetLeft - nav.offsetLeft;
        if (l < nav.scrollLeft || l + on.offsetWidth > nav.scrollLeft + nav.clientWidth) nav.scrollLeft = l - 8;
      }
    },

    spy() {
      const body = $("#helpBody");
      body.onscroll = () => {
        const top = body.scrollTop + 24;
        let cur = SECTIONS[0][0];
        for (const s of $$(".h-sec", body)) if (s.offsetTop <= top) cur = s.id.slice(5);
        if (body.scrollTop + body.clientHeight >= body.scrollHeight - 4) cur = SECTIONS[SECTIONS.length - 1][0];
        this.mark(cur);
      };
    },

    bind() {
      const d = $("#dlgHelp");
      $("#btnHelp").onclick = () => this.open(this.forRoute());
      $$("#dlgHelp [data-close]").forEach((b) => (b.onclick = () => d.close()));
      d.addEventListener("click", (ev) => {
        if (ev.target === d) return d.close(); // backdrop
        const nav = ev.target.closest("[data-sec]");
        if (nav) {
          const s = $("#help-" + nav.dataset.sec);
          $("#helpBody").scrollTo({ top: s.offsetTop, behavior: "smooth" });
          return;
        }
        const go = ev.target.closest("[data-go], .h-pages a");
        if (go) {
          ev.preventDefault();
          d.close();
          App.go(go.dataset.go || go.getAttribute("href"));
        }
      });
      document.addEventListener("keydown", (ev) => {
        if (ev.key !== "?" || ev.ctrlKey || ev.metaKey || ev.altKey) return;
        if (ev.target.closest("input, textarea, select, [contenteditable]") || $("dialog[open]")) return;
        ev.preventDefault();
        this.open(this.forRoute());
      });
    },

    /** Opens on the section of the page the user is on. */
    forRoute() {
      const map = { overview: "intro", projects: "projects", load: "load", people: "trips", settings: "settings" };
      return map[App.route.name] || "intro";
    },
  };

  window.Help = Help;
})();
