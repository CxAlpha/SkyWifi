#!/bin/sh
# urlblock-engine.sh - Multi-layer Website & Content Blocker Engine for luci-app-skywifi
# Enforcement layers:
#   1) DNS Sinkhole (dnsmasq address=/domain/ + addnhosts) for global "all" rules
#   2) Dynamic IP Set blocking (nftables ip daddr @set drop on 80/443) - defeats
#      DNS changes, DoH and proxy tricks - for global AND per-device (MAC) rules
#   3) Encrypted-DNS shield: drops port 853 (DoT) plus known public DoH IPs
#   4) Per-device VPN protocol shield (vpn_block sections)
# "refresh" mode re-resolves blocked domains so IP sets stay current without
# bouncing dnsmasq.

QOS_TABLE="inet netmon_qos"
CHAIN_BLOCK="netmon_block"
DNSMASQ_CONF="/etc/dnsmasq.d/skywifi_block.conf"
HOSTS_BLOCK="/etc/skywifi/hosts_block"
RAM_DIR="/tmp/skywifi"
IPS_DIR="$RAM_DIR/bips"
ALL4_FILE="$IPS_DIR/global_ipv4"
RESULT_FILE="$RAM_DIR/urlblock_result.tmp"

# Known public DNS-over-HTTPS resolver endpoints (blocked on 443 while the
# encrypted-DNS shield is active so clients cannot upgrade to DoH silently).
DOH_IPS="1.1.1.1 1.0.0.1 8.8.8.8 8.8.4.4 9.9.9.9 149.112.112.112 208.67.222.222 208.67.220.220 77.88.8.8 77.88.8.1 94.140.14.14 94.140.15.15 185.228.168.168 185.228.169.169 76.76.2.22 76.76.10.2"

LAN_IF=$(uci -q get skywifi.global.lan_interface || echo "br-lan")
ROUTER_IP=$(uci -q get network.lan.ipaddr || ip addr show dev "$LAN_IF" 2>/dev/null | grep -oE 'inet [0-9]+.[0-9]+.[0-9]+.[0-9]+' | head -n1 | cut -d' ' -f2)
ROUTER_IP=$(echo "$ROUTER_IP" | cut -d/ -f1)

mkdir -p "$RAM_DIR" "$IPS_DIR" /etc/dnsmasq.d /etc/skywifi 2>/dev/null || true

# ---------------------------------------------------------------- helpers

get_domain_aliases() {
	dom="$1"
	case "$dom" in
		youtube.com|*.youtube.com|youtu.be|*.youtu.be|googlevideo.com|*.googlevideo.com)
			echo "youtube.com www.youtube.com m.youtube.com youtu.be googlevideo.com ytimg.com yt3.ggpht.com youtube-nocookie.com"
			;;
		facebook.com|*.facebook.com|fbcdn.net|*.fbcdn.net)
			echo "facebook.com www.facebook.com m.facebook.com fbcdn.net fbsbx.com messenger.com"
			;;
		tiktok.com|*.tiktok.com|tiktokcdn.com|*.tiktokcdn.com)
			echo "tiktok.com www.tiktok.com tiktokcdn.com byteoversea.com ibytedtos.com"
			;;
		instagram.com|*.instagram.com|cdninstagram.com|*.cdninstagram.com)
			echo "instagram.com www.instagram.com cdninstagram.com"
			;;
		twitter.com|*.twitter.com|x.com|*.x.com)
			echo "twitter.com x.com twimg.com t.co"
			;;
		*)
			echo "$dom"
			;;
	esac
}

