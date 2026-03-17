const express         = require('express');
const TelegramBot     = require('node-telegram-bot-api');
const path            = require('path');
const { MongoClient } = require('mongodb');
require('dotenv').config();

// ══════════════════════════════════════
// DATABASE (inline — no separate file needed)
// ══════════════════════════════════════
let _db     = null;
let _client = null;

async function connectDatabase() {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGODB_URI not set!');
    _client = new MongoClient(uri);
    await _client.connect();
    _db = _client.db('oddsking');
    console.log('✅ MongoDB connected — database: oddsking');
    return _db;
}

async function closeDatabase() {
    if (_client) await _client.close();
}

// Admins
async function saveAdmin(data) {
    return _db.collection('admins').updateOne({ adminId: data.adminId }, { $set: data }, { upsert: true });
}
async function getAdmin(adminId) {
    return _db.collection('admins').findOne({ adminId });
}
async function getAllAdmins() {
    return _db.collection('admins').find({}).toArray();
}
async function updateAdmin(adminId, updates) {
    return _db.collection('admins').updateOne({ adminId }, { $set: updates });
}
async function deleteAdmin(adminId) {
    return _db.collection('admins').deleteOne({ adminId });
}

// Odds
async function saveMatch(data) {
    return _db.collection('odds').insertOne(data);
}
async function getTodayOdds() {
    const start = new Date(); start.setHours(0,0,0,0);
    const end   = new Date(); end.setHours(23,59,59,999);
    return _db.collection('odds').find({ date: { $gte: start, $lte: end } }).toArray();
}
async function updateMatch(matchId, updates) {
    const { ObjectId } = require('mongodb');
    return _db.collection('odds').updateOne({ _id: new ObjectId(matchId) }, { $set: updates });
}
async function clearTodayOdds() {
    const start = new Date(); start.setHours(0,0,0,0);
    const end   = new Date(); end.setHours(23,59,59,999);
    return _db.collection('odds').deleteMany({ date: { $gte: start, $lte: end } });
}

// Proof images
async function saveProofImage(data) {
    return _db.collection('proofs').insertOne(data);
}
async function getProofImages(limit = 30) {
    return _db.collection('proofs').find({}).sort({ date: -1 }).limit(limit).toArray();
}

// Payments
async function savePaymentRequest(data) {
    return _db.collection('payments').updateOne({ requestId: data.requestId }, { $set: data }, { upsert: true });
}
async function getPaymentRequest(requestId) {
    return _db.collection('payments').findOne({ requestId });
}
async function updatePaymentRequest(requestId, updates) {
    return _db.collection('payments').updateOne({ requestId }, { $set: updates });
}
async function getPaymentsByAdmin(adminId) {
    return _db.collection('payments').find({ adminId }).toArray();
}

// Win History
async function saveWin(data) {
    return _db.collection('wins').insertOne(data);
}
async function getWins(limit = 30) {
    return _db.collection('wins').find({}).sort({ date: -1 }).limit(limit).toArray();
}
async function deleteLastWin() {
    const last = await _db.collection('wins').findOne({}, { sort: { date: -1 } });
    if (last) await _db.collection('wins').deleteOne({ _id: last._id });
    return last;
}
async function clearWins() {
    return _db.collection('wins').deleteMany({});
}

// ══════════════════════════════════════
// CONFIG
// ══════════════════════════════════════
const app       = express();
const BOT_TOKEN = process.env.SUPER_ADMIN_BOT_TOKEN;
const PORT      = process.env.PORT || 10000;
const WEBHOOK_URL = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL || `http://localhost:${PORT}`;

app.use(express.json());
app.use(express.static(__dirname));

console.log('\n=== ENV CHECK ===');
console.log('BOT_TOKEN:   ', BOT_TOKEN        ? '✅ SET' : '❌ MISSING');
console.log('MONGODB_URI: ', process.env.MONGODB_URI ? '✅ SET' : '❌ MISSING');
console.log('WEBHOOK_URL: ', WEBHOOK_URL);
console.log('=================\n');

if (!BOT_TOKEN) { console.error('❌ SUPER_ADMIN_BOT_TOKEN missing!'); process.exit(1); }

const bot = new TelegramBot(BOT_TOKEN);
bot.on('error',         (e) => console.error('❌ Bot error:', e.message));
bot.on('polling_error', (e) => console.error('❌ Polling error:', e.message));

