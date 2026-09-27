require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadContentFromMessage } = require('@whiskeysockets/baileys');
const fs = require('fs');
const path = require('path');
const P = require('pino');
const readline = require('readline');
const express = require('express');
const mongoose = require('mongoose');

process.on('uncaughtException', (err)=>{
  if(err.message.includes('Session')||err.message.includes('MAC')||err.message.includes('Bad MAC')||err.message.includes('decrypt')||err.message.includes('Connection Closed')||err.message.includes('Precondition')) return;
});
process.on('unhandledRejection', (err)=>{
  if(err?.message?.includes('Session')||err?.message?.includes('MAC')||err?.message?.includes('Bad MAC')) return;
});

const BOT_NAME = "*ETIAS-MINI-BOT*";
const PREFIX = ".";
const OWNER_NUMBER = (process.env.OWNER_NUMBER || "263778810589").replace(/[^0-9]/g,'');
const ADMIN_KEY = process.env.ADMIN_KEY || OWNER_NUMBER;
const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URL;
const PAIRING_SITE = "https://etias-mini-bot-pair.onrender.com/";
const DEFAULT_EXPIRE_DAYS = parseInt(process.env.EXPIRE_DAYS) || 30;

const dataPath = path.join(__dirname, 'data');
const authBasePath = path.join(__dirname, 'auth');
const usersPath = path.join(authBasePath, 'users');
[ dataPath, authBasePath, usersPath ].forEach(p=>{ if(!fs.existsSync(p)) fs.mkdirSync(p,{recursive:true}) });

let botMode = process.env.MODE || 'public';
try{ const f=path.join(dataPath,'mode.json'); if(fs.existsSync(f)) botMode=JSON.parse(fs.readFileSync(f,'utf-8')).mode||botMode; }catch{}
global.botMode = botMode;

const sessionSchema = new mongoose.Schema({
  userId: { type: String, unique: true },
  sessionId: String,
  phone: String,
  connected: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
  expireAt: { type: Date, default: () => new Date(Date.now() + DEFAULT_EXPIRE_DAYS*86400000) },
  days: { type: Number, default: DEFAULT_EXPIRE_DAYS }
});
sessionSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });
const SessionModel = mongoose.models.Session || mongoose.model('Session', sessionSchema);

async function connectMongo(){
  if(!MONGODB_URI) return false;
  try{ if(mongoose.connection.readyState===0) await mongoose.connect(MONGODB_URI); console.log("[MONGO] ✅"); return true; }catch(e){ console.log("[MONGO] ❌",e.message); return false; }
}
async function saveToMongo(userId, sessionId, days=DEFAULT_EXPIRE_DAYS){
  if(mongoose.connection.readyState!==1) return;
  const expireAt = new Date(Date.now() + days*86400000);
  try{ await SessionModel.findOneAndUpdate({ userId }, { sessionId, phone: userId, connected: true, expireAt, days }, { upsert: true }); console.log(`[MONGO] Saved ${userId} ${days}d`); }catch(e){}
}
async function getFromMongo(){
  if(mongoose.connection.readyState!==1) return null;
  const all = await SessionModel.find({}); const obj={};
  all.forEach(s=>{ if(new Date(s.expireAt) > new Date()) obj[s.userId]=s.sessionId; });
  return obj;
}

const commands = new Map();
const cmdPath = path.join(__dirname, 'commands');
if(fs.existsSync(cmdPath)){
  for(const file of fs.readdirSync(cmdPath).filter(f=>f.endsWith('.js'))){
    try{ delete require.cache[require.resolve(path.join(cmdPath,file))]; const cmd=require(path.join(cmdPath,file)); const name=(cmd.name||file.replace('.js','')).toLowerCase(); commands.set(name,cmd); if(cmd.aliases) cmd.aliases.forEach(a=>commands.set(a.toLowerCase(),cmd)); }catch{}
  }
}

