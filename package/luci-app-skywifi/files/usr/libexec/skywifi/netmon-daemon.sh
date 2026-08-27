#!/bin/sh
# netmon-daemon.sh - real-time traffic accounting daemon for luci-app-skywifi
# Single-writer accounting loop: polls kernel counters, publishes an atomic
# snapshot with server-side speeds, and periodically syncs history to storage.

RAM_DIR="/tmp/skywifi"
HELPER="/usr/libexec/skywifi/netmon-helper.sh"
ARCHIVER="/usr/libexec/skywifi/stats-archiver.sh"

mkdir -p "$RAM_DIR" 2>/dev/null || true

POLL_INT=$(uci -q get skywifi.global.poll_interval || echo "1")
case "$POLL_INT" in
	''|*[!0-9]*) POLL_INT=1 ;;
esac
[ "$POLL_INT" -lt 1 ] && POLL_INT=1

parse_interval_to_seconds() {
	val=$(uci -q get skywifi.global.sync_interval || echo "5m")
	if [ "$val" = "custom" ]; then
		cval=$(uci -q get skywifi.global.custom_sync_interval)
		[ -n "$cval" ] && val="$cval"
	fi
	[ -z "$val" ] && val="5m"

	case "$val" in
		initial) echo 1 ;;
		5s) echo 5 ;;
		10s) echo 10 ;;
		30s) echo 30 ;;
		1m) echo 60 ;;
		5m) echo 300 ;;
		10m) echo 600 ;;
		15m) echo 900 ;;
		30m) echo 1800 ;;
		1h) echo 3600 ;;
		12h) echo 43200 ;;
		24h) echo 86400 ;;
		*)
			num=$(echo "$val" | tr -cd '0-9')
			unit=$(echo "$val" | tr -cd 'a-zA-Z')
			[ -z "$num" ] && num=300

			if [ "$unit" = "s" ]; then
				echo "$num"
			elif [ "$unit" = "h" ]; then
				echo $((num * 3600))
			else
				echo $((num * 60))
			fi
			;;
	esac
}

sec_counter=0
telegram_counter=0

final_sync() {
	"$HELPER" sync >/dev/null 2>&1 || true
	"$ARCHIVER" sync >/dev/null 2>&1 || true
}

trap 'exit 0' TERM INT
trap final_sync EXIT

# Wait for qos-engine and urlblock-engine nftables chains to fully settle
# before running the first accounting cycle. Without this, counter rules can
# land in a partially-built table, stalling one traffic direction.
sleep 1

# Initial accounting + history sync on startup
final_sync

sync_sec=$(parse_interval_to_seconds)
last_sync_check=0

while true; do
	"$HELPER" sync >/dev/null 2>&1 || true
	date +%s > "$RAM_DIR/daemon.alive" 2>/dev/null || true

	sec_counter=$((sec_counter + POLL_INT))
	telegram_counter=$((telegram_counter + POLL_INT))
	last_sync_check=$((last_sync_check + POLL_INT))
	
	if [ "$last_sync_check" -ge 60 ]; then
		last_sync_check=0
		sync_sec=$(parse_interval_to_seconds)
	fi

	if [ "$sec_counter" -ge "$sync_sec" ]; then
		sec_counter=0
telegram_counter=0
		sync_sec=$(parse_interval_to_seconds)
		"$ARCHIVER" sync >/dev/null 2>&1 || true
	fi

	if [ "$telegram_counter" -ge 60 ]; then
		telegram_counter=0
		if [ -x "/usr/libexec/skywifi/telegram-bot.sh" ]; then
			/usr/libexec/skywifi/telegram-bot.sh poll >/dev/null 2>&1 &
		fi
	fi

	sleep "$POLL_INT"
done
