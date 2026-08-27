# ==============================================================================
# Sky Wifi LuCI Application - Universal Installer (Windows PowerShell)
# Deploys from Windows PC to OpenWrt Router via SSH/SCP
# Supports Offline package streaming AND Online GitHub deployment
# ==============================================================================

$GITHUB_USER = "CxAlpha"
$GITHUB_REPO = "SkyWifi-"
$BRANCH = "main"
$IPK_VER = "2.2.0-1"
$APK_VER = "2.2.0-1"

$SSH_OPTS = @("-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR")

Write-Host -ForegroundColor Cyan "=========================================================="
Write-Host -ForegroundColor Cyan "        Sky Wifi OpenWrt Router Deployer (PowerShell)       "
Write-Host -ForegroundColor Cyan "=========================================================="

# Check for SSH and SCP in system path
if (-not (Get-Command ssh -ErrorAction SilentlyContinue) -or -not (Get-Command scp -ErrorAction SilentlyContinue)) {
    Write-Host -ForegroundColor Red "Error: SSH or SCP clients not found in system path."
    Write-Host -ForegroundColor Yellow "Please ensure OpenSSH Client is installed on Windows."
    Write-Host -ForegroundColor Yellow "  Settings > Apps > Optional Features > OpenSSH Client"
    Exit 1
}

# 1. Resolve local packages
$IPK_FILE = ""
if (Test-Path "$PSScriptRoot\packages\luci-app-skywifi_${IPK_VER}_all.ipk") {
    $IPK_FILE = "$PSScriptRoot\packages\luci-app-skywifi_${IPK_VER}_all.ipk"
} elseif (Test-Path "$PSScriptRoot\luci-app-skywifi_${IPK_VER}_all.ipk") {
    $IPK_FILE = "$PSScriptRoot\luci-app-skywifi_${IPK_VER}_all.ipk"
} else {
    $f = Get-ChildItem -Path $PSScriptRoot -Filter "*.ipk" -Recurse -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($f) { $IPK_FILE = $f.FullName }
}

$APK_FILE = ""
if (Test-Path "$PSScriptRoot\packages\luci-app-skywifi-${APK_VER}.apk") {
    $APK_FILE = "$PSScriptRoot\packages\luci-app-skywifi-${APK_VER}.apk"
} elseif (Test-Path "$PSScriptRoot\luci-app-skywifi-${APK_VER}.apk") {
    $APK_FILE = "$PSScriptRoot\luci-app-skywifi-${APK_VER}.apk"
} else {
    $f = Get-ChildItem -Path $PSScriptRoot -Filter "*.apk" -Recurse -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($f) { $APK_FILE = $f.FullName }
}

# 2. Get Router IP
$RouterIP = $args[0]
if ([string]::IsNullOrEmpty($RouterIP)) {
    $inputIP = Read-Host "Enter Router IP address [default: 192.168.1.1]"
    $RouterIP = if ([string]::IsNullOrWhiteSpace($inputIP)) { "192.168.1.1" } else { $inputIP.Trim() }
}

Write-Host ""
Write-Host -ForegroundColor Cyan "=========================================================="
Write-Host -ForegroundColor Cyan "   Connecting to Router ($RouterIP) ..."
Write-Host -ForegroundColor Cyan "=========================================================="

# 3. Test SSH Connection
Write-Host -ForegroundColor Blue "`n[1/4] Testing SSH connection to root@$RouterIP ..."
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
        $result = Get-Content $tmpFile -Raw | & ssh @SSH_OPTS "root@$RouterIP" "sh -s" 2>$null
        return $result
    } finally {
        if (Test-Path $tmpFile) { Remove-Item $tmpFile -Force -ErrorAction SilentlyContinue }
    }
}

# 4. Backup existing data and config
Write-Host -ForegroundColor Blue "`n[2/4] Protecting existing traffic records & settings ..."

