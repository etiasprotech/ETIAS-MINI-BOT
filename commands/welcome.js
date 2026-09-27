const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'database/welcome.json');
const BOT_IMAGE_PATH = path.join(__dirname, '..', 'media/bot_image.png');
const BOT_NAME = "*ETIAS-MINI-BOT*";

if (!fs.existsSync(path.dirname(DB_PATH))) fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, JSON.stringify({}));

function getDB() { try { return JSON.parse(fs.readFileSync(DB_PATH)); } catch { return {}; } }
function saveDB(data) { fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2)); }

module.exports.name = "welcome";
module.exports.aliases = ["wel", "wellcome", "setwelcome"];
module.exports.execute = async (sock, msg, args) => {
  const chatId = msg.key.remoteJid;
  const isGroup = chatId.endsWith('@g.us');
  if (!isGroup) return await sock.sendMessage(chatId, { text: "❌ Group only." }, { quoted: msg });

  const groupMeta = await sock.groupMetadata(chatId);
  const sender = msg.key.participant || msg.key.remoteJid;
  const isSenderAdmin = groupMeta.participants.find(p => p.id === sender)?.admin;
  if (!isSenderAdmin) return await sock.sendMessage(chatId, { text: "❌ Admins only." }, { quoted: msg });

  const db = getDB();
  const sub = args[0]?.toLowerCase();

  if (sub === "on" || sub === "enable" || sub === "1") {
    db[chatId] = db[chatId] || {};
    db[chatId].enabled = true;
    db[chatId].message = db[chatId].message || "Welcome @user to @group 🎉\n\n@desc\n\nMembers: @count";
    saveDB(db);
    return await sock.sendMessage(chatId, { text: `✅ *Welcome enabled*\n\nTags: @user @group @count @desc @pp\n\n> *POWERED BY ETIAS-TECH*` }, { quoted: msg });
  }

  if (sub === "off" || sub === "disable" || sub === "0") {
    db[chatId] = db[chatId] || {};
    db[chatId].enabled = false;
    saveDB(db);
    return await sock.sendMessage(chatId, { text: "❌ *Welcome disabled*\n\n> *POWERED BY ETIAS-TECH*" }, { quoted: msg });
  }

  if (sub === "set" || sub === "message") {
    const custom = args.slice(1).join(" ");
    if (!custom) return await sock.sendMessage(chatId, { text: "Usage:.welcome set Welcome @user to @group" }, { quoted: msg });
    db[chatId] = db[chatId] || {};
    db[chatId].message = custom;
    db[chatId].enabled = true;
    saveDB(db);
    return await sock.sendMessage(chatId, { text: `✅ Custom welcome set:\n\n${custom}` }, { quoted: msg });
  }

  if (sub === "status") {
    const conf = db[chatId];
    return await sock.sendMessage(chatId, {
      text: `╭━━━〔 *WELCOME STATUS* 〕━━━\n┃ Status: ${conf?.enabled? "✅ ON" : "❌ OFF"}\n┃ Message: ${conf?.message || "Not set"}\n╰━━━━━━━━━━━━━━━`
    }, { quoted: msg });
  }

  // Get group PP for help preview
  let groupPP = null;
  try { groupPP = await sock.profilePictureUrl(chatId, 'image'); } catch {}

  const helpText = `
╭━━━〔 *${BOT_NAME} WELCOME* 〕━━━┈⊷
┃
┃ 🔧 *Setup Welcome Message*
┃
┃.welcome on - Enable
┃.welcome off - Disable
┃.welcome set <msg> - Custom msg
┃.welcome status - Check
┃
┃ *Tags:*
┃ @user - new member
┃ @group - group name
┃ @count - total members
┃ @desc - group description
┃
┃ *Example:*
┃.welcome set Hello @user Welcome to @group 🎉
┃ Total: @count
┃
╰━━━━━━━━━━━━━━━━━━┈⊷
> *POWERED BY ETIAS-TECH*
`;
  const footer = "*ETIAS-MINI-BOT • POWERED BY ETIAS-TECH*";
  const buttons = [
    { buttonId: '.welcome on', buttonText: { displayText: '✅ ENABLE' }, type: 1 },
    { buttonId: '.welcome off', buttonText: { displayText: '❌ DISABLE' }, type: 1 }
  ];

  try {
    if (groupPP) {
      await sock.sendMessage(chatId, { image: { url: groupPP }, caption: helpText, footer: footer, buttons: buttons, headerType: 4 }, { quoted: msg });
    } else if (fs.existsSync(BOT_IMAGE_PATH)) {
      await sock.sendMessage(chatId, { image: fs.readFileSync(BOT_IMAGE_PATH), caption: helpText, footer: footer, buttons: buttons, headerType: 4 }, { quoted: msg });
    } else {
      await sock.sendMessage(chatId, { text: helpText, footer: footer, buttons: buttons, headerType: 1 }, { quoted: msg });
    }
  } catch {
    await sock.sendMessage(chatId, { text: helpText }, { quoted: msg });
  }
};

