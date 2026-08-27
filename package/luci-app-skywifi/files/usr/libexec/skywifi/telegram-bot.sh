#!/bin/sh
# telegram-bot.sh - Telegram Bot daemon and notification handler for luci-app-skywifi
# Enables remote network monitoring, device blocking/unblocking, and alert notifications.

RAM_DIR="/tmp/skywifi"
LOCK_FILE="$RAM_DIR/telegram.lock"
OFFSET_FILE="$RAM_DIR/telegram.offset"
HELPER="/usr/libexec/skywifi/netmon-helper.sh"
QOS="/usr/libexec/skywifi/qos-engine.sh"
ARCHIVER="/usr/libexec/skywifi/stats-archiver.sh"

ENABLED=$(uci -q get skywifi.telegram.enabled || echo "0")
BOT_TOKEN=$(uci -q get skywifi.telegram.bot_token || echo "")
CHAT_ID=$(uci -q get skywifi.telegram.chat_id || echo "")

mkdir -p "$RAM_DIR" 2>/dev/null || true

api_post() {
	method="$1"
	payload="$2"
	[ -z "$BOT_TOKEN" ] && return 1
	url="https://api.telegram.org/bot${BOT_TOKEN}/${method}"

	if command -v curl >/dev/null 2>&1; then
		curl -s -m 10 -X POST "$url" -H "Content-Type: application/json" -d "$payload" 2>/dev/null
	elif command -v wget >/dev/null 2>&1; then
		wget -qO- --timeout=10 --header="Content-Type: application/json" --post-data="$payload" "$url" 2>/dev/null
	fi
}

