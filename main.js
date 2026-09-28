// ============================================================
// ETIAS-MINI-BOT
// FULL MAIN.JS
// 440 DISCONNECT + SELF-CHAT + MULTI-SESSION FIX
// 30-DAY SESSION EXPIRY
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
const readline = require("readline");
const express = require("express");
const mongoose = require("mongoose");

// ============================================================
// GLOBAL ERROR HANDLING
// ============================================================

process.on("uncaughtException", (err) => {
    const msg = err?.message || "";

    if (
        msg.includes("Session") ||
        msg.includes("MAC") ||
        msg.includes("decrypt") ||
        msg.includes("Closing open session")
    ) {
        console.log("[IGNORED ERROR]", msg);
        return;
    }

    console.error("[UNCAUGHT EXCEPTION]", err);
});

process.on("unhandledRejection", (err) => {
    const msg = err?.message || "";

    if (
        msg.includes("Session") ||
        msg.includes("MAC") ||
        msg.includes("decrypt") ||
        msg.includes("Connection Closed")
    ) {
        console.log("[IGNORED REJECTION]", msg);
        return;
    }

    console.error("[UNHANDLED REJECTION]", err);
});

// ============================================================
// CONFIG
// ============================================================

const BOT_NAME = "*ETIAS-MINI-BOT*";
const PREFIX = ".";

const OWNER_NUMBER = (
    process.env.OWNER_NUMBER || "263778810589"
).replace(/[^0-9]/g, "");

const MONGODB_URI =
    process.env.MONGODB_URI ||
    process.env.MONGO_URL ||
    "";

const PAIRING_SITE =
    process.env.PAIRING_SITE ||
    "https://etias-mini-bot-pair.onrender.com/";

const SESSION_DAYS = 30;

const SESSION_DURATION =
    SESSION_DAYS *
    24 *
    60 *
    60 *
    1000;

// ============================================================
// PATHS
// ============================================================

const dataPath = path.join(__dirname, "data");
const authBasePath = path.join(__dirname, "auth");
const usersPath = path.join(authBasePath, "users");

