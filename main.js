"use strict";

/*
============================================================
 ETIAS-MINI-BOT
 MULTI SESSION BOT ENGINE
 WhatsApp Multi-Device
 WEB PAIRING AUTH ONLY
 MongoDB + Local Fallback
 Live Logs
 Automatic Reconnect
 COMMAND LOADER
 WELCOME / GOODBYE
 ANTILINK
 ANTIDELETE
 ANTIVIEWONCE
 VIEWONCE
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
    jidNormalizedUser,
    downloadContentFromMessage
} = require("@whiskeysockets/baileys");

/*
============================================================
 CONFIG
============================================================
*/

const BOT_NAME =
    process.env.BOT_NAME ||
    "*ETIAS-MINI-BOT*";

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
 DIRECTORIES
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
        .replace(
            /[^a-zA-Z0-9_-]/g,
            "_"
        );
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
        return JSON.parse(
            fs.readFileSync(
                LOCAL_DB,
                "utf8"
            )
        );
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

    if (
        !deploymentLogs.has(
            sessionId
        )
    ) {
        deploymentLogs.set(
            sessionId,
            []
        );
    }

    const list =
        deploymentLogs.get(
            sessionId
        );

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
        deploymentLogs.get(
            sessionId
        );

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

            lastSeen: Date,

            features: {
                antiLink: {
                    type: Boolean,
                    default: false
                },

                antiDelete: {
                    type: Boolean,
                    default: false
                },

                antiViewOnce: {
                    type: Boolean,
                    default: false
                },

                welcome: {
                    type: Boolean,
                    default: true
                },

                goodbye: {
                    type: Boolean,
                    default: true
                },

                viewOnce: {
                    type: Boolean,
                    default: false
                }
            }
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
            mongoose.connection
                .readyState === 1
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

        /*
         * Kept for compatibility,
         * but main.js NEVER generates
         * a pairing code.
         */
        pairingCode:
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
            session.lastSeen || null,

        features: {
            antiLink:
                !!session.antiLink,

            antiDelete:
                !!session.antiDelete,

            antiViewOnce:
                !!session.antiViewOnce,

            welcome:
                session.welcome !== false,

            goodbye:
                session.goodbye !== false,

            viewOnce:
                !!session.viewOnce
        }
    };

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
 FIND DEPLOYMENT
============================================================
*/

