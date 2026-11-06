# 编译原生助手 vdmhost.exe 到 dist\。
#
# 为什么需要这个脚本（而不是直接 dotnet build）：
#   1. 受限环境下 dotnet 会去写 %USERPROFILE%\.dotnet 和 %APPDATA%\NuGet\NuGet.Config，
#      这两处经常不可写，构建直接失败。这里把 APPDATA / LOCALAPPDATA / DOTNET_CLI_HOME /
#      NUGET_PACKAGES 全部重定向到仓库内的 .build\ 目录，构建过程不碰用户目录。
#   2. 工程刻意用 net472 而不是 net8+：目标机器是 Windows 11 自带的 .NET Framework 4.8，
#      不需要用户额外装运行时，产物体积也只有几十 KB。

param(
    [string]$Configuration = 'Release'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$buildHome = Join-Path $root '.build'
$null = New-Item -ItemType Directory -Force -Path (Join-Path $buildHome 'appdata\NuGet'), (Join-Path $buildHome 'appdata\Local'), (Join-Path $buildHome 'dotnet-home'), (Join-Path $root 'dist')

$env:APPDATA = Join-Path $buildHome 'appdata'
$env:LOCALAPPDATA = Join-Path $buildHome 'appdata\Local'
$env:DOTNET_CLI_HOME = Join-Path $buildHome 'dotnet-home'
$env:NUGET_PACKAGES = Join-Path $buildHome 'nuget-packages'
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:DOTNET_NOLOGO = '1'
$env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE = '1'

Write-Host "[build] 工程目录: $root"
Write-Host "[build] 目标框架: net472 (x64)"

& dotnet build (Join-Path $root 'native\VdmHost.csproj') `
    -c $Configuration `
    -o (Join-Path $root 'dist') `
    -p:UseSharedCompilation=false `
    -v minimal

if ($LASTEXITCODE -ne 0) {
    Write-Host "[build] 失败，退出码 $LASTEXITCODE"
    exit $LASTEXITCODE
}

$exe = Join-Path $root 'dist\vdmhost.exe'
if (-not (Test-Path $exe)) {
    Write-Host "[build] 没有产出 $exe"
    exit 1
}

$size = (Get-Item $exe).Length
Write-Host "[build] 完成: $exe ($size 字节)"
