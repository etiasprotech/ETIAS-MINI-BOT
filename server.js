"use strict";

require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");
const fsp = fs.promises;
const crypto = require("crypto");
const pino = require("pino");
const QRCode = require("qrcode");

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    Browsers,
    makeCacheableSignalKeyStore
} = require("@whiskeysockets/baileys");

const {
    createPairing,
    getPairing,
    updatePairing,
    getAllPairings,
    generateUserId,
    addDeployedUser,
    loadDeployed
} = require("./id");

const app = express();

/* =========================================================
   CONFIG
========================================================= */

const PORT =
    process.env.PORT || 3000;

const BOT_NAME =
    process.env.BOT_NAME ||
    "ETIAS-MINI-BOT";

const ROOT =
    __dirname;

const AUTH_DIR =
    path.join(ROOT, "auth");

const DATA_DIR =
    path.join(ROOT, "data");

const MEDIA_DIR =
    path.join(ROOT, "media");

const TEMP_AUTH_DIR =
    path.join(ROOT, "temp_auth");

/*
 * Session format:
 *
 * ETIAS-MINI-BOT~12345678
 *
 * Exactly 8 digits after the ~
 */
const SESSION_PREFIX =
    "ETIAS-MINI-BOT~";

const SESSION_REGEX =
    /^ETIAS-MINI-BOT~\d{8}$/;

/* =========================================================
   LOGGER
========================================================= */

const logger = pino({
    level:
        process.env.LOG_LEVEL ||
        "silent"
});

/* =========================================================
   EXPRESS
========================================================= */

app.use(
    express.json({
        limit: "10mb"
    })
);

app.use(
    express.urlencoded({
        extended: true,
        limit: "10mb"
    })
);

app.use(
    express.static(ROOT)
);

/* =========================================================
   RUNTIME STORES
========================================================= */

/*
 * pairingId -> WhatsApp socket
 */
const sockets = new Map();

/*
 * pairingId -> reconnect lock
 */
const reconnecting = new Set();

/*
 * sessionId -> deployment information
 *
 * IMPORTANT:
 * This is also persisted to data/sessions.json
 * so a restart does not immediately destroy the mapping.
 */
const sessions = new Map();

/* =========================================================
   DIRECTORY SETUP
========================================================= */

async function ensureDirectories() {

    await fsp.mkdir(
        AUTH_DIR,
        {
            recursive: true
        }
    );

    await fsp.mkdir(
        DATA_DIR,
        {
            recursive: true
        }
    );

    await fsp.mkdir(
        MEDIA_DIR,
        {
            recursive: true
        }
    );

    await fsp.mkdir(
        TEMP_AUTH_DIR,
        {
            recursive: true
        }
    );
}

/* =========================================================
   SESSION DATABASE
========================================================= */

const SESSION_FILE =
    path.join(
        DATA_DIR,
        "sessions.json"
    );

async function loadSessions() {

    try {

        if (
            !fs.existsSync(
                SESSION_FILE
            )
        ) {
            return;
        }

        const raw =
            await fsp.readFile(
                SESSION_FILE,
                "utf8"
            );

        if (!raw.trim()) {
            return;
        }

        const data =
            JSON.parse(raw);

        if (
            !Array.isArray(data)
        ) {
            return;
        }

        sessions.clear();

        for (
            const item of data
        ) {

            if (
                item &&
                item.sessionId
            ) {
                sessions.set(
                    item.sessionId,
                    item
                );
            }
        }

        console.log(
            `[SESSION DB] Loaded ${sessions.size} sessions`
        );

    } catch (error) {

        console.error(
            "[SESSION DB] Load error:",
            error.message
        );
    }
}

async function saveSessions() {

    try {

        const data =
            Array.from(
                sessions.values()
            );

        await fsp.writeFile(
            SESSION_FILE,
            JSON.stringify(
                data,
                null,
                2
            )
        );

    } catch (error) {

        console.error(
            "[SESSION DB] Save error:",
            error.message
        );
    }
}

/* =========================================================
   HELPERS
========================================================= */

function sleep(ms) {

    return new Promise(
        resolve =>
            setTimeout(
                resolve,
                ms
            )
    );
}

function cleanNumber(number) {

    return String(
        number || ""
    )
        .replace(
            /\D/g,
            ""
        );
}

function normalizeJid(jid) {

    if (!jid) {
        return null;
    }

    return String(jid)
        .trim()
        .replace(
            /:\d+(?=@)/,
            ""
        );
}

