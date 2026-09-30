"use strict";

/*
============================================================
 ETIAS-MINI-BOT
 MAIN BOT MANAGER
============================================================

 IMPORTANT ARCHITECTURE

 1. Pairing server handles WhatsApp pairing.
 2. Pairing server generates:
       ETIAS-MINI-BOT~12345678
 3. User submits that Session ID to the deployment dashboard.
 4. The deployment server calls this manager.
 5. This file NEVER generates a WhatsApp pairing code.
 6. This file connects using existing Baileys auth files.

============================================================
*/

require("dotenv").config();

const fs = require("fs");
const fsp = fs.promises;
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

const app = require("./server");

/* ============================================================
   CONFIG
============================================================ */

const PORT = Number(process.env.PORT || 3000);

const ROOT = __dirname;

const AUTH_DIR = path.join(ROOT, "auth");
const USERS_AUTH_DIR = path.join(AUTH_DIR, "users");

const DATA_DIR = path.join(ROOT, "data");
const LOG_DIR = path.join(ROOT, "logs");
const COMMANDS_DIR = path.join(ROOT, "commands");
const MEDIA_DIR = path.join(ROOT, "media");

const DEPLOYED_FILE = path.join(DATA_DIR, "deployed.json");
const MULTI_SESSION_FILE = path.join(DATA_DIR, "multi_sessions.json");

const SESSION_PREFIX = "ETIAS-MINI-BOT~";

const DEFAULT_DAYS = Number(process.env.DEFAULT_DAYS || 30);

const MONGO_URI =
    process.env.MONGO_URI ||
    process.env.MONGODB_URI ||
    "";

/* ============================================================
   DIRECTORIES
============================================================ */

const requiredDirs = [
    AUTH_DIR,
    USERS_AUTH_DIR,
    DATA_DIR,
    LOG_DIR,
    COMMANDS_DIR,
    MEDIA_DIR
];

for (const dir of requiredDirs) {
    fs.mkdirSync(dir, {
        recursive: true
    });
}

/* ============================================================
   LOGGER
============================================================ */

const logger = pino({
    level: process.env.LOG_LEVEL || "info"
});

/* ============================================================
   RUNTIME STATE
============================================================ */

const sessions = new Map();
const deploymentLogs = new Map();
const reconnecting = new Set();

let loadedCommands = new Map();

/* ============================================================
   MONGOOSE SCHEMA
============================================================ */

const DeploymentSchema = new mongoose.Schema(
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

        phone: {
            type: String,
            index: true
        },

        pairId: {
            type: String,
            index: true
        },

        status: {
            type: String,
            default: "deployed"
        },

        connected: {
            type: Boolean,
            default: false
        },

        mode: {
            type: String,
            default: "public"
        },

        days: {
            type: Number,
            default: DEFAULT_DAYS
        },

        expireAt: {
            type: Date
        },

        authFolder: {
            type: String
        },

        pairingCode: {
            type: String,
            default: null
        },

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

        lastSeen: {
            type: Date
        }
    },
    {
        timestamps: true
    }
);

let Deployment;

try {
    Deployment =
        mongoose.models.Deployment ||
        mongoose.model("Deployment", DeploymentSchema);
} catch (err) {
    logger.error({
        err
    }, "Failed to initialize Deployment model");
}

/* ============================================================
   DATABASE
============================================================ */

async function connectMongo() {
    if (!MONGO_URI) {
        logger.warn(
            "MONGO_URI/MONGODB_URI not configured. Running with local storage only."
        );
        return;
    }

    try {
        await mongoose.connect(MONGO_URI);

        logger.info("MongoDB Connected");

    } catch (err) {
        logger.error({
            err: err.message
        }, "MongoDB connection failed");
    }
}

/* ============================================================
   LOCAL JSON HELPERS
============================================================ */

async function ensureJsonFile(file, fallback) {
    try {
        await fsp.access(file);
    } catch {
        await fsp.writeFile(
            file,
            JSON.stringify(fallback, null, 2)
        );
    }
}

async function readJson(file, fallback = []) {
    try {
        const raw = await fsp.readFile(file, "utf8");

        if (!raw.trim()) {
            return fallback;
        }

        return JSON.parse(raw);

    } catch {
        return fallback;
    }
}

async function writeJson(file, data) {
    await fsp.writeFile(
        file,
        JSON.stringify(data, null, 2)
    );
}

/* ============================================================
   SESSION ID VALIDATION
============================================================ */

function isValidSessionId(sessionId) {
    return (
        typeof sessionId === "string" &&
        /^ETIAS-MINI-BOT~\d{8}$/i.test(
            sessionId.trim()
        )
    );
}

function normalizeSessionId(sessionId) {
    if (
        typeof sessionId !== "string"
    ) {
        return "";
    }

    return sessionId.trim().toUpperCase();
}

function cleanPhone(phone) {
    if (!phone) {
        return "";
    }

    return String(phone)
        .replace(/[^\d]/g, "")
        .replace(/^00/, "");
}

/* ============================================================
   LOGGING
============================================================ */

