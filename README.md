# OpenCodex 0.4.7

獨立安裝於 `/Applications/OpenCodex.app`。使用這台 Mac 的 ChatGPT 26.1007.71326（20398）原生程式封裝與內附 Codex app-server，保留原生介面，接上 OpenCodex 直接 SSH。這是本機修改版，不是 OpenAI 官方發行版本；本次修改依據安裝封裝，沒有取得原廠完整開發儲存庫。

## 0.4.7 的更新

- MCP 事件訂閱的初始化等待改為 100 秒，涵蓋原生引擎的 90 秒啟動期限。
- 原生終止事件會釋放訂閱，允許相同介面 ID 重新訂閱；舊主機及舊訂閱事件不會傳給新訂閱。
- 停止、視窗關閉與啟動失敗共用一次遠端取消；取消失敗仍可重試。
- 背景標題對話取消訂閱時，同步取消其排隊、準備與執行中的工作；不影響一般對話。避免已卸載的標題工作持續占用工作區，卡住 MCP 按鈕或輸入框。
- 停止流程不再重複中止已由代理管理器處理的主回合；遠端回合已消失或取消失敗時，仍會排程本機清理。
- 新增隔離引擎 Hooks 協定測試，驗證原生信任、真實回合 ID、同步阻擋與附加內容。這不是 SSH Hooks 已完成的證據；回合中止後的 MCP 請求仍需要額外取消。

2026-10-18：同一份固定簽章建置通過 33 組回歸與 12 份整合驗收，包含真實 GPT 工具、Git Review、子代理與原生詳細畫面、Git／Worktree、分類、Shell、訊息佇列、離線重開，以及 MCP 回合後按鈕與背景標題後輸入框恢復。ASAR SHA256 為 `e5b0b897dbe3b999577d27589d8841e3936244c454ce7ff7e9f40725c7aacd72`。驗證範圍以 `evidence/release-check-0.4.7.json`、`evidence/native-gpt-e2e-0.4.7.json` 及交付時產生的 `OpenCodex-0.4.7-verification.json` 為準。完整原生功能仍有下方列出的缺口；既有 0.4.6 成果如下保留。

## 0.4.6 的更新

2026-10-18：同一份固定簽章建置通過 32 組回歸與 12 份整合驗收。ASAR SHA256 為 `0d2cbcc4bfadf148185c32a9bd5c6723f99b63722aca8f8f6d8c4c7a3814e9a1`。當版證據以 `release-check-0.4.6.json` 與 `native-gpt-e2e-0.4.6.json` 為準；尚存的原生功能缺口仍列於下方。

- **Git Review 工具歸屬**：審查對話以遠端引擎實際工作目錄驗證父子關係，另行驗證繼承的 Mac 執行環境，修正 Windows 遠端主機與 Mac 專案路徑不同時拒絕工具的問題。取消仍依審查對話與回合隔離。
- **真實 Review 驗收**：GPT 透過 Mac 工具讀取專用 Git 測試專案，指出金額運算中錯用除法的具體程式碼行；核對工具紀錄及原檔未變更。
- **訊息佇列驗收**：原生介面編輯排隊訊息後自動接續下一回合，GPT 正確引用前一個 Shell 隨機驗收碼，並呼叫 Mac 工具讀取驗收檔案；完整歷史保存通過。
- **同版整合**：重新驗證連線就緒、真實子代理與詳細畫面、Git／Worktree、分類、Shell、離線重開，以及 MCP 原生 WebView 的回合後按鈕回呼。測試外掛已移除，原始工具設定逐位元核對還原。

## 保留的 0.4.5 更新與歷史驗證

2026-10-17：當次固定簽章建置通過 30 組回歸與 10 份整合驗收，包含真實 GPT／子代理工具呼叫、原生子代理詳細畫面、跨專案 Git／Worktree、分類、Shell 歷史、離線重開及 MCP 回合後互動。當次 ASAR SHA256 為 `5548b26b8cf98f8dc697b737197a50bde0eff2cc40ee225cbadd12a04496919d`；以下歷史版本的驗證範圍仍各自保留，不代表完整原生功能已完成。