function numberFromJid(jid) {

    const normalized =
        normalizeJid(jid);

    if (!normalized) {
        return "";
    }

    return normalized
        .split("@")[0]
        .replace(
            /\D/g,
            ""
        );
}

/* =========================================================
   SESSION ID
========================================================= */

function generateSessionId() {

    const number =
        crypto.randomInt(
            0,
            100000000
        );

    return (
        SESSION_PREFIX +
        String(number)
            .padStart(
                8,
                "0"
            )
    );
}

function isValidSessionId(
    sessionId
) {

    return SESSION_REGEX.test(
        String(
            sessionId || ""
        ).trim()
    );
}

function createUniqueSessionId() {

    let sessionId;

    do {

        sessionId =
            generateSessionId();

    } while (
        sessions.has(
            sessionId
        )
    );

    return sessionId;
}

/* =========================================================
   DISCONNECT HELPERS
========================================================= */

function getDisconnectCode(
    lastDisconnect
) {

    return (
        lastDisconnect?.error
            ?.output?.statusCode ||

        lastDisconnect?.error
            ?.data?.statusCode ||

        lastDisconnect?.error
            ?.statusCode ||

        null
    );
}

function isLoggedOut(code) {

    return (
        code ===
        DisconnectReason.loggedOut
    );
}

function isBadSession(code) {

    return (
        code ===
        DisconnectReason.badSession
    );
}

function isRestartRequired(code) {

    return (
        code ===
        DisconnectReason.restartRequired
    );
}

/* =========================================================
   FIND SESSION
========================================================= */

function getSessionById(
    sessionId
) {

    return sessions.get(
        String(
            sessionId || ""
        ).trim()
    );
}

/* =========================================================
   SAVE SESSION
========================================================= */

async function saveSession(
    data
) {

    sessions.set(
        data.sessionId,
        {
            ...data,
            updatedAt:
                new Date().toISOString()
        }
    );

    await saveSessions();
}

/* =========================================================
   SEND SESSION ID
========================================================= */

async function sendSessionId(
    sock,
    sessionId,
    targetJid
) {

    if (!sock) {
        throw new Error(
            "WhatsApp socket unavailable"
        );
    }

    if (!sessionId) {
        throw new Error(
            "Session ID unavailable"
        );
    }

    if (!targetJid) {
        throw new Error(
            "Target WhatsApp JID unavailable"
        );
    }

    const message =
        "╭━━━〔 ETIAS-MINI-BOT 〕━━━╮\n" +
        "┃\n" +
        "┃ ✅ PAIRING SUCCESSFUL\n" +
        "┃\n" +
        "┃ YOUR SESSION ID\n" +
        "┃\n" +
        `┃ ${sessionId}\n` +
        "┃\n" +
        "┃ Copy the Session ID above\n" +
        "┃ and paste it on the\n" +
        "┃ deployment page.\n" +
        "┃\n" +
        "┃ Do NOT share this ID.\n" +
        "┃\n" +
        "╰━━━━━━━━━━━━━━━━━━━━━━╯";

    await sock.sendMessage(
        targetJid,
        {
            text:
                message
        }
    );

    console.log(
        `[SESSION] Session ID sent: ${sessionId}`
    );
}

/* =========================================================
   SAVE SUCCESSFUL DEPLOYMENT
========================================================= */

async function saveSuccessfulDeployment(
    session,
    days
) {

    const now =
        new Date();

    const duration =
        Math.max(
            1,
            Number(days || 30)
        );

    const expireAt =
        new Date(
            now.getTime() +
            duration *
                86400000
        );

    session.status =
        "deployed";

    session.connected =
        true;

    session.days =
        duration;

    session.expireAt =
        expireAt.toISOString();

    session.deployedAt =
        now.toISOString();

    session.updatedAt =
        now.toISOString();

    await saveSession(
        session
    );

    updatePairing(
        session.pairingId,
        {
            status:
                "deployed",

            connected:
                true,

            sent:
                true,

            jid:
                session.jid,

            authFolder:
                session.authFolder,

            sessionId:
                session.sessionId,

            deployedAt:
                session.deployedAt,

            days:
                duration,

            expireAt:
                session.expireAt
        }
    );

    try {

        await addDeployedUser({

            id:
                generateUserId(),

            pairingId:
                session.pairingId,

            sessionId:
                session.sessionId,

            number:
                session.number,

            jid:
                session.jid,

            authFolder:
                session.authFolder,

            status:
                "deployed",

            connected:
                true,

            sent:
                true,

            days:
                duration,

            expireAt:
                session.expireAt,

            deployedAt:
                session.deployedAt,

            createdAt:
                session.createdAt ||
                now.toISOString()
        });

    } catch (error) {

        console.error(
            "[DEPLOYMENT DB]",
            error.message
        );
    }
}

