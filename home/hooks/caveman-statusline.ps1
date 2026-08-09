$ClaudeDir = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HOME ".claude" }

# Without this, PowerShell decodes external-process stdout (ccusage/node) using
# the console codepage (e.g. cp850) instead of UTF-8, mangling emoji and the
# "▪" separator into "?". Must be set before the ccusage call below.
# $OutputEncoding (used to encode our string when piped INTO ccusage's stdin)
# must be UTF-8 *without* BOM — the plain [System.Text.Encoding]::UTF8 static
# instance prepends a BOM, which breaks ccusage's JSON parser on the input.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = New-Object System.Text.UTF8Encoding $false

# Claude Code pipes the status-line JSON payload on stdin. Capture it once so
# it can be forwarded to ccusage below, regardless of whether caveman mode
# itself is active.
$StdinJson = [Console]::In.ReadToEnd()

$Esc = [char]27
$Neutral = '38;5;244'
$Dim = '38;5;240'
function Get-ThresholdColor([double]$Pct) {
    if ($Pct -lt 50) { return '38;5;108' }   # verde: uso baixo
    elseif ($Pct -lt 80) { return '38;5;179' } # amarelo: uso medio
    else { return '38;5;167' }               # vermelho: uso alto
}

# Tetos em USD pra converter custo (ccusage) em % de "limite" — Anthropic nao
# expoe o teto real por API/hook. Calibrado 2026-08-06 comparando com o app da
# Anthropic: block $88.40 = 5% real -> teto sessao ~$1768; semana $659 = 60%
# real -> teto semanal ~$1098. Custo ccusage usa pricing de API list price, que
# nao necessariamente escala 1:1 com a unidade de quota interna da Anthropic
# (mix de modelo, cache hit ratio etc mudam a razao $/quota) — recalibrar de
# vez em quando comparando com o app. Ajustavel via env var sem editar o script.
$SessionCapUsd = if ($env:CAVEMAN_SESSION_CAP_USD) { [double]$env:CAVEMAN_SESSION_CAP_USD } else { 1768.0 }
$WeeklyCapUsd = if ($env:CAVEMAN_WEEKLY_CAP_USD) { [double]$env:CAVEMAN_WEEKLY_CAP_USD } else { 1098.0 }
$WeeklyCacheTtlSec = if ($env:CAVEMAN_WEEKLY_CACHE_SECONDS) { [double]$env:CAVEMAN_WEEKLY_CACHE_SECONDS } else { 300.0 }

