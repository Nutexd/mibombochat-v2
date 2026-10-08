'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'mibombo.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  balance INTEGER NOT NULL DEFAULT 1000,
  daily_earned INTEGER NOT NULL DEFAULT 0,
  daily_reset_at INTEGER NOT NULL,
  total_won INTEGER NOT NULL DEFAULT 0,
  total_lost INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  username TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  amount INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  meta TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
`);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false } });

app.set('trust proxy', 'loopback');

app.use(express.json({ limit: '16kb' }));
app.use(rateLimit({ windowMs: 60_000, limit: 180, standardHeaders: true, legacyHeaders: false }));
app.use(express.static(path.join(ROOT, 'public')));

const START_BALANCE = 1000;
const DAILY_EARN_LIMIT = 1500;
const CLICK_REWARD = 10;
const CLICK_COOLDOWN_MS = 250;
const SEQUENCE_REWARD = 75;
const SEQUENCE_COOLDOWN_MS = 1500;
const SESSION_DAYS = 7;
const MAX_BET = 500;
const MAX_BALANCE = 5000;
const MAX_CHAT_LENGTH = 500;
const activeSocketUsers = new Map();
const lastEarn = new Map();

function now() { return Date.now(); }
function dayStart(ts = now()) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function resetDailyIfNeeded(user) {
  const today = dayStart();
  if (user.daily_reset_at !== today) {
    db.prepare('UPDATE users SET daily_earned = 0, daily_reset_at = ? WHERE id = ?').run(today, user.id);
    user.daily_earned = 0;
    user.daily_reset_at = today;
  }
  return user;
}
function publicUser(user) {
  return { id: user.id, username: user.username, balance: user.balance, dailyEarned: user.daily_earned, dailyLimit: DAILY_EARN_LIMIT };
}
function getUserById(id) { return db.prepare('SELECT * FROM users WHERE id = ?').get(id); }
function getUserByToken(token) {
  if (!token) return null;
  const row = db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>?`).get(token, now());
  if (!row) return null;
  return resetDailyIfNeeded(row);
}
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, expected) {
  const actual = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}
function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const created = now();
  db.prepare('INSERT INTO sessions(token,user_id,expires_at,created_at) VALUES(?,?,?,?)').run(token, userId, created + SESSION_DAYS * 86400000, created);
  return token;
}
function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const user = getUserByToken(token);
  if (!user) return res.status(401).json({ error: 'Sesión no válida o caducada.' });
  req.user = user;
  req.token = token;
  next();
}
function validUsername(username) { return /^[a-zA-Z0-9_]{3,20}$/.test(username); }
function validPassword(password) { return typeof password === 'string' && password.length >= 6 && password.length <= 100; }
function safeBet(value, balance) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_BET || n > balance) return null;
  return n;
}
function changeBalance(userId, delta, kind, meta = null) {
  const tx = db.transaction(() => {
    const user = getUserById(userId);
    if (!user) throw new Error('Usuario inexistente');
    const rawNext = user.balance + delta;
    if (rawNext < 0) throw new Error('Saldo insuficiente');
    const next = Math.min(rawNext, MAX_BALANCE);
    const actualDelta = next - user.balance;
    const totalWon = actualDelta > 0 ? user.total_won + actualDelta : user.total_won;
    const totalLost = actualDelta < 0 ? user.total_lost + Math.abs(actualDelta) : user.total_lost;
    db.prepare('UPDATE users SET balance=?, total_won=?, total_lost=? WHERE id=?').run(next, totalWon, totalLost, userId);
    db.prepare('INSERT INTO transactions(user_id,kind,amount,balance_after,meta,created_at) VALUES(?,?,?,?,?,?)')
      .run(userId, kind, actualDelta, next, meta ? JSON.stringify(meta) : null, now());
    return getUserById(userId);
  });
  return tx();
}
function earn(userId, amount, kind) {
  const user = resetDailyIfNeeded(getUserById(userId));
  if (!user) throw new Error('Usuario inexistente');
  const remaining = DAILY_EARN_LIMIT - user.daily_earned;
  if (remaining <= 0) return { user, earned: 0, limitReached: true };
  const actual = Math.min(amount, remaining);
  const updated = changeBalance(userId, actual, kind);
  db.prepare('UPDATE users SET daily_earned=daily_earned+? WHERE id=?').run(actual, userId);
  return { user: getUserById(userId), earned: actual, limitReached: actual < amount };
}

app.post('/api/register', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!validUsername(username)) return res.status(400).json({ error: 'El usuario debe tener 3-20 caracteres: letras, números o _.' });
  if (!validPassword(password)) return res.status(400).json({ error: 'La contraseña debe tener entre 6 y 100 caracteres.' });
  try {
    const { salt, hash } = hashPassword(password);
    const created = now();
    const result = db.prepare('INSERT INTO users(username,password_hash,password_salt,balance,daily_reset_at,created_at) VALUES(?,?,?,?,?,?)')
      .run(username, hash, salt, START_BALANCE, dayStart(), created);
    const token = createSession(result.lastInsertRowid);
    const user = getUserById(result.lastInsertRowid);
    db.prepare('INSERT INTO transactions(user_id,kind,amount,balance_after,created_at) VALUES(?,?,?,?,?)').run(user.id, 'welcome', START_BALANCE, START_BALANCE, created);
    return res.json({ token, user: publicUser(user) });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'Ese nombre de usuario ya existe.' });
    console.error(e); return res.status(500).json({ error: 'No se pudo crear la cuenta.' });
  }
});

