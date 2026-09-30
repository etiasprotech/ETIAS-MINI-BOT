"use strict";

require("dotenv").config();

const express = require("express");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const pino = require("pino");

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    Browsers,
    makeCacheableSignalKeyStore,
    downloadMediaMessage
} = require("@whiskeysockets/baileys");

const app = express();

const PORT = process.env.PORT || 3000;

const ROOT = __dirname;

const AUTH_DIR = path.join(ROOT, "auth");
const DATA_DIR = path.join(ROOT, "data");
const COMMANDS_DIR = path.join(ROOT, "commands");
const PUBLIC_DIR = path.join(ROOT, "public");

const USERS_FILE = path.join(
    DATA_DIR,
    "deployed.json"
);

const SETTINGS_FILE = path.join(
    DATA_DIR,
    "settings.json"
);

const LOG_FILE = path.join(
    DATA_DIR,
    "logs.json"
);

const ADMIN_TOKEN =
    process.env.ADMIN_TOKEN ||
    "change-this-admin-token";

const logger = pino({
    level: "silent"
});

/* =========================================================
   MEMORY
========================================================= */

const sessions = new Map();

const reconnecting = new Set();

let commands = new Map();

/* =========================================================
   DIRECTORIES
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
        COMMANDS_DIR,
        {
            recursive: true
        }
    );

    await fsp.mkdir(
        PUBLIC_DIR,
        {
            recursive: true
        }
    );

    if (!fs.existsSync(USERS_FILE)) {
        await fsp.writeFile(
            USERS_FILE,
            "[]"
        );
    }

    if (!fs.existsSync(SETTINGS_FILE)) {
        await fsp.writeFile(
            SETTINGS_FILE,
            "{}"
        );
    }

    if (!fs.existsSync(LOG_FILE)) {
        await fsp.writeFile(
            LOG_FILE,
            "[]"
        );
    }
}

/* =========================================================
   JSON STORAGE
========================================================= */

async function readJSON(file, fallback) {

    try {

        const data =
            await fsp.readFile(
                file,
                "utf8"
            );

        return JSON.parse(data);

    } catch {

        return fallback;
    }
}

async function writeJSON(
    file,
    data
) {

    await fsp.writeFile(
        file,
        JSON.stringify(
            data,
            null,
            2
        )
    );
}

/* =========================================================
   LOGGING
========================================================= */

async function log(
    level,
    message,
    number = null
) {

    const entry = {
        time:
            new Date().toISOString(),

        level,

        number,

        message
    };

    console.log(
        `[${level.toUpperCase()}]`,
        number
            ? `[${number}]`
            : "",
        message
    );

    const logs =
        await readJSON(
            LOG_FILE,
            []
        );

    logs.push(entry);

    /*
     * Keep last 500 logs.
     */
    const trimmed =
        logs.slice(-500);

    await writeJSON(
        LOG_FILE,
        trimmed
    );
}

/* =========================================================
   PHONE NUMBER
========================================================= */

function cleanNumber(number) {

    return String(
        number || ""
    )
        .replace(
            /\D/g,
            ""
        );
}

/* =========================================================
   SESSION ID
========================================================= */

function sessionName(number) {

    return cleanNumber(
        number
    );
}

function authPath(number) {

    return path.join(
        AUTH_DIR,
        sessionName(number)
    );
}

/* =========================================================
   USERS
========================================================= */

async function getUsers() {

    return await readJSON(
        USERS_FILE,
        []
    );
}

async function saveUsers(users) {

    await writeJSON(
        USERS_FILE,
        users
    );
}

async function findUser(number) {

    number =
        cleanNumber(
            number
        );

    const users =
        await getUsers();

    return users.find(
        user =>
            user.number ===
            number
    );
}

/* =========================================================
   SETTINGS
========================================================= */

const DEFAULT_SETTINGS = {

    mode: "public",

    antilink: false,

    antidelete: false,

    antiviewonce: false,

    viewonce: false,

    welcome: true,

    goodbye: true

};

async function getSettings(number) {

    const all =
        await readJSON(
            SETTINGS_FILE,
            {}
        );

    return {
        ...DEFAULT_SETTINGS,
        ...(all[number] || {})
    };
}

async function saveSettings(
    number,
    settings
) {

    const all =
        await readJSON(
            SETTINGS_FILE,
            {}
        );

    all[number] = {
        ...DEFAULT_SETTINGS,
        ...settings
    };

    await writeJSON(
        SETTINGS_FILE,
        all
    );
}

/* =========================================================
   COMMAND LOADER
========================================================= */

