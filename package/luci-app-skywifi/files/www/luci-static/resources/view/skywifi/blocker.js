'use strict';
'require view';
'require rpc';
'require ui';
'require dom';
'require uci';

var callGetUrlBlockStatus = rpc.declare({
	object: 'luci.skywifi',
	method: 'get_url_block_status',
	expect: {}
});

var callAddBlockedDomain = rpc.declare({
	object: 'luci.skywifi',
	method: 'add_blocked_domain',
	params: [ 'domain', 'mac', 'category' ],
	expect: {}
});

var callDeleteBlockedDomain = rpc.declare({
	object: 'luci.skywifi',
	method: 'delete_blocked_domain',
	params: [ 'section' ],
	expect: {}
});

var callToggleBlockedDomain = rpc.declare({
	object: 'luci.skywifi',
	method: 'toggle_blocked_domain',
	params: [ 'section', 'enabled' ],
	expect: {}
});

var callSetAntiBypassOptions = rpc.declare({
	object: 'luci.skywifi',
	method: 'set_antibypass_options',
	params: [ 'force_local_dns', 'block_encrypted_dns', 'tls_sni_filtering' ],
	expect: {}
});

var callAddVpnBlockDevice = rpc.declare({
	object: 'luci.skywifi',
	method: 'add_vpn_block_device',
	params: [ 'mac' ],
	expect: {}
});

var callDeleteVpnBlockDevice = rpc.declare({
	object: 'luci.skywifi',
	method: 'delete_vpn_block_device',
	params: [ 'mac' ],
	expect: {}
});

var callToggleVpnBlockDevice = rpc.declare({
	object: 'luci.skywifi',
	method: 'toggle_vpn_block_device',
	params: [ 'mac', 'enabled' ],
	expect: {}
});

var callGetDevices = rpc.declare({
	object: 'luci.skywifi',
	method: 'get_devices',
	expect: {}
});

var categories = [
	{
		id: 'social',
		label: 'Social Media',
		badgeColor: '#2563eb',
		bgColor: 'rgba(37, 99, 235, 0.08)',
		domains: ['facebook.com', 'instagram.com', 'tiktok.com', 'x.com', 'twitter.com', 'snapchat.com']
	},
	{
		id: 'streaming',
		label: 'Video Streaming',
		badgeColor: '#dc2626',
		bgColor: 'rgba(220, 38, 38, 0.08)',
		domains: ['youtube.com', 'netflix.com', 'twitch.tv', 'hulu.com', 'disneyplus.com']
	},
	{
		id: 'gaming',
		label: 'Gaming & Steam',
		badgeColor: '#7c3aed',
		bgColor: 'rgba(124, 58, 237, 0.08)',
		domains: ['steampowered.com', 'roblox.com', 'epicgames.com', 'discord.com']
	}
];