/* =========================================================
   START WHATSAPP CONNECTION
========================================================= */

async function startPairing(
    number,
    pairingId,
    existingAuthFolder = null,
    existingSessionId = null
) {

    const clean =
        cleanNumber(
            number
        );

    if (!clean) {
        throw new Error(
            "Invalid phone number"
        );
    }

    let authFolder =
        existingAuthFolder;

    if (!authFolder) {

        authFolder =
            path.join(
                AUTH_DIR,
                `ETIAS_${clean}_${Date.now()}_${Math.random()
                    .toString(16)
                    .slice(2, 10)}`
            );
    }

    await fsp.mkdir(
        authFolder,
        {
            recursive: true
        }
    );

    console.log(
        `[PAIR] Auth folder: ${authFolder}`
    );

    const {
        state,
        saveCreds
    } =
        await useMultiFileAuthState(
            authFolder
        );

    const sock =
        makeWASocket({

            auth: {

                creds:
                    state.creds,

                keys:
                    makeCacheableSignalKeyStore(
                        state.keys,
                        logger
                    )
            },

            logger,

            browser:
                Browsers.macOS(
                    "Chrome"
                ),

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
                25000
        });

    sockets.set(
        pairingId,
        sock
    );

    updatePairing(
        pairingId,
        {
            status:
                "connecting",

            connected:
                false,

            authFolder
        }
    );

    sock.ev.on(
        "creds.update",
        saveCreds
    );

    /* =====================================================
       CONNECTION UPDATE
    ===================================================== */

    sock.ev.on(
        "connection.update",
        async update => {

            const {
                connection,
                lastDisconnect,
                qr
            } = update;

            /* =================================================
               QR
            ================================================= */

            if (qr) {

                updatePairing(
                    pairingId,
                    {
                        status:
                            "qr",

                        connected:
                            false
                    }
                );

                try {

                    const qrData =
                        await QRCode.toDataURL(
                            qr
                        );

                    updatePairing(
                        pairingId,
                        {
                            qrImage:
                                qrData
                        }
                    );

                } catch (error) {

                    console.error(
                        "[QR]",
                        error.message
                    );
                }
            }

            /* =================================================
               CONNECTING
            ================================================= */

            if (
                connection ===
                "connecting"
            ) {

                console.log(
                    `[PAIR] Connecting ${pairingId}`
                );

                updatePairing(
                    pairingId,
                    {
                        status:
                            "connecting",

                        connected:
                            false
                    }
                );
            }

            /* =================================================
               OPEN
            ================================================= */

            if (
                connection ===
                "open"
            ) {

                console.log(
                    "========================================"
                );

                console.log(
                    "✅ WHATSAPP CONNECTED"
                );

                console.log(
                    `PAIR ID: ${pairingId}`
                );

                console.log(
                    `JID: ${
                        sock.user?.id ||
                        "unknown"
                    }`
                );

                console.log(
                    "========================================"
                );

                try {

                    await sleep(
                        1500
                    );

                    await saveCreds();

                    const authenticatedJid =
                        sock.user?.id;

                    if (
                        !authenticatedJid
                    ) {
                        throw new Error(
                            "Authenticated WhatsApp JID unavailable"
                        );
                    }

                    const normalizedJid =
                        normalizeJid(
                            authenticatedJid
                        );

                    const connectedNumber =
                        numberFromJid(
                            normalizedJid
                        );

                    /*
                     * Reuse an existing session ID
                     * if this is a restored connection.
                     */
                    let sessionId =
                        existingSessionId;

                    if (
                        !sessionId
                    ) {
                        sessionId =
                            createUniqueSessionId();
                    }

                    /*
                     * Validate generated ID.
                     */
                    if (
                        !isValidSessionId(
                            sessionId
                        )
                    ) {
                        throw new Error(
                            "Invalid generated session ID"
                        );
                    }

                    const session = {

                        sessionId,

                        pairingId,

                        number:
                            connectedNumber ||
                            clean,

                        jid:
                            normalizedJid,

                        authFolder,

                        status:
                            "awaiting_deployment",

                        connected:
                            true,

                        sent:
                            false,

                        createdAt:
                            new Date()
                                .toISOString(),

                        updatedAt:
                            new Date()
                                .toISOString()
                    };

                    await saveSession(
                        session
                    );

                    updatePairing(
                        pairingId,
                        {
                            status:
                                "session_ready",

                            connected:
                                true,

                            jid:
                                normalizedJid,

                            authFolder,

                            sessionId,

                            number:
                                session.number
                        }
                    );

                    console.log(
                        "========================================"
                    );

                    console.log(
                        "🆔 SESSION ID GENERATED"
                    );

                    console.log(
                        `SESSION ID: ${sessionId}`
                    );

                    console.log(
                        `NUMBER: ${session.number}`
                    );

                    console.log(
                        `PAIR ID: ${pairingId}`
                    );

                    console.log(
                        "========================================"
                    );

                    /*
                     * Send the REAL session ID to WhatsApp.
                     */
                    await sendSessionId(
                        sock,
                        sessionId,
                        normalizedJid
                    );

                    session.sent =
                        true;

                    await saveSession(
                        session
                    );

                    updatePairing(
                        pairingId,
                        {
                            status:
                                "awaiting_deployment",

                            connected:
                                true,

                            sent:
                                true,

                            sessionId
                        }
                    );

                    console.log(
                        "========================================"
                    );

                    console.log(
                        "📲 SESSION ID SENT"
                    );

                    console.log(
                        `SESSION: ${sessionId}`
                    );

                    console.log(
                        "Waiting for deployment page..."
                    );

                    console.log(
                        "========================================"
                    );

                } catch (error) {

                    console.error(
                        "[SESSION ERROR]",
                        error
                    );

                    updatePairing(
                        pairingId,
                        {
                            status:
                                "error",

                            connected:
                                true,

                            error:
                                error.message ||
                                String(error)
                        }
                    );
                }
            }

            /* =================================================
               CLOSE
            ================================================= */

            if (
                connection ===
                "close"
            ) {

                const code =
                    getDisconnectCode(
                        lastDisconnect
                    );

                console.log(
                    `[PAIR] Connection closed: ${code}`
                );

                sockets.delete(
                    pairingId
                );

                /* =============================================
                   LOGGED OUT
                ============================================= */

                if (
                    isLoggedOut(code)
                ) {

                    console.log(
                        "[PAIR] ❌ WhatsApp logged out"
                    );

                    const pairing =
                        getPairing(
                            pairingId
                        );

                    if (
                        pairing?.sessionId
                    ) {

                        const session =
                            getSessionById(
                                pairing.sessionId
                            );

                        if (
                            session
                        ) {

                            session.connected =
                                false;

                            session.status =
                                "logged_out";

                            await saveSession(
                                session
                            );
                        }
                    }

                    updatePairing(
                        pairingId,
                        {
                            status:
                                "logged_out",

                            connected:
                                false
                        }
                    );

                    return;
                }

                /* =============================================
                   BAD SESSION
                ============================================= */

                if (
                    isBadSession(code)
                ) {

                    console.log(
                        "[PAIR] ❌ Bad session"
                    );

                    updatePairing(
                        pairingId,
                        {
                            status:
                                "bad_session",

                            connected:
                                false
                        }
                    );

                    return;
                }

                /* =============================================
                   RECONNECT
                ============================================= */

                if (
                    reconnecting.has(
                        pairingId
                    )
                ) {
                    return;
                }

                reconnecting.add(
                    pairingId
                );

                updatePairing(
                    pairingId,
                    {
                        status:
                            "reconnecting",

                        connected:
                            false
                    }
                );

                console.log(
                    "[PAIR] 🔄 Reconnecting..."
                );

                const pairing =
                    getPairing(
                        pairingId
                    );

                const session =
                    pairing?.sessionId
                        ? getSessionById(
                              pairing.sessionId
                          )
                        : null;

                setTimeout(
                    async () => {

                        try {

                            reconnecting.delete(
                                pairingId
                            );

                            await startPairing(
                                clean,
                                pairingId,
                                authFolder,
                                session?.sessionId ||
                                    existingSessionId
                            );

                        } catch (error) {

                            reconnecting.delete(
                                pairingId
                            );

                            console.error(
                                "[PAIR] Reconnect failed:",
                                error.message
                            );

                            updatePairing(
                                pairingId,
                                {
                                    status:
                                        "error",

                                    connected:
                                        false,

                                    error:
                                        error.message
                                }
                            );
                        }

                    },

                    isRestartRequired(
                        code
                    )
                        ? 1000
                        : 3000
                );
            }
        }
    );

    /*
     * IMPORTANT:
     *
     * There is NO requestPairingCode()
     * here.
     *
     * Pairing is handled by the existing
     * pairing/QR flow.
     */
    return sock;
}

