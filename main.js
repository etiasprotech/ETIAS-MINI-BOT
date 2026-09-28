// ============================================================
// ETIAS-MINI-BOT - DEPLOY DASHBOARD FINAL
// PAIR SITE: https://etias-mini-bot-pair.onrender.com
// OWNER: 263778810589 always main owner
// FEATURES: viewonce, antidelete, antilink, antiviewonce
// ============================================================
require("dotenv").config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadContentFromMessage } = require("@whiskeysockets/baileys");
const fs = require("fs"); const path = require("path"); const P = require("pino"); const express = require("express"); const mongoose = require("mongoose");

process.on("uncaughtException", (err) => { const m=err?.message||""; if(m.includes("Session")||m.includes("MAC")||m.includes("decrypt")||m.includes("Closing open session")) return; console.error(err); });
process.on("unhandledRejection", (err) => { const m=err?.message||""; if(m.includes("Session")||m.includes("MAC")||m.includes("decrypt")||m.includes("Connection Closed")) return; console.error(err); });

const BOT_NAME="*ETIAS-MINI-BOT*"; const PREFIX=".";
const MAIN_OWNER="263778810589";
const OWNER_NUMBER=(process.env.OWNER_NUMBER||MAIN_OWNER).replace(/[^0-9]/g,"");
const MONGODB_URI=process.env.MONGODB_URI||process.env.MONGO_URL||"";
const PAIRING_SITE="https://etias-mini-bot-pair.onrender.com";
const SESSION_DAYS_DEFAULT=30;

const dataPath=path.join(__dirname,"data"); const authBasePath=path.join(__dirname,"auth"); const usersPath=path.join(authBasePath,"users"); const tempAuthPath=path.join(__dirname,"temp_auth");
[dataPath,authBasePath,usersPath,tempAuthPath].forEach(d=>{ if(!fs.existsSync(d)) fs.mkdirSync(d,{recursive:true}); });

let botMode=process.env.MODE||"public"; try{ const mf=path.join(dataPath,"mode.json"); if(fs.existsSync(mf)){ const md=JSON.parse(fs.readFileSync(mf,"utf8")); if(md.mode) botMode=md.mode; } }catch{} global.botMode=botMode;

const sessionSchema=new mongoose.Schema({
    userId:{type:String,unique:true,index:true}, sessionId:String, phone:String, connected:{type:Boolean,default:false},
    createdAt:{type:Date,default:Date.now}, lastConnectedAt:{type:Date,default:null},
    expiresAt:{type:Date,default:null,index:true}, days:{type:Number,default:30}, addedBy:{type:String,default:MAIN_OWNER}
});
const SessionModel=mongoose.models.Session||mongoose.model("Session",sessionSchema);

