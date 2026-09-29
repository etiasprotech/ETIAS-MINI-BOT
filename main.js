// ============================================================
// ETIAS-MINI-BOT
// MULTI SESSION WHATSAPP BOT SERVER
// ============================================================
// Features:
// - Multi-device Baileys
// - Multi-session support
// - Pairing-code login
// - Long/short session ID support
// - SESSION_ID saved as creds.json
// - SESSION_ID sent to WhatsApp as a FILE
// - SESSION_ID also printed in terminal
// - MongoDB session persistence
// - Automatic reconnect
// - Anti-delete
// - Anti-link
// - Anti-view-once
// - View-once recovery
// - Public/private mode
// - Owner commands
// - Command loader
// - Live connection logs
// - Session expiration support
// ============================================================

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser,
    downloadContentFromMessage,
    getContentType
} = require("@whiskeysockets/baileys");

const pino = require("pino");

// ============================================================
// CONFIG
// ============================================================

const BOT_NAME = process.env.BOT_NAME || "ETIAS-MINI-BOT";
const PREFIX = process.env.PREFIX || ".";
const PORT = Number(process.env.PORT || 3000);

const OWNER_NUMBER =
    process.env.OWNER_NUMBER ||
    process.env.OWNER ||
    "";

const MONGO_URI =
    process.env.MONGO_URI ||
    process.env.MONGODB_URI ||
    "";

const SESSION_EXPIRY_DAYS =
    Number(process.env.SESSION_EXPIRY_DAYS || 30);

const PAIRING_SITE =
    process.env.PAIRING_SITE ||
    "https://etias-mini-bot-pair.onrender.com/";

const DATA_DIR = path.join(__dirname, "data");
const AUTH_DIR = path.join(__dirname, "auth");
const USERS_DIR = path.join(AUTH_DIR, "users");
const COMMANDS_DIR = path.join(__dirname, "commands");
const MEDIA_DIR = path.join(__dirname, "media");

const BOT_IMAGE =
    process.env.BOT_IMAGE ||
    path.join(__dirname, "assets", "bot_image.png");

// ============================================================
// DIRECTORIES
// ============================================================

for (const dir of [
    DATA_DIR,
    AUTH_DIR,
    USERS_DIR,
    COMMANDS_DIR,
    MEDIA_DIR
]) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

// ============================================================
// GLOBAL STATE
// ============================================================

const sessions = new Map();
const commands = new Map();

let BOT_MODE = "public";

// ============================================================
// EXPRESS
// ============================================================

const app = express();

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({
    extended: true,
    limit: "50mb"
}));