/* =========================================================
   HOME
========================================================= */

app.get(
    "/",
    (req, res) => {

        const file =
            path.join(
                ROOT,
                "index.html"
            );

        if (
            fs.existsSync(file)
        ) {
            return res.sendFile(
                file
            );
        }

        res.json({
            success:
                true,

            service:
                BOT_NAME,

            status:
                "online"
        });
    }
);

/* =========================================================
   PAIR PAGE
========================================================= */

app.get(
    "/pair",
    (req, res) => {

        const file =
            path.join(
                ROOT,
                "pair.html"
            );

        if (
            fs.existsSync(file)
        ) {
            return res.sendFile(
                file
            );
        }

        res.status(404).send(
            "pair.html not found"
        );
    }
);

/* =========================================================
   QR PAGE
========================================================= */

app.get(
    "/qr",
    (req, res) => {

        const file =
            path.join(
                ROOT,
                "qr.html"
            );

        if (
            fs.existsSync(file)
        ) {
            return res.sendFile(
                file
            );
        }

        res.status(404).send(
            "qr.html not found"
        );
    }
);

/* =========================================================
   PING
========================================================= */

app.get(
    "/ping",
    (req, res) => {

        res.json({

            status:
                "online",

            service:
                BOT_NAME,

            sessions:
                sessions.size,

            sockets:
                sockets.size,

            uptime:
                process.uptime(),

            time:
                new Date()
                    .toISOString()
        });
    }
);