- **工具就緒檢查**：SSH 連線後，必須確認 Mac 執行環境已註冊、工具通道正常且工作區切換成功，才開放送出訊息；失效或錯誤的環境不會顯示為就緒。
- **初始化診斷**：執行器啟動、環境註冊、工具通道與專案初始化分別顯示失敗階段及分類原因，避免遺失錯誤原因，也避免把原始程序輸出或憑證帶入介面。恢復後清除過期提示，不自動重送工作。
- **驗證範圍**：連線故障、註冊錯配、工具通道中斷與恢復由受控測試驗證；真實 SSH 驗收另核對工具就緒及原生輸入框。這不代表偶發初始化失敗的根因已修復。當版證據以 `release-check-0.4.5.json`、`native-gpt-e2e-0.4.5.json` 為準。

## 保留的 0.4.4 更新與歷史驗證

- **SSH 原生子代理**：在已驗證的 Codex 0.160.0 引擎上啟用；子代理沿用主對話的 Mac 執行環境與權限，依真實 thread／turn／parent 身分綁定工具。未驗證的引擎或遠端角色覆寫設定保持停用。
- **工具與停止隔離**：各代理有獨立的原生工具執行個體。停止單一分支會停止其後代，不中止仍執行的兄弟代理；主對話停止或結束時清理子代理及待處理授權。取消後到達的工具請求會拒絕。
- **原生子代理詳細畫面**：依已驗證的父子來源鏈載入歷史，避免介面早於工具登記讀取而暫時空白；歷史查詢本身不授予工具執行權。主對話與子代理的歷史還原可有界等待，執行中的模型工作仍保持互斥。
- **歷史權限相容**：補齊原生介面需要的 Mac 工作區根目錄資料，也正規化舊快取，修正還原對話時的介面錯誤。
- **摘要恢復保留完整歷史**：原生介面只索取對話摘要時，不再用省略的回合覆寫已保存的完整內容，並在連線時補讀完整歷史；主對話的子代理活動及各子代理的工具結果可供離線重開讀取。

0.4.4 歷史回歸及整合驗收以 `evidence/release-check-0.4.4.json`、`evidence/native-gpt-e2e-0.4.4.json` 為準。受控模擬服務測試取消範圍；真實 SSH GPT 測試主代理與兩個子代理的 Node 狀態隔離、檔案結果、完整歷史及原生詳細畫面。這些測試不等於完整原生功能全部完成；Hooks、Guardian、自訂權限與官方雲端驗收仍有缺口。

## 保留的 0.4.3 更新與歷史驗證

本輪以 GPT Codex 的原生體驗為主；依使用者要求暫緩 Claude，保留既有兩個入口與資料。

- **原生專案與分類**：專案根目錄、對話分類、名稱、外觀與排序保存於 Mac；線上與離線使用同一份對應，避免把 Mac 專案路徑交給遠端檔案系統。
- **離線完整歷史**：GPT 回覆與本機 Shell 卡片合併保存；歷史與項目分頁支援雙向瀏覽。只有完整讀取成功的快取才作為離線完整歷史；資料不完整時明確回報。
- **Shell 歷史與分支**：完整分支保留真實本機 Shell 卡片；不能以本機合成的 Shell 回合冒充遠端模型分支錨點。
- **MCP Apps 互動**：外掛資源依來源隔離，保留工具與結果的 UI metadata；小工具操作使用對話所屬的 Mac 工作目錄與授權流程，停止或斷線會取消待處理操作。自有測試外掛已透過真實 GPT 呼叫顯示原生 WebView，回合結束後按鈕仍成功回呼工具並更新計數。
- **首次訊息與背景工作**：背景標題產生與使用者送出訊息共用有界等待流程，優先處理使用者訊息，避免首次送出被背景工作占用而拒絕；仍保留取消、逾時及主對話互斥。
- **權限與通知**：原生權限快照顯示 Mac 的選擇；串流訂閱依視窗與主機隔離，避免切換主機後收到舊通知。
- **封裝完整性**：先完成原生檔案簽章，再更新 ASAR 的 unpacked 檔案大小、分塊雜湊及 Electron header integrity，最後封簽 Framework 與 App。完整檔案驗證與嚴格簽章驗證分別執行，避免只有 codesign 通過、ASAR 內部校驗卻已過期。