function addLog(sessionId, message, level = "info") {
    const id = normalizeSessionId(sessionId);

    if (!id) {
        return;
    }

    if (!deploymentLogs.has(id)) {
        deploymentLogs.set(id, []);
    }

    const entry = {
        time: new Date().toISOString(),
        level,
        message: String(message)
    };

    const logs = deploymentLogs.get(id);

    logs.push(entry);

    if (logs.length > 500) {
        logs.splice(
            0,
            logs.length - 500
        );
    }

    try {
        const logFile = path.join(
            LOG_DIR,
            `${id.replace(/[^a-zA-Z0-9_-]/g, "_")}.log`
        );

        fs.appendFileSync(
            logFile,
            `[${entry.time}] [${level.toUpperCase()}] ${entry.message}\n`
        );
    } catch {
        // Ignore log file errors.
    }

    logger.info(
        `[${id}] ${message}`
    );
}

function getLogs(sessionId) {
    return (
        deploymentLogs.get(
            normalizeSessionId(sessionId)
        ) || []
    );
}

/* ============================================================
   COMMAND LOADER
============================================================ */

function loadCommands() {
    loadedCommands = new Map();

    if (!fs.existsSync(COMMANDS_DIR)) {
        return;
    }

    const files = fs
        .readdirSync(COMMANDS_DIR)
        .filter(
            file =>
                file.endsWith(".js") &&
                !file.startsWith("_")
        );

    for (const file of files) {
        const fullPath = path.join(
            COMMANDS_DIR,
            file
        );

        try {
            delete require.cache[
                require.resolve(fullPath)
            ];

            const command = require(fullPath);

            if (
                !command ||
                typeof command !== "object"
            ) {
                continue;
            }

            const name =
                command.name ||
                path.basename(
                    file,
                    ".js"
                );

            const aliases = Array.isArray(
                command.aliases
            )
                ? command.aliases
                : command.alias
                    ? [command.alias]
                    : [];

            loadedCommands.set(
                String(name).toLowerCase(),
                command
            );

            for (const alias of aliases) {
                loadedCommands.set(
                    String(alias).toLowerCase(),
                    command
                );
            }

        } catch (err) {
            logger.error({
                file,
                error: err.message
            }, "Failed to load command");
        }
    }

    logger.info(
        `[COMMANDS] ${loadedCommands.size} command entries loaded`
    );
}

/* ============================================================
   AUTH FOLDER RESOLUTION
============================================================ */

function safeSessionFolder(sessionId) {
    const safe = normalizeSessionId(sessionId)
        .replace(/[^a-zA-Z0-9_-]/g, "_");

    return path.join(
        USERS_AUTH_DIR,
        safe
    );
}

/*
 The pairing server may already have an auth folder.

 This function checks several possible locations so the bot
 can work with existing deployments without creating pairing
 codes.
*/

function findAuthFolder(sessionId, suppliedFolder = null) {
    const candidates = [];

    if (suppliedFolder) {
        candidates.push(
            path.resolve(suppliedFolder)
        );
    }

    candidates.push(
        safeSessionFolder(sessionId)
    );

    /*
     Older deployment layouts.
    */

    candidates.push(
        path.join(
            AUTH_DIR,
            normalizeSessionId(sessionId)
        )
    );

    /*
     Search users directory.
    */

    try {
        if (fs.existsSync(USERS_AUTH_DIR)) {
            const entries =
                fs.readdirSync(
                    USERS_AUTH_DIR,
                    {
                        withFileTypes: true
                    }
                );

            for (const entry of entries) {
                if (!entry.isDirectory()) {
                    continue;
                }

                const candidate =
                    path.join(
                        USERS_AUTH_DIR,
                        entry.name
                    );

                if (
                    fs.existsSync(
                        path.join(
                            candidate,
                            "creds.json"
                        )
                    )
                ) {
                    candidates.push(candidate);
                }
            }
        }
    } catch {
        // Ignore search errors.
    }

    for (const folder of candidates) {
        try {
            if (
                fs.existsSync(
                    path.join(
                        folder,
                        "creds.json"
                    )
                )
            ) {
                return folder;
            }
        } catch {
            // Continue.
        }
    }

    return null;
}

/* ============================================================
   AUTH STATE VALIDATION
============================================================ */

function hasAuthCredentials(authFolder) {
    if (!authFolder) {
        return false;
    }

    const creds = path.join(
        authFolder,
        "creds.json"
    );

    return fs.existsSync(creds);
}

/* ============================================================
   DEPLOYMENT RECORD
============================================================ */

async function saveDeployment(record) {
    const deployments =
        await readJson(
            DEPLOYED_FILE,
            []
        );

    const index =
        deployments.findIndex(
            item =>
                normalizeSessionId(
                    item.sessionId
                ) === normalizeSessionId(
                    record.sessionId
                )
        );

    if (index >= 0) {
        deployments[index] = {
            ...deployments[index],
            ...record
        };
    } else {
        deployments.push(record);
    }

    await writeJson(
        DEPLOYED_FILE,
        deployments
    );

    if (Deployment) {
        try {
            await Deployment.findOneAndUpdate(
                {
                    sessionId:
                        record.sessionId
                },
                {
                    $set: record
                },
                {
                    upsert: true,
                    new: true
                }
            );
        } catch (err) {
            logger.error({
                error: err.message
            }, "Mongo deployment save failed");
        }
    }

    return record;
}