async function loadCommands() {

    commands.clear();

    if (
        !fs.existsSync(
            COMMANDS_DIR
        )
    ) {
        return;
    }

    const files =
        await fsp.readdir(
            COMMANDS_DIR
        );

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

            const name =
                command.name ||
                path.basename(
                    file,
                    ".js"
                );

            commands.set(
                name.toLowerCase(),
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

            console.error(
                `[COMMAND ERROR] ${file}`,
                error
            );
        }
    }

    console.log(
        `[COMMANDS] ${commands.size} commands loaded`
    );
}

/* =========================================================
   MESSAGE TEXT
========================================================= */

function getMessageText(
    message
) {

    if (!message) {
        return "";
    }

    if (
        message.conversation
    ) {
        return message.conversation;
    }

    if (
        message.extendedTextMessage
    ) {
        return (
            message
                .extendedTextMessage
                .text ||
            ""
        );
    }

    if (
        message.imageMessage
    ) {
        return (
            message
                .imageMessage
                .caption ||
            ""
        );
    }

    if (
        message.videoMessage
    ) {
        return (
            message
                .videoMessage
                .caption ||
            ""
        );
    }

    if (
        message.documentMessage
    ) {
        return (
            message
                .documentMessage
                .caption ||
            ""
        );
    }

    return "";
}

/* =========================================================
   UNWRAP MESSAGE
========================================================= */

function unwrapMessage(
    message
) {

    if (
        message?.ephemeralMessage
    ) {
        return unwrapMessage(
            message.ephemeralMessage.message
        );
    }

    if (
        message?.viewOnceMessage
    ) {
        return unwrapMessage(
            message.viewOnceMessage.message
        );
    }

    if (
        message?.viewOnceMessageV2
    ) {
        return unwrapMessage(
            message.viewOnceMessageV2.message
        );
    }

    if (
        message?.viewOnceMessageV2Extension
    ) {
        return unwrapMessage(
            message
                .viewOnceMessageV2Extension
                .message
        );
    }

    return message;
}

/* =========================================================
   ADMIN CHECK
========================================================= */

function isAdminRequest(
    req
) {

    const token =
        req.headers[
            "x-admin-token"
        ] ||
        req.query.token ||
        req.body?.token;

    return token ===
        ADMIN_TOKEN;
}

function requireAdmin(
    req,
    res,
    next
) {

    if (
        !isAdminRequest(
            req
        )
    ) {

        return res.status(
            401
        ).json({
            success: false,
            error:
                "Unauthorized"
        });
    }

    next();
}

/* =========================================================
   GROUP ADMIN
========================================================= */

async function isGroupAdmin(
    sock,
    jid,
    participant
) {

    try {

        const metadata =
            await sock.groupMetadata(
                jid
            );

        const member =
            metadata.participants.find(
                p =>
                    p.id ===
                    participant
            );

        return Boolean(
            member &&
            (
                member.admin ===
                    "admin" ||
                member.admin ===
                    "superadmin"
            )
        );

    } catch {

        return false;
    }
}

/* =========================================================
   ANTILINK
========================================================= */

const LINK_REGEX =
    /(https?:\/\/|www\.|chat\.whatsapp\.com\/|t\.me\/|discord\.gg\/)/i;

async function handleAntilink(
    sock,
    message,
    settings
) {

    if (
        !settings.antilink
    ) {
        return false;
    }

    const jid =
        message.key.remoteJid;

    if (
        !jid ||
        !jid.endsWith("@g.us")
    ) {
        return false;
    }

    const sender =
        message.key.participant;

    const text =
        getMessageText(
            message.message
        );

    if (
        !LINK_REGEX.test(
            text
        )
    ) {
        return false;
    }

    /*
     * Don't remove group admins.
     */
    if (
        await isGroupAdmin(
            sock,
            jid,
            sender
        )
    ) {
        return false;
    }

    try {

        await sock.sendMessage(
            jid,
            {
                delete:
                    message.key
            }
        );

        await sock.sendMessage(
            jid,
            {
                text:
                    "🚫 Links are not allowed in this group."
            }
        );

        return true;

    } catch (error) {

        console.error(
            "[ANTILINK]",
            error.message
        );

        return false;
    }
}

/* =========================================================
   WELCOME / GOODBYE
========================================================= */

async function handleGroupParticipants(
    sock,
    update,
    settings
) {

    if (
        !settings.welcome &&
        !settings.goodbye
    ) {
        return;
    }

    const {
        id,
        participants,
        action
    } = update;

    if (
        action === "add" &&
        settings.welcome
    ) {

        for (
            const participant
            of participants
        ) {

            await sock.sendMessage(
                id,
                {
                    text:
                        `👋 Welcome @${participant.split("@")[0]}!\n\n` +
                        `Welcome to the group. Enjoy your stay!`,
                    mentions: [
                        participant
                    ]
                }
            );
        }
    }

    if (
        (
            action === "remove" ||
            action === "leave"
        ) &&
        settings.goodbye
    ) {

        for (
            const participant
            of participants
        ) {

            await sock.sendMessage(
                id,
                {
                    text:
                        `👋 Goodbye @${participant.split("@")[0]}!`,
                    mentions: [
                        participant
                    ]
                }
            );
        }
    }
}

