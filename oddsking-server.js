const express     = require('express');
const TelegramBot = require('node-telegram-bot-api');
const path        = require('path');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

// ══════════════════════════════════════
// ENV CHECK — runs before anything else
// ══════════════════════════════════════
console.log('\n=== ENV CHECK ===');
console.log('BOT_TOKEN:    ', process.env.BOT_TOKEN    ? '✅ SET (' + process.env.BOT_TOKEN.substring(0,10) + '...)' : '❌ MISSING');
console.log('ADMIN_CHAT_ID:', process.env.ADMIN_CHAT_ID ? '✅ SET (' + process.env.ADMIN_CHAT_ID + ')'              : '❌ MISSING');
console.log('PORT:         ', process.env.PORT          ? '✅ ' + process.env.PORT                                  : '⚠️  using 3000');
console.log('WEBHOOK_URL:  ', process.env.RENDER_EXTERNAL_URL || process.env.APP_URL || 'http://localhost:3000');
console.log('=================\n');

if (!process.env.BOT_TOKEN) {
    console.error('❌ FATAL: BOT_TOKEN not set!');
    console.error('Go to Render → Your Service → Environment → Add BOT_TOKEN');
    process.exit(1);
}
if (!process.env.ADMIN_CHAT_ID) {
    console.error('❌ FATAL: ADMIN_CHAT_ID not set!');
    console.error('Go to Render → Your Service → Environment → Add ADMIN_CHAT_ID');
    process.exit(1);
}

// ══════════════════════════════════════
// CONFIG
// ══════════════════════════════════════
const BOT_TOKEN   = process.env.BOT_TOKEN;
const PORT        = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL || `http://localhost:${PORT}`;
const ADMIN_CHAT  = process.env.ADMIN_CHAT_ID;

// ══════════════════════════════════════
// BOT — created AFTER env check passes
// ══════════════════════════════════════
const bot = new TelegramBot(BOT_TOKEN);
bot.on('error',         (e) => console.error('❌ Bot error:', e.message));
bot.on('polling_error', (e) => console.error('❌ Polling error:', e.message));

// ══════════════════════════════════════
// IN-MEMORY STORAGE
// ══════════════════════════════════════
let paymentRequests = {};  // { reqId: { country, method, phone, status, instructions } }
let proofImages     = [];  // [{ url, date, caption }]
let todayOdds       = [];  // [{ team1, team2, league, time, odds, pick, unlocked }]

// ══════════════════════════════════════
// EXPRESS ROUTES
// ══════════════════════════════════════

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'oddsking-pro.html'));
});

app.get('/health', (req, res) => {
    res.json({
        status:    'ok',
        bot:       'running',
        matches:   todayOdds.length,
        proofs:    proofImages.length,
        requests:  Object.keys(paymentRequests).length,
        timestamp: new Date().toISOString()
    });
});

// POST /api/payment-request — customer submits payment
app.post('/api/payment-request', async (req, res) => {
    try {
        const { requestId, country, method, phone } = req.body;

        paymentRequests[requestId] = {
            country, method, phone,
            status:       'pending',
            instructions: null,
            createdAt:    new Date().toISOString()
        };

        await bot.sendMessage(ADMIN_CHAT, `
💰 *NEW PAYMENT REQUEST*

🆔 \`${requestId}\`
🌍 Country: *${country}*
💳 Method: *${method}*
📱 Phone: \`${phone}\`
⏰ ${new Date().toLocaleString()}

━━━━━━━━━━━━━━━━
To send payment instructions reply:
/pay ${requestId} Your instructions here

*Example:*
/pay ${requestId} Send KES 200 via M\\-Pesa to 0712345678\\. Screenshot after payment\\.
        `, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[
                    { text: '❌ Decline', callback_data: `decline_${requestId}` }
                ]]
            }
        });

        res.json({ success: true, requestId });
    } catch (err) {
        console.error('❌ Payment request error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /api/payment-status/:id — customer polls for instructions
app.get('/api/payment-status/:id', (req, res) => {
    const r = paymentRequests[req.params.id];
    if (!r)              return res.json({ status: 'not_found' });
    if (r.instructions)  return res.json({ status: 'ready', instructions: r.instructions });
    res.json({ status: 'pending' });
});

// GET /api/proof-images — website fetches proof gallery
app.get('/api/proof-images', (req, res) => {
    res.json({ images: proofImages });
});

// GET /api/odds — website fetches today's matches (picks hidden until unlocked)
app.get('/api/odds', (req, res) => {
    const safe = todayOdds.map(o => ({
        ...o,
        pick: o.unlocked ? o.pick : null
    }));
    res.json({ odds: safe });
});

// POST /telegram-webhook — Telegram sends updates here
app.post('/telegram-webhook', (req, res) => {
    try {
        bot.processUpdate(req.body);
    } catch (e) {
        console.error('❌ processUpdate error:', e.message);
    }
    res.sendStatus(200);
});

// ══════════════════════════════════════
// BOT COMMANDS
// ══════════════════════════════════════

// /start
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    console.log(`/start from chatId: ${chatId} | ADMIN_CHAT: ${ADMIN_CHAT}`);

    if (String(chatId) !== String(ADMIN_CHAT)) {
        return bot.sendMessage(chatId,
            `👋 Welcome to OddsKing Pro!\n\nYour Chat ID: \`${chatId}\`\n\nProvide this to the site owner for admin access.`,
            { parse_mode: 'Markdown' }
        );
    }

    bot.sendMessage(chatId, `
👑 *ODDSKING PRO — ADMIN PANEL*

━━━━━━━━━━━━━━━━━━
📸 *Upload Proof of Win:*
Just send any photo to this bot

⚽ *Add a Match:*
/addmatch Team1 | Team2 | League | Time | Odds | Pick

💳 *Send Payment Instructions:*
/pay REQUEST\\_ID Instructions here

🔓 *Unlock Winning Pick:*
/unlock MATCH\\_NUMBER

🗑️ *Clear All Matches (new day):*
/clearmatches

📊 *View Today's Stats:*
/stats
━━━━━━━━━━━━━━━━━━
    `, { parse_mode: 'Markdown' });
});