/* =========================================================
   HEALTH
========================================================= */

app.get(
    "/health",
    (req, res) => {

        res.json({

            status:
                "online",

            sockets:
                sockets.size,

            sessions:
                sessions.size,

            pairings:
                getAllPairings()
                    .length,

            uptime:
                process.uptime()
        });
    }
);

/* =========================================================
   CREATE PAIRING
========================================================= */

app.get(
    "/code",
    async (req, res) => {

        try {

            const number =
                cleanNumber(
                    req.query.number
                );

            if (!number) {

                return res.status(
                    400
                ).json({

                    success:
                        false,

                    error:
                        "Phone number is required"
                });
            }

            const existing =
                getAllPairings()
                    .find(
                        item =>

                            item.number ===
                                number &&

                            [
                                "starting",
                                "connecting",
                                "qr",
                                "reconnecting",
                                "session_ready",
                                "awaiting_deployment"
                            ].includes(
                                item.status
                            )
                    );

            if (existing) {

                return res.json({

                    success:
                        true,

                    pairingId:
                        existing.id,

                    number,

                    status:
                        existing.status,

                    sessionId:
                        existing.sessionId ||
                        null,

                    message:
                        "Pairing session already exists."
                });
            }

            const pairing =
                createPairing(
                    number
                );

            updatePairing(
                pairing.id,
                {
                    status:
                        "starting"
                }
            );

            startPairing(
                number,
                pairing.id
            ).catch(
                error => {

                    console.error(
                        "[PAIR] Startup error:",
                        error
                    );

                    updatePairing(
                        pairing.id,
                        {
                            status:
                                "error",

                            connected:
                                false,

                            error:
                                error.message ||
                                String(error)
                        }
                    );
                }
            );

            await sleep(
                1200
            );

            const current =
                getPairing(
                    pairing.id
                );

            return res.json({

                success:
                    true,

                pairingId:
                    pairing.id,

                number,

                status:
                    current?.status ||
                    "starting",

                sessionId:
                    current?.sessionId ||
                    null,

                message:
                    "Pairing started."
            });

        } catch (error) {

            console.error(
                "[CODE]",
                error
            );

            return res.status(
                500
            ).json({

                success:
                    false,

                error:
                    error.message ||
                    String(error)
            });
        }
    }
);

/* =========================================================
   STATUS
========================================================= */