// ========================
// ADVANCED EVENT HANDLER - PUT IN index.js
// ========================
/*
const fs = require('fs');
const path = require('path');
const WELCOME_DB = path.join(__dirname, 'database/welcome.json');
const BOT_IMAGE_PATH = path.join(__dirname, 'media/bot.png');

sock.ev.on('group-participants.update', async (anu) => {
  try {
    if (!fs.existsSync(WELCOME_DB)) return;
    const db = JSON.parse(fs.readFileSync(WELCOME_DB));
    if (!db[anu.id] ||!db[anu.id].enabled) return;
    if (anu.action!== 'add') return;

    const groupMeta = await sock.groupMetadata(anu.id);

    // Get Group PP
    let groupPP = null;
    try { groupPP = await sock.profilePictureUrl(anu.id, 'image'); } catch { groupPP = null; }

    // Get Group Description
    const groupDesc = groupMeta.desc || "No description";
    const memberCount = groupMeta.participants.length;
    const groupName = groupMeta.subject;

    for (let participant of anu.participants) {

      // User PP (optional)
      let userPP = null;
      try { userPP = await sock.profilePictureUrl(participant, 'image'); } catch {}

      let text = db[anu.id].message
     .replace(/@user/g, `@${participant.split('@')[0]}`)
     .replace(/@group/g, groupName)
     .replace(/@count/g, memberCount)
     .replace(/@desc/g, groupDesc)
     .replace(/@time/g, new Date().toLocaleTimeString());

      const welcomeCard = `
╭━━━〔 *WELCOME TO ${groupName.toUpperCase()}* 〕━━━┈⊷
┃
┃ 👋 *Hello* @${participant.split('@')[0]}!
┃
┃ 🏷️ *Group:* ${groupName}
┃ 📝 *Description:*
┃ ${groupDesc.slice(0, 150)}${groupDesc.length > 150? '...' : ''}
┃
┃ 👥 *Members:* ${memberCount}
┃ ⏰ *Joined:* ${new Date().toLocaleString()}
┃
┃ ${text}
┃
╰━━━━━━━━━━━━━━━━━━┈⊷

> *POWERED BY ETIAS-TECH*
`;

      // Prefer Group Image, fallback to Bot Image, fallback to text
      if (groupPP) {
        await sock.sendMessage(anu.id, {
          image: { url: groupPP },
          caption: welcomeCard,
          mentions: [participant]
        });
      } else if (fs.existsSync(BOT_IMAGE_PATH)) {
        await sock.sendMessage(anu.id, {
          image: fs.readFileSync(BOT_IMAGE_PATH),
          caption: welcomeCard,
          mentions: [participant]
        });
      } else {
        await sock.sendMessage(anu.id, {
          text: welcomeCard,
          mentions: [participant]
        });
      }
    }
  } catch (e) {
    console.log('[WELCOME EVENT ERROR]', e.message);
  }
});
*/
