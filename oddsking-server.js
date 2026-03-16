const express     = require('express');
const TelegramBot = require('node-telegram-bot-api');
const path        = require('path');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

// ══════════════════════════════════════
// CONFIG
// ══════════════════════════════════════
const BOT_TOKEN   = process.env.SUPER_ADMIN_BOT_TOKEN;
const PORT        = process.env.PORT || 10000;
const WEBHOOK_URL = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL || `http://localhost:${PORT}`;

console.log('\n=== ENV CHECK ===');
console.log('BOT_TOKEN:    ', BOT_TOKEN ? '✅ SET (' + BOT_TOKEN.substring(0,10) + '...)' : '❌ MISSING');
console.log('WEBHOOK_URL:  ', WEBHOOK_URL);
console.log('=================\n');

if (!BOT_TOKEN) {
    console.error('❌ FATAL: SUPER_ADMIN_BOT_TOKEN not set!');
    process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN);
bot.on('error',         (e) => console.error('❌ Bot error:', e.message));
bot.on('polling_error', (e) => console.error('❌ Polling error:', e.message));

// ══════════════════════════════════════
// IN-MEMORY STORAGE
// ══════════════════════════════════════
// Admins: { adminId → { adminId, chatId, name, email, status, createdAt } }
const admins      = new Map();
const adminByChatId = new Map(); // chatId → adminId  (reverse lookup)
const pausedAdmins  = new Set();

// OddsKing data
let proofImages     = [];   // [{ url, date, caption }]
let todayOdds       = [];   // [{ team1, team2, league, time, odds, pick, unlocked }]
let paymentRequests = {};   // reqId → { adminId, country, method, phone, status, instructions }

// ══════════════════════════════════════
// HELPER FUNCTIONS
// ══════════════════════════════════════
function getAdminByChatId(chatId) {
    const adminId = adminByChatId.get(String(chatId));
    return adminId ? admins.get(adminId) : null;
}

function isAdminActive(chatId) {
    const admin = getAdminByChatId(chatId);
    if (!admin) return false;
    if (admin.adminId === 'ADMIN001') return true;
    return !pausedAdmins.has(admin.adminId);
}

function getNextAdminId() {
    const nums = Array.from(admins.keys())
        .map(id => parseInt(id.replace('ADMIN', '')))
        .filter(n => !isNaN(n));
    const next = nums.length > 0 ? Math.max(...nums) + 1 : 1;
    return `ADMIN${String(next).padStart(3, '0')}`;
}

function saveAdmin(adminData) {
    admins.set(adminData.adminId, adminData);
    if (adminData.chatId) adminByChatId.set(String(adminData.chatId), adminData.adminId);
    if (adminData.status === 'paused') pausedAdmins.add(adminData.adminId);
}

// ══════════════════════════════════════
// WEBHOOK
// ══════════════════════════════════════
app.post('/telegram-webhook', (req, res) => {
    try { bot.processUpdate(req.body); } catch (e) { console.error('processUpdate error:', e.message); }
    res.sendStatus(200);
});

// ══════════════════════════════════════
// BOT COMMAND HANDLERS
// ══════════════════════════════════════
setupCommandHandlers();

