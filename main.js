"use strict";

/*
============================================================
 ETIAS-MINI-BOT
 MULTI SESSION BOT ENGINE
 WhatsApp Multi-Device
 Pairing Code Deployment
 MongoDB + Local Fallback
 Live Logs
 Automatic Reconnect
============================================================
*/

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const pino = require("pino");
const mongoose = require("mongoose");

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    Browsers,
    jidNormalizedUser
} = require("@whiskeysockets/baileys");

/*
============================================================
 CONFIG
============================================================
*/

const BOT_NAME =
    process.env.BOT_NAME ||
    "ETIAS-MINI-BOT";

const PREFIX =
    process.env.PREFIX ||
    ".";

const PORT =
    Number(process.env.PORT) ||
    3000;

const DEFAULT_DAYS =
    Number(process.env.DEFAULT_DAYS) ||
    30;

const OWNER_NUMBER =
    String(process.env.OWNER_NUMBER || "")
        .replace(/\D/g, "");

const MONGO_URI =
    process.env.MONGODB_URI ||
    process.env.MONGO_URI ||
    "";

const MODE =
    process.env.MODE ||
    "public";

const BASE_DIR = __dirname;

const AUTH_DIR =
    path.join(BASE_DIR, "auth");

const USERS_AUTH_DIR =
    path.join(AUTH_DIR, "users");

const DATA_DIR =
    path.join(BASE_DIR, "data");

const LOG_DIR =
    path.join(BASE_DIR, "logs");

const COMMANDS_DIR =
    path.join(BASE_DIR, "commands");

const MEDIA_DIR =
    path.join(BASE_DIR, "media");

const LOCAL_DB =
    path.join(DATA_DIR, "deployed.json");

const LOCAL_MULTI_DB =
    path.join(DATA_DIR, "multi_sessions.json");

/*
============================================================
 CREATE DIRECTORIES
============================================================
*/

[
    AUTH_DIR,
    USERS_AUTH_DIR,
    DATA_DIR,
    LOG_DIR,
    COMMANDS_DIR,
    MEDIA_DIR
].forEach((dir) => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, {
            recursive: true
        });
    }
});

/*
============================================================
 LOGGER
============================================================
*/

const logger = pino({
    level:
        process.env.LOG_LEVEL ||
        "silent"
});

/*
============================================================
 RUNTIME STORAGE
============================================================
*/

const sessions = new Map();

const deploymentLogs = new Map();

const loadedCommands = new Map();

/*
============================================================
 UTILITIES
============================================================
*/

function now() {
    return new Date();
}

function randomId(length = 12) {
    return crypto
        .randomBytes(
            Math.ceil(length / 2)
        )
        .toString("hex")
        .slice(0, length);
}

function generateSessionId() {
    return (
        "ETIAS-MINI-BOT~" +
        randomId(24)
    );
}

function normalizeNumber(number) {
    return String(number || "")
        .replace(/\D/g, "");
}

function sanitizeSessionId(sessionId) {
    return String(sessionId || "")
        .replace(/[^a-zA-Z0-9_-]/g, "_");
}

function getAuthPath(sessionId) {
    return path.join(
        USERS_AUTH_DIR,
        sanitizeSessionId(sessionId)
    );
}

function getLogFile(sessionId) {
    return path.join(
        LOG_DIR,
        `${sanitizeSessionId(sessionId)}.log`
    );
}

function ensureFile(file, fallback) {
    if (!fs.existsSync(file)) {
        fs.writeFileSync(
            file,
            fallback
        );
    }
}

/*
============================================================
 LOCAL DATABASE
============================================================
*/

function readLocalDatabase() {
    ensureFile(
        LOCAL_DB,
        "{}"
    );

    try {
        const data =
            fs.readFileSync(
                LOCAL_DB,
                "utf8"
            );

        return JSON.parse(data);
    } catch {
        return {};
    }
}

function writeLocalDatabase(data) {
    fs.writeFileSync(
        LOCAL_DB,
        JSON.stringify(
            data,
            null,
            2
        )
    );
}

function readLegacyDatabase() {
    ensureFile(
        LOCAL_MULTI_DB,
        "{}"
    );

    try {
        return JSON.parse(
            fs.readFileSync(
                LOCAL_MULTI_DB,
                "utf8"
            )
        );
    } catch {
        return {};
    }
}

/*
============================================================
 LOGGING
============================================================
*/

function addLog(
    sessionId,
    message
) {
    const text =
        `[${new Date().toISOString()}] ${message}`;

    console.log(
        `[${sessionId}] ${message}`
    );

    if (!deploymentLogs.has(sessionId)) {
        deploymentLogs.set(
            sessionId,
            []
        );
    }

    const list =
        deploymentLogs.get(sessionId);

    list.push(text);

    if (list.length > 300) {
        list.splice(
            0,
            list.length - 300
        );
    }

    try {
        fs.appendFileSync(
            getLogFile(sessionId),
            text + "\n"
        );
    } catch {}
}

function getLogs(sessionId) {
    const memory =
        deploymentLogs.get(sessionId);

    if (memory) {
        return [...memory];
    }

    try {
        if (
            fs.existsSync(
                getLogFile(sessionId)
            )
        ) {
            return fs
                .readFileSync(
                    getLogFile(sessionId),
                    "utf8"
                )
                .split("\n")
                .filter(Boolean)
                .slice(-300);
        }
    } catch {}

    return [];
}

/*
============================================================
 DEPLOYMENT SCHEMA
============================================================
*/

