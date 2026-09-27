const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'database/antidelete.json');
const STORE_PATH = path.join(__dirname, '..', 'database/messageStore.json');
const BOT_IMAGE_PATH = path.join(__dirname, '..', 'media/bot_image.png');
const BOT_NAME = "*ETIAS-MINI-BOT*";

if (!fs.existsSync(path.dirname(DB_PATH))) fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, JSON.stringify({}));
if (!fs.existsSync(STORE_PATH)) fs.writeFileSync(STORE_PATH, JSON.stringify({}));

function getDB() { try { return JSON.parse(fs.readFileSync(DB_PATH)); } catch { return {}; } }
function saveDB(d) { fs.writeFileSync(DB_PATH, JSON.stringify(d, null, 2)); }

module.exports.name = "antidelete";
module.exports.aliases = ["antidel", "ad", "antidelete"];
module.exports.execute = async (sock, msg, args) => {
  const chatId = msg.key.remoteJid;
  const isGroup = chatId.endsWith('@g.us');
  const sender = msg.key.participant || msg.key.remoteJid;

  if (isGroup) {
    const groupMeta = await sock.groupMetadata(chatId);
    const isAdmin = groupMeta.participants.find(p => p.id === sender)?.admin;
    if (!isAdmin) return await sock.sendMessage(chatId, { text: "❌ Admins only." }, { quoted: msg });
  }

  const db = getDB();
  const sub = args[0]?.toLowerCase();

  if (sub === "on" || sub === "enable") {
    db[chatId] = true;
    saveDB(db);
    return await sock.sendMessage(chatId, { text: `✅ *Antidelete enabled* for this ${isGroup? "group" : "chat"}\n\nI will recover deleted messages.\n\n> *POWERED BY ETIAS-TECH*` }, { quoted: msg });
  }

  if (sub === "off" || sub === "disable") {
    db[chatId] = false;
    saveDB(db);
    return await sock.sendMessage(chatId, { text: `❌ *Antidelete disabled*\n\n> *POWERED BY ETIAS-TECH*` }, { quoted: msg });
  }

  if (sub === "status") {
    const enabled = db[chatId];
    return await sock.sendMessage(chatId, { text: `╭━━━〔 *ANTIDELETE STATUS* 〕━━━\n┃ Status: ${enabled? "✅ ON" : "❌ OFF"}\n╰━━━━━━━━━━━━━━\n\n> *POWERED BY ETIAS-TECH*` }, { quoted: msg });
  }

  const helpText = `
╭━━━〔 *${BOT_NAME} ANTIDELETE* 〕━━━┈⊷
┃
┃ 🛡️ *Recover Deleted Messages*
┃
┃.antidelete on - Enable
┃.antidelete off - Disable
┃.antidelete status - Check
┃
┃ *How it works:*
┃ Bot saves all messages
┃ When someone deletes for everyone
┃ Bot resends it with info
┃
┃ Works for:
┃ Text, Image, Video, Audio, Sticker
┃
╰━━━━━━━━━━━━━━━━━━┈⊷

> *POWERED BY ETIAS-TECH*
`;
  const footer = "*ETIAS-MINI-BOT • POWERED BY ETIAS-TECH*";
  const buttons = [
    { buttonId: '.antidelete on', buttonText: { displayText: '✅ ENABLE' }, type: 1 },
    { buttonId: '.antidelete off', buttonText: { displayText: '❌ DISABLE' }, type: 1 }
  ];

  if (fs.existsSync(BOT_IMAGE_PATH)) {
    await sock.sendMessage(chatId, { image: fs.readFileSync(BOT_IMAGE_PATH), caption: helpText, footer: footer, buttons: buttons, headerType: 4 }, { quoted: msg });
  } else {
    await sock.sendMessage(chatId, { text: helpText, footer: footer, buttons: buttons, headerType: 1 }, { quoted: msg });
  }
};

