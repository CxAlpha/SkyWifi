#!/bin/sh
# Sky Wifi lightweight captive-portal library
BASE=/etc/skywifi
CFG=/etc/config/skywifi
CUSTOMERS=$BASE/customers.db
DEVICES=$BASE/devices.db
VOUCHERS=$BASE/vouchers.db
AUDIT=$BASE/audit.log
LOCK=$BASE/.lock
NFT_FAMILY=inet
NFT_TABLE=skywifi
LAN_IF=$(uci -q get skywifi.global.lan_interface || echo br-lan)
PORTAL_IP=$(uci -q get skywifi.global.portal_ip || ip -4 addr show dev "$LAN_IF" | awk '/inet /{sub(/\/.*/,"",$2); print $2; exit}')
PORTAL_PORT=$(uci -q get skywifi.global.portal_port || echo 8080)
DAYS=$(uci -q get skywifi.global.voucher_days || echo 30)

mkdir -p "$BASE" /tmp/skywifi 2>/dev/null || true
touch "$CUSTOMERS" "$DEVICES" "$VOUCHERS" "$AUDIT" 2>/dev/null || true

now() { date +%s; }

portal_enabled() {
	case "$(uci -q get skywifi.global.portal_enabled || echo 0)" in
		1|true|on|yes) return 0 ;;
		*) return 1 ;;
	esac
}

portal_listener_up() {
	PORT=$(uci -q get skywifi.global.portal_port || echo 8080)
	ip4=$(uci -q get skywifi.global.portal_ip || echo 192.168.1.1)
	if command -v netstat >/dev/null 2>&1 && netstat -ltn 2>/dev/null | awk -v want="${ip4}:${PORT}" -v port=":${PORT}" '$4 == want || $4 ~ port"$" {found=1} END{exit !found}'; then
		return 0
	fi
	# BusyBox/OpenWrt fallback: inspect the kernel TCP listen table.
	port_hex=$(printf '%04X' "$PORT" 2>/dev/null) || return 1
	grep -qi ":${port_hex} " /proc/net/tcp 2>/dev/null || grep -qi ":${port_hex} " /proc/net/tcp6 2>/dev/null
}

reset_data() {
	# SkyWifi-only reset. Never touch OpenWrt network/Wi-Fi/LuCI configuration.
	/etc/init.d/skywifi stop >/dev/null 2>&1 || true
	nft delete table $NFT_FAMILY $NFT_TABLE 2>/dev/null || true
	rm -rf "$BASE/history" /tmp/skywifi /tmp/skywifi_history_backup 2>/dev/null || true
	mkdir -p "$BASE/history" /tmp/skywifi
	: > "$CUSTOMERS"
	: > "$DEVICES"
	: > "$VOUCHERS"
	: > "$AUDIT"
	# Remove only SkyWifi-generated dynamic UCI sections.
	uci show skywifi 2>/dev/null | awk -F= '/^skywifi\.(quick_block_|alias_|rule_|vpn_block_|block_domain|qos_rule)|^skywifi\.@(block_domain|qos_rule)/ {print $1}' | while IFS= read -r key; do
		[ -n "$key" ] && uci delete "$key" 2>/dev/null || true
	done
	uci set skywifi.global.portal_enabled='0'
	uci set skywifi.global.admin_password_hash=''
	uci set skywifi.global.master_password_hash=''
	uci commit skywifi
	/etc/init.d/skywifi restart >/dev/null 2>&1 || true
	return 0
}

