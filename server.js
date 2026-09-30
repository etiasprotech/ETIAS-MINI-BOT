"use strict";

require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

const app = express();

const PORT = process.env.PORT || 3000;

const BOT_NAME = process.env.BOT_NAME || "ETIAS-MINI-BOT";
const VERSION = "V4 MULTI + PAIRING + MONGO";

const PAIRING_SITE =
    process.env.PAIRING_SITE ||
    "https://etias-mini-bot-pair.onrender.com/";

const MONGODB_URI =
    process.env.MONGODB_URI ||
    process.env.MONGO_URI ||
    "";

const BOT_IMAGE_PATH = path.join(__dirname, "media", "bot.jpg");
const BOT_IMAGE_PNG = path.join(__dirname, "media", "bot_image.png");

const DATA_DIR = path.join(__dirname, "data");
const MULTI_FILE = path.join(DATA_DIR, "multi_sessions.json");

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

/*
|--------------------------------------------------------------------------
| MongoDB
|--------------------------------------------------------------------------
*/

const sessionSchema = new mongoose.Schema(
    {
        userId: {
            type: String,
            unique: true,
            index: true
        },

        sessionId: {
            type: String,
            index: true
        },

        phone: String,

        pairId: String,

        connected: {
            type: Boolean,
            default: false
        },

        status: {
            type: String,
            default: "offline"
        },

        mode: {
            type: String,
            default: "public"
        },

        days: Number,

        expireAt: Date,

        createdAt: {
            type: Date,
            default: Date.now
        },

        lastSeen: Date,

        reconnects: {
            type: Number,
            default: 0
        },

        messages: {
            type: Number,
            default: 0
        },

        commandCount: {
            type: Number,
            default: 0
        }
    },
    {
        minimize: false
    }
);

const SessionModel =
    mongoose.models.Session ||
    mongoose.model("Session", sessionSchema);

let mongoConnected = false;

/*
|--------------------------------------------------------------------------
| Connect MongoDB
|--------------------------------------------------------------------------
*/

async function connectMongo() {
    if (!MONGODB_URI) {
        console.log("[MONGO] No MONGODB_URI/MONGO_URI configured");
        return false;
    }

    try {
        if (mongoose.connection.readyState === 1) {
            mongoConnected = true;
            return true;
        }

        await mongoose.connect(MONGODB_URI);

        mongoConnected = true;

        console.log("[MONGO] ✅ Connected");

        return true;
    } catch (error) {
        mongoConnected = false;

        console.error(
            "[MONGO] ❌ Connection failed:",
            error.message
        );

        return false;
    }
}

/*
|--------------------------------------------------------------------------
| Helper - Main.js Manager
|--------------------------------------------------------------------------
*/

function getBotManager() {
    return global.ETIAS_BOT_MANAGER || null;
}

/*
|--------------------------------------------------------------------------
| Bot Image
|--------------------------------------------------------------------------
*/

app.get("/bot-image", (req, res) => {
    try {
        if (fs.existsSync(BOT_IMAGE_PATH)) {
            return res.sendFile(BOT_IMAGE_PATH);
        }

        if (fs.existsSync(BOT_IMAGE_PNG)) {
            return res.sendFile(BOT_IMAGE_PNG);
        }

        return res.status(404).send("Bot image not found");
    } catch (error) {
        return res.status(500).send(error.message);
    }
});

/*
|--------------------------------------------------------------------------
| Ping
|--------------------------------------------------------------------------
*/

app.get("/ping", async (req, res) => {
    let mongoCount = 0;

    try {
        if (
            MONGODB_URI &&
            mongoose.connection.readyState === 1
        ) {
            mongoCount = await SessionModel.countDocuments();
        }
    } catch {}

    const manager = getBotManager();

    let totalBots = 0;

    try {
        if (manager && typeof manager.getSessions === "function") {
            const sessions = await Promise.resolve(
                manager.getSessions()
            );

            totalBots = Array.isArray(sessions)
                ? sessions.length
                : 0;
        }
    } catch {}

    res.json({
        status: "online",
        bot: BOT_NAME,
        version: VERSION,

        uptime: `${Math.floor(process.uptime() / 60)}m ${Math.floor(
            process.uptime() % 60
        )}s`,

        uptime_seconds: process.uptime(),

        total_bots: totalBots,

        total_users_db: mongoCount,

        mongo_connected:
            mongoose.connection.readyState === 1,

        pairing_site: PAIRING_SITE,

        platform: process.platform,

        node: process.version,

        timestamp: new Date().toISOString()
    });
});

