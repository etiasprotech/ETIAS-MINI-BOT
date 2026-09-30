"use strict";

require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");

const app = express();

const PORT = process.env.PORT || 3000;
const BOT_NAME = process.env.BOT_NAME || "ETIAS-MINI-BOT";
const PAIRING_SITE =
    process.env.PAIRING_SITE ||
    "https://etias-mini-bot-pair.onrender.com/";

const MONGO_URI =
    process.env.MONGODB_URI ||
    process.env.MONGO_URI ||
    "";

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* =========================
   MONGODB
========================= */

const schema = new mongoose.Schema({
    userId: String,
    sessionId: { type: String, index: true },
    phone: String,
    pairId: String,
    connected: Boolean,
    status: String,
    mode: String,
    days: Number,
    expireAt: Date,
    createdAt: Date,
    lastSeen: Date,
    reconnects: Number,
    messages: Number,
    commandCount: Number
}, { minimize: false });

const Session =
    mongoose.models.Session ||
    mongoose.model("Session", schema);

async function connectMongo() {
    if (!MONGO_URI) {
        console.log("[MONGO] No MongoDB URI");
        return;
    }

    try {
        await mongoose.connect(MONGO_URI);
        console.log("[MONGO] ✅ Connected");
    } catch (e) {
        console.error("[MONGO] ❌", e.message);
    }
}

/* =========================
   MAIN.JS MANAGER
========================= */

function manager() {
    return global.ETIAS_BOT_MANAGER || null;
}

/* =========================
   DEPLOY
========================= */

app.post("/deploy", async (req, res) => {
    try {
        const sessionId = String(
            req.body.sessionId || ""
        ).trim();

        const phone = String(
            req.body.phone ||
            req.body.number ||
            ""
        ).replace(/\D/g, "");

        const days = Math.max(
            1,
            Number(req.body.days || req.body.duration || 30)
        );

        if (!sessionId) {
            return res.status(400).json({
                success: false,
                error: "Session ID is required"
            });
        }

        if (!phone) {
            return res.status(400).json({
                success: false,
                error: "User number is required"
            });
        }

        const bot = manager();

        if (!bot || typeof bot.deploy !== "function") {
            return res.status(503).json({
                success: false,
                error: "main.js bot manager is not running"
            });
        }

        console.log(
            `[DEPLOY] ${sessionId} -> +${phone} (${days} days)`
        );

        const result = await bot.deploy({
            sessionId,
            phone,
            days
        });

        return res.json({
            success: true,
            bot: BOT_NAME,
            sessionId,
            phone,
            days,
            ...result
        });

    } catch (e) {
        console.error("[DEPLOY]", e);

        res.status(500).json({
            success: false,
            error: e.message
        });
    }
});

/* =========================
   ALL BOTS
========================= */

app.get("/bots", async (req, res) => {
    try {
        const bot = manager();

        if (bot && typeof bot.getSessions === "function") {
            const sessions = await bot.getSessions();

            return res.json({
                success: true,
                total: sessions.length,
                sessions
            });
        }

        const sessions = await Session.find({}).lean();

        res.json({
            success: true,
            total: sessions.length,
            sessions
        });

    } catch (e) {
        res.status(500).json({
            success: false,
            error: e.message
        });
    }
});

/* =========================
   SINGLE BOT
========================= */

app.get("/deploy/:sessionId", async (req, res) => {
    try {
        const bot = manager();

        if (bot && typeof bot.getSession === "function") {
            const session = await bot.getSession(
                req.params.sessionId
            );

            if (session) {
                return res.json({
                    success: true,
                    session
                });
            }
        }

        const session = await Session.findOne({
            sessionId: req.params.sessionId
        }).lean();

        if (!session) {
            return res.status(404).json({
                success: false,
                error: "Session not found"
            });
        }

        res.json({
            success: true,
            session
        });

    } catch (e) {
        res.status(500).json({
            success: false,
            error: e.message
        });
    }
});

/* =========================
   LIVE LOGS
========================= */

app.get("/logs/:sessionId", async (req, res) => {
    try {
        const bot = manager();

        if (!bot || typeof bot.getLogs !== "function") {
            return res.json({
                success: true,
                logs: []
            });
        }

        const logs = await bot.getLogs(
            req.params.sessionId
        );

        res.json({
            success: true,
            sessionId: req.params.sessionId,
            logs: logs || []
        });

    } catch (e) {
        res.status(500).json({
            success: false,
            error: e.message
        });
    }
});

