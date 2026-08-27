'use strict';
'require view';
'require rpc';
'require ui';
'require dom';
'require uci';
'require poll';

var callGetDevices = rpc.declare({
	object: 'luci.skywifi',
	method: 'get_devices',
	expect: {}
});

var callApplyQoS = rpc.declare({
	object: 'luci.skywifi',
	method: 'apply_qos',
	expect: {}
});

var callGetQoSStatus = rpc.declare({
	object: 'luci.skywifi',
	method: 'get_qos_status',
	expect: {}
});

var callSetQoSEnabled = rpc.declare({
	object: 'luci.skywifi',
	method: 'set_qos_enabled',
	params: ['enabled'],
	expect: {}
});

var callToggleQoSRule = rpc.declare({
	object: 'luci.skywifi',
	method: 'toggle_qos_rule',
	params: ['section', 'enabled'],
	expect: {}
});

var rulesList = [];
var editingRuleId = null;
var deviceMap = {};
var lastStats = {};
var currentDevices = [];
var lastTime = 0;
var lastOnlineMap = {};
var lastDeviceSig = '';

var IP_OCTET = '(?:[0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])';
var IP_RANGE_RE = new RegExp('^' + IP_OCTET + '(?:\\.' + IP_OCTET + '){3}(-[0-9.]+)?$');
var MAC_RE = /^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/;

// Module-level helpers: deliberately NOT methods on the view class so they
// work regardless of how the LuCI view runtime binds `this`/`self`.
function normalizeMac(mac) {
	return (mac || '').trim().toUpperCase();
}

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

function ipToNum(ip) {
	if (!ip) return 0;
	var parts = ip.split('.');
	if (parts.length !== 4) return 0;
	return ((parseInt(parts[0]) << 24) | (parseInt(parts[1]) << 16) | (parseInt(parts[2]) << 8) | parseInt(parts[3])) >>> 0;
}

function isMatchTarget(targetStr, macStr, devIp, devMac) {
	if (macStr && devMac && macStr.toLowerCase() === devMac.toLowerCase()) return true;
	if (!targetStr) return false;
	if (targetStr === devIp) return true;
	if (targetStr.indexOf('-') !== -1) {
		var parts = targetStr.split('-');
		var startIp = parts[0].trim();
		var endIp = parts[1].trim();
		if (endIp.indexOf('.') === -1) {
			var base = startIp.substring(0, startIp.lastIndexOf('.') + 1);
			endIp = base + endIp;
		}
		var devNum = ipToNum(devIp);
		var startNum = ipToNum(startIp);
		var endNum = ipToNum(endIp);
		if (devNum > 0 && devNum >= startNum && devNum <= endNum) return true;
	}
	return false;
}

// Validate a single QoS rule before it is committed
function validateQoSRule(targetType, targetVal, down, up, quotaVal, isBlock) {
	if (targetType !== 'IP' && targetType !== 'MAC') {
		return _('Target must be IP or MAC');
	}
	if (targetType === 'IP' && !IP_RANGE_RE.test(targetVal)) {
		return _('Invalid IP address or range');
	}
	if (targetType === 'MAC' && !MAC_RE.test(targetVal)) {
		return _('Invalid MAC address (e.g. aa:bb:cc:dd:ee:ff)');
	}
	var d = parseFloat(down) || 0;
	var u = parseFloat(up) || 0;
	var q = parseFloat(quotaVal) || 0;
	if (d < 0 || u < 0) {
		return _('Speed limits cannot be negative numbers');
	}
	if (d === 0 && u === 0 && q === 0 && !isBlock) {
		return _('Please enter bandwidth speed limits or a data quota limit.');
	}
	if (d > 100000 || u > 100000) {
		return _('Speed must not exceed 100000 kbit/s');
	}
	return null;
}

function renderMediumBadge(connType, isOnline) {
	if (!connType || isOnline === false || isOnline === 0 || isOnline === '0') return '';
	var medium = connType;
	var bg = '#f1f5f9';
	var color = '#475569';
	var border = '#cbd5e1';

	if (medium === '5GHz' || medium === '5G') {
		bg = '#e0e7ff';
		color = '#4338ca';
		border = '#c7d2fe';
		medium = '5 GHz';
	} else if (medium === '2.4GHz' || medium === '2.4G') {
		bg = '#ccfbf1';
		color = '#0f766e';
		border = '#99f6e4';
		medium = '2.4 GHz';
	} else if (medium === '6GHz' || medium === '6G') {
		bg = '#fce7f3';
		color = '#be185d';
		border = '#fbcfe8';
		medium = '6 GHz';
	} else {
		bg = '#f1f5f9';
		color = '#475569';
		border = '#cbd5e1';
		medium = 'LAN';
	}

	return E('span', {
		'class': 'medium-badge',
		'style': 'font-size: 10px !important; font-weight: 700 !important; padding: 2px 7px; border-radius: 6px; background: ' + bg + '; color: ' + color + '; border: 1px solid ' + border + '; display: inline-flex; align-items: center; white-space: nowrap; margin-left: 8px;'
	}, [ medium ]);
}

function renderPagination(containerId, currentPage, totalPages, totalItems, pageSize, onPageChange) {
	var container = document.getElementById(containerId);
	if (!container) return;

	if (totalItems <= pageSize) {
		container.style.display = 'none';
		container.innerHTML = '';
		return;
	}

	container.style.display = 'flex';
	container.style.alignItems = 'center';
	container.style.justifyContent = 'space-between';
	container.style.marginTop = '0';
	container.style.flexWrap = 'wrap';
	container.style.gap = '12px';

	var startItem = Math.min((currentPage - 1) * pageSize + 1, totalItems);
	var endItem = Math.min(currentPage * pageSize, totalItems);

	var infoStr = _('Showing') + ' ' + startItem + '–' + endItem + ' ' + _('of') + ' ' + totalItems + ' ' + _('items');

	var prevBtn = E('button', {
		'class': 'btn cbi-button cbi-button-action',
		'style': 'padding: 4px 12px; font-size: 12px; font-weight: 700; border-radius: 6px;',
		'disabled': currentPage <= 1 ? 'disabled' : null,
		'click': function () {
			if (currentPage > 1) onPageChange(currentPage - 1);
		}
	}, ['‹ ' + _('Previous')]);

	var nextBtn = E('button', {
		'class': 'btn cbi-button cbi-button-action',
		'style': 'padding: 4px 12px; font-size: 12px; font-weight: 700; border-radius: 6px;',
		'disabled': currentPage >= totalPages ? 'disabled' : null,
		'click': function () {
			if (currentPage < totalPages) onPageChange(currentPage + 1);
		}
	}, [_('Next') + ' ›']);

	var pageInfo = E('span', {
		'style': 'font-size: 12px; font-weight: 700; color: #0f172a; padding: 0 6px;'
	}, [_('Page') + ' ' + currentPage + ' ' + _('of') + ' ' + totalPages]);

	dom.content(container, [
		E('div', { 'style': 'font-size: 12px; font-weight: 600; color: #64748b;' }, [infoStr]),
		E('div', { 'style': 'display: flex; align-items: center; gap: 8px;' }, [
			prevBtn,
			pageInfo,
			nextBtn
		])
	]);
}