app.get(
    "/status/:id",
    (req, res) => {

        const pairing =
            getPairing(
                req.params.id
            );

        if (!pairing) {

            return res.status(
                404
            ).json({

                success:
                    false,

                error:
                    "Pairing ID not found"
            });
        }

        const safe = {
            ...pairing
        };

        /*
         * Never expose auth credentials.
         */
        delete safe.authState;

        delete safe.auth;

        delete safe.deploymentCode;

        res.json({

            success:
                true,

            ...safe
        });
    }
);

/* =========================================================
   CHECK PAIRING
========================================================= */

app.get(
    "/check/:id",
    (req, res) => {

        const pairing =
            getPairing(
                req.params.id
            );

        if (!pairing) {

            return res.status(
                404
            ).json({

                success:
                    false,

                error:
                    "Pairing ID not found"
            });
        }

        res.json({

            success:
                true,

            id:
                pairing.id,

            number:
                pairing.number,

            status:
                pairing.status,

            connected:
                pairing.connected,

            sent:
                pairing.sent,

            jid:
                pairing.jid ||
                null,

            sessionId:
                pairing.sessionId ||
                null,

            error:
                pairing.error ||
                null
        });
    }
);

/* =========================================================
   SESSION VALIDATION
========================================================= */

app.get(
    "/session/:sessionId",
    (req, res) => {

        const sessionId =
            String(
                req.params.sessionId ||
                ""
            ).trim();

        if (
            !isValidSessionId(
                sessionId
            )
        ) {

            return res.status(
                400
            ).json({

                success:
                    false,

                valid:
                    false,

                error:
                    "Invalid session ID format"
            });
        }

        const session =
            getSessionById(
                sessionId
            );

        if (!session) {

            return res.status(
                404
            ).json({

                success:
                    false,

                valid:
                    false,

                error:
                    "Session ID not found"
            });
        }

        const sock =
            sockets.get(
                session.pairingId
            );

        res.json({

            success:
                true,

            valid:
                true,

            sessionId:
                session.sessionId,

            number:
                session.number,

            jid:
                session.jid,

            connected:
                Boolean(
                    sock &&
                    session.connected
                ),

            status:
                session.status,

            deployed:
                session.status ===
                "deployed",

            createdAt:
                session.createdAt,

            expireAt:
                session.expireAt ||
                null
        });
    }
);

/* =========================================================
   DEPLOY
========================================================= */

