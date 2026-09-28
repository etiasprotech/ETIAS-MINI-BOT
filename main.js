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

/* =========================================================
   ERROR HANDLING
========================================================= */

process.on("uncaughtException", (err) => {
  const message = err?.message || "";

  if (
    message.includes("Session") ||
    message.includes("MAC") ||
    message.includes("Bad MAC") ||
    message.includes("decrypt") ||
    message.includes("Connection Closed") ||
    message.includes("Precondition")
  ) {
    return;
  }

  console.error("[UNCAUGHT EXCEPTION]", err);
});

process.on("unhandledRejection", (err) => {
  const message = err?.message || "";

  if (
    message.includes("Session") ||
    message.includes("MAC") ||
    message.includes("Bad MAC")
  ) {
    return;
  }

  console.error("[UNHANDLED REJECTION]", err);
});

/* =========================================================
   CONFIG
========================================================= */

const BOT_NAME = "ETIAS-MINI-BOT";
const PREFIX = ".";

const OWNER_NUMBER = (
  process.env.OWNER_NUMBER || "263778810589"
).replace(/[^0-9]/g, "");

const ADMIN_KEY = process.env.ADMIN_KEY || OWNER_NUMBER;

const MONGODB_URI =
  process.env.MONGODB_URI ||
  process.env.MONGO_URL;

const PAIRING_SITE =
  "https://etias-mini-bot-pair.onrender.com/";

const DEFAULT_EXPIRE_DAYS =
  parseInt(process.env.EXPIRE_DAYS) || 30;

/* =========================================================
   PATHS
========================================================= */

const dataPath = path.join(__dirname, "data");
const authBasePath = path.join(__dirname, "auth");
const usersPath = path.join(authBasePath, "users");

[dataPath, authBasePath, usersPath].forEach((p) => {
  if (!fs.existsSync(p)) {
    fs.mkdirSync(p, { recursive: true });
  }
});

/* =========================================================
   BOT MODE
========================================================= */

let botMode = process.env.MODE || "public";

try {
  const modeFile = path.join(dataPath, "mode.json");

  if (fs.existsSync(modeFile)) {
    const modeData = JSON.parse(
      fs.readFileSync(modeFile, "utf8")
    );

    botMode = modeData.mode || botMode;
  }
} catch (e) {
  console.log("[MODE] Using default mode");
}

global.botMode = botMode;

/* =========================================================
   MONGODB
========================================================= */

const sessionSchema = new mongoose.Schema({
  userId: {
    type: String,
    unique: true
  },

  sessionId: String,

  phone: String,

  connected: {
    type: Boolean,
    default: true
  },

  createdAt: {
    type: Date,
    default: Date.now
  },

  expireAt: {
    type: Date,
    default: () =>
      new Date(
        Date.now() +
        DEFAULT_EXPIRE_DAYS * 86400000
      )
  },

  days: {
    type: Number,
    default: DEFAULT_EXPIRE_DAYS
  }
});

sessionSchema.index(
  { expireAt: 1 },
  { expireAfterSeconds: 0 }
);

const SessionModel =
  mongoose.models.Session ||
  mongoose.model("Session", sessionSchema);

async function connectMongo() {
  if (!MONGODB_URI) {
    console.log("[MONGO] No MongoDB URI configured");
    return false;
  }

  try {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(MONGODB_URI);
    }

    console.log("[MONGO] ✅ Connected");

    return true;
  } catch (e) {
    console.log("[MONGO] ❌", e.message);
    return false;
  }
}

async function saveToMongo(
  userId,
  sessionId,
  days = DEFAULT_EXPIRE_DAYS
) {
  if (mongoose.connection.readyState !== 1) {
    return;
  }

  const expireAt = new Date(
    Date.now() + days * 86400000
  );

  try {
    await SessionModel.findOneAndUpdate(
      { userId },
      {
        sessionId,
        phone: userId,
        connected: true,
        expireAt,
        days
      },
      {
        upsert: true,
        new: true
      }
    );

    console.log(
      `[MONGO] Saved ${userId} - ${days} days`
    );
  } catch (e) {
    console.log(
      "[MONGO SAVE ERROR]",
      e.message
    );
  }
}

async function getFromMongo() {
  if (mongoose.connection.readyState !== 1) {
    return null;
  }

  try {
    const all = await SessionModel.find({});
    const obj = {};

    all.forEach((s) => {
      if (
        new Date(s.expireAt) >
        new Date()
      ) {
        obj[s.userId] = s.sessionId;
      }
    });

    return obj;
  } catch (e) {
    console.log(
      "[MONGO LOAD ERROR]",
      e.message
    );

    return {};
  }
}

/* =========================================================
   COMMAND LOADER
========================================================= */

const commands = new Map();

const cmdPath = path.join(
  __dirname,
  "commands"
);

if (fs.existsSync(cmdPath)) {
  const files = fs
    .readdirSync(cmdPath)
    .filter((f) => f.endsWith(".js"));

  for (const file of files) {
    try {
      const fullPath = path.join(
        cmdPath,
        file
      );

      delete require.cache[
        require.resolve(fullPath)
      ];

      const cmd = require(fullPath);

      const name = (
        cmd.name ||
        file.replace(".js", "")
      ).toLowerCase();

      commands.set(name, cmd);

      if (Array.isArray(cmd.aliases)) {
        cmd.aliases.forEach((alias) => {
          commands.set(
            alias.toLowerCase(),
            cmd
          );
        });
      }

      console.log(
        `[COMMAND] Loaded .${name}`
      );
    } catch (e) {
      console.log(
        `[COMMAND ERROR] ${file}:`,
        e.message
      );
    }
  }
}

console.log(
  `[COMMANDS] ${commands.size} commands loaded`
);

/* =========================================================
   JSON DATABASE
========================================================= */

function getDB(file, def = {}) {
  const filePath = path.join(
    dataPath,
    file
  );

  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(
      filePath,
      JSON.stringify(def, null, 2)
    );
  }

  try {
    return JSON.parse(
      fs.readFileSync(filePath, "utf8")
    );
  } catch (e) {
    return def;
  }
}

