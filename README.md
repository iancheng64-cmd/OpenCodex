# OpenCodex 0.4.11 · 預覽版

OpenCodex 是 macOS 上的獨立 AI 工作介面：保留原生對話、側邊欄與模型選單，讓同一個對話接續使用 Codex、Claude Code、Antigravity CLI 與 Grok CLI。模型可以在 SSH 伺服器運行，檔案與工具則透過已授權的 Mac 執行端工作。

這是非官方修改版，與 OpenAI、Anthropic、Google、xAI、Cursor 均無官方合作關係。介面基於固定版本的原生封裝，並非從零實作的開源 ChatGPT，也不代表支援所有 ChatGPT 雲端功能。第三方程式仍受各自授權條款約束；本儲存庫沒有授予原廠程式的再散布權。

**0.4.11 為預覽版。** 實機驗收涵蓋 GPT ↔ Grok 切換、前文交接、Mac 工具、停止操作、模型選單及 Composio。Claude 和 Antigravity 的伺服器授權尚待處理，實際生成與逐模型額度未完成實機驗收。完整回歸缺少 11 個舊版進階情境，仍為未通過；詳見下方驗證範圍。

## 安裝與更新

1. 從本專案 Releases 下載 `OpenCodex-0.4.11.dmg`；同版提供來源 ZIP、SHA-256 及驗證 JSON。
2. 關閉原有 OpenCodex，開啟 DMG，將 `OpenCodex.app` 拖到 Applications。
3. 啟動後在設定加入 SSH 主機、使用者、認證方式與本機專案資料夾。
4. 首次連線核對 SSH 指紋；依工具需要授予 macOS 輔助使用、螢幕錄製或檔案存取權限。

目前使用固定本機簽署身分，尚無 Apple Developer ID 公證。如果 macOS 阻擋首次開啟，在確認來源與雜湊後，使用「系統設定 → 隱私權與安全性 → 仍要打開」。不需要停用 Gatekeeper、SIP、FileVault 或整個鑰匙圈。簽章驗證通過不等於 Apple 公證通過。

需求：Apple Silicon Mac、SSH 伺服器、各供應商 CLI 與有效帳號。模型權限與服務條件仍由供應商決定。私有儲存庫的 Release 只能由獲授權成員下載。

## 同一對話切換模型

- 從輸入框的原生模型選單切換 GPT、Claude、Antigravity 模型或 Grok，不需重開 App。
- 工作進行中可以選擇下一個模型，在下一回合生效。要立即交接，先按停止，再送出下一則訊息。
- 「停止」永遠送給目前工作的供應商，不會誤送給剛選的新模型。
- 側邊欄「新對話預設」設定新對話供應商；目前對話使用自己的模型設定。
- 可見前文會交接給下一個供應商，受上下文長度限制；不搬移另一家模型的內部推理、未完成程序或所有工具隱藏狀態。
- SSH 主機、工作目錄與權限會影響工具操作位置，因此變更主機仍需先停止工作；模型選擇不受這項限制。

保存主機後，啟動時自動連線並探測所有供應商，各家獨立回報狀態。網路斷線有有界重連；登入失效仍需本人重新授權。

## 在哪裡登入各個 AI？

在**執行模型的伺服器**上，使用 OpenCodex SSH 對應的實際系統使用者登入。SSH 別名可能映射到不同帳號，可先執行 `whoami` 確認。只登入桌面 App，不保證 CLI 在 SSH 中能讀到同一份憑證。

| 供應商 | 伺服器登入入口 | 使用方式 |
| --- | --- | --- |
| Codex | `codex login` | Codex CLI / app-server |
| Claude Code | `claude auth login`，或執行 `claude` 按提示登入 | Claude Code CLI 憑證 |
| Antigravity | 執行 `agy` 完成瀏覽器驗證 | CLI；模型由 `agy models` 探測 |
| Grok | `grok login --device-auth` | Grok CLI / ACP |

指令必須能在 SSH 使用者環境中找到；自訂路徑可在進階引擎設定中指定。首次登入需要本人完成瀏覽器驗證；OpenCodex 不索取密碼，也不略過供應商驗證。

