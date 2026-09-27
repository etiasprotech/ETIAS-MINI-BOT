require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadContentFromMessage } = require('@whiskeysockets/baileys');
const fs = require('fs');
const path = require('path');
const P = require('pino');
const readline = require('readline');
const express = require('express');
const mongoose = require('mongoose');

process.on('uncaughtException', (err)=>{ if(err.message.includes('Session')||err.message.includes('MAC')||err.message.includes('decrypt')){console.log('[IGNORED]',err.message);return;} console.log(err); });
process.on('unhandledRejection', (err)=>{ if(err?.message?.includes('Session')||err?.message?.includes('MAC')){console.log('[IGNORED]',err.message);return;} console.log(err); });

const BOT_NAME = "*ETIAS-MINI-BOT*";
const PREFIX = ".";
const OWNER_NUMBER = (process.env.OWNER_NUMBER || "263778810589").replace(/[^0-9]/g,'');
const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URL;
const PAIRING_SITE = "https://etias-mini-bot-pair.onrender.com/";

require('./server.js');
mongoose.connect(process.env.MONGODB_URI)

const dataPath = path.join(__dirname, 'data');
const authBasePath = path.join(__dirname, 'auth');
const usersPath = path.join(authBasePath, 'users');
[ dataPath, authBasePath, usersPath ].forEach(p=>{ if(!fs.existsSync(p)) fs.mkdirSync(p,{recursive:true}) });

let botMode = process.env.MODE || 'public';
try{ const f=path.join(dataPath,'mode.json'); if(fs.existsSync(f)) botMode=JSON.parse(fs.readFileSync(f,'utf-8')).mode||botMode; }catch{}
global.botMode = botMode;
console.log(`[MODE] ${botMode.toUpperCase()}`);

// ===== MONGODB =====
const sessionSchema = new mongoose.Schema({
  userId: { type: String, unique: true },
  sessionId: String,
  phone: String,
  connected: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});
const SessionModel = mongoose.models.Session || mongoose.model('Session', sessionSchema);

async function connectMongo(){
  if(!MONGODB_URI){ console.log("[MONGO] No MONGODB_URI - using file"); return false; }
  try{ await mongoose.connect(MONGODB_URI); console.log("[MONGO] ✅ Connected"); return true; }catch(e){ console.log("[MONGO] ❌",e.message); return false; }
}
async function saveToMongo(userId, sessionId){
  if(mongoose.connection.readyState!==1) return;
  try{ await SessionModel.findOneAndUpdate({ userId }, { sessionId, phone: userId, connected: true }, { upsert: true }); console.log(`[MONGO] Saved ${userId}`); }catch(e){ console.log("[MONGO SAVE]",e.message) }
}
async function getFromMongo(){
  if(mongoose.connection.readyState!==1) return null;
  const all = await SessionModel.find({});
  const obj = {}; all.forEach(s=>obj[s.userId]=s.sessionId); return obj;
}

const commands = new Map();
const cmdPath = path.join(__dirname, 'commands');
if(fs.existsSync(cmdPath)){
  for(const file of fs.readdirSync(cmdPath).filter(f=>f.endsWith('.js'))){
    try{ delete require.cache[require.resolve(path.join(cmdPath,file))]; const cmd=require(path.join(cmdPath,file)); const name=(cmd.name||file.replace('.js','')).toLowerCase(); commands.set(name,cmd); if(cmd.aliases) cmd.aliases.forEach(a=>commands.set(a.toLowerCase(),cmd)); }catch(e){}
  }
}

function getDB(f, def={}){ const p=path.join(dataPath,f); if(!fs.existsSync(p)) fs.writeFileSync(p, JSON.stringify(def)); try{return JSON.parse(fs.readFileSync(p))}catch{return def} }
function saveDB(f,d){ fs.writeFileSync(path.join(dataPath,f), JSON.stringify(d,null,2)); }
function getMultiDB(){ return getDB('multi_sessions.json', {}); }
function saveMultiSession(userId, sessionId){
  const db=getMultiDB(); db[userId]=sessionId; saveDB('multi_sessions.json', db);
  saveToMongo(userId, sessionId);
}
function initSessionFromString(sid, destPath){
  if(!sid) return false;
  try{
    const p=path.join(destPath,'creds.json'); if(fs.existsSync(p)&&fs.statSync(p).size>500) return true;
    let c=sid.trim().replace(/\s/g,''); if(c.includes("~")) c=c.split("~").pop();
    const d=Buffer.from(c,'base64').toString('utf-8');
    if(d.startsWith("{")){ if(!fs.existsSync(destPath)) fs.mkdirSync(destPath,{recursive:true}); fs.writeFileSync(p,d); console.log(`[SESSION] Restored ${path.basename(destPath)}`); return true; }
  }catch(e){ console.log("[SESSION]",e.message) } return false;
}
function askNumber(){ const rl=readline.createInterface({input:process.stdin,output:process.stdout}); return new Promise(r=>{rl.question(`📱 Enter number: `,a=>{rl.close(); r(a.trim()||OWNER_NUMBER)})}) }

