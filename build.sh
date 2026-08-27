#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$SCRIPT_DIR/package/luci-app-skywifi/files"
PACKAGES_DIR="$SCRIPT_DIR/packages"
PKG_NAME="luci-app-skywifi"
PKG_VER="2.2.0-1"

[[ -d "$ROOT_DIR" ]] || { echo "ERROR: package files missing: $ROOT_DIR" >&2; exit 1; }
mkdir -p "$PACKAGES_DIR"

for tool in tar gzip ar; do
  command -v "$tool" >/dev/null 2>&1 || { echo "ERROR: missing tool: $tool" >&2; exit 1; }
done

# Ensure all runtime scripts are executable in the package.
find "$ROOT_DIR/etc/init.d" "$ROOT_DIR/etc/uci-defaults" "$ROOT_DIR/usr/libexec" "$ROOT_DIR/www/cgi-bin" \
  -type f -exec chmod 0755 {} +

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
CTRL="$TMP/control"
mkdir -p "$CTRL"

cat > "$CTRL/control" <<META
Package: $PKG_NAME
Version: $PKG_VER
Architecture: all
Maintainer: Sky Wifi
Description: Sky Wifi traffic monitoring, bandwidth QoS, website blocking and captive portal for OpenWrt.
Depends: luci-base, nftables, uhttpd, hostapd-utils, iw
META
printf '%s\n' '/etc/config/skywifi' > "$CTRL/conffiles"

cat > "$CTRL/postinst" <<'POST'
#!/bin/sh
[ -z "${IPKG_INSTROOT:-}" ] || exit 0
chmod +x /usr/libexec/skywifi/* /usr/libexec/rpcd/luci.skywifi /etc/init.d/skywifi /etc/uci-defaults/80_luci-app-skywifi 2>/dev/null || true
if [ -f /etc/uci-defaults/80_luci-app-skywifi ]; then
  sh /etc/uci-defaults/80_luci-app-skywifi >/dev/null 2>&1 || true
  rm -f /etc/uci-defaults/80_luci-app-skywifi
fi
mkdir -p /etc/skywifi/history /tmp/skywifi /tmp/skywifi/ram_buffer
rm -rf /tmp/luci-indexcache /tmp/luci-modulecache 2>/dev/null || true
/etc/init.d/rpcd restart >/dev/null 2>&1 || true
/etc/init.d/skywifi enable >/dev/null 2>&1 || true
/etc/init.d/skywifi restart >/dev/null 2>&1 || true
exit 0
POST

cat > "$CTRL/prerm" <<'PRE'
#!/bin/sh
[ -n "${IPKG_INSTROOT:-}" ] && exit 0
/etc/init.d/skywifi stop >/dev/null 2>&1 || true
/etc/init.d/skywifi disable >/dev/null 2>&1 || true
exit 0
PRE

cat > "$CTRL/postrm" <<'POSTRM'
#!/bin/sh
[ -n "${IPKG_INSTROOT:-}" ] && exit 0
rm -rf /tmp/luci-indexcache /tmp/luci-modulecache 2>/dev/null || true
/etc/init.d/rpcd restart >/dev/null 2>&1 || true
exit 0
POSTRM
chmod 0755 "$CTRL/postinst" "$CTRL/prerm" "$CTRL/postrm"

mkdir -p "$TMP/ipk"
printf '2.0\n' > "$TMP/ipk/debian-binary"
tar -C "$CTRL" --owner=0 --group=0 -czf "$TMP/ipk/control.tar.gz" control conffiles postinst prerm postrm
tar -C "$ROOT_DIR" --owner=0 --group=0 -czf "$TMP/ipk/data.tar.gz" .
rm -f "$PACKAGES_DIR/${PKG_NAME}"_*.ipk
ar -crD "$PACKAGES_DIR/${PKG_NAME}_${PKG_VER}_all.ipk" "$TMP/ipk/debian-binary" "$TMP/ipk/control.tar.gz" "$TMP/ipk/data.tar.gz"

echo "Created: $PACKAGES_DIR/${PKG_NAME}_${PKG_VER}_all.ipk"
ls -lh "$PACKAGES_DIR/${PKG_NAME}_${PKG_VER}_all.ipk"

# APK is intentionally built only with apk-tools 3.x. Never fake APKv3 with tar archives.
APK_BIN="${APK_BIN:-$(command -v apk 2>/dev/null || true)}"
if [[ -n "$APK_BIN" ]] && "$APK_BIN" --version 2>/dev/null | grep -q 'apk-tools 3\.'; then
  "$SCRIPT_DIR/build-apk-router.sh"
else
  echo "APKv3 not built: apk-tools 3.x not available on this build host."
  echo "Use build-apk-router.sh on OpenWrt 25.12+ or the GitHub SDK workflow."
fi