/*
|--------------------------------------------------------------------------
| Current Session
|--------------------------------------------------------------------------
*/

app.get("/session", async (req, res) => {
    try {
        const manager = getBotManager();

        if (
            manager &&
            typeof manager.getSessions === "function"
        ) {
            const sessions = await Promise.resolve(
                manager.getSessions()
            );

            return res.json({
                exists: Array.isArray(sessions)
                    ? sessions.length > 0
                    : false,

                sessions: Array.isArray(sessions)
                    ? sessions
                    : [],

                pairing_site: PAIRING_SITE
            });
        }

        return res.json({
            exists: false,
            sessions: [],
            pairing_site: PAIRING_SITE,
            message: "Bot manager not loaded"
        });
    } catch (error) {
        return res.status(500).json({
            exists: false,
            error: error.message
        });
    }
});

/*
|--------------------------------------------------------------------------
| GET ALL BOTS
|--------------------------------------------------------------------------
*/

app.get("/bots", async (req, res) => {
    try {
        const manager = getBotManager();

        if (
            manager &&
            typeof manager.getSessions === "function"
        ) {
            const sessions = await Promise.resolve(
                manager.getSessions()
            );

            return res.json({
                total: Array.isArray(sessions)
                    ? sessions.length
                    : 0,

                pairing_site: PAIRING_SITE,

                sessions: Array.isArray(sessions)
                    ? sessions
                    : []
            });
        }

        /*
         * Mongo fallback
         */

        if (
            MONGODB_URI &&
            mongoose.connection.readyState === 1
        ) {
            const sessions = await SessionModel
                .find({})
                .select(
                    "userId sessionId phone connected status mode days expireAt createdAt lastSeen"
                )
                .lean();

            return res.json({
                total: sessions.length,
                pairing_site: PAIRING_SITE,
                sessions
            });
        }

        /*
         * Local fallback
         */

        let sessions = {};

        if (fs.existsSync(MULTI_FILE)) {
            try {
                sessions = JSON.parse(
                    fs.readFileSync(MULTI_FILE, "utf8")
                );
            } catch {
                sessions = {};
            }
        }

        const list = Object.keys(sessions).map((id) => ({
            userId: id,
            sessionId: sessions[id]
        }));

        return res.json({
            total: list.length,
            pairing_site: PAIRING_SITE,
            sessions: list
        });
    } catch (error) {
        return res.status(500).json({
            error: error.message
        });
    }
});

/*
|--------------------------------------------------------------------------
| DEPLOY / PAIR NEW BOT
|--------------------------------------------------------------------------
|
| Example:
|
| POST /deploy
|
| {
|   "phone": "2637XXXXXXXX"
| }
|
|--------------------------------------------------------------------------
*/

