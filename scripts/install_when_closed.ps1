# Guarded installer: wait until deadlock.exe is fully gone and stable,
# then back up the installed VPK and swap in the fresh build.
# Rule: never install while the game is running. We re-check the process
# right before the copy to avoid the "crash → auto-restart" race that would
# leave a half-written VPK on disk.
param(
  [string]$Src = "F:\BabelTower\dist\pak01_dir.vpk",
  [string]$Dst = "F:\SteamLibrary\steamapps\common\Deadlock\game\citadel\addons\pak15_dir.vpk",
  [string]$Tag = "pre-targethero",
  [int]$PollSec = 5,
  [int]$StableSec = 15
)

$log = "F:\BabelTower\logs\install_when_closed.log"
function W($m) {
  Add-Content -Path $log -Value ((Get-Date).ToString('HH:mm:ss') + "  " + $m) -Encoding UTF8
}

W "armed: waiting for game to close   src=$Src"
if (-not (Test-Path $Src)) { W "ABORT: source missing"; exit 1 }
if (-not (Test-Path $Dst)) { W "ABORT: dest missing"; exit 1 }

# 1) wait for the process to disappear
while (Get-Process -Name deadlock -ErrorAction SilentlyContinue) {
  Start-Sleep -Seconds $PollSec
}
W "process gone"

# 2) stability window: make sure it is not crash-and-relaunch
Start-Sleep -Seconds $StableSec
if (Get-Process -Name deadlock -ErrorAction SilentlyContinue) {
  W "ABORT: game came back during stability window"; exit 1
}

# 3) final check right before the copy
if (Get-Process -Name deadlock -ErrorAction SilentlyContinue) {
  W "ABORT: game running at final check"; exit 1
}

$srcLen = (Get-Item $Src).Length
$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$bk = "$Dst.bak-$Tag-$ts"
Copy-Item -Path $Dst -Destination $bk -Force
if (-not (Test-Path $bk)) { W "ABORT: backup failed"; exit 1 }
W "backup -> $bk  (" + (Get-Item $bk).Length + " B)"

# 4) copy to a temp file first, then rename - never leave a partial VPK
$tmp = "$Dst.new"
if (Test-Path $tmp) { Remove-Item $tmp -Force }
Copy-Item -Path $Src -Destination $tmp -Force
if ((Get-Item $tmp).Length -ne $srcLen) {
  Remove-Item $tmp -Force
  W "ABORT: temp copy size mismatch"; exit 1
}
Move-Item -Path $tmp -Destination $Dst -Force

if ((Get-Item $Dst).Length -ne $srcLen) { W "ABORT: dest size mismatch"; exit 1 }
$sha = (Get-FileHash -Path $Dst -Algorithm SHA256).Hash
W "installed: size=" + (Get-Item $Dst).Length + "  sha256=" + $sha.Substring(0, 16)
W "DONE - relaunch the game to pick up the fix"