/* =========================================================
   ANTIVIEWONCE / VIEWONCE
========================================================= */

async function handleViewOnce(
    sock,
    message,
    settings
) {

    if (
        !message.message
    ) {
        return false;
    }

    const raw =
        message.message;

    const isViewOnce =
        Boolean(
            raw.viewOnceMessage ||
            raw.viewOnceMessageV2 ||
            raw.viewOnceMessageV2Extension
        );

    if (
        !isViewOnce
    ) {
        return false;
    }

    if (
        !settings.antiviewonce &&
        !settings.viewonce
    ) {
        return false;
    }

    const unwrapped =
        unwrapMessage(
            raw
        );

    const content =
        unwrapped;

    const remoteJid =
        message.key.remoteJid;

    /*
     * If viewonce mode is enabled,
     * re-send the media without view-once.
     */
    if (
        settings.viewonce
    ) {

        try {

            if (
                content.imageMessage
            ) {

                const buffer =
                    await downloadMediaMessage(
                        message,
                        "buffer",
                        {},
                        {
                            logger,
                            reuploadRequest:
                                sock.updateMediaMessage
                        }
                    );

                await sock.sendMessage(
                    remoteJid,
                    {
                        image: buffer,
                        caption:
                            content
                                .imageMessage
                                .caption ||
                            ""
                    }
                );

                return true;
            }

            if (
                content.videoMessage
            ) {

                const buffer =
                    await downloadMediaMessage(
                        message,
                        "buffer",
                        {},
                        {
                            logger,
                            reuploadRequest:
                                sock.updateMediaMessage
                        }
                    );

                await sock.sendMessage(
                    remoteJid,
                    {
                        video: buffer,
                        caption:
                            content
                                .videoMessage
                                .caption ||
                            ""
                    }
                );

                return true;
            }

            if (
                content.audioMessage
            ) {

                const buffer =
                    await downloadMediaMessage(
                        message,
                        "buffer",
                        {},
                        {
                            logger,
                            reuploadRequest:
                                sock.updateMediaMessage
                        }
                    );

                await sock.sendMessage(
                    remoteJid,
                    {
                        audio: buffer,
                        mimetype:
                            content
                                .audioMessage
                                .mimetype ||
                            "audio/mpeg"
                    }
                );

                return true;
            }

        } catch (error) {

            console.error(
                "[VIEWONCE]",
                error.message
            );
        }
    }

    /*
     * antiviewonce is enabled but
     * viewonce forwarding isn't enabled.
     */
    if (
        settings.antiviewonce
    ) {

        try {

            await sock.sendMessage(
                remoteJid,
                {
                    text:
                        "👁️ View-once media detected."
                }
            );

        } catch {}

        return true;
    }

    return false;
}

/* =========================================================
   COMMAND HANDLER
========================================================= */

async function handleCommand(
    sock,
    message,
    user
) {

    const settings =
        await getSettings(
            user.number
        );

    const body =
        getMessageText(
            message.message
        ).trim();

    if (!body) {
        return false;
    }

    const prefix =
        process.env.PREFIX ||
        ".";

    if (
        !body.startsWith(
            prefix
        )
    ) {
        return false;
    }

    const args =
        body
            .slice(
                prefix.length
            )
            .trim()
            .split(/\s+/);

    const commandName =
        (
            args.shift() ||
            ""
        ).toLowerCase();

    if (!commandName) {
        return false;
    }

    const command =
        commands.get(
            commandName
        );

    if (!command) {
        return false;
    }

    const context = {

        sock,

        message,

        user,

        settings,

        args,

        text:
            args.join(" "),

        prefix,

        jid:
            message.key.remoteJid,

        sender:
            message.key.participant ||
            message.key.remoteJid,

        isGroup:
            Boolean(
                message.key.remoteJid &&
                message.key.remoteJid.endsWith(
                    "@g.us"
                )
            ),

        reply: async text => {

            return sock.sendMessage(
                message.key.remoteJid,
                {
                    text
                },
                {
                    quoted:
                        message
                }
            );
        }
    };

    try {

        if (
            typeof command ===
            "function"
        ) {

            await command(
                context
            );

        } else if (
            typeof command.execute ===
            "function"
        ) {

            await command.execute(
                context
            );

        } else if (
            typeof command.run ===
            "function"
        ) {

            await command.run(
                context
            );

        } else if (
            typeof command.handler ===
            "function"
        ) {

            await command.handler(
                context
            );
        }

        return true;

    } catch (error) {

        console.error(
            `[COMMAND ERROR] ${commandName}`,
            error
        );

        await context.reply(
            "❌ Command error: " +
            error.message
        );

        return true;
    }
}