// /addmatch Team1 | Team2 | League | Time | Odds | Pick
bot.onText(/\/addmatch (.+)/, (msg, match) => {
    if (String(msg.chat.id) !== String(ADMIN_CHAT)) return;

    const parts = match[1].split('|').map(p => p.trim());
    if (parts.length < 6) {
        return bot.sendMessage(msg.chat.id,
            `❌ *Wrong format!*\n\nUse:\n/addmatch Team1 | Team2 | League | Time | Odds | Pick\n\nExample:\n/addmatch Man Utd | Chelsea | Premier League | 15:00 GMT | 2.45 | Man Utd Win`,
            { parse_mode: 'Markdown' }
        );
    }

    const [team1, team2, league, time, odds, pick] = parts;
    const idx = todayOdds.push({
        team1, team2, league, time, odds, pick,
        unlocked: false
    }) - 1;

    bot.sendMessage(msg.chat.id, `
✅ *MATCH ADDED* (ID: #${idx})

⚽ ${team1} vs ${team2}
🏆 ${league} — ${time}
📊 Odds: *${odds}*
🎯 Pick: *${pick}* 🔒 LOCKED

Use /unlock ${idx} after payment confirmed.
    `, { parse_mode: 'Markdown' });
});

// /unlock MATCH_NUMBER
bot.onText(/\/unlock (\d+)/, (msg, match) => {
    if (String(msg.chat.id) !== String(ADMIN_CHAT)) return;

    const idx = parseInt(match[1]);
    if (!todayOdds[idx]) {
        return bot.sendMessage(msg.chat.id, `❌ Match #${idx} not found.\nUse /stats to see all matches.`);
    }

    todayOdds[idx].unlocked = true;
    bot.sendMessage(msg.chat.id, `
🔓 *PICK UNLOCKED!*

⚽ ${todayOdds[idx].team1} vs ${todayOdds[idx].team2}
🎯 Winning Pick: *${todayOdds[idx].pick}*

✅ Customers can now see the prediction!
    `, { parse_mode: 'Markdown' });
});

// /clearmatches
bot.onText(/\/clearmatches/, (msg) => {
    if (String(msg.chat.id) !== String(ADMIN_CHAT)) return;
    const count = todayOdds.length;
    todayOdds = [];
    bot.sendMessage(msg.chat.id, `✅ Cleared ${count} matches. Ready for a new day! 🌅`);
});

// /pay REQUEST_ID instructions
bot.onText(/\/pay (.+)/, (msg, match) => {
    if (String(msg.chat.id) !== String(ADMIN_CHAT)) return;

    const input    = match[1].trim();
    const spaceIdx = input.indexOf(' ');

    if (spaceIdx === -1) {
        return bot.sendMessage(msg.chat.id,
            `❌ Use: /pay REQUEST_ID Your instructions here\n\nExample:\n/pay PAY-123456789 Send KES 200 to M-Pesa 0712345678`
        );
    }

    const reqId        = input.substring(0, spaceIdx).trim();
    const instructions = input.substring(spaceIdx + 1).trim();

    if (!paymentRequests[reqId]) {
        return bot.sendMessage(msg.chat.id, `❌ Request not found: \`${reqId}\`\n\nUse /stats to see pending requests.`, { parse_mode: 'Markdown' });
    }

    paymentRequests[reqId].instructions = instructions;
    paymentRequests[reqId].status       = 'instructed';

    bot.sendMessage(msg.chat.id, `
✅ *PAYMENT INSTRUCTIONS SENT!*

🆔 \`${reqId}\`
📋 ${instructions}

🌐 Customer sees this on the website automatically.
    `, { parse_mode: 'Markdown' });
});

