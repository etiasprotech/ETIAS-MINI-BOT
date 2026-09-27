const axios = require('axios');
const fs = require('fs');
const path = require('path');

const BOT_IMAGE_PATH = path.join(__dirname, '..', 'media/bot_image.png');
const BOT_NAME = "*ETIAS-MINI-BOT*";

const API_URL = "https://api.princetechn.com/api/fun/quotes?apikey=prince";

module.exports.name = "quote";
module.exports.aliases = ["quotes", "qoute"];
module.exports.execute = async (sock, msg) => {
  const chatId = msg.key.remoteJid;

  try { await sock.sendMessage(chatId, { react: { text: "💬", key: msg.key } }); } catch {}

  await sock.sendMessage(chatId, { text: `💬 _Fetching quote..._ ` }, { quoted: msg });

  let quote = null;
  let author = null;

  try {
    const res = await axios.get(API_URL, { timeout: 15000 });
    const data = res.data;

    // Try to parse all possible formats
    if (typeof data === 'string') {
      quote = data;
    } else if (data.quote) {
      quote = data.quote;
      author = data.author || data.from;
    } else if (data.result) {
      if (typeof data.result === 'string') {
        quote = data.result;
      } else {
        quote = data.result.quote || data.result.text;
        author = data.result.author;
      }
    } else if (data.data) {
      if (typeof data.data === 'string') {
        quote = data.data;
      } else {
        quote = data.data.quote || data.data.text;
        author = data.data.author;
      }
    } else if (data.text) {
      quote = data.text;
      author = data.author;
    } else {
      // last resort
      quote = data.message || JSON.stringify(data);
    }

  } catch (e) {
    console.log('[QUOTE API ERROR]', e.message);
  }

  // Fallback quotes
  if (!quote) {
    const fallback = [
      { text: "Believe you can and you're halfway there.", author: "Theodore Roosevelt" },
      { text: "Success is not final, failure is not fatal: it is the courage to continue that counts.", author: "Winston Churchill" },
      { text: "The only way to do great work is to love what you do.", author: "Steve Jobs" }
    ];
    const pick = fallback[Math.floor(Math.random() * fallback.length)];
    quote = pick.text;
    author = pick.author;
  }

  const quoteText = `
╭━━━〔 *${BOT_NAME} QUOTE* 〕━━━┈⊷
┃
┃ ✨ _"${quote}"_
┃
┃ ${author ? `— *${author}*` : ''}
┃
╰━━━━━━━━━━━━━━━━━━┈⊷

> *POWERED BY ETIAS-TECH*
`;

  const footer = "*ETIAS-MINI-BOT • POWERED BY ETIAS-TECH*";
  const buttons = [
    { buttonId: '.quote', buttonText: { displayText: '✨ NEXT QUOTE' }, type: 1 },
    { buttonId: '.menu', buttonText: { displayText: '📜 MENU' }, type: 1 }
  ];

  try {
    if (fs.existsSync(BOT_IMAGE_PATH)) {
      const img = fs.readFileSync(BOT_IMAGE_PATH);
      await sock.sendMessage(chatId, {
        image: img,
        caption: quoteText,
        footer: footer,
        buttons: buttons,
        headerType: 4
      }, { quoted: msg });
    } else {
      await sock.sendMessage(chatId, {
        text: quoteText,
        footer: footer,
        buttons: buttons,
        headerType: 1
      }, { quoted: msg });
    }
  } catch (e) {
    console.log('[QUOTE SEND ERROR]', e.message);
    await sock.sendMessage(chatId, { text: quoteText }, { quoted: msg });
  }
};