function saveDB(file, data) {
  fs.writeFileSync(
    path.join(dataPath, file),
    JSON.stringify(data, null, 2)
  );
}

function getMultiDB() {
  return getDB(
    "multi_sessions.json",
    {}
  );
}

function saveMultiSession(
  userId,
  sessionId,
  days = DEFAULT_EXPIRE_DAYS
) {
  const db = getMultiDB();

  db[userId] = sessionId;

  saveDB(
    "multi_sessions.json",
    db
  );

  saveToMongo(
    userId,
    sessionId,
    days
  );
}

/* =========================================================
   SESSION HELPERS
========================================================= */

function initSessionFromString(
  sid,
  destPath
) {
  if (!sid) return false;

  try {
    const credsPath = path.join(
      destPath,
      "creds.json"
    );

    if (
      fs.existsSync(credsPath) &&
      fs.statSync(credsPath).size > 500
    ) {
      return true;
    }

    let session = sid
      .trim()
      .replace(/\s/g, "");

    if (session.includes("~")) {
      session =
        session.split("~").pop();
    }

    const decoded = Buffer.from(
      session,
      "base64"
    ).toString("utf8");

    if (!decoded.startsWith("{")) {
      return false;
    }

    if (!fs.existsSync(destPath)) {
      fs.mkdirSync(destPath, {
        recursive: true
      });
    }

    fs.writeFileSync(
      credsPath,
      decoded
    );

    return true;
  } catch (e) {
    console.log(
      "[SESSION INIT ERROR]",
      e.message
    );

    return false;
  }
}

function askNumber() {
  const rl =
    readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

  return new Promise((resolve) => {
    rl.question(
      "📱 Number: ",
      (answer) => {
        rl.close();

        resolve(
          answer.trim() ||
          OWNER_NUMBER
        );
      }
    );
  });
}

/* =========================================================
   GLOBAL BOT STATE
========================================================= */

const msgCache = new Map();

const activeBots = new Map();

const alreadySent = new Set();

const startingBots = new Set();

/* =========================================================
   SEND SESSION ONCE
========================================================= */

async function sendSessionDM(
  sock,
  authPath
) {
  try {
    const myNumber =
      sock.user?.id
        ?.split(":")[0]
        ?.replace(/[^0-9]/g, "");

    if (!myNumber) return;

    if (alreadySent.has(myNumber)) {
      return;
    }

    const lockFile = path.join(
      dataPath,
      `sent_${myNumber}.lock`
    );

    if (
      fs.existsSync(lockFile) &&
      Date.now() -
        fs.statSync(lockFile).mtimeMs <
        12 * 60 * 60 * 1000
    ) {
      alreadySent.add(myNumber);
      return;
    }

    await new Promise((resolve) =>
      setTimeout(resolve, 12000)
    );

    const credsPath = path.join(
      authPath,
      "creds.json"
    );

    if (!fs.existsSync(credsPath)) {
      return;
    }

    const creds =
      fs.readFileSync(
        credsPath,
        "utf8"
      );

    const full =
      `ETIAS-MINI-BOT~${Buffer.from(
        creds
      ).toString("base64")}`;

    const userMsg =
      `✅ *${BOT_NAME} CONNECTED!*\n\n` +
      `📱 Number: ${myNumber}\n` +
      `⏰ Package: ${DEFAULT_EXPIRE_DAYS} days\n\n` +
      `🔑 *YOUR SESSION ID:*\n` +
      `${full}\n\n` +
      `👉 *NEXT STEP:*\n` +
      `Copy this entire Session and send it to Owner:\n\n` +
      `wa.me/${OWNER_NUMBER}?text=Hi%20Owner%20here%20is%20my%20session:%20${encodeURIComponent(
        full
      )}\n\n` +
      `Owner will deploy it and your bot will be online 24/7.`;

    await sock.sendMessage(
      sock.user.id,
      {
        text: userMsg
      }
    );

    fs.writeFileSync(
      lockFile,
      "sent"
    );

    alreadySent.add(myNumber);

    console.log(
      `[SESSION SENT] ${myNumber}`
    );
  } catch (e) {
    console.log(
      "[SESSION DM ERROR]",
      e.message
    );
  }
}

/* =========================================================
   START BOT FOR USER
========================================================= */

