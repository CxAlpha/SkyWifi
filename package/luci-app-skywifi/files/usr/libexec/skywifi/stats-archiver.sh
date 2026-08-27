#!/bin/sh
# stats-archiver.sh - history persistence & retrieval for luci-app-skywifi
# Data model:
#   /tmp/skywifi/current_stats.json              live snapshot (daemon, atomic)
#   <storage>/days/day_YYYY-MM-DD.json           end-of-day device snapshots
#   <storage>/daily.json                         aggregated per-day totals (deltas)
#   <storage>/months/history_YYYY-MM.json        archived month day totals
#   <storage>/months/monthly_devices_YYYY-MM.json archived month device totals
#   <storage>/dat/<mac>.dat                      RAM accumulator backups (reboot-safe)
# Reads never mutate state; only sync/check_rollover/archive_daily do.

RAM_DIR="/tmp/skywifi"
STORAGE_DIR=$(uci -q get skywifi.global.storage_path || echo "/etc/skywifi/history")
if ! mkdir -p "$STORAGE_DIR" 2>/dev/null; then
	STORAGE_DIR="$RAM_DIR/history"
fi

DAYS_DIR="$STORAGE_DIR/days"
MONTHS_DIR="$STORAGE_DIR/months"
SNAPSHOT="$RAM_DIR/current_stats.json"
DAILY="$STORAGE_DIR/daily.json"
DAILY_TMP="$STORAGE_DIR/daily.json.tmp"
STATE="$RAM_DIR/state.info"
HELPER="/usr/libexec/skywifi/netmon-helper.sh"
LOCK="$RAM_DIR/poll.lock"

# Serialize with the accounting daemon so .dat/day writes never race.
lock_or_exit() {
	exec 9>"$LOCK" 2>/dev/null
	if command -v flock >/dev/null 2>&1; then
		if [ "$ACTION" = "reset" ]; then
			flock -w 5 9 2>/dev/null || exit 1
		else
			flock -n 9 2>/dev/null || exit 0
		fi
	fi
}

mkdir -p "$RAM_DIR" "$STORAGE_DIR" "$DAYS_DIR" "$MONTHS_DIR" "$RAM_DIR/dat" "$STORAGE_DIR/dat" 2>/dev/null || true

ACTION="${1:-get}"
PARAM="$2"

ymd() { date +%Y-%m-%d; }
ym() { date +%Y-%m; }
today_epoch() { date +%s; }
shift_days() {
	# $1 = days ago
	date -d "@$(( $(date +%s) - ($1 * 86400) ))" +%Y-%m-%d 2>/dev/null || echo ""
}

days_in_month_of() {
	m="${1#*-}"
	y="${1%-*}"
	case "$m" in
		02)
			if { [ $((y % 4)) -eq 0 ] && { [ $((y % 100)) -ne 0 ] || [ $((y % 400)) -eq 0 ]; }; }; then
				echo 29
			else
				echo 28
			fi
			;;
		04|06|09|11) echo 30 ;;
		*) echo 31 ;;
	esac
}

# Sum device totals of a snapshot file -> "total rx tx" (0s if missing)
# Uses awk floating point so totals above 2^31 do not overflow 32-bit
# shell arithmetic, and printf "%.0f" avoids %.6g exponential output.
sum_devices_file() {
	f="$1"
	if [ -s "$f" ]; then
		awk '
		{
			l = $0;
			while (match(l, /"rx_bytes":[0-9]+/)) { rx += substr(l, RSTART + 11, RLENGTH - 11); l = substr(l, RSTART + RLENGTH) }
			l = $0;
			while (match(l, /"tx_bytes":[0-9]+/)) { tx += substr(l, RSTART + 11, RLENGTH - 11); l = substr(l, RSTART + RLENGTH) }
		}
		END { printf "%.0f %.0f %.0f\n", rx + tx, rx, tx }' "$f"
	else
		echo "0 0 0"
	fi
}

