# Claude Code dotfiles bootstrap — Windows (PowerShell 7+)
#   git clone https://github.com/LeonardoChiarelli/claude-dotfiles.git $HOME\dotfiles\claude
#   pwsh -File $HOME\dotfiles\claude\install.ps1 [-DryRun]
param([switch]$DryRun)

$ErrorActionPreference = 'Stop'
$DotfilesDir = $PSScriptRoot
$ClaudeDir   = if ($env:CLAUDE_HOME) { $env:CLAUDE_HOME } else { Join-Path $HOME '.claude' }

function Write-Step($msg) { Write-Host $msg -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "[ok]   $msg" -ForegroundColor Green }
function Write-Skip($msg) { Write-Host "[skip] $msg" -ForegroundColor DarkGray }
function Write-Warn2($msg){ Write-Host "[warn] $msg" -ForegroundColor Yellow }

if (-not (Get-Command git  -ErrorAction SilentlyContinue)) { throw "git is required" }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js is required: https://nodejs.org" }

Write-Step "==> Claude dotfiles bootstrap (Windows)"
Write-Host "    Dotfiles: $DotfilesDir"
Write-Host "    Target:   $ClaudeDir"
Write-Host ""

# ── 1. Config, memory, MCP — manifest-driven ──────────────────────────────
$dryArg = if ($DryRun) { '--dry-run' } else { $null }
& node (Join-Path $DotfilesDir 'tools\dotfiles.mjs') install $dryArg
if ($LASTEXITCODE -ne 0) { throw "dotfiles.mjs install failed" }
if ($DryRun) { Write-Warn2 "dry-run: stopping before toolchain install"; exit 0 }

# Resolve a bash.exe for hook + remote-script execution (Git Bash preferred).
function Get-BashPath {
    $candidates = @(
        (Get-Command bash.exe -ErrorAction SilentlyContinue | Where-Object { $_.Source -notmatch 'System32' } | Select-Object -First 1).Source,
        'C:\Program Files\Git\bin\bash.exe',
        'C:\Program Files\Git\usr\bin\bash.exe'
    )
    foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { return $c } }
    return $null
}
$Bash = Get-BashPath

# Shared user-level bin dir for portable single-file tools (rtk, jq). It is on
# PATH for both PowerShell and Git Bash, so the hook finds tools immediately —
# no shell restart needed (winget's PATH change only applies to new shells).
$LocalBin = Join-Path $HOME '.local\bin'
function Add-UserPath($dir) {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (($userPath -split ';') -notcontains $dir) {
        [Environment]::SetEnvironmentVariable('Path', (($userPath.TrimEnd(';') + ';' + $dir).TrimStart(';')), 'User')
        $env:Path = "$env:Path;$dir"
        return $true
    }
    return $false
}

# ── 2. Dirs + user PATH for portable tools ────────────────────────────────
New-Item -ItemType Directory -Force -Path $ClaudeDir | Out-Null
New-Item -ItemType Directory -Force -Path $LocalBin  | Out-Null
if (Add-UserPath $LocalBin) { Write-Ok "added $LocalBin to user PATH" }

# ── 3. Install jq (needed by the rtk hook) ────────────────────────────────
Write-Host ""
Write-Step "==> Installing jq..."
if (Test-Path (Join-Path $LocalBin 'jq.exe')) {
    Write-Skip "jq already in $LocalBin"
} elseif (Get-Command winget -ErrorAction SilentlyContinue) {
    winget install --id jqlang.jq --accept-source-agreements --accept-package-agreements -e --silent
    # winget's PATH alias only applies to new shells; copy the portable exe into
    # $LocalBin so the rtk hook (run via Git Bash) sees jq right away.
    $jqExe = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Recurse -Filter 'jq.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($jqExe) { Copy-Item -Force $jqExe.FullName (Join-Path $LocalBin 'jq.exe'); Write-Ok "jq installed (winget) and copied to $LocalBin" }
    else { Write-Ok "jq installed via winget (restart shell to use)" }
} else {
    Write-Warn2 "winget not found. Install jq manually: https://jqlang.github.io/jq/download/"
}