async function startBotForUser(
  userId,
  sessionString = null,
  days = DEFAULT_EXPIRE_DAYS
) {
  if (startingBots.has(userId)) {
    console.log(
      `[BOT] ${userId} is already starting`
    );

    return;
  }

  startingBots.add(userId);

  try {
    const isMain =
      userId === "main";

    const authPath = isMain
      ? authBasePath
      : path.join(
          usersPath,
          userId
        );

    if (sessionString) {
      initSessionFromString(
        sessionString,
        authPath
      );
    } else if (isMain) {
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

    const sock =
      makeWASocket({
        auth: state,

        logger: P({
          level: "silent"
        }),

        printQRInTerminal: false,

        browser: [
          "Ubuntu",
          "Chrome",
          "20.0.04"
        ],

        markOnlineOnConnect: false,

        syncFullHistory: false,

        shouldSyncHistoryMessage: () =>
          false,

        getMessage: async () =>
          undefined
      });

    sock.ev.on(
      "creds.update",
      saveCreds
    );

    /* =====================================================
       PAIRING
    ===================================================== */

    if (
      !sock.authState.creds.registered &&
      isMain
    ) {
      let number = (
        process.env.PAIR_NUMBER ||
        OWNER_NUMBER
      ).replace(/[^0-9]/g, "");

      if (
        !process.env.PORT &&
        process.stdin.isTTY
      ) {
        try {
          number = (
            await askNumber()
          ).replace(
            /[^0-9]/g,
            ""
          );
        } catch {}
      }

      await new Promise(
        (resolve) =>
          setTimeout(
            resolve,
            2000
          )
      );

      if (
        !sock.authState.creds.registered
      ) {
        try {
          const code =
            await sock.requestPairingCode(
              number
            );

          console.log(
            `\nPAIR CODE ${number}: ${
              code
                .match(/.{1,4}/g)
                .join("-")
            }\n`
          );
        } catch (e) {
          console.log(
            "[PAIRING ERROR]",
            e.message
          );
        }
      }
    }

    /* =====================================================
       CONNECTION UPDATE
    ===================================================== */

    sock.ev.on(
      "connection.update",
      async ({
        connection,
        lastDisconnect
      }) => {
        if (connection === "open") {
          const botNumber =
            sock.user?.id
              ?.split(":")[0]
              ?.replace(
                /[^0-9]/g,
                "");

          console.log(
            `\n[CONNECTED] ${userId}`
          );

          console.log(
            `[BOT NUMBER] ${botNumber}`
          );

          console.log(
            `[OWNER NUMBER] ${OWNER_NUMBER}`
          );

          console.log(
            `[MODE] ${global.botMode}`
          );

          activeBots.set(
            userId,
            sock
          );

          startingBots.delete(
            userId
          );

          try {
            const creds =
              fs.readFileSync(
                path.join(
                  authPath,
                  "creds.json"
                ),
                "utf8"
              );

            const full =
              `ETIAS-MINI-BOT~${Buffer.from(
                creds
              ).toString(
                "base64"
              )}`;

            const saveId =
              botNumber;

            if (saveId) {
              saveMultiSession(
                saveId,
                full,
                days
              );

              if (
                !alreadySent.has(
                  saveId
                )
              ) {
                sendSessionDM(
                  sock,
                  authPath
                );
              }
            }
          } catch (e) {
            console.log(
              "[SESSION SAVE ERROR]",
              e.message
            );
          }

          return;
        }

        if (connection === "close") {
          activeBots.delete(
            userId
          );

          startingBots.delete(
            userId
          );

          const code =
            lastDisconnect
              ?.error
              ?.output
              ?.statusCode;

          console.log(
            `[DISCONNECTED] ${userId} code=${code}`
          );

          if (
            code !==
            DisconnectReason.loggedOut
          ) {
            console.log(
              `[RECONNECT] ${userId} in 5 seconds...`
            );

            setTimeout(
              () =>
                startBotForUser(
                  userId,
                  null,
                  days
                ),
              5000
            );
          } else {
            console.log(
              `[LOGGED OUT] ${userId}`
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

            if (!isMain) {
              const db =
                getMultiDB();

              delete db[userId];

              saveDB(
                "multi_sessions.json",
                db
              );

              if (
                mongoose.connection
                  .readyState === 1
              ) {
                try {
                  await SessionModel.deleteOne(
                    {
                      userId
                    }
                  );
                } catch {}
              }

              activeBots.delete(
                userId
              );
            }
          }
        }
      }
    );

    /* =====================================================
       GROUP PARTICIPANTS
    ===================================================== */

    sock.ev.on(
      "group-participants.update",
      async (update) => {
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
          for (const p of update.participants) {
            if (
              update.action === "add" &&
              welcomeDB[
                update.id
              ]?.enabled
            ) {
              const txt = (
                welcomeDB[
                  update.id
                ].msg ||
                `Welcome @${p.split("@")[0]}`
              ).replace(
                /@user/g,
                `@${p.split("@")[0]}`
              );

              await sock.sendMessage(
                update.id,
                {
                  text: txt,
                  mentions: [p]
                }
              );
            }

            if (
              update.action === "remove" &&
              goodbyeDB[
                update.id
              ]?.enabled
            ) {
              const txt = (
                goodbyeDB[
                  update.id
                ].msg ||
                `Goodbye @${p.split("@")[0]}`
              ).replace(
                /@user/g,
                `@${p.split("@")[0]}`
              );

              await sock.sendMessage(
                update.id,
                {
                  text: txt,
                  mentions: [p]
                }
              );
            }
          }
        } catch (e) {
          console.log(
            "[GROUP EVENT ERROR]",
            e.message
          );
        }
      }
    );

    /* =====================================================
       MESSAGE HANDLER
    ===================================================== */

    sock.ev.on(
  "messages.upsert",
  async ({
    messages,
    type
  }) => {

    console.log(
      `[UPSERT] type=${type} count=${messages?.length || 0}`
    );

    for (const msg of messages || []) {

      console.log(
        `[UPSERT MESSAGE] jid=${msg?.key?.remoteJid} fromMe=${msg?.key?.fromMe} id=${msg?.key?.id}`
      );

      try {

        await handleMessage(
          sock,
          msg,
          authPath
        );

      } catch (e) {

        console.log(
          "[MESSAGE ERROR]",
          e.message
        );

      }
    }
  }
);

  } catch (e) {
    startingBots.delete(
      userId
    );

    console.log(
      `[START BOT ERROR] ${userId}:`,
      e.message
    );

    setTimeout(
      () =>
        startBotForUser(
          userId,
          null,
          days
        ),
      5000
    );
  }
}

/* =========================================================
   MESSAGE HANDLER
========================================================= */

async function handleMessage(
  sock,
  msg,
  authPath
) {
  if (!msg) return;

  if (!msg.message) {
    return;
  }

  const jid =
    msg.key?.remoteJid;

  if (!jid) return;

  if (
    jid === "status@broadcast"
  ) {
    return;
  }

  /*
   * IMPORTANT SELF-CHAT FIX
   */

  const sender =
    msg.key.participant ||
    msg.key.remoteJid;

  const senderNum =
    sender
      ?.split("@")[0]
      ?.replace(
        /[^0-9]/g,
        ""
      ) || "";

  const botNumber =
    sock.user?.id
      ?.split(":")[0]
      ?.replace(
        /[^0-9]/g,
        ""
      ) || "";

  const isFromBot =
    msg.key.fromMe === true;

  const isOwner =
    senderNum === OWNER_NUMBER ||
    senderNum === botNumber ||
    isFromBot;

  const isSelfChat =
    senderNum === botNumber ||
    isFromBot;

  /*
   * DEBUG
   */

  console.log(
    `[MESSAGE] jid=${jid} fromMe=${isFromBot} sender=${senderNum} bot=${botNumber} owner=${isOwner}`
  );

  /* =======================================================
     CACHE MESSAGE
  ======================================================= */

  if (
    !msg.message.protocolMessage
  ) {
    const type =
      Object.keys(
        msg.message
      )[0];

    if (
      [
        "conversation",
        "extendedTextMessage",
        "imageMessage",
        "videoMessage"
      ].includes(type)
    ) {
      const messageText =
        msg.message
          .conversation ||
        msg.message
          .extendedTextMessage
          ?.text ||
        msg.message
          .imageMessage
          ?.caption ||
        msg.message
          .videoMessage
          ?.caption ||
        `[${type}]`;

      msgCache.set(
        msg.key.id,
        {
          jid,
          sender,
          text: messageText,
          message:
            msg.message,
          time: new Date()
        }
      );
    }
  }

  /* =======================================================
     ANTI DELETE
  ======================================================= */

  if (
    msg.message.protocolMessage
      ?.type === 0
  ) {
    const adDB =
      getDB(
        "antidelete.json",
        {}
      );

    if (
      adDB[jid]?.enabled ||
      adDB.global?.enabled
    ) {
      const deletedKey =
        msg.message
          .protocolMessage
          .key;

      const cached =
        msgCache.get(
          deletedKey.id
        );

      if (cached) {
        try {
          await sock.sendMessage(
            jid,
            {
              text:
                `*ANTI-DELETE*\n\n` +
                `👤 @${cached.sender.split("@")[0]}\n` +
                `📝 ${cached.text}`,
              mentions: [
                cached.sender
              ]
            }
          );
        } catch {}
      }
    }

    return;
  }

  if (
    msg.message.protocolMessage
  ) {
    return;
  }

  /* =======================================================
     VIEW ONCE
  ======================================================= */

  const viewOnce =
    msg.message
      .viewOnceMessageV2
      ?.message ||
    msg.message
      .viewOnceMessage
      ?.message;

  if (
    viewOnce &&
    !isFromBot
  ) {
    const vvDB =
      getDB(
        "antiviewonce.json",
        {}
      );

    if (
      vvDB[jid]?.enabled ||
      vvDB.global?.enabled
    ) {
      try {
        const type =
          Object.keys(
            viewOnce
          )[0];

        const media =
          viewOnce[type];

        let buffer =
          Buffer.alloc(0);

        const stream =
          await downloadContentFromMessage(
            media,
            type.replace(
              "Message",
              ""
            )
          );

        for await (
          const chunk of stream
        ) {
          buffer = Buffer.concat([
            buffer,
            chunk
          ]);
        }

        if (
          buffer.length
        ) {
          if (
            type ===
            "imageMessage"
          ) {
            await sock.sendMessage(
              jid,
              {
                image: buffer,
                caption:
                  `*VIEWONCE* @${sender.split("@")[0]}`,
                mentions: [
                  sender
                ]
              },
              {
                quoted: msg
              }
            );
          }

          if (
            type ===
            "videoMessage"
          ) {
            await sock.sendMessage(
              jid,
              {
                video: buffer,
                caption:
                  "*VIEWONCE*"
              },
              {
                quoted: msg
              }
            );
          }
        }
      } catch (e) {
        console.log(
          "[VIEWONCE ERROR]",
          e.message
        );
      }
    }
  }

  /* =======================================================
     EXTRACT TEXT
  ======================================================= */

  let text =
    msg.message
      .conversation ||
    msg.message
      .extendedTextMessage
      ?.text ||
    msg.message
      .imageMessage
      ?.caption ||
    msg.message
      .videoMessage
      ?.caption ||
    "";

  if (!text) {
    return;
  }

  text = text.trim();

  console.log(
    `[TEXT] ${isSelfChat ? "(SELF)" : ""} "${text}"`
  );

  /* =======================================================
     ANTILINK
  ======================================================= */

  const isGroup =
    jid.endsWith("@g.us");

  if (
    isGroup &&
    !text.startsWith(PREFIX) &&
    !isFromBot
  ) {
    const db =
      getDB(
        "antilink.json",
        {}
      );

    if (
      db[jid]?.enabled &&
      /(https?:\/\/|chat\.whatsapp\.com)/i.test(
        text
      )
    ) {
      try {
        const meta =
          await sock.groupMetadata(
            jid
          );

        const participant =
          meta.participants.find(
            (p) =>
              p.id === sender
          );

        const isAdmin =
          participant?.admin;

        const botId =
          `${botNumber}@s.whatsapp.net`;

        const botParticipant =
          meta.participants.find(
            (p) =>
              p.id === botId ||
              p.id ===
                sock.user?.id
          );

        const isBotAdmin =
          botParticipant?.admin;

        if (
          !isAdmin &&
          !isOwner &&
          isBotAdmin
        ) {
          await sock.sendMessage(
            jid,
            {
              delete: msg.key
            }
          );
        }
      } catch {}
    }
  }

  /* =======================================================
     SESSION MESSAGE
  ======================================================= */

  if (
    isOwner &&
    text.includes(
      "ETIAS-MINI-BOT~"
    ) &&
    text.length > 100 &&
    !text.startsWith(PREFIX) &&
    !isFromBot
  ) {
    const match =
      text.match(
        /ETIAS-MINI-BOT~[A-Za-z0-9+/=]+/
      );

    if (match) {
      const sid =
        match[0];

      try {
        const b64 =
          sid
            .split("~")
            .pop();

        const sessionJSON =
          JSON.parse(
            Buffer.from(
              b64,
              "base64"
            ).toString()
          );

        const uid =
          sessionJSON.me
            ?.id
            ?.split(":")[0] ||
          senderNum;

        await sock.sendMessage(
          jid,
          {
            text:
              `🔍 Session from ${uid}\n\n` +
              `Go to deploy panel:\n` +
              `/admin?key=${ADMIN_KEY}\n\n` +
              `Or type:\n` +
              `.addbot ${sid} ${uid} ${DEFAULT_EXPIRE_DAYS}`
          },
          {
            quoted: msg
          }
        );
      } catch (e) {
        console.log(
          "[SESSION PARSE ERROR]",
          e.message
        );
      }
    }

    return;
  }

  /* =======================================================
     COMMAND CHECK
  ======================================================= */

  if (
    !text.startsWith(PREFIX)
  ) {
    return;
  }

  const commandText =
    text.slice(
      PREFIX.length
    ).trim();

  if (!commandText) {
    return;
  }

  const parts =
    commandText.split(
      /\s+/
    );

  const cmdName =
    parts
      .shift()
      .toLowerCase();

  const args = parts;

  console.log(
    `[COMMAND] .${cmdName} args=${JSON.stringify(args)} self=${isSelfChat}`
  );

  /* =======================================================
     WELCOME
  ======================================================= */

  if (
    cmdName === "welcome" &&
    isGroup
  ) {
    const db =
      getDB(
        "welcome.json",
        {}
      );

    if (
      args[0] === "on"
    ) {
      db[jid] = {
        enabled: true,
        msg:
          args
            .slice(1)
            .join(" ") ||
          null
      };

      saveDB(
        "welcome.json",
        db
      );

      return await sock.sendMessage(
        jid,
        {
          text:
            "✅ Welcome ON"
        },
        {
          quoted: msg
        }
      );
    }

    if (
      args[0] === "off"
    ) {
      delete db[jid];

      saveDB(
        "welcome.json",
        db
      );

      return await sock.sendMessage(
        jid,
        {
          text:
            "❌ Welcome OFF"
        },
        {
          quoted: msg
        }
      );
    }
  }

  /* =======================================================
     GOODBYE
  ======================================================= */

  if (
    cmdName === "goodbye" &&
    isGroup
  ) {
    const db =
      getDB(
        "goodbye.json",
        {}
      );

    if (
      args[0] === "on"
    ) {
      db[jid] = {
        enabled: true
      };

      saveDB(
        "goodbye.json",
        db
      );

      return await sock.sendMessage(
        jid,
        {
          text:
            "✅ Goodbye ON"
        },
        {
          quoted: msg
        }
      );
    }

    if (
      args[0] === "off"
    ) {
      delete db[jid];

      saveDB(
        "goodbye.json",
        db
      );

      return await sock.sendMessage(
        jid,
        {
          text:
            "❌ Goodbye OFF"
        },
        {
          quoted: msg
        }
      );
    }
  }

  /* =======================================================
     ANTILINK
  ======================================================= */

  if (
    cmdName === "antilink" &&
    isGroup
  ) {
    const db =
      getDB(
        "antilink.json",
        {}
      );

    if (
      args[0] === "on"
    ) {
      db[jid] = {
        enabled: true
      };

      saveDB(
        "antilink.json",
        db
      );

      return await sock.sendMessage(
        jid,
        {
          text:
            "✅ AntiLink ON"
        },
        {
          quoted: msg
        }
      );
    }

    if (
      args[0] === "off"
    ) {
      delete db[jid];

      saveDB(
        "antilink.json",
        db
      );

      return await sock.sendMessage(
        jid,
        {
          text:
            "❌ AntiLink OFF"
        },
        {
          quoted: msg
        }
      );
    }
  }

  /* =======================================================
     ANTIDELETE
  ======================================================= */

  if (
    cmdName ===
    "antidelete"
  ) {
    const db =
      getDB(
        "antidelete.json",
        {}
      );

    if (
      args[0] === "on"
    ) {
      db[jid] = {
        enabled: true
      };

      saveDB(
        "antidelete.json",
        db
      );

      return await sock.sendMessage(
        jid,
        {
          text:
            "✅ AntiDelete ON"
        },
        {
          quoted: msg
        }
      );
    }

    if (
      args[0] === "off"
    ) {
      delete db[jid];

      saveDB(
        "antidelete.json",
        db
      );

      return await sock.sendMessage(
        jid,
        {
          text:
            "❌ AntiDelete OFF"
        },
        {
          quoted: msg
        }
      );
    }
  }

  /* =======================================================
     ANTIVIEWONCE
  ======================================================= */

  if (
    cmdName ===
      "antiviewonce" ||
    cmdName === "viewonce"
  ) {
    const db =
      getDB(
        "antiviewonce.json",
        {}
      );

    if (
      args[0] === "on"
    ) {
      db[jid] = {
        enabled: true
      };

      saveDB(
        "antiviewonce.json",
        db
      );

      return await sock.sendMessage(
        jid,
        {
          text:
            "✅ AntiViewOnce ON"
        },
        {
          quoted: msg
        }
      );
    }

    if (
      args[0] === "off"
    ) {
      delete db[jid];

      saveDB(
        "antiviewonce.json",
        db
      );

      return await sock.sendMessage(
        jid,
        {
          text:
            "❌ AntiViewOnce OFF"
        },
        {
          quoted: msg
        }
      );
    }
  }

  /* =======================================================
     MODE
  ======================================================= */

  if (
    cmdName === "mode"
  ) {
    if (!isOwner) {
      return;
    }

    const newMode =
      args[0] || "public";

    if (
      !["public", "private"].includes(
        newMode
      )
    ) {
      return await sock.sendMessage(
        jid,
        {
          text:
            "❌ Use:\n.mode public\n.mode private"
        },
        {
          quoted: msg
        }
      );
    }

    global.botMode =
      newMode;

    saveDB(
      "mode.json",
      {
        mode: newMode
      }
    );

    return await sock.sendMessage(
      jid,
      {
        text:
          `✅ Bot mode: ${newMode}`
      },
      {
        quoted: msg
      }
    );
  }

  /* =======================================================
     ADDBOT
  ======================================================= */

  if (
    cmdName === "addbot" &&
    isOwner
  ) {
    const sid =
      args[0];

    const num =
      (
        args[1] || ""
      ).replace(
        /[^0-9]/g,
        ""
      );

    const d =
      parseInt(
        args[2]
      ) ||
      DEFAULT_EXPIRE_DAYS;

    if (!sid) {
      return await sock.sendMessage(
        jid,
        {
          text:
            "Usage:\n.addbot ETIAS-MINI-BOT~xxx number days"
        },
        {
          quoted: msg
        }
      );
    }

    try {
      const b64 =
        sid
          .split("~")
          .pop();

      const sessionJSON =
        JSON.parse(
          Buffer.from(
            b64,
            "base64"
          ).toString()
        );

      const uid =
        sessionJSON.me
          ?.id
          ?.split(":")[0] ||
        num;

      saveMultiSession(
        uid,
        sid,
        d
      );

      await startBotForUser(
        uid,
        sid,
        d
      );

      return await sock.sendMessage(
        jid,
        {
          text:
            `✅ Deploying ${uid} for ${d} days\n\n` +
            `Until ${new Date(
              Date.now() +
              d * 86400000
            ).toDateString()}\n\n` +
            `Bot will be online shortly.`
        },
        {
          quoted: msg
        }
      );
    } catch (e) {
      return await sock.sendMessage(
        jid,
        {
          text:
            `❌ ${e.message}`
        },
        {
          quoted: msg
        }
      );
    }
  }

  /* =======================================================
     REMOVE BOT
  ======================================================= */

  if (
    (
      cmdName ===
        "removebot" ||
      cmdName ===
        "delbot"
    ) &&
    isOwner
  ) {
    const target =
      (
        args[0] || ""
      ).replace(
        /[^0-9]/g,
        ""
      );

    if (!target) {
      return await sock.sendMessage(
        jid,
        {
          text:
            "Usage:\n.removebot 2637xxxxxxx"
        },
        {
          quoted: msg
        }
      );
    }

    if (
      mongoose.connection
        .readyState === 1
    ) {
      await SessionModel.deleteOne(
        {
          userId:
            target
        }
      );
    }

    const db =
      getMultiDB();

    delete db[target];

    saveDB(
      "multi_sessions.json",
      db
    );

    try {
      fs.rmSync(
        path.join(
          usersPath,
          target
        ),
        {
          recursive: true,
          force: true
        }
      );

      const lock =
        path.join(
          dataPath,
          `sent_${target}.lock`
        );

      if (
        fs.existsSync(lock)
      ) {
        fs.unlinkSync(lock);
      }
    } catch {}

    activeBots.delete(
      target
    );

    alreadySent.delete(
      target
    );

    return await sock.sendMessage(
      jid,
      {
        text:
          `✅ Deleted ${target}`
      },
      {
        quoted: msg
      }
    );
  }

  /* =======================================================
     EXTEND
  ======================================================= */

  if (
    cmdName === "extend" &&
    isOwner
  ) {
    const target =
      (
        args[0] || ""
      ).replace(
        /[^0-9]/g,
        ""
      );

    const extraDays =
      parseInt(
        args[1]
      ) || 30;

    if (
      mongoose.connection
        .readyState === 1
    ) {
      const doc =
        await SessionModel.findOne(
          {
            userId:
              target
          }
        );

      if (doc) {
        const newExpire =
          new Date(
            new Date(
              doc.expireAt
            ).getTime() +
            extraDays *
              86400000
          );

        await SessionModel.updateOne(
          {
            userId:
              target
          },
          {
            expireAt:
              newExpire,
            days:
              doc.days +
              extraDays
          }
        );

        return await sock.sendMessage(
          jid,
          {
            text:
              `✅ Extended ${target} +${extraDays} days\n\n` +
              `New expiry: ${newExpire.toDateString()}`
          },
          {
            quoted: msg
          }
        );
      }
    }

    return await sock.sendMessage(
      jid,
      {
        text:
          "❌ Bot not found."
      },
      {
        quoted: msg
      }
    );
  }

  /* =======================================================
     LIST BOTS
  ======================================================= */

  if (
    (
      cmdName === "bots" ||
      cmdName ===
        "listbots"
    ) &&
    isOwner
  ) {
    if (
      mongoose.connection
        .readyState === 1
    ) {
      const all =
        await SessionModel.find(
          {}
        );

      let output =
        `*ETIAS-MINI-BOT*\n` +
        `*ACTIVE BOTS: ${all.length}*\n\n`;

      for (const bot of all) {
        const left =
          Math.ceil(
            (
              new Date(
                bot.expireAt
              ) -
              new Date()
            ) /
              86400000
          );

        output +=
          `📱 ${bot.userId}\n` +
          `⏳ ${left} days left\n` +
          `📅 ${new Date(
            bot.expireAt
          ).toDateString()}\n\n`;
      }

      return await sock.sendMessage(
        jid,
        {
          text:
            output
        },
        {
          quoted: msg
        }
      );
    }

    return await sock.sendMessage(
      jid,
      {
        text:
          "❌ MongoDB is not connected."
      },
      {
        quoted: msg
      }
    );
  }

  /* =======================================================
     SESSION
  ======================================================= */

  if (
    cmdName === "session"
  ) {
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

      return await sock.sendMessage(
        jid,
        {
          text:
            `*SESSION ID*\n\n${session}`
        },
        {
          quoted: msg
        }
      );
    } catch (e) {
      return await sock.sendMessage(
        jid,
        {
          text:
            "❌ Session unavailable."
        },
        {
          quoted: msg
        }
      );
    }
  }

  /* =======================================================
     PUBLIC / PRIVATE MODE
  ======================================================= */

  const currentMode =
    global.botMode ||
    "public";

  if (
    currentMode ===
      "private" &&
    !isOwner
  ) {
    return;
  }

  /* =======================================================
     LOAD COMMAND
  ======================================================= */

  const command =
    commands.get(
      cmdName
    );

  if (!command) {
    console.log(
      `[COMMAND NOT FOUND] .${cmdName}`
    );

    return;
  }

  /* =======================================================
     EXECUTE COMMAND
  ======================================================= */

  try {
    console.log(
      `[EXECUTING] .${cmdName} from ${isSelfChat ? "SELF" : senderNum}`
    );

    await command.execute(
      sock,
      msg,
      args,
      {
        getDB,
        saveDB,
        downloadContentFromMessage,
        isOwner,
        isGroup,
        isSelfChat,
        sender,
        senderNum,
        botNumber
      }
    );

    console.log(
      `[EXECUTED] .${cmdName}`
    );
  } catch (e) {
    console.log(
      `[COMMAND ERROR] .${cmdName}`,
      e
    );

    try {
      await sock.sendMessage(
        jid,
        {
          text:
            `❌ ${e.message}`
        },
        {
          quoted: msg
        }
      );
    } catch {}
  }
}