# Safe non-negative difference of two (possibly > 2^31) shell values
delta() {
	awk -v a="$1" -v b="$2" 'BEGIN { d = a - b; if (d < 0) d = 0; printf "%.0f\n", d }'
}

day_file() {
	echo "$DAYS_DIR/day_$1.json"
}

# Latest day snapshot strictly before $1 (YYYY-MM-DD); empty if none
latest_day_before() {
	d="$1"
	ls "$DAYS_DIR"/day_*.json 2>/dev/null | awk -v d="$d" '
	{
		f = $0;
		sub(/.*\/day_/, "", f);
		sub(/\.json/, "", f);
		if (f < d) { best = f }
	}
	END { if (best != "") print "'"$DAYS_DIR"'/day_" best ".json" }'
}

# Latest day snapshot for a given month (last day captured); empty if none
latest_day_of_month() {
	m="$1"
	ls "$DAYS_DIR"/day_${m}-*.json 2>/dev/null | sort | tail -1
}

# Copy the live snapshot into a day file (once per day)
snapshot_day() {
	d="$1"
	f="$DAYS_DIR/day_$d.json"
	if [ ! -f "$f" ] && [ -s "$SNAPSHOT" ]; then
		cp -f "$SNAPSHOT" "$f" 2>/dev/null || true
	fi
}

# Emit the per-day totals array (deltas between consecutive day snapshots).
# $1 = month (YYYY-MM), $2 = optional "live" date (use snapshot for that day)
emit_days() {
	month="$1"
	live_date="$2"
	dmi=$(days_in_month_of "$month")
	prev_sum=""
	for d in $(seq 1 "$dmi"); do
		label=$(printf '%02d' "$d")
		date="$month-$label"
		f="$DAYS_DIR/day_$date.json"
		sum=""
		if [ -f "$f" ]; then
			sum=$(sum_devices_file "$f")
		fi
		if [ -n "$live_date" ] && [ "$live_date" = "$date" ] && [ -s "$SNAPSHOT" ]; then
			sum=$(sum_devices_file "$SNAPSHOT")
		fi

		tot=0; rx=0; tx=0
		if [ -n "$sum" ]; then
			set -- $sum
			s_tot=$1; s_rx=$2; s_tx=$3
			if [ -n "$prev_sum" ]; then
				set -- $prev_sum
				p_tot=$1; p_rx=$2; p_tx=$3
				tot=$(delta "$s_tot" "$p_tot")
				rx=$(delta "$s_rx" "$p_rx")
				tx=$(delta "$s_tx" "$p_tx")
			else
				tot=$s_tot; rx=$s_rx; tx=$s_tx
			fi
			prev_sum=$sum
		fi

		[ "$d" -gt 1 ] && printf ','
		printf '{"day":%d,"label":"%s","total_bytes":%.0f,"rx_bytes":%.0f,"tx_bytes":%.0f}' "$d" "$label" "$tot" "$rx" "$tx"
	done
}

rebuild_daily() {
	month=$(ym)
	cur=$(ymd)
	tmp="$DAILY_TMP"
	{
		printf '{"month":"%s","days_in_month":%d,"days":[' "$month" "$(days_in_month_of "$month")"
		emit_days "$month" "$cur"
		printf ']}\n'
	} > "$tmp" 2>/dev/null && mv -f "$tmp" "$DAILY" 2>/dev/null || true
}