# Append resolved IPv4 addresses for a domain into a one-IP-per-line file.
# Uses an explicit upstream first so the local sinkhole never poisons the lookup.
# Every lookup is bounded by timeout so a stalled WAN DNS cannot block apply.
resolve_domain_ips() {
	dom="$1"
	out="$2"
	[ -z "$dom" ] && return 0
	ips=""

	if command -v getent >/dev/null 2>&1 && command -v timeout >/dev/null 2>&1; then
		ips=$(timeout 4 getent ahostsv4 "$dom" 2>/dev/null | awk '{print $1}' | grep -E '^[0-9]{1,3}([.][0-9]{1,3}){3}$' | grep -vE '^(0|127|255)\.' | sort -u)
		[ -z "$ips" ] && ips=$(timeout 4 getent hosts "$dom" 2>/dev/null | awk '{print $1}' | grep -E '^[0-9]{1,3}([.][0-9]{1,3}){3}$' | grep -vE '^(0|127|255)\.' | sort -u)
	elif command -v getent >/dev/null 2>&1; then
		ips=$(getent ahostsv4 "$dom" 2>/dev/null | awk '{print $1}' | grep -E '^[0-9]{1,3}([.][0-9]{1,3}){3}$' | grep -vE '^(0|127|255)\.' | sort -u)
		[ -z "$ips" ] && ips=$(getent hosts "$dom" 2>/dev/null | awk '{print $1}' | grep -E '^[0-9]{1,3}([.][0-9]{1,3}){3}$' | grep -vE '^(0|127|255)\.' | sort -u)
	fi
	if [ -z "$ips" ] && command -v nslookup >/dev/null 2>&1 && command -v timeout >/dev/null 2>&1; then
		ips=$(timeout 5 nslookup "$dom" 1.1.1.1 2>/dev/null | grep -oE '[0-9]{1,3}([.][0-9]{1,3}){3}' | grep -vE '^(0|127|255)\.' | sort -u)
	fi
	if [ -z "$ips" ] && command -v nslookup >/dev/null 2>&1; then
		ips=$(nslookup "$dom" 2>/dev/null | grep -oE '[0-9]{1,3}([.][0-9]{1,3}){3}' | grep -vE '^(0|127|255)\.' | sort -u)
	fi
	if [ -z "$ips" ] && command -v ping >/dev/null 2>&1; then
		ips=$(ping -c 1 -W 2 "$dom" 2>/dev/null | grep -oE '\([0-9]{1,3}([.][0-9]{1,3}){3}\)' | head -n 1 | tr -d '()')
	fi

	[ -n "$ips" ] && printf '%s\n' "$ips" >> "$out"
	return 0
}

# Best-effort IPv4 address of a LAN device (lease file, odhcpd hosts, static lease)
client_ip() {
	mac="$1"
	mac=$(echo "$mac" | tr '[:upper:]' '[:lower:]')
	ip=""
	if [ -f /tmp/dhcp.leases ]; then
		ip=$(awk -v m="$mac" '$2 == m { print $3 }' /tmp/dhcp.leases | tail -n 1)
	fi
	if [ -z "$ip" ] && [ -f /tmp/hosts/odhcpd ]; then
		ip=$(awk -v m="$mac" '$3 == m { print $1 }' /tmp/hosts/odhcpd | tail -n 1)
	fi
	ip=$(echo "$ip" | grep -E '^[0-9]{1,3}([.][0-9]{1,3}){3}$' | head -n 1)
	if [ -z "$ip" ]; then
		idx=$(uci -q show dhcp 2>/dev/null | grep -F "dhcp.@host[" | grep -F ".mac='$mac'" | tr -d "'" | grep -oE 'host\[[0-9]+\]' | grep -oE '[0-9]+' | head -n 1)
		if [ -n "$idx" ]; then
			ip=$(uci -q get "dhcp.@host[$idx].ip" | grep -E '^[0-9]{1,3}([.][0-9]{1,3}){3}$' | head -n 1)
		fi
	fi
	echo "$ip"
}

nft_has() {
	command -v nft >/dev/null 2>&1
}

# Drop only URL-blocker-owned sets inside our table (block_ips_*, blk_*, doh_endpoints).
# QoS sets created by qos-engine.sh live in the same table and must NOT be touched.
delete_orphan_sets() {
	nft_has || return 0
	nft list table $QOS_TABLE >/dev/null 2>&1 || return 0
	nft flush chain $QOS_TABLE $CHAIN_BLOCK 2>/dev/null || true
	nft list table $QOS_TABLE 2>/dev/null \
		| awk '/^[[:space:]]*set (block_ips_|blk_|doh_endpoints)/{print $2}' \
		| while read -r s; do
			nft delete set $QOS_TABLE "$s" 2>/dev/null || true
		done
}