function getDB(f, def={}){ const p=path.join(dataPath,f); if(!fs.existsSync(p)) fs.writeFileSync(p, JSON.stringify(def)); try{return JSON.parse(fs.readFileSync(p))}catch{return def} }
function saveDB(f,d){ fs.writeFileSync(path.join(dataPath,f), JSON.stringify(d,null,2)); }
function getMultiDB(){ return getDB('multi_sessions.json', {}); }
function saveMultiSession(userId, sessionId, days=DEFAULT_EXPIRE_DAYS){
  const db=getMultiDB(); db[userId]=sessionId; saveDB('multi_sessions.json', db);
  saveToMongo(userId, sessionId, days);
}
function initSessionFromString(sid, destPath){
  if(!sid) return false;
  try{
    const p=path.join(destPath,'creds.json'); if(fs.existsSync(p)&&fs.statSync(p).size>500) return true;
    let c=sid.trim().replace(/\s/g,''); if(c.includes("~")) c=c.split("~").pop();
    const d=Buffer.from(c,'base64').toString('utf-8');
    if(d.startsWith("{")){ if(!fs.existsSync(destPath)) fs.mkdirSync(destPath,{recursive:true}); fs.writeFileSync(p,d); return true; }
  }catch{} return false;
}
function askNumber(){ const rl=readline.createInterface({input:process.stdin,output:process.stdout}); return new Promise(r=>{rl.question(`📱 Number: `,a=>{rl.close(); r(a.trim()||OWNER_NUMBER)})}) }

const msgCache=new Map();
const activeBots=new Map();
const alreadySent = new Set(); // FIX SPAM

// === SEND SESSION ONLY ONCE ===
async function sendSessionDM(sock, authPath){
  try{
    const myNumber = sock.user?.id?.split(':')[0];
    if(!myNumber) return;
    if(alreadySent.has(myNumber)) return; // spam fix
    alreadySent.add(myNumber);

    await new Promise(r=>setTimeout(r, 12000));
    const credsPath = path.join(authPath,'creds.json');
    if(!fs.existsSync(credsPath)) return;
    const creds = fs.readFileSync(credsPath,'utf-8');
    const full = `ETIAS-MINI-BOT~${Buffer.from(creds).toString('base64')}`;

    // Lock file prevents re-send on restart
    const lockFile = path.join(dataPath, `sent_${myNumber}.lock`);
    if(fs.existsSync(lockFile) && (Date.now() - fs.statSync(lockFile).mtimeMs < 12*60*60*1000)) return;

    const userMsg = `✅ *${BOT_NAME} CONNECTED!*

📱 Number: ${myNumber}
⏰ Package: ${DEFAULT_EXPIRE_DAYS} days

*🔑 YOUR SESSION ID:*
${full}

*👉 NEXT STEP:*
Copy this entire Session and send it to Owner:
wa.me/${OWNER_NUMBER}?text=Hi%20Owner%20here%20is%20my%20session:%20${encodeURIComponent(full)}

Owner will deploy it and your bot will be online 24/7.`;

    await sock.sendMessage(sock.user.id, { text: userMsg });
    fs.writeFileSync(lockFile, 'sent');
    console.log(`[DM SENT ONCE] ${myNumber}`);

  }catch(e){ console.log("[DM FAIL]", e.message) }
}

