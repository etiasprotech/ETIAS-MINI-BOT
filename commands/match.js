const axios = require('axios');

module.exports.name = "match";
module.exports.execute = async (sock, msg, args) => {
  const chatId = msg.key.remoteJid;

  try {
    const apiUrl = `https://api.princetechn.com/api/football/epl/matches?apikey=prince`;
    console.log(`[MATCH] Fetching EPL matches...`);

    const res = await axios.get(apiUrl, {
      timeout: 20000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    const data = res.data;
    console.log(`[MATCH] Raw:`, JSON.stringify(data).slice(0, 800));

    // PrinceTech usually returns result / matches / data
    const matches = data?.result || data?.matches || data?.data || data;

    if (!matches || (Array.isArray(matches) && matches.length === 0)) {
      await sock.sendMessage(chatId, { text: '❌ No EPL matches found today.' }, { quoted: msg });
      return;
    }

    const matchList = Array.isArray(matches)? matches : [matches];

    let text = `*⚽ EPL MATCHES - TODAY*\n`;
    text += `┏━━━━━━━━━━━━━━━━━━━━┓\n`;

    matchList.slice(0, 15).forEach((m, i) => {
      // Try to support all possible field names from API
      const home = m.homeTeam || m.home || m.team1 || m.HomeTeam || 'Home';
      const away = m.awayTeam || m.away || m.team2 || m.AwayTeam || 'Away';
      const time = m.time || m.kickoff || m.startTime || m.date || m.matchTime || 'TBD';
      const status = m.status || m.matchStatus || 'Scheduled';
      const league = m.league || 'EPL';

      text += `┃\n`;
      text += `┃ *${i+1}. ${home} vs ${away}*\n`;
      text += `┃ ⏰ Time: ${time}\n`;
      text += `┃ 📊 Status: ${status}\n`;
      text += `┃ 🏆 ${league}\n`;
    });

    text += `┗━━━━━━━━━━━━━━━━━━━━┛\n`;
    text += `\n> *POWERED BY ETIAS-TECH*`;

    await sock.sendMessage(chatId, { text }, { quoted: msg });

  } catch (err) {
    console.log('[MATCH ERROR]', err.message);
    await sock.sendMessage(chatId, { text: `❌ Error fetching matches: ${err.message}` }, { quoted: msg });
  }
};
