// ============================================================
// ETIAS-MINI-BOT
// MULTI SESSION DEPLOYMENT SERVER
// PAIR-SITE SESSION -> DEPLOY -> AUTO CONNECT -> COMMANDS
// ============================================================

require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const mongoose = require("mongoose");
const P = require("pino");

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason
} = require("@whiskeysockets/baileys");


// ============================================================
// CONFIG
// ============================================================

const app = express();

const PORT = Number(
    process.env.PORT || 3000
);

const BOT_NAME = "*ETIAS-MINI-BOT*";

const PREFIX =
    process.env.PREFIX || ".";

const MAIN_OWNER =
    "263778810589";

const OWNER_NUMBER =
    (
        process.env.OWNER_NUMBER ||
        MAIN_OWNER
    ).replace(/[^0-9]/g, "");

const MONGODB_URI =
    process.env.MONGODB_URI ||
    process.env.MONGO_URL ||
    "";

const PAIRING_SITE =
    "https://etias-mini-bot-pair.onrender.com";

const PREFIX_SESSION =
    "ETIAS-MINI-BOT~";

const ALLOWED_DAYS = [
    7,
    15,
    30,
    60,
    90,
    365
];

const DEFAULT_DAYS =
    30;


// ============================================================
// DIRECTORIES
// ============================================================

const dataPath =
    path.join(__dirname, "data");

const authBasePath =
    path.join(__dirname, "auth");

const usersPath =
    path.join(authBasePath, "users");

const tempAuthPath =
    path.join(__dirname, "temp_auth");


for (const dir of [
    dataPath,
    authBasePath,
    usersPath,
    tempAuthPath
]) {

    if (!fs.existsSync(dir)) {

        fs.mkdirSync(
            dir,
            {
                recursive: true
            }
        );

    }

}


// ============================================================
// EXPRESS
// ============================================================

app.use(
    express.json({
        limit: "50mb"
    })
);

app.use(
    express.urlencoded({
        extended: true,
        limit: "50mb"
    })
);


// ============================================================
// MONGODB MODEL
// ============================================================

const sessionSchema =
    new mongoose.Schema({

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
        },

        days: {
            type: Number,
            default: DEFAULT_DAYS
        },

        addedBy: {
            type: String,
            default: MAIN_OWNER
        }

    });


const SessionModel =
    mongoose.models.Session ||
    mongoose.model(
        "Session",
        sessionSchema
    );


// ============================================================
// MONGODB
// ============================================================

async function connectMongo() {

    if (!MONGODB_URI) {

        console.log(
            "[MONGO] No MongoDB URI configured"
        );

        return false;

    }

    try {

        await mongoose.connect(
            MONGODB_URI,
            {
                serverSelectionTimeoutMS: 10000
            }
        );

        console.log(
            "[MONGO] ✅ Connected"
        );

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
// LOCAL DATABASE HELPERS
// ============================================================

function getDB(
    filename,
    fallback = {}
) {

    const file =
        path.join(
            dataPath,
            filename
        );

    try {

        if (!fs.existsSync(file)) {

            return fallback;

        }

        return JSON.parse(
            fs.readFileSync(
                file,
                "utf8"
            )
        );

    } catch {

        return fallback;

    }

}


function saveDB(
    filename,
    data
) {

    const file =
        path.join(
            dataPath,
            filename
        );

    const temp =
        `${file}.tmp`;

    fs.writeFileSync(
        temp,
        JSON.stringify(
            data,
            null,
            2
        ),
        "utf8"
    );

    fs.renameSync(
        temp,
        file
    );

}


function getMultiDB() {

    return getDB(
        "multi_sessions.json",
        {}
    );

}


// ============================================================
// NORMALIZATION
// ============================================================

function normalizeNumber(value) {

    if (!value) {

        return "";

    }

    return String(value)
        .split(":")[0]
        .split("@")[0]
        .replace(
            /[^0-9]/g,
            ""
        );

}


function isExpired(date) {

    if (!date) {

        return false;

    }

    return (
        new Date(date).getTime() <=
        Date.now()
    );

}


// ============================================================
// EXPIRY
// ============================================================

function calculateExpiry(days) {

    return (
        Date.now() +
        Number(days) *
        24 *
        60 *
        60 *
        1000
    );

}


// ============================================================
// MONGODB SAVE
// ============================================================

async function saveToMongo(
    userId,
    sessionId,
    days,
    expiresAt
) {

    if (
        mongoose.connection.readyState !== 1
    ) {

        return;

    }

    try {

        await SessionModel.findOneAndUpdate(

            {
                userId
            },

            {
                userId,

                sessionId,

                phone: userId,

                connected: true,

                lastConnectedAt:
                    new Date(),

                expiresAt:
                    new Date(expiresAt),

                days,

                addedBy:
                    MAIN_OWNER
            },

            {
                upsert: true,
                new: true
            }

        );

        console.log(
            `[MONGO SAVE] ${userId} ${days}d`
        );

    } catch (error) {

        console.log(
            "[MONGO SAVE]",
            error.message
        );

    }

}


// ============================================================
// SAVE DEPLOYMENT
// ============================================================

function saveMultiSession(
    userId,
    sessionId,
    days,
    expiresAt = null
) {

    const db =
        getMultiDB();

    const finalExpiry =
        expiresAt ||
        calculateExpiry(days);

    db[userId] = {

        sessionId,

        days,

        addedAt:
            Date.now(),

        expiresAt:
            finalExpiry

    };

    saveDB(
        "multi_sessions.json",
        db
    );

    saveToMongo(
        userId,
        sessionId,
        days,
        finalExpiry
    );

}


// ============================================================
// REMOVE DEPLOYMENT
// ============================================================

async function removeDeployment(
    userId
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

        } catch {}

    }

}


// ============================================================
// LOAD FROM MONGODB
// ============================================================

async function getFromMongo() {

    if (
        mongoose.connection.readyState !== 1
    ) {

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
                `[EXPIRY] ${session.userId}`
            );

            try {

                await SessionModel.deleteOne({
                    _id: session._id
                });

            } catch {}

            const authPath =
                path.join(
                    usersPath,
                    normalizeNumber(
                        session.userId
                    )
                );

            try {

                fs.rmSync(
                    authPath,
                    {
                        recursive: true,
                        force: true
                    }
                );

            } catch {}

            continue;

        }

        if (session.sessionId) {

            result[
                normalizeNumber(
                    session.userId
                )
            ] = {

                sessionId:
                    session.sessionId,

                days:
                    session.days,

                expiresAt:
                    session.expiresAt

            };

        }

    }

    return result;

}


// ============================================================
// SAFE ARCHIVE PATH
// ============================================================

function safeRelativePath(file) {

    const normalized =
        path.posix.normalize(
            String(file)
                .replace(/\\/g, "/")
        );

    if (
        normalized === ".." ||
        normalized.startsWith("../") ||
        normalized.startsWith("/") ||
        normalized.includes("\0")
    ) {

        throw new Error(
            "Unsafe archive path"
        );

    }

    return normalized;

}


// ============================================================
// CLEAN SESSION STRING
// ============================================================

