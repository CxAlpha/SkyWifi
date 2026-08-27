#!/bin/sh
# netmon-netinfo.sh - upstream connections & interface status for
# luci-app-skywifi. Read-only; emits JSON on stdout:
#   {"timestamp":...,"upstreams":[{iface,gateway,ipv4[],ipv6[],dns[],
#     ping_ms,ping_ok,rx_bytes,tx_bytes}...],
#    "interfaces":[{name,state,carrier,mac,ipv4[],ipv6[],rx_bytes,
#     tx_bytes,speed}...]}

ts=$(date +%s)

# Combine IPv4 and IPv6 default routes
default_routes=$( { ip -4 route show default 2>/dev/null; ip -6 route show default 2>/dev/null; } )

# map "device|gateway" for every default route
dev_gw=$(printf '%s\n' "$default_routes" | awk '
	{
		gw = ""; dev = "";
		for (i = 1; i <= NF; i++) {
			if ($i == "via") gw = $(i+1);
			if ($i == "dev") dev = $(i+1);
		}
		if (dev != "") print dev "|" (gw != "" ? gw : "?");
	}')

# upstream devices: default-route devices plus the configured WAN iface
up_devs=$(printf '%s\n' "$dev_gw" | cut -d'|' -f1 | sort -u)
wan_cfg=$(uci -q get skywifi.global.wan_interface 2>/dev/null)
[ -z "$wan_cfg" ] && wan_cfg="wan"
wdev=$(uci -q get "network.$wan_cfg.device" 2>/dev/null)
[ -z "$wdev" ] && wdev=$(uci -q get "network.$wan_cfg.ifname" 2>/dev/null)
[ -z "$wdev" ] && wdev="$wan_cfg"
up_devs=$(printf '%s\n%s\n' "$up_devs" "$wdev" | sort -u)

NET_DUMP=$(uci show network 2>/dev/null)

# uci iface name -> proto/dns/uci_name lookup helper (per device)
iface_info() {
	dev="$1"
	[ -z "$dev" ] && { printf '||'; return; }
	info=$(printf '%s\n' "$NET_DUMP" | awk -v dev="$dev" '
	{
		split($0, a, "=");
		key = a[1]; val = a[2];
		gsub(/'\''/, "", val);
		split(key, kparts, ".");
		ifn = kparts[2]; param = kparts[3];
		if (param == "device" || param == "ifname") {
			if (val == dev) dev_ifns[ifn] = 1;
		}
		if (param == "proto") protos[ifn] = val;
		if (param == "dns") dnses[ifn] = val;
	}
	END {
		uiname = ""; p = ""; d = "";
		for (ifn in dev_ifns) {
			if (uiname == "") uiname = ifn;
			if (protos[ifn] != "") {
				if (p == "") p = protos[ifn];
				else if (p != protos[ifn]) p = p "/" protos[ifn];
			}
			if (dnses[ifn] != "") {
				d = (d != "") ? d " " dnses[ifn] : dnses[ifn];
			}
		}
		print p "|" d "|" uiname;
	}')
	p="${info%%|*}"
	rest="${info#*|}"
	d="${rest%%|*}"
	uiname="${rest#*|}"
	if [ -z "$d" ]; then
		for rf in /tmp/resolv.conf.d/resolv.conf.auto /tmp/resolv.conf.auto /etc/resolv.conf; do
			if [ -f "$rf" ]; then
				d=$(grep '^nameserver' "$rf" 2>/dev/null | awk '{print $2}' | tr '\n' ' ')
				[ -n "$d" ] && break
			fi
		done
	fi
	printf '%s|%s|%s' "$p" "$d" "$uiname"
}

# ping once; handles both IPv4 and IPv6 gateways
ping_host() {
	target="$1"
	case "$target" in
		*:*) cmd="ping6" ;;
		*) cmd="ping" ;;
	esac
	out=$($cmd -c1 -W1 "$target" 2>/dev/null)
	t=$(printf '%s\n' "$out" | grep -o 'time=[0-9.]*' | head -1 | cut -d= -f2)
	[ -n "$t" ] && printf '%.1f' "$t"
}

# IPv4 addresses of a device
dev_ips4() {
	dev="$1"
	ip -4 addr show dev "$dev" 2>/dev/null | awk '/inet /{print $2}'
}

# IPv6 addresses of a device (prefer global/ULA, fallback to link-local)
dev_ips6() {
	dev="$1"
	g6=$(ip -6 addr show dev "$dev" 2>/dev/null | awk '/inet6 /{if ($2 !~ /^fe80/i && $2 !~ /^::1/) print $2}')
	if [ -n "$g6" ]; then
		echo "$g6"
	else
		ip -6 addr show dev "$dev" 2>/dev/null | awk '/inet6 /{if ($2 !~ /^::1/) print $2}'
	fi
}

sys_bytes() {
	[ -r "/sys/class/net/$1/statistics/rx_bytes" ] && cat "/sys/class/net/$1/statistics/rx_bytes" 2>/dev/null
}

# wrap a comma-joined list into a valid JSON array; empty -> []
mkarr() {
	s=$(printf '%s' "$1" | sed 's/,$//')
	if [ -z "$s" ]; then
		printf '[]'
	else
		echo "$s" | awk -F',' '{
			out = "";
			for (i = 1; i <= NF; i++) {
				if ($i == "") continue;
				item = sprintf("\"%s\"", $i);
				if (out == "") out = item; else out = out "," item;
			}
			print "[" out "]";
		}'
	fi
}

