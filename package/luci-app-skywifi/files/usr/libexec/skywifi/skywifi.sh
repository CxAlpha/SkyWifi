#!/bin/sh
. /usr/libexec/skywifi/skywifi-lib.sh

case "$1" in
	setup)
		nft_setup
		;;
	stop)
		nft delete table $NFT_FAMILY $NFT_TABLE 2>/dev/null || true
		;;
	reconcile)
		nowv=$(now)
		while TAB=$(printf '\t')
		IFS="$TAB" read -r mac cid ip name activated expires state last; do
			[ -n "$mac" ] || continue
			# Device history never grants access by itself. A matching ACTIVE,
			# unexpired voucher assigned to this MAC is required.
			if [ "$state" = ACTIVE ] && device_voucher_valid "$mac" && { [ "$expires" = 0 ] || { [ -n "$expires" ] && [ "$expires" -gt "$nowv" ] 2>/dev/null; }; }; then
				current_ip=$(ip neigh show 2>/dev/null | awk -v m="$mac" 'tolower($5)==m && $1 ~ /^[0-9]+(\.[0-9]+){3}$/ {print $1; exit}')
				if [ -n "$current_ip" ]; then
					if [ "$expires" = 0 ]; then
						authorize_ip "$current_ip" lifetime
					else
						remaining=$((expires-nowv)); [ "$remaining" -lt 1 ] && remaining=1
						nft_setup >/dev/null 2>&1 || true
						nft add element $NFT_FAMILY $NFT_TABLE authorized4 "{ $current_ip timeout ${remaining}s }" 2>/dev/null || true
					fi
					[ "$ip" = "$current_ip" ] || update_device_ip "$mac" "$current_ip"
				fi
			else
				[ -n "$ip" ] && deauthorize_ip "$ip"
			fi
		done < "$DEVICES"
		;;
	set_enabled)
		enabled=$2
		case "$enabled" in 1|true|on|yes) enabled=1;; *) enabled=0;; esac
		uci set skywifi.global.portal_enabled="$enabled"
		uci commit skywifi || exit 1
		/etc/init.d/skywifi restart >/dev/null 2>&1 || true
		if [ "$enabled" = 1 ]; then
			i=0
			while [ "$i" -lt 20 ]; do
				portal_listener_up && nft list table $NFT_FAMILY $NFT_TABLE >/dev/null 2>&1 && break
				sleep 0.25; i=$((i+1))
			done
			if ! portal_listener_up || ! nft list table $NFT_FAMILY $NFT_TABLE >/dev/null 2>&1; then
				uci set skywifi.global.portal_enabled='0'; uci commit skywifi
				/etc/init.d/skywifi restart >/dev/null 2>&1 || true
				echo '{"status":"error","error":"portal_start_failed","enabled":0}'
				exit 1
			fi
		else
			i=0
			while [ "$i" -lt 20 ]; do
				if ! portal_listener_up && ! nft list table $NFT_FAMILY $NFT_TABLE >/dev/null 2>&1; then break; fi
				sleep 0.25; i=$((i+1))
			done
		fi
		echo '{"status":"ok","enabled":'"$enabled"'}'
		;;
	reset)
		reset_data
		echo '{"status":"ok","enabled":0}'
		;;
	status)
		active=$(awk -F '\t' -v now="$(now)" '$7=="ACTIVE" && ($6==0 || $6>now){c++} END{print c+0}' "$DEVICES" 2>/dev/null)
		unused=$(awk -F '\t' '$2=="UNUSED"{c++} END{print c+0}' "$VOUCHERS" 2>/dev/null)
		expired=$(awk -F '\t' -v now="$(now)" '$6>0 && $6<=now{c++} END{print c+0}' "$DEVICES" 2>/dev/null)
		portal=$(uci -q get skywifi.global.portal_enabled || echo 0)
	admin_configured=0
	[ -n "$(uci -q get skywifi.global.admin_password_hash)" ] && admin_configured=1
		case "$portal" in 1|true|on) portal=1;; *) portal=0;; esac
		runtime=0
	portal_listener_up && runtime=1
	nftok=0
	nft list table $NFT_FAMILY $NFT_TABLE >/dev/null 2>&1 && nftok=1
	printf '{"active_devices":%s,"unused_vouchers":%s,"expired_devices":%s,"portal_enabled":%s,"portal_listener":%s,"portal_nft":%s,"admin_configured":%s}\n' "$active" "$unused" "$expired" "$portal" "$runtime" "$nftok" "$admin_configured"
		;;
	generate)
		count=${2:-1}; validity=${3:-30d}
		case "$count" in ''|*[!0-9]*) count=1;; esac
		[ "$count" -gt 5000 ] && count=5000
		case "$validity" in lifetime|30d) ;; *) validity=30d;; esac
		i=0
		while [ "$i" -lt "$count" ]; do
			code=$(random_voucher_code) || continue
			if ! voucher_exists "$code"; then
				# Field 3 stores the plan (30d/lifetime); field 5 is expiry and remains 0 until activation.
				printf '%s\tUNUSED\t%s\t%s\t0\t0\t-\t-\n' "$code" "$(now)" "$validity" >> "$VOUCHERS"
				printf '%s\n' "$code"
				i=$((i+1))
			fi
		 done
		log_event "GENERATE count=$count validity=$validity"
		;;
		revoke)
		[ -n "$2" ] || exit 1
		line=$(voucher_get "$2")
		TAB=$(printf '\t')
		IFS="$TAB" read -r vcode vstatus vcreated vplan vactivated vexpires vcustomer vdevice <<EOFV
$line
EOFV
		revoke_voucher "$2"
		[ -n "$vdevice" ] && {
			device_line=$(find_device "$vdevice")
			TAB=$(printf '\t')
			IFS="$TAB" read -r dmac dcid dip dname dact dexp dstatus dlast <<EOFD
$device_line
EOFD
			[ -n "$dip" ] && deauthorize_ip "$dip"
		}
		log_event "REVOKE voucher=$2"
		;;
	*)
		echo "usage: $0 {setup|stop|status|generate [count] [30d|lifetime]|revoke CODE}" >&2
		exit 1
		;;
esac
