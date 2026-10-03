"use strict";
require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const app = express();

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);
const PAIRING_SERVER_URL = String(process.env.PAIRING_SERVER_URL || "https://etias-mini-bot-pair.onrender.com").replace(/\/+$/, "");
const SESSION_TRANSFER_SECRET = String(process.env.SESSION_TRANSFER_SECRET || "").trim();
const SESSION_PREFIX = "ETIAS-MINI-BOT~";
const DEFAULT_DAYS = 30;
const MAX_DAYS = 3650;

const DATA_DIR = path.join(ROOT, "data");
const AUTH_DIR = path.join(ROOT, "auth");
const USERS_AUTH_DIR = path.join(AUTH_DIR, "users");
const DEPLOYED_FILE = path.join(DATA_DIR, "deployed.json");

for (const dir of [DATA_DIR, AUTH_DIR, USERS_AUTH_DIR]) fs.mkdirSync(dir, { recursive: true });

app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));
app.use((req, res, next) => { res.setHeader("X-Powered-By", "ETIAS-MINI-BOT"); next(); });

function normalizeSessionId(v){ return String(v||"").trim().toUpperCase(); }
function isValidSessionId(id){ return new RegExp(`^${SESSION_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\d{8}$`).test(normalizeSessionId(id)); }
function normalizePhone(p){ return String(p||"").replace(/[^\d]/g,"").replace(/^00/,""); }
function authFolderName(sId){ const id=normalizeSessionId(sId); if(!isValidSessionId(id)) throw new Error("Invalid Session ID"); return id.replace(/[^A-Z0-9_-]/gi,"_"); }
function getAuthFolder(sId){ return path.join(USERS_AUTH_DIR, authFolderName(sId)); }
function ensureAuthFolder(sId){ const f=getAuthFolder(sId); fs.mkdirSync(f,{recursive:true}); return f; }
function readJSON(f,fb){ try{ if(!fs.existsSync(f)) return fb; return JSON.parse(fs.readFileSync(f,"utf8")); }catch{ return fb; } }
function writeJSON(f,d){ fs.mkdirSync(path.dirname(f),{recursive:true}); fs.writeFileSync(f, JSON.stringify(d,null,2),"utf8"); }
function getDeployments(){ const d=readJSON(DEPLOYED_FILE,[]); return Array.isArray(d)?d:[]; }
function saveDeployments(d){ writeJSON(DEPLOYED_FILE,d); }
function findDeployment(sId){ const id=normalizeSessionId(sId); return getDeployments().find(i=>normalizeSessionId(i.sessionId)===id); }
function updateDeployment(sId,patch){ const deps=getDeployments(); const idx=deps.findIndex(i=>normalizeSessionId(i.sessionId)===normalizeSessionId(sId)); if(idx===-1) return null; deps[idx]={...deps[idx],...patch,updatedAt:new Date().toISOString()}; saveDeployments(deps); return deps[idx]; }
function safeAuthRelativePath(fp){ let rel=String(fp||"").replace(/\\/g,"/").replace(/^\/+/,""); if(!rel) throw new Error("Invalid auth file path"); if(rel.includes("\0")||rel.split("/").includes("..")) throw new Error("Unsafe auth file path"); if(path.isAbsolute(rel)) throw new Error("Absolute auth paths not allowed"); return rel; }
function writeTransferredAuth(sId,files){
    if(!Array.isArray(files)||files.length===0) throw new Error("Pairing server returned no auth files");
    const authFolder=ensureAuthFolder(sId); let credsFound=false;
    for(const file of files){
        if(!file||!file.path) continue;
        const rel=safeAuthRelativePath(file.path);
        const dest=path.resolve(authFolder, rel);
        const rootResolved=path.resolve(authFolder);
        if(dest!==rootResolved && !dest.startsWith(rootResolved+path.sep)) throw new Error("Auth path escaped");
        if(rel==="creds.json") credsFound=true;
        if(typeof file.data!=="string") throw new Error(`Invalid data for ${rel}`);
        const buf=Buffer.from(file.data,"base64");
        fs.mkdirSync(path.dirname(dest),{recursive:true});
        fs.writeFileSync(dest, buf);
    }
    const credsPath=path.join(authFolder,"creds.json");
    if(!credsFound && !fs.existsSync(credsPath)) throw new Error("creds.json missing");
    return authFolder;
}
async function callPairingServer(endpoint, options={}){
    const url=`${PAIRING_SERVER_URL}${endpoint.startsWith("/")?endpoint:"/"+endpoint}`;
    const headers={Accept:"application/json",...(options.headers||{})};
    if(options.body!==undefined) headers["Content-Type"]="application/json";
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(), Number(options.timeout||30000));
    try{
        const res=await fetch(url,{method:options.method||"GET",headers,body:options.body!==undefined?JSON.stringify(options.body):undefined,signal:controller.signal});
        const text=await res.text(); let data; try{data=JSON.parse(text);}catch{data={success:false,error:text||`HTTP ${res.status}`};} return {ok:res.ok,status:res.status,data};
    }finally{clearTimeout(timeout);}
}
async function verifySessionWithPairingServer(sId, phone){
    const id=normalizeSessionId(sId); const normPhone=normalizePhone(phone);
    if(!isValidSessionId(id)) return {success:false,error:"Invalid Session ID format"};
    const encoded=encodeURIComponent(id);
    const endpoints=[`/session/${encoded}`,`/session-status/${encoded}`,`/check-session/${encoded}`,`/check/${encoded}`];
    let lastError="Session not found";
    for(const ep of endpoints){
        try{
            const r=await callPairingServer(ep);
            if(!r.ok){ lastError=r.data?.error||`HTTP ${r.status}`; continue; }
            const d=r.data||{}; if(d.success===false){ lastError=d.error||"Verification failed"; continue; }
            const retId=normalizeSessionId(d.sessionId||d.session?.sessionId||d.record?.sessionId||id);
            if(retId && retId!==id){ lastError="Session ID mismatch"; continue; }
            const retPhone=normalizePhone(d.phone||d.number||d.session?.phone||d.session?.number||d.record?.phone||"");
            if(retPhone && normPhone && retPhone!==normPhone) return {success:false,error:"Session ID does not belong to this number"};
            return {success:true,sessionId:id,phone:retPhone||normPhone,jid:d.jid||d.session?.jid||null,pairingId:d.pairingId||null,status:d.status||"authenticated",raw:d};
        }catch(e){ lastError=e.message; }
    }
    return {success:false,error:lastError};
}
async function transferAuthFromPairingServer(sId, phone){
    if(!SESSION_TRANSFER_SECRET) throw new Error("SESSION_TRANSFER_SECRET not configured");
    const id=normalizeSessionId(sId); const encoded=encodeURIComponent(id);
    const result=await callPairingServer(`/session/${encoded}/auth`,{timeout:60000,headers:{"X-Session-Transfer-Secret":SESSION_TRANSFER_SECRET}});
    if(!result.ok) throw new Error(result.data?.error||`Auth transfer HTTP ${result.status}`);
    if(result.data.success!==true) throw new Error(result.data.error||"Auth transfer rejected");
    if(normalizeSessionId(result.data.sessionId||id)!==id) throw new Error("Auth transfer ID mismatch");
    const authFolder=writeTransferredAuth(id, result.data.files);
    return {success:true,sessionId:id,phone:normalizePhone(result.data.phone||phone),jid:result.data.jid||null,authFolder,filesTransferred:result.data.files.length};
}
async function deployThroughManager(options){
    const botManager=global.ETIAS_BOT_MANAGER;
    if(!botManager||typeof botManager.deploySession!=="function") throw new Error("ETIAS_BOT_MANAGER not available");
    const auth=await transferAuthFromPairingServer(options.sessionId, options.phone);
    const result=await botManager.deploySession({...options,authFolder:auth.authFolder,authenticated:true,connectImmediately:true,startCommands:true,jid:options.jid||auth.jid||null});
    if(!result||result.success!==true) throw new Error(result?.error||"Bot manager failed");
    return {...result,success:true,authTransferred:true,authFolder:auth.authFolder,filesTransferred:auth.filesTransferred,jid:result.jid||auth.jid||null};
}

