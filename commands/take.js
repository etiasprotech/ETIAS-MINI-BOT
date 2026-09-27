const fs = require('fs');
const path = require('path');
const BOT_IMAGE_PATH = path.join(__dirname, '..', 'media/bot_image.png');

module.exports.name = "take";
module.exports.aliases = ["pp", "getpp", "profilepic", "stealpp", "getdp"];
module.exports.execute = async (sock, msg, args) => {
  const chatId = msg.key.remoteJid;
  const isGroup = chatId.endsWith('@g.us');

  // Determine target: mentioned, replied, or args number, or self
  let targetJid = null;
  let targetName = "User";

  const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
  const quoted = msg.message?.extendedTextMessage?.contextInfo?.participant;

  if (mentioned && mentioned.length > 0) {
    targetJid = mentioned[0];
  } else if (quoted) {
    targetJid = quoted;
  } else if (args[0]) {
    // If user typed number or jid
    let num = args[0].replace(/[^0-9]/g, '');
    if (num) {
      if (num.length >= 10) targetJid = num + '@s.whatsapp.net';
    }
    // If group pp
    if (args[0].toLowerCase() === 'group' || args[0].toLowerCase() === 'gc') {
      targetJid = chatId;
      targetName = "Group";
    }
  } else {
    // Default: sender
    targetJid = msg.key.participant || msg.key.remoteJid;
  }

  if (!targetJid) targetJid = msg.key.participant || msg.key.remoteJid;

  // If group target
  if (targetJid.endsWith('@g.us')) {
    try {
      const ppUrl = await sock.profilePictureUrl(targetJid, 'image');
      await sock.sendMessage(chatId, {
        image: { url: ppUrl },
        caption: `╭━━━〔 *GROUP DP* 〕━━━\n┃ Group: ${targetJid}\n╰━━━━━━━━━━━━\n\n> *POWERED BY ETIAS-TECH*`
      }, { quoted: msg });
    } catch {
      await sock.sendMessage(chatId, { text: "❌ Group has no profile picture or can't fetch.\n\n> *POWERED BY ETIAS-TECH*" }, { quoted: msg });
    }
    return;
  }

  try {
    const ppUrl = await sock.profilePictureUrl(targetJid, 'image');
    const username = targetJid.split('@')[0];

    await sock.sendMessage(chatId, {
      image: { url: ppUrl },
      caption: `╭━━━〔 *PROFILE PICTURE* 〕━━━\n┃ 👤 User: @${username}\n┃ 🆔 JID: ${targetJid}\n┃ 🔗 URL: Fetched\n╰━━━━━━━━━━━━━━━\n\n> *POWERED BY ETIAS-TECH*`,
      mentions: [targetJid]
    }, { quoted: msg });

  } catch (e) {
    await sock.sendMessage(chatId, {
      text: `❌ Can't get DP for @${targetJid.split('@')[0]}\n\nReason: No DP / Privacy settings / Invalid number\n\n> *POWERED BY ETIAS-TECH*`,
      mentions: [targetJid]
    }, { quoted: msg });
  }
};
