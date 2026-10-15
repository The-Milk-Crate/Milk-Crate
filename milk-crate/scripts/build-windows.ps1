# Milk Crate - one-step Windows build.
# Run by double-clicking "Build Milk Crate.bat" in the project folder.
# Installs what's missing (with your OK), builds the app, and puts
# "Milk Crate.exe" and an installer in the "release" folder.

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Say($msg, $color = "Gray") { Write-Host $msg -ForegroundColor $color }
function Has($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User") + ";$env:USERPROFILE\.cargo\bin"
}
function Has-MsvcTools {
  $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
  if (-not (Test-Path $vswhere)) { return $false }
  $found = & $vswhere -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  return [bool]$found
}
function Ask($question) {
  $answer = Read-Host "$question [Y/n]"
  return ($answer -eq "" -or $answer -match "^[Yy]")
}

Say ""
Say "  MILK CRATE - building the desktop app" "Magenta"
Say ""

# ---------- 1. Prerequisites ----------
Refresh-Path
$missing = @()
if (-not (Has "node"))  { $missing += "Node.js LTS" }
if (-not (Has "cargo")) { $missing += "Rust" }
if (-not (Has-MsvcTools)) { $missing += "Microsoft C++ Build Tools" }

if ($missing.Count -gt 0) {
  Say "Missing: $($missing -join ', ')" "Yellow"
  if (-not (Has "winget")) {
    Say "winget isn't available, so install these by hand (see README.md), then run this again." "Red"
    exit 1
  }
  if (-not (Ask "Install them now with winget? (A few GB for the C++ tools; takes 10-20 minutes the first time)")) {
    Say "Okay - install them by hand (see README.md), then run this again." "Yellow"
    exit 1
  }
  if ($missing -contains "Node.js LTS") {
    winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
  }
  if ($missing -contains "Microsoft C++ Build Tools") {
    winget install --id Microsoft.VisualStudio.2022.BuildTools -e --accept-source-agreements --accept-package-agreements `
      --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
  }
  if ($missing -contains "Rust") {
    winget install --id Rustlang.Rustup -e --accept-source-agreements --accept-package-agreements
    Refresh-Path
    rustup default stable-msvc
  }
  Refresh-Path
  if (-not (Has "node") -or -not (Has "cargo")) {
    Say "Installed. Close this window and double-click 'Build Milk Crate.bat' again so Windows picks up the new tools." "Yellow"
    Read-Host "Press Enter to close"
    exit 0
  }
}
Say "Node $(node -v), $(cargo --version)" "DarkGray"

# ---------- 2. Build ----------
Say "Installing JavaScript packages..." "Cyan"
npm install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw "npm install failed" }

Say "Building (the first build compiles Rust and takes several minutes)..." "Cyan"
npx tauri build --bundles nsis
if ($LASTEXITCODE -ne 0) { throw "Build failed - scroll up for the first error." }

# ---------- 3. Collect the results ----------
$out = Join-Path $root "release"
New-Item -ItemType Directory -Force -Path $out | Out-Null
Copy-Item "src-tauri\target\release\milk-crate.exe" (Join-Path $out "Milk Crate.exe") -Force
Get-ChildItem "src-tauri\target\release\bundle\nsis\*.exe" | Copy-Item -Destination $out -Force

Say ""
Say "Done." "Green"
Say "  release\Milk Crate.exe        - run it directly, no install needed" "Green"
Say "  release\*-setup.exe           - installer with a Start menu shortcut" "Green"
Say ""
Start-Process explorer.exe $out
if (Ask "Open Milk Crate now?") { Start-Process (Join-Path $out "Milk Crate.exe") }
