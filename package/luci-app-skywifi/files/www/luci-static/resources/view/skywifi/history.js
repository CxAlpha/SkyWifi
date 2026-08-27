'use strict';
'require view';
'require rpc';
'require ui';
'require dom';
'require poll';

var callGetHistory = rpc.declare({
	object: 'luci.skywifi',
	method: 'get_history',
	params: ['range'],
	expect: {}
});

var callResetStats = rpc.declare({
	object: 'luci.skywifi',
	method: 'reset_stats',
	params: ['target'],
	expect: {}
});

function formatBytes(bytes) {
	if (!bytes || isNaN(bytes) || bytes <= 0) return '0.00 B';
	var k = 1024;
	var sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
	var i = Math.floor(Math.log(bytes) / Math.log(k));
	return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatBytesShort(bytes) {
	if (!bytes || isNaN(bytes) || bytes <= 0) return '0 B';
	var k = 1024;
	var sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
	var i = Math.floor(Math.log(bytes) / Math.log(k));
	var val = bytes / Math.pow(k, i);
	var formatted = val >= 100 ? val.toFixed(0) : val.toFixed(1);
	return formatted + ' ' + sizes[i];
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

function exportCSV(data, range) {
	if (!data) return;
	var filename = 'skywifi_history_' + range + '_' + new Date().toISOString().slice(0, 10) + '.csv';
	var csvLines = ['MAC,IP Address,Hostname,Download Bytes,Upload Bytes,Total Bytes'];
	var devs = data.devices || [];
	devs.forEach(function (d) {
		var mac = d.mac || '';
		var ip = d.ip || '';
		var host = (d.hostname || 'Unknown').replace(/,/g, ' ');
		var rx = d.rx_bytes || 0;
		var tx = d.tx_bytes || 0;
		var tot = d.total_bytes || (rx + tx);
		csvLines.push([mac, ip, host, rx, tx, tot].join(','));
	});
	var blob = new Blob([csvLines.join('\n')], { type: 'text/csv;charset=utf-8;' });
	var link = document.createElement('a');
	link.href = URL.createObjectURL(blob);
	link.download = filename;
	link.click();
}

function exportJSON(data, range) {
	if (!data) return;
	var filename = 'skywifi_history_' + range + '_' + new Date().toISOString().slice(0, 10) + '.json';
	var jsonStr = JSON.stringify(data, null, 2);
	var blob = new Blob([jsonStr], { type: 'application/json;charset=utf-8;' });
	var link = document.createElement('a');
	link.href = URL.createObjectURL(blob);
	link.download = filename;
	link.click();
}

return view.extend({
	currentPage: 1,
	pageSize: 10,
	currentRange: 'today',
	selectedDevice: 'all',
	searchQuery: '',
	cachedData: null,
	monthlyData: null,

	load: function () {
		return Promise.all([
			callGetHistory('today').catch(function () { return { devices: [] }; }),
			callGetHistory('month').catch(function () { return { devices: [] }; })
		]);
	},

	render: function (parsedData) {
		var self = this;
		var data = (parsedData && parsedData[0] && Array.isArray(parsedData[0].devices)) ? parsedData[0] : { devices: [] };
		self.cachedData = data;
		self.monthlyData = (parsedData && parsedData[1] && Array.isArray(parsedData[1].devices)) ? parsedData[1] : data;

		var container = E('div', { 'class': 'cbi-map', 'id': 'netmon-history-master' }, [
			E('style', {}, [
				'#netmon-history-master { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; font-size: 12px; color: #334155; }',
				'.netmon-title { font-size: 16px !important; font-weight: 800 !important; color: #0f172a; margin: 0; line-height: 1.3; }',
				'.netmon-label { font-size: 12px !important; font-weight: 700 !important; color: #475569; display: block; margin-bottom: 4px; }',
				'.netmon-badge { font-size: 12px !important; font-weight: 700 !important; border-radius: 12px; padding: 4px 12px; display: inline-flex; align-items: center; }',

				'.hist-card { background: #ffffff; border-radius: 16px; padding: 20px; border: 1px solid #e2e8f0; box-shadow: 0 4px 20px rgba(0,0,0,0.03); margin-bottom: 20px; }',
				'.hist-kpi-card { background: #ffffff; border-radius: 12px; padding: 16px; border: 1px solid #e2e8f0; box-shadow: 0 2px 10px rgba(0,0,0,0.02); display: flex; flex-direction: column; justify-content: center; }',
				'.hist-kpi-val { font-size: 1.4rem; font-weight: 800; color: #0f172a; margin-top: 6px; word-break: break-word; }',

				'.hist-select { height: 38px; padding: 0 12px; border-radius: 8px; border: 1px solid #cbd5e1; background: #ffffff; color: #0f172a; font-weight: 600; font-size: 12px; cursor: pointer; outline: none; width: 100%; box-sizing: border-box; }',
				'.hist-select:focus { border-color: #4f46e5; box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.12); }',

				'.hist-input { height: 38px; padding: 0 12px; border-radius: 8px; border: 1px solid #cbd5e1; background: #ffffff; color: #0f172a; font-weight: 400; font-size: 12px; outline: none; width: 100%; box-sizing: border-box; }',
				'.hist-input:focus { border-color: #4f46e5; box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.12); }',

				'.hist-btn-primary { background: #4f46e5; color: #ffffff; border: none; padding: 9px 18px; border-radius: 8px; font-weight: 700; font-size: 12px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 6px; transition: background 0.15s ease; }',
				'.hist-btn-primary:hover { background: #4338ca; }',
				'.hist-btn-sec { background: #f1f5f9; color: #334155; border: 1px solid #cbd5e1; padding: 8px 14px; border-radius: 8px; font-weight: 700; font-size: 12px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; transition: all 0.15s ease; }',
				'.hist-btn-sec:hover { background: #e2e8f0; }',

				'.hist-btn-danger { background: #fef2f2; color: #dc2626; border: 1px solid #fecaca; padding: 8px 16px; border-radius: 8px; font-weight: 700; font-size: 12px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 6px; transition: background 0.15s ease; }',
				'.hist-btn-danger:hover { background: #fee2e2; }',

				'.table-responsive { width: 100% !important; max-width: 100% !important; overflow-x: auto !important; -webkit-overflow-scrolling: touch !important; display: block !important; touch-action: pan-x pan-y !important; }',
				'.hist-table { width: 100% !important; min-width: 650px; border-collapse: collapse; table-layout: auto !important; }',
				'.hist-table th { font-size: 11px !important; font-weight: 700 !important; color: #64748b; padding: 12px 16px; text-align: left; background: #f8fafc; border-bottom: 1px solid #e2e8f0; text-transform: uppercase; letter-spacing: 0.05em; white-space: nowrap; }',
				'.hist-table td { padding: 12px 16px; border-bottom: 1px solid #e2e8f0; font-size: 12px !important; font-weight: 400 !important; color: #0f172a; vertical-align: middle; background: #ffffff; white-space: nowrap; }',
				'.hist-table tr:hover td { background: #f8fafc; }',

				'.column-bar-item { transition: transform 0.2s ease, opacity 0.2s ease; cursor: pointer; }',
				'.column-bar-item:hover { transform: translateY(-3px); opacity: 0.9; }',

				'.ctrl-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; width: 100%; align-items: end; }',

				'@media (max-width: 768px) {',
					'#netmon-history-master { font-size: 11px !important; }',
					'.hist-card { padding: 14px !important; margin-bottom: 16px !important; border-radius: 12px !important; }',
					'.hist-kpi-card { padding: 12px !important; }',
					'.hist-kpi-val { font-size: 1.2rem !important; }',
					'.ctrl-grid { grid-template-columns: 1fr !important; }',
					'.table-responsive { width: 100% !important; max-width: 100vw !important; overflow-x: auto !important; }',
				'}'
			]),

			// 1. Header Toolbar
			E('div', { 'style': 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; flex-wrap: wrap; gap: 12px;' }, [
				E('div', {}, [
					E('h2', { 'class': 'netmon-title' }, [_('Traffic History')])
				]),
				E('div', { 'style': 'display: flex; align-items: center; gap: 8px;' }, [
					E('button', {
						'class': 'hist-btn-sec',
						'click': function () { exportCSV(self.cachedData, self.currentRange); }
					}, [_('Export CSV')]),
					E('button', {
						'class': 'hist-btn-sec',
						'click': function () { exportJSON(self.cachedData, self.currentRange); }
					}, [_('Export JSON')]),
					E('button', {
						'class': 'hist-btn-danger',
						'click': function () { self.resetHistory('all'); }
					}, [_('Clear History')])
				])
			]),

			// 2. KPI Summary Cards Grid
			E('div', { 'style': 'display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 14px; margin-bottom: 20px;' }, [
				E('div', { 'class': 'hist-kpi-card', 'style': 'border-left: 4px solid #4f46e5;' }, [
					E('div', { 'class': 'netmon-label' }, [_('Total Traffic')]),
					E('div', { 'id': 'hist-kpi-total', 'class': 'hist-kpi-val', 'style': 'color: #4338ca;' }, ['0.00 B'])
				]),

				E('div', { 'class': 'hist-kpi-card', 'style': 'border-left: 4px solid #0284c7;' }, [
					E('div', { 'class': 'netmon-label' }, [_('Download (RX)')]),
					E('div', { 'id': 'hist-kpi-rx', 'class': 'hist-kpi-val', 'style': 'color: #0369a1;' }, ['0.00 B'])
				]),

				E('div', { 'class': 'hist-kpi-card', 'style': 'border-left: 4px solid #d97706;' }, [
					E('div', { 'class': 'netmon-label' }, [_('Upload (TX)')]),
					E('div', { 'id': 'hist-kpi-tx', 'class': 'hist-kpi-val', 'style': 'color: #b45309;' }, ['0.00 B'])
				]),

				E('div', { 'class': 'hist-kpi-card', 'style': 'border-left: 4px solid #16a34a;' }, [
					E('div', { 'class': 'netmon-label' }, [_('Top Device')]),
					E('div', { 'id': 'hist-kpi-top-dev', 'class': 'hist-kpi-val', 'style': 'color: #15803d; font-size: 1.15rem; overflow: hidden; text-overflow: ellipsis;' }, ['None'])
				])
			]),

			// 3. Controls & Filter Bar Card
			E('div', { 'class': 'hist-card', 'id': 'hist-controls-card', 'style': 'padding: 16px;' }, [
				E('div', { 'class': 'ctrl-grid' }, [
					// Timeframe Range Dropdown
					E('div', {}, [
						E('label', { 'class': 'netmon-label' }, [_('Timeframe')]),
						E('select', {
							'class': 'hist-select',
							'id': 'hist-range-select',
							'change': function (ev) { self.switchRange(ev.target.value); }
						}, [
							E('option', { 'value': 'today' }, [_('Today')]),
							E('option', { 'value': 'yesterday' }, [_('Yesterday')]),
							E('option', { 'value': 'last7' }, [_('Last 7 Days')]),
							E('option', { 'value': 'month' }, [_('Current Month')])
						])
					]),

					// Device Target Filter Dropdown
					E('div', {}, [
						E('label', { 'class': 'netmon-label' }, [_('Device')]),
						E('select', {
							'class': 'hist-select',
							'id': 'hist-device-select',
							'change': function (ev) {
								self.selectedDevice = ev.target.value;
								self.renderAnalytics(self.cachedData);
							}
						}, [
							E('option', { 'value': 'all' }, [_('All Devices')])
						])
					]),

					// Search Filter Input
					E('div', {}, [
						E('label', { 'class': 'netmon-label' }, [_('Search')]),
						E('input', {
							'type': 'text',
							'class': 'hist-input',
							'placeholder': _('Search host or IP...'),
							'input': function (ev) {
								self.searchQuery = ev.target.value.toLowerCase();
								self.renderAnalytics(self.cachedData);
							}
						})
					]),

					// Refresh Button
					E('div', {}, [
						E('button', {
							'class': 'hist-btn-primary',
							'style': 'width: 100%;',
							'click': function () { self.refreshCurrentData(); }
						}, [_('Refresh')])
					])
				])
			]),

			// 4. Daily Usage Bar Chart Card
			E('div', { 'class': 'hist-card', 'id': 'hist-daily-column-chart-card' }, [
				E('div', { 'style': 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; flex-wrap: wrap; gap: 10px;' }, [
					E('h3', { 'class': 'netmon-title' }, [_('Daily Usage')]),
					E('div', { 'style': 'display: flex; align-items: center; gap: 10px;' }, [
						E('select', {
							'class': 'hist-select',
							'id': 'hist-month-filter-select',
							'style': 'width: auto; height: 34px;',
							'change': function (ev) {
								var selectedMonthId = ev.target.value;
								var param = (selectedMonthId && selectedMonthId !== 'current') ? ('month:' + selectedMonthId) : 'month';
								callGetHistory(param).then(function (mRes) {
									if (mRes) {
										self.monthlyData = mRes;
										self.renderDailyColumnChart(mRes);
									}
								});
							}
						}, [
							E('option', { 'value': 'current' }, [_('Current Period')])
						]),
						E('span', { 'id': 'month-name-badge', 'class': 'netmon-badge', 'style': 'background: #e0e7ff; color: #3730a3;' }, [_('Period')])
					])
				]),
				E('div', { 'id': 'hist-daily-column-container', 'style': 'width: 100%; min-height: 220px; overflow-x: auto;' }, [
					E('div', { 'style': 'text-align: center; color: #64748b; padding: 40px;' }, [_('Loading chart...')])
				])
			]),

			// 5. Detailed Device History Records Table Card
			E('div', { 'class': 'hist-card', 'style': 'padding: 0; overflow: hidden;' }, [
				E('div', { 'style': 'padding: 16px 20px; border-bottom: 1px solid #e2e8f0; background: #f8fafc; display: flex; justify-content: space-between; align-items: center;' }, [
					E('h3', { 'class': 'netmon-title' }, [_('Device Records')]),
					E('span', { 'id': 'hist-table-badge', 'class': 'netmon-badge', 'style': 'background: #e0e7ff; color: #3730a3;' }, [_('0 Devices')])
				]),
				E('div', { 'class': 'table-responsive' }, [
					E('table', { 'class': 'hist-table' }, [
						E('thead', {}, [
							E('tr', {}, [
								E('th', {}, [_('Device')]),
								E('th', {}, [_('IP Address')]),
								E('th', {}, [_('MAC Address')]),
								E('th', {}, [_('Download')]),
								E('th', {}, [_('Upload')]),
								E('th', {}, [_('Total')]),
								E('th', {}, [_('Share')])
							])
						]),
						E('tbody', { 'id': 'hist-table-tbody' }, [
							E('tr', {}, [E('td', { 'colspan': '7', 'style': 'text-align: center; padding: 25px; color: #64748b;' }, [_('Loading history records...')])])
						])
					])
				]),
				E('div', { 'id': 'hist-table-pagination', 'style': 'padding: 12px 16px; background: #ffffff; border-top: 1px solid #e2e8f0;' })
			])
		]);

		setTimeout(function () {
			self.populateDeviceDropdown(data);
			self.renderDailyColumnChart(self.monthlyData);
			self.renderAnalytics(data);
		}, 100);

		poll.add(function () {
			return Promise.all([
				callGetHistory(self.currentRange).catch(function () { return { devices: [], days: [] }; }),
				callGetHistory('month').catch(function () { return { devices: [], days: [] }; })
			]).then(function (resList) {
				if (resList && resList[0]) {
					self.cachedData = resList[0];
					self.renderAnalytics(resList[0]);
				}
				if (resList && resList[1]) {
					self.monthlyData = resList[1];
					self.renderDailyColumnChart(resList[1]);
				}
			});
		}, 5);

		return container;
	},

	renderDailyColumnChart: function (mRes) {
		var container = document.getElementById('hist-daily-column-container');
		var monthBadge = document.getElementById('month-name-badge');
		if (!container) return;

		var days = (mRes && Array.isArray(mRes.days)) ? mRes.days : [];
		if (monthBadge && mRes && mRes.month_name) {
			monthBadge.innerText = mRes.month_name;
		}

		var monthSelect = document.getElementById('hist-month-filter-select');
		if (monthSelect && mRes && Array.isArray(mRes.available_months) && mRes.available_months.length > 0) {
			var currVal = monthSelect.value;
			dom.content(monthSelect, []);
			mRes.available_months.forEach(function (m) {
				monthSelect.appendChild(E('option', { 'value': m.id }, [m.label]));
			});
			if (currVal) monthSelect.value = currVal;
		}

		if (days.length === 0) {
			dom.content(container, E('div', { 'style': 'text-align: center; color: #64748b; padding: 40px;' }, [
				_('No daily usage records available.')
			]));
			return;
		}

		var maxVal = 1024 * 1024 * 10; // 10 MB floor
		days.forEach(function (d) {
			var val = d.total_bytes || 0;
			if (val > maxVal) maxVal = val;
		});

		var chartHeight = 220;
		var topMargin = 55;
		var yTicks = [
			formatBytes(maxVal),
			formatBytes(maxVal * 0.75),
			formatBytes(maxVal * 0.5),
			formatBytes(maxVal * 0.25),
			'0 B'
		];

		var svgWidth = Math.max(900, days.length * 30);
		var svgHeight = chartHeight + 40;
		var barWidth = 14;
		var groupWidth = svgWidth / days.length;

		var svgHTML = '<svg viewBox="0 0 ' + (svgWidth + 70) + ' ' + svgHeight + '" preserveAspectRatio="none" style="min-width: 900px; width:100%; height:260px; display:block; overflow:visible;">' +
			'<defs>' +
			'<linearGradient id="colGrad1" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#ef4444"/><stop offset="100%" stop-color="#dc2626"/></linearGradient>' +
			'<linearGradient id="colGrad2" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#0284c7"/><stop offset="100%" stop-color="#0369a1"/></linearGradient>' +
			'<linearGradient id="colGrad3" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#10b981"/><stop offset="100%" stop-color="#059669"/></linearGradient>' +
			'<linearGradient id="colGrad4" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#f59e0b"/><stop offset="100%" stop-color="#d97706"/></linearGradient>' +
			'<linearGradient id="colGrad5" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#ec4899"/><stop offset="100%" stop-color="#db2777"/></linearGradient>' +
			'</defs>';

		// Y-Axis Horizontal Gridlines & Labels
		var gridSteps = [0, 0.25, 0.5, 0.75, 1];
		gridSteps.forEach(function (ratio, idx) {
			var yPos = chartHeight - (ratio * (chartHeight - topMargin));
			svgHTML += '<line x1="60" y1="' + yPos + '" x2="' + (svgWidth + 60) + '" y2="' + yPos + '" stroke="#e2e8f0" stroke-dasharray="3,3" stroke-width="1"/>';
			svgHTML += '<text x="52" y="' + (yPos + 4) + '" font-size="11" font-weight="700" fill="#64748b" text-anchor="end">' + yTicks[4 - idx] + '</text>';
		});

		// Base X-Axis Line
		svgHTML += '<line x1="60" y1="' + chartHeight + '" x2="' + (svgWidth + 60) + '" y2="' + chartHeight + '" stroke="#94a3b8" stroke-width="2"/>';

		var currentDayNum = (mRes && mRes.current_day) ? parseInt(mRes.current_day) : new Date().getDate();

		days.forEach(function (d, idx) {
			var val = d.total_bytes || 0;
			var isZeroData = (!val || val <= 0);

			var colH = isZeroData ? 3 : Math.max(4, Math.round((val / maxVal) * (chartHeight - topMargin)));
			var xPos = 60 + (idx * groupWidth) + (groupWidth - barWidth) / 2;
			var yPos = chartHeight - colH;

			var colorIdx = (idx % 5) + 1;
			var fillUrl = isZeroData ? '#cbd5e1' : ('url(#colGrad' + colorIdx + ')');
			var opacityAttr = isZeroData ? 'opacity="0.65"' : '';

			var isToday = (d.day === currentDayNum);
			var strokeAttr = isToday ? 'stroke="#4f46e5" stroke-width="2.5"' : '';
			var tooltipText = 'Day ' + d.label + ': ' + (isZeroData ? 'No traffic recorded (0 B)' : formatBytes(val));

			svgHTML += '<rect x="' + xPos + '" y="' + yPos + '" width="' + barWidth + '" height="' + colH + '" rx="2" ry="2" fill="' + fillUrl + '" ' + strokeAttr + ' ' + opacityAttr + ' class="column-bar-item">' +
				'<title>' + tooltipText + '</title>' +
				'</rect>';

			// Always display data usage label on top of every bar
			var dataLabelText = formatBytesShort(val);
			var dataLabelColor = isZeroData ? '#94a3b8' : (isToday ? '#4338ca' : '#0f172a');
			var labelCenterX = xPos + (barWidth / 2);
			var labelCenterY = yPos - 6;
			svgHTML += '<text x="' + labelCenterX + '" y="' + labelCenterY + '" font-size="9.5" font-weight="800" fill="' + dataLabelColor + '" text-anchor="start" transform="rotate(-45, ' + labelCenterX + ', ' + labelCenterY + ')">' + dataLabelText + '</text>';

			// X-Axis Day Number Label
			svgHTML += '<text x="' + (xPos + barWidth / 2) + '" y="' + (chartHeight + 16) + '" font-size="10" font-weight="700" fill="' + (isToday ? '#4f46e5' : '#475569') + '" text-anchor="middle">' + d.label + '</text>';
		});

		svgHTML += '</svg>';
		container.innerHTML = svgHTML;
	},

	switchRange: function (range) {
		var self = this;
		self.currentRange = range;
		self.refreshCurrentData();
	},

	refreshCurrentData: function () {
		var self = this;
		Promise.all([
			callGetHistory(self.currentRange).catch(function () { return { devices: [] }; }),
			callGetHistory('month').catch(function () { return { devices: [] }; })
		]).then(function (resList) {
			if (resList && resList[0]) {
				self.cachedData = resList[0];
				self.populateDeviceDropdown(resList[0]);
				self.renderAnalytics(resList[0]);
			}
			if (resList && resList[1]) {
				self.monthlyData = resList[1];
				self.renderDailyColumnChart(resList[1]);
			}
		});
	},

	resetHistory: function (target) {
		var self = this;
		var msg = target === 'all' ? _('Are you sure you want to clear all historical traffic records?') : _('Are you sure you want to reset records for this device?');
		if (confirm(msg)) {
			callResetStats(target).then(function () {
				ui.addNotification(null, _('History records reset successfully!'), 'info');
				self.cachedData = { devices: [] };
				self.monthlyData = { days: [], current_day: new Date().getDate(), month_name: '' };

				if (target === 'all') {
					self.selectedDevice = 'all';
					self.currentPage = 1;
					self.searchQuery = '';
					var searchInput = document.querySelector('.hist-input');
					if (searchInput) searchInput.value = '';
				}

				var monthSelect = document.getElementById('hist-month-filter-select');
				if (monthSelect) {
					dom.content(monthSelect, [E('option', { 'value': 'current' }, [_('Current Period')])]);
				}

				return Promise.all([
					callGetHistory(self.currentRange).catch(function () { return { devices: [] }; }),
					callGetHistory('month').catch(function () { return { devices: [] }; })
				]).then(function (resList) {
					if (resList && resList[0]) {
						self.cachedData = resList[0];
						self.populateDeviceDropdown(resList[0]);
					}
					if (resList && resList[1]) {
						self.monthlyData = resList[1];
					}
					self.renderAnalytics(self.cachedData);
					self.renderDailyColumnChart(self.monthlyData);
				});
			}).catch(function (err) {
				ui.addNotification(null, _('Failed to clear history: ') + (err.message || err), 'error');
			});
		}
	},

	populateDeviceDropdown: function (res) {
		var select = document.getElementById('hist-device-select');
		if (!select) return;

		var rawDevices = (res && res.devices) ? res.devices : [];
		var currentVal = select.value || 'all';

		var seenKeys = {};
		var devices = [];
		rawDevices.forEach(function (d) {
			if (!d) return;
			var key = (d.mac || '').toLowerCase().replace(/[^0-9a-f]/g, '') || d.ip || '';
			if (key && !seenKeys[key]) {
				seenKeys[key] = true;
				devices.push(d);
			}
		});

		dom.content(select, [E('option', { 'value': 'all' }, [_('All Devices')])]);

		devices.forEach(function (d) {
			var connStr = (d.online && d.conn_type) ? (' | ' + d.conn_type) : '';
			var label = (d.hostname && d.hostname !== 'Unknown' ? d.hostname : (d.ip || d.mac)) + ' (' + (d.ip || d.mac) + connStr + ')';
			select.appendChild(E('option', { 'value': d.mac || d.ip }, [label]));
		});

		select.value = currentVal;
	},

	renderAnalytics: function (res) {
		var self = this;
		var rawDevices = (res && Array.isArray(res.devices)) ? res.devices : [];

		var seenKeys = {};
		var devices = [];
		rawDevices.forEach(function (d) {
			if (!d) return;
			var key = (d.mac || '').toLowerCase().replace(/[^0-9a-f]/g, '') || d.ip || '';
			if (!key) return;
			if (!seenKeys[key]) {
				seenKeys[key] = d;
				devices.push(d);
			} else {
				var existing = seenKeys[key];
				existing.rx_bytes = Math.max(parseFloat(existing.rx_bytes) || 0, parseFloat(d.rx_bytes) || 0);
				existing.tx_bytes = Math.max(parseFloat(existing.tx_bytes) || 0, parseFloat(d.tx_bytes) || 0);
				existing.total_bytes = Math.max(parseFloat(existing.total_bytes) || 0, parseFloat(d.total_bytes) || 0);
				if (d.online) existing.online = 1;
			}
		});

		var totalRxNet = 0;
		var totalTxNet = 0;
		var totalNet = 0;

		devices.forEach(function (d) {
			totalRxNet += (parseFloat(d.rx_bytes) || 0);
			totalTxNet += (parseFloat(d.tx_bytes) || 0);
			totalNet += (parseFloat(d.total_bytes) || 0);
		});

		var m = self.monthlyData || {};
		var monthlyTotal = parseFloat(m.monthly_total_bytes) || 0;
		var monthlyRx = parseFloat(m.monthly_rx_bytes) || 0;
		var monthlyTx = parseFloat(m.monthly_tx_bytes) || 0;
		if (monthlyTotal <= 0) {
			monthlyTotal = totalNet;
			monthlyRx = totalRxNet;
			monthlyTx = totalTxNet;
		}

		var kpiTotalEl = document.getElementById('hist-kpi-total');
		var kpiRxEl = document.getElementById('hist-kpi-rx');
		var kpiTxEl = document.getElementById('hist-kpi-tx');
		var kpiTopDevEl = document.getElementById('hist-kpi-top-dev');

		if (kpiTotalEl) kpiTotalEl.innerText = formatBytes(monthlyTotal);
		if (kpiRxEl) kpiRxEl.innerText = formatBytes(monthlyRx);
		if (kpiTxEl) kpiTxEl.innerText = formatBytes(monthlyTx);

		var monthDevices = (m && Array.isArray(m.devices)) ? m.devices : devices;
		var sortedDevices = monthDevices.slice().sort(function (a, b) {
			return (b.total_bytes || 0) - (a.total_bytes || 0);
		});
		var topDev = sortedDevices[0];
		if (topDev && topDev.total_bytes > 0) {
			if (kpiTopDevEl) {
				dom.content(kpiTopDevEl, [
					E('div', { 'style': 'display: flex; align-items: center; justify-content: space-between; gap: 6px; width: 100%;' }, [
						E('span', { 'style': 'overflow: hidden; text-overflow: ellipsis; white-space: nowrap;' }, [topDev.hostname || topDev.ip || topDev.mac]),
						renderMediumBadge(topDev.conn_type, topDev.online)
					])
				]);
			}
		} else {
			if (kpiTopDevEl) kpiTopDevEl.innerText = _('None');
		}

		var displayDevices = devices.slice();

		if (self.selectedDevice !== 'all') {
			displayDevices = displayDevices.filter(function (d) {
				return d.mac === self.selectedDevice || d.ip === self.selectedDevice;
			});
		}

		if (self.searchQuery) {
			displayDevices = displayDevices.filter(function (d) {
				var host = (d.hostname || '').toLowerCase();
				var ip = (d.ip || '').toLowerCase();
				var mac = (d.mac || '').toLowerCase();
				return host.indexOf(self.searchQuery) !== -1 || ip.indexOf(self.searchQuery) !== -1 || mac.indexOf(self.searchQuery) !== -1;
			});
		}

		// Sort devices by total data consumed descending (highest data consumer on top)
		displayDevices.sort(function (a, b) {
			var totA = a.total_bytes || ((a.rx_bytes || 0) + (a.tx_bytes || 0));
			var totB = b.total_bytes || ((b.rx_bytes || 0) + (b.tx_bytes || 0));
			return totB - totA;
		});

		var tableBadge = document.getElementById('hist-table-badge');
		if (tableBadge) tableBadge.innerText = displayDevices.length + ' ' + _('Devices');

		var totalItems = displayDevices.length;
		var totalPages = Math.max(1, Math.ceil(totalItems / self.pageSize));
		if (self.currentPage > totalPages) self.currentPage = totalPages;
		if (self.currentPage < 1) self.currentPage = 1;

		var startIndex = (self.currentPage - 1) * self.pageSize;
		var pageDevices = displayDevices.slice(startIndex, startIndex + self.pageSize);

		var tbody = document.getElementById('hist-table-tbody');
		if (tbody) {
			dom.content(tbody, []);

			if (pageDevices.length === 0) {
				tbody.appendChild(E('tr', {}, [
					E('td', { 'colspan': '7', 'style': 'text-align: center; padding: 25px; color: #64748b;' }, [_('No records match current criteria.')])
				]));
			} else {
				pageDevices.forEach(function (dev) {
					var devTotal = parseFloat(dev.total_bytes) || ((parseFloat(dev.rx_bytes) || 0) + (parseFloat(dev.tx_bytes) || 0));
					var sharePct = totalNet > 0 ? ((devTotal / totalNet) * 100).toFixed(1) : '0.0';

					var row = E('tr', {}, [
						E('td', {}, [
							E('div', { 'style': 'display: flex; align-items: center; justify-content: space-between; gap: 8px;' }, [
								E('span', { 'style': 'font-weight: 700; color: #0f172a;' }, [dev.hostname || 'Unknown Device']),
								renderMediumBadge(dev.conn_type, dev.online)
							])
						]),
						E('td', { 'style': 'font-family: monospace; font-weight: 700; color: #334155;' }, [dev.ip || '-']),
						E('td', { 'style': 'font-family: monospace; color: #64748b;' }, [dev.mac || '-']),
						E('td', { 'style': 'font-weight: 700; color: #0284c7;' }, [formatBytes(dev.rx_bytes || 0)]),
						E('td', { 'style': 'font-weight: 700; color: #d97706;' }, [formatBytes(dev.tx_bytes || 0)]),
						E('td', { 'style': 'font-weight: 700; color: #4338ca;' }, [formatBytes(devTotal)]),
						E('td', {}, [
							E('span', { 'class': 'netmon-badge', 'style': 'background: #e0e7ff; color: #3730a3;' }, [sharePct + '%'])
						])
					]);

					tbody.appendChild(row);
				});
			}
		}

		renderPagination('hist-table-pagination', self.currentPage, totalPages, totalItems, self.pageSize, function (newPage) {
			self.currentPage = newPage;
			self.renderAnalytics(self.cachedData);
		});
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