/* =========================================================
   BUILT-IN MODE COMMANDS
========================================================= */

async function handleBuiltIn(
    sock,
    message,
    user
) {

    const body =
        getMessageText(
            message.message
        ).trim();

    const prefix =
        process.env.PREFIX ||
        ".";

    if (
        !body.startsWith(
            prefix
        )
    ) {
        return false;
    }

    const args =
        body
            .slice(
                prefix.length
            )
            .trim()
            .split(/\s+/);

    const cmd =
        (
            args.shift() ||
            ""
        ).toLowerCase();

    if (
        cmd !== "mode"
    ) {
        return false;
    }

    const mode =
        (
            args[0] ||
            ""
        ).toLowerCase();

    if (
        ![
            "public",
            "private"
        ].includes(
            mode
        )
    ) {

        await sock.sendMessage(
            message.key.remoteJid,
            {
                text:
                    "Usage: .mode public\n" +
                    "or\n" +
                    ".mode private"
            }
        );

        return true;
    }

    await saveSettings(
        user.number,
        {
            ...(await getSettings(
                user.number
            )),
            mode
        }
    );

    await sock.sendMessage(
        message.key.remoteJid,
        {
            text:
                `✅ Bot mode changed to: ${mode}`
        }
    );

    return true;
}

/* =========================================================
   MESSAGE HANDLER
========================================================= */

async function handleMessage(
    sock,
    message,
    user
) {

    if (
        !message ||
        !message.message
    ) {
        return;
    }

    if (
        message.key.fromMe
    ) {
        return;
    }

    const settings =
        await getSettings(
            user.number
        );

    /*
     * Expiry check.
     */
    if (
        user.expiresAt &&
        Date.now() >
            new Date(
                user.expiresAt
            ).getTime()
    ) {

        await log(
            "warn",
            "Session expired",
            user.number
        );

        return;
    }

    /*
     * View-once handling.
     */
    const viewOnceHandled =
        await handleViewOnce(
            sock,
            message,
            settings
        );

    if (
        viewOnceHandled
    ) {
        return;
    }

    /*
     * Antilink.
     */
    const linkHandled =
        await handleAntilink(
            sock,
            message,
            settings
        );

    if (
        linkHandled
    ) {
        return;
    }

    /*
     * Public/private mode.
     */
    const body =
        getMessageText(
            message.message
        ).trim();

    const prefix =
        process.env.PREFIX ||
        ".";

    const isCommand =
        body.startsWith(
            prefix
        );

    if (
        settings.mode ===
            "private" &&
        !isCommand
    ) {
        return;
    }

    /*
     * Built-in commands.
     */
    const builtIn =
        await handleBuiltIn(
            sock,
            message,
            user
        );

    if (
        builtIn
    ) {
        return;
    }

    /*
     * External commands.
     */
    await handleCommand(
        sock,
        message,
        user
    );
}

/* =========================================================
   ANTIDELETE
========================================================= */

function setupAntidelete(
    sock,
    user
) {

    sock.ev.on(
        "messages.delete",
        async event => {

            const settings =
                await getSettings(
                    user.number
                );

            if (
                !settings.antidelete
            ) {
                return;
            }

            await log(
                "info",
                "Message deletion event received",
                user.number
            );

            /*
             * Full recovery of deleted media/text
             * requires a message store. This handler
             * records the event without claiming
             * deleted content can always be recovered.
             */
            try {

                if (
                    event?.keys?.length
                ) {

                    for (
                        const key
                        of event.keys
                    ) {

                        console.log(
                            `[ANTIDELETE] Deleted message in ${key.remoteJid}`
                        );
                    }
                }

            } catch (
                error
            ) {

                console.error(
                    "[ANTIDELETE]",
                    error.message
                );
            }
        }
    );
}

/* =========================================================
   CONNECT SESSION
========================================================= */