# Archive an entire old month: build month records, then reset for the new month
archive_month() {
	old_month="$1"

	# Ensure the last day of the old month is snapshotted
	last_day_file=$(latest_day_of_month "$old_month")
	if [ -z "$last_day_file" ] && [ -s "$SNAPSHOT" ]; then
		last_day=$(printf '%s-%02d' "$old_month" "$(days_in_month_of "$old_month")")
		snapshot_day "$last_day"
		last_day_file=$(day_file "$last_day")
	fi

	# Aggregate daily totals for the archived month
	{
		printf '{"month":"%s","days_in_month":%d,"days":[' "$old_month" "$(days_in_month_of "$old_month")"
		emit_days "$old_month" ""
		printf ']}\n'
	} > "$MONTHS_DIR/history_$old_month.json.tmp" 2>/dev/null && mv -f "$MONTHS_DIR/history_$old_month.json.tmp" "$MONTHS_DIR/history_$old_month.json" 2>/dev/null || true

	# Device totals for the archived month = last snapshot of that month
	if [ -n "$last_day_file" ] && [ -f "$last_day_file" ]; then
		cp -f "$last_day_file" "$MONTHS_DIR/monthly_devices_$old_month.json" 2>/dev/null || true
	fi

	# Reset everything for the new month (accumulators, kernel counters, live state)
	rm -rf "$DAYS_DIR" 2>/dev/null || true
	mkdir -p "$DAYS_DIR"
	rm -f "$DAILY" "$SNAPSHOT" "$STATE" "$RAM_DIR"/dat/*.dat "$STORAGE_DIR"/dat/*.dat "$RAM_DIR"/reset_queue 2>/dev/null || true
	"$HELPER" flush >/dev/null 2>&1 || true
	mkdir -p "$RAM_DIR/dat" "$STORAGE_DIR/dat"
}

# Day/month rollover detection + daily aggregation (safe to run often)
ensure_daily() {
	cur_month=$(ym)
	cur_day=$(ymd)

	state=""
	[ -f "$STATE" ] && state=$(cat "$STATE" 2>/dev/null || true)
	state_day=$(echo "$state" | cut -d: -f1)
	state_month=$(echo "$state" | cut -d: -f2)

	if [ -n "$state_month" ] && [ "$state_month" != "$cur_month" ]; then
		archive_month "$state_month"
	elif [ -n "$state_day" ] && [ "$state_day" != "$cur_day" ] && [ "${state_day%-*}" = "$cur_month" ]; then
		snapshot_day "$state_day"
	fi

	rebuild_daily
	echo "$cur_day:$cur_month" > "$STATE" 2>/dev/null || true
}

prune_old_archives() {
	ret_m=$(uci -q get skywifi.global.retention_months || echo "12")
	case "$ret_m" in
		0|forever|never) return ;;
		''|*[!0-9]*) ret_m=12 ;;
	esac
	[ "$ret_m" -lt 1 ] && return

	now_sec=$(today_epoch)
	max_age_sec=$((ret_m * 30 * 86400))

	for f in "$MONTHS_DIR"/history_*.json "$MONTHS_DIR"/monthly_devices_*.json; do
		[ -f "$f" ] || continue
		mtime=$(stat -c %Y "$f" 2>/dev/null || echo 0)
		if [ "$mtime" -gt 0 ] && [ $((now_sec - mtime)) -gt "$max_age_sec" ]; then
			rm -f "$f" 2>/dev/null || true
		fi
	done
}

sync_to_storage() {
	mkdir -p "$STORAGE_DIR" "$DAYS_DIR" "$MONTHS_DIR" "$STORAGE_DIR/dat"
	cp -f "$SNAPSHOT" "$STORAGE_DIR/current_stats.json" 2>/dev/null || true
	cp -f "$DAILY" "$STORAGE_DIR/daily.json" 2>/dev/null || true
	cp -f "$STATE" "$STORAGE_DIR/state.info" 2>/dev/null || true
	cp -f "$RAM_DIR"/dat/*.dat "$STORAGE_DIR/dat/" 2>/dev/null || true
	prune_old_archives
}

# Restore persistent state into RAM (used on boot). Includes migration of
# legacy layouts (root-level .dat / daily_history.json / history_*.json).
restore_to_ram() {
	mkdir -p "$RAM_DIR" "$RAM_DIR/dat" "$DAYS_DIR" "$MONTHS_DIR" "$STORAGE_DIR/dat"
	for f in "$STORAGE_DIR"/*.dat; do
		[ -f "$f" ] && cp -f "$f" "$RAM_DIR/dat/" 2>/dev/null
	done
	cp -f "$STORAGE_DIR"/dat/*.dat "$RAM_DIR/dat/" 2>/dev/null || true
	[ -f "$STORAGE_DIR/current_stats.json" ] && cp -f "$STORAGE_DIR/current_stats.json" "$SNAPSHOT" 2>/dev/null || true
	if [ -f "$STORAGE_DIR/daily_history.json" ] && [ ! -f "$DAILY" ]; then
		cp -f "$STORAGE_DIR/daily_history.json" "$DAILY" 2>/dev/null || true
	fi
	[ -f "$STORAGE_DIR/state.info" ] && cp -f "$STORAGE_DIR/state.info" "$STATE" 2>/dev/null || true
	for f in "$STORAGE_DIR"/history_*.json "$STORAGE_DIR"/monthly_devices_*.json; do
		[ -f "$f" ] && cp -f "$f" "$MONTHS_DIR/" 2>/dev/null
	done
}

# Extract the device array from a snapshot file (or current snapshot)
extract_devices() {
	f="$1"
	if [ -s "$f" ]; then
		awk -F'"devices":' '{print $2}' "$f" 2>/dev/null | sed 's/}$//' | tr -d '\r\n'
	else
		echo '[]'
	fi
}

# Device-level diff between two snapshots: values of base minus sub, clamped >= 0
diff_devices() {
	base="$1"
	subs="$2"

	if [ ! -s "$subs" ]; then
		extract_devices "$base"
		return
	fi

	awk -v base="$base" -v subs="$subs" '
	function parse(str, RX, TX, IP, HOST, ONL, MAC,   n, i, dev, mac, m12, p, q) {
		n = split(str, items, "\"mac\":\"")
		for (i = 2; i <= n; i++) {
			dev = items[i]
			mac = dev
			sub(/".*/, "", mac)
			m12 = mac; gsub(/[^0-9a-fA-F]/, "", m12); m12 = tolower(m12)
			if (m12 == "" || m12 == "000000000000") continue
			MAC[m12] = mac
			RX[m12] = gnum(dev, "rx_bytes")
			TX[m12] = gnum(dev, "tx_bytes")
			IP[m12] = gstr(dev, "ip")
			HOST[m12] = gstr(dev, "hostname")
			ONL[m12] = gnum(dev, "online")
		}
	}
	function gstr(dev, key,   p, q, s) {
		p = index(dev, "\"" key "\":\"")
		if (p <= 0) return ""
		s = substr(dev, p + length(key) + 4)
		q = index(s, "\"")
		if (q <= 0) return ""
		return substr(s, 1, q - 1)
	}
	function gnum(dev, key,   p, q, s, out) {
		p = index(dev, "\"" key "\":")
		if (p <= 0) return 0
		s = substr(dev, p + length(key) + 3)
		sub(/^[ \t]*/, "", s)
		out = s + 0
		return out
	}
	BEGIN {
		b = ""; s = ""
		while ((getline line < base) > 0) b = b line; close(base)
		while ((getline line < subs) > 0) s = s line; close(subs)
		parse(b, BRX, BTX, BIP, BHOST, BONL, BMAC)
		parse(s, SRX, STX, SIP, SHOST, SONL, SMAC)
		first = 1
		for (m in BMAC) {
			brx = BRX[m]; btx = BTX[m]
			srx = (m in SRX) ? SRX[m] : 0
			stx = (m in STX) ? STX[m] : 0
			drx = brx - srx; if (drx < 0) drx = 0
			dtx = btx - stx; if (dtx < 0) dtx = 0
			host = (m in BHOST) ? BHOST[m] : "Unknown"
			ip = (m in BIP) ? BIP[m] : ""
			onl = (m in BONL) ? BONL[m] : 0
			gsub(/\\/, "\\\\", host)
			gsub(/"/, "\\\"", host)
			if (!first) out = out ","
			first = 0
			out = out sprintf("{\"mac\":\"%s\",\"ip\":\"%s\",\"hostname\":\"%s\",\"online\":%d,\"rx_bytes\":%.0f,\"tx_bytes\":%.0f,\"total_bytes\":%.0f}",
				BMAC[m], ip, host, onl, drx, dtx, drx + dtx)
		}
		print "[" out "]"
	}' 2>/dev/null
}

