const { downloadContentFromMessage } = require('@whiskeysockets/baileys');

module.exports.name = "viewonce";
module.exports.aliases = ["vv", "vo", "rvo", "openviewonce", "readvo", "antivv"];

module.exports.execute = async (sock, msg, args) => {
  const chatId = msg.key.remoteJid;

  const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
  const quotedMsg = contextInfo?.quotedMessage;

  if (!quotedMsg) {
    return await sock.sendMessage(chatId, {
      text: "❌ *Reply to a view once message*\n\nUsage: reply to view once image/video then type\n`.vv`\n\n> *POWERED BY ETIAS-TECH*"
    }, { quoted: msg });
  }

  try {
    // Detect viewonce content - supports ALL formats
    let mediaMsg = null;
    let type = null;
    let caption = "";

    // Case 1: Direct imageMessage/videoMessage with viewOnce flag
    if (quotedMsg.imageMessage?.viewOnce || quotedMsg.imageMessage?.viewOnce === true) {
      mediaMsg = quotedMsg.imageMessage;
      type = "image";
      caption = mediaMsg.caption || "";
    } else if (quotedMsg.videoMessage?.viewOnce || quotedMsg.videoMessage?.viewOnce === true) {
      mediaMsg = quotedMsg.videoMessage;
      type = "video";
      caption = mediaMsg.caption || "";
    }
    // Case 2: Wrapped in viewOnceMessage
    else if (quotedMsg.viewOnceMessage?.message) {
      const inner = quotedMsg.viewOnceMessage.message;
      const innerType = Object.keys(inner)[0];
      mediaMsg = inner[innerType];
      type = innerType.includes('image')? 'image' : innerType.includes('video')? 'video' : 'audio';
      caption = mediaMsg.caption || "";
    }
    // Case 3: Wrapped in viewOnceMessageV2
    else if (quotedMsg.viewOnceMessageV2?.message) {
      const inner = quotedMsg.viewOnceMessageV2.message;
      const innerType = Object.keys(inner)[0];
      mediaMsg = inner[innerType];
      type = innerType.includes('image')? 'image' : innerType.includes('video')? 'video' : 'audio';
      caption = mediaMsg.caption || "";
    }
    // Case 4: V2 Extension
    else if (quotedMsg.viewOnceMessageV2Extension?.message) {
      const inner = quotedMsg.viewOnceMessageV2Extension.message;
      const innerType = Object.keys(inner)[0];
      mediaMsg = inner[innerType];
      type = innerType.includes('image')? 'image' : innerType.includes('video')? 'video' : 'audio';
      caption = mediaMsg.caption || "";
    }

    if (!mediaMsg) {
      return await sock.sendMessage(chatId, {
        text: "❌ That is not a view once message.\n\nMake sure you REPLIED to a view once photo/video.\n\n> *POWERED BY ETIAS-TECH*"
      }, { quoted: msg });
    }

    await sock.sendMessage(chatId, { react: { text: "👁️", key: msg.key } }).catch(()=>{});

    // DOWNLOAD USING downloadContentFromMessage - MOST STABLE METHOD
    let buffer = Buffer.from([]);
    const stream = await downloadContentFromMessage(mediaMsg, type);

    for await (const chunk of stream) {
      buffer = Buffer.concat([buffer, chunk]);
    }

    if (!buffer || buffer.length === 0) throw new Error("Empty buffer");

    const finalCaption = `╭━━━〔 *VIEW ONCE OPENED* 〕━━━\n┃ ${caption? `📝 Caption: ${caption}` : "📂 No caption"}\n┃ 👁️ Type: ${type.toUpperCase()}\n╰━━━━━━━━━━━━\n\n> *POWERED BY ETIAS-TECH*`;

    if (type === "image") {
      await sock.sendMessage(chatId, {
        image: buffer,
        caption: finalCaption
      }, { quoted: msg });
    } else if (type === "video") {
      await sock.sendMessage(chatId, {
        video: buffer,
        caption: finalCaption,
        mimetype: 'video/mp4'
      }, { quoted: msg });
    } else if (type === "audio") {
      await sock.sendMessage(chatId, {
        audio: buffer,
        mimetype: 'audio/mp4',
        ptt: mediaMsg.ptt || false
      }, { quoted: msg });
    }

    console.log(`[VV MANUAL] Opened ${type} for ${chatId}`);

  } catch (e) {
    console.log("[VV ERROR]", e);
    await sock.sendMessage(chatId, {
      text: `❌ Failed to open view once: ${e.message}\n\nTip: The view once may have expired or WhatsApp changed format.\n\n> *POWERED BY ETIAS-TECH*`
    }, { quoted: msg });
  }
};
