const fs = require('fs');
const path = require('path');

const BOT_IMAGE_PATH = path.join(__dirname, '..', 'media/bot_image.png');
const BOT_NAME = "*ETIAS-MINI-BOT*";

const OWNER_NAME = "ETIAS-TECH";
const OWNER_NUMBER = "263778810589"; // no +
const OWNER_JID = `${OWNER_NUMBER}@s.whatsapp.net`;

module.exports.name = "owner";
module.exports.aliases = ["creator", "dev"];
module.exports.execute = async (sock, msg) => {
  const chatId = msg.key.remoteJid;

  try { await sock.sendMessage(chatId, { react: { text: "👑", key: msg.key } }); } catch {}

  const ownerText = `
╭━━━〔 *${BOT_NAME} OWNER* 〕━━━┈⊷
┃
┃ 👑 *Name:* ${OWNER_NAME}
┃ 📞 *Number:* +${OWNER_NUMBER}
┃ 🤖 *Bot:* ${BOT_NAME}
┃ 💎 *Role:* Developer & Owner
┃ 🌐 *Status:* Available
┃
┃ > _Contact for bot issues / paid promotion_
╰━━━━━━━━━━━━━━━━━━┈⊷

> *POWERED BY ETIAS-TECH*
`;

  const footer = "*ETIAS-MINI-BOT • POWERED BY ETIAS-TECH*";

  const buttons = [
    { buttonId: '.menu', buttonText: { displayText: '📜 MENU' }, type: 1 },
    { buttonId: '.ping', buttonText: { displayText: '🚀 PING' }, type: 1 }
  ];

  // vCard for contact
  const vcard = `BEGIN:VCARD
VERSION:3.0
FN:${OWNER_NAME}
ORG:${BOT_NAME};
TEL;type=CELL;type=VOICE;waid=${OWNER_NUMBER}:+${OWNER_NUMBER}
END:VCARD`;

  try {
    // 1. Send image + info with buttons
    if (fs.existsSync(BOT_IMAGE_PATH)) {
      const imageBuffer = fs.readFileSync(BOT_IMAGE_PATH);
      await sock.sendMessage(chatId, {
        image: imageBuffer,
        caption: ownerText,
        footer: footer,
        buttons: buttons,
        headerType: 4
      }, { quoted: msg });
    } else {
      await sock.sendMessage(chatId, {
        text: ownerText,
        footer: footer,
        buttons: buttons,
        headerType: 1
      }, { quoted: msg });
    }

    // 2. Send owner contact
    await sock.sendMessage(chatId, {
      contacts: {
        displayName: OWNER_NAME,
        contacts: [{ vcard }]
      }
    }, { quoted: msg });

  } catch (e) {
    console.log('[OWNER ERROR]', e.message);
    // Fallback plain
    await sock.sendMessage(chatId, { text: ownerText }, { quoted: msg });
    await sock.sendMessage(chatId, {
      contacts: {
        displayName: OWNER_NAME,
        contacts: [{ vcard }]
      }
    }).catch(()=>{});
  }
};