async function getDeployment(sessionId) {
    const id =
        normalizeSessionId(sessionId);

    if (Deployment) {
        try {
            const record =
                await Deployment.findOne({
                    sessionId: id
                }).lean();

            if (record) {
                return record;
            }
        } catch {
            // Fall back to local database.
        }
    }

    const deployments =
        await readJson(
            DEPLOYED_FILE,
            []
        );

    return (
        deployments.find(
            item =>
                normalizeSessionId(
                    item.sessionId
                ) === id
        ) || null
    );
}

/* ============================================================
   PHONE EXTRACTION
============================================================ */

function jidToPhone(jid) {
    if (!jid) {
        return "";
    }

    const value = String(jid);

    const first =
        value.split("@")[0];

    const phone =
        first.split(":")[0];

    return cleanPhone(phone);
}

/* ============================================================
   SEND SESSION ID
============================================================ */

async function sendSessionInfo(sock, session) {
    if (!sock || !session) {
        return false;
    }

    const sessionId =
        normalizeSessionId(
            session.sessionId
        );

    if (!isValidSessionId(sessionId)) {
        return false;
    }

    const jid =
        session.userJid ||
        session.jid;

    if (!jid) {
        return false;
    }

    try {
        await sock.sendMessage(
            jid,
            {
                text:
`╭━━━〔 ETIAS-MINI-BOT 〕━━━╮
┃
┃ SESSION ID
┃
┃ ${sessionId}
┃
┃ Copy this Session ID to
┃ the deployment page.
┃
┃ The Session ID is used to
┃ connect this WhatsApp account.
┃
╰━━━━━━━━━━━━━━━━━━━━━━╯`
            }
        );

        addLog(
            sessionId,
            "Session ID sent to WhatsApp."
        );

        return true;

    } catch (err) {
        addLog(
            sessionId,
            `Failed to send Session ID: ${err.message}`,
            "error"
        );

        return false;
    }
}

/* ============================================================
   SOCKET CREATION
============================================================ */

async function createSocket(
    sessionId,
    options = {}
) {
    const id =
        normalizeSessionId(sessionId);

    if (!isValidSessionId(id)) {
        throw new Error(
            "Invalid Session ID. Expected ETIAS-MINI-BOT~XXXXXXXX."
        );
    }

    const existing =
        sessions.get(id);

    if (
        existing &&
        existing.sock
    ) {
        return existing.sock;
    }

    const authFolder =
        findAuthFolder(
            id,
            options.authFolder
        );

    if (!authFolder) {
        throw new Error(
            "Authentication files were not found for this Session ID."
        );
    }

    if (
        !hasAuthCredentials(
            authFolder
        )
    ) {
        throw new Error(
            "creds.json was not found. Pair the WhatsApp number first."
        );
    }

    addLog(
        id,
        `Using auth folder: ${authFolder}`
    );

    const {
        state,
        saveCreds
    } = await useMultiFileAuthState(
        authFolder
    );

    const deployment =
        await getDeployment(id);

    const session = {
        sessionId: id,
        sock: null,
        authFolder,
        state,
        saveCreds,
        userJid:
            deployment?.jid ||
            null,
        phone:
            cleanPhone(
                deployment?.phone ||
                options.phone ||
                ""
            ),
        pairId:
            deployment?.pairId ||
            options.pairId ||
            null,
        mode:
            deployment?.mode ||
            "public",
        days:
            Number(
                deployment?.days ||
                options.days ||
                DEFAULT_DAYS
            ),
        connected: false,
        reconnects:
            Number(
                deployment?.reconnects || 0
            ),
        messages:
            Number(
                deployment?.messages || 0
            ),
        commandCount:
            Number(
                deployment?.commandCount || 0
            ),
        createdAt:
            deployment?.createdAt ||
            new Date().toISOString(),
        lastSeen:
            new Date().toISOString()
    };

    sessions.set(
        id,
        session
    );

    const sock =
        makeWASocket({
            auth: state,
            browser:
                Browsers.macOS(
                    "Chrome"
                ),
            logger: pino({
                level:
                    process.env.BAILEYS_LOG_LEVEL ||
                    "silent"
            }),
            printQRInTerminal: false,
            markOnlineOnConnect: true,
            syncFullHistory: false,
            generateHighQualityLinkPreview: true
        });

    session.sock = sock;

    /*
    ========================================================
     SAVE AUTH CREDENTIALS
    ========================================================
    */

    sock.ev.on(
        "creds.update",
        async () => {
            try {
                await saveCreds();
            } catch (err) {
                addLog(
                    id,
                    `Failed to save credentials: ${err.message}`,
                    "error"
                );
            }
        }
    );

    /*
    ========================================================
     CONNECTION UPDATE
    ========================================================
    */

    sock.ev.on(
        "connection.update",
        async update => {
            const {
                connection,
                lastDisconnect
            } = update;

            if (connection === "connecting") {
                addLog(
                    id,
                    "Connecting to WhatsApp..."
                );
            }

            if (connection === "open") {
                session.connected = true;
                session.lastSeen =
                    new Date().toISOString();

                const jid =
                    sock.user?.id
                        ? jidNormalizedUser(
                            sock.user.id
                        )
                        : session.userJid;

                if (jid) {
                    session.userJid =
                        jid;

                    session.phone =
                        jidToPhone(jid);
                }

                addLog(
                    id,
                    `WhatsApp connected${session.phone ? `: ${session.phone}` : ""}.`
                );

                await saveDeployment({
                    sessionId: id,
                    phone:
                        session.phone,
                    pairId:
                        session.pairId,
                    jid:
                        session.userJid,
                    status:
                        "connected",
                    connected:
                        true,
                    mode:
                        session.mode,
                    days:
                        session.days,
                    authFolder:
                        session.authFolder,
                    reconnects:
                        session.reconnects,
                    messages:
                        session.messages,
                    commandCount:
                        session.commandCount,
                    lastSeen:
                        new Date()
                });

                /*
                Main.js does NOT generate a pairing code.

                If a deployment has just been created and the
                session ID has not already been sent, send it.
                */

                const deployment =
                    await getDeployment(id);

                if (
                    deployment &&
                    !deployment.sessionMessageSent
                ) {
                    const sent =
                        await sendSessionInfo(
                            sock,
                            {
                                ...session,
                                sessionId: id
                            }
                        );

                    if (sent) {
                        await saveDeployment({
                            sessionId: id,
                            sessionMessageSent:
                                true,
                            connected: true,
                            status:
                                "connected",
                            lastSeen:
                                new Date()
                        });
                    }
                }
            }

            if (connection === "close") {
                session.connected =
                    false;

                const statusCode =
                    lastDisconnect
                        ?.error
                        ?.output
                        ?.statusCode;

                addLog(
                    id,
                    `WhatsApp connection closed. Status: ${statusCode || "unknown"}`
                );

                await saveDeployment({
                    sessionId: id,
                    connected: false,
                    status:
                        "disconnected",
                    lastSeen:
                        new Date()
                });

                /*
                Logged out / removed account.
                Do not reconnect forever.
                */

                if (
                    statusCode ===
                    DisconnectReason.loggedOut
                ) {
                    addLog(
                        id,
                        "WhatsApp logged out. Automatic reconnect disabled.",
                        "warn"
                    );

                    session.status =
                        "logged_out";

                    sessions.delete(id);

                    return;
                }

                /*
                Bad session / replaced / invalid auth.
                */

                if (
                    statusCode ===
                    DisconnectReason.badSession
                ) {
                    addLog(
                        id,
                        "Bad WhatsApp session. Re-pairing is required.",
                        "error"
                    );

                    session.status =
                        "bad_session";

                    return;
                }

                /*
                Normal network/server disconnect.
                */

                await scheduleReconnect(
                    id
                );
            }
        }
    );

    /*
    ========================================================
     MESSAGE HANDLER
    ========================================================
    */

    sock.ev.on(
        "messages.upsert",
        async event => {
            if (
                !event ||
                !Array.isArray(
                    event.messages
                )
            ) {
                return;
            }

            for (
                const message
                of event.messages
            ) {
                try {
                    await processMessage(
                        id,
                        message
                    );
                } catch (err) {
                    addLog(
                        id,
                        `Message processing error: ${err.message}`,
                        "error"
                    );
                }
            }
        }
    );

    /*
    ========================================================
     GROUP PARTICIPANT EVENTS
    ========================================================
    */

    sock.ev.on(
        "group-participants.update",
        async event => {
            try {
                await handleGroupParticipants(
                    id,
                    event
                );
            } catch (err) {
                addLog(
                    id,
                    `Group event error: ${err.message}`,
                    "error"
                );
            }
        }
    );

    return sock;
}