/* =========================
   DELETE BOT
========================= */

app.delete("/bots/:sessionId", async (req, res) => {
    try {
        const bot = manager();

        if (!bot || typeof bot.remove !== "function") {
            return res.status(503).json({
                success: false,
                error: "Bot manager unavailable"
            });
        }

        const result = await bot.remove(
            req.params.sessionId
        );

        await Session.deleteOne({
            sessionId: req.params.sessionId
        });

        res.json({
            success: true,
            result
        });

    } catch (e) {
        res.status(500).json({
            success: false,
            error: e.message
        });
    }
});

/* =========================
   RENEW
========================= */

app.post("/renew/:sessionId", async (req, res) => {
    try {
        const days = Math.max(
            1,
            Number(req.body.days || 30)
        );

        const session = await Session.findOne({
            sessionId: req.params.sessionId
        });

        if (!session) {
            return res.status(404).json({
                success: false,
                error: "Session not found"
            });
        }

        const now = new Date();

        const base =
            session.expireAt &&
            session.expireAt > now
                ? session.expireAt
                : now;

        session.days =
            Number(session.days || 0) + days;

        session.expireAt =
            new Date(
                base.getTime() +
                days * 86400000
            );

        await session.save();

        res.json({
            success: true,
            sessionId: session.sessionId,
            daysAdded: days,
            daysTotal: session.days,
            expireAt: session.expireAt
        });

    } catch (e) {
        res.status(500).json({
            success: false,
            error: e.message
        });
    }
});

/* =========================
   PING
========================= */

app.get("/ping", (req, res) => {
    res.json({
        status: "online",
        bot: BOT_NAME,
        uptime: process.uptime(),
        mongo:
            mongoose.connection.readyState === 1,
        pairing_site: PAIRING_SITE
    });
});

/* =========================
   DASHBOARD
========================= */

