const $ = id => document.getElementById(id);
if (window.lucide) lucide.createIcons();
const SENSOR_META = [
  {id:'mpu6050',name:'MPU6050',kind:'Motion / IMU',icon:'activity',desc:'3-axis acceleration and gyroscope'},
  {id:'sw420',name:'SW-420',kind:'Vibration switch',icon:'vibrate',desc:'Digital vibration event detector'},
  {id:'dht22',name:'DHT22',kind:'Environment',icon:'thermometer',desc:'Ambient temperature and humidity'},
  {id:'a3144',name:'A3144',kind:'Hall effect / RPM',icon:'gauge',desc:'Magnetic pulse and rotational speed'},
  {id:'mq2',name:'MQ-2',kind:'Gas response',icon:'cloud',desc:'Raw gas / smoke sensor response'},
  {id:'mc38',name:'MC-38',kind:'Reed switch',icon:'shield',desc:'Enclosure open / closed state'}
];
let latest = null, alarms = [], history = [], ws = null, apiOnline = false, mqttOnline = false;
const chartOpts = {responsive:true,maintainAspectRatio:false,animation:false,plugins:{legend:{display:false},tooltip:{backgroundColor:'#14243a',borderColor:'#344a65',borderWidth:1,titleColor:'#edf4ff',bodyColor:'#b8c9dc'}},scales:{x:{grid:{color:'#263750'},ticks:{color:'#8196b1',maxTicksLimit:7,font:{size:9}},border:{color:'#34465f'}},y:{grid:{color:'#263750'},ticks:{color:'#8196b1',font:{size:9}},border:{color:'#34465f'}}}};
let vibrationChart=null, axisChart=null, fftChart=null;
if (window.Chart) {
  vibrationChart = new Chart($('vibrationChart'),{type:'line',data:{labels:[],datasets:[{data:[],borderColor:'#4bd4e8',backgroundColor:'#4bd4e81c',fill:true,borderWidth:2,pointRadius:0,tension:.25}]},options:{...chartOpts,scales:{...chartOpts.scales,y:{...chartOpts.scales.y,beginAtZero:true}}}});
  axisChart = new Chart($('axisChart'),{type:'line',data:{labels:[],datasets:[{label:'X',data:[],borderColor:'#4bd4e8',pointRadius:0,borderWidth:1.5},{label:'Y',data:[],borderColor:'#ad91ff',pointRadius:0,borderWidth:1.5},{label:'Z',data:[],borderColor:'#ffbd69',pointRadius:0,borderWidth:1.5}]},options:{...chartOpts,plugins:{...chartOpts.plugins,legend:{display:true,labels:{color:'#aebed0',boxWidth:8,font:{size:9}}}}}});
}
function fmt(value,digits=2){return value===null||value===undefined||!Number.isFinite(Number(value))?'—':Number(value).toFixed(digits)}
function setState(id,kind,label){const el=$(id);if(!el)return;el.className=`state ${kind}`;el.textContent=label}
function statusClass(s){return ['connected','online','ok','ready'].includes(String(s||'').toLowerCase())?'connected':['disconnected','offline','error','failed'].includes(String(s||'').toLowerCase())?'disconnected':['warning','degraded'].includes(String(s||'').toLowerCase())?'warning':'unknown'}
function sensorStatus(d,id){const explicit=d?.sensor_status?.[id];if(explicit)return statusClass(explicit);if(id==='mpu6050'&&d?.mpu6050)return 'connected';if(id==='dht22'&&d?.dht22&&d.dht22.temperature_c!=null&&d.dht22.humidity_pct!=null)return 'connected';if(id==='a3144'&&d?.a3144)return 'connected';if(id==='sw420'&&d?.sw420&&d.sw420.detected!==undefined)return 'connected';if(id==='mc38'&&d?.mc38&&d.mc38.closed!==undefined)return 'connected';if(id==='mq2'&&d?.mq2?.enabled===true&&d.mq2.raw_adc!==undefined)return 'connected';return 'unknown'}
function statusLabel(s){return s==='connected'?'CONNECTED':s==='disconnected'?'DISCONNECTED':s==='warning'?'WARNING':'NOT REPORTED'}
function renderSensorSummaries(d){
 const overview=$('overviewSensorList'),full=$('sensorGrid'),device=$('deviceSensorList');overview.innerHTML='';full.innerHTML='';device.innerHTML='';
 SENSOR_META.forEach(meta=>{const s=sensorStatus(d,meta.id),obj=d?.[meta.id]||{};let value='—',detail=meta.desc;
  if(meta.id==='mpu6050'&&obj.acceleration){value=`X ${fmt(obj.acceleration.x)} · Y ${fmt(obj.acceleration.y)} · Z ${fmt(obj.acceleration.z)}`;detail='Acceleration · m/s²'}
  if(meta.id==='sw420'&&obj.detected!==undefined){value=obj.detected?'Vibration detected':'No vibration event';detail='Digital output: '+(obj.digital_output??'—')}
  if(meta.id==='dht22'){value=obj.temperature_c!=null?`${fmt(obj.temperature_c,1)} °C`:'—';detail=obj.humidity_pct!=null?`Humidity ${fmt(obj.humidity_pct,1)} %`:'Awaiting valid temperature / humidity'}
  if(meta.id==='a3144'){value=obj.rpm!=null?`${Math.round(obj.rpm)} RPM`:obj.magnet_detected!==undefined?(obj.magnet_detected?'Magnet detected':'Magnet removed'):'—';detail=`Pulses: ${obj.pulses_per_second??obj.pulses??'—'} / s`}
  if(meta.id==='mq2'){value=obj.enabled===false?'Disabled':obj.raw_adc!=null?`${obj.raw_adc} raw ADC`:'—';detail=obj.enabled===false?'Disabled pending safe inspection':obj.voltage_v!=null?`ADC voltage ${fmt(obj.voltage_v,2)} V`:'Raw response; not calibrated ppm'}
  if(meta.id==='mc38'){value=obj.closed===true?'CLOSED':obj.closed===false?'OPEN':'—';detail=obj.closed===true?'Enclosure contact closed':obj.closed===false?'Enclosure contact open':'Awaiting switch state'}
  const mini=document.createElement('div');mini.className='mini-sensor';mini.innerHTML=`<b>${meta.name}</b><span><i class="${s}"></i>${statusLabel(s)}</span>`;overview.appendChild(mini);
  const card=document.createElement('article');card.className='sensor-card';card.innerHTML=`<div class="sensor-card-top"><div><div class="sensor-name">${meta.name}</div><div class="sensor-type">${meta.kind}</div></div><span class="sensor-icon"><i data-lucide="${meta.icon}"></i></span></div><div class="sensor-reading">${value}</div><div class="sensor-unit">${detail}</div><div class="sensor-detail">${meta.desc}</div><div class="sensor-meta"><span>ESP32 sensor node</span><span class="sensor-status ${s}">${statusLabel(s)}</span></div>`;full.appendChild(card);
  const row=document.createElement('div');row.className='device-row';row.innerHTML=`<span class="device-row-icon"><i data-lucide="${meta.icon}"></i></span><span class="device-row-main"><b>${meta.name}</b><small>${meta.desc}</small></span><span class="device-row-status ${s}">${statusLabel(s)}</span>`;device.appendChild(row);
 });if(window.lucide)lucide.createIcons();
}
function renderTelemetry(d){latest=d;const m=d.mpu6050||{},a=m.acceleration||{},g=m.gyroscope||{},t=d.dht22||{},hall=d.a3144||{},gas=d.mq2||{},reed=d.mc38||{},sw=d.sw420||{};
 const vib=d.vibration_rms??m.vibration_rms_g;const rpm=hall.rpm??d.rpm;const temp=t.temperature_c??d.ambient_temperature;const hum=t.humidity_pct??d.humidity;
 $('kpiVibration').innerHTML=`${fmt(vib)} <small>g</small>`;$('kpiRpm').innerHTML=`${rpm==null?'—':Math.round(rpm)} <small>RPM</small>`;$('kpiTemp').innerHTML=`${fmt(temp,1)} <small>°C</small>`;$('kpiHumidity').innerHTML=`${fmt(hum,1)} <small>%</small>`;
 setState('vibrationStatus',vib==null?'neutral':vib>=1.8?'critical':vib>=1.2?'warning':'normal',vib==null?'No reading':vib>=1.8?'Critical':vib>=1.2?'Warning':'Normal');
 setState('rpmStatus',rpm==null?'neutral':rpm<=0?'warning':'normal',rpm==null?'No reading':rpm<=0?'Stopped':'Reading');
 setState('tempStatus',temp==null?'neutral':temp>=55?'critical':temp>=45?'warning':'normal',temp==null?'No reading':temp>=55?'Critical':temp>=45?'High':'Normal');
 setState('humidityStatus',hum==null?'neutral':'normal',hum==null?'No reading':'Reading');
 $('axisX').textContent=fmt(a.x);$('axisY').textContent=fmt(a.y);$('axisZ').textContent=fmt(a.z);$('gyroXYZ').textContent=[g.x,g.y,g.z].every(x=>x!=null)?`${fmt(g.x)} / ${fmt(g.y)} / ${fmt(g.z)}`:'—';
 $('vibNow').textContent=vib==null?'No RMS metric':`${fmt(vib)} g`;
 const machineCritical=(vib!=null&&vib>=1.8)||(temp!=null&&temp>=55);const machineWarning=!machineCritical&&((vib!=null&&vib>=1.2)||(temp!=null&&temp>=45)||(reed.closed===false));
 const state=machineCritical?'critical':machineWarning?'warning':'normal';$('machineState').className=`state ${state}`;$('machineState').textContent=machineCritical?'CRITICAL':machineWarning?'WARNING':'MONITORING';
 const score=machineCritical?35:machineWarning?68:(vib==null&&temp==null?null:Math.max(70,Math.min(100,Math.round(100-(vib||0)*8-(temp!=null&&temp>35?(temp-35)*.5:0)))));
 $('healthValue').textContent=score??'—';$('healthRing').style.setProperty('--score',score??0);$('healthHeadline').textContent=score==null?'Waiting for telemetry':machineCritical?'Critical condition':machineWarning?'Attention required':'No threshold exceeded';$('healthDescription').textContent=score==null?'No health estimate until valid sensor data arrives.': 'Rule-based prototype indicator from available telemetry; not a certified machine safety score.';
 $('healthRing').style.background=score==null?'conic-gradient(#34465d 0%,#34465d 100%)':`conic-gradient(${machineCritical?'#ff7184':machineWarning?'#ffbd69':'#52d6a2'} ${score}%,#283b51 0)`;
 if($('machineName')) $('machineName').textContent=d.machine_id||'Machine 01';$('gatewayStatus').textContent='Telemetry received';$('espState').textContent='Reporting';$('espLastSeen').textContent=`Last packet: ${new Date(d.timestamp||Date.now()).toLocaleString()}`;
 const when=d.timestamp?new Date(d.timestamp):new Date();$('lastUpdated').textContent=`Last packet ${when.toLocaleTimeString()}`;
 $('sideConnection').textContent='Telemetry received from controller';$('sideMode').textContent='HARDWARE DATA';$('sideMode').parentElement.classList.add('ok');$('modeBadge').className='mode-badge hardware';$('modeBadge').innerHTML='<i></i> REAL HARDWARE DATA';
 renderSensorSummaries(d);updateCharts(d,vib);
}
let sampleCount=0;function updateCharts(d,vib){const time=new Date(d.timestamp||Date.now()).toLocaleTimeString();if(vibrationChart&&vib!=null){vibrationChart.data.labels.push(time);vibrationChart.data.datasets[0].data.push(vib);vibrationChart.data.labels=vibrationChart.data.labels.slice(-60);vibrationChart.data.datasets[0].data=vibrationChart.data.datasets[0].data.slice(-60);vibrationChart.update('none')}
 const a=d.mpu6050?.acceleration;if(axisChart&&a){axisChart.data.labels.push(time);['x','y','z'].forEach((k,i)=>axisChart.data.datasets[i].data.push(a[k]??null));axisChart.data.labels=axisChart.data.labels.slice(-60);axisChart.data.datasets.forEach(ds=>ds.data=ds.data.slice(-60));axisChart.update('none')}
 const fft=d.fft;if(fft&&Array.isArray(fft.frequencies_hz)&&Array.isArray(fft.magnitudes)&&window.Chart){$('fftPlaceholder').classList.add('hidden');$('fftChartWrap').classList.remove('hidden');if(!fftChart)fftChart=new Chart($('fftChart'),{type:'bar',data:{labels:fft.frequencies_hz,datasets:[{data:fft.magnitudes,backgroundColor:'#4bd4e8',borderRadius:2}]},options:chartOpts});else{fftChart.data.labels=fft.frequencies_hz;fftChart.data.datasets[0].data=fft.magnitudes;fftChart.update('none')}}sampleCount++;
}
function safeTime(ts){const d=ts?new Date(ts):new Date();return Number.isNaN(d.getTime())?'—':d.toLocaleTimeString()}
function addAlarm(a){alarms.unshift(a);alarms=alarms.slice(0,250);renderAlarms();renderRecentEvents()}
function renderAlarms(){const filter=$('severityFilter')?.value||'All';const shown=alarms.filter(a=>filter==='All'||a.severity===filter);$('alarmRows').innerHTML=shown.map(a=>`<tr><td>${safeTime(a.timestamp)}</td><td>${a.parameter||a.sensor||'Sensor event'}</td><td>${a.value??'—'}</td><td><span class="severity ${a.severity||'Info'}">${a.severity||'Info'}</span></td><td>${a.description||a.message||'Event received'}</td><td>${a.acknowledged?'<span class="acknowledged">Acknowledged</span>':'<span class="state warning">Open</span>'}</td><td>${a.acknowledged?'':`<button class="ack-btn" data-ack="${a.id}">Acknowledge</button>`}</td></tr>`).join('');$('noAlarms').style.display=shown.length?'none':'block';$('unackedCount').textContent=alarms.filter(a=>!a.acknowledged).length;$('criticalCount').textContent=alarms.filter(a=>a.severity==='Critical'&&!a.acknowledged).length;$('warningCount').textContent=alarms.filter(a=>a.severity==='Warning'&&!a.acknowledged).length;$('alarmCount').textContent=alarms.filter(a=>!a.acknowledged).length;$('alarmRows').querySelectorAll('[data-ack]').forEach(b=>b.addEventListener('click',()=>acknowledgeAlarm(Number(b.dataset.ack))));}
async function acknowledgeAlarm(id){try{const r=await fetch(`/api/alarms/${id}/acknowledge`,{method:'POST'});if(!r.ok)throw new Error('API rejected acknowledgement');const a=alarms.find(x=>Number(x.id)===id);if(a)a.acknowledged=true;renderAlarms()}catch(e){alert('Could not acknowledge this alarm. Check the backend connection.')}}
function renderRecentEvents(){const list=$('recentEvents');const top=alarms.slice(0,4);list.innerHTML=top.length?top.map(a=>`<div class="recent-event"><span class="event-symbol"><i data-lucide="${a.severity==='Critical'?'alert-octagon':'bell-ring'}"></i></span><div><b>${a.parameter||'Sensor event'}</b><p>${a.description||a.value||'Event received'}</p><time>${safeTime(a.timestamp)}</time></div></div>`).join(''):'<div class="empty-note">No events received yet.</div>';if(window.lucide)lucide.createIcons()}
function renderSensorEvents(d){const ev=d.events||[];const list=$('sensorEvents');if(!ev.length){list.innerHTML='<div class="empty-note">No event transitions in this telemetry packet.</div>';return}list.innerHTML=ev.slice().reverse().map(e=>`<div class="feed-item"><i class="feed-dot"></i><div><b>${e.sensor||'Sensor'} · ${e.value??'Event'}</b><small>${e.message||'Sensor state changed'}</small></div><time>${safeTime(e.timestamp||d.timestamp)}</time></div>`).join('')}
async function loadAlarms(){try{const r=await fetch('/api/alarms');if(r.ok){const rows=await r.json();alarms=rows.map(a=>({...a,acknowledged:!!a.acknowledged}));renderAlarms();renderRecentEvents()}}catch(e){}}
async function loadHistory(){try{const r=await fetch('/api/telemetry/history?limit=100');if(!r.ok)throw new Error();history=await r.json();$('historyRows').innerHTML=history.slice().reverse().map(d=>`<tr><td>${d.timestamp?new Date(d.timestamp).toLocaleString():'—'}</td><td>${d.machine_id||'—'}</td><td>${fmt(d.ambient_temperature,1)}</td><td>${fmt(d.humidity,1)}</td><td>${d.rpm==null?'—':Math.round(d.rpm)}</td><td>${fmt(d.vibration_rms)}</td><td>${d.enclosure_closed==null?'—':d.enclosure_closed?'Closed':'Open'}</td></tr>`).join('');$('historyEmpty').style.display=history.length?'none':'block'}catch(e){$('historyEmpty').textContent='History unavailable: backend not reachable.'}}
function downloadCSV(filename,rows){if(!rows.length){alert('No records available to export.');return}const cols=Object.keys(rows[0]);const csv=[cols.join(','),...rows.map(row=>cols.map(k=>`"${String(row[k]??'').replaceAll('"','""')}"`).join(','))].join('\n');const url=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));const a=document.createElement('a');a.href=url;a.download=filename;a.click();URL.revokeObjectURL(url)}

