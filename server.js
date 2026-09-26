const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const BOT_IMAGE_PATH = path.join(__dirname, 'media/bot.jpg');
const BOT_IMAGE_PNG = path.join(__dirname, 'media/bot_image.png');
const BOT_NAME = "ETIAS-MINI-BOT";
const VERSION = "V2 ULTRA";

app.use(express.json());

// Serve local bot image - supports jpg/png
app.get('/bot-image', (req, res) => {
  if (fs.existsSync(BOT_IMAGE_PATH)) {
    res.sendFile(BOT_IMAGE_PATH);
  } else if (fs.existsSync(BOT_IMAGE_PNG)) {
    res.sendFile(BOT_IMAGE_PNG);
  } else {
    res.status(404).send('Bot image not found in /media/bot.jpg or /media/bot_image.png');
  }
});

app.get('/ping', (req, res) => {
  res.json({ 
    status: 'online', 
    bot: BOT_NAME,
    version: VERSION,
    uptime: `${Math.floor(process.uptime() / 60)}m ${Math.floor(process.uptime() % 60)}s`,
    uptime_seconds: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

app.get('/session', (req, res) => {
  try {
    const sessionFile = path.join(__dirname, 'data/session.json');
    if (fs.existsSync(sessionFile)) {
      const data = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
      res.json({ exists: true, ...data });
    } else {
      const credsPath = path.join(__dirname, 'auth/creds.json');
      if (fs.existsSync(credsPath)) {
        const creds = fs.readFileSync(credsPath, 'utf-8');
        const b64 = Buffer.from(creds).toString('base64');
        res.json({ 
          exists: true, 
          sessionId: `ETIAS-MINI-BOT~${b64}`,
          note: "Set this as ENV SESSION_ID"
        });
      } else {
        res.json({ exists: false, message: "No session yet - pair first" });
      }
    }
  } catch (e) {
    res.json({ exists: false, error: e.message });
  }
});

app.get('/', (req, res) => {
  let commandsCount = 0;
  try {
    const cmdPath = path.join(__dirname, 'commands');
    if (fs.existsSync(cmdPath)) {
      commandsCount = fs.readdirSync(cmdPath).filter(f => f.endsWith('.js')).length;
    }
  } catch {}

  let sessionExists = false;
  try {
    sessionExists = fs.existsSync(path.join(__dirname, 'auth/creds.json'));
  } catch {}

  const uptime = process.uptime();
  const hours = Math.floor(uptime / 3600);
  const mins = Math.floor((uptime % 3600) / 60);

  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>${BOT_NAME} - Online</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body {
      background: linear-gradient(135deg, #111 0%, #1a1a1a 100%);
      color: #fff;
      font-family: 'Segoe UI', sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      flex-direction: column;
      padding:20px;
    }
    .card {
      background: #222;
      border: 1px solid #333;
      border-radius: 20px;
      padding: 30px;
      text-align: center;
      max-width: 400px;
      width: 100%;
      box-shadow: 0 10px 30px rgba(0,0,0,0.5);
    }
    img {
      width: 130px;
      height: 130px;
      border-radius: 50%;
      border: 4px solid #25D366;
      margin-bottom: 20px;
      object-fit: cover;
    }
    h1 { margin: 10px 0 5px 0; font-size: 24px; }
    .status {
      background: #25D36620;
      border: 1px solid #25D366;
      color: #25D366;
      padding: 6px 15px;
      border-radius: 20px;
      font-size: 12px;
      display: inline-block;
      margin: 10px 0;
    }
    .dot {
      width: 8px;
      height: 8px;
      background: #25D366;
      border-radius: 50%;
      display: inline-block;
      margin-right: 6px;
      box-shadow: 0 0 10px #25D366;
      animation: blink 1.5s infinite;
    }
    @keyframes blink { 0% {opacity:1} 50% {opacity:0.3} 100% {opacity:1} }
    .info {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      margin: 20px 0;
      text-align: left;
    }
    .info div {
      background: #2a2a2a;
      padding: 10px;
      border-radius: 10px;
      font-size: 12px;
    }
    .info span { color: #aaa; display:block; font-size:10px; text-transform:uppercase; }
    .info b { color:#fff; font-size:14px; }
    .btn {
      background: #25D366;
      color: #000;
      border: none;
      padding: 10px 20px;
      border-radius: 10px;
      font-weight: bold;
      cursor: pointer;
      text-decoration: none;
      display: inline-block;
      margin: 5px;
      font-size: 13px;
    }
    .btn-outline {
      background: transparent;
      border: 1px solid #333;
      color: #fff;
    }
    p { color: #aaa; font-size: 13px; margin-top: 10px; }
    .footer { font-size: 11px; color: #555; margin-top: 20px; }
  </style>
</head>
<body>
  <div class="card">
    <img src="/bot-image" onerror="this.src='https://i.imgur.com/3Q6qT6o.png'" />
    <h1><span class="dot"></span>${BOT_NAME}</h1>
    <div class="status">● ONLINE - ${VERSION}</div>
    
    <div class="info">
      <div><span>Uptime</span><b>${hours}h ${mins}m</b></div>
      <div><span>Commands</span><b>${commandsCount}</b></div>
      <div><span>Session</span><b>${sessionExists? '✅ Paired' : '❌ Not Paired'}</b></div>
      <div><span>Platform</span><b>${process.platform}</b></div>
    </div>

    <div>
      <a class="btn" href="/ping">📡 Ping</a>
      <a class="btn btn-outline" href="/session">🔑 Session</a>
    </div>

    <p>Bot is running successfully!</p>
    <p style="font-size:11px;">${new Date().toLocaleString()}</p>
    <div class="footer">POWERED BY ETIAS-TECH © 2026</div>
  </div>
</body>
</html>
  `);
});

app.listen(PORT, () => {
  console.log(`[SERVER] Running on http://localhost:${PORT}`);
  console.log(`[SERVER] Ping: http://localhost:${PORT}/ping`);
  console.log(`[SERVER] Session: http://localhost:${PORT}/session`);
});

module.exports = app;