lock_acquire() {
	tries=0
	while ! mkdir "$LOCK" 2>/dev/null; do
		tries=$((tries + 1))
		[ "$tries" -ge 50 ] && return 1
		sleep 0.1
	done
	return 0
}
lock_release() { rmdir "$LOCK" 2>/dev/null || true; }
log_event() { printf '%s\t%s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$AUDIT" 2>/dev/null || true; }
clean_field() { printf '%s' "$1" | tr '\t\r\n|' '    ' | cut -c1-120; }
normalize_mac() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

client_mac() {
	ip="$1"
	[ -n "$ip" ] || return 1

	# Do not depend on a single ARP/neighbor source. A captive-portal HTTP
	# request can arrive before the kernel has populated the neighbor entry on
	# br-lan, and bridge/VLAN/Wi-Fi paths can expose the entry without the
	# expected interface name. Try the kernel neighbor table first without an
	# interface restriction, then fall back to ARP and DHCP lease databases.
	mac=$(ip neigh show "$ip" 2>/dev/null | awk '/lladdr/{print tolower($5); exit}')
	if valid_mac "$mac" 2>/dev/null; then
		printf '%s\n' "$mac"
		return 0
	fi

	if [ -r /proc/net/arp ]; then
		mac=$(awk -v want="$ip" '$1==want && $4 != "00:00:00:00:00:00" {print tolower($4); exit}' /proc/net/arp 2>/dev/null)
		if valid_mac "$mac" 2>/dev/null; then
			printf '%s\n' "$mac"
			return 0
		fi
	fi

	for lease in /tmp/dhcp.leases /tmp/dnsmasq.leases; do
		[ -r "$lease" ] || continue
		mac=$(awk -v want="$ip" '$3==want {print tolower($2); exit}' "$lease" 2>/dev/null)
		if valid_mac "$mac" 2>/dev/null; then
			printf '%s\n' "$mac"
			return 0
		fi
	done

	# OpenWrt's DHCP ubus API is useful when the lease file is unavailable or
	# managed by a different DHCP backend. Keep this as the final fallback.
	if command -v ubus >/dev/null 2>&1; then
		mac=$(ubus call dhcp get_leases 2>/dev/null | awk -F'"' -v want="$ip" '''{
			for (i=1; i<=NF; i++) {
				if ($i=="ip" && $(i+2)==want) {
					for (j=1; j<=NF; j++) if ($j=="mac") {print tolower($(j+2)); exit}
				}
			}
		}''' )
		if valid_mac "$mac" 2>/dev/null; then
			printf '%s\n' "$mac"
			return 0
		fi
	fi
	return 1
}

valid_mac() { printf '%s' "$1" | grep -Eq '^([0-9a-f]{2}:){5}[0-9a-f]{2}$'; }
valid_ip() { printf '%s' "$1" | grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}$'; }

random_code() {
	# 12 hex chars, enough entropy for a short-lived voucher namespace.
	if [ -r /dev/urandom ] && command -v od >/dev/null 2>&1; then
		od -An -N6 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n' | cut -c1-12
	else
		printf '%s%s' "$(date +%s)" "$$" | md5sum 2>/dev/null | cut -c1-12
	fi
}

# Generate three independent 4-character segments and never repeat a segment
# within the same voucher. This guarantees codes such as SKY-5F98-5F98-5F98
# cannot be generated.
random_voucher_code() {
	local a b c tries=0
	while :; do
		tries=$((tries + 1))
		a=$(random_code | cut -c1-4 | tr 'a-f' 'A-F')
		b=$(random_code | cut -c1-4 | tr 'a-f' 'A-F')
		c=$(random_code | cut -c1-4 | tr 'a-f' 'A-F')
		[ "$a" != "$b" ] && [ "$a" != "$c" ] && [ "$b" != "$c" ] && {
			printf 'SKY-%s-%s-%s\n' "$a" "$b" "$c"
			return 0
		}
		[ "$tries" -ge 20 ] && return 1
	done
}

voucher_exists() { awk -F '\t' -v c="$1" '$1==c{found=1} END{exit !found}' "$VOUCHERS" 2>/dev/null; }

voucher_get() {
	code="$1"
	awk -F '\t' -v c="$code" '$1==c{print; exit}' "$VOUCHERS" 2>/dev/null
}

voucher_state() {
	line="$1"
	TAB=$(printf '\t')
IFS="$TAB" read -r code status created plan activated expires customer device <<EOF2
$line
EOF2
	if [ "$status" = UNUSED ]; then echo UNUSED; return; fi
	if [ "$status" = REVOKED ]; then echo REVOKED; return; fi
	# expires=0 means lifetime and never expires.
	if [ -n "$expires" ] && [ "$expires" -gt 0 ] 2>/dev/null && [ "$expires" -le "$(now)" ] 2>/dev/null; then echo EXPIRED; return; fi
	echo ACTIVE
}

is_authorized_ip() {
	ip="$1"
	valid_ip "$ip" || return 1
	nft list set $NFT_FAMILY $NFT_TABLE authorized4 2>/dev/null | grep -Eq "(^|[^0-9])$ip([^0-9]|$)"
}

nft_setup() {
	command -v nft >/dev/null 2>&1 || return 1
	nft list table $NFT_FAMILY $NFT_TABLE >/dev/null 2>&1 || nft add table $NFT_FAMILY $NFT_TABLE 2>/dev/null || true
	nft list set $NFT_FAMILY $NFT_TABLE authorized4 >/dev/null 2>&1 || nft add set $NFT_FAMILY $NFT_TABLE authorized4 '{ type ipv4_addr; flags timeout; timeout 30d; }' 2>/dev/null || true
	if ! nft list chain $NFT_FAMILY $NFT_TABLE portal_nat >/dev/null 2>&1; then
		nft add chain $NFT_FAMILY $NFT_TABLE portal_nat '{ type nat hook prerouting priority dstnat; policy accept; }' 2>/dev/null || true
	fi
	if ! nft list chain $NFT_FAMILY $NFT_TABLE portal_filter >/dev/null 2>&1; then
		nft add chain $NFT_FAMILY $NFT_TABLE portal_filter '{ type filter hook forward priority -150; policy accept; }' 2>/dev/null || true
	fi
	if ! nft list chain $NFT_FAMILY $NFT_TABLE portal_input >/dev/null 2>&1; then
		nft add chain $NFT_FAMILY $NFT_TABLE portal_input '{ type filter hook input priority -150; policy accept; }' 2>/dev/null || true
	fi
	# Rebuild only our own small ruleset.
	nft flush chain $NFT_FAMILY $NFT_TABLE portal_nat 2>/dev/null || true
	nft flush chain $NFT_FAMILY $NFT_TABLE portal_filter 2>/dev/null || true
	nft flush chain $NFT_FAMILY $NFT_TABLE portal_input 2>/dev/null || true
	# Never intercept the router's own LAN address. This keeps LuCI/admin
	# access available even after the captive portal is enabled. Client HTTP
	# traffic to external destinations is redirected as before.
	nft add rule $NFT_FAMILY $NFT_TABLE portal_nat iifname "$LAN_IF" ip daddr != "$PORTAL_IP" ip saddr != @authorized4 tcp dport 80 dnat to "$PORTAL_IP:$PORTAL_PORT" 2>/dev/null || true
	# Keep local DNS and the portal reachable for unauthenticated clients.
	nft add rule $NFT_FAMILY $NFT_TABLE portal_input iifname "$LAN_IF" udp dport 53 accept 2>/dev/null || true
	nft add rule $NFT_FAMILY $NFT_TABLE portal_input iifname "$LAN_IF" tcp dport 53 accept 2>/dev/null || true
	nft add rule $NFT_FAMILY $NFT_TABLE portal_input iifname "$LAN_IF" tcp dport "$PORTAL_PORT" accept 2>/dev/null || true
	# Only currently authorized clients retain established Internet sessions.
	# This prevents revoked/expired vouchers from keeping old connections alive.
	nft add rule $NFT_FAMILY $NFT_TABLE portal_filter iifname "$LAN_IF" ip saddr @authorized4 ct state established,related accept 2>/dev/null || true
	# Unauthorized clients may reach the local portal after HTTP DNAT.
	nft add rule $NFT_FAMILY $NFT_TABLE portal_filter iifname "$LAN_IF" ip daddr "$PORTAL_IP" tcp dport "$PORTAL_PORT" accept 2>/dev/null || true
	nft add rule $NFT_FAMILY $NFT_TABLE portal_filter iifname "$LAN_IF" ip saddr != @authorized4 tcp dport 80 accept 2>/dev/null || true
	# Everything else from an unauthorized client is denied.
	nft add rule $NFT_FAMILY $NFT_TABLE portal_filter iifname "$LAN_IF" ip saddr != @authorized4 drop 2>/dev/null || true
}

authorize_ip() {
	ip="$1"
	plan="$2"
	valid_ip "$ip" || return 1
	nft_setup >/dev/null 2>&1 || true
	if [ "$plan" = lifetime ]; then
		nft add element $NFT_FAMILY $NFT_TABLE authorized4 "{ $ip }" 2>/dev/null || true
	else
		nft add element $NFT_FAMILY $NFT_TABLE authorized4 "{ $ip timeout ${DAYS}d }" 2>/dev/null || true
	fi
}

deauthorize_ip() {
	ip="$1"
	valid_ip "$ip" || return 0
	nft delete element $NFT_FAMILY $NFT_TABLE authorized4 "{ $ip }" 2>/dev/null || true
}

# A device is authorized only while its currently assigned voucher is ACTIVE
# and unexpired. Device history alone is never sufficient for Internet access.
device_voucher_valid() {
	mac=$(normalize_mac "$1")
	[ -n "$mac" ] || return 1
	line=$(awk -F '\t' -v m="$mac" '$8==m{print; exit}' "$VOUCHERS" 2>/dev/null)
	[ -n "$line" ] || return 1
	TAB=$(printf '\t')
	IFS="$TAB" read -r vcode vstatus vcreated vplan vactivated vexpires vcustomer vdevice <<EOFV
$line
EOFV
	[ "$vdevice" = "$mac" ] || return 1
	[ "$vstatus" = "ACTIVE" ] || return 1
	[ "$vexpires" = "0" ] || { [ -n "$vexpires" ] && [ "$vexpires" -gt "$(now)" ] 2>/dev/null; }
}

find_device() {
	mac=$(normalize_mac "$1")
	awk -F '\t' -v m="$mac" '$1==m{print; exit}' "$DEVICES" 2>/dev/null
}

find_customer_by_device() {
	mac=$(normalize_mac "$1")
	awk -F '\t' -v m="$mac" '$1==m{print $2; exit}' "$DEVICES" 2>/dev/null
}

customer_line() {
	id="$1"
	awk -F '\t' -v i="$id" '$1==i{print; exit}' "$CUSTOMERS" 2>/dev/null
}

upsert_customer() {
	id="$1"; name="$2"; mobile="$3"; created="$4"
	tmp="$CUSTOMERS.tmp.$$"
	awk -F '\t' -v i="$id" -v n="$name" -v m="$mobile" -v c="$created" 'BEGIN{OFS="\t"} $1==i{$2=n;$3=m;$4=c;found=1} {print} END{if(!found) print i,n,m,c}' "$CUSTOMERS" > "$tmp" && mv "$tmp" "$CUSTOMERS"
}

upsert_device() {
	mac="$1"; cid="$2"; ip="$3"; name="$4"; activated="$5"; expires="$6"; status="$7"
	tmp="$DEVICES.tmp.$$"
	awk -F '\t' -v m="$mac" -v c="$cid" -v i="$ip" -v n="$name" -v a="$activated" -v e="$expires" -v s="$status" 'BEGIN{OFS="\t"} $1==m{$2=c;$3=i;$4=n;$5=a;$6=e;$7=s;$8=systime();found=1} {print} END{if(!found) print m,c,i,n,a,e,s,systime()}' "$DEVICES" > "$tmp" && mv "$tmp" "$DEVICES"
}

update_device_ip() {
	mac=$(normalize_mac "$1"); ip="$2"
	valid_mac "$mac" || return 1
	valid_ip "$ip" || return 1
	tmp="$DEVICES.tmp.$$"
	awk -F '\t' -v m="$mac" -v i="$ip" 'BEGIN{OFS="\t"} $1==m{$3=i;$8=systime()} {print}' "$DEVICES" > "$tmp" && mv "$tmp" "$DEVICES"
}

set_voucher_active() {
	code="$1"; activated="$2"; expires="$3"; cid="$4"; mac="$5"
	tmp="$VOUCHERS.tmp.$$"
	awk -F '\t' -v c="$code" -v a="$activated" -v e="$expires" -v cid="$cid" -v m="$mac" 'BEGIN{OFS="\t"} $1==c{$2="ACTIVE";$5=a;$6=e;$7=cid;$8=m;found=1} {print} END{if(!found) exit 1}' "$VOUCHERS" > "$tmp" || { rm -f "$tmp"; return 1; }
	mv "$tmp" "$VOUCHERS"
}

revoke_voucher() {
	code="$1"; tmp="$VOUCHERS.tmp.$$"
	awk -F '\t' -v c="$code" 'BEGIN{OFS="\t"} $1==c{$2="REVOKED"} {print}' "$VOUCHERS" > "$tmp" && mv "$tmp" "$VOUCHERS"
}
