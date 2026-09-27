const axios = require('axios');
const fs = require('fs');
const path = require('path');

const BOT_IMAGE_PATH = path.join(__dirname, '..', 'media/bot_image.png');
const BOT_NAME = "*ETIAS-MINI-BOT*";

const API_URL = "https://api.princetechn.com/api/fun/jokes?apikey=prince";

module.exports.name = "joke";
module.exports.aliases = ["jokes", "funny"];
module.exports.execute = async (sock, msg) => {
  const chatId = msg.key.remoteJid;

  try { await sock.sendMessage(chatId, { react: { text: "😂", key: msg.key } }); } catch {}

  await sock.sendMessage(chatId, { text: `😂 _Fetching joke..._ ` }, { quoted: msg });

  let joke = null;

  try {
    const res = await axios.get(API_URL, { timeout: 15000 });
    const data = res.data;

    // Handle different possible response formats
    if (typeof data === 'string') {
      joke = data;
    } else if (data.joke) {
      joke = data.joke;
    } else if (data.result) {
      joke = data.result;
    } else if (data.data) {
      joke = data.data;
    } else if (data.message && typeof data.message === 'string') {
      joke = data.message;
    } else {
      joke = JSON.stringify(data);
    }

  } catch (e) {
    console.log('[JOKE API ERROR]', e.message);
  }

  // Fallback jokes if API fails
  if (!joke) {
    const fallbackJokes = [
      "Why don't scientists trust atoms? Because they make up everything!",
      "I told my computer I needed a break, and it said 'No problem, I'll go to sleep!'",
      "Why did the scarecrow win an award? He was outstanding in his field!",
      "I used to play piano by ear, but now I use my hands."
    ];
    joke = fallbackJokes[Math.floor(Math.random() * fallbackJokes.length)];
  }

  const jokeText = `
╭━━━〔 *${BOT_NAME} JOKE* 〕━━━┈⊷
┃
┃ 😂 *Here's one for you:*
┃
┃ ${joke}
┃
╰━━━━━━━━━━━━━━━━━━┈⊷

> *POWERED BY ETIAS-TECH*
`;

  const footer = "*ETIAS-AI • POWERED BY ETIAS-TECH*";
  const buttons = [
    { buttonId: '.joke', buttonText: { displayText: '😂 NEXT JOKE' }, type: 1 },
    { buttonId: '.menu', buttonText: { displayText: '📜 MENU' }, type: 1 }
  ];

  try {
    if (fs.existsSync(BOT_IMAGE_PATH)) {
      const img = fs.readFileSync(BOT_IMAGE_PATH);
      await sock.sendMessage(chatId, {
        image: img,
        caption: jokeText,
        footer: footer,
        buttons: buttons,
        headerType: 4
      }, { quoted: msg });
    } else {
      await sock.sendMessage(chatId, {
        text: jokeText,
        footer: footer,
        buttons: buttons,
        headerType: 1
      }, { quoted: msg });
    }
  } catch (e) {
    console.log('[JOKE SEND ERROR]', e.message);
    await sock.sendMessage(chatId, { text: jokeText }, { quoted: msg });
  }
};