async function connectMongo(){ if(!MONGODB_URI){ console.log("[MONGO] No URI - local"); return false; } try{ if(mongoose.connection.readyState===1) return true; await mongoose.connect(MONGODB_URI); console.log("[MONGO] ✅ Connected"); return true; }catch(e){ console.log("[MONGO] ❌",e.message); return false; } }
function isExpired(d){ if(!d) return false; return new Date(d).getTime()<=Date.now(); }
async function saveToMongo(userId,sessionId,days=30){
    if(mongoose.connection.readyState!==1) return;
    try{
        const expiresAt=new Date(Date.now()+days*24*60*60*1000);
        await SessionModel.findOneAndUpdate({userId},{sessionId,phone:userId,connected:true,lastConnectedAt:new Date(),expiresAt,days,addedBy:MAIN_OWNER},{upsert:true,new:true});
        console.log(`[MONGO] Saved ${userId} ${days} days`);
    }catch(e){ console.log("[MONGO SAVE]",e.message); }
}
async function getFromMongo(){
    if(mongoose.connection.readyState!==1) return {};
    const sessions=await SessionModel.find({}); const result={};
    for(const s of sessions){
        if(s.expiresAt&&isExpired(s.expiresAt)){ console.log(`[EXPIRY] ${s.userId}`); try{ await SessionModel.deleteOne({_id:s._id}); }catch{} const la=s.userId==="main"?authBasePath:path.join(usersPath,s.userId); try{ fs.rmSync(la,{recursive:true,force:true}); }catch{} continue; }
        if(s.sessionId) result[s.userId]={sessionId:s.sessionId,days:s.days,expiresAt:s.expiresAt};
    }
    return result;
}
function getDB(f,def={}){ const fp=path.join(dataPath,f); if(!fs.existsSync(fp)) fs.writeFileSync(fp,JSON.stringify(def,null,2)); try{ return JSON.parse(fs.readFileSync(fp,"utf8")); }catch{ return def; } }
function saveDB(f,d){ fs.writeFileSync(path.join(dataPath,f),JSON.stringify(d,null,2)); }
function getMultiDB(){ return getDB("multi_sessions.json",{}); }
function saveMultiSession(userId,sessionId,days=30){ const db=getMultiDB(); db[userId]={sessionId,days,addedAt:Date.now(),expiresAt:Date.now()+days*24*60*60*1000}; saveDB("multi_sessions.json",db); saveToMongo(userId,sessionId,days); }
function initSessionFromString(sessionString,destination){
    if(!sessionString) return false;
    try{
        const cp=path.join(destination,"creds.json"); if(fs.existsSync(cp)&&fs.statSync(cp).size>500) return true;
        let clean=sessionString.trim().replace(/\s/g,""); if(clean.includes("~")) clean=clean.split("~").pop();
        const decoded=Buffer.from(clean,"base64").toString("utf8"); if(decoded.startsWith("{")){
            if(!fs.existsSync(destination)) fs.mkdirSync(destination,{recursive:true}); fs.writeFileSync(cp,decoded); console.log(`[SESSION] Restored ${path.basename(destination)}`); return true;
        }
    }catch(e){ console.log("[SESSION RESTORE]",e.message); } return false;
}
const sentDM=new Set();
async function sendSessionDMOnce(sock,authPath){
  try{ const myNumber=normalizeNumber(sock.user?.id||""); if(!myNumber) return; const lf=path.join(dataPath,`sent_${myNumber}.lock`); if(fs.existsSync(lf)||sentDM.has(myNumber)) return; await new Promise(r=>setTimeout(r,3000)); const cp=path.join(authPath,"creds.json"); if(!fs.existsSync(cp)) return; const creds=fs.readFileSync(cp,'utf8'); const full=`ETIAS-MINI-BOT~${Buffer.from(creds).toString("base64")}`; await sock.sendMessage(sock.user.id,{text:full}); fs.writeFileSync(lf,Date.now().toString()); sentDM.add(myNumber); console.log(`[DM SENT ONCE] ${myNumber}`); }catch(e){ console.log("[DM FAIL]",e.message); }
}
const messageStore=new Map(); const pendingSessions=new Map(); const pairingCodes=new Map();
const commands=new Map(); const commandsPath=path.join(__dirname,"commands");
if(fs.existsSync(commandsPath)){ const files=fs.readdirSync(commandsPath).filter(f=>f.endsWith(".js")); for(const file of files){ try{ const fp=path.join(commandsPath,file); delete require.cache[require.resolve(fp)]; const cmd=require(fp); const name=(cmd.name||file.replace(".js","")).toLowerCase(); commands.set(name,cmd); if(Array.isArray(cmd.aliases)) for(const a of cmd.aliases) commands.set(a.toLowerCase(),cmd); }catch(e){ console.log(`[CMD ERR] ${file}`,e.message); } } }
console.log(`[COMMANDS] ${commands.size} loaded`);
const activeBots=new Map(); const startingBots=new Map(); const reconnectTimers=new Map(); const disconnect440History=new Map(); const stoppedBots=new Set();
const logsBuffer=[]; const MAX_LOGS=200; function addLog(msg){ const line=`[${new Date().toLocaleTimeString()}] ${msg}`; logsBuffer.push(line); if(logsBuffer.length>MAX_LOGS) logsBuffer.shift(); console.log(msg); }

function normalizeNumber(v){ if(!v) return ""; return String(v).split(":")[0].split("@")[0].replace(/[^0-9]/g,""); }
function getSenderNumber(msg){ const k=msg?.key||{}; return normalizeNumber(k.participant||k.remoteJid||""); }
function isOwnerMessage(msg,userId){ const k=msg?.key||{}; if(k.fromMe) return true; const s=getSenderNumber(msg); if(s===MAIN_OWNER) return true; if(s===OWNER_NUMBER) return true; if(userId!=="main"&&s===normalizeNumber(userId)) return true; return false; }
function getMessageText(message){ if(!message) return ""; if(typeof message.conversation==="string") return message.conversation; if(message.extendedTextMessage?.text) return message.extendedTextMessage.text; if(message.imageMessage?.caption) return message.imageMessage.caption; if(message.videoMessage?.caption) return message.videoMessage.caption; if(message.documentMessage?.caption) return message.documentMessage.caption; if(message.viewOnceMessage?.message) return getMessageText(message.viewOnceMessage.message); if(message.viewOnceMessageV2?.message) return getMessageText(message.viewOnceMessageV2.message); if(message.viewOnceMessageV2Extension?.message) return getMessageText(message.viewOnceMessageV2Extension.message); return ""; }
function scheduleReconnect(userId,delay,sessionString=null){ if(stoppedBots.has(userId)) return; if(reconnectTimers.has(userId)) return; addLog(`[RECONNECT] ${userId} in ${delay/1000}s`); const t=setTimeout(async()=>{ reconnectTimers.delete(userId); try{ await startBotForUser(userId,sessionString); }catch(e){ addLog(`[RECONNECT ERR] ${userId} ${e.message}`); scheduleReconnect(userId,10000,sessionString); } },delay); reconnectTimers.set(userId,t); }
function clearReconnect(userId){ const t=reconnectTimers.get(userId); if(t){ clearTimeout(t); reconnectTimers.delete(userId); } }

