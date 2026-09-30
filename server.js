"use strict";

require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");
const fsp = fs.promises;

const app = express();

/* =========================================================
   CONFIG
========================================================= */

const PORT = Number(process.env.PORT || 3000);

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const LOG_DIR = path.join(ROOT, "logs");

const DEPLOYED_FILE = path.join(DATA_DIR, "deployed.json");
const MULTI_SESSION_FILE = path.join(DATA_DIR, "multi_sessions.json");

const PAIRING_SERVER_URL = (
    process.env.PAIRING_SERVER_URL ||
    "https://etias-mini-bot-pair.onrender.com"
).replace(/\/+$/, "");

const SESSION_PREFIX = "ETIAS-MINI-BOT~";

const DEFAULT_DAYS = Number(process.env.DEFAULT_DAYS || 30);
const MAX_DAYS = Number(process.env.MAX_DAYS || 365);

/* =========================================================
   DIRECTORIES
========================================================= */

for (const dir of [DATA_DIR, LOG_DIR]) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

/* =========================================================
   EXPRESS
========================================================= */

app.disable("x-powered-by");

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader(
        "Access-Control-Allow-Methods",
        "GET,POST,PUT,PATCH,DELETE,OPTIONS"
    );
    res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization, X-API-Key"
    );

    if (req.method === "OPTIONS") {
        return res.sendStatus(204);
    }

    next();
});

/* =========================================================
   HELPERS
========================================================= */

function normalizePhone(value) {
    return String(value || "")
        .replace(/[^\d]/g, "")
        .replace(/^0+/, "");
}

function normalizeSessionId(value) {
    return String(value || "").trim().toUpperCase();
}

function isValidSessionId(sessionId) {
    return new RegExp(
        "^" +
            SESSION_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
            "\\d{8}$",
        "i"
    ).test(String(sessionId || "").trim());
}

function safeDays(value) {
    const days = Number(value);

    if (!Number.isFinite(days)) {
        return DEFAULT_DAYS;
    }

    return Math.max(1, Math.min(Math.floor(days), MAX_DAYS));
}

function now() {
    return new Date().toISOString();
}

function getExpireDate(days) {
    return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

async function ensureJsonFile(file, fallback) {
    try {
        await fsp.access(file);
    } catch {
        await fsp.writeFile(
            file,
            JSON.stringify(fallback, null, 2),
            "utf8"
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
    const temp = `${file}.tmp`;

    await fsp.writeFile(
        temp,
        JSON.stringify(data, null, 2),
        "utf8"
    );

    await fsp.rename(temp, file);
}

async function appendLog(message, meta = null) {
    const line =
        `[${now()}] ${message}` +
        (meta ? ` ${JSON.stringify(meta)}` : "") +
        "\n";

    try {
        await fsp.appendFile(
            path.join(LOG_DIR, "server.log"),
            line,
            "utf8"
        );
    } catch {
        // Logging must never crash the API.
    }
}

function jsonError(res, status, message, extra = {}) {
    return res.status(status).json({
        success: false,
        error: message,
        ...extra
    });
}

function manager() {
    return global.ETIAS_BOT_MANAGER || null;
}

/* =========================================================
   INITIAL DATA
========================================================= */

ensureJsonFile(DEPLOYED_FILE, []).catch(() => {});
ensureJsonFile(MULTI_SESSION_FILE, []).catch(() => {});

/* =========================================================
   BASIC ROUTES
========================================================= */

app.get("/", async (req, res) => {
    res.json({
        success: true,
        name: "ETIAS-MINI-BOT Deployment Server",
        status: "online",
        version: "3.0.0",
        service: "bot",
        pairingServer: PAIRING_SERVER_URL,
        pairingHandledBy: "ETIAS pairing server",
        pairingCodeGeneration: false,
        sessionPrefix: SESSION_PREFIX,
        time: now()
    });
});

app.get("/health", async (req, res) => {
    const botManager = manager();

    res.json({
        success: true,
        status: "online",
        service: "deployment-server",
        botManager: !!botManager,
        pairingServer: PAIRING_SERVER_URL,
        time: now()
    });
});

app.get("/api/health", async (req, res) => {
    const botManager = manager();

    res.json({
        success: true,
        status: "online",
        botManager: !!botManager,
        time: now()
    });
});

/* =========================================================
   PAIRING SERVER REQUEST
========================================================= */

async function callPairingServer(endpoint, options = {}) {
    const url =
        `${PAIRING_SERVER_URL}${endpoint.startsWith("/") ? endpoint : "/" + endpoint}`;

    const controller = new AbortController();

    const timeout = setTimeout(() => {
        controller.abort();
    }, 20000);

    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal,
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                ...(options.headers || {})
            }
        });

        const text = await response.text();

        let data;

        try {
            data = text ? JSON.parse(text) : {};
        } catch {
            data = {
                success: false,
                error: text || "Invalid response from pairing server"
            };
        }

        return {
            ok: response.ok,
            status: response.status,
            data
        };
    } finally {
        clearTimeout(timeout);
    }
}

