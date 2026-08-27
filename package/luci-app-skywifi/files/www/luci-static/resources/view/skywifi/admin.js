'use strict';
'require view';
'require rpc';
'require ui';

var statusCall = rpc.declare({ object:'luci.skywifi', method:'skywifi_status', expect:{} });
var adminSet = rpc.declare({ object:'luci.skywifi', method:'skywifi_admin_set', params:['password','master'], expect:{} });
var adminCheck = rpc.declare({ object:'luci.skywifi', method:'skywifi_admin_check', params:['password'], expect:{} });
var portalSet = rpc.declare({ object:'luci.skywifi', method:'skywifi_set_enabled', params:['enabled','password'], expect:{} });
var devicesCall = rpc.declare({ object:'luci.skywifi', method:'get_devices', expect:{} });
var deviceStatus = rpc.declare({ object:'luci.skywifi', method:'skywifi_device_status', params:['mac','password'], expect:{} });
var toggleBlock = rpc.declare({ object:'luci.skywifi', method:'toggle_block', params:['target','block'], expect:{} });
var forgetDevice = rpc.declare({ object:'luci.skywifi', method:'skywifi_forget_device', params:['mac','password'], expect:{} });
var resetSkyWifi = rpc.declare({ object:'luci.skywifi', method:'skywifi_reset', params:['password'], expect:{} });

function esc(v) { return String(v == null ? '' : v); }
function fmtBytes(n) {
	n=Number(n||0);
	if(n<1024) return n+' B';
	if(n<1048576) return (n/1024).toFixed(1)+' KB';
	if(n<1073741824) return (n/1048576).toFixed(1)+' MB';
	return (n/1073741824).toFixed(2)+' GB';
}
function fmtSpeed(n) { return fmtBytes(n)+'/s'; }

