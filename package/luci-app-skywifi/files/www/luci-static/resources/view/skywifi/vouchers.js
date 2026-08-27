'use strict';
'require view';
'require rpc';
'require ui';
'require poll';

var callStatus = rpc.declare({ object: 'luci.skywifi', method: 'skywifi_status', expect: {} });
var callList = rpc.declare({ object: 'luci.skywifi', method: 'skywifi_list_vouchers', params: ['password'], expect: {} });
var callGenerate = rpc.declare({ object: 'luci.skywifi', method: 'skywifi_generate', params: ['count','validity','password'], expect: {} });
var callRevoke = rpc.declare({ object: 'luci.skywifi', method: 'skywifi_revoke', params: ['code','password'], expect: {} });
var callAdminCheck = rpc.declare({ object: 'luci.skywifi', method: 'skywifi_admin_check', params: ['password'], expect: {} });
var callAdminSet = rpc.declare({ object: 'luci.skywifi', method: 'skywifi_admin_set', params: ['password','master'], expect: {} });
var callPortal = rpc.declare({ object: 'luci.skywifi', method: 'skywifi_set_enabled', params: ['enabled','password'], expect: {} });

function esc(s) { return String(s == null ? '' : s); }
function auth(cb) {
  callStatus().then(function(st) {
    var hasAdmin = false;
    var prompt = E('input', { type:'password', class:'cbi-input-text', placeholder: _('Admin password'), style:'width:100%;height:38px;' });
    ui.showModal(_('Sky Wifi Admin Access'), [
      E('p', {}, [_('Enter the Sky Wifi Admin password to manage vouchers and portal access.')]), prompt,
      E('div', { class:'right', style:'margin-top:12px' }, [
        E('button', { class:'btn cbi-button cbi-button-neutral', click:ui.hideModal }, [_('Cancel')]),
        E('button', { class:'btn cbi-button cbi-button-positive', click:function(){
          var pw=prompt.value||'';
          callAdminCheck(pw).then(function(r){
            if (r && r.valid) { ui.hideModal(); cb(pw); }
            else if (r && r.valid === false) {
              // On a fresh installation no admin password exists yet; allow
              // the first-time management page to open so the password can be set.
              callList('').then(function(x){
                if (x && x.status === 'ok') { ui.hideModal(); cb(''); }
                else ui.addNotification(null,E('p',{},[_('Invalid Admin password.')]),'error');
              });
            }
            else { ui.hideModal(); cb(pw); }
          });
        }}, [_('Continue')])
      ])
    ]);
  });
}

function renderRows(container, data, password) {
  container.innerHTML='';
  var list=(data&&data.vouchers)||[];
  if (!list.length) { container.appendChild(E('p',{style:'padding:18px;color:#64748b;'},[_('No vouchers found.') ])); return; }
  var table=E('table',{class:'table cbi-section-table',style:'width:100%;'},[
    E('tr',{},[E('th',{},[_('Code')]),E('th',{},[_('Plan')]),E('th',{},[_('Status')]),E('th',{},[_('Used By')]),E('th',{},[_('Device')]),E('th',{},[_('Expires')]),E('th',{},[_('Action')])])
  ]);
  list.forEach(function(v){
    var state=esc(v.state);
    var row=E('tr',{},[
      E('td',{style:'font-family:monospace;font-weight:800;'},[esc(v.code)]),
      E('td',{},[esc(v.plan)]), E('td',{},[state]),
      E('td',{},[v.customer ? esc(v.customer) + (v.mobile ? ' • ' + esc(v.mobile) : '') : _('Not used')]),
      E('td',{style:'font-family:monospace;font-size:12px;'},[v.device ? esc(v.device) : '—']),
      E('td',{},[v.expires && Number(v.expires)>0 ? new Date(Number(v.expires)*1000).toLocaleString() : _('Lifetime')]),
      E('td',{},[E('button',{class:'btn cbi-button cbi-button-remove',disabled:state==='REVOKED'||state==='EXPIRED',click:function(){
        callRevoke(v.code,password).then(function(r){ if(r&&r.status==='ok'){ ui.addNotification(null,E('p',{},[_('Voucher revoked.') ])); load(password); } else ui.addNotification(null,E('p',{},[_('Revoke failed.')]),'error'); });
      }},[_('Revoke')])])
    ]);
    table.appendChild(row);
  });
  container.appendChild(table);
}
function load(password){
  callList(password).then(function(r){ if(r&&r.error==='admin_auth_required'){auth(load);} else renderRows(document.getElementById('sky-voucher-list'),r,password); });
}