2026-10-17：同一份固定簽章建置通過 24 組回歸及 7 份整合驗收（本機功能、原生介面／SSH、Git／Worktree、專案分類、混合 Shell 歷史、離線重開、MCP App GUI 與回合後互動）。ASAR 的 21,103 個 packed 與 16 個 unpacked 檔案通過完整性驗證，REA 對當前封裝未發現完整性矛盾。另已修正原生 Shell 完成事件的未載入標記，避免完整卡片保存後仍被離線分頁拒絕；舊紀錄也能正確讀取。

各功能的測試範圍以本次 `evidence/release-check-0.4.3.json` 與 `evidence/native-gpt-e2e-0.4.3.json` 為準。單元測試、MCP 測試程序與真實桌面驗收分開記錄；未通過的項目不作交付證據。

## 保留的 0.4.2 功能

- **GPT Codex 與 Claude Code 並存**：側邊欄固定顯示兩個入口。點選後切換原生工作區並重啟，分別保留對話、模型、主機與 Mac 工作目錄；Codex 可保留官方、自訂 API 或 SSH 模式。
- **保留既有 Codex 資料**：Claude 使用獨立資料目錄，不取代 Codex 對話、模型設定或登入。兩者共用已安裝的 Skills／外掛，工具執行個體依連線隔離。
- **Claude SSH 整合**：接上原生對話、串流、工具、停止、排隊與權限。登入狀態以遠端實際檢查為準；未登入會明確顯示並禁止送出。
- **雙代理連線與討論工具**：可同時連接 Codex 和 Claude。討論工具支援分輪文字討論、取消及獨立程序；此版主機的 Claude 尚未登入，完整雙模型生成仍待驗收。
- **目前工作不可被切換中斷**：有執行中的對話、工具或討論時，切換入口停用。

## 保留的 0.4.1 功能

- **最高權限模式**：側邊欄「SSH 連線」可開啟。所有 SSH 對話使用完整的 Mac 檔案、指令與工具權限，跨專案及重開後保留；執行工作時禁止切換，關閉後恢復對話原本的權限設定。macOS 系統權限與外掛自己的授權仍適用。
- **永遠允許此工具**：一般權限模式下，可記住指定主機指紋、Mac 專案及工具的授權；從連線面板撤銷。停止、斷線或失效的請求會關閉授權視窗，不能誤存過期授權。
- **原生專案與 Git**：Mac 工作目錄隨對話切換及恢復，並接上原生 Git 與 Worktree 操作。
- **固定簽章與啟動修正**：更新沿用同一個本機憑證；修復側邊欄重複更新導致畫面卡在載入中的問題。
- **原生工具啟動**：等待外掛完成初始化後才發布工具清單，避免切換專案後漏載 Node 或 Computer Use。遠端清單查詢期限配合工具啟動期限，並區分本機及遠端的逾時來源。

## 已整合的功能

- **直接使用原生工具**：將 Mac 內附 Codex 提供的原生 MCP 工具接到遠端 Codex。已實際驗證原生 Node、Computer Use 與瀏覽器操作，保留工具審批、取消及錯誤回傳。
- **Skills 與外掛**：本機設定、Skills 掃描、外掛設定與目錄查詢由 Mac 內附 Codex 處理；已啟用的工具與 Skills 接入 SSH 回合。工具是否可用以實際載入結果為準，沒有把安裝清單當作可用清單。
- **原生 Shell**：對話內明確執行的 Shell 在 Mac 執行，輸出顯示為原生指令卡片、保存於本機，並將真實輸出送入遠端對話上下文。重新開啟後仍可讀取卡片。
- **排隊訊息**：支援新增、編輯、排序、刪除及持久保存。由 Mac 排程器經過執行器檢查再開始回合；停止會暫停佇列。送出結果不明時保留待確認狀態，不自動重送可能已執行的工作。
- **獨立審查**：SSH 的獨立 review 建立獨立對話，接上 Mac 工具；行內審查仍保留。
- **對話相容性**：搜尋、分支、附件、停止、續聊及主機隔離路由已補齊。新空對話在遠端尚不支援歷史查詢時，只對已確認沒有回合的對話使用 metadata 查詢。
- **帳號與額度**：左下角帳號選單沿用原生位置，讀取所選 SSH 主機的帳號與額度。每 30 秒及回合結束時更新；載入、失效與斷線各有明確狀態。
- **先開啟、再連線**：原生介面與本機功能先啟動；SSH 失敗不關閉 App，可從側邊欄修正設定或重試。