return view.extend({
	render:function(){
		var self=this, adminPw='', portal=E('strong',{},[_('Checking...')]);
		var deviceBox=E('div',{style:'overflow:auto;'},[_('Admin authentication required.')]);

		function askPassword(cb) {
			var pw=E('input',{type:'password',class:'cbi-input-text',style:'width:100%;height:40px;',placeholder:_('Admin password')});
			ui.showModal(_('Sky Wifi Admin Access'),[
				E('p',{},[_('Enter the Admin password to manage devices and portal access.')]),pw,
				E('div',{class:'right',style:'margin-top:12px'},[
					E('button',{class:'btn cbi-button cbi-button-neutral',click:ui.hideModal},[_('Cancel')]),
					E('button',{class:'btn cbi-button cbi-button-positive',click:function(){
						adminCheck(pw.value).then(function(r){
							if(r && r.valid){ adminPw=pw.value; ui.hideModal(); cb(adminPw); return; }
							statusCall().then(function(st){
								if(st && st.admin_configured===0){
									adminSet(pw.value,'').then(function(sr){
										if(sr && sr.status==='ok'){ adminPw=pw.value; ui.hideModal(); cb(adminPw); ui.addNotification(null,E('p',{},[_('Admin password created successfully.')])) }
										else ui.addNotification(null,E('p',{},[sr&&sr.error||_('Unable to create Admin password.')]),'error');
									});
								} else ui.addNotification(null,E('p',{},[_('Invalid Admin password.')]),'error');
							});
						});
					}},[_('Continue')])
				])
			]);
		}

		function refreshStatus(){
			statusCall().then(function(r){ var en=!!(r&&r.portal_enabled===1); portal.textContent=en?_('ENABLED'):_('DISABLED'); updatePortalButtons(en); });
		}

		function showDetails(d){
			ui.showModal(_('Device Details'),[
				E('table',{class:'table'},[
					E('tr',{},[E('th',{},[_('Hostname')]),E('td',{},[esc(d.hostname||'Unknown')])]),
					E('tr',{},[E('th',{},[_('IP Address')]),E('td',{},[esc(d.ip||'-')])]),
					E('tr',{},[E('th',{},[_('MAC Address')]),E('td',{},[esc(d.mac||'-')])]),
					E('tr',{},[E('th',{},[_('Status')]),E('td',{},[d.online?_('Online'):_('Offline')])]),
					E('tr',{},[E('th',{},[_('Connection')]),E('td',{},[esc(d.conn_type||'-')])]),
					E('tr',{},[E('th',{},[_('Download Speed')]),E('td',{},[fmtSpeed(d.rx_speed)])]),
					E('tr',{},[E('th',{},[_('Upload Speed')]),E('td',{},[fmtSpeed(d.tx_speed)])]),
					E('tr',{},[E('th',{},[_('Download Total')]),E('td',{},[fmtBytes(d.rx_bytes)])]),
					E('tr',{},[E('th',{},[_('Upload Total')]),E('td',{},[fmtBytes(d.tx_bytes)])]),
					E('tr',{},[E('th',{},[_('Total Traffic')]),E('td',{},[fmtBytes(d.total_bytes)])])
				]),
				E('div',{class:'right'},[E('button',{class:'btn cbi-button cbi-button-neutral',click:ui.hideModal},[_('Close')])])
			]);
		}

		function renderDevices(data){
			var list=(data&&data.devices)||[];
			deviceBox.innerHTML='';
			if(!list.length){ deviceBox.appendChild(E('p',{style:'padding:18px;color:#64748b'},[_('No devices discovered.') ])); return; }
			var table=E('table',{class:'table cbi-section-table',style:'width:100%;'},[
				E('tr',{},[
					E('th',{},[_('Status')]),E('th',{},[_('Device')]),E('th',{},[_('IP')]),
					E('th',{},[_('MAC')]),E('th',{},[_('Traffic')]),E('th',{},[_('Actions')])
				])
			]);
			list.forEach(function(d){
				var actions=E('div',{style:'display:flex;gap:5px;flex-wrap:wrap;'});
				actions.appendChild(E('button',{class:'btn cbi-button cbi-button-neutral',click:function(){showDetails(d);}},[_('Details')]));
				(function(dev){
					deviceStatus(dev.mac,adminPw).then(function(s){
						var blocked=!!(s&&s.blocked);
						var b=E('button',{class:'btn '+(blocked?'cbi-button-positive':'cbi-button-remove')},[blocked?_('Unblock'):_('Block')]);
						b.onclick=function(){
							b.disabled=true;
							toggleBlock(dev.mac,blocked?'0':'1',adminPw).then(function(r){
								if(r&&r.status==='ok'){ blocked=!blocked; b.textContent=blocked?_('Unblock'):_('Block'); }
								else ui.addNotification(null,E('p',{},[r&&r.error||_('Action failed.')]),'error');
								b.disabled=false;
							});
						};
						actions.appendChild(b);
					});
				})(d);
				actions.appendChild(E('button',{class:'btn cbi-button cbi-button-remove',click:function(){
					ui.showModal(_('Forget Device'),[
						E('p',{},[_('This removes the stored device record and authorization. If the device reconnects, it must use a valid voucher again.')]),
						E('div',{class:'right'},[
							E('button',{class:'btn cbi-button cbi-button-neutral',click:ui.hideModal},[_('Cancel')]),
							E('button',{class:'btn cbi-button cbi-button-negative',click:function(){
								forgetDevice(d.mac,adminPw).then(function(r){ if(r&&r.status==='ok'){ui.hideModal();loadDevices();} else ui.addNotification(null,E('p',{},[r&&r.error||_('Unable to forget device.')]),'error'); });
							}},[_('Forget')])
						])
					]);
				}},[_('Delete')]));
				table.appendChild(E('tr',{},[
					E('td',{},[d.online?_('Online'):_('Offline')]),
					E('td',{},[esc(d.hostname||'Unknown')]),
					E('td',{},[esc(d.ip||'-')]),
					E('td',{style:'font-family:monospace'},[esc(d.mac||'-')]),
					E('td',{},[fmtBytes(d.total_bytes)]),
					E('td',{},[actions])
				]));
			});
			deviceBox.appendChild(table);
		}
		function loadDevices(){
			if(!adminPw){ askPassword(function(){ loadDevices(); }); return; }
			devicesCall().then(renderDevices).catch(function(){ deviceBox.innerHTML=''; deviceBox.appendChild(E('p',{style:'color:#b42318'},[_('Unable to load devices.') ])); });
		}

		var enableButton=E('button',{class:'btn cbi-button cbi-button-positive',click:function(){askPassword(function(pw){ portalSet('1',pw).then(function(r){ if(r&&r.portal_enabled===1){refreshStatus();ui.addNotification(null,E('p',{},[_('Portal enabled.')]))} else ui.addNotification(null,E('p',{},[r&&r.error||_('Unable to enable portal.')]),'error'); }); });}},[_('Enable Portal')]);
		var disableButton=E('button',{class:'btn cbi-button cbi-button-remove',click:function(){askPassword(function(pw){ portalSet('0',pw).then(function(r){ if(r&&r.portal_enabled===0){refreshStatus();ui.addNotification(null,E('p',{},[_('Portal disabled.')]))} else ui.addNotification(null,E('p',{},[r&&r.error||_('Unable to disable portal.')]),'error'); }); });}},[_('Disable Portal')]);
		function updatePortalButtons(en){ enableButton.style.display=en?'none':'inline-block'; disableButton.style.display=en?'inline-block':'none'; }
		var adminButton=E('button',{class:'btn cbi-button cbi-button-positive',click:function(){
			var np=E('input',{type:'password',class:'cbi-input-text',style:'width:100%;height:40px;',placeholder:_('New Admin password')});
			var old=E('input',{type:'password',class:'cbi-input-text',style:'width:100%;height:40px;margin-top:8px;',placeholder:_('Current Master password (only if already set)')});
			ui.showModal(_('Set Admin Password'),[
				E('p',{},[_('Minimum 8 characters. On first setup no Master password is required.')]),np,old,
				E('div',{class:'right',style:'margin-top:12px'},[
					E('button',{class:'btn cbi-button cbi-button-neutral',click:ui.hideModal},[_('Cancel')]),
					E('button',{class:'btn cbi-button cbi-button-positive',click:function(){
						adminSet(np.value,old.value).then(function(r){if(r&&r.status==='ok'){ui.hideModal();ui.addNotification(null,E('p',{},[_('Admin password saved.')]))}else ui.addNotification(null,E('p',{},[r&&r.error||_('Unable to save password.')]),'error');});
					}},[_('Save')])
				])
			]);
		}},[_('Admin Password')]);

		var resetButton=E('button',{class:'btn cbi-button cbi-button-remove',click:function(){
			askPassword(function(pw){ ui.showModal(_('Reset SkyWifi'),[
				E('p',{},[_('Are you sure? This will reset all SkyWifi data, vouchers, device authorizations and SkyWifi runtime state. OpenWrt, Wi-Fi, WAN, LAN and LuCI will remain intact.')]),
				E('div',{class:'right',style:'margin-top:12px'},[E('button',{class:'btn cbi-button cbi-button-neutral',click:ui.hideModal},[_('Cancel')]),E('button',{class:'btn cbi-button cbi-button-negative',click:function(){ resetSkyWifi(pw).then(function(r){ if(r&&r.status==='ok'){ui.hideModal();refreshStatus();ui.addNotification(null,E('p',{},[_('SkyWifi reset completed. Portal is disabled.')]))} else ui.addNotification(null,E('p',{},[r&&r.error||_('Reset failed.')]),'error'); }); }},[_('Reset SkyWifi')])])
		]); });
		}},[_('Reset SkyWifi')]);

		refreshStatus();
		return E('div',{class:'cbi-map'},[
			E('h2',{},[_('Sky Wifi — Admin Panel')]),
			E('div',{class:'cbi-section',style:'padding:18px;'},[
				E('h3',{},[_('Portal Control')]),
				E('p',{},[_('Portal is OFF by default after installation. Turn it ON only after first admin setup.')]),
				E('div',{style:'display:flex;gap:10px;align-items:center;flex-wrap:wrap;'},[E('strong',{},[_('Portal status: ')]),portal,enableButton,disableButton,adminButton,resetButton])
			]),
			E('div',{class:'cbi-section',style:'padding:18px;'},[
				E('h3',{},[_('Connected & Discovered Devices')]),
				E('p',{},[_('View details, block/unblock, or forget a device. A forgotten device will need a valid voucher when it reconnects.')]),
				E('button',{class:'btn cbi-button cbi-button-action',click:loadDevices},[_('Load / Refresh Devices')]),
				E('div',{style:'margin-top:12px;'},[deviceBox])
			])
		]);
	}
});
