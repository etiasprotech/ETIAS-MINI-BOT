"use strict";

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

const ROOT = __dirname;

const PORT =
    Number(process.env.PORT || 3000);

const AUTH_DIR =
    path.join(ROOT, "auth");

const USERS_AUTH_DIR =
    path.join(AUTH_DIR, "users");

const DATA_DIR =
    path.join(ROOT, "data");

const LOG_DIR =
    path.join(ROOT, "logs");

const COMMANDS_DIR =
    path.join(ROOT, "commands");

const MEDIA_DIR =
    path.join(ROOT, "media");

const DEPLOYMENTS_FILE =
    path.join(
        DATA_DIR,
        "deployed.json"
    );

const SESSION_PREFIX =
    "ETIAS-MINI-BOT~";

const DEFAULT_DAYS =
    Number(process.env.DEFAULT_DAYS || 30);

const MONGO_URI =
    process.env.MONGO_URI ||
    process.env.MONGODB_URI ||
    "";

const logger =
    pino({
        level:
            process.env.LOG_LEVEL ||
            "info"
    });

/* ============================================================
   DIRECTORIES
============================================================ */

for (const dir of [
    AUTH_DIR,
    USERS_AUTH_DIR,
    DATA_DIR,
    LOG_DIR,
    COMMANDS_DIR,
    MEDIA_DIR
]) {
    fs.mkdirSync(dir, {
        recursive: true
    });
}

/* ============================================================
   RUNTIME STATE
============================================================ */

const sessions = new Map();

const commands = new Map();

const reconnectTimers = new Map();

/* ============================================================
   MONGO
============================================================ */

const DeploymentSchema =
    new mongoose.Schema({

        sessionId: {
            type: String,
            unique: true,
            index: true
        },

        phone: String,

        jid: String,

        userId: String,

        pairId: String,

        status: String,

        connected: Boolean,

        mode: {
            type: String,
            default: "public"
        },

        days: Number,

        expireAt: Date,

        authFolder: String,

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

        createdAt: Date,

        lastSeen: Date

    });

const Deployment =
    mongoose.models.ETIASDeployment ||
    mongoose.model(
        "ETIASDeployment",
        DeploymentSchema
    );

async function connectMongo() {

    if (!MONGO_URI) {

        logger.warn(
            "[MONGO] MONGO_URI not configured"
        );

        return false;
    }

    try {

        await mongoose.connect(
            MONGO_URI,
            {
                serverSelectionTimeoutMS: 10000
            }
        );

        logger.info(
            "[MONGO] Connected"
        );

        return true;

    } catch (error) {

        logger.error(
            {
                error: error.message
            },
            "[MONGO] Connection failed"
        );

        return false;
    }
}

/* ============================================================
   JSON STORAGE
============================================================ */

function readDeployments() {

    try {

        if (!fs.existsSync(
            DEPLOYMENTS_FILE
        )) {
            return [];
        }

        const data =
            JSON.parse(
                fs.readFileSync(
                    DEPLOYMENTS_FILE,
                    "utf8"
                )
            );

        return Array.isArray(data)
            ? data
            : [];

    } catch {

        return [];
    }
}

async function writeDeployments(
    deployments
) {

    await fsp.mkdir(
        DATA_DIR,
        {
            recursive: true
        }
    );

    await fsp.writeFile(
        DEPLOYMENTS_FILE,
        JSON.stringify(
            deployments,
            null,
            2
        ),
        "utf8"
    );
}

/* ============================================================
   SESSION VALIDATION
============================================================ */

function normalizeSessionId(
    sessionId
) {
    return String(
        sessionId || ""
    )
        .trim()
        .toUpperCase();
}

function isValidSessionId(
    sessionId
) {

    return new RegExp(
        `^${SESSION_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\d{8}$`
    ).test(
        normalizeSessionId(sessionId)
    );
}

function normalizePhone(phone) {

    return String(
        phone || ""
    )
        .replace(/[^\d]/g, "")
        .replace(/^00/, "");
}

function phoneFromJid(jid) {

    if (!jid) {
        return null;
    }

    return normalizePhone(
        String(jid).split("@")[0]
    );
}

/* ============================================================
   AUTH FOLDER
============================================================ */

function sessionFolderName(
    sessionId
) {

    const id =
        normalizeSessionId(
            sessionId
        );

    if (!isValidSessionId(id)) {

        throw new Error(
            "Invalid Session ID"
        );
    }

    return id.replace(
        /[^A-Z0-9_-]/gi,
        "_"
    );
}

function safeSessionFolder(
    sessionId
) {

    return path.join(
        USERS_AUTH_DIR,
        sessionFolderName(sessionId)
    );
}