async function findDeployment(
    sessionId
) {
    if (
        sessions.has(sessionId)
    ) {
        return sessions.get(
            sessionId
        );
    }

    if (mongoReady) {
        try {
            const found =
                await Deployment
                    .findOne({
                        sessionId
                    })
                    .lean();

            if (found) {
                return found;
            }
        } catch {}
    }

    try {
        const db =
            readLocalDatabase();

        return (
            db[sessionId] ||
            null
        );
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
            sessionSummary(
                session
            )
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
            null,

        features: {
            antiLink:
                !!session.antiLink,

            antiDelete:
                !!session.antiDelete,

            antiViewOnce:
                !!session.antiViewOnce,

            welcome:
                session.welcome !== false,

            goodbye:
                session.goodbye !== false,

            viewOnce:
                !!session.viewOnce
        }
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

        /*
         * No pairing code.
         */
        pairingCode:
            null,

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

        authFolder:
            getAuthPath(
                sessionId
            ),

        /*
         * BOT FEATURES
         */

        antiLink:
            options.features
                ?.antiLink ??
            false,

        antiDelete:
            options.features
                ?.antiDelete ??
            false,

        antiViewOnce:
            options.features
                ?.antiViewOnce ??
            false,

        welcome:
            options.features
                ?.welcome ??
            true,

        goodbye:
            options.features
                ?.goodbye ??
            true,

        viewOnce:
            options.features
                ?.viewOnce ??
            false,

        /*
         * Message cache for
         * antidelete/viewonce.
         */

        messageStore:
            new Map()
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
                !command
            ) {
                continue;
            }

            const names = [];

            /*
             * Direct function command
             */

            if (
                typeof command ===
                "function"
            ) {
                const name =
                    path
                        .basename(
                            file,
                            ".js"
                        )
                        .toLowerCase();

                names.push(name);
            }

            /*
             * Object command
             */

            if (
                typeof command ===
                "object"
            ) {
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

                /*
                 * If no explicit name,
                 * use filename.
                 */

                if (
                    names.length === 0
                ) {
                    names.push(
                        path
                            .basename(
                                file,
                                ".js"
                            )
                            .toLowerCase()
                    );
                }
            }

            if (
                names.length === 0
            ) {
                continue;
            }

            for (
                const name of
                names
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

    addLog(
        "SYSTEM",
        `${count} commands loaded from commands folder`
    );
}

/*
============================================================
 RELOAD COMMANDS
============================================================
*/

function reloadCommands() {
    loadCommands();

    return {
        success: true,
        count:
            loadedCommands.size
    };
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
    const sender =
        String(jid || "")
            .split("@")[0]
            .split(":")[0]
            .replace(/\D/g, "");

    if (
        OWNER_NUMBER &&
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
        return null;
    }
}

/*
============================================================
 GROUP CHECK
============================================================
*/

function isGroupJid(jid) {
    return String(jid || "")
        .endsWith("@g.us");
}

/*
============================================================
 STORE MESSAGE
============================================================
*/

function storeMessage(
    session,
    message
) {
    if (
        !message?.key?.id
    ) {
        return;
    }

    if (
        !session.messageStore
    ) {
        session.messageStore =
            new Map();
    }

    const id =
        message.key.id;

    session.messageStore.set(
        id,
        message
    );

    /*
     * Keep only latest 500.
     */

    if (
        session.messageStore.size >
        500
    ) {
        const first =
            session.messageStore
                .keys()
                .next()
                .value;

        session.messageStore.delete(
            first
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
            "✅ Session ID sent to WhatsApp"
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
 NO PAIRING CODE
============================================================
*/

function pairingCodeDisabled(
    session
) {
    addLog(
        session.sessionId,
        "🔐 Pairing code generation is disabled. Waiting for web pairing/authentication."
    );
}

/*
============================================================
 FEATURE: ANTILINK
============================================================
*/

async function handleAntiLink(
    session,
    message,
    text
) {
    if (
        !session.antiLink
    ) {
        return false;
    }

    if (
        !isGroupJid(
            message.key?.remoteJid
        )
    ) {
        return false;
    }

    if (
        !/https?:\/\/|www\./i.test(
            text
        )
    ) {
        return false;
    }

    const remoteJid =
        message.key.remoteJid;

    const sender =
        message.key.participant ||
        remoteJid;

    /*
     * Do not delete owner messages.
     */

    if (
        isOwner(
            sender,
            session
        )
    ) {
        return false;
    }

    try {
        await session.sock.sendMessage(
            remoteJid,
            {
                delete:
                    message.key
            }
        );

        await reply(
            session.sock,
            remoteJid,
            "🚫 Link removed.\n\nAntilink is active."
        );

        addLog(
            session.sessionId,
            `🔗 Antilink removed message from ${sender}`
        );

        return true;
    } catch (error) {
        addLog(
            session.sessionId,
            `Antilink failed: ${error.message}`
        );

        return false;
    }
}

/*
============================================================
 FEATURE: ANTIDELETE
============================================================
*/

async function handleDeletedMessage(
    session,
    update
) {
    if (
        !session.antiDelete
    ) {
        return;
    }

    const key =
        update?.key;

    if (!key?.id) {
        return;
    }

    const oldMessage =
        session.messageStore.get(
            key.id
        );

    if (!oldMessage) {
        addLog(
            session.sessionId,
            `🗑️ Deleted message detected: ${key.id}`
        );

        return;
    }

    const remoteJid =
        key.remoteJid;

    if (!remoteJid) {
        return;
    }

    const text =
        getMessageText(
            oldMessage
        );

    try {
        await session.sock.sendMessage(
            remoteJid,
            {
                text:
`🗑️ *MESSAGE DELETED*

👤 From:
${key.participant || key.remoteJid}

💬 Message:
${text || "[media/message]"}`
            }
        );

        addLog(
            session.sessionId,
            "🗑️ Deleted message recovered/reported"
        );
    } catch (error) {
        addLog(
            session.sessionId,
            `Antidelete failed: ${error.message}`
        );
    }
}

/*
============================================================
 FEATURE: VIEW ONCE
============================================================
*/

function getViewOnceMessage(
    message
) {
    if (
        !message?.message
    ) {
        return null;
    }

    const msg =
        message.message;

    /*
     * Direct viewOnce wrapper
     */

    if (
        msg.viewOnceMessage
            ?.message
    ) {
        return (
            msg.viewOnceMessage
                .message
        );
    }

    /*
     * V2 wrapper
     */

    if (
        msg.viewOnceMessageV2
            ?.message
    ) {
        return (
            msg.viewOnceMessageV2
                .message
        );
    }

    /*
     * V2 extension
     */

    if (
        msg.viewOnceMessageV2Extension
            ?.message
    ) {
        return (
            msg.viewOnceMessageV2Extension
                .message
        );
    }

    return null;
}

async function handleViewOnce(
    session,
    message
) {
    if (
        !session.antiViewOnce &&
        !session.viewOnce
    ) {
        return;
    }

    const content =
        getViewOnceMessage(
            message
        );

    if (!content) {
        return;
    }

    const remoteJid =
        message.key?.remoteJid;

    if (!remoteJid) {
        return;
    }

    try {
        /*
         * IMAGE
         */

        if (
            content.imageMessage
        ) {
            const image =
                content.imageMessage;

            const stream =
                await downloadContentFromMessage(
                    image,
                    "image"
                );

            const chunks = [];

            for await (
                const chunk of
                stream
            ) {
                chunks.push(chunk);
            }

            const buffer =
                Buffer.concat(
                    chunks
                );

            await session.sock.sendMessage(
                remoteJid,
                {
                    image: buffer,

                    caption:
                        image.caption ||
                        "👁️ View-once media"
                }
            );

            addLog(
                session.sessionId,
                "👁️ View-once image handled"
            );

            return;
        }

        /*
         * VIDEO
         */

        if (
            content.videoMessage
        ) {
            const video =
                content.videoMessage;

            const stream =
                await downloadContentFromMessage(
                    video,
                    "video"
                );

            const chunks = [];

            for await (
                const chunk of
                stream
            ) {
                chunks.push(chunk);
            }

            const buffer =
                Buffer.concat(
                    chunks
                );

            await session.sock.sendMessage(
                remoteJid,
                {
                    video: buffer,

                    caption:
                        video.caption ||
                        "👁️ View-once media"
                }
            );

            addLog(
                session.sessionId,
                "👁️ View-once video handled"
            );

            return;
        }

        /*
         * AUDIO
         */

        if (
            content.audioMessage
        ) {
            const audio =
                content.audioMessage;

            const stream =
                await downloadContentFromMessage(
                    audio,
                    "audio"
                );

            const chunks = [];

            for await (
                const chunk of
                stream
            ) {
                chunks.push(chunk);
            }

            const buffer =
                Buffer.concat(
                    chunks
                );

            await session.sock.sendMessage(
                remoteJid,
                {
                    audio: buffer,

                    mimetype:
                        audio.mimetype ||
                        "audio/mp4",

                    ptt:
                        !!audio.ptt
                }
            );

            addLog(
                session.sessionId,
                "👁️ View-once audio handled"
            );

            return;
        }

        /*
         * TEXT
         */

        const text =
            getMessageText({
                message: content
            });

        if (text) {
            await reply(
                session.sock,
                remoteJid,
                `👁️ View-once content:\n\n${text}`
            );
        }
    } catch (error) {
        addLog(
            session.sessionId,
            `View-once handling failed: ${error.message}`
        );
    }
}

/*
============================================================
 FEATURE COMMAND CONTROL
============================================================
*/

async function handleFeatureCommand(
    session,
    commandName,
    args,
    message,
    remoteJid,
    owner
) {
    if (
        [
            "antilink",
            "antidelete",
            "antiviewonce",
            "welcome",
            "goodbye",
            "viewonce"
        ].includes(
            commandName
        )
    ) {
        if (!owner) {
            return true;
        }
    }

    const state =
        String(
            args[0] || ""
        ).toLowerCase();

    /*
     * ANTILINK
     */

    if (
        commandName ===
        "antilink"
    ) {
        if (
            ![
                "on",
                "off"
            ].includes(state)
        ) {
            await reply(
                session.sock,
                remoteJid,
                `Usage:\n${PREFIX}antilink on\n${PREFIX}antilink off`
            );

            return true;
        }

        session.antiLink =
            state === "on";

        await updateSession(
            session
        );

        await reply(
            session.sock,
            remoteJid,
            `🔗 Antilink ${
                session.antiLink
                    ? "enabled"
                    : "disabled"
            }.`
        );

        return true;
    }

    /*
     * ANTIDELETE
     */

    if (
        commandName ===
        "antidelete"
    ) {
        if (
            ![
                "on",
                "off"
            ].includes(state)
        ) {
            await reply(
                session.sock,
                remoteJid,
                `Usage:\n${PREFIX}antidelete on\n${PREFIX}antidelete off`
            );

            return true;
        }

        session.antiDelete =
            state === "on";

        await updateSession(
            session
        );

        await reply(
            session.sock,
            remoteJid,
            `🗑️ Antidelete ${
                session.antiDelete
                    ? "enabled"
                    : "disabled"
            }.`
        );

        return true;
    }

    /*
     * ANTIVIEWONCE
     */

    if (
        commandName ===
        "antiviewonce"
    ) {
        if (
            ![
                "on",
                "off"
            ].includes(state)
        ) {
            await reply(
                session.sock,
                remoteJid,
                `Usage:\n${PREFIX}antiviewonce on\n${PREFIX}antiviewonce off`
            );

            return true;
        }

        session.antiViewOnce =
            state === "on";

        await updateSession(
            session
        );

        await reply(
            session.sock,
            remoteJid,
            `👁️ Anti-view-once ${
                session.antiViewOnce
                    ? "enabled"
                    : "disabled"
            }.`
        );

        return true;
    }

    /*
     * VIEWONCE
     */

    if (
        commandName ===
        "viewonce"
    ) {
        session.viewOnce =
            true;

        await updateSession(
            session
        );

        await reply(
            session.sock,
            remoteJid,
            "👁️ View-once handling enabled."
        );

        return true;
    }

    /*
     * WELCOME
     */

    if (
        commandName ===
        "welcome"
    ) {
        if (
            ![
                "on",
                "off"
            ].includes(state)
        ) {
            await reply(
                session.sock,
                remoteJid,
                `Usage:\n${PREFIX}welcome on\n${PREFIX}welcome off`
            );

            return true;
        }

        session.welcome =
            state === "on";

        await updateSession(
            session
        );

        await reply(
            session.sock,
            remoteJid,
            `👋 Welcome ${
                session.welcome
                    ? "enabled"
                    : "disabled"
            }.`
        );

        return true;
    }

    /*
     * GOODBYE
     */

    if (
        commandName ===
        "goodbye"
    ) {
        if (
            ![
                "on",
                "off"
            ].includes(state)
        ) {
            await reply(
                session.sock,
                remoteJid,
                `Usage:\n${PREFIX}goodbye on\n${PREFIX}goodbye off`
            );

            return true;
        }

        session.goodbye =
            state === "on";

        await updateSession(
            session
        );

        await reply(
            session.sock,
            remoteJid,
            `👋 Goodbye ${
                session.goodbye
                    ? "enabled"
                    : "disabled"
            }.`
        );

        return true;
    }

    return false;
}

/*
============================================================
 COMMAND CONTEXT
============================================================
*/

function buildCommandContext(
    session,
    message,
    remoteJid,
    args,
    body,
    commandName,
    owner
) {
    return {
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
            args.join(" "),

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

        phone:
            session.phone,

        isOwner:
            owner,

        owner,

        mode:
            session.mode,

        reply: async (
            response
        ) =>
            reply(
                session.sock,
                remoteJid,
                response,
                message
            ),

        sendMessage:
            async (
                jid,
                content
            ) =>
                session.sock.sendMessage(
                    jid,
                    content
                ),

        addLog:
            (message) =>
                addLog(
                    session.sessionId,
                    message
                ),

        reloadCommands,

        getSession:
            () =>
                sessionSummary(
                    session
                )
    };
}

/*
============================================================
 RUN COMMAND
============================================================
*/

async function runCommand(
    session,
    command,
    context
) {
    if (
        typeof command ===
        "function"
    ) {
        return command(
            context
        );
    }

    if (
        typeof command.execute ===
        "function"
    ) {
        return command.execute(
            context
        );
    }

    if (
        typeof command.run ===
        "function"
    ) {
        return command.run(
            context
        );
    }

    if (
        typeof command.handler ===
        "function"
    ) {
        return command.handler(
            context
        );
    }

    return null;
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

    /*
     * Store message BEFORE checking
     * fromMe so antidelete can work.
     */

    storeMessage(
        session,
        message
    );

    /*
     * View-once handling
     */

    if (
        getViewOnceMessage(
            message
        )
    ) {
        await handleViewOnce(
            session,
            message
        );
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

    session.messages++;

    session.lastSeen =
        now();

    await updateSession(
        session
    );

    /*
     * Antilink
     */

    if (
        text &&
        await handleAntiLink(
            session,
            message,
            text
        )
    ) {
        return;
    }

    if (!text) {
        return;
    }

    /*
     * Only commands from here.
     */

    if (
        !text.startsWith(
            PREFIX
        )
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

    const owner =
        isOwner(
            message.key?.participant ||
            message.key?.remoteJid,
            session
        );

    /*
     * Built-in feature commands
     */

    const featureHandled =
        await handleFeatureCommand(
            session,
            commandName,
            args,
            message,
            remoteJid,
            owner
        );

    if (
        featureHandled
    ) {
        return;
    }

    /*
     * PING
     */

    if (
        commandName ===
        "test_ping"
    ) {
        await reply(
            session.sock,
            remoteJid,
            `🏓 ${BOT_NAME} online!\n\n⏱ ${Math.floor(process.uptime())} seconds`
        );

        return;
    }

    /*
     * ALIVE
     */

    if (
        commandName ===
        "test_alive"
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

    /*
     * SESSION
     */

    if (
        commandName ===
        "session"
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

    /*
     * STATUS
     */

    if (
        commandName ===
        "status"
    ) {
        await reply(
            session.sock,
            remoteJid,
`🤖 ${BOT_NAME}

Status:
${
    session.connected
        ? "ONLINE"
        : "OFFLINE"
}

Mode:
${session.mode}

Messages:
${session.messages}

Commands:
${session.commandCount}

Reconnects:
${session.reconnects}

Features:

🔗 Antilink:
${session.antiLink ? "ON" : "OFF"}

🗑️ Antidelete:
${session.antiDelete ? "ON" : "OFF"}

👁️ Antiviewonce:
${session.antiViewOnce ? "ON" : "OFF"}

👋 Welcome:
${session.welcome ? "ON" : "OFF"}

👋 Goodbye:
${session.goodbye ? "ON" : "OFF"}`
        );

        return;
    }

    /*
     * MODE
     */

    if (
        commandName ===
        "mode"
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
            ].includes(
                newMode
            )
        ) {
            await reply(
                session.sock,
                remoteJid,
                `Usage:\n${PREFIX}mode public\n${PREFIX}mode private`
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

    /*
     * MENU
     */

    if (
        commandName ===
            "test" ||
        commandName ===
            "test1"
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

FEATURES

${PREFIX}antilink on
${PREFIX}antilink off

${PREFIX}antidelete on
${PREFIX}antidelete off

${PREFIX}antiviewonce on
${PREFIX}antiviewonce off

${PREFIX}viewonce

${PREFIX}welcome on
${PREFIX}welcome off

${PREFIX}goodbye on
${PREFIX}goodbye off

OWNER

${PREFIX}mode public
${PREFIX}mode private

╰━━━━━━━━━━━━━━━━╯`
        );

        return;
    }

    /*
     * PRIVATE MODE
     */

    if (
        session.mode ===
            "private" &&
        !owner
    ) {
        return;
    }

    /*
     * FIND COMMAND FROM
     * ~/bot/commands
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

    const context =
        buildCommandContext(
            session,
            message,
            remoteJid,
            args,
            body,
            commandName,
            owner
        );

    try {
        await runCommand(
            session,
            command,
            context
        );

        addLog(
            session.sessionId,
            `✅ Command executed: ${PREFIX}${commandName}`
        );
    } catch (error) {
        addLog(
            session.sessionId,
            `❌ Command ${commandName} failed: ${error.message}`
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
 GROUP WELCOME / GOODBYE
============================================================
*/

async function handleGroupParticipants(
    session,
    update
) {
    if (
        !session.sock
    ) {
        return;
    }

    const groupJid =
        update.id;

    if (!groupJid) {
        return;
    }

    const participants =
        update.participants ||
        [];

    /*
     * Find command modules.
     */

    const welcomeCommand =
        loadedCommands.get(
            "welcome"
        );

    const goodbyeCommand =
        loadedCommands.get(
            "goodbye"
        );

    /*
     * JOIN
     */

    if (
        update.action ===
        "add"
    ) {
        if (
            !session.welcome
        ) {
            return;
        }

        for (
            const participant of
            participants
        ) {
            try {
                /*
                 * If a custom
                 * welcome.js exists,
                 * let it handle the event.
                 */

                if (
                    welcomeCommand
                ) {
                    const context = {
                        sock:
                            session.sock,

                        client:
                            session.sock,

                        session,

                        jid:
                            groupJid,

                        participant,

                        participants,

                        action:
                            "add",

                        update,

                        isOwner:
                            false,

                        owner:
                            false,

                        command:
                            "welcome",

                        prefix:
                            PREFIX,

                        botName:
                            BOT_NAME,

                        phone:
                            session.phone,

                        sessionId:
                            session.sessionId,

                        reply: async (
                            response
                        ) =>
                            reply(
                                session.sock,
                                groupJid,
                                response
                            ),

                        sendMessage:
                            async (
                                jid,
                                content
                            ) =>
                                session.sock
                                    .sendMessage(
                                        jid,
                                        content
                                    ),

                        addLog:
                            (msg) =>
                                addLog(
                                    session.sessionId,
                                    msg
                                )
                    };

                    await runCommand(
                        session,
                        welcomeCommand,
                        context
                    );

                    continue;
                }

                /*
                 * Default welcome
                 */

                await session.sock.sendMessage(
                    groupJid,
                    {
                        text:
`👋 *WELCOME!*

Welcome @${String(
    participant
).split("@")[0]}

🤖 ${BOT_NAME}
⚡ Bringing AI to your fingertips`,
                        mentions: [
                            participant
                        ]
                    }
                );

                addLog(
                    session.sessionId,
                    `👋 Welcome sent to ${participant}`
                );
            } catch (
                error
            ) {
                addLog(
                    session.sessionId,
                    `Welcome failed: ${error.message}`
                );
            }
        }

        return;
    }

    /*
     * LEAVE / REMOVE
     */

    if (
        update.action ===
            "remove" ||
        update.action ===
            "leave"
    ) {
        if (
            !session.goodbye
        ) {
            return;
        }

        for (
            const participant of
            participants
        ) {
            try {
                /*
                 * Custom goodbye.js
                 */

                if (
                    goodbyeCommand
                ) {
                    const context = {
                        sock:
                            session.sock,

                        client:
                            session.sock,

                        session,

                        jid:
                            groupJid,

                        participant,

                        participants,

                        action:
                            "remove",

                        update,

                        command:
                            "goodbye",

                        prefix:
                            PREFIX,

                        botName:
                            BOT_NAME,

                        phone:
                            session.phone,

                        sessionId:
                            session.sessionId,

                        reply: async (
                            response
                        ) =>
                            reply(
                                session.sock,
                                groupJid,
                                response
                            ),

                        sendMessage:
                            async (
                                jid,
                                content
                            ) =>
                                session.sock
                                    .sendMessage(
                                        jid,
                                        content
                                    ),

                        addLog:
                            (msg) =>
                                addLog(
                                    session.sessionId,
                                    msg
                                )
                    };

                    await runCommand(
                        session,
                        goodbyeCommand,
                        context
                    );

                    continue;
                }

                /*
                 * Default goodbye
                 */

                await session.sock.sendMessage(
                    groupJid,
                    {
                        text:
`👋 *GOODBYE!*

@${String(
    participant
).split("@")[0]} has left the group.

🤖 ${BOT_NAME}`,
                        mentions: [
                            participant
                        ]
                    }
                );

                addLog(
                    session.sessionId,
                    `👋 Goodbye sent to ${participant}`
                );
            } catch (
                error
            ) {
                addLog(
                    session.sessionId,
                    `Goodbye failed: ${error.message}`
                );
            }
        }
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
        connection ===
        "connecting"
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

    /*
     * OPEN
     */

    if (
        connection ===
        "open"
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

        /*
         * Absolutely no pairing
         * code generation here.
         */

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

        addLog(
            session.sessionId,
            `📦 ${loadedCommands.size} commands available`
        );

        await sendSessionId(
            session
        );

        return;
    }

    /*
     * CLOSE
     */

    if (
        connection ===
        "close"
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

        if (
            session.reconnectTimer
        ) {
            clearTimeout(
                session.reconnectTimer
            );
        }

        session.reconnects++;

        const delay =
            statusCode ===
            DisconnectReason.restartRequired
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

                        await connectSession(
                            session
                        );
                    } catch (
                        error
                    ) {
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

    /*
     * Expiration
     */

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

    /*
     * Already connected
     */

    if (
        session.sock &&
        session.connected
    ) {
        return session;
    }

    /*
     * Auth folder
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
     * IMPORTANT:
     *
     * main.js does NOT call
     * requestPairingCode().
     *
     * The web pairing system must
     * place valid Baileys credentials
     * in this auth folder.
     */

    if (
        !state.creds.registered
    ) {
        session.status =
            "waiting_for_pairing";

        await updateSession(
            session
        );

        addLog(
            session.sessionId,
            "🔐 No registered credentials found."
        );

        addLog(
            session.sessionId,
            "🌐 Waiting for the web pairing system to authenticate this session."
        );
    } else {
        addLog(
            session.sessionId,
            "🔐 Existing WhatsApp credentials found."
        );
    }

    /*
     * SOCKET
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
     * CREDENTIALS
     */

    sock.ev.on(
        "creds.update",
        async () => {
            try {
                await saveCreds();
            } catch (
                error
            ) {
                addLog(
                    session.sessionId,
                    `Credential save failed: ${error.message}`
                );
            }
        }
    );

    /*
     * CONNECTION
     */

    sock.ev.on(
        "connection.update",
        async (update) => {
            try {
                await handleConnectionUpdate(
                    session,
                    update
                );
            } catch (
                error
            ) {
                addLog(
                    session.sessionId,
                    `Connection handler error: ${error.message}`
                );
            }
        }
    );

    /*
     * MESSAGES
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
                } catch (
                    error
                ) {
                    addLog(
                        session.sessionId,
                        `Message handler error: ${error.message}`
                    );
                }
            }
        }
    );

    /*
     * MESSAGE UPDATES
     *
     * Used by antidelete.
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
                try {
                    /*
                     * Deleted message
                     * usually has message:null.
                     */

                    if (
                        item.update
                            ?.message ===
                        null
                    ) {
                        await handleDeletedMessage(
                            session,
                            item
                        );
                    }
                } catch (
                    error
                ) {
                    addLog(
                        session.sessionId,
                        `Antidelete event failed: ${error.message}`
                    );
                }
            }
        }
    );

    /*
     * GROUP PARTICIPANTS
     */

    sock.ev.on(
        "group-participants.update",
        async (update) => {
            try {
                await handleGroupParticipants(
                    session,
                    update
                );
            } catch (
                error
            ) {
                addLog(
                    session.sessionId,
                    `Group event failed: ${error.message}`
                );
            }
        }
    );

    /*
     * NO PAIRING CODE.
     */

    if (
        !state.creds.registered
    ) {
        pairingCodeDisabled(
            session
        );
    }

    session.status =
        state.creds.registered
            ? "connecting"
            : "waiting_for_pairing";

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
     * Use the Session ID supplied
     * by the web deployment page.
     *
     * A fallback is kept for API
     * compatibility, but NO pairing
     * code is ever generated.
     */

    const sessionId =
        String(
            options.sessionId ||
            generateSessionId()
        );

    /*
     * Prevent duplicate session.
     */

    if (
        sessions.has(
            sessionId
        )
    ) {
        const existing =
            sessions.get(
                sessionId
            );

        return {
            success: true,
            existing: true,
            ...sessionSummary(
                existing
            )
        };
    }

    /*
     * Prevent duplicate number.
     */

    for (
        const existing of
        sessions.values()
    ) {
        if (
            existing.phone ===
                phone &&
            !existing.stopping
        ) {
            return {
                success: true,

                existing: true,

                ...sessionSummary(
                    existing
                )
            };
        }
    }

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
                randomId(12),

            features:
                options.features
        });

    sessions.set(
        sessionId,
        session
    );

    addLog(
        sessionId,
        `🚀 Deployment created for +${phone}`
    );

    addLog(
        sessionId,
        `🆔 Session ID: ${sessionId}`
    );

    addLog(
        sessionId,
        `📅 Duration: ${session.days} days`
    );

    await updateSession(
        session
    );

    /*
     * Load latest commands before
     * the deployed bot starts.
     */

    loadCommands();

    try {
        await connectSession(
            session
        );
    } catch (
        error
    ) {
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

    return {
        success: true,

        existing: false,

        sessionId:
            session.sessionId,

        phone:
            session.phone,

        pairId:
            session.pairId,

        status:
            session.status,

        connected:
            session.connected,

        expireAt:
            session.expireAt,

        commands:
            loadedCommands.size
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

    try {
        session.sock?.end(
            undefined
        );
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
                    saved.pairId,

                features:
                    saved.features
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

    session.status =
        "restarting";

    loadCommands();

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
 RENEW SESSION
============================================================
*/

async function renewSession(
    sessionId,
    days
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

    const extraDays =
        Number(days);

    if (
        !Number.isFinite(
            extraDays
        ) ||
        extraDays <= 0
    ) {
        throw new Error(
            "Invalid renewal days"
        );
    }

    const base =
        session.expireAt &&
        new Date(
            session.expireAt
        ) > new Date()
            ? new Date(
                  session.expireAt
              )
            : new Date();

    session.expireAt =
        new Date(
            base.getTime() +
            extraDays *
                24 *
                60 *
                60 *
                1000
        );

    session.days +=
        extraDays;

    if (
        session.status ===
        "expired"
    ) {
        session.status =
            "online";

        session.stopping =
            false;
    }

    await updateSession(
        session
    );

    addLog(
        sessionId,
        `♻️ Session renewed for ${extraDays} additional days`
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
     * Delete auth folder.
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

    if (mongoReady) {
        try {
            deployments =
                await Deployment
                    .find({})
                    .lean();
        } catch {}
    }

    if (
        deployments.length === 0
    ) {
        const db =
            readLocalDatabase();

        deployments =
            Object.values(db);
    }

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
                        randomId(12),

                    features:
                        saved.features
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

            /*
             * Commands are loaded before
             * restored session starts.
             */

            loadCommands();

            await connectSession(
                session
            );

            await new Promise(
                (resolve) =>
                    setTimeout(
                        resolve,
                        1000
                    )
            );
        } catch (
            error
        ) {
            console.error(
                `[RESTORE] Failed ${saved.sessionId}:`,
                error.message
            );
        }
    }
}

/*
============================================================
 EXPIRATION
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
        () =>
            Array.from(
                sessions.values()
            ).map(
                sessionSummary
            ),

    getAll:
        getAllDeployments,

    getLogs:
        getLogs,

    stop:
        stopSession,

    restart:
        restartSession,

    renew:
        renewSession,

    remove:
        removeSession,

    reloadCommands:
        reloadCommands,

    commandCount:
        () =>
            loadedCommands.size,

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
                        "waiting_for_pairing"
                ).length,

            commands:
                loadedCommands.size
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
    } catch (
        error
    ) {
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
        "       WEB PAIRING AUTH"
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
        "Pairing Code: DISABLED"
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
     * Expiration
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

    console.log(
        `[COMMANDS] ${loadedCommands.size} commands available`
    );

    console.log(
        "[PAIRING] Waiting for web pairing/authentication"
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

    renewSession,

    removeSession,

    getAllDeployments,

    findDeployment,

    getLogs,

    addLog,

    generateSessionId,

    loadCommands,

    reloadCommands
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
