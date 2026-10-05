# Motes installer for Windows (PowerShell).
#   From a clone:   powershell -ExecutionPolicy Bypass -File install.ps1
#   From the web:   irm https://raw.githubusercontent.com/koushikvarma37-jpg/claude/main/install.ps1 | iex
# Installs Motes into %USERPROFILE%\.motes\venv, adds it to your PATH, then runs `motes setup`.
$ErrorActionPreference = "Stop"
$Repo = if ($env:MOTES_REPO) { $env:MOTES_REPO } else { "https://github.com/koushikvarma37-jpg/claude" }
$Home_ = Join-Path $env:USERPROFILE ".motes"
$Venv = Join-Path $Home_ "venv"

$py = $null
foreach ($cand in @("py -3", "python")) {
  try {
    $ok = & cmd /c "$cand -c ""import sys; print(sys.version_info >= (3, 10))""" 2>$null
    if ($ok -eq "True") { $py = $cand; break }
  } catch {}
}
if (-not $py) {
  Write-Host "Motes needs Python 3.10 or newer. Install it from https://www.python.org/downloads/ (tick 'Add to PATH') and run this again."
  exit 1
}

Write-Host "Installing Motes..." -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $Home_ | Out-Null
& cmd /c "$py -m venv ""$Venv"""
$pip = Join-Path $Venv "Scripts\pip.exe"
& $pip install --quiet --upgrade pip
$here = if ($PSScriptRoot) { $PSScriptRoot } else { "" }
if ($here -and (Test-Path (Join-Path $here "pyproject.toml"))) { & $pip install --quiet $here }
else { & $pip install --quiet "git+$Repo" }

$scripts = Join-Path $Venv "Scripts"
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$scripts*") {
  [Environment]::SetEnvironmentVariable("Path", "$userPath;$scripts", "User")
  $env:Path = "$env:Path;$scripts"
  Write-Host "Added Motes to your PATH (open a new terminal to use 'motes' everywhere)."
}

if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
  Write-Host "Motes runs on Ollama, which isn't installed yet." -ForegroundColor Yellow
  Write-Host "  Install it with:  winget install Ollama.Ollama   (or https://ollama.com/download)"
  Write-Host "Then run:  motes setup; motes up"
  exit 0
}
& (Join-Path $scripts "motes.exe") setup
Write-Host "Done. Start Motes with:  motes up" -ForegroundColor Green
