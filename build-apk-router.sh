#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR="$SCRIPT_DIR/package/luci-app-skywifi/files"
OUT_DIR="$SCRIPT_DIR/packages"
PKG_NAME="luci-app-skywifi"
PKG_VER="${SKYWIFI_VERSION:-2.2.0-1}"
APK_BIN=${APK_BIN:-$(command -v apk 2>/dev/null || true)}
OPENSSL_BIN=${OPENSSL_BIN:-$(command -v openssl 2>/dev/null || true)}
export OPENSSL_CONF=${OPENSSL_CONF:-/dev/null}

[ -n "$APK_BIN" ] || { echo "ERROR: apk-tools not found." >&2; exit 1; }
[ -n "$OPENSSL_BIN" ] || { echo "ERROR: openssl not found." >&2; exit 1; }
[ -d "$ROOT_DIR" ] || { echo "ERROR: package files missing: $ROOT_DIR" >&2; exit 1; }
case "$($APK_BIN --version 2>/dev/null || true)" in
  *'apk-tools 3.'*) ;;
  *) echo "ERROR: apk-tools 3.x is required." >&2; exit 1 ;;
esac

mkdir -p "$OUT_DIR"

# OpenWrt 25.12 APK packages are produced by the OpenWrt package-pack
# machinery with an APK signature, package file list and conffile metadata.
# Reproduce the relevant packaging contract here without compiling LuCI.
find "$ROOT_DIR/etc/init.d" "$ROOT_DIR/etc/uci-defaults" "$ROOT_DIR/usr/libexec" "$ROOT_DIR/www/cgi-bin" \
  -type f -exec chmod 0755 {} + 2>/dev/null || true

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
STAGE="$TMP/root"
mkdir -p "$STAGE/lib/apk/packages"
cp -a "$ROOT_DIR"/. "$STAGE"/

# APK package file manifest, matching OpenWrt's package-pack output.
(cd "$STAGE" && find . -type f,l -printf "/%P\\n" | sort) > "$STAGE/lib/apk/packages/${PKG_NAME}.list"

# Conffile metadata and static checksums, matching OpenWrt APK packaging.
CONFFILES="$STAGE/lib/apk/packages/${PKG_NAME}.conffiles"
printf '%s\\n' '/etc/config/skywifi' > "$CONFFILES"
printf '%s\\n' '/etc/config/skywifi' | while IFS= read -r f; do
  if [ -f "$STAGE$f" ]; then
    sha256sum "$STAGE$f" | awk -v p="$f" '{print p " " $1}'
  fi
done > "$STAGE/lib/apk/packages/${PKG_NAME}.conffiles_static"

cat > "$TMP/post-install" <<'POST'
#!/bin/sh
chmod +x /usr/libexec/skywifi/* /usr/libexec/rpcd/luci.skywifi /etc/init.d/skywifi 2>/dev/null || true
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
cat > "$TMP/pre-deinstall" <<'PRER'
#!/bin/sh
/etc/init.d/skywifi stop >/dev/null 2>&1 || true
exit 0
PRER
cat > "$TMP/post-deinstall" <<'POSTRM'
#!/bin/sh
rm -rf /tmp/luci-indexcache /tmp/luci-modulecache 2>/dev/null || true
/etc/init.d/rpcd restart >/dev/null 2>&1 || true
exit 0
POSTRM
chmod 0755 "$TMP/post-install" "$TMP/pre-deinstall" "$TMP/post-deinstall"

# Generate a package signing key on the runner. The router can still install
# the resulting package with --allow-untrusted if the public key is not added.
KEY="$TMP/apk-signing.key"
"$OPENSSL_BIN" ecparam -name prime256v1 -genkey -noout -out "$KEY"

OUT="$OUT_DIR/${PKG_NAME}-${PKG_VER}.apk"
rm -f "$OUT"

"$APK_BIN" mkpkg \
  --info "name:${PKG_NAME}" \
  --info "version:${PKG_VER}" \
  --info "description:Sky Wifi traffic monitoring, bandwidth QoS, website blocking and captive portal for OpenWrt." \
  --info "arch:noarch" \
  --info "license:MIT" \
  --info "origin:${PKG_NAME}" \
  --info "url:https://github.com/CxAlpha/SkyWifi-" \
  --info "maintainer:Sky Wifi" \
  --info "depends:luci-base nftables uhttpd hostapd-utils iw" \
  --script "post-install:$TMP/post-install" \
  --script "pre-deinstall:$TMP/pre-deinstall" \
  --files "$STAGE" \
  --output "$OUT" \
  --sign "$KEY"

[ -s "$OUT" ] || { echo "ERROR: APK was not created." >&2; exit 1; }
# Parse the package using the same apk-tools binary. Do not use the host apk.
"$APK_BIN" manifest "$OUT" >/dev/null
"$APK_BIN" --allow-untrusted verify "$OUT" >/dev/null 2>&1 || {
  echo "ERROR: generated APK failed apk verification." >&2
  exit 1
}
ls -lh "$OUT"
echo "APK created and verified: $OUT"
