"use strict";
require("dotenv").config();
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const pino = require("pino");
const mongoose = require("mongoose");
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    Browsers,
    jidNormalizedUser
} = require("@whiskeysockets/baileys");

const app = require("./server");

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);
const AUTH_DIR = path.join(ROOT, "auth");
const USERS_AUTH_DIR = path.join(AUTH_DIR, "users");
const DATA_DIR = path.join(ROOT, "data");
const LOG_DIR = path.join(ROOT, "logs");
const COMMANDS_DIR = path.join(ROOT, "commands");
const MEDIA_DIR = path.join(ROOT, "media");
const DEPLOYMENTS_FILE = path.join(DATA_DIR, "deployed.json");
const SESSION_PREFIX = "ETIAS-MINI-BOT~";
const DEFAULT_DAYS = Number(process.env.DEFAULT_DAYS || 30);
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI || "";
const logger = pino({ level: process.env.LOG_LEVEL || "info" });

for (const dir of [AUTH_DIR, USERS_AUTH_DIR, DATA_DIR, LOG_DIR, COMMANDS_DIR, MEDIA_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
}

const sessions = new Map();
const commands = new Map();
const reconnectTimers = new Map();

const DeploymentSchema = new mongoose.Schema({
    sessionId: { type: String, unique: true, index: true },
    phone: String, jid: String, userId: String, pairId: String,
    status: String, connected: Boolean,
    mode: { type: String, default: "public" },
    days: Number, expireAt: Date, authFolder: String,
    reconnects: { type: Number, default: 0 },
    messages: { type: Number, default: 0 },
    commandCount: { type: Number, default: 0 },
    createdAt: Date, lastSeen: Date, sessionMessageSent: Boolean
});
const Deployment = mongoose.models.ETIASDeployment || mongoose.model("ETIASDeployment", DeploymentSchema);

async function connectMongo(){
    if(!MONGO_URI){ logger.warn("[MONGO] MONGO_URI not configured"); return false; }
    try{ await mongoose.connect(MONGO_URI,{serverSelectionTimeoutMS:10000}); logger.info("[MONGO] Connected"); return true; }
    catch(error){ logger.error({error:error.message},"[MONGO] Connection failed"); return false; }
}

function readDeployments(){
    try{ if(!fs.existsSync(DEPLOYMENTS_FILE)) return []; const data=JSON.parse(fs.readFileSync(DEPLOYMENTS_FILE,"utf8")); return Array.isArray(data)?data:[]; }
    catch{ return []; }
}
async function writeDeployments(deployments){
    await fsp.mkdir(DATA_DIR,{recursive:true});
    await fsp.writeFile(DEPLOYMENTS_FILE, JSON.stringify(deployments,null,2),"utf8");
}

function normalizeSessionId(sessionId){ return String(sessionId||"").trim().toUpperCase(); }
function isValidSessionId(sessionId){ return new RegExp(`^${SESSION_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\d{8}$`).test(normalizeSessionId(sessionId)); }
function normalizePhone(phone){ return String(phone||"").replace(/[^\d]/g,"").replace(/^00/,""); }
function phoneFromJid(jid){ if(!jid) return null; return normalizePhone(String(jid).split("@")[0]); }
function sessionFolderName(sessionId){ const id=normalizeSessionId(sessionId); if(!isValidSessionId(id)) throw new Error("Invalid Session ID"); return id.replace(/[^A-Z0-9_-]/gi,"_"); }
function safeSessionFolder(sessionId){ return path.join(USERS_AUTH_DIR, sessionFolderName(sessionId)); }
function isInsideDirectory(child,parent){ const childPath=path.resolve(child); const parentPath=path.resolve(parent); return (childPath===parentPath || childPath.startsWith(parentPath+path.sep)); }

function isExpired(dep){
    if(!dep ||!dep.expireAt) return false;
    return new Date(dep.expireAt) < new Date();
}

function resolveAuthFolder(sessionId, suppliedFolder){
    const id=normalizeSessionId(sessionId);
    const expected=safeSessionFolder(id);
    const candidates=[];
    if(suppliedFolder){
        const supplied=path.resolve(String(suppliedFolder));
        if(isInsideDirectory(supplied, AUTH_DIR)) candidates.push(supplied);
    }
    candidates.push(expected);
    candidates.push(path.join(AUTH_DIR, sessionFolderName(id)));
    for(const candidate of candidates){
        if(fs.existsSync(path.join(candidate,"creds.json"))) return candidate;
    }
    return null;
}
function hasAuthCredentials(folder){ return Boolean(folder && fs.existsSync(path.join(folder,"creds.json"))); }

function addLog(sessionId,message){
    const line=`[${new Date().toISOString()}] [${sessionId}] ${message}`;
    logger.info(line);
    try{ fs.appendFileSync(path.join(LOG_DIR,"bot.log"), line+"\n"); }catch{}
}
function getLogs(sessionId){
    try{
        const file=path.join(LOG_DIR,"bot.log"); if(!fs.existsSync(file)) return [];
        const lines=fs.readFileSync(file,"utf8").split("\n").filter(Boolean);
        if(!sessionId) return lines.slice(-500);
        return lines.filter(l=>l.includes(`[${sessionId}]`)).slice(-500);
    }catch{ return []; }
}

async function loadCommands(){
    commands.clear(); if(!fs.existsSync(COMMANDS_DIR)) return;
    const files=await fsp.readdir(COMMANDS_DIR);
    for(const file of files){
        if(!file.endsWith(".js")||file.startsWith("_")) continue;
        const fullPath=path.join(COMMANDS_DIR,file);
        try{
            delete require.cache[require.resolve(fullPath)];
            const command=require(fullPath);
            if(!command||typeof command!=="object") continue;
            const name=String(command.name||path.basename(file,".js")).toLowerCase();
            commands.set(name,command);
            if(command.aliases) command.aliases.forEach(a=>commands.set(String(a).toLowerCase(),command));
        }catch(error){ logger.error({file,error:error.message},"[COMMAND] Failed to load"); }
    }
    logger.info(`[COMMANDS] ${commands.size} commands loaded`);
}

async function saveDeployment(deployment){
    const deployments=readDeployments();
    const index=deployments.findIndex(item=>normalizeSessionId(item.sessionId)===normalizeSessionId(deployment.sessionId));
    const clean={...deployment,sessionId:normalizeSessionId(deployment.sessionId)};
    if(index===-1) deployments.push(clean); else deployments[index]={...deployments[index],...clean};
    await writeDeployments(deployments);
    if(mongoose.connection.readyState===1){
        try{ await Deployment.findOneAndUpdate({sessionId:clean.sessionId},{$set:{...clean,expireAt:clean.expireAt?new Date(clean.expireAt):null}},{upsert:true,new:true,setDefaultsOnInsert:true}); }
        catch(error){ logger.warn({error:error.message},"[MONGO] Deployment save failed"); }
    }
    return clean;
}
function getDeployment(sessionId){ const id=normalizeSessionId(sessionId); return readDeployments().find(item=>normalizeSessionId(item.sessionId)===id); }

async function sendSessionInfo(sock,jid,sessionId){
    if(!sock||!jid) return false;
    try{
        await sock.sendMessage(jid,{text:`*ETIAS-MINI-BOT*\n\nYour Session ID:\n\n\`${sessionId}\`\n\nSend this ID to owner for deployment.\n\nExpires as per owner setting.`});
        return true;
    }catch(error){ addLog(sessionId,`Failed to send Session ID: ${error.message}`); return false; }
}

async function createSocket(sessionId, options={}){
    const id=normalizeSessionId(sessionId);
    if(!isValidSessionId(id)) throw new Error("Invalid Session ID");
    const existingDep = getDeployment(id);
    if(isExpired(existingDep)){
        addLog(id, `Session expired on ${existingDep.expireAt} - not connecting`);
        await saveDeployment({...existingDep, status:"expired", connected:false, lastSeen:new Date().toISOString()});
        throw new Error(`Session ${id} expired on ${existingDep.expireAt}. Please renew.`);
    }
    const existing=sessions.get(id);
    if(existing && existing.sock && existing.connected!==false) return existing.sock;
    const authFolder=resolveAuthFolder(id, options.authFolder);
    if(!authFolder) throw new Error(`Authentication folder not found for ${id}`);
    if(!hasAuthCredentials(authFolder)) throw new Error(`creds.json not found for ${id}`);
    const {state, saveCreds}=await useMultiFileAuthState(authFolder);
    const deployment=getDeployment(id);
    const userJid=options.jid||deployment?.jid||null;
    const phone=normalizePhone(options.phone||deployment?.phone||phoneFromJid(userJid));
    const session={
        sessionId:id, sock:null, userJid, phone,
        pairId:options.pairingId||deployment?.pairingId||null,
        authFolder, status:"connecting", connected:false,
        mode:deployment?.mode||options.mode||"public",
        days:Number(options.days||deployment?.days||DEFAULT_DAYS),
        expireAt:options.expireAt||deployment?.expireAt||null,
        reconnects:Number(deployment?.reconnects||0),
        messages:Number(deployment?.messages||0),
        commandCount:Number(deployment?.commandCount||0),
        createdAt:deployment?.createdAt||new Date().toISOString(),
        lastSeen:new Date().toISOString(),
        sessionMessageSent:Boolean(deployment?.sessionMessageSent)
    };
    sessions.set(id, session);
    const sock=makeWASocket({
        auth:state,
        browser:Browsers.macOS("Chrome"),
        logger:pino({level:"silent"}),
        printQRInTerminal:false,
        markOnlineOnConnect:true,
        syncFullHistory:false,
        generateHighQualityLinkPreview:false
    });
    session.sock=sock;
    sock.ev.on("creds.update", async ()=>{ try{ await saveCreds(); }catch(e){ addLog(id,`Failed to save credentials: ${e.message}`); } });
    sock.ev.on("connection.update", async update=>{
        const {connection, lastDisconnect}=update;
        if(connection==="connecting"){ session.status="connecting"; session.connected=false; addLog(id,"Connecting..."); return; }
        if(connection==="open"){
            session.status="connected"; session.connected=true; session.lastSeen=new Date().toISOString();
            session.userJid=sock.user?.id||session.userJid||null;
            session.phone=phoneFromJid(session.userJid)||session.phone;
            clearReconnectTimer(id);
            addLog(id,`Connected as ${session.userJid||session.phone}`);
            await saveDeployment({
                sessionId:id, phone:session.phone, jid:session.userJid, pairId:session.pairId,
                status:"connected", connected:true, mode:session.mode, days:session.days, expireAt:session.expireAt,
                authFolder:session.authFolder, reconnects:session.reconnects, messages:session.messages,
                commandCount:session.commandCount, createdAt:session.createdAt, lastSeen:session.lastSeen, sessionMessageSent:session.sessionMessageSent
            });
            if(!session.sessionMessageSent && session.userJid){
                const sent=await sendSessionInfo(sock, session.userJid, id);
                if(sent){ session.sessionMessageSent=true; await saveDeployment({sessionId:id,phone:session.phone,jid:session.userJid,pairId:session.pairId,status:"connected",connected:true,mode:session.mode,days:session.days,expireAt:session.expireAt,authFolder:session.authFolder,reconnects:session.reconnects,messages:session.messages,commandCount:session.commandCount,createdAt:session.createdAt,lastSeen:session.lastSeen,sessionMessageSent:true}); }
            }
            return;
        }
        if(connection==="close"){
            session.connected=false; session.status="disconnected"; session.lastSeen=new Date().toISOString(); session.sock=null;
            const statusCode=lastDisconnect?.error?.output?.statusCode;
            const loggedOut=statusCode===DisconnectReason.loggedOut;
            const badSession=statusCode===DisconnectReason.badSession;
            await saveDeployment({
                sessionId:id, phone:session.phone, jid:session.userJid, pairId:session.pairId,
                status:loggedOut||badSession?"logged_out":"disconnected", connected:false, mode:session.mode, days:session.days, expireAt:session.expireAt,
                authFolder:session.authFolder, reconnects:session.reconnects, messages:session.messages, commandCount:session.commandCount,
                createdAt:session.createdAt, lastSeen:session.lastSeen, sessionMessageSent:session.sessionMessageSent
            });
            addLog(id,`Closed code=${statusCode||"unknown"}`);
            if(loggedOut||badSession){ session.status=loggedOut?"logged_out":"bad_session"; return; }
            scheduleReconnect(id);
        }
    });

    sock.ev.on("messages.upsert", async event=>{
        try{
            if(!event?.messages) return;
            const dep=getDeployment(id);
            if(isExpired(dep)){
                addLog(id, "Expired - stopping bot");
                await sock.sendMessage(event.messages[0].key.remoteJid, {text:`*ETIAS-MINI-BOT EXPIRED*\nYour session ${id} expired on ${dep.expireAt}. Contact owner to renew.`});
                await removeSession(id);
                return;
            }
            for(const message of event.messages) await processMessage(id, message);
        }catch(error){ addLog(id,`Message handler error: ${error.message}`); }
    });

    sock.ev.on("group-participants.update", async event=>{
        try{ await handleGroupParticipants(id, event); }catch(error){ addLog(id,`Group event error: ${error.message}`); }
    });
    return sock;
}

function clearReconnectTimer(sessionId){ const timer=reconnectTimers.get(sessionId); if(timer){ clearTimeout(timer); reconnectTimers.delete(sessionId); } }
function scheduleReconnect(sessionId){
    const id=normalizeSessionId(sessionId); if(reconnectTimers.has(id)) return; const session=sessions.get(id); if(!session) return;
    session.reconnects=Number(session.reconnects||0)+1;
    const delay=Math.min(5000*Math.max(session.reconnects,1),60000);
    addLog(id,`Reconnecting in ${delay}ms...`);
    const timer=setTimeout(async()=>{
        reconnectTimers.delete(id); const current=sessions.get(id); if(!current) return;
        try{ current.status="reconnecting"; await createSocket(id,{authFolder:current.authFolder,phone:current.phone,jid:current.userJid,pairingId:current.pairId,days:current.days,expireAt:current.expireAt}); }
        catch(error){ addLog(id,`Reconnect failed: ${error.message}`); scheduleReconnect(id); }
    },delay);
    reconnectTimers.set(id,timer);
}

function getMessageText(message){
    const msg=message?.message; if(!msg) return "";
    return (msg.conversation||msg.extendedTextMessage?.text||msg.imageMessage?.caption||msg.videoMessage?.caption||msg.documentMessage?.caption||"");
}
function getMessageChat(message){ return (message?.key?.remoteJid||""); }
function isGroupJid(jid){ return String(jid||"").endsWith("@g.us"); }

// REMOVED runBuiltInCommand - now only commands folder

async function processMessage(sessionId, message){
    const id=normalizeSessionId(sessionId);
    const session=sessions.get(id); if(!session||!session.sock) return;
    const text=getMessageText(message).trim(); if(!text) return;
    const chat=getMessageChat(message);
    session.messages++; session.lastSeen=new Date().toISOString();
    const prefix=process.env.PREFIX||".";
    if(!text.startsWith(prefix)) return;
    const parts=text.slice(prefix.length).trim().split(/\s+/);
    const cmd=parts[0].toLowerCase(); const args=parts.slice(1);

    // ONLY from commands folder
    const command=commands.get(cmd);
    if(!command) return;
    try{
        if(typeof command.execute==="function"){
            await command.execute({sock:session.sock,message,args,sessionId:id,session,chat,text});
            session.commandCount++;
        }
    }catch(e){ addLog(id,`Command ${cmd} error: ${e.message}`); }
}

async function handleGroupParticipants(sessionId, event){}

async function deploySession(options){
    const id=normalizeSessionId(options.sessionId);
    if(!isValidSessionId(id)) throw new Error("Invalid Session ID");
    const existingDep=getDeployment(id);
    if(existingDep && isExpired(existingDep) &&!options.days){
        throw new Error("Session expired, renew first");
    }
    const authFolder=options.authFolder||safeSessionFolder(id);
    if(!fs.existsSync(path.join(authFolder,"creds.json"))) throw new Error("creds.json not found");
    const deployment={
        sessionId:id, phone:normalizePhone(options.phone||existingDep?.phone||""),
        jid:options.jid||existingDep?.jid||null, pairId:options.pairingId||existingDep?.pairId||null,
        status:"starting", connected:false, mode:options.mode||existingDep?.mode||"public",
        days:Number(options.days||existingDep?.days||DEFAULT_DAYS),
        expireAt:options.expireAt||existingDep?.expireAt||new Date(Date.now()+DEFAULT_DAYS*24*60*60*1000).toISOString(),
        authFolder, reconnects:0, messages:existingDep?.messages||0, commandCount:existingDep?.commandCount||0,
        createdAt:existingDep?.createdAt||new Date().toISOString(), lastSeen:new Date().toISOString(),
        sessionMessageSent:existingDep?.sessionMessageSent||false
    };
    await saveDeployment(deployment);
    const sock=await createSocket(id,{authFolder,phone:deployment.phone,jid:deployment.jid,pairingId:deployment.pairId,days:deployment.days,expireAt:deployment.expireAt,mode:deployment.mode});
    return {success:true,sessionId:id,phone:deployment.phone,jid:deployment.jid,status:"starting",connected:false,authFolder,commandsStarted:true};
}

async function removeSession(sessionId){
    const id=normalizeSessionId(sessionId);
    clearReconnectTimer(id);
    const session=sessions.get(id);
    if(session&&session.sock){
        try{ await session.sock.logout(); }catch{}
        try{ session.sock.end(); }catch{}
    }
    sessions.delete(id);
    return true;
}

function getSession(sessionId){
    const id=normalizeSessionId(sessionId);
    const s=sessions.get(id);
    const dep=getDeployment(id);
    if(!s &&!dep) return null;
    return {
        sessionId:id,
        phone:s?.phone||dep?.phone||null,
        jid:s?.userJid||dep?.jid||null,
        status:s?.status||dep?.status||"offline",
        connected:s?.connected||false,
        expireAt:s?.expireAt||dep?.expireAt||null,
        days:s?.days||dep?.days||0,
        expired: isExpired(dep||s)
    };
}

function getSessions(){
    const deps=readDeployments();
    return deps.map(d=>{
        const s=sessions.get(normalizeSessionId(d.sessionId));
        return {
            sessionId:normalizeSessionId(d.sessionId),
            phone:s?.phone||d.phone,
            jid:s?.userJid||d.jid,
            status:s?.status||d.status,
            connected:s?.connected||false,
            expireAt:d.expireAt,
            days:d.days,
            expired: isExpired(d),
            lastSeen:s?.lastSeen||d.lastSeen
        };
    });
}

setInterval(async ()=>{
    const deps=readDeployments();
    for(const dep of deps){
        if(isExpired(dep)){
            const id=normalizeSessionId(dep.sessionId);
            const sess=sessions.get(id);
            if(sess && sess.connected){
                addLog(id, `Session expired - disconnecting`);
                try{ await sess.sock.sendMessage(sess.userJid||dep.jid, {text:`*ETIAS-MINI-BOT*\nYour session ${id} expired on ${dep.expireAt}. Bot stopped.`}); }catch{}
                await removeSession(id);
                await saveDeployment({...dep, status:"expired", connected:false});
            }
        }
    }
}, 60*1000);

(async ()=>{
    await connectMongo();
    await loadCommands();
    const deps=readDeployments();
    for(const dep of deps){
        if(isExpired(dep)){
            addLog(dep.sessionId, `Skipping expired session ${dep.sessionId}`);
            continue;
        }
        if(dep.status==="connected"||dep.status==="starting"||dep.status==="active"){
            try{ await createSocket(dep.sessionId, {authFolder:dep.authFolder, phone:dep.phone, jid:dep.jid, pairingId:dep.pairId, days:dep.days, expireAt:dep.expireAt}); }
            catch(e){ addLog(dep.sessionId, `Auto-restore failed: ${e.message}`); }
        }
    }
})();

global.ETIAS_BOT_MANAGER={
    deploySession,
    removeSession,
    getSession,
    getSessions,
    getLogs,
    loadCommands
};

module.exports={app, deploySession, getSessions, createSocket, startBot: createSocket, loadCommands, sessions, commands};
