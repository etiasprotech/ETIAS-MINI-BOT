const os = require('os');

module.exports.name = "ping";
module.exports.aliases = ["speed", "latency", "pong"];

module.exports.execute = async (sock, msg, args) => {
  const chatId = msg.key.remoteJid;
  const start = Date.now();

  // 🚀 React to command
  try {
    await sock.sendMessage(chatId, {
      react: { text: "⚙️", key: msg.key }
    });
  } catch {}

  // Send processing
  const m = await sock.sendMessage(chatId, {
    text: "⚡ *Pinging...*"
  }, { quoted: msg });

  const latency = Date.now() - start;
  const uptimeSec = process.uptime();
  const hours = Math.floor(uptimeSec / 3600);
  const mins = Math.floor((uptimeSec % 3600) / 60);
  const secs = Math.floor(uptimeSec % 60);

  const ramUsed = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
  const ramTotal = (os.totalmem() / 1024 / 1024 / 1024).toFixed(2);
  const cpuModel = os.cpus()[0]?.model?.split('@')[0]?.trim() || "Unknown CPU";

  const text = `╭━━━〔 *ETIAS-MINI-BOT PING* 〕━━━┈⊷
┃
┃ 🚀 *Speed:* ${latency} ms
┃ ⏱️ *Latency:* ${latency} ms
┃ ⏰ *Uptime:* ${hours}h ${mins}m ${secs}s
┃ 🧠 *RAM:* ${ramUsed} MB / ${ramTotal} GB
┃ 💻 *CPU:* ${cpuModel}
┃ 📡 *Platform:* ${os.platform()}
┃ 🤖 *Bot:* ETIAS-MINI-BOT V2 ULTRA
┃
╰━━━━━━━━━━━━━━━┈⊷

> *POWERED BY ETIAS-TECH*`;

  try {
    await sock.sendMessage(chatId, {
      text: text,
      edit: m.key
    });
  } catch {
    await sock.sendMessage(chatId, { text: text }, { quoted: msg });
  }

  // Final reaction ⚡
  try {
    await sock.sendMessage(chatId, {
      react: { text: "⚡", key: m.key }
    });
  } catch {}
};