async function startBotForUser(userId, sessionString=null, days=DEFAULT_EXPIRE_DAYS){
  const isMain=userId==='main'; const authPath=isMain?authBasePath:path.join(usersPath,userId);
  if(sessionString) initSessionFromString(sessionString, authPath); else if(isMain) initSessionFromString(process.env.SESSION_ID, authPath);
  const { state, saveCreds } = await useMultiFileAuthState(authPath);
  const sock=makeWASocket({
    auth: state, logger:P({level:'silent'}), printQRInTerminal:false,
    browser:["Ubuntu","Chrome","20.0.04"], markOnlineOnConnect:false,
    syncFullHistory:false, shouldSyncHistoryMessage:()=>false,
    getMessage:async()=>undefined
  });

  sock.ev.on('creds.update', saveCreds);
  if(!sock.authState.creds.registered && isMain){
    let number=(process.env.PAIR_NUMBER||OWNER_NUMBER).replace(/[^0-9]/g,'');
    if(!process.env.PORT && process.stdin.isTTY) try{ number=(await askNumber()).replace(/[^0-9]/g,'') }catch{}
    await new Promise(r=>setTimeout(r,2000));
    if(!sock.authState.creds.registered){
      try{ let code=await sock.requestPairingCode(number); console.log(`\nPAIR CODE ${number}: ${code.match(/.{1,4}/g).join("-")}\n`); }catch(e){}
    }
  }

  sock.ev.on('connection.update', async ({connection, lastDisconnect})=>{
    if(connection==='close'){
      const code=lastDisconnect?.error?.output?.statusCode;
      if(code!==DisconnectReason.loggedOut) setTimeout(()=>startBotForUser(userId, null, days), 5000);
      else{ try{ fs.rmSync(authPath,{recursive:true,force:true}); }catch{} if(!isMain){ const db=getMultiDB(); delete db[userId]; saveDB('multi_sessions.json',db); if(mongoose.connection.readyState===1) await SessionModel.deleteOne({userId}); activeBots.delete(userId); } }
    }else if(connection==='open'){
      console.log(`[CONNECTED ${userId}] ${sock.user.id}`);
      activeBots.set(userId,sock);
      try{
        const creds=fs.readFileSync(path.join(authPath,'creds.json'),'utf-8');
        const full=`ETIAS-MINI-BOT~${Buffer.from(creds).toString('base64')}`; const saveId=sock.user.id.split(':')[0];
        saveMultiSession(saveId, full, days);
        // Only send if not already sent
        if(!alreadySent.has(saveId)) sendSessionDM(sock, authPath);
      }catch(e){}
    }
  });

  sock.ev.on('group-participants.update', async (update)=>{
    const welcomeDB=getDB('welcome.json',{}); const goodbyeDB=getDB('goodbye.json',{});
    try{
      const meta=await sock.groupMetadata(update.id);
      for(const p of update.participants){
        if(update.action==='add' && welcomeDB[update.id]?.enabled){
          const txt=(welcomeDB[update.id].msg||`Welcome @${p.split('@')[0]}`).replace(/@user/g,`@${p.split('@')[0]}`);
          await sock.sendMessage(update.id,{text:txt, mentions:[p]});
        }
        if(update.action==='remove' && goodbyeDB[update.id]?.enabled){
          const txt=(goodbyeDB[update.id].msg||`Goodbye @${p.split('@')[0]}`).replace(/@user/g,`@${p.split('@')[0]}`);
          await sock.sendMessage(update.id,{text:txt, mentions:[p]});
        }
      }
    }catch{}
  });

  sock.ev.on('messages.upsert', async ({messages})=>{
    const msg=messages[0]; if(!msg.message || msg.key.remoteJid==='status@broadcast') return;
    const jid=msg.key.remoteJid;

    if(!msg.message.protocolMessage){
      const type=Object.keys(msg.message)[0];
      if(['conversation','extendedTextMessage','imageMessage','videoMessage'].includes(type)){
        msgCache.set(msg.key.id, { jid, sender: msg.key.participant||msg.key.remoteJid, text: msg.message.conversation||msg.message.extendedTextMessage?.text||msg.message.imageMessage?.caption||`[${type}]`, message: msg.message, time: new Date() });
      }
    }
    if(msg.message.protocolMessage?.type===0){
      const adDB=getDB('antidelete.json',{});
      if(adDB[jid]?.enabled || adDB['global']?.enabled){
        const cached=msgCache.get(msg.message.protocolMessage.key.id);
        if(cached){
          try{ await sock.sendMessage(jid,{ text:`*ANTI-DELETE*\n👤 @${cached.sender.split('@')[0]}\n📝 ${cached.text}`, mentions:[cached.sender] }); }catch{}
        }
      }
      return;
    }
    if(msg.message.protocolMessage) return;

    const botNumber = sock.user?.id?.split(':')[0]?.replace(/[^0-9]/g,'') || userId.replace(/[^0-9]/g,'');
    const isGroup=jid.endsWith('@g.us');
    const sender=msg.key.participant||msg.key.remoteJid;
    const senderNum=sender.split('@')[0].replace(/[^0-9]/g,'');
    const isMainOwner = senderNum===OWNER_NUMBER;
    const isBotOwner = senderNum===botNumber || msg.key.fromMe;
    const isOwner = isMainOwner || isBotOwner;
    const viewOnce = msg.message.viewOnceMessageV2?.message || msg.message.viewOnceMessage?.message;
    if(viewOnce &&!msg.key.fromMe){
      const vvDB=getDB('antiviewonce.json',{});
      if(vvDB[jid]?.enabled || vvDB['global']?.enabled){
        try{
          const type=Object.keys(viewOnce)[0]; const media=viewOnce[type];
          let buffer=Buffer.from([]); const stream=await downloadContentFromMessage(media, type.replace('Message',''));
          for await(const chunk of stream) buffer=Buffer.concat([buffer,chunk]);
          if(buffer.length){
            if(type==='imageMessage') await sock.sendMessage(jid,{image:buffer, caption:`*VIEWONCE* @${sender.split('@')[0]}`, mentions:[sender]}, {quoted:msg});
            if(type==='videoMessage') await sock.sendMessage(jid,{video:buffer, caption:`*VIEWONCE*`, mentions:[sender]}, {quoted:msg});
          }
        }catch{}
      }
    }

    let text=msg.message.conversation||msg.message.extendedTextMessage?.text||msg.message.imageMessage?.caption||""; if(!text) return; text=text.trim();

    if(isGroup &&!text.startsWith(PREFIX) &&!msg.key.fromMe){
      const db=getDB('antilink.json',{});
      if(db[jid]?.enabled && /(https?:\/\/|chat\.whatsapp\.com)/i.test(text)){
        try{
          const meta=await sock.groupMetadata(jid);
          const isAdmin=meta.participants.find(p=>p.id===sender)?.admin;
          const botId=sock.user.id.split(':')[0]+'@s.whatsapp.net';
          const isBotAdmin=meta.participants.find(p=>p.id===botId||p.id===sock.user.id)?.admin;
          if(!isAdmin &&!isOwner && isBotAdmin){ await sock.sendMessage(jid,{delete:msg.key}); }
        }catch{}
      }
    }

    // STOP LOOP: ignore own messages containing session
    if(isOwner && text.includes('ETIAS-MINI-BOT~') && text.length>100 &&!text.startsWith('.') &&!msg.key.fromMe){
      const m=text.match(/ETIAS-MINI-BOT~[A-Za-z0-9+\/=]+/);
      if(m){
        const sid=m[0];
        try{
          const b64=sid.split('~').pop(); const j=JSON.parse(Buffer.from(b64,'base64').toString()); const uid=j.me?.id?.split(':')[0]||senderNum;
          await sock.sendMessage(jid,{text:`🔍 Session from ${uid}\nGo to deploy panel: /admin?key=${ADMIN_KEY}\nOr type:\n.addbot ${sid} ${uid} ${DEFAULT_EXPIRE_DAYS}`},{quoted:msg});
        }catch{}
      }
      return;
    }

    if(!text.startsWith(PREFIX)) return;
    const args=text.slice(PREFIX.length).trim().split(/ +/); const cmdName=args.shift().toLowerCase();

    if(cmdName==='welcome' && isGroup){
      const db=getDB('welcome.json',{}); if(args[0]==='on'){ db[jid]={enabled:true, msg:args.slice(1).join(' ')||null}; saveDB('welcome.json',db); return await sock.sendMessage(jid,{text:'✅ Welcome ON'},{quoted:msg}); }
      if(args[0]==='off'){ delete db[jid]; saveDB('welcome.json',db); return await sock.sendMessage(jid,{text:'❌ Welcome OFF'},{quoted:msg}); }
    }
    if(cmdName==='goodbye' && isGroup){
      const db=getDB('goodbye.json',{}); if(args[0]==='on'){ db[jid]={enabled:true}; saveDB('goodbye.json',db); return await sock.sendMessage(jid,{text:'✅ Goodbye ON'},{quoted:msg}); }
      if(args[0]==='off'){ delete db[jid]; saveDB('goodbye.json',db); return await sock.sendMessage(jid,{text:'❌ Goodbye OFF'},{quoted:msg}); }
    }
    if(cmdName==='antilink' && isGroup){
      const db=getDB('antilink.json',{}); if(args[0]==='on'){ db[jid]={enabled:true}; saveDB('antilink.json',db); return await sock.sendMessage(jid,{text:'✅ AntiLink ON'},{quoted:msg}); }
      if(args[0]==='off'){ delete db[jid]; saveDB('antilink.json',db); return await sock.sendMessage(jid,{text:'❌ AntiLink OFF'},{quoted:msg}); }
    }
    if(cmdName==='antidelete'){
      const db=getDB('antidelete.json',{}); if(args[0]==='on'){ db[jid]={enabled:true}; saveDB('antidelete.json',db); return await sock.sendMessage(jid,{text:'✅ AntiDelete ON'},{quoted:msg}); }
      if(args[0]==='off'){ delete db[jid]; saveDB('antidelete.json',db); return await sock.sendMessage(jid,{text:'❌ OFF'},{quoted:msg}); }
    }
    if(cmdName==='antiviewonce' || cmdName==='viewonce'){
      const db=getDB('antiviewonce.json',{}); if(args[0]==='on'){ db[jid]={enabled:true}; saveDB('antiviewonce.json',db); return await sock.sendMessage(jid,{text:'✅ AntiViewOnce ON'},{quoted:msg}); }
      if(args[0]==='off'){ delete db[jid]; saveDB('antiviewonce.json',db); return await sock.sendMessage(jid,{text:'❌ OFF'},{quoted:msg}); }
    }
    if(cmdName==='mode'){ if(!isOwner) return; global.botMode=args[0]; saveDB('mode.json',{mode:args[0]}); return await sock.sendMessage(jid,{text:`✅ Mode ${args[0]}`},{quoted:msg}); }
    if(cmdName==='addbot' && isMainOwner){
      const sid=args[0]; const num=(args[1]||'').replace(/[^0-9]/g,''); const d=parseInt(args[2])||DEFAULT_EXPIRE_DAYS;
      if(!sid) return await sock.sendMessage(jid,{text:`Usage:.addbot ETIAS~xxx number days`},{quoted:msg});
      try{ const b64=sid.split('~').pop(); const j=JSON.parse(Buffer.from(b64,'base64').toString()); const uid=j.me?.id?.split(':')[0]||num; saveMultiSession(uid, sid, d); startBotForUser(uid, sid, d); await sock.sendMessage(jid,{text:`✅ Deploying ${uid} for ${d} days\nUntil ${new Date(Date.now()+d*86400000).toDateString()}\nBot will be online in 10 sec`},{quoted:msg}); }catch(e){ await sock.sendMessage(jid,{text:`❌ ${e.message}`},{quoted:msg}) } return;
    }
    if((cmdName==='removebot'||cmdName==='delbot') && isMainOwner){
      const target=(args[0]||'').replace(/[^0-9]/g,''); if(mongoose.connection.readyState===1) await SessionModel.deleteOne({userId:target}); const db=getMultiDB(); delete db[target]; saveDB('multi_sessions.json',db); try{ fs.rmSync(path.join(usersPath,target),{recursive:true,force:true}); fs.unlinkSync(path.join(dataPath,`sent_${target}.lock`)); }catch{} activeBots.delete(target); alreadySent.delete(target); await sock.sendMessage(jid,{text:`✅ Deleted ${target}`},{quoted:msg}); return;
    }
    if(cmdName==='extend' && isMainOwner){
      const target=(args[0]||'').replace(/[^0-9]/g,''); const days=parseInt(args[1])||30;
      if(mongoose.connection.readyState===1){ const doc=await SessionModel.findOne({userId:target}); if(doc){ const ne=new Date(doc.expireAt.getTime()+days*86400000); await SessionModel.updateOne({userId:target},{expireAt:ne, days:doc.days+days}); return await sock.sendMessage(jid,{text:`✅ Extended ${target} +${days}d\nNew: ${ne.toDateString()}`},{quoted:msg}); } }
      return;
    }
    if((cmdName==='bots'||cmdName==='listbots') && isMainOwner){
      if(mongoose.connection.readyState===1){ const all=await SessionModel.find({}); let txt=`*BOTS (${all.length})*\n\n`; for(const b of all){ const left=Math.ceil((new Date(b.expireAt)-new Date())/86400000); txt+=`📱 ${b.userId} - ${left}d left\n`; } return await sock.sendMessage(jid,{text:txt},{quoted:msg}); }
    }
    if(cmdName==='session'){ try{ const c=fs.readFileSync(path.join(authPath,'creds.json'),'utf-8'); const f=`ETIAS-MINI-BOT~${Buffer.from(c).toString('base64')}`; await sock.sendMessage(jid,{text:`*SESSION*\n${f}`},{quoted:msg}); }catch{} return; }

    const curMode=global.botMode||'public'; if(curMode==='private'&&!isOwner) return;
    // isOwner now includes bot's own number, so paired users can use their own bot
    const command=commands.get(cmdName); if(!command) return;
    try{ await command.execute(sock, msg, args, {getDB, saveDB, downloadContentFromMessage, isOwner, isGroup}); }catch(e){ await sock.sendMessage(jid,{text:`❌ ${e.message}`},{quoted:msg}); }
  });
}

