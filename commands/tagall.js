const fs = require('fs');
const path = require('path');

const BOT_IMAGE_PATH = path.join(__dirname, '..', 'media/bot_image.png');
const BOT_NAME = "*ETIAS-MINI-BOT*";

module.exports.name = "tagall";
module.exports.aliases = ["everyone", "all", "tag"];
module.exports.execute = async (sock, msg, args) => {
  const chatId = msg.key.remoteJid;
  const isGroup = chatId.endsWith('@g.us');
  if (!isGroup) return await sock.sendMessage(chatId, { text: "❌ Group only command." }, { quoted: msg });

  try {
    const groupMeta = await sock.groupMetadata(chatId);
    const sender = msg.key.participant || msg.key.remoteJid;
    const isSenderAdmin = groupMeta.participants.find(p => p.id === sender)?.admin;

    if (!isSenderAdmin) {
      return await sock.sendMessage(chatId, { text: "❌ *Admins only - tagall.*\n\n> *POWERED BY ETIAS-TECH*" }, { quoted: msg });
    }

    const participants = groupMeta.participants.map(p => p.id);
    const customMsg = args.join(" ");

    try { await sock.sendMessage(chatId, { react: { text: "👥", key: msg.key } }); } catch {}

    // Build message
    let header = customMsg ? customMsg : `Attention Everyone !`;
    
    let tagText = `
╭━━━〔 *${BOT_NAME} TAGALL* 〕━━━┈⊷
┃
┃ 📢 *Message:* ${header}
┃ 👥 *Total:* ${participants.length} Members
┃ 🏷️ *Group:* ${groupMeta.subject.slice(0, 25)}
┃
┃ ━━〔 *MENTIONS* 〕━━
┃
`;

    participants.forEach((p, i) => {
      tagText += `┃ ${i+1}. @${p.split('@')[0]}\n`;
    });

    tagText += `┃
╰━━━━━━━━━━━━━━━━━━┈⊷

> *POWERED BY ETIAS-TECH*
`;

    const footer = "*ETIAS-MINI-BOT • POWERED BY ETIAS-TECH*";
    const buttons = [
      { buttonId: '.hidetag ' + (customMsg || ''), buttonText: { displayText: '🔊 HIDETAG' }, type: 1 },
      { buttonId: '.mute', buttonText: { displayText: '🔒 MUTE' }, type: 1 }
    ];

    // Send with image if exists, else text
    if (fs.existsSync(BOT_IMAGE_PATH)) {
      await sock.sendMessage(chatId, {
        image: fs.readFileSync(BOT_IMAGE_PATH),
        caption: tagText,
        footer: footer,
        buttons: buttons,
        headerType: 4,
        mentions: participants
      }, { quoted: msg });
    } else {
      await sock.sendMessage(chatId, {
        text: tagText,
        footer: footer,
        buttons: buttons,
        headerType: 1,
        mentions: participants
      }, { quoted: msg });
    }

  } catch (e) {
    console.log('[TAGALL ERROR]', e.message);
    await sock.sendMessage(chatId, { text: `❌ Tagall failed: ${e.message}` }, { quoted: msg });
  }
};