## 操作與執行位置

1. 開啟 OpenCodex，無須先連線。
2. 點側邊欄「SSH 連線」，選取已授權主機與 Mac 工作目錄，再按「連線」。新主機或金鑰變更時需確認指紋。
3. 連線及 Mac Executor 就緒後傳送工作。模型與 Agent loop 在遠端，檔案、Shell、原生工具、桌面與瀏覽器在這台 Mac 執行。
4. 左下角個人選單可查看額度及原生設定。剩餘百分比與重置時間來自遠端 Codex，並非剩餘 token 數。
5. 三種模式在「SSH 連線」的「連線模式」切換，套用後會重啟；也可用 macOS 選單列「OpenCodex → 模式與連線設定」。

| 模式 | Agent loop／模型入口 | 工具與設定 |
| --- | --- | --- |
| SSH · GPT Codex | 遠端主機上的 Codex app-server | Mac Executor 與本機原生 Codex 工具 |
| SSH · Claude Code | 遠端主機上的 Claude Code | Mac Executor 與本機原生 Codex 工具 |
| 官方登入 | 本機內附 Codex，使用 OpenCodex 獨立登入 | 本機 |
| 自訂 API | 本機 Codex，連接自訂 Responses API | 本機 |

SSH 由 OpenCodex 自行建立，不啟動 AgentBridge App 或其主程式，不使用 relay。底層重用 AgentBridge MIT 授權的傳輸、Runtime 與工具模組。朋友的 OAuth token 不複製到 Mac，遠端登入也不會自動登入本機官方雲端功能。

主機設定支援密碼、私鑰、SSH Agent、平台與本機資料夾。工作執行中禁止切換主機或模式；斷線不自動重送指令。保存的密碼綁定主機、連接埠、使用者及認證方法，修改目標不挪用舊密碼。

自訂 API 需支援 Responses 協定及 HTTPS；localhost 測試可使用 HTTP。API 金鑰於本機加密保存。僅支援 Chat Completions 的供應商不能直接視為相容。

## 實際驗證範圍

0.4.7 的交付報告為 `~/Downloads/OpenCodex-0.4.7-verification.json`。打包必須通過當次 `release-check-0.4.7.json` 及 `native-gpt-e2e-0.4.7.json`，且證據的 App ASAR 與來源雜湊須相同。GPT、Git／Worktree、分類、混合歷史與離線重開有各自的端到端報告；原始截圖及含本機路徑的測試資料僅保留本機。

0.4.2 的兩引擎切換為歷史驗證，仍保留於 `release-0.4.2.json`、`release-check-0.4.2.json` 及 `native-engines-e2e.json`，不視為本輪重新測試 Claude。

以下為 0.4.1 及更早版本的歷史驗證範圍，保留原日期與版本，不代表所有流程已在 0.4.2 重跑。

本版重新驗證權限、工作區、固定簽章、離線啟動、SSH 及原生工具；下列電腦、瀏覽器、排隊、review 與模式切換的完整流程保留明確標為 0.4.0 的歷史證據，不代表已在 0.4.1 全部重跑。