# Read-only stats retrieval for a range
get_stats() {
	range="${1:-today}"
	cur_month=$(ym)
	cur_day=$(ymd)
	dmi=$(days_in_month_of "$cur_month")

	devices_json='[]'
	total=0
	rx_total=0
	tx_total=0
	days_json='[]'
	monthly_total=0
	monthly_rx=0
	monthly_tx=0

	case "$range" in
		month:*)
			m="${range#month:}"
			dev_file="$MONTHS_DIR/monthly_devices_$m.json"
			days_file="$MONTHS_DIR/history_$m.json"
			if [ -s "$days_file" ]; then
				days_json=$(awk -F'"days":' '{print $2}' "$days_file" 2>/dev/null | sed 's/}$//' | tr -d '\r\n')
			fi
			set -- $(sum_devices_file "$dev_file")
			monthly_total=$1; monthly_rx=$2; monthly_tx=$3
			total=$monthly_total; rx_total=$monthly_rx; tx_total=$monthly_tx
			devices_json=$(extract_devices "$dev_file")
			month="$m"
			;;
		yesterday)
			y=$(shift_days 1)
			by=$(shift_days 2)
			fy=$(day_file "$y")
			fb=$(day_file "$by")
		if [ -s "$fy" ]; then
			set -- $(sum_devices_file "$fy")
			y_tot=$1; y_rx=$2; y_tx=$3
			set -- $(sum_devices_file "$fb")
			b_tot=$1; b_rx=$2; b_tx=$3
			total=$(delta "$y_tot" "$b_tot")
			rx_total=$(delta "$y_rx" "$b_rx")
			tx_total=$(delta "$y_tx" "$b_tx")
			devices_json=$(diff_devices "$fy" "$fb")
		fi
			set -- $(sum_devices_file "$SNAPSHOT")
			monthly_total=$1; monthly_rx=$2; monthly_tx=$3
			;;
		last7)
			w7=$(shift_days 7)
			fb=$(latest_day_before "$w7")
			set -- $(sum_devices_file "$SNAPSHOT")
			c_tot=$1; c_rx=$2; c_tx=$3
			monthly_total=$c_tot; monthly_rx=$c_rx; monthly_tx=$c_tx
			if [ -s "$fb" ]; then
				set -- $(sum_devices_file "$fb")
				b_tot=$1; b_rx=$2; b_tx=$3
				total=$(delta "$c_tot" "$b_tot")
				rx_total=$(delta "$c_rx" "$b_rx")
				tx_total=$(delta "$c_tx" "$b_tx")
				devices_json=$(diff_devices "$SNAPSHOT" "$fb")
			else
				total=$c_tot; rx_total=$c_rx; tx_total=$c_tx
				devices_json=$(extract_devices "$SNAPSHOT")
			fi
			;;
		today|month|*)
			set -- $(sum_devices_file "$SNAPSHOT")
			monthly_total=$1; monthly_rx=$2; monthly_tx=$3
			# Today-only totals: current minus last day snapshot
			prev_day=$(shift_days 1)
			fp=$(day_file "$prev_day")
			if [ -s "$fp" ]; then
				set -- $(sum_devices_file "$fp")
				b_tot=$1; b_rx=$2; b_tx=$3
				total=$(delta "$monthly_total" "$b_tot")
				rx_total=$(delta "$monthly_rx" "$b_rx")
				tx_total=$(delta "$monthly_tx" "$b_tx")
				devices_json=$(diff_devices "$SNAPSHOT" "$fp")
			else
				total=$monthly_total; rx_total=$monthly_rx; tx_total=$monthly_tx
				devices_json=$(extract_devices "$SNAPSHOT")
			fi
			;;
	esac

	[ -z "$days_json" ] && days_json='[]'
	[ -z "$devices_json" ] && devices_json='[]'

	# Daily breakdown fallback: current month aggregation when the requested
	# range does not carry its own day data
	if [ -z "$days_json" ] || [ "$days_json" = "[]" ]; then
		if [ -s "$DAILY" ]; then
			days_json=$(awk -F'"days":' '{print $2}' "$DAILY" 2>/dev/null | sed 's/}$//' | tr -d '\r\n')
		else
			days_json='[]'
		fi
	fi

	# Available archived months
	available='[{"id":"current","label":"'"$(date +'%B %Y')"' (Current)"}'
	for hf in "$MONTHS_DIR"/history_*.json; do
		if [ -f "$hf" ]; then
			m_tag="${hf##*/history_}"
			m_tag="${m_tag%.json}"
			available="${available},{\"id\":\"${m_tag}\",\"label\":\"${m_tag}\"}"
		fi
	done
	available="${available}]"

	printf '{"timestamp":%d,"range":"%s","month":"%s","month_name":"%s","current_day":%d,"days_in_month":%d,"available_months":%s,"days":%s,"devices":%s,"total_bytes":%s,"rx_bytes":%s,"tx_bytes":%s,"monthly_total_bytes":%s,"monthly_rx_bytes":%s,"monthly_tx_bytes":%s}\n' \
		"$(today_epoch)" "$range" "$cur_month" "$(date +'%B %Y')" "${cur_day##*-}" "$dmi" \
		"$available" "$days_json" "$devices_json" \
		"$total" "$rx_total" "$tx_total" \
		"$monthly_total" "$monthly_rx" "$monthly_tx"
}