function setupCommandHandlers() {

    // /start
    bot.onText(/\/start/, async (msg) => {
        const chatId = msg.chat.id;
        const admin  = getAdminByChatId(chatId);

        if (!admin) {
            return bot.sendMessage(chatId, `
👑 *Welcome to OddsKing Pro!*

Your Chat ID: \`${chatId}\`

Provide this to the super admin to get access.
            `, { parse_mode: 'Markdown' });
        }

        if (pausedAdmins.has(admin.adminId) && admin.adminId !== 'ADMIN001') {
            return bot.sendMessage(chatId, `
🚫 *ACCESS PAUSED*

Your admin access has been paused.
Contact the super admin.

*Your Admin ID:* \`${admin.adminId}\`
            `, { parse_mode: 'Markdown' });
        }

        const isSuperAdmin = admin.adminId === 'ADMIN001';
        let message = `
👑 *Welcome ${admin.name}!*

*Admin ID:* \`${admin.adminId}\`
*Role:* ${isSuperAdmin ? '⭐ Super Admin' : '👤 Admin'}
*Your Personal Link:*
${WEBHOOK_URL}?admin=${admin.adminId}

*Commands:*
/mylink - Your personal link
/stats - Your statistics
/myinfo - Your information

*OddsKing Commands:*
/addmatch Team1 | Team2 | League | Time | Odds | Pick
/unlock MATCH\\_NUMBER
/clearmatches
/pending - Pending payments
`;
        if (isSuperAdmin) {
            message += `
*Admin Management:*
/addadmin NAME|EMAIL|CHATID
/addadminid ADMINID|NAME|EMAIL|CHATID
/pauseadmin ADMINID
/unpauseadmin ADMINID
/removeadmin ADMINID
/admins - List all admins
/send ADMINID message
/broadcast message
`;
        }
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    });

    // /mylink
    bot.onText(/\/mylink/, (msg) => {
        const chatId = msg.chat.id;
        const admin  = getAdminByChatId(chatId);
        if (!admin)               return bot.sendMessage(chatId, '❌ Not registered as admin.');
        if (!isAdminActive(chatId)) return bot.sendMessage(chatId, '🚫 Your access has been paused.');
        bot.sendMessage(chatId, `
🔗 *YOUR PERSONAL LINK*

\`${WEBHOOK_URL}?admin=${admin.adminId}\`

Share this link with your customers.
Payments go directly to you! 💰
        `, { parse_mode: 'Markdown' });
    });

    // /myinfo
    bot.onText(/\/myinfo/, (msg) => {
        const chatId = msg.chat.id;
        const admin  = getAdminByChatId(chatId);
        if (!admin)               return bot.sendMessage(chatId, '❌ Not registered as admin.');
        if (!isAdminActive(chatId)) return bot.sendMessage(chatId, '🚫 Your access has been paused.');
        const statusEmoji = pausedAdmins.has(admin.adminId) ? '🚫' : '✅';
        bot.sendMessage(chatId, `
ℹ️ *YOUR INFO*

👤 ${admin.name}
📧 ${admin.email}
🆔 \`${admin.adminId}\`
💬 Chat ID: \`${chatId}\`
📅 Joined: ${new Date(admin.createdAt).toLocaleString()}
${statusEmoji} Status: ${pausedAdmins.has(admin.adminId) ? 'Paused' : 'Active'}

🔗 ${WEBHOOK_URL}?admin=${admin.adminId}
        `, { parse_mode: 'Markdown' });
    });

    // /stats
    bot.onText(/\/stats/, (msg) => {
        const chatId = msg.chat.id;
        const admin  = getAdminByChatId(chatId);
        if (!admin)               return bot.sendMessage(chatId, '❌ Not registered as admin.');
        if (!isAdminActive(chatId)) return bot.sendMessage(chatId, '🚫 Your access has been paused.');

        const myRequests = Object.values(paymentRequests).filter(r => r.adminId === admin.adminId);
        const pending    = myRequests.filter(r => r.status === 'pending').length;
        const done       = myRequests.filter(r => r.status === 'instructed').length;

        let matchList = '';
        todayOdds.forEach((m, i) => {
            matchList += `\n${i}. ${m.team1} vs ${m.team2} ${m.unlocked ? '🔓' : '🔒'}`;
        });

        bot.sendMessage(chatId, `
📊 *YOUR STATS*

💰 Total Requests: *${myRequests.length}*
⏳ Pending: *${pending}*
✅ Completed: *${done}*
📸 Proof Images: *${proofImages.length}*
⚽ Matches Today: *${todayOdds.length}*
${matchList || '\nNo matches yet.'}
        `, { parse_mode: 'Markdown' });
    });

    // /pending
    bot.onText(/\/pending/, (msg) => {
        const chatId = msg.chat.id;
        const admin  = getAdminByChatId(chatId);
        if (!admin)               return bot.sendMessage(chatId, '❌ Not registered as admin.');
        if (!isAdminActive(chatId)) return bot.sendMessage(chatId, '🚫 Your access has been paused.');

        const myPending = Object.entries(paymentRequests)
            .filter(([, r]) => r.adminId === admin.adminId && r.status === 'pending');

        if (myPending.length === 0) return bot.sendMessage(chatId, '✨ No pending payment requests!');

        let message = `⏳ *PENDING PAYMENTS (${myPending.length})*\n\n`;
        myPending.forEach(([reqId, r], i) => {
            message += `${i+1}. 📱 \`${r.phone}\` — ${r.method} (${r.country})\n`;
            message += `   🆔 \`${reqId}\`\n`;
            message += `   /pay ${reqId} instructions\n\n`;
        });
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    });

    // ── MATCH MANAGEMENT (any admin can manage) ──

    // /addmatch
    bot.onText(/\/addmatch (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        const admin  = getAdminByChatId(chatId);
        if (!admin)               return bot.sendMessage(chatId, '❌ Not registered as admin.');
        if (!isAdminActive(chatId)) return bot.sendMessage(chatId, '🚫 Your access has been paused.');

        const parts = match[1].split('|').map(p => p.trim());
        if (parts.length < 6) {
            return bot.sendMessage(chatId,
                `❌ Format:\n/addmatch Team1 | Team2 | League | Time | Odds | Pick\n\nExample:\n/addmatch Man Utd | Chelsea | EPL | 15:00 GMT | 2.45 | Man Utd Win`
            );
        }
        const [team1, team2, league, time, odds, pick] = parts;
        const idx = todayOdds.push({ team1, team2, league, time, odds, pick, unlocked: false, addedBy: admin.adminId }) - 1;
        bot.sendMessage(chatId, `
✅ *MATCH ADDED* (ID: #${idx})

⚽ ${team1} vs ${team2}
🏆 ${league} — ${time}
📊 Odds: *${odds}*
🎯 Pick: *${pick}* 🔒 LOCKED

Use /unlock ${idx} after payment confirmed.
        `, { parse_mode: 'Markdown' });
    });

    // /unlock
    bot.onText(/\/unlock (\d+)/, (msg, match) => {
        const chatId = msg.chat.id;
        const admin  = getAdminByChatId(chatId);
        if (!admin)               return bot.sendMessage(chatId, '❌ Not registered as admin.');
        if (!isAdminActive(chatId)) return bot.sendMessage(chatId, '🚫 Your access has been paused.');

        const idx = parseInt(match[1]);
        if (!todayOdds[idx]) return bot.sendMessage(chatId, `❌ Match #${idx} not found.`);
        todayOdds[idx].unlocked = true;
        bot.sendMessage(chatId, `
🔓 *PICK UNLOCKED!*

⚽ ${todayOdds[idx].team1} vs ${todayOdds[idx].team2}
🎯 Winning Pick: *${todayOdds[idx].pick}*

✅ Customers can now see the prediction!
        `, { parse_mode: 'Markdown' });
    });

    // /clearmatches
    bot.onText(/\/clearmatches/, (msg) => {
        const chatId = msg.chat.id;
        const admin  = getAdminByChatId(chatId);
        if (!admin)               return bot.sendMessage(chatId, '❌ Not registered as admin.');
        if (!isAdminActive(chatId)) return bot.sendMessage(chatId, '🚫 Your access has been paused.');
        const count = todayOdds.length;
        todayOdds = [];
        bot.sendMessage(chatId, `✅ Cleared ${count} matches. Ready for new day! 🌅`);
    });

    // /pay REQUEST_ID instructions
    bot.onText(/\/pay (.+)/, (msg, match) => {
        const chatId = msg.chat.id;
        const admin  = getAdminByChatId(chatId);
        if (!admin)               return bot.sendMessage(chatId, '❌ Not registered as admin.');
        if (!isAdminActive(chatId)) return bot.sendMessage(chatId, '🚫 Your access has been paused.');

        const input    = match[1].trim();
        const spaceIdx = input.indexOf(' ');
        if (spaceIdx === -1) return bot.sendMessage(chatId, '❌ Use: /pay REQUEST_ID Your instructions here');

        const reqId = input.substring(0, spaceIdx).trim();
        const instr = input.substring(spaceIdx + 1).trim();

        if (!paymentRequests[reqId]) return bot.sendMessage(chatId, `❌ Request not found: \`${reqId}\``, { parse_mode: 'Markdown' });
        if (paymentRequests[reqId].adminId !== admin.adminId) return bot.sendMessage(chatId, '❌ This request belongs to another admin!');

        paymentRequests[reqId].instructions = instr;
        paymentRequests[reqId].status       = 'instructed';

        bot.sendMessage(chatId, `
✅ *PAYMENT INSTRUCTIONS SENT!*

🆔 \`${reqId}\`
📋 ${instr}

🌐 Customer sees this on the website automatically.
        `, { parse_mode: 'Markdown' });
    });

    // ── PHOTO: proof of win ──
    bot.on('photo', async (msg) => {
        const chatId = msg.chat.id;
        const admin  = getAdminByChatId(chatId);
        if (!admin || !isAdminActive(chatId)) return;

        try {
            const fileUrl = await bot.getFileLink(msg.photo[msg.photo.length - 1].file_id);
            const caption = msg.caption || 'Win Proof';
            proofImages.unshift({ url: fileUrl, date: new Date().toISOString(), caption, uploadedBy: admin.name });
            if (proofImages.length > 30) proofImages = proofImages.slice(0, 30);
            bot.sendMessage(chatId, `
✅ *PROOF IMAGE UPLOADED!*

📸 "${caption}"
📅 ${new Date().toLocaleString()}
👤 By: ${admin.name}
🔢 Total: ${proofImages.length}

🌐 Live on website!
            `, { parse_mode: 'Markdown' });
        } catch (err) {
            bot.sendMessage(chatId, `❌ Upload failed: ${err.message}`);
        }
    });

    // ══════════════════════════════════════
    // SUPER ADMIN ONLY COMMANDS
    // ══════════════════════════════════════

    // /addadmin NAME|EMAIL|CHATID
    bot.onText(/\/addadmin (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const admin  = getAdminByChatId(chatId);
        if (!admin || admin.adminId !== 'ADMIN001') return bot.sendMessage(chatId, '❌ Only super admin can add admins.');

        const parts = match[1].trim().split('|').map(p => p.trim());
        if (parts.length !== 3) {
            return bot.sendMessage(chatId, `
❌ *Wrong format*

Use: /addadmin NAME|EMAIL|CHATID

Example:
/addadmin John Doe|john@email.com|123456789
            `, { parse_mode: 'Markdown' });
        }

        const [name, email, chatIdStr] = parts;
        const newChatId = parseInt(chatIdStr);
        if (isNaN(newChatId)) return bot.sendMessage(chatId, '❌ Chat ID must be a number!');

        const newAdminId = getNextAdminId();
        const newAdmin   = { adminId: newAdminId, chatId: newChatId, name, email, status: 'active', createdAt: new Date().toISOString() };
        saveAdmin(newAdmin);

        await bot.sendMessage(chatId, `
✅ *ADMIN ADDED*

👤 ${name}
📧 ${email}
🆔 \`${newAdminId}\`
💬 Chat ID: \`${newChatId}\`

🔗 Their personal link:
${WEBHOOK_URL}?admin=${newAdminId}

✅ Admin is now CONNECTED and ready!
        `, { parse_mode: 'Markdown' });

        bot.sendMessage(newChatId, `
🎉 *YOU ARE NOW AN ADMIN!*

Welcome ${name}!

*Your Admin ID:* \`${newAdminId}\`
*Your Personal Link:*
${WEBHOOK_URL}?admin=${newAdminId}

Share your link with customers.
Their payments come directly to you!

/mylink - Get your link
/stats - Your statistics
/pending - Pending payments
/myinfo - Your information
        `, { parse_mode: 'Markdown' }).catch(() => {
            bot.sendMessage(chatId, '⚠️ Admin added but could not notify them. They need to /start the bot first.');
        });
    });

    // /addadmin with no args — show help
    bot.onText(/\/addadmin$/, (msg) => {
        const chatId = msg.chat.id;
        const admin  = getAdminByChatId(chatId);
        if (!admin || admin.adminId !== 'ADMIN001') return bot.sendMessage(chatId, '❌ Only super admin can add admins.');
        bot.sendMessage(chatId, `
📝 *ADD NEW ADMIN*

Use: /addadmin NAME|EMAIL|CHATID

Example:
/addadmin John Doe|john@email.com|123456789

How to get Chat ID:
1. Ask new admin to /start your bot
2. They get their Chat ID
3. Use that here
        `, { parse_mode: 'Markdown' });
    });

    // /addadminid ADMINID|NAME|EMAIL|CHATID
    bot.onText(/\/addadminid (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const admin  = getAdminByChatId(chatId);
        if (!admin || admin.adminId !== 'ADMIN001') return bot.sendMessage(chatId, '❌ Only super admin can add admins.');

        const parts = match[1].trim().split('|').map(p => p.trim());
        if (parts.length !== 4) {
            return bot.sendMessage(chatId, `
❌ Use: /addadminid ADMINID|NAME|EMAIL|CHATID

Example:
/addadminid ADMIN010|John Doe|john@email.com|123456789
            `, { parse_mode: 'Markdown' });
        }

        const [newAdminId, name, email, chatIdStr] = parts;
        const newChatId = parseInt(chatIdStr);
        if (isNaN(newChatId)) return bot.sendMessage(chatId, '❌ Chat ID must be a number!');
        if (admins.has(newAdminId)) return bot.sendMessage(chatId, `❌ Admin \`${newAdminId}\` already exists!`, { parse_mode: 'Markdown' });

        const newAdmin = { adminId: newAdminId, chatId: newChatId, name, email, status: 'active', createdAt: new Date().toISOString() };
        saveAdmin(newAdmin);

        await bot.sendMessage(chatId, `
✅ *ADMIN ADDED WITH CUSTOM ID*

👤 ${name}
📧 ${email}
🆔 \`${newAdminId}\`
💬 Chat ID: \`${newChatId}\`

🔗 Their link:
${WEBHOOK_URL}?admin=${newAdminId}
        `, { parse_mode: 'Markdown' });

        bot.sendMessage(newChatId, `
🎉 *YOU ARE NOW AN ADMIN!*

Welcome ${name}!
*Your Admin ID:* \`${newAdminId}\`
*Your Link:* ${WEBHOOK_URL}?admin=${newAdminId}

/mylink /stats /pending /myinfo
        `, { parse_mode: 'Markdown' }).catch(() => {
            bot.sendMessage(chatId, '⚠️ Admin added but could not notify them.');
        });
    });

    // /pauseadmin ADMINID
    bot.onText(/\/pauseadmin (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const admin  = getAdminByChatId(chatId);
        if (!admin || admin.adminId !== 'ADMIN001') return bot.sendMessage(chatId, '❌ Only super admin can pause admins.');

        const targetId = match[1].trim();
        if (targetId === 'ADMIN001') return bot.sendMessage(chatId, '🚫 Cannot pause super admin!');
        if (!admins.has(targetId)) return bot.sendMessage(chatId, `❌ Admin \`${targetId}\` not found.`, { parse_mode: 'Markdown' });
        if (pausedAdmins.has(targetId)) return bot.sendMessage(chatId, '⚠️ Admin is already paused.');

        pausedAdmins.add(targetId);
        admins.get(targetId).status = 'paused';

        await bot.sendMessage(chatId, `
🚫 *ADMIN PAUSED*

👤 ${admins.get(targetId).name}
🆔 \`${targetId}\`
⏰ ${new Date().toLocaleString()}

Use /unpauseadmin ${targetId} to restore.
        `, { parse_mode: 'Markdown' });

        const targetChatId = admins.get(targetId).chatId;
        if (targetChatId) bot.sendMessage(targetChatId, '🚫 *YOUR ADMIN ACCESS HAS BEEN PAUSED*\n\nContact super admin.', { parse_mode: 'Markdown' }).catch(() => {});
    });

    // /unpauseadmin ADMINID
    bot.onText(/\/unpauseadmin (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const admin  = getAdminByChatId(chatId);
        if (!admin || admin.adminId !== 'ADMIN001') return bot.sendMessage(chatId, '❌ Only super admin can unpause admins.');

        const targetId = match[1].trim();
        if (!pausedAdmins.has(targetId)) return bot.sendMessage(chatId, '⚠️ Admin is not paused.');
        if (!admins.has(targetId)) return bot.sendMessage(chatId, `❌ Admin \`${targetId}\` not found.`, { parse_mode: 'Markdown' });

        pausedAdmins.delete(targetId);
        admins.get(targetId).status = 'active';

        await bot.sendMessage(chatId, `
✅ *ADMIN UNPAUSED*

👤 ${admins.get(targetId).name}
🆔 \`${targetId}\`
⏰ ${new Date().toLocaleString()}
        `, { parse_mode: 'Markdown' });

        const targetChatId = admins.get(targetId).chatId;
        if (targetChatId) bot.sendMessage(targetChatId, '✅ *YOUR ACCESS HAS BEEN RESTORED!*\n\nUse /start to see commands.', { parse_mode: 'Markdown' }).catch(() => {});
    });

    // /removeadmin ADMINID
    bot.onText(/\/removeadmin (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const admin  = getAdminByChatId(chatId);
        if (!admin || admin.adminId !== 'ADMIN001') return bot.sendMessage(chatId, '❌ Only super admin can remove admins.');

        const targetId = match[1].trim();
        if (targetId === 'ADMIN001') return bot.sendMessage(chatId, '🚫 Cannot remove super admin!');
        if (!admins.has(targetId)) return bot.sendMessage(chatId, `❌ Admin \`${targetId}\` not found.`, { parse_mode: 'Markdown' });

        const target = admins.get(targetId);
        adminByChatId.delete(String(target.chatId));
        admins.delete(targetId);
        pausedAdmins.delete(targetId);

        await bot.sendMessage(chatId, `
🗑️ *ADMIN REMOVED*

👤 ${target.name}
📧 ${target.email}
🆔 \`${targetId}\`
⏰ ${new Date().toLocaleString()}
        `, { parse_mode: 'Markdown' });

        if (target.chatId) bot.sendMessage(target.chatId, '🗑️ *YOU HAVE BEEN REMOVED AS ADMIN*\n\nContact super admin if you have questions.', { parse_mode: 'Markdown' }).catch(() => {});
    });

    // /admins
    bot.onText(/\/admins/, (msg) => {
        const chatId = msg.chat.id;
        const admin  = getAdminByChatId(chatId);
        if (!admin)               return bot.sendMessage(chatId, '❌ Not registered as admin.');
        if (!isAdminActive(chatId)) return bot.sendMessage(chatId, '🚫 Your access has been paused.');

        if (admins.size === 0) return bot.sendMessage(chatId, '👥 No admins yet.');

        let message = `👥 *ALL ADMINS (${admins.size})*\n\n`;
        admins.forEach((a, id) => {
            const isSuperAdmin = id === 'ADMIN001';
            const isPaused     = pausedAdmins.has(id);
            const statusEmoji  = isSuperAdmin ? '⭐' : isPaused ? '🚫' : '✅';
            const statusText   = isSuperAdmin ? 'Super Admin' : isPaused ? 'Paused' : 'Active';
            message += `${statusEmoji} *${a.name}*\n`;
            message += `   🆔 \`${id}\` | 💬 \`${a.chatId}\`\n`;
            message += `   📧 ${a.email}\n`;
            message += `   ${statusText}\n`;
            message += `   🔗 ?admin=${id}\n\n`;
        });
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    });

    // /send ADMINID message
    bot.onText(/\/send (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const admin  = getAdminByChatId(chatId);
        if (!admin || admin.adminId !== 'ADMIN001') return bot.sendMessage(chatId, '❌ Only super admin can send messages.');

        const input    = match[1].trim();
        const spaceIdx = input.indexOf(' ');
        if (spaceIdx === -1) return bot.sendMessage(chatId, '❌ Use: /send ADMINID Your message here');

        const targetId  = input.substring(0, spaceIdx).trim();
        const msgText   = input.substring(spaceIdx + 1).trim();
        const target    = admins.get(targetId);

        if (!target) return bot.sendMessage(chatId, `❌ Admin \`${targetId}\` not found.`, { parse_mode: 'Markdown' });

        bot.sendMessage(target.chatId, `
📨 *MESSAGE FROM SUPER ADMIN*

${msgText}

⏰ ${new Date().toLocaleString()}
        `, { parse_mode: 'Markdown' })
        .then(() => bot.sendMessage(chatId, `✅ Message sent to ${target.name}`))
        .catch(() => bot.sendMessage(chatId, `❌ Could not reach ${target.name}`));
    });

    // /broadcast message
    bot.onText(/\/broadcast (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const admin  = getAdminByChatId(chatId);
        if (!admin || admin.adminId !== 'ADMIN001') return bot.sendMessage(chatId, '❌ Only super admin can broadcast.');

        const msgText = match[1].trim();
        let success = 0, fail = 0;
        const results = [];

        for (const [id, a] of admins) {
            if (id === 'ADMIN001') continue;
            try {
                await bot.sendMessage(a.chatId, `
📢 *BROADCAST FROM SUPER ADMIN*

${msgText}

⏰ ${new Date().toLocaleString()}
                `, { parse_mode: 'Markdown' });
                success++; results.push(`✅ ${a.name}`);
            } catch {
                fail++; results.push(`❌ ${a.name}`);
            }
            await new Promise(r => setTimeout(r, 100));
        }

        bot.sendMessage(chatId, `
📢 *BROADCAST COMPLETE*

✅ Sent: ${success}
❌ Failed: ${fail}

${results.join('\n')}
        `, { parse_mode: 'Markdown' });
    });

    console.log('✅ All command handlers registered!');
}