const deploymentSchema =
    new mongoose.Schema(
        {
            sessionId: {
                type: String,
                unique: true,
                index: true
            },

            userId: {
                type: String,
                index: true
            },

            phone: String,

            pairId: String,

            status: {
                type: String,
                default: "created"
            },

            connected: {
                type: Boolean,
                default: false
            },

            mode: {
                type: String,
                default: "public"
            },

            days: Number,

            expireAt: Date,

            authFolder: String,

            pairingCode: String,

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
            },

            createdAt: {
                type: Date,
                default: Date.now
            },

            lastSeen: Date
        },
        {
            minimize: false
        }
    );

const Deployment =
    mongoose.models.ETIASDeployment ||
    mongoose.model(
        "ETIASDeployment",
        deploymentSchema
    );

/*
============================================================
 MONGODB
============================================================
*/

let mongoReady = false;

async function connectMongo() {
    if (!MONGO_URI) {
        addLog(
            "SYSTEM",
            "MongoDB URI not configured. Using local database."
        );

        return false;
    }

    try {
        if (
            mongoose.connection.readyState === 1
        ) {
            mongoReady = true;
            return true;
        }

        await mongoose.connect(
            MONGO_URI,
            {
                serverSelectionTimeoutMS: 10000
            }
        );

        mongoReady = true;

        console.log(
            "[MONGO] ✅ Connected"
        );

        return true;
    } catch (error) {
        mongoReady = false;

        console.error(
            "[MONGO] ❌",
            error.message
        );

        return false;
    }
}

/*
============================================================
 SAVE DEPLOYMENT
============================================================
*/

async function updateSession(
    session
) {
    const data = {
        sessionId:
            session.sessionId,

        userId:
            session.userId || null,

        phone:
            session.phone,

        pairId:
            session.pairId,

        status:
            session.status,

        connected:
            !!session.connected,

        mode:
            session.mode,

        days:
            session.days,

        expireAt:
            session.expireAt,

        authFolder:
            session.authFolder,

        pairingCode:
            session.pairingCode ||
            null,

        reconnects:
            session.reconnects || 0,

        messages:
            session.messages || 0,

        commandCount:
            session.commandCount || 0,

        createdAt:
            session.createdAt,

        lastSeen:
            session.lastSeen ||
            null
    };

    /*
     * Mongo
     */

    if (mongoReady) {
        try {
            await Deployment.findOneAndUpdate(
                {
                    sessionId:
                        session.sessionId
                },
                data,
                {
                    upsert: true,
                    new: true
                }
            );
        } catch (error) {
            addLog(
                session.sessionId,
                `Mongo save failed: ${error.message}`
            );
        }
    }

    /*
     * Local
     */

    try {
        const db =
            readLocalDatabase();

        db[
            session.sessionId
        ] = data;

        writeLocalDatabase(db);
    } catch (error) {
        addLog(
            session.sessionId,
            `Local save failed: ${error.message}`
        );
    }
}

/*
============================================================
 REMOVE DEPLOYMENT
============================================================
*/

async function removeDeployment(
    sessionId
) {
    if (mongoReady) {
        try {
            await Deployment.deleteOne({
                sessionId
            });
        } catch {}
    }

    try {
        const db =
            readLocalDatabase();

        delete db[sessionId];

        writeLocalDatabase(db);
    } catch {}
}

/*
============================================================
 GET DEPLOYMENT
============================================================
*/

async function findDeployment(
    sessionId
) {
    if (sessions.has(sessionId)) {
        return sessions.get(
            sessionId
        );
    }

    if (mongoReady) {
        try {
            const found =
                await Deployment.findOne({
                    sessionId
                }).lean();

            if (found) {
                return found;
            }
        } catch {}
    }

    try {
        const db =
            readLocalDatabase();

        return db[sessionId] ||
            null;
    } catch {
        return null;
    }
}

/*
============================================================
 GET ALL DEPLOYMENTS
============================================================
*/

async function getAllDeployments() {
    const result = [];

    for (
        const session of
        sessions.values()
    ) {
        result.push(
            sessionSummary(session)
        );
    }

    if (result.length > 0) {
        return result;
    }

    if (mongoReady) {
        try {
            return await Deployment
                .find({})
                .lean();
        } catch {}
    }

    const db =
        readLocalDatabase();

    return Object.values(db);
}

/*
============================================================
 SESSION SUMMARY
============================================================
*/

function sessionSummary(
    session
) {
    return {
        sessionId:
            session.sessionId,

        userId:
            session.userId ||
            null,

        phone:
            session.phone,

        pairId:
            session.pairId,

        status:
            session.status,

        connected:
            !!session.connected,

        mode:
            session.mode,

        days:
            session.days,

        expireAt:
            session.expireAt,

        createdAt:
            session.createdAt,

        lastSeen:
            session.lastSeen,

        reconnects:
            session.reconnects,

        messages:
            session.messages,

        commandCount:
            session.commandCount,

        pairingCode:
            session.pairingCode ||
            null
    };
}

/*
============================================================
 CREATE SESSION
============================================================
*/

function createSession(
    options = {}
) {
    const phone =
        normalizeNumber(
            options.phone
        );

    const sessionId =
        options.sessionId ||
        generateSessionId();

    const days =
        Number(
            options.days ||
            DEFAULT_DAYS
        );

    const createdAt =
        now();

    const expireAt =
        new Date(
            createdAt.getTime() +
            days *
                24 *
                60 *
                60 *
                1000
        );

    return {
        sessionId,

        phone,

        pairId:
            options.pairId ||
            randomId(12),

        userId:
            null,

        sock:
            null,

        status:
            "created",

        connected:
            false,

        pairingCode:
            null,

        pairingRequested:
            false,

        mode:
            options.mode ||
            MODE,

        days,

        expireAt,

        createdAt,

        lastSeen:
            null,

        reconnects:
            0,

        messages:
            0,

        commandCount:
            0,

        stopping:
            false,

        reconnectTimer:
            null,

        pairingTimer:
            null,

        authFolder:
            getAuthPath(
                sessionId
            ),

        antiLink:
            false,

        antiDelete:
            false,

        antiViewOnce:
            false
    };
}

