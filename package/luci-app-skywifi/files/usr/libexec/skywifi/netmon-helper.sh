#!/bin/sh
# netmon-helper.sh - core traffic accounting engine for luci-app-skywifi
# Single-writer design: only the daemon triggers "sync". Every other consumer
# reads the daemon's cached snapshot (current_stats.json) which is published
# atomically with server-side computed speeds.
#
# nftables layout (fully isolated from OpenWrt fw4 and the QoS engine):
#   table inet netmon_acct { chain luci_netmon_acct { hook forward prio -200 } }
#   counter rules: ip daddr <ip> / ip saddr <ip> with comment "netmon_rx_<mac12>"
# Counters are never reset by readers; the daemon folds them into RAM
# accumulator files (.dat) at a fixed cadence and on rule changes.

RAM_DIR="/tmp/skywifi"
STORAGE_DIR=$(uci -q get skywifi.global.storage_path || echo "/etc/skywifi/history")
if ! mkdir -p "$STORAGE_DIR" 2>/dev/null; then
	STORAGE_DIR="$RAM_DIR/history"
fi

DAT_DIR="$RAM_DIR/dat"
SNAPSHOT="$RAM_DIR/current_stats.json"
SNAP_TMP="$RAM_DIR/current_stats.json.tmp"
LOCK="$RAM_DIR/poll.lock"
RESET_Q="$RAM_DIR/reset_queue"

ACCT_TABLE="inet netmon_acct"
ACCT_CHAIN="luci_netmon_acct"
DAT_EVERY=5
POLL_CNT=0

LAN_IF=$(uci -q get skywifi.global.lan_interface || echo "br-lan")
WAN_IF=$(uci -q get skywifi.global.wan_interface || echo "wan")
LAN_MAC=$(cat "/sys/class/net/$LAN_IF/address" 2>/dev/null | tr '[:upper:]' '[:lower:]')
WAN_MAC=$(cat "/sys/class/net/$WAN_IF/address" 2>/dev/null | tr '[:upper:]' '[:lower:]')
WAN_IP=$(ip -4 addr show dev "$WAN_IF" 2>/dev/null | awk '/inet /{sub(/\/.*/, "", $2); print $2; exit}')
ACTIVE_FILE="$RAM_DIR/active_map"
ACTIVE_WINDOW=60

mkdir -p "$RAM_DIR" "$STORAGE_DIR" "$DAT_DIR" "$STORAGE_DIR/dat" 2>/dev/null || true

POLL_INT=$(uci -q get skywifi.global.poll_interval || echo 1)
case "$POLL_INT" in
	''|*[!0-9]*) POLL_INT=1 ;;
esac
[ "$POLL_INT" -lt 1 ] && POLL_INT=1

now_sec() {
	date +%s
}

ensure_chain() {
	if [ ! -f "$RAM_DIR/chain_created" ]; then
		nft add table $ACCT_TABLE 2>/dev/null || true
		if ! nft list chain $ACCT_TABLE $ACCT_CHAIN >/dev/null 2>&1; then
			nft add chain $ACCT_TABLE $ACCT_CHAIN '{ type filter hook forward priority -200; policy accept; }' 2>/dev/null || true
		fi
		touch "$RAM_DIR/chain_created" 2>/dev/null || true
	fi
}