// Local maintenance planner: browser-local until a shared backend endpoint is added.
const TASK_KEY='industrialguard_maintenance_tasks_v1';
const HANDOVER_KEY='industrialguard_handover_note_v1';
let maintenanceTasks=[];
function escapeHtml(value){return String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));}
function loadMaintenance(){
 try{maintenanceTasks=JSON.parse(localStorage.getItem(TASK_KEY)||'[]');if(!Array.isArray(maintenanceTasks))maintenanceTasks=[];}catch(e){maintenanceTasks=[];}
 $('handoverNotes').value=localStorage.getItem(HANDOVER_KEY)||'';
 const due=new Date();due.setDate(due.getDate()+7);$('taskDue').value=due.toISOString().slice(0,10);
 renderMaintenance();
}
function renderMaintenance(){
 const today=new Date().toISOString().slice(0,10);
 const open=maintenanceTasks.filter(t=>!t.completed);
 $('taskOpen').textContent=open.length;
 $('taskOverdue').textContent=open.filter(t=>t.due<today).length;
 $('taskDone').textContent=maintenanceTasks.filter(t=>t.completed).length;
 const filter=$('taskFilter')?.value||'Open';
 const shown=maintenanceTasks.filter(t=>filter==='All'||(filter==='Completed'?t.completed:!t.completed)).sort((a,b)=>(a.completed-b.completed)||a.due.localeCompare(b.due));
 const host=$('maintenanceTasks');
 host.innerHTML=shown.length?shown.map(t=>`<div class="task-item ${t.completed?'completed':''}">
  <input class="task-check" type="checkbox" data-task-done="${escapeHtml(t.id)}" ${t.completed?'checked':''} aria-label="Mark task complete">
  <div class="task-main"><b>${escapeHtml(t.title)}</b><small>${escapeHtml(t.owner||'Unassigned')} · ${escapeHtml(t.notes||'No additional notes')}</small></div>
  <div class="task-side"><span class="priority-pill ${escapeHtml(t.priority)}">${escapeHtml(t.priority)}</span><span class="task-date">${escapeHtml(t.due)}${!t.completed&&t.due<today?' · OVERDUE':''}</span><div class="task-actions"><button data-task-delete="${escapeHtml(t.id)}">Delete</button></div></div>
 </div>`).join(''):'<div class="empty-note">No tasks in this view. Add a task or change the filter.</div>';
 host.querySelectorAll('[data-task-done]').forEach(el=>el.addEventListener('change',()=>{const t=maintenanceTasks.find(x=>x.id===el.dataset.taskDone);if(t){t.completed=el.checked;t.completed_at=el.checked?new Date().toISOString():null;saveMaintenance();}}));
 host.querySelectorAll('[data-task-delete]').forEach(el=>el.addEventListener('click',()=>{maintenanceTasks=maintenanceTasks.filter(t=>t.id!==el.dataset.taskDelete);saveMaintenance();}));
}
function saveMaintenance(){localStorage.setItem(TASK_KEY,JSON.stringify(maintenanceTasks));renderMaintenance();}
$('maintenanceForm').addEventListener('submit',e=>{
 e.preventDefault();
 const task={id:`task-${Date.now()}-${Math.random().toString(16).slice(2,7)}`,title:$('taskTitle').value.trim(),due:$('taskDue').value,priority:$('taskPriority').value,owner:$('taskOwner').value.trim(),notes:$('taskNotes').value.trim(),completed:false,created_at:new Date().toISOString()};
 if(!task.title||!task.due)return;
 maintenanceTasks.unshift(task);saveMaintenance();e.target.reset();
 const due=new Date();due.setDate(due.getDate()+7);$('taskDue').value=due.toISOString().slice(0,10);$('taskPriority').value='Medium';
});
$('taskFilter').addEventListener('change',renderMaintenance);
$('handoverNotes').addEventListener('input',()=>{localStorage.setItem(HANDOVER_KEY,$('handoverNotes').value);$('handoverSaved').innerHTML='<i></i> Saved just now';});
$('clearHandover').addEventListener('click',()=>{if(confirm('Clear the saved handover note?')){$('handoverNotes').value='';localStorage.removeItem(HANDOVER_KEY);$('handoverSaved').innerHTML='<i></i> Cleared';}});
function quickJump(){const choice=prompt('Quick jump: overview, sensors, vibration, alarms, devices, reports, maintenance');if(!choice)return;const key=choice.trim().toLowerCase();const aliases={overview:'overview',dashboard:'overview',sensors:'sensors','live sensors':'sensors',vibration:'vibration',analytics:'vibration',alarms:'alarms',devices:'devices',reports:'reports',history:'reports',maintenance:'maintenance'};if(aliases[key])setPage(aliases[key]);else alert('Page not found. Try: overview, sensors, vibration, alarms, devices, reports or maintenance.');}
$('commandBtn')?.addEventListener('click',quickJump);
document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();quickJump();}});
function updateFreshness(){
 if(!latest)return;
 const stamp=new Date(latest.timestamp||0).getTime();
 if(!stamp||!Number.isFinite(stamp))return;
 const age=(Date.now()-stamp)/1000;
 const stale=age>15;
 if(stale){
  $('modeBadge').className='mode-badge waiting stale';
  $('modeBadge').innerHTML='<i></i> DATA STALE';
  $('sideMode').textContent='STALE TELEMETRY';
  $('sideConnection').textContent=`Last packet ${Math.round(age)} seconds ago`;
  $('espState').textContent='Stale / no recent heartbeat';
  $('gatewayStatus').textContent='No recent packet';
 }else if(apiOnline){
  $('modeBadge').className='mode-badge hardware';
  $('modeBadge').innerHTML='<i></i> REAL HARDWARE DATA';
  $('sideMode').textContent='HARDWARE DATA';
  $('sideConnection').textContent='Telemetry received from controller';
  $('espState').textContent='Reporting';
  $('gatewayStatus').textContent='Telemetry received';
 }
}