function isInsideDirectory(
    child,
    parent
) {

    const childPath =
        path.resolve(child);

    const parentPath =
        path.resolve(parent);

    return (
        childPath === parentPath ||
        childPath.startsWith(
            parentPath + path.sep
        )
    );
}

function resolveAuthFolder(
    sessionId,
    suppliedFolder
) {

    const id =
        normalizeSessionId(
            sessionId
        );

    const expected =
        safeSessionFolder(id);

    const candidates = [];

    if (suppliedFolder) {

        const supplied =
            path.resolve(
                String(
                    suppliedFolder
                )
            );

        /*
         * Only allow folders belonging to this
         * bot's auth directory.
         */
        if (
            isInsideDirectory(
                supplied,
                AUTH_DIR
            )
        ) {
            candidates.push(
                supplied
            );
        }
    }

    candidates.push(expected);

    /*
     * Legacy exact location.
     */
    candidates.push(
        path.join(
            AUTH_DIR,
            sessionFolderName(id)
        )
    );

    for (const candidate of candidates) {

        if (
            fs.existsSync(
                path.join(
                    candidate,
                    "creds.json"
                )
            )
        ) {

            return candidate;
        }
    }

    /*
     * IMPORTANT:
     * Do NOT scan every user's folder.
     * That could attach the wrong WhatsApp account.
     */
    return null;
}

function hasAuthCredentials(
    folder
) {

    return Boolean(
        folder &&
        fs.existsSync(
            path.join(
                folder,
                "creds.json"
            )
        )
    );
}

/* ============================================================
   LOGGING
============================================================ */

function addLog(
    sessionId,
    message
) {

    const line =
        `[${new Date().toISOString()}] ` +
        `[${sessionId}] ` +
        `${message}`;

    logger.info(line);

    try {

        fs.appendFileSync(
            path.join(
                LOG_DIR,
                "bot.log"
            ),
            line + "\n"
        );

    } catch {}
}

function getLogs(
    sessionId
) {

    try {

        const file =
            path.join(
                LOG_DIR,
                "bot.log"
            );

        if (!fs.existsSync(file)) {
            return [];
        }

        const lines =
            fs.readFileSync(
                file,
                "utf8"
            )
            .split("\n")
            .filter(Boolean);

        if (!sessionId) {
            return lines.slice(-500);
        }

        return lines
            .filter(
                line =>
                    line.includes(
                        `[${sessionId}]`
                    )
            )
            .slice(-500);

    } catch {

        return [];
    }
}

/* ============================================================
   COMMAND LOADER
============================================================ */

async function loadCommands() {

    commands.clear();

    if (!fs.existsSync(
        COMMANDS_DIR
    )) {
        return;
    }

    const files =
        await fsp.readdir(
            COMMANDS_DIR
        );

    for (const file of files) {

        if (
            !file.endsWith(".js") ||
            file.startsWith("_")
        ) {
            continue;
        }

        const fullPath =
            path.join(
                COMMANDS_DIR,
                file
            );

        try {

            delete require.cache[
                require.resolve(fullPath)
            ];

            const command =
                require(fullPath);

            if (
                !command ||
                typeof command !== "object"
            ) {
                continue;
            }

            const name =
                String(
                    command.name ||
                    path.basename(
                        file,
                        ".js"
                    )
                )
                .toLowerCase();

            commands.set(
                name,
                command
            );

        } catch (error) {

            logger.error(
                {
                    file,
                    error:
                        error.message
                },
                "[COMMAND] Failed to load"
            );
        }
    }

    logger.info(
        `[COMMANDS] ${commands.size} commands loaded`
    );
}

/* ============================================================
   DEPLOYMENT STORAGE
============================================================ */

async function saveDeployment(
    deployment
) {

    const deployments =
        readDeployments();

    const index =
        deployments.findIndex(
            item =>
                normalizeSessionId(
                    item.sessionId
                ) ===
                normalizeSessionId(
                    deployment.sessionId
                )
        );

    const clean = {
        ...deployment,
        sessionId:
            normalizeSessionId(
                deployment.sessionId
            )
    };

    if (index === -1) {
        deployments.push(clean);
    } else {
        deployments[index] = {
            ...deployments[index],
            ...clean
        };
    }

    await writeDeployments(
        deployments
    );

    /*
     * MongoDB persistence.
     */
    if (
        mongoose.connection.readyState === 1
    ) {

        try {

            await Deployment.findOneAndUpdate(

                {
                    sessionId:
                        clean.sessionId
                },

                {
                    $set: {
                        ...clean,
                        expireAt:
                            clean.expireAt
                                ? new Date(
                                    clean.expireAt
                                )
                                : null
                    }
                },

                {
                    upsert: true,
                    new: true,
                    setDefaultsOnInsert: true
                }
            );

        } catch (error) {

            logger.warn(
                {
                    error:
                        error.message
                },
                "[MONGO] Deployment save failed"
            );
        }
    }

    return clean;
}

