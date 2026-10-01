"use strict";

require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();

/* ============================================================
   CONFIG
============================================================ */

const ROOT = __dirname;

const PORT = Number(process.env.PORT || 3000);

const PAIRING_SERVER_URL = String(
    process.env.PAIRING_SERVER_URL ||
    "https://etias-mini-bot-pair.onrender.com"
).replace(/\/+$/, "");

const SESSION_TRANSFER_SECRET = String(
    process.env.SESSION_TRANSFER_SECRET || ""
).trim();

const SESSION_PREFIX = "ETIAS-MINI-BOT~";

const DEFAULT_DAYS = 30;
const MAX_DAYS = 3650;

const DATA_DIR = path.join(ROOT, "data");
const AUTH_DIR = path.join(ROOT, "auth");
const USERS_AUTH_DIR = path.join(AUTH_DIR, "users");

const DEPLOYED_FILE = path.join(DATA_DIR, "deployed.json");

for (const dir of [
    DATA_DIR,
    AUTH_DIR,
    USERS_AUTH_DIR
]) {
    fs.mkdirSync(dir, { recursive: true });
}

/* ============================================================
   EXPRESS
============================================================ */

app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({
    extended: true,
    limit: "20mb"
}));

app.use((req, res, next) => {
    res.setHeader("X-Powered-By", "ETIAS-MINI-BOT");
    next();
});

/* ============================================================
   HELPERS
============================================================ */

function normalizeSessionId(value) {
    return String(value || "").trim().toUpperCase();
}

function isValidSessionId(sessionId) {
    return new RegExp(
        `^${SESSION_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\d{8}$`
    ).test(normalizeSessionId(sessionId));
}

function normalizePhone(phone) {
    return String(phone || "")
        .replace(/[^\d]/g, "")
        .replace(/^00/, "");
}

function authFolderName(sessionId) {
    const id = normalizeSessionId(sessionId);

    if (!isValidSessionId(id)) {
        throw new Error("Invalid Session ID");
    }

    return id.replace(/[^A-Z0-9_-]/gi, "_");
}

function getAuthFolder(sessionId) {
    return path.join(
        USERS_AUTH_DIR,
        authFolderName(sessionId)
    );
}

function ensureAuthFolder(sessionId) {
    const folder = getAuthFolder(sessionId);
    fs.mkdirSync(folder, { recursive: true });
    return folder;
}

function readJSON(file, fallback) {
    try {
        if (!fs.existsSync(file)) {
            return fallback;
        }

        return JSON.parse(
            fs.readFileSync(file, "utf8")
        );
    } catch {
        return fallback;
    }
}

function writeJSON(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });

    fs.writeFileSync(
        file,
        JSON.stringify(data, null, 2),
        "utf8"
    );
}

function getDeployments() {
    const data = readJSON(DEPLOYED_FILE, []);

    return Array.isArray(data) ? data : [];
}

function saveDeployments(data) {
    writeJSON(DEPLOYED_FILE, data);
}

function findDeployment(sessionId) {
    const id = normalizeSessionId(sessionId);

    return getDeployments().find(
        item =>
            normalizeSessionId(item.sessionId) === id
    );
}

function updateDeployment(sessionId, patch) {
    const deployments = getDeployments();

    const index = deployments.findIndex(
        item =>
            normalizeSessionId(item.sessionId) ===
            normalizeSessionId(sessionId)
    );

    if (index === -1) {
        return null;
    }

    deployments[index] = {
        ...deployments[index],
        ...patch,
        updatedAt: new Date().toISOString()
    };

    saveDeployments(deployments);

    return deployments[index];
}

/* ============================================================
   SAFE AUTH FILE HANDLING
============================================================ */