// ========================
// REQUIRED - MESSAGE STORE & DELETE HANDLER
// ADD THIS IN YOUR index.js / main.js
// ========================
/*
const fs = require('fs');
const path = require('path');
const DB_PATH = path.join(__dirname, 'database/antidelete.json');
const STORE_PATH = path.join(__dirname, 'database/messageStore.json');

if (!fs.existsSync(STORE_PATH)) fs.writeFileSync(STORE_PATH, JSON.stringify({}));

function getStore() { try { return JSON.parse(fs.readFileSync(STORE_PATH)); } catch { return {}; } }
function saveStore(d) { fs.writeFileSync(STORE_PATH, JSON.stringify(d, null, 2)); }

// 1. STORE EVERY MESSAGE
sock.ev.on('messages.upsert', async ({ messages }) => {
  try {
    const store = getStore();
    for (let m of messages) {
      if (!m.message || m.key.fromMe) continue;
      const chatId = m.key.remoteJid;
      const msgId = m.key.id;

      // Save text
      let content = m.message.conversation || m.message.extendedTextMessage?.text || m.message.imageMessage?.caption || m.message.videoMessage?.caption || "";

      // Save media reference for later download
      store[msgId] = {
        chatId: chatId,
        sender: m.key.participant || m.key.remoteJid,
        content: content,
        message: m.message, // full message object
        timestamp: Date.now(),
        type: Object.keys(m.message)[0]
      };
    }
    saveStore(store);

    // Auto clean old messages (keep 500)
    const keys = Object.keys(store);
    if (keys.length > 500) {
      const sorted = keys.sort((a,b) => store[a].timestamp - store[b].timestamp);
      for (let i=0; i< keys.length-500; i++) delete store[sorted[i]];
      saveStore(store);
    }

  } catch {}
});

// 2. DETECT DELETE
sock.ev.on('messages.update', async (updates) => {
  try {
    if (!fs.existsSync(DB_PATH)) return;
    const db = JSON.parse(fs.readFileSync(DB_PATH));
    const store = getStore();

    for (let update of updates) {
      const { key, update: upd } = update;
      if (upd.status!== 2) continue; // Not needed, check for deleted
      // WhatsApp delete is actually a message with protocolMessage type = 0 in upsert

      // Alternative method: check protocolMessage
      if (upd.messageStubType === 68 || upd.messageStubType === 2) { // REVOKE
        const msgId = key.id;
        const chatId = key.remoteJid;
        if (!db[chatId]) continue; // Antidelete not enabled for this chat
        if (!store[msgId]) continue;

        const saved = store[msgId];
        const sender = saved.sender;

        const deleteInfo = `
╭━━━〔 *ANTIDELETE DETECTED* 〕━━━┈⊷
┃
┃ 🗑️ *Someone deleted a message!*
┃ 👤 *Sender:* @${sender.split('@')[0]}
┃ 💬 *Chat:* ${chatId.endsWith('@g.us')? 'Group' : 'Private'}
┃ ⏰ *Time:* ${new Date().toLocaleString()}
┃ 📝 *Type:* ${saved.type}
┃
╰━━━━━━━━━━━━━━━━━━┈⊷

*Recovered Content:*
`;

        await sock.sendMessage(chatId, { text: deleteInfo, mentions: [sender] });

        // Resend original content
        if (saved.type === 'conversation' || saved.type === 'extendedTextMessage') {
          await sock.sendMessage(chatId, { text: `💬 *Deleted text:*\n\n${saved.content}\n\n> POWERED BY ETIAS-TECH`, mentions: [sender] });
        } else {
          // For media, forward the original message
          try {
            await sock.sendMessage(chatId, { forward: { key: { remoteJid: saved.chatId, id: msgId }, message: saved.message } });
          } catch {
            await sock.sendMessage(chatId, { text: `📎 *Deleted ${saved.type}* recovered but can't forward (media expired)\n\nCaption: ${saved.content}` });
          }
        }
      }
    }
  } catch (e) { console.log('[ANTIDELETE EVENT ERROR]', e.message); }
});

// BETTER METHOD - ALSO ADD THIS (Baileys new way):
sock.ev.on('messages.upsert', async ({ messages, type }) => {
  for (let m of messages) {
    // Check if it's a revoke (delete for everyone)
    if (m.message?.protocolMessage?.type === 0) { // 0 = REVOKE
      const revokedId = m.message.protocolMessage.key.id;
      const chatId = m.message.protocolMessage.key.remoteJid;
      const db = fs.existsSync(DB_PATH)? JSON.parse(fs.readFileSync(DB_PATH)) : {};
      if (!db[chatId]) continue;
      const store = getStore();
      const saved = store[revokedId];
      if (!saved) continue;

      const sender = saved.sender;
      const info = `╭━━━〔 *ANTIDELETE* 〕━━━\n┃ 🗑️ @${sender.split('@')[0]} deleted:\n╰━━━━━━\n\n${saved.content || `[${saved.type}]`}\n\n> POWERED BY ETIAS-TECH`;
      await sock.sendMessage(chatId, { text: info, mentions: [sender] });

      try {
        // Try to resend original
        if (saved.message.imageMessage) {
          const buffer = await sock.downloadMediaMessage({ key: { remoteJid: saved.chatId, id: revokedId }, message: saved.message });
          await sock.sendMessage(chatId, { image: buffer, caption: saved.content || '' });
        } else if (saved.message.videoMessage) {
          const buffer = await sock.downloadMediaMessage({ key: { remoteJid: saved.chatId, id: revokedId }, message: saved.message });
          await sock.sendMessage(chatId, { video: buffer, caption: saved.content || '' });
        } else if (saved.content) {
          await sock.sendMessage(chatId, { text: `💬 Deleted: ${saved.content}` });
        }
      } catch {}
    }
  }
});
*/