const DEPLOYMENT_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>ETIAS-MINI-BOT</title>
<style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at top,#063b27 0%,#01150e 35%,#000 100%);color:#d7ffe9;font-family:Arial,sans-serif}
.container{width:min(700px,96%);margin:30px auto;padding:25px;border:1px solid #00ff88;border-radius:20px;background:rgba(0,20,13,.86);box-shadow:0 0 30px rgba(0,255,136,.18)}
h1{text-align:center;color:#00ff88;letter-spacing:2px;margin:0} .subtitle{text-align:center;color:#7deeb1;margin-bottom:20px}
label{display:block;margin:12px 0 5px} input,select{width:100%;padding:12px;border-radius:10px;border:1px solid #00a95c;background:#001a10;color:white;outline:none}
button{width:100%;margin-top:18px;padding:14px;border:0;border-radius:10px;background:#00ff88;color:#00150c;font-weight:bold;cursor:pointer}
#result{margin-top:15px;padding:12px;border-radius:10px;background:#001a10;white-space:pre-wrap;word-break:break-word;font-size:13px}
.success{color:#00ff88} .error{color:#ff6868}
table{width:100%;border-collapse:collapse;margin-top:15px} th,td{padding:8px;border:1px solid #00a95c;text-align:left;font-size:12px}
th{background:#001a10;color:#00ff88} .online{color:#00ff88;font-weight:bold} .offline{color:#ff6868}
.btn-small{padding:5px 9px;border:0;border-radius:6px;cursor:pointer;margin:2px;font-size:11px;width:auto}
.btn-renew{background:#00ff88;color:#000} .btn-del{background:#ff3b3b;color:#fff}
</style></head>
<body><div class="container">
<h1>ETIAS-MINI-BOT</h1><div class="subtitle">Multi-User Deployment System</div>
<form id="deployForm">
<label>Admin Key</label><input id="adminKey" type="password" placeholder="Admin key" required>
<label>Session ID</label><input id="sessionId" placeholder="ETIAS-MINI-BOT~12345678" required>
<label>WhatsApp Number</label><input id="phone" placeholder="263778810589" required>
<label>Duration</label><select id="days"><option value="30">30 Days</option><option value="60">60 Days</option><option value="90">90 Days</option><option value="180">180 Days</option><option value="365">365 Days</option></select>
<button type="submit">DEPLOY BOT</button>
</form>
<div id="result">Waiting for deployment...</div>
<h2 style="color:#00ff88;margin-top:25px">Users</h2>
<table><thead><tr><th>Session</th><th>Phone</th><th>Status</th><th>Expiry</th><th>Action</th></tr></thead><tbody id="usersTable"></tbody></table>
</div>
<script>
const form=document.getElementById("deployForm"); const result=document.getElementById("result"); const usersTable=document.getElementById("usersTable");
async function loadUsers(){
  try{
    const r=await fetch("/api/users"); const d=await r.json();
    const r2=await fetch("/sessions"); const d2=await r2.json();
    const liveMap=new Map((d2.live||[]).map(s=>[s.sessionId, s.connected]));
    usersTable.innerHTML="";
    (d.users||[]).forEach(u=>{
      const online=liveMap.get(u.sessionId)===true;
      const tr=document.createElement("tr");
      tr.innerHTML = "<td>" + u.sessionId + "</td><td>" + u.phone + "</td><td class='" + (online?'online':'offline') + "'>" + (online?'ONLINE':(u.status||'offline')) + "</td><td>" + new Date(u.expireAt).toLocaleDateString() + "</td><td><button class='btn-small btn-renew' onclick=\\"renewUser('" + u.sessionId + "')\\">Renew</button><button class='btn-small btn-del' onclick=\\"deleteUser('" + u.sessionId + "')\\">Delete</button></td>";
      usersTable.appendChild(tr);
    });
  }catch(e){ console.log(e); }
}
async function renewUser(id){ const days=prompt("Renew for how many days?","30"); if(!days) return; await fetch("/renew",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({sessionId:id,days:Number(days)})}); loadUsers(); }
async function deleteUser(id){ if(!confirm("Delete "+id+" ?")) return; await fetch("/sessions/"+encodeURIComponent(id),{method:"DELETE"}); loadUsers(); }
form.addEventListener("submit", async (e)=>{
  e.preventDefault(); result.className=""; result.textContent="Deploying...";
  const payload={adminKey:document.getElementById("adminKey").value,sessionId:document.getElementById("sessionId").value,phone:document.getElementById("phone").value,days:Number(document.getElementById("days").value)};
  try{
    const res=await fetch("/deploy",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
    const data=await res.json();
    if(!res.ok||!data.success){ result.className="error"; result.textContent=data.error||"Failed"; return; }
    result.className="success"; result.textContent="DEPLOYED\\nSession: "+data.sessionId+"\\nPhone: "+data.phone+"\\nConnected: "+data.connected+"\\nExpiry: "+data.expireAt;
    loadUsers();
  }catch(err){ result.className="error"; result.textContent=err.message; }
});
loadUsers(); setInterval(loadUsers,5000);
</script></body></html>`;

app.get("/", (req,res)=> res.type("html").send(DEPLOYMENT_HTML));
app.get("/health",(req,res)=> res.json({success:true,status:"online",service:"ETIAS-MINI-BOT",pairingServer:PAIRING_SERVER_URL,authTransfer:Boolean(SESSION_TRANSFER_SECRET),time:new Date().toISOString()}));

app.post("/deploy", async (req,res)=>{
    try{
        const sessionId=normalizeSessionId(req.body.sessionId);
        const phone=normalizePhone(req.body.phone);
        const days=Math.min(Math.max(Number(req.body.days||DEFAULT_DAYS),1),MAX_DAYS);
        const adminKey=String(req.body.adminKey||"").trim();
        if(!process.env.ADMIN_SECRET || adminKey!==process.env.ADMIN_SECRET) return res.status(403).json({success:false,error:"Invalid admin key"});
        if(!isValidSessionId(sessionId)) return res.status(400).json({success:false,error:`Invalid Session ID. Expected ${SESSION_PREFIX} + 8 digits`});
        if(!phone||phone.length<7) return res.status(400).json({success:false,error:"Invalid WhatsApp number"});
        const existing=findDeployment(sessionId);
        if(existing && ["starting","connected","active"].includes(String(existing.status).toLowerCase())) return res.status(409).json({success:false,error:"Session already deployed"});
        const deployments=getDeployments();
        const samePhone=deployments.find(i=>normalizePhone(i.phone)===phone && ["starting","connected","active"].includes(String(i.status).toLowerCase()));
        if(samePhone) return res.status(409).json({success:false,error:"Number already has active deployment",sessionId:samePhone.sessionId});

        const verification=await verifySessionWithPairingServer(sessionId,phone);
        if(!verification.success) return res.status(400).json({success:false,error:verification.error});

        const expireAt=new Date(Date.now()+days*24*60*60*1000).toISOString();
        const managerResult=await deployThroughManager({sessionId,phone,days,expireAt,pairingId:verification.pairingId,jid:verification.jid});

        const deployment={sessionId,phone,jid:managerResult.jid||verification.jid||null,pairingId:managerResult.pairingId||verification.pairingId||null,days,expireAt,authFolder:managerResult.authFolder,status:managerResult.status||"starting",connected:managerResult.connected===true,authTransferred:true,filesTransferred:managerResult.filesTransferred||0,createdAt:new Date().toISOString(),botStartedAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
        const updated=getDeployments().filter(i=>normalizeSessionId(i.sessionId)!==sessionId); updated.push(deployment); saveDeployments(updated);

        return res.json({success:true,message:"Deployed",sessionId,phone,jid:deployment.jid,days,expireAt,status:deployment.status,connected:deployment.connected,authTransferred:true});
    }catch(error){ console.error("[DEPLOY ERROR]",error); return res.status(500).json({success:false,error:error.message}); }
});

app.get("/status/:sessionId", async (req,res)=>{
    const sessionId=normalizeSessionId(req.params.sessionId); const local=findDeployment(sessionId);
    const manager=global.ETIAS_BOT_MANAGER; let live=null;
    if(manager&&typeof manager.getSession==="function"){ try{live=manager.getSession(sessionId);}catch{} }
    if(!local&&!live) return res.status(404).json({success:false,error:"Session not found"});
    res.json({success:true,sessionId,deployment:local||null,live:live||null});
});
app.get("/sessions",(req,res)=>{
    const manager=global.ETIAS_BOT_MANAGER; let live=[]; if(manager&&typeof manager.getSessions==="function"){ try{live=manager.getSessions()||[];}catch{} }
    res.json({success:true,deployments:getDeployments(),live});
});
app.get("/api/sessions",(req,res)=>{
    const manager=global.ETIAS_BOT_MANAGER; let live=[]; if(manager&&typeof manager.getSessions==="function"){ try{live=manager.getSessions()||[];}catch{} }
    res.json({success:true,sessions:live,deployments:getDeployments()});
});
app.get("/api/users",(req,res)=>{ const deps=getDeployments(); res.json({success:true,total:deps.length,users:deps}); });
app.post("/renew",(req,res)=>{
    try{
        const sessionId=normalizeSessionId(req.body.sessionId);
        const days=Math.min(Math.max(Number(req.body.days||30),1),MAX_DAYS);
        const dep=findDeployment(sessionId); if(!dep) return res.status(404).json({success:false,error:"Not found"});
        const base=new Date(dep.expireAt||Date.now())>new Date()?new Date(dep.expireAt):new Date();
        const expireAt=new Date(base.getTime()+days*24*60*60*1000).toISOString();
        const updated=updateDeployment(sessionId,{expireAt,days:Number(dep.days||0)+days});
        res.json({success:true,deployment:updated});
    }catch(e){ res.status(500).json({success:false,error:e.message}); }
});
app.delete("/sessions/:sessionId", async (req,res)=>{
    const sessionId=normalizeSessionId(req.params.sessionId); const manager=global.ETIAS_BOT_MANAGER;
    try{ if(manager&&typeof manager.removeSession==="function") await manager.removeSession(sessionId); const deps=getDeployments().filter(i=>normalizeSessionId(i.sessionId)!==sessionId); saveDeployments(deps); res.json({success:true,sessionId}); }catch(e){ res.status(500).json({success:false,error:e.message}); }
});
app.get("/deploy-stats",(req,res)=>{
    const deps=getDeployments(); const manager=global.ETIAS_BOT_MANAGER; let live=[]; if(manager&&typeof manager.getSessions==="function"){ try{live=manager.getSessions()||[];}catch{} }
    const connected=live.filter(s=>s.connected===true).length;
    res.json({success:true,totalUsers:deps.length,onlineUsers:connected,connected,active:deps.filter(i=>new Date(i.expireAt||0)>new Date()).length});
});
app.use((req,res)=> res.status(404).json({success:false,error:"Route not found",path:req.path}));
module.exports = app;