/* =========================================================
   SESSION VERIFICATION
========================================================= */

async function verifySessionWithPairingServer(sessionId, phone) {
    const encoded = encodeURIComponent(sessionId);

    /*
     * Preferred endpoint.
     *
     * The pairing server should expose:
     *
     * GET /session/:sessionId
     *
     * or:
     *
     * GET /session-status/:sessionId
     */

    const endpoints = [
        `/session/${encoded}`,
        `/session-status/${encoded}`,
        `/check-session/${encoded}`
    ];

    let lastResult = null;

    for (const endpoint of endpoints) {
        try {
            const result = await callPairingServer(endpoint);

            lastResult = result;

            if (result.status === 404) {
                continue;
            }

            if (!result.ok) {
                continue;
            }

            const data = result.data || {};

            const record =
                data.session ||
                data.data ||
                data.result ||
                data;

            const storedPhone = normalizePhone(
                record.phone ||
                record.number ||
                record.msisdn ||
                record.jid ||
                ""
            );

            const requestedPhone = normalizePhone(phone);

            if (
                storedPhone &&
                requestedPhone &&
                !storedPhone.endsWith(requestedPhone) &&
                !requestedPhone.endsWith(storedPhone)
            ) {
                return {
                    valid: false,
                    error: "Session ID does not belong to this phone number."
                };
            }

            return {
                valid:
                    data.valid !== false &&
                    data.success !== false &&
                    data.error === undefined,
                data
            };
        } catch (error) {
            lastResult = {
                error: error.message
            };
        }
    }

    return {
        valid: false,
        unavailable: true,
        error:
            "Could not verify the Session ID with the pairing server.",
        details: lastResult
    };
}

/* =========================================================
   DEPLOYMENT RECORDS
========================================================= */

async function getDeployments() {
    return await readJson(DEPLOYED_FILE, []);
}

async function saveDeployments(records) {
    await writeJson(DEPLOYED_FILE, records);
}

async function findDeployment(sessionId) {
    const records = await getDeployments();

    return records.find(
        item =>
            normalizeSessionId(item.sessionId) ===
            normalizeSessionId(sessionId)
    );
}

async function findActivePhone(phone) {
    const normalized = normalizePhone(phone);

    const records = await getDeployments();

    return records.find(item => {
        if (normalizePhone(item.phone) !== normalized) {
            return false;
        }

        if (item.status === "expired") {
            return false;
        }

        if (!item.expireAt) {
            return true;
        }

        return new Date(item.expireAt).getTime() > Date.now();
    });
}

/* =========================================================
   DEPLOY THROUGH MAIN.JS MANAGER
========================================================= */

async function deployThroughManager(options) {
    const botManager = manager();

    if (!botManager) {
        throw new Error(
            "ETIAS_BOT_MANAGER is not initialized yet."
        );
    }

    if (typeof botManager.deploySession !== "function") {
        throw new Error(
            "deploySession() is not available in ETIAS_BOT_MANAGER."
        );
    }

    return await botManager.deploySession(options);
}

/* =========================================================
   POST /DEPLOY
========================================================= */

