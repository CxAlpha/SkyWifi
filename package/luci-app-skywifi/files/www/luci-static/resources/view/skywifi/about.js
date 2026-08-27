'use strict';
'require view';
'require rpc';

var callSystemBoard = rpc.declare({
	object: 'system',
	method: 'board',
	expect: { }
});

return view.extend({
	load: function() {
		return callSystemBoard();
	},

	render: function(board) {
		var boardName = (board && board.board_name) ? board.board_name : 'Generic OpenWrt Device';
		var model = (board && board.model) ? board.model : 'Router';
		var kernel = (board && board.kernel) ? board.kernel : 'Linux';

		var container = E('div', { 'class': 'cbi-map', 'id': 'skywifi-about' }, [
			E('style', {}, [
				'#skywifi-about { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #0f172a; font-size: 12px; }',
				'.about-card { background: #ffffff; border-radius: 16px; padding: 24px; border: 1px solid #e2e8f0; box-shadow: 0 4px 20px rgba(0,0,0,0.03); margin-bottom: 24px; font-size: 12px !important; }',
				'.about-badge { background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%); color: white; padding: 5px 14px; border-radius: 20px; font-weight: 700; font-size: 12px !important; display: inline-block; box-shadow: 0 2px 8px rgba(79, 70, 229, 0.25); }',
				'.table-responsive { width: 100% !important; max-width: 100% !important; overflow-x: auto !important; -webkit-overflow-scrolling: touch !important; display: block !important; touch-action: pan-x pan-y !important; }',
				'.about-table { width: 100% !important; border-collapse: collapse; table-layout: auto !important; }',
				'.about-table td { padding: 12px 16px; border-bottom: 1px solid #e2e8f0; font-size: 12px !important; color: #0f172a; vertical-align: middle; }',
				'.about-table tr:last-child td { border-bottom: none; }'
			]),

			// Header
			E('div', { 'style': 'margin-bottom: 24px;' }, [
				E('h2', { 'style': 'font-size: 18px !important; font-weight: 800 !important; color: #0f172a; margin: 0;' }, [ _('About Sky Wifi') ])
			]),

			// System Specs Card
			E('div', { 'class': 'about-card' }, [
				E('div', { 'style': 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 18px;' }, [
					E('h3', { 'style': 'font-size: 14px !important; font-weight: 800 !important; color: #0f172a; margin: 0;' }, [ _('System Specifications') ]),
					E('span', { 'class': 'about-badge' }, [ _('Sky Wifi Active') ])
				]),
				E('div', { 'class': 'table-responsive' }, [
					E('table', { 'class': 'about-table' }, [
						E('tr', {}, [
							E('td', { 'style': 'font-weight: 700; width: 220px; color: #475569;' }, [ _('Hardware Model') ]),
							E('td', { 'style': 'font-weight: 600;' }, [ model + ' (' + boardName + ')' ])
						]),
						E('tr', {}, [
							E('td', { 'style': 'font-weight: 700; color: #475569;' }, [ _('Kernel Architecture') ]),
							E('td', { 'style': 'font-weight: 600;' }, [ kernel ])
						]),
						E('tr', {}, [
							E('td', { 'style': 'font-weight: 700; color: #475569;' }, [ _('Traffic Engine') ]),
							E('td', { 'style': 'font-weight: 600;' }, [ 'nftables (isolated netmon_acct & netmon_qos tables)' ])
						]),
						E('tr', {}, [
							E('td', { 'style': 'font-weight: 700; color: #475569;' }, [ _('Resource Overhead') ]),
							E('td', { 'style': 'color: #059669; font-weight: 700;' }, [ _('< 150 KB RAM / Zero firewall disruption') ])
						])
					])
				])
			]),

			// Developer & Contact Card
			E('div', { 'class': 'about-card' }, [
				E('h3', { 'style': 'font-size: 14px !important; font-weight: 800 !important; color: #0f172a; margin-bottom: 16px;' }, [ _('Owner & Support') ]),
				E('div', { 'class': 'table-responsive' }, [
					E('table', { 'class': 'about-table' }, [
						E('tr', {}, [
							E('td', { 'style': 'font-weight: 700; width: 220px; color: #475569;' }, [ _('Developer') ]),
							E('td', { 'style': 'font-weight: 700; color: #0f172a;' }, [ 'Yeasin Arafat' ])
						]),
						E('tr', {}, [
							E('td', { 'style': 'font-weight: 700; color: #475569;' }, [ _('Business / Service') ]),
							E('td', {}, [
								E('a', {
									'href': '#',
									'target': '_blank',
									'rel': 'noopener noreferrer',
									'style': 'color: #4f46e5; font-weight: 700; text-decoration: none; display: inline-flex; align-items: center; gap: 6px;'
								}, [
									'Sky Wifi'
								])
							])
						]),
						E('tr', {}, [
							E('td', { 'style': 'font-weight: 700; color: #475569;' }, [ _('Mobile / Support') ]),
							E('td', {}, [
								E('a', {
									'href': 'tel:+8801650121954',
									'target': '_blank',
									'rel': 'noopener noreferrer',
									'style': 'color: #0284c7; font-weight: 700; text-decoration: none; display: inline-flex; align-items: center; gap: 6px;'
								}, [
									'01650121954'
								])
							])
						])
					])
				])
			]),

			E('div', { 'style': 'text-align: center; color: #64748b; font-size: 12px !important; margin-top: 24px; font-weight: 600;' }, [
				_('Sky Wifi | Owner: Yeasin Arafat | Support: 01650121954')
			])
		]);

		return container;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
