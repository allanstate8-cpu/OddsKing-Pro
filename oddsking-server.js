const express     = require('express');
const TelegramBot = require('node-telegram-bot-api');
const path        = require('path');
require('dotenv').config();

const db = require('./oddsking-db');

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
console.log('MONGODB_URI:  ', process.env.MONGODB_URI ? '✅ SET' : '❌ MISSING');
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
// IN-MEMORY CACHE (synced with MongoDB)
// ══════════════════════════════════════
const adminCache    = new Map(); // adminId → adminData
const adminByChatId = new Map(); // chatId  → adminId
const pausedAdmins  = new Set();
let   dbReady       = false;

// ══════════════════════════════════════
// HELPER FUNCTIONS
// ══════════════════════════════════════
function cacheAdmin(data) {
    adminCache.set(data.adminId, data);
    if (data.chatId) adminByChatId.set(String(data.chatId), data.adminId);
    if (data.status === 'paused') pausedAdmins.add(data.adminId);
    else pausedAdmins.delete(data.adminId);
}

function getAdminByChatId(chatId) {
    const adminId = adminByChatId.get(String(chatId));
    return adminId ? adminCache.get(adminId) : null;
}

function isAdminActive(chatId) {
    const admin = getAdminByChatId(chatId);
    if (!admin) return false;
    if (admin.adminId === 'ADMIN001') return true;
    return !pausedAdmins.has(admin.adminId);
}

function getNextAdminId() {
    const nums = Array.from(adminCache.keys())
        .map(id => parseInt(id.replace('ADMIN', '')))
        .filter(n => !isNaN(n));
    const next = nums.length > 0 ? Math.max(...nums) + 1 : 1;
    return `ADMIN${String(next).padStart(3, '0')}`;
}

async function loadAdminsFromDB() {
    const allAdmins = await db.getAllAdmins();
    adminCache.clear();
    adminByChatId.clear();
    pausedAdmins.clear();
    for (const admin of allAdmins) cacheAdmin(admin);
    console.log(`✅ Loaded ${allAdmins.length} admins from MongoDB`);
}

// ══════════════════════════════════════
// WEBHOOK
// ══════════════════════════════════════
app.post('/telegram-webhook', (req, res) => {
    try { bot.processUpdate(req.body); } catch (e) { console.error('processUpdate error:', e.message); }
    res.sendStatus(200);
});

// DB-ready middleware
app.use((req, res, next) => {
    if (!dbReady && !req.path.includes('/health') && !req.path.includes('/telegram-webhook')) {
        return res.status(503).json({ success: false, message: 'Server starting up, please wait...' });
    }
    next();
});

// ══════════════════════════════════════
// BOT COMMAND HANDLERS
// ══════════════════════════════════════
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
/pending - Pending payments

*OddsKing Commands:*
/addmatch Team1 | Team2 | League | Time | Odds | Pick
/unlock MATCH\\_ID
/clearmatches
`;
        if (isSuperAdmin) {
            message += `
