/* 公开站模式：Google 登录、会话、用户积分、Stripe 充值。
   仅当 A452_PUBLIC=1 时由 server.js 挂载；桌面/本地模式完全不加载。 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PUBLIC_MODE = process.env.A452_PUBLIC === '1';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const DEV_LOGIN = process.env.A452_DEV_LOGIN === '1';        // 本地验证用：允许 /api/auth/dev
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').map((s) => s.trim()).filter(Boolean);
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const SITE_URL = (process.env.SITE_URL || 'http://localhost:5893').replace(/\/+$/, '');
const FREE_CREDITS = Number(process.env.FREE_CREDITS || 20);  // 新用户赠送

// 各功能定价（积分）。按 Seedance 成本加成后调整。
const PRICING = {
  whole: (dur) => Math.ceil(dur * 3),        // 一体生成：3 积分/秒
  segment: (dur) => Math.ceil(dur * 2),      // 分段补间：2 积分/秒
  v2v: (dur) => Math.ceil(dur * 4),          // 转绘上色：4 积分/秒
  refine: () => 5,                           // 原画精修：5 积分/次
};

// 充值包
const PACKS = {
  starter: { credits: 200, amount: 500, currency: 'usd', name: 'Starter · 200 credits' },   // $5
  creator: { credits: 500, amount: 1000, currency: 'usd', name: 'Creator · 500 credits' },  // $10
  studio: { credits: 1500, amount: 2500, currency: 'usd', name: 'Studio · 1500 credits' },  // $25
};

// ---------- 简单 JSON 存储（原子写） ----------
function jsonStore(file, def) {
  let data = def;
  try { data = { ...def, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch {}
  let timer = 0;
  const flush = () => {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
    fs.renameSync(tmp, file);
  };
  return {
    get: () => data,
    save: () => { clearTimeout(timer); timer = setTimeout(flush, 300); },
    flushNow: flush,
  };
}

function install(app, dirs) {
  if (!PUBLIC_MODE) return null;

  const USERS_PATH = path.join(dirs.DATA_DIR, 'users.json');
  const SESS_PATH = path.join(dirs.DATA_DIR, 'sessions.json');
  const PROJ_DIR = path.join(dirs.DATA_DIR, 'projects');
  fs.mkdirSync(PROJ_DIR, { recursive: true });
  const users = jsonStore(USERS_PATH, {});    // sub -> {email, name, credits, created, ledger: [...last 50]}
  const sessions = jsonStore(SESS_PATH, {});  // sid -> {sub, created}

  function getUser(req) {
    const cookie = req.headers.cookie || '';
    const m = /(?:^|;\s*)a452sid=([\w-]+)/.exec(cookie);
    if (!m) return null;
    const sess = sessions.get()[m[1]];
    if (!sess) return null;
    const u = users.get()[sess.sub];
    return u ? { sub: sess.sub, ...u } : null;
  }

  function ensureUser(sub, email, name) {
    const all = users.get();
    if (!all[sub]) {
      all[sub] = { email, name, credits: FREE_CREDITS, created: Date.now(), ledger: [] };
      users.save();
    }
    return all[sub];
  }

  function addLedger(u, delta, why) {
    u.ledger = u.ledger || [];
    u.ledger.unshift({ t: Date.now(), delta, why });
    if (u.ledger.length > 50) u.ledger.length = 50;
  }

  // 扣费/退款（server.js 生成端点调用）
  function charge(req, kind, dur) {
    const user = getUser(req);
    if (!user) return { ok: false, error: '未登录' };
    const cost = PRICING[kind] ? PRICING[kind](dur) : 1;
    const all = users.get();
    const u = all[user.sub];
    if (u.credits < cost) return { ok: false, error: `积分不足：本次需要 ${cost}，余额 ${u.credits}。请充值。`, cost };
    u.credits -= cost;
    addLedger(u, -cost, kind);
    users.save();
    return { ok: true, cost, uid: user.sub };
  }

  function refund(uid, cost, why) {
    if (!uid || !cost) return;
    const u = users.get()[uid];
    if (!u) return;
    u.credits += cost;
    addLedger(u, cost, 'refund:' + (why || ''));
    users.save();
  }

  function isAdmin(user) {
    return user && ADMIN_EMAILS.includes(user.email);
  }

  // ---------- 鉴权中间件 ----------
  const OPEN_PATHS = new Set(['/api/auth/google', '/api/auth/dev', '/api/auth/logout', '/api/me', '/api/pay/webhook', '/api/site']);
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api/')) return next();
    if (OPEN_PATHS.has(req.path)) return next();
    const user = getUser(req);
    if (!user) return res.status(401).json({ error: '请先登录 / Please sign in' });
    // 全局配置仅管理员可改；普通用户 GET 允许（服务器已只回非敏感字段）
    if (req.path === '/api/config' && req.method === 'POST' && !isAdmin(user)) {
      // 允许普通用户保存自己的提示词类字段？公开站上这些是全局的 → 拒绝，提示词保存在工程里
      return res.status(403).json({ error: '公开站上全局设置仅管理员可改' });
    }
    req.a452user = user;
    next();
  });

  // ---------- 站点信息（登录前可访问） ----------
  app.get('/api/site', (req, res) => {
    res.json({
      publicMode: true,
      googleClientId: GOOGLE_CLIENT_ID,
      devLogin: DEV_LOGIN,
      packs: Object.entries(PACKS).map(([id, p]) => ({ id, ...p })),
      pricing: { whole: '3/s', segment: '2/s', v2v: '4/s', refine: '5' },
      payments: !!STRIPE_SECRET,
      freeCredits: FREE_CREDITS,
    });
  });

  // ---------- 登录 ----------
  function startSession(res, sub) {
    const sid = crypto.randomBytes(24).toString('base64url');
    sessions.get()[sid] = { sub, created: Date.now() };
    sessions.save();
    res.setHeader('Set-Cookie', `a452sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${180 * 24 * 3600}`);
  }

  app.post('/api/auth/google', async (req, res) => {
    const { credential } = req.body || {};
    if (!credential) return res.status(400).json({ error: '缺少凭证' });
    try {
      const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential));
      const info = await r.json();
      if (!r.ok || !info.sub) throw new Error(info.error_description || '校验失败');
      if (GOOGLE_CLIENT_ID && info.aud !== GOOGLE_CLIENT_ID) throw new Error('client_id 不匹配');
      if (info.email_verified !== 'true' && info.email_verified !== true) throw new Error('邮箱未验证');
      ensureUser(info.sub, info.email, info.name || info.email);
      startSession(res, info.sub);
      res.json({ ok: true });
    } catch (e) {
      res.status(401).json({ error: 'Google 登录失败: ' + String(e.message || e) });
    }
  });

  // 本地开发登录（A452_DEV_LOGIN=1 时可用）
  app.post('/api/auth/dev', (req, res) => {
    if (!DEV_LOGIN) return res.status(403).json({ error: 'dev 登录未开启' });
    const email = (req.body && req.body.email || 'dev@test.local').toLowerCase();
    const sub = 'dev-' + crypto.createHash('sha1').update(email).digest('hex').slice(0, 12);
    ensureUser(sub, email, email.split('@')[0]);
    startSession(res, sub);
    res.json({ ok: true });
  });

  app.post('/api/auth/logout', (req, res) => {
    const m = /(?:^|;\s*)a452sid=([\w-]+)/.exec(req.headers.cookie || '');
    if (m) { delete sessions.get()[m[1]]; sessions.save(); }
    res.setHeader('Set-Cookie', 'a452sid=; Path=/; Max-Age=0');
    res.json({ ok: true });
  });

  app.get('/api/me', (req, res) => {
    const user = getUser(req);
    if (!user) return res.json({ signedIn: false });
    res.json({
      signedIn: true,
      email: user.email,
      name: user.name,
      credits: user.credits,
      admin: isAdmin(user),
      ledger: (user.ledger || []).slice(0, 10),
    });
  });

  // ---------- 每用户工程 ----------
  function projPath(uid) { return path.join(PROJ_DIR, uid.replace(/[^\w-]/g, '_') + '.json'); }
  // 覆盖全局工程端点（在 server.js 注册之前挂载即可拦截）
  app.get('/api/project', (req, res) => {
    const user = getUser(req);
    if (!user) return res.status(401).json({ error: '请先登录' });
    const r = dirs.readProjectFile(projPath(user.sub));
    if (!r.ok) return res.status(500).json({ corrupt: true, error: '工程文件已损坏且无可用备份（原件已保存为 .corrupt-*），请勿覆盖保存' });
    if (r.restored && r.data && typeof r.data === 'object') r.data.restoredFromBackup = true;
    res.json(r.data);
  });
  app.post('/api/project', (req, res) => {
    const user = getUser(req);
    if (!user) return res.status(401).json({ error: '请先登录' });
    try {
      dirs.writeProjectFile(projPath(user.sub), req.body || {});
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  // ---------- Stripe 充值 ----------
  app.post('/api/pay/checkout', async (req, res) => {
    const user = getUser(req);
    if (!user) return res.status(401).json({ error: '请先登录' });
    if (!STRIPE_SECRET) return res.status(503).json({ error: '支付尚未配置（缺少 STRIPE_SECRET_KEY）' });
    const pack = PACKS[req.body && req.body.pack];
    if (!pack) return res.status(400).json({ error: '未知充值包' });
    try {
      const form = new URLSearchParams({
        mode: 'payment',
        success_url: SITE_URL + '/?paid=1',
        cancel_url: SITE_URL + '/?paid=0',
        'line_items[0][quantity]': '1',
        'line_items[0][price_data][currency]': pack.currency,
        'line_items[0][price_data][unit_amount]': String(pack.amount),
        'line_items[0][price_data][product_data][name]': pack.name,
        'metadata[sub]': user.sub,
        'metadata[credits]': String(pack.credits),
      });
      const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + STRIPE_SECRET,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form,
      });
      const j = await r.json();
      if (!r.ok) throw new Error((j.error && j.error.message) || 'Stripe 错误');
      res.json({ url: j.url });
    } catch (e) {
      res.status(502).json({ error: String(e.message || e) });
    }
  });

  // Stripe webhook（需在 Stripe 后台配置指向 /api/pay/webhook）
  app.post('/api/pay/webhook', (req, res) => {
    try {
      const sig = req.headers['stripe-signature'] || '';
      const raw = req.rawBody; // server.js 需为该路径保留原始 body
      if (STRIPE_WEBHOOK_SECRET && raw) {
        const parts = Object.fromEntries(sig.split(',').map((kv) => kv.split('=')));
        const signed = crypto.createHmac('sha256', STRIPE_WEBHOOK_SECRET)
          .update(parts.t + '.' + raw).digest('hex');
        if (signed !== parts.v1) return res.status(400).json({ error: '签名不符' });
      }
      const event = raw ? JSON.parse(raw.toString()) : req.body;
      if (event.type === 'checkout.session.completed') {
        const s = event.data.object;
        const sub = s.metadata && s.metadata.sub;
        const credits = Number(s.metadata && s.metadata.credits) || 0;
        const u = sub && users.get()[sub];
        if (u && credits > 0) {
          u.credits += credits;
          addLedger(u, credits, 'purchase');
          users.save();
        }
      }
      res.json({ received: true });
    } catch (e) {
      res.status(400).json({ error: String(e.message || e) });
    }
  });

  console.log(`公开站模式已启用${GOOGLE_CLIENT_ID ? '' : '（GOOGLE_CLIENT_ID 未配置，仅 dev 登录可用）'}${STRIPE_SECRET ? '' : '（Stripe 未配置）'}`);
  return { charge, refund, getUser, isAdmin };
}

module.exports = { install, PUBLIC_MODE };
