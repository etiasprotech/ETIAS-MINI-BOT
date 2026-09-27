require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 3000;

const BOT_IMAGE_PATH = path.join(__dirname, 'media/bot.jpg');
const BOT_IMAGE_PNG = path.join(__dirname, 'media/bot_image.png');
const BOT_NAME = "ETIAS-MINI-BOT";
const VERSION = "V3 MULTI + MONGO";
const PAIRING_SITE = "https://etias-mini-bot-pair.onrender.com/";
const MONGODB_URI = process.env.MONGODB_URI;

app.use(express.json());

// --- MongoDB Model (reuse if exists) ---
const sessionSchema = new mongoose.Schema({
  userId: { type: String, unique: true },
  sessionId: String,
  phone: String,
  connected: Boolean,
  createdAt: { type: Date, default: Date.now }
});
const SessionModel = mongoose.models.Session || mongoose.model('Session', sessionSchema);

app.get('/bot-image', (req, res) => {
  if (fs.existsSync(BOT_IMAGE_PATH)) res.sendFile(BOT_IMAGE_PATH);
  else if (fs.existsSync(BOT_IMAGE_PNG)) res.sendFile(BOT_IMAGE_PNG);
  else res.status(404).send('Bot image not found');
});

app.get('/ping', async (req, res) => {
  let mongoCount = 0;
  if (MONGODB_URI && mongoose.connection.readyState === 1) {
    try{ mongoCount = await SessionModel.countDocuments(); }catch{}
  }
  res.json({
    status: 'online',
    bot: BOT_NAME,
    version: VERSION,
    uptime: `${Math.floor(process.uptime() / 60)}m ${Math.floor(process.uptime() % 60)}s`,
    uptime_seconds: process.uptime(),
    total_users_db: mongoCount,
    pairing_site: PAIRING_SITE,
    timestamp: new Date().toISOString()
  });
});

app.get('/session', (req, res) => {
  try {
    const sessionFile = path.join(__dirname, 'data/session.json');
    if (fs.existsSync(sessionFile)) {
      const data = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
      return res.json({ exists: true,...data, pairing_site: PAIRING_SITE });
    }
    const credsPath = path.join(__dirname, 'auth/creds.json');
    if (fs.existsSync(credsPath)) {
      const creds = fs.readFileSync(credsPath, 'utf-8');
      const b64 = Buffer.from(creds).toString('base64');
      return res.json({ exists: true, sessionId: `ETIAS-MINI-BOT~${b64}`, pairing_site: PAIRING_SITE });
    }
    res.json({ exists: false, message: "No session - pair at " + PAIRING_SITE });
  } catch (e) {
    res.json({ exists: false, error: e.message });
  }
});

// --- MULTI ENDPOINTS ---
app.get('/bots', async (req, res) => {
  try {
    let sessions = [];
    let total = 0;
    if (MONGODB_URI && mongoose.connection.readyState === 1) {
      sessions = await SessionModel.find({}).select('userId phone createdAt -_id');
      total = sessions.length;
    } else {
      const multiFile = path.join(__dirname, 'data/multi_sessions.json');
      if (fs.existsSync(multiFile)) {
        const db = JSON.parse(fs.readFileSync(multiFile, 'utf-8'));
        total = Object.keys(db).length;
        sessions = Object.keys(db).map(k=>({ userId: k }));
      }
    }
    res.json({ total, pairing_site: PAIRING_SITE, sessions });
  } catch (e) { res.json({ error: e.message }) }
});

app.get('/add', async (req, res) => {
  const sid = req.query.session;
  if (!sid) return res.send(`Use pairing site: <a href="${PAIRING_SITE}">${PAIRING_SITE}</a> or /add?session=ETIAS~xxx`);
  try {
    const b64 = sid.includes('~')? sid.split('~').pop() : sid;
    const j = JSON.parse(Buffer.from(b64.trim(), 'base64').toString('utf-8'));
    const userId = j.me?.id?.split(':')[0] || `user_${Date.now()}`;

    // Save to file
    const multiPath = path.join(__dirname, 'data/multi_sessions.json');
    let db = {}; if (fs.existsSync(multiPath)) try{ db = JSON.parse(fs.readFileSync(multiPath,'utf-8')) }catch{}
    db[userId] = sid;
    fs.writeFileSync(multiPath, JSON.stringify(db, null, 2));

    // Save to Mongo
    if (MONGODB_URI && mongoose.connection.readyState === 1) {
      await SessionModel.findOneAndUpdate({ userId }, { sessionId: sid, phone: userId }, { upsert: true });
    }

    // Try to create auth folder so next restart loads it
    const authUsersPath = path.join(__dirname, 'auth/users', userId);
    try {
      let c = sid.trim(); if (c.includes("~")) c = c.split("~").pop();
      const d = Buffer.from(c, 'base64').toString('utf-8');
      if (d.startsWith("{")) {
        if (!fs.existsSync(authUsersPath)) fs.mkdirSync(authUsersPath, { recursive: true });
        fs.writeFileSync(path.join(authUsersPath, 'creds.json'), d);
      }
    } catch {}

    res.send(`✅ Added ${userId}. Restart bot to connect. <br><a href="/">Home</a> | <a href="${PAIRING_SITE}">Pair Site</a>`);
  } catch (e) { res.send('❌ Invalid SESSION: ' + e.message); }
});