/*
============================================================
 COMMAND LOADER
============================================================
*/

function loadCommands() {
    loadedCommands.clear();

    if (
        !fs.existsSync(
            COMMANDS_DIR
        )
    ) {
        addLog(
            "SYSTEM",
            "commands directory not found"
        );

        return;
    }

    const files =
        fs.readdirSync(
            COMMANDS_DIR
        );

    let count = 0;

    for (
        const file of files
    ) {
        if (
            !file.endsWith(".js")
        ) {
            continue;
        }

        try {
            const fullPath =
                path.join(
                    COMMANDS_DIR,
                    file
                );

            delete require.cache[
                require.resolve(
                    fullPath
                )
            ];

            const command =
                require(fullPath);

            if (
                !command ||
                typeof command !==
                    "object"
            ) {
                continue;
            }

            const names = [];

            if (
                command.name
            ) {
                names.push(
                    String(
                        command.name
                    ).toLowerCase()
                );
            }

            if (
                Array.isArray(
                    command.alias
                )
            ) {
                command.alias.forEach(
                    (alias) =>
                        names.push(
                            String(
                                alias
                            ).toLowerCase()
                        )
                );
            }

            if (
                Array.isArray(
                    command.aliases
                )
            ) {
                command.aliases.forEach(
                    (alias) =>
                        names.push(
                            String(
                                alias
                            ).toLowerCase()
                        )
                );
            }

            if (
                names.length === 0
            ) {
                continue;
            }

            for (
                const name of names
            ) {
                loadedCommands.set(
                    name,
                    command
                );
            }

            count++;
        } catch (error) {
            console.error(
                `[COMMAND] Failed ${file}:`,
                error.message
            );
        }
    }

    console.log(
        `[COMMANDS] ${count} commands loaded`
    );
}

/*
============================================================
 TEXT EXTRACTION
============================================================
*/

function getMessageText(
    message
) {
    if (!message) {
        return "";
    }

    const msg =
        message.message;

    if (!msg) {
        return "";
    }

    if (
        typeof msg.conversation ===
        "string"
    ) {
        return msg.conversation;
    }

    if (
        msg.extendedTextMessage
            ?.text
    ) {
        return msg
            .extendedTextMessage
            .text;
    }

    if (
        msg.imageMessage
            ?.caption
    ) {
        return msg
            .imageMessage
            .caption;
    }

    if (
        msg.videoMessage
            ?.caption
    ) {
        return msg
            .videoMessage
            .caption;
    }

    if (
        msg.documentMessage
            ?.caption
    ) {
        return msg
            .documentMessage
            .caption;
    }

    return "";
}

/*
============================================================
 OWNER CHECK
============================================================
*/

function isOwner(
    jid,
    session
) {
    if (
        !OWNER_NUMBER
    ) {
        return false;
    }

    const sender =
        String(jid || "")
            .split("@")[0]
            .split(":")[0]
            .replace(/\D/g, "");

    if (
        sender &&
        sender === OWNER_NUMBER
    ) {
        return true;
    }

    if (
        session?.phone &&
        sender === session.phone
    ) {
        return true;
    }

    return false;
}

/*
============================================================
 REPLY
============================================================
*/

async function reply(
    sock,
    jid,
    text,
    quoted
) {
    try {
        return await sock.sendMessage(
            jid,
            {
                text: String(text)
            },
            quoted
                ? {
                      quoted
                  }
                : undefined
        );
    } catch (error) {
        addLog(
            "SYSTEM",
            `Reply failed: ${error.message}`
        );
    }
}

/*
============================================================
 SEND SESSION ID
============================================================
*/

async function sendSessionId(
    session
) {
    if (
        !session.sock ||
        !session.userId
    ) {
        return;
    }

    try {
        const jid =
            jidNormalizedUser(
                session.userId
            );

        const text =
`╭━━━〔 ${BOT_NAME} 〕━━━╮

✅ BOT CONNECTED

📱 Number:
+${session.phone}

🆔 SESSION ID:
${session.sessionId}

📅 DAYS:
${session.days}

⏰ EXPIRES:
${session.expireAt.toISOString()}

🤖 MODE:
${session.mode}

╰━━━━━━━━━━━━━━━━╯

⚡ ${BOT_NAME}
Bringing AI to your fingertips`;

        await session.sock.sendMessage(
            jid,
            {
                text
            }
        );

        addLog(
            session.sessionId,
            "Session ID sent to WhatsApp"
        );
    } catch (error) {
        addLog(
            session.sessionId,
            `Could not send session ID: ${error.message}`
        );
    }
}

/*
============================================================
 PAIRING CODE
============================================================
*/