/* =========================================================
   START ALL BOTS
========================================================= */

async function startAll() {
  console.log(
    "\n=============================="
  );

  console.log(
    "     ETIAS-MINI-BOT"
  );

  console.log(
    "==============================\n"
  );

  const mongoOK =
    await connectMongo();

  let multiDB = {};

  if (mongoOK) {
    multiDB =
      (await getFromMongo()) ||
      {};

    console.log(
      `[MULTI] ${Object.keys(
        multiDB
      ).length} valid sessions`
    );
  } else {
    multiDB =
      getMultiDB();

    console.log(
      `[LOCAL] ${Object.keys(
        multiDB
      ).length} sessions`
    );
  }

  const ids =
    Object.keys(
      multiDB
    );

  if (
    ids.length === 0 &&
    process.env.SESSION_ID
  ) {
    await startBotForUser(
      "main",
      process.env.SESSION_ID
    );
  } else if (
    ids.length > 0
  ) {
    for (const id of ids) {
      await startBotForUser(
        id,
        multiDB[id]
      );

      await new Promise(
        (resolve) =>
          setTimeout(
            resolve,
            2000
          )
      );
    }
  } else {
    await startBotForUser(
      "main"
    );
  }
}

/* =========================================================
   EXPRESS
========================================================= */

const app =
  express();

