# ==============================================================================
# Sky Wifi LuCI Application - Offline Uninstaller (Windows PowerShell)
# Deploys from Windows PC to OpenWrt Router via SSH
# ==============================================================================

$SSH_OPTS = @("-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR")

Write-Host -ForegroundColor Cyan "=========================================================="
Write-Host -ForegroundColor Cyan "        Sky Wifi OpenWrt Router Offline Uninstaller         "
Write-Host -ForegroundColor Cyan "=========================================================="

# Check for SSH in system path
if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) {
    Write-Host -ForegroundColor Red "Error: SSH client not found in system path."
    Write-Host -ForegroundColor Yellow "Please ensure OpenSSH Client is installed on Windows."
    Write-Host -ForegroundColor Yellow "  Settings > Apps > Optional Features > OpenSSH Client"
    Exit 1
}

# 1. Get Router IP
$RouterIP = $args[0]
if ([string]::IsNullOrEmpty($RouterIP)) {
    $inputIP = Read-Host "Enter Router IP address [default: 192.168.1.1]"
    $RouterIP = if ([string]::IsNullOrWhiteSpace($inputIP)) { "192.168.1.1" } else { $inputIP.Trim() }
}

# 2. Ask whether to purge historical data
$PurgeData = $args[1]
if ([string]::IsNullOrEmpty($PurgeData)) {
    $confirmPurge = Read-Host "Purge historical traffic data & configs? (y/N)"
    $PurgeData = if ($confirmPurge -match "^[yY]([eE][sS])?$") { "yes" } else { "no" }
}

Write-Host ""
Write-Host -ForegroundColor Cyan "=========================================================="
Write-Host -ForegroundColor Cyan "   Connecting to Router ($RouterIP) ..."
Write-Host -ForegroundColor Cyan "=========================================================="

# 3. Test SSH Connection
Write-Host -ForegroundColor Blue "`n[1/2] Testing SSH connection to root@$RouterIP ..."
$sshTest = & ssh @SSH_OPTS "root@$RouterIP" "echo connection_ok" 2>$null
if ($LASTEXITCODE -ne 0 -or "$sshTest" -notmatch "connection_ok") {
    Write-Host -ForegroundColor Red "Error: Could not connect to root@$RouterIP via SSH."
    Exit 1
}
Write-Host -ForegroundColor Green "[OK] SSH connection successful."

# Helper: run a shell script on router via stdin pipe
function Invoke-RouterScript {
    param([string]$ScriptContent)
    $tmpFile = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "skywifi_tmp_$([System.Guid]::NewGuid().ToString('N')).sh")
    try {
        [System.IO.File]::WriteAllText($tmpFile, $ScriptContent, [System.Text.Encoding]::ASCII)
        Get-Content $tmpFile -Raw | & ssh @SSH_OPTS "root@$RouterIP" "sh -s" 2>$null
    } finally {
        if (Test-Path $tmpFile) { Remove-Item $tmpFile -Force -ErrorAction SilentlyContinue }
    }
}

# 4. Remove skywifi
Write-Host -ForegroundColor Blue "`n[2/2] Removing skywifi package and binaries from router ..."

$purgeFlag = if ($PurgeData -eq "yes") { "1" } else { "0" }

$uninstallScript = "PURGE_DATA='$purgeFlag'
" + @'
[ -x /etc/init.d/skywifi ] && /etc/init.d/skywifi stop >/dev/null 2>&1 || true
[ -x /etc/init.d/skywifi ] && /etc/init.d/skywifi disable >/dev/null 2>&1 || true

if command -v nft >/dev/null 2>&1; then
    nft delete table inet skywifi_acct 2>/dev/null || true
    nft delete table inet skywifi_qos 2>/dev/null || true
fi

if command -v apk >/dev/null 2>&1; then
    apk del luci-app-skywifi 2>/dev/null || true
elif command -v opkg >/dev/null 2>&1; then
    opkg remove luci-app-skywifi 2>/dev/null || true
fi

rm -rf /usr/libexec/skywifi
rm -f /usr/libexec/rpcd/luci.skywifi
rm -f /usr/share/luci/menu.d/luci-app-skywifi.json
rm -f /usr/share/rpcd/acl.d/luci-app-skywifi.json
rm -rf /www/luci-static/resources/view/skywifi
rm -f /etc/init.d/skywifi
rm -f /etc/uci-defaults/80_luci-app-skywifi
rm -f /etc/cron.d/skywifi
rm -rf /tmp/skywifi

if [ "$PURGE_DATA" = "1" ]; then
    rm -f /etc/config/skywifi
    rm -rf /etc/skywifi
fi

rm -rf /tmp/luci-indexcache /tmp/luci-modulecache/
/etc/init.d/rpcd restart >/dev/null 2>&1 || true
'@

Invoke-RouterScript $uninstallScript | Out-Null

Write-Host -ForegroundColor Cyan "`n=========================================================="
Write-Host -ForegroundColor Green " SUCCESS: skywifi uninstalled successfully over SSH!     "
Write-Host -ForegroundColor Cyan "=========================================================="