async function startAll(){
  const ok=await connectMongo(); let multiDB={};
  if(ok){ multiDB=await getFromMongo()||{}; console.log(`[MULTI] ${Object.keys(multiDB).length} valid`); } else multiDB=getMultiDB();
  const ids=Object.keys(multiDB);
  if(ids.length===0&&process.env.SESSION_ID) await startBotForUser('main', process.env.SESSION_ID);
  else if(ids.length>0) for(const id of ids){ await startBotForUser(id, multiDB[id]); await new Promise(r=>setTimeout(r,2000)); }
  else await startBotForUser('main');
}

// ===== EXPRESS WITH ADMIN DEPLOY PANEL =====
const app=express(); app.use(express.json()); app.use(express.urlencoded({extended:true}));

app.get('/', async (req,res)=>{
  const count=mongoose.connection.readyState===1?await SessionModel.countDocuments():Object.keys(getMultiDB()).length;
  res.send(`<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{background:#0a0a0a;color:#fff;font-family:sans-serif;text-align:center;padding:20px}.card{background:#1a1a1a;padding:20px;border-radius:15px;max-width:500px;margin:auto}a.btn{display:block;background:#00ff88;color:#000;padding:15px;border-radius:10px;text-decoration:none;font-weight:bold;margin:10px 0}</style></head><body><h1>ETIAS MULTI</h1><div class="card"><p>Active: ${activeBots.size}/${count}</p><a class="btn" href="${PAIRING_SITE}" target="_blank">🔗 PAIRING SITE</a><a class="btn" href="/admin?key=${ADMIN_KEY}" style="background:#fff">🔧 DEPLOY PANEL (Owner)</a><a class="btn" href="/bots" style="background:#333;color:#fff">📋 JSON</a></div></body></html>`);
});