upstreams_json=""
for dev in $up_devs; do
	gw=$(printf '%s\n' "$dev_gw" | grep "^$dev|" | cut -d'|' -f2 | head -1)
	[ -z "$gw" ] && gw="?"
	if [ "$gw" != "?" ] && [ "$gw" != "unreachable" ]; then
		ms=$(ping_host "$gw")
	else
		ms=""
	fi
	[ -n "$ms" ] && ping_ok=1 || ping_ok=0
	[ -z "$ms" ] && ms="null"

	info=$(iface_info "$dev")
	proto="${info%%|*}"
	rest="${info#*|}"
	dns="${rest%%|*}"

	ips4_json=""
	for a in $(dev_ips4 "$dev"); do
		[ -n "$a" ] && ips4_json="$ips4_json$a,"
	done

	ips6_json=""
	for a in $(dev_ips6 "$dev"); do
		[ -n "$a" ] && ips6_json="$ips6_json$a,"
	done

	dns_json=""
	for d in $dns; do
		dns_json="$dns_json$d,"
	done

	rx=$(sys_bytes "$dev"); [ -z "$rx" ] && rx=0
	txf="/sys/class/net/$dev/statistics/tx_bytes"
	tx=0; [ -r "$txf" ] && tx=$(cat "$txf" 2>/dev/null)

	item=$(printf '{"iface":"%s","proto":"%s","gateway":"%s","ipv4":%s,"ipv6":%s,"dns":%s,"ping_ms":%s,"ping_ok":%s,"rx_bytes":%s,"tx_bytes":%s}' \
		"$dev" "$proto" "$gw" "$(mkarr "$ips4_json")" "$(mkarr "$ips6_json")" "$(mkarr "$dns_json")" "$ms" "$ping_ok" "$rx" "$tx")
	upstreams_json="$upstreams_json$item,"
done
upstreams_json=$(printf '%s' "$upstreams_json" | sed 's/,$//')

interfaces_json=""
for intf in /sys/class/net/*; do
	[ -d "$intf" ] || continue
	dev=$(basename "$intf")
	case "$dev" in
		lo|pppoe-*|ppp*|tun*|tap*|veth*|ifb*|gre*|sit*|ip6tnl*)
			continue
			;;
	esac

	is_bridge=0
	[ -d "$intf/bridge" ] && is_bridge=1

	master=""
	if [ -L "$intf/brport/bridge" ]; then
		master=$(basename "$(readlink -f "$intf/brport/bridge" 2>/dev/null)" 2>/dev/null)
	elif [ -d "$intf/master" ] || [ -L "$intf/master" ]; then
		master=$(basename "$(readlink -f "$intf/master" 2>/dev/null)" 2>/dev/null)
	fi

	state=$(cat "$intf/operstate" 2>/dev/null)
	carrier=0
	[ -r "$intf/carrier" ] && carrier=$(cat "$intf/carrier" 2>/dev/null)
	[ -z "$carrier" ] && carrier=0

	mac=$(cat "$intf/address" 2>/dev/null)
	speed=$(cat "$intf/speed" 2>/dev/null)
	case "$speed" in
		''|*-*|*[!0-9]*) speed=0 ;;
	esac
	rx=$(sys_bytes "$dev"); [ -z "$rx" ] && rx=0
	txf="$intf/statistics/tx_bytes"
	tx=0; [ -r "$txf" ] && tx=$(cat "$txf" 2>/dev/null)

	ips4_json=""
	for a in $(dev_ips4 "$dev"); do
		[ -n "$a" ] && ips4_json="$ips4_json$a,"
	done

	ips6_json=""
	for a in $(dev_ips6 "$dev"); do
		[ -n "$a" ] && ips6_json="$ips6_json$a,"
	done

	# Resolve bridge status and carrier
	if [ "$is_bridge" -eq 1 ]; then
		has_slave_up=0
		for slave in "$intf"/brif/*; do
			[ -d "$slave" ] || continue
			sc=$(cat "$slave/carrier" 2>/dev/null)
			if [ "$sc" = "1" ]; then
				has_slave_up=1
				break
			fi
		done
		if [ "$has_slave_up" -eq 1 ] || [ -n "$ips4_json" ] || [ -n "$ips6_json" ]; then
			carrier=1
			state="up"
		fi
	fi

	# interface type: wireless radio (sysfs wireless/phy80211), loopback, wired
	iftype="wired"
	if [ -d "$intf/wireless" ] || [ -d "/sys/class/net/$dev/phy80211" ]; then
		iftype="wireless"
	elif [ "$dev" = "lo" ]; then
		iftype="loopback"
	fi
	phy=""
	[ -L "/sys/class/net/$dev/phy80211" ] && phy=$(basename "$(readlink -f "/sys/class/net/$dev/phy80211" 2>/dev/null)" 2>/dev/null)

	info=$(iface_info "$dev")
	proto="${info%%|*}"
	rest="${info#*|}"
	dns="${rest%%|*}"
	uci_name="${rest#*|}"

	item=$(printf '{"name":"%s","uci_name":"%s","type":"%s","phy":"%s","is_bridge":%d,"master":"%s","state":"%s","carrier":%s,"mac":"%s","ipv4":%s,"ipv6":%s,"rx_bytes":%s,"tx_bytes":%s,"speed":%s}' \
		"$dev" "$uci_name" "$iftype" "$phy" "$is_bridge" "$master" "$state" "$carrier" "$mac" "$(mkarr "$ips4_json")" "$(mkarr "$ips6_json")" "$rx" "$tx" "$speed")
	interfaces_json="$interfaces_json$item,"
done
interfaces_json=$(printf '%s' "$interfaces_json" | sed 's/,$//')

printf '{"timestamp":%s,"upstreams":[%s],"interfaces":[%s]}' "$ts" "$upstreams_json" "$interfaces_json"


