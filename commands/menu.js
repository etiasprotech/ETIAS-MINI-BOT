const fs = require('fs');
const path = require('path');

const BOT_IMAGE_PATH = path.join(__dirname, '..', 'media/bot_image.png');
const MENU_IMAGE_PATH = path.join(__dirname, '..', 'media/menu.jpg');
const BOT_NAME = "*ETIAS-MINI-BOT*";
const VERSION = "*V2.0 ULTRA*";
const FOOTER = "*POWERED BY ETIAS-TECH*";

module.exports.name = "menu";
module.exports.aliases = ["allmenu", "commands", "help", "list"];
module.exports.execute = async (sock, msg, args) => {
  const chatId = msg.key.remoteJid;
  const sender = msg.key.participant || msg.key.remoteJid;

  try {
    await sock.sendMessage(chatId, {
      react: { text: "🚀", key: msg.key }
    });
  } catch {}

  const uptime = () => {
    const sec = process.uptime();
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    return `${h}h ${m}m ${s}s`;
  };

  // ===== GET CURRENT MODE =====
  let currentMode = global.botMode || 'public';
  try {
    const modePath = path.join(__dirname, '..', 'data/mode.json');
    if(fs.existsSync(modePath)){
      const d = JSON.parse(fs.readFileSync(modePath,'utf-8'));
      currentMode = d.mode || currentMode;
    }
  } catch {}

  const modeEmoji = {
    public: '🌍',
    private: '🔒',
    groups: '👥',
    inbox: '💬'
  }[currentMode] || '🌍';

  const totalCommands = 39;

  const menuText = `
╭━━━〔 *${BOT_NAME} ${VERSION}* 〕━━━┈⊷
┃
┃ 👑 *Owner:* ETIAS-TECH
┃ 🤖 *Bot:* ${BOT_NAME}
┃ ⏰ *Uptime:* ${uptime()}
┃ 📊 *Commands:* ${totalCommands}
┃ ${modeEmoji} *Mode:* ${currentMode.toUpperCase()}
┃ 🚀 *Prefix:* .
┃
╰━━━━━━━━━━━━━━━━━━━━━┈⊷

╭━━━〔 *📥 DOWNLOADER* 〕━━━┈⊷
┃ • .apk - Apk downloader
┃ • .fb - Facebook video
┃ • .play - Play audio YT
┃ • .play2 / .song - Song download
┃ • .tiktok / .tt - TikTok DL
┃ • .video / .ytmp4 - Video download
┃ • .ytmp3 - Audio download
┃ • .streaming / .stream - Streaming DL
╰━━━━━━━━━━━━━━━━━━━━━┈⊷

╭━━━〔 *👥 GROUP* 〕━━━┈⊷
┃ • .add - Add member
┃ • .kick - Kick member
┃ • .promote / .demote - Admin
┃ • .mute / .unmute - Group mute
┃ • .tagall / .hidetag - Tag all
┃ • .antilink - Anti link
┃ • .antidelete - Anti delete
┃ • .antiviewonce - Anti view once
┃ • .welcome / .goodbye - Welcome
┃ • .update - Update group
┃ • .alive - Bot alive check
╰━━━━━━━━━━━━━━━━━━━━━┈⊷

╭━━━〔 *🔐 BOT SETTINGS* 〕━━━┈⊷
┃ • .mode - Check current mode
┃ • .mode public - All can use
┃ • .mode private - Owner only 🔒
┃ • .mode groups - Groups only 👥
┃ • .mode inbox - Inbox only 💬
┃ • .session - Get session ID
╰━━━━━━━━━━━━━━━━━━━━━┈⊷

╭━━━〔 *🤖 AI & FUN* 〕━━━┈⊷
┃ • .ai / .etias - ETIAS AI Chat
┃ • .joke - Random joke
┃ • .fact - Random fact
┃ • .quote - Random quote
┃ • .alive / .etias - AI tools
╰━━━━━━━━━━━━━━━━━━━━━┈⊷

╭━━━〔 *🛠️ TOOLS* 〕━━━┈⊷
┃ • .take / .pp - Steal profile pic
┃ • .viewonce / .vv - Open view once
┃ • .owner - Owner contact
┃ • .ping - Speed check
┃ • .weather - Weather info
┃ • .livescore / .match - Live scores
┃ • .tagall / .take - Tools
╰━━━━━━━━━━━━━━━━━━━━━┈⊷

╭━━━〔 *⚡ ETIAS SPECIAL* 〕━━━┈⊷
┃ • Type .etias <question> for AI
┃ • Type .etias image <prompt>
┃ • Auto ViewOnce Recovery
┃ • Auto AntiLink + AntiDelete
┃ • HD Profile Picture Stealer
┃ • Mode: ${modeEmoji} ${currentMode.toUpperCase()}
╰━━━━━━━━━━━━━━━━━━━━━┈⊷

> ${FOOTER}
> *© 2026 ETIAS-TECH*
`;

  const buttons = [
    { buttonId: `.mode ${currentMode}`, buttonText: { displayText: `${modeEmoji} MODE: ${currentMode.toUpperCase()}` }, type: 1 },
    { buttonId: '.ping', buttonText: { displayText: '⚡ SPEED' }, type: 1 },
    { buttonId: '.owner', buttonText: { displayText: '👑 OWNER' }, type: 1 }
  ];

  let imagePath = null;
  if (fs.existsSync(MENU_IMAGE_PATH)) imagePath = MENU_IMAGE_PATH;
  else if (fs.existsSync(BOT_IMAGE_PATH)) imagePath = BOT_IMAGE_PATH;

  try {
    if (imagePath) {
      await sock.sendMessage(chatId, {
        image: fs.readFileSync(imagePath),
        caption: menuText,
        footer: `🚀 ${BOT_NAME} • ${FOOTER}`,
        buttons: buttons,
        headerType: 4,
        contextInfo: {
          externalAdReply: {
            title: `${BOT_NAME} ${VERSION} [${currentMode.toUpperCase()}]`,
            body: `Total ${totalCommands} Commands | Mode: ${currentMode} | ${FOOTER}`,
            thumbnailUrl: "",
            sourceUrl: "https://etias-mini-bot-pair.onrender.com/",
            mediaType: 1,
            renderLargerThumbnail: true
          }
        }
      }, { quoted: msg });
    } else {
      await sock.sendMessage(chatId, {
        text: menuText,
        footer: `🚀 ${BOT_NAME} • ${FOOTER}`,
        buttons: buttons,
        headerType: 1
      }, { quoted: msg });
    }
  } catch (e) {
    if (imagePath) {
      await sock.sendMessage(chatId, {
        image: fs.readFileSync(imagePath),
        caption: menuText + `\n\n🚀 ${BOT_NAME} • ${FOOTER}`
      }, { quoted: msg });
    } else {
      await sock.sendMessage(chatId, { text: menuText }, { quoted: msg });
    }
  }
};