| 項目 | 已完成的測試 |
| --- | --- |
| 最高權限（0.4.1） | 真實原生 Node 讀檔與專案外寫檔無審批；跨專案、重啟保留，關閉後恢復專案權限 |
| 永久工具授權（0.4.1） | 原生視窗保存授權、第二次免詢問、重啟後沿用；撤銷後重新詢問，Stop 關閉視窗且不執行工具 |
| 原生工具初始化（0.4.1） | Node 與 Computer Use 完成啟動後才發布；取消後可恢復使用 |
| 原生工作區（0.4.1） | Git 初始化、差異、分支與 Worktree；兩個 SSH 專案及續聊恢復正確 Shell／Node 目錄，對話清單依專案篩選 |
| 固定簽章（0.4.1） | 兩個內容不同的 App 通過嚴格簽章驗證，指定身分相同 |
| 真實 SSH 與原生工具 | 遠端 Codex 呼叫 Mac 讀檔及原生 Node，取得正確驗收結果 |
| 原生 Computer Use | 遠端 Codex 使用原生工具操作計算機得到 42；另由 Mac 介面狀態核對 |
| 原生瀏覽器 | 遠端 Codex 操作本機測試表單、輸入並提交 42；截圖、介面狀態及頁面 DOM 核對一致 |
| Shell 與排隊 | Mac 實際執行指令，執行中編輯佇列；下一模型回合正確引用 Shell 隨機驗收碼並讀取 Mac 檔案 |
| 停止與續聊 | 真實回合中斷後，續聊仍能呼叫 Mac 工具 |
| 獨立審查 | 建立獨立 review 對話，實際呼叫 Mac 檔案工具 |
| Skills、本機設定、檔案與程序 | 本版掃描 475 個 Skills，另回報 2 個解析錯誤；本機讀檔、指令、程序輸出與取消／恢復測試通過 |
| 路由與隔離 | 15 組路由測試；Shell 6 組、佇列 7 組測試涵蓋持久化、主機隔離、停止與送出狀態不明 |
| 原生設定頁 | 驗證頁面可呈現；不代表頁面內每個服務或工作流程皆已測試 |
| 模式切換 | 官方模式初始化使用獨立帳號；自訂 API 使用本機模擬 Responses 服務驗證串流；切回 SSH 後再測續聊 |

## 尚存限制

這版完成多項先前缺少的原生工具整合，但不能宣稱與官方 App 的所有功能完全等同。

- 先前 0.4.6 以獨立官方資料目錄執行 `login status`，實際回報未登入；0.4.7 的測試以 SSH 為主，沒有重新驗證官方登入。官方 OAuth／雲端流程仍需使用者完成登入及具備相應服務資格；自訂 API 的既有驗證使用本機模擬服務，沒有測試付費供應商。
- 官方雲端功能、部分外掛目錄與服務，需要 OpenCodex 自己的登入、帳號資格及服務授權。SSH 遠端帳號不替代這些認證。
- Claude SSH 與雙代理連線已整合；目前驗收主機 Claude 尚未登入，因此 Claude 真實生成及雙模型討論結果尚未驗證。Claude 的原生分支、獨立 review、Shell 對話卡片仍未支援，會回報明確錯誤。
- 兩種 Agent 目前切換需重啟 App；各自歷史及模型保留，同時可有兩個 SSH Runtime 連線，尚非兩個並排原生聊天視窗。
- SSH 自訂權限設定檔及 Guardian 自動審批尚不支援，會明確拒絕。內建唯讀、工作區與完整存取會同步至 Mac 工具；受限模式使用使用者審批，工作區寫入比原生本機模式保守。
- SSH Hooks 尚未接入遠端 engine 的真實生命週期。原生子代理已接入經驗證的 0.160.0 引擎；其他版本或具有角色覆寫設定的主機仍停用子代理。0.4.7 的隔離引擎測試已確認原生 MCP Hook 能取得真實回合 ID、遵守信任設定並同步阻擋模型請求；SSH 產品仍缺少 Mac Hook 執行、設定同步及取消整合。舊核對見 `evidence/native-hooks-audit-20261017.md`，新探測以 `evidence/native-hooks-relay-probe.json` 為準。
- MCP Apps 的自有計數器已通過真實模型呼叫、原生 GUI 與回合後按鈕回呼；所有第三方 App、完整事件串流、Appshots 及每一種 Git／Worktrees 操作仍未逐項驗收。保留原生頁面不代表所有流程都已通過。
- 原生 MCP resources API 已接通；目前內附 app-server 沒有提供 MCP prompts API。
- 本輪本機掃描發現 533 個 Skills、4 個解析錯誤。錯誤來自已安裝第三方套件中的巢狀 SKILL.md 缺少 YAML frontmatter；沒有修改這些使用者檔案。數量不代表每個 Skill 的外部依賴都可用。
- 驗收期間曾有一次 SSH 已連線但 Mac executor 未啟動；同一建置重新啟動後通過。間歇性初始化失敗的原因尚未確認，不能視為已修復。
- macOS 輔助使用、螢幕錄製及工具審批仍依系統與 App 的實際授權生效。
- 採固定的本機自簽憑證，沒有 Developer ID 公證。已驗證不同建置維持相同的 designated requirement；尚未實測 macOS「App 管理」跨更新保留，首次更換簽章仍可能需重新授權。

