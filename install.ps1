$ErrorActionPreference = "Stop"

$PluginId = "memory-viking-local"
$HomeDir = if ($env:USERPROFILE) { $env:USERPROFILE } else { $env:HOME }
$OpenClawDir = Join-Path $HomeDir ".openclaw"
$PluginDest = Join-Path $OpenClawDir "extensions/$PluginId"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not (Get-Command openclaw -ErrorAction SilentlyContinue)) {
  Write-Error "openclaw not found. Install first: npm install -g openclaw"
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Write-Error "npm not found. Install Node.js >= 22"
}

Write-Host "[INFO] Installing $PluginId to $PluginDest"
New-Item -ItemType Directory -Force -Path $PluginDest | Out-Null

$files = @(
  "index.ts",
  "plugin.ts",
  "config.ts",
  "openclaw.plugin.json",
  "package.json",
  ".gitignore",
  "README.md",
  "README.en.md"
)

foreach ($f in $files) {
  $src = Join-Path $ScriptDir $f
  if (Test-Path $src) {
    Copy-Item -Force $src (Join-Path $PluginDest $f)
  }
}

$lock = Join-Path $ScriptDir "package-lock.json"
if (Test-Path $lock) {
  Copy-Item -Force $lock (Join-Path $PluginDest "package-lock.json")
}
$dirs = @("core", "services", "stores", "cli", "setup-helper", "deploy")
foreach ($d in $dirs) {
  $srcDir = Join-Path $ScriptDir $d
  if (Test-Path $srcDir) {
    $destDir = Join-Path $PluginDest $d
    if (Test-Path $destDir) {
      Remove-Item -Recurse -Force $destDir
    }
    Copy-Item -Recurse -Force $srcDir $destDir
  }
}

Push-Location $PluginDest
npm install --omit=dev
Pop-Location

$LocalBinDir = Join-Path $HomeDir ".local/bin"
New-Item -ItemType Directory -Force -Path $LocalBinDir | Out-Null
$VkMemoryWrapper = Join-Path $LocalBinDir "vk-memory.cmd"
$wrapperBody = "@echo off`r`nnode `"$PluginDest\\cli\\vk-memory.js`" %*`r`n"
Set-Content -Path $VkMemoryWrapper -Value $wrapperBody -Encoding ASCII

Write-Host "[INFO] Configuring OpenClaw memory slot"
openclaw config set plugins.enabled true
openclaw config set plugins.slots.memory $PluginId
openclaw config set "plugins.entries.$PluginId.config.envConfigPath" "~/.viking-memory/plugin.env.json"
openclaw config set "plugins.entries.$PluginId.config.rootDir" "~/.viking-memory"
openclaw config set "plugins.entries.$PluginId.config.recallLimit" 6
openclaw config set "plugins.entries.$PluginId.config.recallScoreThreshold" 0.12
openclaw config set "plugins.entries.$PluginId.config.timelineRecallLimit" 4
openclaw config set "plugins.entries.$PluginId.config.timelineScoreThreshold" 0.08

if (-not (($env:PATH + ";").ToLower().Contains(($LocalBinDir + ";").ToLower()))) {
  Write-Host "[WARN] $LocalBinDir is not in PATH."
  Write-Host "[WARN] Add it to your user PATH so vk-memory can be called globally."
}

Write-Host "[OK] Install completed."
Write-Host "[INFO] Use vk-memory commands:"
Write-Host "       vk-memory setup | config | start | stop | status"
Write-Host "[INFO] First run: vk-memory setup && vk-memory start"
Write-Host "[INFO] Then run: openclaw gateway"
