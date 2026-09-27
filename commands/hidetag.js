const fs = require('fs');
const path = require('path');

const BOT_IMAGE_PATH = path.join(__dirname, '..', 'media/bot_image.png');
const BOT_NAME = "*ETIAS-MINI-BOT*";

module.exports.name = "hidetag";
module.exports.aliases = ["htag", "hidetagg", "notag"];
module.exports.execute = async (sock, msg, args) => {
  const chatId = msg.key.remoteJid;
  const isGroup = chatId.endsWith('@g.us');
  if (!isGroup) return await sock.sendMessage(chatId, { text: "❌ Group only command." }, { quoted: msg });

  try {
    const groupMeta = await sock.groupMetadata(chatId);
    const sender = msg.key.participant || msg.key.remoteJid;
    const isSenderAdmin = groupMeta.participants.find(p => p.id === sender)?.admin;

    if (!isSenderAdmin) {
      return await sock.sendMessage(chatId, { text: "❌ *Admins only - hidetag.*\n\n> *POWERED BY ETIAS-TECH*" }, { quoted: msg });
    }

    const participants = groupMeta.participants.map(p => p.id);

    // Get text from args or quoted message
    let text = args.join(" ");

    // If reply to a message, use that message content
    if (!text && msg.message?.extendedTextMessage?.contextInfo?.quotedMessage) {
      const q = msg.message.extendedTextMessage.contextInfo.quotedMessage;
      text = q.conversation || q.extendedTextMessage?.text || q.imageMessage?.caption || q.videoMessage?.caption || "";
    }

    if (!text) {
      return await sock.sendMessage(chatId, {
        text: `╭━━━〔 *${BOT_NAME} HIDETAG* 〕━━━┈⊷\n┃\n┃ ❌ Usage:.hidetag <message>\n┃ Or reply to message with.hidetag\n┃ Example:.hidetag Hello everyone\n┃\n╰━━━━━━━━━━━━━━┈⊷\n\n> *POWERED BY ETIAS-TECH*`
      }, { quoted: msg });
    }

    try { await sock.sendMessage(chatId, { react: { text: "🔊", key: msg.key } }); } catch {}

    // Check if quoted message has media - if yes, resend that media with hidetag
    const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    const quotedType = quoted? Object.keys(quoted)[0] : null;

    if (quotedType === 'imageMessage') {
      const caption = text || quoted.imageMessage.caption || "";
      await sock.sendMessage(chatId, {
        image: { url: quoted.imageMessage.url || await sock.downloadMediaMessage({ message: quoted }) },
        caption: caption,
        mentions: participants
      }, { quoted: msg });
    } else if (quotedType === 'videoMessage') {
      const caption = text || quoted.videoMessage.caption || "";
      await sock.sendMessage(chatId, {
        video: { url: quoted.videoMessage.url || await sock.downloadMediaMessage({ message: quoted }) },
        caption: caption,
        mentions: participants
      }, { quoted: msg });
    } else {
      // Plain text hidetag - invisible mentions
      await sock.sendMessage(chatId, {
        text: text,
        mentions: participants
      }, { quoted: msg });
    }

    // Confirmation with bot image card (optional - delete if you don't want extra msg)
    const confirmText = `
╭━━━〔 *${BOT_NAME} HIDETAG* 〕━━━┈⊷
┃
┃ ✅ *Sent to:* ${participants.length} members
┃ 💬 *Message:* ${text.slice(0, 50)}${text.length > 50? '...' : ''}
┃ 👤 *By:* @${sender.split('@')[0]}
┃
╰━━━━━━━━━━━━━━━━━━┈⊷
> *POWERED BY ETIAS-TECH*
`;
    // Uncomment below if you want confirmation card:
    // if (fs.existsSync(BOT_IMAGE_PATH)) {
    // await sock.sendMessage(chatId, {
    // image: fs.readFileSync(BOT_IMAGE_PATH),
    // caption: confirmText,
    // mentions: [sender]
    // });
    // }

  } catch (e) {
    console.log('[HIDETAG ERROR]', e.message);
    await sock.sendMessage(chatId, { text: `❌ Hidetag failed: ${e.message}\n\n> *POWERED BY ETIAS-TECH*` }, { quoted: msg });
  }
};