app.post(
    "/deploy",
    async (req, res) => {

        try {

            const sessionId =
                String(
                    req.body.sessionId ||
                    ""
                ).trim();

            const phone =
                cleanNumber(
                    req.body.phone ||
                    req.body.number
                );

            const days =
                Math.max(
                    1,
                    Number(
                        req.body.days ||
                        req.body.duration ||
                        30
                    )
                );

            /* =============================================
               VALIDATE SESSION FORMAT
            ============================================= */

            if (
                !isValidSessionId(
                    sessionId
                )
            ) {

                return res.status(
                    400
                ).json({

                    success:
                        false,

                    error:
                        "Invalid Session ID. Expected ETIAS-MINI-BOT~12345678"
                });
            }

            /* =============================================
               VALIDATE PHONE
            ============================================= */

            if (!phone) {

                return res.status(
                    400
                ).json({

                    success:
                        false,

                    error:
                        "User WhatsApp number is required"
                });
            }

            /* =============================================
               FIND REAL SESSION
            ============================================= */

            const session =
                getSessionById(
                    sessionId
                );

            if (!session) {

                return res.status(
                    404
                ).json({

                    success:
                        false,

                    error:
                        "Session ID does not exist. Generate a real Session ID first."
                });
            }

            /* =============================================
               VERIFY NUMBER
            ============================================= */

            const sessionNumber =
                cleanNumber(
                    session.number
                );

            const jidNumber =
                cleanNumber(
                    numberFromJid(
                        session.jid
                    )
                );

            /*
             * The number entered on the dashboard
             * MUST be the same WhatsApp account
             * that received the session ID.
             */
            if (
                phone !==
                    sessionNumber &&
                phone !==
                    jidNumber
            ) {

                return res.status(
                    403
                ).json({

                    success:
                        false,

                    error:
                        "The WhatsApp number does not match the account that received this Session ID."
                });
            }

            /* =============================================
               FIND LIVE SOCKET
            ============================================= */

            const sock =
                sockets.get(
                    session.pairingId
                );

            if (!sock) {

                return res.status(
                    410
                ).json({

                    success:
                        false,

                    error:
                        "This Session ID is real, but its WhatsApp connection is no longer active. Re-pair the number and generate a new Session ID."
                });
            }

            /* =============================================
               VERIFY CONNECTED
            ============================================= */

            if (
                !session.connected ||
                !sock.user
            ) {

                return res.status(
                    409
                ).json({

                    success:
                        false,

                    error:
                        "WhatsApp account is not currently connected."
                });
            }

            /* =============================================
               PREVENT DUPLICATE DEPLOYMENT
            ============================================= */

            if (
                session.status ===
                    "deployed"
            ) {

                return res.status(
                    409
                ).json({

                    success:
                        false,

                    error:
                        "This Session ID has already been deployed."
                });
            }

            /* =============================================
               DEPLOY
            ============================================= */

            console.log(
                "========================================"
            );

            console.log(
                "🚀 DEPLOYMENT STARTED"
            );

            console.log(
                `SESSION: ${sessionId}`
            );

            console.log(
                `NUMBER: ${phone}`
            );

            console.log(
                `DAYS: ${days}`
            );

            console.log(
                `PAIR ID: ${session.pairingId}`
            );

            console.log(
                `AUTH: ${session.authFolder}`
            );

            console.log(
                "========================================"
            );

            await saveSuccessfulDeployment(
                session,
                days
            );

            /*
             * Keep socket alive.
             *
             * The authenticated WhatsApp account
             * is already connected and becomes the bot.
             */
            try {

                if (
                    typeof sock.sendPresenceUpdate ===
                    "function"
                ) {

                    await sock.sendPresenceUpdate(
                        "available"
                    );
                }

            } catch (error) {

                console.log(
                    "[DEPLOY] Presence update skipped:",
                    error.message
                );
            }

            return res.json({

                success:
                    true,

                message:
                    "Bot deployed successfully and WhatsApp connection is active.",

                bot:
                    BOT_NAME,

                sessionId:
                    session.sessionId,

                phone:
                    session.number,

                jid:
                    session.jid,

                days,

                status:
                    "deployed",

                connected:
                    true,

                expireAt:
                    session.expireAt
            });

        } catch (error) {

            console.error(
                "[DEPLOY ERROR]",
                error
            );

            return res.status(
                500
            ).json({

                success:
                    false,

                error:
                    error.message ||
                    String(error)
            });
        }
    }
);

/* =========================================================
   GET SESSION LIST
========================================================= */

app.get(
    "/sessions",
    (req, res) => {

        const list =
            Array.from(
                sessions.values()
            ).map(
                session => ({

                    sessionId:
                        session.sessionId,

                    number:
                        session.number,

                    status:
                        session.status,

                    connected:
                        session.connected,

                    days:
                        session.days ||
                        null,

                    expireAt:
                        session.expireAt ||
                        null,

                    createdAt:
                        session.createdAt,

                    deployedAt:
                        session.deployedAt ||
                        null
                })
            );

        res.json({

            success:
                true,

            total:
                list.length,

            sessions:
                list
        });
    }
);

/* =========================================================
   DEPLOYED LIST
========================================================= */

app.get(
    "/deployed-list",
    async (req, res) => {

        try {

            const users =
                await loadDeployed();

            const safeUsers =
                users.map(
                    user => {

                        const copy =
                            {
                                ...user
                            };

                        delete copy.authFolder;

                        delete copy.sessionId;

                        delete copy.deploymentCode;

                        delete copy.auth;

                        return copy;
                    }
                );

            res.json({

                success:
                    true,

                count:
                    safeUsers.length,

                users:
                    safeUsers
            });

        } catch (error) {

            res.status(
                500
            ).json({

                success:
                    false,

                error:
                    error.message ||
                    String(error)
            });
        }
    }
);

/* =========================================================
   TOTAL USERS
========================================================= */

app.get(
    "/total-users",
    async (req, res) => {

        try {

            const users =
                await loadDeployed();

            res.json({

                success:
                    true,

                total:
                    users.length
            });

        } catch (error) {

            res.status(
                500
            ).json({

                success:
                    false,

                error:
                    error.message ||
                    String(error)
            });
        }
    }
);

/* =========================================================
   DEPLOY STATS
========================================================= */

