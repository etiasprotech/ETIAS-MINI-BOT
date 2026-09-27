const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const fs = require('fs');
const path = require('path');
const P = require('pino');

// ===== WEB SERVER FOR HOSTING (Render/Panel) =====
try {
  require('./server.js');
} catch {
  const express = require('express');
  const app = express();
  app.get('/', (req, res) => res.send('ETIAS-AI IS ONLINE 🤖 - POWERED BY ETIAS-TECH'));
  app.listen(process.env.PORT || 3000, () => console.log('[SERVER] Web server running on port 3000'));
}

const BOT_NAME = "*ETIAS-AI*";
const BOT_IMAGE_PATH = path.join(__dirname, 'media/bot.jpg');
const PREFIX = ".";
const OWNER_NUMBER = "263778810589";
const OWNER = `${OWNER_NUMBER}@s.whatsapp.net`;

const commands = new Map();
const cmdPath = path.join(__dirname, 'commands');
const dataPath = path.join(__dirname, 'data');

// Ensure data folder
if (!fs.existsSync(dataPath)) fs.mkdirSync(dataPath, { recursive: true });

// Load commands
if (fs.existsSync(cmdPath)) {
  fs.readdirSync(cmdPath).forEach(file => {
    if (file.endsWith('.js')) {
      try {
        const cmd = require(path.join(cmdPath, file));
        const name = (cmd.name || file.replace('.js','')).toLowerCase();
        commands.set(name, cmd);
        if (cmd.aliases) {
          cmd.aliases.forEach(a => commands.set(a.toLowerCase(), cmd));
        }
      } catch(e){
        console.log(`[CMD LOAD ERROR] ${file}: ${e.message}`);
      }
    }
  });
  console.log(`[COMMANDS] Loaded ${commands.size}: ${[...new Set([...commands.keys()])].join(', ')}`);
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth');

  const sock = makeWASocket({
    auth: state,
    logger: P({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ["Ubuntu", "Chrome", "20.0.04"],
    syncFullHistory: false,
    markOnlineOnConnect: true
  });

  if (!sock.authState.creds.registered) {
    await new Promise(r => setTimeout(r, 3000));
    try {
      const code = await sock.requestPairingCode(OWNER_NUMBER);
      console.log(`\n==========================`);
      console.log(`[PAIR CODE] ${code}`);
      console.log(`[BOT] ${BOT_NAME} - Go to WhatsApp > Linked Devices > Link with phone number`);
      console.log(`==========================\n`);
    } catch (e) {
      console.log("[PAIR ERROR]", e.message);
    }
  }

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode!== DisconnectReason.loggedOut;
      console.log(`[CONNECTION] Closed | Code: ${statusCode} | Reconnect: ${shouldReconnect}`);
      if (shouldReconnect) {
        setTimeout(() => startBot(), 5000);
      } else {
        console.log('[CONNECTION] Logged out! Delete auth folder and pair again.');
      }
    } else if (connection === 'open') {
      console.log(`[BOT] ${BOT_NAME} Connected! Owner: ${OWNER_NUMBER}`);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message) return;
    const jid = msg.key.remoteJid;
    const isGroup = jid.endsWith('@g.us');

    // ====== AUTO VV WITH TOGGLE CHECK ======
    const viewOnce = msg.message.viewOnceMessageV2?.message ||
                     msg.message.viewOnceMessage?.message ||
                     msg.message.viewOnceMessageV2Extension?.message;

    if (viewOnce) {
      try {
        const avvPath = path.join(dataPath, 'antivv.json');
        let enabled = true;
        if (fs.existsSync(avvPath)) {
          try { enabled = JSON.parse(fs.readFileSync(avvPath)).enabled; } catch {}
        }
        if (!enabled) return;

        console.log(`[VV] Revealing from ${jid}`);
        const content = viewOnce;
        const type = Object.keys(content)[0];
        const buffer = await sock.downloadMediaMessage({ message: content });
        if (!buffer) return;

        const caption = `👁️ *VIEW ONCE REVEALED*\n*From:* ${isGroup? 'Group' : '@'+jid.split('@')[0]}\n*Type:* ${type.replace('Message','')}\n\n> POWERED BY ETIAS-TECH`;

        if (type === 'imageMessage') {
          await sock.sendMessage(jid, { image: buffer, caption, mentions: [msg.key.participant || jid] });
          if (jid!== OWNER) await sock.sendMessage(OWNER, { image: buffer, caption: `VV from ${jid}\n${caption}` }).catch(()=>{});
        } else if (type === 'videoMessage') {
          await sock.sendMessage(jid, { video: buffer, caption, mentions: [msg.key.participant || jid] });
          if (jid!== OWNER) await sock.sendMessage(OWNER, { video: buffer, caption: `VV from ${jid}\n${caption}` }).catch(()=>{});
        } else if (type === 'audioMessage') {
          await sock.sendMessage(jid, { audio: buffer, mimetype: 'audio/mpeg', ptt: content.audioMessage?.ptt || false });
        }
      } catch (e) {
        console.log('[VV ERROR]', e.message);
      }
      return;
    }

    const text = msg.message.conversation ||
                 msg.message.extendedTextMessage?.text ||
                 msg.message.imageMessage?.caption ||
                 msg.message.videoMessage?.caption || "";

    if (!text) return;

    // Only respond to owner or if you want public, remove this check
    // console.log(`[MSG] ${jid} | ${text.slice(0,30)}`);

    if (!text.startsWith(PREFIX)) return;

    const args = text.slice(PREFIX.length).trim().split(/ +/);
    const cmdName = args.shift().toLowerCase();
    if (!cmdName) return;

    // ===== BUILT-IN COMMANDS =====
    if (cmdName === 'ping') {
      const start = Date.now();
      await sock.sendMessage(jid, { text: `*Pong!* 🏓\n${BOT_NAME} online\nSpeed: ${Date.now() - start}ms` }, { quoted: msg });
      return;
    }

    if (cmdName === 'menu' || cmdName === 'help' || cmdName === 'list') {
      const menuText =
`┏━━━━━━━━━━━━━━━━━━━━┓
┃ 🤖 ${BOT_NAME} MENU ┃
┗━━━━━━━━━━━━━━━━━━━━┛

┌─ 🎵 *MUSIC* ─┐
│ •.play <song name>
└───────────────┘

┌─ 🤖 *AI* ─┐
│ •.ai <question>
└─────────────┘

┌─ 👁️ *TOOLS* ─┐
│ •.antiviewonce on/off
│ •.ping - Speed
│ •.menu - This menu
└───────────────┘

> *POWERED BY ETIAS-TECH*`;

      try {
        if (fs.existsSync(BOT_IMAGE_PATH)) {
          const img = fs.readFileSync(BOT_IMAGE_PATH);
          await sock.sendMessage(jid, { image: img, caption: menuText }, { quoted: msg });
        } else {
          await sock.sendMessage(jid, { text: menuText }, { quoted: msg });
        }
      } catch {
        await sock.sendMessage(jid, { text: menuText }, { quoted: msg });
      }
      return;
    }

    const command = commands.get(cmdName);
    if (!command) return;

    try {
      console.log(`[CMD] ${cmdName} by ${jid}`);
      await command.execute(sock, msg, args);
    } catch (e) {
      console.log('[CMD ERROR]', e);
      await sock.sendMessage(jid, { text: `❌ Error: ${e.message}` }, { quoted: msg });
    }
  });
}

startBot();