return view.extend({
  load: function(){ return Promise.resolve(); },
  render: function(){
    var self=this;
    var listBox=E('div',{id:'sky-voucher-list',style:'overflow:auto;'});
    var count=E('input',{type:'number',min:'1',max:'5000',value:'1',style:'width:100%;height:38px;'});
    var validity=E('select',{style:'width:100%;height:38px;'},[E('option',{value:'30d'},[_('30 Days')]),E('option',{value:'lifetime'},[_('Lifetime')])]);
    var status=E('span',{},[_('Loading...')]);
    var adminBtn=E('button',{class:'btn cbi-button cbi-button-neutral',click:function(){
      ui.showModal(_('Set Admin Password'),[
        E('p',{},[_('Minimum 8 characters. Leave Master password empty only during first setup.')]),
        E('input',{id:'sky-new-admin',type:'password',class:'cbi-input-text',placeholder:_('New Admin password'),style:'width:100%;height:38px;'}),
        E('input',{id:'sky-master',type:'password',class:'cbi-input-text',placeholder:_('Current Master password (if already set)'),style:'width:100%;height:38px;margin-top:8px;'}),
        E('div',{class:'right',style:'margin-top:12px'},[E('button',{class:'btn cbi-button cbi-button-positive',click:function(){
          var np=document.getElementById('sky-new-admin').value, mp=document.getElementById('sky-master').value;
          callAdminSet(np,mp).then(function(r){ if(r&&r.status==='ok'){ui.hideModal();ui.addNotification(null,E('p',{},[_('Admin password saved.') ]));} else ui.addNotification(null,E('p',{},[r.error||_('Unable to save password.')]),'error'); });
        }},[_('Save')])])
      ]);
    }},[_('Admin Password')]);
    var enableBtn=E('button',{class:'btn cbi-button cbi-button-positive',click:function(){auth(function(pw){ callPortal('1',pw).then(function(r){ if(r&&r.portal_enabled===1){refresh();ui.addNotification(null,E('p',{},[_('Voucher portal enabled.')]))} else ui.addNotification(null,E('p',{},[r&&r.error||_('Unable to enable portal.')]),'error'); }); });}},[_('Enable Portal')]);
    var disableBtn=E('button',{class:'btn cbi-button cbi-button-remove',click:function(){auth(function(pw){ callPortal('0',pw).then(function(r){ if(r&&r.portal_enabled===0){refresh();ui.addNotification(null,E('p',{},[_('Voucher portal disabled.')]))} else ui.addNotification(null,E('p',{},[r&&r.error||_('Unable to disable portal.')]),'error'); }); });}},[_('Disable Portal')]);
    function refresh(){callStatus().then(function(r){var en=!!(r&&r.portal_enabled===1);status.textContent=en?_('ENABLED'):_('DISABLED');enableBtn.style.display=en?'none':'inline-block';disableBtn.style.display=en?'inline-block':'none';});}
    var generateBtn=E('button',{class:'btn cbi-button cbi-button-positive',click:function(){auth(function(pw){
      callGenerate(String(count.value||1),validity.value,pw).then(function(r){
        if(r&&r.status==='ok'){ui.showModal(_('Generated Vouchers'),[E('p',{},[_('Save or print these codes before closing this dialog:')]),E('textarea',{readonly:true,style:'width:100%;height:180px;font-family:monospace;'},[(r.codes||[]).join('\n')]),E('div',{class:'right'},[E('button',{class:'btn cbi-button cbi-button-neutral',click:ui.hideModal},[_('Close')])])]); load(pw);}
        else ui.addNotification(null,E('p',{},[r.error||_('Generation failed.')]),'error');
      });
    });}},[_('Generate Vouchers')]);
    refresh();
    setTimeout(function(){ load(''); }, 0);
    return E('div',{class:'cbi-map'},[
      E('h2',{},[_('Sky Wifi — Voucher Manager')]),
      E('div',{class:'cbi-section',style:'padding:16px;'},[
        E('div',{style:'display:flex;gap:8px;align-items:center;flex-wrap:wrap;'},[E('strong',{},[_('Portal: ')]),status,enableBtn,disableBtn,adminBtn])
      ]),
      E('div',{class:'cbi-section',style:'padding:16px;'},[
        E('h3',{},[_('Create Vouchers')]),
        E('div',{style:'display:grid;grid-template-columns:1fr 1fr auto;gap:12px;align-items:end;'},[
          E('label',{},[_('Quantity'),count]), E('label',{},[_('Validity'),validity]), generateBtn
        ])
      ]),
      E('div',{class:'cbi-section',style:'padding:16px;'},[E('h3',{},[_('Voucher List')]),listBox])
    ]);
  },
  handleSaveApply: null
});