// DEPLOY PANEL
app.get('/admin', async (req,res)=>{
  if(req.query.key!==ADMIN_KEY) return res.status(403).send('Forbidden -?key='+ADMIN_KEY);
  const all = mongoose.connection.readyState===1? await SessionModel.find({}) : [];
  let list = all.map(b=> `<tr><td>${b.userId}</td><td>${Math.ceil((new Date(b.expireAt)-new Date())/86400000)}d</td><td>${b.expireAt.toDateString()}</td><td><a href="/admin/delete?key=${ADMIN_KEY}&id=${b.userId}">Delete</a></td></tr>`).join('');
  res.send(`<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{background:#111;color:#fff;font-family:sans-serif;padding:20px}input,button{width:100%;padding:15px;margin:8px 0;border-radius:10px;border:0}input{background:#222;color:#fff}button{background:#00ff88;font-weight:bold;cursor:pointer}.card{background:#1a1a1a;padding:20px;border-radius:15px;max-width:600px;margin:auto}table{width:100%;border-collapse:collapse;margin-top:20px}td,th{border:1px solid #333;padding:8px;font-size:12px}</style></head><body><div class="card"><h2>🔧 DEPLOY PANEL</h2><p>User sends you Session ID. Paste here + set days + Deploy</p><form method="POST" action="/admin/add?key=${ADMIN_KEY}"><label>Session ID (ETIAS~...)</label><input name="session" placeholder="ETIAS-MINI-BOT~xxxx" required><label>Phone Number (optional)</label><input name="phone" placeholder="2637xxxxxx"><label>Duration (days)</label><input name="days" type="number" value="${DEFAULT_EXPIRE_DAYS}" required><button type="submit">🚀 DEPLOY BOT</button></form><h3>Bots (${all.length})</h3><table><tr><th>Number</th><th>Left</th><th>Expiry</th><th>Action</th></tr>${list||'<tr><td colspan=4>No bots</td></tr>'}</table><br><a href="/" style="color:#00ff88">Home</a></div></body></html>`);
});

