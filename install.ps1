# Claude Code dotfiles bootstrap — Windows (PowerShell 7+)
# Run this on any new Windows machine:
#   git clone https://github.com/LeonardoChiarelli/claude-dotfiles.git $HOME\dotfiles\claude
#   pwsh -File $HOME\dotfiles\claude\install.ps1
#
# This is the Windows counterpart to install.sh. It mirrors the same steps but
# COPIES files instead of symlinking (Windows symlinks require admin/Developer
# Mode), installs jq via winget and rtk via its installer, and wires the rtk
# PreToolUse hook through Git Bash.

$ErrorActionPreference = 'Stop'

$DotfilesDir = $PSScriptRoot
$ClaudeDir   = Join-Path $HOME '.claude'

function Write-Step($msg) { Write-Host $msg -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "[ok]   $msg" -ForegroundColor Green }
function Write-Skip($msg) { Write-Host "[skip] $msg" -ForegroundColor DarkGray }
function Write-Warn2($msg){ Write-Host "[warn] $msg" -ForegroundColor Yellow }

Write-Step "==> Claude dotfiles bootstrap (Windows)"
Write-Host "    Dotfiles: $DotfilesDir"
Write-Host "    Target:   $ClaudeDir"
Write-Host ""

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

# ── 1. Create ~/.claude if missing ────────────────────────────────────────
New-Item -ItemType Directory -Force -Path $ClaudeDir | Out-Null
New-Item -ItemType Directory -Force -Path $LocalBin  | Out-Null
if (Add-UserPath $LocalBin) { Write-Ok "added $LocalBin to user PATH" }

# ── 2. Sync skills (copy — preserves any pre-existing skill/symlink) ───────
$skillsTarget = Join-Path $ClaudeDir 'skills'
New-Item -ItemType Directory -Force -Path $skillsTarget | Out-Null
Get-ChildItem -Directory (Join-Path $DotfilesDir 'skills') | ForEach-Object {
    $target = Join-Path $skillsTarget $_.Name
    if (Test-Path $target) {
        Write-Skip "~/.claude/skills/$($_.Name) already exists"
    } else {
        Copy-Item -Recurse -Path $_.FullName -Destination $target
        Write-Ok "~/.claude/skills/$($_.Name) installed"
    }
}

# ── 3. Install CLAUDE.md (symlink if allowed, else copy) ──────────────────
$claudeMdSrc    = Join-Path $DotfilesDir 'CLAUDE.md'
$claudeMdTarget = Join-Path $ClaudeDir   'CLAUDE.md'
function Install-Linked($src, $target, $label) {
    if (Test-Path $target) {
        $existing = Get-Item $target
        if ($existing.LinkType -eq 'SymbolicLink') { Write-Skip "$label already symlinked"; return }
        $bak = "$target.bak"
        Write-Warn2 "$label exists — backing up to $bak"
        Move-Item -Force $target $bak
    }
    try {
        New-Item -ItemType SymbolicLink -Path $target -Target $src -ErrorAction Stop | Out-Null
        Write-Ok "$label -> $src (symlink)"
    } catch {
        Copy-Item -Force $src $target
        Write-Ok "$label copied (symlink needs admin/Developer Mode; re-run after 'git pull' to refresh)"
    }
}
Install-Linked $claudeMdSrc $claudeMdTarget '~/.claude/CLAUDE.md'

# ── 4. Merge settings.json (does NOT overwrite settings.local.json) ───────
$settingsSrc    = Join-Path $DotfilesDir 'settings.json'
$settingsTarget = Join-Path $ClaudeDir   'settings.json'

function Test-JsonObject($v) {
    return ($null -ne $v) -and ($v.GetType().Name -eq 'PSCustomObject')
}
function Merge-Json($base, $overlay) {
    # Deep-merge: overlay wins on scalar/array conflicts, recurse into objects.
    $result = [ordered]@{}
    foreach ($k in $base.PSObject.Properties.Name) { $result[$k] = $base.$k }
    foreach ($p in $overlay.PSObject.Properties) {
        if ($result.Contains($p.Name) -and (Test-JsonObject $result[$p.Name]) -and (Test-JsonObject $p.Value)) {
            $result[$p.Name] = Merge-Json $result[$p.Name] $p.Value
        } else {
            $result[$p.Name] = $p.Value
        }
    }
    return [pscustomobject]$result
}

if (-not (Test-Path $settingsTarget)) {
    Copy-Item $settingsSrc $settingsTarget
    Write-Ok "~/.claude/settings.json created from template"
} else {
    $existing = Get-Content $settingsTarget -Raw | ConvertFrom-Json
    $template = Get-Content $settingsSrc -Raw    | ConvertFrom-Json
    $merged   = Merge-Json $existing $template
    $merged | ConvertTo-Json -Depth 20 | Set-Content -Path $settingsTarget -Encoding utf8
    Write-Ok "~/.claude/settings.json merged with template (existing keys preserved)"
}

# ── 5. Install jq (needed by the rtk hook) ────────────────────────────────
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

# ── 6. Install rtk (token-efficient CLI proxy) ────────────────────────────
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

# ── 7. Copy rtk hook script ───────────────────────────────────────────────
$hooksDir = Join-Path $ClaudeDir 'hooks'
New-Item -ItemType Directory -Force -Path $hooksDir | Out-Null
Copy-Item -Force (Join-Path $DotfilesDir 'hooks\rtk-rewrite.sh') (Join-Path $hooksDir 'rtk-rewrite.sh')
Write-Ok "~/.claude/hooks/rtk-rewrite.sh installed"

# ── 8. Configure rtk hook in settings.local.json ─────────────────────────
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

# ── 9. Install caveman (output compression plugin) ────────────────────────
Write-Host ""
Write-Step "==> Installing caveman..."
if ($Bash) {
    & $Bash -lc "curl -fsSL https://raw.githubusercontent.com/JuliusBrussee/caveman/main/install.sh | bash"
    Write-Ok "caveman installed"
} else {
    Write-Warn2 "Git Bash not found — install caveman manually: https://github.com/JuliusBrussee/caveman"
}

# ── 10. Manual steps reminder ─────────────────────────────────────────────
Write-Host ""
Write-Step "==> Done! One manual step remaining:"
Write-Host ""
Write-Host "    Install context-mode plugin (run inside Claude Code):"
Write-Host "      /plugin marketplace add mksglu/context-mode"
Write-Host "      /plugin install context-mode@context-mode"
Write-Host "    Then restart Claude Code."
Write-Host ""
Write-Step "==> Summary of what was installed:"
Write-Host "    - ~/.claude/skills    <- copied from $DotfilesDir\skills"
Write-Host "    - ~/.claude/CLAUDE.md <- from $DotfilesDir\CLAUDE.md"
Write-Host "    - jq  (required by the rtk hook)"
Write-Host "    - rtk (CLI token proxy, 60-90% savings)"
Write-Host "    - caveman (output compression, ~75% savings)"
Write-Host "    - context-mode: install manually in Claude Code (see above)"
