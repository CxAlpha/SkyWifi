'use strict';
'require view';
'require rpc';
'require poll';
'require ui';
'require dom';
'require uci';

var callGetStats = rpc.declare({
	object: 'luci.skywifi',
	method: 'get_stats',
	expect: {}
});

var callToggleBlock = rpc.declare({
	object: 'luci.skywifi',
	method: 'toggle_block',
	params: ['target', 'block', 'password'],
	expect: {}
});

var dashboardAdminCheck = rpc.declare({
	object:'luci.skywifi', method:'skywifi_admin_check', params:['password'], expect:{}
});

function dashboardAskAdmin(cb) {
	var pw=E('input',{type:'password',class:'cbi-input-text',placeholder:_('Admin password'),style:'width:100%;height:38px;'});
	ui.showModal(_('Sky Wifi Admin Access'),[E('p',{},[_('Enter the Admin password to change device access.')]),pw,E('div',{class:'right',style:'margin-top:12px'},[E('button',{class:'btn cbi-button cbi-button-neutral',click:ui.hideModal},[_('Cancel')]),E('button',{class:'btn cbi-button cbi-button-positive',click:function(){dashboardAdminCheck(pw.value).then(function(r){if(r&&r.valid){ui.hideModal();cb(pw.value);}else ui.addNotification(null,E('p',{},[_('Invalid Admin password.')]),'error');});}},[_('Continue')])])]);
}

var callSetDeviceName = rpc.declare({
	object: 'luci.skywifi',
	method: 'set_device_name',
	params: ['target_mac', 'name'],
	expect: {}
});

function showRenameModal(dev) {
	var targetMac = dev.mac || '';
	var currentName = (dev.hostname && dev.hostname !== 'Unknown') ? dev.hostname : '';

	var inputName = E('input', {
		'type': 'text',
		'class': 'cbi-input-text',
		'value': currentName,
		'placeholder': _('e.g. Living Room TV or Jahid\'s Phone'),
		'style': 'width: 100%; height: 36px; border-radius: 8px; border: 1.5px solid #cbd5e1; padding: 0 10px; font-weight: 700; font-size: 13px; margin-top: 10px;'
	});

	ui.showModal(_('Rename Device: %s').format(targetMac), [
		E('div', { 'style': 'padding: 10px 0;' }, [
			E('p', { 'style': 'font-size: 12px; color: #475569;' }, [
				_('Set a custom display name for this device. The name will be saved permanently and displayed across Dashboard, QoS, History, and Telegram Bot alerts.')
			]),
			inputName
		]),
		E('div', { 'class': 'right', 'style': 'display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px;' }, [
			E('button', {
				'class': 'btn cbi-button cbi-button-neutral',
				'click': ui.hideModal
			}, [_('Cancel')]),
			E('button', {
				'class': 'btn cbi-button cbi-button-remove',
				'click': function() {
					callSetDeviceName(targetMac, '').then(function() {
						ui.addNotification(null, E('p', {}, [_('Reset to default hostname.')]));
						ui.hideModal();
					});
				}
			}, [_('Reset Default')]),
			E('button', {
				'class': 'btn cbi-button cbi-button-positive',
				'click': function() {
					var newName = inputName.value.trim();
					callSetDeviceName(targetMac, newName).then(function() {
						ui.addNotification(null, E('p', {}, [_('Custom device name saved!')]));
						ui.hideModal();
					});
				}
			}, [_('Save Name')])
		])
	]);
}


var callSetQuota = rpc.declare({
	object: 'luci.skywifi',
	method: 'set_quota',
	params: ['target_mac', 'target_ip', 'quota_bytes', 'quota_val', 'quota_unit', 'reset_cycle'],
	expect: {}
});