app.get('/', async (req, res) => {
  let commandsCount = 0;
  try { const cmdPath = path.join(__dirname, 'commands'); if (fs.existsSync(cmdPath)) commandsCount = fs.readdirSync(cmdPath).filter(f=>f.endsWith('.js')).length; } catch {}
  let sessionExists = fs.existsSync(path.join(__dirname, 'auth/creds.json'));
  let mongoCount = 0; let mongoConnected = false;
  try { if (MONGODB_URI && mongoose.connection.readyState===1){ mongoConnected=true; mongoCount=await SessionModel.countDocuments(); } }catch{}

  const uptime = process.uptime(); const hours = Math.floor(uptime/3600); const mins = Math.floor((uptime%3600)/60);

  res.send(`
<!DOCTYPE html>
<html><head><title>${BOT_NAME} - Online</title><meta name="viewport" content="width=device-width, initial-scale=1">
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { background: linear-gradient(135deg, #0a0a0a 0%, #1a1a1a 100%); color: #fff; font-family: 'Segoe UI', sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; flex-direction: column; padding:20px; }
.card { background: #222; border: 1px solid #333; border-radius: 20px; padding: 30px; text-align: center; max-width: 450px; width: 100%; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
img { width: 130px; height: 130px; border-radius: 50%; border: 4px solid #25D366; margin-bottom: 20px; object-fit: cover; }
h1 { margin: 10px 0 5px 0; font-size: 24px; }
.status { background: #25D36620; border: 1px solid #25D366; color: #25D366; padding: 6px 15px; border-radius: 20px; font-size: 12px; display: inline-block; margin: 10px 0; }
.dot { width: 8px; height: 8px; background: #25D366; border-radius: 50%; display: inline-block; margin-right: 6px; box-shadow: 0 0 10px #25D366; animation: blink 1.5s infinite; }
@keyframes blink { 0% {opacity:1} 50% {opacity:0.3} 100% {opacity:1} }
.info { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 20px 0; text-align: left; }
.info div { background: #2a2a2a; padding: 10px; border-radius: 10px; font-size: 12px; }
.info span { color: #aaa; display:block; font-size:10px; text-transform:uppercase; }
.info b { color:#fff; font-size:14px; }
.btn { background: #25D366; color: #000; border: none; padding: 12px 20px; border-radius: 10px; font-weight: bold; cursor: pointer; text-decoration: none; display: inline-block; margin: 5px; font-size: 13px; width:100%; }
.btn-outline { background: transparent; border: 1px solid #333; color: #fff; }
.btn-pair { background: #00ff88; color: #000; }
p { color: #aaa; font-size: 13px; margin-top: 10px; }
.footer { font-size: 11px; color: #555; margin-top: 20px; }
</style></head><body>
<div class="card">
<img src="/bot-image" onerror="this.src='https://i.imgur.com/3Q6qT6o.png'" />
<h1><span class="dot"></span>${BOT_NAME}</h1>
<div class="status">● ONLINE - ${VERSION}</div>
<div class="info">
<div><span>Uptime</span><b>${hours}h ${mins}m</b></div>
<div><span>Commands</span><b>${commandsCount}</b></div>
<div><span>Session</span><b>${sessionExists? '✅ Paired' : '❌ Not Paired'}</b></div>
<div><span>MongoDB Users</span><b>${mongoConnected? mongoCount : 'No DB'}</b></div>
<div><span>Platform</span><b>${process.platform}</b></div>
<div><span>Mode</span><b>${process.env.MODE||'public'}</b></div>
</div>
<a class="btn btn-pair" href="${PAIRING_SITE}" target="_blank">🔗 PAIR NEW USER</a>
<a class="btn" href="/bots">📋 View All Bots (${mongoCount})</a>
<div style="display:flex;gap:10px">
<a class="btn btn-outline" href="/ping">📡 Ping</a>
<a class="btn btn-outline" href="/session">🔑 Session</a>
</div>
<p>Bot is running with Multi-User + MongoDB</p>
<p style="font-size:11px;">Pair Site: ${PAIRING_SITE}<br>${new Date().toLocaleString()}</p>
<div class="footer">POWERED BY ETIAS-TECH © 2026</div>
</div>
</body></html>
  `);
});

// Don't listen if required from Main.js
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[SERVER] Running on http://localhost:${PORT}`);
  });
}

module.exports = app;
