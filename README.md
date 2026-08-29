# Sky Wifi v7 — OpenWrt Traffic Management

A standalone LuCI application for OpenWrt providing per-device traffic monitoring, QoS/rate limits, data quotas, internet blocking, website blocking, traffic history, and an optional captive portal with voucher handling.

## Target

- OpenWrt 25.12.x
- `ramips/mt7621`
- `mipsel_24kc`
- Tested design target: TP-Link Archer C6 v3.x
- APKv3 for OpenWrt 25.12+
- Legacy IPK is also produced for older OpenWrt releases

## Features

- Real-time per-device download/upload traffic accounting
- Per-device download/upload speed limits
- Daily, monthly, and total data quotas
- Per-device internet block/unblock
- Website/domain blocking
- Traffic history and automatic archiving
- Optional captive portal and voucher handling
- Seamless re-authorization for valid existing voucher bindings
- DHCP/IP-change aware traffic accounting
- QoS and website-blocking nftables isolation
- LuCI dashboard under **Network → Sky Wifi**
- Persistent UCI configuration

The captive portal is disabled by default.

## Build

The OpenWrt package source is:

```text
package/luci-app-skywifi/