*Admin Management:*
/addadmin NAME|EMAIL|CHATID
/pauseadmin ADMINID
/unpauseadmin ADMINID
/removeadmin ADMINID
/admins
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
        if (!admin)                return bot.sendMessage(chatId, '❌ Not registered as admin.');
        if (!isAdminActive(chatId)) return bot.sendMessage(chatId, '🚫 Your access has been paused.');
        bot.sendMessage(chatId, `
🔗 *YOUR PERSONAL LINK*

\`${WEBHOOK_URL}?admin=${admin.adminId}\`

Share this with your customers.
Their payments come directly to you! 💰
        `, { parse_mode: 'Markdown' });
    });

    // /myinfo
    bot.onText(/\/myinfo/, (msg) => {
        const chatId = msg.chat.id;
        const admin  = getAdminByChatId(chatId);
        if (!admin)                return bot.sendMessage(chatId, '❌ Not registered as admin.');
        if (!isAdminActive(chatId)) return bot.sendMessage(chatId, '🚫 Your access has been paused.');
        bot.sendMessage(chatId, `
ℹ️ *YOUR INFO*

👤 ${admin.name}
📧 ${admin.email}
🆔 \`${admin.adminId}\`
💬 Chat ID: \`${chatId}\`
📅 Joined: ${new Date(admin.createdAt).toLocaleString()}
${pausedAdmins.has(admin.adminId) ? '🚫 Paused' : '✅ Active'}

🔗 ${WEBHOOK_URL}?admin=${admin.adminId}
        `, { parse_mode: 'Markdown' });
    });

    // /stats
    bot.onText(/\/stats/, async (msg) => {
        const chatId = msg.chat.id;
        const admin  = getAdminByChatId(chatId);
        if (!admin)                return bot.sendMessage(chatId, '❌ Not registered as admin.');
        if (!isAdminActive(chatId)) return bot.sendMessage(chatId, '🚫 Your access has been paused.');

        const myRequests = await db.getPaymentsByAdmin(admin.adminId);
        const pending    = myRequests.filter(r => r.status === 'pending').length;
        const done       = myRequests.filter(r => r.status === 'instructed').length;
        const todayOdds  = await db.getTodayOdds();
        const proofs     = await db.getProofImages(100);

        let matchList = '';
        todayOdds.forEach((m, i) => {
            matchList += `\n${i}. ${m.team1} vs ${m.team2} ${m.unlocked ? '🔓' : '🔒'}`;
        });

        bot.sendMessage(chatId, `
📊 *YOUR STATS*

💰 Total Requests: *${myRequests.length}*
⏳ Pending: *${pending}*
✅ Completed: *${done}*
📸 Proof Images: *${proofs.length}*
⚽ Matches Today: *${todayOdds.length}*
${matchList || '\nNo matches yet.'}
        `, { parse_mode: 'Markdown' });
    });

    // /pending
    bot.onText(/\/pending/, async (msg) => {
        const chatId = msg.chat.id;
        const admin  = getAdminByChatId(chatId);
        if (!admin)                return bot.sendMessage(chatId, '❌ Not registered as admin.');
        if (!isAdminActive(chatId)) return bot.sendMessage(chatId, '🚫 Your access has been paused.');

        const myPending = await db.getPaymentsByAdmin(admin.adminId);
        const pending   = myPending.filter(r => r.status === 'pending');

        if (pending.length === 0) return bot.sendMessage(chatId, '✨ No pending payment requests!');

        let message = `⏳ *PENDING PAYMENTS (${pending.length})*\n\n`;
        pending.forEach((r, i) => {
            message += `${i+1}. 📱 \`${r.phone}\` — ${r.method} (${r.country})\n`;
            message += `   🆔 \`${r.requestId}\`\n`;
            message += `   /pay ${r.requestId} instructions\n\n`;
        });
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    });

    // /addmatch
    bot.onText(/\/addmatch (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const admin  = getAdminByChatId(chatId);
        if (!admin)                return bot.sendMessage(chatId, '❌ Not registered as admin.');
        if (!isAdminActive(chatId)) return bot.sendMessage(chatId, '🚫 Your access has been paused.');

        const parts = match[1].split('|').map(p => p.trim());
        if (parts.length < 6) {
            return bot.sendMessage(chatId,
                `❌ Format:\n/addmatch Team1 | Team2 | League | Time | Odds | Pick\n\nExample:\n/addmatch Man Utd | Chelsea | EPL | 15:00 GMT | 2.45 | Man Utd Win`
            );
        }
        const [team1, team2, league, time, odds, pick] = parts;
        const matchData = { team1, team2, league, time, odds, pick, unlocked: false, addedBy: admin.adminId, date: new Date() };
        const result    = await db.saveMatch(matchData);
        const matchId   = result.insertedId.toString();

        bot.sendMessage(chatId, `
✅ *MATCH ADDED*

⚽ ${team1} vs ${team2}
🏆 ${league} — ${time}
📊 Odds: *${odds}*
🎯 Pick: *${pick}* 🔒 LOCKED
🆔 ID: \`${matchId}\`

Use /unlock ${matchId} after payment confirmed.
        `, { parse_mode: 'Markdown' });
    });

    // /unlock MATCH_ID
    bot.onText(/\/unlock (.+)/, async (msg, match) => {
        const chatId  = msg.chat.id;
        const admin   = getAdminByChatId(chatId);
        if (!admin)                return bot.sendMessage(chatId, '❌ Not registered as admin.');
        if (!isAdminActive(chatId)) return bot.sendMessage(chatId, '🚫 Your access has been paused.');

        const matchId = match[1].trim();
        try {
            await db.updateMatch(matchId, { unlocked: true });
            bot.sendMessage(chatId, `🔓 *PICK UNLOCKED!*\n\nMatch ID: \`${matchId}\`\n✅ Customers can now see the prediction!`, { parse_mode: 'Markdown' });
        } catch (e) {
            bot.sendMessage(chatId, `❌ Match not found: \`${matchId}\``, { parse_mode: 'Markdown' });
        }
    });

    // /clearmatches
    bot.onText(/\/clearmatches/, async (msg) => {
        const chatId = msg.chat.id;
        const admin  = getAdminByChatId(chatId);
        if (!admin)                return bot.sendMessage(chatId, '❌ Not registered as admin.');
        if (!isAdminActive(chatId)) return bot.sendMessage(chatId, '🚫 Your access has been paused.');
        const result = await db.clearTodayOdds();
        bot.sendMessage(chatId, `✅ Cleared ${result.deletedCount} matches. Ready for new day! 🌅`);
    });

    // /pay REQUEST_ID instructions
    bot.onText(/\/pay (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const admin  = getAdminByChatId(chatId);
        if (!admin)                return bot.sendMessage(chatId, '❌ Not registered as admin.');
        if (!isAdminActive(chatId)) return bot.sendMessage(chatId, '🚫 Your access has been paused.');

        const input    = match[1].trim();
        const spaceIdx = input.indexOf(' ');
        if (spaceIdx === -1) return bot.sendMessage(chatId, '❌ Use: /pay REQUEST_ID Your instructions here');

        const reqId = input.substring(0, spaceIdx).trim();
        const instr = input.substring(spaceIdx + 1).trim();

        const request = await db.getPaymentRequest(reqId);
        if (!request) return bot.sendMessage(chatId, `❌ Request not found: \`${reqId}\``, { parse_mode: 'Markdown' });
        if (request.adminId !== admin.adminId) return bot.sendMessage(chatId, '❌ This request belongs to another admin!');

        await db.updatePaymentRequest(reqId, { instructions: instr, status: 'instructed' });

        bot.sendMessage(chatId, `
✅ *PAYMENT INSTRUCTIONS SENT!*

🆔 \`${reqId}\`
📋 ${instr}

🌐 Customer sees this on the website automatically.
        `, { parse_mode: 'Markdown' });
    });

    // Photo handler — proof of win
    bot.on('photo', async (msg) => {
        const chatId = msg.chat.id;
        const admin  = getAdminByChatId(chatId);
        if (!admin || !isAdminActive(chatId)) return;

        try {
            const fileUrl = await bot.getFileLink(msg.photo[msg.photo.length - 1].file_id);
            const caption = msg.caption || 'Win Proof';
            await db.saveProofImage({ url: fileUrl, date: new Date(), caption, uploadedBy: admin.name });
            bot.sendMessage(chatId, `
✅ *PROOF IMAGE UPLOADED!*

📸 "${caption}"
📅 ${new Date().toLocaleString()}
👤 By: ${admin.name}

🌐 Live on website! 💾 Saved to database!
            `, { parse_mode: 'Markdown' });
        } catch (err) {
            bot.sendMessage(chatId, `❌ Upload failed: ${err.message}`);
        }
    });

    // ── SUPER ADMIN COMMANDS ──

    // /addadmin NAME|EMAIL|CHATID
    bot.onText(/\/addadmin (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const admin  = getAdminByChatId(chatId);
        if (!admin || admin.adminId !== 'ADMIN001') return bot.sendMessage(chatId, '❌ Only super admin can add admins.');

        const parts = match[1].trim().split('|').map(p => p.trim());
        if (parts.length !== 3) {
            return bot.sendMessage(chatId, `
❌ Wrong format!

Use: /addadmin NAME|EMAIL|CHATID

Example:
/addadmin John Doe|john@email.com|123456789
            `);
        }

        const [name, email, chatIdStr] = parts;
        const newChatId  = parseInt(chatIdStr);
        if (isNaN(newChatId)) return bot.sendMessage(chatId, '❌ Chat ID must be a number!');

        const newAdminId = getNextAdminId();
        const newAdmin   = { adminId: newAdminId, chatId: newChatId, name, email, status: 'active', createdAt: new Date().toISOString() };

        await db.saveAdmin(newAdmin);
        cacheAdmin(newAdmin);

        await bot.sendMessage(chatId, `
✅ *ADMIN ADDED*

👤 ${name}
📧 ${email}
🆔 \`${newAdminId}\`
💬 Chat ID: \`${newChatId}\`

🔗 Their personal link:
${WEBHOOK_URL}?admin=${newAdminId}

✅ Saved to database permanently!
        `, { parse_mode: 'Markdown' });

        bot.sendMessage(newChatId, `
🎉 *YOU ARE NOW AN ADMIN!*

Welcome ${name}!

*Your Admin ID:* \`${newAdminId}\`
*Your Personal Link:*
${WEBHOOK_URL}?admin=${newAdminId}

Share your link with customers.
Their payments come directly to you! 💰

/mylink /stats /pending /myinfo
        `, { parse_mode: 'Markdown' }).catch(() => {
            bot.sendMessage(chatId, '⚠️ Admin saved but could not notify them. They need to /start the bot first.');
        });
    });

    // /addadmin with no args
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
2. They see their Chat ID
3. Use that Chat ID here
        `);
    });

    // /pauseadmin ADMINID
    bot.onText(/\/pauseadmin (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const admin  = getAdminByChatId(chatId);
        if (!admin || admin.adminId !== 'ADMIN001') return bot.sendMessage(chatId, '❌ Only super admin can pause admins.');

        const targetId = match[1].trim();
        if (targetId === 'ADMIN001') return bot.sendMessage(chatId, '🚫 Cannot pause super admin!');
        const target = adminCache.get(targetId);
        if (!target) return bot.sendMessage(chatId, `❌ Admin \`${targetId}\` not found.`, { parse_mode: 'Markdown' });
        if (pausedAdmins.has(targetId)) return bot.sendMessage(chatId, '⚠️ Admin is already paused.');

        pausedAdmins.add(targetId);
        target.status = 'paused';
        await db.updateAdmin(targetId, { status: 'paused' });

        await bot.sendMessage(chatId, `
🚫 *ADMIN PAUSED*

👤 ${target.name}
🆔 \`${targetId}\`
⏰ ${new Date().toLocaleString()}

Use /unpauseadmin ${targetId} to restore.
        `, { parse_mode: 'Markdown' });

        if (target.chatId) bot.sendMessage(target.chatId, '🚫 *YOUR ADMIN ACCESS HAS BEEN PAUSED*\n\nContact super admin.', { parse_mode: 'Markdown' }).catch(() => {});
    });

    // /unpauseadmin ADMINID
    bot.onText(/\/unpauseadmin (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const admin  = getAdminByChatId(chatId);
        if (!admin || admin.adminId !== 'ADMIN001') return bot.sendMessage(chatId, '❌ Only super admin can unpause admins.');

        const targetId = match[1].trim();
        if (!pausedAdmins.has(targetId)) return bot.sendMessage(chatId, '⚠️ Admin is not paused.');
        const target = adminCache.get(targetId);
        if (!target) return bot.sendMessage(chatId, `❌ Admin \`${targetId}\` not found.`, { parse_mode: 'Markdown' });

        pausedAdmins.delete(targetId);
        target.status = 'active';
        await db.updateAdmin(targetId, { status: 'active' });

        await bot.sendMessage(chatId, `
✅ *ADMIN UNPAUSED*

👤 ${target.name}
🆔 \`${targetId}\`
⏰ ${new Date().toLocaleString()}
        `, { parse_mode: 'Markdown' });

        if (target.chatId) bot.sendMessage(target.chatId, '✅ *YOUR ACCESS HAS BEEN RESTORED!*\n\nUse /start to see your commands.', { parse_mode: 'Markdown' }).catch(() => {});
    });

    // /removeadmin ADMINID
    bot.onText(/\/removeadmin (.+)/, async (msg, match) => {
        const chatId = msg.chat.id;
        const admin  = getAdminByChatId(chatId);
        if (!admin || admin.adminId !== 'ADMIN001') return bot.sendMessage(chatId, '❌ Only super admin can remove admins.');

        const targetId = match[1].trim();
        if (targetId === 'ADMIN001') return bot.sendMessage(chatId, '🚫 Cannot remove super admin!');
        const target = adminCache.get(targetId);
        if (!target) return bot.sendMessage(chatId, `❌ Admin \`${targetId}\` not found.`, { parse_mode: 'Markdown' });

        await db.deleteAdmin(targetId);
        adminByChatId.delete(String(target.chatId));
        adminCache.delete(targetId);
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
        if (!admin)                return bot.sendMessage(chatId, '❌ Not registered as admin.');
        if (!isAdminActive(chatId)) return bot.sendMessage(chatId, '🚫 Your access has been paused.');

        if (adminCache.size === 0) return bot.sendMessage(chatId, '👥 No admins yet.');

        let message = `👥 *ALL ADMINS (${adminCache.size})*\n\n`;
        adminCache.forEach((a, id) => {
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

        const targetId = input.substring(0, spaceIdx).trim();
        const msgText  = input.substring(spaceIdx + 1).trim();
        const target   = adminCache.get(targetId);

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

        for (const [id, a] of adminCache) {
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

✅ Sent: ${success}  ❌ Failed: ${fail}

${results.join('\n')}
        `, { parse_mode: 'Markdown' });
    });

    // Callback query
    bot.on('callback_query', async (cb) => {
        const data   = cb.data;
        const chatId = cb.message.chat.id;
        if (data.startsWith('decline_')) {
            const reqId = data.replace('decline_', '');
            await db.updatePaymentRequest(reqId, { status: 'declined', instructions: '❌ Request declined. Please contact support.' });
            await bot.answerCallbackQuery(cb.id, { text: '❌ Declined' });
            await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: cb.message.message_id });
            bot.sendMessage(chatId, `❌ Request \`${reqId}\` declined.`, { parse_mode: 'Markdown' });
        }
    });

    console.log('✅ All command handlers registered!');
}