function cleanSessionString(
    sessionString
) {

    if (!sessionString) {

        throw new Error(
            "Session required"
        );

    }

    let value =
        String(sessionString)
            .trim();


    /*
     * Remove accidental whitespace.
     */

    value =
        value.replace(
            /\s+/g,
            ""
        );


    /*
     * If the session begins with
     * ETIAS-MINI-BOT~
     */

    value =
        value.replace(
            /^ETIAS-MINI-BOT~/,
            ""
        );


    /*
     * Remove PART markers.
     */

    value =
        value.replace(
            /ETIAS-MINI-BOT~PART:\d+\/\d+/g,
            ""
        );


    value =
        value.replace(
            /PART:\d+\/\d+/g,
            ""
        );


    /*
     * Remove any duplicated prefix.
     */

    value =
        value.replace(
            /ETIAS-MINI-BOT~/g,
            ""
        );


    value =
        value.replace(
            /\s+/g,
            ""
        );


    if (!value) {

        throw new Error(
            "Empty session data"
        );

    }


    /*
     * Base64 validation.
     */

    if (
        !/^[A-Za-z0-9+/=_-]+$/.test(
            value
        )
    ) {

        throw new Error(
            "Invalid Base64 session data"
        );

    }


    return value;

}


// ============================================================
// DECODE SESSION ARCHIVE
// ============================================================

function decodeSessionArchive(
    sessionString
) {

    const clean =
        cleanSessionString(
            sessionString
        );


    let compressed;

    try {

        compressed =
            Buffer.from(
                clean,
                "base64"
            );

    } catch (error) {

        throw new Error(
            `Invalid Base64: ${error.message}`
        );

    }


    if (
        !compressed.length
    ) {

        throw new Error(
            "Empty decoded session"
        );

    }


    let tarBuffer;

    try {

        tarBuffer =
            zlib.gunzipSync(
                compressed
            );

    } catch (error) {

        throw new Error(
            `Invalid GZIP session: ${error.message}`
        );

    }


    if (
        !tarBuffer.length
    ) {

        throw new Error(
            "Empty TAR archive"
        );

    }


    return tarBuffer;

}


// ============================================================
// RESTORE SESSION ARCHIVE
// ============================================================

function restoreSessionArchive(
    sessionString,
    destination
) {

    const tarBuffer =
        decodeSessionArchive(
            sessionString
        );


    const tempTar =
        path.join(
            tempAuthPath,
            `restore-${crypto.randomBytes(8).toString("hex")}.tar`
        );


    try {

        fs.writeFileSync(
            tempTar,
            tarBuffer
        );


        const listing =
            execFileSync(
                "tar",
                [
                    "-tf",
                    tempTar
                ],
                {
                    encoding: "utf8"
                }
            );


        const entries =
            listing
                .split("\n")
                .map(
                    item =>
                        item.trim()
                )
                .filter(Boolean);


        let hasCreds =
            false;


        for (
            const entry of entries
        ) {

            const safe =
                safeRelativePath(
                    entry
                );


            if (
                safe === "creds.json" ||
                safe.endsWith(
                    "/creds.json"
                )
            ) {

                hasCreds =
                    true;

            }

        }


        if (!hasCreds) {

            throw new Error(
                "Archive missing creds.json"
            );

        }


        /*
         * Clear destination.
         */

        fs.rmSync(
            destination,
            {
                recursive: true,
                force: true
            }
        );


        fs.mkdirSync(
            destination,
            {
                recursive: true
            }
        );


        /*
         * Extract.
         */

        execFileSync(
            "tar",
            [
                "--no-absolute-names",
                "-xf",
                tempTar,
                "-C",
                destination
            ],
            {
                stdio: "ignore"
            }
        );


        if (
            !fs.existsSync(
                path.join(
                    destination,
                    "creds.json"
                )
            )
        ) {

            throw new Error(
                "Extraction failed: creds.json not found"
            );

        }


        return true;

    } finally {

        try {

            fs.rmSync(
                tempTar,
                {
                    force: true
                }
            );

        } catch {}

    }

}


// ============================================================
// CREATE SESSION ARCHIVE
// ============================================================

function createSessionArchive(
    authPath
) {

    const tempTar =
        path.join(
            tempAuthPath,
            `create-${crypto.randomBytes(8).toString("hex")}.tar`
        );

    const tempGz =
        `${tempTar}.gz`;


    try {

        if (
            !fs.existsSync(authPath)
        ) {

            throw new Error(
                "Auth folder not found"
            );

        }


        if (
            !fs.existsSync(
                path.join(
                    authPath,
                    "creds.json"
                )
            )
        ) {

            throw new Error(
                "creds.json missing"
            );

        }


        /*
         * TAR the complete multi-file auth.
         */

        execFileSync(
            "tar",
            [
                "-cf",
                tempTar,
                "-C",
                authPath,
                "."
            ],
            {
                stdio: "ignore"
            }
        );


        execFileSync(
            "gzip",
            [
                "-f",
                tempTar
            ],
            {
                stdio: "ignore"
            }
        );


        const data =
            fs.readFileSync(
                tempGz
            );


        return (
            PREFIX_SESSION +
            data.toString("base64")
        );

    } finally {

        try {

            fs.rmSync(
                tempTar,
                {
                    force: true
                }
            );

        } catch {}


        try {

            fs.rmSync(
                tempGz,
                {
                    force: true
                }
            );

        } catch {}

    }

}


// ============================================================
// GET ACCOUNT FROM AUTH
// ============================================================

function getSessionAccount(
    authPath
) {

    const credsPath =
        path.join(
            authPath,
            "creds.json"
        );


    if (
        !fs.existsSync(credsPath)
    ) {

        throw new Error(
            "creds.json not found"
        );

    }


    const creds =
        JSON.parse(
            fs.readFileSync(
                credsPath,
                "utf8"
            )
        );


    const number =
        normalizeNumber(
            creds?.me?.id
        );


    if (!number) {

        throw new Error(
            "Unable to determine WhatsApp number from session"
        );

    }


    return {

        number,

        registered:
            !!creds?.registered

    };

}


// ============================================================
// LOGGING
// ============================================================

const logs = [];


function addLog(message) {

    const line =
        `[${new Date().toISOString()}] ${message}`;

    console.log(line);

    logs.push(line);

    if (
        logs.length > 300
    ) {

        logs.shift();

    }

}


// ============================================================
// RUNTIME MAPS
// ============================================================

const messageStore =
    new Map();

const activeBots =
    new Map();

const startingBots =
    new Map();

const reconnectTimers =
    new Map();

const stoppedBots =
    new Set();

const sentDM =
    new Set();

const commands =
    new Map();


// ============================================================
// COMMAND LOADER
// ============================================================