function getDeployment(
    sessionId
) {

    const id =
        normalizeSessionId(
            sessionId
        );

    return readDeployments()
        .find(
            item =>
                normalizeSessionId(
                    item.sessionId
                ) === id
        );
}

/* ============================================================
   SEND SESSION INFO
============================================================ */

async function sendSessionInfo(
    sock,
    jid,
    sessionId
) {

    if (!sock || !jid) {
        return false;
    }

    try {

        await sock.sendMessage(
            jid,
            {
                text:
                    `*ETIAS-MINI-BOT*\n\n` +
                    `Your Session ID:\n\n` +
                    `\`${sessionId}\`\n\n` +
                    `Use this Session ID on the deployment panel.\n\n` +
                    `Bringing AI to your fingertips.`
            }
        );

        return true;

    } catch (error) {

        addLog(
            sessionId,
            `Failed to send Session ID: ${error.message}`
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
        normalizeSessionId(
            sessionId
        );

    if (!isValidSessionId(id)) {

        throw new Error(
            "Invalid Session ID"
        );
    }

    const existing =
        sessions.get(id);

    if (
        existing &&
        existing.sock &&
        existing.connected !== false
    ) {

        return existing.sock;
    }

    const authFolder =
        resolveAuthFolder(
            id,
            options.authFolder
        );

    if (!authFolder) {

        throw new Error(
            `Authentication folder not found for ${id}`
        );
    }

    if (!hasAuthCredentials(
        authFolder
    )) {

        throw new Error(
            `creds.json not found for ${id}`
        );
    }

    const {
        state,
        saveCreds
    } =
        await useMultiFileAuthState(
            authFolder
        );

    const deployment =
        getDeployment(id);

    const userJid =
        options.jid ||
        deployment?.jid ||
        null;

    const phone =
        normalizePhone(
            options.phone ||
            deployment?.phone ||
            phoneFromJid(userJid)
        );

    const session = {

        sessionId: id,

        sock: null,

        userJid,

        phone,

        pairId:
            options.pairingId ||
            deployment?.pairingId ||
            null,

        authFolder,

        status: "connecting",

        connected: false,

        mode:
            deployment?.mode ||
            options.mode ||
            "public",

        days:
            Number(
                options.days ||
                deployment?.days ||
                DEFAULT_DAYS
            ),

        expireAt:
            options.expireAt ||
            deployment?.expireAt ||
            null,

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
            new Date().toISOString(),

        sessionMessageSent:
            Boolean(
                deployment?.sessionMessageSent
            )

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

            logger:
                pino({
                    level: "silent"
                }),

            printQRInTerminal: false,

            markOnlineOnConnect: true,

            syncFullHistory: false,

            generateHighQualityLinkPreview: false

        });

    session.sock = sock;

    sock.ev.on(
        "creds.update",
        async () => {

            try {

                await saveCreds();

            } catch (error) {

                addLog(
                    id,
                    `Failed to save credentials: ${error.message}`
                );
            }
        }
    );

    /* ========================================================
       CONNECTION
    ======================================================== */

    sock.ev.on(
        "connection.update",
        async update => {

            const {
                connection,
                lastDisconnect
            } = update;

            if (connection === "connecting") {

                session.status =
                    "connecting";

                session.connected =
                    false;

                addLog(
                    id,
                    "Connecting to WhatsApp..."
                );

                return;
            }

            if (connection === "open") {

                session.status =
                    "connected";

                session.connected =
                    true;

                session.lastSeen =
                    new Date().toISOString();

                session.userJid =
                    sock.user?.id ||
                    session.userJid ||
                    null;

                session.phone =
                    phoneFromJid(
                        session.userJid
                    ) ||
                    session.phone;

                clearReconnectTimer(id);

                addLog(
                    id,
                    `Connected as ${session.userJid || session.phone}`
                );

                await saveDeployment({

                    sessionId: id,

                    phone:
                        session.phone,

                    jid:
                        session.userJid,

                    pairId:
                        session.pairId,

                    status:
                        "connected",

                    connected: true,

                    mode:
                        session.mode,

                    days:
                        session.days,

                    expireAt:
                        session.expireAt,

                    authFolder:
                        session.authFolder,

                    reconnects:
                        session.reconnects,

                    messages:
                        session.messages,

                    commandCount:
                        session.commandCount,

                    createdAt:
                        session.createdAt,

                    lastSeen:
                        session.lastSeen,

                    sessionMessageSent:
                        session.sessionMessageSent
                });

                /*
                 * If this was the first successful
                 * connection and we know the JID,
                 * send the Session ID.
                 */
                if (
                    !session.sessionMessageSent &&
                    session.userJid
                ) {

                    const sent =
                        await sendSessionInfo(
                            sock,
                            session.userJid,
                            id
                        );

                    if (sent) {

                        session.sessionMessageSent =
                            true;

                        await saveDeployment({

                            sessionId: id,

                            phone:
                                session.phone,

                            jid:
                                session.userJid,

                            pairId:
                                session.pairId,

                            status:
                                "connected",

                            connected: true,

                            mode:
                                session.mode,

                            days:
                                session.days,

                            expireAt:
                                session.expireAt,

                            authFolder:
                                session.authFolder,

                            reconnects:
                                session.reconnects,

                            messages:
                                session.messages,

                            commandCount:
                                session.commandCount,

                            createdAt:
                                session.createdAt,

                            lastSeen:
                                session.lastSeen,

                            sessionMessageSent: true
                        });
                    }
                }

                return;
            }

            if (connection === "close") {

                session.connected =
                    false;

                session.status =
                    "disconnected";

                session.lastSeen =
                    new Date().toISOString();

                /*
                 * IMPORTANT:
                 * Remove the closed socket before
                 * reconnecting.
                 */
                session.sock = null;

                const statusCode =
                    lastDisconnect
                        ?.error
                        ?.output
                        ?.statusCode;

                const loggedOut =
                    statusCode ===
                    DisconnectReason.loggedOut;

                const badSession =
                    statusCode ===
                    DisconnectReason.badSession;

                await saveDeployment({

                    sessionId: id,

                    phone:
                        session.phone,

                    jid:
                        session.userJid,

                    pairId:
                        session.pairId,

                    status:
                        loggedOut ||
                        badSession
                            ? "logged_out"
                            : "disconnected",

                    connected: false,

                    mode:
                        session.mode,

                    days:
                        session.days,

                    expireAt:
                        session.expireAt,

                    authFolder:
                        session.authFolder,

                    reconnects:
                        session.reconnects,

                    messages:
                        session.messages,

                    commandCount:
                        session.commandCount,

                    createdAt:
                        session.createdAt,

                    lastSeen:
                        session.lastSeen,

                    sessionMessageSent:
                        session.sessionMessageSent
                });

                addLog(
                    id,
                    `Connection closed. code=${statusCode || "unknown"}`
                );

                if (
                    loggedOut ||
                    badSession
                ) {

                    session.status =
                        loggedOut
                            ? "logged_out"
                            : "bad_session";

                    return;
                }

                scheduleReconnect(
                    id
                );
            }
        }
    );

    /* ========================================================
       MESSAGES
    ======================================================== */

    sock.ev.on(
        "messages.upsert",
        async event => {

            try {

                if (!event?.messages) {
                    return;
                }

                for (const message of event.messages) {

                    await processMessage(
                        id,
                        message
                    );
                }

            } catch (error) {

                addLog(
                    id,
                    `Message handler error: ${error.message}`
                );
            }
        }
    );

    /* ========================================================
       GROUP PARTICIPANTS
    ======================================================== */

    sock.ev.on(
        "group-participants.update",
        async event => {

            try {

                await handleGroupParticipants(
                    id,
                    event
                );

            } catch (error) {

                addLog(
                    id,
                    `Group event error: ${error.message}`
                );
            }
        }
    );

    return sock;
}

/* ============================================================
   RECONNECT
============================================================ */

function clearReconnectTimer(
    sessionId
) {

    const timer =
        reconnectTimers.get(
            sessionId
        );

    if (timer) {

        clearTimeout(timer);

        reconnectTimers.delete(
            sessionId
        );
    }
}

function scheduleReconnect(
    sessionId
) {

    const id =
        normalizeSessionId(
            sessionId
        );

    if (
        reconnectTimers.has(id)
    ) {
        return;
    }

    const session =
        sessions.get(id);

    if (!session) {
        return;
    }

    session.reconnects =
        Number(
            session.reconnects || 0
        ) + 1;

    const delay =
        Math.min(
            5000 *
            Math.max(
                session.reconnects,
                1
            ),
            60000
        );

    addLog(
        id,
        `Reconnecting in ${delay}ms...`
    );

    const timer =
        setTimeout(
            async () => {

                reconnectTimers.delete(
                    id
                );

                const current =
                    sessions.get(id);

                if (!current) {
                    return;
                }

                try {

                    current.status =
                        "reconnecting";

                    await createSocket(
                        id,
                        {
                            authFolder:
                                current.authFolder,

                            phone:
                                current.phone,

                            jid:
                                current.userJid,

                            pairingId:
                                current.pairId,

                            days:
                                current.days,

                            expireAt:
                                current.expireAt
                        }
                    );

                } catch (error) {

                    addLog(
                        id,
                        `Reconnect failed: ${error.message}`
                    );

                    scheduleReconnect(
                        id
                    );
                }

            },
            delay
        );

    reconnectTimers.set(
        id,
        timer
    );
}

/* ============================================================
   MESSAGE HELPERS
============================================================ */

function getMessageText(
    message
) {

    const msg =
        message?.message;

    if (!msg) {
        return "";
    }

    return (
        msg.conversation ||
        msg.extendedTextMessage?.text ||
        msg.imageMessage?.caption ||
        msg.videoMessage?.caption ||
        msg.documentMessage?.caption ||
        ""
    );
}

function getMessageChat(
    message
) {

    return (
        message?.key?.remoteJid ||
        ""
    );
}

function isGroupJid(
    jid
) {

    return String(
        jid || ""
    ).endsWith("@g.us");
}

/* ============================================================
   BUILT-IN COMMANDS
============================================================ */

async function runBuiltInCommand(
    session,
    message,
    command,
    args
) {

    const sock =
        session.sock;

    const chat =
        getMessageChat(
            message
        );

    switch (command) {

        case "ping":

            await sock.sendMessage(
                chat,
                {
                    text:
                        "🏓 ETIAS-MINI-BOT is online!"
                }
            );

            return true;

        case "alive":

            await sock.sendMessage(
                chat,
                {
                    text:
                        `🤖 *ETIAS-MINI-BOT*\n\n` +
                        `Status: ${session.connected ? "ONLINE" : "OFFLINE"}\n` +
                        `Session: ${session.sessionId}\n` +
                        `Phone: ${session.phone || "Unknown"}`
                }
            );

            return true;

        case "session":

            await sock.sendMessage(
                chat,
                {
                    text:
                        `*SESSION ID*\n\n` +
                        `\`${session.sessionId}\``
                }
            );

            return true;

        case "status":

            await sock.sendMessage(
                chat,
                {
                    text:
                        `*ETIAS STATUS*\n\n` +
                        `Session: ${session.sessionId}\n` +
                        `Connected: ${session.connected}\n` +
                        `Messages: ${session.messages}\n` +
                        `Commands: ${session.commandCount}\n` +
                        `Reconnects: ${session.reconnects}`
                }
            );

            return true;

        case "mode":

            if (
                args[0] &&
                ["public", "private"].includes(
                    args[0].toLowerCase()
                )
            ) {

                session.mode =
                    args[0].toLowerCase();

                await saveDeployment({

                    sessionId:
                        session.sessionId,

                    phone:
                        session.phone,

                    jid:
                        session.userJid,

                    pairId:
                        session.pairId,

                    status:
                        session.status,

                    connected:
                        session.connected,

                    mode:
                        session.mode,

                    days:
                        session.days,

                    expireAt:
                        session.expireAt,

                    authFolder:
                        session.authFolder,

                    reconnects:
                        session.reconnects,

                    messages:
                        session.messages,

                    commandCount:
                        session.commandCount,

                    createdAt:
                        session.createdAt,

                    lastSeen:
                        new Date().toISOString()
                });
            }

            await sock.sendMessage(
                chat,
                {
                    text:
                        `Mode: ${session.mode}`
                }
            );

            return true;

        case "menu":
        case "help":

            await sock.sendMessage(
                chat,
                {
                    text:
                        `*ETIAS-MINI-BOT*\n\n` +
                        `.ping\n` +
                        `.alive\n` +
                        `.session\n` +
                        `.status\n` +
                        `.mode public\n` +
                        `.mode private\n` +
                        `.menu`
                }
            );

            return true;

        default:

            return false;
    }
}

/* ============================================================
   CUSTOM COMMAND
============================================================ */

async function runCustomCommand(
    session,
    message,
    command,
    args
) {

    const handler =
        commands.get(
            command.toLowerCase()
        );

    if (!handler) {
        return false;
    }

    try {

        const execute =
            handler.execute ||
            handler.run ||
            handler.handler;

        if (
            typeof execute !== "function"
        ) {
            return false;
        }

        await execute({

            sock:
                session.sock,

            message,

            args,

            session,

            sessionId:
                session.sessionId,

            bot:
                session,

            phone:
                session.phone,

            jid:
                session.userJid

        });

        return true;

    } catch (error) {

        addLog(
            session.sessionId,
            `Command ${command} failed: ${error.message}`
        );

        return false;
    }
}

/* ============================================================
   MESSAGE PROCESSOR
============================================================ */

async function processMessage(
    sessionId,
    message
) {

    const session =
        sessions.get(
            sessionId
        );

    if (!session) {
        return;
    }

    session.lastSeen =
        new Date().toISOString();

    if (
        !message ||
        message.key?.fromMe
    ) {
        return;
    }

    const text =
        getMessageText(
            message
        ).trim();

    if (!text.startsWith(".")) {
        return;
    }

    const parts =
        text
            .slice(1)
            .trim()
            .split(/\s+/);

    const command =
        String(
            parts.shift() || ""
        ).toLowerCase();

    const args =
        parts;

    if (!command) {
        return;
    }

    session.messages =
        Number(
            session.messages || 0
        ) + 1;

    let handled =
        await runBuiltInCommand(
            session,
            message,
            command,
            args
        );

    if (!handled) {

        handled =
            await runCustomCommand(
                session,
                message,
                command,
                args
            );
    }

    if (handled) {

        session.commandCount =
            Number(
                session.commandCount || 0
            ) + 1;
    }

    /*
     * Persist counters periodically.
     */
    if (
        session.commandCount % 10 === 0
    ) {

        await saveDeployment({

            sessionId:
                session.sessionId,

            phone:
                session.phone,

            jid:
                session.userJid,

            pairId:
                session.pairId,

            status:
                session.status,

            connected:
                session.connected,

            mode:
                session.mode,

            days:
                session.days,

            expireAt:
                session.expireAt,

            authFolder:
                session.authFolder,

            reconnects:
                session.reconnects,

            messages:
                session.messages,

            commandCount:
                session.commandCount,

            createdAt:
                session.createdAt,

            lastSeen:
                session.lastSeen
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
            sessionId
        );

    if (!session) {
        return;
    }

    addLog(
        sessionId,
        `Group participant event: ${event.action || "unknown"}`
    );

    /*
     * Your existing welcome/goodbye,
     * antilink and group features can
     * use this event without changing
     * the multi-user architecture.
     */
}

/* ============================================================
   DEPLOY SESSION
============================================================ */

async function deploySession(
    options = {}
) {

    const sessionId =
        normalizeSessionId(
            options.sessionId
        );

    const phone =
        normalizePhone(
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

    if (!isValidSessionId(
        sessionId
    )) {

        return {
            success: false,
            error: "Invalid Session ID"
        };
    }

    /*
     * Find ONLY this session's auth folder.
     */
    const authFolder =
        resolveAuthFolder(
            sessionId,
            options.authFolder
        );

    if (!authFolder) {

        return {
            success: false,
            error:
                `Auth state not found for ${sessionId}`
        };
    }

    if (!hasAuthCredentials(
        authFolder
    )) {

        return {
            success: false,
            error:
                `creds.json not found for ${sessionId}`
        };
    }

    /*
     * Prevent the same WhatsApp account
     * from being connected twice.
     */
    for (const [
        existingId,
        session
    ] of sessions.entries()) {

        if (
            existingId !== sessionId &&
            session.phone &&
            phone &&
            normalizePhone(
                session.phone
            ) === phone &&
            session.connected
        ) {

            return {
                success: false,
                error:
                    "This WhatsApp number is already connected",
                sessionId:
                    existingId
            };
        }
    }

    const existing =
        sessions.get(
            sessionId
        );

    if (
        existing &&
        existing.sock &&
        existing.connected
    ) {

        return {

            success: true,

            sessionId,

            phone:
                existing.phone,

            jid:
                existing.userJid,

            days:
                existing.days,

            expireAt:
                existing.expireAt,

            status:
                "connected",

            connected: true,

            authFolder:
                existing.authFolder,

            alreadyRunning: true

        };
    }

    const expireAt =
        options.expireAt ||
        new Date(
            Date.now() +
            days *
            24 *
            60 *
            60 *
            1000
        ).toISOString();

    await saveDeployment({

        sessionId,

        phone,

        jid:
            options.jid ||
            null,

        pairId:
            options.pairingId ||
            null,

        status:
            "starting",

        connected: false,

        mode:
            options.mode ||
            "public",

        days,

        expireAt,

        authFolder,

        reconnects:
            existing?.reconnects ||
            0,

        messages:
            existing?.messages ||
            0,

        commandCount:
            existing?.commandCount ||
            0,

        createdAt:
            existing?.createdAt ||
            new Date().toISOString(),

        lastSeen:
            new Date().toISOString(),

        sessionMessageSent:
            existing?.sessionMessageSent ||
            false
    });

    try {

        const sock =
            await createSocket(
                sessionId,
                {
                    authFolder,

                    phone,

                    jid:
                        options.jid,

                    pairingId:
                        options.pairingId,

                    days,

                    expireAt,

                    mode:
                        options.mode ||
                        "public"
                }
            );

        const session =
            sessions.get(
                sessionId
            );

        /*
         * Give the socket a short amount of time
         * to reach connection=open.
         */
        const connected =
            await waitForConnection(
                sessionId,
                30000
            );

        const current =
            sessions.get(
                sessionId
            );

        return {

            success: true,

            sessionId,

            phone:
                current?.phone ||
                phone,

            jid:
                current?.userJid ||
                options.jid ||
                null,

            days,

            expireAt,

            status:
                connected
                    ? "connected"
                    : current?.status ||
                      "starting",

            connected,

            authFolder,

            commandsStarted:
                true,

            socketCreated:
                Boolean(sock)

        };

    } catch (error) {

        const current =
            sessions.get(
                sessionId
            );

        if (current) {

            current.status =
                "error";

            current.connected =
                false;

            current.sock =
                null;
        }

        await saveDeployment({

            sessionId,

            phone,

            jid:
                options.jid ||
                null,

            pairId:
                options.pairingId ||
                null,

            status:
                "error",

            connected: false,

            mode:
                options.mode ||
                "public",

            days,

            expireAt,

            authFolder,

            reconnects:
                current?.reconnects ||
                0,

            messages:
                current?.messages ||
                0,

            commandCount:
                current?.commandCount ||
                0,

            createdAt:
                current?.createdAt ||
                new Date().toISOString(),

            lastSeen:
                new Date().toISOString()
        });

        return {

            success: false,

            sessionId,

            error:
                error.message

        };
    }
}

/* ============================================================
   WAIT FOR CONNECTION
============================================================ */

function waitForConnection(
    sessionId,
    timeoutMs
) {

    return new Promise(resolve => {

        const start =
            Date.now();

        const timer =
            setInterval(() => {

                const session =
                    sessions.get(
                        sessionId
                    );

                if (
                    session?.connected
                ) {

                    clearInterval(timer);

                    resolve(true);

                    return;
                }

                if (
                    Date.now() -
                    start >=
                    timeoutMs
                ) {

                    clearInterval(timer);

                    resolve(false);
                }

            }, 500);

    });
}

/* ============================================================
   ALIASES
============================================================ */

async function deploy(
    options
) {
    return deploySession(
        options
    );
}

/* ============================================================
   SESSION API
============================================================ */

function getSession(
    sessionId
) {

    const id =
        normalizeSessionId(
            sessionId
        );

    const session =
        sessions.get(id);

    if (!session) {
        return null;
    }

    return {

        sessionId:
            session.sessionId,

        phone:
            session.phone,

        jid:
            session.userJid,

        pairId:
            session.pairId,

        status:
            session.status,

        connected:
            session.connected,

        mode:
            session.mode,

        days:
            session.days,

        expireAt:
            session.expireAt,

        authFolder:
            session.authFolder,

        reconnects:
            session.reconnects,

        messages:
            session.messages,

        commandCount:
            session.commandCount,

        createdAt:
            session.createdAt,

        lastSeen:
            session.lastSeen

    };
}

function getSessions() {

    return Array.from(
        sessions.values()
    ).map(
        session =>
            getSession(
                session.sessionId
            )
    );
}

/* ============================================================
   STOP
============================================================ */

async function stopSession(
    sessionId
) {

    const id =
        normalizeSessionId(
            sessionId
        );

    clearReconnectTimer(id);

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

    } catch {}

    session.sock =
        null;

    session.connected =
        false;

    session.status =
        "stopped";

    await saveDeployment({

        sessionId: id,

        phone:
            session.phone,

        jid:
            session.userJid,

        pairId:
            session.pairId,

        status:
            "stopped",

        connected: false,

        mode:
            session.mode,

        days:
            session.days,

        expireAt:
            session.expireAt,

        authFolder:
            session.authFolder,

        reconnects:
            session.reconnects,

        messages:
            session.messages,

        commandCount:
            session.commandCount,

        createdAt:
            session.createdAt,

        lastSeen:
            new Date().toISOString()
    });

    return true;
}

/* ============================================================
   RESTART
============================================================ */

async function restartSession(
    sessionId
) {

    const id =
        normalizeSessionId(
            sessionId
        );

    const session =
        sessions.get(id);

    const deployment =
        getDeployment(id);

    if (!session && !deployment) {

        return {
            success: false,
            error: "Session not found"
        };
    }

    if (session) {
        await stopSession(id);
    }

    return deploySession({

        sessionId: id,

        phone:
            session?.phone ||
            deployment?.phone,

        jid:
            session?.userJid ||
            deployment?.jid,

        pairingId:
            session?.pairId ||
            deployment?.pairId,

        days:
            session?.days ||
            deployment?.days,

        expireAt:
            session?.expireAt ||
            deployment?.expireAt,

        authFolder:
            session?.authFolder ||
            deployment?.authFolder

    });
}

/* ============================================================
   REMOVE
============================================================ */

async function removeSession(
    sessionId
) {

    const id =
        normalizeSessionId(
            sessionId
        );

    await stopSession(id);

    sessions.delete(id);

    clearReconnectTimer(id);

    return true;
}

/* ============================================================
   STATS
============================================================ */

function stats() {

    const list =
        getSessions();

    return {

        total:
            list.length,

        connected:
            list.filter(
                item =>
                    item.connected
            ).length,

        disconnected:
            list.filter(
                item =>
                    !item.connected
            ).length

    };
}

/* ============================================================
   RESTORE SAVED SESSIONS
============================================================ */

async function loadSavedDeployments() {

    const deployments =
        readDeployments();

    logger.info(
        `[RESTORE] ${deployments.length} saved deployments`
    );

    for (const deployment of deployments) {

        const sessionId =
            normalizeSessionId(
                deployment.sessionId
            );

        if (!isValidSessionId(
            sessionId
        )) {
            continue;
        }

        /*
         * Expired deployments should not
         * automatically reconnect.
         */
        if (
            deployment.expireAt &&
            new Date(
                deployment.expireAt
            ) <= new Date()
        ) {

            logger.info(
                `[RESTORE] Skipping expired ${sessionId}`
            );

            continue;
        }

        const authFolder =
            resolveAuthFolder(
                sessionId,
                deployment.authFolder
            );

        if (!authFolder) {

            logger.warn(
                `[RESTORE] Auth state missing for ${sessionId}`
            );

            continue;
        }

        try {

            await deploySession({

                sessionId,

                phone:
                    deployment.phone,

                jid:
                    deployment.jid,

                pairingId:
                    deployment.pairId,

                days:
                    deployment.days,

                expireAt:
                    deployment.expireAt,

                authFolder,

                mode:
                    deployment.mode ||
                    "public"

            });

        } catch (error) {

            logger.error(
                {
                    sessionId,
                    error:
                        error.message
                },
                "[RESTORE] Failed"
            );
        }
    }
}

/* ============================================================
   EXPIRATION
============================================================ */

setInterval(
    async () => {

        const now =
            Date.now();

        for (const [
            sessionId,
            session
        ] of sessions.entries()) {

            if (!session.expireAt) {
                continue;
            }

            if (
                new Date(
                    session.expireAt
                ).getTime() <= now
            ) {

                addLog(
                    sessionId,
                    "Session expired"
                );

                await stopSession(
                    sessionId
                );
            }
        }

    },
    60 * 1000
);

/* ============================================================
   GLOBAL BOT MANAGER
============================================================ */

global.ETIAS_BOT_MANAGER = {

    deploy,

    deploySession,

    getSession,

    getSessions,

    getLogs,

    stopSession,

    stop: stopSession,

    restartSession,

    restart: restartSession,

    removeSession,

    remove: removeSession,

    stats,

    loadCommands,

    loadSavedDeployments,

    isValidSessionId

};

/* ============================================================
   STARTUP
============================================================ */

async function start() {

    logger.info(
        "=========================================="
    );

    logger.info(
        "ETIAS-MINI-BOT starting..."
    );

    logger.info(
        `Node: ${process.version}`
    );

    logger.info(
        `Port: ${PORT}`
    );

    logger.info(
        `Auth directory: ${USERS_AUTH_DIR}`
    );

    await loadCommands();

    await connectMongo();

    /*
     * Start deployment/API server.
     * server.js itself does NOT call listen().
     */
    app.listen(
        PORT,
        "0.0.0.0",
        () => {

            logger.info(
                `[SERVER] Running on port ${PORT}`
            );

        }
    );

    /*
     * Restore previously deployed users.
     */
    await loadSavedDeployments();

    logger.info(
        "=========================================="
    );

    logger.info(
        "ETIAS-MINI-BOT ONLINE"
    );

    logger.info(
        "Multi-user deployment manager active"
    );

    logger.info(
        "=========================================="
    );
}

/* ============================================================
   SHUTDOWN
============================================================ */

async function shutdown(
    signal
) {

    logger.info(
        `[SHUTDOWN] ${signal}`
    );

    for (const [
        sessionId
    ] of sessions) {

        try {

            await stopSession(
                sessionId
            );

        } catch {}
    }

    try {

        await mongoose.disconnect();

    } catch {}

    process.exit(0);
}

process.on(
    "SIGINT",
    () => shutdown("SIGINT")
);

process.on(
    "SIGTERM",
    () => shutdown("SIGTERM")
);

/* ============================================================
   START
============================================================ */

start().catch(
    error => {

        logger.error(
            {
                error:
                    error.stack ||
                    error.message
            },
            "[FATAL] Startup failed"
        );

        process.exit(1);

    }
);