## 隔離與交付

- App ID：`io.opencodex.desktop`；URL scheme：`opencodex`。
- 資料位置：`~/Library/Application Support/OpenCodex`。
- 官方與自訂模式各使用 `codex-official`、`codex-custom`；Claude 使用 `codex-claude`、`native-claude-ui`。不搬用原 App 登入資料。
- 不修改原 ChatGPT、AgentBridge 安裝；只在 OpenCodex 副本停用原廠更新與搬移機制。
- 一般啟動不開放測試 CDP 埠，只有明確測試參數才建立測試端點。
- 更新保留 OpenCodex 主機設定。0.4.7 使用版本化檔名，不覆蓋舊 DMG；先驗證新 DMG，再安裝並保留上一個 App 供復原。只清除此輪的打包暫存。
- 打包採單一程序鎖；清理只處理當次建立的精確目錄，遇到非預期檔案或掛載點就保留。使用者資料、來源、最新 DMG 與開發副本不在自動清理範圍。
- 2026-10-15 已清理本任務 8 個舊產物目錄；當下 SSD 可用空間增加 6,585,122,816 bytes（約 6.6 GB）。完整清單與前後校驗見本機 `evidence/cleanup-20261015-212129.json`；APFS 共用區塊使此數字與目錄大小加總不同。
- DMG 包含獨立 App、Applications 捷徑、說明及修改程式碼 ZIP。

`OpenCodex-0.4.7-source.zip` 包含新增的整合程式、建置／測試腳本、驗證摘要與 AgentBridge 授權聲明，不含登入憑證或完整原廠程式。

## 重建

需求：macOS、Command Line Tools、Python 3.11+、Node 22+。完整重建需要 ChatGPT 26.1007.71326（20398）的原始封裝；目前安裝的官方 App 已更新為 26.1013.40934（20770），不可直接混用。此版本使用已驗證的 20398 開發副本進行增量更新。

0.4.7 增量更新與交付流程如下。先確認開發副本沒有執行中的工作，再關閉該副本；不終止其他 App 或使用者程序。

```sh
node scripts/refresh-build.cjs
python3 scripts/identity.py
node scripts/release-check.cjs
open -n build/OpenCodex.app --args --opencodex-test --remote-debugging-port=9325
node scripts/native-local-test.cjs
node scripts/ui-smoke.cjs --connect
node scripts/native-review-git-e2e.cjs
node scripts/native-connection-live.cjs
node scripts/native-subagents-live.cjs
node scripts/native-subagents-ui.cjs
node scripts/native-workspace-e2e.cjs
node scripts/native-organization-e2e.cjs
node scripts/native-shell-e2e.cjs
node scripts/native-queue-e2e.cjs
```

接著確認閒置，關閉並重新開啟同一個開發副本，保持 SSH 離線，再執行重啟驗收與彙整：