function showQuotaModal(dev) {
	var targetMac = dev.mac || '';
	var targetIp = dev.ip || '';

	var inputVal = E('input', {
		'type': 'number',
		'class': 'cbi-input-text',
		'value': '5',
		'placeholder': '5',
		'style': 'flex: 1; height: 36px; border-radius: 8px; border: 1.5px solid #cbd5e1; padding: 0 10px; font-weight: 700;'
	});

	var selectUnit = E('select', {
		'class': 'cbi-input-select',
		'style': 'width: 90px; height: 36px; border-radius: 8px; border: 1.5px solid #cbd5e1; font-weight: 800; background: #f8fafc;'
	}, [
		E('option', { 'value': 'MB' }, ['MB']),
		E('option', { 'value': 'GB', 'selected': 'selected' }, ['GB']),
		E('option', { 'value': 'TB' }, ['TB'])
	]);

	var selectCycle = E('select', {
		'class': 'cbi-input-select',
		'style': 'width: 100%; height: 36px; border-radius: 8px; border: 1.5px solid #cbd5e1; font-weight: 700; background: #ffffff;'
	}, [
		E('option', { 'value': 'daily', 'selected': 'selected' }, [_('Per Day (Daily Reset)')]),
		E('option', { 'value': 'monthly' }, [_('Per Month (Monthly Reset)')]),
		E('option', { 'value': 'total' }, [_('Total / Fixed Limit')])
	]);

	ui.showModal(_('Set Data Quota: %s').format(dev.hostname || targetMac), [
		E('div', { 'style': 'padding: 10px 0;' }, [
			E('p', { 'style': 'font-size: 12px; color: #475569; margin-bottom: 12px;' }, [
				_('Enter numeric data limit, select unit (MB/GB/TB) and reset frequency. Once exceeded, device access will be automatically blocked.')
			]),
			E('label', { 'style': 'font-size: 11px; font-weight: 800; color: #4338ca; display: block; margin-bottom: 4px;' }, [_('Data Limit & Unit')]),
			E('div', { 'style': 'display: flex; gap: 8px; align-items: center; margin-bottom: 12px;' }, [
				inputVal,
				selectUnit
			]),
			E('label', { 'style': 'font-size: 11px; font-weight: 800; color: #4338ca; display: block; margin-bottom: 4px;' }, [_('Reset Cycle')]),
			E('div', {}, [selectCycle])
		]),
		E('div', { 'class': 'right', 'style': 'display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px;' }, [
			E('button', {
				'class': 'btn cbi-button cbi-button-neutral',
				'click': ui.hideModal
			}, [_('Cancel')]),
			E('button', {
				'class': 'btn cbi-button cbi-button-remove',
				'click': function() {
					callSetQuota(targetMac, targetIp, '0', '0', 'GB', 'daily').then(function() {
						ui.addNotification(null, E('p', {}, [_('Quota limit removed.')]));
						ui.hideModal();
					});
				}
			}, [_('Clear Quota')]),
			E('button', {
				'class': 'btn cbi-button cbi-button-positive',
				'click': function() {
					var num = parseFloat(inputVal.value);
					if (isNaN(num) || num <= 0) return;
					var unit = selectUnit.value;
					var cycle = selectCycle.value;
					var mult = 1073741824;
					if (unit === 'KB') mult = 1024;
					else if (unit === 'MB') mult = 1048576;
					else if (unit === 'GB') mult = 1073741824;
					else if (unit === 'TB') mult = 1099511627776;

					var totalBytes = Math.round(num * mult).toString();
					callSetQuota(targetMac, targetIp, totalBytes, num.toString(), unit, cycle).then(function() {
						ui.addNotification(null, E('p', {}, [_('Data quota set to %s %s (%s) successfully.').format(num, unit, cycle)]));
						ui.hideModal();
					});
				}
			}, [_('Save Quota')])
		])
	]);
}

var prevStats = {};
var filterQuery = '';
var filterStatus = 'all';

var graphHistory = [];
var MAX_GRAPH_POINTS = 30;

// System tile visibility (Settings -> Dashboard Display)
var showTempTile = true;
var showSwapTile = true;

