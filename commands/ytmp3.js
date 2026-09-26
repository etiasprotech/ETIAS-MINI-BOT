const axios = require('axios');

module.exports.name = "ytmp3";
module.exports.aliases = ["ytmp3dl", "yta", "ytmusic"];
module.exports.execute = async (sock, msg, args) => {
  const chatId = msg.key.remoteJid;

  let url = args[0];
  if (!url) {
    await sock.sendMessage(chatId, { text: '❌ *Usage:*.ytmp3 <youtube_url>\n\nExample:\n.ytmp3 https://youtu.be/qF-JLqKtr2Q?feature=shared' }, { quoted: msg });
    return;
  }

  try {
    await sock.sendMessage(chatId, { text: '⏳ *Fetching MP3 from PrinceTech API...*' }, { quoted: msg });

    const apiUrl = `https://api.princetechn.com/api/download/ytmp3?apikey=prince&url=${encodeURIComponent(url)}`;
    console.log(`[YTMP3] ${apiUrl}`);

    const res = await axios.get(apiUrl, { timeout: 60000 });
    const json = res.data;

    console.log(`[YTMP3 RAW]`, JSON.stringify(json).slice(0, 1000));

    const result = json.result || json.data || json;

    if (!result ||!result.downloadUrl) {
      await sock.sendMessage(chatId, { text: `❌ Failed to fetch. Response: ${JSON.stringify(json).slice(0,500)}` }, { quoted: msg });
      return;
    }

    const title = result.title || 'YouTube Audio';
    const thumbnail = result.thumbnail || '';
    const duration = result.duration || 0;
    const author = result.author || 'Unknown';
    const dlUrl = result.downloadUrl;

    const mins = Math.floor(duration / 60);
    const secs = duration % 60;

    // Send info card
    let caption = `*🎵 YTMP3 DOWNLOADER*\n\n`;
    caption += `*Title:* ${title}\n`;
    caption += `*Author:* ${author}\n`;
    caption += `*Duration:* ${mins}:${String(secs).padStart(2,'0')}\n`;
    caption += `*Link:* ${url}\n\n`;
    caption += `> *POWERED BY ETIAS-TECH*`;

    if (thumbnail) {
      await sock.sendMessage(chatId, { image: { url: thumbnail }, caption }, { quoted: msg });
    } else {
      await sock.sendMessage(chatId, { text: caption }, { quoted: msg });
    }

    // Send Audio
    await sock.sendMessage(chatId, {
      audio: { url: dlUrl },
      mimetype: 'audio/mpeg',
      fileName: `${title}.mp3`
    }, { quoted: msg });

    // Also send as document for easy save
    await sock.sendMessage(chatId, {
      document: { url: dlUrl },
      mimetype: 'audio/mpeg',
      fileName: `${title}.mp3`
    }, { quoted: msg });

  } catch (e) {
    console.log('[YTMP3 ERROR]', e.message);
    await sock.sendMessage(chatId, { text: `❌ Error: ${e.message}` }, { quoted: msg });
  }
};
