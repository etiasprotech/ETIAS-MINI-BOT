const fs = require('fs');
const path = require('path');
const axios = require('axios');
const yts = require('yt-search');

const BOT_IMAGE_PATH = path.join(__dirname, '..', 'media/bot_image.png');
const BOT_NAME = "*ETIAS-MINI-BOT*";

const API_BASE = "https://api.princetechn.com/api/download/ytv?apikey=prince&url=";

module.exports.name = "video";
module.exports.aliases = ["ytv", "ytmp4", "mp4"];
module.exports.execute = async (sock, msg, args) => {
  const chatId = msg.key.remoteJid;
  const query = args.join(" ");

  if (!query) {
    return await sock.sendMessage(chatId, {
      text: `🎬 *Usage:*.video <name or youtube link>\nExample:.video faded alan walker\nOr:.video https://youtu.be/60ItHLz5WEA\n\n> POWERED BY ETIAS-TECH`
    }, { quoted: msg });
  }

  try { await sock.sendMessage(chatId, { react: { text: "🎬", key: msg.key } }); } catch {}
  await sock.sendMessage(chatId, { text: `🔍 _Searching *${query}*..._` }, { quoted: msg });

  try {
    let ytUrl = query;
    let videoInfo = null;

    // If not a link, search youtube
    if (!query.includes('youtu.be') &&!query.includes('youtube.com')) {
      const search = await yts(query);
      if (!search.videos.length) {
        return await sock.sendMessage(chatId, { text: `❌ No results found for: ${query}` }, { quoted: msg });
      }
      videoInfo = search.videos[0];
      ytUrl = videoInfo.url;
    } else {
      // If link, still get info for thumbnail
      try {
        const search = await yts({ videoId: ytUrl.split('/').pop().split('?')[0].split('&')[0] });
        videoInfo = search;
      } catch {}
    }

    await sock.sendMessage(chatId, { text: `⬇️ _Downloading video..._\n${videoInfo? videoInfo.title : ytUrl}` }, { quoted: msg });

    // 2. Call your API
    const apiRes = await axios.get(API_BASE + encodeURIComponent(ytUrl), { timeout: 90000 });
    const data = apiRes.data;

    // Handle various formats
    let videoDownloadUrl = data.download_url || data.downloadUrl || data.result || data.url || data.link || data.videoUrl;
    if (typeof data === 'string') videoDownloadUrl = data;
    if (data.data) videoDownloadUrl = data.data.download_url || data.data.url || data.data.downloadUrl || data.data;

    // Prince API sometimes returns { success:true, result: { download_url, title,... } }
    if (data.result && typeof data.result === 'object') {
      videoDownloadUrl = data.result.download_url || data.result.url;
      if (!videoInfo) videoInfo = { title: data.result.title || "YouTube Video" };
    }

    if (!videoDownloadUrl) {
      console.log('[VIDEO API RESPONSE]', JSON.stringify(data).slice(0, 1000));
      return await sock.sendMessage(chatId, { text: `❌ Failed to get download link.\nResponse: ${JSON.stringify(data).slice(0, 300)}` }, { quoted: msg });
    }

    // 3. Send as video
    await sock.sendMessage(chatId, {
      video: { url: videoDownloadUrl },
      mimetype: 'video/mp4',
      caption: `*${videoInfo?.title || "YouTube Video"}*\n\n> POWERED BY ETIAS-TECH`,
      fileName: `${videoInfo?.title || "video"}.mp4`
    }, { quoted: msg });

    // 4. Info card with bot image + footer + buttons
    const infoText = `
╭━━━〔 *${BOT_NAME} VIDEO* 〕━━━┈⊷
┃
┃ 🎬 *Title:* ${(videoInfo?.title || "YouTube Video").slice(0, 60)}
┃ 👤 *Channel:* ${videoInfo?.author?.name || "YouTube"}
┃ ⏱️ *Duration:* ${videoInfo?.timestamp || "Unknown"}
┃ 🔗 *Link:* ${ytUrl}
┃
┃ ✅ *Sent as Video*
┃
╰━━━━━━━━━━━━━━━━━━┈⊷

> *POWERED BY ETIAS-TECH*
`;
    const footer = "ETIAS-AI • POWERED BY ETIAS-TECH";
    const buttons = [
      { buttonId: `.play ${query}`, buttonText: { displayText: '🎧 GET AUDIO' }, type: 1 },
      { buttonId: `.song ${query}`, buttonText: { displayText: '📄 AS DOCUMENT' }, type: 1 }
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
    console.log('[VIDEO ERROR]', e.message, e.response?.data);
    await sock.sendMessage(chatId, { text: `❌ Error: ${e.message}\n> POWERED BY ETIAS-TECH` }, { quoted: msg });
  }
};
