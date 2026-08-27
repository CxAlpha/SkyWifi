#!/bin/sh
# ==============================================================================
# Sky Wifi LuCI Application - Universal Installer (Linux, macOS, OpenWrt Router)
# Runs locally on PC (via SSH) OR directly on OpenWrt router
# Supports Offline package streaming AND Online GitHub deployment
# ==============================================================================

set -e

GITHUB_USER="CxAlpha"
GITHUB_REPO="SkyWifi-"
BRANCH="main"
IPK_VER="2.2.0-1"
APK_VER="2.2.0-1"
HAS_APK=0
command -v apk >/dev/null 2>&1 && HAS_APK=1

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

SSH_OPTS="-o ConnectTimeout=8 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR"

SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd || echo "")"

IPK_FILE=""
[ -f "$SCRIPT_DIR/packages/luci-app-skywifi_2.2.0-1_all.ipk" ] && IPK_FILE="$SCRIPT_DIR/packages/luci-app-skywifi_2.2.0-1_all.ipk"
[ -z "$IPK_FILE" ] && [ -f "$SCRIPT_DIR/luci-app-skywifi_2.2.0-1_all.ipk" ] && IPK_FILE="$SCRIPT_DIR/luci-app-skywifi_2.2.0-1_all.ipk"
if [ -z "$IPK_FILE" ]; then
    IPK_FILE="$(find "$SCRIPT_DIR" -maxdepth 2 -type f -name "*.ipk" 2>/dev/null | head -n 1 || echo "")"
fi

APK_FILE=""
[ -f "$SCRIPT_DIR/packages/luci-app-skywifi-2.2.0-1.apk" ] && APK_FILE="$SCRIPT_DIR/packages/luci-app-skywifi-2.2.0-1.apk"
[ -z "$APK_FILE" ] && [ -f "$SCRIPT_DIR/luci-app-skywifi-2.2.0-1.apk" ] && APK_FILE="$SCRIPT_DIR/luci-app-skywifi-2.2.0-1.apk"
if [ -z "$APK_FILE" ]; then
    APK_FILE="$(find "$SCRIPT_DIR" -maxdepth 2 -type f -name "*.apk" 2>/dev/null | head -n 1 || echo "")"
fi

# Check if running directly on OpenWrt Router
IS_ROUTER=0
if [ -f /etc/openwrt_release ] || ( [ -f /etc/os-release ] && grep -qi "openwrt" /etc/os-release 2>/dev/null ); then
    IS_ROUTER=1
fi

printf "%b\n" "${CYAN}==========================================================${NC}"
printf "%b\n" "${CYAN}        Sky Wifi OpenWrt Router Deployer (sh/ash)           ${NC}"
printf "%b\n" "${CYAN}==========================================================${NC}"

# Helper downloader
dl_file() {
    URL="$1"
    OUT="$2"
    if command -v curl >/dev/null 2>&1; then
        curl -k -s -L -o "$OUT" "$URL" 2>/dev/null && [ -s "$OUT" ] && return 0
    fi
    if command -v uclient-fetch >/dev/null 2>&1; then
        uclient-fetch --no-check-certificate -q -O "$OUT" "$URL" 2>/dev/null && [ -s "$OUT" ] && return 0
    fi
    wget --no-check-certificate -q -O "$OUT" "$URL" 2>/dev/null && [ -s "$OUT" ] && return 0
    return 1
}