app.get("/", (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${BOT_NAME}</title>
<style>
body{
    margin:0;
    background:#050505;
    color:#00ffcc;
    font-family:Arial,sans-serif;
    display:flex;
    align-items:center;
    justify-content:center;
    min-height:100vh;
}
.box{
    text-align:center;
    padding:40px;
    border:1px solid #00ffcc;
    border-radius:20px;
    box-shadow:0 0 30px #00ffcc44;
}
h1{
    font-size:32px;
}
p{
    color:#aaa;
}
</style>
</head>
<body>
<div class="box">
<h1>${BOT_NAME}</h1>
<p>Multi-session WhatsApp Bot Server</p>
<p>Status: ONLINE</p>
<p>Sessions: ${sessions.size}</p>
</div>
</body>
</html>
`);
});

// ============================================================
// HEALTH
// ============================================================

app.get("/health", (req, res) => {
    res.json({
        status: "online",
        bot: BOT_NAME,
        mode: BOT_MODE,
        sessions: sessions.size,
        commands: commands.size,
        uptime: process.uptime()
    });
});

app.get("/status", (req, res) => {

    const result = [];

    for (const [id, session] of sessions.entries()) {

        result.push({
            sessionId: id,
            phone: session.phone || null,
            connected: !!session.connected,
            reconnecting: !!session.reconnecting,
            createdAt: session.createdAt || null,
            expireAt: session.expireAt || null
        });
    }

    res.json({
        bot: BOT_NAME,
        mode: BOT_MODE,
        sessions: result
    });
});

// ============================================================
// MONGOOSE MODEL
// ============================================================

let SessionModel = null;

if (MONGO_URI) {

    const sessionSchema = new mongoose.Schema({

        userId: {
            type: String,
            index: true
        },

        sessionId: {
            type: String,
            unique: true,
            index: true
        },

        phone: {
            type: String,
            index: true
        },

        connected: {
            type: Boolean,
            default: false
        },

        days: {
            type: Number,
            default: SESSION_EXPIRY_DAYS
        },

        createdAt: {
            type: Date,
            default: Date.now
        },

        expireAt: {
            type: Date
        }

    });

    SessionModel =
        mongoose.models.BotSession ||
        mongoose.model("BotSession", sessionSchema);
}

// ============================================================
// MONGODB
// ============================================================

async function connectMongo() {

    if (!MONGO_URI) {
        console.log("[MONGO] ⚠️ MONGO_URI not configured");
        return;
    }

    try {

        await mongoose.connect(MONGO_URI);

        console.log("[MONGO] ✅ Connected");

    } catch (err) {

        console.error(
            "[MONGO] ❌ Connection failed:",
            err.message
        );
    }
}

// ============================================================
// HELPERS
// ============================================================

function cleanPhone(phone) {

    return String(phone || "")
        .replace(/\D/g, "")
        .replace(/^0+/, "");
}

function normalizeJid(phone) {

    const clean = cleanPhone(phone);

    if (!clean) return null;

    return jidNormalizedUser(`${clean}@s.whatsapp.net`);
}

function safeSessionName(value) {

    return String(value || "")
        .replace(/[^a-zA-Z0-9_-]/g, "_")
        .slice(0, 100);
}

function sessionFolder(sessionId) {

    return path.join(
        USERS_DIR,
        safeSessionName(sessionId)
    );
}

function sleep(ms) {

    return new Promise(resolve =>
        setTimeout(resolve, ms)
    );
}

function generateSessionId() {

    const chars =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

    let random = "";

    for (let i = 0; i < 160; i++) {
        random += chars[
            Math.floor(Math.random() * chars.length)
        ];
    }

    return `ETIAS-MINI-BOT~${random}`;
}

// ============================================================
// SESSION FILE
// ============================================================

function saveSessionIdFile(sessionId, folder) {

    fs.mkdirSync(folder, {
        recursive: true
    });

    const credsPath =
        path.join(folder, "creds.json");

    const sessionData = {

        format: "ETIAS-MINI-BOT",

        version: 2,

        sessionId,

        generatedAt:
            new Date().toISOString(),

        bot: BOT_NAME

    };

    fs.writeFileSync(
        credsPath,
        JSON.stringify(sessionData, null, 2)
    );

    return credsPath;
}

// ============================================================
// SESSION ID FILE FOR SENDING
// ============================================================

function createSessionDownload(sessionId) {

    const fileName =
        `${safeSessionName(sessionId)}.txt`;

    const filePath =
        path.join(MEDIA_DIR, fileName);

    fs.writeFileSync(
        filePath,
        sessionId,
        "utf8"
    );

    return filePath;
}

// ============================================================
// SEND SESSION FILE
// ============================================================

async function sendSessionFile(sock, phone, sessionId) {

    const jid = normalizeJid(phone);

    if (!jid) {
        console.log("[SESSION] Invalid phone:", phone);
        return false;
    }

    const filePath =
        createSessionDownload(sessionId);

    try {

        console.log(
            `[SESSION] Sending session file to ${phone}`
        );

        await sock.sendMessage(jid, {

            document: {
                url: filePath
            },

            mimetype:
                "text/plain",

            fileName:
                `${BOT_NAME}-SESSION.txt`,

            caption:
                `*${BOT_NAME} SESSION*\n\n` +
                `Your complete session ID is attached as a file.\n\n` +
                `Keep this file private.\n\n` +
                `Powered by ETIAS-TECH`

        });

        console.log(
            `[SESSION] ✅ Session file sent to ${phone}`
        );

        return true;

    } catch (err) {

        console.error(
            "[SESSION] ❌ Failed to send:",
            err.message
        );

        return false;

    } finally {

        setTimeout(() => {

            try {

                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                }

            } catch (_) {}

        }, 60000);
    }
}

// ============================================================
// TERMINAL SESSION DISPLAY
// ============================================================

function displaySession(sessionId, phone) {

    console.log("");
    console.log(
        "============================================================"
    );

    console.log(
        `🔥 ${BOT_NAME} SESSION GENERATED`
    );

    console.log(
        `📱 Phone: ${phone || "unknown"}`
    );

    console.log(
        `🧩 Length: ${sessionId.length} characters`
    );

    console.log("");
    console.log(
        "SESSION_ID:"
    );

    console.log(sessionId);

    console.log("");
    console.log(
        "============================================================"
    );
    console.log("");
}

// ============================================================
// COMMAND LOADER
// ============================================================

function loadCommands() {

    commands.clear();

    if (!fs.existsSync(COMMANDS_DIR)) {
        console.log(
            "[COMMANDS] ⚠️ commands folder not found"
        );
        return;
    }

    const files =
        fs.readdirSync(COMMANDS_DIR)
            .filter(file =>
                file.endsWith(".js")
            );

    for (const file of files) {

        try {

            const command =
                require(
                    path.join(COMMANDS_DIR, file)
                );

            if (!command) continue;

            const names = [];

            if (command.name) {
                names.push(command.name);
            }

            if (Array.isArray(command.command)) {
                names.push(...command.command);
            }

            if (Array.isArray(command.alias)) {
                names.push(...command.alias);
            }

            if (typeof command === "function") {

                commands.set(
                    file.replace(".js", ""),
                    {
                        name:
                            file.replace(".js", ""),
                        execute: command
                    }
                );

                continue;
            }

            if (
                typeof command.execute ===
                "function"
            ) {

                if (!names.length) {
                    names.push(
                        file.replace(".js", "")
                    );
                }

                for (const name of names) {

                    commands.set(
                        String(name).toLowerCase(),
                        command
                    );
                }
            }

        } catch (err) {

            console.error(
                `[COMMANDS] Failed ${file}:`,
                err.message
            );
        }
    }

    console.log(
        `[COMMANDS] ${commands.size} commands loaded`
    );
}

// ============================================================
// SESSION DATABASE SAVE
// ============================================================

async function saveSessionDatabase(data) {

    if (!SessionModel) return;

    try {

        await SessionModel.findOneAndUpdate(

            {
                sessionId: data.sessionId
            },

            {
                $set: data
            },

            {
                upsert: true,
                new: true
            }
        );

    } catch (err) {

        console.error(
            "[MONGO] Session save error:",
            err.message
        );
    }
}

// ============================================================
// SESSION DATABASE DELETE
// ============================================================

async function deleteSessionDatabase(sessionId) {

    if (!SessionModel) return;

    try {

        await SessionModel.deleteOne({
            sessionId
        });

    } catch (err) {

        console.error(
            "[MONGO] Session delete error:",
            err.message
        );
    }
}

// ============================================================
// STORE
// ============================================================

const messageStore = new Map();

function rememberMessage(message) {

    if (!message?.key?.id) return;

    const id =
        message.key.id;

    messageStore.set(
        id,
        message
    );

    if (messageStore.size > 1000) {

        const first =
            messageStore.keys().next().value;

        messageStore.delete(first);
    }
}

function getRememberedMessage(id) {

    return messageStore.get(id);
}

// ============================================================
// DOWNLOAD MEDIA
// ============================================================

async function downloadMessageMedia(message) {

    try {

        const type =
            getContentType(message.message);

        if (!type) return null;

        let mediaMessage = null;

        if (
            type === "imageMessage" ||
            type === "videoMessage" ||
            type === "audioMessage" ||
            type === "documentMessage"
        ) {

            mediaMessage =
                message.message[type];

        } else {

            return null;
        }

        const stream =
            await downloadContentFromMessage(
                mediaMessage,
                type.replace("Message", "")
            );

        const chunks = [];

        for await (const chunk of stream) {
            chunks.push(chunk);
        }

        return Buffer.concat(chunks);

    } catch (err) {

        console.error(
            "[MEDIA] Download error:",
            err.message
        );

        return null;
    }
}

// ============================================================
// ANTI LINK
// ============================================================

function containsLink(text) {

    if (!text) return false;

    return /(https?:\/\/|www\.|chat\.whatsapp\.com\/)/i
        .test(text);
}

// ============================================================
// EXTRACT TEXT
// ============================================================

function getMessageText(message) {

    if (!message?.message) return "";

    const msg =
        message.message;

    if (msg.conversation) {
        return msg.conversation;
    }

    if (msg.extendedTextMessage) {
        return msg.extendedTextMessage.text || "";
    }

    if (msg.imageMessage) {
        return msg.imageMessage.caption || "";
    }

    if (msg.videoMessage) {
        return msg.videoMessage.caption || "";
    }

    if (msg.documentMessage) {
        return msg.documentMessage.caption || "";
    }

    return "";
}

// ============================================================
// VIEW ONCE
// ============================================================

function unwrapViewOnce(message) {

    if (!message?.message) {
        return message;
    }

    const msg =
        message.message;

    if (msg.viewOnceMessage?.message) {

        return {
            ...message,
            message:
                msg.viewOnceMessage.message
        };
    }

    if (
        msg.viewOnceMessageV2?.message
    ) {

        return {
            ...message,
            message:
                msg.viewOnceMessageV2.message
        };
    }

    if (
        msg.viewOnceMessageV2Extension?.message
    ) {

        return {
            ...message,
            message:
                msg.viewOnceMessageV2Extension.message
        };
    }

    return message;
}

// ============================================================
// CONNECTION MESSAGE
// ============================================================

async function sendWelcome(sock, phone) {

    try {

        const jid =
            normalizeJid(phone);

        if (!jid) return;

        await sock.sendMessage(jid, {

            text:
`*${BOT_NAME}*

✅ Connected successfully.

Your WhatsApp bot is now online.

Prefix: ${PREFIX}
Mode: ${BOT_MODE}

🌐 Pairing:
${PAIRING_SITE}

⚡ Powered by ETIAS-TECH`

        });

    } catch (err) {

        console.error(
            "[WELCOME] Error:",
            err.message
        );
    }
}

// ============================================================
// HANDLE COMMAND
// ============================================================

async function executeCommand(
    sock,
    message,
    session
) {

    const text =
        getMessageText(message)
            .trim();

    if (!text.startsWith(PREFIX)) {
        return false;
    }

    const withoutPrefix =
        text.slice(PREFIX.length)
            .trim();

    if (!withoutPrefix) {
        return false;
    }

    const parts =
        withoutPrefix.split(/\s+/);

    const commandName =
        parts.shift()
            .toLowerCase();

    const args =
        parts;

    const command =
        commands.get(commandName);

    if (!command) {
        return false;
    }

    const sender =
        message.key?.participant ||
        message.key?.remoteJid ||
        "";

    const chat =
        message.key?.remoteJid ||
        "";

    const isOwner =
        cleanPhone(sender) ===
        cleanPhone(OWNER_NUMBER);

    const context = {

        sock,

        message,

        session,

        args,

        text,

        command: commandName,

        sender,

        chat,

        isOwner,

        botName: BOT_NAME,

        prefix: PREFIX,

        mode: BOT_MODE,

        send: async content => {

            return sock.sendMessage(
                chat,
                content,
                {
                    quoted: message
                }
            );
        },

        reply: async text => {

            return sock.sendMessage(
                chat,
                {
                    text
                },
                {
                    quoted: message
                }
            );
        }

    };

    try {

        if (
            typeof command.execute ===
            "function"
        ) {

            await command.execute(
                context
            );

            return true;
        }

        if (
            typeof command.run ===
            "function"
        ) {

            await command.run(
                context
            );

            return true;
        }

        if (typeof command === "function") {

            await command(
                context
            );

            return true;
        }

    } catch (err) {

        console.error(
            `[COMMAND] ${commandName}:`,
            err
        );

        try {

            await context.reply(
                `❌ Command error: ${err.message}`
            );

        } catch (_) {}
    }

    return false;
}

// ============================================================
// HANDLE MESSAGE
// ============================================================

async function handleMessage(
    sock,
    message,
    session
) {

    if (!message?.message) {
        return;
    }

    if (message.key?.fromMe) {
        return;
    }

    rememberMessage(message);

    let msg =
        unwrapViewOnce(message);

    const remoteJid =
        msg.key?.remoteJid;

    if (!remoteJid) return;

    const text =
        getMessageText(msg);

    // ========================================================
    // ANTI-LINK
    // ========================================================

    if (
        session.antiLink &&
        containsLink(text)
    ) {

        try {

            if (
                remoteJid.endsWith("@g.us")
            ) {

                await sock.sendMessage(
                    remoteJid,
                    {
                        text:
                            "🚫 Links are not allowed."
                    },
                    {
                        quoted: msg
                    }
                );
            }

        } catch (_) {}
    }

    // ========================================================
    // VIEW ONCE
    // ========================================================

    const originalType =
        getContentType(
            message.message
        );

    const isViewOnce =
        originalType ===
            "viewOnceMessage" ||
        originalType ===
            "viewOnceMessageV2" ||
        originalType ===
            "viewOnceMessageV2Extension";

    if (
        isViewOnce &&
        session.antiViewOnce
    ) {

        try {

            const inner =
                unwrapViewOnce(message);

            const innerType =
                getContentType(
                    inner.message
                );

            if (
                innerType ===
                    "imageMessage" ||
                innerType ===
                    "videoMessage"
            ) {

                const media =
                    await downloadMessageMedia(
                        inner
                    );

                if (media) {

                    await sock.sendMessage(
                        remoteJid,
                        {
                            [innerType === "imageMessage"
                                ? "image"
                                : "video"]: media,

                            caption:
                                "👁️ View-once recovered."
                        },
                        {
                            quoted: message
                        }
                    );
                }
            }

        } catch (err) {

            console.error(
                "[VIEWONCE]",
                err.message
            );
        }
    }

    // ========================================================
    // COMMANDS
    // ========================================================

    await executeCommand(
        sock,
        msg,
        session
    );
}

// ============================================================
// ANTI DELETE
// ============================================================

async function handleMessageDelete(
    sock,
    update,
    session
) {

    if (!session.antiDelete) {
        return;
    }

    try {

        const key =
            update.keys?.[0];

        if (!key) return;

        const deleted =
            getRememberedMessage(
                key.id
            );

        if (!deleted) return;

        const chat =
            key.remoteJid;

        if (!chat) return;

        const text =
            getMessageText(deleted);

        if (text) {

            await sock.sendMessage(
                chat,
                {
                    text:
`🗑️ *Deleted Message*

${text}`
                }
            );

            return;
        }

        const type =
            getContentType(
                deleted.message
            );

        if (
            type === "imageMessage" ||
            type === "videoMessage"
        ) {

            const media =
                await downloadMessageMedia(
                    deleted
                );

            if (!media) return;

            await sock.sendMessage(
                chat,
                {
                    [type === "imageMessage"
                        ? "image"
                        : "video"]: media,

                    caption:
                        "🗑️ Deleted media recovered."
                }
            );
        }

    } catch (err) {

        console.error(
            "[ANTIDELETE]",
            err.message
        );
    }
}

// ============================================================
// CREATE WHATSAPP SESSION
// ============================================================

async function createSession(options = {}) {

    const {

        sessionId:
            suppliedSessionId,

        phone,

        userId,

        days =
            SESSION_EXPIRY_DAYS

    } = options;

    const sessionId =
        suppliedSessionId ||
        generateSessionId();

    const safeId =
        safeSessionName(sessionId);

    const authPath =
        sessionFolder(safeId);

    fs.mkdirSync(
        authPath,
        {
            recursive: true
        }
    );

    const {

        state,
        saveCreds

    } =
        await useMultiFileAuthState(
            authPath
        );

    let version;

    try {

        const latest =
            await fetchLatestBaileysVersion();

        version =
            latest.version;

        console.log(
            `[BAILEYS] Using version ${version.join(".")}`
        );

    } catch (_) {

        version =
            [2, 3000, 1015901307];
    }

    const logger =
        pino({
            level:
                process.env.LOG_LEVEL ||
                "silent"
        });

    const sock =
        makeWASocket({

            version,

            logger,

            printQRInTerminal:
                false,

            browser:
                Browsers.macOS(
                    "Chrome"
                ),

            auth: {

                creds:
                    state.creds,

                keys:
                    makeCacheableSignalKeyStore(
                        state.keys,
                        logger
                    )
            },

            generateHighQualityLinkPreview:
                true,

            markOnlineOnConnect:
                false,

            syncFullHistory:
                false

        });

    const session = {

        id: sessionId,

        sessionId,

        phone:
            phone ||
            sock.user?.id?.split(":")[0] ||
            "",

        userId:

            userId ||
            phone ||
            "",

        sock,

        connected: false,

        reconnecting: false,

        createdAt:
            new Date(),

        expireAt:
            new Date(
                Date.now() +
                days *
                24 *
                60 *
                60 *
                1000
            ),

        antiDelete:
            true,

        antiLink:
            true,

        antiViewOnce:
            true,

        viewOnce:
            true,

        authPath,

        lastDisconnect: null

    };

    sessions.set(
        sessionId,
        session
    );

    // ========================================================
    // SAVE CREDS
    // ========================================================

    sock.ev.on(
        "creds.update",
        saveCreds
    );

    // ========================================================
    // CONNECTION
    // ========================================================

    sock.ev.on(
        "connection.update",
        async update => {

            const {

                connection,

                lastDisconnect,

                qr

            } = update;

            if (qr) {

                console.log(
                    `[PAIRING] QR received for ${session.phone || sessionId}`
                );
            }

            if (
                connection ===
                "connecting"
            ) {

                console.log(
                    `[${sessionId.slice(0, 30)}...] 🔄 Connecting...`
                );
            }

            if (
                connection ===
                "open"
            ) {

                session.connected =
                    true;

                session.reconnecting =
                    false;

                session.lastDisconnect =
                    null;

                if (
                    sock.user?.id
                ) {

                    session.phone =
                        sock.user.id
                            .split(":")[0]
                            .replace(
                                /\D/g,
                                ""
                            );
                }

                console.log("");
                console.log(
                    "============================================================"
                );

                console.log(
                    `[WHATSAPP] ✅ CONNECTED`
                );

                console.log(
                    `[WHATSAPP] 📱 ${session.phone}`
                );

                console.log(
                    `[WHATSAPP] 🧩 Session length: ${sessionId.length}`
                );

                console.log(
                    `[WHATSAPP] 📁 Auth: ${authPath}`
                );

                console.log(
                    "============================================================"
                );
                console.log("");

                await saveSessionDatabase({

                    sessionId,

                    phone:
                        session.phone,

                    userId:
                        session.userId,

                    connected:
                        true,

                    days,

                    expireAt:
                        session.expireAt,

                    createdAt:
                        session.createdAt

                });

                await sendWelcome(
                    sock,
                    session.phone
                );
            }

            if (
                connection ===
                "close"
            ) {

                session.connected =
                    false;

                session.lastDisconnect =
                    lastDisconnect;

                const statusCode =
                    lastDisconnect
                        ?.error
                        ?.output
                        ?.statusCode;

                const loggedOut =
                    statusCode ===
                    DisconnectReason.loggedOut;

                const connectionReplaced =
                    statusCode ===
                    DisconnectReason.connectionReplaced;

                console.log(
                    `[WHATSAPP] ❌ Connection closed`
                );

                console.log(
                    `[WHATSAPP] Code: ${statusCode || "unknown"}`
                );

                if (
                    loggedOut ||
                    connectionReplaced
                ) {

                    console.log(
                        `[WHATSAPP] ❌ Session cannot automatically reconnect`
                    );

                    sessions.delete(
                        sessionId
                    );

                    await saveSessionDatabase({

                        sessionId,

                        phone:
                            session.phone,

                        userId:
                            session.userId,

                        connected:
                            false,

                        days,

                        expireAt:
                            session.expireAt
                    });

                    return;
                }

                if (
                    !session.reconnecting
                ) {

                    session.reconnecting =
                        true;

                    console.log(
                        `[WHATSAPP] 🔄 Reconnecting ${session.phone || sessionId}`
                    );

                    setTimeout(
                        async () => {

                            try {

                                await createSession({

                                    sessionId,

                                    phone:
                                        session.phone,

                                    userId:
                                        session.userId,

                                    days

                                });

                            } catch (err) {

                                console.error(
                                    "[RECONNECT] Failed:",
                                    err.message
                                );

                            }

                        },
                        5000
                    );
                }
            }
        }
    );

    // ========================================================
    // MESSAGE EVENTS
    // ========================================================

    sock.ev.on(
        "messages.upsert",
        async ({
            messages,
            type
        }) => {

            if (
                type !== "notify" &&
                type !== "append"
            ) {
                return;
            }

            for (
                const message
                of messages
            ) {

                try {

                    await handleMessage(
                        sock,
                        message,
                        session
                    );

                } catch (err) {

                    console.error(
                        "[MESSAGE]",
                        err.message
                    );
                }
            }
        }
    );

    // ========================================================
    // MESSAGE DELETE
    // ========================================================

    sock.ev.on(
        "messages.update",
        async updates => {

            for (
                const update
                of updates
            ) {

                if (
                    update.update
                        ?.message ===
                    null
                ) {

                    await handleMessageDelete(
                        sock,
                        update,
                        session
                    );
                }
            }
        }
    );

    // ========================================================
    // GROUP PARTICIPANTS
    // ========================================================

    sock.ev.on(
        "group-participants.update",
        async update => {

            try {

                const {
                    id,
                    participants,
                    action
                } = update;

                if (
                    action ===
                    "add"
                ) {

                    for (
                        const participant
                        of participants
                    ) {

                        await sock.sendMessage(
                            id,
                            {
                                text:
`👋 Welcome @${participant.split("@")[0]}

Welcome to the group!

Powered by ${BOT_NAME}`,

                                mentions: [
                                    participant
                                ]
                            }
                        );
                    }
                }

                if (
                    action ===
                    "remove"
                ) {

                    for (
                        const participant
                        of participants
                    ) {

                        await sock.sendMessage(
                            id,
                            {
                                text:
`👋 Goodbye @${participant.split("@")[0]}`,

                                mentions: [
                                    participant
                                ]
                            }
                        );
                    }
                }

            } catch (err) {

                console.error(
                    "[GROUP]",
                    err.message
                );
            }
        }
    );

    // ========================================================
    // SAVE DATABASE
    // ========================================================

    await saveSessionDatabase({

        sessionId,

        phone:
            session.phone,

        userId:
            session.userId,

        connected:
            false,

        days,

        expireAt:
            session.expireAt,

        createdAt:
            session.createdAt

    });

    // ========================================================
    // SESSION EXPIRY
    // ========================================================

    const expiryTimer =
        setInterval(
            async () => {

                if (
                    Date.now() >=
                    session.expireAt.getTime()
                ) {

                    console.log(
                        `[SESSION] ⏰ Expired: ${sessionId}`
                    );

                    clearInterval(
                        expiryTimer
                    );

                    try {
                        await sock.logout();
                    } catch (_) {}

                    sessions.delete(
                        sessionId
                    );

                    await deleteSessionDatabase(
                        sessionId
                    );
                }

            },
            60000
        );

    // ========================================================
    // PAIRING CODE
    // ========================================================

    if (
        phone &&
        !state.creds.registered
    ) {

        const clean =
            cleanPhone(phone);

        if (clean) {

            try {

                await sleep(2000);

                console.log(
                    `[PAIRING] Requesting code for ${clean}`
                );

                const code =
                    await sock.requestPairingCode(
                        clean
                    );

                console.log("");
                console.log(
                    "============================================================"
                );

                console.log(
                    `📱 PAIRING CODE FOR ${clean}`
                );

                console.log(
                    code
                );

                console.log(
                    "============================================================"
                );
                console.log("");

            } catch (err) {

                console.error(
                    "[PAIRING] ❌ Failed:",
                    err.message
                );
            }
        }
    }

    return session;
}

// ============================================================
// DEPLOY SESSION
// ============================================================

async function deploySession(
    phone,
    userId
) {

    phone =
        cleanPhone(phone);

    if (!phone) {
        throw new Error(
            "Invalid phone number"
        );
    }

    const sessionId =
        generateSessionId();

    const folder =
        sessionFolder(
            sessionId
        );

    saveSessionIdFile(
        sessionId,
        folder
    );

    // IMPORTANT:
    // Display complete long session in terminal.
    displaySession(
        sessionId,
        phone
    );

    const session =
        await createSession({

            sessionId,

            phone,

            userId

        });

    // ========================================================
    // SEND SESSION AS FILE AFTER CONNECTION
    // ========================================================

    const check =
        setInterval(
            async () => {

                if (
                    session.connected
                ) {

                    clearInterval(
                        check
                    );

                    await sendSessionFile(
                        session.sock,
                        phone,
                        sessionId
                    );
                }

            },
            2000
        );

    // Stop checking after 5 minutes.
    setTimeout(
        () => {
            clearInterval(check);
        },
        5 * 60 * 1000
    );

    return {

        sessionId,

        phone,

        connected:
            session.connected,

        expireAt:
            session.expireAt

    };
}

// ============================================================
// API: DEPLOY
// ============================================================

app.post(
    "/deploy",
    async (req, res) => {

        try {

            const {
                phone,
                userId
            } = req.body;

            if (!phone) {

                return res.status(400)
                    .json({

                        success: false,

                        error:
                            "phone is required"

                    });
            }

            const result =
                await deploySession(
                    phone,
                    userId
                );

            res.json({

                success: true,

                message:
                    "Session deployment started",

                ...result

            });

        } catch (err) {

            console.error(
                "[DEPLOY]",
                err
            );

            res.status(500)
                .json({

                    success: false,

                    error:
                        err.message

                });
        }
    }
);

// ============================================================
// API: MODE
// ============================================================

app.get(
    "/mode",
    (req, res) => {

        res.json({

            mode:
                BOT_MODE

        });
    }
);

app.post(
    "/mode",
    (req, res) => {

        const mode =
            req.body.mode;

        if (
            mode !== "public" &&
            mode !== "private"
        ) {

            return res.status(400)
                .json({

                    success: false,

                    error:
                        "Mode must be public or private"

                });
        }

        BOT_MODE =
            mode;

        console.log(
            `[MODE] ${BOT_MODE.toUpperCase()}`
        );

        res.json({

            success: true,

            mode:
                BOT_MODE

        });
    }
);

// ============================================================
// API: TOTAL USERS
// ============================================================

app.get(
    "/total-users",
    async (req, res) => {

        let total =
            sessions.size;

        if (SessionModel) {

            try {

                total =
                    await SessionModel.countDocuments();

            } catch (_) {}
        }

        res.json({
            total
        });
    }
);

// ============================================================
// API: DEPLOY STATS
// ============================================================

app.get(
    "/deploy-stats",
    async (req, res) => {

        let total =
            sessions.size;

        let connected =
            0;

        for (
            const session
            of sessions.values()
        ) {

            if (
                session.connected
            ) {
                connected++;
            }
        }

        if (SessionModel) {

            try {

                total =
                    await SessionModel.countDocuments();

                connected =
                    await SessionModel.countDocuments({
                        connected: true
                    });

            } catch (_) {}
        }

        res.json({

            total,

            connected,

            offline:
                total - connected

        });
    }
);

// ============================================================
// API: DEPLOYED LIST
// ============================================================

app.get(
    "/deployed-list",
    async (req, res) => {

        if (SessionModel) {

            try {

                const data =
                    await SessionModel
                        .find({})
                        .sort({
                            createdAt: -1
                        })
                        .lean();

                return res.json(data);

            } catch (_) {}
        }

        const data =
            [...sessions.values()]
                .map(session => ({

                    sessionId:
                        session.sessionId,

                    phone:
                        session.phone,

                    connected:
                        session.connected,

                    createdAt:
                        session.createdAt,

                    expireAt:
                        session.expireAt

                }));

        res.json(data);
    }
);

// ============================================================
// API: REMOVE SESSION
// ============================================================

app.post(
    "/remove",
    async (req, res) => {

        try {

            const {
                sessionId
            } = req.body;

            if (!sessionId) {

                return res.status(400)
                    .json({

                        success: false,

                        error:
                            "sessionId required"

                    });
            }

            const session =
                sessions.get(
                    sessionId
                );

            if (session) {

                try {
                    await session.sock.logout();
                } catch (_) {}

                sessions.delete(
                    sessionId
                );
            }

            await deleteSessionDatabase(
                sessionId
            );

            res.json({

                success: true

            });

        } catch (err) {

            res.status(500)
                .json({

                    success: false,

                    error:
                        err.message

                });
        }
    }
);

// ============================================================
// LOAD SAVED SESSIONS
// ============================================================

async function loadSavedSessions() {

    if (!SessionModel) {

        console.log(
            "[MULTI] MongoDB not available; skipping saved sessions"
        );

        return;
    }

    try {

        const saved =
            await SessionModel.find({

                expireAt: {
                    $gt:
                        new Date()
                }

            }).lean();

        console.log(
            `[MULTI] ${saved.length} saved sessions`
        );

        for (
            const item
            of saved
        ) {

            if (
                !item.sessionId
            ) {
                continue;
            }

            const folder =
                sessionFolder(
                    item.sessionId
                );

            if (
                !fs.existsSync(folder)
            ) {

                console.log(
                    `[MULTI] Auth missing for ${item.phone || item.sessionId}`
                );

                continue;
            }

            try {

                await createSession({

                    sessionId:
                        item.sessionId,

                    phone:
                        item.phone,

                    userId:
                        item.userId,

                    days:
                        item.days ||
                        SESSION_EXPIRY_DAYS

                });

                console.log(
                    `[MULTI] Loaded ${item.phone || item.sessionId}`
                );

            } catch (err) {

                console.error(
                    `[MULTI] Failed loading ${item.sessionId}:`,
                    err.message
                );
            }

            await sleep(1000);
        }

    } catch (err) {

        console.error(
            "[MULTI] Load error:",
            err.message
        );
    }
}

// ============================================================
// PROCESS ERRORS
// ============================================================

process.on(
    "uncaughtException",
    err => {

        console.error(
            "[PROCESS] Uncaught Exception:",
            err
        );
    }
);

process.on(
    "unhandledRejection",
    err => {

        console.error(
            "[PROCESS] Unhandled Rejection:",
            err
        );
    }
);

// ============================================================
// START SERVER
// ============================================================

async function start() {

    console.log("");
    console.log(
        "============================================================"
    );

    console.log(
        `🤖 ${BOT_NAME}`
    );

    console.log(
        "🚀 Starting..."
    );

    console.log(
        "============================================================"
    );

    await connectMongo();

    loadCommands();

    await loadSavedSessions();

    const server =
        http.createServer(app);

    server.listen(
        PORT,
        "0.0.0.0",
        () => {

            console.log(
                `[SERVER] Running on port ${PORT}`
            );

            console.log(
                `[MODE] ${BOT_MODE.toUpperCase()}`
            );

            console.log(
                `[COMMANDS] ${commands.size} commands loaded`
            );

            console.log(
                `[MULTI] ${sessions.size} active sessions`
            );

            console.log(
                `[PAIRING] ${PAIRING_SITE}`
            );

            console.log("");
        }
    );
}

// ============================================================
// START
// ============================================================

start();
