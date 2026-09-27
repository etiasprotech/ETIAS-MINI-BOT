const fs = require('fs');
const path = require('path');

const BOT_IMAGE_PATH = path.join(__dirname, '..', 'media/bot_image.png');
const BOT_NAME = "*ETIAS-MINI-BOT*";

module.exports.name = "mute";
module.exports.aliases = ["close", "groupclose", "lock"];
module.exports.execute = async (sock, msg, args) => {
  const chatId = msg.key.remoteJid;
  const isGroup = chatId.endsWith('@g.us');
  if (!isGroup) return await sock.sendMessage(chatId, { text: "❌ Group only command." }, { quoted: msg });

  try {
    const groupMeta = await sock.groupMetadata(chatId);
    const sender = msg.key.participant || msg.key.remoteJid;
    const botId = sock.user.id.split(':')[0] + '@s.whatsapp.net';

    const isSenderAdmin = groupMeta.participants.find(p => p.id === sender)?.admin;
    const isBotAdmin = groupMeta.participants.find(p => p.id === botId)?.admin;

    if (!isSenderAdmin) {
      return await sock.sendMessage(chatId, { text: "❌ *Admins only.*\n\n> *POWERED BY ETIAS-TECH*" }, { quoted: msg });
    }
    if (!isBotAdmin) {
      return await sock.sendMessage(chatId, { text: "❌ *Bot must be admin to mute.*\n\n> *POWERED BY ETIAS-TECH*" }, { quoted: msg });
    }

    // Check if already closed
    if (groupMeta.announce === true || groupMeta.announce === 'true') {
      return await sock.sendMessage(chatId, { text: "⚠️ Group is already closed / muted.\n\n> *POWERED BY ETIAS-TECH*" }, { quoted: msg });
    }

    try { await sock.sendMessage(chatId, { react: { text: "🔒", key: msg.key } }); } catch {}

    await sock.groupSettingUpdate(chatId, 'announcement');

    const muteText = `
╭━━━〔 *${BOT_NAME} MUTE* 〕━━━┈⊷
┃
┃ 🔒 *Action:* Group Closed
┃ 🏷️ *Group:* ${groupMeta.subject.slice(0, 30)}
┃ 👤 *By:* @${sender.split('@')[0]}
┃ 📝 *Info:* Only admins can chat now
┃
╰━━━━━━━━━━━━━━━━━━┈⊷

> *POWERED BY ETIAS-TECH*
`;
    const footer = "*ETIAS-MINI-BOT • POWERED BY ETIAS-TECH*";
    const buttons = [
      { buttonId: '.unmute', buttonText: { displayText: '🔓 UNMUTE' }, type: 1 },
      { buttonId: '.tagall', buttonText: { displayText: '👥 TAGALL' }, type: 1 }
    ];

    if (fs.existsSync(BOT_IMAGE_PATH)) {
      await sock.sendMessage(chatId, {
        image: fs.readFileSync(BOT_IMAGE_PATH),
        caption: muteText,
        footer: footer,
        buttons: buttons,
        headerType: 4,
        mentions: [sender]
      }, { quoted: msg });
    } else {
      await sock.sendMessage(chatId, {
        text: muteText,
        footer: footer,
        buttons: buttons,
        headerType: 1,
        mentions: [sender]
      }, { quoted: msg });
    }

  } catch (e) {
    console.log('[MUTE ERROR]', e.message);
    await sock.sendMessage(chatId, { text: `❌ Failed to mute: ${e.message}\n\n> *POWERED BY ETIAS-TECH*` }, { quoted: msg });
  }
};