app.use(
  express.json()
);

app.use(
  express.urlencoded({
    extended: true
  })
);

/* =========================================================
   HOME
========================================================= */

app.get(
  "/",
  async (req, res) => {
    let count = 0;

    if (
      mongoose.connection
        .readyState === 1
    ) {
      count =
        await SessionModel.countDocuments();
    } else {
      count =
        Object.keys(
          getMultiDB()
        ).length;
    }

    res.send(`
<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ETIAS MULTI</title>

<style>
body{
  background:#0a0a0a;
  color:#fff;
  font-family:sans-serif;
  text-align:center;
  padding:20px;
}

.card{
  background:#1a1a1a;
  padding:20px;
  border-radius:15px;
  max-width:500px;
  margin:auto;
}

a.btn{
  display:block;
  background:#00ff88;
  color:#000;
  padding:15px;
  border-radius:10px;
  text-decoration:none;
  font-weight:bold;
  margin:10px 0;
}
</style>

</head>

<body>

<h1>ETIAS MULTI</h1>

<div class="card">

<p>
Active:
${activeBots.size}/${count}
</p>

<a
class="btn"
href="${PAIRING_SITE}"
target="_blank">
🔗 PAIRING SITE
</a>

<a
class="btn"
href="/admin?key=${encodeURIComponent(
      ADMIN_KEY
    )}"
style="background:#fff">
🔧 DEPLOY PANEL
</a>

<a
class="btn"
href="/bots"
style="background:#333;color:#fff">
📋 JSON
</a>

</div>

</body>
</html>
`);
  }
);