function loadCommands() {

    const commandsPath =
        path.join(
            __dirname,
            "commands"
        );


    if (
        !fs.existsSync(
            commandsPath
        )
    ) {

        addLog(
            "[COMMANDS] commands folder not found"
        );

        return;

    }


    const files =
        fs.readdirSync(
            commandsPath
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

            const full =
                path.join(
                    commandsPath,
                    file
                );


            delete require.cache[
                require.resolve(full)
            ];


            const command =
                require(full);


            const names = [];


            if (
                command.name
            ) {

                names.push(
                    command.name
                );

            }


            if (
                Array.isArray(
                    command.aliases
                )
            ) {

                names.push(
                    ...command.aliases
                );

            }


            for (
                const name of names
            ) {

                commands.set(
                    String(name)
                        .toLowerCase(),
                    command
                );

            }


            if (
                names.length
            ) {

                count++;

            }

        } catch (error) {

            addLog(
                `[CMD ERR] ${file}: ${error.message}`
            );

        }

    }


    addLog(
        `[COMMANDS] ${count} loaded`
    );

}


// ============================================================
// OWNER CHECK
// ============================================================

function isOwnerMessage(
    msg,
    userId
) {

    const key =
        msg?.key || {};


    /*
     * Messages sent by the bot itself.
     */

    if (
        key.fromMe
    ) {

        return true;

    }


    const sender =
        normalizeNumber(
            key.participant ||
            key.remoteJid ||
            ""
        );


    /*
     * Main owner.
     */

    if (
        sender === MAIN_OWNER
    ) {

        return true;

    }


    /*
     * Configured owner.
     */

    if (
        sender === OWNER_NUMBER
    ) {

        return true;

    }


    /*
     * The owner of the deployed session.
     *
     * Example:
     * deployed account = 263771234567
     *
     * Messages from 263771234567
     * are treated as owner commands.
     */

    if (
        userId !== "main" &&
        sender ===
        normalizeNumber(userId)
    ) {

        return true;

    }


    return false;

}


// ============================================================
// EXPIRY HELPERS
// ============================================================

function getExpiry(
    userId
) {

    const db =
        getMultiDB();


    const item =
        db[userId];


    if (
        !item ||
        typeof item === "string"
    ) {

        return null;

    }


    return item.expiresAt;

}


function isSessionExpired(
    userId
) {

    if (
        userId === "main"
    ) {

        return false;

    }


    const expiry =
        getExpiry(userId);


    return (
        expiry &&
        Number(expiry) <=
        Date.now()
    );

}


// ============================================================
// RECONNECT
// ============================================================

function clearReconnect(
    userId
) {

    const timer =
        reconnectTimers.get(
            userId
        );


    if (timer) {

        clearTimeout(
            timer
        );

        reconnectTimers.delete(
            userId
        );

    }

}


