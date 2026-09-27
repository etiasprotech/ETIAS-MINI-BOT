const fs = require('fs');
const path = require('path');
const os = require('os');

const BOT_IMAGE_PATH = path.join(__dirname, '..', 'media/bot_image.png');
const BOT_NAME = "*ETIAS-MINI-BOT*";

module.exports.name = "alive";
module.exports.aliases = ["bot", "online"];
module.exports.execute = async (sock, msg) => {
  const chatId = msg.key.remoteJid;

  try { await sock.sendMessage(chatId, { react: { text: "🤖", key: msg.key } }); } catch {}

  const uptime = process.uptime();
  const h = Math.floor(uptime / 3600);
  const m = Math.floor((uptime % 3600) / 60);
  const s = Math.floor(uptime % 60);

  const aliveText = `
╭━━━〔 *${BOT_NAME} IS ALIVE* 〕━━━┈⊷
┃
┃ 🤖 *Bot:* ${BOT_NAME}
┃ 👑 *Owner:* ETIAS-TECH
┃ 📡 *Status:* Online ✅
┃ ⏱️ *Uptime:* ${h}h ${m}m ${s}s
┃ 🔧 *Version:* 2.0.0
┃ 🌐 *Mode:* Public
┃ 💾 *RAM:* ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)}MB
┃
┃ >  _I'm alive and ready to rock!_
╰━━━━━━━━━━━━━━━━━━┈⊷

> *POWERED BY ETIAS-TECH*
`;

  const footer = "*ETIAS-MINI-BOT • POWERED BY ETIAS-TECH*";

  const buttons = [
    { buttonId: '.menu', buttonText: { displayText: '📜 MENU' }, type: 1 },
    { buttonId: '.ping', buttonText: { displayText: '🚀 PING' }, type: 1 }
  ];

  try {
    if (fs.existsSync(BOT_IMAGE_PATH)) {
      const imageBuffer = fs.readFileSync(BOT_IMAGE_PATH);
      await sock.sendMessage(chatId, {
        image: imageBuffer,
        caption: aliveText,
        footer: footer,
        buttons: buttons,
        headerType: 4
      }, { quoted: msg });
    } else {
      await sock.sendMessage(chatId, {
        text: aliveText,
        footer: footer,
        buttons: buttons,
        headerType: 1
      }, { quoted: msg });
    }
  } catch (e) {
    console.log('[ALIVE ERROR]', e.message);
    await sock.sendMessage(chatId, { text: aliveText }, { quoted: msg });
  }
};