function safeAuthRelativePath(filePath) {
    let relative = String(filePath || "")
        .replace(/\\/g, "/")
        .replace(/^\/+/, "");

    if (!relative) {
        throw new Error("Invalid auth file path");
    }

    if (
        relative.includes("\0") ||
        relative.split("/").includes("..")
    ) {
        throw new Error("Unsafe auth file path");
    }

    if (path.isAbsolute(relative)) {
        throw new Error("Absolute auth paths are not allowed");
    }

    return relative;
}

function writeTransferredAuth(sessionId, files) {
    if (!Array.isArray(files) || files.length === 0) {
        throw new Error("Pairing server returned no auth files");
    }

    const authFolder = ensureAuthFolder(sessionId);

    let credsFound = false;

    for (const file of files) {
        if (!file || !file.path) {
            continue;
        }

        const relative = safeAuthRelativePath(file.path);

        const destination = path.resolve(
            authFolder,
            relative
        );

        const rootResolved = path.resolve(authFolder);

        if (
            destination !== rootResolved &&
            !destination.startsWith(rootResolved + path.sep)
        ) {
            throw new Error("Auth path escaped session folder");
        }

        if (relative === "creds.json") {
            credsFound = true;
        }

        if (typeof file.data !== "string") {
            throw new Error(
                `Invalid data for auth file: ${relative}`
            );
        }

        const buffer = Buffer.from(file.data, "base64");

        fs.mkdirSync(
            path.dirname(destination),
            { recursive: true }
        );

        fs.writeFileSync(
            destination,
            buffer
        );
    }

    const credsPath = path.join(
        authFolder,
        "creds.json"
    );

    if (!credsFound && !fs.existsSync(credsPath)) {
        throw new Error(
            "Transferred authentication does not contain creds.json"
        );
    }

    if (!fs.existsSync(credsPath)) {
        throw new Error("creds.json was not created");
    }

    return authFolder;
}

/* ============================================================
   PAIRING SERVER REQUEST
============================================================ */

