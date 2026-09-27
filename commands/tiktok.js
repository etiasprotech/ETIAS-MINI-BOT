const fs = require('fs');
const path = require('path');
const axios = require('axios');

const BOT_IMAGE_PATH = path.join(__dirname, '..', 'media/bot_image.png');
const BOT_NAME = "*ETIAS-MINI-BOT*";

const APIS = [
  { name: "v4", url: "https://api.princetechn.com/api/download/tiktokdlv4?apikey=prince&url=" },
  { name: "v3", url: "https://api.princetechn.com/api/download/tiktokdlv3?apikey=prince&url=" },
  { name: "v2", url: "https://api.princetechn.com/api/download/tiktokdlv2?apikey=prince&url=" },
  { name: "v1", url: "https://api.princetechn.com/api/download/tiktok?apikey=prince&url=" }
];

module.exports.name = "tiktok";
module.exports.aliases = ["ttdl", "tikdl"];
module.exports.execute = async (sock, msg, args) => {
  const chatId = msg.key.remoteJid;
  const url = args[0];

  if (!url ||!url.includes('tiktok')) {
    return await sock.sendMessage(chatId, {
      text: `🎵 *Usage:*.tiktok <tiktok link>\nExample:.tiktok https://vm.tiktok.com/ZMrgKWmVd\n\n> POWERED BY ETIAS-TECH`
    }, { quoted: msg });
  }

  try { await sock.sendMessage(chatId, { react: { text: "🎵", key: msg.key } }); } catch {}

  let videoUrl = null;
  let audioUrl = null;
  let title = "TikTok Video";
  let author = "TikTok";
  let thumb = null;
  let successApi = null;

  for (let api of APIS) {
    try {
      await sock.sendMessage(chatId, { text: `⬇️ _Trying ${api.name}..._ ` }, { quoted: msg });

      const res = await axios.get(api.url + encodeURIComponent(url), { timeout: 60000 });
      const data = res.data;

      // Debug log
      // console.log(`[TT ${api.name}]`, JSON.stringify(data).slice(0, 500));

      // Parse all possible formats
      if (typeof data === 'string') videoUrl = data;

      if (data.download_url) videoUrl = data.download_url;
      if (data.downloadUrl) videoUrl = data.downloadUrl;
      if (data.video) videoUrl = data.video;
      if (data.url) videoUrl = data.url;

      if (data.data) {
        videoUrl = data.data.download_url || data.data.url || data.data.video || data.data.play || videoUrl;
        audioUrl = data.data.music || data.data.audio || audioUrl;
        title = data.data.title || data.data.desc || title;
        author = data.data.author || data.data.nickname || author;
        thumb = data.data.thumbnail || data.data.cover || thumb;
      }

      if (data.result) {
        if (typeof data.result === 'string') {
          videoUrl = data.result;
        } else {
          videoUrl = data.result.download_url || data.result.video || data.result.nowm || data.result.wm || data.result.url || videoUrl;
          audioUrl = data.result.music || data.result.audio || audioUrl;
          title = data.result.title || data.result.desc || title;
          author = data.result.author || author;
        }
      }

      // Array format
      if (data.videos && Array.isArray(data.videos)) videoUrl = data.videos[0];

      if (videoUrl) {
        successApi = api.name;
        break; // Success, stop loop
      }

    } catch (e) {
      console.log(`[TT ${api.name} FAIL]`, e.message);
      continue;
    }
  }

  if (!videoUrl) {
    return await sock.sendMessage(chatId, { text: `❌ All 4 TikTok APIs failed (v4,v3,v2,v1).\n> *POWERED BY ETIAS-TECH*` }, { quoted: msg });
  }

  try {
    // Send video
    await sock.sendMessage(chatId, {
      video: { url: videoUrl },
      mimetype: 'video/mp4',
      caption: `*${title}*\n👤 ${author}\n\n✅ *Downloaded via ${successApi.toUpperCase()}*\n> *POWERED BY ETIAS-TECH*`
    }, { quoted: msg });

    // Info card
    const infoText = `
╭━━━〔 *${BOT_NAME} TIKTOK* 〕━━━┈⊷
┃
┃ 🎵 *Title:* ${title.slice(0, 80)}
┃ 👤 *Author:* ${author}
┃ 🔗 *Link:* ${url.slice(0, 50)}...
┃ ⚡ *API:* ${successApi.toUpperCase()} (v4→v1 cascade)
┃ ✅ *Status:* Downloaded [No Watermark]
┃
╰━━━━━━━━━━━━━━━━━━┈⊷

> *POWERED BY ETIAS-TECH*
`;
    const footer = "*ETIAS-MINI-BOT • POWERED BY ETIAS-TECH*";
    const buttons = [
      { buttonId: `.tiktok ${url}`, buttonText: { displayText: '🔄 RE-DOWNLOAD' }, type: 1 },
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
    console.log('[TT SEND ERROR]', e.message);
    await sock.sendMessage(chatId, { text: `❌ Send error: ${e.message}` }, { quoted: msg });
  }
};
