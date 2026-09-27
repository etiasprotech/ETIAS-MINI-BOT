const fs = require('fs');
const path = require('path');

const BOT_IMAGE_PATH = path.join(__dirname, '..', 'media/bot_image.png');
const BOT_NAME = "*ETIAS-MINI-BOT*";

module.exports.name = "kick";
module.exports.aliases = ["remove", "k"];
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

    // Fallback check for LID bots
    const isSenderAdmin2 = isSenderAdmin || groupMeta.participants.find(p => p.id.includes(sender.split('@')[0]))?.admin;

    if (!isSenderAdmin &&!isSenderAdmin2) {
      return await sock.sendMessage(chatId, {
        text: "❌ *Admins only.*\n\n> *POWERED BY ETIAS-TECH*"
      }, { quoted: msg });
    }

    if (!isBotAdmin) {
      return await sock.sendMessage(chatId, {
        text: "❌ *Bot must be admin to kick.*\n\n> *POWERED BY ETIAS-TECH*"
      }, { quoted: msg });
    }

    let target;
    let targetName = "";

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
        text: `╭━━━〔 *${BOT_NAME} KICK* 〕━━━┈⊷\n┃\n┃ ❌ Usage:.kick @user\n┃ Or reply to user with.kick\n┃\n╰━━━━━━━━━━━━━━┈⊷\n\n> *POWERED BY ETIAS-TECH*`
      }, { quoted: msg });
    }

    // Don't kick bot or group itself
    if (target === botId || target === chatId) {
      return await sock.sendMessage(chatId, { text: "❌ Can't kick bot." }, { quoted: msg });
    }

    // Check if target is admin (prevent admin kick)
    const isTargetAdmin = groupMeta.participants.find(p => p.id === target)?.admin;
    if (isTargetAdmin) {
      return await sock.sendMessage(chatId, {
        text: `❌ Can't kick another admin.\nDemote first.\n\n> *POWERED BY ETIAS-TECH*`
      }, { quoted: msg });
    }

    try { await sock.sendMessage(chatId, { react: { text: "👢", key: msg.key } }); } catch {}

    await sock.groupParticipantsUpdate(chatId, [target], "remove");

    const kickText = `
╭━━━〔 *${BOT_NAME} KICK* 〕━━━┈⊷
┃
┃ ✅ *Action:* Removed
┃ 👤 *User:* @${target.split('@')[0]}
┃ 👢 *By:* @${sender.split('@')[0]}
┃ 🏷️ *Group:* ${groupMeta.subject.slice(0, 30)}
┃
╰━━━━━━━━━━━━━━━━━━┈⊷

> *POWERED BY ETIAS-TECH*
`;
    const footer = "*ETIAS-MINI-BOT • POWERED BY ETIAS-TECH*";
    const buttons = [
      { buttonId: '.tagall', buttonText: { displayText: '👥 TAGALL' }, type: 1 },
      { buttonId: '.menu', buttonText: { displayText: '📜 MENU' }, type: 1 }
    ];

    if (fs.existsSync(BOT_IMAGE_PATH)) {
      await sock.sendMessage(chatId, {
        image: fs.readFileSync(BOT_IMAGE_PATH),
        caption: kickText,
        footer: footer,
        buttons: buttons,
        headerType: 4,
        mentions: [target, sender]
      }, { quoted: msg });
    } else {
      await sock.sendMessage(chatId, {
        text: kickText,
        footer: footer,
        buttons: buttons,
        headerType: 1,
        mentions: [target, sender]
      }, { quoted: msg });
    }

  } catch (e) {
    console.log('[KICK ERROR]', e.message);
    await sock.sendMessage(chatId, {
      text: `❌ Failed to kick: ${e.message}\n\n> *POWERED BY ETIAS-TECH*`
    }, { quoted: msg });
  }
};