// ══════════════════════════════════════
// API ENDPOINTS
// ══════════════════════════════════════

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'oddsking-pro.html')));

app.get('/health', (req, res) => res.json({
    status:   'ok',
    database: dbReady ? 'connected' : 'not ready',
    admins:   adminCache.size,
    timestamp: new Date().toISOString()
}));

app.get('/api/validate-admin/:adminId', (req, res) => {
    const admin = adminCache.get(req.params.adminId);
    if (admin && admin.status === 'active' && !pausedAdmins.has(admin.adminId)) {
        res.json({ success: true, valid: true, admin: { id: admin.adminId, name: admin.name } });
    } else {
        res.json({ success: true, valid: false });
    }
});

app.get('/api/odds', async (req, res) => {
    const odds = await db.getTodayOdds();
    const safe = odds.map(o => ({ ...o, pick: o.unlocked ? o.pick : null }));
    res.json({ odds: safe });
});

app.get('/api/proof-images', async (req, res) => {
    const images = await db.getProofImages(30);
    res.json({ images });
});

app.post('/api/payment-request', async (req, res) => {
    try {
        const { requestId, country, method, phone, adminId: reqAdminId } = req.body;
        console.log('💰 Payment request received:', { requestId, country, method, phone, reqAdminId });
        console.log('👥 Admins in cache:', adminCache.size, Array.from(adminCache.keys()));

        // Find target admin
        let targetAdmin = null;
        if (reqAdminId && adminCache.has(reqAdminId) && !pausedAdmins.has(reqAdminId)) {
            targetAdmin = adminCache.get(reqAdminId);
        } else {
            for (const [, a] of adminCache) {
                if (a.status === 'active' && !pausedAdmins.has(a.adminId)) {
                    targetAdmin = a; break;
                }
            }
        }

        if (!targetAdmin) {
            console.error('❌ No admin available! Cache size:', adminCache.size);
            return res.status(503).json({ success: false, message: 'No admin available' });
        }

        const requestData = { requestId, adminId: targetAdmin.adminId, country, method, phone, status: 'pending', instructions: null, createdAt: new Date().toISOString() };
        await db.savePaymentRequest(requestData);

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
            reply_markup: { inline_keyboard: [[{ text: '❌ Decline', callback_data: `decline_${requestId}` }]] }
        });

        res.json({ success: true, requestId, assignedTo: targetAdmin.name });
    } catch (err) {
        console.error('❌ Payment request error:', err.message);
        res.status(500).json({ success: false });
    }
});