// ══════════════════════════════════════
// CACHE
// ══════════════════════════════════════
const adminCache    = new Map();
const adminByChatId = new Map();
const pausedAdmins  = new Set();
let   dbReady       = false;

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
        .map(id => parseInt(id.replace('ADMIN', ''))).filter(n => !isNaN(n));
    const next = nums.length > 0 ? Math.max(...nums) + 1 : 1;
    return `ADMIN${String(next).padStart(3, '0')}`;
}

async function loadAdminsFromDB() {
    const all = await getAllAdmins();
    adminCache.clear(); adminByChatId.clear(); pausedAdmins.clear();
    for (const a of all) cacheAdmin(a);
    console.log(`✅ Loaded ${all.length} admins from MongoDB`);
}

// ══════════════════════════════════════
// WEBHOOK
// ══════════════════════════════════════
app.post('/telegram-webhook', (req, res) => {
    try { bot.processUpdate(req.body); } catch (e) { console.error('processUpdate error:', e.message); }
    res.sendStatus(200);
});

app.use((req, res, next) => {
    if (!dbReady && !req.path.includes('/health') && !req.path.includes('/telegram-webhook')) {
        return res.status(503).json({ success: false, message: 'Server starting, please wait...' });
    }
    next();
});

// ══════════════════════════════════════
// BOT COMMANDS
// ══════════════════════════════════════
function setupCommandHandlers() {

    bot.onText(/\/start/, async (msg) => {
        const chatId = msg.chat.id;
        const admin  = getAdminByChatId(chatId);
        if (!admin) {
            return bot.sendMessage(chatId, `👑 *Welcome to OddsKing Pro!*\n\nYour Chat ID: \`${chatId}\`\n\nProvide this to the super admin to get access.`, { parse_mode: 'Markdown' });
        }
        if (pausedAdmins.has(admin.adminId) && admin.adminId !== 'ADMIN001') {
            return bot.sendMessage(chatId, `🚫 *ACCESS PAUSED*\n\nContact super admin.\n*Your ID:* \`${admin.adminId}\``, { parse_mode: 'Markdown' });
        }
        const isSA = admin.adminId === 'ADMIN001';
        let msg2 = `👑 *Welcome ${admin.name}!*\n\n*ID:* \`${admin.adminId}\`\n*Role:* ${isSA ? '⭐ Super Admin' : '👤 Admin'}\n*Your Link:*\n${WEBHOOK_URL}?admin=${admin.adminId}\n\n/mylink /stats /pending /myinfo\n/addmatch /unlock /clearmatches /pay\n/addwin MATCH|PICK|ODDS|WIN — add win history\n/wins — view win history`;
        if (isSA) msg2 += `\n\n*Super Admin Only:*\n/addadmin NAME|EMAIL|CHATID\n/addadminid ADMINID|NAME|EMAIL|CHATID\n/pauseadmin ADMINID\n/unpauseadmin ADMINID\n/removeadmin ADMINID\n/admins\n/send ADMINID msg\n/broadcast msg`;
        bot.sendMessage(chatId, msg2, { parse_mode: 'Markdown' });
    });

    bot.onText(/\/mylink/, (msg) => {
        const chatId = msg.chat.id; const admin = getAdminByChatId(chatId);
        if (!admin || !isAdminActive(chatId)) return bot.sendMessage(chatId, '❌ Not authorized.');
        bot.sendMessage(chatId, `🔗 *YOUR LINK*\n\n\`${WEBHOOK_URL}?admin=${admin.adminId}\`\n\nShare with customers — their payments go to you! 💰`, { parse_mode: 'Markdown' });
    });

    bot.onText(/\/myinfo/, (msg) => {
        const chatId = msg.chat.id; const admin = getAdminByChatId(chatId);
        if (!admin || !isAdminActive(chatId)) return bot.sendMessage(chatId, '❌ Not authorized.');
        bot.sendMessage(chatId, `ℹ️ *INFO*\n\n👤 ${admin.name}\n📧 ${admin.email}\n🆔 \`${admin.adminId}\`\n💬 \`${chatId}\`\n${pausedAdmins.has(admin.adminId)?'🚫 Paused':'✅ Active'}\n\n🔗 ${WEBHOOK_URL}?admin=${admin.adminId}`, { parse_mode: 'Markdown' });
    });

    bot.onText(/\/stats/, async (msg) => {
        const chatId = msg.chat.id; const admin = getAdminByChatId(chatId);
        if (!admin || !isAdminActive(chatId)) return bot.sendMessage(chatId, '❌ Not authorized.');
        const reqs    = await getPaymentsByAdmin(admin.adminId);
        const odds    = await getTodayOdds();
        const proofs  = await getProofImages(100);
        const pending = reqs.filter(r => r.status === 'pending').length;
        const done    = reqs.filter(r => r.status === 'instructed').length;
        let matchList = odds.map((m,i) => `\n${i}. ${m.team1} vs ${m.team2} ${m.unlocked?'🔓':'🔒'} — ID: \`${m._id}\``).join('');
        bot.sendMessage(chatId, `📊 *STATS*\n\n💰 Requests: *${reqs.length}*\n⏳ Pending: *${pending}*\n✅ Done: *${done}*\n📸 Proofs: *${proofs.length}*\n⚽ Matches: *${odds.length}*${matchList||'\nNo matches yet.'}`, { parse_mode: 'Markdown' });
    });

    bot.onText(/\/pending/, async (msg) => {
        const chatId = msg.chat.id; const admin = getAdminByChatId(chatId);
        if (!admin || !isAdminActive(chatId)) return bot.sendMessage(chatId, '❌ Not authorized.');
        const reqs    = await getPaymentsByAdmin(admin.adminId);
        const pending = reqs.filter(r => r.status === 'pending');
        if (pending.length === 0) return bot.sendMessage(chatId, '✨ No pending payments!');
        let msg2 = `⏳ *PENDING (${pending.length})*\n\n`;
        pending.forEach((r,i) => { msg2 += `${i+1}. 📱 \`${r.phone}\` — ${r.method} (${r.country})\n   /pay ${r.requestId} instructions\n\n`; });
        bot.sendMessage(chatId, msg2, { parse_mode: 'Markdown' });
    });

    bot.onText(/\/addmatch (.+)/, async (msg, match) => {
        const chatId = msg.chat.id; const admin = getAdminByChatId(chatId);
        if (!admin || !isAdminActive(chatId)) return bot.sendMessage(chatId, '❌ Not authorized.');
        const p = match[1].split('|').map(s => s.trim());
        if (p.length < 6) return bot.sendMessage(chatId, '❌ Use:\n/addmatch Team1 | Team2 | League | Time | Odds | Pick\n\nExample:\n/addmatch Man Utd | Chelsea | EPL | 15:00 GMT | 2.45 | Man Utd Win');
        const result = await saveMatch({ team1:p[0], team2:p[1], league:p[2], time:p[3], odds:p[4], pick:p[5], unlocked:false, addedBy:admin.adminId, date:new Date() });
        bot.sendMessage(chatId, `✅ *MATCH ADDED*\n\n⚽ ${p[0]} vs ${p[1]}\n🏆 ${p[2]} — ${p[3]}\n📊 Odds: *${p[4]}*\n🎯 Pick: *${p[5]}* 🔒\n🆔 \`${result.insertedId}\`\n\nUse: /unlock ${result.insertedId}`, { parse_mode: 'Markdown' });
    });

    bot.onText(/\/unlock (.+)/, async (msg, match) => {
        const chatId = msg.chat.id; const admin = getAdminByChatId(chatId);
        if (!admin || !isAdminActive(chatId)) return bot.sendMessage(chatId, '❌ Not authorized.');
        try {
            await updateMatch(match[1].trim(), { unlocked: true });
            bot.sendMessage(chatId, `🔓 Pick unlocked for match \`${match[1].trim()}\`!\n✅ Customers can now see the prediction!`, { parse_mode: 'Markdown' });
        } catch(e) { bot.sendMessage(chatId, `❌ Match not found: ${match[1].trim()}`); }
    });

    bot.onText(/\/clearmatches/, async (msg) => {
        const chatId = msg.chat.id; const admin = getAdminByChatId(chatId);
        if (!admin || !isAdminActive(chatId)) return bot.sendMessage(chatId, '❌ Not authorized.');
        const r = await clearTodayOdds();
        bot.sendMessage(chatId, `✅ Cleared ${r.deletedCount} matches. Ready for new day! 🌅`);
    });

    bot.onText(/\/pay (.+)/, async (msg, match) => {
        const chatId = msg.chat.id; const admin = getAdminByChatId(chatId);
        if (!admin || !isAdminActive(chatId)) return bot.sendMessage(chatId, '❌ Not authorized.');
        const input = match[1].trim();
        const sp    = input.indexOf(' ');
        if (sp === -1) return bot.sendMessage(chatId, '❌ Use: /pay REQUEST_ID Instructions here');
        const reqId = input.substring(0, sp).trim();
        const instr = input.substring(sp + 1).trim();
        console.log(`💳 /pay command: reqId=${reqId} instr=${instr} admin=${admin.adminId}`);
        try {
            const req = await getPaymentRequest(reqId);
            console.log(`💳 Found request:`, req ? `adminId=${req.adminId} status=${req.status}` : 'NOT FOUND');
            if (!req) return bot.sendMessage(chatId, `❌ Request not found: \`${reqId}\`\n\nUse /pending to see your pending requests.`, { parse_mode: 'Markdown' });
            // Allow super admin to pay any request
            if (req.adminId !== admin.adminId && admin.adminId !== 'ADMIN001') {
                return bot.sendMessage(chatId, '❌ This request belongs to another admin!');
            }
            await updatePaymentRequest(reqId, { instructions: instr, status: 'instructed' });
            console.log(`✅ Payment instructions saved for ${reqId}`);
            bot.sendMessage(chatId, `✅ *INSTRUCTIONS SENT!*\n\n🆔 \`${reqId}\`\n📋 ${instr}\n\n🌐 Customer sees this automatically!`, { parse_mode: 'Markdown' });
        } catch(e) {
            console.error('❌ /pay error:', e.message);
            bot.sendMessage(chatId, `❌ Error: ${e.message}`);
        }
    });

    // /addwin MATCH | PICK | ODDS | WIN or LOSS
    bot.onText(/\/addwin (.+)/, async (msg, match) => {
        const chatId = msg.chat.id; const admin = getAdminByChatId(chatId);
        if (!admin || !isAdminActive(chatId)) return bot.sendMessage(chatId, '❌ Not authorized.');
        const p = match[1].split('|').map(s => s.trim());
        if (p.length < 4) {
            return bot.sendMessage(chatId,
                '❌ Use:\n/addwin MATCH | PICK | ODDS | WIN or LOSS\n\nExample:\n/addwin Man Utd vs Chelsea | Man Utd Win | 2.10 | WIN'
            );
        }
        const [match2, pick, odds, result] = p;
        const isWin = result.toUpperCase().includes('WIN');
        await saveWin({ match: match2, pick, odds, result: isWin ? 'WIN' : 'LOSS', date: new Date(), addedBy: admin.name });
        bot.sendMessage(chatId, `${isWin ? '✅' : '❌'} *WIN HISTORY UPDATED*\n\n⚽ ${match2}\n🎯 Pick: ${pick}\n📊 Odds: ${odds}\n${isWin ? '✅ WIN' : '❌ LOSS'}\n\n🌐 Live on website!`, { parse_mode: 'Markdown' });
    });

    // /wins — list recent wins
    bot.onText(/\/wins/, async (msg) => {
        const chatId = msg.chat.id; const admin = getAdminByChatId(chatId);
        if (!admin || !isAdminActive(chatId)) return bot.sendMessage(chatId, '❌ Not authorized.');
        const wins = await getWins(10);
        if (wins.length === 0) return bot.sendMessage(chatId, '📊 No win history yet. Use /addwin to add.');
        let msg2 = `🏆 *WIN HISTORY (last ${wins.length})*\n\n`;
        wins.forEach((w, i) => {
            msg2 += `${i+1}. ${w.result === 'WIN' ? '✅' : '❌'} ${w.match}\n   Pick: ${w.pick} | Odds: ${w.odds}\n   ${new Date(w.date).toLocaleDateString()}\n\n`;
        });
        bot.sendMessage(chatId, msg2, { parse_mode: 'Markdown' });
    });

    // /deletelastwin — remove last win entry
    bot.onText(/\/deletelastwin/, async (msg) => {
        const chatId = msg.chat.id; const admin = getAdminByChatId(chatId);
        if (!admin || admin.adminId !== 'ADMIN001') return bot.sendMessage(chatId, '❌ Only super admin.');
        const deleted = await deleteLastWin();
        if (!deleted) return bot.sendMessage(chatId, '⚠️ No win history to delete.');
        bot.sendMessage(chatId, `🗑️ Deleted: ${deleted.match} — ${deleted.pick}`);
    });

    // /clearwins — wipe all win history
    bot.onText(/\/clearwins/, async (msg) => {
        const chatId = msg.chat.id; const admin = getAdminByChatId(chatId);
        if (!admin || admin.adminId !== 'ADMIN001') return bot.sendMessage(chatId, '❌ Only super admin.');
        const r = await clearWins();
        bot.sendMessage(chatId, `🗑️ Cleared ${r.deletedCount} win history entries.`);
    });

    bot.on('photo', async (msg) => {
        const chatId = msg.chat.id; const admin = getAdminByChatId(chatId);
        if (!admin || !isAdminActive(chatId)) return;
        try {
            const url = await bot.getFileLink(msg.photo[msg.photo.length-1].file_id);
            await saveProofImage({ url, date: new Date(), caption: msg.caption || 'Win Proof', uploadedBy: admin.name });
            bot.sendMessage(chatId, `✅ *PROOF UPLOADED!*\n📸 "${msg.caption||'Win Proof'}"\n👤 By: ${admin.name}\n🌐 Live on website! 💾 Saved to DB!`, { parse_mode: 'Markdown' });
        } catch(e) { bot.sendMessage(chatId, `❌ Upload failed: ${e.message}`); }
    });

    // ── SUPER ADMIN COMMANDS ──

    bot.onText(/\/addadmin (.+)/, async (msg, match) => {
        const chatId = msg.chat.id; const admin = getAdminByChatId(chatId);
        if (!admin || admin.adminId !== 'ADMIN001') return bot.sendMessage(chatId, '❌ Only super admin.');
        const p = match[1].trim().split('|').map(s => s.trim());
        if (p.length !== 3) return bot.sendMessage(chatId, '❌ Use: /addadmin NAME|EMAIL|CHATID');
        const newChatId = parseInt(p[2]);
        if (isNaN(newChatId)) return bot.sendMessage(chatId, '❌ Chat ID must be a number!');
        const newAdminId = getNextAdminId();
        const newAdmin   = { adminId: newAdminId, chatId: newChatId, name: p[0], email: p[1], status: 'active', createdAt: new Date().toISOString() };
        await saveAdmin(newAdmin); cacheAdmin(newAdmin);
        await bot.sendMessage(chatId, `✅ *ADMIN ADDED*\n\n👤 ${p[0]}\n📧 ${p[1]}\n🆔 \`${newAdminId}\`\n💬 \`${newChatId}\`\n\n🔗 ${WEBHOOK_URL}?admin=${newAdminId}`, { parse_mode: 'Markdown' });
        bot.sendMessage(newChatId, `🎉 *YOU ARE NOW AN ADMIN!*\n\nWelcome ${p[0]}!\n*ID:* \`${newAdminId}\`\n*Link:* ${WEBHOOK_URL}?admin=${newAdminId}\n\n/mylink /stats /pending /myinfo`, { parse_mode: 'Markdown' }).catch(() => bot.sendMessage(chatId, '⚠️ Admin saved but could not notify them — they need to /start first.'));
    });

    bot.onText(/\/addadminid (.+)/, async (msg, match) => {
        const chatId = msg.chat.id; const admin = getAdminByChatId(chatId);
        if (!admin || admin.adminId !== 'ADMIN001') return bot.sendMessage(chatId, '❌ Only super admin.');
        const p = match[1].trim().split('|').map(s => s.trim());
        if (p.length !== 4) return bot.sendMessage(chatId, '❌ Use: /addadminid ADMINID|NAME|EMAIL|CHATID\n\nExample:\n/addadminid ADMIN010|John|john@email.com|123456789');
        const [newAdminId, name, email, chatIdStr] = p;
        const newChatId = parseInt(chatIdStr);
        if (isNaN(newChatId)) return bot.sendMessage(chatId, '❌ Chat ID must be a number!');
        if (adminCache.has(newAdminId)) return bot.sendMessage(chatId, `❌ Admin \`${newAdminId}\` already exists!`, { parse_mode: 'Markdown' });
        const newAdmin = { adminId: newAdminId, chatId: newChatId, name, email, status: 'active', createdAt: new Date().toISOString() };
        await saveAdmin(newAdmin); cacheAdmin(newAdmin);
        await bot.sendMessage(chatId, `✅ *ADMIN ADDED WITH CUSTOM ID*\n\n👤 ${name}\n📧 ${email}\n🆔 \`${newAdminId}\`\n💬 \`${newChatId}\`\n\n🔗 ${WEBHOOK_URL}?admin=${newAdminId}`, { parse_mode: 'Markdown' });
        bot.sendMessage(newChatId, `🎉 *YOU ARE NOW AN ADMIN!*\n\nWelcome ${name}!\n*ID:* \`${newAdminId}\`\n*Link:* ${WEBHOOK_URL}?admin=${newAdminId}\n\n/mylink /stats /pending /myinfo`, { parse_mode: 'Markdown' }).catch(() => bot.sendMessage(chatId, '⚠️ Admin saved but could not notify them — they need to /start first.'));
    });

        bot.onText(/\/addadmin$/, (msg) => {
        const chatId = msg.chat.id; const admin = getAdminByChatId(chatId);
        if (!admin || admin.adminId !== 'ADMIN001') return;
        bot.sendMessage(chatId, '📝 Use:\n/addadmin NAME|EMAIL|CHATID\n\nExample:\n/addadmin John|john@email.com|123456789');
    });

    bot.onText(/\/pauseadmin (.+)/, async (msg, match) => {
        const chatId = msg.chat.id; const admin = getAdminByChatId(chatId);
        if (!admin || admin.adminId !== 'ADMIN001') return bot.sendMessage(chatId, '❌ Only super admin.');
        const tid = match[1].trim();
        if (tid === 'ADMIN001') return bot.sendMessage(chatId, '🚫 Cannot pause super admin!');
        const target = adminCache.get(tid);
        if (!target) return bot.sendMessage(chatId, `❌ Admin \`${tid}\` not found.`, { parse_mode: 'Markdown' });
        pausedAdmins.add(tid); target.status = 'paused';
        await updateAdmin(tid, { status: 'paused' });
        bot.sendMessage(chatId, `🚫 Admin ${target.name} paused.\nUse /unpauseadmin ${tid} to restore.`);
        if (target.chatId) bot.sendMessage(target.chatId, '🚫 Your admin access has been paused.').catch(()=>{});
    });

    bot.onText(/\/unpauseadmin (.+)/, async (msg, match) => {
        const chatId = msg.chat.id; const admin = getAdminByChatId(chatId);
        if (!admin || admin.adminId !== 'ADMIN001') return bot.sendMessage(chatId, '❌ Only super admin.');
        const tid = match[1].trim();
        const target = adminCache.get(tid);
        if (!target) return bot.sendMessage(chatId, `❌ Admin \`${tid}\` not found.`, { parse_mode: 'Markdown' });
        pausedAdmins.delete(tid); target.status = 'active';
        await updateAdmin(tid, { status: 'active' });
        bot.sendMessage(chatId, `✅ Admin ${target.name} unpaused!`);
        if (target.chatId) bot.sendMessage(target.chatId, '✅ Your access has been restored! Use /start.').catch(()=>{});
    });

    bot.onText(/\/removeadmin (.+)/, async (msg, match) => {
        const chatId = msg.chat.id; const admin = getAdminByChatId(chatId);
        if (!admin || admin.adminId !== 'ADMIN001') return bot.sendMessage(chatId, '❌ Only super admin.');
        const tid = match[1].trim();
        if (tid === 'ADMIN001') return bot.sendMessage(chatId, '🚫 Cannot remove super admin!');
        const target = adminCache.get(tid);
        if (!target) return bot.sendMessage(chatId, `❌ Not found: \`${tid}\``, { parse_mode: 'Markdown' });
        await deleteAdmin(tid); adminByChatId.delete(String(target.chatId)); adminCache.delete(tid); pausedAdmins.delete(tid);
        bot.sendMessage(chatId, `🗑️ Admin ${target.name} removed.`);
        if (target.chatId) bot.sendMessage(target.chatId, '🗑️ You have been removed as admin.').catch(()=>{});
    });

    bot.onText(/\/admins/, (msg) => {
        const chatId = msg.chat.id; const admin = getAdminByChatId(chatId);
        if (!admin || admin.adminId !== 'ADMIN001') return bot.sendMessage(chatId, '❌ Only super admin can list admins.');
        let msg2 = `👥 *ADMINS (${adminCache.size})*\n\n`;
        adminCache.forEach((a, id) => {
            const isSA = id === 'ADMIN001';
            msg2 += `${isSA?'⭐':pausedAdmins.has(id)?'🚫':'✅'} *${a.name}*\n   🆔 \`${id}\` | 💬 \`${a.chatId}\`\n   🔗 ?admin=${id}\n\n`;
        });
        bot.sendMessage(chatId, msg2, { parse_mode: 'Markdown' });
    });

    bot.onText(/\/send (.+)/, async (msg, match) => {
        const chatId = msg.chat.id; const admin = getAdminByChatId(chatId);
        if (!admin || admin.adminId !== 'ADMIN001') return bot.sendMessage(chatId, '❌ Only super admin.');
        const input = match[1].trim(); const sp = input.indexOf(' ');
        if (sp === -1) return bot.sendMessage(chatId, '❌ Use: /send ADMINID message');
        const tid = input.substring(0, sp).trim(); const txt = input.substring(sp+1).trim();
        const target = adminCache.get(tid);
        if (!target) return bot.sendMessage(chatId, `❌ Admin \`${tid}\` not found.`, { parse_mode: 'Markdown' });
        bot.sendMessage(target.chatId, `📨 *FROM SUPER ADMIN*\n\n${txt}`, { parse_mode: 'Markdown' })
           .then(() => bot.sendMessage(chatId, `✅ Sent to ${target.name}`))
           .catch(() => bot.sendMessage(chatId, `❌ Could not reach ${target.name}`));
    });

    bot.onText(/\/broadcast (.+)/, async (msg, match) => {
        const chatId = msg.chat.id; const admin = getAdminByChatId(chatId);
        if (!admin || admin.adminId !== 'ADMIN001') return bot.sendMessage(chatId, '❌ Only super admin.');
        const txt = match[1].trim(); let ok = 0, fail = 0;
        for (const [id, a] of adminCache) {
            if (id === 'ADMIN001') continue;
            try { await bot.sendMessage(a.chatId, `📢 *BROADCAST*\n\n${txt}`, { parse_mode: 'Markdown' }); ok++; }
            catch { fail++; }
            await new Promise(r => setTimeout(r, 100));
        }
        bot.sendMessage(chatId, `📢 Done! ✅ ${ok} sent | ❌ ${fail} failed`);
    });

    bot.on('callback_query', async (cb) => {
        const data = cb.data; const chatId = cb.message.chat.id;
        if (data.startsWith('decline_')) {
            const reqId = data.replace('decline_', '');
            await updatePaymentRequest(reqId, { status: 'declined', instructions: '❌ Request declined. Please contact support.' }).catch(()=>{});
            await bot.answerCallbackQuery(cb.id, { text: '❌ Declined' });
            await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: cb.message.message_id }).catch(()=>{});
        }
    });

    console.log('✅ All command handlers registered!');
}

