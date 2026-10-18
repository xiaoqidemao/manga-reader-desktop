# ============================================================
# 漫画阅读器 · 安装脚本
# ------------------------------------------------------------
# 替代 NSIS 安装程序（打包工具联网下载失败，改用系统自带的
# PowerShell 完成同样的事）：
#   - 把程序复制到 %LOCALAPPDATA%\Programs\漫画阅读器
#   - 在桌面和开始菜单创建快捷方式
#   - 写入卸载信息，可在「应用和功能」里卸载
#
# 用法：双击同目录下的「点我安装.bat」
# ============================================================

$ErrorActionPreference = 'Stop'

$AppName    = '漫画阅读器'
$AppVersion = '1.0.0'
$InstallDir = Join-Path $env:LOCALAPPDATA "Programs\$AppName"
$SourceDir  = $PSScriptRoot
$ExeName    = "$AppName.exe"

Write-Host ""
Write-Host "  漫画阅读器 - 安装" -ForegroundColor Cyan
Write-Host "  ------------------" -ForegroundColor DarkGray
Write-Host ""

# 校验源文件
$srcExe = Join-Path $SourceDir $ExeName
if (-not (Test-Path $srcExe)) {
    Write-Host "  [错误] 找不到 $ExeName" -ForegroundColor Red
    Write-Host "  请把这个脚本放在程序目录（含 $ExeName 的文件夹）里再运行。" -ForegroundColor Yellow
    Write-Host "  按任意键退出..."
    $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
    exit 1
}

# 关闭正在运行的实例
$running = Get-Process -Name $AppName -ErrorAction SilentlyContinue
if ($running) {
    Write-Host "  正在关闭已运行的 $AppName ..." -ForegroundColor Yellow
    $running | ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 2
}

# 复制文件
Write-Host "  正在安装到: $InstallDir"
if (Test-Path $InstallDir) {
    Write-Host "  检测到旧版本，正在覆盖..." -ForegroundColor DarkGray
    Remove-Item $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
}
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
Copy-Item -Path (Join-Path $SourceDir '*') -Destination $InstallDir -Recurse -Force

$installedExe = Join-Path $InstallDir $ExeName
if (-not (Test-Path $installedExe)) {
    Write-Host "  [错误] 复制失败" -ForegroundColor Red
    exit 1
}

# 创建快捷方式
function New-Shortcut {
    param($Path, $Target, $WorkDir, $Icon)
    $shell = New-Object -ComObject WScript.Shell
    $sc = $shell.CreateShortcut($Path)
    $sc.TargetPath = $Target
    $sc.WorkingDirectory = $WorkDir
    $sc.IconLocation = $Icon
    $sc.Description = '本地漫画阅读器'
    $sc.Save()
}

$icon = "$installedExe,0"

Write-Host "  正在创建快捷方式..."
$desktop = [Environment]::GetFolderPath('Desktop')
$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'

try {
    New-Shortcut -Path (Join-Path $desktop "$AppName.lnk") -Target $installedExe -WorkDir $InstallDir -Icon $icon
    Write-Host "    [OK] 桌面快捷方式" -ForegroundColor Green
} catch {
    Write-Host "    [!] 桌面快捷方式创建失败（可手动创建）" -ForegroundColor DarkYellow
}

try {
    New-Shortcut -Path (Join-Path $startMenu "$AppName.lnk") -Target $installedExe -WorkDir $InstallDir -Icon $icon
    Write-Host "    [OK] 开始菜单快捷方式" -ForegroundColor Green
} catch {
    Write-Host "    [!] 开始菜单快捷方式创建失败" -ForegroundColor DarkYellow
}

# 写入卸载信息
Write-Host "  正在登记卸载信息..."
$uninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\MangaReaderDesktop"
try {
    New-Item -Path $uninstallKey -Force | Out-Null
    Set-ItemProperty -Path $uninstallKey -Name 'DisplayName'     -Value $AppName
    Set-ItemProperty -Path $uninstallKey -Name 'DisplayVersion'  -Value $AppVersion
    Set-ItemProperty -Path $uninstallKey -Name 'InstallLocation' -Value $InstallDir
    Set-ItemProperty -Path $uninstallKey -Name 'UninstallString' -Value "`"$InstallDir\卸载.ps1`""
    Set-ItemProperty -Path $uninstallKey -Name 'DisplayIcon'     -Value $installedExe
    Set-ItemProperty -Path $uninstallKey -Name 'Publisher'       -Value '本地应用'
    Set-ItemProperty -Path $uninstallKey -Name 'NoModify'        -Value 1 -Type DWord
    Set-ItemProperty -Path $uninstallKey -Name 'NoRepair'        -Value 1 -Type DWord
    Write-Host "    [OK] 可在「应用和功能」中卸载" -ForegroundColor Green
} catch {
    Write-Host "    [!] 卸载信息写入失败" -ForegroundColor DarkYellow
}

# 生成卸载脚本
$uninstallScript = @'
$ErrorActionPreference = 'SilentlyContinue'
$AppName = '漫画阅读器'
$InstallDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "正在卸载 $AppName ..."
Get-Process -Name $AppName | ForEach-Object { Stop-Process -Id $_.Id -Force }
Start-Sleep -Seconds 2

$desktop = [Environment]::GetFolderPath('Desktop')
Remove-Item (Join-Path $desktop "$AppName.lnk") -Force
$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
Remove-Item (Join-Path $startMenu "$AppName.lnk") -Force

Remove-Item "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\MangaReaderDesktop" -Recurse -Force

Start-Process cmd -ArgumentList "/c timeout /t 2 & rmdir /s /q `"$InstallDir`"" -WindowStyle Hidden

Write-Host "卸载完成。"
Write-Host ""
Write-Host "注意：阅读进度仍保留在:"
Write-Host "  $env:APPDATA\漫画阅读器\progress.json"
Write-Host "如需彻底清除，请手动删除该文件夹。"
Start-Sleep -Seconds 3
'@

$uninstallScript | Out-File -FilePath (Join-Path $InstallDir '卸载.ps1') -Encoding UTF8

Write-Host ""
Write-Host "  [OK] 安装完成！" -ForegroundColor Green
Write-Host ""
Write-Host "  双击桌面上的「$AppName」即可启动。" -ForegroundColor Cyan
Write-Host "  第一次打开会让你选择漫画文件夹。"
Write-Host ""
Write-Host "  你的漫画不会被复制或移动，程序只读取。" -ForegroundColor DarkGray
Write-Host "  阅读进度保存在: %APPDATA%\漫画阅读器\progress.json" -ForegroundColor DarkGray
Write-Host ""

$launch = Read-Host "  现在启动吗？(Y/n)"
if ($launch -ne 'n' -and $launch -ne 'N') {
    Start-Process -FilePath $installedExe
}

Write-Host ""
Write-Host "  按任意键关闭..."
$null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