async function requestPairingCode(
    session
) {
    if (
        !session.sock ||
        !session.phone
    ) {
        return null;
    }

    if (
        session.pairingRequested
    ) {
        return session.pairingCode;
    }

    try {
        session.pairingRequested =
            true;

        addLog(
            session.sessionId,
            `Requesting WhatsApp pairing code for +${session.phone}`
        );

        /*
         * Baileys returns an 8-character
         * WhatsApp pairing code.
         */

        const code =
            await session.sock
                .requestPairingCode(
                    session.phone
                );

        session.pairingCode =
            String(code || "")
                .toUpperCase();

        session.status =
            "pairing";

        await updateSession(
            session
        );

        addLog(
            session.sessionId,
            `🔐 PAIRING CODE: ${session.pairingCode}`
        );

        console.log("");
        console.log(
            "=========================================="
        );
        console.log(
            ` ${BOT_NAME} PAIRING CODE`
        );
        console.log(
            "=========================================="
        );
        console.log(
            ` PHONE : +${session.phone}`
        );
        console.log(
            ` CODE  : ${session.pairingCode}`
        );
        console.log(
            ` SID   : ${session.sessionId}`
        );
        console.log(
            "=========================================="
        );
        console.log("");

        return session.pairingCode;
    } catch (error) {
        session.pairingRequested =
            false;

        session.status =
            "pairing_error";

        addLog(
            session.sessionId,
            `Pairing code failed: ${error.message}`
        );

        return null;
    }
}

/*
============================================================
 MESSAGE PROCESSING
============================================================
*/

async function processMessage(
    session,
    message
) {
    if (
        !session.sock ||
        !message
    ) {
        return;
    }

    if (
        message.key?.fromMe
    ) {
        return;
    }

    const remoteJid =
        message.key?.remoteJid;

    if (!remoteJid) {
        return;
    }

    const text =
        getMessageText(
            message
        ).trim();

    if (!text) {
        return;
    }

    session.messages++;
    session.lastSeen =
        now();

    await updateSession(
        session
    );

    /*
     * Anti-link
     */

    if (
        session.antiLink &&
        /https?:\/\/|www\./i.test(text) &&
        remoteJid.endsWith("@g.us")
    ) {
        try {
            await session.sock.sendMessage(
                remoteJid,
                {
                    delete:
                        message.key
                }
            );
        } catch {}

        return;
    }

    if (
        !text.startsWith(PREFIX)
    ) {
        return;
    }

    const body =
        text.slice(
            PREFIX.length
        ).trim();

    if (!body) {
        return;
    }

    const parts =
        body.split(/\s+/);

    const commandName =
        String(
            parts.shift() ||
            ""
        ).toLowerCase();

    const args =
        parts;

    const argText =
        args.join(" ");

    const owner =
        isOwner(
            message.key?.participant ||
            message.key?.remoteJid,
            session
        );

    /*
     * Built-in commands
     */

    if (
        commandName === "ping"
    ) {
        await reply(
            session.sock,
            remoteJid,
            `🏓 ${BOT_NAME} online!\n\n⏱ ${Math.floor(process.uptime())} seconds`
        );

        return;
    }

    if (
        commandName === "alive"
    ) {
        await reply(
            session.sock,
            remoteJid,
`╭━━━〔 ${BOT_NAME} 〕━━━╮

✅ ONLINE

📱 +${session.phone}

🆔 ${session.sessionId}

⏰ ${session.expireAt.toISOString()}

⚡ Bringing AI to your fingertips

╰━━━━━━━━━━━━━━━━╯`
        );

        return;
    }

    if (
        commandName === "session"
    ) {
        if (!owner) {
            return;
        }

        await reply(
            session.sock,
            remoteJid,
`🆔 SESSION ID

${session.sessionId}

📱 +${session.phone}

⏰ ${session.expireAt.toISOString()}`
        );

        return;
    }

    if (
        commandName === "status"
    ) {
        await reply(
            session.sock,
            remoteJid,
`🤖 ${BOT_NAME}

Status: ${
    session.connected
        ? "ONLINE"
        : "OFFLINE"
}

Mode: ${session.mode}

Messages: ${session.messages}

Commands: ${session.commandCount}

Reconnects: ${session.reconnects}`
        );

        return;
    }

    if (
        commandName === "mode"
    ) {
        if (!owner) {
            return;
        }

        const newMode =
            String(
                args[0] ||
                ""
            ).toLowerCase();

        if (
            ![
                "public",
                "private"
            ].includes(newMode)
        ) {
            await reply(
                session.sock,
                remoteJid,
                `Usage: ${PREFIX}mode public\nor\n${PREFIX}mode private`
            );

            return;
        }

        session.mode =
            newMode;

        await updateSession(
            session
        );

        await reply(
            session.sock,
            remoteJid,
            `✅ Mode changed to ${newMode}`
        );

        return;
    }

    if (
        commandName === "antilink"
    ) {
        if (!owner) {
            return;
        }

        const state =
            String(
                args[0] ||
                ""
            ).toLowerCase();

        session.antiLink =
            state === "on";

        await reply(
            session.sock,
            remoteJid,
            `🔗 Anti-link: ${
                session.antiLink
                    ? "ON"
                    : "OFF"
            }`
        );

        return;
    }

    if (
        commandName === "antidelete"
    ) {
        if (!owner) {
            return;
        }

        const state =
            String(
                args[0] ||
                ""
            ).toLowerCase();

        session.antiDelete =
            state === "on";

        await reply(
            session.sock,
            remoteJid,
            `🗑️ Anti-delete: ${
                session.antiDelete
                    ? "ON"
                    : "OFF"
            }`
        );

        return;
    }

    if (
        commandName === "viewonce"
    ) {
        if (!owner) {
            return;
        }

        session.antiViewOnce =
            true;

        await reply(
            session.sock,
            remoteJid,
            "👁️ View-once handling enabled."
        );

        return;
    }

    /*
     * Help
     */

    if (
        commandName === "menu" ||
        commandName === "help"
    ) {
        await reply(
            session.sock,
            remoteJid,
`╭━━━〔 ${BOT_NAME} 〕━━━╮

📌 COMMAND MENU

${PREFIX}ping
${PREFIX}alive
${PREFIX}status
${PREFIX}session
${PREFIX}menu

OWNER

${PREFIX}mode public
${PREFIX}mode private
${PREFIX}antilink on
${PREFIX}antilink off
${PREFIX}antidelete on
${PREFIX}antidelete off

╰━━━━━━━━━━━━━━━━╯`
        );

        return;
    }

    /*
     * Private mode
     */

    if (
        session.mode ===
            "private" &&
        !owner
    ) {
        return;
    }

    /*
     * External commands
     */

    const command =
        loadedCommands.get(
            commandName
        );

    if (!command) {
        return;
    }

    session.commandCount++;

    await updateSession(
        session
    );

    const context = {
        sock:
            session.sock,

        client:
            session.sock,

        session,

        message,

        msg:
            message,

        jid:
            remoteJid,

        args,

        text:
            argText,

        body,

        command:
            commandName,

        prefix:
            PREFIX,

        commandPrefix:
            PREFIX,

        sessionId:
            session.sessionId,

        botName:
            BOT_NAME,

        isOwner:
            owner,

        owner,

        reply: async (
            response
        ) =>
            reply(
                session.sock,
                remoteJid,
                response,
                message
            )
    };

    try {
        if (
            typeof command.execute ===
            "function"
        ) {
            await command.execute(
                context
            );

            return;
        }

        if (
            typeof command.run ===
            "function"
        ) {
            await command.run(
                context
            );

            return;
        }

        if (
            typeof command.handler ===
            "function"
        ) {
            await command.handler(
                context
            );

            return;
        }

        if (
            typeof command ===
            "function"
        ) {
            await command(
                context
            );
        }
    } catch (error) {
        addLog(
            session.sessionId,
            `Command ${commandName} failed: ${error.message}`
        );

        await reply(
            session.sock,
            remoteJid,
            `❌ Command error: ${error.message}`
        );
    }
}