/* =========================================================
   ADMIN
========================================================= */

app.get(
  "/admin",
  async (req, res) => {
    if (
      req.query.key !==
      ADMIN_KEY
    ) {
      return res
        .status(403)
        .send(
          "Forbidden"
        );
    }

    const all =
      mongoose.connection
        .readyState === 1
        ? await SessionModel.find(
            {}
          )
        : [];

    const list =
      all
        .map((bot) => {
          const daysLeft =
            Math.ceil(
              (
                new Date(
                  bot.expireAt
                ) -
                new Date()
              ) /
                86400000
            );

          return `
<tr>

<td>
${bot.userId}
</td>

<td>
${daysLeft}d
</td>

<td>
${new Date(
            bot.expireAt
          ).toDateString()}
</td>

<td>

<a
href="/admin/delete?key=${encodeURIComponent(
            ADMIN_KEY
          )}&id=${encodeURIComponent(
            bot.userId
          )}">
Delete
</a>

</td>

</tr>
`;
        })
        .join("");

    res.send(`
<!DOCTYPE html>

<html>

<head>

<meta
name="viewport"
content="width=device-width,initial-scale=1">

<title>
ETIAS DEPLOY PANEL
</title>

<style>

body{
background:#111;
color:#fff;
font-family:sans-serif;
padding:20px;
}

.card{
background:#1a1a1a;
padding:20px;
border-radius:15px;
max-width:600px;
margin:auto;
}

input,button{
width:100%;
padding:15px;
margin:8px 0;
border-radius:10px;
border:0;
box-sizing:border-box;
}

input{
background:#222;
color:#fff;
}

button{
background:#00ff88;
font-weight:bold;
cursor:pointer;
}

table{
width:100%;
border-collapse:collapse;
margin-top:20px;
}

td,th{
border:1px solid #333;
padding:8px;
font-size:12px;
}

a{
color:#00ff88;
}

</style>

</head>

<body>

<div class="card">

<h2>
🔧 DEPLOY PANEL
</h2>

<p>
Paste Session ID, choose duration,
then deploy.
</p>

<form
method="POST"
action="/admin/add?key=${encodeURIComponent(
      ADMIN_KEY
    )}">

<label>
Session ID
</label>

<input
name="session"
placeholder="ETIAS-MINI-BOT~xxxx"
required>

<label>
Phone Number
</label>

<input
name="phone"
placeholder="2637xxxxxx">

<label>
Duration
</label>

<input
name="days"
type="number"
value="${DEFAULT_EXPIRE_DAYS}"
required>

<button
type="submit">
🚀 DEPLOY BOT
</button>

</form>

<h3>
Bots (${all.length})
</h3>

<table>

<tr>
<th>Number</th>
<th>Left</th>
<th>Expiry</th>
<th>Action</th>
</tr>

${list ||
      `<tr>
<td colspan="4">
No bots
</td>
</tr>`}

</table>

<br>

<a href="/">
Home
</a>

</div>

</body>

</html>
`);
  }
);