[
    dataPath,
    authBasePath,
    usersPath
].forEach((dir) => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

// ============================================================
// BOT MODE
// ============================================================

let botMode = process.env.MODE || "public";

try {
    const modeFile = path.join(dataPath, "mode.json");

    if (fs.existsSync(modeFile)) {
        const modeData = JSON.parse(
            fs.readFileSync(modeFile, "utf8")
        );

        if (modeData.mode) {
            botMode = modeData.mode;
        }
    }
} catch (e) {}

global.botMode = botMode;

console.log(`[MODE] ${botMode.toUpperCase()}`);

// ============================================================
// MONGODB
// ============================================================

const sessionSchema = new mongoose.Schema({
    userId: {
        type: String,
        unique: true,
        index: true
    },

    sessionId: {
        type: String
    },

    phone: {
        type: String
    },

    connected: {
        type: Boolean,
        default: false
    },

    createdAt: {
        type: Date,
        default: Date.now
    },

    lastConnectedAt: {
        type: Date,
        default: null
    },

    expiresAt: {
        type: Date,
        default: null,
        index: true
    }
});

const SessionModel =
    mongoose.models.Session ||
    mongoose.model("Session", sessionSchema);

// ============================================================
// MONGODB CONNECT
// ============================================================

async function connectMongo() {
    if (!MONGODB_URI) {
        console.log(
            "[MONGO] No MONGODB_URI - using local storage"
        );

        return false;
    }

    try {
        if (mongoose.connection.readyState === 1) {
            console.log("[MONGO] Already connected");
            return true;
        }

        await mongoose.connect(MONGODB_URI);

        console.log("[MONGO] ✅ Connected");

        return true;

    } catch (error) {
        console.log(
            "[MONGO] ❌",
            error.message
        );

        return false;
    }
}

// ============================================================
// SESSION EXPIRY
// ============================================================

function isExpired(date) {
    if (!date) return false;

    return new Date(date).getTime() <= Date.now();
}

// ============================================================
// SAVE SESSION
//
// IMPORTANT:
// Existing valid session keeps its original expiry.
// New session receives 30 days.
// ============================================================

async function saveToMongo(userId, sessionId) {
    if (mongoose.connection.readyState !== 1) {
        return;
    }

    try {
        const existing =
            await SessionModel.findOne({
                userId
            });

        let expiresAt;

        if (
            existing &&
            existing.expiresAt &&
            !isExpired(existing.expiresAt)
        ) {
            expiresAt = existing.expiresAt;
        } else {
            expiresAt = new Date(
                Date.now() + SESSION_DURATION
            );
        }

        await SessionModel.findOneAndUpdate(
            { userId },
            {
                sessionId,
                phone: userId,
                connected: true,
                lastConnectedAt: new Date(),
                expiresAt
            },
            {
                upsert: true,
                new: true
            }
        );

        const remaining =
            expiresAt.getTime() - Date.now();

        const remainingDays =
            Math.max(
                0,
                Math.ceil(
                    remaining /
                    (24 * 60 * 60 * 1000)
                )
            );

        console.log(
            `[MONGO] Saved ${userId} - ${remainingDays} days remaining`
        );

    } catch (error) {
        console.log(
            "[MONGO SAVE]",
            error.message
        );
    }
}

// ============================================================
// LOAD SESSIONS
// REMOVE EXPIRED SESSIONS
// ============================================================

async function getFromMongo() {
    if (mongoose.connection.readyState !== 1) {
        return {};
    }

    const sessions =
        await SessionModel.find({});

    const result = {};

    for (const session of sessions) {

        if (
            session.expiresAt &&
            isExpired(session.expiresAt)
        ) {

            console.log(
                `[EXPIRY] Removing expired session ${session.userId}`
            );

            try {
                await SessionModel.deleteOne({
                    _id: session._id
                });
            } catch (e) {}

            const localAuth =
                session.userId === "main"
                    ? authBasePath
                    : path.join(
                        usersPath,
                        session.userId
                    );

            try {
                fs.rmSync(
                    localAuth,
                    {
                        recursive: true,
                        force: true
                    }
                );
            } catch (e) {}

            continue;
        }

        if (session.sessionId) {
            result[session.userId] =
                session.sessionId;
        }
    }

    return result;
}

// ============================================================
// LOCAL DATABASE HELPERS
// ============================================================

function getDB(file, defaultValue = {}) {

    const filePath =
        path.join(dataPath, file);

    if (!fs.existsSync(filePath)) {
        fs.writeFileSync(
            filePath,
            JSON.stringify(defaultValue, null, 2)
        );
    }

    try {
        return JSON.parse(
            fs.readFileSync(
                filePath,
                "utf8"
            )
        );
    } catch {
        return defaultValue;
    }
}

function saveDB(file, data) {

    fs.writeFileSync(
        path.join(dataPath, file),
        JSON.stringify(
            data,
            null,
            2
        )
    );
}

// ============================================================
// MULTI SESSION LOCAL STORAGE
// ============================================================

function getMultiDB() {
    return getDB(
        "multi_sessions.json",
        {}
    );
}

function saveMultiSession(
    userId,
    sessionId
) {

    const db = getMultiDB();

    db[userId] = sessionId;

    saveDB(
        "multi_sessions.json",
        db
    );

    saveToMongo(
        userId,
        sessionId
    );
}

// ============================================================
// SESSION STRING RESTORE
// ============================================================

function initSessionFromString(
    sessionString,
    destination
) {

    if (!sessionString) {
        return false;
    }

    try {

        const credsPath =
            path.join(
                destination,
                "creds.json"
            );

        if (
            fs.existsSync(credsPath) &&
            fs.statSync(credsPath).size > 500
        ) {
            return true;
        }

        let clean =
            sessionString
                .trim()
                .replace(/\s/g, "");

        if (clean.includes("~")) {
            clean =
                clean
                    .split("~")
                    .pop();
        }

        const decoded =
            Buffer
                .from(
                    clean,
                    "base64"
                )
                .toString("utf8");

        if (
            decoded.startsWith("{")
        ) {

            if (!fs.existsSync(destination)) {
                fs.mkdirSync(
                    destination,
                    {
                        recursive: true
                    }
                );
            }

            fs.writeFileSync(
                credsPath,
                decoded
            );

            console.log(
                `[SESSION] Restored ${path.basename(destination)}`
            );

            return true;
        }

    } catch (error) {

        console.log(
            "[SESSION RESTORE]",
            error.message
        );
    }

    return false;
}

// ============================================================
// COMMAND LOADER
// ============================================================

const commands = new Map();

const commandsPath =
    path.join(
        __dirname,
        "commands"
    );

if (fs.existsSync(commandsPath)) {

    const commandFiles =
        fs.readdirSync(
            commandsPath
        )
        .filter(
            file =>
                file.endsWith(".js")
        );

    for (const file of commandFiles) {

        try {

            const fullPath =
                path.join(
                    commandsPath,
                    file
                );

            delete require.cache[
                require.resolve(fullPath)
            ];

            const command =
                require(fullPath);

            const commandName =
                (
                    command.name ||
                    file.replace(
                        ".js",
                        ""
                    )
                ).toLowerCase();

            commands.set(
                commandName,
                command
            );

            if (
                Array.isArray(
                    command.aliases
                )
            ) {

                for (
                    const alias
                    of command.aliases
                ) {

                    commands.set(
                        alias.toLowerCase(),
                        command
                    );
                }
            }

        } catch (error) {

            console.log(
                `[COMMAND ERROR] ${file}:`,
                error.message
            );
        }
    }
}

console.log(
    `[COMMANDS] ${commands.size} commands loaded`
);

// ============================================================
// BOT STATE
// ============================================================

// Current live socket for each account
const activeBots = new Map();

// Prevent two simultaneous start operations
const startingBots = new Map();

// Reconnect timers
const reconnectTimers = new Map();

// 440 tracking
const disconnect440History = new Map();

// Accounts intentionally stopped
const stoppedBots = new Set();

// ============================================================
// ASK NUMBER
// ============================================================

function askNumber() {

    const rl =
        readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

    return new Promise(
        resolve => {

            rl.question(
                "📱 Enter number: ",
                answer => {

                    rl.close();

                    resolve(
                        answer.trim() ||
                        OWNER_NUMBER
                    );
                }
            );
        }
    );
}

// ============================================================
// NORMALIZE PHONE
// ============================================================

function normalizeNumber(value) {

    if (!value) return "";

    return String(value)
        .split(":")[0]
        .split("@")[0]
        .replace(
            /[^0-9]/g,
            ""
        );
}

// ============================================================
// GET SENDER NUMBER
// ============================================================

function getSenderNumber(msg) {

    const key =
        msg?.key || {};

    const participant =
        key.participant;

    const remoteJid =
        key.remoteJid;

    const sender =
        participant ||
        remoteJid ||
        "";

    return normalizeNumber(
        sender
    );
}

// ============================================================
// CHECK OWNER
//
// IMPORTANT:
// LID JIDs don't contain the normal
// phone number. fromMe is therefore
// also treated as owner.
// ============================================================

function isOwnerMessage(
    msg,
    userId
) {

    const key =
        msg?.key || {};

    if (key.fromMe) {
        return true;
    }

    const senderNumber =
        getSenderNumber(msg);

    if (
        senderNumber &&
        senderNumber === OWNER_NUMBER
    ) {
        return true;
    }

    if (
        userId !== "main" &&
        senderNumber &&
        senderNumber === normalizeNumber(userId)
    ) {
        return true;
    }

    return false;
}

// ============================================================
// SAFE MESSAGE TEXT EXTRACTION
// ============================================================

function getMessageText(message) {

    if (!message) {
        return "";
    }

    if (
        typeof message.conversation ===
        "string"
    ) {
        return message.conversation;
    }

    if (
        message.extendedTextMessage?.text
    ) {
        return message
            .extendedTextMessage
            .text;
    }

    if (
        message.imageMessage?.caption
    ) {
        return message
            .imageMessage
            .caption;
    }

    if (
        message.videoMessage?.caption
    ) {
        return message
            .videoMessage
            .caption;
    }

    if (
        message.documentMessage?.caption
    ) {
        return message
            .documentMessage
            .caption;
    }

    return "";
}

// ============================================================
// SCHEDULE RECONNECT
// ============================================================

function scheduleReconnect(
    userId,
    delay,
    sessionString = null
) {

    if (
        stoppedBots.has(userId)
    ) {
        return;
    }

    if (
        reconnectTimers.has(userId)
    ) {
        return;
    }

    console.log(
        `[RECONNECT] ${userId} in ${delay / 1000} seconds...`
    );

    const timer =
        setTimeout(
            async () => {

                reconnectTimers.delete(
                    userId
                );

                try {

                    await startBotForUser(
                        userId,
                        sessionString
                    );

                } catch (error) {

                    console.log(
                        `[RECONNECT ERROR] ${userId}`,
                        error.message
                    );

                    scheduleReconnect(
                        userId,
                        10000,
                        sessionString
                    );
                }

            },
            delay
        );

    reconnectTimers.set(
        userId,
        timer
    );
}

// ============================================================
// CLEAR RECONNECT TIMER
// ============================================================

function clearReconnect(
    userId
) {

    const timer =
        reconnectTimers.get(
            userId
        );

    if (timer) {

        clearTimeout(timer);

        reconnectTimers.delete(
            userId
        );
    }
}

// ============================================================
// STOP BOT
// ============================================================

async function stopBot(
    userId
) {

    stoppedBots.add(
        userId
    );

    clearReconnect(
        userId
    );

    const sock =
        activeBots.get(
            userId
        );

    if (sock) {

        try {
            sock.ws?.close();
        } catch (e) {}

        try {
            sock.end?.(
                new Error(
                    "Bot stopped"
                )
            );
        } catch (e) {}
    }

    activeBots.delete(
        userId
    );

    startingBots.delete(
        userId
    );
}

// ============================================================
// START BOT
// ============================================================

async function startBotForUser(
    userId,
    sessionString = null
) {

    // --------------------------------------------------------
    // IMPORTANT:
    // NEVER start the same account twice.
    // --------------------------------------------------------

    if (
        startingBots.has(userId)
    ) {

        console.log(
            `[START SKIP] ${userId} is already starting`
        );

        return startingBots.get(
            userId
        );
    }

    const existing =
        activeBots.get(
            userId
        );

    if (
        existing &&
        existing.user
    ) {

        console.log(
            `[START SKIP] ${userId} already has an active socket`
        );

        return existing;
    }

    stoppedBots.delete(
        userId
    );

    const startPromise =
        (async () => {

            const isMain =
                userId === "main";

            const authPath =
                isMain
                    ? authBasePath
                    : path.join(
                        usersPath,
                        normalizeNumber(
                            userId
                        )
                    );

            // ------------------------------------------------
            // Restore session
            // ------------------------------------------------

            if (sessionString) {

                initSessionFromString(
                    sessionString,
                    authPath
                );

            } else if (
                isMain &&
                process.env.SESSION_ID
            ) {

                initSessionFromString(
                    process.env.SESSION_ID,
                    authPath
                );
            }

            const {
                state,
                saveCreds
            } =
                await useMultiFileAuthState(
                    authPath
                );

            // ------------------------------------------------
            // Create socket
            // ------------------------------------------------

            const sock =
                makeWASocket({

                    auth: state,

                    logger:
                        P({
                            level: "silent"
                        }),

                    printQRInTerminal:
                        false,

                    browser: [
                        "ETIAS-MINI-BOT",
                        "Chrome",
                        "1.0.0"
                    ],

                    markOnlineOnConnect:
                        false,

                    syncFullHistory:
                        false,

                    getMessage:
                        async () =>
                            undefined
                });

            // ------------------------------------------------
            // IMPORTANT:
            // Register socket immediately so another
            // start operation cannot create a second one.
            // ------------------------------------------------

            activeBots.set(
                userId,
                sock
            );

            sock.ev.on(
                "creds.update",
                saveCreds
            );

            // ------------------------------------------------
            // Pairing
            // ------------------------------------------------

            if (
                !sock.authState.creds.registered &&
                isMain &&
                !process.env.PORT
            ) {

                let number =
                    (
                        process.env.PAIR_NUMBER ||
                        OWNER_NUMBER
                    ).replace(
                        /[^0-9]/g,
                        ""
                    );

                if (
                    process.stdin.isTTY
                ) {

                    try {

                        number =
                            await askNumber();

                        number =
                            number.replace(
                                /[^0-9]/g,
                                ""
                            );

                    } catch (e) {}
                }

                await new Promise(
                    resolve =>
                        setTimeout(
                            resolve,
                            3000
                        )
                );

                try {

                    const code =
                        await sock.requestPairingCode(
                            number
                        );

                    console.log(
                        "\n================================"
                    );

                    console.log(
                        `PAIR CODE: ${code.match(/.{1,4}/g)?.join("-") || code}`
                    );

                    console.log(
                        `NUMBER: ${number}`
                    );

                    console.log(
                        "================================\n"
                    );

                } catch (error) {

                    console.log(
                        "[PAIRING ERROR]",
                        error.message
                    );
                }
            }

            // ------------------------------------------------
            // CONNECTION UPDATE
            // ------------------------------------------------

            sock.ev.on(
                "connection.update",
                async update => {

                    const {
                        connection,
                        lastDisconnect
                    } = update;

                    // ========================================
                    // OPEN
                    // ========================================

                    if (
                        connection === "open"
                    ) {

                        console.log(
                            `\n[CONNECTED] ${userId}`
                        );

                        console.log(
                            `[BOT ID] ${sock.user?.id || "unknown"}`
                        );

                        console.log(
                            `[OWNER] ${OWNER_NUMBER}`
                        );

                        console.log(
                            `[MODE] ${global.botMode}`
                        );

                        // ------------------------------------
                        // Only this socket may be active
                        // ------------------------------------

                        const current =
                            activeBots.get(
                                userId
                            );

                        if (
                            current !== sock
                        ) {

                            console.log(
                                `[STALE SOCKET] ${userId} opened but is no longer current`
                            );

                            try {
                                sock.ws?.close();
                            } catch (e) {}

                            return;
                        }

                        // ------------------------------------
                        // Clear reconnect state
                        // ------------------------------------

                        clearReconnect(
                            userId
                        );

                        disconnect440History.delete(
                            userId
                        );

                        // ------------------------------------
                        // Save session
                        // ------------------------------------

                        try {

                            const credsPath =
                                path.join(
                                    authPath,
                                    "creds.json"
                                );

                            const creds =
                                fs.readFileSync(
                                    credsPath,
                                    "utf8"
                                );

                            const fullSession =
                                `ETIAS-MINI-BOT~${Buffer.from(
                                    creds
                                ).toString(
                                    "base64"
                                )}`;

                            let saveId;

                            if (sock.user?.id) {

                                saveId =
                                    normalizeNumber(
                                        sock.user.id
                                    );

                            }

                            if (
                                !saveId ||
                                saveId.length < 5
                            ) {

                                saveId =
                                    isMain
                                        ? OWNER_NUMBER
                                        : normalizeNumber(
                                            userId
                                        );
                            }

                            saveMultiSession(
                                saveId,
                                fullSession
                            );

                        } catch (error) {

                            console.log(
                                "[SESSION SAVE ERROR]",
                                error.message
                            );
                        }

                        console.log(
                            `[READY] ${userId}`
                        );

                        return;
                    }

                    // ========================================
                    // CLOSE
                    // ========================================

                    if (
                        connection === "close"
                    ) {

                        const code =
                            lastDisconnect
                                ?.error
                                ?.output
                                ?.statusCode;

                        console.log(
                            `[DISCONNECTED] ${userId} code=${code}`
                        );

                        // ------------------------------------
                        // CRITICAL:
                        // Ignore disconnects from old sockets.
                        // ------------------------------------

                        const current =
                            activeBots.get(
                                userId
                            );

                        if (
                            current !== sock
                        ) {

                            console.log(
                                `[STALE CLOSE] Ignoring close from old socket ${userId}`
                            );

                            return;
                        }

                        activeBots.delete(
                            userId
                        );

                        // ------------------------------------
                        // LOGGED OUT
                        // ------------------------------------

                        if (
                            code ===
                            DisconnectReason.loggedOut
                        ) {

                            console.log(
                                `[LOGGED OUT] ${userId}`
                            );

                            clearReconnect(
                                userId
                            );

                            stoppedBots.add(
                                userId
                            );

                            try {

                                fs.rmSync(
                                    authPath,
                                    {
                                        recursive: true,
                                        force: true
                                    }
                                );

                            } catch (e) {}

                            if (
                                !isMain
                            ) {

                                const db =
                                    getMultiDB();

                                delete db[userId];

                                saveDB(
                                    "multi_sessions.json",
                                    db
                                );

                                if (
                                    mongoose.connection.readyState === 1
                                ) {

                                    try {

                                        await SessionModel.deleteOne({
                                            userId
                                        });

                                    } catch (e) {}
                                }
                            }

                            return;
                        }

                        // ------------------------------------
                        // CODE 440
                        //
                        // Connection replaced.
                        //
                        // Do NOT immediately reconnect forever.
                        // ------------------------------------

                        if (
                            code ===
                            DisconnectReason.connectionReplaced ||
                            code === 440
                        ) {

                            const now =
                                Date.now();

                            let history =
                                disconnect440History.get(
                                    userId
                                ) || [];

                            history =
                                history.filter(
                                    timestamp =>
                                        now - timestamp <
                                        60000
                                );

                            history.push(
                                now
                            );

                            disconnect440History.set(
                                userId,
                                history
                            );

                            console.log(
                                `[440] ${userId}: connection replaced (${history.length}/3 in 60s)`
                            );

                            // --------------------------------
                            // If 440 happens repeatedly,
                            // DON'T create another competing
                            // socket.
                            // --------------------------------

                            if (
                                history.length >= 3
                            ) {

                                console.log(
                                    `[440 STOP] ${userId}: repeated connection replacement detected.`
                                );

                                console.log(
                                    `[440 STOP] Check WhatsApp Linked Devices and Render SESSION_ID.`
                                );

                                console.log(
                                    `[440 STOP] Automatic reconnect paused for this account.`
                                );

                                stoppedBots.add(
                                    userId
                                );

                                clearReconnect(
                                    userId
                                );

                                return;
                            }

                            // --------------------------------
                            // First/second 440:
                            // one delayed reconnect.
                            // --------------------------------

                            console.log(
                                `[440] Waiting before reconnecting ${userId}...`
                            );

                            scheduleReconnect(
                                userId,
                                30000,
                                sessionString
                            );

                            return;
                        }

                        // ------------------------------------
                        // OTHER TEMPORARY DISCONNECT
                        // ------------------------------------

                        if (
                            !stoppedBots.has(
                                userId
                            )
                        ) {

                            scheduleReconnect(
                                userId,
                                5000,
                                sessionString
                            );
                        }
                    }
                }
            );

            // =================================================
            // GROUP PARTICIPANTS
            // =================================================

            sock.ev.on(
                "group-participants.update",
                async update => {

                    const welcomeDB =
                        getDB(
                            "welcome.json",
                            {}
                        );

                    const goodbyeDB =
                        getDB(
                            "goodbye.json",
                            {}
                        );

                    try {

                        const metadata =
                            await sock.groupMetadata(
                                update.id
                            );

                        for (
                            const participant
                            of update.participants
                        ) {

                            if (
                                update.action ===
                                "add" &&
                                welcomeDB[
                                    update.id
                                ]?.enabled
                            ) {

                                await sock.sendMessage(
                                    update.id,
                                    {
                                        text:
                                            `Welcome @${participant.split("@")[0]}`,
                                        mentions: [
                                            participant
                                        ]
                                    }
                                );
                            }

                            if (
                                update.action ===
                                "remove" &&
                                goodbyeDB[
                                    update.id
                                ]?.enabled
                            ) {

                                await sock.sendMessage(
                                    update.id,
                                    {
                                        text:
                                            `Goodbye @${participant.split("@")[0]}`,
                                        mentions: [
                                            participant
                                        ]
                                    }
                                );
                            }
                        }

                    } catch (error) {

                        console.log(
                            "[GROUP UPDATE]",
                            error.message
                        );
                    }
                }
            );

            // =================================================
            // MESSAGES
            // =================================================

            sock.ev.on(
                "messages.upsert",
                async event => {

                    const messages =
                        event?.messages || [];

                    if (
                        !messages.length
                    ) {
                        return;
                    }

                    console.log(
                        `[UPSERT] type=${event.type} count=${messages.length}`
                    );

                    // ----------------------------------------
                    // Process every message
                    // ----------------------------------------

                    for (
                        const msg
                        of messages
                    ) {

                        try {

                            if (
                                !msg ||
                                !msg.message
                            ) {
                                continue;
                            }

                            const key =
                                msg.key || {};

                            const jid =
                                key.remoteJid || "";

                            if (!jid) {
                                continue;
                            }

                            const isGroup =
                                jid.endsWith(
                                    "@g.us"
                                );

                            const fromMe =
                                key.fromMe === true;

                            const senderNumber =
                                getSenderNumber(
                                    msg
                                );

                            const owner =
                                isOwnerMessage(
                                    msg,
                                    userId
                                );

                            // =================================
                            // SELF CHAT / LID DIAGNOSTICS
                            // =================================

                            if (fromMe) {

                                console.log(
                                    `[SELF-CHAT] jid=${jid} user=${userId}`
                                );

                            } else {

                                console.log(
                                    `[MESSAGE] jid=${jid} fromMe=false user=${userId}`
                                );
                            }

                            if (
                                jid.endsWith(
                                    "@lid"
                                )
                            ) {

                                console.log(
                                    `[LID] ${jid}`
                                );
                            }

                            // =================================
                            // TEXT
                            // =================================

                            let text =
                                getMessageText(
                                    msg.message
                                );

                            if (!text) {
                                continue;
                            }

                            text =
                                text.trim();

                            console.log(
                                `[TEXT] ${text}`
                            );

                            // =================================
                            // ANTI-LINK
                            // =================================

                            if (
                                isGroup &&
                                !text.startsWith(
                                    PREFIX
                                ) &&
                                !fromMe
                            ) {

                                const antiLinkDB =
                                    getDB(
                                        "antilink.json",
                                        {}
                                    );

                                if (
                                    antiLinkDB[
                                        jid
                                    ]?.enabled &&
                                    /(https?:\/\/|chat\.whatsapp\.com|wa\.me|t\.me)/i.test(
                                        text
                                    )
                                ) {

                                    try {

                                        const metadata =
                                            await sock.groupMetadata(
                                                jid
                                            );

                                        const participant =
                                            metadata.participants.find(
                                                p =>
                                                    p.id ===
                                                    key.participant
                                            );

                                        const isAdmin =
                                            !!participant?.admin;

                                        const botNumber =
                                            normalizeNumber(
                                                sock.user?.id
                                            );

                                        const botParticipant =
                                            metadata.participants.find(
                                                p =>
                                                    normalizeNumber(
                                                        p.id
                                                    ) ===
                                                    botNumber
                                            );

                                        const botIsAdmin =
                                            !!botParticipant?.admin;

                                        if (
                                            !isAdmin &&
                                            botIsAdmin
                                        ) {

                                            await sock.sendMessage(
                                                jid,
                                                {
                                                    delete:
                                                        key
                                                }
                                            );
                                        }

                                    } catch (error) {

                                        console.log(
                                            "[ANTILINK]",
                                            error.message
                                        );
                                    }
                                }
                            }

                            // =================================
                            // COMMAND CHECK
                            // =================================

                            if (
                                !text.startsWith(
                                    PREFIX
                                )
                            ) {
                                continue;
                            }

                            const withoutPrefix =
                                text
                                    .slice(
                                        PREFIX.length
                                    )
                                    .trim();

                            if (
                                !withoutPrefix
                            ) {
                                continue;
                            }

                            const parts =
                                withoutPrefix
                                    .split(/\s+/);

                            const commandName =
                                parts
                                    .shift()
                                    .toLowerCase();

                            const args =
                                parts;

                            console.log(
                                `[COMMAND] ${commandName} owner=${owner} fromMe=${fromMe}`
                            );

                            // =================================
                            // MODE COMMAND
                            // =================================

                            if (
                                commandName ===
                                "mode"
                            ) {

                                if (!owner) {
                                    continue;
                                }

                                const newMode =
                                    args[0]
                                        ?.toLowerCase();

                                const validModes = [
                                    "public",
                                    "private",
                                    "groups",
                                    "inbox"
                                ];

                                if (
                                    !newMode ||
                                    !validModes.includes(
                                        newMode
                                    )
                                ) {

                                    await sock.sendMessage(
                                        jid,
                                        {
                                            text:
                                                `Current mode: ${global.botMode}\n\nAvailable: public, private, groups, inbox`
                                        },
                                        {
                                            quoted:
                                                msg
                                        }
                                    );

                                    continue;
                                }

                                global.botMode =
                                    newMode;

                                saveDB(
                                    "mode.json",
                                    {
                                        mode:
                                            newMode
                                    }
                                );

                                await sock.sendMessage(
                                    jid,
                                    {
                                        text:
                                            `✅ Mode changed to ${newMode}`
                                    },
                                    {
                                        quoted:
                                            msg
                                    }
                                );

                                continue;
                            }

                            // =================================
                            // SESSION COMMAND
                            // =================================

                            if (
                                commandName ===
                                "session"
                            ) {

                                if (!owner) {
                                    continue;
                                }

                                try {

                                    const creds =
                                        fs.readFileSync(
                                            path.join(
                                                authPath,
                                                "creds.json"
                                            ),
                                            "utf8"
                                        );

                                    const session =
                                        `ETIAS-MINI-BOT~${Buffer.from(
                                            creds
                                        ).toString(
                                            "base64"
                                        )}`;

                                    await sock.sendMessage(
                                        jid,
                                        {
                                            text:
                                                `*ETIAS-MINI-BOT SESSION*\n\n${session}\n\nPair Site:\n${PAIRING_SITE}\n\nExpires after ${SESSION_DAYS} days.`
                                        },
                                        {
                                            quoted:
                                                msg
                                        }
                                    );

                                } catch (error) {

                                    await sock.sendMessage(
                                        jid,
                                        {
                                            text:
                                                `❌ Could not generate session: ${error.message}`
                                        },
                                        {
                                            quoted:
                                                msg
                                        }
                                    );
                                }

                                continue;
                            }

                            // =================================
                            // LISTBOTS
                            // =================================

                            if (
                                commandName ===
                                "listbots" &&
                                owner
                            ) {

                                const active =
                                    Array.from(
                                        activeBots.keys()
                                    );

                                let dbCount = 0;

                                if (
                                    mongoose.connection.readyState === 1
                                ) {

                                    dbCount =
                                        await SessionModel.countDocuments();
                                }

                                await sock.sendMessage(
                                    jid,
                                    {
                                        text:
                                            `*ETIAS-MINI-BOT*\n\nACTIVE BOTS: ${active.length}\n\n${active.join("\n") || "None"}\n\nMongoDB Sessions: ${dbCount}\n\nPair Site:\n${PAIRING_SITE}`
                                    },
                                    {
                                        quoted:
                                            msg
                                    }
                                );

                                continue;
                            }

                            // =================================
                            // BOT MODE
                            // =================================

                            const currentMode =
                                global.botMode ||
                                "public";

                            if (
                                currentMode ===
                                "private" &&
                                !owner
                            ) {
                                continue;
                            }

                            if (
                                currentMode ===
                                "groups" &&
                                !isGroup &&
                                !owner
                            ) {
                                continue;
                            }

                            if (
                                currentMode ===
                                "inbox" &&
                                isGroup &&
                                !owner
                            ) {
                                continue;
                            }

                            // =================================
                            // FIND COMMAND
                            // =================================

                            const command =
                                commands.get(
                                    commandName
                                );

                            if (!command) {

                                console.log(
                                    `[COMMAND NOT FOUND] ${commandName}`
                                );

                                continue;
                            }

                            // =================================
                            // EXECUTE COMMAND
                            // =================================

                            console.log(
                                `[EXECUTE] ${commandName}`
                            );

                            try {

                                await command.execute(
                                    sock,
                                    msg,
                                    args,
                                    {
                                        getDB,
                                        saveDB,
                                        downloadContentFromMessage,
                                        isOwner: owner,
                                        isGroup,
                                        userId,
                                        botMode:
                                            global.botMode,
                                        BOT_NAME,
                                        PREFIX
                                    }
                                );

                            } catch (error) {

                                console.log(
                                    `[COMMAND ERROR] ${commandName}`,
                                    error
                                );

                                try {

                                    await sock.sendMessage(
                                        jid,
                                        {
                                            text:
                                                `❌ ${error.message || "Command failed"}`
                                        },
                                        {
                                            quoted:
                                                msg
                                        }
                                    );

                                } catch (sendError) {}
                            }

                        } catch (error) {

                            console.log(
                                "[MESSAGE HANDLER ERROR]",
                                error.message
                            );
                        }
                    }
                }
            );

            return sock;

        })();

    startingBots.set(
        userId,
        startPromise
    );

    try {

        return await startPromise;

    } finally {

        startingBots.delete(
            userId
        );
    }
}

// ============================================================
// START ALL SESSIONS
//
// IMPORTANT FIX:
// If MongoDB already has sessions, DO NOT also start the
// Render SESSION_ID automatically.
//
// This prevents the same WhatsApp account being opened twice.
// ============================================================

async function startAll() {

    await connectMongo();

    let multiDB = {};

    if (
        mongoose.connection.readyState === 1
    ) {

        multiDB =
            await getFromMongo();

        console.log(
            `[MULTI] ${Object.keys(multiDB).length} valid sessions`
        );

    } else {

        multiDB =
            getMultiDB();

        console.log(
            `[MULTI] ${Object.keys(multiDB).length} local sessions`
        );
    }

    const ids =
        Object.keys(
            multiDB
        );

    // ========================================================
    // CASE 1:
    // MongoDB/local sessions exist
    //
    // ONLY start those sessions.
    // DO NOT start SESSION_ID as another socket.
    // ========================================================

    if (
        ids.length > 0
    ) {

        for (
            const id
            of ids
        ) {

            console.log(
                `[MULTI] Starting saved session ${id}`
            );

            try {

                await startBotForUser(
                    id,
                    multiDB[id]
                );

            } catch (error) {

                console.log(
                    `[MULTI START ERROR] ${id}`,
                    error.message
                );
            }

            await new Promise(
                resolve =>
                    setTimeout(
                        resolve,
                        3000
                    )
            );
        }

        console.log(
            "[MULTI] Saved sessions started."
        );

        return;
    }

    // ========================================================
    // CASE 2:
    // No MongoDB sessions
    //
    // Start Render SESSION_ID once.
    // ========================================================

    if (
        process.env.SESSION_ID
    ) {

        console.log(
            "[MAIN] Starting SESSION_ID once..."
        );

        await startBotForUser(
            "main",
            process.env.SESSION_ID
        );

        return;
    }

    // ========================================================
    // CASE 3:
    // No session at all
    // ========================================================

    console.log(
        "[MAIN] No saved session found."
    );

    await startBotForUser(
        "main"
    );
}

// ============================================================
// EXPRESS SERVER
// ============================================================

const app =
    express();

app.use(
    express.json({
        limit: "10mb"
    })
);

// ============================================================
// HOME
// ============================================================

app.get(
    "/",
    async (req, res) => {

        let mongoCount = 0;

        if (
            mongoose.connection.readyState === 1
        ) {

            mongoCount =
                await SessionModel.countDocuments();

        } else {

            mongoCount =
                Object.keys(
                    getMultiDB()
                ).length;
        }

        res.send(`
<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ETIAS-MINI-BOT</title>

<style>

body{
    background:#080808;
    color:#fff;
    font-family:Arial,sans-serif;
    text-align:center;
    padding:30px;
}

.card{
    max-width:500px;
    margin:auto;
    background:#151515;
    padding:25px;
    border-radius:18px;
    box-shadow:0 0 30px rgba(0,255,136,.15);
}

h1{
    color:#00ff88;
}

.btn{
    display:block;
    padding:15px;
    margin:12px 0;
    background:#00ff88;
    color:#000;
    text-decoration:none;
    border-radius:10px;
    font-weight:bold;
}

.dark{
    background:#222;
    color:#fff;
}

.small{
    color:#888;
    font-size:12px;
}

</style>
</head>

<body>

<div class="card">

<h1>🤖 ETIAS-MINI-BOT</h1>

<p>
Active Bots:
<strong>${activeBots.size}</strong>
</p>

<p>
MongoDB Sessions:
<strong>${mongoCount}</strong>
</p>

<p>
Mode:
<strong>${global.botMode}</strong>
</p>

<p>
Session duration:
<strong>${SESSION_DAYS} days</strong>
</p>

<a class="btn"
href="${PAIRING_SITE}"
target="_blank">
🔗 PAIR BOT
</a>

<a class="btn dark"
href="/bots">
📋 VIEW BOTS
</a>

<p class="small">
ETIAS TECH<br>
Bringing AI to your fingertips
</p>

</div>

</body>
</html>
`);
    }
);

// ============================================================
// ADD SESSION
// ============================================================

app.get(
    "/add",
    async (req, res) => {

        const session =
            req.query.session;

        if (!session) {

            return res.send(`
                Use:
                ${PAIRING_SITE}

                <br><br>

                Or:
                /add?session=ETIAS~xxx
            `);
        }

        try {

            const base64 =
                session.includes("~")
                    ? session
                        .split("~")
                        .pop()
                    : session;

            const json =
                JSON.parse(
                    Buffer
                        .from(
                            base64.trim(),
                            "base64"
                        )
                        .toString(
                            "utf8"
                        )
                );

            const userId =
                normalizeNumber(
                    json?.me?.id
                ) ||
                `user_${Date.now()}`;

            // ----------------------------------------------
            // Prevent duplicate account
            // ----------------------------------------------

            if (
                activeBots.has(
                    userId
                ) ||
                startingBots.has(
                    userId
                )
            ) {

                return res.send(`
                    ⚠️ ${userId} is already active.
                    <br><br>
                    <a href="/">Home</a>
                `);
            }

            saveMultiSession(
                userId,
                session
            );

            await startBotForUser(
                userId,
                session
            );

            res.send(`
                <h2>✅ Bot Added</h2>

                <p>
                Number:
                ${userId}
                </p>

                <p>
                Session expires after
                ${SESSION_DAYS} days.
                </p>

                <a href="/">Home</a>
                <br><br>
                <a href="${PAIRING_SITE}">
                Pair Site
                </a>
            `);

        } catch (error) {

            res.send(
                "❌ Invalid session: " +
                error.message
            );
        }
    }
);

// ============================================================
// BOTS API
// ============================================================

app.get(
    "/bots",
    async (req, res) => {

        if (
            mongoose.connection.readyState === 1
        ) {

            const sessions =
                await SessionModel.find({});

            return res.json({
                active:
                    Array.from(
                        activeBots.keys()
                    ),

                starting:
                    Array.from(
                        startingBots.keys()
                    ),

                total:
                    sessions.length,

                pairingSite:
                    PAIRING_SITE,

                sessions
            });
        }

        res.json({

            active:
                Array.from(
                    activeBots.keys()
                ),

            starting:
                Array.from(
                    startingBots.keys()
                ),

            saved:
                Object.keys(
                    getMultiDB()
                ),

            pairingSite:
                PAIRING_SITE
        });
    }
);

// ============================================================
// PAIR REDIRECT
// ============================================================

app.get(
    "/pair",
    (req, res) => {

        res.redirect(
            PAIRING_SITE
        );
    }
);

// ============================================================
// HEALTH
// ============================================================

app.get(
    "/health",
    (req, res) => {

        res.json({

            status: "online",

            bot:
                BOT_NAME,

            activeBots:
                activeBots.size,

            startingBots:
                startingBots.size,

            mongo:
                mongoose.connection.readyState === 1
                    ? "connected"
                    : "disconnected",

            mode:
                global.botMode,

            sessionDays:
                SESSION_DAYS,

            uptime:
                process.uptime()
        });
    }
);

// ============================================================
// SERVER
// ============================================================

const PORT =
    process.env.PORT || 3000;

app.listen(
    PORT,
    () => {

        console.log(
            `[SERVER] Running on port ${PORT}`
        );
    }
);

// ============================================================
// START
// ============================================================

startAll()
    .catch(
        error => {

            console.error(
                "[START ERROR]",
                error
            );
        }
    );
