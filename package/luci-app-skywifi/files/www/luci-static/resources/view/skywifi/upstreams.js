'use strict';
'require view';
'require rpc';
'require poll';
'require dom';
'require uci';

var callGetNetInfo = rpc.declare({
	object: 'luci.skywifi',
	method: 'get_netinfo',
	expect: {}
});

var prevBytes = {};
var lastTime = 0;

function formatBytes(bytes) {
	if (!bytes || bytes === 0) return '0.00 B';
	var k = 1024;
	var sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
	var i = Math.floor(Math.log(bytes) / Math.log(k));
	return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatRate(bytesPerSec) {
	if (!bytesPerSec || bytesPerSec <= 0) return '0.00 kb/s';
	var bitsPerSec = bytesPerSec * 8;
	if (bitsPerSec >= 1000000) {
		return (bitsPerSec / 1000000).toFixed(2) + ' Mb/s';
	}
	return (bitsPerSec / 1000).toFixed(2) + ' kb/s';
}

function rate(key, bytes, dt) {
	var cur = parseInt(bytes) || 0;
	var prev = prevBytes[key];
	var r = (prev !== undefined && cur >= prev) ? ((cur - prev) / dt) : 0;
	prevBytes[key] = cur;
	return r;
}

function sanitizeArr(arr) {
	if (!arr) return [];
	var raw = [];
	var stack = Array.isArray(arr) ? arr.slice() : [arr];

	while (stack.length > 0) {
		var item = stack.shift();
		if (item === null || item === undefined) continue;
		if (typeof item === 'string') {
			raw.push(item);
		} else if (Array.isArray(item)) {
			stack = item.concat(stack);
		} else if (typeof item === 'object') {
			if (item.textContent !== undefined && item.textContent !== null) {
				raw.push(String(item.textContent));
			} else {
				var str = String(item);
				if (!/\[object\s+HTML[A-Za-z]+Element\]/i.test(str)) {
					raw.push(str);
				}
			}
		}
	}

	var clean = [];
	raw.forEach(function (str) {
		if (typeof str !== 'string') return;
		str = str.replace(/\[object\s+HTML[A-Za-z]+Element\]/gi, ' ')
		         .replace(/<br\s*\/?>/gi, ' ')
		         .replace(/,/g, ' ');
		var parts = str.split(/\s+/);
		parts.forEach(function (p) {
			p = p.trim();
			if (p && p !== '—' && p !== '?' && !/\[object\s+HTML[A-Za-z]+Element\]/i.test(p)) {
				clean.push(p);
			}
		});
	});

	return clean;
}

function filterIp4(arr) {
	var clean = sanitizeArr(arr);
	var res = [];
	var seen = {};
	clean.forEach(function (ip) {
		if (!ip.includes(':') && /^[0-9.]+(\/[0-9]+)?$/.test(ip)) {
			if (!seen[ip]) {
				seen[ip] = true;
				res.push(ip);
			}
		}
	});
	return res;
}

function filterIp6(arr) {
	var clean = sanitizeArr(arr);
	var res = [];
	var seen = {};
	clean.forEach(function (ip) {
		if (ip.includes(':') && /^[0-9a-fA-F:]+(\/[0-9]+)?$/.test(ip)) {
			if (!seen[ip]) {
				seen[ip] = true;
				res.push(ip);
			}
		}
	});
	return res;
}

function joinArr(arr, sep) {
	var clean = sanitizeArr(arr);
	return clean.length > 0 ? clean.join(sep || ', ') : '—';
}

// array of values rendered as div elements per line
function joinArrDom(arr) {
	var clean = Array.isArray(arr) ? arr : sanitizeArr(arr);
	if (!clean || clean.length === 0) return '—';
	if (clean.length === 1) return clean[0];

	var res = clean.map(function (a) {
		return E('div', {}, [a]);
	});
	return E('div', {}, res);
}

function dash(txt) {
	return (txt && txt !== '?' && txt !== '—') ? txt : '—';
}

return view.extend({
	load: function () {
		return uci.load('skywifi').catch(function() { return {}; });
	},

	render: function () {
		var self = this;
		var container = E('div', { 'class': 'cbi-map', 'id': 'netmon-upstreams' }, [
			E('style', {}, [
				'#netmon-upstreams { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #0f172a; font-size: 12px; }',
				'.up-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; flex-wrap: wrap; gap: 12px; }',
				'.up-header h2 { font-size: 16px !important; font-weight: 800 !important; color: #0f172a; margin: 0; }',
				'.up-header .up-sub { font-size: 12px !important; color: #64748b; margin-top: 4px; }',
				'.up-card { background: #ffffff; border-radius: 16px; padding: 20px; border: 1px solid #e2e8f0; box-shadow: 0 4px 20px rgba(0,0,0,0.03); margin-bottom: 20px; }',
				'.up-card-title { font-size: 13px !important; font-weight: 800 !important; color: #0f172a; margin: 0 0 14px 0; text-transform: uppercase; letter-spacing: 0.04em; }',
				'.up-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 14px; }',
				'.up-tile { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 16px; }',
				'.up-tile-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }',
				'.up-tile-name { font-weight: 800; font-size: 14px; display: flex; align-items: center; gap: 8px; }',
				'.up-tile-sub { font-size: 10px !important; font-weight: 600 !important; color: #94a3b8; margin-top: 2px; }',
				'.up-dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }',
				'.up-dot-on { background: #10b981; box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.15); }',
				'.up-dot-off { background: #ef4444; box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.15); }',
				'.up-badge { font-size: 10px !important; font-weight: 800 !important; text-transform: uppercase; letter-spacing: 0.04em; padding: 3px 10px; border-radius: 12px; background: #e0e7ff; color: #3730a3; }',
				'.up-row { display: flex; justify-content: space-between; gap: 10px; padding: 5px 0; font-size: 12px !important; }',
				'.up-row .k { color: #64748b; font-weight: 700; white-space: nowrap; }',
				'.up-row .v { color: #0f172a; font-weight: 600; text-align: right; word-break: break-all; }',
				'.up-ping { font-weight: 800; }',
				'.up-ping-ok { color: #059669; }',
				'.up-ping-fail { color: #dc2626; }',
				'.table-responsive { width: 100% !important; max-width: 100% !important; overflow-x: auto !important; -webkit-overflow-scrolling: touch !important; display: block !important; }',
				'.up-table { width: 100% !important; border-collapse: separate; border-spacing: 0; }',
				'.up-table th { font-size: 11px !important; font-weight: 800 !important; color: #475569; padding: 10px 14px; text-align: left; background: #f8fafc; border-bottom: 1.5px solid #e2e8f0; text-transform: uppercase; letter-spacing: 0.04em; white-space: nowrap !important; }',
				'.up-table td { padding: 10px 14px; border-bottom: 1px solid #e2e8f0; font-size: 12px !important; color: #0f172a; vertical-align: middle; background: #ffffff; }',
				'.up-table tr:last-child td { border-bottom: none; }',
				'.up-mac { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace !important; font-size: 11px !important; color: #475569; }',
				'.st-badge { display: inline-flex; align-items: center; gap: 5px; padding: 2px 10px; border-radius: 12px; font-size: 11px !important; font-weight: 800 !important; }',
				'.st-up { background: #dcfce7; color: #15803d; }',
				'.st-down { background: #fee2e2; color: #b91c1c; }',
				'.st-mid { background: #fef3c7; color: #b45309; }',
				'.spd-rx { color: #059669; font-weight: 700; }',
				'.spd-tx { color: #d97706; font-weight: 700; }',
				'@media (max-width: 768px) { .up-grid { grid-template-columns: 1fr !important; } .up-header { flex-direction: column; align-items: flex-start; } }'
			]),

			E('div', { 'class': 'up-header' }, [
				E('div', {}, [
					E('h2', {}, [_('Upstreams')])
				])
			]),

			// Upstream Connections
			E('div', { 'class': 'up-card' }, [
				E('h3', { 'class': 'up-card-title' }, [_('Upstream Connections')]),
				E('div', { 'id': 'upstream-cards', 'class': 'up-grid' }, [
					E('div', { 'style': 'color: #64748b; padding: 20px; text-align: center;' }, [_('Loading upstream status...')])
				])
			]),

			// Wireless Interfaces
			E('div', { 'class': 'up-card' }, [
				E('h3', { 'class': 'up-card-title' }, [_('Wireless Interfaces')]),
				E('div', { 'id': 'radio-cards', 'class': 'up-grid' }, [
					E('div', { 'style': 'color: #64748b; padding: 20px; text-align: center;' }, [_('Loading wireless interfaces...')])
				])
			]),

			// Wired Interfaces
			E('div', { 'class': 'up-card' }, [
				E('h3', { 'class': 'up-card-title' }, [_('Wired Interfaces')]),
				E('div', { 'id': 'wired-cards', 'class': 'up-grid' }, [
					E('div', { 'style': 'color: #64748b; padding: 20px; text-align: center;' }, [_('Loading interfaces...')])
				])
			])
		]);

		// Refresh every 5 seconds
		poll.add(function () {
			return callGetNetInfo().then(function (res) {
				self.update(res);
			});
		}, 5);

		return container;
	},

	update: function (res) {
		if (!res || !Array.isArray(res.upstreams) || !Array.isArray(res.interfaces)) return;

		var now = Date.now() / 1000;
		var dt = (lastTime > 0) ? (now - lastTime) : 1;
		if (dt <= 0) dt = 1;
		lastTime = now;

		// Deduplicate Upstreams
		var seenUpstreams = {};
		var upstreams = [];
		res.upstreams.forEach(function (u) {
			if (!u || !u.iface || u.iface === '?') return;
			if (!seenUpstreams[u.iface]) {
				seenUpstreams[u.iface] = true;
				upstreams.push(u);
			}
		});

		// Deduplicate Interfaces
		var seenIfaces = {};
		var interfaces = [];
		res.interfaces.forEach(function (i) {
			if (!i || !i.name || i.name === 'lo') return;
			if (!seenIfaces[i.name]) {
				seenIfaces[i.name] = true;
				interfaces.push(i);
			}
		});

		// --- Upstream cards ---
		var cards = document.getElementById('upstream-cards');
		if (cards) {
			dom.content(cards, []);

			if (upstreams.length === 0) {
				cards.appendChild(E('div', { 'style': 'color: #64748b; padding: 20px; text-align: center;' }, [_('No upstream connection detected.')]));
			}

			upstreams.forEach(function (u) {
				var rxRate = rate('up_' + u.iface + '_rx', u.rx_bytes, dt);
				var txRate = rate('up_' + u.iface + '_tx', u.tx_bytes, dt);
				var online = !!u.ping_ok;

				var rows = [
					E('div', { 'class': 'up-row' }, [
						E('span', { 'class': 'k' }, [_('Gateway')]),
						E('span', { 'class': 'v' }, [dash(u.gateway)])
					]),
					E('div', { 'class': 'up-row' }, [
						E('span', { 'class': 'k' }, [_('IPv4')]),
						E('span', { 'class': 'v' }, [joinArrDom(filterIp4(u.ipv4))])
					]),
					E('div', { 'class': 'up-row' }, [
						E('span', { 'class': 'k' }, [_('IPv6')]),
						E('span', { 'class': 'v' }, [joinArrDom(filterIp6(u.ipv6))])
					]),
					E('div', { 'class': 'up-row' }, [
						E('span', { 'class': 'k' }, [_('DNS Resolvers')]),
						E('span', { 'class': 'v' }, [joinArrDom(u.dns)])
					]),
					E('div', { 'class': 'up-row' }, [
						E('span', { 'class': 'k' }, [_('Gateway Ping')]),
						E('span', { 'class': 'v up-ping ' + (online ? 'up-ping-ok' : 'up-ping-fail') }, [
							u.ping_ms !== null && u.ping_ms !== undefined ? (u.ping_ms + ' ms') : _('unreachable')
						])
					]),
					E('div', { 'class': 'up-row' }, [
						E('span', { 'class': 'k' }, [_('Download')]),
						E('span', { 'class': 'v spd-rx' }, ['↓ ' + formatRate(rxRate)])
					]),
					E('div', { 'class': 'up-row' }, [
						E('span', { 'class': 'k' }, [_('Upload')]),
						E('span', { 'class': 'v spd-tx' }, ['↑ ' + formatRate(txRate)])
					])
				];

				var dot = E('span', { 'class': 'up-dot ' + (online ? 'up-dot-on' : 'up-dot-off') });
				var name = E('span', { 'class': 'up-tile-name' }, [dot, u.iface || '?']);
				var protoBadge = (u.proto && u.proto !== '' && u.proto !== '?' && u.proto !== 'none') ?
					E('span', { 'class': 'up-badge' }, [u.proto]) : '';

				cards.appendChild(E('div', { 'class': 'up-tile' }, [
					E('div', { 'class': 'up-tile-head' }, [name, protoBadge]),
					E('div', {}, rows)
				]));
			});
		}

		// --- Interface cards ---
		var radioCards = document.getElementById('radio-cards');
		var wiredCards = document.getElementById('wired-cards');
		if (!radioCards || !wiredCards) return;

		var radios = interfaces.filter(function (i) { return i.type === 'wireless'; });
		var wired = interfaces.filter(function (i) {
			if (i.type === 'wireless' || i.name === 'lo') return false;
			return !/^(pppoe|ppp|tun|tap|veth|ifb|gre|sit|ip6tnl)/i.test(i.name);
		});

		this.renderIfaceCards(radioCards, radios, _('No wireless interfaces found.'), dt);
		this.renderIfaceCards(wiredCards, wired, _('No interfaces found.'), dt);
	},

	renderIfaceCards: function (cardsEl, ifaces, emptyText, dt) {
		dom.content(cardsEl, []);

		if (ifaces.length === 0) {
			cardsEl.appendChild(E('div', { 'style': 'color: #64748b; padding: 20px; text-align: center;' }, [emptyText]));
			return;
		}

		ifaces.forEach(function (i) {
			var rxRate = rate('if_' + i.name + '_rx', i.rx_bytes, dt);
			var txRate = rate('if_' + i.name + '_tx', i.tx_bytes, dt);

			var isUp = (i.state === 'up' || i.carrier === 1);
			var stCls = isUp ? 'st-up' : ((i.state === 'down' || i.carrier === 0) ? 'st-down' : 'st-mid');
			var stTxt = isUp ? _('UP') : ((i.state === 'down' || i.carrier === 0) ? _('DOWN') : _('UNKNOWN'));

			var linkTxt = '—';
			if (i.carrier === 1) linkTxt = _('Up');
			else if (i.carrier === 0) linkTxt = _('Down');

			var nameTxt = i.name || '?';
			var subParts = [];
			if (i.uci_name) subParts.push(i.uci_name.toUpperCase());
			if (i.is_bridge) subParts.push('Bridge');
			else if (i.master) subParts.push('Port of ' + i.master);
			if (i.phy) subParts.push(i.phy);
			if (parseInt(i.speed) > 0) subParts.push(i.speed + ' Mb/s');

			var subTxt = subParts.join(' · ');

			var uciBadge = (i.uci_name && i.uci_name !== '') ?
				E('span', { 'class': 'up-badge' }, [i.uci_name.toUpperCase()]) : '';

			cardsEl.appendChild(E('div', { 'class': 'up-tile' }, [
				E('div', { 'class': 'up-tile-head' }, [
					E('div', {}, [
						E('div', { 'class': 'up-tile-name' }, [nameTxt]),
						subTxt ? E('div', { 'class': 'up-tile-sub' }, [subTxt]) : ''
					]),
					E('div', { 'style': 'display: flex; gap: 6px; align-items: center;' }, [
						uciBadge,
						E('span', { 'class': 'st-badge ' + stCls }, [stTxt])
					])
				]),
				E('div', { 'class': 'up-row' }, [
					E('span', { 'class': 'k' }, [_('Link')]),
					E('span', { 'class': 'v' }, [linkTxt])
				]),
				E('div', { 'class': 'up-row' }, [
					E('span', { 'class': 'k' }, [_('MAC Address')]),
					E('span', { 'class': 'v up-mac' }, [dash(i.mac)])
				]),
				E('div', { 'class': 'up-row' }, [
					E('span', { 'class': 'k' }, [_('IPv4')]),
					E('span', { 'class': 'v' }, [joinArrDom(filterIp4(i.ipv4))])
				]),
				E('div', { 'class': 'up-row' }, [
					E('span', { 'class': 'k' }, [_('IPv6')]),
					E('span', { 'class': 'v' }, [joinArrDom(filterIp6(i.ipv6))])
				]),
				E('div', { 'class': 'up-row' }, [
					E('span', { 'class': 'k' }, [_('Download')]),
					E('span', { 'class': 'v spd-rx' }, ['↓ ' + formatRate(rxRate)])
				]),
				E('div', { 'class': 'up-row' }, [
					E('span', { 'class': 'k' }, [_('Upload')]),
					E('span', { 'class': 'v spd-tx' }, ['↑ ' + formatRate(txRate)])
				])
			]));
		});
	}
});