// /stats
bot.onText(/\/stats/, (msg) => {
    if (String(msg.chat.id) !== String(ADMIN_CHAT)) return;

    const total     = Object.keys(paymentRequests).length;
    const pending   = Object.values(paymentRequests).filter(r => r.status === 'pending').length;
    const instructed = Object.values(paymentRequests).filter(r => r.status === 'instructed').length;

    let matchList = '';
    todayOdds.forEach((m, i) => {
        matchList += `\n${i}. ${m.team1} vs ${m.team2} — ${m.unlocked ? '🔓' : '🔒'}`;
    });

    bot.sendMessage(msg.chat.id, `
📊 *TODAY'S STATS*

💰 Payment Requests: *${total}*
⏳ Pending: *${pending}*
✅ Instructed: *${instructed}*
📸 Proof Images: *${proofImages.length}*
⚽ Matches: *${todayOdds.length}*
${matchList || '\nNo matches added yet.'}
    `, { parse_mode: 'Markdown' });
});

// Photo handler — admin uploads proof of win
bot.on('photo', async (msg) => {
    if (String(msg.chat.id) !== String(ADMIN_CHAT)) return;

    try {
        const photo   = msg.photo[msg.photo.length - 1];
        const fileUrl = await bot.getFileLink(photo.file_id);
        const caption = msg.caption || 'Win Proof';

        proofImages.unshift({
            url:     fileUrl,
            date:    new Date().toISOString(),
            caption: caption
        });

        // Keep only last 30 images
        if (proofImages.length > 30) proofImages = proofImages.slice(0, 30);

        bot.sendMessage(msg.chat.id, `
✅ *PROOF IMAGE UPLOADED!*

📸 Caption: "${caption}"
📅 ${new Date().toLocaleString()}
🔢 Total images stored: ${proofImages.length}

🌐 Image is now LIVE on the website!
        `, { parse_mode: 'Markdown' });

    } catch (err) {
        console.error('❌ Photo upload error:', err.message);
        bot.sendMessage(msg.chat.id, `❌ Failed to upload image: ${err.message}`);
    }
});

// Callback query handler
bot.on('callback_query', async (cb) => {
    const data   = cb.data;
    const chatId = cb.message.chat.id;

    if (data.startsWith('decline_')) {
        const reqId = data.replace('decline_', '');
        if (paymentRequests[reqId]) {
            paymentRequests[reqId].status       = 'declined';
            paymentRequests[reqId].instructions = '❌ Your request was declined. Please contact support or try a different payment method.';
        }
        await bot.answerCallbackQuery(cb.id, { text: '❌ Request declined' });
        await bot.editMessageReplyMarkup(
            { inline_keyboard: [] },
            { chat_id: chatId, message_id: cb.message.message_id }
        );
        bot.sendMessage(chatId, `❌ Request declined: \`${reqId}\``, { parse_mode: 'Markdown' });
    }
});

// ══════════════════════════════════════
// START SERVER THEN SET WEBHOOK
// ══════════════════════════════════════
async function start() {
    // 1. Start HTTP server first so Render sees the port
    await new Promise((resolve, reject) => {
        app.listen(PORT, '0.0.0.0', () => {
            console.log(`✅ Server listening on 0.0.0.0:${PORT}`);
            resolve();
        }).on('error', reject);
    });

    // 2. Set webhook after server is up
    try {
        await bot.deleteWebHook();
        await new Promise(r => setTimeout(r, 1000));

        const webhookUrl = `${WEBHOOK_URL}/telegram-webhook`;
        const result     = await bot.setWebHook(webhookUrl, {
            drop_pending_updates: false,
            max_connections:      40,
            allowed_updates:      ['message', 'callback_query']
        });

        if (result) {
            const info = await bot.getWebHookInfo();
            console.log(`✅ Webhook confirmed: ${info.url}`);
        }

        const me = await bot.getMe();
        console.log(`✅ Bot connected: @${me.username}`);
        console.log(`✅ Admin Chat ID: ${ADMIN_CHAT}`);
        console.log('\n🚀 ODDSKING PRO FULLY READY!\n');

    } catch (err) {
        console.error('❌ Webhook setup error:', err.message);
        // Server still runs even if webhook fails
    }
}

start().catch((err) => {
    console.error('❌ Fatal startup error:', err.message);
    process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('Shutting down...');
    await bot.deleteWebHook().catch(() => {});
    process.exit(0);
});

process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err?.message));
process.on('uncaughtException',  (err) => console.error('Uncaught exception:', err?.message));