# ==============================================================================
# DIRECT ON-ROUTER INSTALLATION MODE
# ==============================================================================
if [ "$IS_ROUTER" -eq 1 ]; then
    printf "\n%b\n" "${BLUE}[1/3] Direct Router Environment Detected.${NC}"
    printf "%b\n" "${BLUE}[2/3] Protecting existing traffic records & settings ...${NC}"

    [ -x /usr/libexec/skywifi/stats-archiver.sh ] && /usr/libexec/skywifi/stats-archiver.sh sync >/dev/null 2>&1 || true
    [ -f /etc/config/skywifi ] && cp -f /etc/config/skywifi /tmp/skywifi.config.bak 2>/dev/null || true

    HIST_PATH=$(uci -q get skywifi.global.storage_path || echo "/etc/skywifi/history")
    rm -rf /tmp/skywifi_history_backup
    mkdir -p /tmp/skywifi_history_backup

    [ -d "$HIST_PATH" ] && cp -rf "$HIST_PATH"/* /tmp/skywifi_history_backup/ 2>/dev/null || true
    [ -d /etc/skywifi/history ] && cp -rf /etc/skywifi/history/* /tmp/skywifi_history_backup/ 2>/dev/null || true
    [ -d /tmp/skywifi ] && cp -rf /tmp/skywifi/*.json /tmp/skywifi/*.dat /tmp/skywifi_history_backup/ 2>/dev/null || true
    printf "%b\n" "${GREEN}[OK] Data backup complete.${NC}"

    printf "\n%b\n" "${BLUE}[3/3] Installing skywifi package ...${NC}"

    [ -x /etc/init.d/skywifi ] && /etc/init.d/skywifi stop >/dev/null 2>&1 || true
    killall -9 netmon-daemon.sh netmon-helper.sh >/dev/null 2>&1 || true

    if [ "$HAS_APK" -eq 1 ]; then
        printf "%b\n" " Using ${YELLOW}APK${NC} package manager ..."
        if [ -z "$APK_FILE" ] || [ ! -s "$APK_FILE" ]; then
            # Build a native APKv3 from the included package source when apk-tools 3.x is available.
            if [ -x "$SCRIPT_DIR/build-apk-router.sh" ]; then
                printf "%b\n" " No APK found; building a native OpenWrt APKv3 package locally ..."
                "$SCRIPT_DIR/build-apk-router.sh"
                APK_FILE="$SCRIPT_DIR/packages/luci-app-skywifi-${APK_VER}.apk"
            fi
        fi
        if [ -n "$APK_FILE" ] && [ -s "$APK_FILE" ]; then
            apk add --allow-untrusted --force-overwrite "$APK_FILE"
        else
            echo "ERROR: No valid APK package is available." >&2
            exit 1
        fi
    else
        printf "%b\n" " Using ${YELLOW}OPKG${NC} package manager ..."
        if [ -z "$IPK_FILE" ] || [ ! -s "$IPK_FILE" ]; then
            echo "ERROR: No IPK package is available." >&2
            exit 1
        fi
        opkg install --force-depends --force-reinstall --force-overwrite "$IPK_FILE"
    fi


    rm -f /tmp/skywifi.ipk /tmp/skywifi.apk 2>/dev/null || true

    [ -d /usr/libexec/skywifi ] && chmod +x /usr/libexec/skywifi/* 2>/dev/null || true
    [ -d /usr/libexec/rpcd ] && chmod +x /usr/libexec/rpcd/* 2>/dev/null || true
    [ -f /etc/init.d/skywifi ] && chmod +x /etc/init.d/skywifi 2>/dev/null || true
    rm -f /etc/cron.d/skywifi 2>/dev/null || true

    if [ -f /etc/uci-defaults/80_luci-app-skywifi ]; then
        sh /etc/uci-defaults/80_luci-app-skywifi >/dev/null 2>&1 || true
        rm -f /etc/uci-defaults/80_luci-app-skywifi
    fi

    if [ -f /tmp/skywifi.config.bak ]; then
        cp -f /tmp/skywifi.config.bak /etc/config/skywifi
        rm -f /tmp/skywifi.config.bak
    fi

    mkdir -p "$HIST_PATH" /tmp/skywifi /tmp/skywifi/ram_buffer
    if [ -d /tmp/skywifi_history_backup ] && [ "$(ls -A /tmp/skywifi_history_backup 2>/dev/null)" ]; then
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

    if [ -x /usr/libexec/skywifi/netmon-daemon.sh ] && [ -x /etc/init.d/skywifi ]; then
        printf "\n%b\n" "${CYAN}==========================================================${NC}"
        printf "%b\n" "${GREEN} SUCCESS: skywifi application installed successfully!     ${NC}"
        printf "%b\n" "${CYAN}==========================================================${NC}"
    else
        printf "\n%b\n" "${RED}Error: Installation failed! Core files missing.${NC}"
        exit 1
    fi
    exit 0
fi

# ==============================================================================
# REMOTE SSH DEPLOYMENT MODE (PC to Router)
# ==============================================================================
ROUTER_IP="$1"
if [ -z "$ROUTER_IP" ]; then
    printf "Enter Router IP address [default: 192.168.1.1]: "
    read INPUT_IP
    ROUTER_IP="${INPUT_IP:-192.168.1.1}"
fi

printf "\n%b\n" "${CYAN}==========================================================${NC}"
printf "%b\n" "${CYAN}   Connecting to Router ($ROUTER_IP) ...                  ${NC}"
printf "%b\n" "${CYAN}==========================================================${NC}"

# 1. Test SSH Connection
printf "\n%b\n" "${BLUE}[1/4] Testing SSH connection to root@$ROUTER_IP ...${NC}"
if ! ssh $SSH_OPTS "root@$ROUTER_IP" "echo connection_ok" >/dev/null 2>&1; then
    printf "%b\n" "${RED}Error: Could not connect to root@$ROUTER_IP via SSH.${NC}"
    exit 1
fi
printf "%b\n" "${GREEN}[OK] SSH connection successful.${NC}"

# 2. Protect data
printf "\n%b\n" "${BLUE}[2/4] Protecting existing traffic records & settings ...${NC}"
ssh $SSH_OPTS "root@$ROUTER_IP" "[ -x /usr/libexec/skywifi/stats-archiver.sh ] && /usr/libexec/skywifi/stats-archiver.sh sync >/dev/null 2>&1 || true; [ -f /etc/config/skywifi ] && cp -f /etc/config/skywifi /tmp/skywifi.config.bak 2>/dev/null || true; HIST_PATH=\$(uci -q get skywifi.global.storage_path || echo /etc/skywifi/history); rm -rf /tmp/skywifi_history_backup; mkdir -p /tmp/skywifi_history_backup; [ -d \$HIST_PATH ] && cp -rf \$HIST_PATH/* /tmp/skywifi_history_backup/ 2>/dev/null || true; [ -d /etc/skywifi/history ] && cp -rf /etc/skywifi/history/* /tmp/skywifi_history_backup/ 2>/dev/null || true; [ -d /tmp/skywifi ] && cp -rf /tmp/skywifi/*.json /tmp/skywifi/*.dat /tmp/skywifi_history_backup/ 2>/dev/null || true" >/dev/null 2>&1 || true
printf "%b\n" "${GREEN}[OK] Traffic history data backed up.${NC}"

# 3. Upload or Download package
printf "\n%b\n" "${BLUE}[3/4] Deploying application package to router ...${NC}"
LOCAL_FOUND=0
if [ -n "$IPK_FILE" ] && [ -f "$IPK_FILE" ]; then
    printf "%s\n" " Uploading OPKG package ..."
    cat "$IPK_FILE" | ssh $SSH_OPTS "root@$ROUTER_IP" "cat > /tmp/luci-app-skywifi_2.2.0-1_all.ipk"
    LOCAL_FOUND=1
fi

if [ -n "$APK_FILE" ] && [ -f "$APK_FILE" ]; then
    printf "%s\n" " Uploading APK package ..."
    cat "$APK_FILE" | ssh $SSH_OPTS "root@$ROUTER_IP" "cat > /tmp/luci-app-skywifi-2.2.0-1.apk"
    LOCAL_FOUND=1
fi

if [ "$LOCAL_FOUND" -eq 0 ]; then
    printf "%s\n" " Local package not found. Downloading latest build from GitHub directly on router ..."
    ssh $SSH_OPTS "root@$ROUTER_IP" "USER=\"$GITHUB_USER\" REPO=\"$GITHUB_REPO\" BRANCH=\"$BRANCH\" IPK_V=\"$IPK_VER\" APK_V=\"$APK_VER\" sh -s" << 'EOF' >/dev/null 2>&1 || true
        dl_file() {
            URL="$1"
            OUT="$2"
            if command -v curl >/dev/null 2>&1; then
                curl -k -s -L -o "$OUT" "$URL" 2>/dev/null && [ -s "$OUT" ] && return 0
            fi
            if command -v uclient-fetch >/dev/null 2>&1; then
                uclient-fetch --no-check-certificate -q -O "$OUT" "$URL" 2>/dev/null && [ -s "$OUT" ] && return 0
            fi
            wget --no-check-certificate -q -O "$OUT" "$URL" 2>/dev/null && [ -s "$OUT" ] && return 0
            return 1
        }
        REL_URL="https://github.com/${USER}/${REPO}/releases/latest/download"
        RAW_URL="https://raw.githubusercontent.com/${USER}/${REPO}/${BRANCH}"
        if command -v apk >/dev/null 2>&1; then
            dl_file "$REL_URL/luci-app-skywifi-${APK_V}.apk" /tmp/skywifi.apk || dl_file "$RAW_URL/packages/luci-app-skywifi-${APK_V}.apk" /tmp/skywifi.apk || true
        else
            dl_file "$REL_URL/luci-app-skywifi_${IPK_V}_all.ipk" /tmp/skywifi.ipk || dl_file "$RAW_URL/packages/luci-app-skywifi_${IPK_V}_all.ipk" /tmp/skywifi.ipk || true
        fi
EOF
fi
printf "%b\n" "${GREEN}[OK] Package payload deployed.${NC}"

# 4. Install & restart services
printf "\n%b\n" "${BLUE}[4/4] Installing application & configuring services ...${NC}"
ssh $SSH_OPTS "root@$ROUTER_IP" "$(cat <<'REMOTE_INSTALL'
[ -x /etc/init.d/skywifi ] && /etc/init.d/skywifi stop 2>/dev/null || true
killall -9 netmon-daemon.sh netmon-helper.sh 2>/dev/null || true

if command -v apk >/dev/null 2>&1; then
    [ -f /tmp/skywifi.apk ] && apk add --allow-untrusted --force-non-repository --force-overwrite /tmp/skywifi.apk 2>/dev/null || true
    [ -f /tmp/luci-app-skywifi-2.2.0-1.apk ] && apk add --allow-untrusted --force-non-repository --force-overwrite /tmp/luci-app-skywifi-2.2.0-1.apk 2>/dev/null || true
else
    [ -f /tmp/skywifi.ipk ] && opkg install --force-reinstall --force-overwrite --force-depends /tmp/skywifi.ipk 2>/dev/null || true
    [ -f /tmp/luci-app-skywifi_2.2.0-1_all.ipk ] && opkg install --force-depends --force-reinstall --force-overwrite /tmp/luci-app-skywifi_2.2.0-1_all.ipk 2>/dev/null || true
fi

# APKv3 is managed by apk and is deliberately not unpacked as a tar archive.
# Only the legacy IPK gets a direct-extraction fallback.
for pkg in /tmp/skywifi.ipk /tmp/luci-app-skywifi*.ipk /tmp/*.ipk; do
    [ -s "$pkg" ] || continue
    rm -rf /tmp/ipk_extract && mkdir -p /tmp/ipk_extract
    if command -v ar >/dev/null 2>&1; then
        (cd /tmp/ipk_extract && ar -x "$pkg") 2>/dev/null || true
    else
        tar -xzf "$pkg" -C /tmp/ipk_extract 2>/dev/null || tar -xf "$pkg" -C /tmp/ipk_extract 2>/dev/null || true
    fi
    [ -f /tmp/ipk_extract/data.tar.gz ] && tar -xzf /tmp/ipk_extract/data.tar.gz -C / 2>/dev/null || true
    [ -f /tmp/ipk_extract/data.tar ] && tar -xf /tmp/ipk_extract/data.tar -C / 2>/dev/null || true
    rm -rf /tmp/ipk_extract
    break
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

HIST_PATH=$(uci -q get skywifi.global.storage_path 2>/dev/null || echo /etc/skywifi/history)
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
REMOTE_INSTALL
)" >/dev/null 2>&1 || true

printf "\n%b\n" "${BLUE}Verifying installation ...${NC}"
FINAL_CHECK=$(ssh $SSH_OPTS "root@$ROUTER_IP" '[ -f /usr/libexec/skywifi/netmon-daemon.sh ] && [ -f /usr/share/luci/menu.d/luci-app-skywifi.json ] && echo "ok" || echo "failed"' 2>/dev/null | tr -d '\r\n')

if [ "$FINAL_CHECK" = "ok" ]; then
    printf "%b\n" "${CYAN}==========================================================${NC}"
    printf "%b\n" "${GREEN} SUCCESS: skywifi installation verified on router!        ${NC}"
    printf "%b\n" "${CYAN}==========================================================${NC}"
    printf "%b\n" " Router Dashboard: ${YELLOW}http://$ROUTER_IP/cgi-bin/luci/admin/network/skywifi${NC}"
    printf "%b\n" "${CYAN}==========================================================${NC}"
else
    printf "%b\n" "${RED}Error: Installation failed! Core files were not installed properly.${NC}"
    exit 1
fi
