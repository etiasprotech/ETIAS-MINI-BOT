const axios = require('axios');
const yts = require('yt-search');
const fs = require('fs');
const path = require('path');

const BOT_NAME = "*ETIAS-MINI-BOT*";
const BOT_IMAGE_PATH = path.join(__dirname, '..', 'media/bot.png');

const APIS = [
  (url) => `https://api.princetechn.com/api/download/ytmp3?apikey=prince&url=${encodeURIComponent(url)}`,
  (url) => `https://api.princetechn.com/api/download/ytmp4?apikey=prince&url=${encodeURIComponent(url)}`,
  (url) => `https://api.princetechn.com/api/download/mp3?apikey=prince&url=${encodeURIComponent(url)}`,
  (url) => `https://api.princetechn.com/api/download/yta?apikey=prince&url=${encodeURIComponent(url)}`
];

module.exports.name = "song";
module.exports.aliases = ["music2"];
module.exports.execute = async (sock, msg, args) => {
  const chatId = msg.key.remoteJid;
  const query = args.join(' ').trim();
  if (!query) return sock.sendMessage(chatId, { text: '❌ Usage: .song <song name>' }, { quoted: msg });

  try {
    let video;
    if (query.includes('youtube.com') || query.includes('youtu.be')) {
      video = { url: query, title: 'YouTube Audio', author: { name: 'Unknown' }, timestamp: 'Unknown', views: 0, thumbnail: '' };
    } else {
      await sock.sendMessage(chatId, { text: `🔎 _Searching: ${query}_` }, { quoted: msg });
      const search = await yts(query);
      if (!search.videos.length) return sock.sendMessage(chatId, { text: '❌ Not found' }, { quoted: msg });
      video = search.videos[0];
    }

    const title = video.title || 'YouTube Audio';
    const artist = video.author?.name || video.author || 'Unknown';
    const duration = video.timestamp || 'Unknown';
    const youtubeUrl = video.url;

    let botImageBuffer;
    try { botImageBuffer = fs.readFileSync(BOT_IMAGE_PATH); } catch { botImageBuffer = null; }

    const caption = `🎵 *${title}*\n👤 ${artist}\n⏱️ ${duration}\n🔗 ${youtubeUrl}\n\n_Downloading as document..._`;

    if (botImageBuffer) {
      await sock.sendMessage(chatId, { image: botImageBuffer, caption }, { quoted: msg });
    } else if (video.thumbnail) {
      await sock.sendMessage(chatId, { image: { url: video.thumbnail }, caption }, { quoted: msg });
    }

    // === GET DOWNLOAD URL FROM ytmp3 API ===
    let audioUrl = null;
    let apiResult = null;
    let lastError = null;

    for (let i = 0; i < APIS.length; i++) {
      try {
        const apiUrl = APIS[i](youtubeUrl);
        console.log(`[SONG] API ${i+1}: ${apiUrl}`);

        const apiRes = await axios.get(apiUrl, { timeout: 40000, headers: { 'User-Agent': 'Mozilla/5.0' } });
        const resObj = apiRes.data?.result || apiRes.data?.data || apiRes.data;
        audioUrl = resObj?.downloadUrl || resObj?.download || resObj?.url || apiRes.data?.download;
        apiResult = resObj;

        if (audioUrl) break;
        else throw new Error('No downloadUrl');

      } catch (e) {
        lastError = e;
        console.log(`[SONG] API ${i+1} failed: ${e.message}`);
        continue;
      }
    }

    if (!audioUrl) throw new Error(`All APIs failed: ${lastError?.message}`);

    await sock.sendMessage(chatId, { text: `⬇️ *Downloading document:* ${apiResult?.title || title}` }, { quoted: msg });

    const audioRes = await axios.get(audioUrl, {
      responseType: 'arraybuffer',
      timeout: 120000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    const audioBuffer = Buffer.from(audioRes.data);

    // DOCUMENT ONLY - NO AUDIO
    await sock.sendMessage(chatId, {
      document: audioBuffer,
      mimetype: 'audio/mpeg',
      fileName: `${title}.mp3`.replace(/[^\w\s.-]/gi, ''),
      caption: `✅ *${title}*\n> *POWERED BY ETIAS-TECH*`
    }, { quoted: msg });

  } catch (e) {
    console.log('[SONG ERROR]', e.message);
    await sock.sendMessage(chatId, { text: `❌ Error: ${e.message}\n\nFailed to fetch. Try .play` }, { quoted: msg });
  }
};