app.post("/deploy", async (req, res) => {
    const sessionId = normalizeSessionId(req.body.sessionId);
    const phone = normalizePhone(req.body.phone);
    const days = safeDays(req.body.days);

    await appendLog("Deployment request received", {
        sessionId,
        phone,
        days
    });

    if (!isValidSessionId(sessionId)) {
        return jsonError(
            res,
            400,
            "Invalid Session ID. Expected ETIAS-MINI-BOT~12345678."
        );
    }

    if (!phone || phone.length < 7) {
        return jsonError(
            res,
            400,
            "A valid WhatsApp phone number is required."
        );
    }

    try {
        const existing = await findDeployment(sessionId);

        if (existing && existing.status === "deployed") {
            return jsonError(
                res,
                409,
                "This Session ID has already been deployed.",
                {
                    deployment: existing
                }
            );
        }

        const activePhone = await findActivePhone(phone);

        if (
            activePhone &&
            normalizeSessionId(activePhone.sessionId) !== sessionId
        ) {
            return jsonError(
                res,
                409,
                "This phone number already has an active deployment."
            );
        }

        /*
         * Ask the pairing service to validate that the
         * Session ID actually exists.
         */

        const verification =
            await verifySessionWithPairingServer(
                sessionId,
                phone
            );

        if (!verification.valid) {
            await appendLog(
                "Session verification failed",
                {
                    sessionId,
                    phone,
                    error: verification.error
                }
            );

            return jsonError(
                res,
                verification.unavailable ? 503 : 400,
                verification.error ||
                    "Session ID could not be verified."
            );
        }

        const expireAt = getExpireDate(days);

        /*
         * Important:
         *
         * main.js handles the actual Baileys session.
         * This server does NOT generate a pairing code.
         */

        const result = await deployThroughManager({
            sessionId,
            phone,
            days,
            expireAt: expireAt.toISOString(),
            pairingServer: PAIRING_SERVER_URL,

            /*
             * Let main.js resolve the persisted auth state.
             */
            authFolder:
                verification.data?.authFolder ||
                verification.data?.session?.authFolder ||
                null,

            pairingId:
                verification.data?.pairingId ||
                verification.data?.session?.pairingId ||
                null
        });

        const records = await getDeployments();

        const deployment = {
            sessionId,
            phone,
            days,
            expireAt: expireAt.toISOString(),

            status: "deployed",
            connected: false,

            pairingServer: PAIRING_SERVER_URL,

            createdAt: now(),
            lastSeen: now(),

            result:
                result && typeof result === "object"
                    ? result
                    : null
        };

        const index = records.findIndex(
            item =>
                normalizeSessionId(item.sessionId) ===
                sessionId
        );

        if (index >= 0) {
            records[index] = {
                ...records[index],
                ...deployment
            };
        } else {
            records.push(deployment);
        }

        await saveDeployments(records);

        await appendLog(
            "Deployment successful",
            deployment
        );

        return res.json({
            success: true,
            message: "ETIAS-MINI-BOT deployed successfully.",
            deployment
        });
    } catch (error) {
        await appendLog(
            "Deployment failed",
            {
                sessionId,
                phone,
                error: error.message,
                stack: error.stack
            }
        );

        console.error(
            "[DEPLOY ERROR]",
            error
        );

        return jsonError(
            res,
            500,
            error.message ||
                "Failed to deploy bot session."
        );
    }
});

/* =========================================================
   GET /DEPLOY
   Compatibility/status endpoint
========================================================= */

app.get("/deploy", async (req, res) => {
    res.json({
        success: false,
        message:
            "Use POST /deploy with sessionId, phone and days.",
        example: {
            sessionId: "ETIAS-MINI-BOT~12345678",
            phone: "263771234567",
            days: 30
        }
    });
});

/* =========================================================
   SESSION STATUS
========================================================= */

app.get("/status/:sessionId", async (req, res) => {
    const sessionId = normalizeSessionId(
        req.params.sessionId
    );

    if (!isValidSessionId(sessionId)) {
        return jsonError(
            res,
            400,
            "Invalid Session ID."
        );
    }

    const deployment =
        await findDeployment(sessionId);

    const botManager = manager();

    let managerStatus = null;

    try {
        if (
            botManager &&
            typeof botManager.getSessionStatus ===
                "function"
        ) {
            managerStatus =
                await botManager.getSessionStatus(
                    sessionId
                );
        }
    } catch (error) {
        managerStatus = {
            error: error.message
        };
    }

    return res.json({
        success: true,
        sessionId,
        deployment: deployment || null,
        manager: managerStatus,
        time: now()
    });
});

/* =========================================================
   SESSION LOOKUP
========================================================= */

app.get("/api/session/:sessionId", async (req, res) => {
    const sessionId = normalizeSessionId(
        req.params.sessionId
    );

    if (!isValidSessionId(sessionId)) {
        return jsonError(
            res,
            400,
            "Invalid Session ID."
        );
    }

    const deployment =
        await findDeployment(sessionId);

    return res.json({
        success: true,
        sessionId,
        deployment: deployment || null
    });
});

/* =========================================================
   ALL DEPLOYED SESSIONS
========================================================= */