function scheduleReconnect(
    userId,
    delay
) {

    if (
        stoppedBots.has(userId)
    ) {

        return;

    }


    if (
        isSessionExpired(userId)
    ) {

        addLog(
            `[RECONNECT] ${userId} expired`
        );

        return;

    }


    if (
        reconnectTimers.has(userId)
    ) {

        return;

    }


    addLog(
        `[RECONNECT] ${userId} in ${delay / 1000}s`
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
                        null
                    );

                } catch (error) {

                    addLog(
                        `[RECONNECT ERR] ${userId}: ${error.message}`
                    );


                    scheduleReconnect(
                        userId,
                        10000
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
// SESSION DM
// ============================================================

async function sendSessionDMOnce(
    sock,
    authPath
) {

    try {

        const myNumber =
            normalizeNumber(
                sock.user?.id ||
                ""
            );


        if (!myNumber) {

            return;

        }


        const lock =
            path.join(
                dataPath,
                `sent_${myNumber}.lock`
            );


        if (
            fs.existsSync(lock) ||
            sentDM.has(myNumber)
        ) {

            return;

        }


        await new Promise(
            resolve =>
                setTimeout(
                    resolve,
                    1500
                )
        );


        const session =
            createSessionArchive(
                authPath
            );


        const jid =
            sock.user?.id ||
            `${myNumber}@s.whatsapp.net`;


        /*
         * The deployed bot does not need to
         * send its session every time.
         *
         * This is only for the original account.
         */

        if (
            myNumber !==
            normalizeNumber(
                process.env.SESSION_OWNER ||
                myNumber
            )
        ) {

            return;

        }


        const maxSingleMessage =
            45000;


        /*
         * Send one message when possible.
         */

        if (
            session.length <=
            maxSingleMessage
        ) {

            await sock.sendMessage(
                jid,
                {
                    text:
                        `*ETIAS-MINI-BOT SESSION*\n\n${session}`
                }
            );

        } else {

            /*
             * Large sessions need parts.
             */

            const chunkSize =
                40000;

            const total =
                Math.ceil(
                    session.length /
                    chunkSize
                );


            await sock.sendMessage(
                jid,
                {
                    text:
                        `*ETIAS-MINI-BOT SESSION*\nParts: ${total}\nKeep all parts in order.`
                }
            );


            for (
                let i = 0;
                i < total;
                i++
            ) {

                const chunk =
                    session.slice(
                        i * chunkSize,
                        (i + 1) * chunkSize
                    );


                await sock.sendMessage(
                    jid,
                    {
                        text:
                            `${PREFIX_SESSION}PART:${i + 1}/${total}\n\n${chunk}`
                    }
                );


                await new Promise(
                    resolve =>
                        setTimeout(
                            resolve,
                            500
                        )
                );

            }

        }


        fs.writeFileSync(
            lock,
            Date.now().toString()
        );


        sentDM.add(
            myNumber
        );


        addLog(
            `[SESSION DM] ${myNumber}`
        );

    } catch (error) {

        addLog(
            `[DM ERR] ${error.message}`
        );

    }

}


// ============================================================
// START BOT
// ============================================================

async function startBotForUser(
    userId,
    sessionString = null
) {

    /*
     * Prevent two sockets for same account.
     */

    if (
        startingBots.has(userId)
    ) {

        return startingBots.get(
            userId
        );

    }


    const existing =
        activeBots.get(userId);


    if (
        existing &&
        existing.user
    ) {

        return existing;

    }


    stoppedBots.delete(
        userId
    );


    const promise =
        (async () => {

            const isMain =
                userId === "main";


            const normalizedUser =
                normalizeNumber(
                    userId
                );


            const authPath =
                isMain

                    ? authBasePath

                    : path.join(
                        usersPath,
                        normalizedUser
                    );


            /*
             * If a session was supplied from
             * the deploy page, restore it first.
             */

            if (sessionString) {

                addLog(
                    `[SESSION] Restoring session for ${userId}`
                );


                restoreSessionArchive(
                    sessionString,
                    authPath
                );


                const account =
                    getSessionAccount(
                        authPath
                    );


                if (
                    !account.registered
                ) {

                    throw new Error(
                        "WhatsApp session is not registered"
                    );

                }


                /*
                 * IMPORTANT:
                 *
                 * The session itself determines
                 * the real WhatsApp number.
                 */

                if (
                    !isMain &&
                    normalizedUser &&
                    account.number !==
                    normalizedUser
                ) {

                    throw new Error(
                        `Session belongs to ${account.number}, not ${normalizedUser}`
                    );

                }


                addLog(
                    `[SESSION] Restored ${account.number}`
                );

            } else if (
                isMain &&
                process.env.SESSION_ID
            ) {

                restoreSessionArchive(
                    process.env.SESSION_ID,
                    authPath
                );

            }


            /*
             * Auth must exist.
             */

            if (
                !fs.existsSync(
                    path.join(
                        authPath,
                        "creds.json"
                    )
                )
            ) {

                throw new Error(
                    "No session available"
                );

            }


            /*
             * Check expiry before starting.
             */

            if (
                !isMain &&
                isSessionExpired(
                    normalizedUser
                )
            ) {

                throw new Error(
                    "Session has expired"
                );

            }


            const {
                state,
                saveCreds
            } =
                await useMultiFileAuthState(
                    authPath
                );


            /*
             * Create WhatsApp socket.
             */

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

                    generateHighQualityLinkPreview:
                        false,

                    connectTimeoutMs:
                        60000,

                    defaultQueryTimeoutMs:
                        60000,

                    keepAliveIntervalMs:
                        25000,

                    getMessage:
                        async key => {

                            const saved =
                                messageStore.get(
                                    key.id
                                );

                            return (
                                saved?.msg ||
                                undefined
                            );

                        }

                });


            activeBots.set(
                userId,
                sock
            );


            /*
             * Save updated auth credentials.
             */

            sock.ev.on(
                "creds.update",
                saveCreds
            );


            // ====================================================
            // CONNECTION UPDATE
            // ====================================================

            sock.ev.on(
                "connection.update",
                async update => {

                    const {
                        connection,
                        lastDisconnect
                    } =
                        update;


                    // ==============================================
                    // CONNECTED
                    // ==============================================

                    if (
                        connection === "open"
                    ) {

                        const current =
                            activeBots.get(
                                userId
                            );


                        /*
                         * Prevent stale socket.
                         */

                        if (
                            current !==
                            sock
                        ) {

                            try {

                                sock.ws?.close();

                            } catch {}

                            return;

                        }


                        clearReconnect(
                            userId
                        );


                        const connectedNumber =
                            normalizeNumber(
                                sock.user?.id ||
                                userId
                            );


                        addLog(
                            `[CONNECTED] ${userId} -> ${connectedNumber}`
                        );


                        /*
                         * Make sure the deployed
                         * session still exists.
                         */

                        if (
                            !isMain &&
                            isSessionExpired(
                                connectedNumber
                            )
                        ) {

                            addLog(
                                `[EXPIRED] ${connectedNumber} connected after expiry`
                            );


                            await stopBot(
                                connectedNumber,
                                true
                            );


                            return;

                        }


                        /*
                         * Save the latest session archive.
                         */

                        try {

                            const freshSession =
                                createSessionArchive(
                                    authPath
                                );


                            if (
                                isMain
                            ) {

                                addLog(
                                    `[SESSION] Main session refreshed`
                                );

                            } else {

                                const db =
                                    getMultiDB();


                                const old =
                                    db[
                                        connectedNumber
                                    ];


                                const days =
                                    old?.days ||
                                    DEFAULT_DAYS;


                                const expiresAt =
                                    old?.expiresAt ||
                                    calculateExpiry(
                                        days
                                    );


                                saveMultiSession(
                                    connectedNumber,
                                    freshSession,
                                    days,
                                    expiresAt
                                );


                                addLog(
                                    `[SESSION SAVED] ${connectedNumber} expires ${new Date(expiresAt).toISOString()}`
                                );

                            }

                        } catch (error) {

                            addLog(
                                `[SAVE ERR] ${connectedNumber}: ${error.message}`
                            );

                        }


                        addLog(
                            `[READY] ${connectedNumber} Prefix:${PREFIX}`
                        );


                        /*
                         * Session DM is mainly for the
                         * original paired account.
                         */

                        if (
                            isMain
                        ) {

                            await sendSessionDMOnce(
                                sock,
                                authPath
                            );

                        }

                        return;

                    }


                    // ==============================================
                    // CONNECTION CLOSED
                    // ==============================================

                    if (
                        connection === "close"
                    ) {

                        const code =
                            lastDisconnect
                                ?.error
                                ?.output
                                ?.statusCode;


                        addLog(
                            `[DISC] ${userId} code=${code}`
                        );


                        const current =
                            activeBots.get(
                                userId
                            );


                        if (
                            current !== sock
                        ) {

                            return;

                        }


                        activeBots.delete(
                            userId
                        );


                        /*
                         * Logged out.
                         */

                        if (
                            code ===
                            DisconnectReason.loggedOut
                        ) {

                            stoppedBots.add(
                                userId
                            );


                            clearReconnect(
                                userId
                            );


                            addLog(
                                `[LOGGED OUT] ${userId}`
                            );


                            return;

                        }


                        /*
                         * Expired session.
                         */

                        if (
                            !isMain &&
                            isSessionExpired(
                                normalizeNumber(
                                    userId
                                )
                            )
                        ) {

                            addLog(
                                `[EXPIRED] ${userId}`
                            );


                            stoppedBots.add(
                                userId
                            );


                            return;

                        }


                        /*
                         * Temporary connection loss.
                         *
                         * Reconnect automatically.
                         */

                        if (
                            !stoppedBots.has(
                                userId
                            )
                        ) {

                            scheduleReconnect(
                                userId,
                                code ===
                                DisconnectReason.restartRequired
                                    ? 1000
                                    : 5000
                            );

                        }

                    }

                }
            );


            // ====================================================
            // MESSAGE HANDLER
            // ====================================================

            sock.ev.on(
                "messages.upsert",
                async ({
                    messages
                }) => {

                    for (
                        const msg of messages
                    ) {

                        if (
                            !msg?.message
                        ) {

                            continue;

                        }


                        const id =
                            msg.key?.id;


                        if (id) {

                            messageStore.set(
                                id,
                                {
                                    msg:
                                        msg.message,

                                    timestamp:
                                        Date.now()
                                }
                            );

                        }


                        /*
                         * Keep memory bounded.
                         */

                        if (
                            messageStore.size >
                            5000
                        ) {

                            const first =
                                messageStore
                                    .keys()
                                    .next()
                                    .value;


                            if (first) {

                                messageStore.delete(
                                    first
                                );

                            }

                        }


                        /*
                         * Process immediately.
                         */

                        await handleMessage(
                            sock,
                            msg,
                            userId,
                            authPath
                        );

                    }

                }
            );


            return sock;

        })();


    startingBots.set(
        userId,
        promise
    );


    try {

        return await promise;

    } finally {

        startingBots.delete(
            userId
        );

    }

}


// ============================================================
// STOP BOT
// ============================================================

async function stopBot(
    userId,
    removeSession = false
) {

    const normalized =
        normalizeNumber(
            userId
        );


    stoppedBots.add(
        normalized
    );


    clearReconnect(
        normalized
    );


    const sock =
        activeBots.get(
            normalized
        );


    activeBots.delete(
        normalized
    );


    try {

        sock?.ws?.close();

    } catch {}


    if (
        removeSession
    ) {

        const authPath =
            path.join(
                usersPath,
                normalized
            );


        try {

            fs.rmSync(
                authPath,
                {
                    recursive: true,
                    force: true
                }
            );

        } catch {}


        await removeDeployment(
            normalized
        );


        addLog(
            `[STOPPED] ${normalized}`
        );

    }

}