/* ============================================================
   RECONNECT
============================================================ */

async function scheduleReconnect(sessionId) {
    const id =
        normalizeSessionId(sessionId);

    if (
        reconnecting.has(id)
    ) {
        return;
    }

    const session =
        sessions.get(id);

    if (!session) {
        return;
    }

    reconnecting.add(id);

    session.reconnects =
        Number(
            session.reconnects || 0
        ) + 1;

    const delay =
        Math.min(
            60000,
            5000 *
                Math.min(
                    session.reconnects,
                    12
                )
        );

    addLog(
        id,
        `Reconnecting in ${Math.round(delay / 1000)} seconds...`
    );

    setTimeout(
        async () => {
            reconnecting.delete(id);

            try {
                const current =
                    sessions.get(id);

                if (!current) {
                    return;
                }

                const sock =
                    await createSocket(
                        id,
                        {
                            authFolder:
                                current.authFolder,
                            phone:
                                current.phone,
                            pairId:
                                current.pairId,
                            days:
                                current.days
                        }
                    );

                current.sock =
                    sock;

            } catch (err) {
                addLog(
                    id,
                    `Reconnect failed: ${err.message}`,
                    "error"
                );

                setTimeout(
                    () =>
                        scheduleReconnect(
                            id
                        ),
                    10000
                );
            }
        },
        delay
    );
}

/* ============================================================
   COMMAND HELPERS
============================================================ */

function getMessageText(message) {
    const msg =
        message?.message;

    if (!msg) {
        return "";
    }

    return (
        msg.conversation ||
        msg.extendedTextMessage
            ?.text ||
        msg.imageMessage
            ?.caption ||
        msg.videoMessage
            ?.caption ||
        msg.documentMessage
            ?.caption ||
        msg.buttonsResponseMessage
            ?.selectedButtonId ||
        msg.listResponseMessage
            ?.singleSelectReply
            ?.selectedRowId ||
        ""
    );
}