function setPage(page){document.querySelectorAll('.page').forEach(p=>p.classList.toggle('active',p.id===`page-${page}`));document.querySelectorAll('.nav-item').forEach(b=>b.classList.toggle('active',b.dataset.page===page));const names={overview:['Overview','Machine overview','A live operational picture of your monitored equipment.'],sensors:['Live sensors','Live sensor monitoring','Actual readings and diagnostics received from the ESP32.'],vibration:['Vibration analytics','Vibration analytics','Signal analysis from the MPU6050 sensor.'],alarms:['Alarm management','Alarm management','Review abnormal conditions and acknowledge inspected events.'],devices:['Device health','Device health','Controller, transport and sensor diagnostics.'],reports:['Reports & history','Reports and history','Historical telemetry stored by the backend.'],maintenance:['Maintenance planner','Maintenance planner','Plan inspections, track work and hand over shift notes.']};const n=names[page];$('pageName').textContent=n[0];$('pageTitle').textContent=n[1];$('pageSubtitle').textContent=n[2]}
document.querySelectorAll('.nav-item').forEach(b=>b.addEventListener('click',()=>setPage(b.dataset.page)));document.querySelectorAll('[data-goto]').forEach(b=>b.addEventListener('click',()=>setPage(b.dataset.goto)));$('severityFilter').addEventListener('change',renderAlarms);
$('exportBtn').addEventListener('click',()=>downloadCSV('industrialguard-alarms.csv',alarms));$('historyExport').addEventListener('click',()=>downloadCSV('industrialguard-telemetry.csv',history));$('loadHistory').addEventListener('click',loadHistory);
$('refreshBtn').addEventListener('click',async()=>{await checkApi();await loadLatest();await loadAlarms();await loadHistory()});
async function checkApi(){try{const r=await fetch('/api/health');if(!r.ok)throw new Error();const h=await r.json();apiOnline=true;mqttOnline=!!h.mqtt_connected;$('apiState').textContent='Online';$('mqttState').textContent=mqttOnline?'Connected':'Not connected';$('mqttDetail').textContent=h.mqtt_error||'MQTT broker connection';$('backendStatus')?.classList.toggle('online',mqttOnline);if(!latest){$('modeBadge').className='mode-badge waiting';$('modeBadge').innerHTML='<i></i> WAITING FOR ESP32';$('sideMode').textContent='WAITING FOR DATA';$('sideConnection').textContent='API available; no telemetry yet'}$('gatewayStatus').textContent=latest?'Telemetry received':'Waiting for telemetry'}catch(e){apiOnline=false;$('apiState').textContent='Offline';$('mqttState').textContent='Unknown';$('mqttDetail').textContent='Start the FastAPI backend';$('modeBadge').className='mode-badge waiting';$('modeBadge').innerHTML='<i></i> BACKEND OFFLINE';$('sideMode').textContent='NOT CONNECTED';$('sideConnection').textContent='Start backend to receive live data'}}
async function loadLatest(){try{const r=await fetch('/api/telemetry/latest');if(!r.ok)throw new Error();const data=await r.json();if(data.length){renderTelemetry(data[data.length-1]);renderSensorEvents(data[data.length-1])}}catch(e){}}
function connectWS(){if(!location.protocol.startsWith('http'))return;const protocol=location.protocol==='https:'?'wss':'ws';ws=new WebSocket(`${protocol}://${location.host}/ws/telemetry`);ws.onopen=()=>{ $('sideConnection').textContent='WebSocket connected; awaiting sensor packets'};ws.onmessage=e=>{try{const m=JSON.parse(e.data);if(m.type==='telemetry'){renderTelemetry(m.data);renderSensorEvents(m.data)}else if(m.type==='snapshot'&&m.data?.length){const d=m.data[m.data.length-1];renderTelemetry(d);renderSensorEvents(d)}else if(m.type==='alarm'){addAlarm(m.data)}}catch(err){console.error('Invalid live message',err)}};ws.onclose=()=>{setTimeout(connectWS,2500)}}
$('sideMode').textContent='WAITING FOR DATA';$('modeBadge').className='mode-badge waiting';$('modeBadge').innerHTML='<i></i> WAITING FOR ESP32';$('espState').textContent='Awaiting heartbeat';$('mqttState').textContent='Checking';$('apiState').textContent='Checking';renderSensorSummaries(null);renderAlarms();renderRecentEvents();loadMaintenance();checkApi();loadLatest();loadAlarms();loadHistory();connectWS();setInterval(checkApi,10000);setInterval(updateFreshness,3000);
