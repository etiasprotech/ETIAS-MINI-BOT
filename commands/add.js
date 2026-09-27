const fs = require('fs');
const path = require('path');

const BOT_IMAGE_PATH = path.join(__dirname, '..', 'media/bot_image.png');
const BOT_NAME = "*ETIAS-MINI-BOT*";

module.exports.name = "add";
module.exports.aliases = ["invite"];
module.exports.execute = async (sock, msg, args) => {
  const chatId = msg.key.remoteJid;
  const isGroup = chatId.endsWith('@g.us');
  if (!isGroup) return await sock.sendMessage(chatId, { text: "❌ Group only command." }, { quoted: msg });

  try {
    const groupMeta = await sock.groupMetadata(chatId);
    const sender = msg.key.participant || msg.key.remoteJid;
    const botId = sock.user.id.split(':')[0] + '@s.whatsapp.net';

    const isSenderAdmin = groupMeta.participants.find(p => p.id === sender)?.admin;
    const isBotAdmin = groupMeta.participants.find(p => p.id === botId)?.admin;

    if (!isSenderAdmin) {
      return await sock.sendMessage(chatId, { text: "❌ *Admins only.*\n\n> *POWERED BY ETIAS-TECH*" }, { quoted: msg });
    }
    if (!isBotAdmin) {
      return await sock.sendMessage(chatId, { text: "❌ *Bot must be admin to add.*\n\n> *POWERED BY ETIAS-TECH*" }, { quoted: msg });
    }

    if (!args[0]) {
      return await sock.sendMessage(chatId, {
        text: `╭━━━〔 *${BOT_NAME} ADD* 〕━━━┈⊷\n┃\n┃ ❌ Usage:.add 263xxxxxxxx\n┃ Example:.add 263785123456\n┃\n┃ Or multiple:.add 2637xxxx,2637xxxx\n┃\n╰━━━━━━━━━━━━━━┈⊷\n\n> *POWERED BY ETIAS-TECH*`
      }, { quoted: msg });
    }

    // Support multiple numbers separated by comma or space
    const numbersRaw = args.join(" ").split(/[\s,]+/);
    const targets = [];

    for (let raw of numbersRaw) {
      let num = raw.replace(/[^0-9]/g, '');
      if (num.length >= 10 && num.length <= 15) {
        targets.push(num + '@s.whatsapp.net');
      }
    }

    if (!targets.length) {
      return await sock.sendMessage(chatId, { text: "❌ Provide valid number. Example: 263785123456" }, { quoted: msg });
    }

    try { await sock.sendMessage(chatId, { react: { text: "➕", key: msg.key } }); } catch {}

    await sock.sendMessage(chatId, { text: `➕ _Adding ${targets.length} user(s)..._` }, { quoted: msg });

    const result = await sock.groupParticipantsUpdate(chatId, targets, "add");

    // Check results
    let added = [];
    let failed = [];

    // result can be array of status objects
    if (Array.isArray(result)) {
      result.forEach((res, i) => {
        if (res.status === "200" || res.status === 200) added.push(targets[i]);
        else failed.push(targets[i]);
      });
    } else {
      added = targets; // assume success if no detailed status
    }

    const addText = `
╭━━━〔 *${BOT_NAME} ADD* 〕━━━┈⊷
┃
┃ ✅ *Added:* ${added.length}
┃ ❌ *Failed:* ${failed.length}
┃ 👤 *Users:* ${added.map(u => '@'+u.split('@')[0]).join(', ').slice(0, 100)}
┃ ➕ *By:* @${sender.split('@')[0]}
┃ 🏷️ *Group:* ${groupMeta.subject.slice(0, 30)}
${failed.length? `┃\n┃ ⚠️ Failed maybe privacy/blocked or needs invite link.` : ''}
┃
╰━━━━━━━━━━━━━━━━━━┈⊷

> *POWERED BY ETIAS-TECH*
`;
    const footer = "*ETIAS-MINI-BOT • POWERED BY ETIAS-TECH*";
    const buttons = [
      { buttonId: '.tagall', buttonText: { displayText: '👥 TAGALL' }, type: 1 },
      { buttonId: '.link', buttonText: { displayText: '🔗 GROUP LINK' }, type: 1 }
    ];

    const mentions = [...added, sender];

    if (fs.existsSync(BOT_IMAGE_PATH)) {
      await sock.sendMessage(chatId, {
        image: fs.readFileSync(BOT_IMAGE_PATH),
        caption: addText,
        footer: footer,
        buttons: buttons,
        headerType: 4,
        mentions: mentions
      }, { quoted: msg });
    } else {
      await sock.sendMessage(chatId, {
        text: addText,
        footer: footer,
        buttons: buttons,
        headerType: 1,
        mentions: mentions
      }, { quoted: msg });
    }

    // If failed due to privacy, send invite
    if (failed.length) {
      try {
        const inviteCode = await sock.groupInviteCode(chatId);
        for (let f of failed) {
          await sock.sendMessage(f, {
            text: `🔗 You were invited to join *${groupMeta.subject}* by @${sender.split('@')[0]}\n\nhttps://chat.whatsapp.com/${inviteCode}\n\n> *POWERED BY ETIAS-TECH*`,
            mentions: [sender]
          });
        }
        await sock.sendMessage(chatId, { text: `📩 Invite link sent to ${failed.length} private user(s).` }, { quoted: msg });
      } catch {}
    }

  } catch (e) {
    console.log('[ADD ERROR]', e.message);
    await sock.sendMessage(chatId, {
      text: `❌ Failed to add: ${e.message}\n\n> *POWERED BY ETIAS-TECH*`
    }, { quoted: msg });
  }
};