/*
============================================================
 CONNECTION UPDATE
============================================================
*/

async function handleConnectionUpdate(
    session,
    update
) {
    const {
        connection,
        lastDisconnect
    } = update;

    if (
        connection === "connecting"
    ) {
        session.status =
            "connecting";

        await updateSession(
            session
        );

        addLog(
            session.sessionId,
            "🔄 Connecting to WhatsApp..."
        );
    }

    if (
        connection === "open"
    ) {
        session.connected =
            true;

        session.status =
            "online";

        session.lastSeen =
            now();

        session.userId =
            session.sock?.user?.id ||
            session.userId;

        session.pairingCode =
            null;

        session.pairingRequested =
            true;

        await updateSession(
            session
        );

        addLog(
            session.sessionId,
            "✅ WhatsApp connection OPEN"
        );

        addLog(
            session.sessionId,
            `👤 Logged in as ${session.userId || "unknown"}`
        );

        await sendSessionId(
            session
        );

        return;
    }

    if (
        connection === "close"
    ) {
        session.connected =
            false;

        session.status =
            "offline";

        await updateSession(
            session
        );

        let statusCode =
            null;

        try {
            statusCode =
                lastDisconnect
                    ?.error
                    ?.output
                    ?.statusCode;
        } catch {}

        addLog(
            session.sessionId,
            `❌ WhatsApp connection closed. Code: ${statusCode || "unknown"}`
        );

        const loggedOut =
            statusCode ===
            DisconnectReason.loggedOut;

        const badSession =
            statusCode ===
            DisconnectReason.badSession;

        const connectionReplaced =
            statusCode ===
            DisconnectReason.connectionReplaced;

        const restartRequired =
            statusCode ===
            DisconnectReason.restartRequired;

        if (
            session.stopping ||
            loggedOut ||
            badSession ||
            connectionReplaced
        ) {
            session.status =
                "stopped";

            await updateSession(
                session
            );

            addLog(
                session.sessionId,
                "🛑 Session will not automatically reconnect."
            );

            return;
        }

        /*
         * Reconnect
         */

        if (
            session.reconnectTimer
        ) {
            clearTimeout(
                session.reconnectTimer
            );
        }

        session.reconnects++;

        const delay =
            restartRequired
                ? 1000
                : 5000;

        addLog(
            session.sessionId,
            `♻️ Reconnecting in ${delay / 1000}s...`
        );

        session.reconnectTimer =
            setTimeout(
                async () => {
                    try {
                        session.sock =
                            null;

                        session.pairingRequested =
                            false;

                        await connectSession(
                            session
                        );
                    } catch (error) {
                        addLog(
                            session.sessionId,
                            `Reconnect failed: ${error.message}`
                        );
                    }
                },
                delay
            );
    }
}

/*
============================================================
 CREATE SOCKET
============================================================
*/

