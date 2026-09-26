const axios = require('axios');

module.exports.name = "livescore";
module.exports.aliases = ["live", "score", "livescores"];
module.exports.execute = async (sock, msg, args) => {
  const chatId = msg.key.remoteJid;

  try {
    const apiUrl = `https://api.princetechn.com/api/football/livescore?apikey=prince`;
    console.log(`[LIVESCORE] Fetching...`);

    const res = await axios.get(apiUrl, {
      timeout: 25000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    const data = res.data;
    console.log(`[LIVESCORE] Raw:`, JSON.stringify(data).slice(0, 1500));

    let raw = data?.result || data?.matches || data?.data || data?.livescore || data;
    let list = Array.isArray(raw)? raw : raw?.matches || raw?.games || [raw];

    if (!list || list.length === 0 ||!list[0] || (list.length === 1 && Object.keys(list[0]).length === 0)) {
      await sock.sendMessage(chatId, { text: '❌ No live matches right now.\n\nTry *.match* for upcoming EPL fixtures.' }, { quoted: msg });
      return;
    }

    let text = `*🔴 LIVE FOOTBALL - NOW*\n`;
    text += `┏━━━━━━━━━━━━━━━━━━━━┓\n`;

    list.slice(0, 20).forEach((m, i) => {
      // Team parsing - support string and object
      let home = m.homeTeam || m.home || m.team1 || m.teamA || m.localTeam || m.HomeTeam || 'Home';
      let away = m.awayTeam || m.away || m.team2 || m.teamB || m.visitorTeam || m.AwayTeam || 'Away';

      if (typeof home === 'object') home = home.name || home.team || home.team_name || home.title || 'Home';
      if (typeof away === 'object') away = away.name || away.team || away.team_name || away.title || 'Away';

      home = String(home).trim();
      away = String(away).trim();

      // Score parsing
      let hs = m.homeScore?? m.score1?? m.goalsHome?? m.localScore?? m.score?.home?? m.goals?.home?? m.homeGoals?? 0;
      let as = m.awayScore?? m.score2?? m.goalsAway?? m.visitorScore?? m.score?.away?? m.goals?.away?? m.awayGoals?? 0;

      if (typeof hs === 'object') hs = hs.score?? hs.goals?? 0;
      if (typeof as === 'object') as = as.score?? as.goals?? 0;

      let minute = m.minute || m.time || m.elapsed || m.matchTime || m.status || 'LIVE';
      let league = m.league || m.competition || m.tournament || 'Football';
      if (typeof league === 'object') league = league.name || league.title || 'Football';
      if (typeof minute === 'object') minute = minute.time || minute.status || 'LIVE';

      // YOUR REQUIRED FORMAT: Chelsea vs Man U
      text += `┃\n`;
      text += `┃ *${i+1}. ${home} vs ${away}*\n`;
      text += `┃ ⚽ ${hs} - ${as} | ⏱️ ${minute}\n`;
      text += `┃ 🏆 ${league}\n`;
    });

    text += `┗━━━━━━━━━━━━━━━━━━━━┛\n`;
    text += `\n> *POWERED BY ETIAS-TECH*`;

    await sock.sendMessage(chatId, { text }, { quoted: msg });

  } catch (err) {
    console.log('[LIVESCORE ERROR]', err.message);
    await sock.sendMessage(chatId, { text: `❌ Error fetching livescore: ${err.message}` }, { quoted: msg });
  }
};
