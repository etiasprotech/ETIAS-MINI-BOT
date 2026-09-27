const fs = require('fs');
const path = require('path');
const axios = require('axios');

const BOT_IMAGE_PATH = path.join(__dirname, '..', 'media/bot_image.png');
const BOT_NAME = "*ETIAS-MINI-BOT*";

const API_V2 = "https://api.princetechn.com/api/download/facebookv2?apikey=prince&url=";
const API_V1 = "https://api.princetechn.com/api/download/facebook?apikey=prince&url=";

module.exports.name = "fb";
module.exports.aliases = ["facebook", "fbdl", "facebookdl"];
module.exports.execute = async (sock, msg, args) => {
  const chatId = msg.key.remoteJid;
  const url = args[0];

  if (!url ||!url.includes('facebook.com')) {
    return await sock.sendMessage(chatId, {
      text: `📘 *Usage:*.fb <facebook link>\nExample:.fb https://www.facebook.com/reel/402579285704851\n\n> *POWERED BY ETIAS-TECH*`
    }, { quoted: msg });
  }

  try { await sock.sendMessage(chatId, { react: { text: "📘", key: msg.key } }); } catch {}
  await sock.sendMessage(chatId, { text: `⬇️ _Downloading Facebook video..._\nTrying v2...` }, { quoted: msg });

  let videoUrl = null;
  let title = "Facebook Video";
  let apiUsed = "v2";

  try {
    // TRY V2 FIRST
    const resV2 = await axios.get(API_V2 + encodeURIComponent(url), { timeout: 60000 });
    const data = resV2.data;

    videoUrl = data.download_url || data.downloadUrl || data.result || data.url || data.link;
    if (typeof data === 'string') videoUrl = data;
    if (data.data) videoUrl = data.data.download_url || data.data.url || data.data.downloadUrl || data.data;
    if (data.result && typeof data.result === 'object') {
      videoUrl = data.result.download_url || data.result.url || data.result.sd || data.result.hd || videoUrl;
      title = data.result.title || title;
    }

    if (!videoUrl && Array.isArray(data.downloads)) {
      videoUrl = data.downloads[0]?.url;
    }

    // If v2 failed, throw to try v1
    if (!videoUrl) throw new Error("v2 no url");

  } catch (e) {
    console.log('[FB V2 FAIL]', e.message, '- trying v1...');
    await sock.sendMessage(chatId, { text: `⚠️ _v2 failed, trying v1..._` }, { quoted: msg });

    try {
      const resV1 = await axios.get(API_V1 + encodeURIComponent(url), { timeout: 60000 });
      const data = resV1.data;

      videoUrl = data.download_url || data.downloadUrl || data.result || data.url || data.link;
      if (typeof data === 'string') videoUrl = data;
      if (data.data) videoUrl = data.data.download_url || data.data.url || data.data.downloadUrl || data.data;
      if (data.result && typeof data.result === 'object') {
        videoUrl = data.result.download_url || data.result.url || data.result.sd || data.result.hd || videoUrl;
        title = data.result.title || title;
      }

      apiUsed = "v1";
    } catch (e2) {
      console.log('[FB V1 FAIL]', e2.message);
      return await sock.sendMessage(chatId, { text: `❌ Both v2 and v1 failed.\n> *POWERED BY ETIAS-TECH*` }, { quoted: msg });
    }
  }

  if (!videoUrl) {
    return await sock.sendMessage(chatId, { text: `❌ Could not get download link.` }, { quoted: msg });
  }

  try {
    // Send video
    await sock.sendMessage(chatId, {
      video: { url: videoUrl },
      mimetype: 'video/mp4',
      caption: `*${title}*\n\n✅ *Downloaded via FB ${apiUsed.toUpperCase()}*\n> *POWERED BY ETIAS-TECH*`,
      fileName: `facebook_${Date.now()}.mp4`
    }, { quoted: msg });

    // Info card
    const infoText = `
╭━━━〔 *${BOT_NAME} FBDL* 〕━━━┈⊷
┃
┃ 📘 *Source:* Facebook ${apiUsed.toUpperCase()}
┃ 🎬 *Title:* ${title.slice(0, 70)}
┃ 🔗 *Link:* ${url.slice(0, 50)}...
┃ ✅ *Status:* Downloaded
┃
╰━━━━━━━━━━━━━━━━━━┈⊷

> *POWERED BY ETIAS-TECH*
`;
    const footer = "*ETIAS-MINI-BOT • POWERED BY ETIAS-TECH*";
    const buttons = [
      { buttonId: `.fb ${url}`, buttonText: { displayText: '🔄 RE-DOWNLOAD' }, type: 1 },
      { buttonId: '.menu', buttonText: { displayText: '📜 MENU' }, type: 1 }
    ];

    if (fs.existsSync(BOT_IMAGE_PATH)) {
      const img = fs.readFileSync(BOT_IMAGE_PATH);
      await sock.sendMessage(chatId, {
        image: img,
        caption: infoText,
        footer: footer,
        buttons: buttons,
        headerType: 4
      }, { quoted: msg });
    } else {
      await sock.sendMessage(chatId, {
        text: infoText,
        footer: footer,
        buttons: buttons,
        headerType: 1
      }, { quoted: msg });
    }

  } catch (e) {
    console.log('[FB SEND ERROR]', e.message);
    await sock.sendMessage(chatId, { text: `❌ Send error: ${e.message}` }, { quoted: msg });
  }
};
