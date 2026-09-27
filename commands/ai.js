require('dotenv').config();
const { GoogleGenerativeAI } = require("@google/generative-ai");
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
 // <- PUT YOUR KEY
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

module.exports.name = "ai";
module.exports.execute = async (sock, msg, args) => {
  const chatId = msg.key.remoteJid;
  const query = args.join(' ').trim();

  if (!query) {
    await sock.sendMessage(chatId, { text: "🤖 Usage: .ai <question>" }, { quoted: msg });
    return;
  }

  try {
    await sock.sendPresenceUpdate('composing', chatId);

    const model = genAI.getGenerativeModel({
        model: "gemini-3.6-flash"
    });

    const result = await model.generateContent(`You are ETIAS-AI by ETIAS-TECH. Be helpful, short, friendly. Question: ${query}`);
    const text = result.response.text();

    const reply = `┏━━━━━━━━━━━━━━━━━━━━┓
┃ 🤖 *ETIAS-AI* ┃
┗━━━━━━━━━━━━━━━━━━━━┛

${text}

> *POWERED BY ETIAS-TECH*`;

    await sock.sendMessage(chatId, { text: reply }, { quoted: msg });

  } catch (err) {
    console.log('[AI ERROR]', err.message);

    // Auto fallback to your working models
    try {
      const fallback = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
      const res2 = await fallback.generateContent(query);
      await sock.sendMessage(chatId, { text: res2.response.text() }, { quoted: msg });
    } catch (e) {
      try {
        const fallback2 = genAI.getGenerativeModel({ model: "gemini-flash-latest" });
        const res3 = await fallback2.generateContent(query);
        await sock.sendMessage(chatId, { text: res3.response.text() }, { quoted: msg });
      } catch (e2) {
        await sock.sendMessage(chatId, { text: `❌ AI Error: ${err.message}` }, { quoted: msg });
      }
    }
  }
};