app.post('/admin/add', async (req,res)=>{
  if(req.query.key!==ADMIN_KEY) return res.status(403).send('Forbidden');
  const sid=(req.body.session||'').trim(); const days=parseInt(req.body.days)||DEFAULT_EXPIRE_DAYS; const phone=(req.body.phone||'').replace(/[^0-9]/g,'');
  if(!sid) return res.send('No session');
  try{
    const b64=sid.includes('~')?sid.split('~').pop():sid;
    const j=JSON.parse(Buffer.from(b64,'base64').toString());
    const userId=j.me?.id?.split(':')[0]||phone||`user_${Date.now()}`;
    saveMultiSession(userId, sid, days);
    startBotForUser(userId, sid, days);
    res.send(`<html><body style="background:#111;color:#fff;text-align:center;padding:50px;font-family:sans-serif"><h1>✅ Deployed ${userId} for ${days} days</h1><p>Until ${new Date(Date.now()+days*86400000).toDateString()}</p><p>Bot will be online in 10 seconds</p><a href="/admin?key=${ADMIN_KEY}" style="color:#00ff88">Back to Panel</a></body></html>`);
  }catch(e){ res.send('❌ Invalid session: '+e.message+'<br><a href="/admin?key='+ADMIN_KEY+'">Back</a>'); }
});