app.post("/deploy", async (req, res) => {
    try {
        const phone = String(
            req.body.phone ||
            req.body.number ||
            ""
        ).replace(/\D/g, "");

        if (!phone) {
            return res.status(400).json({
                success: false,
                error: "Phone number is required"
            });
        }

        const manager = getBotManager();

        if (!manager) {
            return res.status(503).json({
                success: false,
                error:
                    "Bot manager is not loaded. Start main.js first."
            });
        }

        if (
            typeof manager.deploy !== "function"
        ) {
            return res.status(500).json({
                success: false,
                error:
                    "Bot manager does not support deployment"
            });
        }

        console.log(
            `[DEPLOY] New pairing request for +${phone}`
        );

        const result = await manager.deploy({
            phone
        });

        return res.json({
            success: true,

            bot: BOT_NAME,

            pairing_site: PAIRING_SITE,

            ...result
        });
    } catch (error) {
        console.error(
            "[DEPLOY] Error:",
            error
        );

        return res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/*
|--------------------------------------------------------------------------
| GET DEPLOYMENT
|--------------------------------------------------------------------------
*/

app.get("/deploy/:sessionId", async (req, res) => {
    try {
        const manager = getBotManager();

        if (
            manager &&
            typeof manager.getSession === "function"
        ) {
            const session =
                await Promise.resolve(
                    manager.getSession(
                        req.params.sessionId
                    )
                );

            if (!session) {
                return res.status(404).json({
                    success: false,
                    error: "Session not found"
                });
            }

            return res.json({
                success: true,
                session
            });
        }

        return res.status(503).json({
            success: false,
            error: "Bot manager unavailable"
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/*
|--------------------------------------------------------------------------
| LIVE LOGS
|--------------------------------------------------------------------------
*/

app.get("/logs/:sessionId", async (req, res) => {
    try {
        const manager = getBotManager();

        if (
            manager &&
            typeof manager.getLogs === "function"
        ) {
            const logs = await Promise.resolve(
                manager.getLogs(
                    req.params.sessionId
                )
            );

            return res.json({
                success: true,
                sessionId: req.params.sessionId,
                logs: Array.isArray(logs)
                    ? logs
                    : []
            });
        }

        return res.status(503).json({
            success: false,
            error: "Log manager unavailable"
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/*
|--------------------------------------------------------------------------
| RESTART BOT
|--------------------------------------------------------------------------
*/

app.post("/restart/:sessionId", async (req, res) => {
    try {
        const manager = getBotManager();

        if (
            !manager ||
            typeof manager.restart !== "function"
        ) {
            return res.status(503).json({
                success: false,
                error: "Restart manager unavailable"
            });
        }

        const result = await manager.restart(
            req.params.sessionId
        );

        return res.json({
            success: true,
            result
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/*
|--------------------------------------------------------------------------
| STOP BOT
|--------------------------------------------------------------------------
*/

app.post("/stop/:sessionId", async (req, res) => {
    try {
        const manager = getBotManager();

        if (
            !manager ||
            typeof manager.stop !== "function"
        ) {
            return res.status(503).json({
                success: false,
                error: "Stop manager unavailable"
            });
        }

        const result = await manager.stop(
            req.params.sessionId
        );

        return res.json({
            success: true,
            result
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/*
|--------------------------------------------------------------------------
| REMOVE BOT
|--------------------------------------------------------------------------
*/

app.delete("/bots/:sessionId", async (req, res) => {
    try {
        const manager = getBotManager();

        if (
            !manager ||
            typeof manager.remove !== "function"
        ) {
            return res.status(503).json({
                success: false,
                error: "Remove manager unavailable"
            });
        }

        const result = await manager.remove(
            req.params.sessionId
        );

        return res.json({
            success: true,
            result
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/*
|--------------------------------------------------------------------------
| OLD /add SESSION COMPATIBILITY
|--------------------------------------------------------------------------
*/

app.get("/add", async (req, res) => {
    const sid = req.query.session;

    if (!sid) {
        return res.send(`
            <h3>ETIAS-MINI-BOT</h3>
            <p>Use the pairing site to create a new session:</p>
            <a href="${PAIRING_SITE}" target="_blank">
                ${PAIRING_SITE}
            </a>
        `);
    }

    try {
        const cleanSession = String(sid).trim();

        let userId =
            "user_" + Date.now();

        /*
         * Try to decode old session format.
         */

        try {
            const b64 =
                cleanSession.includes("~")
                    ? cleanSession
                        .split("~")
                        .pop()
                    : cleanSession;

            const decoded = Buffer
                .from(b64, "base64")
                .toString("utf8");

            if (
                decoded.startsWith("{") &&
                decoded.endsWith("}")
            ) {
                const json =
                    JSON.parse(decoded);

                userId =
                    json.me?.id
                        ?.split(":")[0] ||
                    userId;
            }
        } catch {}

        /*
         * Save legacy session record.
         */

        let db = {};

        if (fs.existsSync(MULTI_FILE)) {
            try {
                db = JSON.parse(
                    fs.readFileSync(
                        MULTI_FILE,
                        "utf8"
                    )
                );
            } catch {
                db = {};
            }
        }

        db[userId] = {
            sessionId: cleanSession,
            updatedAt:
                new Date().toISOString()
        };

        fs.writeFileSync(
            MULTI_FILE,
            JSON.stringify(
                db,
                null,
                2
            )
        );

        /*
         * MongoDB
         */

        if (
            MONGODB_URI &&
            mongoose.connection.readyState === 1
        ) {
            await SessionModel.findOneAndUpdate(
                {
                    userId
                },
                {
                    sessionId: cleanSession,
                    phone: userId,
                    connected: false,
                    status: "saved"
                },
                {
                    upsert: true,
                    new: true
                }
            );
        }

        return res.send(`
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>${BOT_NAME}</title>
<meta name="viewport"
content="width=device-width,initial-scale=1">
<style>
body{
    background:#080808;
    color:white;
    font-family:Arial,sans-serif;
    display:flex;
    justify-content:center;
    align-items:center;
    min-height:100vh;
}
.card{
    max-width:500px;
    width:90%;
    background:#151515;
    border:1px solid #333;
    border-radius:20px;
    padding:30px;
    text-align:center;
}
.success{
    color:#25D366;
    font-size:20px;
    margin-bottom:15px;
}
a{
    display:inline-block;
    margin-top:20px;
    padding:12px 20px;
    border-radius:10px;
    background:#25D366;
    color:#000;
    text-decoration:none;
    font-weight:bold;
}
</style>
</head>
<body>
<div class="card">
<div class="success">✅ SESSION SAVED</div>
<p>User: ${userId}</p>
<p>The new multi-session manager will handle reconnection.</p>
<a href="${PAIRING_SITE}">
PAIR NEW BOT
</a>
</div>
</body>
</html>
        `);
    } catch (error) {
        return res.status(400).send(
            "❌ Invalid SESSION: " +
            error.message
        );
    }
});

/*
|--------------------------------------------------------------------------
| HOME PAGE
|--------------------------------------------------------------------------
*/

app.get("/", async (req, res) => {
    let commandsCount = 0;

    try {
        const commandPath =
            path.join(__dirname, "commands");

        if (fs.existsSync(commandPath)) {
            commandsCount =
                fs.readdirSync(commandPath)
                    .filter(
                        (file) =>
                            file.endsWith(".js")
                    )
                    .length;
        }
    } catch {}

    let mongoCount = 0;

    try {
        if (
            MONGODB_URI &&
            mongoose.connection.readyState === 1
        ) {
            mongoCount =
                await SessionModel.countDocuments();
        }
    } catch {}

    let totalBots = 0;

    try {
        const manager = getBotManager();

        if (
            manager &&
            typeof manager.getSessions ===
                "function"
        ) {
            const sessions =
                await Promise.resolve(
                    manager.getSessions()
                );

            if (Array.isArray(sessions)) {
                totalBots = sessions.length;
            }
        }
    } catch {}

    const uptime =
        process.uptime();

    const hours =
        Math.floor(uptime / 3600);

    const mins =
        Math.floor(
            (uptime % 3600) / 60
        );

    const secs =
        Math.floor(uptime % 60);

    res.send(`
<!DOCTYPE html>
<html>

<head>

<meta charset="UTF-8">

<meta
name="viewport"
content="width=device-width,initial-scale=1">

<title>
${BOT_NAME} - Online
</title>

<style>

*{
    margin:0;
    padding:0;
    box-sizing:border-box;
}

body{

    background:
    radial-gradient(
        circle at top,
        #10251b,
        #050505 60%
    );

    color:#fff;

    font-family:
    Arial,
    "Segoe UI",
    sans-serif;

    min-height:100vh;

    display:flex;

    justify-content:center;

    align-items:center;

    padding:20px;
}

.card{

    width:100%;

    max-width:500px;

    background:
    rgba(20,20,20,.95);

    border:
    1px solid #333;

    border-radius:24px;

    padding:30px;

    text-align:center;

    box-shadow:
    0 20px 60px
    rgba(0,0,0,.6);

}

img{

    width:130px;

    height:130px;

    object-fit:cover;

    border-radius:50%;

    border:
    4px solid #25D366;

    margin-bottom:20px;

}

h1{

    font-size:25px;

    margin-bottom:8px;

}

.status{

    display:inline-block;

    padding:
    7px 14px;

    border-radius:30px;

    color:#25D366;

    background:
    rgba(37,211,102,.1);

    border:
    1px solid #25D366;

    font-size:12px;

    margin-bottom:20px;

}

.dot{

    width:9px;

    height:9px;

    display:inline-block;

    background:#25D366;

    border-radius:50%;

    margin-right:6px;

    box-shadow:
    0 0 12px #25D366;

    animation:
    blink 1.4s infinite;

}

@keyframes blink{

    0%,100%{
        opacity:1;
    }

    50%{
        opacity:.3;
    }

}

.info{

    display:grid;

    grid-template-columns:
    1fr 1fr;

    gap:10px;

    margin:
    20px 0;

}

.info div{

    background:#242424;

    border:
    1px solid #303030;

    padding:12px;

    border-radius:12px;

    text-align:left;

}

.info span{

    display:block;

    color:#888;

    font-size:10px;

    text-transform:uppercase;

    margin-bottom:4px;

}

.info b{

    font-size:14px;

}

.btn{

    width:100%;

    display:block;

    padding:13px;

    margin-top:10px;

    border-radius:11px;

    text-decoration:none;

    font-weight:bold;

    font-size:13px;

    background:#25D366;

    color:#000;

}

.btn2{

    background:#111;

    border:
    1px solid #333;

    color:#fff;

}

.footer{

    color:#555;

    font-size:11px;

    margin-top:20px;

}

.small{

    color:#888;

    font-size:12px;

    margin-top:10px;

}

</style>

</head>

<body>

<div class="card">

<img
src="/bot-image"
onerror="
this.style.display='none'
"
/>

<h1>

<span class="dot"></span>

${BOT_NAME}

</h1>

<div class="status">

● ONLINE - ${VERSION}

</div>

<div class="info">

<div>

<span>Uptime</span>

<b>
${hours}h ${mins}m ${secs}s
</b>

</div>

<div>

<span>Commands</span>

<b>
${commandsCount}
</b>

</div>

<div>

<span>Active Bots</span>

<b>
${totalBots}
</b>

</div>

<div>

<span>MongoDB</span>

<b>
${
    mongoose.connection.readyState === 1
        ? "CONNECTED"
        : "OFFLINE"
}
</b>

</div>

<div>

<span>Database Users</span>

<b>
${mongoCount}
</b>

</div>

<div>

<span>Platform</span>

<b>
${process.platform}
</b>

</div>

</div>

<a
class="btn"
href="${PAIRING_SITE}"
target="_blank"
>

🔗 PAIR NEW BOT

</a>

<a
class="btn btn2"
href="/bots"
>

📋 VIEW ALL BOTS

</a>

<a
class="btn btn2"
href="/ping"
>

📡 SERVER STATUS

</a>

<p class="small">

WhatsApp Multi-Device<br>

Automatic reconnect + MongoDB

</p>

<div class="footer">

POWERED BY ETIAS-TECH © 2026

</div>

</div>

</body>

</html>
    `);
});

/*
|--------------------------------------------------------------------------
| 404
|--------------------------------------------------------------------------
*/

app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: "Route not found",
        path: req.path
    });
});

/*
|--------------------------------------------------------------------------
| Error Handler
|--------------------------------------------------------------------------
*/

app.use((err, req, res, next) => {
    console.error(
        "[SERVER ERROR]",
        err
    );

    res.status(500).json({
        success: false,
        error: err.message
    });
});

/*
|--------------------------------------------------------------------------
| Start Server
|--------------------------------------------------------------------------
|
| main.js can require this file without starting a second server.
|--------------------------------------------------------------------------
*/

async function startServer() {

    await connectMongo();

    return new Promise((resolve) => {

        if (app.locals.server) {
            return resolve(
                app.locals.server
            );
        }

        const server =
            app.listen(
                PORT,
                () => {

                    app.locals.server =
                        server;

                    console.log(
                        `[SERVER] ${BOT_NAME} running on port ${PORT}`
                    );

                    console.log(
                        `[SERVER] Pairing site: ${PAIRING_SITE}`
                    );

                    resolve(server);
                }
            );
    });
}

/*
|--------------------------------------------------------------------------
| Direct execution
|--------------------------------------------------------------------------
*/

if (require.main === module) {
    startServer().catch((error) => {

        console.error(
            "[SERVER] Startup failed:",
            error
        );

        process.exit(1);
    });
}

/*
|--------------------------------------------------------------------------
| Exports
|--------------------------------------------------------------------------
*/

module.exports = app;

module.exports.app = app;
module.exports.startServer = startServer;
module.exports.connectMongo = connectMongo;
module.exports.SessionModel = SessionModel;
module.exports.PAIRING_SITE = PAIRING_SITE;
