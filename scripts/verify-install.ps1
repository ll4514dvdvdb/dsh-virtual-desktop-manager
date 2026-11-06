<#
.SYNOPSIS
  校验 dsh-virtual-desktop-manager 是不是真的装好了。

.DESCRIPTION
  安装卡在 pnpm 收尾阶段时会出现一种假象：文件已经拷进 node_modules，
  但 profile 的 dependencies / dsh.profile.bundles / pnpm-lock.yaml 三处都没写进去。
  命令看起来跑完了，重开 DSH 却找不到 vdm_* 工具。
  本脚本把四处逐个查一遍，再用"装着的那份拷贝"跑一次原生助手冒烟测试。

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-install.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify-install.ps1 -Profile web
#>
param(
  [string]$Profile = 'desktop'
)

$profileDir = Join-Path $env:USERPROFILE ".dsh\profiles\$Profile"
$ok = $true

function Check([string]$label, [bool]$passed, [string]$detail) {
  if ($passed) {
    Write-Host "  [OK] $label" -ForegroundColor Green
  } else {
    Write-Host "  [!!] $label" -ForegroundColor Red
    if ($detail) { Write-Host "       $detail" -ForegroundColor DarkGray }
    $script:ok = $false
  }
}

Write-Host "profile: $profileDir"
Write-Host ""

if (-not (Test-Path $profileDir)) {
  Write-Host "[!!] profile 目录不存在，插件没有安装。" -ForegroundColor Red
  exit 1
}

# 1. package.json ----------------------------------------------------------
$pkgPath = Join-Path $profileDir 'package.json'
$cfg = $null
if (Test-Path $pkgPath) {
  try { $cfg = Get-Content -LiteralPath $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $cfg = $null }
}
Check 'package.json 存在且可解析' ($null -ne $cfg) $pkgPath

if ($cfg) {
  $depProp = $cfg.PSObject.Properties['dependencies']
  $hasDep = ($null -ne $depProp) -and ($null -ne $depProp.Value) -and
            ($null -ne $depProp.Value.PSObject.Properties['dsh-virtual-desktop-manager'])
  Check 'dependencies 里有 dsh-virtual-desktop-manager' $hasDep '没写进去 -> DSH 不会加载这个包'

  $inBundle = @($cfg.dsh.profile.bundles) -contains 'dsh-virtual-desktop-manager'
  Check 'dsh.profile.bundles 里注册了' $inBundle '没注册 -> 插件树里不会出现'
}

# 2. lockfile --------------------------------------------------------------
$lockPath = Join-Path $profileDir 'pnpm-lock.yaml'
if (Test-Path $lockPath) {
  $inLock = Select-String -LiteralPath $lockPath -Pattern 'dsh-virtual-desktop-manager' -Quiet
  Check 'pnpm-lock.yaml 已记账' $inLock 'pnpm 只拷贝文件、没写 lockfile 的半成品状态'
} else {
  Write-Host "  [--] 没有 pnpm-lock.yaml，跳过" -ForegroundColor DarkGray
}

# 3. 安装后的文件 ----------------------------------------------------------
$pkgDir = Join-Path $profileDir 'node_modules\dsh-virtual-desktop-manager'
$exePath = Join-Path $pkgDir 'dist\vdmhost.exe'
Check 'node_modules 里有插件目录' (Test-Path $pkgDir) $pkgDir
Check 'dist\vdmhost.exe 存在' (Test-Path $exePath) $exePath

# 4. 冒烟测试（用装着的那份拷贝，不是工程目录） ----------------------------
$smoke = Join-Path $pkgDir 'tests\host-smoke.mjs'
if ((Test-Path $exePath) -and (Test-Path $smoke)) {
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $nodeCmd) {
    Write-Host "  [!] 找不到 node，跳过冒烟测试" -ForegroundColor Yellow
  } else {
    Write-Host ""
    Write-Host "用装好的这份拷贝跑原生助手冒烟测试…" -ForegroundColor Cyan
    Push-Location $pkgDir
    & $nodeCmd.Source $smoke 2>&1 | ForEach-Object { "  $_" }
    $smokeExit = $LASTEXITCODE
    Pop-Location
    Write-Host ""
    if ($smokeExit -eq 0) {
      Write-Host "  [OK] 冒烟通过：COM 可用，桌面和窗口都能读到" -ForegroundColor Green
    } elseif ($smokeExit -eq 2) {
      Write-Host "  [!] 冒烟发现虚拟桌面 COM 不可用（完整性级别/会话问题）。工具仍会注册，但调用会报结构化错误。" -ForegroundColor Yellow
    } else {
      Write-Host "  [!!] 冒烟失败，退出码 $smokeExit" -ForegroundColor Red
      $ok = $false
    }
  }
}

Write-Host ""
if ($ok) {
  Write-Host "[OK] 安装完整。重开 DSH 后在新会话里调 vdm_capabilities 即可。" -ForegroundColor Green
  exit 0
} else {
  Write-Host "[!!] 上面标 [!!] 的项必须先处理，否则 DSH 里不会出现 vdm_* 工具。" -ForegroundColor Red
  Write-Host "     处理顺序：1) 再跑一次 install.ps1  2) install.ps1 -Remove 后重装  3) 手工删掉 node_modules\dsh-virtual-desktop-manager 后重装"
  exit 1
}
