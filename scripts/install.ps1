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

# 3. 校验真的落地了 ---------------------------------------------------------
# 本机遇到过一次：pnpm 把文件拷进 node_modules 了，但 dependencies / bundles / lockfile
# 三处都没写进去，命令却"看起来"跑完了。不校验就会以为装好了，重开 DSH 发现没有工具。
if (-not $Remove) {
  $profileDir = Join-Path $env:USERPROFILE ".dsh\profiles\$Profile"
  $problems = New-Object System.Collections.Generic.List[string]

  $pkgJsonPath = Join-Path $profileDir 'package.json'
  if (-not (Test-Path $pkgJsonPath)) {
    $problems.Add("找不到 profile 的 package.json：$pkgJsonPath")
  } else {
    $cfg = Get-Content -LiteralPath $pkgJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $depEntry = $cfg.PSObject.Properties['dependencies']
    if ($null -eq $depEntry -or $null -eq $depEntry.Value.PSObject.Properties['dsh-virtual-desktop-manager']) {
      $problems.Add('package.json 的 dependencies 里没有 dsh-virtual-desktop-manager')
    }
    if (-not (@($cfg.dsh.profile.bundles) -contains 'dsh-virtual-desktop-manager')) {
      $problems.Add('package.json 的 dsh.profile.bundles 里没有 dsh-virtual-desktop-manager')
    }
  }

  $lockPath = Join-Path $profileDir 'pnpm-lock.yaml'
  if ((Test-Path $lockPath) -and (-not (Select-String -LiteralPath $lockPath -Pattern 'dsh-virtual-desktop-manager' -Quiet))) {
    $problems.Add('pnpm-lock.yaml 里没有这个包（pnpm 只拷了文件、没记账）')
  }

  $hostInProfile = Join-Path $profileDir 'node_modules\dsh-virtual-desktop-manager\dist\vdmhost.exe'
  if (-not (Test-Path $hostInProfile)) {
    $problems.Add("node_modules 里找不到 vdmhost.exe：$hostInProfile")
  }

  if ($problems.Count -gt 0) {
    Write-Host ""
    Write-Host "✗ 安装命令跑完了，但校验发现以下问题：" -ForegroundColor Red
    $problems | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
    Write-Host ""
    Write-Host "  这是 pnpm 只完成文件拷贝、没完成依赖记账的半成品状态，DSH 不会认。"
    Write-Host "  处理办法（按顺序试）："
    Write-Host "    1) 再跑一次本脚本"
    Write-Host "    2) 跑 scripts\install.ps1 -Remove 卸载后再装"
    Write-Host "    3) 手工删掉 $profileDir\node_modules\dsh-virtual-desktop-manager 后重装"
    exit 1
  }

  Write-Host ""
  Write-Host "✓ 校验通过：dependencies / bundles / pnpm-lock / node_modules 四处都已落地。" -ForegroundColor Green
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