async function connectSession(
    session
) {
    if (!session) {
        throw new Error(
            "Session is required"
        );
    }

    if (
        session.stopping
    ) {
        return session;
    }

    if (
        session.expireAt &&
        new Date() >
            new Date(
                session.expireAt
            )
    ) {
        session.status =
            "expired";

        await updateSession(
            session
        );

        addLog(
            session.sessionId,
            "⏰ Session expired"
        );

        return session;
    }

    if (
        session.sock
    ) {
        try {
            if (
                session.connected
            ) {
                return session;
            }
        } catch {}
    }

    /*
     * Auth directory
     */

    if (
        !fs.existsSync(
            session.authFolder
        )
    ) {
        fs.mkdirSync(
            session.authFolder,
            {
                recursive: true
            }
        );
    }

    addLog(
        session.sessionId,
        `Auth folder: ${session.authFolder}`
    );

    /*
     * Multi-file authentication
     */

    const {
        state,
        saveCreds
    } =
        await useMultiFileAuthState(
            session.authFolder
        );

    /*
     * Create socket
     */

    const sock =
        makeWASocket({
            auth: state,

            logger,

            browser:
                Browsers.macOS(
                    "Chrome"
                ),

            printQRInTerminal:
                false,

            markOnlineOnConnect:
                false,

            syncFullHistory:
                false,

            generateHighQualityLinkPreview:
                false,

            connectTimeoutMs:
                60000,

            defaultQueryTimeoutMs:
                60000,

            keepAliveIntervalMs:
                30000,

            retryRequestDelayMs:
                2000
        });

    session.sock =
        sock;

    /*
     * Credentials
     */

    sock.ev.on(
        "creds.update",
        async () => {
            try {
                await saveCreds();
            } catch (error) {
                addLog(
                    session.sessionId,
                    `Credential save failed: ${error.message}`
                );
            }
        }
    );

    /*
     * Connection
     */

    sock.ev.on(
        "connection.update",
        async (update) => {
            try {
                await handleConnectionUpdate(
                    session,
                    update
                );
            } catch (error) {
                addLog(
                    session.sessionId,
                    `Connection handler error: ${error.message}`
                );
            }
        }
    );

    /*
     * Messages
     */

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
                const message of
                messages || []
            ) {
                try {
                    await processMessage(
                        session,
                        message
                    );
                } catch (error) {
                    addLog(
                        session.sessionId,
                        `Message handler error: ${error.message}`
                    );
                }
            }
        }
    );

    /*
     * Message updates
     */

    sock.ev.on(
        "messages.update",
        async (updates) => {
            if (
                !session.antiDelete
            ) {
                return;
            }

            for (
                const item of
                updates || []
            ) {
                if (
                    item.update
                        ?.message ===
                    null
                ) {
                    addLog(
                        session.sessionId,
                        "🗑️ A message was deleted"
                    );
                }
            }
        }
    );

    /*
     * Group participants
     */

    sock.ev.on(
        "group-participants.update",
        async (update) => {
            try {
                addLog(
                    session.sessionId,
                    `Group event: ${update.action}`
                );
            } catch {}
        }
    );

    /*
     * Pairing code
     *
     * Only request it when there
     * are no registered credentials.
     */

    if (
        !state.creds.registered &&
        session.phone
    ) {
        /*
         * Give the socket time to
         * initialize before requesting.
         */

        if (
            session.pairingTimer
        ) {
            clearTimeout(
                session.pairingTimer
            );
        }

        session.pairingTimer =
            setTimeout(
                async () => {
                    try {
                        await requestPairingCode(
                            session
                        );
                    } catch (error) {
                        addLog(
                            session.sessionId,
                            `Pairing request error: ${error.message}`
                        );
                    }
                },
                2500
            );
    } else {
        addLog(
            session.sessionId,
            "Existing credentials found. Skipping pairing code."
        );
    }

    session.status =
        "connecting";

    await updateSession(
        session
    );

    return session;
}

/*
============================================================
 DEPLOY SESSION
============================================================
*/

async function deploySession(
    options = {}
) {
    const phone =
        normalizeNumber(
            options.phone
        );

    if (!phone) {
        throw new Error(
            "Phone number is required"
        );
    }

    if (
        phone.length < 8 ||
        phone.length > 15
    ) {
        throw new Error(
            "Invalid phone number"
        );
    }

    /*
     * Prevent duplicate deployment
     * for the same active number.
     */

    for (
        const existing of
        sessions.values()
    ) {
        if (
            existing.phone === phone &&
            !existing.stopping
        ) {
            return {
                success: true,
                existing: true,
                ...sessionSummary(
                    existing
                ),
                code:
                    existing.pairingCode ||
                    null
            };
        }
    }

    const sessionId =
        options.sessionId ||
        generateSessionId();

    const session =
        createSession({
            sessionId,

            phone,

            days:
                options.days ||
                DEFAULT_DAYS,

            mode:
                options.mode ||
                MODE,

            pairId:
                options.pairId ||
                randomId(12)
        });

    sessions.set(
        sessionId,
        session
    );

    addLog(
        sessionId,
        `🚀 Deployment created for +${phone}`
    );

    await updateSession(
        session
    );

    try {
        await connectSession(
            session
        );
    } catch (error) {
        session.status =
            "error";

        await updateSession(
            session
        );

        addLog(
            sessionId,
            `❌ Deployment failed: ${error.message}`
        );

        throw error;
    }

    /*
     * Wait briefly so the pairing
     * code has time to appear.
     */

    await new Promise(
        (resolve) =>
            setTimeout(
                resolve,
                3500
            )
    );

    return {
        success: true,

        existing: false,

        sessionId:
            session.sessionId,

        phone:
            session.phone,

        pairId:
            session.pairId,

        code:
            session.pairingCode ||
            null,

        status:
            session.status,

        connected:
            session.connected,

        expireAt:
            session.expireAt
    };
}

/*
============================================================
 STOP SESSION
============================================================
*/

async function stopSession(
    sessionId
) {
    const session =
        sessions.get(
            sessionId
        );

    if (!session) {
        throw new Error(
            "Session not found"
        );
    }

    session.stopping =
        true;

    session.status =
        "stopping";

    if (
        session.reconnectTimer
    ) {
        clearTimeout(
            session.reconnectTimer
        );
    }

    if (
        session.pairingTimer
    ) {
        clearTimeout(
            session.pairingTimer
        );
    }

    try {
        if (
            session.sock
        ) {
            try {
                session.sock.end(
                    undefined
                );
            } catch {}
        }
    } catch {}

    session.sock =
        null;

    session.connected =
        false;

    session.status =
        "stopped";

    await updateSession(
        session
    );

    addLog(
        sessionId,
        "🛑 Session stopped"
    );

    return sessionSummary(
        session
    );
}

