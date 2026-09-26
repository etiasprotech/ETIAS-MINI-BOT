const axios = require('axios');

module.exports.name = "streaming";
module.exports.aliases = ["channels", "livechannels", "streams"];
module.exports.execute = async (sock, msg, args) => {
  const chatId = msg.key.remoteJid;

  try {
    const apiUrl = `https://api.princetechn.com/api/football/streaming/channels?apikey=prince`;
    console.log(`[STREAMING] Fetching...`);

    const res = await axios.get(apiUrl, {
      timeout: 25000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    const data = res.data;
    console.log(`[STREAMING] Raw:`, JSON.stringify(data).slice(0, 1200));

    const channels = data?.result || data?.channels || data?.data || data?.streams || data;

    if (!channels || (Array.isArray(channels) && channels.length === 0)) {
      await sock.sendMessage(chatId, { text: '❌ No streaming channels available right now.' }, { quoted: msg });
      return;
    }

    const list = Array.isArray(channels)? channels : [channels];

    let text = `*📺 LIVE STREAMING CHANNELS*\n`;
    text += `┏━━━━━━━━━━━━━━━━━━━━┓\n`;

    list.slice(0, 20).forEach((ch, i) => {
      const name = ch.name || ch.channel || ch.channelName || ch.title || `Channel ${i+1}`;
      const url = ch.url || ch.link || ch.stream || ch.streamUrl || '';
      const category = ch.category || ch.league || ch.sport || ch.type || 'Football';
      const status = ch.status || ch.live || 'LIVE';

      text += `┃\n`;
      text += `┃ *${i+1}. ${name}*\n`;
      text += `┃ 📡 ${category} | ${status}\n`;
      if (url) {
        text += `┃ 🔗 ${url}\n`;
      }
    });

    text += `┗━━━━━━━━━━━━━━━━━━━━┛\n`;
    text += `\n*Use:*.playstream <number> to get link\n`;
    text += `> *POWERED BY ETIAS-TECH*`;

    await sock.sendMessage(chatId, { text }, { quoted: msg });

  } catch (err) {
    console.log('[STREAMING ERROR]', err.message);
    await sock.sendMessage(chatId, { text: `❌ Error fetching channels: ${err.message}` }, { quoted: msg });
  }
};