// ══════════════════════════════════════
// API ENDPOINTS
// ══════════════════════════════════════

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'oddsking-pro.html')));

app.get('/health', (req, res) => res.json({
    status: 'ok',
    admins: admins.size,
    matches: todayOdds.length,
    proofs: proofImages.length,
    requests: Object.keys(paymentRequests).length,
    timestamp: new Date().toISOString()
}));

// Validate admin link
app.get('/api/validate-admin/:adminId', (req, res) => {
    const admin = admins.get(req.params.adminId);
    if (admin && admin.status === 'active' && !pausedAdmins.has(admin.adminId)) {
        res.json({ success: true, valid: true, admin: { id: admin.adminId, name: admin.name } });
    } else {
        res.json({ success: true, valid: false });
    }
});

// Get today's odds
app.get('/api/odds', (req, res) => {
    const safe = todayOdds.map(o => ({ ...o, pick: o.unlocked ? o.pick : null }));
    res.json({ odds: safe });
});

// Get proof images
app.get('/api/proof-images', (req, res) => {
    res.json({ images: proofImages });
});

// Customer submits payment request
app.post('/api/payment-request', async (req, res) => {
    try {
        const { requestId, country, method, phone, adminId: reqAdminId } = req.body;

        // Find which admin to notify
        let targetAdmin = null;
        if (reqAdminId && admins.has(reqAdminId)) {
            targetAdmin = admins.get(reqAdminId);
        } else {
            // Auto-assign to first active admin
            for (const [, a] of admins) {
                if (a.status === 'active' && !pausedAdmins.has(a.adminId)) {
                    targetAdmin = a; break;
                }
            }
        }

        if (!targetAdmin) return res.status(503).json({ success: false, message: 'No admin available' });

        paymentRequests[requestId] = {
            adminId:      targetAdmin.adminId,
            country, method, phone,
            status:       'pending',
            instructions: null,
            createdAt:    new Date().toISOString()
        };

        await bot.sendMessage(targetAdmin.chatId, `
💰 *NEW PAYMENT REQUEST*

🆔 \`${requestId}\`
🌍 Country: *${country}*
💳 Method: *${method}*
📱 Phone: \`${phone}\`
⏰ ${new Date().toLocaleString()}

━━━━━━━━━━━━━━━━
Reply with:
/pay ${requestId} Your instructions here

Example:
/pay ${requestId} Send KES 200 to M-Pesa 0712345678
        `, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[
                    { text: '❌ Decline', callback_data: `decline_${requestId}` }
                ]]
            }
        });

        res.json({ success: true, requestId, assignedTo: targetAdmin.name });
    } catch (err) {
        console.error('❌ Payment request error:', err.message);
        res.status(500).json({ success: false });
    }
});

