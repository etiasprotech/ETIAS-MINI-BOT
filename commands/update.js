const { execSync } = require('child_process');

module.exports = {
  name: "update",
  alias: ["gitpull"],
  desc: "Update bot from GitHub",
  category: "owner",
  async run(m, { sock, isOwner }) {
    if (!isOwner) return m.reply("Owner only!");
    
    try {
      m.reply("🔄 *Updating ETIAS-MINI-BOT...*");
      
      execSync('git pull origin main', { stdio: 'inherit' });
      execSync('npm install', { stdio: 'inherit' });
      
      await m.reply("✅ *Updated successfully! Restarting...*");
      
      setTimeout(() => {
        process.exit(0); // Render will auto restart
      }, 2000);
      
    } catch (e) {
      m.reply(`❌ Update failed:\n${e.message}`);
    }
  }
}