function formatBytes(bytes) {
	if (!bytes || bytes === 0) return '0.00 B';
	var k = 1024;
	var sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
	var i = Math.floor(Math.log(bytes) / Math.log(k));
	return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// /proc/meminfo + df report kB; convert for display
function formatKB(kb) {
	return formatBytes((parseInt(kb) || 0) * 1024);
}

function formatSpeed(bytesPerSec) {
	if (bytesPerSec <= 0 || isNaN(bytesPerSec)) return '0.00 KB/s';
	var bitsPerSec = bytesPerSec * 8;
	if (bitsPerSec >= 1000000) {
		return (bitsPerSec / 1000000).toFixed(2) + ' Mbps';
	}
	return (bytesPerSec / 1024).toFixed(1) + ' KB/s';
}

function pad2(n) {
	return (n < 10 ? '0' : '') + n;
}

// Router uptime from /proc/uptime (seconds) rendered as "Xd Yh Zm Xs"
function formatUptime(secs) {
	secs = parseInt(secs) || 0;
	var d = Math.floor(secs / 86400);
	var h = Math.floor((secs % 86400) / 3600);
	var m = Math.floor((secs % 3600) / 60);
	var s = secs % 60;
	if (d > 0) return d + 'd ' + h + 'h ' + m + 'm ' + s + 's';
	if (h > 0) return h + 'h ' + m + 'm ' + s + 's';
	return m + 'm ' + s + 's';
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
	currentPage: 1,
	pageSize: 10,

	load: function () {
		return Promise.all([
			callGetStats().catch(function() { return {}; }),
			uci.load('skywifi').catch(function() { return {}; })
		]);
	},

	render: function (data) {
		var self = this;

		// Module-level state survives LuCI page switches; reset it so
		// each visit starts with a clean graph and fresh deltas.
		graphHistory = [];
		prevStats = {};

		showTempTile = uci.get('skywifi', 'global', 'show_temp') !== '0';
		showSwapTile = uci.get('skywifi', 'global', 'show_swap') !== '0';

		var container = E('div', { 'class': 'cbi-map', 'id': 'netmon-dashboard' }, [
			E('style', {}, [
				'@keyframes netmon-pulse { 0% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7); } 70% { box-shadow: 0 0 0 8px rgba(16, 185, 129, 0); } 100% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); } }',

				'#netmon-dashboard { font-family: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; font-size: 12px; font-weight: 400; color: #334155; }',

				'.netmon-header-title { font-size: 18px !important; font-weight: 800 !important; color: #0f172a; margin: 0; line-height: 1.2; letter-spacing: -0.02em; }',
				'.netmon-header-sub { font-size: 12px !important; font-weight: 500 !important; color: #64748b; margin-top: 3px; }',

				'.netmon-kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; margin-bottom: 20px; }',
				'.netmon-kpi-card { background: #ffffff; border-radius: 12px; padding: 16px 18px; border: 1px solid #e2e8f0; box-shadow: 0 4px 12px rgba(0,0,0,0.03); transition: transform 0.2s ease, box-shadow 0.2s ease; }',
				'.netmon-kpi-card:hover { transform: translateY(-2px); box-shadow: 0 6px 18px rgba(0,0,0,0.05); }',

				'.netmon-kpi-title { font-size: 11px !important; font-weight: 800 !important; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 6px; }',
				'.netmon-kpi-val { font-size: 1.65rem !important; font-weight: 800 !important; line-height: 1.1; letter-spacing: -0.03em; }',

				'.netmon-card-active { border-left: 4px solid #10b981; }',
				'.netmon-card-active .netmon-kpi-title { color: #059669; }',
				'.netmon-card-active .netmon-kpi-val { color: #10b981; }',

				'.netmon-card-down { border-left: 4px solid #3b82f6; }',
				'.netmon-card-down .netmon-kpi-title { color: #2563eb; }',
				'.netmon-card-down .netmon-kpi-val { color: #3b82f6; }',

				'.netmon-card-up { border-left: 4px solid #8b5cf6; }',
				'.netmon-card-up .netmon-kpi-title { color: #7c3aed; }',
				'.netmon-card-up .netmon-kpi-val { color: #8b5cf6; }',

				'.netmon-card-bytes { border-left: 4px solid #f59e0b; }',
				'.netmon-card-bytes .netmon-kpi-title { color: #d97706; }',
				'.netmon-card-bytes .netmon-kpi-val { color: #f59e0b; }',

				'.netmon-badge-live { background: #ecfdf5; color: #047857; border: 1.5px solid #a7f3d0; padding: 4px 12px; border-radius: 16px; font-size: 11px; font-weight: 700; display: inline-flex; align-items: center; gap: 6px; }',
				'.netmon-badge-live::before { content: ""; width: 7px; height: 7px; background: #10b981; border-radius: 50%; animation: netmon-pulse 1.8s infinite; }',

				'.netmon-badge-online { background: #dcfce7; color: #15803d; border: 1px solid #bbf7d0; padding: 3px 10px; border-radius: 12px; font-size: 11px; font-weight: 700; display: inline-flex; align-items: center; gap: 5px; }',
				'.netmon-badge-online::before { content: ""; width: 6px; height: 6px; background: #22c55e; border-radius: 50%; }',
				'.netmon-badge-offline { background: #f1f5f9; color: #64748b; border: 1px solid #cbd5e1; padding: 3px 10px; border-radius: 12px; font-size: 11px; font-weight: 700; }',

				'.netmon-section-card { background: #ffffff; border-radius: 12px; padding: 18px; border: 1px solid #e2e8f0; box-shadow: 0 4px 12px rgba(0,0,0,0.02); margin-bottom: 20px; }',

				'.netmon-sys-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; }',
				'.netmon-sys-tile { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 14px 16px; }',
				'.netmon-sys-title { font-size: 10px !important; font-weight: 800 !important; text-transform: uppercase; letter-spacing: 0.06em; color: #64748b; margin-bottom: 6px; }',
				'.netmon-sys-val { font-size: 20px !important; font-weight: 800 !important; color: #0f172a; line-height: 1.15; letter-spacing: -0.02em; }',
				'.netmon-sys-sub { font-size: 10px !important; font-weight: 600 !important; color: #94a3b8; margin-top: 4px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace !important; }',
				'.netmon-sys-bar { height: 5px; background: #e2e8f0; border-radius: 4px; margin-top: 10px; overflow: hidden; }',
				'.netmon-sys-bar > div { height: 100%; border-radius: 4px; transition: width 0.5s ease, background 0.5s ease; }',

				'.svg-graph-container { width: 100%; height: 170px; position: relative; background: linear-gradient(180deg, #f8fafc 0%, #ffffff 100%); border-radius: 10px; border: 1px solid #e2e8f0; overflow: hidden; padding: 10px 0; }',

				'.netmon-table-toolbar { display: flex; flex-direction: row; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 18px; border-bottom: 1px solid #e2e8f0; background: #ffffff; }',
				'.netmon-search-input { width: 260px; padding: 7px 12px; border-radius: 8px; border: 1.5px solid #cbd5e1; background: #ffffff; color: #0f172a; font-size: 12px; font-weight: 400; outline: none; transition: border-color 0.2s ease; }',
				'.netmon-search-input:focus { border-color: #3b82f6; }',
				'.netmon-select { width: 180px; padding: 7px 12px; border-radius: 8px; border: 1.5px solid #cbd5e1; background: #ffffff; color: #0f172a; font-size: 12px; font-weight: 700; outline: none; transition: border-color 0.2s ease; }',
				'.netmon-select:focus { border-color: #3b82f6; }',

				'.table-responsive { width: 100% !important; max-width: 100% !important; overflow-x: auto !important; -webkit-overflow-scrolling: touch !important; display: block !important; touch-action: pan-x pan-y !important; }',
				'.netmon-table { width: max-content !important; min-width: 100% !important; border-collapse: separate; border-spacing: 0; table-layout: auto !important; }',
				'.netmon-table th { font-size: 11px !important; font-weight: 800 !important; color: #475569; padding: 12px 16px; text-align: left; background: #f8fafc; border-bottom: 1.5px solid #e2e8f0; text-transform: uppercase; letter-spacing: 0.04em; white-space: nowrap !important; }',
				'.netmon-table td { padding: 12px 16px; border-bottom: 1px solid #e2e8f0; font-size: 12px !important; font-weight: 400 !important; color: #0f172a; vertical-align: middle; background: #ffffff; white-space: nowrap !important; }',
				'.netmon-table tr:hover td { background: #f8fafc; }',

				'.dev-name-title { font-size: 13px !important; font-weight: 700 !important; color: #0f172a; line-height: 1.2; }',
				'.dev-ip-sub { font-size: 11px !important; font-weight: 500 !important; color: #64748b; margin-top: 2px; }',
				'.dev-mac-code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace !important; font-size: 11px !important; font-weight: 600 !important; color: #475569; background: #f1f5f9; padding: 3px 7px; border-radius: 6px; border: 1px solid #e2e8f0; }',

				'@media (max-width: 768px) {',
					'.netmon-kpi-grid { grid-template-columns: 1fr 1fr !important; }',
					'.netmon-search-input { width: 100% !important; }',
					'.netmon-select { width: 100% !important; }',
					'.netmon-table-toolbar { flex-direction: column !important; align-items: stretch !important; }',
				'}'
			]),

			// Executive Header Title
			E('div', { 'style': 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; flex-wrap: wrap; gap: 12px;' }, [
				E('div', {}, [
					E('h2', { 'class': 'netmon-header-title' }, [_('Dashboard')])
				]),
				E('div', { 'style': 'display: flex; align-items: center; gap: 10px;' }, [
					E('span', { 'id': 'netmon-last-update', 'style': 'font-size: 11px; font-weight: 700; color: #64748b;' }, [''])
				])
			]),

			// Top Executive Metric KPI Cards Grid
			E('div', { 'class': 'netmon-kpi-grid' }, [
				E('div', { 'class': 'netmon-kpi-card netmon-card-active' }, [
					E('div', { 'class': 'netmon-kpi-title' }, [_('ACTIVE DEVICES')]),
					E('div', { 'id': 'summary-active-count', 'class': 'netmon-kpi-val' }, ['0 / 0'])
				]),
				E('div', { 'class': 'netmon-kpi-card netmon-card-down' }, [
					E('div', { 'class': 'netmon-kpi-title' }, [_('TOTAL DOWNLOAD SPEED')]),
					E('div', { 'id': 'summary-total-down', 'class': 'netmon-kpi-val' }, ['0.00 KB/s'])
				]),
				E('div', { 'class': 'netmon-kpi-card netmon-card-up' }, [
					E('div', { 'class': 'netmon-kpi-title' }, [_('TOTAL UPLOAD SPEED')]),
					E('div', { 'id': 'summary-total-up', 'class': 'netmon-kpi-val' }, ['0.00 KB/s'])
				]),
				E('div', { 'class': 'netmon-kpi-card netmon-card-bytes' }, [
					E('div', { 'class': 'netmon-kpi-title' }, [_('TOTAL SESSION TRAFFIC')]),
					E('div', { 'id': 'summary-total-bytes', 'class': 'netmon-kpi-val' }, ['0.00 B'])
				])
			]),

			// System Resources Card
			E('div', { 'class': 'netmon-section-card' }, [
				E('div', { 'style': 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;' }, [
					E('h3', { 'class': 'netmon-header-title', 'style': 'font-size: 15px !important;' }, [_('System Resources')])
				]),
				E('div', { 'class': 'netmon-sys-grid' }, [
					E('div', { 'class': 'netmon-sys-tile' }, [
						E('div', { 'class': 'netmon-sys-title' }, [_('CPU LOAD')]),
						E('div', { 'id': 'sys-load', 'class': 'netmon-sys-val' }, ['0%']),
						E('div', { 'id': 'sys-load-sub', 'class': 'netmon-sys-sub' }, ['load avg --'])
					]),
					E('div', { 'class': 'netmon-sys-tile' }, [
						E('div', { 'class': 'netmon-sys-title' }, [_('RAM USAGE')]),
						E('div', { 'id': 'sys-ram', 'class': 'netmon-sys-val' }, ['0%']),
						E('div', { 'id': 'sys-ram-sub', 'class': 'netmon-sys-sub' }, ['0 B / 0 B']),
						E('div', { 'class': 'netmon-sys-bar' }, [E('div', { 'id': 'sys-ram-fill', 'style': 'width:0%;' })])
					]),
					E('div', { 'id': 'sys-tile-swap', 'class': 'netmon-sys-tile' }, [
						E('div', { 'class': 'netmon-sys-title' }, [_('SWAP')]),
						E('div', { 'id': 'sys-swap', 'class': 'netmon-sys-val' }, ['0 B']),
						E('div', { 'id': 'sys-swap-sub', 'class': 'netmon-sys-sub' }, ['0 B / 0 B']),
						E('div', { 'class': 'netmon-sys-bar' }, [E('div', { 'id': 'sys-swap-fill', 'style': 'width:0%;' })])
					]),
					E('div', { 'class': 'netmon-sys-tile' }, [
						E('div', { 'class': 'netmon-sys-title' }, [_('CACHE')]),
						E('div', { 'id': 'sys-cache', 'class': 'netmon-sys-val' }, ['0 B']),
						E('div', { 'id': 'sys-cache-sub', 'class': 'netmon-sys-sub' }, [_('buffers + cache')])
					]),
					E('div', { 'class': 'netmon-sys-tile' }, [
						E('div', { 'class': 'netmon-sys-title' }, [_('STORAGE')]),
						E('div', { 'id': 'sys-storage', 'class': 'netmon-sys-val' }, ['0%']),
						E('div', { 'id': 'sys-storage-sub', 'class': 'netmon-sys-sub' }, ['0 B of 0 B']),
						E('div', { 'class': 'netmon-sys-bar' }, [E('div', { 'id': 'sys-storage-fill', 'style': 'width:0%;' })])
					]),
					E('div', { 'id': 'sys-tile-temp', 'class': 'netmon-sys-tile' }, [
						E('div', { 'class': 'netmon-sys-title' }, [_('TEMPERATURE')]),
						E('div', { 'id': 'sys-temp', 'class': 'netmon-sys-val' }, ['N/A']),
						E('div', { 'class': 'netmon-sys-sub' }, [_('SoC thermal zone')])
					]),
					E('div', { 'id': 'sys-tile-conns', 'class': 'netmon-sys-tile' }, [
						E('div', { 'class': 'netmon-sys-title' }, [_('CONNECTIONS')]),
						E('div', { 'id': 'sys-conns', 'class': 'netmon-sys-val' }, ['0']),
						E('div', { 'class': 'netmon-sys-sub' }, [_('active flows')])
					])
				])
			]),

			// Live SVG Bandwidth Graph Card
			E('div', { 'class': 'netmon-section-card' }, [
				E('div', { 'style': 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;' }, [
					E('h3', { 'class': 'netmon-header-title', 'style': 'font-size: 15px !important;' }, [_('Real-Time Bandwidth History')]),
					E('div', { 'style': 'display: flex; gap: 16px; font-size: 11px; font-weight: 700;' }, [
						E('span', { 'style': 'color: #3b82f6; display: flex; align-items: center; gap: 5px;' }, [
							E('span', { 'style': 'width: 10px; height: 3px; background: #3b82f6; border-radius: 2px; display: inline-block;' }),
							_('Download (RX)')
						]),
						E('span', { 'style': 'color: #8b5cf6; display: flex; align-items: center; gap: 5px;' }, [
							E('span', { 'style': 'width: 10px; height: 3px; background: #8b5cf6; border-radius: 2px; display: inline-block;' }),
							_('Upload (TX)')
						])
					])
				]),
				E('div', { 'id': 'netmon-svg-graph-container', 'class': 'svg-graph-container' }, [
					_('Initializing real-time telemetry graph...')
				])
			]),

			// Device Telemetry Table Card
			E('div', { 'class': 'netmon-section-card', 'style': 'padding: 0; overflow: hidden;' }, [
				E('div', { 'class': 'netmon-table-toolbar' }, [
					E('div', { 'style': 'display: flex; align-items: center; gap: 12px; flex-wrap: wrap;' }, [
						E('input', {
							'type': 'text',
							'class': 'netmon-search-input',
							'placeholder': _('Search by Name, IP, or MAC...'),
							'input': function (ev) {
								filterQuery = ev.target.value.toLowerCase();
								self.currentPage = 1;
								self.renderTableOnly();
							}
						}),
						E('select', {
							'class': 'netmon-select',
							'change': function (ev) {
								filterStatus = ev.target.value;
								self.currentPage = 1;
								self.renderTableOnly();
							}
						}, [
							E('option', { 'value': 'all' }, [_('All Discovered Devices')]),
							E('option', { 'value': 'online' }, [_('Online Devices Only')]),
							E('option', { 'value': 'offline' }, [_('Offline Devices Only')])
						])
					]),
					E('div', { 'id': 'table-device-counter', 'style': 'font-size: 12px; font-weight: 700; color: #64748b;' }, [_('0 Discovered Devices')])
				]),
				E('div', { 'class': 'table-responsive' }, [
					E('table', { 'class': 'netmon-table' }, [
						E('thead', {}, [
							E('tr', {}, [
								E('th', {}, [_('STATUS')]),
								E('th', {}, [_('DEVICE NAME & IP')]),
								E('th', {}, [_('MAC ADDRESS')]),
								E('th', {}, [_('DOWNLOAD SPEED')]),
								E('th', {}, [_('UPLOAD SPEED')]),
								E('th', {}, [_('TOTAL SESSION TRAFFIC')]),
								E('th', {}, [_('QUICK ACTIONS')])
							])
						]),
						E('tbody', { 'id': 'netmon-table-tbody' }, [
							E('tr', {}, [E('td', { 'colspan': '7', 'style': 'text-align: center; padding: 30px; color: #64748b;' }, [_('Loading device telemetry...')])])
						])
					])
				]),
				E('div', { 'id': 'netmon-table-pagination', 'style': 'padding: 12px 16px; background: #ffffff; border-top: 1px solid #e2e8f0;' })
			])
		]);

		// Populate dashboard immediately on initial page load
		if (data) {
			self.updateDashboard(data);
		}

		poll.add(function () {
			return callGetStats().then(function (res) {
				self.updateDashboard(res);
			});
		}, 1);

		return container;
	},

	updateDashboard: function (res) {
		var lastUpd = document.getElementById('netmon-last-update');
		if (lastUpd) {
			lastUpd.innerText = _('Uptime: ') + formatUptime((res && res.uptime) ? res.uptime : 0);
		}

		// System resource tiles (CPU load, RAM, swap, cache, storage, temp, connections)
		var sys = (res && res.system && typeof res.system === 'object') ? res.system : null;
		var setTile = function (id, txt) { var el = document.getElementById(id); if (el) el.innerText = txt; };
		var setFill = function (id, pct) {
			var el = document.getElementById(id);
			if (!el) return;
			el.style.width = (pct > 100 ? 100 : pct) + '%';
			el.style.background = pct >= 80 ? '#ef4444' : (pct >= 50 ? '#f59e0b' : '#10b981');
		};
		if (sys) {
			var cpuPct = parseInt(sys.cpu_pct);
			setTile('sys-load', (isNaN(cpuPct) ? 0 : cpuPct) + '%');
			setTile('sys-load-sub', _('load ') + (sys.load || '0.00'));

			var mTotal = parseInt(sys.mem_total) || 0;
			var mAvail = parseInt(sys.mem_avail) || 0;
			var mUsed = Math.max(0, mTotal - mAvail);
			var mPct = mTotal > 0 ? Math.round((mUsed / mTotal) * 100) : 0;
			setTile('sys-ram', mPct + '%');
			setTile('sys-ram-sub', formatKB(mUsed) + ' / ' + formatKB(mTotal));
			setFill('sys-ram-fill', mPct);

			var sTotal = parseInt(sys.swap_total) || 0;
			var sFree = parseInt(sys.swap_free) || 0;
			var sUsed = Math.max(0, sTotal - sFree);
			var sPct = sTotal > 0 ? Math.round((sUsed / sTotal) * 100) : 0;
			setTile('sys-swap', sTotal > 0 ? (sPct + '%') : '0 B');
			setTile('sys-swap-sub', sTotal > 0 ? (formatKB(sUsed) + ' / ' + formatKB(sTotal)) : _('no swap'));
			setFill('sys-swap-fill', sPct);

			setTile('sys-cache', formatKB((parseInt(sys.mem_buf) || 0) + (parseInt(sys.mem_cached) || 0)));
			setTile('sys-cache-sub', formatKB(parseInt(sys.mem_buf) || 0) + ' + ' + formatKB(parseInt(sys.mem_cached) || 0));

			var dTotal = parseInt(sys.disk_total) || 0;
			var dUsed = parseInt(sys.disk_used) || 0;
			var dPct = dTotal > 0 ? Math.round((dUsed / dTotal) * 100) : 0;
			setTile('sys-storage', dPct + '%');
			setTile('sys-storage-sub', formatKB(dUsed) + ' of ' + formatKB(dTotal));
			setFill('sys-storage-fill', dPct);

			var tempEl = document.getElementById('sys-temp');
			if (tempEl) {
				var t = parseFloat(sys.temp);
				if (isNaN(t)) {
					tempEl.innerText = 'N/A';
				} else {
					tempEl.innerText = t.toFixed(1) + '\u00B0C';
					tempEl.style.color = t >= 60 ? '#ef4444' : (t >= 50 ? '#f59e0b' : '#0f172a');
				}
			}

			setTile('sys-conns', (parseInt(sys.conns) || 0).toString());
		}

		// Tile visibility from Settings: swap is a pure preference; temp is
		// also hidden when the router exposes no thermal sensor at all.
		var tempTile = document.getElementById('sys-tile-temp');
		if (tempTile) {
			var tempVal = (sys && sys.temp) ? parseFloat(sys.temp) : NaN;
			tempTile.style.display = (showTempTile && !isNaN(tempVal)) ? '' : 'none';
		}
		var swapTile = document.getElementById('sys-tile-swap');
		if (swapTile) {
			swapTile.style.display = showSwapTile ? '' : 'none';
		}

		var rawDevices = (res && Array.isArray(res.devices) && res.devices.length > 0) ? res.devices : (this.cachedDevices || []);
		var deviceMap = {};
		var devices = [];
		rawDevices.forEach(function (d) {
			if (!d) return;
			var normMac = (d.mac || '').toLowerCase().replace(/[^0-9a-f]/g, '');
			var key = normMac.length === 12 ? normMac : (d.ip || '');
			if (!key) return;
			if (!deviceMap[key]) {
				deviceMap[key] = d;
				devices.push(d);
			} else {
				var existing = deviceMap[key];
				if ((d.online || d.online === 1 || d.online === '1') && !existing.online) {
					existing.online = 1;
					if (d.conn_type) existing.conn_type = d.conn_type;
				}
				if (d.ip && d.ip !== '0.0.0.0' && (existing.ip === '0.0.0.0' || !existing.ip)) existing.ip = d.ip;
				if (d.hostname && d.hostname !== 'Unknown' && (existing.hostname === 'Unknown' || !existing.hostname)) existing.hostname = d.hostname;
				existing.rx_bytes = Math.max(existing.rx_bytes || 0, d.rx_bytes || 0);
				existing.tx_bytes = Math.max(existing.tx_bytes || 0, d.tx_bytes || 0);
				existing.total_bytes = Math.max(existing.total_bytes || 0, d.total_bytes || 0);
				existing.rx_speed = Math.max(existing.rx_speed || 0, d.rx_speed || 0);
				existing.tx_speed = Math.max(existing.tx_speed || 0, d.tx_speed || 0);
			}
		});

		var activeCount = 0;
		var totalDiscovered = devices.length;
		var totalDownSpeed = 0;
		var totalUpSpeed = 0;
		var totalBytesAll = 0;

		devices.forEach(function (dev) {
			var rxBytes = parseFloat(dev.rx_bytes) || 0;
			var txBytes = parseFloat(dev.tx_bytes) || 0;
			var totBytes = parseFloat(dev.total_bytes) || (rxBytes + txBytes);

			var rxSpd = parseInt(dev.rx_speed);
			var txSpd = parseInt(dev.tx_speed);
			if (isNaN(rxSpd)) rxSpd = 0;
			if (isNaN(txSpd)) txSpd = 0;
			dev.rx_speed = rxSpd;
			dev.tx_speed = txSpd;

			if (dev.online || dev.online === 1 || dev.online === '1') activeCount++;

			totalDownSpeed += rxSpd;
			totalUpSpeed += txSpd;
			totalBytesAll += totBytes;

			dev.rx_bytes = rxBytes;
			dev.tx_bytes = txBytes;
			dev.total_bytes = totBytes;

			if (dev.mac) {
				prevStats[dev.mac] = {
					rx_bytes: rxBytes,
					tx_bytes: txBytes,
					rx_speed: rxSpd,
					tx_speed: txSpd,
					time: Date.now()
				};
			}
		});

		this.cachedDevices = devices;

		// Update Header KPI Summary Elements
		var elActive = document.getElementById('summary-active-count');
		var elDown = document.getElementById('summary-total-down');
		var elUp = document.getElementById('summary-total-up');
		var elBytes = document.getElementById('summary-total-bytes');

		if (elActive) elActive.innerText = activeCount + ' / ' + totalDiscovered;
		if (elDown) elDown.innerText = formatSpeed(totalDownSpeed);
		if (elUp) elUp.innerText = formatSpeed(totalUpSpeed);
		if (elBytes) elBytes.innerText = formatBytes(totalBytesAll);

		this.renderGraphSVG(totalDownSpeed, totalUpSpeed);
		this.renderTableOnly();
	},

	renderGraphSVG: function (downSpeed, upSpeed) {
		graphHistory.push({ down: downSpeed, up: upSpeed });
		if (graphHistory.length > MAX_GRAPH_POINTS) graphHistory.shift();

		var container = document.getElementById('netmon-svg-graph-container');
		if (!container) return;

		var width = 600;
		var height = 150;

		var maxVal = 10000; // 10 KB/s baseline floor
		graphHistory.forEach(function (pt) {
			if (pt.down > maxVal) maxVal = pt.down;
			if (pt.up > maxVal) maxVal = pt.up;
		});

		var stepX = width / (MAX_GRAPH_POINTS - 1);
		var downPoints = [];
		var upPoints = [];

		graphHistory.forEach(function (pt, idx) {
			var x = (idx * stepX).toFixed(1);
			var yDown = (height - (pt.down / maxVal) * (height - 24) - 12).toFixed(1);
			var yUp = (height - (pt.up / maxVal) * (height - 24) - 12).toFixed(1);
			downPoints.push({ x: parseFloat(x), y: parseFloat(yDown) });
			upPoints.push({ x: parseFloat(x), y: parseFloat(yUp) });
		});

		// Build smooth cubic Bezier path string
		function buildBezierPath(points) {
			if (points.length === 0) return '';
			if (points.length === 1) return 'M ' + points[0].x + ',' + points[0].y;
			var path = 'M ' + points[0].x + ',' + points[0].y;
			for (var i = 0; i < points.length - 1; i++) {
				var p0 = points[i];
				var p1 = points[i + 1];
				var cx = (p0.x + p1.x) / 2;
				path += ' C ' + cx + ',' + p0.y + ' ' + cx + ',' + p1.y + ' ' + p1.x + ',' + p1.y;
			}
			return path;
		}

		var downPathStr = buildBezierPath(downPoints);
		var upPathStr = buildBezierPath(upPoints);

		if (downPoints.length === 0 || upPoints.length === 0) {
			container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#64748b;font-weight:700;">' + _('Waiting for telemetry data...') + '</div>';
			return;
		}

		var lastDownX = downPoints[downPoints.length - 1].x;
		var lastUpX = upPoints[upPoints.length - 1].x;

		var downPolyStr = downPathStr + ' L ' + lastDownX + ',' + height + ' L 0,' + height + ' Z';
		var upPolyStr = upPathStr + ' L ' + lastUpX + ',' + height + ' L 0,' + height + ' Z';

		var svgHTML = '<svg viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="none" style="width:100%; height:100%; display:block;">' +
			'<defs>' +
			'<linearGradient id="dashGradDown" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#3b82f6" stop-opacity="0.35"/><stop offset="100%" stop-color="#3b82f6" stop-opacity="0.0"/></linearGradient>' +
			'<linearGradient id="dashGradUp" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#8b5cf6" stop-opacity="0.30"/><stop offset="100%" stop-color="#8b5cf6" stop-opacity="0.0"/></linearGradient>' +
			'</defs>' +
			'<line x1="0" y1="' + (height * 0.25) + '" x2="' + width + '" y2="' + (height * 0.25) + '" stroke="#e2e8f0" stroke-dasharray="4,4"/>' +
			'<line x1="0" y1="' + (height * 0.50) + '" x2="' + width + '" y2="' + (height * 0.50) + '" stroke="#e2e8f0" stroke-dasharray="4,4"/>' +
			'<line x1="0" y1="' + (height * 0.75) + '" x2="' + width + '" y2="' + (height * 0.75) + '" stroke="#e2e8f0" stroke-dasharray="4,4"/>' +
			'<path d="' + downPolyStr + '" fill="url(#dashGradDown)"/>' +
			'<path d="' + upPolyStr + '" fill="url(#dashGradUp)"/>' +
			'<path d="' + downPathStr + '" fill="none" stroke="#3b82f6" stroke-width="2.5" stroke-linejoin="round"/>' +
			'<path d="' + upPathStr + '" fill="none" stroke="#8b5cf6" stroke-width="2.5" stroke-linejoin="round"/>' +
			'</svg>';

		container.innerHTML = svgHTML;
	},

	renderTableOnly: function () {
		var self = this;
		var tbody = document.getElementById('netmon-table-tbody');
		var counter = document.getElementById('table-device-counter');
		if (!tbody || !self.cachedDevices) return;

		var devices = self.cachedDevices.slice();

		if (filterStatus === 'online') {
			devices = devices.filter(function (d) { return d.online; });
		} else if (filterStatus === 'offline') {
			devices = devices.filter(function (d) { return !d.online; });
		}

		if (filterQuery) {
			devices = devices.filter(function (d) {
				var host = (d.hostname || '').toLowerCase();
				var ip = (d.ip || '').toLowerCase();
				var mac = (d.mac || '').toLowerCase();
				return host.indexOf(filterQuery) !== -1 || ip.indexOf(filterQuery) !== -1 || mac.indexOf(filterQuery) !== -1;
			});
		}

		// Sort devices: online/active devices first, then offline/inactive devices.
		// Secondary sort by total session traffic descending.
		devices.sort(function (a, b) {
			var aOnline = (a.online || a.online === 1 || a.online === '1') ? 1 : 0;
			var bOnline = (b.online || b.online === 1 || b.online === '1') ? 1 : 0;
			if (aOnline !== bOnline) {
				return bOnline - aOnline;
			}
			var totA = a.total_bytes || 0;
			var totB = b.total_bytes || 0;
			return totB - totA;
		});

		if (counter) counter.innerText = devices.length + ' ' + _('Discovered Devices');

		var totalItems = devices.length;
		var totalPages = Math.max(1, Math.ceil(totalItems / self.pageSize));
		if (self.currentPage > totalPages) self.currentPage = totalPages;
		if (self.currentPage < 1) self.currentPage = 1;

		var startIndex = (self.currentPage - 1) * self.pageSize;
		var pageDevices = devices.slice(startIndex, startIndex + self.pageSize);

		dom.content(tbody, []);

		// Identify top bandwidth consumer device
		var topMac = '';
		var maxBytes = 0;
		if (self.cachedDevices && self.cachedDevices.length > 0) {
			self.cachedDevices.forEach(function (d) {
				var b = d.total_bytes || 0;
				if (b > maxBytes) {
					maxBytes = b;
					topMac = d.mac;
				}
			});
		}

		if (pageDevices.length === 0) {
			tbody.appendChild(E('tr', {}, [
				E('td', { 'colspan': '6', 'style': 'text-align: center; padding: 30px; color: #64748b;' }, [_('No network devices match criteria.')])
			]));
		} else {
			pageDevices.forEach(function (dev) {
				var statusBadge = dev.online ?
					E('span', { 'class': 'netmon-badge-online' }, [_('Online')]) :
					E('span', { 'class': 'netmon-badge-offline' }, [_('Offline')]);

				var isTop = (dev.mac && dev.mac === topMac && (dev.total_bytes || 0) > 0);
				var topBadge = isTop ? E('span', {
					'style': 'font-size: 10px; font-weight: 700; background: #fef3c7; color: #b45309; border: 1px solid #fde68a; padding: 2px 6px; border-radius: 6px; margin-left: 6px; white-space: nowrap;'
				}, [_('Top Consumer')]) : '';

				var nameIpCell = E('div', { 'style': 'min-width: 180px;' }, [
					E('div', { 'style': 'display: flex; align-items: center; justify-content: space-between; gap: 8px;' }, [
						E('div', { 'style': 'display: flex; align-items: center; gap: 4px;' }, [
							E('span', { 'class': 'dev-name-title' }, [dev.hostname || 'Unknown Device']),
							topBadge
						]),
						renderMediumBadge(dev.conn_type, dev.online)
					]),
					E('div', { 'class': 'dev-ip-sub' }, [dev.ip || '0.0.0.0'])
				]);

				var macCell = E('span', { 'class': 'dev-mac-code' }, [dev.mac || '-']);

				var actionsCell = E('div', { 'style': 'display: flex; gap: 6px;' }, [
					E('button', {
						'class': 'btn cbi-button cbi-button-remove',
						'style': 'padding: 2px 8px; font-size: 11px; font-weight: 700;',
						'title': _('Quick Block Access'),
						'click': function() {
							var target = dev.mac || dev.ip;
							if (!target) return;
							dashboardAskAdmin(function(pw){
									callToggleBlock(target, '1', pw).then(function(r) {
										if(r&&r.status==='ok') ui.addNotification(null, E('p', {}, [_('Blocked access for %s').format(target)]));
										else ui.addNotification(null, E('p', {}, [r&&r.error||_('Unable to block device.')]), 'error');
									});
								});
						}
					}, [_('Block')]),
					E('button', {
						'class': 'btn cbi-button cbi-button-neutral',
						'style': 'padding: 2px 8px; font-size: 11px; font-weight: 700;',
						'title': _('Set Data Quota'),
						'click': function() {
							showQuotaModal(dev);
						}
					}, [_('Quota')]),
					E('button', {
						'class': 'btn cbi-button cbi-button-action',
						'style': 'padding: 2px 8px; font-size: 11px; font-weight: 700;',
						'title': _('Rename Device'),
						'click': function() {
							showRenameModal(dev);
						}
					}, [_('Rename')])
				]);

				var row = E('tr', {}, [
					E('td', {}, [statusBadge]),
					E('td', {}, [nameIpCell]),
					E('td', {}, [macCell]),
					E('td', { 'style': 'font-weight: 700; color: #3b82f6;' }, [formatSpeed(dev.rx_speed || 0)]),
					E('td', { 'style': 'font-weight: 700; color: #8b5cf6;' }, [formatSpeed(dev.tx_speed || 0)]),
					E('td', { 'style': 'font-weight: 700; color: #f59e0b;' }, [formatBytes(dev.total_bytes || 0)]),
					E('td', {}, [actionsCell])
				]);

				tbody.appendChild(row);
			});
		}

		renderPagination('netmon-table-pagination', self.currentPage, totalPages, totalItems, self.pageSize, function (newPage) {
			self.currentPage = newPage;
			self.renderTableOnly();
		});
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