# $1 set name, $2 file with one IPv4 per line
add_set_elements() {
	file="$2"
	[ -s "$file" ] || return 0
	ips=$(awk '{printf "%s,", $0}' "$file" | sed 's/,$//')
	[ -z "$ips" ] && return 0
	nft add element $QOS_TABLE "$1" "{ $ips }" 2>/dev/null || true
}

# -------------------------------------------------------------- firewall

ensure_chain() {
	nft_has || return 1
	nft add table $QOS_TABLE 2>/dev/null || true
	if ! nft list chain $QOS_TABLE $CHAIN_BLOCK >/dev/null 2>&1; then
		nft add chain $QOS_TABLE $CHAIN_BLOCK '{ type filter hook forward priority -210; policy accept; }' 2>/dev/null || true
	fi
	nft flush chain $QOS_TABLE $CHAIN_BLOCK 2>/dev/null || true
	# Always allow router-local access
	if [ -n "$ROUTER_IP" ]; then
		nft add rule $QOS_TABLE $CHAIN_BLOCK ip daddr "$ROUTER_IP" accept 2>/dev/null || true
		nft add rule $QOS_TABLE $CHAIN_BLOCK ip saddr "$ROUTER_IP" accept 2>/dev/null || true
	fi
	return 0
}

# Per-device VPN protocol tunnel shield: drops WireGuard/OpenVPN/IPsec/L2TP/PPTP/WARP
# ports only for devices listed in skywifi vpn_block sections.
build_vpn_rules() {
	nft_has || return 0
	secs=$(uci -q show skywifi | grep "=vpn_block" | cut -d= -f1 | cut -d. -f2)
	for sec in $secs; do
		enabled=$(uci -q get "skywifi.${sec}.enabled")
		[ "$enabled" = "0" ] && continue
		mac=$(uci -q get "skywifi.${sec}.mac" || echo "all")
		[ -z "$mac" ] && continue
		if [ "$mac" = "all" ]; then
			prefix=""
		else
			vpn_ip=$(client_ip "$mac")
			# Device offline -> skip; cron refresh re-applies when it returns
			[ -n "$vpn_ip" ] || continue
			prefix="ip saddr $vpn_ip"
		fi

		# Drop specific dedicated VPN tunnel protocol ports only (preserves normal web browsing)
		nft add rule $QOS_TABLE $CHAIN_BLOCK $prefix udp dport 51820 drop 2>/dev/null || true
		nft add rule $QOS_TABLE $CHAIN_BLOCK $prefix udp dport 51821:51825 drop 2>/dev/null || true
		nft add rule $QOS_TABLE $CHAIN_BLOCK $prefix udp dport 2408 drop 2>/dev/null || true
		nft add rule $QOS_TABLE $CHAIN_BLOCK $prefix udp dport 5000 drop 2>/dev/null || true
		nft add rule $QOS_TABLE $CHAIN_BLOCK $prefix udp dport 854 drop 2>/dev/null || true
		nft add rule $QOS_TABLE $CHAIN_BLOCK $prefix udp dport 1194:1198 drop 2>/dev/null || true
		nft add rule $QOS_TABLE $CHAIN_BLOCK $prefix tcp dport 1194:1198 drop 2>/dev/null || true
		nft add rule $QOS_TABLE $CHAIN_BLOCK $prefix udp dport 943 drop 2>/dev/null || true
		nft add rule $QOS_TABLE $CHAIN_BLOCK $prefix tcp dport 943 drop 2>/dev/null || true
		nft add rule $QOS_TABLE $CHAIN_BLOCK $prefix udp dport 500 drop 2>/dev/null || true
		nft add rule $QOS_TABLE $CHAIN_BLOCK $prefix udp dport 4500 drop 2>/dev/null || true
		nft add rule $QOS_TABLE $CHAIN_BLOCK $prefix udp dport 1701 drop 2>/dev/null || true
		nft add rule $QOS_TABLE $CHAIN_BLOCK $prefix tcp dport 1723 drop 2>/dev/null || true
		nft add rule $QOS_TABLE $CHAIN_BLOCK $prefix tcp dport 992 drop 2>/dev/null || true
		nft add rule $QOS_TABLE $CHAIN_BLOCK $prefix tcp dport 5555 drop 2>/dev/null || true
	done
}