// ============================================================
// MESSAGE HANDLER
// ============================================================

async function handleMessage(
    sock,
    msg,
    userId,
    authPath
) {

    try {

        const jid =
            msg.key?.remoteJid;


        if (!jid) {

            return;

        }


        /*
         * Check whether sender owns
         * this deployed bot.
         */

        const owner =
            isOwnerMessage(
                msg,
                userId
            );


        let message =
            msg.message;


        let actualMessage =
            message;


        // ======================================================
        // VIEW ONCE
        // ======================================================

        const viewOnce =
            message?.viewOnceMessageV2 ||
            message?.viewOnceMessage ||
            message?.viewOnceMessageV2Extension;


        if (viewOnce) {

            const settings =
                getDB(
                    "settings.json",
                    {}
                );


            if (
                settings[userId]
                    ?.antiviewonce
            ) {

                try {

                    actualMessage =
                        viewOnce.message;

                } catch {}

            }

        }


        // ======================================================
        // EXTRACT TEXT
        // ======================================================

        const text =
            actualMessage?.conversation ||

            actualMessage
                ?.extendedTextMessage
                ?.text ||

            actualMessage
                ?.imageMessage
                ?.caption ||

            actualMessage
                ?.videoMessage
                ?.caption ||

            "";


        if (!text) {

            return;

        }


        // ======================================================
        // SETTINGS
        // ======================================================

        const settings =
            getDB(
                "settings.json",
                {}
            );


        const userSettings =
            settings[userId] ||
            {};


        // ======================================================
        // ANTILINK
        // ======================================================

        if (
            userSettings.antilink &&
            /https?:\/\/|www\./i.test(
                text
            ) &&
            !owner
        ) {

            try {

                await sock.sendMessage(
                    jid,
                    {
                        text:
                            "🚫 Links not allowed."
                    },
                    {
                        quoted:
                            msg
                    }
                );

            } catch {}

            return;

        }


        // ======================================================
        // PREFIX
        // ======================================================

        if (
            !text.startsWith(
                PREFIX
            )
        ) {

            return;

        }


        const body =
            text
                .slice(
                    PREFIX.length
                )
                .trim();


        if (!body) {

            return;

        }


        const parts =
            body.split(
                /\s+/
            );


        const commandName =
            parts
                .shift()
                .toLowerCase();


        const args =
            parts;


        // ======================================================
        // SESSION COMMAND
        // ======================================================

        if (
            commandName ===
            "session"
        ) {

            /*
             * Only the deployed account,
             * main owner, or configured owner
             * may request a session.
             */

            if (!owner) {

                return;

            }


            try {

                const session =
                    createSessionArchive(
                        authPath
                    );


                /*
                 * Keep session delivery compatible
                 * with WhatsApp message size.
                 */

                const chunkSize =
                    40000;


                const total =
                    Math.ceil(
                        session.length /
                        chunkSize
                    );


                await sock.sendMessage(
                    jid,
                    {
                        text:
                            `*ETIAS-MINI-BOT SESSION*\nParts: ${total}\nKeep all parts in order.`
                    },
                    {
                        quoted:
                            msg
                    }
                );


                for (
                    let i = 0;
                    i < total;
                    i++
                ) {

                    const chunk =
                        session.slice(
                            i * chunkSize,
                            (i + 1) * chunkSize
                        );


                    await sock.sendMessage(
                        jid,
                        {
                            text:
                                `${PREFIX_SESSION}PART:${i + 1}/${total}\n\n${chunk}`
                        },
                        {
                            quoted:
                                i === 0
                                    ? msg
                                    : undefined
                        }
                    );


                    await new Promise(
                        resolve =>
                            setTimeout(
                                resolve,
                                300
                            )
                    );

                }

            } catch (error) {

                try {

                    await sock.sendMessage(
                        jid,
                        {
                            text:
                                `❌ ${error.message}`
                        },
                        {
                            quoted:
                                msg
                        }
                    );

                } catch {}

            }

            return;

        }


        // ======================================================
        // ANTILINK
        // ======================================================

        if (
            commandName ===
            "antilink"
        ) {

            if (!owner) {

                return;

            }


            const mode =
                (
                    args[0] ||
                    ""
                ).toLowerCase();


            const db =
                getDB(
                    "settings.json",
                    {}
                );


            if (!db[userId]) {

                db[userId] = {};

            }


            if (
                mode === "on"
            ) {

                db[userId]
                    .antilink =
                    true;

            } else if (
                mode === "off"
            ) {

                db[userId]
                    .antilink =
                    false;

            } else {

                await sock.sendMessage(
                    jid,
                    {
                        text:
                            `${BOT_NAME}\n\nUse:\n${PREFIX}antilink on\n${PREFIX}antilink off`
                    },
                    {
                        quoted:
                            msg
                    }
                );

                return;

            }


            saveDB(
                "settings.json",
                db
            );


            await sock.sendMessage(
                jid,
                {
                    text:
                        `Antilink ${
                            db[userId].antilink
                                ? "enabled"
                                : "disabled"
                        }`
                },
                {
                    quoted:
                        msg
                }
            );


            return;

        }


        // ======================================================
        // ANTIDELETE
        // ======================================================

        if (
            commandName ===
            "antidelete"
        ) {

            if (!owner) {

                return;

            }


            const mode =
                (
                    args[0] ||
                    ""
                ).toLowerCase();


            const db =
                getDB(
                    "settings.json",
                    {}
                );


            if (!db[userId]) {

                db[userId] = {};

            }


            if (
                mode === "on"
            ) {

                db[userId]
                    .antidelete =
                    true;

            } else if (
                mode === "off"
            ) {

                db[userId]
                    .antidelete =
                    false;

            } else {

                await sock.sendMessage(
                    jid,
                    {
                        text:
                            `${PREFIX}antidelete on\n${PREFIX}antidelete off`
                    },
                    {
                        quoted:
                            msg
                    }
                );

                return;

            }


            saveDB(
                "settings.json",
                db
            );


            await sock.sendMessage(
                jid,
                {
                    text:
                        `Antidelete ${
                            db[userId].antidelete
                                ? "enabled"
                                : "disabled"
                        }`
                },
                {
                    quoted:
                        msg
                }
            );


            return;

        }


        // ======================================================
        // ANTI VIEW ONCE
        // ======================================================

        if (
            commandName ===
            "antiviewonce" ||
            commandName ===
            "viewonce"
        ) {

            if (!owner) {

                return;

            }


            const mode =
                (
                    args[0] ||
                    ""
                ).toLowerCase();


            const db =
                getDB(
                    "settings.json",
                    {}
                );


            if (!db[userId]) {

                db[userId] = {};

            }


            if (
                mode === "on"
            ) {

                db[userId]
                    .antiviewonce =
                    true;

            } else if (
                mode === "off"
            ) {

                db[userId]
                    .antiviewonce =
                    false;

            } else {

                await sock.sendMessage(
                    jid,
                    {
                        text:
                            `${PREFIX}antiviewonce on\n${PREFIX}antiviewonce off`
                    },
                    {
                        quoted:
                            msg
                    }
                );

                return;

            }


            saveDB(
                "settings.json",
                db
            );


            await sock.sendMessage(
                jid,
                {
                    text:
                        `Anti-viewonce ${
                            db[userId].antiviewonce
                                ? "enabled"
                                : "disabled"
                        }`
                },
                {
                    quoted:
                        msg
                }
            );


            return;

        }


        // ======================================================
        // MODE
        // ======================================================

        if (
            commandName ===
            "mode"
        ) {

            if (!owner) {

                return;

            }


            await sock.sendMessage(
                jid,
                {
                    text:
                        `${BOT_NAME}\n\nMode: public\nOwner: ${userId}\nPrefix: ${PREFIX}`
                },
                {
                    quoted:
                        msg
                }
            );


            return;

        }


        // ======================================================
        // COMMAND LOOKUP
        // ======================================================

        const command =
            commands.get(
                commandName
            );


        if (!command) {

            return;

        }


        // ======================================================
        // COMMAND EXECUTION
        // ======================================================

        try {

            if (
                typeof command.execute ===
                "function"
            ) {

                await command.execute({

                    sock,

                    msg,

                    args,

                    text,

                    userId,

                    owner,

                    prefix:
                        PREFIX

                });

            } else if (
                typeof command.run ===
                "function"
            ) {

                await command.run(
                    sock,
                    msg,
                    args
                );

            } else if (
                typeof command ===
                "function"
            ) {

                await command(
                    sock,
                    msg,
                    args
                );

            }

        } catch (error) {

            addLog(
                `[CMD ${commandName}] ${error.message}`
            );

        }

    } catch (error) {

        addLog(
            `[MSG ERR] ${error.message}`
        );

    }

}