// ══════════════════════════════════════
// API ROUTES
// ══════════════════════════════════════
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'oddsking-pro.html')));

app.get('/health', (req, res) => res.json({ status:'ok', db: dbReady?'connected':'not ready', admins: adminCache.size, timestamp: new Date().toISOString() }));

app.get('/api/validate-admin/:adminId', (req, res) => {
    const a = adminCache.get(req.params.adminId);
    if (a && a.status === 'active' && !pausedAdmins.has(a.adminId))
        return res.json({ success:true, valid:true, admin:{ id:a.adminId, name:a.name } });
    res.json({ success:true, valid:false });
});

app.get('/api/odds', async (req, res) => {
    try {
        const odds = await getTodayOdds();
        res.json({ odds: odds.map(o => ({ ...o, pick: o.unlocked ? o.pick : null })) });
    } catch(e) { res.json({ odds: [] }); }
});

app.get('/api/wins', async (req, res) => {
    try {
        const wins = await getWins(30);
        res.json({ wins });
    } catch(e) { res.json({ wins: [] }); }
});

app.get('/api/proof-images', async (req, res) => {
    try {
        const images = await getProofImages(30);
        res.json({ images });
    } catch(e) { res.json({ images: [] }); }
});

app.post('/api/payment-request', async (req, res) => {
    try {
        const { requestId, country, method, phone, adminId: reqAdminId } = req.body;
        console.log('💰 Payment request:', { requestId, country, method, phone, reqAdminId });
        console.log('👥 Admins in cache:', adminCache.size, Array.from(adminCache.keys()));

        // Find target admin
        let targetAdmin = null;
        if (reqAdminId && adminCache.has(reqAdminId) && !pausedAdmins.has(reqAdminId)) {
            targetAdmin = adminCache.get(reqAdminId);
        } else {
            for (const [, a] of adminCache) {
                if (a.status === 'active' && !pausedAdmins.has(a.adminId)) { targetAdmin = a; break; }
            }
        }

        if (!targetAdmin) {
            console.error('❌ No admin available! Cache:', adminCache.size);
            return res.status(503).json({ success:false, message:'No admin available. Please try again.' });
        }

        console.log('✅ Assigned to:', targetAdmin.name, 'chatId:', targetAdmin.chatId);

        await savePaymentRequest({ requestId, adminId:targetAdmin.adminId, country, method, phone, status:'pending', instructions:null, createdAt:new Date().toISOString() });

        await bot.sendMessage(targetAdmin.chatId, `
💰 *NEW PAYMENT REQUEST*

🆔 \`${requestId}\`
🌍 Country: *${country}*
💳 Method: *${method}*
📱 Phone: \`${phone}\`
⏰ ${new Date().toLocaleString()}

━━━━━━━━━━━━━━━━
To send payment instructions:
/pay ${requestId} Your instructions here

Example:
/pay ${requestId} Send KES 200 to M-Pesa 0712345678
        `, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text:'❌ Decline', callback_data:`decline_${requestId}` }]] }
        });

        console.log('✅ Telegram notification sent!');
        res.json({ success:true, requestId, assignedTo:targetAdmin.name });
    } catch(err) {
        console.error('❌ Payment request error:', err.message);
        res.status(500).json({ success:false, message: err.message });
    }
});