app.post('/api/login', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const user = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username);
  if (!user || !verifyPassword(password, user.password_salt, user.password_hash)) return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
  resetDailyIfNeeded(user);
  const token = createSession(user.id);
  res.json({ token, user: publicUser(getUserById(user.id)) });
});

app.post('/api/logout', auth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token=?').run(req.token);
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));

app.get('/api/chat/history', (req, res) => {
  const rows = db.prepare('SELECT id,username,text,created_at FROM messages ORDER BY id DESC LIMIT 100').all().reverse();
  res.json({ messages: rows.map(m => ({ id: m.id, username: m.username, text: m.text, time: new Date(m.created_at).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }) })) });
});

app.post('/api/earn/click', auth, (req, res) => {
  const key = req.user.id;
  const last = lastEarn.get(`click:${key}`) || 0;
  if (now() - last < CLICK_COOLDOWN_MS) return res.status(429).json({ error: 'Espera un instante antes de volver a pulsar.' });
  lastEarn.set(`click:${key}`, now());
  try {
    const result = earn(key, CLICK_REWARD, 'earn_click');
    res.json({ user: publicUser(result.user), earned: result.earned, limitReached: result.limitReached });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/earn/sequence', auth, (req, res) => {
  const key = req.user.id;
  const last = lastEarn.get(`sequence:${key}`) || 0;
  if (now() - last < SEQUENCE_COOLDOWN_MS) return res.status(429).json({ error: 'Espera un instante antes de repetir el combo.' });
  lastEarn.set(`sequence:${key}`, now());
  try {
    const result = earn(key, SEQUENCE_REWARD, 'earn_sequence');
    res.json({ user: publicUser(result.user), earned: result.earned, limitReached: result.limitReached });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/game/roulette', auth, (req, res) => {
  const bet = safeBet(req.body.bet, req.user.balance);
  if (!bet) return res.status(400).json({ error: `Apuesta inválida. Máximo ${MAX_BET}.` });
  const choice = String(req.body.choice || 'red');
  const valid = ['red','black','green'];
  if (!valid.includes(choice)) return res.status(400).json({ error: 'Elección inválida.' });
  const number = crypto.randomInt(0, 37);
  const color = number === 0 ? 'green' : ([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36].includes(number) ? 'red' : 'black');
  const won = color === choice;
  const payout = won ? (choice === 'green' ? bet * 35 : bet * 2) : 0;
  const delta = payout - bet;
  const user = changeBalance(req.user.id, delta, 'roulette', { bet, choice, number, color, payout });
  res.json({ number, color, won, payout, delta, user: publicUser(user) });
});

app.post('/api/game/slots', auth, (req, res) => {
  const bet = safeBet(req.body.bet, req.user.balance);
  if (!bet) return res.status(400).json({ error: `Apuesta inválida. Máximo ${MAX_BET}.` });
  const symbols = ['7', 'BAR', 'CHERRY', 'LEMON', 'BELL', 'STAR'];
  const reels = Array.from({ length: 3 }, () => symbols[crypto.randomInt(0, symbols.length)]);
  let multiplier = 0;
  if (reels[0] === reels[1] && reels[1] === reels[2]) multiplier = reels[0] === '7' ? 12 : 6;
  else if (new Set(reels).size === 2) multiplier = 2;
  const payout = bet * multiplier;
  const delta = payout - bet;
  const user = changeBalance(req.user.id, delta, 'slots', { bet, reels, multiplier, payout });
  res.json({ reels, multiplier, payout, delta, won: payout > 0, user: publicUser(user) });
});

app.get('/api/transactions', auth, (req, res) => {
  const rows = db.prepare('SELECT kind,amount,balance_after,created_at,meta FROM transactions WHERE user_id=? ORDER BY id DESC LIMIT 50').all(req.user.id);
  res.json({ transactions: rows });
});

app.get(/.*/, (req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  const user = getUserByToken(token);
  if (!user) return next(new Error('AUTH_REQUIRED'));
  socket.user = user;
  next();
});

io.on('connection', socket => {
  activeSocketUsers.set(socket.id, socket.user.username);
  io.emit('presence', { count: activeSocketUsers.size });

  socket.on('chat message', payload => {
    const text = String(payload?.text || '').trim();
    if (!text || text.length > MAX_CHAT_LENGTH) return;
    const created = now();
    const result = db.prepare('INSERT INTO messages(user_id,username,text,created_at) VALUES(?,?,?,?)').run(socket.user.id, socket.user.username, text, created);
    const msg = { id: result.lastInsertRowid, username: socket.user.username, text, time: new Date(created).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }) };
    io.emit('chat message', msg);
  });

  socket.on('disconnect', () => {
    activeSocketUsers.delete(socket.id);
    io.emit('presence', { count: activeSocketUsers.size });
  });
});

setInterval(() => {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now());
  db.prepare('DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY id DESC LIMIT 1000)').run();
}, 60 * 60 * 1000).unref();

server.listen(PORT, '127.0.0.1', () => console.log(`Mi Bombo escuchando en http://127.0.0.1:${PORT}`));