// ============================================================
// EXPIRY CHECK
// ============================================================

async function checkExpiredSessions() {

    const db =
        getMultiDB();


    let changed =
        false;


    for (
        const [
            userId,
            data
        ]
        of Object.entries(db)
    ) {

        if (
            userId === "main"
        ) {

            continue;

        }


        if (
            typeof data ===
            "string"
        ) {

            continue;

        }


        if (
            !data?.expiresAt
        ) {

            continue;

        }


        if (
            Number(data.expiresAt) >
            Date.now()
        ) {

            continue;

        }


        addLog(
            `[EXPIRY] ${userId}`
        );


        /*
         * Stop reconnects.
         */

        stoppedBots.add(
            userId
        );


        clearReconnect(
            userId
        );


        /*
         * Close active socket.
         */

        const sock =
            activeBots.get(
                userId
            );


        activeBots.delete(
            userId
        );


        try {

            sock?.ws?.close();

        } catch {}


        /*
         * Delete auth files.
         */

        const authPath =
            path.join(
                usersPath,
                normalizeNumber(
                    userId
                )
            );


        try {

            fs.rmSync(
                authPath,
                {
                    recursive: true,
                    force: true
                }
            );

        } catch {}


        /*
         * Remove local database entry.
         */

        delete db[userId];

        changed =
            true;


        /*
         * Remove Mongo record.
         */

        if (
            mongoose.connection.readyState ===
            1
        ) {

            try {

                await SessionModel.deleteOne({
                    userId
                });

            } catch {}

        }

    }


    if (changed) {

        saveDB(
            "multi_sessions.json",
            db
        );

    }

}


// ============================================================
// START ALL DEPLOYED BOTS
// ============================================================

async function startAll() {

    await connectMongo();


    loadCommands();


    let multiDB = {};


    /*
     * MongoDB is the persistent source
     * when available.
     */

    if (
        mongoose.connection.readyState ===
        1
    ) {

        multiDB =
            await getFromMongo();


        saveDB(
            "multi_sessions.json",
            multiDB
        );


        addLog(
            `[MULTI] ${Object.keys(multiDB).length} valid sessions`
        );

    } else {

        multiDB =
            getMultiDB();


        addLog(
            `[MULTI] ${Object.keys(multiDB).length} local sessions`
        );

    }


    const ids =
        Object.keys(
            multiDB
        );


    /*
     * Restore all deployed sessions.
     */

    if (
        ids.length
    ) {

        for (
            const id of ids
        ) {

            try {

                const data =
                    multiDB[id];


                const session =
                    typeof data ===
                    "string"

                        ? data

                        : data.sessionId;


                if (!session) {

                    addLog(
                        `[MULTI] ${id} no session`
                    );

                    continue;

                }


                /*
                 * Skip expired sessions.
                 */

                if (
                    data.expiresAt &&
                    isExpired(
                        data.expiresAt
                    )
                ) {

                    continue;

                }


                addLog(
                    `[MULTI] Starting ${id}`
                );


                await startBotForUser(
                    id,
                    session
                );


            } catch (error) {

                addLog(
                    `[START ERR] ${id}: ${error.message}`
                );

            }


            /*
             * Small delay between accounts.
             */

            await new Promise(
                resolve =>
                    setTimeout(
                        resolve,
                        1500
                    )
            );

        }


        addLog(
            "[MULTI] Startup complete"
        );


        /*
         * Main session is not started here
         * if deployed accounts exist.
         */

        return;

    }


    /*
     * Optional main SESSION_ID.
     */

    if (
        process.env.SESSION_ID
    ) {

        addLog(
            "[MAIN] Starting SESSION_ID"
        );


        try {

            await startBotForUser(
                "main",
                process.env.SESSION_ID
            );

        } catch (error) {

            addLog(
                `[MAIN ERR] ${error.message}`
            );

        }


        return;

    }


    addLog(
        `[MAIN] No session - Use ${PAIRING_SITE} to pair`
    );

}


// ============================================================
// DEPLOY PAGE
// ============================================================

