<#
install.ps1 - 把本插件挂载到 DeepSeek Harness（DSH 桌面版）的 profile。

在克隆下来的仓库目录里运行即可；重复运行等于刷新链接，可随时安全重跑。
加 -Uninstall 参数则卸载（移除链接与 profile 配置条目，仓库文件不动）。
Windows PowerShell 5.1 兼容。
#>
param(
    # 插件目录（默认：本脚本所在目录）
    [string]$PluginDir = (Split-Path -Parent $MyInvocation.MyCommand.Path),
    # DSH profile 目录
    [string]$ProfileDir = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop'),
    # 卸载而不是安装
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

$PluginName = 'dsh-ask-mode'
$PkgName = '@local/' + $PluginName

function Write-Step([string]$Message) { Write-Host ('==> ' + $Message) -ForegroundColor Cyan }
function Write-Note([string]$Message) { Write-Host ('    ' + $Message) -ForegroundColor DarkGray }

# 确认 DSH 已安装（找卸载注册表键）。
function Get-DshUninstallKey {
    $roots = @(
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
    )
    foreach ($root in $roots) {
        if (-not (Test-Path $root)) { continue }
        foreach ($key in Get-ChildItem $root -ErrorAction SilentlyContinue) {
            if ($key.GetValue('DisplayName') -like '*DeepSeek Harness*') { return $key }
        }
    }
    return $null
}

# profile 在 DSH 首次启动时创建；没有就启动一次并等待。
function Ensure-Profile {
    if (Test-Path (Join-Path $ProfileDir 'package.json')) { return }

    $key = Get-DshUninstallKey
    if ($null -eq $key) { throw '未检测到 DeepSeek Harness，请先安装 DSH 桌面版再运行本脚本' }

    $installDir = $key.GetValue('InstallLocation')
    if (-not $installDir) {
        # 兜底：从卸载命令里反推安装目录。
        $uninstall = [string]$key.GetValue('UninstallString')
        if ($uninstall -match '^"([^"]+)"') { $installDir = Split-Path -Parent $Matches[1] }
    }
    $exe = Join-Path $installDir 'DeepSeek Harness.exe'
    if (-not (Test-Path $exe)) { throw ('未找到 DSH 主程序: ' + $exe) }

    Write-Step '首次启动 DSH 以生成配置目录...'
    Start-Process -FilePath $exe | Out-Null
    $deadline = (Get-Date).AddSeconds(120)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 3
        if (Test-Path (Join-Path $ProfileDir 'package.json')) {
            Start-Sleep -Seconds 2  # 等应用写完 profile
            Write-Step '正在关闭首次启动的 DSH...'
            Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Stop-Process -Force
            return
        }
    }
    throw '等待配置目录超时。请先手动启动一次 DSH，然后重新运行本脚本。'
}

# 建立（或刷新）node_modules/@local 下的 junction。
function Set-PluginJunction {
    if (-not (Test-Path (Join-Path $PluginDir 'package.json'))) {
        throw ('插件目录不完整: ' + $PluginDir)
    }
    $localDir = Join-Path $ProfileDir 'node_modules\@local'
    if (-not (Test-Path $localDir)) { New-Item -ItemType Directory -Path $localDir -Force | Out-Null }
    $link = Join-Path $localDir $PluginName

    if (Test-Path $link) {
        $item = Get-Item $link -Force
        if (-not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw ($link + ' 已存在且不是链接，请手动处理后重试')
        }
        # rmdir 只删 junction 本身，不会动目标目录。
        cmd /c rmdir "$link" | Out-Null
    }
    New-Item -ItemType Junction -Path $link -Target $PluginDir | Out-Null
    Write-Note ('已链接 ' + $PluginName + ' -> ' + $PluginDir)
}

