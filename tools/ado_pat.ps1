<#
.SYNOPSIS
  把 %USERPROFILE%\.ado_pat 裡的 PAT 交給 dashboard 的「ADO Task」頁面。

.DESCRIPTION
  瀏覽器不能自己讀本機檔案，所以這個腳本把 PAT 寫成 data\ado_pat.js
  （window.LLT_ADO_PAT）。index.html 開啟時會順手載入它，進入「ADO Task」
  就直接去 ADO 擷取，不必每次貼 PAT。

  data\ado_pat.js 內含你的 PAT：已列入 .gitignore，不要 commit、不要分享。
  不用了就跑 -Clear 刪掉。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\ado_pat.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\ado_pat.ps1 -Open
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\ado_pat.ps1 -Clear
#>
[CmdletBinding()]
param(
  # PAT 檔的位置，預設 C:\Users\<登入者>\.ado_pat
  [string]$Path = (Join-Path $env:USERPROFILE ".ado_pat"),
  # 寫完就用預設瀏覽器開 index.html
  [switch]$Open,
  # 刪掉 data\ado_pat.js
  [switch]$Clear
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$out = Join-Path $repo "data\ado_pat.js"
$page = Join-Path $repo "index.html"

if ($Clear) {
  if (Test-Path $out) {
    Remove-Item $out -Force
    Write-Host "已刪除 $out"
  } else {
    Write-Host "沒有 $out，不需要清除"
  }
  exit 0
}

if (-not (Test-Path $Path)) {
  Write-Warning "找不到 $Path"
  Write-Host ""
  Write-Host "PAT 在 ADO 的 User settings -> Personal access tokens 建立，scope 只要勾 Work Items (Read)，"
  Write-Host "然後存成單獨一行："
  Write-Host "  Set-Content -Path '$Path' -Value '<你的 PAT>' -NoNewline -Encoding ascii"
  Write-Host ""
  Write-Host "不想用這個檔案也可以：在網頁上按「⟳ 從 ADO 擷取」貼上 PAT，或在設定對話框按「從 .ado_pat 檔載入」選檔案。"
  exit 1
}

# 第一個非空白行；容許 "PAT=xxx"、引號與前後空白。
$line = Get-Content -Path $Path -Encoding UTF8 | Where-Object { $_.Trim() -ne "" } | Select-Object -First 1
if (-not $line) { throw "$Path 是空的" }
$pat = $line.Trim().Trim('"').Trim("'")
$pat = [regex]::Replace($pat, '^(?i)\s*(ado[_-]?)?pat\s*[=:]\s*', '').Trim()
if ($pat -notmatch '^[A-Za-z0-9._\-]{20,}$') {
  throw "$Path 的內容看起來不像 PAT（應該是一串英數字）。請確認檔案裡只放 PAT 本身。"
}

# 這個檔案含有 PAT，一定要先被 git 忽略才寫出去。
git -C $repo check-ignore -q -- $out
if ($LASTEXITCODE -ne 0) {
  Write-Warning "data/ado_pat.js 沒有被 .gitignore 忽略 - 請先把 data/ado_pat.js 加進 .gitignore，再跑一次。"
  exit 1
}

$stamp = Get-Date -Format "yyyy-MM-dd HH:mm"
$fromJs = $Path -replace '\\', '\\'
$js = @"
/* tools/ado_pat.ps1 於 $stamp 從 $Path 產生。
   這個檔案含有你的 ADO PAT：已被 .gitignore 忽略，請不要 commit 或分享。
   刪除：powershell -ExecutionPolicy Bypass -File tools\ado_pat.ps1 -Clear */
window.LLT_ADO_PAT = "$pat";
window.LLT_ADO_PAT_FROM = "$fromJs";
"@

Set-Content -Path $out -Value $js -Encoding UTF8
Write-Host "已寫入 $out（PAT 長度 $($pat.Length)，來源 $Path）"
Write-Host "開啟 index.html → ADO Task 就會自動擷取。"

if ($Open) { Start-Process $page }
