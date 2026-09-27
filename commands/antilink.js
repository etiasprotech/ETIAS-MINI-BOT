const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'database/antilink.json');
const BOT_IMAGE_PATH = path.join(__dirname, '..', 'media/bot_image.png');
const BOT_NAME = "*ETIAS-MINI-BOT*";

if (!fs.existsSync(path.dirname(DB_PATH))) fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, JSON.stringify({}));

function getDB() { try { return JSON.parse(fs.readFileSync(DB_PATH)); } catch { return {}; } }
function saveDB(d) { fs.writeFileSync(DB_PATH, JSON.stringify(d, null, 2)); }

// Link regex
const LINK_REGEX = /(https?:\/\/|www\.|wa\.me\/|chat\.whatsapp\.com\/|t\.me\/|discord\.gg\/|instagram\.com\/|facebook\.com\/|youtube\.com\/|youtu\.be\/)/i;

module.exports.name = "antilink";
module.exports.aliases = ["antilinks", "nolink"];
module.exports.execute = async (sock, msg, args) => {
  const chatId = msg.key.remoteJid;
  const isGroup = chatId.endsWith('@g.us');
  if (!isGroup) return await sock.sendMessage(chatId, { text: "❌ Group only." }, { quoted: msg });

  const groupMeta = await sock.groupMetadata(chatId);
  const sender = msg.key.participant || msg.key.remoteJid;
  const isAdmin = groupMeta.participants.find(p => p.id === sender)?.admin;
  const botId = sock.user.id.split(':')[0] + '@s.whatsapp.net';
  const isBotAdmin = groupMeta.participants.find(p => p.id === botId)?.admin;

  if (!isAdmin) return await sock.sendMessage(chatId, { text: "❌ Admins only." }, { quoted: msg });

  const db = getDB();
  const sub = args[0]?.toLowerCase();

  if (sub === "on" || sub === "enable") {
    const action = args[1]?.toLowerCase() || "delete"; // delete, kick, warn
    db[chatId] = { enabled: true, action: action, warnCount: {} };
    saveDB(db);
    return await sock.sendMessage(chatId, { text: `✅ *Antilink enabled*\n\nAction: ${action.toUpperCase()}\n• delete = delete link\n• kick = delete + kick\n• warn = delete + warn (3 warns = kick)\n\nExample:.antilink on kick\n\n> *POWERED BY ETIAS-TECH*` }, { quoted: msg });
  }

  if (sub === "off" || sub === "disable") {
    db[chatId] = { enabled: false, action: "delete", warnCount: {} };
    saveDB(db);
    return await sock.sendMessage(chatId, { text: "❌ *Antilink disabled*\n\n> *POWERED BY ETIAS-TECH*" }, { quoted: msg });
  }

  if (sub === "status") {
    const conf = db[chatId];
    return await sock.sendMessage(chatId, { text: `╭━━━〔 *ANTILINK STATUS* 〕━━━\n┃ Status: ${conf?.enabled? "✅ ON" : "❌ OFF"}\n┃ Action: ${conf?.action || "delete"}\n╰━━━━━━━━━━━━━━\n\n> *POWERED BY ETIAS-TECH*` }, { quoted: msg });
  }

  if (sub === "kick" || sub === "delete" || sub === "warn") {
    db[chatId] = { enabled: true, action: sub, warnCount: db[chatId]?.warnCount || {} };
    saveDB(db);
    return await sock.sendMessage(chatId, { text: `✅ Antilink set to *${sub.toUpperCase()}* mode\n\n> *POWERED BY ETIAS-TECH*` }, { quoted: msg });
  }

  const helpText = `
╭━━━〔 *${BOT_NAME} ANTILINK* 〕━━━┈⊷
┃
┃ 🔗 *Block Links in Group*
┃
┃.antilink on - Enable (delete mode)
┃.antilink on delete - Just delete
┃.antilink on kick - Delete + kick
┃.antilink on warn - Warn + kick after 3
┃.antilink off - Disable
┃.antilink status - Check
┃
┃ *Whitelist:* Group invite of this group
┃ allowed automatically
┃
┃ *Blocked:*
┃ https://, www., wa.me, t.me,
┃ discord.gg, youtube etc
┃
╰━━━━━━━━━━━━━━━━━━┈⊷

> *POWERED BY ETIAS-TECH*
`;
  const footer = "*ETIAS-MINI-BOT • POWERED BY ETIAS-TECH*";
  const buttons = [
    { buttonId: '.antilink on kick', buttonText: { displayText: '🔨 KICK MODE' }, type: 1 },
    { buttonId: '.antilink off', buttonText: { displayText: '❌ DISABLE' }, type: 1 }
  ];

  if (fs.existsSync(BOT_IMAGE_PATH)) {
    await sock.sendMessage(chatId, { image: fs.readFileSync(BOT_IMAGE_PATH), caption: helpText, footer: footer, buttons: buttons, headerType: 4 }, { quoted: msg });
  } else {
    await sock.sendMessage(chatId, { text: helpText, footer: footer, buttons: buttons, headerType: 1 }, { quoted: msg });
  }
};