$backupScript = @'
[ -x /usr/libexec/skywifi/stats-archiver.sh ] && /usr/libexec/skywifi/stats-archiver.sh sync >/dev/null 2>&1 || true
[ -f /etc/config/skywifi ] && cp -f /etc/config/skywifi /tmp/skywifi.config.bak 2>/dev/null || true
HIST_PATH=$(uci -q get skywifi.global.storage_path 2>/dev/null || echo "/etc/skywifi/history")
rm -rf /tmp/skywifi_history_backup
mkdir -p /tmp/skywifi_history_backup
[ -d "$HIST_PATH" ] && cp -rf "$HIST_PATH"/* /tmp/skywifi_history_backup/ 2>/dev/null || true
[ -d /etc/skywifi/history ] && cp -rf /etc/skywifi/history/* /tmp/skywifi_history_backup/ 2>/dev/null || true
[ -d /tmp/skywifi ] && cp -rf /tmp/skywifi/*.json /tmp/skywifi/*.dat /tmp/skywifi_history_backup/ 2>/dev/null || true
'@

Invoke-RouterScript $backupScript | Out-Null
Write-Host -ForegroundColor Green "[OK] Traffic history data backed up."

# 5. Upload or download package
Write-Host -ForegroundColor Blue "`n[3/4] Deploying application package to router ..."
$LocalFound = $false

if ($IPK_FILE -and (Test-Path $IPK_FILE)) {
    Write-Host "  Uploading OPKG package: $([System.IO.Path]::GetFileName($IPK_FILE)) ..."
    & scp -O @SSH_OPTS "$IPK_FILE" "root@${RouterIP}:/tmp/luci-app-skywifi_${IPK_VER}_all.ipk"
    if ($LASTEXITCODE -eq 0) { $LocalFound = $true; Write-Host -ForegroundColor Green "  [OK] OPKG package uploaded." }
}

if ($APK_FILE -and (Test-Path $APK_FILE)) {
    Write-Host "  Uploading APK package: $([System.IO.Path]::GetFileName($APK_FILE)) ..."
    & scp -O @SSH_OPTS "$APK_FILE" "root@${RouterIP}:/tmp/luci-app-skywifi-${APK_VER}.apk"
    if ($LASTEXITCODE -eq 0) { $LocalFound = $true; Write-Host -ForegroundColor Green "  [OK] APK package uploaded." }
}

if (-not $LocalFound) {
    Write-Host -ForegroundColor Yellow "  Local package not found. Downloading latest from GitHub directly on router..."
    $dlScript = "REL_URL='https://github.com/${GITHUB_USER}/${GITHUB_REPO}/releases/latest/download'
RAW_URL='https://raw.githubusercontent.com/${GITHUB_USER}/${GITHUB_REPO}/${BRANCH}'
dl_file() {
    URL=""`$1""; OUT=""`$2""
    if command -v curl >/dev/null 2>&1; then curl -k -s -L -o ""`$OUT"" ""`$URL"" 2>/dev/null && [ -s ""`$OUT"" ] && return 0; fi
    if command -v uclient-fetch >/dev/null 2>&1; then uclient-fetch --no-check-certificate -q -O ""`$OUT"" ""`$URL"" 2>/dev/null && [ -s ""`$OUT"" ] && return 0; fi
    wget --no-check-certificate -q -O ""`$OUT"" ""`$URL"" 2>/dev/null && [ -s ""`$OUT"" ] && return 0
    return 1
}
if command -v apk >/dev/null 2>&1; then
    dl_file ""`$REL_URL/luci-app-skywifi-${APK_VER}.apk"" /tmp/skywifi.apk || dl_file ""`$RAW_URL/packages/luci-app-skywifi-${APK_VER}.apk"" /tmp/skywifi.apk || true
else
    dl_file ""`$REL_URL/luci-app-skywifi_${IPK_VER}_all.ipk"" /tmp/skywifi.ipk || dl_file ""`$RAW_URL/packages/luci-app-skywifi_${IPK_VER}_all.ipk"" /tmp/skywifi.ipk || true
fi"
    Invoke-RouterScript $dlScript | Out-Null
}
Write-Host -ForegroundColor Green "[OK] Package payload deployed."

# 6. Install & configure services
Write-Host -ForegroundColor Blue "`n[4/4] Installing application & configuring services ..."

$installScript = "APK_VER='${APK_VER}'
IPK_VER='${IPK_VER}'
" + @'
[ -x /etc/init.d/skywifi ] && /etc/init.d/skywifi stop >/dev/null 2>&1 || true
killall -9 netmon-daemon.sh netmon-helper.sh >/dev/null 2>&1 || true

if command -v apk >/dev/null 2>&1; then
    [ -f /tmp/skywifi.apk ] && apk add --allow-untrusted --force-non-repository --force-overwrite /tmp/skywifi.apk 2>/dev/null || true
    [ -f "/tmp/luci-app-skywifi-${APK_VER}.apk" ] && apk add --allow-untrusted --force-non-repository --force-overwrite "/tmp/luci-app-skywifi-${APK_VER}.apk" 2>/dev/null || true
else
    [ -f /tmp/skywifi.ipk ] && opkg install --force-reinstall --force-overwrite --force-depends /tmp/skywifi.ipk 2>/dev/null || true
    [ -f "/tmp/luci-app-skywifi_${IPK_VER}_all.ipk" ] && opkg install --force-depends --force-reinstall --force-overwrite "/tmp/luci-app-skywifi_${IPK_VER}_all.ipk" 2>/dev/null || true
fi

# Always perform direct payload extraction to guarantee all files are replaced on re-install
for pkg in /tmp/skywifi.ipk /tmp/luci-app-skywifi*.ipk /tmp/*.ipk; do
    [ -s "$pkg" ] || continue
    rm -rf /tmp/ipk_extract && mkdir -p /tmp/ipk_extract
    tar -xzf "$pkg" -C /tmp/ipk_extract 2>/dev/null || tar -xf "$pkg" -C /tmp/ipk_extract 2>/dev/null || true
    [ -f /tmp/ipk_extract/data.tar.gz ] && tar -xzf /tmp/ipk_extract/data.tar.gz -C / 2>/dev/null || true
    [ -f /tmp/ipk_extract/data.tar ] && tar -xf /tmp/ipk_extract/data.tar -C / 2>/dev/null || true
    rm -rf /tmp/ipk_extract
done
done

rm -f /tmp/skywifi.* /tmp/luci-app-skywifi* 2>/dev/null || true
[ -d /usr/libexec/skywifi ] && chmod +x /usr/libexec/skywifi/* 2>/dev/null || true
[ -d /usr/libexec/rpcd ] && chmod +x /usr/libexec/rpcd/* 2>/dev/null || true
[ -f /etc/init.d/skywifi ] && chmod +x /etc/init.d/skywifi 2>/dev/null || true
rm -f /etc/cron.d/skywifi 2>/dev/null || true

[ -f /tmp/skywifi.config.bak ] && cp -f /tmp/skywifi.config.bak /etc/config/skywifi && rm -f /tmp/skywifi.config.bak || true

if [ -f /etc/uci-defaults/80_luci-app-skywifi ]; then
    sh /etc/uci-defaults/80_luci-app-skywifi >/dev/null 2>&1 || true
    rm -f /etc/uci-defaults/80_luci-app-skywifi
fi

HIST_PATH=$(uci -q get skywifi.global.storage_path 2>/dev/null || echo "/etc/skywifi/history")
mkdir -p "$HIST_PATH" /tmp/skywifi /tmp/skywifi/ram_buffer
if [ -d /tmp/skywifi_history_backup ]; then
    cp -rf /tmp/skywifi_history_backup/* "$HIST_PATH"/ 2>/dev/null || true
    cp -rf /tmp/skywifi_history_backup/* /tmp/skywifi/ 2>/dev/null || true
    cp -rf /tmp/skywifi_history_backup/* /tmp/skywifi/ram_buffer/ 2>/dev/null || true
    rm -rf /tmp/skywifi_history_backup
fi

touch /www/luci-static/resources/view/skywifi/*.js 2>/dev/null || true
rm -rf /tmp/luci-indexcache /tmp/luci-modulecache/
/etc/init.d/rpcd restart >/dev/null 2>&1 || true
[ -x /etc/init.d/uhttpd ] && /etc/init.d/uhttpd restart >/dev/null 2>&1 || true
[ -x /etc/init.d/nginx ] && /etc/init.d/nginx reload >/dev/null 2>&1 || true
/etc/init.d/skywifi enable >/dev/null 2>&1 || true
/etc/init.d/skywifi restart >/dev/null 2>&1 || true
'@

Invoke-RouterScript $installScript | Out-Null

# 7. Verification
Write-Host -ForegroundColor Blue "`nVerifying installation ..."
$verifyScript = @'
[ -f /usr/libexec/skywifi/netmon-daemon.sh ] && [ -f /usr/share/luci/menu.d/luci-app-skywifi.json ] && echo ok || echo failed
'@
$finalCheck = Invoke-RouterScript $verifyScript

if ($finalCheck -match "ok") {
    Write-Host -ForegroundColor Cyan "=========================================================="
    Write-Host -ForegroundColor Green " SUCCESS: skywifi installation verified on router!"
    Write-Host -ForegroundColor Cyan "=========================================================="
    Write-Host -ForegroundColor Yellow " Router Dashboard: http://$RouterIP/cgi-bin/luci/admin/network/skywifi"
    Write-Host -ForegroundColor Cyan "=========================================================="
} else {
    Write-Host -ForegroundColor Red "Error: Installation failed! Core files were not installed properly."
    Exit 1
}