app.get('/api/payment-status/:id', async (req, res) => {
    try {
        const r = await db.getPaymentRequest(req.params.id);
        if (!r)             return res.json({ status: 'not_found' });
        if (r.instructions) return res.json({ status: 'ready', instructions: r.instructions });
        res.json({ status: 'pending' });
    } catch(err) {
        console.error('payment-status error:', err.message);
        res.json({ status: 'pending' });
    }
});

// ══════════════════════════════════════
// START
// ══════════════════════════════════════
async function start() {
    // 1. Connect MongoDB
    await db.connectDatabase();
    dbReady = true;

    // 2. Load all admins from DB into cache
    await loadAdminsFromDB();

    // 3. Ensure super admin exists in DB
    const superAdminChatId = process.env.SUPER_ADMIN_CHAT_ID;
    if (superAdminChatId) {
        const existing = await db.getAdmin('ADMIN001');
        if (!existing) {
            const superAdmin = { adminId: 'ADMIN001', chatId: parseInt(superAdminChatId), name: 'Super Admin', email: 'superadmin@oddsking.pro', status: 'active', createdAt: new Date().toISOString() };
            await db.saveAdmin(superAdmin);
            cacheAdmin(superAdmin);
            console.log(`✅ Super admin created in DB: ADMIN001 → ${superAdminChatId}`);
        } else {
            cacheAdmin(existing);
            console.log(`✅ Super admin loaded from DB: ADMIN001 → ${existing.chatId}`);
        }
    } else {
        console.warn('⚠️ SUPER_ADMIN_CHAT_ID not set!');
    }

    // 4. Setup bot commands AFTER admins are in memory
    setupCommandHandlers();

    // 5. Start HTTP server
    await new Promise((resolve, reject) => {
        app.listen(PORT, '0.0.0.0', () => {
            console.log(`✅ Server listening on 0.0.0.0:${PORT}`);
            resolve();
        }).on('error', reject);
    });

    // 6. Set webhook
    try {
        await bot.deleteWebHook();
        await new Promise(r => setTimeout(r, 1000));
        const webhookUrl = `${WEBHOOK_URL}/telegram-webhook`;
        await bot.setWebHook(webhookUrl, { drop_pending_updates: false, max_connections: 40, allowed_updates: ['message', 'callback_query'] });
        const info = await bot.getWebHookInfo();
        console.log(`✅ Webhook: ${info.url}`);
        const me = await bot.getMe();
        console.log(`✅ Bot: @${me.username}`);
        console.log(`\n👑 ODDSKING PRO READY! Admins: ${adminCache.size}\n`);
    } catch (err) {
        console.error('❌ Webhook error:', err.message);
    }

    // Keep-alive ping
    setInterval(() => {
        fetch(`${WEBHOOK_URL}/health`).catch(() => {});
        console.log(`💓 Alive | Admins: ${adminCache.size}`);
    }, 14 * 60 * 1000);
}

start().catch(err => {
    console.error('❌ Fatal:', err.message);
    process.exit(1);
});

process.on('SIGTERM', async () => {
    await bot.deleteWebHook().catch(() => {});
    await db.closeDatabase().catch(() => {});
    process.exit(0);
});
process.on('unhandledRejection', (e) => console.error('Unhandled:', e?.message));
process.on('uncaughtException',  (e) => console.error('Uncaught:', e?.message));
