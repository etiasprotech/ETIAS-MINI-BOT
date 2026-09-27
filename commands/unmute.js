const fs = require('fs');
const path = require('path');
const BOT_IMAGE_PATH = path.join(__dirname, '..', 'media/bot_image.png');
module.exports.name = "unmute";
module.exports.aliases = ["open", "groupopen", "unlock"];
module.exports.execute = async (sock, msg) => {
  const chatId = msg.key.remoteJid;
  if (!chatId.endsWith('@g.us')) return;
  const groupMeta = await sock.groupMetadata(chatId);
  const sender = msg.key.participant || msg.key.remoteJid;
  const botId = sock.user.id.split(':')[0] + '@s.whatsapp.net';
  if (!groupMeta.participants.find(p => p.id === sender)?.admin) return await sock.sendMessage(chatId, { text: "❌ Admins only." }, { quoted: msg });
  if (!groupMeta.participants.find(p => p.id === botId)?.admin) return await sock.sendMessage(chatId, { text: "❌ Bot must be admin." }, { quoted: msg });
  await sock.groupSettingUpdate(chatId, 'not_announcement');
  const text = `╭━━━〔 *ETIAS-MINI-BOT UNMUTE* 〕━━━┈⊷\n┃\n┃ 🔓 *Action:* Group Opened\n┃ 🏷️ *Group:* ${groupMeta.subject.slice(0, 30)}\n┃ 👤 *By:* @${sender.split('@')[0]}\n┃ 📝 *Info:* Everyone can chat now\n┃\n╰━━━━━━━━━━━━━━┈⊷\n\n> *POWERED BY ETIAS-TECH*`;
  if (fs.existsSync(BOT_IMAGE_PATH)) {
    await sock.sendMessage(chatId, { image: fs.readFileSync(BOT_IMAGE_PATH), caption: text, footer: "*ETIAS-MINI-BOT • POWERED BY ETIAS-TECH*", buttons: [{ buttonId: '.mute', buttonText: { displayText: '🔒 MUTE' }, type: 1 }, { buttonId: '.tagall', buttonText: { displayText: '👥 TAGALL' }, type: 1 }], headerType: 4, mentions: [sender] }, { quoted: msg });
  } else {
    await sock.sendMessage(chatId, { text: text, mentions: [sender] }, { quoted: msg });
  }
};