/*
============================================================
 RESTART SESSION
============================================================
*/

async function restartSession(
    sessionId
) {
    let session =
        sessions.get(
            sessionId
        );

    if (!session) {
        const saved =
            await findDeployment(
                sessionId
            );

        if (!saved) {
            throw new Error(
                "Session not found"
            );
        }

        session =
            createSession({
                sessionId:
                    saved.sessionId,

                phone:
                    saved.phone,

                days:
                    saved.days,

                mode:
                    saved.mode,

                pairId:
                    saved.pairId
            });

        sessions.set(
            sessionId,
            session
        );
    }

    session.stopping =
        false;

    session.connected =
        false;

    session.pairingRequested =
        false;

    session.pairingCode =
        null;

    session.status =
        "restarting";

    addLog(
        sessionId,
        "♻️ Restarting session..."
    );

    await updateSession(
        session
    );

    await connectSession(
        session
    );

    return sessionSummary(
        session
    );
}

/*
============================================================
 REMOVE SESSION
============================================================
*/

async function removeSession(
    sessionId
) {
    const session =
        sessions.get(
            sessionId
        );

    if (session) {
        session.stopping =
            true;

        if (
            session.reconnectTimer
        ) {
            clearTimeout(
                session.reconnectTimer
            );
        }

        if (
            session.pairingTimer
        ) {
            clearTimeout(
                session.pairingTimer
            );
        }

        try {
            session.sock?.end(
                undefined
            );
        } catch {}

        sessions.delete(
            sessionId
        );
    }

    await removeDeployment(
        sessionId
    );

    /*
     * Delete auth folder
     */

    try {
        const authPath =
            getAuthPath(
                sessionId
            );

        if (
            fs.existsSync(
                authPath
            )
        ) {
            fs.rmSync(
                authPath,
                {
                    recursive: true,
                    force: true
                }
            );
        }
    } catch {}

    addLog(
        sessionId,
        "🗑️ Session removed"
    );

    return {
        success: true,
        sessionId
    };
}

/*
============================================================
 RESTORE SESSIONS
============================================================
*/

async function restoreSessions() {
    let deployments = [];

    /*
     * Mongo
     */

    if (mongoReady) {
        try {
            deployments =
                await Deployment
                    .find({})
                    .lean();
        } catch {}
    }

    /*
     * Local fallback
     */

    if (
        deployments.length === 0
    ) {
        const db =
            readLocalDatabase();

        deployments =
            Object.values(db);
    }

    /*
     * Legacy database
     */

    if (
        deployments.length === 0
    ) {
        const legacy =
            readLegacyDatabase();

        for (
            const [userId, value]
            of Object.entries(
                legacy
            )
        ) {
            if (
                typeof value ===
                "string"
            ) {
                deployments.push({
                    sessionId:
                        value,
                    phone:
                        userId,
                    userId
                });
            } else if (
                value &&
                value.sessionId
            ) {
                deployments.push({
                    ...value,
                    userId
                });
            }
        }
    }

    if (
        deployments.length === 0
    ) {
        console.log(
            "[RESTORE] No saved sessions"
        );

        return;
    }

    console.log(
        `[RESTORE] ${deployments.length} saved sessions found`
    );

    for (
        const saved of
        deployments
    ) {
        try {
            if (
                !saved.sessionId
            ) {
                continue;
            }

            /*
             * Do not restore expired
             * sessions.
             */

            if (
                saved.expireAt &&
                new Date() >
                    new Date(
                        saved.expireAt
                    )
            ) {
                addLog(
                    saved.sessionId,
                    "Skipping expired session"
                );

                continue;
            }

            /*
             * Phone can sometimes be
             * missing from older records.
             */

            const phone =
                normalizeNumber(
                    saved.phone ||
                    saved.userId ||
                    ""
                );

            if (!phone) {
                addLog(
                    saved.sessionId,
                    "Skipping session: phone unavailable"
                );

                continue;
            }

            const session =
                createSession({
                    sessionId:
                        saved.sessionId,

                    phone,

                    days:
                        saved.days ||
                        DEFAULT_DAYS,

                    mode:
                        saved.mode ||
                        MODE,

                    pairId:
                        saved.pairId ||
                        randomId(12)
                });

            session.userId =
                saved.userId ||
                null;

            session.reconnects =
                saved.reconnects ||
                0;

            session.messages =
                saved.messages ||
                0;

            session.commandCount =
                saved.commandCount ||
                0;

            session.createdAt =
                saved.createdAt
                    ? new Date(
                          saved.createdAt
                      )
                    : session.createdAt;

            session.expireAt =
                saved.expireAt
                    ? new Date(
                          saved.expireAt
                      )
                    : session.expireAt;

            sessions.set(
                session.sessionId,
                session
            );

            addLog(
                session.sessionId,
                "♻️ Restoring saved session..."
            );

            await connectSession(
                session
            );

            /*
             * Small delay between
             * multiple connections.
             */

            await new Promise(
                (resolve) =>
                    setTimeout(
                        resolve,
                        1000
                    )
            );
        } catch (error) {
            console.error(
                `[RESTORE] Failed ${saved.sessionId}:`,
                error.message
            );
        }
    }
}

/*
============================================================
 EXPIRATION CHECKER
============================================================
*/

async function checkExpirations() {
    const current =
        Date.now();

    for (
        const session of
        sessions.values()
    ) {
        if (
            !session.expireAt
        ) {
            continue;
        }

        if (
            current >=
            new Date(
                session.expireAt
            ).getTime()
        ) {
            addLog(
                session.sessionId,
                "⏰ Session expired. Stopping bot."
            );

            try {
                await stopSession(
                    session.sessionId
                );
            } catch {}
        }
    }
}