reset_stats() {
	target="${1:-all}"
	case "$target" in
		all|"")
			rm -f "$RAM_DIR"/dat/*.dat "$STORAGE_DIR"/dat/*.dat "$SNAPSHOT" "$DAILY" "$STATE" "$RAM_DIR"/reset_queue 2>/dev/null || true
			rm -f "$DAYS_DIR"/day_*.json "$MONTHS_DIR"/history_*.json "$MONTHS_DIR"/monthly_devices_*.json 2>/dev/null || true
			rm -f "$STORAGE_DIR"/current_stats.json "$STORAGE_DIR"/daily.json "$STORAGE_DIR"/state.info 2>/dev/null || true
			touch "$RAM_DIR/reset_all" 2>/dev/null || true
			"$HELPER" flush >/dev/null 2>&1 || true
			mkdir -p "$DAYS_DIR" "$MONTHS_DIR" "$RAM_DIR/dat" "$STORAGE_DIR/dat"
			rebuild_daily
			;;
		mac:*|*:*:*:*:*:*)
			mac="${target#mac:}"
			m12=$(echo "$mac" | tr -cd '0-9a-fA-F' | tr '[:upper:]' '[:lower:]')
			if [ -n "$m12" ] && [ "$m12" != "000000000000" ]; then
				rm -f "$RAM_DIR/dat/$m12.dat" "$STORAGE_DIR/dat/$m12.dat" 2>/dev/null || true
				echo "$m12" >> "$RAM_DIR/reset_queue" 2>/dev/null || true
			fi
			;;
		*)
			;;
	esac
}

case "$ACTION" in
	get)
		get_stats "$PARAM"
		;;
	reset)
		lock_or_exit
		reset_stats "$PARAM"
		printf '{"status":"success"}\n'
		;;
	sync)
		lock_or_exit
		ensure_daily
		sync_to_storage
		;;
	restore)
		restore_to_ram
		;;
	archive_daily|check_rollover)
		lock_or_exit
		ensure_daily
		sync_to_storage
		;;
	*)
		get_stats "today"
		;;
esac

exit 0