# Collect cheap router system telemetry for the dashboard: CPU load average,
# RAM/swap/cache usage (kB from /proc/meminfo), root filesystem usage,
# SoC temperature (first thermal zone, millidegrees) and established TCP
# connection count. Emits a JSON object consumed by collect().
get_sys_stats() {
	load="0.00 0.00 0.00"
	[ -r /proc/loadavg ] && load=$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null)

	# CPU utilization % from /proc/stat tick deltas against the previous
	# cycle. First sample has no baseline -> 0 (falls back to the badge
	# rendering a sensible value on the very first poll).
	cpu_pct=0
	if [ -r /proc/stat ]; then
		cur=$(awk '/^cpu /{for (i = 2; i <= NF; i++) tot += $i; idle = $5 + $6; printf "%d %d", tot, idle}' /proc/stat)
		if [ -f "$RAM_DIR/cpu_prev" ]; then
			prev=$(cat "$RAM_DIR/cpu_prev" 2>/dev/null)
			ptot=${prev%% *}; pidle=${prev##* }
			ctot=${cur%% *}; cidle=${cur##* }
			dtot=$((ctot - ptot)); didle=$((cidle - pidle))
			if [ "$dtot" -gt 0 ] 2>/dev/null; then
				cpu_pct=$(( (100 * (dtot - didle)) / dtot ))
				[ "$cpu_pct" -lt 0 ] && cpu_pct=0
				[ "$cpu_pct" -gt 100 ] && cpu_pct=100
			fi
		fi
		printf '%s' "$cur" > "$RAM_DIR/cpu_prev" 2>/dev/null
	fi

	mem_total=0; mem_free=0; mem_avail=0; mem_buf=0; mem_cached=0; swap_total=0; swap_free=0
	if [ -r /proc/meminfo ]; then
		while read -r key val unit; do
			case "$key" in
				MemTotal:) mem_total=$val ;;
				MemFree:) mem_free=$val ;;
				MemAvailable:) mem_avail=$val ;;
				Buffers:) mem_buf=$val ;;
				Cached:) mem_cached=$val ;;
				SwapTotal:) swap_total=$val ;;
				SwapFree:) swap_free=$val ;;
			esac
		done < /proc/meminfo
	fi

	disk_total=0; disk_used=0; disk_avail=0
	disk_cache="$RAM_DIR/disk_stats.cache"
	now_time=$(date +%s)
	if [ -f "$disk_cache" ]; then
		disk_mtime=$(stat -c %Y "$disk_cache" 2>/dev/null || echo 0)
		if [ $((now_time - disk_mtime)) -lt 30 ]; then
			read -r disk_total disk_used disk_avail < "$disk_cache" 2>/dev/null || true
		fi
	fi
	if [ -z "$disk_total" ] || [ "$disk_total" -eq 0 ] 2>/dev/null; then
		if command -v df >/dev/null 2>&1; then
			set -- $(df -k / 2>/dev/null | tail -1)
			disk_total=${2:-0}; disk_used=${3:-0}; disk_avail=${4:-0}
			echo "$disk_total $disk_used $disk_avail" > "$disk_cache" 2>/dev/null || true
		fi
	fi

	temp=""
	for tz in /sys/class/thermal/thermal_zone*/temp; do
		[ -r "$tz" ] || continue
		t=$(cat "$tz" 2>/dev/null)
		case "$t" in
			''|*[!0-9-]*) continue ;;
		esac
		temp=$(awk -v v="$t" 'BEGIN { printf "%.1f", v / 1000 }')
		break
	done

	# Active connections THROUGH the router = conntrack flow count
	# (authoritative; includes forwarded TCP/UDP/ICMP traffic). Reads directly
	# from /proc sysfs to avoid subshell binary executions per cycle.
	conns=0
	if [ -r /proc/sys/net/netfilter/nf_conntrack_count ]; then
		conns=$(cat /proc/sys/net/netfilter/nf_conntrack_count 2>/dev/null)
	elif command -v conntrack >/dev/null 2>&1; then
		conns=$(conntrack -C 2>/dev/null)
	fi
	if [ -z "$conns" ] || [ "$conns" -eq 0 ] 2>/dev/null || ! [ "$conns" -ge 0 ] 2>/dev/null; then
		conns=0
		if [ -r /proc/net/tcp ]; then
			conns=$(awk 'NR>1 && $4=="01"{c++} END{print c+0}' /proc/net/tcp 2>/dev/null)
		fi
		if [ -r /proc/net/tcp6 ]; then
			c6=$(awk 'NR>1 && $4=="01"{c++} END{print c+0}' /proc/net/tcp6 2>/dev/null)
			conns=$((conns + c6))
		fi
	fi

	printf '{"load":"%s","cpu_pct":%s,"mem_total":%s,"mem_free":%s,"mem_avail":%s,"mem_buf":%s,"mem_cached":%s,"swap_total":%s,"swap_free":%s,"disk_total":%s,"disk_used":%s,"disk_avail":%s,"temp":%s,"conns":%s}' \
		"$load" "$cpu_pct" "$mem_total" "$mem_free" "$mem_avail" "$mem_buf" "$mem_cached" \
		"$swap_total" "$swap_free" "$disk_total" "$disk_used" "$disk_avail" \
		"${temp:-null}" "$conns"
}