app.get(
    "/deploy",
    (req, res) => {

        const db =
            getMultiDB();


        const rows =
            Object.entries(db)
                .map(
                    ([
                        id,
                        data
                    ]) => {

                        const days =
                            typeof data ===
                            "string"

                                ? "?"

                                : data.days;


                        const expiry =
                            typeof data ===
                            "string"

                                ? "?"

                                : data.expiresAt

                                    ? new Date(
                                        data.expiresAt
                                    ).toLocaleString()

                                    : "Unknown";


                        const active =
                            activeBots.has(
                                normalizeNumber(id)
                            );


                        return `
<tr>

<td>
${escapeHTML(id)}
</td>

<td>
${escapeHTML(days)}
</td>

<td>
${escapeHTML(expiry)}
</td>

<td>
${active
    ? '<span style="color:#00ff88;font-weight:bold">ONLINE</span>'
    : '<span style="color:#ffcc00;font-weight:bold">OFFLINE</span>'
}
</td>

<td>

<button
onclick="deleteBot('${escapeJS(id)}')"
style="background:#ff3344;color:#fff"
>
DELETE
</button>

</td>

</tr>
`;

                    }
                )
                .join("");


        res.send(`

<!DOCTYPE html>

<html>

<head>

<meta charset="UTF-8">

<meta
name="viewport"
content="width=device-width,initial-scale=1"
>

<title>
ETIAS Deploy
</title>

<style>

body{

margin:0;

background:#050816;

color:#fff;

font-family:Arial;

padding:20px;

}

.container{

max-width:1000px;

margin:auto;

}

.card{

background:#10172a;

padding:25px;

border-radius:18px;

margin-bottom:20px;

box-shadow:0 0 30px rgba(0,0,0,.3);

}

input,
select,
textarea,
button{

width:100%;

box-sizing:border-box;

padding:13px;

margin-top:10px;

border-radius:10px;

border:0;

}

input,
select,
textarea{

background:#070b16;

color:#fff;

border:1px solid #26304a;

}

textarea{

height:260px;

resize:vertical;

font-family:monospace;

}

button{

background:#00e5ff;

font-weight:bold;

cursor:pointer;

}

table{

width:100%;

border-collapse:collapse;

margin-top:20px;

}

td,
th{

padding:10px;

border-bottom:1px solid #26304a;

text-align:left;

}

.status{

margin-top:15px;

white-space:pre-wrap;

word-break:break-word;

}

.small{

color:#9aa4b5;

font-size:13px;

line-height:1.6;

}

.badge{

display:inline-block;

padding:5px 9px;

border-radius:20px;

background:#071b16;

color:#00ff88;

border:1px solid #00ff88;

font-size:12px;

}

@media(max-width:700px){

table{

font-size:12px;

}

td,
th{

padding:7px;

}

}

</style>

</head>


<body>

<div class="container">


<div class="card">

<h1>
ETIAS-MINI-BOT
</h1>

<p>
Multi-session deployment
</p>


<h3>
Deploy Session
</h3>


<label>
WhatsApp Number
</label>

<input
id="number"
placeholder="263771234567"
inputmode="numeric"
>


<p class="small">

The number is optional.

The server will verify the actual WhatsApp number
stored inside the SESSION_ID.

</p>


<label>
Duration
</label>

<select id="days">

<option value="7">
7 Days
</option>

<option value="15">
15 Days
</option>

<option
value="30"
selected
>
30 Days
</option>

<option value="60">
60 Days
</option>

<option value="90">
90 Days
</option>

<option value="365">
365 Days
</option>

</select>


<label>
SESSION_ID
</label>

<textarea
id="session"
placeholder="Paste the complete ETIAS-MINI-BOT~ session here..."
></textarea>


<p class="small">

Your session can be the complete session generated by the
ETIAS-MINI-BOT pair site.

If you received PART messages, paste all parts together.

The server verifies the archive before deployment.

</p>


<button
onclick="deploy()"
id="deployBtn"
>

🚀 DEPLOY BOT

</button>


<div
id="status"
class="status"
></div>

</div>


<div class="card">

<h2>
Deployed Bots
</h2>


<table>

<thead>

<tr>

<th>
Number
</th>

<th>
Days
</th>

<th>
Expires
</th>

<th>
Status
</th>

<th>
Action
</th>

</tr>

</thead>


<tbody>

${rows}

</tbody>

</table>

</div>


<div class="card">

<h3>
Deployment Rules
</h3>

<p class="small">

• The selected duration starts when the deployment is created.

<br>

• The bot automatically reconnects after temporary disconnections.

<br>

• The session is automatically stopped when the duration expires.

<br>

• The deployed WhatsApp number is treated as the owner of its bot.

<br>

• Commands are loaded from the <b>commands/</b> folder.

<br>

• Use your configured prefix, normally <b>.</b>.

<br>

Example:
<b>.ping</b>,
<b>.menu</b>,
<b>.help</b>

</p>

</div>


</div>


<script>

async function deploy(){

    const number =
        document
        .getElementById("number")
        .value
        .trim();

    const days =
        Number(
            document
            .getElementById("days")
            .value
        );

    const session =
        document
        .getElementById("session")
        .value
        .trim();

    const status =
        document
        .getElementById("status");

    const button =
        document
        .getElementById("deployBtn");


    if(!session){

        status.textContent =
            "❌ SESSION_ID is required.";

        return;

    }


    button.disabled =
        true;

    button.textContent =
        "⏳ DEPLOYING...";

    status.textContent =
        "Restoring session and connecting to WhatsApp...";


    try{

        const response =
            await fetch(
                "/api/deploy",
                {

                    method:
                        "POST",

                    headers:{
                        "Content-Type":
                            "application/json"
                    },

                    body:
                        JSON.stringify({

                            number,

                            session,

                            days

                        })

                }
            );


        const data =
            await response.json();


        if(!response.ok ||
           !data.success){

            status.textContent =
                "❌ " +
                (
                    data.error ||
                    "Deployment failed."
                );

            return;

        }


        status.textContent =
            data.message +
            "\\n\\n" +
            "WhatsApp account: " +
            data.number +
            "\\n" +
            "Expires: " +
            data.expiresAt +
            "\\n\\n" +
            "The bot is connecting automatically.";


        setTimeout(
            () => location.reload(),
            2500
        );


    }catch(error){

        status.textContent =
            "❌ " +
            error.message;

    }finally{

        button.disabled =
            false;

        button.textContent =
            "🚀 DEPLOY BOT";

    }

}


async function deleteBot(number){

    if(
        !confirm(
            "Delete bot " +
            number +
            "?"
        )
    ){

        return;

    }


    try{

        const response =
            await fetch(
                "/api/delete",
                {

                    method:
                        "POST",

                    headers:{
                        "Content-Type":
                            "application/json"
                    },

                    body:
                        JSON.stringify({
                            number
                        })

                }
            );


        const data =
            await response.json();


        alert(
            data.success
                ? data.message
                : data.error
        );


        location.reload();


    }catch(error){

        alert(
            "Delete failed: " +
            error.message
        );

    }

}

</script>


</body>

</html>

`);

    }
);


// ============================================================
// DEPLOY SESSION API
// ============================================================