build_firewall() {
	force_local_dns="$1"
	block_encrypted_dns="$2"
	ip_defense="$3"

	ensure_chain || return 0

	# Transparent DNS hijack / enforcement (force port 53 to router)
	if [ "$force_local_dns" = "1" ] && [ -n "$ROUTER_IP" ]; then
		nft add rule $QOS_TABLE $CHAIN_BLOCK udp dport 53 ip daddr != "$ROUTER_IP" drop 2>/dev/null || true
		nft add rule $QOS_TABLE $CHAIN_BLOCK tcp dport 53 ip daddr != "$ROUTER_IP" drop 2>/dev/null || true
	fi

	# Encrypted DNS shield: block DoT (853) and public DoH endpoints (443)
	if [ "$block_encrypted_dns" = "1" ]; then
		nft add rule $QOS_TABLE $CHAIN_BLOCK tcp dport 853 drop 2>/dev/null || true
		nft add rule $QOS_TABLE $CHAIN_BLOCK udp dport 853 drop 2>/dev/null || true
		nft add set $QOS_TABLE doh_endpoints '{ type ipv4_addr; }' 2>/dev/null || true
		nft flush set $QOS_TABLE doh_endpoints 2>/dev/null || true
		doh_list=$(echo "$DOH_IPS" | tr ' ' ',')
		nft add element $QOS_TABLE doh_endpoints "{ $doh_list }" 2>/dev/null || true
		nft add rule $QOS_TABLE $CHAIN_BLOCK tcp dport 443 ip daddr @doh_endpoints drop 2>/dev/null || true
		nft add rule $QOS_TABLE $CHAIN_BLOCK udp dport 443 ip daddr @doh_endpoints drop 2>/dev/null || true
	fi

	build_vpn_rules

	# Dynamic IP set defense: drop direct connections to resolved site IPs
	if [ "$ip_defense" = "1" ]; then
		if [ -s "$ALL4_FILE" ]; then
			nft add set $QOS_TABLE block_ips_all '{ type ipv4_addr; }' 2>/dev/null || true
			nft flush set $QOS_TABLE block_ips_all 2>/dev/null || true
			add_set_elements block_ips_all "$ALL4_FILE"
			nft add rule $QOS_TABLE $CHAIN_BLOCK tcp dport 80 ip daddr @block_ips_all drop 2>/dev/null || true
			nft add rule $QOS_TABLE $CHAIN_BLOCK tcp dport 443 ip daddr @block_ips_all drop 2>/dev/null || true
			nft add rule $QOS_TABLE $CHAIN_BLOCK udp dport 443 ip daddr @block_ips_all drop 2>/dev/null || true
		fi
		# Per-device (MAC) rules: only drop traffic sourced from that device
		for f in "$IPS_DIR"/mac_*; do
			[ -f "$f" ] || continue
			[ -s "$f" ] || continue
			mid=$(basename "$f" | cut -d_ -f2-)
			rawmac=$(cat "$IPS_DIR/macmeta_${mid}" 2>/dev/null)
			cip=$(client_ip "$rawmac")
			[ -n "$cip" ] || continue
			setname="blk_${mid}"
			nft add set $QOS_TABLE "$setname" '{ type ipv4_addr; }' 2>/dev/null || true
			nft flush set $QOS_TABLE "$setname" 2>/dev/null || true
			add_set_elements "$setname" "$f"
			nft add rule $QOS_TABLE $CHAIN_BLOCK ip saddr "$cip" tcp dport 80 ip daddr @"$setname" drop 2>/dev/null || true
			nft add rule $QOS_TABLE $CHAIN_BLOCK ip saddr "$cip" tcp dport 443 ip daddr @"$setname" drop 2>/dev/null || true
			nft add rule $QOS_TABLE $CHAIN_BLOCK ip saddr "$cip" udp dport 443 ip daddr @"$setname" drop 2>/dev/null || true
		done
	fi
}

# ------------------------------------------------------------ rule builder