const msgCache=new Map();
const activeBots=new Map();

async function startBotForUser(userId, sessionString=null){
  const isMain=userId==='main'; const authPath=isMain?authBasePath:path.join(usersPath,userId);
  if(sessionString) initSessionFromString(sessionString, authPath); else if(isMain) initSessionFromString(process.env.SESSION_ID, authPath);
  const { state, saveCreds } = await useMultiFileAuthState(authPath);
  const sock=makeWASocket({ auth: state, logger:P({level:'silent'}), printQRInTerminal:false, browser:["Ubuntu","Chrome","20.0.04"], markOnlineOnConnect:false, syncFullHistory:false, getMessage:async()=>undefined });

  sock.ev.on('creds.update', saveCreds);
  if(!sock.authState.creds.registered && isMain &&!process.env.PORT){
    let number=(process.env.PAIR_NUMBER||OWNER_NUMBER).replace(/[^0-9]/g,'');
    if(process.stdin.isTTY) try{ number=(await askNumber()).replace(/[^0-9]/g,'') }catch{}
    await new Promise(r=>setTimeout(r,3000));
    try{ let code=await sock.requestPairingCode(number); console.log(`\nPAIR CODE: ${code.match(/.{1,4}/g).join("-")} FOR ${number}\n`) }catch(e){console.log(e.message)}
  }

  sock.ev.on('connection.update', async ({connection, lastDisconnect})=>{
    if(connection==='close'){
      const code=lastDisconnect?.error?.output?.statusCode; console.log(`[CLOSE ${userId}]`,code);
      if(code!==DisconnectReason.loggedOut) setTimeout(()=>startBotForUser(userId),3000);
      else{ try{ fs.rmSync(authPath,{recursive:true,force:true}); }catch{} if(!isMain){ const db=getMultiDB(); delete db[userId]; saveDB('multi_sessions.json',db); if(mongoose.connection.readyState===1) await SessionModel.deleteOne({userId}); activeBots.delete(userId); } }
    }else if(connection==='open'){
      console.log(`\n[CONNECTED ${userId}] ${BOT_NAME} - ${sock.user.id}\n`); activeBots.set(userId,sock);
      try{
        const creds=fs.readFileSync(path.join(authPath,'creds.json'),'utf-8');
        const full=`ETIAS-MINI-BOT~${Buffer.from(creds).toString('base64')}`; const saveId=isMain?sock.user.id.split(':')[0]:userId;
        saveMultiSession(saveId, full);
      }catch(e){ console.log(e.message) }
    }
  });

  sock.ev.on('group-participants.update', async (update)=>{
    const welcomeDB=getDB('welcome.json',{}); const goodbyeDB=getDB('goodbye.json',{});
    try{ const meta=await sock.groupMetadata(update.id); for(const p of update.participants){ if(update.action==='add'&&welcomeDB[update.id]?.enabled){ await sock.sendMessage(update.id,{text:`Welcome @${p.split('@')[0]}`, mentions:[p]}); } } }catch{}
  });

  sock.ev.on('messages.upsert', async ({messages})=>{
    const msg=messages[0]; if(!msg.message) return; const jid=msg.key.remoteJid;
    const isGroup=jid.endsWith('@g.us'); const sender=msg.key.participant||msg.key.remoteJid; const senderNum=sender.split('@')[0].replace(/[^0-9]/g,''); const isOwner=senderNum===OWNER_NUMBER||msg.key.fromMe||senderNum===userId;
    let text=msg.message.conversation||msg.message.extendedTextMessage?.text||msg.message.imageMessage?.caption||msg.message.videoMessage?.caption||""; if(!text) return; text=text.trim();
    if(isGroup&&!text.startsWith(PREFIX)&&!msg.key.fromMe){ const db=getDB('antilink.json',{}); if(db[jid]?.enabled&&/(https?:\/\/|chat\.whatsapp\.com|wa\.me|t\.me)/i.test(text)){ try{ const meta=await sock.groupMetadata(jid); const isAdmin=meta.participants.find(p=>p.id===sender)?.admin; const botId=sock.user.id.split(':')[0]+'@s.whatsapp.net'; const isBotAdmin=meta.participants.find(p=>p.id===botId||p.id===sock.user.id)?.admin; if(!isAdmin&&isBotAdmin) await sock.sendMessage(jid,{delete:msg.key}); }catch{} } }
    if(!text.startsWith(PREFIX)) return; const args=text.slice(PREFIX.length).trim().split(/ +/); const cmdName=args.shift().toLowerCase();
    if(cmdName==='mode'){ if(!isOwner) return; const newMode=args[0]?.toLowerCase(); const valid=['public','private','groups','inbox']; if(!newMode||!valid.includes(newMode)) return; global.botMode=newMode; saveDB('mode.json',{mode:newMode}); return await sock.sendMessage(jid,{text:`✅ Mode ${newMode}`},{quoted:msg}); }
    if(cmdName==='session'){ try{ const c=fs.readFileSync(path.join(authPath,'creds.json'),'utf-8'); const f=`ETIAS-MINI-BOT~${Buffer.from(c).toString('base64')}`; await sock.sendMessage(jid,{text:`*SESSION*\n${f}\n\nPair Site: ${PAIRING_SITE}`},{quoted:msg}); }catch{} return; }
    if(cmdName==='listbots'&&isOwner){ const list=Array.from(activeBots.keys()).join('\n'); const mongoCount=mongoose.connection.readyState===1?await SessionModel.countDocuments():0; return await sock.sendMessage(jid,{text:`*ACTIVE: ${activeBots.size}*\n${list}\n\nDB Total: ${mongoCount}\nPair: ${PAIRING_SITE}`},{quoted:msg}); }
    const curMode=global.botMode||'public'; if(curMode==='private'&&!isOwner) return; const command=commands.get(cmdName); if(!command) return; try{ await command.execute(sock, msg, args, {getDB, saveDB, downloadContentFromMessage, isOwner, isGroup}); }catch(e){ await sock.sendMessage(jid,{text:`❌ ${e.message}`},{quoted:msg}); }
  });
}