app.get("/", (req, res) => {
    res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport"
content="width=device-width,initial-scale=1">

<title>${BOT_NAME} Dashboard</title>

<style>
*{
 box-sizing:border-box;
}

body{
 margin:0;
 background:#050505;
 color:#fff;
 font-family:Arial,sans-serif;
 padding:20px;
}

.container{
 max-width:1100px;
 margin:auto;
}

.card{
 background:#111;
 border:1px solid #292929;
 border-radius:16px;
 padding:20px;
 margin-bottom:20px;
}

h1{
 color:#25D366;
}

input{
 width:100%;
 padding:13px;
 margin:7px 0;
 border-radius:9px;
 border:1px solid #333;
 background:#181818;
 color:white;
}

button{
 padding:11px 16px;
 border:0;
 border-radius:8px;
 cursor:pointer;
 font-weight:bold;
 margin:4px;
}

.deploy{
 background:#25D366;
 color:#000;
 width:100%;
}

.delete{
 background:#e53935;
 color:white;
}

.renew{
 background:#ffb300;
 color:#000;
}

.logs{
 background:#000;
 border:1px solid #222;
 border-radius:10px;
 padding:15px;
 height:250px;
 overflow:auto;
 white-space:pre-wrap;
 font-family:monospace;
 font-size:12px;
}

table{
 width:100%;
 border-collapse:collapse;
 font-size:12px;
}

th,td{
 padding:10px;
 border-bottom:1px solid #292929;
 text-align:left;
}

.online{
 color:#25D366;
}

.offline{
 color:#ff5252;
}

@media(max-width:700px){
 table{
  display:block;
  overflow-x:auto;
 }
}
</style>
</head>

<body>

<div class="container">

<div class="card">
<h1>🤖 ${BOT_NAME}</h1>
<p>Multi-Session Deployment Dashboard</p>

<input
 id="sessionId"
 placeholder="Session ID"
/>

<input
 id="phone"
 placeholder="User WhatsApp number e.g. 263778810589"
/>

<input
 id="days"
 type="number"
 value="30"
 min="1"
 placeholder="Duration in days"
/>

<button
 class="deploy"
 onclick="deployBot()">
🚀 DEPLOY BOT
</button>

<p id="result"></p>
</div>

<div class="card">
<h2>📡 Live Logs</h2>

<p id="logStatus">
Waiting for deployment...
</p>

<div
 id="logs"
 class="logs">
No logs yet.
</div>
</div>

<div class="card">

<h2>👥 Deployed Users</h2>

<table>

<thead>
<tr>
<th>Phone</th>
<th>Session ID</th>
<th>Status</th>
<th>Expires</th>
<th>Actions</th>
</tr>
</thead>

<tbody id="users">
<tr>
<td colspan="5">
Loading...
</td>
</tr>
</tbody>

</table>

</div>

</div>

<script>

let currentSession = "";

async function deployBot(){

 const sessionId =
 document.getElementById("sessionId").value.trim();

 const phone =
 document.getElementById("phone").value.trim();

 const days =
 document.getElementById("days").value;

 if(!sessionId || !phone){
   alert("Enter Session ID and user number");
   return;
 }

 document.getElementById("result").innerText =
   "🚀 Deploying...";

 const res = await fetch("/deploy",{
   method:"POST",
   headers:{
     "Content-Type":"application/json"
   },
   body:JSON.stringify({
     sessionId,
     phone,
     days
   })
 });

 const data = await res.json();

 if(!data.success){
   document.getElementById("result").innerText =
     "❌ " + data.error;
   return;
 }

 currentSession = sessionId;

 document.getElementById("result").innerText =
   "✅ Deployment started";

 watchLogs();

 loadBots();
}

async function watchLogs(){

 if(!currentSession) return;

 try{

   const res =
     await fetch(
       "/logs/" +
       encodeURIComponent(currentSession)
     );

   const data = await res.json();

   document.getElementById("logs").innerText =
     (data.logs || []).join("\\n");

   document.getElementById("logs").scrollTop =
     document.getElementById("logs").scrollHeight;

   document.getElementById("logStatus").innerText =
     "🟢 Live";

 }catch(e){

   document.getElementById("logStatus").innerText =
     "🔴 Log connection error";
 }

 setTimeout(watchLogs,2000);
}

async function loadBots(){

 try{

   const res = await fetch("/bots");
   const data = await res.json();

   const tbody =
     document.getElementById("users");

   tbody.innerHTML = "";

   (data.sessions || []).forEach(bot => {

     const tr =
       document.createElement("tr");

     const status =
       bot.connected
       ? '<span class="online">● ONLINE</span>'
       : '<span class="offline">● OFFLINE</span>';

     tr.innerHTML = \`
       <td>\${bot.phone || "-"}</td>
       <td>\${bot.sessionId || "-"}</td>
       <td>\${status}</td>
       <td>\${bot.expireAt || "-"}</td>

       <td>

       <button
       class="renew"
       onclick="renewBot('\${bot.sessionId}')">
       Renew
       </button>

       <button
       class="delete"
       onclick="deleteBot('\${bot.sessionId}')">
       Delete
       </button>

       </td>
     \`;

     tbody.appendChild(tr);
   });

 }catch(e){
   console.error(e);
 }
}

async function renewBot(id){

 const days =
   prompt("How many days to add?", "30");

 if(!days) return;

 const res =
   await fetch(
     "/renew/" +
     encodeURIComponent(id),
     {
       method:"POST",
       headers:{
         "Content-Type":"application/json"
       },
       body:JSON.stringify({days})
     }
   );

 const data = await res.json();

 alert(
   data.success
   ? "✅ Bot renewed"
   : "❌ " + data.error
 );

 loadBots();
}

async function deleteBot(id){

 if(!confirm(
   "Delete this deployed bot?"
 )) return;

 const res =
   await fetch(
     "/bots/" +
     encodeURIComponent(id),
     {
       method:"DELETE"
     }
   );

 const data = await res.json();

 alert(
   data.success
   ? "✅ Bot deleted"
   : "❌ " + data.error
 );

 loadBots();
}

loadBots();

setInterval(loadBots,5000);

</script>

</body>
</html>`);
});

/* =========================
   404
========================= */

app.use((req,res)=>{
    res.status(404).json({
        success:false,
        error:"Route not found"
    });
});

/* =========================
   START
========================= */

async function startServer(){

    await connectMongo();

    if(app.locals.server)
        return app.locals.server;

    app.locals.server =
        app.listen(PORT,()=>{
            console.log(
                `[SERVER] ${BOT_NAME} running on ${PORT}`
            );

            console.log(
                `[SERVER] Dashboard: http://localhost:${PORT}`
            );

            console.log(
                `[SERVER] Pairing site: ${PAIRING_SITE}`
            );
        });

    return app.locals.server;
}

if(require.main === module){

    startServer().catch(e=>{
        console.error(e);
        process.exit(1);
    });
}

module.exports = app;
module.exports.startServer = startServer;
module.exports.connectMongo = connectMongo;
module.exports.SessionModel = Session;