### Mac mini 已登入，為什麼 SSH 仍被拒絕？

登入鑰匙圈、個別項目的存取控制，以及 SSH 是否能顯示授權視窗，是不同的檢查。SSH 公鑰登入成功不代表鑰匙圈已解鎖。

1. 在 Mac mini 桌面登入與 SSH 相同的系統帳號。
2. 開啟「鑰匙圈存取」，選「登入」鑰匙圈；若鎖定，使用該 Mac 帳號密碼解鎖。密碼只在那台 Mac 的系統視窗輸入。
3. 若 Claude 仍被拒絕，檢查 `Claude Code-credentials` 的「存取控制」，只授權你確認過的 Claude CLI，不要設成所有應用程式皆可讀取。
4. 回 SSH 執行 `claude auth status --json`，再按 OpenCodex 用量區的「更新」。

本版將「憑證存在、SSH 無法讀取」標成**鑰匙圈需授權**。探測憑證時不將內容寫入輸出或日誌。如果授權視窗只能在桌面出現，必須在桌面確認，App 無法代替 macOS 授權。

可以在「登入鑰匙圈設定」調整閒置或睡眠自動鎖定，但不保證解除個別項目存取控制。不要刪除鑰匙圈或停用整套保護。

Antigravity 另行判斷：若 `agy models` 仍要求驗證，憑證可能到期或無法更新。以相同 SSH 使用者重新執行 `agy`，開啟它提供的 URL 登入，再將驗證碼回填 CLI。**不會因 Claude 鑰匙圈出錯，就把 Antigravity 判成相同原因。**