async function connectSession(
    user
) {

    const number =
        cleanNumber(
            user.number
        );

    const folder =
        authPath(
            number
        );

    if (
        !fs.existsSync(
            path.join(
                folder,
                "creds.json"
            )
        )
    ) {

        await log(
            "error",
            "creds.json not found",
            number
        );

        return;
    }

    if (
        sessions.has(
            number
        )
    ) {

        const existing =
            sessions.get(
                number
            );

        if (
            existing.socket
        ) {
            return existing.socket;
        }
    }

    await log(
        "info",
        "Connecting WhatsApp session...",
        number
    );

    const {
        state,
        saveCreds
    } =
        await useMultiFileAuthState(
            folder
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

    sessions.set(
        number,
        {
            socket: sock,
            status:
                "connecting"
        }
    );

    sock.ev.on(
        "creds.update",
        saveCreds
    );

    setupAntidelete(
        sock,
        user
    );

    sock.ev.on(
        "group-participants.update",
        async update => {

            try {

                const settings =
                    await getSettings(
                        number
                    );

                await handleGroupParticipants(
                    sock,
                    update,
                    settings
                );

            } catch (
                error
            ) {

                console.error(
                    "[GROUP]",
                    error.message
                );
            }
        }
    );

    sock.ev.on(
        "messages.upsert",
        async event => {

            if (
                event.type !==
                    "notify" &&
                event.type !==
                    "append"
            ) {
                return;
            }

            for (
                const message
                of event.messages
            ) {

                try {

                    await handleMessage(
                        sock,
                        message,
                        user
                    );

                } catch (
                    error
                ) {

                    console.error(
                        "[MESSAGE]",
                        error
                    );
                }
            }
        }
    );

    sock.ev.on(
        "connection.update",
        async update => {

            const {
                connection,
                lastDisconnect
            } = update;

            if (
                connection ===
                "connecting"
            ) {

                sessions.set(
                    number,
                    {
                        socket: sock,
                        status:
                            "connecting"
                    }
                );

                await updateUserStatus(
                    number,
                    "connecting"
                );

                await log(
                    "info",
                    "WhatsApp connecting...",
                    number
                );
            }

            if (
                connection ===
                "open"
            ) {

                sessions.set(
                    number,
                    {
                        socket: sock,
                        status:
                            "connected"
                    }
                );

                await updateUserStatus(
                    number,
                    "connected"
                );

                await log(
                    "success",
                    "WhatsApp connected. Bot is online.",
                    number
                );
            }

            if (
                connection ===
                "close"
            ) {

                sessions.delete(
                    number
                );

                const code =
                    lastDisconnect
                        ?.error
                        ?.output
                        ?.statusCode;

                await updateUserStatus(
                    number,
                    "disconnected"
                );

                await log(
                    "warn",
                    `WhatsApp disconnected. Code: ${code || "unknown"}`,
                    number
                );

                if (
                    code ===
                    DisconnectReason.loggedOut
                ) {

                    await log(
                        "error",
                        "WhatsApp session logged out.",
                        number
                    );

                    return;
                }

                if (
                    reconnecting.has(
                        number
                    )
                ) {
                    return;
                }

                reconnecting.add(
                    number
                );

                await log(
                    "info",
                    "Scheduling automatic reconnect...",
                    number
                );

                setTimeout(
                    async () => {

                        reconnecting.delete(
                            number
                        );

                        const current =
                            await findUser(
                                number
                            );

                        if (
                            !current
                        ) {
                            return;
                        }

                        if (
                            current.status ===
                            "deleted"
                        ) {
                            return;
                        }

                        if (
                            current.expiresAt &&
                            Date.now() >
                                new Date(
                                    current.expiresAt
                                ).getTime()
                        ) {

                            await updateUserStatus(
                                number,
                                "expired"
                            );

                            return;
                        }

                        try {

                            await connectSession(
                                current
                            );

                        } catch (
                            error
                        ) {

                            await log(
                                "error",
                                `Reconnect failed: ${error.message}`,
                                number
                            );
                        }

                    },
                    5000
                );
            }
        }
    );

    return sock;
}

/* =========================================================
   USER STATUS
========================================================= */

async function updateUserStatus(
    number,
    status
) {

    const users =
        await getUsers();

    const index =
        users.findIndex(
            user =>
                user.number ===
                number
        );

    if (
        index === -1
    ) {
        return;
    }

    users[index].status =
        status;

    users[index].updatedAt =
        new Date().toISOString();

    await saveUsers(
        users
    );
}

/* =========================================================
   DECODE SESSION CODE
========================================================= */

function decodeSessionCode(
    code
) {

    if (!code) {
        throw new Error(
            "Session code is empty"
        );
    }

    let raw =
        String(code).trim();

    /*
     * Remove optional prefixes.
     */
    raw =
        raw.replace(
            /^ETIAS-MINI-BOT~/,
            ""
        );

    raw =
        raw.replace(
            /^SESSION~/,
            ""
        );

    /*
     * Try base64 JSON.
     */
    let decoded;

    try {

        decoded =
            Buffer.from(
                raw,
                "base64"
            ).toString(
                "utf8"
            );

    } catch {

        decoded =
            raw;
    }

    try {

        return JSON.parse(
            decoded
        );

    } catch {

        /*
         * Also allow raw JSON.
         */
        try {

            return JSON.parse(
                raw
            );

        } catch {

            throw new Error(
                "Invalid session code. Expected the code generated by the ETIAS pairing server."
            );
        }
    }
}

/* =========================================================
   WRITE SESSION BUNDLE
========================================================= */

async function writeSessionBundle(
    code,
    destination
) {

    const bundle =
        decodeSessionCode(
            code
        );

    await fsp.mkdir(
        destination,
        {
            recursive: true
        }
    );

    /*
     * Format used by the pairing server:
     *
     * {
     *   format: "ETIAS-MINI-BOT",
     *   version: 2,
     *   files: {
     *      "creds.json": "base64...",
     *      "keys/....json": "base64..."
     *   }
     * }
     */

    const files =
        bundle.files ||
        bundle.auth ||
        bundle.data;

    if (
        !files ||
        typeof files !==
            "object"
    ) {

        throw new Error(
            "Session bundle contains no auth files"
        );
    }

    for (
        const [
            relative,
            value
        ] of Object.entries(
            files
        )
    ) {

        /*
         * Prevent path traversal.
         */
        const safeRelative =
            path.normalize(
                relative
            );

        if (
            safeRelative.startsWith(
                ".."
            ) ||
            path.isAbsolute(
                safeRelative
            )
        ) {
            continue;
        }

        const target =
            path.join(
                destination,
                safeRelative
            );

        await fsp.mkdir(
            path.dirname(
                target
            ),
            {
                recursive: true
            }
        );

        let buffer;

        if (
            typeof value ===
            "string"
        ) {

            buffer =
                Buffer.from(
                    value,
                    "base64"
                );

        } else if (
            Array.isArray(
                value
            )
        ) {

            buffer =
                Buffer.from(
                    value
                );

        } else if (
            value?.base64
        ) {

            buffer =
                Buffer.from(
                    value.base64,
                    "base64"
                );

        } else {

            buffer =
                Buffer.from(
                    JSON.stringify(
                        value,
                        null,
                        2
                    )
                );
        }

        await fsp.writeFile(
            target,
            buffer
        );
    }

    const creds =
        path.join(
            destination,
            "creds.json"
        );

    if (
        !fs.existsSync(
            creds
        )
    ) {

        throw new Error(
            "Session bundle was extracted but creds.json is missing"
        );
    }

    return bundle;
}

/* =========================================================
   DEPLOY USER
========================================================= */

async function deployUser({
    number,
    duration,
    code
}) {

    number =
        cleanNumber(
            number
        );

    duration =
        Number(
            duration
        );

    if (
        !number
    ) {
        throw new Error(
            "User number is required"
        );
    }

    if (
        !Number.isInteger(
            duration
        ) ||
        duration < 1
    ) {

        throw new Error(
            "Duration must be at least 1 day"
        );
    }

    if (
        !code
    ) {

        throw new Error(
            "Session code is required"
        );
    }

    const users =
        await getUsers();

    const existingIndex =
        users.findIndex(
            user =>
                user.number ===
                number
        );

    /*
     * Remove existing socket if replacing
     * an existing deployment.
     */
    if (
        sessions.has(
            number
        )
    ) {

        try {

            const old =
                sessions.get(
                    number
                );

            old.socket?.end();

        } catch {}

        sessions.delete(
            number
        );
    }

    const folder =
        authPath(
            number
        );

    /*
     * Clean previous auth state.
     */
    await fsp.rm(
        folder,
        {
            recursive: true,
            force: true
        }
    );

    await fsp.mkdir(
        folder,
        {
            recursive: true
        }
    );

    await log(
        "info",
        "Extracting session bundle...",
        number
    );

    await writeSessionBundle(
        code,
        folder
    );

    const now =
        new Date();

    const expires =
        new Date(
            now.getTime() +
            duration *
                24 *
                60 *
                60 *
                1000
        );

    const user = {

        number,

        duration,

        status:
            "deploying",

        connected:
            false,

        authFolder:
            folder,

        createdAt:
            existingIndex >= 0
                ? users[
                    existingIndex
                  ].createdAt
                : now.toISOString(),

        updatedAt:
            now.toISOString(),

        expiresAt:
            expires.toISOString()
    };

    if (
        existingIndex >= 0
    ) {

        users[
            existingIndex
        ] = {
            ...users[
                existingIndex
            ],
            ...user
        };

    } else {

        users.push(
            user
        );
    }

    await saveUsers(
        users
    );

    await saveSettings(
        number,
        await getSettings(
            number
        )
    );

    await log(
        "info",
        "Session extracted successfully.",
        number
    );

    /*
     * Connect immediately.
     */
    await connectSession(
        user
    );

    return user;
}

/* =========================================================
   RENEW USER
========================================================= */

async function renewUser(
    number,
    duration
) {

    number =
        cleanNumber(
            number
        );

    duration =
        Number(
            duration
        );

    if (
        !number
    ) {
        throw new Error(
            "Number required"
        );
    }

    if (
        !Number.isInteger(
            duration
        ) ||
        duration < 1
    ) {
        throw new Error(
            "Invalid duration"
        );
    }

    const users =
        await getUsers();

    const index =
        users.findIndex(
            user =>
                user.number ===
                number
        );

    if (
        index === -1
    ) {
        throw new Error(
            "User not found"
        );
    }

    const current =
        new Date();

    const oldExpiry =
        new Date(
            users[index]
                .expiresAt
        );

    const base =
        oldExpiry > current
            ? oldExpiry
            : current;

    const newExpiry =
        new Date(
            base.getTime() +
            duration *
                24 *
                60 *
                60 *
                1000
        );

    users[index]
        .expiresAt =
        newExpiry.toISOString();

    users[index]
        .duration =
        duration;

    users[index]
        .status =
        "connected";

    await saveUsers(
        users
    );

    await log(
        "success",
        `User renewed for ${duration} day(s).`,
        number
    );

    return users[index];
}

/* =========================================================
   DELETE USER
========================================================= */

async function deleteUser(
    number
) {

    number =
        cleanNumber(
            number
        );

    const users =
        await getUsers();

    const index =
        users.findIndex(
            user =>
                user.number ===
                number
        );

    if (
        index === -1
    ) {

        throw new Error(
            "User not found"
        );
    }

    /*
     * Stop WhatsApp socket.
     */
    if (
        sessions.has(
            number
        )
    ) {

        try {

            const session =
                sessions.get(
                    number
                );

            session.socket?.end();

        } catch {}

        sessions.delete(
            number
        );
    }

    /*
     * Remove auth files.
     */
    const folder =
        authPath(
            number
        );

    await fsp.rm(
        folder,
        {
            recursive: true,
            force: true
        }
    );

    /*
     * Remove settings.
     */
    const settings =
        await readJSON(
            SETTINGS_FILE,
            {}
        );

    delete settings[
        number
    ];

    await writeJSON(
        SETTINGS_FILE,
        settings
    );

    /*
     * Remove user.
     */
    users.splice(
        index,
        1
    );

    await saveUsers(
        users
    );

    await log(
        "success",
        "User deleted.",
        number
    );

    return true;
}

/* =========================================================
   EXPIRY CHECKER
========================================================= */

async function checkExpiry() {

    const users =
        await getUsers();

    const now =
        Date.now();

    for (
        const user
        of users
    ) {

        if (
            !user.expiresAt
        ) {
            continue;
        }

        if (
            new Date(
                user.expiresAt
            ).getTime() <=
            now
        ) {

            if (
                user.status !==
                    "expired"
            ) {

                await log(
                    "warn",
                    "Deployment expired.",
                    user.number
                );

                await updateUserStatus(
                    user.number,
                    "expired"
                );

                /*
                 * Disconnect expired session.
                 */
                if (
                    sessions.has(
                        user.number
                    )
                ) {

                    try {

                        sessions
                            .get(
                                user.number
                            )
                            .socket
                            ?.end();

                    } catch {}

                    sessions.delete(
                        user.number
                    );
                }
            }
        }
    }
}

/* =========================================================
   EXPRESS
========================================================= */

app.use(
    express.json({
        limit:
            "20mb"
    })
);

app.use(
    express.urlencoded({
        extended: true,
        limit:
            "20mb"
    })
);

app.use(
    express.static(
        PUBLIC_DIR
    )
);

/* =========================================================
   DASHBOARD
========================================================= */

app.get(
    "/",
    (req, res) => {

        res.sendFile(
            path.join(
                PUBLIC_DIR,
                "deploy.html"
            )
        );
    }
);

/* =========================================================
   HEALTH
========================================================= */

app.get(
    "/health",
    (req, res) => {

        res.json({
            success:
                true,

            service:
                "ETIAS-MINI-BOT",

            sessions:
                sessions.size,

            uptime:
                process.uptime(),

            time:
                new Date().toISOString()
        });
    }
);

/* =========================================================
   USERS API
========================================================= */

app.get(
    "/api/users",
    requireAdmin,
    async (req, res) => {

        try {

            const users =
                await getUsers();

            const safe =
                users.map(
                    user => ({
                        ...user,

                        /*
                         * Never return auth path
                         * to browser.
                         */
                        authFolder:
                            undefined,

                        connected:
                            sessions.has(
                                user.number
                            )
                    })
                );

            res.json({
                success:
                    true,

                users:
                    safe
            });

        } catch (
            error
        ) {

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
   LOGS API
========================================================= */

app.get(
    "/api/logs",
    requireAdmin,
    async (req, res) => {

        const logs =
            await readJSON(
                LOG_FILE,
                []
            );

        res.json({
            success:
                true,

            logs:
                logs.slice(
                    -150
                )
        });
    }
);

/* =========================================================
   DEPLOY API
========================================================= */

app.post(
    "/api/deploy",
    requireAdmin,
    async (req, res) => {

        try {

            const {
                number,
                duration,
                code
            } = req.body;

            const user =
                await deployUser({
                    number,
                    duration,
                    code
                });

            res.json({
                success:
                    true,

                message:
                    "User deployed and WhatsApp connection started.",

                user
            });

        } catch (
            error
        ) {

            await log(
                "error",
                error.message,
                cleanNumber(
                    req.body?.number
                )
            );

            res.status(
                400
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
   RENEW API
========================================================= */

app.post(
    "/api/renew",
    requireAdmin,
    async (req, res) => {

        try {

            const {
                number,
                duration
            } = req.body;

            const user =
                await renewUser(
                    number,
                    duration
                );

            res.json({
                success:
                    true,

                user
            });

        } catch (
            error
        ) {

            res.status(
                400
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
   DELETE API
========================================================= */

app.delete(
    "/api/users/:number",
    requireAdmin,
    async (req, res) => {

        try {

            await deleteUser(
                req.params.number
            );

            res.json({
                success:
                    true,

                message:
                    "User deleted."
            });

        } catch (
            error
        ) {

            res.status(
                400
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
   SETTINGS API
========================================================= */

app.get(
    "/api/settings/:number",
    requireAdmin,
    async (req, res) => {

        const number =
            cleanNumber(
                req.params.number
            );

        res.json({
            success:
                true,

            settings:
                await getSettings(
                    number
                )
        });
    }
);

app.post(
    "/api/settings/:number",
    requireAdmin,
    async (req, res) => {

        try {

            const number =
                cleanNumber(
                    req.params.number
                );

            const current =
                await getSettings(
                    number
                );

            await saveSettings(
                number,
                {
                    ...current,
                    ...req.body
                }
            );

            res.json({
                success:
                    true,

                settings:
                    await getSettings(
                        number
                    )
            });

        } catch (
            error
        ) {

            res.status(
                400
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
   COMMAND RELOAD
========================================================= */

app.post(
    "/api/reload-commands",
    requireAdmin,
    async (req, res) => {

        await loadCommands();

        res.json({
            success:
                true,

            commands:
                commands.size
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
                "Route not found"
        });
    }
);

/* =========================================================
   START
========================================================= */

async function start() {

    await ensureDirectories();

    await loadCommands();

    /*
     * Reconnect every saved deployment.
     */
    const users =
        await getUsers();

    console.log(
        `[BOOT] ${users.length} saved users`
    );

    for (
        const user
        of users
    ) {

        if (
            user.expiresAt &&
            Date.now() >
                new Date(
                    user.expiresAt
                ).getTime()
        ) {

            await updateUserStatus(
                user.number,
                "expired"
            );

            continue;
        }

        try {

            await connectSession(
                user
            );

        } catch (
            error
        ) {

            await log(
                "error",
                `Startup connection failed: ${error.message}`,
                user.number
            );
        }

        /*
         * Small delay between sessions.
         */
        await new Promise(
            resolve =>
                setTimeout(
                    resolve,
                    1500
                )
        );
    }

    app.listen(
        PORT,
        "0.0.0.0",
        () => {

            console.log(
                "========================================"
            );

            console.log(
                "🤖 ETIAS-MINI-BOT"
            );

            console.log(
                "🚀 MULTI-SESSION SERVER ONLINE"
            );

            console.log(
                `🌐 Port: ${PORT}`
            );

            console.log(
                `📦 Commands: ${commands.size}`
            );

            console.log(
                `👥 Sessions: ${sessions.size}`
            );

            console.log(
                "========================================"
            );
        }
    );
}

/* =========================================================
   PERIODIC EXPIRY
========================================================= */

setInterval(
    () => {

        checkExpiry()
            .catch(
                console.error
            );

    },
    60 * 1000
);

/* =========================================================
   START
========================================================= */

start().catch(
    error => {

        console.error(
            "[FATAL]",
            error
        );

        process.exit(
            1
        );
    }
);

/* =========================================================
   SHUTDOWN
========================================================= */

async function shutdown() {

    console.log(
        "[SHUTDOWN] Closing sessions..."
    );

    for (
        const [
            number,
            session
        ]
        of sessions.entries()
    ) {

        try {

            session.socket?.end();

        } catch {}

        console.log(
            `[SHUTDOWN] ${number}`
        );
    }

    sessions.clear();

    process.exit(
        0
    );
}

process.on(
    "SIGINT",
    shutdown
);

process.on(
    "SIGTERM",
    shutdown
);