if ($env:CAVEMAN_STATUSLINE_USAGE -ne "0") {
    try {
        # ccusage statusline: chamada rapida (cache proprio), da contexto% + custo
        # do block de 5h (nosso proxy pro "limite de sessao" real da Anthropic).
        $Raw = $StdinJson | & ccusage statusline --visual-burn-rate off 2>$null
        if ($LASTEXITCODE -eq 0 -and $Raw) {
            $Raw = ($Raw -join ' ').Trim()
            $Segments = @()

            # 1. Contexto % — ccusage prints "121,632 (12%)" quando conhece a
            # janela de contexto do modelo, senao so a contagem crua de tokens.
            if ($Raw -match '🧠[^%]*\(([\d.]+)%\)') {
                $Color = Get-ThresholdColor ([double]$Matches[1])
                $Segments += "${Esc}[${Color}mContexto $([Math]::Round([double]$Matches[1]))%${Esc}[0m"
            } elseif ($Raw -match '🧠\s*(\S+)') {
                $Segments += "${Esc}[${Neutral}mContexto $($Matches[1])${Esc}[0m"
            }

            # 2. Sessao % — custo do block de 5h (rate-limit window) vs teto estimado.
            if ($Raw -match '\$([\d.]+)\s*block') {
                $SessPct = [double]$Matches[1] / $SessionCapUsd * 100
                $Color = Get-ThresholdColor $SessPct
                $Segments += "${Esc}[${Color}mSessão $([Math]::Round($SessPct))%${Esc}[0m"
            }

            # 3. Limite Semanal % — custo da semana corrente (cache 5min, scan
            # completo do historico local e lento demais pra rodar toda linha).
            $WeeklyCacheFile = Join-Path $ClaudeDir ".caveman-weekly-cache.json"
            $WeeklyCost = $null
            $CacheFresh = $false
            if (Test-Path $WeeklyCacheFile) {
                try {
                    $CacheItem = Get-Item -LiteralPath $WeeklyCacheFile -Force -ErrorAction Stop
                    if (-not ($CacheItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -and $CacheItem.Length -le 256) {
                        $CacheObj = Get-Content -LiteralPath $WeeklyCacheFile -Raw -ErrorAction Stop | ConvertFrom-Json
                        $AgeSec = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - [double]$CacheObj.ts
                        if ($AgeSec -ge 0 -and $AgeSec -lt $WeeklyCacheTtlSec) {
                            $WeeklyCost = [double]$CacheObj.cost
                            $CacheFresh = $true
                        }
                    }
                } catch {}
            }
            if (-not $CacheFresh) {
                try {
                    $WeeklyRaw = & ccusage weekly --json --offline 2>$null | Out-String
                    if ($LASTEXITCODE -eq 0 -and $WeeklyRaw) {
                        $WeeklyObj = $WeeklyRaw | ConvertFrom-Json
                        $Weeks = @($WeeklyObj.weekly)
                        if ($Weeks.Count -gt 0) {
                            $WeeklyCost = [double]$Weeks[$Weeks.Count - 1].totalCost
                            $Nowts = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
                            (@{ ts = $Nowts; cost = $WeeklyCost } | ConvertTo-Json -Compress) |
                                Set-Content -LiteralPath $WeeklyCacheFile -Encoding utf8 -ErrorAction Stop
                        }
                    }
                } catch {}
            }
            if ($null -ne $WeeklyCost) {
                $WeekPct = $WeeklyCost / $WeeklyCapUsd * 100
                $Color = Get-ThresholdColor $WeekPct
                $Segments += "${Esc}[${Color}mLimite Semanal $([Math]::Round($WeekPct))%${Esc}[0m"
            }

            # 4. Modelo
            if ($Raw -match '🤖\s*([^|]+?)\s*(?:\||$)') {
                $Segments += "${Esc}[${Neutral}m$($Matches[1].Trim())${Esc}[0m"
            }

            if ($Segments.Count -gt 0) {
                $Sep = "${Esc}[${Dim}m ▪ ${Esc}[0m"
                [Console]::Write(($Segments -join $Sep))
            }
        }
    } catch {}
}

$Flag = Join-Path $ClaudeDir ".caveman-active"
if (-not (Test-Path $Flag)) { exit 0 }
[Console]::Write("  ")

# Refuse reparse points (symlinks / junctions) and oversized files. Without
# this, a local attacker could point the flag at a secret file and have the
# statusline render its bytes (including ANSI escape sequences) to the terminal
# every keystroke.
try {
    $Item = Get-Item -LiteralPath $Flag -Force -ErrorAction Stop
    if ($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { exit 0 }
    if ($Item.Length -gt 64) { exit 0 }
} catch {
    exit 0
}

$Mode = ""
try {
    $Raw = Get-Content -LiteralPath $Flag -TotalCount 1 -ErrorAction Stop
    if ($null -ne $Raw) { $Mode = ([string]$Raw).Trim() }
} catch {
    exit 0
}

# Strip anything outside [a-z0-9-] — blocks terminal-escape and OSC hyperlink
# injection via the flag contents. Then whitelist-validate.
$Mode = $Mode.ToLowerInvariant()
$Mode = ($Mode -replace '[^a-z0-9-]', '')

$Valid = @('off','lite','full','ultra','wenyan-lite','wenyan','wenyan-full','wenyan-ultra','commit','review','compress')
if (-not ($Valid -contains $Mode)) { exit 0 }

$Esc = [char]27
if ([string]::IsNullOrEmpty($Mode) -or $Mode -eq "full") {
    [Console]::Write("${Esc}[38;5;172m[CAVEMAN]${Esc}[0m")
} else {
    $Suffix = $Mode.ToUpperInvariant()
    [Console]::Write("${Esc}[38;5;172m[CAVEMAN:$Suffix]${Esc}[0m")
}

# Savings suffix: on by default. Opt out via CAVEMAN_STATUSLINE_SAVINGS=0.
# Reads a pre-rendered string written by caveman-stats.js. Refuses reparse
# points and strips control bytes (matches statusline.sh hardening). Until
# /caveman-stats has run at least once, the suffix file is absent and nothing
# is rendered — safe default for fresh installs.
if ($env:CAVEMAN_STATUSLINE_SAVINGS -ne "0") {
    $SavingsFile = Join-Path $ClaudeDir ".caveman-statusline-suffix"
    if (Test-Path $SavingsFile) {
        try {
            $SavingsItem = Get-Item -LiteralPath $SavingsFile -Force -ErrorAction Stop
            if (-not ($SavingsItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -and
                $SavingsItem.Length -le 64) {
                $Savings = (Get-Content -LiteralPath $SavingsFile -Raw -ErrorAction Stop).TrimEnd()
                $Savings = ($Savings -replace '[\x00-\x1F]', '')
                if ($Savings.Length -gt 0) {
                    [Console]::Write(" ${Esc}[38;5;172m$Savings${Esc}[0m")
                }
            }
        } catch {}
    }
}