參考：[Apple 鑰匙圈存取](https://support.apple.com/en-gb/guide/mac-help/kychn002/26/mac/26)、[自動鎖定](https://support.apple.com/en-gb/guide/keychain-access/kyca1242/mac)、[Claude 驗證](https://code.claude.com/docs/en/authentication)、[Antigravity CLI 登入](https://antigravity.google/docs/install?tab=cli)。

## 所有帳號與剩餘額度

左下角常駐所有供應商用量，可捲動、展開、手動更新，並定期刷新。切換模型不隱藏其他帳號。

| 供應商 | 顯示內容與限制 |
| --- | --- |
| Codex | 服務回傳的用量週期、剩餘比例、重置時間；五小時或每週欄位缺少時標示「未提供」 |
| Claude Code | 可取得時顯示五小時、每週及其他用量桶；授權受阻與用量讀取失敗分開標示 |
| Antigravity | CLI `/usage` 的逐模型原始報告；需有效登入與 CLI 支援，未取得時不假列模型或百分比 |
| Grok CLI | 目前沒有可讀取的訂閱五小時／週額度，標示未提供，不當成零或無限額度 |

CLI 登入、模型權限、API 餘額、網頁訂閱額度不一定來自同一資料來源。本版不以對話 token 數推算訂閱剩餘額度。[Antigravity 指令參考](https://antigravity.google/docs/cli/reference/)。

### SuperGrok 可以使用 Opus 5.5 嗎？

Grok Bot 官方說明中，Auto 可能使用包括 Opus 5.5 在內的後端模型，使用者不能手動指定 Auto 的後端。符合資格的 SuperGrok 方案可依 Grok Bot 的帳號連結規則取得權益。這不等於 Anthropic API 額度，也不代表 OpenCodex 的 Grok CLI 能直接選 Opus 5.5。

若要在 OpenCodex 明確選 Claude，需使用具有模型權限的 Claude Code 帳號。帳號連結可能無法解除，連結前應確認正確帳號。詳見 [Grok Bot 模型](https://cursor.com/help/grok-bot/models) 與 [方案條件](https://cursor.com/help/grok-bot/plans)。

## Composio MCP

1. 設定 → Composio →「連接 Composio」。
2. 瀏覽器選擇正確帳號與工作區，完成 OAuth。
3. 返回 App 按「檢查連線」，確認狀態和工具數量。
4. 使用 AI 時依 Composio 引導，分別授權 Gmail、Drive、GitHub 等服務；多帳號請確認所選帳號。

端點為 `https://connect.composio.dev/mcp`。授權使用本機 App 的憑證儲存流程，不提交 Git、不放進來源 ZIP。連接 Composio 不會自動授權所有線上帳號。本版驗證連線及 11 個 MCP 工具，並未測試所有第三方服務。

## 功能範圍

保留原生對話、側邊欄、模型選單、工具卡片與適用的工作區功能，新增統一路由、前文交接、Mac 工具橋接、全帳號用量與 Composio。外部供應商的附件、工具、模型與回合事件仍受各自 CLI 能力限制。

Hooks、Guardian 自動審批及自訂權限需要對應修改版引擎能力標記。未回報能力的引擎不會被當成支援。完整 ChatGPT 功能、所有雲端服務、所有第三方插件、自訂權限完整 GUI 授權流程，以及跨版本 TCC 授權保留，均未完成完整驗收。

## 開發與建置

**全新 clone 不能直接建出完整 App。** 專案是固定原生基底上的修改工具，使用 ChatGPT `26.1007.71326` build `20398` 與 AgentBridge 執行端。新版官方 App 不能直接混用；版本或 patch 定位不符會中止。

- `src/`：統一路由、原生介面、工具／權限、供應商與 Composio。
- `scripts/`：固定版本 patch、測試、完整性、簽署與封裝。
- `native/hooks-helper/`：Hooks helper 原始碼。
- `build/`：本機產物與引擎來源封存，不提交 Git。
- `evidence/`：驗收報告；只發布去識別摘要。

需要 Node.js 22 或相容版本、Python 3.11+、Xcode Command Line Tools；原生引擎另需符合鎖定依賴的 Rust 工具鏈。完整建置先閱讀 `scripts/build.cjs` 固定來源要求，自行取得合法相容基底。

已具備通過簽章驗證的相容開發 App 時，關閉 App 後更新：

```sh
node scripts/refresh-build.cjs
python3 scripts/identity.py
node scripts/release-check.cjs
```

`identity.py` 使用本機簽署設定，不提交私人金鑰。`refresh-build.cjs` 保留並驗證既有原生元件，並不等於從原始碼重建所有二進位檔。

本版針對性測試：

```sh
node scripts/claude-auth-probe-test.cjs
node scripts/native-claude-test.cjs
node scripts/unified-providers-test.cjs
node scripts/composio-test.cjs
```

實機 QA 的 `unified-providers-live.cjs`、`unified-providers-ui.cjs` 需要開發 App 使用 `--opencodex-test --remote-debugging-port=9325`、已登入帳號與已授權測試工作區，會使用少量模型額度。一般安裝啟動不使用 QA 參數。不要公開 QA 端點或原始模型事件。

## 驗證與可重現性限制

Release 的 verification JSON 綁定 App ASAR、測試來源及下載產物雜湊。已執行檢查與未執行情境分開列出，不用舊版結果冒充本版通過。

目前缺少 8 支 `research/native-permission*-probe.cjs` 及 Guardian 的 3 個進階情境。`release-check.cjs` 繼續執行可用檢查，但最後回傳非零、`passed:false`。預覽版封裝只接受明列的 11 個缺失，其他測試失敗會阻止封裝。穩定版驗收需先補回原始探針。

先前引擎建置的部分來源對應與原廠 App 基準檔也缺失。來源 ZIP 附現存引擎來源封存與雜湊，但不把目前雜湊當成遺失的歷史證明；不宣稱來源封存與保留二進位檔具完整可重現對應，也不宣稱重驗原廠 App 歷史基準。

Claude 實機目前是 macOS 拒絕 SSH 存取已存在的憑證；Antigravity CLI 回報需要驗證。隔離測試覆蓋錯誤分類及恢復，沒有把兩者算成已成功連線或生成。修復授權後仍需補做實機驗收。

變更詳見 [CHANGELOG.md](CHANGELOG.md)。
