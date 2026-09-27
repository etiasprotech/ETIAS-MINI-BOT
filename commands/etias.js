const axios = require('axios');
const fs = require('fs');
const path = require('path');

const BASE_URL = "https://api-etias-ai.onrender.com/";
const API_KEY = "etias_c76121f2630667b7e0499f221543e7389fabffb2e048d095"; // Replace with your real key
const BOT_IMAGE_PATH = path.join(__dirname, '..', 'media/bot_image.png');
const BOT_NAME = "*ETIAS-MINI-BOT*";

module.exports.name = "etias";
module.exports.aliases = ["etiasai", "gpt", "ask"];
module.exports.execute = async (sock, msg, args) => {
  const chatId = msg.key.remoteJid;
  const text = args.join(" ").trim();
  const sender = msg.key.participant || msg.key.remoteJid;

  if (!text) {
    const helpText = `
╭━━━〔 *${BOT_NAME} API* 〕━━━┈⊷
┃
┃ 🤖 *ETIAS-AI Commands*
┃
┃.etias <question> - Chat with AI
┃.etias image <prompt> - Generate image
┃.etias code <prompt> - Code help
┃.etias status - API status
┃
┃ *Examples:*
┃.etias what is quantum physics?
┃.etias image a cyberpunk cat
┃.etias code make a welcome.js
┃
╰━━━━━━━━━━━━━━━━━━┈⊷

> *Base: ${BASE_URL}*
> *POWERED BY ETIAS-TECH*
`;
    const footer = "*ETIAS-MINI-BOT • POWERED BY ETIAS-TECH*";
    const buttons = [
      { buttonId: '.etias status', buttonText: { displayText: '📊 STATUS' }, type: 1 },
      { buttonId: '.etias hello', buttonText: { displayText: '💬 CHAT' }, type: 1 }
    ];

    if (fs.existsSync(BOT_IMAGE_PATH)) {
      return await sock.sendMessage(chatId, { image: fs.readFileSync(BOT_IMAGE_PATH), caption: helpText, footer: footer, buttons: buttons, headerType: 4 }, { quoted: msg });
    } else {
      return await sock.sendMessage(chatId, { text: helpText, footer: footer, buttons: buttons, headerType: 1 }, { quoted: msg });
    }
  }

  // STATUS CHECK
  if (text.toLowerCase() === "status") {
    try {
      const res = await axios.get(`${BASE_URL}/status`, {
        headers: { "x-api-key": API_KEY, "Authorization": `Bearer ${API_KEY}` },
        timeout: 10000
      });
      return await sock.sendMessage(chatId, { text: `╭━━━〔 *API STATUS* 〕━━━\n┃ ✅ Online\n┃ URL: ${BASE_URL}\n┃ Response: ${JSON.stringify(res.data).slice(0,300)}\n╰━━━━━━━━━━━━\n\n> *POWERED BY ETIAS-TECH*` }, { quoted: msg });
    } catch (e) {
      return await sock.sendMessage(chatId, { text: `❌ API Offline: ${e.message}\n\n> *POWERED BY ETIAS-TECH*` }, { quoted: msg });
    }
  }

  // IMAGE GENERATION
  if (text.toLowerCase().startsWith("image ")) {
    const prompt = text.slice(6).trim();
    if (!prompt) return await sock.sendMessage(chatId, { text: "❌ Provide prompt:.etias image a cat" }, { quoted: msg });

    try {
      await sock.sendMessage(chatId, { text: `🎨 *Generating image...*\nPrompt: ${prompt}\n\n> *POWERED BY ETIAS-TECH*` }, { quoted: msg });

      const res = await axios.post(`${BASE_URL}/image/generate`, {
        prompt: prompt,
        model: "etias-v2",
        n: 1,
        size: "1024x1024"
      }, {
        headers: { "x-api-key": API_KEY, "Authorization": `Bearer ${API_KEY}`, "Content-Type": "application/json" },
        timeout: 60000
      });

      const imageUrl = res.data?.data?.[0]?.url || res.data?.url || res.data?.image;

      if (!imageUrl) throw new Error("No image URL in response");

      // If url is base64
      if (imageUrl.startsWith("data:") || imageUrl.length > 1000 &&!imageUrl.startsWith("http")) {
        const buffer = Buffer.from(imageUrl.split(",").pop(), 'base64');
        await sock.sendMessage(chatId, { image: buffer, caption: `🎨 *Prompt:* ${prompt}\n\n> *POWERED BY ETIAS-TECH*` }, { quoted: msg });
      } else {
        await sock.sendMessage(chatId, { image: { url: imageUrl }, caption: `🎨 *Prompt:* ${prompt}\n\n> *POWERED BY ETIAS-TECH*` }, { quoted: msg });
      }

    } catch (e) {
      await sock.sendMessage(chatId, { text: `❌ Image failed: ${e.response?.data?.message || e.message}\n\n> *POWERED BY ETIAS-TECH*` }, { quoted: msg });
    }
    return;
  }

  // CHAT / CODE
  try {
    await sock.sendMessage(chatId, { text: `⏳ *${BOT_NAME} thinking...*` }, { quoted: msg });

    const payload = {
      model: "etias-ai-v2",
      messages: [
        { role: "system", content: "You are ETIAS-AI, a powerful WhatsApp bot assistant. Powered by ETIAS-TECH. Be helpful, concise." },
        { role: "user", content: text }
      ],
      temperature: 0.7,
      max_tokens: 2000
    };

    const res = await axios.post(`${BASE_URL}/chat/completions`, payload, {
      headers: {
        "x-api-key": API_KEY,
        "Authorization": `Bearer ${API_KEY}`,
        "Content-Type": "application/json"
      },
      timeout: 30000
    });

    let reply = res.data?.choices?.[0]?.message?.content || res.data?.reply || res.data?.response || res.data?.message || JSON.stringify(res.data).slice(0,1000);

    if (!reply) reply = "❌ No response from API.";

    const finalText = `
╭━━━〔 *${BOT_NAME}* 〕━━━┈⊷
┃
${reply}
┃
╰━━━━━━━━━━━━━━━━━━┈⊷

> *POWERED BY ETIAS-TECH*
`;

    await sock.sendMessage(chatId, { text: finalText }, { quoted: msg });

  } catch (e) {
    const errMsg = e.response?.data? JSON.stringify(e.response.data).slice(0,500) : e.message;
    await sock.sendMessage(chatId, { text: `❌ *API Error*\n\n${errMsg}\n\nBase: ${BASE_URL}\n\n> *POWERED BY ETIAS-TECH*` }, { quoted: msg });
  }
};
