const express    = require('express');
const TelegramBot = require('node-telegram-bot-api');
const path        = require('path');
const fs          = require('fs');
const https       = require('https');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

// ── Config ──
const BOT_TOKEN   = process.env.BOT_TOKEN;
const PORT        = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL || `http://localhost:${PORT}`;
const ADMIN_CHAT  = process.env.ADMIN_CHAT_ID; // your Telegram chat ID

const bot = new TelegramBot(BOT_TOKEN);

// ── In-Memory Storage (replace with MongoDB for production) ──
let paymentRequests = {};   // reqId → { country, method, phone, instructions, status }
let proofImages     = [];   // [{ url, date, caption }]
let todayOdds       = [];   // [{ team1, team2, league, time, odds, pick, unlocked }]

// ── Serve website ──
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'oddsking-pro.html'));
});

// ─────────────────────────────────────────────
// API: Customer submits payment request
// ─────────────────────────────────────────────
app.post('/api/payment-request', async (req, res) => {
    const { requestId, country, method, phone, timestamp } = req.body;

    // Store request
    paymentRequests[requestId] = {
        country, method, phone, timestamp,
        status: 'pending',
        instructions: null
    };

    // Notify admin on Telegram
    const message = `
💰 *NEW PAYMENT REQUEST*

🆔 \`${requestId}\`
🌍 Country: *${country}*
💳 Method: *${method}*
📱 Phone: \`${phone}\`
⏰ ${new Date(timestamp).toLocaleString()}

━━━━━━━━━━━━━━━━
Reply with payment instructions:
/pay ${requestId} YOUR INSTRUCTIONS HERE

Example:
/pay ${requestId} Send KES 200 to M-Pesa 0712345678 (John). Send screenshot after payment.
    `;

    try {
        await bot.sendMessage(ADMIN_CHAT, message, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[
                    { text: '✅ Send Instructions', callback_data: `instruct_${requestId}` },
                    { text: '❌ Decline', callback_data: `decline_${requestId}` }
                ]]
            }
        });
        res.json({ success: true, requestId });
    } catch (err) {
        console.error('Telegram error:', err.message);
        res.status(500).json({ success: false });
    }
});

// ─────────────────────────────────────────────
// API: Poll for payment instructions
// ─────────────────────────────────────────────
app.get('/api/payment-status/:requestId', (req, res) => {
    const req2 = paymentRequests[req.params.requestId];
    if (!req2) return res.json({ status: 'not_found' });
    if (req2.instructions) {
        return res.json({ status: 'ready', instructions: req2.instructions });
    }
    res.json({ status: 'pending' });
});

// ─────────────────────────────────────────────
// API: Get proof images
// ─────────────────────────────────────────────
app.get('/api/proof-images', (req, res) => {
    res.json({ images: proofImages });
});

// ─────────────────────────────────────────────
// API: Get today's odds
// ─────────────────────────────────────────────
app.get('/api/odds', (req, res) => {
    // Hide pick if not unlocked
    const safe = todayOdds.map(o => ({
        ...o,
        pick: o.unlocked ? o.pick : null
    }));
    res.json({ odds: safe });
});