app.get(
    "/deploy-stats",
    async (req, res) => {

        try {

            const users =
                await loadDeployed();

            const connected =
                users.filter(
                    user =>
                        user.connected ===
                        true
                ).length;

            const sent =
                users.filter(
                    user =>
                        user.sent ===
                        true
                ).length;

            const deployed =
                users.filter(
                    user =>
                        user.status ===
                        "deployed"
                ).length;

            res.json({

                success:
                    true,

                total:
                    users.length,

                connected,

                sent,

                deployed
            });

        } catch (error) {

            res.status(
                500
            ).json({

                success:
                    false,

                error:
                    error.message ||
                    String(error)
            });
        }
    }
);

/* =========================================================
   QR IMAGE
========================================================= */

app.get(
    "/qr-image",
    (req, res) => {

        const id =
            req.query.id;

        if (!id) {

            return res.status(
                400
            ).json({

                success:
                    false,

                error:
                    "Pairing ID required"
            });
        }

        const pairing =
            getPairing(id);

        if (!pairing) {

            return res.status(
                404
            ).json({

                success:
                    false,

                error:
                    "Pairing ID not found"
            });
        }

        if (
            !pairing.qrImage
        ) {

            return res.status(
                404
            ).json({

                success:
                    false,

                error:
                    "QR code not available"
            });
        }

        try {

            const base64 =
                pairing.qrImage.replace(
                    /^data:image\/png;base64,/,
                    ""
                );

            res.type(
                "png"
            );

            res.send(
                Buffer.from(
                    base64,
                    "base64"
                )
            );

        } catch (error) {

            res.status(
                500
            ).json({

                success:
                    false,

                error:
                    error.message
            });
        }
    }
);

/* =========================================================
   BOT IMAGE
========================================================= */

app.get(
    "/bot-image",
    (req, res) => {

        const imagePath =
            path.join(
                MEDIA_DIR,
                "bot_image.png"
            );

        if (
            fs.existsSync(
                imagePath
            )
        ) {

            return res.sendFile(
                imagePath
            );
        }

        res.status(
            404
        ).json({

            success:
                false,

            error:
                "Bot image not found"
        });
    }
);

/* =========================================================
   404
========================================================= */

app.use(
    (req, res) => {

        res.status(
            404
        ).json({

            success:
                false,

            error:
                "Route not found",

            path:
                req.path
        });
    }
);

/* =========================================================
   ERROR HANDLER
========================================================= */

app.use(
    (
        err,
        req,
        res,
        next
    ) => {

        console.error(
            "[EXPRESS ERROR]",
            err
        );

        if (
            res.headersSent
        ) {

            return next(
                err
            );
        }

        res.status(
            500
        ).json({

            success:
                false,

            error:
                err.message ||
                "Internal server error"
        });
    }
);

/* =========================================================
   START
========================================================= */

async function startServer() {

    try {

        await ensureDirectories();

        await loadSessions();

        app.listen(
            PORT,
            "0.0.0.0",
            () => {

                console.log(
                    "========================================"
                );

                console.log(
                    "🚀 ETIAS-MINI-BOT PAIR SERVER"
                );

                console.log(
                    `🌐 PORT: ${PORT}`
                );

                console.log(
                    `📁 ROOT: ${ROOT}`
                );

                console.log(
                    `📁 AUTH: ${AUTH_DIR}`
                );

                console.log(
                    `📁 DATA: ${DATA_DIR}`
                );

                console.log(
                    `🆔 SESSION FORMAT: ${SESSION_PREFIX}12345678`
                );

                console.log(
                    "========================================"
                );
            }
        );

    } catch (error) {

        console.error(
            "[SERVER] Failed to start:",
            error
        );

        process.exit(
            1
        );
    }
}

startServer();

/* =========================================================
   GRACEFUL SHUTDOWN
========================================================= */

async function shutdown(
    signal
) {

    console.log(
        `[SERVER] ${signal} received.`
    );

    await saveSessions();

    for (
        const [
            pairingId,
            sock
        ] of sockets.entries()
    ) {

        try {

            console.log(
                `[SERVER] Closing socket: ${pairingId}`
            );

            if (
                sock &&
                typeof sock.end ===
                    "function"
            ) {

                sock.end(
                    undefined
                );
            }

        } catch (error) {

            console.error(
                `[SERVER] Close error ${pairingId}:`,
                error.message
            );
        }
    }

    sockets.clear();

    process.exit(
        0
    );
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

/* =========================================================
   EXPORT
========================================================= */

module.exports = app;

module.exports.startServer =
    startServer;

module.exports.startPairing =
    startPairing;

module.exports.generateSessionId =
    generateSessionId;

module.exports.isValidSessionId =
    isValidSessionId;
