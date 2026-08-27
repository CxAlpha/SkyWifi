'use strict';
'require view';
'require ui';
'require dom';
'require uci';

function createSwitch(id, checked, onChange) {
	var checkbox = E('input', {
		'type': 'checkbox',
		'id': id,
		'class': 'nx-switch-input',
		'checked': checked ? 'checked' : null
	});

	if (onChange) {
		checkbox.addEventListener('change', function(ev) {
			onChange(ev.target.checked);
		});
	}

	var slider = E('span', { 'class': 'nx-switch-slider' });
	var label = E('label', { 'class': 'nx-switch-label', 'for': id }, [ checkbox, slider ]);
	return { node: label, input: checkbox };
}

return view.extend({
	load: function() {
		return Promise.all([
			uci.load('skywifi').catch(function() { return {}; })
		]);
	},

	render: function() {
		// Read UCI values with defaults
		var storagePath = uci.get('skywifi', 'global', 'storage_path') || '/etc/skywifi/history';
		var syncInterval = uci.get('skywifi', 'global', 'sync_interval') || '5m';
		var customSyncInterval = uci.get('skywifi', 'global', 'custom_sync_interval') || '';
		var syncOnShutdown = uci.get('skywifi', 'global', 'sync_on_shutdown') !== '0';
		var retentionMonths = uci.get('skywifi', 'global', 'retention_months') || '12';

		var showTemp = uci.get('skywifi', 'global', 'show_temp') !== '0';
		var showSwap = uci.get('skywifi', 'global', 'show_swap') !== '0';

		var telegramEnabled = uci.get('skywifi', 'telegram', 'enabled') === '1';
		var botToken = uci.get('skywifi', 'telegram', 'bot_token') || '';
		var chatId = uci.get('skywifi', 'telegram', 'chat_id') || '';
		var telegramNotifications = uci.get('skywifi', 'telegram', 'notifications') !== '0';

		// Form Element References
		var storageSelect, customStorageInput, customStorageGroup;
		var syncSelect, customSyncInput, customSyncGroup;
		var syncOnShutdownObj, retentionSelect;
		var showTempObj, showSwapObj;
		var telegramSwitchObj, telegramTokenInput, telegramChatInput, telegramNotifObj, telegramConfigCard;

		// Badge Update Helper
		function updateBadge(badgeEl, isEnabled, activeText, disabledText) {
			if (!badgeEl) return;
			if (isEnabled) {
				badgeEl.className = 'nx-badge nx-badge-success';
				badgeEl.textContent = activeText || _('Active');
			} else {
				badgeEl.className = 'nx-badge nx-badge-danger';
				badgeEl.textContent = disabledText || _('Disabled');
			}
		}

		// Stat Summary Badge
		var telegramStatBadge = E('span', { 'class': telegramEnabled ? 'nx-badge nx-badge-info' : 'nx-badge nx-badge-neutral' }, [ telegramEnabled ? _('Active') : _('Standby') ]);

		// Storage Directory Controls
		var isCustomStorage = ['/etc/skywifi/history', '/mnt/sda1/skywifi', '/overlay/skywifi'].indexOf(storagePath) === -1;
		
		customStorageInput = E('input', {
			'type': 'text',
			'class': 'nx-input',
			'placeholder': '/mnt/usb/skywifi/history',
			'value': isCustomStorage ? storagePath : ''
		});

		customStorageGroup = E('div', {
			'style': 'margin-top: 8px; display: ' + (isCustomStorage ? 'block' : 'none') + ';'
		}, [
			E('label', { 'class': 'nx-label' }, [ _('Custom Directory Path') ]),
			customStorageInput
		]);

		storageSelect = E('select', {
			'class': 'nx-select',
			'change': function(ev) {
				customStorageGroup.style.display = (ev.target.value === 'custom') ? 'block' : 'none';
			}
		}, [
			E('option', { 'value': '/etc/skywifi/history', 'selected': (storagePath === '/etc/skywifi/history') ? 'selected' : null }, [ _('/etc/skywifi/history (Default Flash)') ]),
			E('option', { 'value': '/mnt/sda1/skywifi', 'selected': (storagePath === '/mnt/sda1/skywifi') ? 'selected' : null }, [ _('/mnt/sda1/skywifi (External USB Drive)') ]),
			E('option', { 'value': '/overlay/skywifi', 'selected': (storagePath === '/overlay/skywifi') ? 'selected' : null }, [ _('/overlay/skywifi (Overlay Storage)') ]),
			E('option', { 'value': 'custom', 'selected': isCustomStorage ? 'selected' : null }, [ _('Custom Directory Path...') ])
		]);

		// Write Sync Interval Controls
		var syncIntervals = [
			{ val: 'initial', text: _('Initial Write (Instant Sync)') },
			{ val: '5s', text: _('5 Seconds (5s)') },
			{ val: '10s', text: _('10 Seconds (10s)') },
			{ val: '30s', text: _('30 Seconds (30s)') },
			{ val: '1m', text: _('1 Minute (1m)') },
			{ val: '5m', text: _('5 Minutes (5m - Recommended)') },
			{ val: '10m', text: _('10 Minutes (10m)') },
			{ val: '15m', text: _('15 Minutes (15m)') },
			{ val: '30m', text: _('30 Minutes (30m)') },
			{ val: '1h', text: _('1 Hour (1h)') },
			{ val: '12h', text: _('12 Hours (12h)') },
			{ val: '24h', text: _('24 Hours (24h)') },
			{ val: 'custom', text: _('Custom Sync Interval...') }
		];

		var knownSync = syncIntervals.some(function(item) { return item.val === syncInterval; });
		var isCustomSync = !knownSync || syncInterval === 'custom';

		customSyncInput = E('input', {
			'type': 'text',
			'class': 'nx-input',
			'placeholder': '45s, 90m, or 3h',
			'value': isCustomSync ? (customSyncInterval || (knownSync ? '' : syncInterval)) : ''
		});

		customSyncGroup = E('div', {
			'style': 'margin-top: 8px; display: ' + (isCustomSync ? 'block' : 'none') + ';'
		}, [
			E('label', { 'class': 'nx-label' }, [ _('Custom Sync Duration Value') ]),
			customSyncInput,
			E('span', { 'class': 'nx-help-text' }, [ _('Example: 45s, 90m, 3h') ])
		]);

		syncSelect = E('select', {
			'class': 'nx-select',
			'change': function(ev) {
				customSyncGroup.style.display = (ev.target.value === 'custom') ? 'block' : 'none';
			}
		}, syncIntervals.map(function(item) {
			var isSelected = (syncInterval === item.val) || (isCustomSync && item.val === 'custom');
			return E('option', { 'value': item.val, 'selected': isSelected ? 'selected' : null }, [ item.text ]);
		}));

		syncOnShutdownObj = createSwitch('sw-shutdown', syncOnShutdown);

		retentionSelect = E('select', { 'class': 'nx-select' }, [
			E('option', { 'value': '3', 'selected': (retentionMonths === '3') ? 'selected' : null }, [ _('3 Months') ]),
			E('option', { 'value': '6', 'selected': (retentionMonths === '6') ? 'selected' : null }, [ _('6 Months') ]),
			E('option', { 'value': '12', 'selected': (retentionMonths === '12') ? 'selected' : null }, [ _('12 Months (Recommended)') ]),
			E('option', { 'value': '24', 'selected': (retentionMonths === '24') ? 'selected' : null }, [ _('24 Months') ]),
			E('option', { 'value': '0', 'selected': (retentionMonths === '0') ? 'selected' : null }, [ _('Keep Forever (No Limit)') ])
		]);

		// Dashboard Display Switches
		showTempObj = createSwitch('sw-temp', showTemp);
		showSwapObj = createSwitch('sw-swap', showSwap);

		// Telegram Bot Controls
		telegramTokenInput = E('input', {
			'type': 'password',
			'class': 'nx-input',
			'value': botToken,
			'placeholder': '123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ...'
		});

		var togglePassBtn = E('button', {
			'type': 'button',
			'class': 'nx-btn-secondary',
			'style': 'padding: 8px 14px; font-size: 12px; flex-shrink: 0;',
			'click': function() {
				if (telegramTokenInput.type === 'password') {
					telegramTokenInput.type = 'text';
					togglePassBtn.textContent = _('Hide Token');
				} else {
					telegramTokenInput.type = 'password';
					togglePassBtn.textContent = _('Show Token');
				}
			}
		}, [ _('Show Token') ]);

		telegramChatInput = E('input', {
			'type': 'text',
			'class': 'nx-input',
			'value': chatId,
			'placeholder': '123456789'
		});

		telegramNotifObj = createSwitch('sw-tgnotif', telegramNotifications);

		telegramConfigCard = E('div', {
			'style': 'margin-top: 16px; padding-top: 16px; border-top: 1px dashed var(--border-color, #e2e8f0); display: ' + (telegramEnabled ? 'block' : 'none') + ';'
		}, [
			E('div', { 'class': 'nx-grid-2' }, [
				E('div', { 'class': 'nx-form-group' }, [
					E('label', { 'class': 'nx-label' }, [ _('Telegram Bot Token') ]),
					E('div', { 'style': 'display: flex; gap: 8px; align-items: center;' }, [
						telegramTokenInput,
						togglePassBtn
					]),
					E('span', { 'class': 'nx-help-text' }, [ _('API Token generated via Telegram @BotFather.') ])
				]),

				E('div', { 'class': 'nx-form-group' }, [
					E('label', { 'class': 'nx-label' }, [ _('Authorized Chat ID') ]),
					telegramChatInput,
					E('span', { 'class': 'nx-help-text' }, [ _('Telegram User ID or Chat ID.') ])
				])
			]),

			E('div', { 'class': 'nx-field-row', 'style': 'margin-top: 12px;' }, [
				E('div', {}, [
					E('div', { 'class': 'nx-field-title' }, [ _('Alert Notifications') ]),
					E('div', { 'class': 'nx-field-desc' }, [ _('Send instant messages when quota limits are reached or access is blocked.') ])
				]),
				telegramNotifObj.node
			])
		]);

		telegramSwitchObj = createSwitch('sw-tg', telegramEnabled, function(val) {
			telegramConfigCard.style.display = val ? 'block' : 'none';
			updateBadge(telegramStatBadge, val, _('Active'), _('Standby'));
		});

		var alertBannerContainer = E('div', { 'id': 'nx-settings-alert-area' });

		// Main Layout Container
		var container = E('div', { 'class': 'cbi-map', 'id': 'skywifi-settings' }, [
			E('style', {}, [
				'#skywifi-settings { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: var(--text-color, #0f172a); font-size: 13px; }',
				
				'/* Summary Grid */',
				'.nx-summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 14px; margin-bottom: 20px; }',
				'.nx-stat-card { background: var(--card-bg, #ffffff); border-radius: 12px; padding: 14px 18px; border: 1px solid var(--border-color, #e2e8f0); box-shadow: 0 2px 8px rgba(0,0,0,0.02); display: flex; justify-content: space-between; align-items: center; }',
				'.nx-stat-title { font-weight: 700; font-size: 13px; color: var(--text-color, #0f172a); margin-bottom: 2px; }',
				'.nx-stat-sub { font-size: 11px; color: #64748b; font-weight: 500; }',

				'/* Card Styling */',
				'.nx-card { background: var(--card-bg, #ffffff); border-radius: 14px; padding: 20px; border: 1px solid var(--border-color, #e2e8f0); box-shadow: 0 3px 15px rgba(0,0,0,0.02); margin-bottom: 20px; }',
				'.nx-card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid var(--border-color, #e2e8f0); }',
				'.nx-card-title { font-size: 15px !important; font-weight: 800 !important; color: var(--text-color, #0f172a); margin: 0; }',
				'.nx-card-desc { font-size: 12px; color: #64748b; margin-top: 4px; font-weight: 400; line-height: 1.45; }',

				'/* Grid Layouts */',
				'.nx-grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; }',
				'.nx-grid-3 { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; }',

				'/* Engine Box */',
				'.nx-engine-box { background: var(--card-bg, #f8fafc); border: 1px solid var(--border-color, #e2e8f0); border-radius: 10px; padding: 16px; display: flex; flex-direction: column; justify-content: space-between; gap: 10px; transition: border-color 0.2s ease; }',
				'.nx-engine-box:hover { border-color: #6366f1; }',
				'.nx-engine-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; }',
				'.nx-engine-name { font-weight: 700; font-size: 13px; color: var(--text-color, #0f172a); margin-bottom: 4px; }',
				'.nx-engine-desc { font-size: 12px; color: #64748b; line-height: 1.4; }',

				'/* Switch Control */',
				'.nx-switch-label { position: relative; display: inline-block; width: 42px; height: 22px; flex-shrink: 0; cursor: pointer; }',
				'.nx-switch-input { opacity: 0; width: 0; height: 0; margin: 0; }',
				'.nx-switch-slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #cbd5e1; transition: .2s ease; border-radius: 22px; }',
				'.nx-switch-slider:before { position: absolute; content: ""; height: 16px; width: 16px; left: 3px; bottom: 3px; background-color: white; transition: .2s ease; border-radius: 50%; box-shadow: 0 1px 3px rgba(0,0,0,0.2); }',
				'.nx-switch-input:checked + .nx-switch-slider { background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%); }',
				'.nx-switch-input:checked + .nx-switch-slider:before { transform: translateX(20px); }',
				'.nx-switch-input:focus + .nx-switch-slider { box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.2); }',

				'/* Form Inputs */',
				'.nx-form-group { margin-bottom: 14px; }',
				'.nx-label { font-weight: 700; font-size: 12px; color: var(--text-color, #334155); display: block; margin-bottom: 5px; }',
				'.nx-input, .nx-select { width: 100%; height: 36px; border-radius: 8px; border: 1px solid var(--border-color, #cbd5e1); background: var(--card-bg, #ffffff); color: var(--text-color, #0f172a); padding: 0 10px; font-size: 13px; font-weight: 600; outline: none; transition: border-color 0.2s; box-sizing: border-box; }',
				'.nx-input:focus, .nx-select:focus { border-color: #6366f1; box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.15); }',
				'.nx-help-text { font-size: 11px; color: #64748b; margin-top: 4px; display: block; font-weight: 400; line-height: 1.35; }',

				'/* Field Row */',
				'.nx-field-row { display: flex; justify-content: space-between; align-items: center; padding: 12px 0; border-bottom: 1px solid var(--border-color, #f1f5f9); gap: 14px; }',
				'.nx-field-row:last-child { border-bottom: none; }',
				'.nx-field-title { font-weight: 700; font-size: 13px; color: var(--text-color, #0f172a); }',
				'.nx-field-desc { font-size: 12px; color: #64748b; margin-top: 2px; }',

				'/* Badges */',
				'.nx-badge { display: inline-flex; align-items: center; padding: 3px 9px; border-radius: 14px; font-weight: 700; font-size: 11px; text-transform: uppercase; letter-spacing: 0.02em; }',
				'.nx-badge-success { background: rgba(16, 185, 129, 0.12); color: #059669; border: 1px solid rgba(16, 185, 129, 0.2); }',
				'.nx-badge-danger { background: rgba(239, 68, 68, 0.12); color: #dc2626; border: 1px solid rgba(239, 68, 68, 0.2); }',
				'.nx-badge-info { background: rgba(99, 102, 241, 0.12); color: #4f46e5; border: 1px solid rgba(99, 102, 241, 0.2); }',
				'.nx-badge-neutral { background: rgba(100, 116, 139, 0.12); color: #475569; border: 1px solid rgba(100, 116, 139, 0.2); }',

				'/* Buttons */',
				'.nx-btn-primary { background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%); color: #ffffff !important; padding: 10px 22px; border-radius: 8px; font-weight: 800; font-size: 13px; border: none; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; box-shadow: 0 2px 10px rgba(79, 70, 229, 0.25); transition: opacity 0.2s ease; }',
				'.nx-btn-primary:hover { opacity: 0.92; }',
				'.nx-btn-secondary { background: #f1f5f9; color: #475569; padding: 10px 18px; border-radius: 8px; font-weight: 700; font-size: 13px; border: 1px solid #cbd5e1; cursor: pointer; transition: background 0.2s ease; }',
				'.nx-btn-secondary:hover { background: #e2e8f0; color: #0f172a; }',

				'/* Action Bar */',
				'.nx-action-bar { background: var(--card-bg, #ffffff); border: 1px solid var(--border-color, #e2e8f0); border-radius: 14px; padding: 14px 20px; display: flex; justify-content: space-between; align-items: center; box-shadow: 0 -2px 12px rgba(0,0,0,0.03); margin-top: 24px; }'
			]),

			// Alert Banner Container
			alertBannerContainer,

			// Header Title Banner
			E('div', { 'style': 'margin-bottom: 20px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;' }, [
				E('div', {}, [
					E('h2', { 'style': 'font-size: 18px !important; font-weight: 800 !important; color: var(--text-color, #0f172a); margin: 0;' }, [
						_('skywifi Settings')
					]),
					E('p', { 'style': 'font-size: 12px; color: #64748b; margin-top: 3px; font-weight: 400;' }, [
						_('Configure data persistence, dashboard display, and Telegram bot integration.')
					])
				]),
				E('div', { 'style': 'display: flex; gap: 8px;' }, [
					E('span', { 'class': 'nx-badge nx-badge-info' }, [ _('skywifi v1.2.0') ])
				])
			]),

			// Section 1: Storage & Data Persistence
			E('div', { 'class': 'nx-card' }, [
				E('div', { 'class': 'nx-card-header' }, [
					E('div', {}, [
						E('h3', { 'class': 'nx-card-title' }, [ _('Data Persistence & Storage') ]),
						E('div', { 'class': 'nx-card-desc' }, [
							_('Configure bandwidth stats storage path, write intervals, and retention policies.')
						])
					])
				]),

				E('div', { 'class': 'nx-grid-2' }, [
					E('div', { 'class': 'nx-form-group' }, [
						E('label', { 'class': 'nx-label' }, [ _('Persistent Storage Directory') ]),
						storageSelect,
						customStorageGroup,
						E('span', { 'class': 'nx-help-text' }, [ _('Directory where historical statistics are stored.') ])
					]),

					E('div', { 'class': 'nx-form-group' }, [
						E('label', { 'class': 'nx-label' }, [ _('Write Sync Interval') ]),
						syncSelect,
						customSyncGroup,
						E('span', { 'class': 'nx-help-text' }, [ _('Frequency of writing RAM statistics buffer to flash storage.') ])
					])
				]),

				E('div', { 'style': 'margin-top: 8px;' }, [
					E('div', { 'class': 'nx-field-row' }, [
						E('div', {}, [
							E('div', { 'class': 'nx-field-title' }, [ _('Auto-Sync on Reboot/Shutdown') ]),
							E('div', { 'class': 'nx-field-desc' }, [ _('Flushes memory buffer to persistent storage before reboot or shutdown.') ])
						]),
						syncOnShutdownObj.node
					]),

					E('div', { 'class': 'nx-field-row' }, [
						E('div', { 'style': 'flex: 1; padding-right: 16px;' }, [
							E('div', { 'class': 'nx-field-title' }, [ _('Data Retention Period') ]),
							E('div', { 'class': 'nx-field-desc' }, [ _('Automatically prune monthly archived files older than the retention period.') ])
						]),
						E('div', { 'style': 'width: 240px; max-width: 100%;' }, [
							retentionSelect
						])
					])
				])
			]),

			// Section 3: Dashboard Display Options
			E('div', { 'class': 'nx-card' }, [
				E('div', { 'class': 'nx-card-header' }, [
					E('div', {}, [
						E('h3', { 'class': 'nx-card-title' }, [ _('Dashboard Display') ]),
						E('div', { 'class': 'nx-card-desc' }, [
							_('Choose which system resource widgets appear on the main dashboard.')
						])
					])
				]),

				E('div', { 'class': 'nx-grid-2' }, [
					E('div', { 'class': 'nx-field-row', 'style': 'border-bottom: none; background: var(--card-bg, #f8fafc); border-radius: 10px; padding: 14px; border: 1px solid var(--border-color, #e2e8f0);' }, [
						E('div', {}, [
							E('div', { 'class': 'nx-field-title' }, [ _('Show SoC Temperature Tile') ]),
							E('div', { 'class': 'nx-field-desc' }, [ _('Display CPU thermal tile on dashboard.') ])
						]),
						showTempObj.node
					]),

					E('div', { 'class': 'nx-field-row', 'style': 'border-bottom: none; background: var(--card-bg, #f8fafc); border-radius: 10px; padding: 14px; border: 1px solid var(--border-color, #e2e8f0);' }, [
						E('div', {}, [
							E('div', { 'class': 'nx-field-title' }, [ _('Show Swap Memory Tile') ]),
							E('div', { 'class': 'nx-field-desc' }, [ _('Display swap memory utilization tile on dashboard.') ])
						]),
						showSwapObj.node
					])
				])
			]),

			// Section 4: Telegram Bot Integration
			E('div', { 'class': 'nx-card' }, [
				E('div', { 'class': 'nx-card-header' }, [
					E('div', {}, [
						E('h3', { 'class': 'nx-card-title' }, [ _('Telegram Bot Integration') ]),
						E('div', { 'class': 'nx-card-desc' }, [
							_('Configure Telegram bot for remote router monitoring and alerts.')
						])
					])
				]),

				E('div', { 'class': 'nx-field-row', 'style': 'border-bottom: none;' }, [
					E('div', {}, [
						E('div', { 'class': 'nx-field-title' }, [ _('Enable Telegram Bot') ]),
						E('div', { 'class': 'nx-field-desc' }, [ _('Launches background daemon for remote commands and status updates.') ])
					]),
					telegramSwitchObj.node
				]),

				telegramConfigCard
			]),

			// Section 5: Action Bar
			E('div', { 'class': 'nx-action-bar' }, [
				E('div', { 'style': 'font-weight: 500; font-size: 12px; color: #64748b;' }, [
					_('Save and apply settings to update system configuration.')
				]),
				E('div', { 'style': 'display: flex; gap: 10px; align-items: center;' }, [
					E('button', {
						'class': 'nx-btn-secondary',
						'click': function() {
							storageSelect.value = isCustomStorage ? 'custom' : storagePath;
							customStorageGroup.style.display = isCustomStorage ? 'block' : 'none';
							customStorageInput.value = isCustomStorage ? storagePath : '';

							syncSelect.value = knownSync ? syncInterval : 'custom';
							customSyncGroup.style.display = isCustomSync ? 'block' : 'none';
							customSyncInput.value = isCustomSync ? (customSyncInterval || syncInterval) : '';

							syncOnShutdownObj.input.checked = syncOnShutdown;
							retentionSelect.value = retentionMonths;

							showTempObj.input.checked = showTemp;
							showSwapObj.input.checked = showSwap;

							telegramSwitchObj.input.checked = telegramEnabled;
							telegramConfigCard.style.display = telegramEnabled ? 'block' : 'none';
							telegramTokenInput.value = botToken;
							telegramChatInput.value = chatId;
							telegramNotifObj.input.checked = telegramNotifications;

							ui.addNotification(null, E('p', {}, [ _('Settings form reset to saved UCI values.') ]));
						}
					}, [ _('Reset Changes') ]),

					E('button', {
						'class': 'nx-btn-primary',
						'click': function() {
							var selectedStorage = storageSelect.value;
							var finalStorage = (selectedStorage === 'custom') ? customStorageInput.value.trim() : selectedStorage;
							if (!finalStorage) finalStorage = '/etc/skywifi/history';

							var selectedSync = syncSelect.value;
							var finalSync = selectedSync;
							var finalCustomSync = '';
							if (selectedSync === 'custom') {
								finalCustomSync = customSyncInput.value.trim() || '5m';
								finalSync = 'custom';
							}

							var newSyncShutdown = syncOnShutdownObj.input.checked ? '1' : '0';
							var newRetention = retentionSelect.value;

							var newShowTemp = showTempObj.input.checked ? '1' : '0';
							var newShowSwap = showSwapObj.input.checked ? '1' : '0';

							var newTgEnabled = telegramSwitchObj.input.checked ? '1' : '0';
							var newTgToken = telegramTokenInput.value.trim();
							var newTgChat = telegramChatInput.value.trim();
							var newTgNotif = telegramNotifObj.input.checked ? '1' : '0';

							if (newTgEnabled === '1' && !newTgToken) {
								ui.addNotification(null, E('p', {}, [ _('Please enter a valid Telegram Bot Token before enabling Telegram Bot.') ]), 'error');
								return;
							}

							uci.set('skywifi', 'global', 'storage_path', finalStorage);
							uci.set('skywifi', 'global', 'sync_interval', finalSync);
							if (finalCustomSync) {
								uci.set('skywifi', 'global', 'custom_sync_interval', finalCustomSync);
							} else {
								uci.remove('skywifi', 'global', 'custom_sync_interval');
							}
							uci.set('skywifi', 'global', 'sync_on_shutdown', newSyncShutdown);
							uci.set('skywifi', 'global', 'retention_months', newRetention);

							uci.set('skywifi', 'global', 'show_temp', newShowTemp);
							uci.set('skywifi', 'global', 'show_swap', newShowSwap);

							uci.set('skywifi', 'telegram', 'enabled', newTgEnabled);
							uci.set('skywifi', 'telegram', 'bot_token', newTgToken);
							uci.set('skywifi', 'telegram', 'chat_id', newTgChat);
							uci.set('skywifi', 'telegram', 'notifications', newTgNotif);

							ui.addNotification(null, E('p', {}, [ _('Saving and applying settings...') ]));

							uci.save().then(function() {
								return uci.apply();
							}).then(function() {
								if (ui.changes && typeof ui.changes.init === 'function') {
									ui.changes.init();
								}
								uci.unload('skywifi');
								return uci.load('skywifi');
							}).then(function() {
								ui.addNotification(null, E('p', {}, [ _('Settings applied successfully!') ]));
							}).catch(function(err) {
								var errMsg = (err && err.message) ? err.message : String(err || '');
								if (errMsg.indexOf('ubus code 5') !== -1 || errMsg.indexOf('No data received') !== -1) {
									if (ui.changes && typeof ui.changes.init === 'function') {
										ui.changes.init();
									}
									uci.unload('skywifi');
									uci.load('skywifi');
									ui.addNotification(null, E('p', {}, [ _('Settings applied successfully!') ]));
								} else {
									ui.addNotification(null, E('p', {}, [ _('Settings saved, but applying could not be confirmed: %s').format(errMsg) ]), 'error');
								}
							});
						}
					}, [ _('Save & Apply Settings') ])
				])
			])
		]);

		return container;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