// ─────────────────────────────────────────────
// API: Unlock pick after payment confirmed
// ─────────────────────────────────────────────
app.post('/api/unlock/:matchId', (req, res) => {
    const secret = req.headers['x-admin-secret'];
    if (secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Unauthorized' });
    const idx = parseInt(req.params.matchId);
    if (todayOdds[idx]) {
        todayOdds[idx].unlocked = true;
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Match not found' });
    }
});

// ─────────────────────────────────────────────
// WEBHOOK
// ─────────────────────────────────────────────
app.post('/telegram-webhook', (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

// ─────────────────────────────────────────────
// BOT COMMANDS
// ─────────────────────────────────────────────

// /start
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    if (String(chatId) !== String(ADMIN_CHAT)) {
        return bot.sendMessage(chatId, `Your Chat ID: \`${chatId}\`\nProvide this to the owner.`, { parse_mode: 'Markdown' });
    }
    await bot.sendMessage(chatId, `
👑 *ODDSKING PRO — ADMIN PANEL*

*Commands:*
📤 *Proof Images:*
→ Send any photo to upload as proof

🏆 *Add Today's Odds:*
/addmatch Team1 | Team2 | League | Time | Odds | Pick

💳 *Payment Instructions:*
/pay REQUEST_ID Instructions here...

🔓 *Unlock a pick:*
/unlock MATCH_NUMBER

📊 *View stats:*
/stats

🗑️ *Clear today's odds:*
/clearmatches
    `, { parse_mode: 'Markdown' });
});

// /addmatch Team1 | Team2 | League | Time | Odds | Pick
bot.onText(/\/addmatch (.+)/, async (msg, match) => {
    if (String(msg.chat.id) !== String(ADMIN_CHAT)) return;
    const parts = match[1].split('|').map(p => p.trim());
    if (parts.length < 6) {
        return bot.sendMessage(msg.chat.id, `❌ Format:\n/addmatch Team1 | Team2 | League | Time | Odds | Pick\n\nExample:\n/addmatch Man Utd | Chelsea | Premier League | 15:00 GMT | 2.45 | Man Utd Win`);
    }
    const [team1, team2, league, time, odds, pick] = parts;
    const idx = todayOdds.push({ team1, team2, league, time, odds, pick, unlocked: false }) - 1;
    bot.sendMessage(msg.chat.id, `
✅ *MATCH ADDED* (#${idx})

⚽ ${team1} vs ${team2}
🏆 ${league} — ${time}
📊 Odds: *${odds}*
🎯 Pick: *${pick}* (LOCKED)

Use /unlock ${idx} after payment confirmed.
    `, { parse_mode: 'Markdown' });
});

// /unlock MATCH_NUMBER
bot.onText(/\/unlock (\d+)/, async (msg, match) => {
    if (String(msg.chat.id) !== String(ADMIN_CHAT)) return;
    const idx = parseInt(match[1]);
    if (!todayOdds[idx]) return bot.sendMessage(msg.chat.id, `❌ Match #${idx} not found.`);
    todayOdds[idx].unlocked = true;
    bot.sendMessage(msg.chat.id, `
🔓 *PICK UNLOCKED*

⚽ ${todayOdds[idx].team1} vs ${todayOdds[idx].team2}
🎯 Pick: *${todayOdds[idx].pick}*

Customers can now see the winning prediction.
    `, { parse_mode: 'Markdown' });
});

// /clearmatches
bot.onText(/\/clearmatches/, async (msg) => {
    if (String(msg.chat.id) !== String(ADMIN_CHAT)) return;
    todayOdds = [];
    bot.sendMessage(msg.chat.id, '✅ All matches cleared. Ready for new day!');
});

// /pay REQUEST_ID instructions
bot.onText(/\/pay (.+)/, async (msg, match) => {
    if (String(msg.chat.id) !== String(ADMIN_CHAT)) return;
    const input = match[1].trim();
    const spaceIdx = input.indexOf(' ');
    if (spaceIdx === -1) return bot.sendMessage(msg.chat.id, '❌ Use: /pay REQUEST_ID Your instructions here');

    const reqId        = input.substring(0, spaceIdx).trim();
    const instructions = input.substring(spaceIdx + 1).trim();

    if (!paymentRequests[reqId]) return bot.sendMessage(msg.chat.id, `❌ Request \`${reqId}\` not found.`, { parse_mode: 'Markdown' });

    paymentRequests[reqId].instructions = instructions;
    paymentRequests[reqId].status       = 'instructed';

    bot.sendMessage(msg.chat.id, `
✅ *INSTRUCTIONS SENT*

🆔 \`${reqId}\`
📋 ${instructions}

Customer will see this on the website automatically.
    `, { parse_mode: 'Markdown' });
});

// /stats
bot.onText(/\/stats/, async (msg) => {
    if (String(msg.chat.id) !== String(ADMIN_CHAT)) return;
    const total   = Object.keys(paymentRequests).length;
    const pending = Object.values(paymentRequests).filter(r => r.status === 'pending').length;
    const done    = Object.values(paymentRequests).filter(r => r.status === 'instructed').length;
    bot.sendMessage(msg.chat.id, `
📊 *TODAY'S STATS*

💰 Payment Requests: *${total}*
⏳ Pending: *${pending}*
✅ Instructed: *${done}*
📸 Proof Images: *${proofImages.length}*
⚽ Matches Today: *${todayOdds.length}*
    `, { parse_mode: 'Markdown' });
});

// ── PHOTO HANDLER — admin sends proof image ──
bot.on('photo', async (msg) => {
    if (String(msg.chat.id) !== String(ADMIN_CHAT)) return;

    const photo    = msg.photo[msg.photo.length - 1]; // highest res
    const fileId   = photo.file_id;
    const caption  = msg.caption || 'Win Proof';

    try {
        const fileUrl = await bot.getFileLink(fileId);

        // Store proof image
        proofImages.unshift({
            url:     fileUrl,
            date:    new Date().toISOString(),
            caption: caption,
            fileId:  fileId
        });

        // Keep only last 30
        if (proofImages.length > 30) proofImages = proofImages.slice(0, 30);

        bot.sendMessage(msg.chat.id, `
✅ *PROOF IMAGE UPLOADED*

📸 "${caption}"
📅 ${new Date().toLocaleString()}
🔢 Total images: ${proofImages.length}

Image is now LIVE on the website! 🌐
        `, { parse_mode: 'Markdown' });

    } catch (err) {
        bot.sendMessage(msg.chat.id, `❌ Failed to save image: ${err.message}`);
    }
});

// ── CALLBACK: inline button from payment request ──
bot.on('callback_query', async (cb) => {
    const data   = cb.data;
    const chatId = cb.message.chat.id;

    if (data.startsWith('instruct_')) {
        const reqId = data.replace('instruct_', '');
        bot.answerCallbackQuery(cb.id);
        bot.sendMessage(chatId, `To send instructions for \`${reqId}\`, use:\n\n/pay ${reqId} Your instructions here`, { parse_mode: 'Markdown' });
    }

    if (data.startsWith('decline_')) {
        const reqId = data.replace('decline_', '');
        if (paymentRequests[reqId]) {
            paymentRequests[reqId].status       = 'declined';
            paymentRequests[reqId].instructions = '❌ This payment method is not available. Please try again with a different method.';
        }
        bot.answerCallbackQuery(cb.id, { text: 'Request declined' });
        bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: cb.message.message_id });
        bot.sendMessage(chatId, `❌ Request \`${reqId}\` declined.`, { parse_mode: 'Markdown' });
    }
});

// ─────────────────────────────────────────────
// HEALTH
// ─────────────────────────────────────────────
app.get('/health', (req, res) => {
    res.json({
        status:    'ok',
        matches:   todayOdds.length,
        proofs:    proofImages.length,
        requests:  Object.keys(paymentRequests).length,
        timestamp: new Date().toISOString()
    });
});

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
async function start() {
    await bot.deleteWebHook();
    await bot.setWebHook(`${WEBHOOK_URL}/telegram-webhook`, {
        allowed_updates: ['message', 'callback_query']
    });
    console.log(`✅ Webhook set: ${WEBHOOK_URL}/telegram-webhook`);

    app.listen(PORT, () => {
        console.log(`\n👑 ODDSKING PRO`);
        console.log(`================`);
        console.log(`🌐 http://localhost:${PORT}`);
        console.log(`✅ Bot + Server running\n`);
    });
}

start().catch(console.error);
