#!/bin/sh
# qos-engine.sh - per-device QoS (rate limit + full block) for luci-app-skywifi
# Runs in its own nftables table (inet netmon_qos), fully isolated from the
# accounting table (inet netmon_acct) and from OpenWrt fw4.
#
# Hook layout (forward):
#   netmon_block   priority -210  -> instant internet block (drops)
#   [fw4 filter    priority    0] -> OpenWrt firewall untouched
#   netmon_mark    priority    5  -> DSCP priority tagging (no verdicts)
#   netmon_qos_down/up priority 10-> token-bucket rate limiting (after fw4)
# Rate-limit accept verdicts therefore can never bypass fw4 rules.

QOS_TABLE="inet netmon_qos"
CHAIN_BLOCK="netmon_block"
CHAIN_MARK="netmon_mark"
CHAIN_DOWN="netmon_qos_down"
CHAIN_UP="netmon_qos_up"

RAM_DIR="/tmp/skywifi"

LAN_IF=$(uci -q get skywifi.global.lan_interface || echo "br-lan")
WAN_IF=$(uci -q get skywifi.global.wan_interface || echo "wan")

ROUTER_IP=$(uci -q get network.lan.ipaddr || ip addr show dev "$LAN_IF" 2>/dev/null | grep -oE 'inet [0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | head -n1 | cut -d' ' -f2)
ROUTER_IP=$(echo "$ROUTER_IP" | cut -d/ -f1)
ROUTER_MAC=$(cat "/sys/class/net/$LAN_IF/address" 2>/dev/null | tr '[:upper:]' '[:lower:]' || echo "")

clean_qos() {
	nft delete table $QOS_TABLE 2>/dev/null || true
}

setup_chains() {
	nft add table $QOS_TABLE 2>/dev/null || true
	if ! nft list chain $QOS_TABLE $CHAIN_BLOCK >/dev/null 2>&1; then
		nft add chain $QOS_TABLE $CHAIN_BLOCK '{ type filter hook forward priority -210; policy accept; }' 2>/dev/null || true
	fi
	if ! nft list chain $QOS_TABLE $CHAIN_MARK >/dev/null 2>&1; then
		nft add chain $QOS_TABLE $CHAIN_MARK '{ type filter hook forward priority 5; policy accept; }' 2>/dev/null || true
	fi
	if ! nft list chain $QOS_TABLE $CHAIN_DOWN >/dev/null 2>&1; then
		nft add chain $QOS_TABLE $CHAIN_DOWN '{ type filter hook forward priority 10; policy accept; }' 2>/dev/null || true
	fi
	if ! nft list chain $QOS_TABLE $CHAIN_UP >/dev/null 2>&1; then
		nft add chain $QOS_TABLE $CHAIN_UP '{ type filter hook forward priority 10; policy accept; }' 2>/dev/null || true
	fi
	nft flush chain $QOS_TABLE $CHAIN_BLOCK 2>/dev/null || true
	nft flush chain $QOS_TABLE $CHAIN_MARK 2>/dev/null || true
	nft flush chain $QOS_TABLE $CHAIN_DOWN 2>/dev/null || true
	nft flush chain $QOS_TABLE $CHAIN_UP 2>/dev/null || true
}

valid_ip() {
	echo "$1" | grep -Eq '^(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}(-[0-9.]+)?$'
}

valid_mac() {
	echo "$1" | grep -Eq '^[0-9a-fA-F]{2}(:[0-9a-fA-F]{2}){5}$'
}

expand_ip_range() {
	val="$1"
	if echo "$val" | grep -E -q '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+-[0-9]+$'; then
		base=$(echo "$val" | sed -E 's/^([0-9]+\.[0-9]+\.[0-9]+\.).*/\1/')
		start=$(echo "$val" | sed -E 's/.*\.([0-9]+)-[0-9]+$/\1/')
		end=$(echo "$val" | sed -E 's/.*-([0-9]+)$/\1/')
		echo "${base}${start}-${base}${end}"
	else
		echo "$val"
	fi
}

kill_conntrack_sessions() {
	ip="$1"
	[ -z "$ip" ] && return
	if command -v conntrack >/dev/null 2>&1; then
		conntrack -D -s "$ip" 2>/dev/null || true
		conntrack -D -d "$ip" 2>/dev/null || true
	fi
}

apply_qos_rules() {
	global_enabled=$(uci -q get skywifi.global.enabled || echo "1")
	qos_enabled=$(uci -q get skywifi.qos.enabled || echo "1")
	if [ "$global_enabled" = "0" ] || [ "$qos_enabled" = "0" ]; then
		clean_qos
		echo "{\"status\":\"disabled\",\"global_enabled\":\"$global_enabled\",\"qos_enabled\":\"$qos_enabled\"}"
		exit 0
	fi

	clean_qos
	setup_chains

	applied=0
	errors=0
	result_file="$RAM_DIR/qos_result.tmp"
	: > "$result_file" 2>/dev/null || true

	# Always allow router-local access even for blocked devices
	if [ -n "$ROUTER_IP" ]; then
		nft add rule $QOS_TABLE $CHAIN_BLOCK ip daddr "$ROUTER_IP" accept 2>/dev/null || true
		nft add rule $QOS_TABLE $CHAIN_BLOCK ip saddr "$ROUTER_IP" accept 2>/dev/null || true
	fi

	uci show skywifi 2>/dev/null | grep "=qos_rule" | while read -r line; do
		section=$(echo "$line" | cut -d= -f1 | cut -d. -f2)

		is_enabled=$(uci -q get "skywifi.${section}.enabled")
		[ "$is_enabled" = "0" ] && continue

		ip_val=$(uci -q get "skywifi.${section}.target_val" || uci -q get "skywifi.${section}.target")
		mac_val=$(uci -q get "skywifi.${section}.mac")

		# If target_val holds a MAC address (MAC-only rules), use it as
		# the MAC selector instead of rejecting it as an invalid IP.
		if [ -n "$ip_val" ] && valid_mac "$ip_val"; then
			[ -z "$mac_val" ] && mac_val="$ip_val"
			ip_val=""
		fi

		block_val=$(uci -q get "skywifi.${section}.block" || echo "0")
		max_down=$(uci -q get "skywifi.${section}.max_down")
		down_unit=$(uci -q get "skywifi.${section}.down_unit" || echo "Mbps")
		max_up=$(uci -q get "skywifi.${section}.max_up")
		up_unit=$(uci -q get "skywifi.${section}.up_unit" || echo "Mbps")
		priority=$(uci -q get "skywifi.${section}.priority")

		[ -z "$ip_val" ] && [ -z "$mac_val" ] && continue

		ip_ok=0
		if [ -n "$ip_val" ]; then
			ip_val=$(expand_ip_range "$ip_val")
			if valid_ip "$ip_val"; then
				ip_ok=1
			else
				logger -t netmon-qos "invalid target IP '$ip_val' for section $section, skipping"
				echo ERR >> "$result_file" 2>/dev/null || true
				continue
			fi
			[ "$ip_val" = "$ROUTER_IP" ] && continue
			[ "$ip_val" = "127.0.0.1" ] && continue
		fi

		mac_ok=0
		if [ -n "$mac_val" ] && [ "$mac_val" != "Unknown" ]; then
			if valid_mac "$mac_val"; then
				clean_mac=$(echo "$mac_val" | tr '[:upper:]' '[:lower:]')
				[ "$clean_mac" = "$ROUTER_MAC" ] && continue
				mac_ok=1
			else
				logger -t netmon-qos "invalid MAC '$mac_val' for section $section, skipping"
				echo ERR >> "$result_file" 2>/dev/null || true
				continue
			fi
		fi

		if [ "$block_val" = "1" ] || [ "$block_val" = "true" ] || [ "$block_val" = "yes" ]; then
			if [ "$ip_ok" = "1" ]; then
				nft add rule $QOS_TABLE $CHAIN_BLOCK ip saddr "$ip_val" drop 2>/dev/null || true
				nft add rule $QOS_TABLE $CHAIN_BLOCK ip daddr "$ip_val" drop 2>/dev/null || true
				kill_conntrack_sessions "$ip_val"
			fi
			if [ "$mac_ok" = "1" ]; then
				nft add rule $QOS_TABLE $CHAIN_BLOCK ether saddr "$clean_mac" drop 2>/dev/null || true
				nft add rule $QOS_TABLE $CHAIN_BLOCK ether daddr "$clean_mac" drop 2>/dev/null || true
			fi
			echo OK >> "$result_file" 2>/dev/null || true
			continue
		fi

		down_kbytes=0
		up_kbytes=0

		if [ -n "$max_down" ] && [ "$max_down" -gt 0 ] 2>/dev/null; then
			if [ "$down_unit" = "Kbps" ] || [ "$down_unit" = "kbps" ]; then
				down_kbytes=$((max_down / 8))
				[ "$down_kbytes" -lt 1 ] && down_kbytes=1
			else
				down_kbytes=$((max_down * 125))
			fi
		fi

		if [ -n "$max_up" ] && [ "$max_up" -gt 0 ] 2>/dev/null; then
			if [ "$up_unit" = "Kbps" ] || [ "$up_unit" = "kbps" ]; then
				up_kbytes=$((max_up / 8))
				[ "$up_kbytes" -lt 1 ] && up_kbytes=1
			else
				up_kbytes=$((max_up * 125))
			fi
		fi

		dscp_val="cs0"
		[ "$priority" = "high" ] && dscp_val="cs5"
		[ "$priority" = "low" ] && dscp_val="cs1"

		# Download rate limit (traffic TO the device)
		if [ "$down_kbytes" -gt 0 ]; then
			burst_down=$((down_kbytes / 4))
			[ "$burst_down" -lt 256 ] && burst_down=256
			[ "$burst_down" -gt 4096 ] && burst_down=4096

			if [ "$ip_ok" = "1" ]; then
				nft add rule $QOS_TABLE $CHAIN_DOWN ip daddr "$ip_val" limit rate "${down_kbytes} kbytes/second" burst "${burst_down} kbytes" accept 2>/dev/null || true
				nft add rule $QOS_TABLE $CHAIN_DOWN ip daddr "$ip_val" drop 2>/dev/null || true
			fi
			if [ "$mac_ok" = "1" ]; then
				nft add rule $QOS_TABLE $CHAIN_DOWN ether daddr "$clean_mac" limit rate "${down_kbytes} kbytes/second" burst "${burst_down} kbytes" accept 2>/dev/null || true
				nft add rule $QOS_TABLE $CHAIN_DOWN ether daddr "$clean_mac" drop 2>/dev/null || true
			fi
		fi

		# Upload rate limit (traffic FROM the device)
		if [ "$up_kbytes" -gt 0 ]; then
			burst_up=$((up_kbytes / 4))
			[ "$burst_up" -lt 256 ] && burst_up=256
			[ "$burst_up" -gt 4096 ] && burst_up=4096

			if [ "$ip_ok" = "1" ]; then
				nft add rule $QOS_TABLE $CHAIN_UP ip saddr "$ip_val" limit rate "${up_kbytes} kbytes/second" burst "${burst_up} kbytes" accept 2>/dev/null || true
				nft add rule $QOS_TABLE $CHAIN_UP ip saddr "$ip_val" drop 2>/dev/null || true
			fi
			if [ "$mac_ok" = "1" ]; then
				nft add rule $QOS_TABLE $CHAIN_UP ether saddr "$clean_mac" limit rate "${up_kbytes} kbytes/second" burst "${burst_up} kbytes" accept 2>/dev/null || true
				nft add rule $QOS_TABLE $CHAIN_UP ether saddr "$clean_mac" drop 2>/dev/null || true
			fi
		fi

		# Priority DSCP tagging (mark chain, before rate limiting)
		if [ "$ip_ok" = "1" ] && [ "$priority" != "normal" ]; then
			nft add rule $QOS_TABLE $CHAIN_MARK ip daddr "$ip_val" ip dscp set "$dscp_val" 2>/dev/null || true
		fi

		echo OK >> "$result_file" 2>/dev/null || true
	done

	applied=$(grep -c '^OK$' "$result_file" 2>/dev/null || true)
	errors=$(grep -c '^ERR$' "$result_file" 2>/dev/null || true)
	rm -f "$result_file" 2>/dev/null || true

	echo "{\"status\":\"success\",\"rules_applied\":${applied},\"errors\":${errors}}"
}

qos_status() {
	global_enabled=$(uci -q get skywifi.global.enabled || echo "1")
	qos_enabled=$(uci -q get skywifi.qos.enabled || echo "1")
	if [ "$global_enabled" = "0" ] || [ "$qos_enabled" = "0" ]; then
		printf '{"status":"disabled","enabled":"0","global_enabled":"%s","qos_enabled":"%s","configured":0,"applied_rules":0,"chains":{"block":0,"mark":0,"down":0,"up":0}}\n' "$global_enabled" "$qos_enabled"
		return 0
	fi

	configured=$(uci show skywifi 2>/dev/null | grep -c "=qos_rule" || true)

	nft list table $QOS_TABLE 2>/dev/null | awk -v cfg="$configured" -v qos_en="$qos_enabled" -v glob_en="$global_enabled" '
	BEGIN {
		block = 0; mark = 0; down = 0; up = 0;
	}
	/^[ \t]*chain netmon_/ {
		chain = $2;
	}
	/^[ \t][ \t]+/ {
		if ($1 == "ip" || $1 == "ether" || $1 == "ct") {
			if (chain == "netmon_block") block++
			else if (chain == "netmon_mark") mark++
			else if (chain == "netmon_qos_down") down++
			else if (chain == "netmon_qos_up") up++
		}
	}
	END {
		total = block + mark + down + up;
		printf "{\"status\":\"ok\",\"enabled\":\"1\",\"qos_enabled\":\"%s\",\"global_enabled\":\"%s\",\"configured\":%d,\"applied_rules\":%d,\"chains\":{\"block\":%d,\"mark\":%d,\"down\":%d,\"up\":%d}}\n", qos_en, glob_en, cfg, total, block, mark, down, up;
	}'
}

case "$1" in
	apply)
		apply_qos_rules
		;;
	status)
		qos_status
		;;
	clean)
		clean_qos
		echo '{"status":"cleaned"}'
		;;
	*)
		apply_qos_rules
		;;
esac

exit 0
