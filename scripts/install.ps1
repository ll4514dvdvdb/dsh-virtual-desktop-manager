<#
.SYNOPSIS
  把 dsh-virtual-desktop-manager 安装到（或从）DSH 的 desktop profile。

.DESCRIPTION
  DSH 桌面版在运行时会独占 profile 的 package.json（writer lock），
  所以本脚本必须在 DSH 完全退出之后运行。脚本会先检查进程，在跑就直接退出，不会硬抢锁。

  用法：
    # 关闭 DSH 之后
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1

    # 卸载
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1 -Remove
#>
param(
  [switch]$Remove,
  [string]$Profile = 'desktop'
)

$ErrorActionPreference = 'Stop'

$project = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$dshCmd = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'

function Fail($msg) {
  Write-Host ""
  Write-Host "✗ $msg" -ForegroundColor Red
  exit 1
}

# 1. 前置检查 ---------------------------------------------------------------
if (-not (Test-Path $dshCmd)) {
  Fail "找不到 DSH CLI：`n  $dshCmd`n请确认 DeepSeek Harness 已安装到默认位置。"
}

$running = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
if ($running.Count -gt 0) {
  Write-Host "✗ 检测到 DeepSeek Harness 正在运行（PID: $($running.Id -join ', ')）。" -ForegroundColor Red
  Write-Host ""
  Write-Host "  DSH 运行期间独占 profile 的 package.json，强行安装会卡在 writer lock 上（实测约 10 秒超时失败）。"
  Write-Host "  请先完全退出 DSH（托盘图标也要退出），再运行本脚本。"
  exit 1
}

if (-not $Remove) {
  $host1 = Join-Path $project 'dist\vdmhost.exe'
  if (-not (Test-Path $host1)) {
    Write-Host "! 找不到 dist\vdmhost.exe，先构建原生助手……" -ForegroundColor Yellow
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'build-host.ps1')
    if ($LASTEXITCODE -ne 0) { Fail '原生助手构建失败，安装中止。' }
  }
}

# 2. 执行 -------------------------------------------------------------------
if ($Remove) {
  Write-Host "从 profile '$Profile' 卸载 dsh-virtual-desktop-manager ……"
  & $dshCmd plugin --profile $Profile remove dsh-virtual-desktop-manager
} else {
  Write-Host "安装到 profile '$Profile'："
  Write-Host "  包路径：$project"
  & $dshCmd plugin --profile $Profile add "file:$project"
}

if ($LASTEXITCODE -ne 0) {
  Fail "dsh plugin 返回退出码 $LASTEXITCODE，安装未完成。"
}

Write-Host ""
if ($Remove) {
  Write-Host "✓ 已卸载。重开 DSH 生效。" -ForegroundColor Green
} else {
  Write-Host "✓ 安装完成。现在重开 DSH。" -ForegroundColor Green
  Write-Host ""
  Write-Host "  重开后在新会话里调用 vdm_capabilities，看到「虚拟桌面 COM 可用」就通了。"
  Write-Host "  状态与截图在：$env:USERPROFILE\.dsh\virtual-desktop-manager\"
}
