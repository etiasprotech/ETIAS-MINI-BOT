const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'database/antiviewonce.json');
const BOT_IMAGE_PATH = path.join(__dirname, '..', 'media/bot_image.png');
const BOT_NAME = "*ETIAS-MINI-BOT*";

if (!fs.existsSync(path.dirname(DB_PATH))) fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, JSON.stringify({}));

function getDB() { try { return JSON.parse(fs.readFileSync(DB_PATH)); } catch { return {}; } }
function saveDB(d) { fs.writeFileSync(DB_PATH, JSON.stringify(d, null, 2)); }

module.exports.name = "antiviewonce";
module.exports.aliases = ["avv", "viewonce", "antivo", "noviewonce"];
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
    return await sock.sendMessage(chatId, { text: `✅ *Antiviewonce enabled*\n\nI will recover view once messages.\n\n> *POWERED BY ETIAS-TECH*` }, { quoted: msg });
  }

  if (sub === "off" || sub === "disable") {
    db[chatId] = false;
    saveDB(db);
    return await sock.sendMessage(chatId, { text: "❌ *Antiviewonce disabled*" }, { quoted: msg });
  }

  if (sub === "status") {
    return await sock.sendMessage(chatId, { text: `╭━━━〔 *ANTIVIEWONCE* 〕━━━\n┃ Status: ${db[chatId]? "✅ ON" : "❌ OFF"}\n╰━━━━━━━━━━━` }, { quoted: msg });
  }

  const helpText = `
╭━━━〔 *${BOT_NAME} ANTIVIEWONCE* 〕━━━┈⊷
┃
┃ 👁️ *Recover View Once*
┃
┃.antiviewonce on - Enable
┃.antiviewonce off - Disable
┃.antiviewonce status - Check
┃
┃ *What it does:*
┃ When someone sends view once
┃ Bot will resend it as normal
┃ media + save it
┃
╰━━━━━━━━━━━━━━━━━━┈⊷

> *POWERED BY ETIAS-TECH*
`;
  const footer = "*ETIAS-MINI-BOT • POWERED BY ETIAS-TECH*";
  const buttons = [
    { buttonId: '.antiviewonce on', buttonText: { displayText: '✅ ENABLE' }, type: 1 },
    { buttonId: '.antiviewonce off', buttonText: { displayText: '❌ DISABLE' }, type: 1 }
  ];

  if (fs.existsSync(BOT_IMAGE_PATH)) {
    await sock.sendMessage(chatId, { image: fs.readFileSync(BOT_IMAGE_PATH), caption: helpText, footer: footer, buttons: buttons, headerType: 4 }, { quoted: msg });
  } else {
    await sock.sendMessage(chatId, { text: helpText, footer: footer, buttons: buttons, headerType: 1 }, { quoted: msg });
  }
};

// ========================
// REQUIRED EVENT - ADD IN index.js
// ========================
/*
const fs = require('fs');
const path = require('path');
const DB_PATH = path.join(__dirname, 'database/antiviewonce.json');

function getDB() { try { return JSON.parse(fs.readFileSync(DB_PATH)); } catch { return {}; } }

sock.ev.on('messages.upsert', async ({ messages }) => {
  for (let m of messages) {
    if (!m.message || m.key.fromMe) continue;
    const chatId = m.key.remoteJid;

    const db = getDB();
    if (!db[chatId]) continue; // Not enabled for this chat

    const msgType = Object.keys(m.message)[0];

    // ViewOnce v1 and v2
    let viewOnceMsg = null;
    let isViewOnce = false;

    if (m.message.viewOnceMessage) {
      viewOnceMsg = m.message.viewOnceMessage.message;
      isViewOnce = true;
    } else if (m.message.viewOnceMessageV2) {
      viewOnceMsg = m.message.viewOnceMessageV2.message;
      isViewOnce = true;
    } else if (m.message.viewOnceMessageV2Extension) {
      viewOnceMsg = m.message.viewOnceMessageV2Extension.message;
      isViewOnce = true;
    }

    if (!isViewOnce ||!viewOnceMsg) continue;

    const innerType = Object.keys(viewOnceMsg)[0];
    const sender = m.key.participant || m.key.remoteJid;
    const senderTag = `@${sender.split('@')[0]}`;

    try {
      // Download media
      const buffer = await sock.downloadMediaMessage({ message: viewOnceMsg });

      const infoText = `
╭━━━〔 *VIEW ONCE RECOVERED* 〕━━━┈⊷
┃ 👤 Sender: ${senderTag}
┃ 📎 Type: ${innerType.replace('Message','')}
┃ ⏰ Time: ${new Date().toLocaleString()}
╰━━━━━━━━━━━━━━━━━━┈⊷

> POWERED BY ETIAS-TECH
`;

      await sock.sendMessage(chatId, { text: infoText, mentions: [sender] });

      if (innerType === 'imageMessage') {
        const caption = viewOnceMsg.imageMessage.caption || "";
        await sock.sendMessage(chatId, {
          image: buffer,
          caption: `👁️ *ViewOnce Image* from ${senderTag}\n\n${caption}\n\n> POWERED BY ETIAS-TECH`,
          mentions: [sender]
        });
      } else if (innerType === 'videoMessage') {
        const caption = viewOnceMsg.videoMessage.caption || "";
        await sock.sendMessage(chatId, {
          video: buffer,
          caption: `👁️ *ViewOnce Video* from ${senderTag}\n\n${caption}\n\n> POWERED BY ETIAS-TECH`,
          mentions: [sender]
        });
      } else if (innerType === 'audioMessage') {
        await sock.sendMessage(chatId, {
          audio: buffer,
          mimetype: 'audio/mp4',
          ptt: viewOnceMsg.audioMessage.ptt || false
        });
      }

      // Also send to bot owner if you want private backup
      // await sock.sendMessage(sock.user.id, {... });

    } catch (e) {
      console.log('[ANTIVIEWONCE ERROR]', e.message);
      await sock.sendMessage(chatId, {
        text: `⚠️ Failed to recover view once from @${sender.split('@')[0]} - Media download failed`,
        mentions: [sender]
      });
    }
  }
});
*/
