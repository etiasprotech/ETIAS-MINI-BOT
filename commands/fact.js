const axios = require('axios');
const fs = require('fs');
const path = require('path');

const BOT_IMAGE_PATH = path.join(__dirname, '..', 'media/bot_image.png');
const BOT_NAME = "*ETIAS-MINI-BOT*";

const FACT_APIS = [
  'https://uselessfacts.jsph.pl/random.json?language=en',
  'https://api.api-ninjas.com/v1/facts',
  'https://catfact.ninja/fact'
];

module.exports.name = "fact";
module.exports.aliases = ["facts", "randomfact"];
module.exports.execute = async (sock, msg) => {
  const chatId = msg.key.remoteJid;

  try { await sock.sendMessage(chatId, { react: { text: "🧠", key: msg.key } }); } catch {}

  await sock.sendMessage(chatId, { text: `🧠 _Fetching amazing fact..._ ` }, { quoted: msg });

  let fact = null;

  try {
    // Try uselessfacts - best format
    const res = await axios.get(FACT_APIS[0], { timeout: 10000 });
    fact = res.data?.text;
  } catch {
    try {
      const res2 = await axios.get('https://catfact.ninja/fact', { timeout: 10000 });
      fact = res2.data?.fact;
    } catch (e) {
      console.log('[FACT API ERROR]', e.message);
      fact = null;
    }
  }

  // Local fallback facts
  if (!fact) {
    const localFacts = [
      "Octopuses have 3 hearts and blue blood.",
      "Honey never spoils. 3000-year-old honey is still edible.",
      "Your brain generates about 20 watts of power.",
      "Water can boil and freeze at the same time at 0.01°C.",
      "Bananas are berries but strawberries aren't.",
      "A day on Venus is longer than a year on Venus.",
      "Humans share 50% DNA with bananas.",
      "Light from the sun takes 8 minutes to reach Earth."
    ];
    fact = localFacts[Math.floor(Math.random() * localFacts.length)];
  }

  const factText = `
╭━━━〔 *${BOT_NAME} FACT* 〕━━━┈⊷
┃
┃ 🧠 *Did You Know?*
┃
┃ ${fact}
┃
╰━━━━━━━━━━━━━━━━━━┈⊷

> *POWERED BY ETIAS-TECH*
`;

  const footer = "*ETIAS-MINI-BOT • POWERED BY ETIAS-TECH*";
  const buttons = [
    { buttonId: '.fact', buttonText: { displayText: '🔄 NEXT FACT' }, type: 1 },
    { buttonId: '.menu', buttonText: { displayText: '📜 MENU' }, type: 1 }
  ];

  try {
    if (fs.existsSync(BOT_IMAGE_PATH)) {
      const img = fs.readFileSync(BOT_IMAGE_PATH);
      await sock.sendMessage(chatId, {
        image: img,
        caption: factText,
        footer: footer,
        buttons: buttons,
        headerType: 4
      }, { quoted: msg });
    } else {
      await sock.sendMessage(chatId, {
        text: factText,
        footer: footer,
        buttons: buttons,
        headerType: 1
      }, { quoted: msg });
    }
  } catch (e) {
    console.log('[FACT ERROR]', e.message);
    await sock.sendMessage(chatId, { text: factText }, { quoted: msg });
  }
};
