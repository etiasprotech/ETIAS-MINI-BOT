const fs = require('fs');
const path = require('path');
const axios = require('axios');

const BOT_IMAGE_PATH = path.join(__dirname, '..', 'media/bot_image.png');
const BOT_NAME = "*ETIAS-MINI-BOT*";

const API_BASE = "https://api.princetechn.com/api/download/apkdl?apikey=prince&appName=";

module.exports.name = "apk";
module.exports.aliases = ["apkdl", "app"];
module.exports.execute = async (sock, msg, args) => {
  const chatId = msg.key.remoteJid;
  const appName = args.join(" ");

  if (!appName) {
    return await sock.sendMessage(chatId, {
      text: `📦 *Usage:*.apk <app name>\nExample:.apk Whatsapp\n.apk Facebook Lite\n\n> *POWERED BY ETIAS-TECH*`
    }, { quoted: msg });
  }

  try { await sock.sendMessage(chatId, { react: { text: "📦", key: msg.key } }); } catch {}
  await sock.sendMessage(chatId, { text: `🔍 _Searching APK for *${appName}*..._` }, { quoted: msg });

  try {
    const res = await axios.get(API_BASE + encodeURIComponent(appName), { timeout: 60000 });
    const data = res.data;

    // console.log('[APK API]', JSON.stringify(data).slice(0, 1000));

    let apkUrl = data.download_url || data.downloadUrl || data.url || data.link || data.apkUrl;
    let appTitle = data.name || data.title || appName;
    let appSize = data.size || data.fileSize || "Unknown";
    let appVersion = data.version || "Latest";
    let appIcon = data.icon || data.thumbnail || null;

    if (typeof data === 'string') apkUrl = data;

    if (data.data) {
      apkUrl = data.data.download_url || data.data.url || data.data.downloadUrl || data.data.link || apkUrl;
      appTitle = data.data.name || data.data.title || appTitle;
      appSize = data.data.size || appSize;
      appVersion = data.data.version || appVersion;
      appIcon = data.data.icon || appIcon;
    }

    if (data.result) {
      if (typeof data.result === 'string') apkUrl = data.result;
      else {
        apkUrl = data.result.download_url || data.result.url || data.result.downloadUrl || apkUrl;
        appTitle = data.result.name || appTitle;
        appSize = data.result.size || appSize;
        appVersion = data.result.version || appVersion;
      }
    }

    if (!apkUrl) {
      return await sock.sendMessage(chatId, { text: `❌ APK not found for: *${appName}*\n\n> *POWERED BY ETIAS-TECH*` }, { quoted: msg });
    }

    await sock.sendMessage(chatId, { text: `⬇️ _Found *${appTitle}* (${appSize}) - Uploading as document..._` }, { quoted: msg });

    // Send as DOCUMENT
    await sock.sendMessage(chatId, {
      document: { url: apkUrl },
      mimetype: 'application/vnd.android.package-archive',
      fileName: `${appTitle}.apk`,
      caption: `*${appTitle}*\n📦 Size: ${appSize}\n🔖 Version: ${appVersion}\n\n> *POWERED BY ETIAS-TECH*`
    }, { quoted: msg });

    // Info card with bot image + footer
    const infoText = `
╭━━━〔 *${BOT_NAME} APK* 〕━━━┈⊷
┃
┃ 📦 *App:* ${appTitle}
┃ 🔖 *Version:* ${appVersion}
┃ 💾 *Size:* ${appSize}
┃ 🔍 *Query:* ${appName}
┃ ✅ *Status:* Uploaded as APK
┃
╰━━━━━━━━━━━━━━━━━━┈⊷

> *POWERED BY ETIAS-TECH*
`;
    const footer = "*ETIAS-MINI-BOT • POWERED BY ETIAS-TECH*";
    const buttons = [
      { buttonId: `.apk ${appName}`, buttonText: { displayText: '🔄 RE-DOWNLOAD' }, type: 1 },
      { buttonId: '.menu', buttonText: { displayText: '📜 MENU' }, type: 1 }
    ];

    if (fs.existsSync(BOT_IMAGE_PATH)) {
      const img = fs.readFileSync(BOT_IMAGE_PATH);
      await sock.sendMessage(chatId, {
        image: img,
        caption: infoText,
        footer: footer,
        buttons: buttons,
        headerType: 4
      }, { quoted: msg });
    } else {
      await sock.sendMessage(chatId, {
        text: infoText,
        footer: footer,
        buttons: buttons,
        headerType: 1
      }, { quoted: msg });
    }

  } catch (e) {
    console.log('[APK ERROR]', e.message, e.response?.data);
    await sock.sendMessage(chatId, { text: `❌ Error downloading APK: ${e.message}\n> *POWERED BY ETIAS-TECH*` }, { quoted: msg });
  }
};
