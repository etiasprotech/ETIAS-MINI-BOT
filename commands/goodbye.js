const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'database/goodbye.json');
const BOT_IMAGE_PATH = path.join(__dirname, '..', 'media/bot_image.png');
const BOT_NAME = "*ETIAS-MINI-BOT*";

if (!fs.existsSync(path.dirname(DB_PATH))) fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, JSON.stringify({}));

function getDB() { try { return JSON.parse(fs.readFileSync(DB_PATH)); } catch { return {}; } }
function saveDB(data) { fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2)); }

module.exports.name = "goodbye";
module.exports.aliases = ["bye", "leave", "setgoodbye"];
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
    db[chatId].message = db[chatId].message || "Goodbye @user 👋\nWe will miss you from @group\nRemaining: @count members";
    saveDB(db);
    return await sock.sendMessage(chatId, { text: `✅ *Goodbye enabled*\n\nDefault: ${db[chatId].message}\n\n> *POWERED BY ETIAS-TECH*` }, { quoted: msg });
  }

  if (sub === "off" || sub === "disable" || sub === "0") {
    db[chatId] = db[chatId] || {};
    db[chatId].enabled = false;
    saveDB(db);
    return await sock.sendMessage(chatId, { text: "❌ *Goodbye disabled*" }, { quoted: msg });
  }

  if (sub === "set" || sub === "message") {
    const custom = args.slice(1).join(" ");
    if (!custom) return await sock.sendMessage(chatId, { text: "Usage:.goodbye set Goodbye @user" }, { quoted: msg });
    db[chatId] = db[chatId] || {};
    db[chatId].message = custom;
    db[chatId].enabled = true;
    saveDB(db);
    return await sock.sendMessage(chatId, { text: `✅ Custom goodbye set:\n\n${custom}` }, { quoted: msg });
  }

  if (sub === "status") {
    const conf = db[chatId];
    return await sock.sendMessage(chatId, { text: `╭━━━〔 *GOODBYE STATUS* 〕━━━\n┃ ${conf?.enabled? "✅ ON" : "❌ OFF"}\n┃ ${conf?.message || "Not set"}\n╰━━━━━━━` }, { quoted: msg });
  }

  let groupPP = null;
  try { groupPP = await sock.profilePictureUrl(chatId, 'image'); } catch {}

  const helpText = `
╭━━━〔 *${BOT_NAME} GOODBYE* 〕━━━┈⊷
┃
┃ 🔧 *Setup Goodbye*
┃
┃.goodbye on - Enable
┃.goodbye off - Disable
┃.goodbye set <msg> - Custom
┃.goodbye status - Check
┃
┃ *Tags:*
┃ @user @group @count @desc @time
┃
┃ Ex:.goodbye set Goodbye @user 😢
┃ @group now has @count members
┃
╰━━━━━━━━━━━━━━━━━━┈⊷
> *POWERED BY ETIAS-TECH*
`;
  const footer = "*ETIAS-MINI-BOT • POWERED BY ETIAS-TECH*";
  const buttons = [
    { buttonId: '.goodbye on', buttonText: { displayText: '✅ ENABLE' }, type: 1 },
    { buttonId: '.goodbye off', buttonText: { displayText: '❌ DISABLE' }, type: 1 }
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
// ADVANCED GOODBYE EVENT HANDLER - MERGE WITH WELCOME IN index.js
// ========================
/*
const fs = require('fs');
const path = require('path');
const GOODBYE_DB = path.join(__dirname, 'database/goodbye.json');
const BOT_IMAGE_PATH = path.join(__dirname, 'media/bot.png');

sock.ev.on('group-participants.update', async (anu) => {
  try {
    if (!fs.existsSync(GOODBYE_DB)) return;
    const db = JSON.parse(fs.readFileSync(GOODBYE_DB));
    if (!db[anu.id] ||!db[anu.id].enabled) return;
    if (anu.action!== 'remove') return;

    const groupMeta = await sock.groupMetadata(anu.id);

    let groupPP = null;
    try { groupPP = await sock.profilePictureUrl(anu.id, 'image'); } catch { groupPP = null; }

    const groupDesc = groupMeta.desc || "No description";
    const memberCount = groupMeta.participants.length;
    const groupName = groupMeta.subject;

    for (let participant of anu.participants) {

      let text = db[anu.id].message
    .replace(/@user/g, `@${participant.split('@')[0]}`)
    .replace(/@group/g, groupName)
    .replace(/@count/g, memberCount)
    .replace(/@desc/g, groupDesc)
    .replace(/@time/g, new Date().toLocaleTimeString());

      const byeCard = `
╭━━━〔 *GOODBYE FROM ${groupName.toUpperCase()}* 〕━━━┈⊷
┃
┃ 😢 *Goodbye* @${participant.split('@')[0]}!
┃
┃ 🏷️ *Group:* ${groupName}
┃ 📝 *Description:*
┃ ${groupDesc.slice(0, 150)}${groupDesc.length > 150? '...' : ''}
┃
┃ 👥 *Remaining:* ${memberCount} members
┃ ⏰ *Left:* ${new Date().toLocaleString()}
┃
┃ ${text}
┃
╰━━━━━━━━━━━━━━━━━━┈⊷

> *POWERED BY ETIAS-TECH*
`;

      if (groupPP) {
        await sock.sendMessage(anu.id, {
          image: { url: groupPP },
          caption: byeCard,
          mentions: [participant]
        });
      } else if (fs.existsSync(BOT_IMAGE_PATH)) {
        await sock.sendMessage(anu.id, {
          image: fs.readFileSync(BOT_IMAGE_PATH),
          caption: byeCard,
          mentions: [participant]
        });
      } else {
        await sock.sendMessage(anu.id, { text: byeCard, mentions: [participant] });
      }
    }
  } catch (e) {
    console.log('[GOODBYE EVENT ERROR]', e.message);
  }
});

// === COMBINED WELCOME+GOODBYE HANDLER (RECOMMENDED) ===
/*
const fs = require('fs');
const path = require('path');
const WELCOME_DB = path.join(__dirname, 'database/welcome.json');
const GOODBYE_DB = path.join(__dirname, 'database/goodbye.json');
const BOT_IMAGE_PATH = path.join(__dirname, 'media/bot.png');

sock.ev.on('group-participants.update', async (anu) => {
  try {
    const groupMeta = await sock.groupMetadata(anu.id);
    let groupPP = null;
    try { groupPP = await sock.profilePictureUrl(anu.id, 'image'); } catch {}
    const groupDesc = groupMeta.desc || "No description";
    const memberCount = groupMeta.participants.length;
    const groupName = groupMeta.subject;

    const welcomeDB = fs.existsSync(WELCOME_DB)? JSON.parse(fs.readFileSync(WELCOME_DB)) : {};
    const goodbyeDB = fs.existsSync(GOODBYE_DB)? JSON.parse(fs.readFileSync(GOODBYE_DB)) : {};

    for (let p of anu.participants) {
      if (anu.action === 'add' && welcomeDB[anu.id]?.enabled) {
        let txt = welcomeDB[anu.id].message.replace(/@user/g, `@${p.split('@')[0]}`).replace(/@group/g, groupName).replace(/@count/g, memberCount).replace(/@desc/g, groupDesc).replace(/@time/g, new Date().toLocaleTimeString());
        const card = `╭━━━〔 *WELCOME TO ${groupName.toUpperCase()}* 〕━━━\n┃ 👋 Hello @${p.split('@')[0]}!\n┃ 🏷️ Group: ${groupName}\n┃ 📝 Desc: ${groupDesc.slice(0,120)}\n┃ 👥 Members: ${memberCount}\n┃\n┃ ${txt}\n╰━━━━━━━━━━━━━━\n\n> POWERED BY ETIAS-TECH`;
        if (groupPP) await sock.sendMessage(anu.id, { image: { url: groupPP }, caption: card, mentions: [p] });
        else await sock.sendMessage(anu.id, { text: card, mentions: [p] });
      }

      if (anu.action === 'remove' && goodbyeDB[anu.id]?.enabled) {
        let txt = goodbyeDB[anu.id].message.replace(/@user/g, `@${p.split('@')[0]}`).replace(/@group/g, groupName).replace(/@count/g, memberCount).replace(/@desc/g, groupDesc).replace(/@time/g, new Date().toLocaleTimeString());
        const card = `╭━━━〔 *GOODBYE FROM ${groupName.toUpperCase()}* 〕━━━\n┃ 😢 Bye @${p.split('@')[0]}!\n┃ 🏷️ Group: ${groupName}\n┃ 👥 Remaining: ${memberCount}\n┃\n┃ ${txt}\n╰━━━━━━━━━━━━━━\n\n> POWERED BY ETIAS-TECH`;
        if (groupPP) await sock.sendMessage(anu.id, { image: { url: groupPP }, caption: card, mentions: [p] });
        else await sock.sendMessage(anu.id, { text: card, mentions: [p] });
      }
    }
  } catch (e) { console.log(e.message); }
});
*/