return view.extend({
	rulesPage: 1,
	devicesPage: 1,
	pageSize: 10,

	load: function () {
		return Promise.all([
			callGetDevices().catch(function() { return {}; }),
			uci.load('skywifi').catch(function() { return {}; }),
			callGetQoSStatus().catch(function() { return {}; })
		]);
	},

	formatBytes: formatBytes,

	formatRate: formatRate,

	normalizeMac: normalizeMac,

	ipToNum: ipToNum,

	isMatchTarget: isMatchTarget,

	// Validate a single QoS rule before it is committed
	validateQoSRule: validateQoSRule,

	render: function (data) {
		var self = this;
		var devRes = data[0] || {};
		var rawDevs = (devRes && Array.isArray(devRes.devices)) ? devRes.devices : [];
		var qosStatus = data[2] || {};
		var uciQosEn = uci.get('skywifi', 'qos', 'enabled');
		var qosMasterEnabled = (uciQosEn !== '0') && (qosStatus.status !== 'disabled' || qosStatus.qos_enabled !== '0');

		var seenKeys = {};
		currentDevices = [];
		rawDevs.forEach(function (d) {
			if (!d) return;
			var normMac = normalizeMac(d.mac);
			var key = normMac.length === 12 ? normMac : (d.ip || '');
			if (key && !seenKeys[key]) {
				seenKeys[key] = d;
				currentDevices.push(d);
			}
		});

		// Load rules from UCI - NO PRESETS
		rulesList = [];
		var uciSections = uci.sections('skywifi', 'qos_rule');
		if (uciSections && uciSections.length > 0) {
			uciSections.forEach(function (s) {
				rulesList.push({
					id: s['.name'],
					enabled: s.enabled === '1' || s.enabled === true,
					target: s.target_val || s.target || '',
					mac: s.mac || '',
					hostname: s.hostname || s.target_val || s.target || 'Custom Target',
					block: s.block === '1' || s.block === 'true' || s.block === true,
					max_down: parseInt(s.max_down) || 0,
					down_unit: s.down_unit || 'Mbps',
					max_up: parseInt(s.max_up) || 0,
					up_unit: s.up_unit || 'Mbps',
					quota_val: parseFloat(s.quota_val) || 0,
					quota_unit: s.quota_unit || 'GB',
					quota_bytes: s.quota_bytes || '0',
					reset_cycle: s.reset_cycle || 'daily',
					priority: s.priority || 'normal',
					strict: s.strict === '1' || s.strict === true,
					ping_opt: s.ping_opt === '1' || s.ping_opt === true,
					schedule: s.schedule || 'Permanent',
					start_time: s.start_time || '',
					end_time: s.end_time || ''
				});
			});
		}

		// Device Select Options
		var deviceSelectOptions = [
			E('option', { 'value': '' }, [_('Select LAN Device')])
		];

		currentDevices.forEach(function (d) {
			var host = (d.hostname && d.hostname !== 'Unknown') ? d.hostname : '';
			var ip = d.ip || '';
			var mac = d.mac || '';
			var connStr = (d.online && d.conn_type) ? (' | ' + d.conn_type) : '';
			if (ip || mac) {
				mac = normalizeMac(mac);
				if (ip) deviceMap[ip] = mac;
				var label = host ? (host + ' (' + ip + connStr + ' | MAC: ' + mac.toUpperCase() + ')') : (ip + connStr + ' | MAC: ' + mac.toUpperCase());
				deviceSelectOptions.push(E('option', {
					'value': ip || mac,
					'data-mac': mac,
					'data-ip': ip,
					'data-hostname': host || ip || mac
				}, [label]));
			}
		});
		var container = E('div', { 'class': 'cbi-map', 'id': 'netmon-qos' }, [
			E('style', {}, [
				'#netmon-qos { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #0f172a; font-size: 12px; }',
				'.qos-card-light { background: #ffffff; border-radius: 12px; padding: 14px 18px; border: 1px solid #e2e8f0; margin-bottom: 16px; box-shadow: 0 2px 10px rgba(0,0,0,0.02); transition: all 0.2s ease; }',
				'.table-responsive { width: 100% !important; max-width: 100% !important; overflow-x: auto !important; -webkit-overflow-scrolling: touch !important; display: block !important; touch-action: pan-x pan-y !important; }',
				'.table-light { width: max-content !important; min-width: 100% !important; border-collapse: separate; border-spacing: 0; table-layout: auto !important; }',
				'.table-light th { text-transform: uppercase; font-size: 10px !important; letter-spacing: 0.05em; color: #64748b; font-weight: 700 !important; padding: 6px 10px !important; text-align: left; background: #f8fafc; border-bottom: 1.5px solid #e2e8f0; white-space: nowrap !important; text-overflow: clip !important; }',
				'.table-light td { padding: 5px 10px !important; border-bottom: 1px solid #e2e8f0; font-size: 11px !important; color: #0f172a; vertical-align: middle; background: #ffffff; white-space: nowrap !important; text-overflow: clip !important; }',
				'.table-light tr:last-child td { border-bottom: none; }',

				'/* Compact Dashboard-Style Input & Dropdown Sizing (36px height) */',
				'.form-section-card { background: linear-gradient(180deg, #ffffff 0%, #f8fafc 100%); border-radius: 14px; border: 1px solid #cbd5e1; padding: 22px; box-shadow: 0 8px 20px -4px rgba(0, 0, 0, 0.04); margin-bottom: 24px; }',
				'.form-label { display: block; font-size: 12px !important; font-weight: 700 !important; color: #334155; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.04em; }',
				'.input-control, .select-control { width: 100%; height: 36px; border-radius: 8px; background-color: #ffffff; border: 1.5px solid #cbd5e1; color: #0f172a; font-weight: 600; font-size: 12px !important; font-family: inherit; box-shadow: 0 1px 2px rgba(0,0,0,0.04); box-sizing: border-box; transition: all 0.2s ease; }',
				'.input-control { padding: 0 12px; line-height: 34px; }',
				'.select-control { padding: 0 8px; line-height: 34px; cursor: pointer; vertical-align: middle; -webkit-appearance: select; -moz-appearance: select; appearance: auto; }',
				'.input-control:focus, .select-control:focus { outline: none; border-color: #6366f1; box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.15); }',

				'/* Compact Toggle Switch Slider Styling */',
				'.switch { position: relative; display: inline-block; width: 36px; height: 18px; vertical-align: middle; flex-shrink: 0; }',
				'.switch input { opacity: 0; width: 0; height: 0; }',
				'.slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #cbd5e1; transition: .2s ease; border-radius: 18px; }',
				'.slider:before { position: absolute; content: ""; height: 12px; width: 12px; left: 3px; bottom: 3px; background-color: white; transition: .2s ease; border-radius: 50%; box-shadow: 0 1px 2px rgba(0,0,0,0.25); }',
				'input:checked + .slider { background-color: #ef4444; }',
				'input:checked + .slider:before { transform: translateX(18px); }',
				'.switch-green input:checked + .slider { background-color: #10b981; }',
				'.switch-green input:checked + .slider:before { transform: translateX(18px); }',

				'.badge-blocked-pill { padding: 2px 8px; border-radius: 12px; font-size: 10px !important; font-weight: 700 !important; background: #fef2f2; color: #dc2626; border: 1px solid #fecaca; display: inline-flex; align-items: center; gap: 4px; }',
				'.badge-schedule { padding: 2px 8px; border-radius: 12px; font-size: 10px !important; font-weight: 600; background: #e0f2fe; color: #0369a1; border: 1px solid #bae6fd; display: inline-flex; align-items: center; gap: 4px; }',
				'.badge-online { font-size: 11px !important; padding: 2px 6px; border-radius: 8px; background: #dcfce7; color: #15803d; border: 1px solid #bbf7d0; font-weight: 700; margin-left: 6px; }',
				'.badge-offline { font-size: 11px !important; padding: 2px 6px; border-radius: 8px; background: #f1f5f9; color: #64748b; border: 1px solid #e2e8f0; font-weight: 600; margin-left: 6px; }',
				'.btn-purple { background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%); color: white; border: none; padding: 7px 16px; border-radius: 6px; font-weight: 700; cursor: pointer; transition: all 0.2s ease; box-shadow: 0 2px 8px rgba(79, 70, 229, 0.25); display: inline-flex; align-items: center; gap: 6px; font-size: 11px !important; }',
				'.btn-purple:hover { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(79, 70, 229, 0.35); }',
				'.btn-light { background: #ffffff; color: #334155; border: 1.5px solid #cbd5e1; padding: 4px 10px; border-radius: 6px; font-weight: 700; cursor: pointer; transition: all 0.2s ease; display: inline-flex; align-items: center; gap: 4px; font-size: 10px !important; }',
				'.btn-light:hover { background: #f8fafc; color: #0f172a; border-color: #94a3b8; }',
				'.speed-dl { color: #059669; font-weight: 700; font-size: 11px !important; }',
				'.speed-ul { color: #d97706; font-weight: 700; font-size: 11px !important; }',
				'.sub-text { font-size: 10px !important; color: #64748b; margin-top: 1px; font-family: monospace; }',

				'/* Responsive QoS Rule Configurator Layout Tokens */',
				'.qos-header-bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; flex-wrap: wrap; gap: 10px; }',
				'.qos-form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }',
				'.qos-input-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }',
				'.qos-block-switch-box { margin-top: 14px; background: #fff5f5; border: 1.5px dashed #fecaca; border-radius: 8px; padding: 10px 14px; display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }',

				'@media (max-width: 768px) {',
					'#netmon-qos { font-size: 11px !important; }',
					'.qos-card-light { padding: 12px !important; border-radius: 10px !important; margin-bottom: 14px !important; }',
					'.form-section-card { padding: 12px !important; border-radius: 10px !important; margin-bottom: 14px !important; }',
					'.qos-header-bar { flex-direction: column !important; align-items: stretch !important; gap: 8px !important; }',
					'.qos-form-grid { grid-template-columns: 1fr !important; gap: 12px !important; }',
					'.qos-input-grid { grid-template-columns: 1fr !important; gap: 8px !important; }',
					'.btn-purple, .btn-light { width: 100% !important; justify-content: center !important; }',
					'.table-responsive { width: 100% !important; max-width: 100vw !important; overflow-x: auto !important; -webkit-overflow-scrolling: touch !important; display: block !important; }',
				'}'
			]),

			// Header Title & Action Bar
			E('div', { 'class': 'qos-header-bar' }, [
				E('div', {}, [
					E('h2', { 'style': 'font-size: 15px !important; font-weight: 700 !important; color: #0f172a; margin: 0;' }, [_('QoS Manager')])
				])
			]),

			// Master QoS Control Switch Card
			E('div', { 'class': 'qos-card-light', 'style': 'padding: 12px 16px; margin-bottom: 16px; background: ' + (qosMasterEnabled ? 'linear-gradient(135deg, #ffffff 0%, #f8fafc 100%)' : '#fffbe6') + '; border: 1.5px solid ' + (qosMasterEnabled ? '#cbd5e1' : '#ffe58f') + ';' }, [
				E('div', { 'style': 'display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px;' }, [
					E('div', { 'style': 'display: flex; align-items: center; gap: 10px;' }, [
						E('span', {
							'style': 'display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: ' + (qosMasterEnabled ? '#10b981' : '#f59e0b') + '; box-shadow: 0 0 0 3px ' + (qosMasterEnabled ? 'rgba(16,185,129,0.2)' : 'rgba(245,158,11,0.2)') + ';'
						}),
						E('div', {}, [
							E('div', { 'style': 'display: flex; align-items: center; gap: 8px;' }, [
								E('h3', { 'style': 'font-size: 0.95rem; font-weight: 800; color: #0f172a; margin: 0;' }, [_('QoS Traffic Manager Engine')]),
								E('span', {
									'style': 'font-size: 10px; font-weight: 800; padding: 2px 8px; border-radius: 12px; text-transform: uppercase; letter-spacing: 0.04em; background: ' + (qosMasterEnabled ? '#dcfce7' : '#fef3c7') + '; color: ' + (qosMasterEnabled ? '#15803d' : '#b45309') + ';'
								}, [qosMasterEnabled ? _('Active Engine') : _('Engine Disabled')])
							]),
							E('p', { 'style': 'margin: 2px 0 0 0; font-size: 11px; color: #64748b;' }, [
								qosMasterEnabled ?
									_('QoS token-bucket bandwidth throttling, priority packet tagging, and internet blocks are fully operational.') :
									_('QoS Engine is disabled. nftables table inet netmon_qos is purged; network traffic flows unthrottled with zero overhead.')
							])
						])
					]),
					E('div', { 'style': 'display: flex; align-items: center; gap: 10px;' }, [
						E('span', { 'style': 'font-weight: 700; font-size: 11px; color: ' + (qosMasterEnabled ? '#0f172a' : '#b45309') + ';' }, [
							qosMasterEnabled ? _('QoS Enabled') : _('QoS Disabled')
						]),
						E('label', { 'class': 'switch switch-green' }, [
							E('input', {
								'type': 'checkbox',
								'id': 'qos-master-toggle-input',
								'checked': qosMasterEnabled ? 'checked' : null,
								'change': function (ev) { self.toggleQoSMaster(ev.target.checked); }
							}),
							E('span', { 'class': 'slider' })
						])
					])
				])
			]),

			// SECTION 1: Active QoS Rules Table Card
			E('div', { 'class': 'qos-card-light' }, [
				E('div', { 'style': 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 18px;' }, [
				E('div', { 'style': 'display:flex; align-items:center; gap:8px;' }, [
					E('h3', { 'class': 'netmon-title', 'style': 'margin:0;' }, [
						_('Active QoS Rules')
					])
				])
			]),
				E('div', { 'class': 'table-responsive' }, [
					E('table', { 'class': 'table-light' }, [
						E('thead', {}, [
							E('tr', {}, [
								E('th', {}, [_('TARGET DEVICE')]),
								E('th', {}, [_('REAL-TIME SPEED')]),
								E('th', {}, [_('SPEED LIMITS')]),
								E('th', {}, [_('QUOTA USAGE (USED / LIMIT)')]),
								E('th', {}, [_('BLOCK TOGGLE')]),
								E('th', {}, [_('RULE STATUS')]),
								E('th', {}, [_('RESET CYCLE')]),
								E('th', { 'style': 'text-align: right;' }, [_('ACTIONS')])
							])
						]),
						E('tbody', { 'id': 'qos-rules-tbody' }, [
							E('tr', {}, [E('td', { 'colspan': '8', 'style': 'text-align: center; padding: 20px; color: #64748b;' }, [_('No active QoS rules configured.')])])
						])
					])
				]),
				E('div', { 'id': 'qos-rules-pagination', 'style': 'padding-top: 12px;' })
			]),

			// SECTION 2: Rule Configuration Card
			E('div', { 'class': 'form-section-card', 'id': 'qos-form-card' }, [
				// Form Header Banner
				E('div', { 'style': 'padding-bottom: 14px; margin-bottom: 20px; border-bottom: 1.5px solid #e2e8f0;' }, [
					E('h3', { 'id': 'qos-form-title', 'style': 'font-size: 1.1rem; font-weight: 800; color: #0f172a; margin: 0;' }, [
						_('Add / Edit QoS Rule')
					])
				]),

				// Form Inputs Grid Layout
				E('div', { 'class': 'qos-form-grid' }, [
					// Left Column: Target Device Selection & IP/MAC Configuration
					E('div', { 'style': 'background: #ffffff; padding: 16px; border-radius: 10px; border: 1px solid #e2e8f0;' }, [
						E('label', { 'class': 'form-label' }, [_('Target Device')]),
						E('select', {
							'id': 'qos-device-select',
							'class': 'select-control',
							'style': 'margin-bottom: 12px;',
							'change': function (ev) {
								var selOption = ev.target.options[ev.target.selectedIndex];
								var val = ev.target.value;
								var mac = selOption ? selOption.getAttribute('data-mac') : '';
								if (val) {
									var targetInp = document.getElementById('qos-target-val');
									var macInp = document.getElementById('qos-mac-val');
									if (targetInp) targetInp.value = val;
									if (macInp && mac) macInp.value = mac;
								}
							}
						}, deviceSelectOptions),

						E('div', { 'class': 'qos-input-grid' }, [
							E('div', {}, [
								E('label', { 'class': 'form-label', 'style': 'font-size: 0.72rem; color: #64748b;' }, [_('IP Address / Range')]),
								E('input', {
									'type': 'text',
									'id': 'qos-target-val',
									'class': 'input-control',
									'placeholder': 'e.g. 192.168.1.100'
								})
							]),
							E('div', {}, [
								E('label', { 'class': 'form-label', 'style': 'font-size: 0.72rem; color: #64748b;' }, [_('MAC Address')]),
								E('input', {
									'type': 'text',
									'id': 'qos-mac-val',
									'class': 'input-control',
									'placeholder': 'AA:BB:CC:DD:EE:FF',
									'style': 'font-family: monospace; font-size: 0.82rem;'
								})
							])
						])
					]),

					// Right Column: Speed Rate Limits (Download & Upload)
					E('div', { 'style': 'background: #ffffff; padding: 16px; border-radius: 10px; border: 1px solid #e2e8f0; display: flex; flex-direction: column; justify-content: space-between;' }, [
						E('div', {}, [
							E('label', { 'class': 'form-label' }, [_('Bandwidth Speed Limits')]),
							E('div', { 'class': 'qos-input-grid' }, [
								// Download Input + Unit
								E('div', {}, [
									E('label', { 'class': 'form-label', 'style': 'font-size: 0.72rem; color: #059669;' }, [_('Max Download')]),
									E('div', { 'style': 'display: flex; gap: 6px;' }, [
										E('input', {
											'type': 'number',
											'id': 'qos-down-val',
											'class': 'input-control',
											'value': '500',
											'placeholder': '500',
											'style': 'flex: 1;'
										}),
										E('select', {
											'id': 'qos-down-unit',
											'class': 'select-control',
											'style': 'width: 78px; font-weight: 700;'
										}, [
											E('option', { 'value': 'Kbps', 'selected': 'selected' }, ['Kbps']),
											E('option', { 'value': 'Mbps' }, ['Mbps'])
										])
									])
								]),
								// Upload Input + Unit
								E('div', {}, [
									E('label', { 'class': 'form-label', 'style': 'font-size: 0.72rem; color: #d97706;' }, [_('Max Upload')]),
									E('div', { 'style': 'display: flex; gap: 6px;' }, [
										E('input', {
											'type': 'number',
											'id': 'qos-up-val',
											'class': 'input-control',
											'value': '500',
											'placeholder': '500',
											'style': 'flex: 1;'
										}),
										E('select', {
											'id': 'qos-up-unit',
											'class': 'select-control',
											'style': 'width: 78px; font-weight: 700;'
										}, [
											E('option', { 'value': 'Kbps', 'selected': 'selected' }, ['Kbps']),
											E('option', { 'value': 'Mbps' }, ['Mbps'])
										])
									])
								])
							]),
							// Data Quota Limit & Reset Cycle Box
							E('div', { 'style': 'margin-top: 12px; padding-top: 12px; border-top: 1px dashed #e2e8f0;' }, [
								E('label', { 'class': 'form-label', 'style': 'font-size: 0.72rem; color: #4338ca;' }, [_('Data Quota Limit & Reset Cycle')]),
								E('div', { 'style': 'display: flex; gap: 6px; margin-bottom: 8px;' }, [
									E('input', {
										'type': 'number',
										'id': 'qos-quota-val',
										'class': 'input-control',
										'placeholder': '0 (Unlimited)',
										'style': 'flex: 1;'
									}),
									E('select', {
										'id': 'qos-quota-unit',
										'class': 'select-control',
										'style': 'width: 78px; font-weight: 700;'
									}, [
										E('option', { 'value': 'MB' }, ['MB']),
										E('option', { 'value': 'GB', 'selected': 'selected' }, ['GB']),
										E('option', { 'value': 'TB' }, ['TB'])
									])
								]),
								E('select', {
									'id': 'qos-reset-cycle',
									'class': 'select-control',
									'style': 'width: 100%; font-weight: 700; font-size: 0.78rem;'
								}, [
									E('option', { 'value': 'daily', 'selected': 'selected' }, [_('Per Day (Daily Reset)')]),
									E('option', { 'value': 'monthly' }, [_('Per Month (Monthly Reset)')]),
									E('option', { 'value': 'total' }, [_('Total / Fixed Limit')])
								])
							])
						])
					])
				]),

				// Bottom Highlight Box: Block Internet Access
				E('div', { 'class': 'qos-block-switch-box' }, [
					E('div', { 'style': 'font-weight: 800; font-size: 0.9rem; color: #991b1b;' }, [_('Block Internet Access')]),
					E('label', { 'class': 'switch' }, [
						E('input', { 'type': 'checkbox', 'id': 'qos-block-val' }),
						E('span', { 'class': 'slider' })
					])
				]),

				// Form Footer Action Buttons
				E('div', { 'style': 'margin-top: 20px; display: flex; justify-content: flex-end; align-items: center; gap: 10px;' }, [
					E('button', {
						'id': 'qos-cancel-btn',
						'class': 'btn-light',
						'style': 'display: none;',
						'click': function () { self.cancelEdit(); }
					}, [_('Cancel Edit')]),
					E('button', {
						'id': 'qos-submit-btn',
						'class': 'btn-purple',
						'click': function () { self.addRuleToList(); }
					}, [_('Add Bandwidth Rule')])
				])
			]),

			// SECTION 3: Live Devices Traffic Table Card
			E('div', { 'class': 'qos-card-light' }, [
				E('div', { 'style': 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 18px;' }, [
					E('div', { 'style': 'font-size: 1.15rem; font-weight: 800; display: flex; align-items: center; gap: 8px; color: #0f172a;' }, [
						_('Live Device Traffic')
					])
				]),
				E('div', { 'class': 'table-responsive' }, [
					E('table', { 'class': 'table-light' }, [
						E('thead', {}, [
							E('tr', {}, [
								E('th', {}, [_('DEVICE')]),
								E('th', {}, [_('DOWNLOAD')]),
								E('th', {}, [_('UPLOAD')]),
								E('th', {}, [_('TOTAL USAGE')]),
								E('th', {}, [_('BLOCK TOGGLE')]),
								E('th', { 'style': 'text-align: right;' }, [_('ACTION')])
							])
						]),
						E('tbody', { 'id': 'qos-devices-tbody' }, [
							E('tr', {}, [E('td', { 'colspan': '6', 'style': 'text-align: center; padding: 20px; color: #64748b;' }, [_('Loading connected devices...')])])
						])
					])
				]),
				E('div', { 'id': 'qos-devices-pagination', 'style': 'padding-top: 12px;' })
			])
		]);

		setTimeout(function () {
			self.renderRulesTable();
			self.renderDevicesTable(currentDevices);
		}, 100);

		// Realtime device polling every 2 seconds (Updates speeds dynamically without destroying DOM inputs)
		poll.add(function () {
			return callGetDevices().then(function (res) {
				currentDevices = (res && res.devices) ? res.devices : [];
				self.updateLiveSpeeds(currentDevices);
				self.syncOnlineState(currentDevices);
			});
		}, 2);

		return container;
	},

	addRuleToList: function () {
		var targetInp = document.getElementById('qos-target-val');
		var macInp = document.getElementById('qos-mac-val');
		var blockInp = document.getElementById('qos-block-val');
		var downInp = document.getElementById('qos-down-val');
		var downUnitSel = document.getElementById('qos-down-unit');
		var upInp = document.getElementById('qos-up-val');
		var upUnitSel = document.getElementById('qos-up-unit');

		var target = targetInp ? targetInp.value.trim() : '';
		var mac = normalizeMac(macInp ? macInp.value : (deviceMap[target] || ''));
		var isBlock = blockInp ? blockInp.checked : false;
		var downVal = downInp ? (parseInt(downInp.value) || 0) : 0;
		var downUnit = downUnitSel ? downUnitSel.value : 'Mbps';
		var upVal = upInp ? (parseInt(upInp.value) || 0) : 0;
		var upUnit = upUnitSel ? upUnitSel.value : 'Mbps';

		var quotaInp = document.getElementById('qos-quota-val');
		var quotaUnitSel = document.getElementById('qos-quota-unit');
		var cycleSel = document.getElementById('qos-reset-cycle');
		var quotaVal = quotaInp ? (parseFloat(quotaInp.value) || 0) : 0;
		var quotaUnit = quotaUnitSel ? quotaUnitSel.value : 'GB';
		var resetCycle = cycleSel ? cycleSel.value : 'daily';
		var quotaMult = 1073741824;
		if (quotaUnit === 'MB') quotaMult = 1048576;
		else if (quotaUnit === 'TB') quotaMult = 1099511627776;
		var quotaBytes = quotaVal > 0 ? Math.round(quotaVal * quotaMult).toString() : '0';

		if (!target && !mac) {
			ui.addNotification(null, _('Please enter or select a target device / IP range.'), 'error');
			return;
		}

		// Validate target format and speed limits before committing.
		// The target type follows the actual target value: selecting a
		// device from the list fills both IP and MAC, so an IP must be
		// validated as IP (MAC-only rules are validated as MAC).
		var targetType = MAC_RE.test(target || mac) ? 'MAC' : 'IP';
		if (isBlock) {
			downVal = 0;
			upVal = 0;
		} else {
			var validationError = validateQoSRule(targetType, target || mac, downVal, upVal, quotaVal, isBlock);
			if (validationError) {
				ui.addNotification(null, validationError, 'error');
				return;
			}
		}

		// Resolve device name / hostname
		var resolvedHostname = '';
		var devSelect = document.getElementById('qos-device-select');
		if (devSelect && devSelect.selectedIndex > 0) {
			var selOpt = devSelect.options[devSelect.selectedIndex];
			if (selOpt) resolvedHostname = selOpt.getAttribute('data-hostname') || '';
		}

		if (!resolvedHostname || resolvedHostname === 'Unknown') {
			var matchedDev = currentDevices.find(function (d) {
				return isMatchTarget(target, mac, d.ip, d.mac);
			});
			if (matchedDev && matchedDev.hostname && matchedDev.hostname !== 'Unknown') {
				resolvedHostname = matchedDev.hostname;
			}
		}

		if (!resolvedHostname) {
			resolvedHostname = target || mac;
		}

		if (editingRuleId !== null) {
			rulesList.forEach(function (r) {
				if (r.id === editingRuleId) {
					r.target = target;
					r.mac = mac;
					r.hostname = resolvedHostname;
					r.block = isBlock;
					r.max_down = downVal;
					r.down_unit = downUnit;
					r.max_up = upVal;
					r.up_unit = upUnit;
					r.quota_val = quotaVal;
					r.quota_unit = quotaUnit;
					r.quota_bytes = quotaBytes;
					r.reset_cycle = resetCycle;
				}
			}, this);
			this.cancelEdit();
		} else {
			var rule = {
				id: 'rule_' + Date.now(),
				enabled: true,
				target: target,
				mac: mac,
				hostname: resolvedHostname,
				block: isBlock,
				max_down: downVal,
				down_unit: downUnit,
				max_up: upVal,
				up_unit: upUnit,
				quota_val: quotaVal,
				quota_unit: quotaUnit,
				quota_bytes: quotaBytes,
				reset_cycle: resetCycle,
				strict: true,
				ping_opt: true
			};
			rulesList.push(rule);
		}

		// Show the rule in the table immediately; persistence happens in
		// applyQoSConfig() which reports any UCI/RPC failure as an error.
		this.renderRulesTable();

		if (targetInp) targetInp.value = '';
		if (macInp) macInp.value = '';
		if (blockInp) blockInp.checked = false;

		// INSTANTLY APPLY TO UCI & KERNEL FIREWALL
		this.applyQoSConfig();
	},

	toggleRuleBlock: function (ruleId, checked) {
		var rule = rulesList.find(function (r) { return r.id === ruleId; });
		if (rule) {
			rule.block = checked;
			// If rule has 0 speed limits and block is turned OFF, remove the rule completely
			if (!checked && (!rule.max_down || rule.max_down === 0) && (!rule.max_up || rule.max_up === 0)) {
				rulesList = rulesList.filter(function (r) { return r.id !== ruleId; });
			}
			this.applyQoSConfig();
		}
	},

	toggleDeviceBlock: function (ip, mac, checked) {
		var self = this;
		var existingRule = rulesList.find(function (r) {
			return isMatchTarget(r.target, r.mac, ip, mac);
		});

		if (existingRule) {
			existingRule.block = checked;
			// If rule has 0 speed limits and block is turned OFF, remove the rule completely
			if (!checked && (!existingRule.max_down || existingRule.max_down === 0) && (!existingRule.max_up || existingRule.max_up === 0)) {
				rulesList = rulesList.filter(function (r) { return r.id !== existingRule.id; });
			}
		} else if (checked) {
			rulesList.push({
				id: 'rule_' + Date.now(),
				enabled: true,
				target: ip || mac,
				mac: normalizeMac(mac),
				hostname: ip || mac,
				block: true,
				max_down: 0,
				down_unit: 'Mbps',
				max_up: 0,
				up_unit: 'Mbps',
				strict: true,
				ping_opt: true,
				schedule: 'Permanent'
			});
		}

		this.applyQoSConfig();
	},

	toggleRuleEnable: function (ruleId, checked) {
		var rule = rulesList.find(function (r) { return r.id === ruleId; });
		if (rule) {
			rule.enabled = checked;
			this.applyQoSConfig();
		}
	},

	toggleQoSMaster: function (enabled) {
		var self = this;
		var valStr = enabled ? '1' : '0';
		ui.showModal(_('Updating QoS Engine'), [
			E('div', { 'class': 'spinning', 'style': 'margin: 20px auto; text-align: center;' }, [
				_('Applying QoS configuration and updating kernel netfilter rules...')
			])
		]);

		callSetQoSEnabled(valStr).then(function (res) {
			ui.hideModal();
			ui.addNotification(null, enabled ? _('QoS Engine enabled!') : _('QoS Engine disabled! Netfilter QoS table purged.'), 'info');
			window.location.reload();
		}).catch(function (err) {
			ui.hideModal();
			ui.addNotification(null, _('Failed to update QoS engine state: ') + (err.message || err), 'error');
		});
	},

	applyQoSConfig: function () {
		var self = this;

		// 1. Clear existing sections in local UCI buffer
		var existing = uci.sections('skywifi', 'qos_rule');
		if (existing) {
			existing.forEach(function (s) {
				uci.remove('skywifi', s['.name']);
			});
		}

		// 2. Add current active rules to local UCI buffer
		rulesList.forEach(function (r, idx) {
			var sid = 'rule_' + (idx + 1);
			r.id = sid; // Synchronize ID
			uci.add('skywifi', 'qos_rule', sid);
			var isEn = (r.enabled !== false && r.enabled !== '0' && r.enabled !== 0) ? '1' : '0';
			uci.set('skywifi', sid, 'enabled', isEn);
			uci.set('skywifi', sid, 'target_val', r.target || '');
			uci.set('skywifi', sid, 'mac', r.mac || '');
			uci.set('skywifi', sid, 'hostname', r.hostname || r.target);
			uci.set('skywifi', sid, 'block', r.block ? '1' : '0');
			uci.set('skywifi', sid, 'max_down', (r.max_down || 0).toString());
			uci.set('skywifi', sid, 'down_unit', r.down_unit || 'Mbps');
			uci.set('skywifi', sid, 'max_up', (r.max_up || 0).toString());
			uci.set('skywifi', sid, 'up_unit', r.up_unit || 'Mbps');
			if (r.quota_val) uci.set('skywifi', sid, 'quota_val', r.quota_val.toString());
			if (r.quota_unit) uci.set('skywifi', sid, 'quota_unit', r.quota_unit);
			if (r.quota_bytes) uci.set('skywifi', sid, 'quota_bytes', r.quota_bytes.toString());
			if (r.reset_cycle) uci.set('skywifi', sid, 'reset_cycle', r.reset_cycle);
			uci.set('skywifi', sid, 'priority', r.priority || 'normal');
			uci.set('skywifi', sid, 'strict', '1');
			uci.set('skywifi', sid, 'ping_opt', '1');
		});

		// 3. Save, Apply, and Unload/Reload UCI Cache
		return uci.save().then(function () {
			return uci.apply();
		}).then(function () {
			if (ui.changes && typeof ui.changes.init === 'function') {
				ui.changes.init();
			}
			return callApplyQoS();
		}).then(function () {
			uci.unload('skywifi');
			return uci.load('skywifi');
		}).then(function () {
			ui.addNotification(null, _('Rules saved & kernel firewall updated!'), 'info');
			self.renderRulesTable();
			self.renderDevicesTable(currentDevices);
		}).catch(function (e) {
			var msg = (e && e.message) ? e.message : String(e || '');
			if (msg.indexOf('ubus code 5') !== -1 || msg.indexOf('No data received') !== -1) {
				if (ui.changes && typeof ui.changes.init === 'function') {
					ui.changes.init();
				}
				uci.unload('skywifi');
				uci.load('skywifi');
				ui.addNotification(null, _('Rules saved & kernel firewall updated!'), 'info');
				self.renderRulesTable();
				self.renderDevicesTable(currentDevices);
			} else {
				ui.addNotification(null, _('Failed to save/apply rules: ') + msg, 'error');
				self.renderRulesTable();
			}
		});
	},

	editRule: function (id) {
		var self = this;
		var rule = rulesList.find(function (r) { return r.id === id; });
		if (!rule) return;

		editingRuleId = id;

		var targetInp = document.getElementById('qos-target-val');
		var macInp = document.getElementById('qos-mac-val');
		var blockInp = document.getElementById('qos-block-val');
		var downInp = document.getElementById('qos-down-val');
		var downUnitSel = document.getElementById('qos-down-unit');
		var upInp = document.getElementById('qos-up-val');
		var upUnitSel = document.getElementById('qos-up-unit');
		var submitBtn = document.getElementById('qos-submit-btn');
		var cancelBtn = document.getElementById('qos-cancel-btn');
		var titleEl = document.getElementById('qos-form-title');

		if (targetInp) targetInp.value = rule.target;
		if (macInp) macInp.value = normalizeMac(rule.mac);
		if (blockInp) blockInp.checked = !!rule.block;
		if (downInp) downInp.value = rule.max_down;
		if (downUnitSel) downUnitSel.value = rule.down_unit || 'Mbps';
		if (upInp) upInp.value = rule.max_up;
		if (upUnitSel) upUnitSel.value = rule.up_unit || 'Mbps';

		var quotaInp = document.getElementById('qos-quota-val');
		var quotaUnitSel = document.getElementById('qos-quota-unit');
		var cycleSel = document.getElementById('qos-reset-cycle');
		if (quotaInp) quotaInp.value = rule.quota_val ? rule.quota_val : '';
		if (quotaUnitSel) quotaUnitSel.value = rule.quota_unit || 'GB';
		if (cycleSel) cycleSel.value = rule.reset_cycle || 'daily';

		var startTimeInp = document.getElementById('qos-start-time');
		var endTimeInp = document.getElementById('qos-end-time');
		var schedSel = document.getElementById('qos-schedule-sel');
		var timeBox = document.getElementById('qos-time-range-box');

		if (rule.start_time && rule.end_time) {
			if (schedSel) schedSel.value = 'custom';
			if (timeBox) timeBox.style.display = 'grid';
			if (startTimeInp) startTimeInp.value = rule.start_time;
			if (endTimeInp) endTimeInp.value = rule.end_time;
		} else {
			if (schedSel) schedSel.value = 'always';
			if (timeBox) timeBox.style.display = 'none';
			if (startTimeInp) startTimeInp.value = '';
			if (endTimeInp) endTimeInp.value = '';
		}

		if (submitBtn) submitBtn.innerHTML = _('Update Rule');
		if (cancelBtn) cancelBtn.style.display = 'inline-flex';
		if (titleEl) titleEl.innerText = _('Edit QoS Rule');

		var devSelect = document.getElementById('qos-device-select');
		if (devSelect) {
			var matchVal = '';
			var normRuleMac = normalizeMac(rule.mac);
			for (var i = 0; i < devSelect.options.length; i++) {
				var opt = devSelect.options[i];
				var optVal = opt.value;
				var optMac = normalizeMac(opt.getAttribute('data-mac'));
				var optIp = opt.getAttribute('data-ip');
				if ((rule.target && (optVal === rule.target || optIp === rule.target)) ||
					(normRuleMac && (optVal === normRuleMac || optMac === normRuleMac))) {
					matchVal = optVal;
					break;
				}
			}
			devSelect.value = matchVal;
		}

		var card = document.getElementById('qos-form-card');
		if (card) card.scrollIntoView({ behavior: 'smooth' });
	},

	quickLimitDevice: function (ip, mac) {
		var self = this;
		var targetInp = document.getElementById('qos-target-val');
		var macInp = document.getElementById('qos-mac-val');
		var devSelect = document.getElementById('qos-device-select');
		var normMac = normalizeMac(mac);

		if (targetInp) targetInp.value = ip || mac;
		if (macInp) macInp.value = normMac;

		if (devSelect) {
			var matchVal = '';
			for (var i = 0; i < devSelect.options.length; i++) {
				var opt = devSelect.options[i];
				var optVal = opt.value;
				var optMac = normalizeMac(opt.getAttribute('data-mac'));
				var optIp = opt.getAttribute('data-ip');
				if (optVal === ip || optVal === normMac || (ip && optIp === ip) || (normMac && optMac === normMac)) {
					matchVal = optVal;
					break;
				}
			}
			devSelect.value = matchVal;
		}

		var existingRule = rulesList.find(function (r) {
			return isMatchTarget(r.target, r.mac, ip, mac);
		});

		if (existingRule) {
			this.editRule(existingRule.id);
		} else {
			var card = document.getElementById('qos-form-card');
			if (card) card.scrollIntoView({ behavior: 'smooth' });
		}
	},

	cancelEdit: function () {
		editingRuleId = null;

		var targetInp = document.getElementById('qos-target-val');
		var macInp = document.getElementById('qos-mac-val');
		var devSelect = document.getElementById('qos-device-select');
		var blockInp = document.getElementById('qos-block-val');
		var downInp = document.getElementById('qos-down-val');
		var upInp = document.getElementById('qos-up-val');
		var submitBtn = document.getElementById('qos-submit-btn');
		var cancelBtn = document.getElementById('qos-cancel-btn');
		var titleEl = document.getElementById('qos-form-title');

		if (targetInp) targetInp.value = '';
		if (macInp) macInp.value = '';
		if (devSelect) devSelect.value = '';
		if (blockInp) blockInp.checked = false;
		if (downInp) downInp.value = '500';
		if (upInp) upInp.value = '500';

		var quotaInp = document.getElementById('qos-quota-val');
		var quotaUnitSel = document.getElementById('qos-quota-unit');
		var cycleSel = document.getElementById('qos-reset-cycle');
		if (quotaInp) quotaInp.value = '';
		if (quotaUnitSel) quotaUnitSel.value = 'GB';
		if (cycleSel) cycleSel.value = 'daily';

		var startTimeInp = document.getElementById('qos-start-time');
		var endTimeInp = document.getElementById('qos-end-time');
		var schedSel = document.getElementById('qos-schedule-sel');
		var timeBox = document.getElementById('qos-time-range-box');
		if (schedSel) schedSel.value = 'always';
		if (timeBox) timeBox.style.display = 'none';
		if (startTimeInp) startTimeInp.value = '';
		if (endTimeInp) endTimeInp.value = '';

		if (submitBtn) submitBtn.innerHTML = _('Add Bandwidth Rule');
		if (cancelBtn) cancelBtn.style.display = 'none';
		if (titleEl) titleEl.innerText = _('Add / Edit QoS Rule');
	},

	removeRule: function (id) {
		rulesList = rulesList.filter(function (r) { return r.id !== id; });
		if (editingRuleId === id) this.cancelEdit();
		this.applyQoSConfig();
	},

	renderRulesTable: function () {
		var self = this;
		var tbody = document.getElementById('qos-rules-tbody');
		if (!tbody) return;

		var totalItems = rulesList.length;
		var totalPages = Math.max(1, Math.ceil(totalItems / self.pageSize));
		if (self.rulesPage > totalPages) self.rulesPage = totalPages;
		if (self.rulesPage < 1) self.rulesPage = 1;

		var startIndex = (self.rulesPage - 1) * self.pageSize;
		var pageRules = rulesList.slice(startIndex, startIndex + self.pageSize);

		dom.content(tbody, []);

		if (pageRules.length === 0) {
			tbody.appendChild(E('tr', {}, [
				E('td', { 'colspan': '7', 'style': 'text-align: center; padding: 30px; color: #64748b;' }, [_('No active QoS rules configured.')])
			]));
		} else {
			pageRules.forEach(function (r) {
				var dlText = r.block ? 'BLOCKED' : (r.max_down > 0 ? (r.max_down + ' ' + (r.down_unit || 'Mbps')) : 'Unlimited');
				var ulText = r.block ? 'BLOCKED' : (r.max_up > 0 ? (r.max_up + ' ' + (r.up_unit || 'Mbps')) : 'Unlimited');

				var liveRxRate = 0;
				var liveTxRate = 0;
				var matchedDev = currentDevices.find(function (d) {
					return isMatchTarget(r.target, r.mac, d.ip, d.mac);
				});

				if (matchedDev) {
					var key = matchedDev.mac || matchedDev.ip;
					var stats = lastStats[key];
					if (stats) {
						liveRxRate = stats.rxRate || 0;
						liveTxRate = stats.txRate || 0;
					}
				}

				var devUsedBytes = matchedDev ? (parseFloat(matchedDev.total_bytes) || ((parseFloat(matchedDev.rx_bytes) || 0) + (parseFloat(matchedDev.tx_bytes) || 0))) : 0;
				var quotaLimitBytes = parseFloat(r.quota_bytes) || 0;

				var devName = (r.hostname && r.hostname !== 'Unknown' && r.hostname !== r.target && r.hostname !== r.mac) ? r.hostname : (matchedDev && matchedDev.hostname && matchedDev.hostname !== 'Unknown' ? matchedDev.hostname : '');
				var primaryTitle = devName ? devName : (r.target || r.mac || 'Target Device');
				var targetIpStr = r.target || (matchedDev ? matchedDev.ip : '');
				var macStr = r.mac ? normalizeMac(r.mac) : (matchedDev && matchedDev.mac ? normalizeMac(matchedDev.mac) : '');

				var ruleInputAttrs = {
					'type': 'checkbox',
					'change': function (ev) { self.toggleRuleBlock(r.id, ev.target.checked); }
				};
				if (r.block) {
					ruleInputAttrs.checked = 'checked';
				}
				var ruleChkInput = E('input', ruleInputAttrs);
				ruleChkInput.checked = !!r.block;

				var isRuleEn = r.enabled !== false && r.enabled !== '0' && r.enabled !== 0;
				var ruleEnableAttrs = {
					'type': 'checkbox',
					'change': function (ev) { self.toggleRuleEnable(r.id, ev.target.checked); }
				};
				if (isRuleEn) {
					ruleEnableAttrs.checked = 'checked';
				}
				var ruleEnableChkInput = E('input', ruleEnableAttrs);
				ruleEnableChkInput.checked = isRuleEn;

				var connType = matchedDev ? (matchedDev.conn_type || '') : '';
				var isOnline = matchedDev ? matchedDev.online : false;

				// Quota Usage & Progress Telemetry
				var quotaDisplayNode = '';
				if (quotaLimitBytes > 0) {
					var pct = Math.min(100, Math.round((devUsedBytes / quotaLimitBytes) * 100));
					var badgeBg = (pct >= 100 || r.block) ? '#fef2f2' : (pct > 80 ? '#fffbeb' : '#e0e7ff');
					var badgeColor = (pct >= 100 || r.block) ? '#dc2626' : (pct > 80 ? '#d97706' : '#4338ca');
					var pctText = (pct >= 100 || r.block) ? 'EXCEEDED' : (pct + '% Used');

					quotaDisplayNode = E('div', {}, [
						E('div', { 'style': 'font-weight: 800; font-size: 0.85rem; color: #0f172a;' }, [
							formatBytes(devUsedBytes) + ' / ' + formatBytes(quotaLimitBytes)
						]),
						E('span', {
							'style': 'font-size: 10px; font-weight: 800; padding: 2px 6px; border-radius: 6px; background: ' + badgeBg + '; color: ' + badgeColor + '; display: inline-block; margin-top: 2px;'
						}, [pctText])
					]);
				} else {
					quotaDisplayNode = E('span', { 'style': 'font-weight: 700; color: #64748b;' }, [_('Unlimited')]);
				}

				var cycleLabel = r.reset_cycle === 'monthly' ? _('Per Month') : (r.reset_cycle === 'total' ? _('Fixed Total') : _('Per Day'));
				var addrSub = targetIpStr ? ('IP: ' + targetIpStr + (macStr ? ' · MAC: ' + macStr : '')) : (macStr ? ('MAC: ' + macStr) : '');

				var row = E('tr', { 'data-rule-id': r.id, 'style': isRuleEn ? '' : 'opacity: 0.65; background: #f8fafc;' }, [
					// 1. TARGET DEVICE
					E('td', {}, [
						E('div', { 'style': 'display: flex; align-items: center; justify-content: space-between; gap: 6px;' }, [
							E('span', { 'style': 'font-weight: 700; font-size: 0.95rem; color: #0f172a;' }, [primaryTitle]),
							renderMediumBadge(connType, isOnline)
						]),
						addrSub ? E('div', { 'class': 'sub-text', 'style': 'font-size: 10px; color: #64748b; margin-top: 1px;' }, [addrSub]) : ''
					]),
					// 2. REAL-TIME SPEED
					E('td', {}, [
						E('div', { 'class': 'speed-dl live-rx', 'style': 'font-weight: 700; font-size: 11px; color: #10b981;' }, ['↓ ' + formatRate(liveRxRate)]),
						E('div', { 'class': 'speed-ul live-tx', 'style': 'font-weight: 700; font-size: 11px; color: #8b5cf6;' }, ['↑ ' + formatRate(liveTxRate)])
					]),
					// 3. CONFIGURED SPEED LIMITS
					E('td', {}, [
						r.block ? E('span', { 'class': 'badge-blocked-pill' }, ['BLOCKED']) :
							E('div', { 'style': 'font-size: 11px;' }, [
								E('div', { 'style': 'font-weight: 600; color: #334155;' }, ['RX: ' + dlText]),
								E('div', { 'style': 'font-weight: 600; color: #475569;' }, ['TX: ' + ulText])
							])
					]),
					// 4. QUOTA USAGE (USED / LIMIT)
					E('td', {}, [quotaDisplayNode]),
					// 5. INTERNET BLOCK TOGGLE SLIDER
					E('td', {}, [
						E('label', { 'class': 'switch' }, [
							ruleChkInput,
							E('span', { 'class': 'slider' })
						])
					]),
					// 6. RULE ENABLE STATUS SLIDER
					E('td', {}, [
						E('div', { 'style': 'display: flex; align-items: center; gap: 6px;' }, [
							E('label', { 'class': 'switch switch-green' }, [
								ruleEnableChkInput,
								E('span', { 'class': 'slider' })
							]),
							E('span', {
								'style': 'font-weight: 700; font-size: 10px; color: ' + (isRuleEn ? '#10b981' : '#94a3b8') + ';'
							}, [isRuleEn ? _('Active') : _('Paused')])
						])
					]),
					// 7. RESET CYCLE
					E('td', {}, [
						E('span', { 'class': 'badge-schedule', 'style': 'display: inline-block;' }, [cycleLabel])
					]),
					// 8. ACTIONS
					E('td', { 'style': 'text-align: right;' }, [
						E('button', {
							'class': 'btn-light',
							'style': 'padding: 3px 10px; margin-right: 4px; font-size: 10px !important;',
							'click': function () { self.editRule(r.id); }
						}, [_('Edit')]),
						E('button', {
							'class': 'btn-light',
							'style': 'padding: 3px 10px; font-size: 10px !important; background: #fef2f2; color: #dc2626; border-color: #fecaca;',
							'click': function () { self.removeRule(r.id); }
						}, [_('Delete')])
					])
				]);

				tbody.appendChild(row);
			});
		}

		renderPagination('qos-rules-pagination', self.rulesPage, totalPages, totalItems, self.pageSize, function (newPage) {
			self.rulesPage = newPage;
			self.renderRulesTable();
		});
	},

	renderDevicesTable: function (devices) {
		var self = this;
		var tbody = document.getElementById('qos-devices-tbody');
		if (!tbody) return;

		var now = Date.now() / 1000;
		var dt = (lastTime > 0) ? (now - lastTime) : 1;
		if (dt <= 0) dt = 1;
		lastTime = now;

		var allDevices = devices || [];
		var totalItems = allDevices.length;
		var totalPages = Math.max(1, Math.ceil(totalItems / self.pageSize));
		if (self.devicesPage > totalPages) self.devicesPage = totalPages;
		if (self.devicesPage < 1) self.devicesPage = 1;

		var startIndex = (self.devicesPage - 1) * self.pageSize;
		var pageDevices = allDevices.slice(startIndex, startIndex + self.pageSize);

		dom.content(tbody, []);

		if (pageDevices.length === 0) {
			tbody.appendChild(E('tr', {}, [
				E('td', { 'colspan': '6', 'style': 'text-align: center; padding: 30px; color: #64748b;' }, [_('No LAN devices detected.')])
			]));
		} else {
			pageDevices.forEach(function (d) {
				var key = d.mac || d.ip;
				var prev = lastStats[key] || { rx: d.rx_bytes || 0, tx: d.tx_bytes || 0 };
				var currentRx = d.rx_bytes || 0;
				var currentTx = d.tx_bytes || 0;

				var rxRate = (currentRx >= prev.rx) ? ((currentRx - prev.rx) / dt) : 0;
				var txRate = (currentTx >= prev.tx) ? ((currentTx - prev.tx) / dt) : 0;

				lastStats[key] = { rx: currentRx, tx: currentTx, rxRate: rxRate, txRate: txRate };

				// Find matching QoS rule limit / block if configured for this device
				var rule = rulesList.find(function (r) {
					return isMatchTarget(r.target, r.mac, d.ip, d.mac);
				});
				var isBlocked = rule ? !!rule.block : false;
				var isLimited = !!rule;

				var dlLimitStr = isBlocked ? 'Status: BLOCKED' : ((rule && rule.max_down > 0) ? ('Limit: ' + rule.max_down + ' ' + (rule.down_unit || 'Mbps')) : 'Limit: Unlimited');
				var ulLimitStr = isBlocked ? 'Status: BLOCKED' : ((rule && rule.max_up > 0) ? ('Limit: ' + rule.max_up + ' ' + (rule.up_unit || 'Mbps')) : 'Limit: Unlimited');

				// Clean attribute object to prevent HTML boolean attribute pitfall
				var devInputAttrs = {
					'type': 'checkbox',
					'change': function (ev) { self.toggleDeviceBlock(d.ip, d.mac, ev.target.checked); }
				};
				if (isBlocked) {
					devInputAttrs.checked = 'checked';
				}
				var devChkInput = E('input', devInputAttrs);
				devChkInput.checked = !!isBlocked;

				var row = E('tr', { 'data-dev-key': key }, [
					// 1. DEVICE
					E('td', {}, [
						E('div', { 'style': 'display: flex; align-items: center; justify-content: space-between; gap: 8px;' }, [
							E('div', { 'style': 'font-weight: 800; font-size: 1.05rem; display: flex; align-items: center; color: #0f172a;' }, [
								d.hostname || d.ip,
								d.online ? E('span', { 'class': 'badge-online' }, ['Online']) : E('span', { 'class': 'badge-offline' }, ['Offline'])
							]),
							renderMediumBadge(d.conn_type, d.online)
						]),
						E('div', { 'class': 'sub-text' }, [d.ip + ' | ' + (d.mac ? d.mac.toUpperCase() : 'NO MAC')])
					]),
					// 2. DOWNLOAD
					E('td', {}, [
						E('div', { 'class': 'speed-dl live-rx' }, ['↓ ' + formatRate(rxRate)]),
						E('div', { 'class': 'sub-text' }, [dlLimitStr])
					]),
					// 3. UPLOAD
					E('td', {}, [
						E('div', { 'class': 'speed-ul live-tx' }, ['↑ ' + formatRate(txRate)]),
						E('div', { 'class': 'sub-text' }, [ulLimitStr])
					]),
					// 4. TOTAL USAGE
					E('td', {}, [
						E('div', { 'class': 'total-vol', 'style': 'font-weight: 800; color: #0f172a; font-size: 1.05rem;' }, [formatBytes(currentRx + currentTx)]),
						E('div', { 'class': 'sub-text' }, [_('Total Volume')])
					]),
					// 5. INTERNET BLOCK TOGGLE SLIDER (Clean slider only)
					E('td', {}, [
						E('label', { 'class': 'switch' }, [
							devChkInput,
							E('span', { 'class': 'slider' })
						])
					]),
					// 6. QUICK ACTION BUTTON (Limit / Edit Limit as usual)
					E('td', { 'style': 'text-align: right;' }, [
						E('button', {
							'class': isLimited ? 'btn-purple' : 'btn-light',
							'click': function () { self.quickLimitDevice(d.ip, d.mac); }
						}, [isLimited ? _('Edit Limit') : _('Limit')])
					])
				]);

				tbody.appendChild(row);
			});
		}

		renderPagination('qos-devices-pagination', self.devicesPage, totalPages, totalItems, self.pageSize, function (newPage) {
			self.devicesPage = newPage;
			self.renderDevicesTable(allDevices);
		});

		// Record rendered online state so poll-driven badge updates only
		// touch rows where the status actually changed.
		lastOnlineMap = {};
		allDevices.forEach(function (d) {
			lastOnlineMap[d.mac || d.ip] = d.online ? 1 : 0;
		});
		lastDeviceSig = allDevices.map(function (d) { return d.mac || d.ip; }).slice().sort().join(',');
	},

	// Dashboard-style online/offline badge updates for the Live Device
	// Traffic table. Speed text is updated in place; the badge is swapped
	// in place too, and the table is only fully re-rendered when the set of
	// devices actually changes (added/removed), so inputs keep their state.
	syncOnlineState: function (devices) {
		var self = this;
		if (!devices) return;
		var keys = devices.map(function (d) { return d.mac || d.ip; });
		var sig = keys.slice().sort().join(',');
		if (sig !== lastDeviceSig) {
			lastDeviceSig = sig;
			self.renderDevicesTable(devices);
			return;
		}
		devices.forEach(function (d) {
			var key = d.mac || d.ip;
			var on = d.online ? 1 : 0;
			if (lastOnlineMap[key] !== on) {
				lastOnlineMap[key] = on;
				var devRow = document.querySelector('tr[data-dev-key="' + key + '"]');
				if (devRow) {
					var oldBadge = devRow.querySelector('.badge-online, .badge-offline');
					if (oldBadge) {
						var newBadge = d.online ?
							E('span', { 'class': 'badge-online' }, [_('Online')]) :
							E('span', { 'class': 'badge-offline' }, [_('Offline')]);
						oldBadge.replaceWith(newBadge);
					}
				}
			}
		});
	},

	updateLiveSpeeds: function (devices) {
		if (!devices) return;
		var now = Date.now() / 1000;
		var dt = (lastTime > 0) ? (now - lastTime) : 1;
		if (dt <= 0) dt = 1;
		lastTime = now;

		var self = this;
		devices.forEach(function (d) {
			var key = d.mac || d.ip;
			var prev = lastStats[key] || { rx: d.rx_bytes || 0, tx: d.tx_bytes || 0 };
			var currentRx = d.rx_bytes || 0;
			var currentTx = d.tx_bytes || 0;

			var rxRate = (currentRx >= prev.rx) ? ((currentRx - prev.rx) / dt) : 0;
			var txRate = (currentTx >= prev.tx) ? ((currentTx - prev.tx) / dt) : 0;

			lastStats[key] = { rx: currentRx, tx: currentTx, rxRate: rxRate, txRate: txRate };

			// Update speed text nodes in Devices table without re-creating DOM elements
			var devRow = document.querySelector('tr[data-dev-key="' + key + '"]');
			if (devRow) {
				var rxEl = devRow.querySelector('.live-rx');
				var txEl = devRow.querySelector('.live-tx');
				var volEl = devRow.querySelector('.total-vol');
				if (rxEl) rxEl.innerText = '↓ ' + formatRate(rxRate);
				if (txEl) txEl.innerText = '↑ ' + formatRate(txRate);
				if (volEl) volEl.innerText = formatBytes(currentRx + currentTx);
			}

			// Update speed text nodes in Rules table
			rulesList.forEach(function (r) {
				if (isMatchTarget(r.target, r.mac, d.ip, d.mac)) {
					var ruleRow = document.querySelector('tr[data-rule-id="' + r.id + '"]');
					if (ruleRow) {
						var rRxEl = ruleRow.querySelector('.live-rx');
						var rTxEl = ruleRow.querySelector('.live-tx');
						if (rRxEl) rRxEl.innerText = '↓ ' + formatRate(rxRate);
						if (rTxEl) rTxEl.innerText = '↑ ' + formatRate(txRate);
					}
				}
			});
		});
	}
});