return view.extend({
	load: function() {
		return Promise.all([
			callGetUrlBlockStatus().catch(function() { return {}; }),
			callGetDevices().catch(function() { return {}; })
		]);
	},

	render: function(data) {
		var status = data[0] || {};
		var devicesData = data[1] || {};
		var devicesList = devicesData.devices || [];
		var domainsList = status.domains || [];
		var vpnDevicesList = status.vpn_devices || [];

		// Custom CSS styling for modern professional UI without icons or emojis
		var styleTag = E('style', {}, [
			'.nx-container { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 1280px; margin: 0 auto; }',
			'.nx-header-card { background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%); color: #ffffff; border-radius: 14px; padding: 24px 28px; margin-bottom: 24px; box-shadow: 0 10px 25px -5px rgba(15, 23, 42, 0.3); display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 16px; }',
			'.nx-header-title { font-size: 1.5rem; font-weight: 800; margin: 0 0 6px 0; color: #ffffff; letter-spacing: -0.02em; }',
			'.nx-header-sub { font-size: 0.875rem; color: #94a3b8; margin: 0; max-width: 680px; line-height: 1.5; }',
			'.nx-grid-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 16px; margin-bottom: 24px; }',
			'.nx-stat-card { background: var(--color-bg, #ffffff); border: 1px solid var(--color-border, #e2e8f0); border-radius: 12px; padding: 18px 20px; position: relative; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.03); transition: transform 0.2s ease, box-shadow 0.2s ease; }',
			'.nx-stat-card:hover { transform: translateY(-2px); box-shadow: 0 8px 16px rgba(0,0,0,0.06); }',
			'.nx-stat-accent { position: absolute; top: 0; left: 0; right: 0; height: 4px; }',
			'.nx-stat-label { font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; margin-bottom: 8px; }',
			'.nx-stat-value { font-size: 1.6rem; font-weight: 800; color: var(--color-fg, #0f172a); line-height: 1.2; margin-bottom: 4px; }',
			'.nx-stat-desc { font-size: 0.775rem; color: #64748b; }',
			'.nx-section-card { background: var(--color-bg, #ffffff); border: 1px solid var(--color-border, #e2e8f0); border-radius: 14px; padding: 22px; margin-bottom: 24px; box-shadow: 0 2px 6px rgba(0,0,0,0.03); }',
			'.nx-section-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; flex-wrap: wrap; gap: 12px; border-bottom: 1px solid var(--color-border, #f1f5f9); padding-bottom: 12px; }',
			'.nx-section-title { font-size: 1.1rem; font-weight: 700; color: var(--color-fg, #0f172a); margin: 0; }',
			'.nx-section-sub { font-size: 0.85rem; color: #64748b; margin-top: 4px; }',
			'.nx-toggle-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; margin-bottom: 16px; }',
			'.nx-toggle-card { display: flex; align-items: flex-start; gap: 12px; padding: 16px; border: 1.5px solid var(--color-border, #cbd5e1); border-radius: 10px; background: var(--color-bg, #ffffff); cursor: pointer; transition: all 0.2s ease; user-select: none; }',
			'.nx-toggle-card:hover { border-color: #3b82f6; background: rgba(59, 130, 246, 0.02); }',
			'.nx-toggle-card.active { border-color: #2563eb; background: rgba(37, 99, 235, 0.04); box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1); }',
			'.nx-toggle-title { font-size: 0.95rem; font-weight: 700; color: var(--color-fg, #0f172a); margin-bottom: 2px; }',
			'.nx-toggle-sub { font-size: 0.775rem; color: #64748b; line-height: 1.4; }',
			'.nx-badge { display: inline-flex; align-items: center; padding: 4px 10px; border-radius: 9999px; font-size: 0.75rem; font-weight: 700; letter-spacing: 0.02em; }',
			'.nx-badge-active { background: #dcfce7; color: #15803d; border: 1px solid #bbf7d0; }',
			'.nx-badge-inactive { background: #f1f5f9; color: #64748b; border: 1px solid #e2e8f0; }',
			'.nx-badge-danger { background: #fee2e2; color: #b91c1c; border: 1px solid #fecaca; }',
			'.nx-badge-blue { background: #dbeafe; color: #1d4ed8; border: 1px solid #bfdbfe; }',
			'.nx-badge-purple { background: #f3e8ff; color: #6b21a8; border: 1px solid #e9d5ff; }',
			'.nx-badge-amber { background: #fef3c7; color: #b45309; border: 1px solid #fde68a; }',
			'.nx-preset-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px; margin-top: 14px; }',
			'.nx-preset-card { background: var(--color-bg-alt, #f8fafc); border: 1.5px solid var(--color-border, #e2e8f0); border-radius: 12px; padding: 16px; transition: all 0.2s ease; display: flex; flex-direction: column; justify-content: space-between; }',
			'.nx-preset-card:hover { border-color: #3b82f6; transform: translateY(-2px); box-shadow: 0 6px 12px rgba(0,0,0,0.05); }',
			'.nx-table-wrap { overflow-x: auto; border-radius: 10px; border: 1px solid var(--color-border, #e2e8f0); }',
			'.nx-table { width: 100%; border-collapse: collapse; text-align: left; }',
			'.nx-table th { background: var(--color-bg-alt, #f8fafc); color: #475569; font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; padding: 12px 16px; border-bottom: 1.5px solid var(--color-border, #e2e8f0); }',
			'.nx-table td { padding: 12px 16px; border-bottom: 1px solid var(--color-border, #f1f5f9); font-size: 0.875rem; vertical-align: middle; }',
			'.nx-table tr:last-child td { border-bottom: none; }',
			'.nx-table tr:hover td { background: rgba(59, 130, 246, 0.02); }',
			'.nx-btn { display: inline-flex; align-items: center; justify-content: center; font-weight: 600; font-size: 0.85rem; border-radius: 8px; padding: 8px 16px; cursor: pointer; transition: all 0.15s ease; border: 1px solid transparent; }',
			'.nx-btn-primary { background: #2563eb; color: #ffffff; }',
			'.nx-btn-primary:hover { background: #1d4ed8; }',
			'.nx-btn-danger { background: #ef4444; color: #ffffff; }',
			'.nx-btn-danger:hover { background: #dc2626; }',
			'.nx-btn-neutral { background: var(--color-bg-alt, #f1f5f9); color: #334155; border-color: #cbd5e1; }',
			'.nx-btn-neutral:hover { background: #e2e8f0; }',
			'.nx-input-group { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }',
			'.nx-input { height: 38px; border-radius: 8px; border: 1.5px solid var(--color-border, #cbd5e1); padding: 0 12px; font-size: 0.875rem; background: var(--color-bg, #ffffff); color: var(--color-fg, #0f172a); outline: none; transition: border-color 0.15s ease; }',
			'.nx-input:focus { border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.15); }',
			'.nx-select { height: 38px; border-radius: 8px; border: 1.5px solid var(--color-border, #cbd5e1); padding: 0 12px; font-size: 0.875rem; background: var(--color-bg, #ffffff); color: var(--color-fg, #0f172a); outline: none; transition: border-color 0.15s ease; }',
			'.nx-select:focus { border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.15); }',
			'.nx-filter-bar { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; margin-bottom: 16px; background: var(--color-bg-alt, #f8fafc); padding: 12px; border-radius: 10px; border: 1px solid var(--color-border, #e2e8f0); }'
		]);

		// Helper function for interactive table filtering
		function filterTableRows() {
			var searchVal = (document.getElementById('nx-search-input') ? document.getElementById('nx-search-input').value : '').toLowerCase().trim();
			var devVal = (document.getElementById('nx-filter-device') ? document.getElementById('nx-filter-device').value : '').toLowerCase();
			var catVal = (document.getElementById('nx-filter-category') ? document.getElementById('nx-filter-category').value : '').toLowerCase();

			var rows = document.querySelectorAll('.nx-domain-row');
			var visibleCount = 0;

			rows.forEach(function(row) {
				var dom = (row.getAttribute('data-domain') || '').toLowerCase();
				var mac = (row.getAttribute('data-mac') || '').toLowerCase();
				var cat = (row.getAttribute('data-category') || '').toLowerCase();

				var matchSearch = !searchVal || dom.indexOf(searchVal) !== -1 || mac.indexOf(searchVal) !== -1 || cat.indexOf(searchVal) !== -1;
				var matchDev = !devVal || devVal === 'all' || mac === devVal;
				var matchCat = !catVal || catVal === 'all' || cat === catVal;

				if (matchSearch && matchDev && matchCat) {
					row.style.display = '';
					visibleCount++;
				} else {
					row.style.display = 'none';
				}
			});

			var emptyMsg = document.getElementById('nx-domain-empty-row');
			if (emptyMsg) {
				emptyMsg.style.display = visibleCount === 0 ? '' : 'none';
			}
		}

		if (status.status === 'disabled' || status.enabled === '0') {
			return E('div', { 'class': 'nx-container' }, [
				styleTag,
				E('div', { 'style': 'background: #ffffff; border: 1.5px solid #e2e8f0; border-radius: 16px; padding: 42px 24px; text-align: center; max-width: 560px; margin: 40px auto; box-shadow: 0 4px 20px rgba(0,0,0,0.04); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;' }, [
					E('h3', { 'style': 'font-size: 1.25rem; font-weight: 800; color: #0f172a; margin-bottom: 8px;' }, [ _('Website Blocker Engine Disabled') ]),
					E('p', { 'style': 'color: #64748b; font-size: 0.9rem; margin-bottom: 24px; line-height: 1.5;' }, [ _('The Website Blocker engine is turned OFF in Settings (0% CPU Overhead). Enable it to activate domain sinkhole and dynamic IP filtering.') ]),
					E('a', {
						'style': 'display: inline-block; background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%); color: #ffffff; font-weight: 700; font-size: 0.875rem; padding: 10px 24px; border-radius: 8px; text-decoration: none; box-shadow: 0 4px 14px rgba(79, 70, 229, 0.3); transition: all 0.2s ease;',
						'href': L.url('admin/network/skywifi/settings')
					}, [ _('Go to Settings') ])
				])
			]);
		}

		// Main container layout
		var container = E('div', { 'class': 'nx-container', 'id': 'nx-blocker-map' }, [
			styleTag,

			// 1. Overview Stats Cards Grid
			E('div', { 'class': 'nx-grid-stats' }, [
				E('div', { 'class': 'nx-stat-card' }, [
					E('div', { 'class': 'nx-stat-accent', 'style': 'background: #ef4444;' }),
					E('div', { 'class': 'nx-stat-label' }, [ _('Blocked Domains') ]),
					E('div', { 'class': 'nx-stat-value' }, [ String(domainsList.length) ]),
					E('div', { 'class': 'nx-stat-desc' }, [ _('Active domain filter rules') ])
				]),
				E('div', { 'class': 'nx-stat-card' }, [
					E('div', { 'class': 'nx-stat-accent', 'style': 'background: ' + (status.tls_sni_filtering === '1' ? '#10b981' : '#f59e0b') + ';' }),
					E('div', { 'class': 'nx-stat-label' }, [ _('Direct IP Defense') ]),
					E('div', { 'class': 'nx-stat-value', 'style': 'font-size: 1.25rem; font-weight: 700; color: ' + (status.tls_sni_filtering === '1' ? '#059669' : '#d97706') + ';' }, [
						status.tls_sni_filtering === '1' ? _('Active (Dynamic IP Sets)') : _('DNS-Only Mode')
					]),
					E('div', { 'class': 'nx-stat-desc' }, [ _('Port 80/443 IP packet filter') ])
				]),
				E('div', { 'class': 'nx-stat-card' }, [
					E('div', { 'class': 'nx-stat-accent', 'style': 'background: ' + (status.force_local_dns === '1' ? '#10b981' : '#f59e0b') + ';' }),
					E('div', { 'class': 'nx-stat-label' }, [ _('DNS Hijacking') ]),
					E('div', { 'class': 'nx-stat-value', 'style': 'font-size: 1.25rem; font-weight: 700; color: ' + (status.force_local_dns === '1' ? '#059669' : '#d97706') + ';' }, [
						status.force_local_dns === '1' ? _('Enforced (Port 53)') : _('Disabled')
					]),
					E('div', { 'class': 'nx-stat-desc' }, [ _('Redirects Port 53 to dnsmasq') ])
				]),
				E('div', { 'class': 'nx-stat-card' }, [
					E('div', { 'class': 'nx-stat-accent', 'style': 'background: ' + (status.block_encrypted_dns === '1' ? '#10b981' : '#f59e0b') + ';' }),
					E('div', { 'class': 'nx-stat-label' }, [ _('Encrypted DNS Shield') ]),
					E('div', { 'class': 'nx-stat-value', 'style': 'font-size: 1.25rem; font-weight: 700; color: ' + (status.block_encrypted_dns === '1' ? '#059669' : '#d97706') + ';' }, [
						status.block_encrypted_dns === '1' ? _('Blocked (DoH / DoT)') : _('Allowed')
					]),
					E('div', { 'class': 'nx-stat-desc' }, [ _('Blocks Port 853 & DoH endpoints') ])
				])
			]),

			// 3. Anti-Bypass Protection Suite Card
			E('div', { 'class': 'nx-section-card' }, [
				E('div', { 'class': 'nx-section-head' }, [
					E('div', {}, [
						E('h3', { 'class': 'nx-section-title' }, [
							_('Anti-Bypass Protection Suite')
						]),
						E('div', { 'class': 'nx-section-sub' }, [
							_('Configure system-wide shields to prevent browser DNS overrides, DoH protocol smuggling, and direct IP bypass.')
						])
					])
				]),

				E('div', { 'class': 'nx-toggle-grid' }, [
					E('div', {
						'class': 'nx-toggle-card' + (status.force_local_dns === '1' ? ' active' : ''),
						'click': function() {
							var chk = document.getElementById('chk-force-dns');
							if (chk) {
								chk.checked = !chk.checked;
								this.classList.toggle('active', chk.checked);
							}
						}
					}, [
						E('input', {
							'type': 'checkbox',
							'id': 'chk-force-dns',
							'checked': status.force_local_dns === '1',
							'style': 'margin-top: 3px; cursor: pointer;',
							'change': function(ev) {
								ev.target.closest('.nx-toggle-card').classList.toggle('active', ev.target.checked);
							}
						}),
						E('div', {}, [
							E('div', { 'class': 'nx-toggle-title' }, [ _('Force Local DNS (DNS Hijack)') ]),
							E('div', { 'class': 'nx-toggle-sub' }, [ _('Forces all outgoing port 53 DNS queries to route through the router dnsmasq sinkhole.') ])
						])
					]),

					E('div', {
						'class': 'nx-toggle-card' + (status.block_encrypted_dns === '1' ? ' active' : ''),
						'click': function() {
							var chk = document.getElementById('chk-block-doh');
							if (chk) {
								chk.checked = !chk.checked;
								this.classList.toggle('active', chk.checked);
							}
						}
					}, [
						E('input', {
							'type': 'checkbox',
							'id': 'chk-block-doh',
							'checked': status.block_encrypted_dns === '1',
							'style': 'margin-top: 3px; cursor: pointer;',
							'change': function(ev) {
								ev.target.closest('.nx-toggle-card').classList.toggle('active', ev.target.checked);
							}
						}),
						E('div', {}, [
							E('div', { 'class': 'nx-toggle-title' }, [ _('Block Encrypted DNS (DoH / DoT)') ]),
							E('div', { 'class': 'nx-toggle-sub' }, [ _('Blocks DoT (Port 853) and known public DNS-over-HTTPS (DoH) resolver IP ranges.') ])
						])
					]),

					E('div', {
						'class': 'nx-toggle-card' + (status.tls_sni_filtering === '1' ? ' active' : ''),
						'click': function() {
							var chk = document.getElementById('chk-tls-sni');
							if (chk) {
								chk.checked = !chk.checked;
								this.classList.toggle('active', chk.checked);
							}
						}
					}, [
						E('input', {
							'type': 'checkbox',
							'id': 'chk-tls-sni',
							'checked': status.tls_sni_filtering === '1',
							'style': 'margin-top: 3px; cursor: pointer;',
							'change': function(ev) {
								ev.target.closest('.nx-toggle-card').classList.toggle('active', ev.target.checked);
							}
						}),
						E('div', {}, [
							E('div', { 'class': 'nx-toggle-title', 'style': 'color: #dc2626;' }, [ _('Direct IP Blocking (Dynamic Sets)') ]),
							E('div', { 'class': 'nx-toggle-sub' }, [ _('Drops connections to resolved IPs of blocked websites, preventing IP/Hosts modifications.') ])
						])
					])
				]),

				E('div', { 'style': 'display: flex; justify-content: flex-end; margin-top: 18px;' }, [
					E('button', {
						'class': 'nx-btn nx-btn-primary',
						'click': function(ev) {
							ui.showModal(_('Applying Anti-Bypass Settings'), [
								E('p', { 'class': 'spinning' }, [ _('Updating firewall rules and DNS configurations...') ])
							]);
							callSetAntiBypassOptions(
								document.getElementById('chk-force-dns').checked ? '1' : '0',
								document.getElementById('chk-block-doh').checked ? '1' : '0',
								document.getElementById('chk-tls-sni').checked ? '1' : '0'
							).then(function() {
								ui.hideModal();
								ui.addNotification(null, E('p', [ _('Anti-bypass protection settings updated successfully!') ]), 'info');
								setTimeout(function() { window.location.reload(); }, 300);
							}).catch(function(err) {
								ui.hideModal();
								ui.addNotification(null, E('p', [ _('Failed to update settings: ') + (err.message || err) ]), 'error');
							});
						}
					}, [
						_('Save Protection Settings')
					])
				])
			]),

			// 4. VPN Protocol Block Section (Per-Device)
			E('div', { 'class': 'nx-section-card' }, [
				E('div', { 'class': 'nx-section-head' }, [
					E('div', {}, [
						E('h3', { 'class': 'nx-section-title' }, [
							_('VPN Protocol Shield (Per-Device)')
						]),
						E('div', { 'class': 'nx-section-sub' }, [
							_('Block standard VPN tunnel protocols (Cloudflare WARP, WireGuard, OpenVPN, IPsec, L2TP, PPTP) for specific network devices.')
						])
					])
				]),

				E('div', { 'style': 'background: var(--color-bg-alt, #f8fafc); border: 1.5px solid var(--color-border, #e2e8f0); border-radius: 12px; padding: 18px; margin-bottom: 20px;' }, [
					E('h4', { 'style': 'margin: 0 0 12px 0; font-weight: 700; font-size: 0.95rem; color: var(--color-fg, #0f172a);' }, [
						_('Add Device to VPN Block List')
					]),
					E('div', { 'class': 'nx-input-group' }, [
						E('select', { 'id': 'sel-vpn-mac', 'class': 'nx-select', 'style': 'flex: 1; min-width: 240px;' }, [
							E('option', { 'value': 'all' }, [ _('All Connected Devices (Global)') ])
						].concat(devicesList.map(function(d) {
							var label = (d.hostname || d.ip || d.mac) + ' (' + d.mac + ')';
							return E('option', { 'value': d.mac }, [ label ]);
						}))),
						E('button', {
							'class': 'nx-btn nx-btn-primary',
							'click': function() {
								var macSelect = document.getElementById('sel-vpn-mac');
								if (!macSelect) return;
								var mac = macSelect.value;
								ui.showModal(_('Adding VPN Shield Rule'), [
									E('p', { 'class': 'spinning' }, [ _('Applying per-device VPN block rule...') ])
								]);
								callAddVpnBlockDevice(mac).then(function(res) {
									ui.hideModal();
									if (res && res.error) {
										ui.addNotification(null, E('p', [ _('Failed to add VPN rule: ') + res.error ]), 'error');
									} else {
										ui.addNotification(null, E('p', [ _('VPN block rule added successfully!') ]), 'info');
										setTimeout(function() { window.location.reload(); }, 300);
									}
								}).catch(function(err) {
									ui.hideModal();
									ui.addNotification(null, E('p', [ _('Failed to add VPN rule: ') + (err.message || err) ]), 'error');
								});
							}
						}, [
							_('Add VPN Block Rule')
						])
					])
				]),

				// Table of VPN Rules
				vpnDevicesList.length === 0 ?
					E('div', { 'style': 'text-align: center; padding: 36px 20px; color: #94a3b8; border: 2px dashed var(--color-border, #cbd5e1); border-radius: 12px;' }, [
						E('div', { 'style': 'font-weight: 700; margin-top: 4px; color: #64748b;' }, [ _('No VPN Protocol Rules Active') ]),
						E('div', { 'style': 'font-size: 0.85rem; margin-top: 4px;' }, [ _('Select a client device above to block WireGuard, OpenVPN, IPsec, and PPTP ports.') ])
					]) :
					E('div', { 'class': 'nx-table-wrap' }, [
						E('table', { 'class': 'nx-table' }, [
							E('thead', {}, [
								E('tr', {}, [
									E('th', {}, [ _('Target Device') ]),
									E('th', {}, [ _('Status') ]),
									E('th', { 'style': 'text-align: right;' }, [ _('Actions') ])
								])
							]),
							E('tbody', {}, vpnDevicesList.map(function(rule) {
								var targetLabel = _('All Devices (Global)');
								if (rule.mac && rule.mac !== 'all') {
									var matchedDev = devicesList.find(function(dev) {
										return dev.mac && dev.mac.toLowerCase() === rule.mac.toLowerCase();
									});
									targetLabel = matchedDev ? ((matchedDev.hostname ? matchedDev.hostname + ' ' : '') + '(' + rule.mac + ')') : rule.mac;
								}

								return E('tr', {}, [
									E('td', { 'style': 'font-weight: 700; color: var(--color-fg, #0f172a);' }, [ targetLabel ]),
									E('td', {}, [
										E('button', {
											'class': 'nx-badge ' + (rule.enabled === '1' ? 'nx-badge-danger' : 'nx-badge-inactive'),
											'style': 'cursor: pointer;',
											'click': function() {
												callToggleVpnBlockDevice(rule.mac, rule.enabled === '1' ? '0' : '1').then(function() {
													setTimeout(function() { window.location.reload(); }, 300);
												});
											}
										}, [
											rule.enabled === '1' ? _('VPN Blocked') : _('VPN Allowed')
										])
									]),
									E('td', { 'style': 'text-align: right;' }, [
										E('button', {
											'class': 'nx-btn nx-btn-danger',
											'style': 'padding: 4px 10px; font-size: 0.775rem;',
											'click': function() {
												if (confirm(_('Delete VPN protocol block rule for: ') + targetLabel + '?')) {
													callDeleteVpnBlockDevice(rule.mac).then(function() {
														setTimeout(function() { window.location.reload(); }, 300);
													});
												}
											}
										}, [
											_('Delete')
										])
									])
								]);
							}))
						])
					])
			]),

			// 5. Quick Category Presets Section
			E('div', { 'class': 'nx-section-card' }, [
				E('div', { 'class': 'nx-section-head' }, [
					E('div', {}, [
						E('h3', { 'class': 'nx-section-title' }, [
							_('Quick Category Presets')
						]),
						E('div', { 'class': 'nx-section-sub' }, [
							_('One-click preset bundles to instantly block major online platforms and domain groups.')
						])
					])
				]),

				E('div', { 'class': 'nx-preset-grid' }, categories.map(function(cat) {
					return E('div', { 'class': 'nx-preset-card' }, [
						E('div', {}, [
							E('div', { 'style': 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;' }, [
								E('div', { 'style': 'font-weight: 700; font-size: 1rem; color: var(--color-fg, #0f172a);' }, [ _(cat.label) ]),
								E('span', { 'class': 'nx-badge', 'style': 'background: ' + cat.bgColor + '; color: ' + cat.badgeColor + ';' }, [
									String(cat.domains.length) + ' ' + _('domains')
								])
							]),
							E('div', { 'style': 'display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 14px; margin-top: 6px;' }, cat.domains.slice(0, 3).map(function(d) {
								return E('span', { 'style': 'font-size: 0.725rem; background: var(--color-bg, #ffffff); border: 1px solid var(--color-border, #e2e8f0); border-radius: 4px; padding: 2px 6px; color: #64748b;' }, [ d ]);
							}).concat(cat.domains.length > 3 ? [ E('span', { 'style': 'font-size: 0.725rem; color: #94a3b8; padding: 2px 4px;' }, [ '+' + (cat.domains.length - 3) + ' ' + _('more') ]) ] : []))
						]),
						E('button', {
							'class': 'nx-btn nx-btn-neutral',
							'style': 'width: 100%; justify-content: center; font-size: 0.8rem;',
							'click': function() {
								ui.showModal(_('Add Preset Category: %s').format(cat.label), [
									E('p', { 'style': 'margin-bottom: 10px; font-size: 0.9rem; color: #475569;' }, [
										_('The following domain list will be added to your blocked rules:')
									]),
									E('div', { 'style': 'max-height: 180px; overflow-y: auto; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px; margin-bottom: 16px;' }, [
										E('ul', { 'style': 'margin: 0; padding-left: 20px; font-family: monospace; font-size: 0.85rem; color: #334155;' }, cat.domains.map(function(d) {
											return E('li', {}, [ d ]);
										}))
									]),
									E('div', { 'style': 'display: flex; gap: 10px; justify-content: flex-end;' }, [
										E('button', {
											'class': 'nx-btn nx-btn-neutral',
											'click': ui.hideModal
										}, [ _('Cancel') ]),
										E('button', {
											'class': 'nx-btn nx-btn-primary',
											'click': function() {
												ui.showModal(_('Adding Presets'), [
													E('p', { 'class': 'spinning' }, [ _('Writing category domain block rules...') ])
												]);
												Promise.all(cat.domains.map(function(d) {
													return callAddBlockedDomain(d, 'all', cat.id);
												})).then(function() {
													ui.hideModal();
													ui.addNotification(null, E('p', [ _('Preset category added successfully!') ]), 'info');
													setTimeout(function() { window.location.reload(); }, 300);
												}).catch(function(err) {
													ui.hideModal();
													ui.addNotification(null, E('p', [ _('Error adding presets: ') + err ]), 'error');
												});
											}
										}, [
											_('Add All Domains')
										])
									])
								]);
							}
						}, [
							_('Add Preset Category')
						])
					]);
				}))
			]),

			// 6. Blocked Domain Rules Section & Form
			E('div', { 'class': 'nx-section-card' }, [
				E('div', { 'class': 'nx-section-head' }, [
					E('div', {}, [
						E('h3', { 'class': 'nx-section-title' }, [
							_('Blocked Website & Domain Rules')
						]),
						E('div', { 'class': 'nx-section-sub' }, [
							_('Manage individual site block rules, wildcard domain patterns, and device assignment.')
						])
					])
				]),

				// Add Rule Form Box
				E('div', { 'style': 'background: var(--color-bg-alt, #f8fafc); border: 1.5px solid var(--color-border, #e2e8f0); border-radius: 12px; padding: 18px; margin-bottom: 20px;' }, [
					E('h4', { 'style': 'margin: 0 0 12px 0; font-weight: 700; font-size: 0.95rem; color: var(--color-fg, #0f172a);' }, [
						_('Add New Block Rule')
					]),
					E('div', { 'class': 'nx-input-group' }, [
						E('input', {
							'type': 'text',
							'id': 'txt-new-domain',
							'class': 'nx-input',
							'placeholder': 'e.g. facebook.com or *.tiktok.com',
							'style': 'flex: 2; min-width: 220px;'
						}),
						E('select', {
							'id': 'sel-target-mac',
							'class': 'nx-select',
							'style': 'flex: 1; min-width: 180px;'
						}, [
							E('option', { 'value': 'all' }, [ _('All Devices (Global)') ])
						].concat(devicesList.map(function(d) {
							var label = (d.hostname || d.ip || d.mac) + ' (' + d.mac + ')';
							return E('option', { 'value': d.mac }, [ label ]);
						}))),
						E('select', {
							'id': 'sel-category',
							'class': 'nx-select',
							'style': 'width: 140px;'
						}, [
							E('option', { 'value': 'custom' }, [ _('Custom') ]),
							E('option', { 'value': 'social' }, [ _('Social Media') ]),
							E('option', { 'value': 'streaming' }, [ _('Streaming') ]),
							E('option', { 'value': 'gaming' }, [ _('Gaming') ]),
							E('option', { 'value': 'vpn' }, [ _('VPN') ])
						]),
						E('button', {
							'class': 'nx-btn nx-btn-primary',
							'click': function() {
								var domainInput = document.getElementById('txt-new-domain').value.trim();
								var macSelect = document.getElementById('sel-target-mac').value;
								var catSelect = document.getElementById('sel-category').value;
								if (!domainInput) {
									ui.addNotification(null, E('p', [ _('Please enter a valid domain name!') ]), 'error');
									return;
								}
								// Strip URL schemes, subpaths, queries, ports
								var cleanDomain = domainInput
									.toLowerCase()
									.replace(/^https?:\/\//i, '')
									.replace(/^www\./i, '')
									.split('/')[0]
									.split('?')[0]
									.split('#')[0]
									.split(':')[0]
									.trim();

								if (!cleanDomain) {
									ui.addNotification(null, E('p', [ _('Invalid domain format!') ]), 'error');
									return;
								}

								ui.showModal(_('Adding Domain Rule'), [
									E('p', { 'class': 'spinning' }, [ _('Saving domain block rule...') ])
								]);
								callAddBlockedDomain(cleanDomain, macSelect, catSelect).then(function(res) {
									ui.hideModal();
									if (res && res.error) {
										ui.addNotification(null, E('p', [ _('Failed to add rule: ') + res.error ]), 'error');
									} else {
										ui.addNotification(null, E('p', [ _('Domain rule added successfully!') ]), 'info');
										setTimeout(function() { window.location.reload(); }, 300);
									}
								}).catch(function(err) {
									ui.hideModal();
									ui.addNotification(null, E('p', [ _('Failed to add rule: ') + (err.message || err) ]), 'error');
								});
							}
						}, [
							_('Add Block Rule')
						])
					])
				]),

				// Live Filter Controls Bar
				E('div', { 'class': 'nx-filter-bar' }, [
					E('div', { 'style': 'display: flex; align-items: center; gap: 8px; flex: 1; min-width: 200px;' }, [
						E('input', {
							'type': 'text',
							'id': 'nx-search-input',
							'class': 'nx-input',
							'placeholder': _('Search domains, device MAC, or category...'),
							'style': 'width: 100%; border-color: #cbd5e1;',
							'input': filterTableRows
						})
					]),
					E('div', { 'style': 'display: flex; gap: 10px;' }, [
						E('select', {
							'id': 'nx-filter-device',
							'class': 'nx-select',
							'change': filterTableRows
						}, [
							E('option', { 'value': 'all' }, [ _('All Targets') ]),
							E('option', { 'value': 'all_only' }, [ _('Global Rules Only') ])
						].concat(devicesList.map(function(d) {
							return E('option', { 'value': d.mac.toLowerCase() }, [ (d.hostname || d.mac) ]);
						}))),
						E('select', {
							'id': 'nx-filter-category',
							'class': 'nx-select',
							'change': filterTableRows
						}, [
							E('option', { 'value': 'all' }, [ _('All Categories') ]),
							E('option', { 'value': 'custom' }, [ _('Custom') ]),
							E('option', { 'value': 'social' }, [ _('Social Media') ]),
							E('option', { 'value': 'streaming' }, [ _('Video Streaming') ]),
							E('option', { 'value': 'gaming' }, [ _('Gaming') ]),
							E('option', { 'value': 'vpn' }, [ _('Public VPN') ])
						])
					])
				]),

				// Domain Rules Table
				domainsList.length === 0 ?
					E('div', { 'style': 'text-align: center; padding: 40px 20px; color: #94a3b8; border: 2px dashed var(--color-border, #cbd5e1); border-radius: 12px;' }, [
						E('div', { 'style': 'font-weight: 700; margin-top: 4px; color: #64748b; font-size: 1rem;' }, [ _('No Blocked Domains Configured') ]),
						E('div', { 'style': 'font-size: 0.85rem; margin-top: 4px;' }, [ _('Add a domain rule above or pick a quick category preset bundle!') ])
					]) :
					E('div', { 'class': 'nx-table-wrap' }, [
						E('table', { 'class': 'nx-table', 'id': 'nx-domain-table' }, [
							E('thead', {}, [
								E('tr', {}, [
									E('th', {}, [ _('Blocked Domain / URL') ]),
									E('th', {}, [ _('Target Device') ]),
									E('th', {}, [ _('Category') ]),
									E('th', {}, [ _('Status') ]),
									E('th', { 'style': 'text-align: right;' }, [ _('Actions') ])
								])
							]),
							E('tbody', {}, domainsList.map(function(rule) {
								var targetLabel = _('All Devices (Global)');
								if (rule.mac && rule.mac !== 'all') {
									var matchedDev = devicesList.find(function(dev) {
										return dev.mac && dev.mac.toLowerCase() === rule.mac.toLowerCase();
									});
									targetLabel = matchedDev ? ((matchedDev.hostname ? matchedDev.hostname + ' ' : '') + '(' + rule.mac + ')') : rule.mac;
								}

								var categoryObj = categories.find(function(c) { return c.id === rule.category; });
								var catLabel = categoryObj ? _(categoryObj.label) : (rule.category || 'custom');
								var catBadgeClass = 'nx-badge-inactive';
								if (rule.category === 'social') catBadgeClass = 'nx-badge-blue';
								else if (rule.category === 'streaming') catBadgeClass = 'nx-badge-danger';
								else if (rule.category === 'gaming') catBadgeClass = 'nx-badge-purple';
								else if (rule.category === 'vpn') catBadgeClass = 'nx-badge-amber';

								return E('tr', {
									'class': 'nx-domain-row',
									'data-domain': rule.domain || '',
									'data-mac': (rule.mac || 'all').toLowerCase(),
									'data-category': (rule.category || 'custom').toLowerCase()
								}, [
									E('td', { 'style': 'font-weight: 700; font-family: monospace; color: var(--color-fg, #0f172a); font-size: 0.9rem;' }, [
										rule.domain
									]),
									E('td', {}, [
										E('span', { 'class': 'nx-badge nx-badge-inactive' }, [ targetLabel ])
									]),
									E('td', {}, [
										E('span', { 'class': 'nx-badge ' + catBadgeClass }, [ catLabel ])
									]),
									E('td', {}, [
										E('button', {
											'class': 'nx-badge ' + (rule.enabled === '1' ? 'nx-badge-active' : 'nx-badge-inactive'),
											'style': 'cursor: pointer;',
											'click': function() {
												callToggleBlockedDomain(rule.section, rule.enabled === '1' ? '0' : '1').then(function() {
													setTimeout(function() { window.location.reload(); }, 300);
												});
											}
										}, [
											rule.enabled === '1' ? _('Active (Blocked)') : _('Disabled')
										])
									]),
									E('td', { 'style': 'text-align: right;' }, [
										E('button', {
											'class': 'nx-btn nx-btn-danger',
											'style': 'padding: 4px 10px; font-size: 0.775rem;',
											'click': function() {
												if (confirm(_('Delete block rule for domain: ') + rule.domain + '?')) {
													callDeleteBlockedDomain(rule.section).then(function() {
														setTimeout(function() { window.location.reload(); }, 300);
													});
												}
											}
										}, [
											_('Delete')
										])
									])
								]);
							}).concat([
								E('tr', { 'id': 'nx-domain-empty-row', 'style': 'display: none;' }, [
									E('td', { 'colspan': '5', 'style': 'text-align: center; padding: 24px; color: #94a3b8;' }, [
										_('No matching domain block rules found.')
									])
								])
							]))
						])
					])
			])
		]);

		return container;
	}
});
