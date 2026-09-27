const fs = require('fs');
const path = require('path');

const BOT_IMAGE_PATH = path.join(__dirname, '..', 'media/bot_image.png');
const BOT_NAME = "*ETIAS-MINI-BOT*";

module.exports.name = "demote";
module.exports.aliases = ["removeadmin", "unadmin"];
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
      return await sock.sendMessage(chatId, { text: "❌ *Bot must be admin to demote.*\n\n> *POWERED BY ETIAS-TECH*" }, { quoted: msg });
    }

    let target;
    // 1. Mention
    if (msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.length) {
      target = msg.message.extendedTextMessage.contextInfo.mentionedJid[0];
    }
    // 2. Reply
    else if (msg.message?.extendedTextMessage?.contextInfo?.participant) {
      target = msg.message.extendedTextMessage.contextInfo.participant;
    }
    // 3. Number
    else if (args[0]) {
      let num = args[0].replace(/[^0-9]/g, '');
      if (num) target = num + '@s.whatsapp.net';
    }

    if (!target) {
      return await sock.sendMessage(chatId, {
        text: `╭━━━〔 *${BOT_NAME} DEMOTE* 〕━━━┈⊷\n┃\n┃ ❌ Usage:.demote @user\n┃ Or reply to user with.demote\n┃\n╰━━━━━━━━━━━━━━┈⊷\n\n> *POWERED BY ETIAS-TECH*`
      }, { quoted: msg });
    }

    if (target === botId) {
      return await sock.sendMessage(chatId, { text: "❌ Can't demote bot." }, { quoted: msg });
    }

    // Check if not admin
    const isTargetAdmin = groupMeta.participants.find(p => p.id === target)?.admin;
    if (!isTargetAdmin) {
      return await sock.sendMessage(chatId, { text: `⚠️ @${target.split('@')[0]} is not an admin.`, mentions: [target] }, { quoted: msg });
    }

    try { await sock.sendMessage(chatId, { react: { text: "⬇️", key: msg.key } }); } catch {}

    await sock.groupParticipantsUpdate(chatId, [target], "demote");

    const demoteText = `
╭━━━〔 *${BOT_NAME} DEMOTE* 〕━━━┈⊷
┃
┃ ✅ *Action:* Demoted from Admin
┃ 👤 *User:* @${target.split('@')[0]}
┃ ⬇️ *By:* @${sender.split('@')[0]}
┃ 🏷️ *Group:* ${groupMeta.subject.slice(0, 30)}
┃
╰━━━━━━━━━━━━━━━━━━┈⊷

> *POWERED BY ETIAS-TECH*
`;
    const footer = "*ETIAS-MINI-BOT • POWERED BY ETIAS-TECH*";
    const buttons = [
      { buttonId: `.promote @${target.split('@')[0]}`, buttonText: { displayText: '⬆️ PROMOTE AGAIN' }, type: 1 },
      { buttonId: '.tagall', buttonText: { displayText: '👥 TAGALL' }, type: 1 }
    ];

    if (fs.existsSync(BOT_IMAGE_PATH)) {
      await sock.sendMessage(chatId, {
        image: fs.readFileSync(BOT_IMAGE_PATH),
        caption: demoteText,
        footer: footer,
        buttons: buttons,
        headerType: 4,
        mentions: [target, sender]
      }, { quoted: msg });
    } else {
      await sock.sendMessage(chatId, {
        text: demoteText,
        footer: footer,
        buttons: buttons,
        headerType: 1,
        mentions: [target, sender]
      }, { quoted: msg });
    }

  } catch (e) {
    console.log('[DEMOTE ERROR]', e.message);
    await sock.sendMessage(chatId, { text: `❌ Failed to demote: ${e.message}\n\n> *POWERED BY ETIAS-TECH*` }, { quoted: msg });
  }
};