# ── 4. Install rtk (token-efficient CLI proxy) ────────────────────────────
# The upstream install.sh has no Windows branch, but the release ships a
# prebuilt MSVC binary. Download the zip, drop rtk.exe in ~/.local/bin, and put
# that dir on the user PATH.
Write-Host ""
Write-Step "==> Installing rtk..."
function Install-RtkWindows {
    $rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/rtk-ai/rtk/releases/latest' -Headers @{ 'User-Agent' = 'claude-dotfiles' }
    $asset = $rel.assets | Where-Object { $_.name -match 'windows-msvc.*\.zip$' } | Select-Object -First 1
    if (-not $asset) { throw "No Windows rtk asset found in latest release." }
    $zip = Join-Path $env:TEMP $asset.name
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip -Headers @{ 'User-Agent' = 'claude-dotfiles' }
    $tmp = Join-Path $env:TEMP 'rtk-extract'
    if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    $exe = Get-ChildItem -Recurse -Filter 'rtk.exe' -Path $tmp | Select-Object -First 1
    if (-not $exe) { throw "rtk.exe not found inside $($asset.name)." }
    Copy-Item -Force $exe.FullName (Join-Path $LocalBin 'rtk.exe')
    Remove-Item -Force $zip; Remove-Item -Recurse -Force $tmp
}
if ((Get-Command rtk -ErrorAction SilentlyContinue) -or (Test-Path (Join-Path $LocalBin 'rtk.exe'))) {
    Write-Skip "rtk already installed"
} else {
    try {
        Install-RtkWindows
        Write-Ok "rtk installed to $LocalBin\rtk.exe"
    } catch {
        Write-Warn2 "Automatic rtk install failed: $($_.Exception.Message)"
        if (Get-Command cargo -ErrorAction SilentlyContinue) {
            cargo install rtk; Write-Ok "rtk installed via cargo"
        } else {
            Write-Warn2 "Install manually from https://github.com/rtk-ai/rtk/releases (rtk-x86_64-pc-windows-msvc.zip)"
        }
    }
}

# ── 5. Configure rtk hook in settings.local.json ─────────────────────────
# rtk-rewrite.sh already arrived at ~/.claude/hooks via dotfiles.mjs install.
$hooksDir      = Join-Path $ClaudeDir 'hooks'
$localSettings = Join-Path $ClaudeDir 'settings.local.json'
$hookSh = ((Join-Path $hooksDir 'rtk-rewrite.sh') -replace '\\','/')
$bashCmd = if ($Bash) { "`"$($Bash -replace '\\','/')`" `"$hookSh`"" } else { "bash `"$hookSh`"" }

$hookEntry = [pscustomobject]@{
    matcher = 'Bash'
    hooks   = @([pscustomobject]@{ type = 'command'; command = $bashCmd })
}
if (-not (Test-Path $localSettings)) {
    $local = [ordered]@{
        permissions = [ordered]@{ allow = @() }
        hooks       = [ordered]@{ PreToolUse = @($hookEntry) }
    }
    ($local | ConvertTo-Json -Depth 20) | Set-Content -Path $localSettings -Encoding utf8
    Write-Ok "~/.claude/settings.local.json created with rtk PreToolUse hook"
} else {
    # File may already exist (Claude Code auto-creates it for permissions).
    # Merge the rtk hook in without clobbering existing keys; skip if present.
    $s = Get-Content $localSettings -Raw | ConvertFrom-Json
    $has = $false
    if ($s.PSObject.Properties.Name -contains 'hooks' -and $s.hooks.PSObject.Properties.Name -contains 'PreToolUse') {
        $has = [bool]($s.hooks.PreToolUse | Where-Object { ($_.hooks.command -join '') -match 'rtk-rewrite' })
    }
    if ($has) {
        Write-Skip "rtk hook already present in settings.local.json"
    } else {
        if (-not ($s.PSObject.Properties.Name -contains 'hooks')) {
            $s | Add-Member -NotePropertyName hooks -NotePropertyValue ([pscustomobject]@{ PreToolUse = @($hookEntry) })
        } elseif (-not ($s.hooks.PSObject.Properties.Name -contains 'PreToolUse')) {
            $s.hooks | Add-Member -NotePropertyName PreToolUse -NotePropertyValue @($hookEntry)
        } else {
            $s.hooks.PreToolUse = @($s.hooks.PreToolUse) + $hookEntry
        }
        ($s | ConvertTo-Json -Depth 20) | Set-Content -Path $localSettings -Encoding utf8
        Write-Ok "rtk PreToolUse hook merged into existing settings.local.json"
    }
}

Write-Host ""
Write-Step "==> Done. Final steps:"
Write-Host "    1. Open Claude Code once - plugins in settings.json auto-install."
Write-Host "    2. MCP servers with OAuth (sentry, neon, context7) authenticate on first use."
Write-Host "    3. Check output above for any [warn] lines."