# sink=1 also writes dnsmasq/hosts sinkhole entries (apply mode), ip_defense=1
# resolves domains into IP-set files (apply + refresh mode).
collect_rules() {
	sink="$1"
	ip_defense="$2"

	sections=$(uci -q show skywifi | grep "=block_domain" | cut -d= -f1 | cut -d. -f2)
	for section in $sections; do
		is_enabled=$(uci -q get "skywifi.${section}.enabled")
		[ "$is_enabled" = "0" ] && continue

		domain=$(uci -q get "skywifi.${section}.domain")
		[ -z "$domain" ] && continue

		mac=$(uci -q get "skywifi.${section}.mac" || echo "all")
		mac=${mac:-all}

		# Strip wildcard prefix, then validate domain characters
		clean_dom=${domain#"*."}
		case "$clean_dom" in
			''|*[!a-zA-Z0-9.*-]*) continue ;;
		esac

		alias_list=$(get_domain_aliases "$clean_dom")

		if [ "$mac" = "all" ]; then
			for t in $alias_list; do
				if [ "$sink" = "1" ]; then
					echo "address=/${t}/0.0.0.0" >> "$DNSMASQ_CONF"
					echo "0.0.0.0 ${t}" >> "$HOSTS_BLOCK"
				fi
				[ "$ip_defense" = "1" ] && resolve_domain_ips "$t" "$ALL4_FILE"
			done
		else
			mid=$(echo "$mac" | tr -cd 'a-zA-Z0-9')
			out="$IPS_DIR/mac_${mid}"
			: > "$out"
			echo "$mac" > "$IPS_DIR/macmeta_${mid}"
			for t in $alias_list; do
				[ "$ip_defense" = "1" ] && resolve_domain_ips "$t" "$out"
			done
		fi
	done
}

count_ip_rules() {
	if [ -d "$IPS_DIR" ]; then
		sort -u "$ALL4_FILE" "$IPS_DIR"/mac_* 2>/dev/null | wc -l
	else
		echo 0
	fi
}

flush_conntrack() {
	if command -v conntrack >/dev/null 2>&1; then
		conntrack -D -p tcp --dport 443 2>/dev/null || true
	fi
}

# --------------------------------------------------------------- commands

apply_urlblock() {
	global_enabled=$(uci -q get skywifi.global.enabled || echo "1")

	if [ "$global_enabled" = "0" ]; then
		clean_urlblock
		echo '{"status":"disabled"}'
		exit 0
	fi

	force_local_dns=$(uci -q get skywifi.blocker.force_local_dns || echo "1")
	block_encrypted_dns=$(uci -q get skywifi.blocker.block_encrypted_dns || echo "1")
	ip_defense=$(uci -q get skywifi.blocker.tls_sni_filtering || echo "1")

	# Ensure OpenWrt dnsmasq reads /etc/dnsmasq.d and /etc/skywifi/hosts_block
	confdir=$(uci -q get dhcp.@dnsmasq[0].confdir)
	if [ -z "$confdir" ]; then
		uci set dhcp.@dnsmasq[0].confdir='/etc/dnsmasq.d'
		uci commit dhcp 2>/dev/null || true
	fi

	addnhosts=$(uci -q get dhcp.@dnsmasq[0].addnhosts)
	if ! echo "$addnhosts" | grep -q "$HOSTS_BLOCK"; then
		uci add_list dhcp.@dnsmasq[0].addnhosts="$HOSTS_BLOCK"
		uci commit dhcp 2>/dev/null || true
	fi

	# Reset block files and IP cache
	: > "$DNSMASQ_CONF"
	: > "$HOSTS_BLOCK"
	rm -rf "$IPS_DIR"
	mkdir -p "$IPS_DIR"
	: > "$ALL4_FILE"


	collect_rules 1 "$ip_defense"

	delete_orphan_sets
	build_firewall "$force_local_dns" "$block_encrypted_dns" "$ip_defense"

	# Reload dnsmasq to pick up both /etc/dnsmasq.d and hosts_block
	if [ -x /etc/init.d/dnsmasq ]; then
		/etc/init.d/dnsmasq restart >/dev/null 2>&1 || true
	fi

	flush_conntrack

	ip_count=$(count_ip_rules)
	echo "{\"status\":\"ok\",\"applied\":true,\"ip_rules\":$ip_count}" > "$RESULT_FILE"
}