/* =========================================================
   ADMIN ADD
========================================================= */

app.post(
  "/admin/add",
  async (req, res) => {
    if (
      req.query.key !==
      ADMIN_KEY
    ) {
      return res
        .status(403)
        .send(
          "Forbidden"
        );
    }

    const sid =
      (
        req.body.session ||
        ""
      ).trim();

    const days =
      parseInt(
        req.body.days
      ) ||
      DEFAULT_EXPIRE_DAYS;

    const phone =
      (
        req.body.phone ||
        ""
      ).replace(
        /[^0-9]/g,
        ""
      );

    if (!sid) {
      return res.send(
        "No session"
      );
    }

    try {
      const b64 =
        sid.includes("~")
          ? sid
              .split("~")
              .pop()
          : sid;

      const sessionJSON =
        JSON.parse(
          Buffer.from(
            b64,
            "base64"
          ).toString()
        );

      const userId =
        sessionJSON.me
          ?.id
          ?.split(":")[0] ||
        phone ||
        `user_${Date.now()}`;

      saveMultiSession(
        userId,
        sid,
        days
      );

      await startBotForUser(
        userId,
        sid,
        days
      );

      res.send(`
<!DOCTYPE html>

<html>

<body
style="
background:#111;
color:#fff;
text-align:center;
padding:50px;
font-family:sans-serif;
">

<h1>
✅ Deployed ${userId}
</h1>

<p>
Duration: ${days} days
</p>

<p>
Until:
${new Date(
        Date.now() +
          days *
            86400000
      ).toDateString()}
</p>

<p>
Bot is starting...
</p>

<a
href="/admin?key=${encodeURIComponent(
        ADMIN_KEY
      )}"
style="color:#00ff88">
Back to Panel
</a>

</body>
</html>
`);
    } catch (e) {
      res.send(
        `❌ Invalid session: ${e.message}<br><br>` +
          `<a href="/admin?key=${encodeURIComponent(
            ADMIN_KEY
          )}">Back</a>`
      );
    }
  }
);