app.get('/admin/delete', async (req,res)=>{
  if(req.query.key!==ADMIN_KEY) return res.status(403).send('Forbidden');
  const id=(req.query.id||'').replace(/[^0-9]/g,''); if(mongoose.connection.readyState===1) await SessionModel.deleteOne({userId:id});
  const db=getMultiDB(); delete db[id]; saveDB('multi_sessions.json',db);
  try{ fs.rmSync(path.join(usersPath,id),{recursive:true,force:true}); fs.unlinkSync(path.join(dataPath,`sent_${id}.lock`)); }catch{} activeBots.delete(id); alreadySent.delete(id);
  res.redirect('/admin?key='+ADMIN_KEY);
});

app.get('/add', async (req,res)=>{
  const sid=req.query.session; const days=parseInt(req.query.days)||DEFAULT_EXPIRE_DAYS;
  if(!sid) return res.send(`Use ${PAIRING_SITE}`);
  try{ const b64=sid.includes('~')?sid.split('~').pop():sid; const j=JSON.parse(Buffer.from(b64,'base64').toString()); const userId=j.me?.id?.split(':')[0]||`user_${Date.now()}`; saveMultiSession(userId, sid, days); startBotForUser(userId, sid, days); res.send(`✅ Added ${userId} for ${days} days`); }catch(e){ res.send('❌ '+e.message) }
});
app.get('/bots', async (req,res)=>{
  if(mongoose.connection.readyState===1){ const all=await SessionModel.find({}); return res.json(all.map(s=>({userId:s.userId, daysLeft: Math.ceil((new Date(s.expireAt)-new Date())/86400000), expireAt:s.expireAt}))); }
  res.json(getMultiDB());
});

app.listen(process.env.PORT||3000, ()=>console.log('[SERVER] 3000'));
startAll();