function getMessageContext(message) {
    const key =
        message?.key || {};

    const remoteJid =
        key.remoteJid || "";

    const participant =
        key.participant ||
        remoteJid;

    return {
        remoteJid,
        participant,
        sender:
            participant,
        isGroup:
            remoteJid.endsWith(
                "@g.us"
            ),
        fromMe:
            Boolean(key.fromMe)
    };
}

/* ============================================================
   BUILT-IN COMMANDS
============================================================ */

async function runBuiltInCommand(
    session,
    message,
    command,
    args,
    context
) {
    const sock =
        session.sock;

    const jid =
        context.remoteJid;

    const text =
        args.join(" ");

    switch (command) {
        case "test1": {
            await sock.sendMessage(
                jid,
                {
                    text:
                        "🏓 Pong!\n\nETIAS-MINI-BOT is online."
                }
            );

            return true;
        }

        case "test2": {
            const uptime =
                process.uptime();

            await sock.sendMessage(
                jid,
                {
                    text:
`╭━━〔 ETIAS-MINI-BOT 〕━━╮
┃
┃ STATUS: ONLINE
┃
┃ Session:
┃ ${session.sessionId}
┃
┃ Phone:
┃ ${session.phone || "Unknown"}
┃
┃ Mode:
┃ ${session.mode}
┃
┃ Uptime:
┃ ${formatUptime(uptime)}
┃
╰━━━━━━━━━━━━━━━━━━━━╯`
                }
            );

            return true;
        }

        case "session": {
            await sock.sendMessage(
                jid,
                {
                    text:
`╭━━〔 SESSION ID 〕━━╮
┃
┃ ${session.sessionId}
┃
╰━━━━━━━━━━━━━━━━╯`
                }
            );

            return true;
        }

        case "status": {
            await sock.sendMessage(
                jid,
                {
                    text:
`╭━━〔 BOT STATUS 〕━━╮
┃
┃ Connection: ${
    session.connected
        ? "ONLINE"
        : "OFFLINE"
}
┃ Mode: ${session.mode}
┃ Messages: ${session.messages}
┃ Commands: ${session.commandCount}
┃ Reconnects: ${session.reconnects}
┃
╰━━━━━━━━━━━━━━━━━━╯`
                }
            );

            return true;
        }

        case "mode": {
            const requested =
                String(
                    args[0] || ""
                ).toLowerCase();

            if (
                requested !== "public" &&
                requested !== "private"
            ) {
                await sock.sendMessage(
                    jid,
                    {
                        text:
                            "Usage: .mode public\nor\n.mode private"
                    }
                );

                return true;
            }

            /*
            Only the owner can change this in a real command
            implementation. Keep the state change here so custom
            owner checks can also be added.
            */

            session.mode =
                requested;

            await saveDeployment({
                sessionId:
                    session.sessionId,
                mode:
                    requested
            });

            await sock.sendMessage(
                jid,
                {
                    text:
                        `Bot mode changed to ${requested.toUpperCase()}.`
                }
            );

            return true;
        }

        case "antilink": {
            await sock.sendMessage(
                jid,
                {
                    text:
`Anti-link system is available.

Use your dedicated anti-link
command module for group settings.`
                }
            );

            return true;
        }

        case "antidelete": {
            await sock.sendMessage(
                jid,
                {
                    text:
                        "Anti-delete is available through the loaded command/event modules."
                }
            );

            return true;
        }

        case "viewonce": {
            await sock.sendMessage(
                jid,
                {
                    text:
                        "View-once handling is available through the loaded command/event modules."
                }
            );

            return true;
        }

        case "test3":
        case "test4": {
            const commands =
                [...loadedCommands.keys()]
                    .filter(
                        name =>
                            name.length > 0
                    );

            const unique =
                [...new Set(commands)];

            await sock.sendMessage(
                jid,
                {
                    text:
`╭━━━〔 ETIAS-MINI-BOT 〕━━━╮
┃
┃ 🤖 ONLINE
┃
┃ Prefix: .
┃ Session:
┃ ${session.sessionId}
┃
┃ Built-in commands:
┃ • .ping
┃ • .alive
┃ • .session
┃ • .status
┃ • .mode public
┃ • .mode private
┃ • .menu
┃
┃ Loaded commands:
┃ ${unique
    .slice(0, 80)
    .map(x => `• .${x}`)
    .join("\n┃ ")}
┃
╰━━━━━━━━━━━━━━━━━━━━━━╯`
                }
            );

            return true;
        }

        default:
            return false;
    }
}

/* ============================================================
   CUSTOM COMMAND RUNNER
============================================================ */

async function runCustomCommand(
    session,
    message,
    command,
    args,
    context
) {
    const cmd =
        loadedCommands.get(
            command
        );

    if (!cmd) {
        return false;
    }

    if (
        typeof cmd.execute !==
        "function"
    ) {
        return false;
    }

    const sock =
        session.sock;

    /*
    Support several common command APIs.
    */

    await cmd.execute(
        sock,
        message,
        args,
        {
            ...context,
            session,
            sessionId:
                session.sessionId,
            bot: sock
        }
    );

    return true;
}

/* ============================================================
   MESSAGE PROCESSING
============================================================ */

