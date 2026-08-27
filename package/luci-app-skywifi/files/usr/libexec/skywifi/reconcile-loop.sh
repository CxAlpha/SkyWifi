#!/bin/sh
while true; do
	/usr/libexec/skywifi/skywifi.sh reconcile >/dev/null 2>&1 || true
	sleep 15
done
