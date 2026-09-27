const fs = require('fs');
const path = require('path');
const axios = require('axios');
const yts = require('yt-search');

const BOT_IMAGE_PATH = path.join(__dirname, '..', 'media/bot_image.png');
const BOT_NAME = "*ETIAS-MINI-BOT*";

const API_BASE = "https://api.princetechn.com/api/download/ytmp4?apikey=prince&url=";

module.exports.name = "ytmp4";
module.exports.aliases = ["ytmp4hd", "mp4hd", "ytdoc"];
module.exports.execute = async (sock, msg, args) => {
  const chatId = msg.key.remoteJid;
  const query = args.join(" ");

  if (!query) {
    return await sock.sendMessage(chatId, {
      text: `📄 *Usage:*.ytmp4 <name or link>\nExample:.ytmp4 alan walker faded\nOr:.ytmp4 https://youtu.be/wdJrTQJh1ZQ\n\n> *POWERED BY ETIAS-TECH*`
    }, { quoted: msg });
  }

  try { await sock.sendMessage(chatId, { react: { text: "📄", key: msg.key } }); } catch {}
  await sock.sendMessage(chatId, { text: `🔍 _Searching *${query}*..._` }, { quoted: msg });

  try {
    let ytUrl = query;
    let videoInfo = null;

    // If not link, search
    if (!query.includes('youtu.be') &&!query.includes('youtube.com')) {
      const search = await yts(query);
      if (!search.videos.length) return await sock.sendMessage(chatId, { text: `❌ No results for: ${query}` }, { quoted: msg });
      videoInfo = search.videos[0];
      ytUrl = videoInfo.url;
    } else {
      try {
        const id = ytUrl.match(/(?:youtu\.be\/|v=)([^&?]+)/)?.[1];
        if (id) {
          const s = await yts({ videoId: id });
          videoInfo = s;
        }
      } catch {}
    }

    await sock.sendMessage(chatId, { text: `⬇️ _Downloading HD video as document..._\n${videoInfo?.title || ytUrl}` }, { quoted: msg });

    // Call Prince API
    const apiRes = await axios.get(API_BASE + encodeURIComponent(ytUrl), { timeout: 90000 });
    const data = apiRes.data;

    let videoUrl = data.download_url || data.downloadUrl || data.result || data.url || data.link;
    let title = videoInfo?.title || "YouTube Video";

    if (typeof data === 'string') videoUrl = data;
    if (data.data) {
      videoUrl = data.data.download_url || data.data.url || data.data.downloadUrl || videoUrl;
      title = data.data.title || title;
    }
    if (data.result && typeof data.result === 'object') {
      videoUrl = data.result.download_url || data.result.url || videoUrl;
      title = data.result.title || title;
    }

    if (!videoUrl) {
      console.log('[YTMP4 API]', JSON.stringify(data).slice(0, 1000));
      return await sock.sendMessage(chatId, { text: `❌ Failed to get download link.` }, { quoted: msg });
    }

    // Send as DOCUMENT (high quality, no WhatsApp compression)
    await sock.sendMessage(chatId, {
      document: { url: videoUrl },
      mimetype: 'video/mp4',
      fileName: `${title.slice(0, 50)}.mp4`,
      caption: `*${title}*\n\n> *POWERED BY ETIAS-TECH*`
    }, { quoted: msg });

    // Info card with bot image + footer + buttons
    const infoText = `
╭━━━〔 *${BOT_NAME} YTMP4* 〕━━━┈⊷
┃
┃ 📄 *Title:* ${title.slice(0, 60)}
┃ 👤 *Channel:* ${videoInfo?.author?.name || "YouTube"}
┃ ⏱️ *Duration:* ${videoInfo?.timestamp || "Unknown"}
┃ 🔗 *Link:* ${ytUrl}
┃
┃ ✅ *Sent as Document [HD]*
┃
╰━━━━━━━━━━━━━━━━━━┈⊷

> *POWERED BY ETIAS-TECH*
`;
    const footer = "*ETIAS-MINI-BOT • POWERED BY ETIAS-TECH*";
    const buttons = [
      { buttonId: `.video ${query}`, buttonText: { displayText: '🎬 AS VIDEO' }, type: 1 },
      { buttonId: `.play ${query}`, buttonText: { displayText: '🎧 GET AUDIO' }, type: 1 }
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
    console.log('[YTMP4 ERROR]', e.message);
    await sock.sendMessage(chatId, { text: `❌ Error: ${e.message}\n> *POWERED BY ETIAS-TECH*` }, { quoted: msg });
  }
};