send_msg() {
	msg="$1"
	target_chat="${2:-$CHAT_ID}"
	[ -z "$target_chat" ] || [ -z "$BOT_TOKEN" ] && return 0

	clean_msg=$(printf '%s' "$msg" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\t/  /g' | awk '{printf "%s\\n", $0}' | sed 's/\\n$//')
	payload=$(printf '{"chat_id":"%s","text":"%s","parse_mode":"HTML"}' "$target_chat" "$clean_msg")
	api_post "sendMessage" "$payload" >/dev/null 2>&1 || true
}

get_updates() {
	offset=$(cat "$OFFSET_FILE" 2>/dev/null || echo "0")
	payload=$(printf '{"offset":%s,"timeout":2}' "$offset")
	api_post "getUpdates" "$payload"
}

format_bytes() {
	b=$1
	if [ -z "$b" ] || [ "$b" -eq 0 ] 2>/dev/null; then
		echo "0 B"
	elif [ "$b" -ge 1073741824 ] 2>/dev/null; then
		awk -v v="$b" 'BEGIN { printf "%.2f GB", v / 1073741824 }'
	elif [ "$b" -ge 1048576 ] 2>/dev/null; then
		awk -v v="$b" 'BEGIN { printf "%.2f MB", v / 1048576 }'
	elif [ "$b" -ge 1024 ] 2>/dev/null; then
		awk -v v="$b" 'BEGIN { printf "%.2f KB", v / 1024 }'
	else
		echo "${b} B"
	fi
}

format_speed() {
	s=$1
	if [ -z "$s" ] || [ "$s" -eq 0 ] 2>/dev/null; then
		echo "0 KB/s"
	elif [ "$s" -ge 1048576 ] 2>/dev/null; then
		awk -v v="$s" 'BEGIN { printf "%.2f MB/s", v / 1048576 }'
	elif [ "$s" -ge 1024 ] 2>/dev/null; then
		awk -v v="$s" 'BEGIN { printf "%.1f KB/s", v / 1024 }'
	else
		echo "${s} B/s"
	fi
}

handle_command() {
	chat="$1"
	cmd="$2"
	arg="$3"

	if [ -n "$CHAT_ID" ] && [ "$chat" != "$CHAT_ID" ]; then
		send_msg "⚠️ Unauthorized access attempt blocked. Chat ID: <code>${chat}</code>" "$chat"
		return
	fi

	case "$cmd" in
		/start|/help)
			reply="<b>🚀 skywifi Network Bot</b>\n\n"
			reply="${reply}<b>Available Commands:</b>\n"
			reply="${reply}• /status - System overview & connectivity\n"
			reply="${reply}• /devices - Active online devices & speeds\n"
			reply="${reply}• /speed - Quick bandwidth activity summary\n"
			reply="${reply}• /block &lt;IP or MAC&gt; - Block internet access\n"
			reply="${reply}• /unblock &lt;IP or MAC&gt; - Restore internet access\n"
			send_msg "$reply" "$chat"
			;;

		/status)
			snap=$(cat "$RAM_DIR/current_stats.json" 2>/dev/null)
			if [ -z "$snap" ]; then
				send_msg "⚠️ Daemon statistics snapshot not available." "$chat"
				return
			fi

			cpu=$(echo "$snap" | grep -o '"cpu_pct":[0-9]*' | cut -d: -f2 || echo "0")
			load=$(echo "$snap" | grep -o '"load":"[^"]*"' | cut -d'"' -f4 || echo "N/A")
			conns=$(echo "$snap" | grep -o '"conns":[0-9]*' | cut -d: -f2 || echo "0")
			mem_tot=$(echo "$snap" | grep -o '"mem_total":[0-9]*' | cut -d: -f2 || echo "0")
			mem_free=$(echo "$snap" | grep -o '"mem_free":[0-9]*' | cut -d: -f2 || echo "0")

			mem_pct=0
			if [ "$mem_tot" -gt 0 ] 2>/dev/null; then
				mem_pct=$(( 100 * (mem_tot - mem_free) / mem_tot ))
			fi

			online_count=$(echo "$snap" | grep -o '"online":1' | wc -l)

			reply="<b>📊 skywifi System Status</b>\n\n"
			reply="${reply}• <b>CPU Utilization:</b> ${cpu}%\n"
			reply="${reply}• <b>Load Average:</b> ${load}\n"
			reply="${reply}• <b>RAM Usage:</b> ${mem_pct}%\n"
			reply="${reply}• <b>Active Flows:</b> ${conns} connections\n"
			reply="${reply}• <b>Devices Online:</b> ${online_count}\n"
			send_msg "$reply" "$chat"
			;;

		/devices)
			snap=$(cat "$RAM_DIR/current_stats.json" 2>/dev/null)
			if [ -z "$snap" ]; then
				send_msg "⚠️ Snapshot not available." "$chat"
				return
			fi

			reply="<b>📱 Active Online Devices:</b>\n\n"
			dev_lines=$(echo "$snap" | awk -F'"mac":"' '{for(i=2;i<=NF;i++){
				m=$i; sub(/".*/,"",m);
				host="Unknown"; ip="0.0.0.0"; online=0; rx=0; tx=0; rx_s=0; tx_s=0;
				if (match($i, /"hostname":"[^"]*"/)) { host=substr($i, RSTART+12, RLENGTH-13); }
				if (match($i, /"ip":"[^"]*"/)) { ip=substr($i, RSTART+6, RLENGTH-7); }
				if (match($i, /"online":1/)) { online=1; }
				if (match($i, /"rx_bytes":[0-9]+/)) { rx=substr($i, RSTART+11, RLENGTH-11)+0; }
				if (match($i, /"tx_bytes":[0-9]+/)) { tx=substr($i, RSTART+11, RLENGTH-11)+0; }
				if (match($i, /"rx_speed":[0-9]+/)) { rx_s=substr($i, RSTART+11, RLENGTH-11)+0; }
				if (match($i, /"tx_speed":[0-9]+/)) { tx_s=substr($i, RSTART+11, RLENGTH-11)+0; }
				if (online == 1) {
					print host "|" ip "|" m "|" rx "|" tx "|" rx_s "|" tx_s;
				}
			}}')

			if [ -z "$dev_lines" ]; then
				reply="${reply}<i>No devices currently online.</i>"
			else
				cnt=0
				echo "$dev_lines" | while IFS='|' read -r host ip mac rx tx rx_s tx_s; do
					cnt=$((cnt + 1))
					[ "$cnt" -gt 15 ] && break
					rx_str=$(format_bytes "$rx")
					tx_str=$(format_bytes "$tx")
					rxs_str=$(format_speed "$rx_s")
					txs_str=$(format_speed "$tx_s")
					send_msg "🔹 <b>${host}</b>\nIP: <code>${ip}</code> (${mac})\n⬇️ ${rxs_str} (Total: ${rx_str})\n⬆️ ${txs_str} (Total: ${tx_str})" "$chat"
				done
				return
			fi
			send_msg "$reply" "$chat"
			;;

		/speed)
			snap=$(cat "$RAM_DIR/current_stats.json" 2>/dev/null)
			tot_rx_spd=0; tot_tx_spd=0;
			if [ -n "$snap" ]; then
				tot_rx_spd=$(echo "$snap" | awk -F'"rx_speed":' '{for(i=2;i<=NF;i++){split($i,a,","); sum+=a[1]+0}} END{print sum+0}')
				tot_tx_spd=$(echo "$snap" | awk -F'"tx_speed":' '{for(i=2;i<=NF;i++){split($i,a,","); sum+=a[1]+0}} END{print sum+0}')
			fi
			rxs_str=$(format_speed "$tot_rx_spd")
			txs_str=$(format_speed "$tot_tx_spd")
			send_msg "⚡ <b>Real-time Network Speed</b>\n\n⬇️ Download: <b>${rxs_str}</b>\n⬆️ Upload: <b>${txs_str}</b>" "$chat"
			;;

		/block)
			target="$arg"
			if [ -z "$target" ]; then
				send_msg "⚠️ Usage: <code>/block &lt;IP or MAC&gt;</code>" "$chat"
				return
			fi

			sec_name="tg_block_$(echo "$target" | tr -cd 'a-zA-Z0-9')"
			uci set skywifi."$sec_name"=qos_rule
			uci set skywifi."$sec_name".enabled='1'
			uci set skywifi."$sec_name".block='1'

			if echo "$target" | grep -q ':'; then
				uci set skywifi."$sec_name".mac="$target"
			else
				uci set skywifi."$sec_name".target="$target"
			fi
			uci commit skywifi

			if [ -x "$QOS" ]; then
				"$QOS" apply >/dev/null 2>&1 || true
			fi
			send_msg "🚫 <b>Blocked:</b> Access restricted for <code>${target}</code>" "$chat"
			;;

		/unblock)
			target="$arg"
			if [ -z "$target" ]; then
				send_msg "⚠️ Usage: <code>/unblock &lt;IP or MAC&gt;</code>" "$chat"
				return
			fi

			matched=0
			uci show skywifi 2>/dev/null | grep "=qos_rule" | while read -r line; do
				sec=$(echo "$line" | cut -d= -f1 | cut -d. -f2)
				t_val=$(uci -q get "skywifi.${sec}.target" || uci -q get "skywifi.${sec}.target_val")
				m_val=$(uci -q get "skywifi.${sec}.mac")
				b_val=$(uci -q get "skywifi.${sec}.block")

				if [ "$b_val" = "1" ] && { [ "$t_val" = "$target" ] || [ "$m_val" = "$target" ]; }; then
					uci delete skywifi."$sec" 2>/dev/null || true
					matched=1
				fi
			done
			uci commit skywifi

			if [ -x "$QOS" ]; then
				"$QOS" apply >/dev/null 2>&1 || true
			fi
			send_msg "✅ <b>Unblocked:</b> Access restored for <code>${target}</code>" "$chat"
			;;

		*)
			send_msg "Unknown command. Send /help for available commands." "$chat"
			;;
	esac
}