/*
============================================================
 MANAGER
============================================================
*/

const botManager = {
    deploy:
        deploySession,

    deploySession:
        deploySession,

    getSession:
        (sessionId) => {
            const session =
                sessions.get(
                    sessionId
                );

            return session
                ? sessionSummary(
                      session
                  )
                : null;
        },

    getSessions:
        () => {
            return Array.from(
                sessions.values()
            ).map(
                sessionSummary
            );
        },

    getLogs:
        getLogs,

    stop:
        stopSession,

    restart:
        restartSession,

    remove:
        removeSession,

    stats:
        () => ({
            total:
                sessions.size,

            online:
                Array.from(
                    sessions.values()
                ).filter(
                    (s) =>
                        s.connected
                ).length,

            pairing:
                Array.from(
                    sessions.values()
                ).filter(
                    (s) =>
                        s.status ===
                        "pairing"
                ).length
        })
};

/*
============================================================
 GLOBAL MANAGER
============================================================
*/

global.ETIAS_BOT_MANAGER =
    botManager;

/*
============================================================
 SERVER
============================================================
*/

let serverStarted =
    false;

async function startServer() {
    if (
        serverStarted
    ) {
        return;
    }

    serverStarted =
        true;

    try {
        const serverModule =
            require("./server.js");

        if (
            serverModule &&
            typeof serverModule.startServer ===
                "function"
        ) {
            await serverModule.startServer();

            return;
        }

        if (
            serverModule &&
            typeof serverModule.listen ===
                "function"
        ) {
            await new Promise(
                (resolve) => {
                    serverModule.listen(
                        PORT,
                        () => {
                            console.log(
                                `[SERVER] Running on port ${PORT}`
                            );

                            resolve();
                        }
                    );
                }
            );

            return;
        }

        console.log(
            "[SERVER] server.js loaded"
        );
    } catch (error) {
        serverStarted =
            false;

        console.error(
            "[SERVER] Failed:",
            error.message
        );

        throw error;
    }
}

/*
============================================================
 HEARTBEAT
============================================================
*/

function startHeartbeat() {
    setInterval(
        async () => {
            for (
                const session of
                sessions.values()
            ) {
                if (
                    session.connected
                ) {
                    session.lastSeen =
                        now();

                    try {
                        await updateSession(
                            session
                        );
                    } catch {}
                }
            }
        },
        60000
    );
}

/*
============================================================
 STARTUP
============================================================
*/

async function start() {
    console.log("");
    console.log(
        "=============================================="
    );
    console.log(
        `       ${BOT_NAME}`
    );
    console.log(
        "       MULTI SESSION ENGINE"
    );
    console.log(
        "=============================================="
    );
    console.log(
        `Node: ${process.version}`
    );
    console.log(
        `Platform: ${process.platform}`
    );
    console.log(
        `Port: ${PORT}`
    );
    console.log(
        `Prefix: ${PREFIX}`
    );
    console.log(
        "=============================================="
    );
    console.log("");

    /*
     * Mongo
     */

    await connectMongo();

    /*
     * Commands
     */

    loadCommands();

    /*
     * Server
     */

    await startServer();

    /*
     * Restore
     */

    await restoreSessions();

    /*
     * Expiration checker
     */

    setInterval(
        () => {
            checkExpirations()
                .catch(() => {});
        },
        60000
    );

    /*
     * Heartbeat
     */

    startHeartbeat();

    console.log("");
    console.log(
        `[BOT] ${BOT_NAME} is ready`
    );

    console.log(
        `[BOT] Active sessions: ${sessions.size}`
    );

    console.log("");
}

/*
============================================================
 GRACEFUL SHUTDOWN
============================================================
*/

let shuttingDown =
    false;

async function shutdown(
    signal
) {
    if (
        shuttingDown
    ) {
        return;
    }

    shuttingDown =
        true;

    console.log(
        `\n[SHUTDOWN] ${signal}`
    );

    for (
        const session of
        sessions.values()
    ) {
        try {
            session.stopping =
                true;

            if (
                session.reconnectTimer
            ) {
                clearTimeout(
                    session.reconnectTimer
                );
            }

            if (
                session.pairingTimer
            ) {
                clearTimeout(
                    session.pairingTimer
                );
            }

            if (
                session.sock
            ) {
                session.sock.end(
                    undefined
                );
            }
        } catch {}
    }

    try {
        if (
            mongoose.connection
                .readyState === 1
        ) {
            await mongoose.connection.close();
        }
    } catch {}

    process.exit(0);
}

process.on(
    "SIGINT",
    () =>
        shutdown("SIGINT")
);

process.on(
    "SIGTERM",
    () =>
        shutdown("SIGTERM")
);

/*
============================================================
 PROCESS ERRORS
============================================================
*/

process.on(
    "uncaughtException",
    (error) => {
        console.error(
            "[FATAL]",
            error
        );
    }
);

process.on(
    "unhandledRejection",
    (error) => {
        console.error(
            "[PROMISE]",
            error
        );
    }
);

/*
============================================================
 EXPORTS
============================================================
*/

module.exports = {
    botManager,

    Deployment,

    sessions,

    connectMongo,

    connectSession,

    deploySession,

    stopSession,

    restartSession,

    removeSession,

    getAllDeployments,

    findDeployment,

    getLogs,

    addLog,

    generateSessionId
};

/*
============================================================
 RUN
============================================================
*/

if (
    require.main ===
    module
) {
    start().catch(
        (error) => {
            console.error(
                "[STARTUP ERROR]",
                error
            );

            process.exit(1);
        }
    );
}