// ========================
// EVENT HANDLER - ADD IN index.js messages.upsert
// ========================
/*
const fs = require('fs');
const path = require('path');
const DB_PATH = path.join(__dirname, 'database/antilink.json');
const LINK_REGEX = /(https?:\/\/|www\.|wa\.me\/|chat\.whatsapp\.com\/|t\.me\/|discord\.gg\/|instagram\.com\/|facebook\.com\/|youtube\.com\/|youtu\.be\/)/i;

function getDB() { try { return JSON.parse(fs.readFileSync(DB_PATH)); } catch { return {}; } }
function saveDB(d) { fs.writeFileSync(DB_PATH, JSON.stringify(d, null, 2)); }

sock.ev.on('messages.upsert', async ({ messages }) => {
  for (let m of messages) {
    if (!m.message || m.key.fromMe) continue;
    const chatId = m.key.remoteJid;
    if (!chatId.endsWith('@g.us')) continue;

    const db = getDB();
    const conf = db[chatId];
    if (!conf ||!conf.enabled) continue;

    const text = m.message.conversation || m.message.extendedTextMessage?.text || m.message.imageMessage?.caption || m.message.videoMessage?.caption || "";
    if (!text) continue;
    if (!LINK_REGEX.test(text)) continue;

    const sender = m.key.participant || m.key.remoteJid;
    const groupMeta = await sock.groupMetadata(chatId);
    const isAdmin = groupMeta.participants.find(p => p.id === sender)?.admin;
    const botId = sock.user.id.split(':')[0] + '@s.whatsapp.net';
    const isBotAdmin = groupMeta.participants.find(p => p.id === botId)?.admin;

    if (isAdmin) continue; // Don't delete admin links
    if (!isBotAdmin) continue;

    // Check if it's current group invite link (allow)
    try {
      const inviteCode = await sock.groupInviteCode(chatId);
      if (text.includes(inviteCode)) continue;
    } catch {}

    // Delete message
    try {
      await sock.sendMessage(chatId, { delete: m.key });
    } catch {}

    const action = conf.action || "delete";

    if (action === "delete") {
      await sock.sendMessage(chatId, {
        text: `⚠️ @${sender.split('@')[0]} Links not allowed!\n\n> POWERED BY ETIAS-TECH`,
        mentions: [sender]
      });
    } else if (action === "warn") {
      conf.warnCount = conf.warnCount || {};
      conf.warnCount[sender] = (conf.warnCount[sender] || 0) + 1;
      saveDB(db);

      if (conf.warnCount[sender] >= 3) {
        await sock.sendMessage(chatId, {
          text: `🔨 @${sender.split('@')[0]} kicked for 3 link warnings!`,
          mentions: [sender]
        });
        try { await sock.groupParticipantsUpdate(chatId, [sender], "remove"); } catch {}
        conf.warnCount[sender] = 0;
        saveDB(db);
      } else {
        await sock.sendMessage(chatId, {
          text: `⚠️ @${sender.split('@')[0]} Warning ${conf.warnCount[sender]}/3 - Links not allowed!`,
          mentions: [sender]
        });
      }
    } else if (action === "kick") {
      await sock.sendMessage(chatId, {
        text: `🔨 @${sender.split('@')[0]} kicked for sending link!\n\nLink: ${text.slice(0,50)}`,
        mentions: [sender]
      });
      try { await sock.groupParticipantsUpdate(chatId, [sender], "remove"); } catch {}
    }
  }
});
*/
