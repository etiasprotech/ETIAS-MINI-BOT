const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY; // only from .env
if(!ADMIN_KEY){ console.warn("[WARN] ADMIN_KEY not set in .env"); }
const MONGO_URI = process.env.MONGO_URI || '';

const activeBots = new Map();
global.activeBots = activeBots;

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, {recursive:true});
const DEPLOY_FILE = path.join(dataDir, 'deployed.json');
const load = () => { try{ if(fs.existsSync(DEPLOY_FILE)) return JSON.parse(fs.readFileSync(DEPLOY_FILE,'utf8')) }catch{} return [] };
const save = (d) => fs.writeFileSync(DEPLOY_FILE, JSON.stringify(d,null,2));
let deployments = load();

function isBotConnected(id){
  // Check real sessions from main.js if available
  try{
    if(global.ETIAS_BOT_MANAGER && global.ETIAS_BOT_MANAGER.getSessions){
      const all = global.ETIAS_BOT_MANAGER.getSessions();
      const found = all.find(x=>x.sessionId===id);
      if(found) return !!found.connected;
    }
    // Fallback to activeBots map
    const b = activeBots.get(id);
    if(b) return !!(b.ws?.isOpen || b.user || b.ready || b.connected);
  }catch{}
  return false;
}

if(MONGO_URI){
  mongoose.connect(MONGO_URI).then(()=>console.log('[MONGO] Connected')).catch(e=>console.log(e.message));
}

app.get('/', (req,res)=>{
  res.send(`
<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ETIAS MINI BOT</title>
<style>
body{background:#0a1a12;color:#e0ffe0;font-family:monospace;padding:15px}
input,select{width:100%;padding:13px;margin:8px 0;background:#0f281e;border:1px solid #00ff88;color:#fff;border-radius:10px;box-sizing:border-box}
button{width:100%;padding:14px;background:#00ff88;color:#000;font-weight:bold;border:none;border-radius:12px;font-size:16px}
.card{border:1px solid #00ff88;border-radius:16px;padding:15px;margin-top:15px;background:#0f281e}
table{width:100%;border-collapse:collapse}
th,td{border:1px solid #00ff88;padding:8px;font-size:12px;text-align:left;word-break:break-all}
.ONLINE{color:#00ff88;font-weight:bold}
.OFFLINE{color:#ff5555;font-weight:bold}
h2{color:#00ff88}
</style>
</head>
<body>
<h3>Admin Key</h3><input id="adminKey" type="password" value="etias123">
<h3>Session ID</h3><input id="sessionId" value="ETIAS-MINI-BOT~${Math.floor(10000000+Math.random()*90000000)}">
<h3>WhatsApp Number</h3><input id="phone" value="263778810589">
<h3>Duration</h3><select id="duration"><option value="30">30 Days</option><option value="60" selected>60 Days</option><option value="90">90 Days</option></select>
<button onclick="deploy()">DEPLOY BOT</button>

<div id="deployedBox" class="card" style="display:none"></div>

<h2>Users</h2>
<div class="card">
<table>
<thead><tr><th>Session</th><th>Phone</th><th>Status</th><th>Expiry</th></tr></thead>
<tbody id="usersTable"></tbody>
</table>
</div>

<script>
async function loadUsers(){
  const r = await fetch('/deployments');
  const data = await r.json();
  document.getElementById('usersTable').innerHTML = data.map(d=>{
    const online = d.liveConnected;
    return \`<tr>
      <td>\${d.sessionId}</td>
      <td>\${d.phone}</td>
      <td class="\${online?'ONLINE':'OFFLINE'}">\${online?'ONLINE':'OFFLINE'}</td>
      <td>\${new Date(d.expiry).toLocaleDateString()}</td>
    </tr>\`;
  }).join('');
}
async function deploy(){
  const body={
    adminKey:document.getElementById('adminKey').value,
    sessionId:document.getElementById('sessionId').value,
    phone:document.getElementById('phone').value,
    duration:document.getElementById('duration').value
  };
  const res = await fetch('/deploy',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data = await res.json();
  if(data.error) return alert(data.error);
  const box=document.getElementById('deployedBox');
  box.style.display='block';
  box.innerHTML = \`DEPLOYED<br>Session: \${data.sessionId}<br>Phone: \${data.phone}<br>Connected: \${data.liveConnected}<br>Expiry: \${new Date(data.expiry).toLocaleDateString()}\`;
  loadUsers();
}
loadUsers();
setInterval(loadUsers,5000);
</script>
</body>
</html>
`);
});

app.get('/deployments',(req,res)=>{
  // reload file each time to get latest from main.js
  deployments = load();
  res.json(deployments.map(d=>({
    ...d, 
    expiry: d.expireAt || d.expiry,
    liveConnected:isBotConnected(d.sessionId),
    connected:isBotConnected(d.sessionId)
  })));
});

app.post('/deploy',(req,res)=>{
  const {adminKey,sessionId,phone,duration}=req.body;
  if(!ADMIN_KEY) return res.status(500).json({error:'ADMIN_KEY not set in .env'});
  if(adminKey!==ADMIN_KEY) return res.status(401).json({error:'Invalid Admin Key'});
  const expiry=new Date(Date.now()+(parseInt(duration)||30)*24*60*60*1000);
  const cleanPhone=phone.replace(/[^0-9]/g,'');
  deployments = load();
  let dep=deployments.find(d=>d.sessionId===sessionId);
  if(!dep){deployments.push({sessionId,phone:cleanPhone,expiry,expireAt:expiry.toISOString()});}
  else{dep.phone=cleanPhone;dep.expiry=expiry;dep.expireAt=expiry.toISOString();}
  save(deployments);
  res.json({sessionId,phone:cleanPhone,expiry,liveConnected:isBotConnected(sessionId)});
});

app.post('/update-status',(req,res)=>{
  const {sessionId,connected}=req.body;
  if(connected) activeBots.set(sessionId,{ready:true,ws:{isOpen:true},connected:true});
  else activeBots.delete(sessionId);
  res.json({liveConnected:isBotConnected(sessionId)});
});

// Only listen if this file is run directly (not when required by main.js, main.js already triggers listen via this file)
if(require.main === module){
  app.listen(PORT,()=>console.log('Running '+PORT));
} else {
  // When required by main.js, still listen but avoid double listen
  if(!global.__ETIAS_SERVER_STARTED){
    global.__ETIAS_SERVER_STARTED = true;
    app.listen(PORT,()=>console.log('Running '+PORT));
  }
}

module.exports = app;
module.exports.app = app;