app.get('/api/payment-status/:id', async (req, res) => {
    try {
        const r = await getPaymentRequest(req.params.id);
        if (!r)             return res.json({ status:'not_found' });
        if (r.instructions) return res.json({ status:'ready', instructions:r.instructions });
        res.json({ status:'pending' });
    } catch(e) {
        res.json({ status:'pending' });
    }
});

// ══════════════════════════════════════
// START
// ══════════════════════════════════════
async function start() {
    await connectDatabase();
    dbReady = true;
    await loadAdminsFromDB();

    const superChatId = process.env.SUPER_ADMIN_CHAT_ID;
    if (superChatId) {
        const existing = await getAdmin('ADMIN001');
        if (!existing) {
            const sa = { adminId:'ADMIN001', chatId:parseInt(superChatId), name:'Super Admin', email:'superadmin@oddsking.pro', status:'active', createdAt:new Date().toISOString() };
            await saveAdmin(sa); cacheAdmin(sa);
            console.log('✅ Super admin created in DB');
        } else {
            cacheAdmin(existing);
            console.log('✅ Super admin loaded from DB');
        }
    } else {
        console.warn('⚠️ SUPER_ADMIN_CHAT_ID not set!');
    }

    setupCommandHandlers();

    await new Promise((resolve, reject) => {
        app.listen(PORT, '0.0.0.0', () => { console.log(`✅ Server on port ${PORT}`); resolve(); }).on('error', reject);
    });

    try {
        await bot.deleteWebHook();
        await new Promise(r => setTimeout(r, 1000));
        const wu = `${WEBHOOK_URL}/telegram-webhook`;
        await bot.setWebHook(wu, { drop_pending_updates:true, max_connections:40, allowed_updates:['message','callback_query'] });
        const info = await bot.getWebHookInfo();
        const me   = await bot.getMe();
        console.log(`✅ Webhook: ${info.url}`);
        console.log(`✅ Bot: @${me.username}`);
        console.log(`\n👑 ODDSKING PRO READY! Admins: ${adminCache.size}\n`);
    } catch(e) {
        console.error('❌ Webhook error:', e.message);
    }

    setInterval(() => {
        fetch(`${WEBHOOK_URL}/health`).catch(()=>{});
        console.log(`💓 Alive | Admins: ${adminCache.size}`);
    }, 14 * 60 * 1000);

    // Auto-fix webhook every 3 minutes + self-ping to prevent sleep
    const expectedWebhook = `${WEBHOOK_URL}/telegram-webhook`;
    setInterval(async () => {
        try {
            // Self-ping to prevent Render free tier sleep
            await fetch(`${WEBHOOK_URL}/health`).catch(()=>{});

            // Check and restore webhook if lost
            const info = await bot.getWebHookInfo();
            if (info.url !== expectedWebhook) {
                console.log('⚠️ Webhook lost! Re-setting...');
                await bot.deleteWebHook();
                await new Promise(r => setTimeout(r, 500));
                await bot.setWebHook(expectedWebhook, {
                    drop_pending_updates: false,
                    max_connections: 40,
                    allowed_updates: ['message', 'callback_query']
                });
                console.log('✅ Webhook restored!');
            }
            if (info.last_error_message) {
                console.log(`⚠️ Webhook error: ${info.last_error_message}`);
            }
        } catch(e) { console.error('Webhook check error:', e.message); }
    }, 3 * 60 * 1000);
}

start().catch(e => { console.error('❌ Fatal:', e.message); process.exit(1); });

process.on('SIGTERM', async () => { await bot.deleteWebHook().catch(()=>{}); await closeDatabase().catch(()=>{}); process.exit(0); });
process.on('unhandledRejection', (e) => console.error('Unhandled:', e?.message));
process.on('uncaughtException',  (e) => console.error('Uncaught:', e?.message));