async function startBotForUser(userId,sessionString=null){
    if(startingBots.has(userId)) return startingBots.get(userId); const exist=activeBots.get(userId); if(exist&&exist.user) return exist; stoppedBots.delete(userId);
    const startPromise=(async()=>{
        const isMain=userId==="main"; const authPath=isMain?authBasePath:path.join(usersPath,normalizeNumber(userId));
        if(sessionString) initSessionFromString(sessionString,authPath); else if(isMain&&process.env.SESSION_ID) initSessionFromString(process.env.SESSION_ID,authPath);
        const { state, saveCreds }=await useMultiFileAuthState(authPath);
        const sock=makeWASocket({ auth:state, logger:P({level:"silent"}), printQRInTerminal:false, browser:["ETIAS-MINI-BOT","Chrome","1.0.0"], markOnlineOnConnect:false, syncFullHistory:false, getMessage: async(key)=>messageStore.get(key.id)?.msg||undefined });
        activeBots.set(userId,sock); sock.ev.on("creds.update",saveCreds);
        sock.ev.on("connection.update", async update=>{
            const { connection, lastDisconnect }=update;
            if(connection==="open"){
                addLog(`[CONNECTED] ${userId} ID:${sock.user?.id} OWNER:${MAIN_OWNER}`); const curr=activeBots.get(userId); if(curr!==sock){ try{ sock.ws?.close(); }catch{} return; } clearReconnect(userId); disconnect440History.delete(userId);
                try{ const cp=path.join(authPath,"creds.json"); const creds=fs.readFileSync(cp,"utf8"); const full=`ETIAS-MINI-BOT~${Buffer.from(creds).toString("base64")}`; let saveId=normalizeNumber(sock.user?.id||""); if(!saveId||saveId.length<5) saveId=isMain?MAIN_OWNER:normalizeNumber(userId); const existingDays=getDB("multi_sessions.json",{})[saveId]?.days||SESSION_DAYS_DEFAULT; saveMultiSession(saveId,full,existingDays); }catch(e){ addLog(`[SESSION SAVE ERR] ${e.message}`); }
                addLog(`[READY] ${userId} Main Owner:${MAIN_OWNER}`); await sendSessionDMOnce(sock,authPath); return;
            }
            if(connection==="close"){
                const code=lastDisconnect?.error?.output?.statusCode; addLog(`[DISCONNECTED] ${userId} code=${code}`); const curr=activeBots.get(userId); if(curr!==sock) return; activeBots.delete(userId);
                if(code===DisconnectReason.loggedOut){ addLog(`[LOGGED OUT] ${userId}`); clearReconnect(userId); stoppedBots.add(userId); try{ fs.rmSync(authPath,{recursive:true,force:true}); }catch{} if(!isMain){ const db=getMultiDB(); delete db[userId]; saveDB("multi_sessions.json",db); if(mongoose.connection.readyState===1){ try{ await SessionModel.deleteOne({userId}); }catch{} } } return; }
                if(code===DisconnectReason.connectionReplaced||code===440){ const now=Date.now(); let hist=disconnect440History.get(userId)||[]; hist=hist.filter(t=>now-t<60000); hist.push(now); disconnect440History.set(userId,hist); addLog(`[440] ${userId} ${hist.length}/3`); if(hist.length>=3){ addLog(`[440 STOP] ${userId}`); stoppedBots.add(userId); clearReconnect(userId); return; } scheduleReconnect(userId,30000,sessionString); return; }
                if(!stoppedBots.has(userId)) scheduleReconnect(userId,5000,sessionString);
            }
        });
        sock.ev.on("group-participants.update", async update=>{ const welcomeDB=getDB("welcome.json",{}); const goodbyeDB=getDB("goodbye.json",{}); try{ for(const p of update.participants){ if(update.action==="add"&&welcomeDB[update.id]?.enabled) await sock.sendMessage(update.id,{text:`Welcome @${p.split("@")[0]}`,mentions:[p]}); if(update.action==="remove"&&goodbyeDB[update.id]?.enabled) await sock.sendMessage(update.id,{text:`Goodbye @${p.split("@")[0]}`,mentions:[p]}); } }catch(e){} });
        sock.ev.on("messages.update", async(updates)=>{ for(const update of updates){ try{ const antideleteDB=getDB("antidelete.json",{}); const enabled=antideleteDB[update.key?.remoteJid]?.enabled||antideleteDB["global"]?.enabled; if(!enabled) continue; if(update.update?.message===null){ const stored=messageStore.get(update.key.id); if(stored&&!stored.fromMe){ await sock.sendMessage(stored.jid,{text:`*🚫 ANTIDELETE*\n*From:* @${stored.sender.split('@')[0]}\n*Deleted:* ${stored.text||stored.type}`,mentions:[stored.sender]}); if(stored.msg?.message) await sock.sendMessage(stored.jid,{forward:stored.msg},{quoted:stored.msg}); } } }catch(e){} } });
        sock.ev.on("messages.upsert", async event=>{
            const messages=event?.messages||[]; if(!messages.length) return;
            for(const msg of messages){
                try{
                    if(!msg||!msg.message) continue; const key=msg.key||{}; const jid=key.remoteJid||""; if(!jid) continue; const isGroup=jid.endsWith("@g.us"); const fromMe=key.fromMe===true; const senderNumber=getSenderNumber(msg); let owner=isOwnerMessage(msg,userId)||fromMe;
                    messageStore.set(msg.key.id,{jid,text:getMessageText(msg.message),sender:key.participant||jid,type:Object.keys(msg.message||{})[0],msg,fromMe}); if(messageStore.size>1000){ const fk=messageStore.keys().next().value; messageStore.delete(fk); }
                    const antiviewonceDB=getDB("antiviewonce.json",{}); const viewonceEnabled=antiviewonceDB[jid]?.enabled||antiviewonceDB["global"]?.enabled||true;
                    let viewOnceMsg=msg.message.viewOnceMessage||msg.message.viewOnceMessageV2||msg.message.viewOnceMessageV2Extension;
                    if(viewOnceMsg&&viewonceEnabled){
                        try{ const inner=viewOnceMsg.message; const mtype=Object.keys(inner||{})[0]; const content=inner[mtype]; let buffer=null; if(content){ const stream=await downloadContentFromMessage(content,mtype.includes('image')?'image':mtype.includes('video')?'video':'audio'); let chunks=[]; for await(const c of stream) chunks.push(c); buffer=Buffer.concat(chunks); } const caption=content?.caption||""; const fwdText=`*👁️ ANTIVIEWONCE*\n*From:* @${senderNumber}\n*Chat:* ${jid}\n*Type:* ${mtype}\n${caption?`*Caption:* ${caption}`:""}`; if(buffer){ if(mtype.includes('image')) await sock.sendMessage(jid,{image:buffer,caption:fwdText,mentions:[key.participant||jid]}); else if(mtype.includes('video')) await sock.sendMessage(jid,{video:buffer,caption:fwdText,mentions:[key.participant||jid]}); }else{ await sock.sendMessage(jid,{text:fwdText,mentions:[key.participant||jid]}); } }catch(e){ console.log("[ANTIVIEWONCE ERR]",e.message); }
                    }
                    let text=getMessageText(msg.message); if(!text) continue; text=text.trim();
                    if(isGroup&&!text.startsWith(PREFIX)&&!fromMe){ const antiLinkDB=getDB("antilink.json",{}); const groupAntilink=antiLinkDB[jid]; if(groupAntilink?.enabled&&/(https?:\/\/|chat\.whatsapp\.com|wa\.me|t\.me|www\.)/i.test(text)){ try{ const metadata=await sock.groupMetadata(jid); const participant=metadata.participants.find(p=>p.id===key.participant); const isAdmin=!!participant?.admin; if(!isAdmin){ const botNumber=normalizeNumber(sock.user?.id); const botParticipant=metadata.participants.find(p=>normalizeNumber(p.id)===botNumber); const botIsAdmin=!!botParticipant?.admin; if(botIsAdmin){ await sock.sendMessage(jid,{delete:key}); if(groupAntilink.action==='kick'){ await sock.groupParticipantsUpdate(jid,[key.participant],"remove"); await sock.sendMessage(jid,{text:`*🚫 ANTILINK* @${senderNumber} removed`,mentions:[key.participant]}); }else{ await sock.sendMessage(jid,{text:`*🚫 ANTILINK* Link deleted from @${senderNumber}`,mentions:[key.participant]}); } } } }catch(e){} } }
                    if(!text.startsWith(PREFIX)) continue; const withoutPrefix=text.slice(PREFIX.length).trim(); if(!withoutPrefix) continue; const parts=withoutPrefix.split(/\s+/); const commandName=parts.shift().toLowerCase(); const args=parts;
                    if(commandName==="mode"){ if(!owner) continue; const newMode=args[0]?.toLowerCase(); const valid=["public","private","groups","inbox"]; if(!newMode||!valid.includes(newMode)){ await sock.sendMessage(jid,{text:`Current: ${global.botMode}\nAvailable: ${valid.join(", ")}`},{quoted:msg}); continue; } global.botMode=newMode; saveDB("mode.json",{mode:newMode}); await sock.sendMessage(jid,{text:`✅ Mode ${newMode}`},{quoted:msg}); continue; }
                    if(commandName==="antilink"){ if(!owner||!isGroup) continue; const act=args[0]?.toLowerCase(); let db=getDB("antilink.json",{}); if(!act){ await sock.sendMessage(jid,{text:`*ANTILINK*\n.antilink on / off / kick\nStatus: ${db[jid]?.enabled?"ON":"OFF"}`},{quoted:msg}); continue; } if(act==="on"){ db[jid]={enabled:true,action:"delete"}; saveDB("antilink.json",db); await sock.sendMessage(jid,{text:"✅ Antilink ON"},{quoted:msg}); } else if(act==="off"){ delete db[jid]; saveDB("antilink.json",db); await sock.sendMessage(jid,{text:"❌ Antilink OFF"},{quoted:msg}); } else if(act==="kick"){ db[jid]={enabled:true,action:"kick"}; saveDB("antilink.json",db); await sock.sendMessage(jid,{text:"✅ Antilink KICK"},{quoted:msg}); } continue; }
                    if(commandName==="antidelete"){ if(!owner) continue; const act=args[0]?.toLowerCase(); let db=getDB("antidelete.json",{}); if(!act){ await sock.sendMessage(jid,{text:`*ANTIDELETE*\n.antidelete on / off / global`},{quoted:msg}); continue; } if(act==="on"){ db[jid]={enabled:true}; saveDB("antidelete.json",db); await sock.sendMessage(jid,{text:"✅ Antidelete ON"},{quoted:msg}); } else if(act==="off"){ delete db[jid]; saveDB("antidelete.json",db); await sock.sendMessage(jid,{text:"❌ Antidelete OFF"},{quoted:msg}); } else if(act==="global"){ db["global"]={enabled:true}; saveDB("antidelete.json",db); await sock.sendMessage(jid,{text:"✅ Antidelete GLOBAL"},{quoted:msg}); } continue; }
                    if(commandName==="antiviewonce"||commandName==="avv"||commandName==="viewonce"){ if(!owner) continue; const act=args[0]?.toLowerCase(); let db=getDB("antiviewonce.json",{}); if(!act){ await sock.sendMessage(jid,{text:`*ANTIVIEWONCE*\n.antiviewonce on / off / global`},{quoted:msg}); continue; } if(act==="on"){ db[jid]={enabled:true}; saveDB("antiviewonce.json",db); await sock.sendMessage(jid,{text:"✅ AntiViewOnce ON"},{quoted:msg}); } else if(act==="off"){ delete db[jid]; saveDB("antiviewonce.json",db); await sock.sendMessage(jid,{text:"❌ AntiViewOnce OFF"},{quoted:msg}); } else if(act==="global"){ db["global"]={enabled:true}; saveDB("antiviewonce.json",db); await sock.sendMessage(jid,{text:"✅ AntiViewOnce GLOBAL"},{quoted:msg}); } continue; }
                    if(commandName==="session"){ if(!owner) continue; try{ const creds=fs.readFileSync(path.join(authPath,"creds.json"),"utf8"); const session=`ETIAS-MINI-BOT~${Buffer.from(creds).toString("base64")}`; await sock.sendMessage(jid,{text:`*SESSION*\n\n${session}`},{quoted:msg}); }catch(e){ await sock.sendMessage(jid,{text:`❌ ${e.message}`},{quoted:msg}); } continue; }
                    const currentMode=global.botMode||"public"; if(currentMode==="private"&&!owner) continue; if(currentMode==="groups"&&!isGroup&&!owner) continue; if(currentMode==="inbox"&&isGroup&&!owner) continue;
                    const command=commands.get(commandName); if(!command) continue; try{ await command.execute(sock,msg,args,{getDB,saveDB,downloadContentFromMessage,isOwner:owner,isGroup,userId,botMode:global.botMode,BOT_NAME,PREFIX,messageStore}); }catch(e){ try{ await sock.sendMessage(jid,{text:`❌ ${e.message}`},{quoted:msg}); }catch{} }
                }catch(e){ console.log("[MSG ERR]",e.message); }
            }
        });
        return sock;
    })();
    startingBots.set(userId,startPromise); try{ return await startPromise; }finally{ startingBots.delete(userId); }
}

