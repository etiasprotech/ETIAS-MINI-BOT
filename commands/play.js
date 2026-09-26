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

module.exports.name = "play";
module.exports.aliases = ["song", "music"];
module.exports.execute = async (sock, msg, args) => {
  const chatId = msg.key.remoteJid;
  const query = args.join(' ').trim();

  if (!query) {
    await sock.sendMessage(chatId, { text: '❌ Usage: *.play <song name>*' }, { quoted: msg });
    return;
  }

  try {
    let video;
    if (query.includes('youtube.com') || query.includes('youtu.be')) {
      video = {
        url: query,
        title: 'YouTube Audio',
        author: { name: 'Unknown' },
        timestamp: 'Unknown',
        ago: '2024',
        views: 0,
        thumbnail: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg'
      };
    } else {
      await sock.sendMessage(chatId, { text: `🔍 *Searching:* ${query}...` }, { quoted: msg });
      const search = await yts(query);
      if (!search?.videos.length) {
        await sock.sendMessage(chatId, { text: '❌ No results found.' }, { quoted: msg });
        return;
      }
      video = search.videos[0];
    }

    const title = video.title || 'Unknown';
    const artist = video.author?.name || video.author || 'Unknown Artist';
    const duration = video.timestamp || 'Unknown';
    const year = video.ago || '2024';
    const plays = video.views ? video.views.toLocaleString() : '0';
    const youtubeUrl = video.url;

    let botImageBuffer;
    try { botImageBuffer = fs.readFileSync(BOT_IMAGE_PATH); } catch { botImageBuffer = null; }

    const caption =
`┏━━━━━━━━━━━━━━━━━━━━┓
┃ 🤖 ${BOT_NAME} ┃
┗━━━━━━━━━━━━━━━━━━━━┛

*🎵 Title:* ${title}
*👤 Artist:* ${artist}

┌─ 📊 *INFO* ─┐
│ ⏱️ Duration: ${duration}
│ 📅 Year: ${year}
│ 👁️ Plays: ${plays}
└─────────────┘

🔗 *Link:* ${youtubeUrl}

> _Downloading via ytmp3..._
> *POWERED BY ETIAS-TECH*`;

    if (botImageBuffer) {
      await sock.sendMessage(chatId, { image: botImageBuffer, caption }, { quoted: msg });
    } else {
      await sock.sendMessage(chatId, { image: { url: video.thumbnail }, caption }, { quoted: msg });
    }

    let audioUrl = null;
    let apiResult = null;
    let lastError = null;

    for (let i = 0; i < APIS.length; i++) {
      try {
        const apiUrl = APIS[i](youtubeUrl);
        console.log(`[PLAY] Trying API ${i+1}: ${apiUrl}`);

        const apiRes = await axios.get(apiUrl, {
          timeout: 40000,
          headers: { 'User-Agent': 'Mozilla/5.0' }
        });

        const data = apiRes.data;
        const resObj = data?.result || data?.data || data;
        audioUrl = resObj?.downloadUrl || resObj?.download || resObj?.url || data?.download || data?.url || resObj?.audio;
        apiResult = resObj;

        if (audioUrl) break;
        else throw new Error('No downloadUrl');

      } catch (e) {
        lastError = e;
        console.log(`[PLAY] API ${i+1} failed: ${e.message}`);
        continue;
      }
    }

    if (!audioUrl) throw new Error(`All APIs failed: ${lastError?.message}`);

    await sock.sendMessage(chatId, { text: `⬇️ *Downloading:* ${apiResult?.title || title}` }, { quoted: msg });

    const audioRes = await axios.get(audioUrl, {
      responseType: 'arraybuffer',
      timeout: 120000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    const audioBuffer = Buffer.from(audioRes.data);

    // AUDIO ONLY - NO DOCUMENT
    await sock.sendMessage(chatId, {
      audio: audioBuffer,
      mimetype: 'audio/mpeg',
      fileName: `${title}.mp3`
    }, { quoted: msg });

  } catch (err) {
    console.log('[PLAY ERROR]', err.message);
    await sock.sendMessage(chatId, { text: `❌ Error: ${err.message}` }, { quoted: msg });
  }
};