// Poll for payment instructions
app.get('/api/payment-status/:id', (req, res) => {
    const r = paymentRequests[req.params.id];
    if (!r)             return res.json({ status: 'not_found' });
    if (r.instructions) return res.json({ status: 'ready', instructions: r.instructions });
    res.json({ status: 'pending' });
});

// Callback query handler
bot.on('callback_query', async (cb) => {
    const data   = cb.data;
    const chatId = cb.message.chat.id;

    if (data.startsWith('decline_')) {
        const reqId = data.replace('decline_', '');
        if (paymentRequests[reqId]) {
            paymentRequests[reqId].status       = 'declined';
            paymentRequests[reqId].instructions = '❌ Request declined. Please contact support.';
        }
        await bot.answerCallbackQuery(cb.id, { text: '❌ Declined' });
        await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: cb.message.message_id });
        bot.sendMessage(chatId, `❌ Request declined.`);
    }
});

// ══════════════════════════════════════
// START SERVER + WEBHOOK
// ══════════════════════════════════════
async function start() {
    // ── Auto-create super admin from env ──
    const superAdminChatId = process.env.SUPER_ADMIN_CHAT_ID;
    if (superAdminChatId) {
        const superAdmin = {
            adminId:   'ADMIN001',
            chatId:    parseInt(superAdminChatId),
            name:      'Super Admin',
            email:     'superadmin@oddsking.pro',
            status:    'active',
            createdAt: new Date().toISOString()
        };
        saveAdmin(superAdmin);
        console.log(`✅ Super admin loaded: ADMIN001 → chatId ${superAdminChatId}`);
    } else {
        console.warn('⚠️ SUPER_ADMIN_CHAT_ID not set — super admin not configured!');
    }

    // Start server first
    await new Promise((resolve, reject) => {
        app.listen(PORT, '0.0.0.0', () => {
            console.log(`✅ Server listening on 0.0.0.0:${PORT}`);
            resolve();
        }).on('error', reject);
    });

    // Set webhook
    try {
        await bot.deleteWebHook();
        await new Promise(r => setTimeout(r, 1000));
        const webhookUrl = `${WEBHOOK_URL}/telegram-webhook`;
        await bot.setWebHook(webhookUrl, {
            drop_pending_updates: false,
            max_connections: 40,
            allowed_updates: ['message', 'callback_query']
        });
        const info = await bot.getWebHookInfo();
        console.log(`✅ Webhook: ${info.url}`);
        const me = await bot.getMe();
        console.log(`✅ Bot: @${me.username}`);
        console.log(`\n👑 ODDSKING PRO READY! Admins: ${admins.size}\n`);
    } catch (err) {
        console.error('❌ Webhook error:', err.message);
    }

    // Keep-alive ping every 14 minutes
    setInterval(() => {
        fetch(`${WEBHOOK_URL}/health`).catch(() => {});
        console.log(`💓 Alive | Admins: ${admins.size} | Matches: ${todayOdds.length}`);
    }, 14 * 60 * 1000);
}

start().catch(err => {
    console.error('❌ Fatal:', err.message);
    process.exit(1);
});

process.on('SIGTERM', async () => {
    await bot.deleteWebHook().catch(() => {});
    process.exit(0);
});
process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e?.message));
process.on('uncaughtException',  (e) => console.error('Uncaught exception:', e?.message));
