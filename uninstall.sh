#!/bin/bash
# ==============================================================================
# Sky Wifi LuCI Application - Offline Uninstaller (Linux, macOS, OpenWrt Router)
# Runs locally on PC (via SSH) OR directly on OpenWrt router
# ==============================================================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

SSH_OPTS="-o ConnectTimeout=8 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR"

# Check if running directly on OpenWrt Router
IS_ROUTER=0
if [ -f /etc/openwrt_release ] || ( [ -f /etc/os-release ] && grep -qi "openwrt" /etc/os-release 2>/dev/null ); then
    IS_ROUTER=1
fi

echo -e "${CYAN}==========================================================${NC}"
echo -e "${CYAN}        Sky Wifi OpenWrt Router Offline Uninstaller        ${NC}"
echo -e "${CYAN}==========================================================${NC}"

# ==============================================================================
# DIRECT ON-ROUTER UNINSTALLATION MODE
# ==============================================================================
if [ "$IS_ROUTER" -eq 1 ]; then
    echo -e "\n${BLUE}[1/2] Direct Router Environment Detected.${NC}"
    echo -e "${BLUE}[2/2] Removing skywifi package and binaries ...${NC}"

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

    rm -rf /tmp/luci-indexcache /tmp/luci-modulecache/
    /etc/init.d/rpcd restart >/dev/null 2>&1 || true

    echo -e "\n${CYAN}==========================================================${NC}"
    echo -e "${GREEN} SUCCESS: skywifi uninstalled successfully!               ${NC}"
    echo -e "${CYAN}==========================================================${NC}"
    exit 0
fi

# ==============================================================================
# REMOTE SSH UNINSTALLATION MODE (PC to Router)
# ==============================================================================
ROUTER_IP="$1"
if [ -z "$ROUTER_IP" ]; then
    read -p "Enter Router IP address [default: 192.168.1.1]: " INPUT_IP
    ROUTER_IP="${INPUT_IP:-192.168.1.1}"
fi

PURGE_DATA="$2"
if [ -z "$PURGE_DATA" ]; then
    read -p "Do you want to purge historical traffic data & configs? (y/N): " CONFIRM_PURGE
    case "$CONFIRM_PURGE" in
        [yY][eE][sS]|[yY]) PURGE_DATA="yes" ;;
        *) PURGE_DATA="no" ;;
    esac
fi

echo -e "\n${BLUE}[1/2] Testing SSH connection to root@$ROUTER_IP ...${NC}"
if ! ssh $SSH_OPTS "root@$ROUTER_IP" "echo connection_ok" >/dev/null 2>&1; then
    echo -e "${RED}Error: Could not connect to root@$ROUTER_IP via SSH.${NC}"
    exit 1
fi

echo -e "\n${BLUE}[2/2] Removing skywifi package and binaries from router ...${NC}"
ssh $SSH_OPTS "root@$ROUTER_IP" "PURGE=\"$PURGE_DATA\" sh -s" << 'EOF' >/dev/null 2>&1 || true
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

    if [ "$PURGE" = "yes" ]; then
        rm -f /etc/config/skywifi
        rm -rf /etc/skywifi
    fi

    rm -rf /tmp/luci-indexcache /tmp/luci-modulecache/
    /etc/init.d/rpcd restart >/dev/null 2>&1 || true
EOF

echo -e "\n${CYAN}==========================================================${NC}"
echo -e "${GREEN} SUCCESS: skywifi uninstalled successfully over SSH!     ${NC}"
echo -e "${CYAN}==========================================================${NC}"