async function processMessage(
    sessionId,
    message
) {
    const session =
        sessions.get(
            normalizeSessionId(
                sessionId
            )
        );

    if (!session) {
        return;
    }

    if (!message) {
        return;
    }

    const context =
        getMessageContext(
            message
        );

    const text =
        getMessageText(
            message
        ).trim();

    session.messages =
        Number(
            session.messages || 0
        ) + 1;

    session.lastSeen =
        new Date().toISOString();

    if (!text) {
        return;
    }

    /*
    Ignore messages sent by the bot itself unless a command/event
    specifically needs them.
    */

    if (context.fromMe) {
        return;
    }

    /*
    Commands require the configured prefix.
    */

    if (
        !text.startsWith(".")
    ) {
        return;
    }

    const body =
        text.slice(1).trim();

    if (!body) {
        return;
    }

    const parts =
        body.split(/\s+/);

    const command =
        String(
            parts.shift() || ""
        ).toLowerCase();

    const args =
        parts;

    session.commandCount =
        Number(
            session.commandCount || 0
        ) + 1;

    let handled = false;

    try {
        handled =
            await runBuiltInCommand(
                session,
                message,
                command,
                args,
                context
            );

        if (!handled) {
            handled =
                await runCustomCommand(
                    session,
                    message,
                    command,
                    args,
                    context
                );
        }

        if (handled) {
            addLog(
                session.sessionId,
                `Command executed: .${command}`
            );
        }

    } catch (err) {
        addLog(
            session.sessionId,
            `Command .${command} failed: ${err.message}`,
            "error"
        );

        try {
            await session.sock.sendMessage(
                context.remoteJid,
                {
                    text:
                        `❌ Command error: ${err.message}`
                }
            );
        } catch {
            // Ignore reply errors.
        }
    }

    /*
    Periodically persist statistics.
    */

    if (
        session.commandCount %
            10 ===
        0
    ) {
        await saveDeployment({
            sessionId:
                session.sessionId,
            connected:
                session.connected,
            messages:
                session.messages,
            commandCount:
                session.commandCount,
            reconnects:
                session.reconnects,
            lastSeen:
                new Date()
        });
    }
}

/* ============================================================
   GROUP EVENTS
============================================================ */

async function handleGroupParticipants(
    sessionId,
    event
) {
    const session =
        sessions.get(
            normalizeSessionId(
                sessionId
            )
        );

    if (!session) {
        return;
    }

    const {
        id,
        participants,
        action
    } = event;

    if (!id) {
        return;
    }

    /*
    If you already have dedicated welcome/goodbye commands,
    they can handle these events. This base manager keeps the
    connection event available without forcing a particular
    message design.
    */

    if (
        action === "add" ||
        action === "remove"
    ) {
        addLog(
            sessionId,
            `Group participant event: ${action} (${participants?.length || 0})`
        );
    }
}

/* ============================================================
   DEPLOY SESSION
============================================================ */

async function deploySession(options = {}) {
    const sessionId =
        normalizeSessionId(
            options.sessionId
        );

    const phone =
        cleanPhone(
            options.phone
        );

    const days =
        Math.max(
            1,
            Number(
                options.days ||
                DEFAULT_DAYS
            )
        );

    if (
        !isValidSessionId(
            sessionId
        )
    ) {
        throw new Error(
            "Invalid Session ID. Use ETIAS-MINI-BOT~XXXXXXXX."
        );
    }

    /*
    The auth state must already exist.

    This is intentionally different from the old architecture:
    main.js does not call requestPairingCode().
    */

    const authFolder =
        findAuthFolder(
            sessionId,
            options.authFolder
        );

    if (!authFolder) {
        throw new Error(
            "No WhatsApp authentication state found for this Session ID. Pair the number first."
        );
    }

    if (
        !hasAuthCredentials(
            authFolder
        )
    ) {
        throw new Error(
            "creds.json is missing for this Session ID."
        );
    }

    /*
    Prevent two active deployments using the same number.
    */

    for (
        const [id, session]
        of sessions.entries()
    ) {
        if (
            id !== sessionId &&
            phone &&
            cleanPhone(
                session.phone
            ) === phone &&
            session.connected
        ) {
            throw new Error(
                "This WhatsApp number already has an active bot deployment."
            );
        }
    }

    const expireAt =
        new Date(
            Date.now() +
                days *
                    24 *
                    60 *
                    60 *
                    1000
        );

    const existing =
        await getDeployment(
            sessionId
        );

    const record = {
        sessionId,
        phone:
            phone ||
            existing?.phone ||
            "",
        pairId:
            options.pairId ||
            existing?.pairId ||
            null,
        jid:
            options.jid ||
            existing?.jid ||
            null,
        status:
            "starting",
        connected:
            false,
        mode:
            options.mode ||
            existing?.mode ||
            "public",
        days,
        expireAt,
        authFolder,
        reconnects:
            Number(
                existing?.reconnects ||
                0
            ),
        messages:
            Number(
                existing?.messages ||
                0
            ),
        commandCount:
            Number(
                existing?.commandCount ||
                0
            ),
        createdAt:
            existing?.createdAt ||
            new Date(),
        lastSeen:
            new Date()
    };

    await saveDeployment(
        record
    );

    addLog(
        sessionId,
        `Starting deployment for ${record.phone || "unknown number"}.`
    );

    let session =
        sessions.get(
            sessionId
        );

    if (
        session &&
        session.sock
    ) {
        addLog(
            sessionId,
            "Existing socket found. Reusing connection."
        );

        return {
            success: true,
            sessionId,
            phone:
                record.phone,
            days,
            expireAt,
            status:
                session.connected
                    ? "connected"
                    : "starting"
        };
    }

    const sock =
        await createSocket(
            sessionId,
            {
                authFolder,
                phone:
                    record.phone,
                pairId:
                    record.pairId,
                days
            }
        );

    session =
        sessions.get(
            sessionId
        );

    if (session) {
        session.sock =
            sock;
        session.phone =
            record.phone;
        session.days =
            days;
        session.pairId =
            record.pairId;
    }

    return {
        success: true,
        sessionId,
        phone:
            record.phone,
        days,
        expireAt,
        status:
            "starting"
    };
}