function Remove-PluginJunction {
    $link = Join-Path $ProfileDir ('node_modules\@local\' + $PluginName)
    if (Test-Path $link) {
        cmd /c rmdir "$link" | Out-Null
        Write-Note ('已移除链接 ' + $PluginName)
    }
}

# 读-改-写 profile 的 package.json；只增删本插件自己的条目，不动其他插件。
function Update-ProfilePackageJson([bool]$Remove) {
    $pkgPath = Join-Path $ProfileDir 'package.json'
    if (-not (Test-Path $pkgPath)) { throw ('未找到 profile 配置: ' + $pkgPath) }

    for ($attempt = 1; $attempt -le 5; $attempt++) {
        try {
            $pkg = Get-Content $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json

            if (-not $Remove) {
                # --- 安装：写入 dependencies + bundles ---
                if ($null -eq $pkg.dependencies) {
                    $pkg | Add-Member -MemberType NoteProperty -Name dependencies -Value (New-Object PSObject)
                }
                if ($null -eq $pkg.dsh) {
                    $pkg | Add-Member -MemberType NoteProperty -Name dsh -Value (New-Object PSObject)
                }
                if ($null -eq $pkg.dsh.profile) {
                    $pkg.dsh | Add-Member -MemberType NoteProperty -Name profile -Value (New-Object PSObject)
                }
                if ($null -eq $pkg.dsh.profile.bundles) {
                    $pkg.dsh.profile | Add-Member -MemberType NoteProperty -Name bundles -Value @()
                }
                $linkValue = 'link:' + ($PluginDir -replace '\\', '/')
                $pkg.dependencies | Add-Member -MemberType NoteProperty -Name $PkgName -Value $linkValue -Force
                $bundles = @($pkg.dsh.profile.bundles)
                if ($bundles -notcontains $PkgName) {
                    $pkg.dsh.profile.bundles = $bundles + $PkgName
                }
            } else {
                # --- 卸载：仅移除本插件的条目 ---
                if ($null -ne $pkg.dependencies) {
                    $depProps = $pkg.dependencies.PSObject.Properties | Where-Object { $_.Name -ne $PkgName }
                    $newDeps = New-Object PSObject
                    foreach ($prop in $depProps) { $newDeps | Add-Member -MemberType NoteProperty -Name $prop.Name -Value $prop.Value }
                    $pkg.dependencies = $newDeps
                }
                if ($null -ne $pkg.dsh -and $null -ne $pkg.dsh.profile -and $null -ne $pkg.dsh.profile.bundles) {
                    $pkg.dsh.profile.bundles = @($pkg.dsh.profile.bundles | Where-Object { $_ -ne $PkgName })
                }
            }

            $json = $pkg | ConvertTo-Json -Depth 32
            [System.IO.File]::WriteAllText($pkgPath, $json + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
            return
        } catch {
            if ($attempt -eq 5) { throw }
            Write-Note ('配置文件被占用，重试 ' + $attempt + '/5...')
            Start-Sleep -Seconds 2
        }
    }
}

# ------------------------------ 主流程 ------------------------------

if ($Uninstall) {
    Write-Step ('正在卸载 ' + $PkgName + ' ...')
    if (Test-Path $ProfileDir) {
        Remove-PluginJunction
        Update-ProfilePackageJson $true
    } else {
        Write-Note '未找到 profile，跳过卸载'
    }
    Write-Step '完成。重启 DSH 后生效，仓库文件不会被删除。'
    exit 0
}

Write-Step '正在检查 DSH 安装状态...'
if ($null -eq (Get-DshUninstallKey)) {
    throw '未检测到 DeepSeek Harness。请先安装 DSH 桌面版，再重新运行本脚本。'
}
Write-Note '已检测到 DSH'

Ensure-Profile

Write-Step '正在挂载插件...'
Set-PluginJunction
Update-ProfilePackageJson $false

Write-Step '完成！请启动（或重启）DeepSeek Harness，在插件管理页确认：'
Write-Host ('    ' + $PkgName) -ForegroundColor Green
