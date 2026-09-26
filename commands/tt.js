const axios = require('axios');

const APIS = [
  (url) => `https://api.princetechn.com/api/download/tiktokdlv4?apikey=prince&url=${encodeURIComponent(url)}`,
  (url) => `https://api.princetechn.com/api/download/tiktokdlv3?apikey=prince&url=${encodeURIComponent(url)}`,
  (url) => `https://api.princetechn.com/api/download/tiktokdlv2?apikey=prince&url=${encodeURIComponent(url)}`
];

module.exports.name = "tiktok";
module.exports.aliases = ["tt", "tiktokdl", "ttdl"];
module.exports.execute = async (sock, msg, args) => {
  const chatId = msg.key.remoteJid;
  const url = args[0];

  if (!url || !url.includes('tiktok')) {
    await sock.sendMessage(chatId, { 
      text: '❌ *Usage:* .tiktok <tiktok_url>\n\nExample:\n.tiktok https://vm.tiktok.com/ZMrgKWmVd' 
    }, { quoted: msg });
    return;
  }

  try {
    await sock.sendMessage(chatId, { text: '⏳ *Fetching TikTok (v4 > v3 > v2)...*' }, { quoted: msg });

    let videoUrl = null;
    let result = null;
    let audioUrl = null;
    let lastError = null;

    for (let i = 0; i < APIS.length; i++) {
      try {
        const apiUrl = APIS[i](url);
        console.log(`[TIKTOK] Trying v${4-i}: ${apiUrl}`);

        const res = await axios.get(apiUrl, {
          timeout: 40000,
          headers: { 'User-Agent': 'Mozilla/5.0' }
        });

        console.log(`[TIKTOK] v${4-i} RAW:`, JSON.stringify(res.data).slice(0, 1500));

        const data = res.data?.result || res.data?.data || res.data;

        // Try all possible video keys
        videoUrl = data?.downloadUrl || data?.video || data?.noWatermark || data?.nowm || data?.hd || data?.play || data?.url || data?.download;
        audioUrl = data?.music || data?.audio;
        result = data;

        if (videoUrl) {
          console.log(`[TIKTOK] Got video from v${4-i}`);
          break;
        } else {
          throw new Error('No video URL in response');
        }

      } catch (e) {
        lastError = e;
        console.log(`[TIKTOK] v${4-i} failed: ${e.message}`);
        continue;
      }
    }

    if (!videoUrl) throw new Error(`All v2/v3/v4 failed: ${lastError?.message}`);

    const title = result?.title || result?.caption || result?.desc || 'TikTok Video';
    const author = result?.author || result?.username || result?.authorMeta?.name || 'TikTok User';

    let caption = `*🎵 TIKTOK DOWNLOADER*\n\n`;
    caption += `*Title:* ${title}\n`;
    caption += `*Author:* ${author}\n\n`;
    caption += `> *POWERED BY ETIAS-TECH*`;

    await sock.sendMessage(chatId, {
      video: { url: videoUrl },
      mimetype: 'video/mp4',
      caption: caption
    }, { quoted: msg });

    // If API also returns audio, send it too (optional)
    if (audioUrl) {
      await sock.sendMessage(chatId, {
        audio: { url: audioUrl },
        mimetype: 'audio/mpeg',
        fileName: `${author}_tiktok.mp3`
      }, { quoted: msg });
    }

  } catch (e) {
    console.log('[TIKTOK ERROR]', e.message);
    await sock.sendMessage(chatId, { text: `❌ Error: ${e.message}\n\nTry another link.` }, { quoted: msg });
  }
};