/* =========================================================
   ADMIN DELETE
========================================================= */

app.get(
  "/admin/delete",
  async (req, res) => {
    if (
      req.query.key !==
      ADMIN_KEY
    ) {
      return res
        .status(403)
        .send(
          "Forbidden"
        );
    }

    const id =
      (
        req.query.id ||
        ""
      ).replace(
        /[^0-9]/g,
        ""
      );

    if (
      mongoose.connection
        .readyState === 1
    ) {
      await SessionModel.deleteOne(
        {
          userId: id
        }
      );
    }

    const db =
      getMultiDB();

    delete db[id];

    saveDB(
      "multi_sessions.json",
      db
    );

    try {
      fs.rmSync(
        path.join(
          usersPath,
          id
        ),
        {
          recursive: true,
          force: true
        }
      );

      const lockFile =
        path.join(
          dataPath,
          `sent_${id}.lock`
        );

      if (
        fs.existsSync(
          lockFile
        )
      ) {
        fs.unlinkSync(
          lockFile
        );
      }
    } catch {}

    activeBots.delete(
      id
    );

    alreadySent.delete(
      id
    );

    res.redirect(
      `/admin?key=${encodeURIComponent(
        ADMIN_KEY
      )}`
    );
  }
);

/* =========================================================
   ADD BOT VIA URL
========================================================= */

app.get(
  "/add",
  async (req, res) => {
    const sid =
      req.query.session;

    const days =
      parseInt(
        req.query.days
      ) ||
      DEFAULT_EXPIRE_DAYS;

    if (!sid) {
      return res.send(
        `Use ${PAIRING_SITE}`
      );
    }

    try {
      const b64 =
        sid.includes("~")
          ? sid
              .split("~")
              .pop()
          : sid;

      const sessionJSON =
        JSON.parse(
          Buffer.from(
            b64,
            "base64"
          ).toString()
        );

      const userId =
        sessionJSON.me
          ?.id
          ?.split(":")[0] ||
        `user_${Date.now()}`;

      saveMultiSession(
        userId,
        sid,
        days
      );

      await startBotForUser(
        userId,
        sid,
        days
      );

      res.send(
        `✅ Added ${userId} for ${days} days`
      );
    } catch (e) {
      res.send(
        `❌ ${e.message}`
      );
    }
  }
);

/* =========================================================
   BOTS API
========================================================= */

app.get(
  "/bots",
  async (req, res) => {
    if (
      mongoose.connection
        .readyState === 1
    ) {
      const all =
        await SessionModel.find(
          {}
        );

      return res.json(
        all.map((s) => ({
          userId:
            s.userId,

          daysLeft:
            Math.ceil(
              (
                new Date(
                  s.expireAt
                ) -
                new Date()
              ) /
                86400000
            ),

          expireAt:
            s.expireAt,

          connected:
            activeBots.has(
              s.userId
            )
        }))
      );
    }

    res.json(
      getMultiDB()
    );
  }
);

/* =========================================================
   SERVER
========================================================= */

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

/* =========================================================
   START
========================================================= */

startAll();