```sh
open -n build/OpenCodex.app --args --opencodex-test --remote-debugging-port=9325
node scripts/native-restart-e2e.cjs
node scripts/native-mcp-gui-summary.cjs
node scripts/native-gpt-e2e.cjs
```

每次啟動後先等原生視窗與測試端點就緒，再開始測試；`open` 返回不代表 App 已完成初始化。

MCP GUI 證據須在相同建置上另外取得：安裝 `native-mcp-gui-fixture.cjs install` 的本機測試外掛，重開並連線後，在空白原生輸入框執行 `native-mcp-gui-e2e.cjs`，再執行 `native-mcp-widget-e2e.cjs`。確認成功後執行 fixture 的 `remove` 並重新啟動。`native-mcp-gui-summary.cjs` 只整理已成功的實際驗收，不會代替 GUI 測試；原始事件與畫面資料不放入來源 ZIP。

關閉已驗收的開發副本及舊安裝版後，執行 `python3 scripts/package-0.4.7.py`。打包會核對當前來源與 App 雜湊、掛載 DMG 驗證、安裝相同副本，最後仍須實測安裝版一般啟動，確認測試埠與端點未開啟。

驗收從 GPT Codex 工作區開始，需已授權且在線的 SSH 主機及最高權限。測試會建立專屬資料夾、Git／Worktree、專案分類及真實模型對話；空白對話必須先有完成的回合，才能用原生歷史清單驗證分類。只刪除腳本明確建立的暫存分類，不清理使用者資料。本輪不切換 Claude。交付為 `~/Downloads/OpenCodex-0.4.7.dmg`。

下列為原始 0.4.1 完整建置與驗收流程，供歷史參考；0.4.7 使用上方流程，不執行舊的 `package.py`。

20398 完整重建來源：

- ChatGPT ASAR SHA256：`2f231a64e6dd30111bcd09e03c149cd06c8679b25914842772423251c4608ded`
- AgentBridge ASAR SHA256：`1142c1e1036bbc1bb02957ee2d11d0c9fdbdceb84978167e34915a9087489cf5`

```sh
node scripts/asar-reader.cjs '/Applications/AgentBridge Studio.app/Contents/Resources/app.asar' vendor/agentbridge
python3 scripts/prepare.py
node scripts/build.cjs
python3 scripts/identity.py
node scripts/quota-test.cjs
node scripts/ssh-profiles-test.cjs
node scripts/native-routing-test.cjs
node scripts/native-shell-test.cjs
node scripts/native-queue-unit.cjs
open -n build/OpenCodex.app --args --opencodex-test --remote-debugging-port=9325
node scripts/native-local-test.cjs
node scripts/native-tools-test.cjs
node scripts/native-request-test.cjs
node scripts/ui-smoke.cjs --connect
node scripts/protocol-test.cjs --native
node scripts/native-queue-test.cjs
node scripts/protocol-test.cjs
node scripts/stop-test.cjs
node scripts/protocol-test.cjs --resume
node scripts/native-pages-test.cjs
node scripts/mode-smoke.cjs
node scripts/ui-smoke.cjs --connect
node scripts/protocol-test.cjs --resume
python3 scripts/package.py
```

現有開發副本增量更新前，請先確認該副本閒置並關閉，再執行 `node scripts/refresh-build.cjs` 及 `python3 scripts/identity.py`。`refresh-build` 只接受已驗證的 20398 結構，不會將新版官方封裝混入舊版補丁。固定簽章須保留原本的簽章鑰匙圈及憑證。

本版另需 `native-full-access-test`、`native-approvals-test`、`native-workspace-test`，以及三者對應的真實端到端驗收；永久授權流程需透過原生對話框實際允許與撤銷，最高權限需重開 App 驗證保留。測試需開發副本就緒，`native-local-test` 在 SSH 未連線狀態執行。遠端驗收需主機在線及相應工具權限。打包腳本會檢查當版權限、工作區與回歸測試，另將審查、電腦／瀏覽器等前版結果存於 `historicalAcceptance`，不混入當版證據。不可將前版證據冒充當版測試結果。
