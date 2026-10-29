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
        <a href="#/ado"><b>ADO Task</b><span>Azure DevOps 未完成項目、成員的 ADO 任務</span></a>
        <a href="#/load"><b>人力資源</b><span>每天有幾個人在忙、每個人手上的工作</span></a>
        <a href="#/people"><b>出差紀錄</b><span>誰在出差、年度出差天數</span></a>
        <a href="#/settings"><b>設定</b><span>員工名冊、Phase、假日、匯入匯出、雲端同步</span></a>
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
        <li><b>只是查看：</b>直接切換上方分頁即可，不需要任何設定。畫面會先顯示這台電腦上次的資料，雲端在背景更新（右上角顯示「雲端 · 更新中…」）。</li>
        <li><b>要新增或修改：</b>按右上角 ${k("✎ 編輯模式")}（設定了密碼的話需要輸入），橫幅底部會出現黃線。之後點 task、PFAM、員工或出差紀錄即可編輯。<br>進入編輯模式時會自動確認你手上是雲端最新版（分頁開一整天後尤其重要），不是的話會先載入最新版再讓你開始改。</li>
        <li><b>改錯了：</b>按 ${k("↶")} / ${k("↷")} 或 ${k("Ctrl+Z")} / ${k("Ctrl+Y")} 復原、重做。</li>
        <li><b>分享給部門：</b>雲端模式下，修改後右上角會出現 ${k("⇪ 同步到雲端")}，按一下才會寫入雲端，其他人重新整理就看得到。</li>
      </ol>
      <h4>右上角的按鈕</h4>
      <dl class="h-defs">
        <dt>${k("本機模式")} / ${k("雲端 · 已同步")}</dt><dd>資料存放位置；黃點表示有尚未同步的修改，藍點閃動表示正在背景讀取雲端。點一下前往雲端同步設定。</dd>
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
        <li><b>KPI 卡片：</b>進行中專案、本週進行中 task、逾期 task、今日忙碌人數、30 天內出差（今天起 30 天內出差中或要出發的人數）。點卡片會到對應的頁面。</li>
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
      "ado",
      "ADO Task",
      () => `
      <p>把 Azure DevOps 上<b>尚未完成</b>的工作項目拉進來看，並對應到部門名冊。資料是 ADO 的即時快照，<b>只存在你這台電腦</b>，不會寫進部門資料或雲端，也不能從這裡改 ADO。</p>
      <h4>先擷取資料</h4>
      <ul>
        <li><b>自動（建議）：</b>把 PAT 存成單獨一行放在 <code>C:\\Users\\&lt;登入者&gt;\\.ado_pat</code>，跑一次 <code>powershell -ExecutionPolicy Bypass -File tools\\ado_pat.ps1</code>（可加 <code>-Open</code> 直接開網頁）。之後每次進這一頁，若本機還沒有「今天」的快照就會自己去擷取，不用再貼 PAT。<br>腳本只是把 PAT 寫成 <code>data/ado_pat.js</code> 給網頁讀（瀏覽器不能自己讀本機檔案）；這個檔案含 PAT，已列入 .gitignore，不用了就跑 <code>-Clear</code> 刪掉。</li>
        <li><b>手動：</b>沒有那個檔案時，進這一頁會提示「找不到 PAT」。按 ${k("⟳ 從 ADO 擷取")} 貼上，或在設定對話框按「從 .ado_pat 檔載入」直接選檔案（只記在這個分頁）。PAT 在 ADO 的 <b>User settings → Personal access tokens</b> 建立，scope 只要勾 <b>Work Items (Read)</b>。</li>
        <li>自己貼的 PAT 預設只記在這個分頁，勾「記住」才會存在這台電腦；不論哪一種都只會送到 dev.azure.com。在「ADO 設定」可以清除、改組織／專案，或填 WIQL 條件與已存查詢 GUID。</li>
        <li>沒有 PAT 時可用 ${k("載入 CSV…")} 丟 ADO Queries 匯出的檔案，欄位採別名比對，順序不同也讀得到。</li>
      </ul>
      <h4>看板</h4>
      <ul>
        <li>上方 4 張卡片：未完成數、名冊成員的項目、未指派、停滯超過 30 天；點一下就是篩選。</li>
        <li><b>篩選：</b>搜尋（多個字詞是 AND）、停滯區間、更新日期；下方每一列是一種條件：負責人範圍（全部 / 名冊成員 / 名冊外 / 未指派）與快捷、負責人 / 類型 / 狀態 / 專案標籤。<b>含已完成</b>預設不勾：勾了才會把已完成（Done / Closed…）的項目一起列出來，可再搭配搜尋或狀態找特定的已完成項目；擷取時只帶最近 180 天內有更新的已完成項目（「ADO 設定」可改天數，0 = 不抓）。已完成項目不算停滯，也不算進「我的成員」與「人力資源」。chip 上的數字是「套用其他條件後」的筆數，再點一次取消；值很多時只列前 12 個，按「更多」看全部。</li>
        <li><b>分布概況</b>的長條點一下即套用該條件；清單可依任一欄排序，也可在清單標題列選擇依負責人 / 類型 / 狀態 / 標籤 / 停滯區間分組。清單只在名冊比對不到的負責人旁標「名冊外」。</li>
        <li>可把篩選結果<b>匯出 CSV</b>或<b>複製成 Markdown 表格</b>貼到 Teams、郵件或 Wiki。</li>
      </ul>
      <h4>我的成員</h4>
      <ul>
        <li>每位名冊成員手上有幾個 ADO 項目、其中多少停滯超過 30 天、狀態分布與最後更新日。點一列展開明細，點 ID 直接開 ADO。</li>
        <li><b>名冊外的負責人</b>＝ADO 上有項目、但名冊比對不到的人（預設收合，點標題展開）。人多時按「<b>批次對應…</b>」：一個對話框列出所有人，每一列都先填好最可能的員工（沒把握的留「略過」），確認一次就全部寫好；也可以單獨按某一列的「對應到員工」。同一位員工不會被同時預填給兩個 ADO 名稱，這種要自己挑。</li>
        <li><b>固定目前比對</b>（成員卡片右上，有「依名字」的比對時才出現）：把用名字猜到的對應一次寫進各人的「ADO 帳號」欄位，之後就不再依賴名字。猜錯了就改那一欄（成員明細的「設定 ADO 帳號」或 設定 › 員工名冊），全部動作都可以 ↶ 復原。<br>以上都會寫進該員工的 <b>ADO 帳號</b>欄位（屬於部門資料，需要編輯模式，會同步給大家）。</li>
        <li>比對順序：員工的「ADO 帳號」（可填多個顯示名稱或信箱，用逗號分隔）→ 姓名。姓名順序顛倒（Chu, Dixon）、中間縮寫（Timothy PH Lee）、以及 ADO 顯示名稱後面的廠區與公司（Dixon Chu WYHQ Wiwynn）都認得。最後還會試「名字」——名冊只寫 <code>Dixon</code> 也能對上 <code>Dixon Chu WYHQ Wiwynn</code>，但只有在名冊與 ADO 兩邊那個名字都唯一時才算（兩個 Ryan 就不猜，留著手動對應），這種會標上「依名字」。</li>
        <li><b>對應會同步給全部門</b>（存在員工資料裡）。雲端模式請確認 Apps Script 已更新到 2026-10-20 之後的版本並重新部署——舊版後端同步時會把這個欄位丟掉，對應就會像「設定自己跑掉」一樣消失；網頁偵測到舊版會先保住這台電腦上的對應並提示。</li>
      </ul>
      <h4>名詞</h4>
      <dl class="h-defs">
        <dt>未完成</dt><dd>State 不在結案清單（Done / Closed / Removed / Resolved / Completed / Cancelled / Abandoned / Rejected…）。在結案清單裡的就是<b>已完成</b>。</dd>
        <dt>停滯天數</dt><dd>擷取當天 − Changed Date（最後更新日）。31–90 天黃、91–180 天橘、超過 180 天紅；「停滯」指超過 30 天沒更新（或沒有更新日期）。</dd>
        <dt>專案標籤</dt><dd>自動取自標題開頭的中括號（<code>[Gen8/Gen8.3]</code> → Gen8、Gen8.3）、標題中的 GenX 與站點代碼（WYMX、WCZ…），以及 ADO 的 Tags 欄位。</dd>
      </dl>
      ${page("#/ado", "ADO Task")}`,
    ],
    [
      "load",
      "人力資源",
      () => `
      <p>回答「部門人力夠不夠、每個人在做什麼」。</p>
      <ul>
        <li>上方可選期間與要計入的專案；卡片是期間內超出人力的工作天、平均忙碌人數與最忙的一天。</li>
        <li><b>每人工作：</b>每個人目前的 task（剩幾天或已逾期）與下一個 task，點 task 跳到專案甘特。擷取過 ADO 的話，最後一欄是他在 ADO 上還開著的項目數（與停滯數）。點人名或 ADO 數字，會在下方展開他的 ADO 未完成項目與進行中的部門 task。</li>
        <li><b>每人時間軸：</b>每個人所有 task 的甘特圖。</li>
      </ul>
      ${page("#/load", "人力資源")}`,
    ],
    [
      "trips",
      "出差紀錄",
      () => `
      <ul>
        <li><b>出差中與即將出差：</b>所有還沒結束的出差（不受年度切換影響），列出人、地點、日期、天數、目的與專案；出差中的標示第幾天，未出發的標示幾天後出發。點一筆即可編輯（需編輯模式，會先要求進入）。</li>
        <li><b>名冊：</b>每人是否出差中、進行中 task 數、年度出差天數、下次出差；點姓名看這個人的詳細資料與 task。</li>
        <li><b>年度出差天數：</b>可切換「依專案」或「依地點」統計；用 ‹ › 切換年度。</li>
        <li><b>出差行事曆：</b>整年的出差分布。</li>
        <li><b>新增出差</b>（需編輯模式）：按「＋ 出差紀錄」，填員工、地點、出發 / 返回日、目的與關聯專案。</li>
      </ul>
      <p class="muted">出差天數以日曆天計算（含週末，出發與返回日都算），跨年的出差會拆到兩個年度。出差不會計入人力負載。</p>
      ${page("#/people", "出差紀錄")}`,
    ],
    [
      "links",
      "常用連結",
      () => `
      <p>部門常用的網站與工具，依分類排列，點卡片就在新分頁開啟；上方可搜尋名稱、網址或說明。</p>
      <ul>
        <li><b>新增 / 修改</b>（需編輯模式）：按「＋ 新增連結」或分類標題旁的「＋ 加到這一類」，填名稱、網址（http / https）、分類與一句說明；每列右側的 ✎ 可修改或刪除。連結屬於部門資料，會同步給大家。</li>
      </ul>
      ${page("#/links", "常用連結")}`,
    ],
    [
      "settings",
      "設定與資料",
      () => `
      <ul>
        <li><b>員工名冊：</b>開始使用前先輸入部門成員（一行一位或用逗號分隔）。員工離職時取消「在職」即可，歷史紀錄會保留。</li>
        <li><b>ADO 帳號</b>（名冊裡的一欄）：只有在 ADO 顯示名稱與這裡的姓名不同時才要填（給「ADO Task › 我的成員」比對用），多個用逗號分隔。</li>
        <li><b>不計入人力的人員：</b>例如主管，不算進忙碌 / 在職人數與人力上限。</li>
        <li><b>假日：</b>週末以外的放假日（國定假日、公司休假），不算工作日，甘特圖以灰底標示。可逐筆新增，或一次貼上多行，例如 <code>2026-10-10 國慶日</code>、<code>2026/2/14~2/22 春節</code>（連續假期的週末會自動略過）。</li>
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
        <dt>忙碌人數</dt><dd>當天手上有任何進行中 task 的人數；一個人有好幾件 task 也只算 1 人。只算工作日（週一～五，扣除「設定 → 假日」）。</dd>
        <dt>未指派</dt><dd>當天有 task 沒指派人的 PFAM，每個 PFAM 算需要 1 人；Others 每 2 個沒指派的 task 算 1 個（規則同「同時進行的 PFAM」）。</dd>
        <dt>標紅</dt><dd>預設「沒有人空著」：忙碌人數 + 未指派 PFAM ≥ 在職人數；也可在設定改成「忙碌人數 ≥ 在職人數的 N%」。</dd>
        <dt>同時進行的 PFAM</dt><dd>同一 PFAM 的多個 task 只算 1；Others 的每 2 個 task 算 1（單剩 1 個也算 1）。</dd>
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
        <dt>我的修改被別人蓋掉了？</dt><dd>每次寫入雲端都會留一份快照，在雲端硬碟的「LLT800_Dashboard 快照」資料夾（保留最近 30 版）。下載那個 JSON 檔，用「設定 → 資料 → 還原 JSON 備份」就能還原。</dd>
        <dt>畫面一直顯示「正在讀取雲端資料」？</dt><dd>只有第一次造訪（這台電腦還沒有資料）才會等；Google 雲端有時需要 10–30 秒，可按「先看本機資料」。之後開啟都是先顯示舊資料、背景更新，不會擋畫面。</dd>
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
      const map = { overview: "intro", projects: "projects", ado: "ado", load: "load", people: "trips", settings: "settings" };
      return map[App.route.name] || "intro";
    },
  };

  window.Help = Help;
})();