/*
Alias kept for compatibility with code that calls deploy().
*/

async function deploy(options = {}) {
    return deploySession(
        options
    );
}

/* ============================================================
   GET SESSION
============================================================ */

function getSession(sessionId) {
    return sessions.get(
        normalizeSessionId(
            sessionId
        )
    ) || null;
}

function getSessions() {
    return [
        ...sessions.values()
    ].map(
        session => ({
            sessionId:
                session.sessionId,
            phone:
                session.phone,
            pairId:
                session.pairId,
            connected:
                session.connected,
            mode:
                session.mode,
            days:
                session.days,
            authFolder:
                session.authFolder,
            reconnects:
                session.reconnects,
            messages:
                session.messages,
            commandCount:
                session.commandCount,
            lastSeen:
                session.lastSeen
        })
    );
}

/* ============================================================
   STOP SESSION
============================================================ */

async function stopSession(
    sessionId
) {
    const id =
        normalizeSessionId(
            sessionId
        );

    const session =
        sessions.get(id);

    if (!session) {
        return false;
    }

    try {
        if (session.sock) {
            session.sock.end(
                undefined
            );
        }
    } catch {
        // Ignore.
    }

    session.connected =
        false;

    await saveDeployment({
        sessionId: id,
        connected: false,
        status:
            "stopped",
        lastSeen:
            new Date()
    });

    sessions.delete(id);

    addLog(
        id,
        "Bot session stopped."
    );

    return true;
}

/* ============================================================
   RESTART SESSION
============================================================ */

async function restartSession(
    sessionId
) {
    const id =
        normalizeSessionId(
            sessionId
        );

    const deployment =
        await getDeployment(
            id
        );

    if (!deployment) {
        throw new Error(
            "Deployment not found."
        );
    }

    await stopSession(id);

    return deploySession({
        sessionId: id,
        phone:
            deployment.phone,
        pairId:
            deployment.pairId,
        jid:
            deployment.jid,
        days:
            deployment.days,
        mode:
            deployment.mode,
        authFolder:
            deployment.authFolder
    });
}

/* ============================================================
   REMOVE SESSION
============================================================ */

async function removeSession(
    sessionId,
    deleteAuth = false
) {
    const id =
        normalizeSessionId(
            sessionId
        );

    const deployment =
        await getDeployment(
            id
        );

    await stopSession(id);

    const deployments =
        await readJson(
            DEPLOYED_FILE,
            []
        );

    const filtered =
        deployments.filter(
            item =>
                normalizeSessionId(
                    item.sessionId
                ) !== id
        );

    await writeJson(
        DEPLOYED_FILE,
        filtered
    );

    if (Deployment) {
        try {
            await Deployment.deleteOne({
                sessionId: id
            });
        } catch {
            // Ignore.
        }
    }

    if (
        deleteAuth &&
        deployment?.authFolder
    ) {
        try {
            await fsp.rm(
                deployment.authFolder,
                {
                    recursive: true,
                    force: true
                }
            );
        } catch (err) {
            addLog(
                id,
                `Failed to remove auth folder: ${err.message}`,
                "error"
            );
        }
    }

    deploymentLogs.delete(id);

    return true;
}

/* ============================================================
   STATS
============================================================ */

async function getStats() {
    const deployments =
        await readJson(
            DEPLOYED_FILE,
            []
        );

    let connected = 0;

    for (
        const session
        of sessions.values()
    ) {
        if (session.connected) {
            connected++;
        }
    }

    return {
        totalDeployments:
            deployments.length,

        activeSessions:
            sessions.size,

        connectedSessions:
            connected,

        commandsLoaded:
            loadedCommands.size,

        uptime:
            process.uptime(),

        memory:
            process.memoryUsage()
    };
}

/* ============================================================
   LOAD SAVED DEPLOYMENTS
============================================================ */

async function loadSavedDeployments() {
    const deployments =
        await readJson(
            DEPLOYED_FILE,
            []
        );

    if (!Array.isArray(
        deployments
    )) {
        return;
    }

    addLog(
        "SYSTEM",
        `${deployments.length} saved deployment(s) found.`
    );

    for (
        const deployment
        of deployments
    ) {
        const sessionId =
            normalizeSessionId(
                deployment.sessionId
            );

        if (
            !isValidSessionId(
                sessionId
            )
        ) {
            continue;
        }

        /*
        Do not start expired deployments.
        */

        if (
            deployment.expireAt &&
            new Date(
                deployment.expireAt
            ).getTime() <=
                Date.now()
        ) {
            logger.warn(
                `[EXPIRED] ${sessionId}`
            );

            continue;
        }

        if (
            !deployment.authFolder &&
            !findAuthFolder(
                sessionId
            )
        ) {
            logger.warn(
                `[SKIP] Auth state missing for ${sessionId}`
            );

            continue;
        }

        try {
            await deploySession({
                sessionId,
                phone:
                    deployment.phone,
                pairId:
                    deployment.pairId,
                jid:
                    deployment.jid,
                days:
                    deployment.days,
                mode:
                    deployment.mode,
                authFolder:
                    deployment.authFolder
            });

        } catch (err) {
            logger.error({
                sessionId,
                error:
                    err.message
            }, "Failed to restore deployment");
        }
    }
}