refresh_urlblock() {
	global_enabled=$(uci -q get skywifi.global.enabled || echo "1")

	if [ "$global_enabled" = "0" ]; then
		exit 0
	fi

	force_local_dns=$(uci -q get skywifi.blocker.force_local_dns || echo "1")
	block_encrypted_dns=$(uci -q get skywifi.blocker.block_encrypted_dns || echo "1")
	ip_defense=$(uci -q get skywifi.blocker.tls_sni_filtering || echo "1")

	# Re-resolve domains into fresh IP files without touching dnsmasq
	rm -rf "$IPS_DIR"
	mkdir -p "$IPS_DIR"
	: > "$ALL4_FILE"
	collect_rules 0 "$ip_defense"

	delete_orphan_sets
	build_firewall "$force_local_dns" "$block_encrypted_dns" "$ip_defense"

	flush_conntrack

	ip_count=$(count_ip_rules)
	echo "{\"status\":\"refreshed\",\"ip_rules\":$ip_count}" > "$RESULT_FILE"
}

clean_urlblock() {
	# Remove dnsmasq block files
	rm -f "$DNSMASQ_CONF" "$HOSTS_BLOCK"
	rm -rf "$IPS_DIR"
	if [ -x /etc/init.d/dnsmasq ]; then
		/etc/init.d/dnsmasq restart >/dev/null 2>&1 || true
	fi

	# Clean nftables block chain and any orphaned sets
	nft_has || return 0
	if nft list table $QOS_TABLE >/dev/null 2>&1; then
		nft flush chain $QOS_TABLE $CHAIN_BLOCK 2>/dev/null || true
		delete_orphan_sets
	fi
}

get_status() {
	force_local_dns=$(uci -q get skywifi.blocker.force_local_dns || echo "1")
	block_encrypted_dns=$(uci -q get skywifi.blocker.block_encrypted_dns || echo "1")
	tls_sni_filtering=$(uci -q get skywifi.blocker.tls_sni_filtering || echo "1")

	ip_count=$(count_ip_rules)

	printf '{\n'
	printf '  "enabled": "1",\n'
	printf '  "force_local_dns": "%s",\n' "$force_local_dns"
	printf '  "block_encrypted_dns": "%s",\n' "$block_encrypted_dns"
	printf '  "tls_sni_filtering": "%s",\n' "$tls_sni_filtering"
	printf '  "ip_rules": "%s",\n' "$ip_count"
	printf '  "vpn_devices": ['

	vpn_first=1
	vpn_sections=$(uci -q show skywifi | grep "=vpn_block" | cut -d= -f1 | cut -d. -f2)
	for vsec in $vpn_sections; do
		vmac=$(uci -q get "skywifi.${vsec}.mac")
		[ -z "$vmac" ] && continue
		venabled=$(uci -q get "skywifi.${vsec}.enabled" || echo "1")
		if [ "$vpn_first" = "0" ]; then
			printf ','
		fi
		vpn_first=0
		printf '{"mac":"%s","enabled":"%s"}' "$vmac" "$venabled"
	done
	printf '],\n'
	printf '  "domains": ['

	first=1
	sections=$(uci -q show skywifi | grep "=block_domain" | cut -d= -f1 | cut -d. -f2)
	for section in $sections; do
		domain=$(uci -q get "skywifi.${section}.domain")
		enabled=$(uci -q get "skywifi.${section}.enabled" || echo "1")
		mac=$(uci -q get "skywifi.${section}.mac" || echo "all")
		category=$(uci -q get "skywifi.${section}.category" || echo "custom")

		[ -z "$domain" ] && continue

		if [ "$first" = "0" ]; then
			printf ','
		fi
		first=0
		printf '{"section":"%s","domain":"%s","enabled":"%s","mac":"%s","category":"%s"}' "$section" "$domain" "$enabled" "$mac" "$category"
	done
	printf ']\n}\n'
}

case "$1" in
	apply)
		apply_urlblock
		;;
	refresh)
		refresh_urlblock
		;;
	clean)
		clean_urlblock
		;;
	status)
		get_status
		;;
	*)
		echo "Usage: $0 {apply|refresh|clean|status}"
		exit 1
		;;
esac

exit 0
