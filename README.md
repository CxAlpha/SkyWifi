# Sky Wifi v1 — OpenWrt Traffic Management

A standalone LuCI application for OpenWrt providing per-device traffic monitoring, QoS/rate limits, quotas, internet blocking, website blocking, traffic history, and an optional captive portal.

## Target

- OpenWrt 25.12.x
- `ramips/mt7621`
- `mipsel_24kc`
- Tested design target: TP-Link Archer C6 v3.x
- APKv3 for OpenWrt 25.12+
- Legacy IPK is also produced for older OpenWrt releases

## Features

- Real-time per-device upload/download accounting
- Per-device download/upload limits
- Daily, monthly and total quotas
- Per-device internet block/unblock
- Website/domain blocking
- Traffic history and archiving
- Optional captive portal and voucher handling
- LuCI dashboard under **Network → Sky Wifi**
- Persistent UCI configuration

The captive portal is disabled by default.

## Build

The OpenWrt package source is:

```text
package/luci-app-skywifi/
```

The GitHub Actions workflow uses the official OpenWrt 25.12.5 MT7621 SDK and builds the package from that source. It does not fabricate APK files from IPK tar archives.

For a local legacy IPK build:

```bash
./build.sh
```

For an APKv3 build directly on an OpenWrt 25.12+ router:

```sh
./build-apk-router.sh
```

## Installation on OpenWrt 25.12+

If you have the generated APK:

```sh
apk add --allow-untrusted --force-overwrite /tmp/luci-app-skywifi-2.2.0-1.apk
```

Then:

```sh
/etc/init.d/rpcd restart
/etc/init.d/skywifi restart
```

## Installation on older OpenWrt

```sh
opkg install --force-depends --force-reinstall --force-overwrite /tmp/luci-app-skywifi_2.2.0-1_all.ipk
```

## Dashboard

```text
LuCI → Network → Sky Wifi
```

Typical URL:

```text
http://192.168.1.1/cgi-bin/luci/admin/network/skywifi
```

## Backup first

Before installation/upgrades, keep an OpenWrt configuration backup:

```sh
sysupgrade -b /tmp/openwrt-backup.tar.gz
```

## License

MIT.

Sky Wifi
Support: 01650121954