poll_loop() {
	[ "$ENABLED" = "1" ] || return 0
	[ -z "$BOT_TOKEN" ] && return 0

	raw=$(get_updates)
	[ -z "$raw" ] && return 0

	echo "$raw" | awk -F'"update_id":' '{for(i=2;i<=NF;i++){
		uid=$i; sub(/,.*/,"",uid);
		if (uid + 0 > 0) {
			chat=""; text="";
			if (match($i, /"chat":\{"id":-?[0-9]+/)) {
				chat=substr($i, RSTART+12, RLENGTH-12);
			}
			if (match($i, /"text":"[^"]*"/)) {
				text=substr($i, RSTART+8, RLENGTH-9);
			}
			if (chat != "" && text != "") {
				print uid "|" chat "|" text;
			}
		}
	}}' | while IFS='|' read -r uid chat text; do
		last_off=$(cat "$OFFSET_FILE" 2>/dev/null || echo "0")
		next_off=$((uid + 1))
		[ "$next_off" -gt "$last_off" ] && echo "$next_off" > "$OFFSET_FILE" 2>/dev/null

		clean_text=$(printf '%s' "$text" | sed 's/\\"/\"/g; s/\\\\/\\/g')
		cmd=$(echo "$clean_text" | awk '{print $1}')
		arg=$(echo "$clean_text" | awk '{$1=""; print $0}' | sed 's/^[ \t]*//')

		handle_command "$chat" "$cmd" "$arg"
	done
}

case "$1" in
	send)
		shift
		send_msg "$*"
		;;
	poll)
		poll_loop
		;;
	*)
		poll_loop
		;;
esac

exit 0