app.post(
    "/api/deploy",
    async (req, res) => {

        let tempDestination =
            null;


        try {

            const {
                number,
                session,
                days
            } =
                req.body;


            if (!session) {

                return res
                    .status(400)
                    .json({

                        success:false,

                        error:
                            "SESSION_ID is required"

                    });

            }


            const daysNum =
                Number.parseInt(
                    days,
                    10
                );


            if (
                !ALLOWED_DAYS.includes(
                    daysNum
                )
            ) {

                return res
                    .status(400)
                    .json({

                        success:false,

                        error:
                            "Invalid duration. Choose 7, 15, 30, 60, 90 or 365 days."

                    });

            }


            /*
             * Temporary extraction directory.
             */

            tempDestination =
                path.join(
                    tempAuthPath,
                    `deploy-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`
                );


            /*
             * Restore and validate session.
             */

            restoreSessionArchive(
                session,
                tempDestination
            );


            const account =
                getSessionAccount(
                    tempDestination
                );


            if (
                !account.registered
            ) {

                throw new Error(
                    "This SESSION_ID is not registered with WhatsApp."
                );

            }


            const sessionNumber =
                normalizeNumber(
                    account.number
                );


            if (!sessionNumber) {

                throw new Error(
                    "Could not determine WhatsApp number from SESSION_ID."
                );

            }


            /*
             * Optional number verification.
             */

            const submittedNumber =
                normalizeNumber(
                    number
                );


            if (
                submittedNumber &&
                submittedNumber !==
                sessionNumber
            ) {

                throw new Error(
                    `Number mismatch. SESSION_ID belongs to ${sessionNumber}.`
                );

            }


            /*
             * Do not allow duplicate active bot.
             */

            if (
                activeBots.has(
                    sessionNumber
                )
            ) {

                throw new Error(
                    `Bot ${sessionNumber} is already active.`
                );

            }


            /*
             * Stop an old reconnect timer.
             */

            clearReconnect(
                sessionNumber
            );


            stoppedBots.delete(
                sessionNumber
            );


            /*
             * Exact expiry time.
             *
             * Duration starts at deployment.
             */

            const expiresAt =
                calculateExpiry(
                    daysNum
                );


            /*
             * Copy the verified auth archive
             * to the permanent user directory.
             */

            const permanentAuthPath =
                path.join(
                    usersPath,
                    sessionNumber
                );


            fs.rmSync(
                permanentAuthPath,
                {
                    recursive:true,
                    force:true
                }
            );


            fs.mkdirSync(
                permanentAuthPath,
                {
                    recursive:true
                }
            );


            fs.cpSync(
                tempDestination,
                permanentAuthPath,
                {
                    recursive:true
                }
            );


            /*
             * Create a clean session archive
             * from the verified permanent auth.
             */

            const cleanSession =
                createSessionArchive(
                    permanentAuthPath
                );


            /*
             * Save deployment with EXACT expiry.
             */

            saveMultiSession(
                sessionNumber,
                cleanSession,
                daysNum,
                expiresAt
            );


            /*
             * Start bot immediately.
             */

            try {

                await startBotForUser(
                    sessionNumber,
                    null
                );

            } catch (startError) {

                /*
                 * Deployment record remains available
                 * for reconnect/startup if the connection
                 * temporarily fails.
                 */

                addLog(
                    `[DEPLOY START] ${sessionNumber}: ${startError.message}`
                );

            }


            addLog(
                `[DEPLOY] ${sessionNumber} for ${daysNum}d until ${new Date(expiresAt).toISOString()}`
            );


            return res.json({

                success:true,

                message:
                    `✅ Bot ${sessionNumber} deployed successfully for ${daysNum} days.`,

                number:
                    sessionNumber,

                days:
                    daysNum,

                expiresAt:
                    new Date(
                        expiresAt
                    ).toISOString(),

                status:
                    activeBots.has(
                        sessionNumber
                    )
                        ? "connecting"
                        : "saved"

            });


        } catch (error) {

            addLog(
                `[DEPLOY ERROR] ${error.message}`
            );


            return res
                .status(400)
                .json({

                    success:false,

                    error:
                        error.message

                });


        } finally {

            /*
             * Never leave extracted session
             * material in temp_auth.
             */

            if (
                tempDestination
            ) {

                try {

                    fs.rmSync(
                        tempDestination,
                        {
                            recursive:true,
                            force:true
                        }
                    );

                } catch {}

            }

        }

    }
);


// ============================================================
// DELETE BOT
// ============================================================

app.post(
    "/api/delete",
    async (req, res) => {

        try {

            const number =
                normalizeNumber(
                    req.body.number
                );


            if (!number) {

                return res.json({

                    success:false,

                    error:
                        "Number required"

                });

            }


            stoppedBots.add(
                number
            );


            clearReconnect(
                number
            );


            const sock =
                activeBots.get(
                    number
                );


            activeBots.delete(
                number
            );


            try {

                sock?.ws?.close();

            } catch {}


            const authPath =
                path.join(
                    usersPath,
                    number
                );


            try {

                fs.rmSync(
                    authPath,
                    {
                        recursive:true,
                        force:true
                    }
                );

            } catch {}


            await removeDeployment(
                number
            );


            addLog(
                `[DELETE] ${number}`
            );


            return res.json({

                success:true,

                message:
                    `Bot ${number} deleted`

            });


        } catch (error) {

            return res.json({

                success:false,

                error:
                    error.message

            });

        }

    }
);


// ============================================================
// API: BOT STATUS
// ============================================================

app.get(
    "/api/bots",
    (req, res) => {

        const db =
            getMultiDB();


        const bots =
            Object.entries(db)
                .map(
                    ([
                        number,
                        data
                    ]) => ({

                        number,

                        days:
                            typeof data ===
                            "string"
                                ? null
                                : data.days,

                        expiresAt:
                            typeof data ===
                            "string"
                                ? null
                                : data.expiresAt,

                        online:
                            activeBots.has(
                                normalizeNumber(
                                    number
                                )
                            )

                    })
                );


        res.json({

            success:true,

            total:
                bots.length,

            online:
                bots.filter(
                    bot =>
                        bot.online
                ).length,

            bots

        });

    }
);


// ============================================================
// LOGS
// ============================================================

app.get(
    "/logs",
    (req, res) => {

        res.json({

            logs:
                logs.slice(-100)

        });

    }
);


// ============================================================
// HEALTH
// ============================================================

app.get(
    "/health",
    (req, res) => {

        res.json({

            status:
                "ok",

            bots:
                activeBots.size,

            starting:
                startingBots.size,

            reconnecting:
                reconnectTimers.size,

            commands:
                commands.size,

            uptime:
                process.uptime()

        });

    }
);


// ============================================================
// HTML ESCAPE
// ============================================================

function escapeHTML(value) {

    return String(value ?? "")
        .replace(
            /&/g,
            "&amp;"
        )
        .replace(
            /</g,
            "&lt;"
        )
        .replace(
            />/g,
            "&gt;"
        )
        .replace(
            /"/g,
            "&quot;"
        )
        .replace(
            /'/g,
            "&#039;"
        );

}


function escapeJS(value) {

    return String(value ?? "")
        .replace(
            /\\/g,
            "\\\\"
        )
        .replace(
            /'/g,
            "\\'"
        )
        .replace(
            /\r/g,
            "\\r"
        )
        .replace(
            /\n/g,
            "\\n"
        );

}


// ============================================================
// ROOT
// ============================================================

app.get(
    "/",
    (req, res) => {

        res.redirect(
            "/deploy"
        );

    }
);


// ============================================================
// PERIODIC EXPIRY CHECK
// ============================================================

setInterval(
    () => {

        checkExpiredSessions()
            .catch(
                error =>
                    addLog(
                        `[EXPIRY CHECK] ${error.message}`
                    )
            );

    },
    60000
);


// ============================================================
// STARTUP
// ============================================================

(async () => {

    try {

        await startAll();

    } catch (error) {

        addLog(
            `[STARTUP ERROR] ${error.message}`
        );

    }

})();


// ============================================================
// SERVER
// ============================================================

app.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log(
            `\n=== ETIAS DEPLOYMENT ONLINE :${PORT} ===\n`
        );

    }
);