async function startAll(){
    await connectMongo();
    let multiDB={}; if(mongoose.connection.readyState===1){ multiDB=await getFromMongo(); addLog(`[MULTI] ${Object.keys(multiDB).length} valid sessions`); } else{ multiDB=getMultiDB(); addLog(`[MULTI] ${Object.keys(multiDB).length} local sessions`); }
    const ids=Object.keys(multiDB);
    if(ids.length>0){
        for(const id of ids){ addLog(`[MULTI] Starting ${id}`); try{ const data=multiDB[id]; const sess=typeof data==="string"?data:data.sessionId; await startBotForUser(id,sess); }catch(e){ addLog(`[MULTI START ERR] ${id} ${e.message}`); } await new Promise(r=>setTimeout(r,3000)); }
        addLog("[MULTI] All saved sessions started"); return;
    }
    if(process.env.SESSION_ID){ addLog("[MAIN] Starting SESSION_ID"); await startBotForUser("main",process.env.SESSION_ID); return; }
    addLog(`[MAIN] No session - Use ${PAIRING_SITE} to pair then deploy via /deploy`);
}

// ============================================================
// EXPRESS + DEPLOY DASHBOARD
// ============================================================
const app=express();
app.use(express.json({limit:"20mb"})); app.use(express.urlencoded({extended:true}));

