const fs = require('fs');
const path = require('path');
const axios = require('axios');
const yts = require('yt-search');

const BOT_IMAGE_PATH = path.join(__dirname, '..', 'media/bot_image.png');
const BOT_NAME = "*ETIAS-MINI-BOT*";

const APIS = [
  (url) => `https://api.princetechn.com/api/download/ytv?apikey=prince&url=${encodeURIComponent(url)}`,
  (url) => `https://api.davidcyriltech.my.id/download/ytmp4?url=${encodeURIComponent(url)}`,
  (url) => `https://apis.davidcyriltech.my.id/download/ytmp4?url=${encodeURIComponent(url)}`
];

module.exports.name = "video";
module.exports.aliases = ["ytv", "ytmp4", "mp4"];

module.exports.execute = async (sock, msg, args) => {
  const chatId = msg.key.remoteJid;
  const query = args.join(" ").trim();
  
  if (!query) {
    return await sock.sendMessage(chatId, {
      text: `🎬 *Usage:* .video <name or youtube link>\n\nExample:\n.video faded alan walker\n.video https://youtu.be/60ItHLz5WEA\n\n> *POWERED BY ETIAS-TECH*`
    }, { quoted: msg });
  }

  try { await sock.sendMessage(chatId, { react: { text: "🎬", key: msg.key } }); } catch {}
  const searchMsg = await sock.sendMessage(chatId, { text: `🔍 _Searching *${query}*..._` }, { quoted: msg });

  try {
    let ytUrl = query;
    let videoInfo = null;

    if (!query.includes('youtu.be') && !query.includes('youtube.com')) {
      const search = await yts(query);
      if (!search.videos.length) {
        return await sock.sendMessage(chatId, { text: `❌ *No results found for:* ${query}\n\nTry with different keywords.` }, { quoted: msg });
      }
      videoInfo = search.videos[0];
      ytUrl = videoInfo.url;
    } else {
      try {
        const id = query.match(/(?:v=|\/)([0-9A-Za-z_-]{11})/)?.[1];
        if (id) {
          const s = await yts({ videoId: id });
          videoInfo = s;
        }
      } catch {}
    }

    await sock.sendMessage(chatId, { text: `⬇️ _Downloading: *${videoInfo?.title?.slice(0, 60) || ytUrl}*..._\n\n> This may take 30s` }, { quoted: msg });

    // Try APIs one by one
    let videoDownloadUrl = null;
    let apiTitle = null;
    let lastError = null;

    for (const apiBuilder of APIS) {
      try {
        const apiUrl = apiBuilder(ytUrl);
        console.log(`[VIDEO] Trying: ${apiUrl.slice(0,80)}`);
        const res = await axios.get(apiUrl, { timeout: 60000 });
        const data = res.data;

        // PrinceTech format
        if (data.download_url) videoDownloadUrl = data.download_url;
        else if (data.downloadUrl) videoDownloadUrl = data.downloadUrl;
        else if (data.result?.download_url) videoDownloadUrl = data.result.download_url;
        else if (data.result?.url) videoDownloadUrl = data.result.url;
        else if (data.result && typeof data.result === 'string') videoDownloadUrl = data.result;
        else if (data.data?.download_url) videoDownloadUrl = data.data.download_url;
        else if (data.data?.url) videoDownloadUrl = data.data.url;
        else if (data.url) videoDownloadUrl = data.url;
        else if (data.link) videoDownloadUrl = data.link;
        else if (typeof data === 'string' && data.startsWith('http')) videoDownloadUrl = data;

        // David API format
        if (data.result?.download_url || data.downloadUrl) {
          videoDownloadUrl = data.result?.download_url || data.downloadUrl || data.result?.downloadUrl;
          apiTitle = data.result?.title || data.title;
        }

        if (videoDownloadUrl && videoDownloadUrl.startsWith('http')) {
          console.log(`[VIDEO] Got URL from API`);
          break;
        }
      } catch (e) {
        lastError = e.message;
        console.log(`[VIDEO API FAIL] ${e.message}`);
        continue;
      }
    }

    if (!videoDownloadUrl) {
      console.log('[VIDEO ALL APIS FAILED]', lastError);
      return await sock.sendMessage(chatId, {
        text: `❌ *Failed to get video*\n\n*Reason:* All download servers are busy / API limit reached\n*Video:* ${videoInfo?.title || ytUrl}\n*Link:* ${ytUrl}\n\n*Try:*\n1. Try again after 1 minute\n2. Try with a shorter video (<10 min)\n3. Use .play for audio only\n\n> Error: ${lastError || 'No download url'}\n\n> *POWERED BY ETIAS-TECH*`
      }, { quoted: msg });
    }

    // Send as MP4 - force video mimetype
    try {
      await sock.sendMessage(chatId, {
        video: { url: videoDownloadUrl },
        mimetype: 'video/mp4',
        fileName: `${(videoInfo?.title || apiTitle || "video").replace(/[^\w ]/g,'').slice(0,50)}.mp4`,
        caption: `*${videoInfo?.title || apiTitle || "YouTube Video"}*\n⏱️ ${videoInfo?.timestamp || ''} | 👤 ${videoInfo?.author?.name || 'YouTube'}\n\n> *POWERED BY ETIAS-TECH*`
      }, { quoted: msg });
    } catch (sendErr) {
      // If URL expired, try as document
      console.log('[VIDEO SEND FAIL]', sendErr.message);
      try {
        await sock.sendMessage(chatId, {
          document: { url: videoDownloadUrl },
          mimetype: 'video/mp4',
          fileName: `${(videoInfo?.title || "video").slice(0,40)}.mp4`,
          caption: `*${videoInfo?.title || "Video"}*\n\nSent as document due to size\n> *POWERED BY ETIAS-TECH*`
        }, { quoted: msg });
      } catch {
        throw new Error(`Download link expired / too large. Try smaller video. Link: ${videoDownloadUrl.slice(0,100)}`);
      }
    }

    // Info card with buttons
    const infoText = `╭━━━〔 *${BOT_NAME} VIDEO* 〕━━━
┃ 🎬 *Title:* ${(videoInfo?.title || apiTitle || "YouTube Video").slice(0, 60)}
┃ 👤 *Channel:* ${videoInfo?.author?.name || "YouTube"}
┃ ⏱️ *Duration:* ${videoInfo?.timestamp || "Unknown"}
┃ 🔗 *Link:* ${ytUrl}
┃ ✅ *Sent as MP4*
╰━━━━━━━━━━━━━━━
> *POWERED BY ETIAS-TECH*`;

    const footer = "*ETIAS-MINI-BOT • POWERED BY ETIAS-TECH*";
    const buttons = [
      { buttonId: `.play ${ytUrl}`, buttonText: { displayText: '🎧 GET AUDIO' }, type: 1 },
      { buttonId: `.song ${ytUrl}`, buttonText: { displayText: '📄 AS DOCUMENT' }, type: 1 }
    ];

    try {
      if (fs.existsSync(BOT_IMAGE_PATH)) {
        const img = fs.readFileSync(BOT_IMAGE_PATH);
        await sock.sendMessage(chatId, { image: img, caption: infoText, footer, buttons, headerType: 4 }, { quoted: msg });
      } else {
        await sock.sendMessage(chatId, { text: infoText, footer, buttons, headerType: 1 }, { quoted: msg });
      }
    } catch {}

  } catch (e) {
    console.log('[VIDEO ERROR]', e.message, e.stack);
    let msgText = `❌ *Video Download Failed*\n\n`;
    
    if (e.message.includes('timeout')) msgText += `*Reason:* Server took too long (video too long?)\n*Fix:* Try video < 10 minutes\n`;
    else if (e.message.includes('404') || e.message.includes('No results')) msgText += `*Reason:* Video not found / private\n`;
    else if (e.message.includes('403') || e.message.includes('Forbidden')) msgText += `*Reason:* YouTube blocked download\n*Fix:* Try again in 2 minutes\n`;
    else msgText += `*Reason:* ${e.message.slice(0,200)}\n`;
    
    msgText += `\n*Query:* ${query.slice(0,100)}\n\n> *POWERED BY ETIAS-TECH*`;

    await sock.sendMessage(chatId, { text: msgText }, { quoted: msg });
  }
};