/* ============================================================
   EXPIRATION CHECKER
============================================================ */

setInterval(
    async () => {
        try {
            const deployments =
                await readJson(
                    DEPLOYED_FILE,
                    []
                );

            for (
                const deployment
                of deployments
            ) {
                if (
                    !deployment.expireAt
                ) {
                    continue;
                }

                const expired =
                    new Date(
                        deployment.expireAt
                    ).getTime() <=
                    Date.now();

                if (!expired) {
                    continue;
                }

                const id =
                    normalizeSessionId(
                        deployment.sessionId
                    );

                const session =
                    sessions.get(id);

                if (session) {
                    await stopSession(
                        id
                    );
                }

                await saveDeployment({
                    sessionId: id,
                    status:
                        "expired",
                    connected:
                        false,
                    lastSeen:
                        new Date()
                });

                addLog(
                    id,
                    "Deployment expired."
                );
            }

        } catch (err) {
            logger.error({
                error:
                    err.message
            }, "Expiration checker error");
        }
    },
    60 * 1000
);

/* ============================================================
   UTILITY
============================================================ */

function formatUptime(seconds) {
    const total =
        Math.floor(
            Number(seconds || 0)
        );

    const days =
        Math.floor(
            total / 86400
        );

    const hours =
        Math.floor(
            (total % 86400) /
                3600
        );

    const minutes =
        Math.floor(
            (total % 3600) /
                60
        );

    const secs =
        total % 60;

    return `${days}d ${hours}h ${minutes}m ${secs}s`;
}

/* ============================================================
   GLOBAL BOT MANAGER
============================================================ */

const botManager = {
    deploy,
    deploySession,

    getSession,
    getSessions,

    getLogs,

    stop: stopSession,
    restart: restartSession,
    remove: removeSession,

    stats: getStats,

    loadCommands,

    isValidSessionId
};

global.ETIAS_BOT_MANAGER =
    botManager;

/* ============================================================
   STARTUP
============================================================ */

async function start() {
    try {
        await ensureJsonFile(
            DEPLOYED_FILE,
            []
        );

        await ensureJsonFile(
            MULTI_SESSION_FILE,
            []
        );

        loadCommands();

        await connectMongo();

        /*
        Give the HTTP server a chance to initialize before
        restoring saved WhatsApp sessions.
        */

        if (
            app &&
            typeof app.listen ===
                "function"
        ) {
            app.listen(
                PORT,
                "0.0.0.0",
                () => {
                    logger.info(
                        `🚀 ETIAS-MINI-BOT running on port ${PORT}`
                    );

                    logger.info(
                        "📱 WhatsApp pairing is handled by the pairing server."
                    );

                    logger.info(
                        "🔐 main.js will NOT generate WhatsApp pairing codes."
                    );
                }
            );
        }

        /*
        Restore already deployed authenticated sessions.
        */

        await loadSavedDeployments();

    } catch (err) {
        logger.error({
            error:
                err.stack ||
                err.message
        }, "Fatal startup error");

        process.exit(1);
    }
}

/* ============================================================
   PROCESS HANDLING
============================================================ */

process.on(
    "uncaughtException",
    err => {
        logger.error({
            error:
                err.stack ||
                err.message
        }, "Uncaught exception");
    }
);

process.on(
    "unhandledRejection",
    reason => {
        logger.error({
            error:
                reason?.stack ||
                reason?.message ||
                String(reason)
        }, "Unhandled rejection");
    }
);

process.on(
    "SIGTERM",
    async () => {
        logger.info(
            "SIGTERM received. Shutting down..."
        );

        for (
            const [
                id,
                session
            ] of sessions.entries()
        ) {
            try {
                if (
                    session.sock
                ) {
                    session.sock.end(
                        undefined
                    );
                }
            } catch {
                // Ignore.
            }

            addLog(
                id,
                "Bot shutting down."
            );
        }

        try {
            await mongoose.connection.close();
        } catch {
            // Ignore.
        }

        process.exit(0);
    }
);

process.on(
    "SIGINT",
    async () => {
        logger.info(
            "SIGINT received. Shutting down..."
        );

        for (
            const session
            of sessions.values()
        ) {
            try {
                if (
                    session.sock
                ) {
                    session.sock.end(
                        undefined
                    );
                }
            } catch {
                // Ignore.
            }
        }

        try {
            await mongoose.connection.close();
        } catch {
            // Ignore.
        }

        process.exit(0);
    }
);

/* ============================================================
   START
============================================================ */

start();

module.exports = {
    botManager,
    deploy,
    deploySession,
    getSession,
    getSessions,
    getLogs,
    stopSession,
    restartSession,
    removeSession,
    getStats,
    isValidSessionId
};