app.get("/sessions", async (req, res) => {
    const records = await getDeployments();

    const safe = records.map(item => ({
        sessionId: item.sessionId,
        phone: item.phone,
        days: item.days,
        status: item.status,
        connected: item.connected,
        expireAt: item.expireAt,
        createdAt: item.createdAt,
        lastSeen: item.lastSeen
    }));

    res.json({
        success: true,
        total: safe.length,
        sessions: safe
    });
});

app.get("/api/sessions", async (req, res) => {
    const records = await getDeployments();

    res.json({
        success: true,
        total: records.length,
        sessions: records
    });
});

/* =========================================================
   DEPLOYMENT STATS
========================================================= */

app.get("/deploy-stats", async (req, res) => {
    const records = await getDeployments();

    const active = records.filter(
        item =>
            item.status !== "expired" &&
            (!item.expireAt ||
                new Date(item.expireAt).getTime() >
                    Date.now())
    );

    const connected = records.filter(
        item => item.connected === true
    );

    const expired = records.filter(
        item =>
            item.status === "expired" ||
            (item.expireAt &&
                new Date(item.expireAt).getTime() <=
                    Date.now())
    );

    res.json({
        success: true,
        total: records.length,
        active: active.length,
        connected: connected.length,
        expired: expired.length,
        time: now()
    });
});

/* =========================================================
   TOTAL USERS
========================================================= */

app.get("/total-users", async (req, res) => {
    const records = await getDeployments();

    const uniquePhones =
        new Set(
            records
                .map(item => normalizePhone(item.phone))
                .filter(Boolean)
        );

    res.json({
        success: true,
        totalUsers: uniquePhones.size
    });
});

/* =========================================================
   LOGS
========================================================= */

app.get("/logs", async (req, res) => {
    const file =
        path.join(LOG_DIR, "server.log");

    try {
        const content =
            await fsp.readFile(file, "utf8");

        const lines =
            content
                .split("\n")
                .filter(Boolean)
                .slice(-200);

        res.json({
            success: true,
            total: lines.length,
            logs: lines
        });
    } catch {
        res.json({
            success: true,
            total: 0,
            logs: []
        });
    }
});

/* =========================================================
   BOT MANAGER STATUS
========================================================= */

app.get("/manager", async (req, res) => {
    const botManager = manager();

    if (!botManager) {
        return res.status(503).json({
            success: false,
            manager: false,
            message:
                "ETIAS_BOT_MANAGER has not initialized."
        });
    }

    res.json({
        success: true,
        manager: true,
        methods: Object.keys(botManager).filter(
            key =>
                typeof botManager[key] ===
                "function"
        )
    });
});

/* =========================================================
   PAIRING SERVER STATUS
========================================================= */

app.get("/pairing-server", async (req, res) => {
    try {
        const result =
            await callPairingServer("/health");

        return res.status(
            result.ok ? 200 : 503
        ).json({
            success: result.ok,
            pairingServer: PAIRING_SERVER_URL,
            status: result.status,
            response: result.data
        });
    } catch (error) {
        return res.status(503).json({
            success: false,
            pairingServer: PAIRING_SERVER_URL,
            error: error.message
        });
    }
});

/* =========================================================
   BOT IMAGE
========================================================= */

app.get("/bot-image", async (req, res) => {
    const possible = [
        path.join(ROOT, "media", "bot_image.png"),
        path.join(ROOT, "media", "bot.jpg"),
        path.join(ROOT, "media", "bot.png"),
        path.join(ROOT, "assets", "bot_image.png")
    ];

    for (const file of possible) {
        try {
            await fsp.access(file);
            return res.sendFile(file);
        } catch {
            // Continue searching.
        }
    }

    return res.status(404).json({
        success: false,
        error: "Bot image not found."
    });
});

/* =========================================================
   STATIC FILES
========================================================= */

const publicDir = path.join(ROOT, "public");

if (fs.existsSync(publicDir)) {
    app.use(
        express.static(publicDir)
    );
}

/* =========================================================
   404
========================================================= */

app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: "Endpoint not found.",
        path: req.originalUrl
    });
});

/* =========================================================
   ERROR HANDLER
========================================================= */

app.use((error, req, res, next) => {
    console.error(
        "[SERVER ERROR]",
        error
    );

    appendLog(
        "Express error",
        {
            error: error.message,
            stack: error.stack
        }
    ).catch(() => {});

    if (res.headersSent) {
        return next(error);
    }

    res.status(500).json({
        success: false,
        error:
            error.message ||
            "Internal server error."
    });
});

/* =========================================================
   EXPORT
========================================================= */

module.exports = app;