async function startAll(){
  await connectMongo();
  let multiDB={};
  if(mongoose.connection.readyState===1){ multiDB=await getFromMongo()||{}; console.log(`[MULTI] Loaded ${Object.keys(multiDB).length} from MongoDB`); } else { multiDB=getMultiDB(); }

  const ids=Object.keys(multiDB);
  if(ids.length===0&&process.env.SESSION_ID){ await startBotForUser('main', process.env.SESSION_ID); }
  else if(ids.length>0){ for(const id of ids){ console.log(`[MULTI] Starting ${id}`); await startBotForUser(id, multiDB[id]); await new Promise(r=>setTimeout(r,2000)); } if(process.env.SESSION_ID&&!multiDB['main']) await startBotForUser('main', process.env.SESSION_ID); }
  else { await startBotForUser('main'); }
}

// EXPRESS + PAIRING LINK
const app=express(); app.use(express.json());
app.get('/', async (req,res)=>{
  const mongoCount=mongoose.connection.readyState===1?await SessionModel.countDocuments():Object.keys(getMultiDB()).length;
  res.send(`
  <html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
  body{background:#0a0a0a;color:#fff;font-family:sans-serif;text-align:center;padding:20px}
 .card{background:#1a1a1a;padding:20px;border-radius:15px;max-width:450px;margin:auto}
  a.btn{display:block;background:#00ff88;color:#000;padding:15px;border-radius:10px;text-decoration:none;font-weight:bold;margin:10px 0}
  </style></head><body>
  <h1>🤖 ETIAS-MINI MULTI + MONGO</h1>
  <div class="card">
  <p>Active Bots: ${activeBots.size}<br>Total in MongoDB: ${mongoCount}</p>
  <a class="btn" href="${PAIRING_SITE}" target="_blank">🔗 GO TO PAIRING SITE</a>
  <a class="btn" href="/bots" style="background:#333;color:#fff">📋 View Bots JSON</a>
  <p style="font-size:12px;color:#888">Pair via: ${PAIRING_SITE}<br>Add via: /add?session=ETIAS~xxx</p>
  </div></body></html>
  `);
});
app.get('/add', async (req,res)=>{
  const sid=req.query.session; if(!sid) return res.send(`Use ${PAIRING_SITE} or /add?session=ETIAS~xxx`);
  try{ const b64=sid.includes('~')?sid.split('~').pop():sid; const j=JSON.parse(Buffer.from(b64.trim(),'base64').toString('utf-8')); const userId=j.me?.id?.split(':')[0]||`user_${Date.now()}`; saveMultiSession(userId, sid); startBotForUser(userId, sid); res.send(`✅ Added ${userId}. <a href="/">Home</a> | <a href="${PAIRING_SITE}">Pair Site</a>`); }catch(e){ res.send('❌ Invalid: '+e.message) }
});
app.get('/bots', async (req,res)=>{
  if(mongoose.connection.readyState===1){ const all=await SessionModel.find({}); return res.json({ active: Array.from(activeBots.keys()), total: all.length, pairingSite: PAIRING_SITE, sessions: all }); }
  res.json({ active: Array.from(activeBots.keys()), saved: Object.keys(getMultiDB()), pairingSite: PAIRING_SITE });
});
app.get('/pair', (req,res)=> res.redirect(PAIRING_SITE));

app.listen(process.env.PORT||3000, ()=>console.log('[SERVER] 3000'));
startAll();