# Build the host lookup table: mac|ip|hostname|online
# LAN-ONLY: the router's own interfaces, the WAN link and WAN-side neighbors
# (gateway, ISP modem) are excluded from every source so only LAN client
# traffic is ever accounted. ARP entries on any non-WAN interface are
# accepted, so all LAN interfaces (br-lan, guest bridges, VLAN ports) count.
get_mac_ip_hosts() {
	lookup_file="$RAM_DIR/device_lookup_$$.tmp"
	trap 'rm -f "$lookup_file"' EXIT INT TERM
	rm -f "$lookup_file" 2>/dev/null

	# 1. DHCP leases (/tmp/dhcp.leases or /tmp/dnsmasq.leases)
	dhcp_file="/tmp/dhcp.leases"
	[ ! -f "$dhcp_file" ] && dhcp_file="/tmp/dnsmasq.leases"

	if [ -f "$dhcp_file" ]; then
		awk -v lan_mac="$LAN_MAC" -v wan_mac="$WAN_MAC" -v wan_ip="$WAN_IP" '
		{
			mac = tolower($2);
			ip = $3;
			host = ($4 != "*" && $4 != "") ? $4 : "Unknown";
			if (mac == "" || mac == "00:00:00:00:00:00") next;
			if (mac == lan_mac || mac == wan_mac || ip == wan_ip) next;
			print mac "|" ip "|" host "|0|dhcp";
		}' "$dhcp_file" >> "$lookup_file" 2>/dev/null
	fi

	# 1b. UBUS DHCP Leases (authoritative for OpenWrt odhcpd/dnsmasq dynamic & static leases)
	if command -v ubus >/dev/null 2>&1; then
		ubus call dhcp get_leases 2>/dev/null | awk -F'"' -v lan_mac="$LAN_MAC" -v wan_mac="$WAN_MAC" -v wan_ip="$WAN_IP" '{
			for (i = 1; i <= NF; i++) {
				if ($i == "mac") mac = tolower($(i+2));
				if ($i == "ip") ip = $(i+2);
				if ($i == "hostname") {
					host = $(i+2);
					if (mac != "" && mac != "00:00:00:00:00:00" && mac != lan_mac && mac != wan_mac && ip != wan_ip) {
						print mac "|" ip "|" (host != "" ? host : "Unknown") "|0|dhcpubus";
						mac = ""; ip = ""; host = "";
					}
				}
			}
		}' >> "$lookup_file" 2>/dev/null
	fi

	# 2. Modern OpenWrt IP Neighbor table (ip -4 neighbor show)
	#    Authoritative for active LAN clients even when hardware flow offloading / WED is enabled.
	if command -v ip >/dev/null 2>&1; then
		ip -4 neighbor show 2>/dev/null | awk -v lan_if="$LAN_IF" -v wan_if="$WAN_IF" -v lan_mac="$LAN_MAC" -v wan_mac="$WAN_MAC" -v wan_ip="$WAN_IP" '
		/lladdr/ {
			ip = $1;
			mac = ""; dev = ""; state = "";
			for (i = 1; i <= NF; i++) {
				if ($i == "dev") dev = $(i+1);
				if ($i == "lladdr") mac = tolower($(i+1));
				if (i == NF) state = $i;
			}
			if (mac == "" || mac == "00:00:00:00:00:00" || mac == lan_mac || mac == wan_mac || ip == wan_ip) next;
			is_lan = 0;
			if (lan_if != "" && dev == lan_if) is_lan = 1;
			if (dev != "" && dev != wan_if && dev !~ /^wan/ && dev !~ /^ppp/ && dev !~ /^tun/) is_lan = 1;
			if (!is_lan) next;
			online = (state == "REACHABLE" || state == "PERMANENT") ? 1 : 0;
			print mac "|" ip "|Unknown|" online "|ipneigh";
		}' >> "$lookup_file" 2>/dev/null
	fi

	# 2b. /proc/net/arp fallback for active devices on LAN interfaces
	if [ -f /proc/net/arp ]; then
		awk -v lan_if="$LAN_IF" -v wan_if="$WAN_IF" -v lan_mac="$LAN_MAC" -v wan_mac="$WAN_MAC" -v wan_ip="$WAN_IP" '
		NR > 1 && $4 != "00:00:00:00:00:00" {
			dev = $6;
			is_lan = 0;
			if (lan_if != "" && dev == lan_if) is_lan = 1;
			if (dev != "" && dev != wan_if && dev !~ /^wan/ && dev !~ /^ppp/ && dev !~ /^tun/) is_lan = 1;
			if (!is_lan) next;
			ip = $1;
			mac = tolower($4);
			if (mac == lan_mac || mac == wan_mac || ip == wan_ip) next;
			print mac "|" ip "|Unknown|0|arp";
		}' /proc/net/arp >> "$lookup_file" 2>/dev/null
	fi

	# 2c. Recent traffic activity (written by daemon each cycle)
	if [ -f "$ACTIVE_FILE" ]; then
		now=$(date +%s)
		awk -F'|' -v now="$now" -v win="$ACTIVE_WINDOW" -v lan_mac="$LAN_MAC" -v wan_mac="$WAN_MAC" '
		{
			m12 = tolower($1);
			ts = $2 + 0;
			if (length(m12) == 12 && ts > 0 && (now - ts) <= win) {
				if (m12 == lan_mac || m12 == wan_mac) next;
				mac = substr(m12,1,2) ":" substr(m12,3,2) ":" substr(m12,5,2) ":" substr(m12,7,2) ":" substr(m12,9,2) ":" substr(m12,11,2);
				print mac "|0.0.0.0|Unknown|1|active";
			}
		}' "$ACTIVE_FILE" >> "$lookup_file" 2>/dev/null
	fi

	# 3. Known devices from RAM + storage accumulator files (aged out after 14 days)
	lan_m12=$(echo "$LAN_MAC" | tr -d ':' 2>/dev/null)
	wan_m12=$(echo "$WAN_MAC" | tr -d ':' 2>/dev/null)
	now=$(date +%s)
	stat -c "%n %Y" "$DAT_DIR"/*.dat "$STORAGE_DIR"/dat/*.dat 2>/dev/null | awk -v now="$now" -v lan_m12="$lan_m12" -v wan_m12="$wan_m12" '{
		df = $1;
		mtime = $2 + 0;
		if (now - mtime > 1209600) next;
		n = split(df, parts, "/");
		bname = parts[n];
		sub(/\.dat$/, "", bname);
		if (length(bname) == 12 && bname != lan_m12 && bname != wan_m12) {
			mac = tolower(substr(bname,1,2) ":" substr(bname,3,2) ":" substr(bname,5,2) ":" substr(bname,7,2) ":" substr(bname,9,2) ":" substr(bname,11,2));
			print mac "|0.0.0.0|Unknown|0|history";
		}
	}' >> "$lookup_file" 2>/dev/null

	# 4. Current snapshot hostnames/ips
	if [ -f "$SNAPSHOT" ]; then
		awk -F'"' -v lan_mac="$LAN_MAC" -v wan_mac="$WAN_MAC" -v wan_ip="$WAN_IP" '{
			for (i = 1; i <= NF; i++) {
				if ($i == "mac") mac = tolower($(i+2));
				if ($i == "ip") ip = $(i+2);
				if ($i == "hostname") { host = $(i+2); if (mac != "" && mac != lan_mac && mac != wan_mac && ip != wan_ip) { print mac "|" ip "|" host "|0|snap"; mac = ""; } }
			}
		}' "$SNAPSHOT" >> "$lookup_file" 2>/dev/null
	fi

	# 4b. Custom Device Aliases / Names from UCI config
	uci show skywifi 2>/dev/null | grep "=device_name" | while read -r line; do
		sec=$(echo "$line" | cut -d= -f1 | cut -d. -f2)
		cmac=$(uci -q get "skywifi.${sec}.mac" | tr '[:upper:]' '[:lower:]')
		cname=$(uci -q get "skywifi.${sec}.name")
		if [ -n "$cmac" ] && [ -n "$cname" ]; then
			echo "$cmac|0.0.0.0|$cname|0|custom" >> "$lookup_file" 2>/dev/null
		fi
	done

	# 5. Merge & unique: prefer real IPs/hostnames, custom names override defaults
	awk -F'|' -v lan_mac="$LAN_MAC" -v wan_mac="$WAN_MAC" '
	{
		mac = tolower($1);
		clean_mac = mac; gsub(/[^0-9a-fA-F]/, "", clean_mac); clean_mac = tolower(clean_mac);
		if (length(clean_mac) == 12) {
			mac = substr(clean_mac,1,2) ":" substr(clean_mac,3,2) ":" substr(clean_mac,5,2) ":" substr(clean_mac,7,2) ":" substr(clean_mac,9,2) ":" substr(clean_mac,11,2);
		}
		ip = $2; host = $3; online = $4 + 0; src = $5;
		if (mac == "" || mac == "00:00:00:00:00:00" || mac == lan_mac || mac == wan_mac) next;

		if (src == "custom") {
			custom_hosts[mac] = host;
			next;
		}

		if (!(mac in macs)) {
			macs[mac] = mac;
			ips[mac] = ip;
			hosts[mac] = host;
			onlines[mac] = online;
		} else {
			if (ip != "0.0.0.0" && ip != "Unknown" && ip != "") {
				if (ips[mac] == "Unknown" || ips[mac] == "0.0.0.0" || ips[mac] == "" || src == "ipneigh" || src == "dhcp") {
					ips[mac] = ip;
				}
			}
			if ((hosts[mac] == "Unknown" || hosts[mac] == "") && host != "Unknown" && host != "") {
				hosts[mac] = host;
			}
			if (online == 1) onlines[mac] = 1;
		}
	}
	END {
		for (m in macs) {
			final_host = (m in custom_hosts && custom_hosts[m] != "") ? custom_hosts[m] : hosts[m];
			print m "|" ips[m] "|" final_host "|" onlines[m];
		}
	}' "$lookup_file" 2>/dev/null

	rm -f "$lookup_file" 2>/dev/null
}

# Read cumulative chain counters: one line per rule "tag|ip|bytes|packets".
# IMPORTANT: counters must NOT be reset here. collect() calculates the
# per-device rate from consecutive cumulative snapshots. Resetting counters
# every poll makes the next delta compare two different intervals and drives
# rx_speed/tx_speed back to zero. Counters are reset only when rules are
# deliberately rebuilt or when the service is stopped.
read_chain() {
	nft list chain $ACCT_TABLE $ACCT_CHAIN 2>/dev/null | awk '
	/comment "netmon_/ {
		ip = ""; bytes = 0; pkts = 0; comment = "";
		for (i = 1; i <= NF; i++) {
			if ($i == "daddr") ip = $(i+1)
			else if ($i == "saddr") ip = $(i+1)
			else if ($i == "packets") pkts = $(i+1)
			else if ($i == "bytes") bytes = $(i+1)
			else if ($i == "comment") { comment = $(i+1); gsub(/"/, "", comment) }
		}
		if (comment != "") print comment "|" ip "|" bytes "|" pkts
	}'
}

# Plan rule maintenance. Input: merged host lookup "mac12|ip|host|online"
# lines (devices with an IP get IP rules, IP-less known devices get MAC
# rules). Outputs "FLUSH" when the rule set must be rebuilt (IP change or
# rule type change), otherwise "ADD|<mac>|<ip>" lines.
plan_rules() {
	nft_map="$1"
	lookup="$2"
	awk -v nftmap="$nft_map" -v lookup="$lookup" '
	BEGIN {
		n = split(lookup, a, "\n");
		for (i = 1; i <= n; i++) {
			if (a[i] == "") continue;
			split(a[i], f, "|");
			m12 = f[1]; gsub(/:/, "", m12); m12 = tolower(m12);
			if (length(m12) == 12) desired[m12] = f[2];
		}
		m = split(nftmap, r, "\n");
		for (i = 1; i <= m; i++) {
			if (r[i] == "") continue;
			split(r[i], p, "|");
			tag = p[1];
			is_mac_rule = (tag ~ /^netmon_rxm_/ || tag ~ /^netmon_txm_/);
			if (tag ~ /^netmon_rxm_/) gsub(/^netmon_rxm_/, "netmon_rx_", tag);
			if (tag ~ /^netmon_txm_/) gsub(/^netmon_txm_/, "netmon_tx_", tag);
			mac = substr(tag, 11);
			if (!(mac in desired)) { print "FLUSH"; exit }
			want_ip = desired[mac];
			if (is_mac_rule && want_ip != "" && want_ip != "0.0.0.0") { print "FLUSH"; exit }
			if (!is_mac_rule && (want_ip == "" || want_ip == "0.0.0.0")) { print "FLUSH"; exit }
			if (!is_mac_rule && p[2] != want_ip) { print "FLUSH"; exit }
			if (tag ~ /^netmon_rx_/) rxseen[mac] = 1;
		}
		for (m in desired) {
			if (!(m in rxseen)) print "ADD|" m "|" desired[m]
		}
	}' 2>/dev/null
}

# Apply planned rule changes. On FLUSH the whole chain is rebuilt from the
# host lookup (counters were already folded into .dat by collect before this
# call). Devices with an IP get per-IP rules; IP-less known devices get
# per-MAC rules so bridged/no-ARP clients are still accounted.
apply_rules() {
	plan="$1"
	lookup="$2"
	case "$plan" in
		*FLUSH*)
			nft flush chain $ACCT_TABLE $ACCT_CHAIN 2>/dev/null || true
			printf '%s\n' "$lookup" | awk -F'|' 'NF >= 2 {
				m12 = $1; gsub(/:/, "", m12); m12 = tolower(m12);
				if (length(m12) != 12) next;
				ip = $2;
				mac = tolower(substr(m12,1,2) ":" substr(m12,3,2) ":" substr(m12,5,2) ":" substr(m12,7,2) ":" substr(m12,9,2) ":" substr(m12,11,2));
				if (ip != "" && ip != "0.0.0.0") {
					printf "add rule %s %s ip daddr %s counter comment \"netmon_rx_%s\"\n", t, c, ip, m12;
					printf "add rule %s %s ip saddr %s counter comment \"netmon_tx_%s\"\n", t, c, ip, m12
				} else {
					printf "add rule %s %s ether daddr %s counter comment \"netmon_rxm_%s\"\n", t, c, mac, m12;
					printf "add rule %s %s ether saddr %s counter comment \"netmon_txm_%s\"\n", t, c, mac, m12
				}
			}' t="$ACCT_TABLE" c="$ACCT_CHAIN" | nft -f - 2>/dev/null || true
			;;
		*)
			printf '%s\n' "$plan" | awk -F'|' '$1 == "ADD" && NF >= 3 && length($2) == 12 {
				m12 = $2; ip = $3;
				mac = tolower(substr(m12,1,2) ":" substr(m12,3,2) ":" substr(m12,5,2) ":" substr(m12,7,2) ":" substr(m12,9,2) ":" substr(m12,11,2));
				if (ip != "" && ip != "0.0.0.0") {
					printf "add rule %s %s ip daddr %s counter comment \"netmon_rx_%s\"\n", t, c, ip, m12;
					printf "add rule %s %s ip saddr %s counter comment \"netmon_tx_%s\"\n", t, c, ip, m12
				} else {
					printf "add rule %s %s ether daddr %s counter comment \"netmon_rxm_%s\"\n", t, c, mac, m12;
					printf "add rule %s %s ether saddr %s counter comment \"netmon_txm_%s\"\n", t, c, mac, m12
				}
			}' t="$ACCT_TABLE" c="$ACCT_CHAIN" | nft -f - 2>/dev/null || true
			;;
	esac
}

# Helper to build a map of wireless client MAC addresses to band (2.4GHz, 5GHz, 6GHz).
# Unmatched active LAN clients default to LAN.
get_wifi_medium_map() {
	wifi_map_file="$RAM_DIR/wifi_medium.map"
	if [ -f "$wifi_map_file" ]; then
		now=$(date +%s)
		mtime=$(stat -c %Y "$wifi_map_file" 2>/dev/null || echo 0)
		if [ $((now - mtime)) -lt 30 ]; then
			cat "$wifi_map_file" 2>/dev/null || true
			return
		fi
	fi

	rm -f "$wifi_map_file" 2>/dev/null

	# 1. OpenWrt iwinfo (authoritative for OpenWrt wireless including custom drivers)
	if command -v iwinfo >/dev/null 2>&1; then
		for iface in $(iwinfo 2>/dev/null | awk '/^[a-zA-Z0-9_-]+/ {print $1}'); do
			[ -z "$iface" ] && continue
			info=$(iwinfo "$iface" info 2>/dev/null)
			band="2.4GHz"
			case "$info" in
				*5.*GHz*|*5GHz*|*Channel:*5*|*51[0-9][0-9]*|*52[0-9][0-9]*|*53[0-9][0-9]*|*55[0-9][0-9]*|*56[0-9][0-9]*|*57[0-9][0-9]*|*58[0-9][0-9]*)
					band="5GHz"
					;;
				*6.*GHz*|*6GHz*)
					band="6GHz"
					;;
				*)
					freq=$(echo "$info" | grep -o '[0-9]\{4\} MHz' | head -1 | awk '{print $1}')
					if [ -n "$freq" ] && [ "$freq" -ge 5000 ] 2>/dev/null; then
						if [ "$freq" -ge 5900 ]; then band="6GHz"; else band="5GHz"; fi
					fi
					;;
			esac
			iwinfo "$iface" assoclist 2>/dev/null | awk -v band="$band" '
			/^[0-9a-fA-F]{2}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2}/ {
				mac = tolower($1);
				if (mac != "") print mac "|" band;
			}' >> "$wifi_map_file" 2>/dev/null
		done
	fi

	# 2. iw dev (mac80211 Linux wireless standard)
	if command -v iw >/dev/null 2>&1; then
		iw dev 2>/dev/null | awk '
		/Interface/ { iface = $2 }
		/channel/ {
			freq = 0;
			for (i = 1; i <= NF; i++) {
				if ($i ~ /\([0-9]+/) {
					gsub(/[^0-9]/, "", $i);
					freq = $i + 0;
					break;
				}
			}
			band = "2.4GHz";
			if (freq >= 5000 && freq < 5900) band = "5GHz";
			else if (freq >= 5900) band = "6GHz";
			if (iface != "") print iface "|" band;
		}' > "$RAM_DIR/iface_bands.tmp" 2>/dev/null

		if [ -s "$RAM_DIR/iface_bands.tmp" ]; then
			while IFS='|' read -r iface band; do
				[ -z "$iface" ] && continue
				iw dev "$iface" station dump 2>/dev/null | awk -v band="$band" '
				/^Station/ {
					mac = tolower($2);
					if (mac != "") print mac "|" band;
				}' >> "$wifi_map_file" 2>/dev/null
			done < "$RAM_DIR/iface_bands.tmp"
			rm -f "$RAM_DIR/iface_bands.tmp" 2>/dev/null
		fi
	fi

	# 3. ubus hostapd calls
	if command -v ubus >/dev/null 2>&1; then
		for hobj in $(ubus list 'hostapd.*' 2>/dev/null); do
			iface="${hobj#hostapd.}"
			clients_json=$(ubus call "$hobj" get_clients 2>/dev/null)
			[ -z "$clients_json" ] && continue
			echo "$clients_json" | awk -F'"' -v iface="$iface" '{
				freq = 0;
				for (i = 1; i <= NF; i++) {
					if ($i ~ /^[0-9a-fA-F]{2}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2}$/) {
						mac = tolower($i);
					}
					if ($i == "freq") {
						freq = $(i+1); gsub(/[^0-9]/, "", freq); freq = freq + 0;
						band = "2.4GHz";
						if (freq >= 5000 && freq < 5900) band = "5GHz";
						else if (freq >= 5900) band = "6GHz";
						if (mac != "") print mac "|" band;
					}
				}
			}' >> "$wifi_map_file" 2>/dev/null
		done
	fi

	# 4. hostapd_cli fallback
	if command -v hostapd_cli >/dev/null 2>&1; then
		for sock in /var/run/hostapd/*; do
			[ -S "$sock" ] || continue
			iface=$(basename "$sock")
			hostapd_cli -i "$iface" all_sta 2>/dev/null | awk -v iface="$iface" '
			/^[0-9a-fA-F]{2}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2}/ {
				mac = tolower($1);
				if (mac != "") print mac "|2.4GHz";
			}' >> "$wifi_map_file" 2>/dev/null
		done
	fi

	[ -f "$wifi_map_file" ] && cat "$wifi_map_file" 2>/dev/null || true
}

# Compute per-device totals, speeds and publish the atomic snapshot.
# Outputs the JSON on stdout and also writes it to SNAP_TMP.
collect() {
	ts="$1"
	dt="$2"
	write_dat="$3"
	nft_raw="$4"
	prev_raw="$5"
	rq_raw="$6"
	lookup_data="$7"
	sys_stats="$8"
	wifi_raw="$9"
	poll_int="$POLL_INT"

	echo "$lookup_data" | awk -F'|' -v ts="$ts" -v dt="$dt" -v dat_dir="$DAT_DIR" -v snap_tmp="$SNAP_TMP" -v poll_int="$poll_int" -v write_dat="$write_dat" -v nft_raw="$nft_raw" -v prev_raw="$prev_raw" -v rq_raw="$rq_raw" -v active_file="$ACTIVE_FILE" -v sys_stats="$sys_stats" -v wifi_raw="$wifi_raw" -v prev_file="$RAM_DIR/prev_counters" '
	BEGIN {
		# Prevent %.6g exponential output ("1e+06") for totals >= 1 MB in
		# .dat files, and keep all numeric JSON fields as plain integers
		# even above 2^31 (32-bit routers overflow %d formatting).
		OFMT = "%.0f";
		if (prev_file != "") {
			while ((getline line < prev_file) > 0) {
				split(line, cp, "|");
				if (cp[1] != "") {
					prx_b[cp[1]] = cp[2] + 0;
					ptx_b[cp[1]] = cp[3] + 0;
				}
			}
			close(prev_file);
		}
		if (wifi_raw != "") {
			wn = split(wifi_raw, wlines, "\n");
			for (wi = 1; wi <= wn; wi++) {
				if (wlines[wi] == "") continue;
				split(wlines[wi], wp, "|");
				wmac = wp[1];
				gsub(/[^0-9a-fA-F]/, "", wmac);
				wmac = tolower(wmac);
				if (length(wmac) == 12) wband[wmac] = wp[2];
			}
		}
		reset_all = 0;
		if (rq_raw != "") {
			n = split(rq_raw, q, "\n");
			for (i = 1; i <= n; i++) {
				m = q[i]; gsub(/[^0-9a-fA-F]/, "", m); m = tolower(m);
				if (m == "all") reset_all = 1;
				else if (m != "") resetq[m] = 1;
			}
		}
		if (nft_raw != "") {
			n = split(nft_raw, lines, "\n");
			for (i = 1; i <= n; i++) {
				if (lines[i] == "") continue;
				split(lines[i], p, "|");
				tag = p[1]; b = p[3] + 0; k = p[4] + 0;
				if (tag ~ /^netmon_rxm_/) gsub(/^netmon_rxm_/, "netmon_rx_", tag);
				if (tag ~ /^netmon_txm_/) gsub(/^netmon_txm_/, "netmon_tx_", tag);
				mac = tolower(substr(tag, 11));
				if (tag ~ /^netmon_rx_/) { rx_b[mac] = b; rx_p[mac] = k }
				else if (tag ~ /^netmon_tx_/) { tx_b[mac] = b; tx_p[mac] = k }
			}
		}
		if (active_file != "") {
			while ((getline line < active_file) > 0) {
				split(line, ap, "|");
				if (ap[1] != "") {
					last_seen[ap[1]] = ap[2] + 0;
				}
			}
			close(active_file);
		}
	}
	{
		mac = $1; ip = $2; host = $3; online = $4 + 0;
		if (mac == "" || mac == "00:00:00:00:00:00") next;

		m = mac; gsub(/[^0-9a-fA-F]/, "", m); m = tolower(m);
		if (m in seen_macs) next;
		seen_macs[m] = 1;

		cur_rx = (m in rx_b) ? rx_b[m] : 0;
		cur_tx = (m in tx_b) ? tx_b[m] : 0;
		rp = (m in rx_p) ? rx_p[m] : 0;
		tp = (m in tx_p) ? tx_p[m] : 0;

		prx = (m in prx_b) ? prx_b[m] : 0;
		ptx = (m in ptx_b) ? ptx_b[m] : 0;

		# Calculate deltas against baseline. Prevent phantom deltas on missing baseline.
		if (!(m in prx_b)) {
			drx = 0;
			dtx = 0;
		} else {
			drx = (cur_rx >= prx) ? (cur_rx - prx) : cur_rx;
			dtx = (cur_tx >= ptx) ? (cur_tx - ptx) : cur_tx;
		}

		# Real-time online connectivity evaluation:
		# Device is online IF connected to Wi-Fi (m in wband)
		# OR transmitting client upload packets (dtx > 0)
		# OR REACHABLE in kernel IP neighbor table (online == 1 from ipneigh)
		# Download-only noise (drx > 0 && dtx == 0) for non-Wi-Fi non-REACHABLE device is router probe noise.
		if ((m in wband) || dtx > 0 || (online == 1)) {
			online = 1;
		} else {
			online = 0;
		}

		conn_type = (online == 1) ? ((m in wband) ? wband[m] : "LAN") : "";

		if (prev_file != "") {
			print m "|" cur_rx "|" cur_tx > prev_file ".tmp";
		}

		acc_rx = 0; acc_tx = 0;
		acc_file = dat_dir "/" m ".dat";
		close(acc_file);
		if ((getline line < acc_file) > 0) {
			split(line, ap, " ");
			acc_rx = ap[1] + 0; if (acc_rx < 0) acc_rx = 0;
			acc_tx = ap[2] + 0; if (acc_tx < 0) acc_tx = 0;
			close(acc_file);
		} else {
			close(acc_file);
		}

		tot_rx = acc_rx + drx;
		tot_tx = acc_tx + dtx;

		reset_forced = 0;
		if (reset_all == 1 || (m in resetq)) {
			tot_rx = drx; tot_tx = dtx;
			reset_forced = 1;
		}

		rx_spd = 0; tx_spd = 0;
		if (online == 1 && dt >= 1 && dt <= 30) {
			rx_spd = drx / dt;
			tx_spd = dtx / dt;
		}

		# Always update RAM accumulator files (.dat in /tmp/skywifi/dat) on every poll cycle.
		print tot_rx " " tot_tx > dat_dir "/" m ".dat";
		close(dat_dir "/" m ".dat");

		gsub(/\\/, "\\\\", host);
		gsub(/"/, "\\\"", host);

		item = sprintf("{\"mac\":\"%s\",\"ip\":\"%s\",\"hostname\":\"%s\",\"online\":%d,\"conn_type\":\"%s\",\"rx_bytes\":%.0f,\"tx_bytes\":%.0f,\"rx_packets\":%.0f,\"tx_packets\":%.0f,\"total_bytes\":%.0f,\"rx_speed\":%.0f,\"tx_speed\":%.0f}",
			mac, ip, host, online, conn_type, tot_rx, tot_tx, rp, tp, tot_rx + tot_tx, rx_spd, tx_spd);
		if (out == "") out = item; else out = out "," item;
	}
	END {
		if (prev_file != "") close(prev_file ".tmp");
		upt = 0;
		if ((getline line < "/proc/uptime") > 0) { split(line, a, " "); upt = a[1] + 0; close("/proc/uptime"); }
		sys = (sys_stats != "") ? sys_stats : "{}";
		json = sprintf("{\"timestamp\":%.0f,\"poll_interval\":%.0f,\"uptime\":%.0f,\"daemon_running\":true,\"system\":%s,\"devices\":[%s]}", ts, poll_int, upt, sys, out);
		if (snap_tmp != "") { print json > snap_tmp; close(snap_tmp); }
		if (active_file != "") {
			printf "" > active_file;
			for (m_key in last_seen) {
				m_ts = last_seen[m_key] + 0;
				if (m_ts > 0 && (ts - m_ts) <= 60) {
					print m_key "|" m_ts > active_file;
				}
			}
			close(active_file);
		}
		print json;
	}'
}

# One full accounting cycle. MUST be called by a single writer only
# (the daemon). Also used as a read fallback when the snapshot is missing.
do_sync() {
	exec 9>"$LOCK" 2>/dev/null
	if command -v flock >/dev/null 2>&1; then
		flock -n 9 2>/dev/null || exit 0
	fi

	now=$(now_sec)
	ensure_chain

	# Purge accumulator files belonging to the router itself. A pre-fix
	# version may have created .dat entries for the router's LAN/WAN
	# interfaces; they must never be listed or accounted.
	lan_m12=$(echo "$LAN_MAC" | tr -d ':' 2>/dev/null)
	wan_m12=$(echo "$WAN_MAC" | tr -d ':' 2>/dev/null)
	rm -f "$DAT_DIR/$lan_m12.dat" "$DAT_DIR/$wan_m12.dat" 2>/dev/null || true
	rm -f "$STORAGE_DIR/dat/$lan_m12.dat" "$STORAGE_DIR/dat/$wan_m12.dat" 2>/dev/null || true

	nft_raw=$(read_chain)
	lookup_data=$(get_mac_ip_hosts)
	wifi_raw=$(get_wifi_medium_map)
	plan=$(plan_rules "$nft_raw" "$lookup_data")

	write_dat=0
	case "$plan" in
		*FLUSH*) write_dat=1 ;;
	esac
	POLL_CNT=$((POLL_CNT + 1))
	if [ $((POLL_CNT % DAT_EVERY)) -eq 0 ]; then
		write_dat=1
	fi

	prev_raw=""
	prev_ts=0
	if [ -f "$SNAPSHOT" ]; then
		prev_raw=$(cat "$SNAPSHOT" 2>/dev/null || true)
		prev_ts=$(printf '%s\n' "$prev_raw" | grep -o '"timestamp":[0-9]*' | head -1 | cut -d: -f2)
		[ -z "$prev_ts" ] && prev_ts=0
	fi

	dt=$POLL_INT
	if [ "$prev_ts" -gt 0 ] 2>/dev/null; then
		dt=$((now - prev_ts))
		[ "$dt" -lt 1 ] && dt=1
		[ "$dt" -gt 10 ] && dt=$POLL_INT
	fi

	rq_raw=""
	if [ -f "$RAM_DIR/reset_all" ]; then
		rq_raw="all"
		rm -f "$RAM_DIR/reset_all" "$RESET_Q" 2>/dev/null || true
	elif [ -f "$RESET_Q" ]; then
		rq_raw=$(cat "$RESET_Q" 2>/dev/null || true)
		rm -f "$RESET_Q" 2>/dev/null || true
	fi

	collect "$now" "$dt" "$write_dat" "$nft_raw" "$prev_raw" "$rq_raw" "$lookup_data" "$(get_sys_stats)" "$wifi_raw" >/dev/null 2>&1 || true
	mv -f "$SNAP_TMP" "$SNAPSHOT" 2>/dev/null || true
	[ -f "$RAM_DIR/prev_counters.tmp" ] && mv -f "$RAM_DIR/prev_counters.tmp" "$RAM_DIR/prev_counters" 2>/dev/null || true

	apply_rules "$plan" "$lookup_data"

	# Do NOT reset accounting counters here. collect() needs cumulative
	# counters across polls to calculate real-time throughput.
	check_quotas

	cat "$SNAPSHOT" 2>/dev/null || true
}

# Check configured per-device data quotas against current snapshot.
# Auto-enforces block/throttle via qos-engine and notifies Telegram.
check_quotas() {
	[ -f "$SNAPSHOT" ] || return 0

	uci show skywifi 2>/dev/null | grep "=qos_rule" | while read -r line; do
		sec=$(echo "$line" | cut -d= -f1 | cut -d. -f2)
		is_enabled=$(uci -q get "skywifi.${sec}.enabled" || echo "1")
		[ "$is_enabled" = "1" ] || continue

		mac_val=$(uci -q get "skywifi.${sec}.mac" | tr '[:upper:]' '[:lower:]')
		ip_val=$(uci -q get "skywifi.${sec}.target" || uci -q get "skywifi.${sec}.target_val")
		quota_bytes=$(uci -q get "skywifi.${sec}.quota_bytes" || echo "0")

		[ "$quota_bytes" -gt 0 ] 2>/dev/null || continue
		[ -z "$mac_val" ] && [ -z "$ip_val" ] && continue

		dev_info=$(awk -v target_mac="$mac_val" -v target_ip="$ip_val" -F'"mac":"' 'BEGIN{tot=0; host="Device"; mac=""; ip=""} {
			for (i=2; i<=NF; i++) {
				cur_mac=tolower(substr($i,1,17));
				cur_ip=""; cur_tot=0; cur_host="Unknown";
				if (match($i, /"ip":"[^"]*"/)) cur_ip=substr($i, RSTART+6, RLENGTH-7);
				if (match($i, /"hostname":"[^"]*"/)) cur_host=substr($i, RSTART+12, RLENGTH-13);
				if (match($i, /"total_bytes":[0-9]+/)) cur_tot=substr($i, RSTART+14, RLENGTH-14)+0;
				if ((target_mac != "" && cur_mac == target_mac) || (target_ip != "" && cur_ip == target_ip)) {
					tot=cur_tot; host=cur_host; mac=cur_mac; ip=cur_ip; break;
				}
			}
		} END { print tot "|" host "|" mac "|" ip }' "$SNAPSHOT" 2>/dev/null)

		tot_bytes=$(echo "$dev_info" | cut -d'|' -f1)
		hostname=$(echo "$dev_info" | cut -d'|' -f2)
		d_mac=$(echo "$dev_info" | cut -d'|' -f3)
		d_ip=$(echo "$dev_info" | cut -d'|' -f4)

		[ -z "$tot_bytes" ] && tot_bytes=0

		if [ "$tot_bytes" -ge "$quota_bytes" ] 2>/dev/null; then
			trig_file="$RAM_DIR/quota_trig_${sec}"
			if [ ! -f "$trig_file" ]; then
				touch "$trig_file" 2>/dev/null || true
				
				uci set skywifi."$sec".block='1'
				uci commit skywifi

				/usr/libexec/skywifi/qos-engine.sh apply >/dev/null 2>&1 || true

				if [ -x "/usr/libexec/skywifi/telegram-bot.sh" ]; then
					q_str=$(awk -v v="$quota_bytes" 'BEGIN { if (v >= 1073741824) printf "%.2f GB", v/1073741824; else printf "%.2f MB", v/1048576 }')
					/usr/libexec/skywifi/telegram-bot.sh send "⚠️ <b>Data Quota Limit Reached!</b>\n\nDevice: <b>${hostname}</b> (<code>${d_ip:-$d_mac}</code>)\nQuota Limit: <b>${q_str}</b>\n\n<i>Access has been automatically blocked.</i>" >/dev/null 2>&1 &
				fi
			fi
		fi
	done
}

# Read-only cached snapshot consumer (RPCD path) - instant <1ms response time
cached_stats() {
	# 1. Instant RAM Snapshot Serving (<1ms)
	if [ -f "$SNAPSHOT" ] && [ -s "$SNAPSHOT" ]; then
		cat "$SNAPSHOT" 2>/dev/null || true
		return 0
	fi

	# 2. If snapshot is missing (cold start), attempt sync
	res=$(do_sync 2>/dev/null)
	if [ -n "$res" ]; then
		echo "$res"
		return 0
	fi

	# 3. Fast Cold-Start Fallback: generate live telemetry on the fly
	sys_stats=$(get_sys_stats)
	lookup_data=$(get_mac_ip_hosts)
	now=$(now_sec)
	collect "$now" 1 0 "" "" "" "$lookup_data" "$sys_stats" "" 2>/dev/null || true
	if [ -f "$SNAP_TMP" ] && [ -s "$SNAP_TMP" ]; then
		mv -f "$SNAP_TMP" "$SNAPSHOT" 2>/dev/null || true
		cat "$SNAPSHOT" 2>/dev/null || true
	else
		upt=0
		[ -r /proc/uptime ] && upt=$(awk '{print int($1)}' /proc/uptime 2>/dev/null || echo 0)
		printf '{"timestamp":%s,"poll_interval":1,"uptime":%s,"daemon_running":true,"system":%s,"devices":[]}\n' "$now" "$upt" "${sys_stats:-{}}"
	fi
}

case "$1" in
	sync)
		do_sync
		;;
	stats|devices)
		cached_stats
		;;

	flush)
		nft flush chain $ACCT_TABLE $ACCT_CHAIN 2>/dev/null || true
		;;
	*)
		cached_stats
		;;
esac

exit 0