async function callPairingServer(endpoint, options = {}) {
    const url =
        `${PAIRING_SERVER_URL}${endpoint.startsWith("/") ? endpoint : "/" + endpoint}`;

    const headers = {
        Accept: "application/json",
        ...(options.headers || {})
    };

    if (options.body !== undefined) {
        headers["Content-Type"] = "application/json";
    }

    const controller = new AbortController();

    const timeout = setTimeout(
        () => controller.abort(),
        Number(options.timeout || 30000)
    );

    try {
        const response = await fetch(url, {
            method: options.method || "GET",
            headers,
            body:
                options.body !== undefined
                    ? JSON.stringify(options.body)
                    : undefined,
            signal: controller.signal
        });

        const text = await response.text();

        let data;

        try {
            data = JSON.parse(text);
        } catch {
            data = {
                success: false,
                error: text || `HTTP ${response.status}`
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

/* ============================================================
   SESSION VERIFICATION
============================================================ */

async function verifySessionWithPairingServer(
    sessionId,
    phone
) {
    const id = normalizeSessionId(sessionId);
    const normalizedPhone = normalizePhone(phone);

    if (!isValidSessionId(id)) {
        return {
            success: false,
            error: "Invalid Session ID format"
        };
    }

    const encoded = encodeURIComponent(id);

    const endpoints = [
        `/session/${encoded}`,
        `/session-status/${encoded}`,
        `/check-session/${encoded}`,
        `/check/${encoded}`
    ];

    let lastError = "Session not found";

    for (const endpoint of endpoints) {
        try {
            const result = await callPairingServer(endpoint);

            if (!result.ok) {
                lastError =
                    result.data?.error ||
                    `Pairing server returned HTTP ${result.status}`;

                continue;
            }

            const data = result.data || {};

            if (data.success === false) {
                lastError =
                    data.error ||
                    "Session verification failed";

                continue;
            }

            const returnedSessionId = normalizeSessionId(
                data.sessionId ||
                data.session?.sessionId ||
                data.record?.sessionId ||
                id
            );

            if (
                returnedSessionId &&
                returnedSessionId !== id
            ) {
                lastError =
                    "Pairing server returned a different Session ID";

                continue;
            }

            const returnedPhone = normalizePhone(
                data.phone ||
                data.number ||
                data.session?.phone ||
                data.session?.number ||
                data.record?.phone ||
                data.record?.number ||
                ""
            );

            if (
                returnedPhone &&
                normalizedPhone &&
                returnedPhone !== normalizedPhone
            ) {
                return {
                    success: false,
                    error:
                        "Session ID does not belong to the supplied WhatsApp number"
                };
            }

            return {
                success: true,
                sessionId: id,
                phone: returnedPhone || normalizedPhone,
                jid:
                    data.jid ||
                    data.session?.jid ||
                    data.record?.jid ||
                    null,
                pairingId:
                    data.pairingId ||
                    data.pairId ||
                    data.session?.pairingId ||
                    data.record?.pairingId ||
                    null,
                authFolder:
                    data.authFolder ||
                    data.session?.authFolder ||
                    data.record?.authFolder ||
                    null,
                status:
                    data.status ||
                    data.session?.status ||
                    "authenticated",
                raw: data
            };
        } catch (error) {
            lastError = error.message;
        }
    }

    return {
        success: false,
        error: lastError
    };
}

/* ============================================================
   AUTH TRANSFER
============================================================ */

async function transferAuthFromPairingServer(
    sessionId,
    phone
) {
    if (!SESSION_TRANSFER_SECRET) {
        throw new Error(
            "SESSION_TRANSFER_SECRET is not configured on the bot server"
        );
    }

    const id = normalizeSessionId(sessionId);

    const encoded = encodeURIComponent(id);

    const result = await callPairingServer(
        `/session/${encoded}/auth`,
        {
            timeout: 60000,
            headers: {
                "X-Session-Transfer-Secret":
                    SESSION_TRANSFER_SECRET
            }
        }
    );

    if (!result.ok) {
        throw new Error(
            result.data?.error ||
            `Auth transfer failed with HTTP ${result.status}`
        );
    }

    const data = result.data || {};

    if (data.success !== true) {
        throw new Error(
            data.error ||
            "Pairing server rejected auth transfer"
        );
    }

    const returnedSessionId = normalizeSessionId(
        data.sessionId || id
    );

    if (returnedSessionId !== id) {
        throw new Error(
            "Auth transfer Session ID mismatch"
        );
    }

    const returnedPhone = normalizePhone(
        data.phone ||
        data.number ||
        phone
    );

    if (
        phone &&
        returnedPhone &&
        returnedPhone !== normalizePhone(phone)
    ) {
        throw new Error(
            "Auth transfer WhatsApp number mismatch"
        );
    }

    const authFolder = writeTransferredAuth(
        id,
        data.files
    );

    return {
        success: true,
        sessionId: id,
        phone: returnedPhone,
        jid: data.jid || null,
        pairingId:
            data.pairingId ||
            data.pairId ||
            null,
        authFolder,
        filesTransferred: data.files.length
    };
}

/* ============================================================
   BOT MANAGER
============================================================ */

async function deployThroughManager(options) {
    const botManager = global.ETIAS_BOT_MANAGER;

    if (
        !botManager ||
        typeof botManager.deploySession !== "function"
    ) {
        throw new Error(
            "ETIAS_BOT_MANAGER is not available"
        );
    }

    const auth = await transferAuthFromPairingServer(
        options.sessionId,
        options.phone
    );

    const result = await botManager.deploySession({
        ...options,

        authFolder: auth.authFolder,

        authenticated: true,

        connectImmediately: true,

        startCommands: true,

        jid: options.jid || auth.jid || null
    });

    if (!result || result.success !== true) {
        throw new Error(
            result?.error ||
            "Bot manager failed to deploy session"
        );
    }

    return {
        ...result,

        success: true,

        authTransferred: true,

        authFolder: auth.authFolder,

        filesTransferred:
            auth.filesTransferred,

        jid:
            result.jid ||
            auth.jid ||
            options.jid ||
            null
    };
}

/* ============================================================
   DEPLOYMENT DASHBOARD
============================================================ */

const DEPLOYMENT_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">

<title>ETIAS-MINI-BOT Deployment</title>

<style>
* {
    box-sizing: border-box;
}

body {
    margin: 0;
    min-height: 100vh;
    background:
        radial-gradient(circle at top, #063b27 0%, #01150e 35%, #000 100%);
    color: #d7ffe9;
    font-family: Arial, sans-serif;
}

body::before {
    content: "";
    position: fixed;
    inset: 0;
    pointer-events: none;
    background-image:
        linear-gradient(rgba(0,255,140,.04) 1px, transparent 1px),
        linear-gradient(90deg, rgba(0,255,140,.04) 1px, transparent 1px);
    background-size: 35px 35px;
}

.container {
    width: min(500px, 92%);
    margin: 60px auto;
    padding: 30px;
    border: 1px solid #00ff88;
    border-radius: 20px;
    background: rgba(0,20,13,.86);
    box-shadow:
        0 0 30px rgba(0,255,136,.18),
        inset 0 0 30px rgba(0,255,136,.03);
}

h1 {
    text-align: center;
    color: #00ff88;
    letter-spacing: 2px;
}

.subtitle {
    text-align: center;
    color: #7deeb1;
    margin-bottom: 25px;
}

label {
    display: block;
    margin: 15px 0 7px;
}

input,
select {
    width: 100%;
    padding: 14px;
    border-radius: 10px;
    border: 1px solid #00a95c;
    background: #001a10;
    color: white;
    outline: none;
}

button {
    width: 100%;
    margin-top: 22px;
    padding: 15px;
    border: 0;
    border-radius: 10px;
    background: #00ff88;
    color: #00150c;
    font-weight: bold;
    cursor: pointer;
}

button:hover {
    box-shadow: 0 0 20px #00ff88;
}

#result {
    margin-top: 20px;
    padding: 15px;
    border-radius: 10px;
    background: #001a10;
    white-space: pre-wrap;
    word-break: break-word;
}

.success {
    color: #00ff88;
}

.error {
    color: #ff6868;
}
</style>
</head>

<body>

<div class="container">

<h1>ETIAS-MINI-BOT</h1>

<div class="subtitle">
Multi-User Deployment System
</div>

<form id="deployForm">

<label>Admin Key</label>
<input
    id="adminKey"
    type="password"
    placeholder="Admin key"
    required
>

<label>Session ID</label>
<input
    id="sessionId"
    placeholder="ETIAS-MINI-BOT~12345678"
    required
>

<label>WhatsApp Number</label>
<input
    id="phone"
    placeholder="263778810589"
    required
>

<label>Duration</label>

<select id="days">

<option value="30">30 Days</option>
<option value="60">60 Days</option>
<option value="90">90 Days</option>
<option value="180">180 Days</option>
<option value="365">365 Days</option>

</select>

<button type="submit">
DEPLOY BOT
</button>

</form>

<div id="result">
Waiting for deployment...
</div>

</div>

<script>

const form = document.getElementById("deployForm");
const result = document.getElementById("result");

form.addEventListener("submit", async (event) => {

    event.preventDefault();

    result.className = "";
    result.textContent = "Deploying...";

    const payload = {
        adminKey:
            document.getElementById("adminKey").value,

        sessionId:
            document.getElementById("sessionId").value,

        phone:
            document.getElementById("phone").value,

        days:
            Number(document.getElementById("days").value)
    };

    try {

        const response = await fetch("/deploy", {

            method: "POST",

            headers: {
                "Content-Type": "application/json"
            },

            body: JSON.stringify(payload)
        });

        const data = await response.json();

        if (!response.ok || !data.success) {

            result.className = "error";

            result.textContent =
                data.error ||
                "Deployment failed.";

            return;
        }

        result.className = "success";

        result.textContent =
            "BOT DEPLOYED SUCCESSFULLY\\n\\n" +
            "Session: " +
            data.sessionId +
            "\\nPhone: " +
            data.phone +
            "\\nStatus: " +
            data.status +
            "\\nConnected: " +
            data.connected +
            "\\nDays: " +
            data.days;

    } catch (error) {

        result.className = "error";

        result.textContent =
            error.message;
    }

});

</script>

</body>
</html>`;

/* ============================================================
   ROOT
============================================================ */

app.get("/", (req, res) => {
    res.type("html").send(DEPLOYMENT_HTML);
});

/* ============================================================
   HEALTH
============================================================ */

app.get("/health", (req, res) => {

    res.json({
        success: true,
        status: "online",
        service: "ETIAS-MINI-BOT Deployment Server",
        version: "5.0.0",
        multiUser: true,
        pairingServer: PAIRING_SERVER_URL,
        sessionPrefix: SESSION_PREFIX,
        authTransfer:
            Boolean(SESSION_TRANSFER_SECRET),
        time: new Date().toISOString()
    });

});

app.get("/api/health", (req, res) => {
    res.json({
        success: true,
        status: "online"
    });
});

/* ============================================================
   DEPLOY
============================================================ */

app.post("/deploy", async (req, res) => {

    try {

        const sessionId =
            normalizeSessionId(req.body.sessionId);

        const phone =
            normalizePhone(req.body.phone);

        const days =
            Math.min(
                Math.max(
                    Number(req.body.days || DEFAULT_DAYS),
                    1
                ),
                MAX_DAYS
            );

        const adminKey =
            String(req.body.adminKey || "").trim();

        if (
            process.env.ADMIN_SECRET &&
            adminKey !== process.env.ADMIN_SECRET
        ) {
            return res.status(403).json({
                success: false,
                error: "Invalid admin key"
            });
        }

        if (!isValidSessionId(sessionId)) {

            return res.status(400).json({
                success: false,
                error:
                    `Invalid Session ID. Expected ${SESSION_PREFIX} followed by 8 digits.`
            });

        }

        if (!phone || phone.length < 7) {

            return res.status(400).json({
                success: false,
                error: "Invalid WhatsApp number"
            });

        }

        const existing =
            findDeployment(sessionId);

        if (
            existing &&
            ["starting", "connected", "active"].includes(
                String(existing.status).toLowerCase()
            )
        ) {

            return res.status(409).json({
                success: false,
                error:
                    "This Session ID is already deployed"
            });

        }

        const deployments =
            getDeployments();

        const samePhone =
            deployments.find(item =>
                normalizePhone(item.phone) === phone &&
                ["starting", "connected", "active"].includes(
                    String(item.status).toLowerCase()
                )
            );

        if (samePhone) {

            return res.status(409).json({
                success: false,
                error:
                    "This WhatsApp number already has an active deployment",
                sessionId:
                    samePhone.sessionId
            });

        }

        /* ----------------------------------------------------
           STEP 1: VERIFY SESSION
        ---------------------------------------------------- */

        const verification =
            await verifySessionWithPairingServer(
                sessionId,
                phone
            );

        if (!verification.success) {

            return res.status(400).json({
                success: false,
                error:
                    verification.error ||
                    "Could not verify the Session ID with the pairing server."
            });

        }

        /* ----------------------------------------------------
           STEP 2: DEPLOY + TRANSFER AUTH
        ---------------------------------------------------- */

        const expireAt =
            new Date(
                Date.now() +
                days * 24 * 60 * 60 * 1000
            ).toISOString();

        const managerResult =
            await deployThroughManager({

                sessionId,

                phone,

                days,

                expireAt,

                pairingId:
                    verification.pairingId,

                jid:
                    verification.jid,

                authenticated: true,

                connectImmediately: true,

                startCommands: true

            });

        /* ----------------------------------------------------
           STEP 3: SAVE DEPLOYMENT
        ---------------------------------------------------- */

        const deployment = {

            sessionId,

            phone,

            jid:
                managerResult.jid ||
                verification.jid ||
                null,

            pairingId:
                managerResult.pairingId ||
                verification.pairingId ||
                null,

            days,

            expireAt,

            authFolder:
                managerResult.authFolder,

            status:
                managerResult.status ||
                "starting",

            connected:
                managerResult.connected === true,

            authTransferred:
                managerResult.authTransferred === true,

            filesTransferred:
                managerResult.filesTransferred || 0,

            commandsStarted:
                managerResult.commandsStarted !== false,

            createdAt:
                new Date().toISOString(),

            botStartedAt:
                new Date().toISOString(),

            updatedAt:
                new Date().toISOString()
        };

        const updated =
            getDeployments().filter(
                item =>
                    normalizeSessionId(item.sessionId) !==
                    sessionId
            );

        updated.push(deployment);

        saveDeployments(updated);

        return res.json({

            success: true,

            message:
                "ETIAS-MINI-BOT deployed successfully",

            sessionId,

            phone,

            jid:
                deployment.jid,

            days,

            expireAt,

            status:
                deployment.status,

            connected:
                deployment.connected,

            authTransferred:
                deployment.authTransferred,

            filesTransferred:
                deployment.filesTransferred,

            commandsStarted:
                deployment.commandsStarted

        });

    } catch (error) {

        console.error(
            "[DEPLOY ERROR]",
            error
        );

        return res.status(500).json({

            success: false,

            error:
                error.message ||
                "Deployment failed"

        });

    }

});

/* ============================================================
   SESSION STATUS
============================================================ */

app.get("/status/:sessionId", async (req, res) => {

    const sessionId =
        normalizeSessionId(
            req.params.sessionId
        );

    const local =
        findDeployment(sessionId);

    const manager =
        global.ETIAS_BOT_MANAGER;

    let live = null;

    if (
        manager &&
        typeof manager.getSession === "function"
    ) {
        try {
            live =
                manager.getSession(
                    sessionId
                );
        } catch {}
    }

    if (!local && !live) {

        return res.status(404).json({
            success: false,
            error: "Session not found"
        });

    }

    res.json({

        success: true,

        sessionId,

        deployment:
            local || null,

        live:
            live || null

    });

});

app.get("/api/session/:sessionId", async (req, res) => {

    req.url =
        `/status/${req.params.sessionId}`;

    return app._router
        ? res.redirect(
            `/status/${encodeURIComponent(req.params.sessionId)}`
        )
        : res.status(404).json({
            success: false
        });

});

/* ============================================================
   SESSIONS
============================================================ */

app.get("/sessions", (req, res) => {

    const manager =
        global.ETIAS_BOT_MANAGER;

    let live = [];

    if (
        manager &&
        typeof manager.getSessions === "function"
    ) {
        try {
            live =
                manager.getSessions() || [];
        } catch {}
    }

    res.json({

        success: true,

        deployments:
            getDeployments(),

        live

    });

});

app.get("/api/sessions", (req, res) => {

    const manager =
        global.ETIAS_BOT_MANAGER;

    let live = [];

    if (
        manager &&
        typeof manager.getSessions === "function"
    ) {
        try {
            live =
                manager.getSessions() || [];
        } catch {}
    }

    res.json({
        success: true,
        sessions: live,
        deployments: getDeployments()
    });

});

/* ============================================================
   USERS
============================================================ */

app.get("/api/users", (req, res) => {

    const deployments =
        getDeployments();

    res.json({
        success: true,
        total: deployments.length,
        users: deployments
    });

});

/* ============================================================
   RENEW
============================================================ */

app.post("/renew", (req, res) => {

    try {

        const sessionId =
            normalizeSessionId(
                req.body.sessionId
            );

        const days =
            Math.min(
                Math.max(
                    Number(req.body.days || 30),
                    1
                ),
                MAX_DAYS
            );

        const deployment =
            findDeployment(sessionId);

        if (!deployment) {

            return res.status(404).json({
                success: false,
                error: "Session not found"
            });

        }

        const current =
            new Date(
                deployment.expireAt || Date.now()
            );

        const base =
            current > new Date()
                ? current
                : new Date();

        const expireAt =
            new Date(
                base.getTime() +
                days * 24 * 60 * 60 * 1000
            ).toISOString();

        const updated =
            updateDeployment(
                sessionId,
                {
                    expireAt,
                    days:
                        Number(deployment.days || 0) +
                        days
                }
            );

        res.json({
            success: true,
            deployment: updated
        });

    } catch (error) {

        res.status(500).json({
            success: false,
            error: error.message
        });

    }

});

/* ============================================================
   DELETE / STOP
============================================================ */

app.delete("/sessions/:sessionId", async (req, res) => {

    const sessionId =
        normalizeSessionId(
            req.params.sessionId
        );

    const manager =
        global.ETIAS_BOT_MANAGER;

    try {

        if (
            manager &&
            typeof manager.removeSession === "function"
        ) {
            await manager.removeSession(
                sessionId
            );
        }

        const deployments =
            getDeployments().filter(
                item =>
                    normalizeSessionId(item.sessionId) !==
                    sessionId
            );

        saveDeployments(deployments);

        res.json({
            success: true,
            sessionId
        });

    } catch (error) {

        res.status(500).json({
            success: false,
            error: error.message
        });

    }

});

/* ============================================================
   STATS
============================================================ */

app.get("/deploy-stats", (req, res) => {

    const deployments =
        getDeployments();

    const manager =
        global.ETIAS_BOT_MANAGER;

    let live = [];

    if (
        manager &&
        typeof manager.getSessions === "function"
    ) {
        try {
            live =
                manager.getSessions() || [];
        } catch {}
    }

    const connected =
        live.filter(
            session =>
                session.connected === true
        ).length;

    res.json({

        success: true,

        totalUsers:
            deployments.length,

        onlineUsers:
            connected,

        connected,

        active:
            deployments.filter(
                item =>
                    new Date(item.expireAt || 0) >
                    new Date()
            ).length

    });

});

app.get("/total-users", (req, res) => {

    res.json({

        success: true,

        totalUsers:
            getDeployments().length

    });

});

/* ============================================================
   MANAGER
============================================================ */

app.get("/manager", (req, res) => {

    const manager =
        global.ETIAS_BOT_MANAGER;

    res.json({

        success: Boolean(manager),

        available:
            Boolean(manager),

        methods:
            manager
                ? Object.keys(manager)
                : []

    });

});

/* ============================================================
   PAIRING SERVER
============================================================ */

app.get("/pairing-server", (req, res) => {

    res.json({

        success: true,

        url:
            PAIRING_SERVER_URL,

        authTransfer:
            Boolean(SESSION_TRANSFER_SECRET)

    });

});

/* ============================================================
   STATIC FILES
============================================================ */

const publicDir =
    path.join(ROOT, "public");

if (fs.existsSync(publicDir)) {

    app.use(
        express.static(publicDir)
    );

}

/* ============================================================
   404
============================================================ */

app.use((req, res) => {

    res.status(404).json({

        success: false,

        error:
            "Route not found",

        path:
            req.path

    });

});

/* ============================================================
   ERROR
============================================================ */

app.use((error, req, res, next) => {

    console.error(
        "[SERVER ERROR]",
        error
    );

    res.status(500).json({

        success: false,

        error:
            error.message ||
            "Internal server error"

    });

});

/* ============================================================
   EXPORT
   main.js starts the HTTP server.
============================================================ */

module.exports = app;