app.get("/", async(req,res)=>{
    let mongoCount=0; if(mongoose.connection.readyState===1) mongoCount=await SessionModel.countDocuments(); else mongoCount=Object.keys(getMultiDB()).length;
    res.send(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>ETIAS-MINI-BOT</title><style>body{background:#080808;color:#fff;font-family:Arial;text-align:center;padding:20px}.card{max-width:550px;margin:auto;background:#151515;padding:25px;border-radius:18px;box-shadow:0 0 30px rgba(0,255,136,.15)}h1{color:#00ff88}.btn{display:block;padding:15px;margin:12px 0;background:#00ff88;color:#000;text-decoration:none;border-radius:10px;font-weight:bold}.dark{background:#222;color:#fff}.small{color:#888;font-size:12px}</style></head><body><div class="card"><h1>🤖 ETIAS-MINI-BOT</h1><p>Active: <b>${activeBots.size}</b> | Sessions: <b>${mongoCount}</b> | Owner: <b>${MAIN_OWNER}</b></p><a class="btn" href="${PAIRING_SITE}" target="_blank">🔗 PAIR ON PAIR SITE</a><a class="btn dark" href="/deploy">🚀 DEPLOY DASHBOARD</a><a class="btn dark" href="/bots">📋 VIEW BOTS JSON</a><p class="small">Pair at ${PAIRING_SITE} then deploy here</p></div></body></html>`);
});

// DEPLOY PAGE
app.get("/deploy", async(req,res)=>{
    let sessions=[];
    if(mongoose.connection.readyState===1){
        const docs=await SessionModel.find({}).sort({createdAt:-1});
        sessions=docs.map(d=>{
            const remainingMs=new Date(d.expiresAt).getTime()-Date.now(); const daysLeft=Math.max(0,Math.ceil(remainingMs/(24*60*60*1000)));
            return { userId:d.userId, phone:d.phone||d.userId, sessionId:d.sessionId, days:d.days, expiresAt:d.expiresAt, daysLeft, connected:activeBots.has(d.userId) };
        });
    } else {
        const db=getMultiDB();
        sessions=Object.keys(db).map(k=>{
            const data=db[k]; const sess=typeof data==="string"?data:data.sessionId; const days=data.days||30; const exp=data.expiresAt||Date.now()+days*24*60*60*1000; const daysLeft=Math.max(0,Math.ceil((exp-Date.now())/(24*60*60*1000)));
            return { userId:k, phone:k, sessionId:sess, days, expiresAt:new Date(exp), daysLeft, connected:activeBots.has(k) };
        });
    }
    const rows=sessions.map(s=>`
        <tr>
            <td>${s.phone}</td>
            <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${s.sessionId}">${s.sessionId.substring(0,30)}...</td>
            <td>${s.daysLeft} / ${s.days}</td>
            <td>${s.connected?'<span style=color:#00ff88>● Online</span>':'<span style=color:red>○ Offline</span>'}</td>
            <td>
                <button onclick="renew('${s.userId}')">Renew +30d</button>
                <button onclick="renewCustom('${s.userId}')">Renew Custom</button>
                <button onclick="del('${s.userId}')" style="background:#ff4444">Delete</button>
            </td>
        </tr>
    `).join("") || `<tr><td colspan=5>No bots deployed</td></tr>`;

    res.send(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Deploy Dashboard</title>
<style>
body{background:#080808;color:#fff;font-family:Arial;padding:15px}.card{max-width:1100px;margin:auto;background:#151515;padding:20px;border-radius:18px}
input,textarea,select{width:100%;padding:12px;margin:6px 0;border-radius:8px;border:none;background:#222;color:#fff;box-sizing:border-box}
.btn{padding:12px 18px;background:#00ff88;color:#000;border:none;border-radius:8px;font-weight:bold;cursor:pointer;margin:5px}
.btn-dark{background:#333;color:#fff} table{width:100%;border-collapse:collapse;margin-top:15px;font-size:13px} th,td{border:1px solid #333;padding:8px;text-align:left} th{background:#222}
.logs{background:#0a0a0a;color:#00ff88;padding:10px;border-radius:8px;height:200px;overflow:auto;font-family:monospace;font-size:12px;white-space:pre-wrap}
.grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px}
@media(max-width:700px){.grid{grid-template-columns:1fr}}
</style></head><body><div class="card">
<h1 style="color:#00ff88">🚀 DEPLOY DASHBOARD</h1>
<p>Main Owner: <b>${MAIN_OWNER}</b> | Pair Site: <a href="${PAIRING_SITE}" target="_blank" style="color:#00ff88">${PAIRING_SITE}</a></p>

<h3>Deploy New Bot</h3>
<div class="grid">
<div><label>User Number</label><input id="number" placeholder="263778810589"></div>
<div><label>Duration (days)</label><select id="days"><option value="7">7 days</option><option value="15">15 days</option><option value="30" selected>30 days</option><option value="60">60 days</option><option value="90">90 days</option><option value="365">365 days</option></select></div>
<div><label>&nbsp;</label><button class="btn" onclick="deploy()" style="width:100%">🚀 DEPLOY</button></div>
</div>
<label>SessionId (ETIAS-MINI-BOT~...)</label>
<textarea id="session" rows="4" placeholder="ETIAS-MINI-BOT~...."></textarea>

<h3>Logs</h3>
<div class="logs" id="logs">${logsBuffer.slice(-50).join("\n")||"No logs yet"}</div>
<button class="btn-dark btn" onclick="loadLogs()">Refresh Logs</button>
<button class="btn-dark btn" onclick="clearLogs()">Clear</button>

<h3>Active Bots (${sessions.length})</h3>
<table><thead><tr><th>Number</th><th>Session (masked)</th><th>Days Left</th><th>Status</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table>

<p style="margin-top:20px"><a href="/" style="color:#00ff88">← Home</a> | <a href="${PAIRING_SITE}" target="_blank" style="color:#00ff88">Pair Site</a></p>
</div>
<script>
async function deploy(){
  const number=document.getElementById('number').value.trim();
  const session=document.getElementById('session').value.trim();
  const days=document.getElementById('days').value;
  if(!session){ alert('Enter sessionId'); return; }
  if(!number){ alert('Enter user number'); return; }
  const res=await fetch('/api/deploy',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({number,session,days})});
  const data=await res.json();
  alert(data.message||data.error);
  if(data.success) location.reload();
}
async function renew(userId){
  if(!confirm('Renew '+userId+' +30 days?')) return;
  const res=await fetch('/api/renew',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId,days:30})});
  const data=await res.json(); alert(data.message||data.error); if(data.success) location.reload();
}
async function renewCustom(userId){
  const days=prompt('Enter days to add:', '30'); if(!days) return;
  const res=await fetch('/api/renew',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId,days:parseInt(days)})});
  const data=await res.json(); alert(data.message||data.error); if(data.success) location.reload();
}
async function del(userId){
  if(!confirm('Delete bot '+userId+'?')) return;
  const res=await fetch('/api/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId})});
  const data=await res.json(); alert(data.message||data.error); if(data.success) location.reload();
}
async function loadLogs(){
  const res=await fetch('/api/logs'); const data=await res.json();
  document.getElementById('logs').textContent=data.logs.join('\\n');
}
async function clearLogs(){ await fetch('/api/logs/clear',{method:'POST'}); document.getElementById('logs').textContent='Cleared'; }
setInterval(loadLogs,5000);
</script>
</body></html>`);
});

// APIs
app.post("/api/deploy", async(req,res)=>{
    try{
        const { number, session, days }=req.body;
        if(!session) return res.json({success:false,error:"Session required"});
        const cleanNum=normalizeNumber(number||"");
        let userId=cleanNum;
        try{ const b64=session.includes("~")? session.split("~").pop():session; const json=JSON.parse(Buffer.from(b64.trim(),"base64").toString("utf8")); userId=normalizeNumber(json?.me?.id)||cleanNum||`user_${Date.now()}`; }catch{}
        if(!userId) userId=`user_${Date.now()}`;
        const daysNum=parseInt(days)||30;
        if(activeBots.has(userId)) return res.json({success:false,error:`Bot ${userId} already active`});
        saveMultiSession(userId,session,daysNum);
        await startBotForUser(userId,session);
        addLog(`[DEPLOY] ${userId} for ${daysNum} days via dashboard`);
        res.json({success:true,message:`✅ Bot ${userId} deployed for ${daysNum} days`});
    }catch(e){ res.json({success:false,error:e.message}); }
});

app.post("/api/renew", async(req,res)=>{
    try{
        const { userId, days }=req.body; if(!userId) return res.json({success:false,error:"userId required"});
        const daysNum=parseInt(days)||30;
        if(mongoose.connection.readyState===1){
            const doc=await SessionModel.findOne({userId});
            if(!doc) return res.json({success:false,error:"Not found"});
            const newExpiry=new Date((doc.expiresAt? new Date(doc.expiresAt).getTime():Date.now()) + daysNum*24*60*60*1000);
            doc.expiresAt=newExpiry; doc.days=(doc.days||0)+daysNum; await doc.save();
            addLog(`[RENEW] ${userId} +${daysNum} days => ${newExpiry.toISOString()}`);
            return res.json({success:true,message:`✅ Renewed ${userId} +${daysNum} days, now ${doc.days} days total, expires ${newExpiry.toDateString()}`});
        } else {
            const db=getMultiDB(); if(!db[userId]) return res.json({success:false,error:"Not found"});
            const data=db[userId]; const currExp=data.expiresAt||Date.now()+ (data.days||30)*24*60*60*1000; const newExp=currExp+daysNum*24*60*60*1000;
            db[userId]={...data, days:(data.days||30)+daysNum, expiresAt:newExp}; saveDB("multi_sessions.json",db);
            addLog(`[RENEW] ${userId} +${daysNum} days`);
            return res.json({success:true,message:`✅ Renewed ${userId} +${daysNum} days`});
        }
    }catch(e){ res.json({success:false,error:e.message}); }
});

app.post("/api/delete", async(req,res)=>{
    try{
        const { userId }=req.body; if(!userId) return res.json({success:false,error:"userId required"});
        try{ const sock=activeBots.get(userId); if(sock){ try{ sock.ws?.close(); }catch{} activeBots.delete(userId); } }catch{}
        stoppedBots.add(userId); clearReconnect(userId);
        const authPath=userId==="main"?authBasePath:path.join(usersPath,userId); try{ fs.rmSync(authPath,{recursive:true,force:true}); }catch{}
        const db=getMultiDB(); delete db[userId]; saveDB("multi_sessions.json",db);
        if(mongoose.connection.readyState===1){ try{ await SessionModel.deleteOne({userId}); }catch{} }
        addLog(`[DELETE] ${userId} deleted via dashboard`);
        res.json({success:true,message:`✅ Deleted ${userId}`});
    }catch(e){ res.json({success:false,error:e.message}); }
});

app.get("/api/logs", (req,res)=>{ res.json({logs:logsBuffer}); });
app.post("/api/logs/clear", (req,res)=>{ logsBuffer.length=0; res.json({success:true}); });
app.get("/add", async(req,res)=>{ const session=req.query.session; const days=parseInt(req.query.days)||30; const number=req.query.number||""; if(!session) return res.redirect("/deploy"); try{ const b64=session.includes("~")?session.split("~").pop():session; const json=JSON.parse(Buffer.from(b64.trim(),"base64").toString("utf8")); const userId=normalizeNumber(json?.me?.id)||normalizeNumber(number)||`user_${Date.now()}`; if(activeBots.has(userId)) return res.send(`Bot ${userId} already active <a href=/deploy>Back</a>`); saveMultiSession(userId,session,days); await startBotForUser(userId,session); res.send(`✅ Bot ${userId} deployed for ${days} days <a href=/deploy>Dashboard</a>`); }catch(e){ res.send(`❌ Failed: ${e.message} <a href=/deploy>Back</a>`); } });
app.get("/bots", async(req,res)=>{ const bots=Array.from(activeBots.keys()); let mongoData=[]; if(mongoose.connection.readyState===1){ const docs=await SessionModel.find({}); mongoData=docs.map(d=>({userId:d.userId,phone:d.phone,days:d.days,expiresAt:d.expiresAt,remaining: d.expiresAt? Math.ceil((new Date(d.expiresAt).getTime()-Date.now())/(24*60*60*1000)):0,connected:activeBots.has(d.userId)})); } res.json({mainOwner:MAIN_OWNER,pairSite:PAIRING_SITE,active:bots.length,bots,sessions:mongoData,mode:global.botMode}); });

const PORT=process.env.PORT||3000;
app.listen(PORT,()=>console.log(`[SERVER] ${PORT} Owner ${MAIN_OWNER} Pair ${PAIRING_SITE} Deploy /deploy`));
startAll();
