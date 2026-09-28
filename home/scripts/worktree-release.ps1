<#
  Libera e remove uma worktree no Windows: encerra processos que a seguram,
  remove com core.longpaths e limpa restos (node_modules profundo, pasta órfã).
  Uso: pwsh -File worktree-release.ps1 -Repo <repo principal> -Worktree <caminho absoluto>
  Saída: linha final "worktree_removed: yes|no (<motivo>)". Exit 0 = removida, 1 = preservada.
  Nunca usa --force: worktree com alterações é preservada.
#>
param(
  [Parameter(Mandatory)][string]$Repo,
  [Parameter(Mandatory)][string]$Worktree,
  [int]$Retries = 3
)
$ErrorActionPreference = 'Stop'

function Norm([string]$p) { ([IO.Path]::GetFullPath($p)).TrimEnd('\', '/').Replace('/', '\') }
function Done([bool]$ok, [string]$why) {
  if ($ok) { Write-Output 'worktree_removed: yes'; exit 0 }
  Write-Output "worktree_removed: no ($why)"; exit 1
}

$Repo = Norm $Repo
$Worktree = Norm $Worktree
Set-Location $Repo  # nunca deixe o cwd desta execução dentro da worktree

if ($Worktree -eq $Repo -or -not $Worktree.StartsWith($Repo + '\', 'OrdinalIgnoreCase') -and -not (Test-Path (Join-Path $Worktree '.git'))) {
  Done $false 'caminho não parece uma worktree'
}

$registered = { (git -C $Repo worktree list --porcelain) -split "`n" |
    Where-Object { $_ -like 'worktree *' } |
    ForEach-Object { Norm ($_.Substring(9).Trim()) } }
if (@(& $registered) -notcontains $Worktree) {
  if (-not (Test-Path $Worktree)) { git -C $Repo worktree prune; Done $true '' }
  Done $false 'pasta existe mas não está registrada no git; identifique a origem antes de apagar'
}

if (Test-Path $Worktree) {
  $dirty = git -C $Worktree status --porcelain
  if ($dirty) { Done $false "alterações pendentes:`n$dirty" }
}

function Get-Holders {
  $needle = $Worktree.ToLowerInvariant()
  $protect = @{}
  $id = $PID
  while ($id) {  # não mate esta sessão nem seus ancestrais
    $protect[[int]$id] = $true
    $id = (Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue).ParentProcessId
    if ($protect.ContainsKey([int]$id)) { break }
  }
  $modRe = '^(node|esbuild|bun|deno|next-server|tsx)$'
  Get-CimInstance Win32_Process | Where-Object { -not $protect.ContainsKey([int]$_.ProcessId) } | Where-Object {
    $cmd = "$($_.CommandLine) $($_.ExecutablePath)".ToLowerInvariant()
    if ($cmd.Contains($needle)) { return $true }
    if ($_.Name -replace '\.exe$', '' -match $modRe) {  # binário nativo carregado da worktree
      try { return [bool](Get-Process -Id $_.ProcessId -ErrorAction Stop).Modules |
          Where-Object { $_.FileName.ToLowerInvariant().StartsWith($needle) } | Select-Object -First 1 } catch { return $false }
    }
    return $false
  }
}

function Wipe([string]$dir) {  # espelha uma pasta vazia: ignora MAX_PATH
  if (-not (Test-Path $dir)) { return }
  $empty = Join-Path ([IO.Path]::GetTempPath()) ('wt-empty-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory $empty | Out-Null
  robocopy $empty $dir /MIR /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Null
  Remove-Item $empty -Force
}

for ($i = 1; $i -le $Retries; $i++) {
  foreach ($p in @(Get-Holders)) {
    Write-Output "encerrando $($p.Name) pid=$($p.ProcessId)"
    taskkill /PID $p.ProcessId /T /F 2>&1 | Out-Null
  }
  Start-Sleep -Seconds 2
  $out = git -c core.longpaths=true -C $Repo worktree remove $Worktree 2>&1
  if ($LASTEXITCODE -eq 0 -and -not (Test-Path $Worktree)) { git -C $Repo worktree prune; Done $true '' }
  if ($i -eq 1) { Wipe (Join-Path $Worktree 'node_modules') }  # caminhos longos são a outra causa comum
}

# git desregistrou mas a pasta sobrou: só é seguro apagar se não há mais registro
if ((Test-Path $Worktree) -and @(& $registered) -notcontains $Worktree) {
  Wipe $Worktree
  Remove-Item $Worktree -Recurse -Force -ErrorAction SilentlyContinue
  git -C $Repo worktree prune
  if (-not (Test-Path $Worktree)) { Done $true '' }
}
$left = @(Get-Holders | ForEach-Object { "$($_.Name)#$($_.ProcessId)" }) -join ', '
Done $false "arquivo em uso ou erro do git: $out; processos: $left"
