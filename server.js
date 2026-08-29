const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const APP_VERSION = '2026.07.14.1';

const ROOT = __dirname;
// 桌面版（Electron）下由主进程指定可写数据目录；直接 node server.js 时用项目目录
const BASE = process.env.ATELIER_DATA_DIR || ROOT;
const VIDEO_DIR = path.join(BASE, 'videos');
const TMP_DIR = path.join(BASE, 'tmp');
const DATA_DIR = path.join(BASE, 'data');
const ASSET_DIR = path.join(DATA_DIR, 'assets');
const PROJECT_PATH = path.join(DATA_DIR, 'project.json');
const CONFIG_PATH = path.join(BASE, 'config.json');
fs.mkdirSync(VIDEO_DIR, { recursive: true });
fs.mkdirSync(TMP_DIR, { recursive: true });
fs.mkdirSync(ASSET_DIR, { recursive: true });

const DEFAULT_STYLE_PROMPT =
  '画面风格必须与首帧和尾帧图片保持完全一致：相同的线条、笔触、色彩和质感。' +
  '严禁改变画风，严禁添加原图中不存在的颜色或上色，严禁增加阴影、光效或背景细节。' +
  '如果原图是黑白线稿，则全程保持纯黑白线稿。只在两帧之间生成自然的动作过渡。';

const DEFAULT_INBETWEEN_PROMPT =
  '中割运动指令（必须遵守）：每两张相邻关键帧之间必须存在完整的中割动画——画面在整个区间内持续运动，' +
  '角色以自然、物理可信、充满中间过程的动作，从前一张关键帧的姿势运动到下一张关键帧的姿势。' +
  '严禁静止定格，严禁用淡入淡出、交叉溶解或仅靠镜头移动来代替角色自身的运动；' +
  '身体、头发、衣物在每一帧都要有可见的位移与形变，关键帧只是运动轨迹中被经过的瞬间。';

const DEFAULT_COLOR_PROMPT =
  '把视频1（粗略的线稿动画）转绘为最终成片：严格保持视频1的动作、时间节奏、构图和镜头完全不变，' +
  '人物造型与线条结构与视频1一致。按照参考图片的配色、上色风格和画面质感为整段视频完整上色，' +
  '输出干净精致的最终动画成片。不要添加参考图中不存在的新元素，不要改变任何动作，不要切换镜头。';

// 隐藏的原画（GENGA）系统指令：不出现在 UI，精修请求永远前置注入。
// 依据日本动画产业原画/動画规范调教：実線、影指定、ハイライト指定、纯白纸面、忠实姿势。
const GENGA_SYSTEM_PROMPT =
  '【原画清稿系统指令 · 必须严格执行】把输入图片转化为日本动画产业标准的原画（GENGA / 第二原画清稿），' +
  '如同资深原画师在动画纸上完成的作画监督修正稿：\n' +
  '1. 実線：所有轮廓用干净、连贯、闭合的深色实线（均匀铅笔质感），运笔自信流畅、粗细有致——' +
  '外轮廓略粗、内部细节更细；彻底去除草稿的重复线、辅助线、结构线、透视线与噪点。\n' +
  '2. 影指定：按统一光源在明暗交界处画出清晰闭合的阴影分界线（shadow boundary contours），' +
  '形态利落、结构正确，覆盖头发块面、面部（鼻影、颈影、刘海投影）、衣褶与身体转折——这是原画的标志性特征，必须存在。\n' +
  '3. ハイライト指定：在头发高光、瞳孔高光、金属与光泽材质处画出简洁明确的高光分界线。\n' +
  '4. 纸面：纯白背景（动画纸），无色彩、无灰阶填充、无排线、无网点，只有线条。\n' +
  '5. 忠实性：人物姿势、构图、镜头角度、身体比例与输入图完全一致，绝不改变动作、不增删元素；' +
  '面部结构、发型分组、服装细节按角色设定精确还原。\n' +
  '6. 若提供彩色设定图/色卡参考：只提取角色设计（发型、五官、服装结构、配饰），翻译成线稿语言；' +
  '不要照搬参考图的姿势、构图或颜色。\n' +
  '输出必须像扫描的职业原画：干净、锐利、可直接进入动画流程。';

const DEFAULT_REFINE_PROMPT =
  '把这张图片精修为干净的完成版动漫原画线稿（tie-down 清线）：线条干净、流畅、闭合，粗细有致；' +
  '去除草稿杂线、辅助线、参考标注和噪点；保持人物结构、姿势、表情、构图与原图完全一致；' +
  '白色背景。不要上色，不要添加阴影，不要改变画风，不要增删任何元素。';

const DEFAULT_PRESETS = [
  { id: 'p1', name: '线稿风格锁定 Lineart lock', text: '纯黑白手绘线稿，白色背景，黑色线条，无任何颜色、无灰阶、无阴影。所有帧保持与输入图完全相同的线稿画风。' },
  { id: 'p2', name: '赛璐璐上色 Cel shading', text: '赛璐璐动画上色：干净的色块、清晰的明暗二分、锐利的阴影边缘，日本 TV 动画质感。' },
  { id: 'p3', name: '高速战斗 Fast action', text: '高速战斗动作：动作迅猛干脆，关键姿势极具冲击力，带速度线与残影感，节奏暴烈。' },
];

const DEFAULT_CONFIG = {
  apiKey: '',
  endpoint: 'https://ark.cn-beijing.volces.com/api/v3',
  model: 'doubao-seedance-1-5-pro-251215',
  v2vModel: 'doubao-seedance-2-0-260128',
  imgModel: 'doubao-seedream-4-0-250828',
  imgProvider: 'ark',                       // 'ark' | 'openai'（OpenAI 兼容 Images API）
  openaiBase: 'https://api.openai.com',
  openaiKey: '',
  openaiImgModel: 'gpt-image-2',
  // 剧本解析智能体（PDF 导入 → 分场/镜头/提示词）
  llmProvider: 'auto',   // 'auto' | 'anthropic' | 'openai' | 'ark' | 'hermes'
  anthropicKey: '',
  llmModel: '',          // 留空则按提供商用默认：claude-fable-5 / gpt-5.6-sol / doubao-seed-1-6-250615
  // 🧠 Hermes 门户：本机 `hermes proxy`（OpenAI 兼容，走用户自己的 OAuth 订阅，零 API Key）
  hermesBase: 'http://127.0.0.1:8645',
  hermesModel: '',       // 留空 = 自动取门户 /v1/models 第一项
  // Claude 用量硬顶：累计成本达到 capUsd 后拒绝再调用 Claude，需人工确认充值后重置
  llmSpend: { usd: 0, capUsd: 20 },
  resolution: '720p',
  ratio: 'adaptive',
  stylePrompt: DEFAULT_STYLE_PROMPT,
  inbetweenPrompt: DEFAULT_INBETWEEN_PROMPT,
  colorPrompt: DEFAULT_COLOR_PROMPT,
  refinePrompt: DEFAULT_REFINE_PROMPT,
  presets: DEFAULT_PRESETS,
  publicBase: '',
};

/** 自动记录用户实际使用过的提示词（去重、封顶 100 条），供提示词库「最近使用」调取 */
function logUsedPrompt(cfg, kind, text) {
  const t = (text || '').trim();
  if (!t || t.length < 4) return;
  try {
    const cur = loadConfig();
    const list = Array.isArray(cur.usedPrompts) ? cur.usedPrompts : [];
    if (list.some((u) => u.text === t)) return;
    list.unshift({ t: Date.now(), kind, text: t });
    if (list.length > 100) list.length = 100;
    cur.usedPrompts = list;
    saveConfig(cur);
  } catch {}
}

// ---------- 原子 JSON 写入（tmp + fsync + rename；Windows 杀毒/索引器瞬时锁定时短重试） ----------
function atomicWriteFileSync(file, data) {
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  let lastErr = null;
  for (let i = 0; i < 3; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      lastErr = e;
      if (e.code !== 'EPERM' && e.code !== 'EBUSY' && e.code !== 'EACCES') throw e;
      const until = Date.now() + 50 * (i + 1);
      while (Date.now() < until) { /* 同步上下文里的短暂退避 */ }
    }
  }
  throw lastErr;
}

// config.json 损坏且无备份可用时置位：花费按已达上限处理（fail closed），
// 并冻结配置写入，防止把清零的 llmSpend 账本静默持久化。仅用户显式 llmSpendReset 可解除。
let configCorrupt = false;
let corruptEvidenceSaved = false;

// ---------------- API Key 钥匙串：多账号按平台组织，选中的那把即当前生效 ----------------
// cfg.keychain = { artcraft: [{id,label,key,addedAt,activatedAt}], ark/anthropic/openai 同构 }
// cfg.keychainActive = { artcraft: id, ... }
// 生效方式：loadConfig 时把 active 的 key 物化回历史字段（artcraftKey/apiKey/...），
// 全部现有调用路径零改动；钥匙串是唯一真理源。
const KEYCHAIN_FIELD = { artcraft: 'artcraftKey', ark: 'apiKey', anthropic: 'anthropicKey', openai: 'openaiKey' };
const KEYCHAIN_LABEL = { artcraft: 'Artcraft', ark: '方舟 Ark', anthropic: 'Anthropic Claude', openai: 'OpenAI 兼容' };
function resolveKeychain(cfg) {
  if (!cfg.keychain || typeof cfg.keychain !== 'object') return cfg;
  for (const [pf, field] of Object.entries(KEYCHAIN_FIELD)) {
    const list = Array.isArray(cfg.keychain[pf]) ? cfg.keychain[pf] : [];
    const activeId = cfg.keychainActive && cfg.keychainActive[pf];
    const hit = list.find((k) => k && k.id === activeId);
    if (hit !== undefined) cfg[field] = hit.key || '';
  }
  return cfg;
}
/** 迁移 + 增改：确保结构存在；把 legacy 字段里已有的 key 收编为钥匙串条目 */
function ensureKeychain(cur) {
  let changed = false;
  if (!cur.keychain || typeof cur.keychain !== 'object') { cur.keychain = {}; changed = true; }
  if (!cur.keychainActive || typeof cur.keychainActive !== 'object') { cur.keychainActive = {}; changed = true; }
  for (const [pf, field] of Object.entries(KEYCHAIN_FIELD)) {
    if (!Array.isArray(cur.keychain[pf])) { cur.keychain[pf] = []; changed = true; }
    const legacy = String(cur[field] || '');
    if (legacy && !cur.keychain[pf].some((k) => k && k.key === legacy)) {
      const entry = { id: newId(), label: '现有 Key（自动收编）', key: legacy, addedAt: Date.now(), activatedAt: Date.now() };
      cur.keychain[pf].push(entry);
      if (!cur.keychainActive[pf]) cur.keychainActive[pf] = entry.id;
      changed = true;
    }
    // active 指向不存在的条目 → 清掉
    if (cur.keychainActive[pf] && !cur.keychain[pf].some((k) => k && k.id === cur.keychainActive[pf])) {
      cur.keychainActive[pf] = cur.keychain[pf][0] ? cur.keychain[pf][0].id : '';
      changed = true;
    }
  }
  return changed;
}
/** 写路径统一：改完钥匙串后把 active 物化回 legacy 字段再落盘 */
function syncKeychainToLegacy(cur) {
  for (const [pf, field] of Object.entries(KEYCHAIN_FIELD)) {
    const hit = (cur.keychain[pf] || []).find((k) => k && k.id === cur.keychainActive[pf]);
    cur[field] = hit ? (hit.key || '') : '';
  }
}
function maskKey(k) {
  const s = String(k || '');
  if (s.length <= 10) return s.slice(0, 2) + '…' + s.slice(-2);
  return s.slice(0, 10) + '…' + s.slice(-4);
}

function loadConfig() {
  let raw = null;
  try {
    raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { ...DEFAULT_CONFIG }; // 首次运行
    console.error('读取 config.json 失败:', String(e.message || e));
  }
  if (raw !== null) {
    try {
      const cfg = resolveKeychain({ ...DEFAULT_CONFIG, ...JSON.parse(raw) });
      configCorrupt = false; // 主文件完好 → 解除（瞬时读错误造成的）写入冻结
      return cfg;
    } catch {
      // 损坏：先保全现场（仅一次），绝不静默用默认值覆盖
      if (!corruptEvidenceSaved) {
        corruptEvidenceSaved = true;
        try { fs.copyFileSync(CONFIG_PATH, CONFIG_PATH + '.corrupt-' + Date.now()); } catch {}
      }
    }
  }
  // 主文件不可用 → 尝试上一次成功写入的备份
  try {
    const cfg = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH + '.bak', 'utf8')) };
    console.error('config.json 损坏，已从 config.json.bak 恢复（损坏原件已保存为 .corrupt-*）');
    configCorrupt = false; // 备份完好：账本未丢，允许写回修复主文件
    return cfg;
  } catch {}
  // 主文件与备份都不可用：llmSpend 账本按已达上限处理，冻结写入，等待用户处理
  if (!configCorrupt) {
    configCorrupt = true;
    console.error('config.json 与 config.json.bak 均不可读：Claude 花费按已达上限处理，' +
      '配置写入已冻结。请检查 ' + CONFIG_PATH + '（损坏原件已保存为 .corrupt-*），或在设置中执行"已充值重置"解除。');
  }
  const cfg = { ...DEFAULT_CONFIG };
  cfg.llmSpend = { usd: DEFAULT_CONFIG.llmSpend.capUsd, capUsd: DEFAULT_CONFIG.llmSpend.capUsd };
  return cfg;
}
function saveConfig(cfg) {
  if (configCorrupt) {
    throw new Error('config.json 已损坏且无可用备份：为保护 Claude 花费账本，配置写入已冻结。' +
      '请手工检查 config.json（损坏原件已保存为 .corrupt-*），或在设置中执行"已充值重置"解除。');
  }
  atomicWriteFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  // 刷新备份：备份内容 = 刚写入的合法 JSON，供下次主文件损坏时恢复
  try { fs.copyFileSync(CONFIG_PATH, CONFIG_PATH + '.bak'); } catch {}
}

// ---------- 工程文件读写（原子写 + .bak 轮换 + 损坏识别，供本地与公开站共用） ----------
function readProjectFile(file) {
  let raw = null;
  let parseFailed = false;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: true, data: {} }; // 首次运行：空工程
    console.error('读取 ' + path.basename(file) + ' 失败:', String(e.message || e));
  }
  if (raw !== null) {
    try {
      return { ok: true, data: JSON.parse(raw) };
    } catch {
      parseFailed = true;
      // 损坏文件先改名保全现场，防止后续自动保存覆盖掉尚可抢救的数据
      try { fs.renameSync(file, file + '.corrupt-' + Date.now()); } catch {}
    }
  }
  try {
    const data = JSON.parse(fs.readFileSync(file + '.bak', 'utf8'));
    console.error(path.basename(file) + ' 不可用，已从 .bak 备份恢复' + (parseFailed ? '（损坏原件已保存为 .corrupt-*）' : ''));
    if (parseFailed) { try { atomicWriteFileSync(file, JSON.stringify(data, null, 1)); } catch {} }
    return { ok: true, data, restored: true };
  } catch {}
  console.error(path.basename(file) + ' 损坏且无可用备份，已拒绝当作空工程返回');
  return { ok: false };
}
function writeProjectFile(file, body) {
  // 覆盖前把当前可解析的版本轮换为 .bak（解析校验保证备份永远是好文件）
  try {
    const prev = fs.readFileSync(file, 'utf8');
    JSON.parse(prev);
    atomicWriteFileSync(file + '.bak', prev);
  } catch {}
  atomicWriteFileSync(file, JSON.stringify(body || {}, null, 1));
}

// ---------- ffmpeg ----------
function findFfmpeg(name) {
  if (process.env.FFMPEG_DIR) {
    const p = path.join(process.env.FFMPEG_DIR, name + (process.platform === 'win32' ? '.exe' : ''));
    if (fs.existsSync(p)) return p;
  }
  const probe = spawnSync(name, ['-version'], { shell: false });
  if (probe.status === 0) return name;
  // winget install location (Windows)
  const base = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
  try {
    for (const dir of fs.readdirSync(base)) {
      if (!dir.startsWith('Gyan.FFmpeg')) continue;
      const pkg = path.join(base, dir);
      for (const sub of fs.readdirSync(pkg)) {
        const bin = path.join(pkg, sub, 'bin', name + '.exe');
        if (fs.existsSync(bin)) return bin;
      }
    }
  } catch {}
  return null;
}
const FFMPEG = findFfmpeg('ffmpeg');
const FFPROBE = findFfmpeg('ffprobe');

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    if (!FFMPEG) return reject(new Error('未找到 ffmpeg，请安装或设置 FFMPEG_DIR 环境变量'));
    const proc = spawn(FFMPEG, args);
    let err = '';
    proc.stderr.on('data', (d) => { err += d; if (err.length > 20000) err = err.slice(-10000); });
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error('ffmpeg 失败: ' + err.slice(-800)))));
    proc.on('error', reject);
  });
}

function probeDurationSec(file) {
  if (!FFPROBE) return null;
  const out = spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  const d = parseFloat((out.stdout || '').trim());
  return Number.isFinite(d) ? d : null;
}

function probeSize(file) {
  if (!FFPROBE) return { w: 1280, h: 720 };
  const out = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  const [w, h] = (out.stdout || '').trim().split(',').map(Number);
  return w && h ? { w, h } : { w: 1280, h: 720 };
}

function dataUrlToFile(dataUrl, filePath) {
  const m = /^data:image\/(\w+);base64,(.+)$/s.exec(dataUrl);
  if (!m) throw new Error('无效的图片数据');
  fs.writeFileSync(filePath, Buffer.from(m[2], 'base64'));
}

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', mp4: 'video/mp4', mov: 'video/quicktime' };

// 本地资源 URL（/assets/x 或 /videos/x）或 data URL → data URL（供 Ark 图片入参）
function resolveToDataUrl(url) {
  if (typeof url !== 'string') throw new Error('无效资源');
  if (url.startsWith('data:')) return url;
  const file = localFileOf(url);
  if (!file) throw new Error('无法解析资源: ' + url.slice(0, 80));
  const ext = path.extname(file).slice(1).toLowerCase();
  return `data:${MIME[ext] || 'application/octet-stream'};base64,` + fs.readFileSync(file).toString('base64');
}

function localFileOf(url) {
  if (url.startsWith('/assets/')) return path.join(ASSET_DIR, path.basename(url));
  if (url.startsWith('/videos/')) return path.join(VIDEO_DIR, path.basename(url));
  return null;
}

// Ark 视频生成的图片入参统一压缩：原图多张 base64 直传会超 Ark 请求体上限（413）。
// 长边压到 1536px JPEG（720P 生成绰绰有余），ffmpeg 不可用或压缩失败时回退原图。
const ARK_IMG_MAX_EDGE = 1536;
function resolveToArkImage(url) {
  try {
    const file = typeof url === 'string' && !url.startsWith('data:') ? localFileOf(url) : null;
    if (!file || !fs.existsSync(file) || !FFMPEG) return resolveToDataUrl(url);
    if (fs.statSync(file).size <= 900 * 1024) return resolveToDataUrl(url); // 已经够小
    const out = path.join(TMP_DIR, 'ark_' + newId() + '.jpg');
    const r = spawnSync(FFMPEG, [
      '-i', file,
      '-vf', `scale='min(${ARK_IMG_MAX_EDGE},iw)':-2`,
      '-frames:v', '1', '-q:v', '4', '-v', 'error', '-y', out,
    ]);
    if (r.status !== 0 || !fs.existsSync(out)) return resolveToDataUrl(url);
    const b64 = 'data:image/jpeg;base64,' + fs.readFileSync(out).toString('base64');
    fs.rm(out, { force: true }, () => {});
    return b64;
  } catch {
    return resolveToDataUrl(url);
  }
}

// ---------- 公网隧道（只暴露 5894 端口的只读文件服务） ----------
const FILES_PORT = 5894;
function findCloudflared() {
  if (process.env.CLOUDFLARED_PATH && fs.existsSync(process.env.CLOUDFLARED_PATH)) return process.env.CLOUDFLARED_PATH;
  const probe = spawnSync('cloudflared', ['--version'], { shell: false });
  if (probe.status === 0) return 'cloudflared';
  const candidates = [
    path.join(process.env.ProgramFiles || 'C:/Program Files', 'cloudflared', 'cloudflared.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'cloudflared', 'cloudflared.exe'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

const tunnel = { url: null, proc: null, starting: null };
function ensureTunnel() {
  // 公开部署时站点自身就是公网地址，无需隧道
  if (process.env.SITE_URL) return Promise.resolve(process.env.SITE_URL.replace(/\/+$/, ''));
  const cfg = loadConfig();
  if (cfg.publicBase) return Promise.resolve(cfg.publicBase.replace(/\/+$/, ''));
  if (tunnel.url) return Promise.resolve(tunnel.url);
  if (tunnel.starting) return tunnel.starting;
  const exe = findCloudflared();
  if (!exe) {
    return Promise.reject(new Error('参考视频必须是公网 URL：请安装 cloudflared（winget install Cloudflare.cloudflared）或在设置里填写公网基址 publicBase'));
  }
  tunnel.starting = new Promise((resolve, reject) => {
    const proc = spawn(exe, ['tunnel', '--url', 'http://127.0.0.1:' + FILES_PORT]);
    let buf = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { proc.kill(); } catch {} // 超时必须杀掉子进程，防止 cloudflared 越积越多
      reject(new Error('cloudflared 隧道启动超时（30s）'));
    }, 30000);
    const onData = (d) => {
      buf += d.toString();
      const m = buf.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m && !settled) {
        settled = true;
        clearTimeout(timer);
        tunnel.url = m[0];
        tunnel.proc = proc;
        console.log('文件隧道已建立:', tunnel.url);
        resolve(tunnel.url);
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    proc.on('close', (code) => {
      if (tunnel.proc === proc) { tunnel.url = null; tunnel.proc = null; }
      // 快速失败：cloudflared 提前退出时立即报错，不再空等 30s
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error('cloudflared 提前退出 (code ' + code + '): ' + buf.slice(-400)));
      }
    });
  }).finally(() => { tunnel.starting = null; });
  return tunnel.starting;
}

// ---------- 任务表 ----------
// tasks[id] = { mode: 'ark'|'mock', status: 'running'|'succeeded'|'failed', videoUrl?, error?, arkId? }
const tasks = {};
const newId = () => crypto.randomBytes(8).toString('hex');

function clampDuration(duration, fallback = 5, min = 4, max = 15) {
  const n = Number(duration);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

// ---------- 生成：本地模拟（交叉溶解） ----------
async function mockGenerate(id, firstDataUrl, lastDataUrl, duration) {
  const a = path.join(TMP_DIR, id + '_a.png');
  const b = path.join(TMP_DIR, id + '_b.png');
  const out = path.join(VIDEO_DIR, id + '.mp4');
  const d = clampDuration(duration);
  const fit = 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:white,setsar=1';
  try {
    // 写帧文件放在 try 里：非法 data URL（如 svg/视频帧）只失败本任务，不能炸掉整个进程
    dataUrlToFile(firstDataUrl, a);
    dataUrlToFile(lastDataUrl, b);
    await runFfmpeg([
      '-y', '-loop', '1', '-t', String(d), '-i', a, '-loop', '1', '-t', String(d), '-i', b,
      '-filter_complex', `[0:v]${fit}[va];[1:v]${fit}[vb];[va][vb]xfade=transition=fade:duration=${d}:offset=0,format=yuv420p`,
      '-r', '24', '-c:v', 'libx264', '-preset', 'fast', out,
    ]);
    tasks[id] = { ...tasks[id], status: 'succeeded', videoUrl: '/videos/' + id + '.mp4' };
  } catch (e) {
    tasks[id] = { ...tasks[id], status: 'failed', error: String(e.message || e) };
  } finally {
    for (const f of [a, b]) fs.rm(f, { force: true }, () => {});
  }
}

// ---------- 生成：火山方舟 Seedance ----------
// ---------- Ark 内容安全防误伤 ----------
// 火山引擎对毒品/违禁词零容忍，英文同形词也会触发（如 ecstasy 既是"狂喜"也是摇头丸）。
// 这里只替换"合法创作语境常见、但撞违禁品名"的明确误伤词，绝不动创作意图。
const ARK_SENSITIVE_FIXES = [
  [/\becstasy\b/gi, 'exhilaration'],
  [/\becstatic\b/gi, 'exhilarated'],
  [/\bcocaine\b|\bheroin\b(?!e)|\bmeth\b|\bopium\b/gi, 'forbidden substance'],
];
function sanitizeForArk(text) {
  let t = String(text || '');
  for (const [re, rep] of ARK_SENSITIVE_FIXES) t = t.replace(re, rep);
  return t;
}
/** 拦截错误增强：命中内容安全时附上实际发送文本预览，用户可自查触发词 */
function arkErrorWithPreview(label, status, json, sentText) {
  let msg = `Ark ${label} (${status}): ` + JSON.stringify(json).slice(0, 400);
  const code = json && json.error && json.error.code || '';
  if (/Sensitive/i.test(code)) {
    msg += `\n⚠ 内容安全拦截：请自查提示词中的敏感词（毒品/暴力/色情/政治类，英文同形词也会触发）。`
      + `\n实际发送文本预览：${String(sentText || '').slice(0, 400)}`;
  }
  if (Number(status) === 413) {
    msg += '\n⚠ 请求体超限：图片总体积过大（已自动压缩仍超限）——请减少参考图数量或使用更小的图片。';
  }
  return new Error(msg);
}

async function arkCreate(cfg, firstDataUrl, lastDataUrl, prompt, duration, stylePrompt, actingPrompt, inbetweenPrompt) {
  const style = (stylePrompt !== undefined ? stylePrompt : cfg.stylePrompt) || '';
  // 中割运动指令：永远注入，保证首尾帧之间不是"无运动的渐变"
  const inbetween = (inbetweenPrompt !== undefined && inbetweenPrompt !== ''
    ? inbetweenPrompt
    : (cfg.inbetweenPrompt || DEFAULT_INBETWEEN_PROMPT));
  const text = sanitizeForArk([style.trim(), inbetween.trim(), (actingPrompt || '').trim(), (prompt || '').trim()]
    .filter(Boolean).join('\n'));
  const content = [];
  if (text) content.push({ type: 'text', text });
  content.push({ type: 'image_url', image_url: { url: firstDataUrl }, role: 'first_frame' });
  content.push({ type: 'image_url', image_url: { url: lastDataUrl }, role: 'last_frame' });
  const body = {
    model: cfg.model,
    content,
    duration: clampDurationFor(cfg.model, duration),
    resolution: cfg.resolution,
    ratio: cfg.ratio,
    watermark: false,
  };
  const res = await fetch(cfg.endpoint + '/contents/generations/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw arkErrorWithPreview('创建任务失败', res.status, json, text);
  if (!json.id) throw new Error('Ark 响应缺少任务 id: ' + JSON.stringify(json).slice(0, 300));
  return json.id;
}

// 远端结果 → 本地文件（结果链接 24h 过期，成功即下载）
async function arkDownload(task, remote, localId) {
  const file = path.join(VIDEO_DIR, localId + '.mp4');
  const vres = await fetch(remote);
  if (!vres.ok) throw new Error('下载生成视频失败: ' + vres.status);
  fs.writeFileSync(file, Buffer.from(await vres.arrayBuffer()));
  task.status = 'succeeded';
  task.videoUrl = '/videos/' + localId + '.mp4';
  delete task.remoteUrl;
}

async function arkPoll(cfg, task, localId) {
  // 上次已确认成功但下载失败：跳过状态查询，直接重试下载（钱已花，结果必须找回）
  if (task.remoteUrl) return arkDownload(task, task.remoteUrl, localId);
  const res = await fetch(cfg.endpoint + '/contents/generations/tasks/' + task.arkId, {
    headers: { Authorization: 'Bearer ' + cfg.apiKey },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Ark 查询失败 (${res.status}): ` + JSON.stringify(json).slice(0, 300));
  const status = json.status;
  if (status === 'succeeded') {
    const remote = json.content && json.content.video_url;
    if (!remote) throw new Error('任务成功但没有 video_url');
    // 先记下远端地址：本次下载失败时，后续轮询可直接重试下载
    task.remoteUrl = remote;
    await arkDownload(task, remote, localId);
  } else if (status === 'failed' || status === 'cancelled') {
    task.status = 'failed';
    task.error = (json.error && (json.error.message || json.error.code)) || ('任务' + status);
  } // queued / running → 保持 running
}

// ---------- V2V：本地模拟（上色滤镜占位） ----------
async function mockV2V(id, srcFile) {
  const out = path.join(VIDEO_DIR, id + '.mp4');
  try {
    await runFfmpeg([
      '-y', '-i', srcFile,
      '-vf', 'eq=saturation=1.5:contrast=1.05,colorbalance=rs=.06:gm=.03:bs=-.05,format=yuv420p',
      '-c:v', 'libx264', '-preset', 'fast', '-an', out,
    ]);
    tasks[id] = { ...tasks[id], status: 'succeeded', videoUrl: '/videos/' + id + '.mp4' };
  } catch (e) {
    tasks[id] = { ...tasks[id], status: 'failed', error: String(e.message || e) };
  }
}

// ---------- Artcraft 平台适配（api.storyteller.ai · Authorization: Bearer artcraft_api_*） ----------
// 端点与请求结构逆向自官方开源仓库 github.com/storytold/artcraft（artcraft_api_defs crate）。
const ARTCRAFT_API = 'https://api.storyteller.ai';

function artcraftResolutionOf(cfg) {
  const r = String(cfg.resolution || '720p');
  return /1080/.test(r) ? 'ten_eighty_p' : /480/.test(r) ? 'four_eighty_p' : 'seven_twenty_p';
}
function artcraftAspectOf(cfg) {
  const r = String(cfg.ratio || '');
  if (/9:16|portrait/i.test(r)) return 'portrait9x16';
  if (/1:1|square/i.test(r)) return 'square1x1';
  if (/4:3/.test(r)) return 'standard4x3';
  return 'landscape16x9';
}

/** 本地图片（经压缩）→ Artcraft media_file_token */
async function artcraftUploadImage(cfg, localUrl) {
  const file = localFileOf(localUrl);
  if (!file || !fs.existsSync(file)) throw new Error('图片不存在: ' + String(localUrl).slice(0, 80));
  // 复用 Ark 的压缩策略控制上传体积
  const dataUrl = resolveToArkImage(localUrl);
  const m = /^data:(image\/[\w.+-]+);base64,(.+)$/s.exec(dataUrl);
  if (!m) throw new Error('图片编码失败');
  const buf = Buffer.from(m[2], 'base64');
  const fd = new FormData();
  fd.append('uuid_idempotency_token', crypto.randomUUID());
  fd.append('file', new Blob([buf], { type: m[1] }), path.basename(file).replace(/\.[^.]+$/, '') + (m[1] === 'image/jpeg' ? '.jpg' : '.png'));
  const r = await fetch(ARTCRAFT_API + '/v1/media_files/upload/image', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + cfg.artcraftKey },
    body: fd,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.media_file_token) {
    throw new Error(`Artcraft 图片上传失败 (${r.status}): ` + JSON.stringify(j).slice(0, 200));
  }
  return j.media_file_token;
}

/** 本地视频 → Artcraft media_file_token（V2V 参考视频用） */
async function artcraftUploadVideo(cfg, localUrl) {
  const file = localFileOf(localUrl);
  if (!file || !fs.existsSync(file)) throw new Error('视频不存在: ' + String(localUrl).slice(0, 80));
  const buf = fs.readFileSync(file);
  const fd = new FormData();
  fd.append('uuid_idempotency_token', crypto.randomUUID());
  fd.append('file', new Blob([buf], { type: 'video/mp4' }), path.basename(file));
  const r = await fetch(ARTCRAFT_API + '/v1/media_files/upload/video', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + cfg.artcraftKey },
    body: fd,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.media_file_token) {
    throw new Error(`Artcraft 视频上传失败 (${r.status}): ` + JSON.stringify(j).slice(0, 200));
  }
  return j.media_file_token;
}

/** 本地音频 → Artcraft media_file_token（参考音频用） */
async function artcraftUploadAudio(cfg, localUrl) {
  const file = localFileOf(localUrl);
  if (!file || !fs.existsSync(file)) throw new Error('音频不存在: ' + String(localUrl).slice(0, 80));
  const buf = fs.readFileSync(file);
  const ext = path.extname(file).slice(1).toLowerCase();
  const mime = ext === 'wav' ? 'audio/wav' : ext === 'm4a' ? 'audio/mp4' : 'audio/mpeg';
  const fd = new FormData();
  fd.append('uuid_idempotency_token', crypto.randomUUID());
  fd.append('file', new Blob([buf], { type: mime }), path.basename(file));
  const r = await fetch(ARTCRAFT_API + '/v1/media_files/upload/audio', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + cfg.artcraftKey },
    body: fd,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.media_file_token) {
    throw new Error(`Artcraft 音频上传失败 (${r.status}): ` + JSON.stringify(j).slice(0, 200));
  }
  return j.media_file_token;
}

/** 动画帧率指令（隐藏注入 · REFERENCES TOOL 专用 · 本工具面向动画生产） */
// 微动作生命层：卡帧≠死帧——定格里角色仍在呼吸、眨眼、微调重心，环境仍有微风与浮尘
const MICRO_LIFE =
  '即使在定格与静止段落，画面也永不完全死寂：角色保持可见的呼吸起伏、自然眨眼、' +
  '重心细微调整、手指与视线的小动作；环境保持微量活动（发丝衣角轻摆、浮尘、光影微颤）——' +
  '微动作幅度小但始终存在，让每一帧都是活的。';
const ANIM_MODE_PROMPTS = {
  '12fps': '【动画帧率指令】整段视频以逐帧动画质感呈现：画面以约每秒 12 帧的卡帧节奏运动（animated on twos / 拍二），' +
    '帧与帧之间保留干脆的跳跃感与定格感，运动是逐帧绘制式的阶跃而非连续滑动；' +
    '严禁 60fps 平滑插值、严禁运动模糊、严禁均匀慢速漂移；快速动作用 smear 帧与残影表达。' + MICRO_LIFE,
  variable: '【动画帧率指令】变速动画节奏（framerate modulation）：动作爆发段节奏凌厉、密集补帧一气呵成；' +
    '蓄力与收势段卡帧定格、节奏放缓甚至完全定格（tome-e）；整体保持逐帧动画的阶跃质感与拍二基调，' +
    '严禁均匀的 60fps 平滑插值与运动模糊，帧率变化本身就是表演的一部分。' + MICRO_LIFE,
};
function animModePrompt(mode) {
  return ANIM_MODE_PROMPTS[mode] || '';
}

// ---------- 常青提示词：全局质量/风格锚，注入所有工作区的每一次生成 ----------
function evergreenText(cfg) {
  const t = String(cfg.evergreen || '').trim();
  return t ? '【常青锚点 · 全片恒定】' + t : '';
}
function evergreenJoin(cfg, prompt) {
  const eg = evergreenText(cfg);
  const base = String(prompt || '').trim();
  if (!eg) return base;
  return base ? base + '\n' + eg : eg;
}

// ---------- 出站提示词终审：≤9999 字符硬顶 + 中文化解释层 ----------
const PROMPT_MAX_CHARS = 9999;
// 超限时按低优先级整行剔除的注入块（都为单行块）；仍超限再硬截
const PROMPT_TRIM_ORDER = ['【运动质量】', '【画面运动】', '【表演指导】', '【动画帧率指令】', '【常青锚点'];
function trimPromptToCap(text) {
  let t = String(text || '');
  for (const tag of PROMPT_TRIM_ORDER) {
    if (t.length <= PROMPT_MAX_CHARS) return t;
    t = t.split('\n').filter((line) => !line.startsWith(tag)).join('\n');
  }
  return t.length > PROMPT_MAX_CHARS ? t.slice(0, PROMPT_MAX_CHARS) : t;
}
function hasSubstantialEnglish(t) {
  const letters = (String(t).match(/[A-Za-z]/g) || []).length;
  return letters > 80 && letters / Math.max(1, String(t).length) > 0.12;
}
const PROMPT_INTERPRETER_SYS =
  '你是视频生成提示词的翻译器。把用户给出的提示词完整翻译成中文，逐块保留原有结构：' +
  '【】标签、镜头编号、时间戳 [x.xs–y.ys]、@引用、「参考图N」等一律原样保留；' +
  '专业电影英文术语（HARD CUT、whip pan、smear、moving hold、sakuga 等）保留英文。' +
  '不增删内容、不解释、不加前后缀，只输出翻译后的提示词全文。';
/** 出站前终审：中文化默认关闭（cfg.translatePrompts=true 才启用，保留原文不 lose context），
 *  9999 字符硬顶永远执行 */
async function finalizePrompt(cfg, text) {
  let t = String(text || '');
  if (cfg.translatePrompts === true && hasSubstantialEnglish(t)) {
    try {
      const provider = cfg.llmProvider
        || (cfg.anthropicKey ? 'anthropic' : (cfg.apiKey ? 'ark' : (cfg.openaiKey ? 'openai' : '')));
      if (provider) {
        const out = await llmComplete(cfg, provider, [{ role: 'user', content: t }], PROMPT_INTERPRETER_SYS);
        const cleaned = String(out || '').trim();
        if (cleaned.length > 20) t = cleaned;
      }
    } catch (e) {
      console.warn('提示词中文化跳过（不拦截生成）:', String(e.message || e).slice(0, 140));
    }
  }
  return trimPromptToCap(t);
}

/** 全局 provider 决策：优先 Artcraft（用户显式选择且已配 key） */
function useArtcraftFirst(cfg) {
  return cfg.preferredProvider === 'artcraft' && !!cfg.artcraftKey;
}
/** 全局模型档位（顶栏 2.0/2.5）→ Artcraft Omni 模型名 */
function artcraftModelOf(cfg) {
  return isSeedance25(cfg.model) ? 'seedance_2p5' : 'seedance_2p0';
}

/** Omni API 统一视频生成（官方 API 文档 storyteller-docs.netlify.app）：
 *  一个端点驱动全部 44 个模型（seedance_2p5 / kling_3p0 / veo_3p1 / sora_2 …） */
function artcraftOmniAspectOf(cfg) {
  const r = String(cfg.ratio || '');
  if (/9:16|portrait/i.test(r)) return 'tall_nine_by_sixteen';
  if (/1:1|square/i.test(r)) return 'square';
  if (/4:3/.test(r)) return 'wide_four_by_three';
  if (/adaptive|auto/i.test(r)) return 'auto';
  return 'wide_sixteen_by_nine';
}
async function artcraftOmniGenerate(cfg, opts) {
  const { model, prompt, startToken, endToken, refTokens, refVideoTokens, refAudioTokens, duration, generateAudio } = opts;
  const body = {
    idempotency_token: crypto.randomUUID(),
    model,
    prompt: String(prompt || '') || undefined,
    start_frame_image_media_token: startToken || undefined,
    end_frame_image_media_token: endToken || undefined,
    reference_image_media_tokens: refTokens && refTokens.length ? refTokens : undefined,
    reference_video_media_tokens: refVideoTokens && refVideoTokens.length ? refVideoTokens : undefined,
    reference_audio_media_tokens: refAudioTokens && refAudioTokens.length ? refAudioTokens : undefined,
    aspect_ratio: artcraftOmniAspectOf(cfg),
    resolution: artcraftResolutionOf(cfg),
    duration_seconds: Math.max(1, Math.round(Number(duration) || 5)),
    generate_audio: typeof generateAudio === 'boolean' ? generateAudio : undefined,
  };
  // 免费预检：cost 端点验证请求形状（实测 omni_api 500 时 omni_gen 家族仍健康）
  try {
    const pre = await fetch(ARTCRAFT_API + '/v1/omni_gen/cost/video', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.artcraftKey },
      body: JSON.stringify(body),
    });
    const pj = await pre.json().catch(() => ({}));
    if (!pre.ok) {
      throw new Error(`Artcraft 预检失败 (${pre.status})，请求本身有问题: ` + JSON.stringify(pj).slice(0, 240));
    }
    if (pj && pj.cost_in_credits) opts.estCredits = pj.cost_in_credits;
  } catch (e) {
    if (/预检失败/.test(String(e.message || e))) throw e; // 明确的请求问题直接拦下
    // 网络抖动等：跳过预检继续生成
  }
  // 主通道 omni_gen（与 cost 同族，实测稳定）→ 5xx 重试 → 最后回退老 omni_api 一次
  const endpoints = ['/v1/omni_gen/generate/video', '/v1/omni_gen/generate/video', '/v1/omni_api/generate/video'];
  let lastErr;
  for (let attempt = 0; attempt < endpoints.length; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1500 * attempt));
    body.idempotency_token = crypto.randomUUID(); // 重试必须换 token，否则撞幂等
    const r = await fetch(ARTCRAFT_API + endpoints[attempt], {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.artcraftKey },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.inference_job_token) return j.inference_job_token;
    lastErr = new Error(`Artcraft 创建生成任务失败 (${r.status}): ` + JSON.stringify(j).slice(0, 300));
    if (r.status < 500) break; // 4xx 是请求本身的问题，重试无意义
  }
  throw lastErr;
}

/** Omni API 单任务状态查询；成功即下载 cdn 视频到本地 */
async function artcraftPoll(cfg, task, localId) {
  if (task.remoteUrl) return arkDownload(task, task.remoteUrl, localId);
  const r = await fetch(ARTCRAFT_API + '/v1/omni_api/job_status/job/' + encodeURIComponent(task.acJobToken), {
    headers: { Authorization: 'Bearer ' + cfg.artcraftKey },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Artcraft 任务查询失败 (${r.status}): ` + JSON.stringify(j).slice(0, 200));
  const st = j.state || {};
  const status = st.status && st.status.status;
  if (status === 'complete_success') {
    const cdn = st.maybe_result && st.maybe_result.media_links && st.maybe_result.media_links.cdn_url;
    if (!cdn) throw new Error('任务成功但未返回 cdn_url');
    task.remoteUrl = cdn;
    await arkDownload(task, cdn, localId);
  } else if (status === 'complete_failure' || status === 'dead' || String(status).startsWith('cancelled')) {
    task.status = 'failed';
    const cat = st.status && st.status.maybe_failure_category;
    task.error = 'Artcraft 生成失败: ' + (cat || status);
  } else {
    // pending / started / attempt_failed（会自动重试）→ 保持 running，带进度
    const pct = st.status && st.status.progress_percentage;
    if (Number.isFinite(pct)) task.warning = `Artcraft 生成中 ${pct}%`;
  }
}

// ---------- 导演生成：首尾帧 + 参考视频 + 参考图混合单次生成（Seedance 2.0 / 2.5） ----------
const SEEDANCE_25_MODEL = 'doubao-seedance-2-5-260628'; // 方舟模型卡已公开；API 开放即插即用
function isSeedance25(model) { return /2-5|2p5/.test(String(model || '')); }
function clampDurationFor(model, d) {
  return isSeedance25(model) ? clampDuration(d, 5, 4, 30) : clampDuration(d);
}

async function arkCreateDirector(cfg, opts) {
  const { firstDataUrl, lastDataUrl, refVideoPublicUrl, refDataUrls = [], text, duration, model } = opts;
  const safeText = sanitizeForArk(text);
  const content = [{ type: 'text', text: safeText }];
  if (firstDataUrl) content.push({ type: 'image_url', image_url: { url: firstDataUrl }, role: 'first_frame' });
  if (lastDataUrl) content.push({ type: 'image_url', image_url: { url: lastDataUrl }, role: 'last_frame' });
  if (refVideoPublicUrl) content.push({ type: 'video_url', video_url: { url: refVideoPublicUrl }, role: 'reference_video' });
  for (const r of refDataUrls) content.push({ type: 'image_url', image_url: { url: r }, role: 'reference_image' });
  const useModel = model || cfg.model;
  // 2.5 仅支持 480P/720P —— 1080p 配置自动降档
  let resolution = cfg.resolution;
  if (isSeedance25(useModel) && /1080/.test(String(resolution))) resolution = '720p';
  const body = {
    model: useModel,
    content,
    duration: clampDurationFor(useModel, duration),
    resolution,
    ratio: cfg.ratio,
    watermark: false,
  };
  const res = await fetch(cfg.endpoint + '/contents/generations/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw arkErrorWithPreview('创建导演生成任务失败', res.status, json, safeText);
  if (!json.id) throw new Error('Ark 响应缺少任务 id');
  return json.id;
}

// ---------- 一体生成：全部关键帧 → 单次连续动画 ----------
function wholePromptFor(n, gaps) {
  let text = `共有 ${n} 张参考图片。图片1到图片${n}是同一段动画按时间顺序排列的关键帧原画：` +
    `动画从图片1的姿势开始，最终到达图片${n}的姿势。整段视频是一次单独的完整生成：` +
    `一镜到底，不切镜头，不淡入淡出，角色和场景全程保持同一个。`;
  text += `\n极其重要——这不是幻灯片轮播：任何时刻画面都必须处于连续的运动之中，` +
    `严禁把任何一张关键帧当作静止画面停留展示后再切到下一张。每个时间段内，` +
    `角色必须以完整、连贯、充满中间过程的运动，从上一张关键帧的姿势自然演变到下一张关键帧的姿势，` +
    `运动铺满整个时间段——关键帧的姿势只是运动轨迹中被经过的瞬间，不是停顿点。` +
    `所有运动必须物理正确、可信：重心转移、动量惯性、跟随与重叠动作（follow-through）都要连贯合理，` +
    `肢体运动有正确的加速与减速，禁止瞬移、跳变或不合理的形变。`;
  if (Array.isArray(gaps) && gaps.length === n - 1 && gaps.every((g) => Number(g && g.seconds) > 0)) {
    const total = gaps.reduce((a, g) => a + Number(g.seconds), 0);
    let t = 0;
    const lines = gaps.map((g, i) => {
      const dur = Number(g.seconds);
      const start = t.toFixed(1);
      t += dur;
      let line = `第${i + 1}段 第${start}秒→第${t.toFixed(1)}秒（图片${i + 1}→图片${i + 2}，约${Math.round(dur * 24)}张中间帧）：` +
        `全程连续运动，从图片${i + 1}的姿势经过完整的动作过程演变到图片${i + 2}的姿势`;
      if (g.prompt && String(g.prompt).trim()) line += `。本段动作内容：${String(g.prompt).trim()}`;
      if (g.actingText && String(g.actingText).trim()) line += `。本段演技：${String(g.actingText).trim()}`;
      return line;
    });
    text += `\n时间表（总时长约${total.toFixed(1)}秒）：\n` + lines.join('；\n') +
      `。\n每张关键帧的姿势在对应时间点被运动经过；段内时长越长，动作越舒展、中间过程越丰富；` +
      `时长越短，动作越快越紧凑。画面在任何一帧都不允许静止。`;
  }
  return text;
}

async function arkCreateWhole(cfg, imageDataUrls, text, duration, refDataUrls = []) {
  const safeText = sanitizeForArk(text);
  const content = [{ type: 'text', text: safeText }];
  // 关键帧在前、附加参考图在后 —— 与提示词里的「图片N+K」编号约定一致
  for (const img of imageDataUrls.concat(refDataUrls)) {
    content.push({ type: 'image_url', image_url: { url: img }, role: 'reference_image' });
  }
  const body = {
    model: cfg.model,
    content,
    duration: clampDurationFor(cfg.model, duration),
    resolution: cfg.resolution,
    ratio: cfg.ratio,
    watermark: false,
  };
  const res = await fetch(cfg.endpoint + '/contents/generations/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw arkErrorWithPreview('创建一体生成任务失败', res.status, json, safeText);
  if (!json.id) throw new Error('Ark 响应缺少任务 id');
  return json.id;
}

// 本地模拟：所有关键帧顺序交叉溶解成一段
async function mockWhole(id, imageFiles, duration) {
  const D = clampDuration(duration);
  const per = D / Math.max(1, imageFiles.length - 1);
  const fit = 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:white,setsar=1';
  const parts = [];
  try {
    for (let i = 0; i < imageFiles.length - 1; i++) {
      const part = path.join(TMP_DIR, `${id}_p${i}.mp4`);
      await runFfmpeg([
        '-y', '-loop', '1', '-t', String(per), '-i', imageFiles[i],
        '-loop', '1', '-t', String(per), '-i', imageFiles[i + 1],
        '-filter_complex', `[0:v]${fit}[va];[1:v]${fit}[vb];[va][vb]xfade=transition=fade:duration=${per}:offset=0,format=yuv420p`,
        '-r', '24', '-c:v', 'libx264', '-preset', 'fast', part,
      ]);
      parts.push(part);
    }
    const out = path.join(VIDEO_DIR, id + '.mp4');
    const args = ['-y'];
    for (const p of parts) args.push('-i', p);
    const chains = parts.map((_, i) => `[${i}:v]`).join('');
    args.push('-filter_complex', `${chains}concat=n=${parts.length}:v=1:a=0,format=yuv420p`,
      '-c:v', 'libx264', '-preset', 'fast', out);
    await runFfmpeg(args);
    tasks[id] = { ...tasks[id], status: 'succeeded', videoUrl: '/videos/' + id + '.mp4' };
  } catch (e) {
    tasks[id] = { ...tasks[id], status: 'failed', error: String(e.message || e) };
  } finally {
    for (const p of parts) fs.rm(p, { force: true }, () => {});
  }
}

// ---------- V2V：Seedance 参考视频转绘 ----------
async function arkCreateV2V(cfg, publicVideoUrl, refDataUrls, text, duration) {
  const safeText = sanitizeForArk(text);
  const content = [{ type: 'text', text: safeText }];
  content.push({ type: 'video_url', video_url: { url: publicVideoUrl }, role: 'reference_video' });
  for (const ref of refDataUrls) {
    content.push({ type: 'image_url', image_url: { url: ref }, role: 'reference_image' });
  }
  const body = {
    model: cfg.v2vModel || cfg.model,
    content,
    duration: clampDurationFor(cfg.v2vModel || cfg.model, duration),
    resolution: cfg.resolution,
    ratio: 'adaptive',
    watermark: false,
  };
  const res = await fetch(cfg.endpoint + '/contents/generations/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw arkErrorWithPreview('创建 V2V 任务失败', res.status, json, safeText);
  if (!json.id) throw new Error('Ark 响应缺少任务 id');
  return json.id;
}

// 自检公网地址可下载（顺便预热刚建立的 Cloudflare 隧道边缘路由——上线可能要 10~40s）
async function waitPublicReachable(url, tries = 25, delayMs = 2000) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { Range: 'bytes=0-0' } });
      if (r.body) { try { await r.arrayBuffer(); } catch {} }
      if (r.ok || r.status === 206) return;
    } catch {}
    await new Promise((res) => setTimeout(res, delayMs));
  }
  throw new Error('参考视频公网地址自检失败（隧道未生效）：请稍后重试，或在设置里配置可用的 publicBase');
}

// Ark 回源下载偶发失败（隧道边缘路由刚生效/网络抖动）→ 自动重试
async function arkCreateV2VWithRetry(cfg, publicUrl, refDataUrls, text, duration, attempts = 3) {
  for (let i = 0; ; i++) {
    try {
      return await arkCreateV2V(cfg, publicUrl, refDataUrls, text, duration);
    } catch (e) {
      const msg = String(e.message || e);
      if (i >= attempts - 1 || !/resource download failed/i.test(msg)) throw e;
      console.warn(`V2V 回源下载失败，${3 * (i + 1)}s 后重试 (${i + 1}/${attempts - 1}):`, msg.slice(0, 160));
      await new Promise((res) => setTimeout(res, 3000 * (i + 1)));
    }
  }
}

// ---------- HTTP ----------
const app = express();
app.use(express.json({
  limit: '300mb',
  verify: (req, _res, buf) => { if (req.originalUrl === '/api/pay/webhook') req.rawBody = buf; },
}));

// ---------------- 📱 手机遥控：cloudflared 隧道（指向 5893 全应用）+ 轮换访问令牌门 ----------------
// 与 5894 文件隧道互不相干。门在 static 之前 = 覆盖一切请求；本机访问零影响。
// 令牌语义：这条链接 = 你电脑上这套应用的完整控制权（含文件浏览/密钥使用），只给自己的手机，绝不转发。
const remoteCtl = { proc: null, url: '', token: '' };
function isRemoteReq(req) {
  const host = String(req.headers.host || '').toLowerCase();
  return host.endsWith('.trycloudflare.com') || !!req.headers['cf-ray'];
}
function remoteCookie(req) {
  const m = /(?:^|;\s*)a452r=([^;]+)/.exec(String(req.headers.cookie || ''));
  return m ? decodeURIComponent(m[1]) : '';
}
app.use((req, res, next) => {
  if (!isRemoteReq(req)) return next();
  if (!remoteCtl.token) return res.status(403).send('<h3 style="font-family:sans-serif">📱 远程访问未开启</h3>');
  const q = req.query ? req.query.key : '';
  if (q) {
    if (q === remoteCtl.token) {
      res.setHeader('Set-Cookie', 'a452r=' + remoteCtl.token + '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400');
      return res.redirect('/');
    }
    return res.status(403).send('<h3 style="font-family:sans-serif">令牌不对 — 用电脑上最新的二维码/链接重新打开</h3>');
  }
  if (remoteCookie(req) === remoteCtl.token) return next();
  return res.status(403).send('<h3 style="font-family:sans-serif">需要访问令牌 — 在电脑上点 📱 扫最新二维码打开</h3>');
});

app.use(express.static(path.join(ROOT, 'public')));
app.use('/videos', express.static(VIDEO_DIR));
app.use('/assets', express.static(ASSET_DIR));

// ---------------- CORS：仅项目注册表端点，且仅放行本机规划器源 ----------------
// 只作用于 /api/projects*（config、生成等敏感端点保持同源），并把来源限制为
// 本机 planner，避免任意网页跨域驱动本地 API 或读取 API Key。
const CORS_ALLOW = new Set([
  'http://localhost:3452', 'http://127.0.0.1:3452',
  'http://localhost:3453', 'http://127.0.0.1:3453', // planner dev fallback port
]);
app.use(['/api/projects', '/api/style-json', '/api/script', '/api/style', '/api/prompt-library'], (req, res, next) => {
  const origin = req.headers.origin;
  if (origin && CORS_ALLOW.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// 公开站模式（A452_PUBLIC=1）：登录、积分、每用户工程、支付。桌面模式下为 null。
const pm = require(path.join(__dirname, 'public-mode.js')).install(app, { DATA_DIR, readProjectFile, writeProjectFile });

// 只读文件服务（隧道只暴露这个端口，不暴露 API）
const filesApp = express();
filesApp.use('/videos', express.static(VIDEO_DIR));
filesApp.use('/assets', express.static(ASSET_DIR));
// 只绑回环：cloudflared 隧道走 127.0.0.1 回源，绑 0.0.0.0 只会招来 Windows 防火墙的管理员弹窗
filesApp.listen(FILES_PORT, '127.0.0.1').on('error', (e) => {
  console.warn('只读文件端口未启动（可能已有实例在跑）:', e.code);
});

// ---------- 资源上传 / 工程持久化 ----------
app.post('/api/upload', (req, res) => {
  try {
    const { dataUrl, name } = req.body || {};
    const m = /^data:(image|video|audio)\/([\w.+-]+);base64,(.+)$/s.exec(dataUrl || '');
    if (!m) return res.status(400).json({ error: '仅支持 base64 图片、视频或音频' });
    const extMap = { jpeg: 'jpg', quicktime: 'mov', 'x-matroska': 'mkv', mpeg: 'mp3', 'x-wav': 'wav', 'x-m4a': 'm4a' };
    const ext = extMap[m[2]] || m[2];
    const file = newId() + '.' + ext;
    fs.writeFileSync(path.join(ASSET_DIR, file), Buffer.from(m[3], 'base64'));
    res.json({ url: '/assets/' + file, name: name || file });
  } catch (e) {
    // 磁盘满 / 权限 / 路径异常：给出人能读懂的原因，绝不让前端拿到空错误
    const raw = String(e && e.message || e);
    const hint = /ENOSPC/.test(raw) ? '磁盘空间不足'
      : /EACCES|EPERM/.test(raw) ? '没有写入权限'
      : /ENOENT/.test(raw) ? '存储目录不存在' : '';
    res.status(500).json({ error: `保存文件失败${hint ? '（' + hint + '）' : ''}: ${raw.slice(0, 160)}` });
  }
});

// ---------- 应用内媒体浏览器 ----------
// Electron/Chromium 的原生打开文件对话框在 Windows 上不渲染缩略图（Chromium 沙箱化对话框的
// 已知缺陷），所以应用内自带一个有真缩略图的文件选择器。仅本机 API 端口可用，隧道不暴露。
const THUMB_DIR = path.join(DATA_DIR, 'thumbcache');
fs.mkdirSync(THUMB_DIR, { recursive: true });

const MEDIA_EXTS = {
  image: new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'avif', 'jfif', 'heic', 'heif', 'ico']),
  video: new Set(['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'mpg', 'mpeg', 'wmv', 'ts', 'm2ts', 'mts', '3gp', 'ogv', 'vob', 'flv', 'f4v', 'asf', 'rm', 'rmvb', 'divx', 'mxf']),
  audio: new Set(['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wma', 'aiff', 'aif', 'mka', 'weba', 'oga', 'mp2', 'ac3', 'amr', 'caf', 'ape']),
};
function mediaKindOf(name) {
  const ext = path.extname(name).slice(1).toLowerCase();
  for (const [kind, set] of Object.entries(MEDIA_EXTS)) if (set.has(ext)) return kind;
  return null;
}
const HIDDEN_DIRS = new Set(['$recycle.bin', 'system volume information', 'node_modules', '$windows.~bt']);

// 跨平台打开文件夹：win=explorer / mac=open / linux=xdg-open（打开器退出码不可靠，一律即发即忘）
function openFolderNative(dir) {
  const opener = process.platform === 'win32' ? 'explorer' : (process.platform === 'darwin' ? 'open' : 'xdg-open');
  try { spawn(opener, [dir], { detached: true, stdio: 'ignore' }).unref(); } catch {}
}

app.get('/api/fs/roots', (req, res) => {
  const roots = [];
  if (process.platform === 'win32') {
    for (let c = 65; c <= 90; c++) {
      const drive = String.fromCharCode(c) + ':\\';
      try { if (fs.existsSync(drive)) roots.push({ name: drive.slice(0, 2), path: drive }); } catch {}
    }
  } else {
    roots.push({ name: '/', path: '/' });
  }
  const home = os.homedir();
  const quick = [];
  for (const [label, sub] of [['🏠 主目录', ''], ['🖥 桌面', 'Desktop'], ['⬇ 下载', 'Downloads'],
    ['🖼 图片', 'Pictures'], ['🎬 视频', 'Videos'], ['🎵 音乐', 'Music'], ['📄 文档', 'Documents']]) {
    const p = sub ? path.join(home, sub) : home;
    try { if (fs.existsSync(p)) quick.push({ name: label, path: p }); } catch {}
  }
  res.json({ roots, quick });
});

app.get('/api/fs/list', (req, res) => {
  try {
    const dir = String(req.query.dir || '');
    if (!path.isAbsolute(dir)) return res.status(400).json({ error: '需要绝对路径' });
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const dirs = [];
    const files = [];
    for (const ent of entries) {
      const name = ent.name;
      if (name.startsWith('.') || HIDDEN_DIRS.has(name.toLowerCase())) continue;
      const full = path.join(dir, name);
      if (ent.isDirectory()) { dirs.push({ name, path: full }); continue; }
      if (!ent.isFile()) continue;
      const kind = mediaKindOf(name);
      if (!kind) continue;
      try {
        const st = fs.statSync(full);
        files.push({ name, path: full, size: st.size, mtime: st.mtimeMs, kind });
      } catch {}
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    files.sort((a, b) => b.mtime - a.mtime);
    const parent = path.dirname(dir);
    res.json({ dir, parent: parent !== dir ? parent : null, dirs, files: files.slice(0, 800), truncated: files.length > 800 });
  } catch (e) {
    const raw = String(e && e.message || e);
    res.status(400).json({ error: /EPERM|EACCES/.test(raw) ? '没有权限访问该目录' : /ENOENT/.test(raw) ? '目录不存在' : raw.slice(0, 200) });
  }
});

// 缩略图：图片直接缩放，视频抽第 1 秒的帧；按 路径+mtime+size 缓存，源文件变了缓存自动失效。
// 打包环境（Electron）里 ffmpeg 子进程可能不可用/受限 → 图片一律有兜底：直接回传原图，
// 本机传输零延迟，浏览器自行缩放显示，预览绝不白屏。
// ffmpeg 并发队列：一次浏览 800 文件的目录会瞬间打出几百个缩略图请求，
// 无限并发 spawn 会把服务端打进坏状态（实测），所以同一时刻最多跑 3 个。
let thumbActive = 0;
const thumbWaiters = [];
async function thumbSlot() {
  if (thumbActive >= 3) await new Promise((r) => thumbWaiters.push(r));
  thumbActive += 1;
}
function thumbRelease() {
  thumbActive -= 1;
  const next = thumbWaiters.shift();
  if (next) next();
}

const THUMB_ORIGINAL_MAX = 40 * 1024 * 1024; // 兜底直传原图的大小上限
let ffmpegBroken = false; // 熔断：spawn 层面失败（ENOENT/EACCES 等）后不再反复尝试

async function serveThumbFile(res, file, kind) {
  let held = false;
  try {
    const st = fs.statSync(file);
    // |tv2：视频抽帧算法升级（代表帧替代 -ss 1，黑场淡入不再出全黑缩略图）→ 旧缓存自动失效重抽
    const key = crypto.createHash('sha1').update(file + '|' + st.mtimeMs + '|' + st.size + (kind === 'video' ? '|tv2' : '')).digest('hex');
    const cached = path.join(THUMB_DIR, key + '.jpg');
    const sendOriginalImage = () => {
      // 图片兜底：原图直传（跳过 ffmpeg），Content-Type 按扩展名
      const ext = path.extname(file).slice(1).toLowerCase();
      res.setHeader('Cache-Control', 'private, max-age=86400');
      res.setHeader('Content-Type', MIME[ext] || 'image/' + ext);
      fs.createReadStream(file).on('error', () => res.status(404).end()).pipe(res);
    };
    if (!fs.existsSync(cached)) {
      if (kind === 'image' && (!FFMPEG || ffmpegBroken || st.size <= 300 * 1024)) {
        // 小图或 ffmpeg 不可用：直接原图，反而更快
        if (st.size <= THUMB_ORIGINAL_MAX) return sendOriginalImage();
        return res.status(404).end();
      }
      if (!FFMPEG || ffmpegBroken) return res.status(404).end();
      await thumbSlot();
      held = true;
      const scale = "scale='min(360,iw)':-2";
      // 视频：thumbnail 滤镜在前 90 帧里选「最有代表性」的一帧 —— 从黑场淡入的素材不再抽出全黑图
      const args = kind === 'video'
        ? ['-y', '-i', file, '-vf', `thumbnail=90,${scale}`, '-frames:v', '1', '-q:v', '5', cached]
        : ['-y', '-i', file, '-frames:v', '1', '-vf', scale, '-q:v', '5', cached];
      try {
        await runFfmpeg(args);
      } catch (e) {
        // thumbnail 滤镜失败（极短/异常封装）→ 退回纯首帧
        try {
          if (kind === 'video') await runFfmpeg(['-y', '-i', file, '-frames:v', '1', '-vf', scale, '-q:v', '5', cached]);
          else throw e;
        } catch (e2) {
          thumbRelease();
          held = false;
          // spawn 层面失败（不是转码失败）→ 熔断，后续请求不再尝试 ffmpeg
          if (/ENOENT|EACCES|EPERM|spawn/i.test(String(e2 && e2.message || e2))) ffmpegBroken = true;
          // ffmpeg 挂了：图片仍然给原图，视频只能交给前端图标兜底
          if (kind === 'image' && st.size <= THUMB_ORIGINAL_MAX) return sendOriginalImage();
          return res.status(404).end();
        }
      }
      thumbRelease();
      held = false;
    }
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.sendFile(cached);
  } catch {
    if (held) thumbRelease();
    res.status(404).end();
  }
}

app.get('/api/fs/thumb', async (req, res) => {
  const file = String(req.query.path || '');
  const kind = mediaKindOf(file);
  if (!path.isAbsolute(file) || !kind || kind === 'audio' || !fs.existsSync(file)) return res.status(404).end();
  serveThumbFile(res, file, kind);
});

// 生成结果 / 参考素材的缩略图：把已挂载的 /videos /assets URL 反解回本地文件，
// 复用同一套 ffmpeg 抽帧 + 磁盘缓存。前端历史卡从此只加载一张 JPEG，
// 不再为每张卡常驻一个 <video> 解码器（那是页面卡顿的根源）。
app.get('/api/media/thumb', (req, res) => {
  try {
    const src = String(req.query.src || '').split('?')[0];
    let file = null;
    if (src.startsWith('/videos/')) file = path.join(VIDEO_DIR, decodeURIComponent(src.slice('/videos/'.length)));
    else if (src.startsWith('/assets/')) file = path.join(ASSET_DIR, decodeURIComponent(src.slice('/assets/'.length)));
    if (!file) return res.status(404).end();
    file = path.normalize(file);
    if (!(file.startsWith(VIDEO_DIR + path.sep) || file.startsWith(ASSET_DIR + path.sep))) return res.status(404).end();
    const kind = mediaKindOf(file);
    if (!kind || kind === 'audio' || !fs.existsSync(file)) return res.status(404).end();
    serveThumbFile(res, file, kind);
  } catch { res.status(404).end(); }
});

// 诊断：打包环境里 ffmpeg 到底能不能 spawn（排查缩略图问题用）
app.get('/api/fs/diag', (req, res) => {
  let spawnStatus = null, spawnError = null;
  try {
    const probe = spawnSync(FFMPEG || 'ffmpeg', ['-version'], { timeout: 5000 });
    spawnStatus = probe.status;
    spawnError = probe.error ? String(probe.error.message || probe.error) : null;
  } catch (e) { spawnError = String(e && e.message || e); }
  res.json({ ffmpegPath: FFMPEG, spawnStatus, spawnError, thumbActive, queued: thumbWaiters.length });
});

// 原始媒体文件直读（原生对话框选中的路径 → 前端取回 blob 喂给现有上传管线）
app.get('/api/fs/file', (req, res) => {
  try {
    const file = String(req.query.path || '');
    const kind = mediaKindOf(file);
    if (!path.isAbsolute(file) || !kind || !fs.existsSync(file)) return res.status(404).end();
    const ext = path.extname(file).slice(1).toLowerCase();
    res.setHeader('Content-Type', MIME[ext] || `${kind}/${ext}`);
    fs.createReadStream(file).on('error', () => { try { res.status(404).end(); } catch {} }).pipe(res);
  } catch {
    res.status(404).end();
  }
});

// 选中的文件导入资产库（服务器直接拷文件，不经过 base64，任意大小都稳）
app.post('/api/fs/import', (req, res) => {
  try {
    const paths = Array.isArray(req.body && req.body.paths) ? req.body.paths.slice(0, 60) : [];
    const items = [];
    for (const p of paths) {
      if (typeof p !== 'string' || !path.isAbsolute(p)) continue;
      const kind = mediaKindOf(p);
      if (!kind || !fs.existsSync(p)) continue;
      const file = newId() + path.extname(p).toLowerCase();
      fs.copyFileSync(p, path.join(ASSET_DIR, file));
      items.push({ url: '/assets/' + file, name: path.basename(p), kind });
    }
    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: "导入失败: " + String(e && e.message || e).slice(0, 200) });
  }
});

app.get('/api/project', (req, res) => {
  const r = readProjectFile(PROJECT_PATH);
  if (!r.ok) {
    return res.status(500).json({
      corrupt: true,
      error: 'project.json 已损坏且无可用备份（原件已保存为 project.json.corrupt-*），请检查数据目录后再保存',
    });
  }
  if (r.restored && r.data && typeof r.data === 'object') r.data.restoredFromBackup = true;
  res.json(r.data);
});

app.post('/api/project', (req, res) => {
  try {
    writeProjectFile(PROJECT_PATH, req.body || {});
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get('/api/config', (req, res) => {
  const cfg = loadConfig();
  res.json({
    hasKey: !!cfg.apiKey,
    endpoint: cfg.endpoint,
    model: cfg.model,
    v2vModel: cfg.v2vModel,
    resolution: cfg.resolution,
    ratio: cfg.ratio,
    stylePrompt: cfg.stylePrompt,
    inbetweenPrompt: cfg.inbetweenPrompt,
    colorPrompt: cfg.colorPrompt,
    refinePrompt: cfg.refinePrompt,
    evergreen: cfg.evergreen || '',
    translatePrompts: cfg.translatePrompts === true,
    imgModel: cfg.imgModel,
    imgProvider: cfg.imgProvider,
    openaiBase: cfg.openaiBase,
    hasOpenaiKey: !!cfg.openaiKey,
    openaiImgModel: cfg.openaiImgModel,
    llmProvider: cfg.llmProvider || 'auto',
    hasAnthropicKey: !!cfg.anthropicKey,
    hasArtcraftKey: !!cfg.artcraftKey,
    preferredProvider: cfg.preferredProvider || 'ark',
    llmModel: cfg.llmModel || '',
    llmSpendUsd: getLlmSpend().usd,
    llmSpendCap: getLlmSpend().capUsd,
    presets: cfg.presets || [],
    promptFolders: cfg.promptFolders || [],
    usedPrompts: cfg.usedPrompts || [],
    publicBase: cfg.publicBase,
    tunnel: !!findCloudflared(),
    ffmpeg: !!FFMPEG,
    appVersion: APP_VERSION,
  });
});

app.post('/api/config', (req, res) => {
  const cur = loadConfig();
  const { apiKey, endpoint, model, v2vModel, imgModel, resolution, ratio, stylePrompt, inbetweenPrompt, colorPrompt, refinePrompt, presets, publicBase } = req.body || {};
  if (stylePrompt !== undefined) cur.stylePrompt = stylePrompt;
  if (inbetweenPrompt !== undefined) cur.inbetweenPrompt = inbetweenPrompt;
  if (colorPrompt !== undefined) cur.colorPrompt = colorPrompt;
  if (refinePrompt !== undefined) cur.refinePrompt = refinePrompt;
  if (req.body && req.body.evergreen !== undefined) cur.evergreen = String(req.body.evergreen || '');
  if (req.body && req.body.translatePrompts !== undefined) cur.translatePrompts = req.body.translatePrompts === true;
  if (Array.isArray(presets)) cur.presets = presets;
  if (Array.isArray(req.body && req.body.promptFolders)) cur.promptFolders = req.body.promptFolders;
  if (publicBase !== undefined) cur.publicBase = publicBase;
  if (v2vModel) cur.v2vModel = v2vModel;
  if (imgModel) cur.imgModel = imgModel;
  const { imgProvider, openaiBase, openaiKey, openaiImgModel } = req.body || {};
  if (imgProvider) cur.imgProvider = imgProvider;
  if (openaiBase !== undefined && openaiBase !== '') cur.openaiBase = openaiBase.replace(/\/+$/, '');
  if (openaiKey !== undefined && openaiKey !== '') cur.openaiKey = openaiKey;
  if (openaiKey === null) cur.openaiKey = '';
  if (openaiImgModel) cur.openaiImgModel = openaiImgModel;
  if (apiKey !== undefined && apiKey !== '') cur.apiKey = apiKey;
  if (apiKey === null) cur.apiKey = '';
  if (endpoint) cur.endpoint = endpoint.replace(/\/+$/, '');
  if (model) cur.model = model;
  if (resolution) cur.resolution = resolution;
  if (ratio) cur.ratio = ratio;
  const { llmProvider, anthropicKey, llmModel, llmSpendReset, llmSpendCap } = req.body || {};
  if (llmProvider) cur.llmProvider = llmProvider;
  if (anthropicKey !== undefined && anthropicKey !== '') cur.anthropicKey = anthropicKey;
  if (anthropicKey === null) cur.anthropicKey = '';
  const { artcraftKey } = req.body || {};
  if (artcraftKey !== undefined && artcraftKey !== '') cur.artcraftKey = artcraftKey;
  if (artcraftKey === null) cur.artcraftKey = '';
  const { preferredProvider } = req.body || {};
  if (preferredProvider === 'artcraft' || preferredProvider === 'ark') cur.preferredProvider = preferredProvider;
  if (llmModel !== undefined) cur.llmModel = llmModel;
  const { hermesBase, hermesModel } = req.body || {};
  if (hermesBase !== undefined && hermesBase !== '') cur.hermesBase = String(hermesBase).replace(/\/+$/, '');
  if (hermesModel !== undefined) cur.hermesModel = hermesModel;
  // 用量重置：仅在用户确认已充值后调用（新的 $20 周期）
  if (llmSpendReset === true) {
    const s = cur.llmSpend && typeof cur.llmSpend === 'object' ? cur.llmSpend : {};
    cur.llmSpend = { usd: 0, capUsd: Number(s.capUsd) > 0 ? Number(s.capUsd) : 20 };
    pendingClaudeCost = 0;
    configCorrupt = false; // 用户显式重置账本 → 解除损坏冻结，允许重建 config.json
  }
  if (Number(llmSpendCap) > 0) {
    const s = cur.llmSpend && typeof cur.llmSpend === 'object' ? cur.llmSpend : {};
    cur.llmSpend = { usd: Number(s.usd) || 0, capUsd: Number(llmSpendCap) };
  }
  // ⚙ 设置里粘贴的 key 自动收编进钥匙串并设为当前生效（同 key 已存在则只激活）
  ensureKeychain(cur); // 注意：它会先把 legacy 字段以「自动收编」名义入列 → 下面把本次粘贴的改成明确 label
  for (const [pf, field] of Object.entries(KEYCHAIN_FIELD)) {
    const v = req.body ? req.body[field] : undefined;
    if (v === undefined || v === '' || v === null) continue;
    let hit = cur.keychain[pf].find((k) => k && k.key === String(v));
    if (!hit) {
      hit = { id: newId(), label: '设置里粘贴 ' + new Date().toISOString().slice(5, 10), key: String(v), addedAt: Date.now(), activatedAt: Date.now() };
      cur.keychain[pf].push(hit);
    } else {
      hit.activatedAt = Date.now();
      if (hit.label === '现有 Key（自动收编）') hit.label = '设置里粘贴 ' + new Date().toISOString().slice(5, 10);
    }
    cur.keychainActive[pf] = hit.id;
  }
  syncKeychainToLegacy(cur);
  saveConfig(cur);
  res.json({ ok: true, hasKey: !!cur.apiKey });
});

// ---------------- 钥匙串端点：列表（掩码）/ 添加 / 切换 / 删除 / 改名 ----------------
app.get('/api/keychain', (req, res) => {
  const cur = loadConfig();
  if (ensureKeychain(cur)) { try { syncKeychainToLegacy(cur); saveConfig(cur); } catch {} }
  const out = {};
  for (const pf of Object.keys(KEYCHAIN_FIELD)) {
    out[pf] = {
      label: KEYCHAIN_LABEL[pf],
      entries: (cur.keychain[pf] || []).map((k) => ({
        id: k.id, label: k.label || '', masked: maskKey(k.key),
        active: cur.keychainActive[pf] === k.id,
        addedAt: k.addedAt || 0, activatedAt: k.activatedAt || 0,
      })),
    };
  }
  res.json({ platforms: out });
});
app.post('/api/keychain/add', (req, res) => {
  try {
    const { platform, label, key, activate } = req.body || {};
    if (!KEYCHAIN_FIELD[platform]) return res.status(400).json({ error: '未知平台' });
    const k = String(key || '').trim();
    if (!k) return res.status(400).json({ error: 'Key 不能为空' });
    const cur = loadConfig();
    ensureKeychain(cur);
    let hit = cur.keychain[platform].find((x) => x && x.key === k);
    if (hit) {
      if (label) hit.label = String(label).slice(0, 40);
    } else {
      hit = { id: newId(), label: String(label || '未命名账号').slice(0, 40), key: k, addedAt: Date.now(), activatedAt: 0 };
      cur.keychain[platform].push(hit);
    }
    if (activate !== false) { cur.keychainActive[platform] = hit.id; hit.activatedAt = Date.now(); }
    syncKeychainToLegacy(cur);
    saveConfig(cur);
    res.json({ ok: true, id: hit.id });
  } catch (e) { res.status(500).json({ error: String(e && e.message || e).slice(0, 200) }); }
});
app.post('/api/keychain/select', (req, res) => {
  try {
    const { platform, id } = req.body || {};
    if (!KEYCHAIN_FIELD[platform]) return res.status(400).json({ error: '未知平台' });
    const cur = loadConfig();
    ensureKeychain(cur);
    const hit = cur.keychain[platform].find((x) => x && x.id === id);
    if (!hit) return res.status(404).json({ error: '找不到该 Key' });
    cur.keychainActive[platform] = id;
    hit.activatedAt = Date.now();
    syncKeychainToLegacy(cur);
    saveConfig(cur);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e && e.message || e).slice(0, 200) }); }
});
app.post('/api/keychain/remove', (req, res) => {
  try {
    const { platform, id } = req.body || {};
    if (!KEYCHAIN_FIELD[platform]) return res.status(400).json({ error: '未知平台' });
    const cur = loadConfig();
    ensureKeychain(cur);
    cur.keychain[platform] = cur.keychain[platform].filter((x) => x && x.id !== id);
    if (cur.keychainActive[platform] === id) {
      cur.keychainActive[platform] = cur.keychain[platform][0] ? cur.keychain[platform][0].id : '';
    }
    syncKeychainToLegacy(cur);
    saveConfig(cur);
    res.json({ ok: true, activeId: cur.keychainActive[platform] || '' });
  } catch (e) { res.status(500).json({ error: String(e && e.message || e).slice(0, 200) }); }
});
app.post('/api/keychain/label', (req, res) => {
  try {
    const { platform, id, label } = req.body || {};
    if (!KEYCHAIN_FIELD[platform]) return res.status(400).json({ error: '未知平台' });
    const cur = loadConfig();
    ensureKeychain(cur);
    const hit = cur.keychain[platform].find((x) => x && x.id === id);
    if (!hit) return res.status(404).json({ error: '找不到该 Key' });
    hit.label = String(label || '').slice(0, 40);
    saveConfig(cur);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e && e.message || e).slice(0, 200) }); }
});

// ---------------- 剧本解析智能体：PDF/文本 → 分场 + 镜头 + 提示词 + 角色/场景地 ----------------
// 内置 LM Agent：优先 Claude（Anthropic），其次 OpenAI 兼容（ChatGPT），再次 Ark（doubao）；
// 全部未配置或调用失败时退化为启发式分场，保证导入永远有结果。
const SCRIPT_AGENT_SYS = [
  'You are the in-house script breakdown agent of Atelier 452, an AI animation director workspace.',
  'You read a raw film / animation script (any language, often extracted from a PDF) and produce a',
  'structured storyboard breakdown as STRICT JSON. Rules:',
  '- Output ONLY a single JSON object. No markdown fences, no commentary.',
  '- Keep all creative text (titles, summaries, prompts, dialogue) in the SAME language as the script.',
  '- Divide the script into scenes at location/time changes (INT./EXT., 第X场, scene headings, blank-line beats).',
  '- For each scene create 2-6 shots covering its key visual beats.',
  '- Every shot MUST include a `prompt`: a vivid one-paragraph text-to-video prompt (subject + action +',
  '  camera + lighting + mood) ready for an AI video model, and `script`: the exact excerpt of the',
  '  original script text this shot covers (dialogue + action lines, verbatim).',
  '- Extract every named character and location into the top-level lists with useful visual descriptions.',
  'JSON schema (all keys required unless marked optional):',
  '{',
  '  "title": string, "logline": string,',
  '  "characters": [{ "name": string, "role": string, "visualDescription": string, "personality": string, "promptFragment": string }],',
  '  "locations":  [{ "name": string, "description": string, "promptFragment": string }],',
  '  "scenes": [{',
  '    "title": string, "summary": string, "location": string,',
  '    "timeOfDay": "dawn"|"morning"|"noon"|"afternoon"|"dusk"|"night"|"unspecified",',
  '    "weather": "clear"|"overcast"|"rain"|"storm"|"snow"|"fog"|"interior"|"unspecified",',
  '    "shots": [{',
  '      "title": string, "description": string, "script": string, "prompt": string,',
  '      "negative": string (optional), "dialogue": string (optional),',
  '      "shotSize": "EWS"|"WS"|"MS"|"MCU"|"CU"|"ECU"|"Insert",',
  '      "cameraMovement": "static"|"dolly in"|"dolly out"|"pan"|"tilt"|"handheld"|"crane"|"tracking",',
  '      "motionDescription": string, "emotion": string,',
  '      "durationSeconds": number (3-8), "characters": [string]',
  '    }]',
  '  }]',
  '}',
].join('\n');

// ---- Claude 用量计费（美元/百万 token；缓存读 0.1×、缓存写 1.25×）----
const CLAUDE_PRICES = [
  { match: /fable|mythos/i,           inUsd: 10, outUsd: 50 },
  { match: /opus/i,                   inUsd: 5,  outUsd: 25 },
  { match: /sonnet/i,                 inUsd: 3,  outUsd: 15 },
  { match: /haiku/i,                  inUsd: 1,  outUsd: 5 },
];

function claudeCostUsd(model, usage) {
  if (!usage) return 0;
  const p = CLAUDE_PRICES.find((x) => x.match.test(model || '')) || CLAUDE_PRICES[0]; // 未知模型按最贵计，宁多勿少
  const inTok = usage.input_tokens || 0;
  const outTok = usage.output_tokens || 0;
  const cacheW = usage.cache_creation_input_tokens || 0;
  const cacheR = usage.cache_read_input_tokens || 0;
  return (
    (inTok * p.inUsd + outTok * p.outUsd + cacheW * p.inUsd * 1.25 + cacheR * p.inUsd * 0.1) / 1e6
  );
}

// saveConfig 失败时暂存的未落盘 Claude 花费：计入硬顶闸门，下次成功写入时补记，绝不静默丢弃
let pendingClaudeCost = 0;

function getLlmSpend() {
  const cur = loadConfig();
  const s = cur.llmSpend && typeof cur.llmSpend === 'object' ? cur.llmSpend : {};
  return { usd: (Number(s.usd) || 0) + pendingClaudeCost, capUsd: Number(s.capUsd) > 0 ? Number(s.capUsd) : 20 };
}

/** 成功调用后累计花费（重新读盘再写，避免覆盖并发变更） */
function trackClaudeSpend(model, usage) {
  const cost = claudeCostUsd(model, usage);
  if (!cost && !pendingClaudeCost) return;
  try {
    const cur = loadConfig();
    const s = cur.llmSpend && typeof cur.llmSpend === 'object' ? cur.llmSpend : {};
    cur.llmSpend = {
      usd: Math.round(((Number(s.usd) || 0) + cost + pendingClaudeCost) * 1e6) / 1e6,
      capUsd: Number(s.capUsd) > 0 ? Number(s.capUsd) : 20,
    };
    saveConfig(cur);
    pendingClaudeCost = 0;
  } catch (e) {
    pendingClaudeCost += cost;
    console.error(`Claude 花费记账写入失败（$${cost.toFixed(6)} 已暂存，计入硬顶并待下次写入补记）:`, String(e.message || e));
  }
}

const CLAUDE_CAP_MSG = 'CLAUDE_SPEND_CAP_REACHED';

function tolerantJsonParse(s) {
  if (!s) return null;
  let t = String(s).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start > 0 || end < t.length - 1) t = t.slice(Math.max(0, start), end + 1);
  try { return JSON.parse(t); } catch { return null; }
}

function validScriptAnalysis(a) {
  // 数组字段若存在必须真是数组（LLM 常把 characters 写成逗号字符串），
  // 不合格就走既有的一轮修复循环，把已付费的调用救回来
  const optArray = (v) => v === undefined || Array.isArray(v);
  return !!(a && Array.isArray(a.scenes) && a.scenes.length > 0 &&
    optArray(a.characters) && optArray(a.locations) &&
    a.scenes.every((sc) => sc && typeof sc === 'object' && Array.isArray(sc.shots) &&
      sc.shots.every((sh) => sh && typeof sh === 'object' && optArray(sh.characters))));
}

/** 单轮 LLM 补全（三提供商统一入口），返回纯文本。system 可覆盖（默认剧本智能体） */
// ---------------- 🧠 Hermes 门户：本机 OpenAI 兼容代理（hermes proxy），零 Key 走用户 OAuth ----------------
let hermesProc = null;          // 本服务拉起的 proxy 子进程（已在跑的外部实例则不接管）
let hermesModelsCache = { at: 0, models: [] };
function findHermesExe() {
  const cands = [
    'hermes',
    path.join(process.env.LOCALAPPDATA || '', 'hermes', 'bin', 'hermes.exe'),
    path.join(os.homedir(), '.local', 'bin', 'hermes'),
  ];
  for (const c of cands) {
    try { if (spawnSync(c, ['--version'], { timeout: 8000, shell: false }).status === 0) return c; } catch {}
  }
  return null;
}
async function hermesFetchModels(cfg, timeoutMs) {
  const base = (cfg.hermesBase || 'http://127.0.0.1:8645').replace(/\/+$/, '');
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs || 2500);
  try {
    const r = await fetch(base + '/v1/models', { headers: { Authorization: 'Bearer atelier-local' }, signal: ctl.signal });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return null;
    const models = (j.data || []).map((m) => m.id).filter(Boolean);
    hermesModelsCache = { at: Date.now(), models };
    return models;
  } catch { return null; } finally { clearTimeout(t); }
}
/** 门户不在线时自动拉起 `hermes proxy start`（绑本机端口，跟随本服务生命周期）；已在线则直接复用 */
async function ensureHermesProxy(cfg) {
  let models = await hermesFetchModels(cfg, 1800);
  if (models) return { ok: true, started: false, models };
  const exe = findHermesExe();
  if (!exe) return { ok: false, error: '未找到 Hermes（先安装 Hermes Agent 桌面版，或改用「OpenAI 兼容」通道填自己的 LLM）' };
  const port = Number(new URL(cfg.hermesBase || 'http://127.0.0.1:8645').port || 8645);
  if (!hermesProc || hermesProc.exitCode !== null) {
    hermesProc = spawn(exe, ['proxy', 'start', '--host', '127.0.0.1', '--port', String(port)], { stdio: 'ignore' });
    hermesProc.on('error', () => {});
    const kill = () => { try { hermesProc && hermesProc.kill(); } catch {} };
    process.once('exit', kill);
  }
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 700));
    models = await hermesFetchModels(cfg, 1500);
    if (models) return { ok: true, started: true, models };
  }
  return { ok: false, error: 'Hermes 门户启动超时（手动运行 hermes proxy start 看报错；上游需已登录，见 hermes proxy status）' };
}
async function hermesResolveModel(cfg) {
  if (cfg.hermesModel) return cfg.hermesModel;
  const models = (Date.now() - hermesModelsCache.at < 60000 && hermesModelsCache.models.length)
    ? hermesModelsCache.models
    : (await hermesFetchModels(cfg, 2500)) || [];
  if (!models.length) throw new Error('Hermes 门户无可用模型（proxy 未就绪或上游未登录）');
  // 懒人包默认：优先 :free 模型（零余额也能跑），没有才用清单第一项
  return models.find((m) => m.includes(':free')) || models[0];
}

// ---------------- 🔌 万能连接：粘任意 API Key，自动识别是谁/去哪/干什么；也能加 MCP ----------------
const KEY_FINGERPRINTS = [
  { re: /^sk-ant-/, name: 'Anthropic Claude', cat: 'llm', base: 'https://api.anthropic.com', verify: '/v1/models', auth: 'x-api-key', extra: { 'anthropic-version': '2023-06-01' }, openai: false },
  { re: /^sk-or-v1-/, name: 'OpenRouter', cat: 'llm', base: 'https://openrouter.ai/api', verify: '/v1/models', auth: 'bearer', openai: true },
  { re: /^sk-proj-|^sk-svcacct-/, name: 'OpenAI', cat: 'llm', base: 'https://api.openai.com', verify: '/v1/models', auth: 'bearer', openai: true },
  { re: /^gsk_/, name: 'Groq', cat: 'llm', base: 'https://api.groq.com/openai', verify: '/v1/models', auth: 'bearer', openai: true },
  { re: /^xai-/, name: 'xAI Grok', cat: 'llm', base: 'https://api.x.ai', verify: '/v1/models', auth: 'bearer', openai: true },
  { re: /^pplx-/, name: 'Perplexity', cat: 'llm', base: 'https://api.perplexity.ai', verify: '/models', auth: 'bearer', openai: true },
  { re: /^nvapi-/, name: 'NVIDIA NIM', cat: 'llm', base: 'https://integrate.api.nvidia.com', verify: '/v1/models', auth: 'bearer', openai: true },
  { re: /^csk-/, name: 'Cerebras', cat: 'llm', base: 'https://api.cerebras.ai', verify: '/v1/models', auth: 'bearer', openai: true },
  { re: /^AIza/, name: 'Google Gemini', cat: 'llm', base: 'https://generativelanguage.googleapis.com', verify: '/v1beta/models', auth: 'query', openai: false },
  { re: /^r8_/, name: 'Replicate', cat: 'video', base: 'https://api.replicate.com', verify: '/v1/models', auth: 'token', openai: false },
  { re: /^hf_/, name: 'Hugging Face', cat: 'data', base: 'https://huggingface.co', verify: '/api/whoami-v2', auth: 'bearer', openai: false },
  { re: /^tvly-/, name: 'Tavily Search', cat: 'search', base: 'https://api.tavily.com', verify: '', auth: 'bearer', openai: false },
  { re: /^re_/, name: 'Resend Email', cat: 'comms', base: 'https://api.resend.com', verify: '/domains', auth: 'bearer', openai: false },
  { re: /^SG\./, name: 'SendGrid', cat: 'comms', base: 'https://api.sendgrid.com', verify: '/v3/scopes', auth: 'bearer', openai: false },
  { re: /^(ghp_|gho_|github_pat_)/, name: 'GitHub', cat: 'dev', base: 'https://api.github.com', verify: '/user', auth: 'bearer', openai: false },
  { re: /^glpat-/, name: 'GitLab', cat: 'dev', base: 'https://gitlab.com/api', verify: '/v4/user', auth: 'bearer', openai: false },
  { re: /^(xoxb-|xoxp-)/, name: 'Slack', cat: 'comms', base: 'https://slack.com/api', verify: '/auth.test', auth: 'bearer', openai: false },
  { re: /^(sk_live_|sk_test_|rk_live_)/, name: 'Stripe', cat: 'pay', base: 'https://api.stripe.com', verify: '/v1/balance', auth: 'bearer', openai: false },
  { re: /^(ntn_|secret_)/, name: 'Notion', cat: 'data', base: 'https://api.notion.com', verify: '/v1/users/me', auth: 'bearer', extra: { 'Notion-Version': '2022-06-28' }, openai: false },
  { re: /^dop_v1_/, name: 'DigitalOcean', cat: 'dev', base: 'https://api.digitalocean.com', verify: '/v2/account', auth: 'bearer', openai: false },
  { re: /^pcsk_/, name: 'Pinecone', cat: 'data', base: 'https://api.pinecone.io', verify: '/indexes', auth: 'apikey', openai: false },
  { re: /^dckr_pat_/, name: 'Docker Hub', cat: 'dev', base: 'https://hub.docker.com', verify: '', auth: 'bearer', openai: false },
  { re: /^sk-ws-/, name: '阿里云百炼 工作空间（需配套端点）', cat: 'llm', base: '', verify: '/models', auth: 'bearer', openai: true, soft: true },
  { re: /^sk-[0-9a-f]{32,}$/, name: 'DeepSeek(或其它 sk- 兼容站)', cat: 'llm', base: 'https://api.deepseek.com', verify: '/v1/models', auth: 'bearer', openai: true, soft: true },
];
const SK_CANDIDATES = [
  { name: 'OpenAI', base: 'https://api.openai.com' },
  { name: 'DeepSeek', base: 'https://api.deepseek.com' },
  { name: 'Mistral', base: 'https://api.mistral.ai' },
  { name: 'Together', base: 'https://api.together.xyz' },
  { name: 'Fireworks', base: 'https://api.fireworks.ai/inference' },
  { name: 'Moonshot Kimi', base: 'https://api.moonshot.cn' },
];
function fingerprintKey(key) {
  const k = String(key || '').trim();
  return KEY_FINGERPRINTS.filter((fp) => fp.re.test(k));
}
function authHeadersFor(fp, key) {
  const h = Object.assign({}, fp.extra || {});
  if (fp.auth === 'bearer') h.Authorization = 'Bearer ' + key;
  else if (fp.auth === 'x-api-key') h['x-api-key'] = key;
  else if (fp.auth === 'token') h.Authorization = 'Token ' + key;
  else if (fp.auth === 'apikey') h['Api-Key'] = key;
  return h;
}
async function probeProvider(base, verify, headers, isOpenai, key, authKind) {
  let url = base.replace(/\/+$/, '') + (verify || (isOpenai ? '/v1/models' : ''));
  if (authKind === 'query') url = url + (url.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(key);
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(url, { headers: headers, signal: ctl.signal });
    const txt = await r.text();
    let models = [];
    try { const j = JSON.parse(txt); models = (j.data || j.models || []).map((m) => m.id || m.name).filter(Boolean).slice(0, 60); } catch (e2) {}
    return { status: r.status, ok: r.ok, models: models };
  } catch (e) { return { status: 0, ok: false, error: String((e && e.message) || e).slice(0, 120) }; }
  finally { clearTimeout(t); }
}
app.post('/api/keys/identify', (req, res) => {
  const key = String((req.body && req.body.key) || '').trim();
  if (!key) return res.status(400).json({ error: '没有粘贴 Key' });
  const hits = fingerprintKey(key);
  const looksSk = /^sk-/.test(key) && !hits.some((h) => !h.soft);
  res.json({
    masked: maskKey(key), length: key.length,
    guesses: hits.map((h) => ({ name: h.name, cat: h.cat, base: h.base, openai: !!h.openai, soft: !!h.soft })),
    skCandidates: looksSk ? SK_CANDIDATES : [],
    unknown: !hits.length && !looksSk,
  });
});
app.post('/api/keys/verify', async (req, res) => {
  const key = String((req.body && req.body.key) || '').trim();
  const forceBase = String((req.body && req.body.base) || '').trim();
  const forceName = String((req.body && req.body.name) || '').trim();
  if (!key) return res.status(400).json({ error: '没有 Key' });
  const tried = [];
  if (forceBase) {
    const r = await probeProvider(forceBase, '/v1/models', { Authorization: 'Bearer ' + key }, true, key, 'bearer');
    tried.push(Object.assign({ name: forceName || forceBase, base: forceBase }, r));
    if (r.ok) return res.json({ resolved: { name: forceName || forceBase, cat: 'llm', base: forceBase, openai: true, models: r.models }, tried });
  }
  for (const fp of fingerprintKey(key)) {
    const r = await probeProvider(fp.base, fp.verify, authHeadersFor(fp, key), fp.openai, key, fp.auth);
    tried.push(Object.assign({ name: fp.name, base: fp.base, cat: fp.cat }, r));
    if (r.ok) return res.json({ resolved: { name: fp.name, cat: fp.cat, base: fp.base, openai: !!fp.openai, models: r.models }, tried });
  }
  if (/^sk-/.test(key)) {
    for (const c of SK_CANDIDATES) {
      const r = await probeProvider(c.base, '/v1/models', { Authorization: 'Bearer ' + key }, true, key, 'bearer');
      tried.push(Object.assign({ name: c.name, base: c.base, cat: 'llm' }, r));
      if (r.ok) return res.json({ resolved: { name: c.name, cat: 'llm', base: c.base, openai: true, models: r.models }, tried });
    }
  }
  res.json({ resolved: null, tried, hint: '没能自动认出——填一个 Base URL(OpenAI 兼容端点)我再试,或手动标注它是什么。' });
});
// 📄 厂商密钥文件导入：把 CSV/KV/JSON（如阿里云百炼工作空间 apiKey.csv）整份贴进来，
// 自动抽出 key + OpenAI 兼容端点 + 工作空间名 → 真连一次拿模型清单 → 存为连接。
function parseVendorBlob(text) {
  const out = {};
  const raw = String(text || '').trim();
  if (!raw) return out;
  try { // 先试 JSON
    const j = JSON.parse(raw);
    if (j && typeof j === 'object') for (const [k, v] of Object.entries(j)) out[String(k).trim()] = String(v == null ? '' : v).trim();
  } catch {
    for (const line of raw.split(/\r?\n/)) { // CSV / key=value / key: value 通吃
      const m = /^\s*"?([A-Za-z0-9_\-. ]+)"?\s*[,=:]\s*(.*)$/.exec(line);
      if (!m) continue;
      out[m[1].trim()] = m[2].trim().replace(/^"(.*)"$/, '$1');
    }
  }
  const pick = (...names) => {
    for (const n of names) {
      const hit = Object.keys(out).find((k) => k.toLowerCase() === n.toLowerCase());
      if (hit && out[hit]) return out[hit];
    }
    return '';
  };
  let base = pick('openAiCompatible', 'openai_compatible', 'baseUrl', 'base_url', 'endpoint', 'apiBase', 'api_base');
  const host = pick('apiHost', 'host');
  if (!base && host) base = 'https://' + host.replace(/^https?:\/\//, '') + '/compatible-mode/v1';
  return {
    key: pick('apiKey', 'api_key', 'key', 'token', 'sk'),
    base: base.replace(/\/+$/, ''),
    name: pick('workspaceName', 'workspace', 'name', 'description') || '',
    workspaceId: pick('workspaceId', 'workspace_id', 'id') || '',
    dashScope: pick('dashScope', 'dashscope') || '',
  };
}
app.post('/api/connections/import-vendor', async (req, res) => {
  const parsed = parseVendorBlob((req.body && req.body.text) || '');
  if (!parsed.key) return res.status(400).json({ error: '没在这份内容里找到 apiKey（支持 CSV / key=value / JSON）' });
  if (!parsed.base) return res.status(400).json({ error: '没找到 OpenAI 兼容端点（openAiCompatible 或 apiHost）— 补一行再试' });
  // OpenAI 兼容端点可能已带 /v1；探测时按原样 + 补 /v1 两种都试
  const candidates = /\/v\d+$/.test(parsed.base) ? [parsed.base] : [parsed.base + '/v1', parsed.base];
  for (const b of candidates) {
    const r = await probeProvider(b, '/models', { Authorization: 'Bearer ' + parsed.key }, false, parsed.key, 'bearer');
    if (!r.ok) continue;
    const cfg = loadConfig();
    ensureConnections(cfg);
    const entry = {
      id: newId(), kind: 'apikey',
      name: parsed.name || parsed.workspaceId || '厂商端点',
      cat: 'llm', base: b, url: '', key: parsed.key,
      // DashScope 原生端点：云端出片（Wan 视频）走它，不是 OpenAI 兼容那条
      ds: parsed.dashScope || (parsed.base ? parsed.base.replace(/\/compatible-mode\/v\d+$/, '') + '/api/v1' : ''),
      models: r.models || [], tools: [],
      note: (parsed.workspaceId ? '工作空间 ' + parsed.workspaceId : '') + (parsed.dashScope ? ' · DashScope ' + parsed.dashScope : ''),
      openai: true, auth: 'bearer', addedAt: Date.now(),
    };
    cfg.connections.push(entry);
    // 一键设为 ✨增强/💬对话/翻译 的通道（省钱：不再走 Claude 硬顶额度）
    // ⚠ 必须经钥匙串落 key：loadConfig 会用 active 条目覆写 openaiKey，直接写字段会被冲掉
    if (req.body && req.body.setAsLlm) {
      ensureKeychain(cfg);
      let hit = (cfg.keychain.openai || []).find((k) => k && k.key === parsed.key);
      if (!hit) {
        hit = { id: newId(), label: entry.name + '（密钥文件导入）', key: parsed.key, addedAt: Date.now(), activatedAt: Date.now() };
        cfg.keychain.openai.push(hit);
      }
      cfg.keychainActive.openai = hit.id;
      syncKeychainToLegacy(cfg);
      cfg.openaiBase = b.replace(/\/v\d+$/, '');
      cfg.llmProvider = 'openai';
      if (req.body.llmModel) cfg.llmModel = String(req.body.llmModel);
    }
    saveConfig(cfg);
    return res.json({
      ok: true, id: entry.id, name: entry.name, base: b,
      masked: maskKey(parsed.key), models: r.models || [],
      setAsLlm: !!(req.body && req.body.setAsLlm),
      hasVideo: (r.models || []).some((m) => /t2v|i2v|s2v|video|minimax|hailuo/i.test(String(m))),
    });
  }
  res.status(502).json({ error: '端点连不上或 Key 被拒（试过：' + candidates.join(' / ') + '）' });
});
function ensureConnections(cur) {
  if (!Array.isArray(cur.connections)) { cur.connections = []; return true; }
  return false;
}
app.get('/api/connections', (req, res) => {
  const cfg = loadConfig();
  ensureConnections(cfg);
  res.json({ connections: (cfg.connections || []).map((c) => ({
    id: c.id, kind: c.kind, name: c.name, cat: c.cat, base: c.base, url: c.url,
    masked: c.key ? maskKey(c.key) : undefined, models: c.models, tools: c.tools, note: c.note, addedAt: c.addedAt, ds: c.ds,
  })) });
});
app.post('/api/connections/save', (req, res) => {
  const b = req.body || {};
  const cfg = loadConfig();
  ensureConnections(cfg);
  const entry = {
    id: newId(), kind: b.kind === 'mcp' ? 'mcp' : 'apikey',
    name: String(b.name || '未命名').slice(0, 60), cat: String(b.cat || 'other'),
    base: b.base ? String(b.base).replace(/\/+$/, '') : '', url: b.url ? String(b.url) : '',
    key: b.key ? String(b.key) : '', models: Array.isArray(b.models) ? b.models.slice(0, 80) : [],
    tools: Array.isArray(b.tools) ? b.tools.slice(0, 200) : [], note: String(b.note || '').slice(0, 300),
    openai: !!b.openai, auth: b.auth || 'bearer', addedAt: Date.now(),
  };
  cfg.connections.push(entry);
  saveConfig(cfg);
  res.json({ ok: true, id: entry.id, masked: entry.key ? maskKey(entry.key) : undefined });
});
app.post('/api/connections/delete', (req, res) => {
  const id = String((req.body && req.body.id) || '');
  const cfg = loadConfig();
  ensureConnections(cfg);
  cfg.connections = cfg.connections.filter((c) => c.id !== id);
  saveConfig(cfg);
  res.json({ ok: true });
});
app.post('/api/mcp/probe', async (req, res) => {
  const url = String((req.body && req.body.url) || '').trim();
  const token = String((req.body && req.body.token) || '').trim();
  if (!/^https?:\/\//.test(url)) return res.status(400).json({ error: 'MCP URL 需为 http(s)(SSE/streamable 端点)' });
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const rpc = (method, params, id) => JSON.stringify({ jsonrpc: '2.0', id: id, method: method, params: params || {} });
  const parseMcp = (txt) => {
    const lines = txt.split(/\r?\n/).filter((l) => l.indexOf('data:') === 0);
    const body = lines.length ? lines.map((l) => l.slice(5).trim()).join('') : txt;
    try { return JSON.parse(body); } catch (e) { return null; }
  };
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 10000);
  try {
    const initR = await fetch(url, { method: 'POST', headers: headers, signal: ctl.signal,
      body: rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'atelier452', version: '1.0' } }, 1) });
    const sid = initR.headers.get('mcp-session-id');
    const h2 = Object.assign({}, headers);
    if (sid) h2['mcp-session-id'] = sid;
    const initJson = parseMcp(await initR.text());
    const serverName = (initJson && initJson.result && initJson.result.serverInfo) ? initJson.result.serverInfo.name : '';
    const toolsR = await fetch(url, { method: 'POST', headers: h2, signal: ctl.signal, body: rpc('tools/list', {}, 2) });
    const toolsJson = parseMcp(await toolsR.text());
    const tools = ((toolsJson && toolsJson.result && Array.isArray(toolsJson.result.tools)) ? toolsJson.result.tools : [])
      .map((x) => ({ name: x.name, desc: String(x.description || '').slice(0, 120) }));
    if (!initJson && !tools.length) return res.status(502).json({ error: '握手失败(不是 MCP 端点或需要授权)' });
    res.json({ ok: true, serverName: serverName, tools: tools });
  } catch (e) {
    res.status(502).json({ error: '连不上/握手失败:' + String((e && e.message) || e).slice(0, 160) });
  } finally { clearTimeout(t); }
});

// 📱 手机遥控开关（只许本机操作；status 双端可查）
app.post('/api/remote/start', async (req, res) => {
  if (isRemoteReq(req)) return res.status(403).json({ error: '只能在电脑上开关远程访问' });
  if (remoteCtl.url && remoteCtl.proc && remoteCtl.proc.exitCode === null) {
    return res.json({ url: remoteCtl.url, link: remoteCtl.url + '/?key=' + remoteCtl.token, reused: true });
  }
  const exe = findCloudflared();
  if (!exe) return res.status(400).json({ error: '未找到 cloudflared（winget install Cloudflare.cloudflared 后重试）' });
  try {
    const url = await new Promise((resolve, reject) => {
      const proc = spawn(exe, ['tunnel', '--url', 'http://127.0.0.1:' + (process.env.PORT || 5893)]);
      let buf = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { proc.kill(); } catch {}
        reject(new Error('隧道启动超时（30s）'));
      }, 30000);
      const onData = (d) => {
        buf += d.toString();
        const m = buf.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (m && !settled) {
          settled = true;
          clearTimeout(timer);
          remoteCtl.proc = proc;
          resolve(m[0]);
        }
      };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);
      proc.on('error', (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } });
      proc.on('close', (code) => {
        if (remoteCtl.proc === proc) { remoteCtl.proc = null; remoteCtl.url = ''; remoteCtl.token = ''; }
        if (!settled) { settled = true; clearTimeout(timer); reject(new Error('cloudflared 提前退出 (code ' + code + '): ' + buf.slice(-300))); }
      });
    });
    remoteCtl.url = url;
    remoteCtl.token = require('crypto').randomBytes(24).toString('hex'); // 每次开启轮换
    console.log('📱 手机遥控隧道已建立:', url);
    res.json({ url, link: url + '/?key=' + remoteCtl.token, reused: false });
  } catch (e) {
    res.status(502).json({ error: String(e && e.message || e).slice(0, 300) });
  }
});
app.post('/api/remote/stop', (req, res) => {
  if (isRemoteReq(req)) return res.status(403).json({ error: '只能在电脑上开关远程访问' });
  try { remoteCtl.proc && remoteCtl.proc.kill(); } catch {}
  remoteCtl.proc = null; remoteCtl.url = ''; remoteCtl.token = '';
  res.json({ ok: true });
});
app.get('/api/remote/status', (req, res) => {
  const on = !!(remoteCtl.url && remoteCtl.proc && remoteCtl.proc.exitCode === null);
  res.json({ on, url: on ? remoteCtl.url : '', isRemote: isRemoteReq(req) });
});

// ---------------- 🧩 ComfyUI · MiniMax H3：免开 UI 本机出片，成片自动存 D:\MINIMAX H3 GENS ----------------
// ComfyUI 存的是 UI 格式工作流（nodes/links）；POST /prompt 要 API 格式 —— 这里用 /object_info
// 的节点 schema 做服务端转换（widgets_values 按 schema 顺序含已转输入的占位槽，见 04/05 记录）。
const comfyCtl = { proc: null, objectInfo: null, jobs: {} };
function comfyCfg(cfg) {
  return {
    base: (cfg.comfyBase || 'http://127.0.0.1:8188').replace(/\/+$/, ''),
    dir: cfg.comfyDir || 'D:\\ComfyUI',
    saveDir: cfg.comfySaveDir || 'D:\\MINIMAX H3 GENS',
  };
}
async function comfyAlive(cc, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs || 1500);
  try { const r = await fetch(cc.base + '/system_stats', { signal: ctl.signal }); return r.ok; }
  catch { return false; } finally { clearTimeout(t); }
}
/** 没在跑就用 .venv 的 python 无头拉起（run_comfyui.ps1 同款参数），跟随本服务生命周期 */
async function ensureComfy(cc) {
  if (await comfyAlive(cc, 1500)) return { ok: true, started: false };
  const py = path.join(cc.dir, '.venv', 'Scripts', 'python.exe');
  if (!fs.existsSync(py)) return { ok: false, error: `未找到 ComfyUI venv（${py}）— 检查 comfyDir 配置` };
  if (!comfyCtl.proc || comfyCtl.proc.exitCode !== null) {
    const port = Number(new URL(cc.base).port || 8188);
    comfyCtl.proc = spawn(py, ['main.py', '--listen', '127.0.0.1', '--port', String(port)], {
      cwd: cc.dir,
      stdio: 'ignore',
      // Windows 下无终端 spawn 的 Python 默认 cp1252，自定义节点启动横幅里的 emoji 直接把进程炸死 —— 强制 UTF-8
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });
    comfyCtl.proc.on('error', () => {});
    const kill = () => { try { comfyCtl.proc && comfyCtl.proc.kill(); } catch {} };
    process.once('exit', kill);
  }
  for (let i = 0; i < 60; i++) { // 首启含节点加载，宽限 90s
    await new Promise((r) => setTimeout(r, 1500));
    if (await comfyAlive(cc, 1500)) return { ok: true, started: true };
    if (comfyCtl.proc && comfyCtl.proc.exitCode !== null) return { ok: false, error: 'ComfyUI 启动即退出 — 手动跑 run_comfyui.ps1 看报错' };
  }
  return { ok: false, error: 'ComfyUI 启动超时（90s）' };
}
async function comfyObjectInfo(cc) {
  if (comfyCtl.objectInfo) return comfyCtl.objectInfo;
  const r = await fetch(cc.base + '/object_info');
  if (!r.ok) throw new Error('object_info HTTP ' + r.status);
  comfyCtl.objectInfo = await r.json();
  return comfyCtl.objectInfo;
}
const COMFY_PRIMS = new Set(['INT', 'FLOAT', 'STRING', 'BOOLEAN']);
function comfyWidgetNames(info) {
  // schema 顺序里的 widget 形参（连线专用类型不占 widgets_values 槽；seed 类后面跟一个 control 占位）
  const names = [];
  const seedish = new Set();
  const defaults = {}; // 旧工作流少存的新增 widget → 按 schema 默认值补齐
  for (const sect of ['required', 'optional']) {
    const specs = (info && info.input && info.input[sect]) || {};
    for (const [name, spec] of Object.entries(specs)) {
      const t = Array.isArray(spec) ? spec[0] : spec;
      const opts = (Array.isArray(spec) && spec[1]) || {};
      // combo 各种写法都算 widget：旧式 = 选项数组本体；新式 = 'COMBO' / 'COMFY_DYNAMICCOMBO_V3' 等含 COMBO 的类型名
      const isWidget = Array.isArray(t) || COMFY_PRIMS.has(t) || (typeof t === 'string' && t.includes('COMBO'));
      if (!isWidget || opts.forceInput) continue;
      names.push(name);
      if (opts.default !== undefined) defaults[name] = opts.default;
      else if (Array.isArray(t) && t.length) defaults[name] = t[0];
      else if (t === 'COMBO' && opts.options && opts.options.length) defaults[name] = opts.options[0];
      else if (t === 'BOOLEAN') defaults[name] = false;
      if (name === 'seed' || name === 'noise_seed' || opts.control_after_generate) seedish.add(name);
    }
  }
  return { names, seedish, defaults };
}
/** UI 工作流 → API prompt v3：支持 GetNode/SetNode/Reroute/PrimitiveNode 虚拟节点、
 *  静音(mode2)=剪除、旁路(mode4)=同类型直通、UI 纯控制节点静默跳过、模型路径按文件名自动改指。 */
const COMFY_VIRTUAL = new Set(['GetNode', 'SetNode', 'Reroute', 'PrimitiveNode', 'PMultilineString']);
// 已知无法自动补装的节点 → 人话原因（体检/转换报错都用）
const COMFY_KNOWN_MISSING = {
  OllamaGenerateV2: '这个工作流用本机 Ollama 大模型看图写提示词 — 需要自行安装 Ollama 服务 + comfyui-ollama 节点包才可跑',
  ExecutionGate: '节点 ExecutionGate 在社区注册表查无来源包（作者未发布）— 此工作流暂无法自动修复',
};
const COMFY_UI_ONLY = /^(Note|MarkdownNote|Fast Groups (Bypasser|Muter) \(rgthree\)|Label \(rgthree\)|Bookmark.*)$/;
// ---------------- 子图容器展开：UUID 节点（definitions.subgraphs）内联回顶层 ----------------
// ComfyUI 新版把「节点组→子图」存成容器：顶层节点 type=子图 UUID，图体在 definitions.subgraphs。
// 展开语义（对 8 个实测工作流逐一验证）：
//  - 子图内部 links 是对象格式 {origin_id,origin_slot,target_id,target_slot}；origin_id=-10 为
//    子图输入伪节点（origin_slot=子图 inputs 下标），target_id=-20 为输出伪节点。
//  - 实例 widgets_values 按「子图 inputs 全序中可 widget 化类型（STRING/INT/FLOAT/BOOLEAN/COMBO）」
//    逐格存值——已连线的槽也占格（值被连线覆盖，与普通节点 seed 槽同理）。
//  - 实例 inputs[] 只列部分子图输入，按 name 对应；输出同理（下标兜底）。
const COMFY_WIDGETABLE_TYPES = /STRING|INT|FLOAT|BOOLEAN|NUMBER|COMBO/i;
function comfyExpandSubgraphs(ui) {
  const defs = ((ui.definitions || {}).subgraphs) || [];
  if (!defs.length) return ui;
  const byDef = {};
  for (const s of defs) byDef[String(s.id)] = s;
  const out = {
    ...ui,
    nodes: (ui.nodes || []).map((n) => ({ ...n })),
    links: (ui.links || []).map((l) => l.slice()),
  };
  let nextNode = Number(out.last_node_id) || 0;
  let nextLink = Number(out.last_link_id) || 0;
  for (const n of out.nodes) { if (Number(n.id) > nextNode) nextNode = Number(n.id); }
  for (const l of out.links) { if (Number(l[0]) > nextLink) nextLink = Number(l[0]); }
  for (let pass = 0; pass < 64; pass++) { // 支持嵌套：每轮展开一个实例，直到没有 UUID 节点
    const inst = out.nodes.find((n) => byDef[String(n.type)]);
    if (!inst) break;
    const sub = byDef[String(inst.type)];
    if (inst.mode === 2 || inst.mode === 4) {
      // 整体静音/旁路的子图实例：按剪除处理（旁路直通子图无通用语义）
      const deadOut = new Set();
      for (const o of inst.outputs || []) for (const lid of o.links || []) deadOut.add(lid);
      out.nodes = out.nodes.filter((n) => n !== inst);
      out.links = out.links.filter((l) => !deadOut.has(l[0]));
      continue;
    }
    const topLinkSrc = {};
    for (const l of out.links) topLinkSrc[l[0]] = [l[1], l[2]];
    const instInputByName = {};
    for (const i of inst.inputs || []) instInputByName[i.name] = i;
    // 子图输入逐槽解析：连线来源 or 实例 widget 字面量
    const wv = Array.isArray(inst.widgets_values) ? inst.widgets_values : [];
    let wi = 0;
    const inMap = (sub.inputs || []).map((si) => {
      const widgetable = COMFY_WIDGETABLE_TYPES.test(String(si.type || ''));
      let lit;
      if (widgetable && wi < wv.length) lit = wv[wi++]; // 占格（连线与否都占）
      const ii = instInputByName[si.name];
      if (ii && ii.link != null && topLinkSrc[ii.link]) return { src: topLinkSrc[ii.link] };
      if (lit !== undefined) return { lit };
      return {};
    });
    // 内部节点重编号并入（inputs.link 先清空，由子图 links 重建，防撞顶层同号）
    const idMap = {};
    for (const n of sub.nodes || []) idMap[String(n.id)] = ++nextNode;
    const newNodes = (sub.nodes || []).map((n) => ({
      ...n,
      id: idMap[String(n.id)],
      inputs: (n.inputs || []).map((i) => ({ ...i, link: null })),
      outputs: (n.outputs || []).map((o) => ({ ...o, links: [] })),
    }));
    const newById = {};
    for (const n of newNodes) newById[n.id] = n;
    // 实例输出槽下标（实例 outputs 按 name 对齐子图 outputs；下标兜底）。
    // 顶层受体必须按「origin==实例id && slot==该下标」全量扫——串联子图时，先展开的邻居
    // 会新建挂在本实例输出上的顶层连线，它们不在实例自带的 outputs[].links 登记表里。
    const instOutIdx = (slot) => {
      const def = (sub.outputs || [])[slot] || {};
      const arr = inst.outputs || [];
      const i = arr.findIndex((o) => o.name === def.name);
      return i >= 0 ? i : Math.min(slot, Math.max(0, arr.length - 1));
    };
    for (const L of sub.links || []) {
      const oid = L.origin_id, tid = L.target_id;
      if (oid === -10 && tid === -20) {
        // 输入直通输出：顶层受体改接实例该输入的真实来源
        const m = inMap[L.origin_slot] || {};
        const oi = instOutIdx(L.target_slot);
        for (const tl of out.links.slice()) {
          if (tl[1] !== inst.id || tl[2] !== oi) continue;
          if (m.src) { tl[1] = m.src[0]; tl[2] = m.src[1]; }
          else out.links = out.links.filter((l) => l !== tl);
        }
        continue;
      }
      if (oid === -10) {
        const m = inMap[L.origin_slot] || {};
        const tgt = newById[idMap[String(tid)]];
        if (!tgt) continue;
        const ti = (tgt.inputs || [])[L.target_slot];
        if (m.src) {
          const lid = ++nextLink;
          out.links.push([lid, m.src[0], m.src[1], tgt.id, L.target_slot, L.type]);
          if (ti) ti.link = lid;
        } else if (m.lit !== undefined) {
          // 实例 widget 值 → 内部目标槽的字面量（转换阶段消费 __lit）
          tgt.__lit = tgt.__lit || {};
          tgt.__lit[ti ? ti.name : 'slot' + L.target_slot] = m.lit;
        }
        continue;
      }
      if (tid === -20) {
        const srcN = newById[idMap[String(oid)]];
        if (!srcN) continue;
        const oi = instOutIdx(L.target_slot);
        for (const tl of out.links) {
          if (tl[1] === inst.id && tl[2] === oi) {
            tl[1] = srcN.id;
            tl[2] = L.origin_slot;
          }
        }
        continue;
      }
      const s = newById[idMap[String(oid)]], t = newById[idMap[String(tid)]];
      if (!s || !t) continue;
      const lid = ++nextLink;
      out.links.push([lid, s.id, L.origin_slot, t.id, L.target_slot, L.type]);
      const ti = (t.inputs || [])[L.target_slot];
      if (ti) ti.link = lid;
    }
    out.nodes = out.nodes.filter((n) => n !== inst).concat(newNodes);
  }
  out.last_node_id = nextNode;
  out.last_link_id = nextLink;
  return out;
}

function comfyConvert(ui, objectInfo) {
  ui = comfyExpandSubgraphs(ui); // 子图容器先内联回顶层，后续转换零感知
  const byId = {};
  for (const n of ui.nodes || []) byId[String(n.id)] = n;
  const linkSrc = {}; // linkId -> [srcNodeId, srcSlot]
  for (const l of ui.links || []) linkSrc[l[0]] = [String(l[1]), l[2]];
  // 穿透：Reroute/旁路 = 直通；GetNode = 同 key SetNode 上溯；PrimitiveNode = 字面量；静音 = 断开
  const resolveSrc = (src, depth) => {
    if (!src || (depth || 0) > 48) return null;
    const n = byId[src[0]];
    if (!n) return null;
    if (n.mode === 2) return null; // 静音：这条来源不存在
    const follow = (inp) => (inp && inp.link != null && linkSrc[inp.link]) ? resolveSrc(linkSrc[inp.link], (depth || 0) + 1) : null;
    if (n.type === 'Reroute') return follow((n.inputs || [])[0]);
    if (n.type === 'GetNode') {
      const key = (n.widgets_values || [])[0];
      const setter = (ui.nodes || []).find((x) => x.type === 'SetNode' && x.mode !== 2 && (x.widgets_values || [])[0] === key);
      const r = setter ? follow((setter.inputs || [])[0]) : null;
      if (!r) throw new Error(`GetNode「${key}」找不到对应的 SetNode 来源`);
      return r;
    }
    if (n.type === 'PrimitiveNode') return { lit: (n.widgets_values || [])[0] };
    // PMultilineString（fearnworks 旧版节点，包已绝版）：本质就是多行字符串常量 → 字面量内联
    if (n.type === 'PMultilineString') return { lit: (n.widgets_values || [])[0] };
    if (n.mode === 4) { // 旁路：按输出槽类型找同类型的输入直通
      const outType = ((n.outputs || [])[src[1]] || {}).type;
      const inp = (n.inputs || []).find((i) => i.type === outType && i.link != null) || (n.inputs || [])[src[1]] || (n.inputs || [])[0];
      return follow(inp);
    }
    return src;
  };
  const api = {};
  for (const n of ui.nodes || []) {
    if (COMFY_UI_ONLY.test(n.type) || COMFY_VIRTUAL.has(n.type)) continue;
    if (n.mode === 2 || n.mode === 4) continue; // 静音剪除；旁路由 resolveSrc 直通
    const info = objectInfo[n.type];
    if (!info) {
      throw new Error(COMFY_KNOWN_MISSING[n.type]
        || `ComfyUI 缺节点 ${n.type} — 对应自定义节点包没装（或是子图/未支持的容器节点）`);
    }
    const inputs = {};
    for (const inp of n.inputs || []) {
      if (inp.link != null && linkSrc[inp.link]) {
        const src = resolveSrc(linkSrc[inp.link], 0);
        if (src && src.lit !== undefined) inputs[inp.name] = src.lit;
        else if (src) inputs[inp.name] = src;
      }
    }
    const wvRaw = n.widgets_values;
    if (wvRaw && !Array.isArray(wvRaw) && typeof wvRaw === 'object') {
      // VHS 系节点把 widgets 存成命名字典 → 直接并入（跳过 videopreview 等 UI 专用对象值）
      for (const [k, v] of Object.entries(wvRaw)) {
        if (k in inputs || v === null || (v && typeof v === 'object')) continue;
        inputs[k] = v;
      }
    } else {
      const { names, seedish, defaults } = comfyWidgetNames(info);
      const wv = wvRaw || [];
      let wi = 0;
      for (const name of names) {
        if (wi >= wv.length) break;
        const val = wv[wi++];
        if (seedish.has(name) && wi < wv.length && typeof wv[wi] === 'string'
          && ['fixed', 'increment', 'decrement', 'randomize'].includes(wv[wi])) wi++;
        if (!(name in inputs)) inputs[name] = val;
      }
      // 工作流比节点包旧：新增的 widget 没存值 → 按 schema 默认补齐（否则整个节点被判无效剔除）
      for (const name of names) {
        if (!(name in inputs) && name in defaults) inputs[name] = defaults[name];
      }
    }
    // 子图展开注入的实例级字面量：优先级最高（覆盖内部节点自存的旧值/默认值）
    if (n.__lit) for (const [k, v] of Object.entries(n.__lit)) inputs[k] = v;
    api[String(n.id)] = { class_type: n.type, inputs };
  }
  return api;
}
/** 取某节点某输入的合法选项清单（combo 三代写法通吃）；不是 combo 返回 null */
function comfyValidOptionsFor(objectInfo, cls, name) {
  const inp = (objectInfo[cls] || {}).input || {};
  const spec = (inp.required || {})[name] || (inp.optional || {})[name];
  if (!spec) return null;
  const t = Array.isArray(spec) ? spec[0] : null;
  if (Array.isArray(t)) return t;
  if (typeof t === 'string' && t.includes('COMBO') && spec[1] && Array.isArray(spec[1].options)) return spec[1].options;
  return null;
}
function comfyRequiredNames(objectInfo, cls) {
  return new Set(Object.keys((((objectInfo[cls] || {}).input) || {}).required || {}));
}
/**
 * 🩹 死链修剪（R2V 能跑的关键）：LoadImage/LoadAudio 指向的文件在 ComfyUI 里已不存在、
 * 且没有场景参考可顶 → 判死，沿「必需输入」级联，遇到可选输入直接断开。
 * H3 的 ref_audios 正是可选：没有参考音频时断开即可，模型按提示词自己生成声音
 * （成片音轨来自 VAEDecodeAudio，不是这条参考链——已核对图结构）。
 */
function comfyPruneDeadLoaders(api, objectInfo, onlyClasses, immuneIds) {
  const notes = [];
  const LOADER_FIELD = { LoadImage: 'image', LoadAudio: 'audio', LoadVideo: 'video', LoadImageMask: 'image' };
  const dead = new Set();
  for (const [id, node] of Object.entries(api)) {
    const field = LOADER_FIELD[node.class_type];
    if (!field) continue;
    if (onlyClasses && !onlyClasses.includes(node.class_type)) continue;
    // 刚上传的场景参考不在缓存的 object_info 清单里，绝不能因此被判死
    if (immuneIds && immuneIds.has(String(id))) continue;
    const val = node.inputs[field];
    if (typeof val !== 'string') continue;
    const opts = comfyValidOptionsFor(objectInfo, node.class_type, field);
    if (opts && opts.length && !opts.includes(val)) {
      dead.add(id);
      notes.push(`${node.class_type}「${val}」已不存在 → 断开该参考链`);
    }
  }
  if (!dead.size) return notes;
  for (let pass = 0; pass < 32; pass++) {
    let changed = false;
    for (const [id, node] of Object.entries(api)) {
      if (dead.has(id)) continue;
      const req = comfyRequiredNames(objectInfo, node.class_type);
      for (const [name, val] of Object.entries(node.inputs)) {
        if (!Array.isArray(val) || typeof val[0] !== 'string' || !dead.has(val[0])) continue;
        const root = String(name).split('.')[0]; // dict 形态 ref_audios.ref_audio_0 → 判根名
        if (req.has(name) || req.has(root)) { dead.add(id); changed = true; break; }
        delete node.inputs[name];
        changed = true;
        notes.push(`断开可选输入 ${node.class_type}.${name}（模型将自行生成该部分）`);
      }
    }
    if (!changed) break;
  }
  for (const id of dead) delete api[id];
  for (const node of Object.values(api)) {
    for (const [name, val] of Object.entries(node.inputs)) {
      if (Array.isArray(val) && typeof val[0] === 'string' && dead.has(val[0])) delete node.inputs[name];
    }
  }
  return notes;
}
/** 音频时长（秒）：ffmpeg -i 读 stderr 的 Duration，拿不到返回 0 */
function comfyAudioSeconds(file) {
  try {
    const r = spawnSync(FFMPEG || 'ffmpeg', ['-i', file], { timeout: 15000 });
    const out = String(r.stderr || '') + String(r.stdout || '');
    const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(out);
    if (!m) return 0;
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  } catch { return 0; }
}
/** 参考音频比工作流存的裁剪窗还短 → 把 start_index/duration 夹回可行范围（否则 TrimAudioDuration 直接报错） */
function comfyFitAudioTrim(api, seconds) {
  const notes = [];
  if (!(seconds > 0)) return notes;
  for (const node of Object.values(api)) {
    if (node.class_type !== 'TrimAudioDuration') continue;
    const start = Number(node.inputs.start_index);
    if (Number.isFinite(start) && start >= seconds - 0.5) {
      node.inputs.start_index = 0;
      notes.push(`参考音频仅 ${seconds.toFixed(1)}s，裁剪起点 ${start}s 越界 → 归 0`);
    }
    const dur = Number(node.inputs.duration);
    if (Number.isFinite(dur)) {
      const room = Math.max(0.5, seconds - Number(node.inputs.start_index || 0));
      if (dur > room) { node.inputs.duration = Math.floor(room * 10) / 10; notes.push(`裁剪时长夹到 ${node.inputs.duration}s`); }
    }
  }
  return notes;
}

/** 模型路径自愈：值不在可选清单、但存在同文件名的可选项（仅子目录/斜杠不同）→ 自动改指同一份文件 */
function comfyRemapModelPaths(api, objectInfo) {
  const notes = [];
  const norm = (s) => String(s).replace(/\\/g, '/').toLowerCase();
  const baseOf = (s) => norm(s).split('/').pop();
  for (const node of Object.values(api)) {
    const input = (objectInfo[node.class_type] || {}).input || {};
    const specs = { ...(input.required || {}), ...(input.optional || {}) };
    for (const [name, val] of Object.entries(node.inputs)) {
      if (typeof val !== 'string') continue;
      const spec = specs[name];
      const t = Array.isArray(spec) ? spec[0] : null;
      const options = Array.isArray(t) ? t : (t === 'COMBO' && spec[1] && Array.isArray(spec[1].options) ? spec[1].options : null);
      if (!options || !options.length || options.includes(val)) continue;
      // 同文件不同挂载路径 → 改指；再退一步：同名的 pruned/非 pruned 量化变体互替
      //（如 fl2va_int8_convrot ↔ fl2va_pruned_int8_convrot——同一模型的两种发布形态，
      //  作者环境用全量、本机只有 pruned 时自动顶上；remaps 会明示给用户）；
      // 最后：清单只剩唯一可选项（节点版本变更移除了旧选项）→ 就选它
      const wantBase = baseOf(val);
      const altBase = wantBase.includes('pruned') ? wantBase.replace(/_?pruned_?/, '_').replace(/__+/g, '_') : wantBase.replace(/(fl2va|ref2va|i2v|t2v)_/, '$1_pruned_');
      // 选项文案规范化匹配（节点更新改了大小写/空格/下划线：First frame priority ↔ first_frame_priority）
      const squash = (s) => String(s).toLowerCase().replace(/[\s_\-.]+/g, '');
      const spec1 = Array.isArray(spec) ? spec[1] : null;
      const schemaDefault = spec1 && spec1.default !== undefined ? spec1.default : undefined;
      const hit = options.find((o) => baseOf(o) === wantBase)
        || options.find((o) => baseOf(o) === altBase)
        || options.find((o) => squash(o) === squash(val))
        || ((val === '' || val == null) && schemaDefault !== undefined && options.includes(schemaDefault) ? schemaDefault : null)
        || ((val === '' || val == null) && options.length ? options[0] : null) // 空值=没选：按 UI 惯例取首项
        || (options.length === 1 ? options[0] : null)
        // 节点升级导致 widget 槽位平移/选项改名（如 "16:9" 落进 resize_method、旧文案选项已删）：
        // 值彻底无效时回退 schema default（作者推荐参数，可跑且合理）—— remaps 会逐条明示
        || (schemaDefault !== undefined && options.includes(schemaDefault) ? schemaDefault : null);
      if (hit != null) {
        node.inputs[name] = hit;
        notes.push(`${node.class_type}.${name}: ${val} → ${hit}`);
      }
    }
  }
  return notes;
}
/** 把应用内素材（/assets|/videos url）传进 ComfyUI 的 input 目录，返回 LoadImage/LoadAudio 可用的相对名 */
function comfyLocalPathOf(url) {
  const u = String(url || '');
  if (u.startsWith('/assets/')) return path.join(ASSET_DIR, path.basename(u));
  if (u.startsWith('/videos/')) return path.join(VIDEO_DIR, path.basename(u));
  return null;
}
async function comfyUpload(cc, filePath) {
  const fd = new FormData();
  fd.append('image', new Blob([fs.readFileSync(filePath)]), path.basename(filePath));
  fd.append('overwrite', 'true');
  const r = await fetch(cc.base + '/upload/image', { method: 'POST', body: fd });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.name) throw new Error('素材上传 ComfyUI 失败: ' + JSON.stringify(j).slice(0, 120));
  return (j.subfolder ? j.subfolder + '/' : '') + j.name;
}
const COMFY_WF_ROOT = () => path.join(comfyCfg(loadConfig()).dir, 'user', 'default', 'workflows');
app.get('/api/comfy/workflows', (req, res) => {
  const root = COMFY_WF_ROOT();
  const out = [];
  const walk = (d, rel) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.isDirectory()) walk(path.join(d, e.name), rel ? rel + '/' + e.name : e.name);
      else if (/\.json$/i.test(e.name)) out.push(rel ? rel + '/' + e.name : e.name);
    }
  };
  walk(root, '');
  // Aiden-H3 优先 + FL2VA 排前（当前唯一支持的家族）
  out.sort((a, b) => (b.startsWith('Aiden-H3/') - a.startsWith('Aiden-H3/')) || a.localeCompare(b));
  res.json({ workflows: out });
});
app.post('/api/comfy/run', async (req, res) => {
  const cfg = loadConfig();
  const cc = comfyCfg(cfg);
  const wfRel = String((req.body && req.body.workflow) || '');
  const promptText = String((req.body && req.body.prompt) || '').trim();
  const durationSec = Number((req.body && req.body.duration) || 0);
  if (!wfRel || !promptText) return res.status(400).json({ error: 'workflow 与 prompt 必填' });
  const wfPath = path.resolve(COMFY_WF_ROOT(), wfRel);
  if (!wfPath.startsWith(path.resolve(COMFY_WF_ROOT())) || !fs.existsSync(wfPath)) {
    return res.status(400).json({ error: '工作流不存在: ' + wfRel });
  }
  try {
    const up = await ensureComfy(cc);
    if (!up.ok) return res.status(502).json({ error: up.error });
    const objectInfo = await comfyObjectInfo(cc);
    const ui = JSON.parse(fs.readFileSync(wfPath, 'utf8'));
    const api = comfyConvert(ui, objectInfo);
    const remaps = comfyRemapModelPaths(api, objectInfo); // 同文件不同挂载路径 → 自愈
    // 注入：提示词 → MiniMaxH3* 节点的首个 STRING widget；时长 → 喂给数学节点的 PrimitiveFloat；种子随机
    let injected = false;
    for (const [id, node] of Object.entries(api)) {
      if (/^MiniMaxH3(ImageToVideo|ReferenceToVideo)$/.test(node.class_type)) {
        const { names } = comfyWidgetNames(objectInfo[node.class_type]);
        const strName = names.find((nm) => {
          const v = node.inputs[nm];
          return typeof v === 'string';
        });
        if (strName) { node.inputs[strName] = promptText; injected = true; }
      }
      if (node.class_type === 'RandomNoise' && typeof node.inputs.noise_seed === 'number') {
        node.inputs.noise_seed = Math.floor(Math.random() * 1e15);
      }
    }
    if (!injected) return res.status(400).json({ error: '工作流里没找到 MiniMaxH3 视频节点的提示词入口' });
    if (durationSec > 0) {
      for (const node of Object.values(api)) {
        if (node.class_type === 'PrimitiveFloat' && typeof node.inputs.value === 'number') node.inputs.value = durationSec;
      }
    }
    // 场景参考注入 v2：先喂既有 LoadImage/LoadAudio，再把剩余参考直接接进 MiniMaxH3 节点的
    // 空闲 image/audio 槽（FL2VA 的 first/last_frame 默认悬空 = 参考被完全无视——此处补上）。
    const refImages = Array.isArray(req.body && req.body.images) ? req.body.images : [];
    const refAudio = (req.body && req.body.audio) || '';
    const refWiring = [];
    const injectedIds = new Set(); // 我们刚喂过素材的节点：免疫死链修剪
    const loadImgEntries = Object.entries(api).filter(([, n]) => n.class_type === 'LoadImage');
    let usedImages = 0;
    for (let i = 0; i < loadImgEntries.length && usedImages < refImages.length; i++) {
      const p = comfyLocalPathOf(refImages[usedImages]);
      if (p && fs.existsSync(p)) {
        loadImgEntries[i][1].inputs.image = await comfyUpload(cc, p);
        injectedIds.add(String(loadImgEntries[i][0]));
        refWiring.push(`参考图${usedImages + 1} → 工作流 LoadImage`);
      }
      usedImages++;
    }
    let audioUsed = false;
    let audioLocalPath = '';
    if (refAudio) {
      const laEntry = Object.entries(api).find(([, n]) => n.class_type === 'LoadAudio');
      const p = comfyLocalPathOf(refAudio);
      if (laEntry && p && fs.existsSync(p)) {
        laEntry[1].inputs.audio = await comfyUpload(cc, p);
        injectedIds.add(String(laEntry[0]));
        refWiring.push('参考音频 → 工作流 LoadAudio');
        audioUsed = true;
        audioLocalPath = p;
      }
    }
    const uiNodesById = {};
    for (const n of ui.nodes || []) uiNodesById[String(n.id)] = n;
    let injSeq = 0;
    for (const [nid, node] of Object.entries(api)) {
      if (!/^MiniMaxH3(ImageToVideo|ReferenceToVideo)$/.test(node.class_type)) continue;
      const uiNode = uiNodesById[nid] || { inputs: [] };
      // ⚠ ref_videos.ref_video_0 的类型也是 IMAGE，但它要的是「≥5 帧的视频」——
      // 往里塞单张静图会在执行期炸「H3 reference videos need at least 5 frames」。按名字排除一切 video 槽。
      const freeImgIns = (uiNode.inputs || []).filter((i) => i.type === 'IMAGE' && i.link == null
        && !(i.name in node.inputs) && !/video/i.test(i.name));
      for (const inp of freeImgIns) {
        if (usedImages >= refImages.length) break;
        const p = comfyLocalPathOf(refImages[usedImages]);
        if (p && fs.existsSync(p)) {
          const name = await comfyUpload(cc, p);
          const lid = 'atelier_img_' + (++injSeq);
          api[lid] = { class_type: 'LoadImage', inputs: { image: name } };
          injectedIds.add(lid);
          node.inputs[inp.name] = [lid, 0];
          refWiring.push(`参考图${usedImages + 1} → ${inp.name}`);
        }
        usedImages++;
      }
      if (refAudio && !audioUsed) {
        // 同理跳过 ref_video_audios.*（那是参考视频自带的音轨槽，不是独立参考音频）
        const freeAud = (uiNode.inputs || []).find((i) => i.type === 'AUDIO' && i.link == null
          && !(i.name in node.inputs) && !/video/i.test(i.name));
        const p = comfyLocalPathOf(refAudio);
        if (freeAud && p && fs.existsSync(p)) {
          const name = await comfyUpload(cc, p);
          const aid = 'atelier_aud_' + (++injSeq);
          api[aid] = { class_type: 'LoadAudio', inputs: { audio: name } };
          injectedIds.add(aid);
          node.inputs[freeAud.name] = [aid, 0];
          refWiring.push('参考音频 → ' + freeAud.name);
          audioUsed = true;
          audioLocalPath = p;
        }
      }
    }
    // 🩹 自愈：夹裁剪窗（参考音频短于工作流预设时）→ 再修剪失效素材的死链（R2V 无参考音频即断开）
    const repairs = (audioLocalPath ? comfyFitAudioTrim(api, comfyAudioSeconds(audioLocalPath)) : [])
      .concat(comfyPruneDeadLoaders(api, objectInfo, null, injectedIds));
    const hasOutput = Object.values(api).some((n) => /SaveVideo|VHS_VideoCombine|CreateVideo|SaveAnimatedWEBP|SaveWEBM/.test(n.class_type));
    if (!hasOutput) {
      return res.status(400).json({ error: '这个工作流缺的素材太多，修剪后连出片节点都没了 — 换一个带 ✓/🖼 的工作流，或补齐它引用的文件', repairs, refWiring });
    }
    // 🔬 干跑：只组装不排队 — 检查参考接线与最终图（前端与 E2E 用）
    if (req.body && req.body.dryRun) {
      return res.json({ dryRun: true, nodeCount: Object.keys(api).length, refWiring, remaps, repairs });
    }
    const r = await fetch(cc.base + '/prompt', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: api, client_id: 'atelier452' }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(502).json({ error: 'ComfyUI 拒绝工作流: ' + JSON.stringify(j.node_errors || j.error || j).slice(0, 500) });
    // 200 也可能带 node_errors（无效节点被剔除后「部分执行」）——那会静默丢掉出片节点，必须当失败
    if (j.node_errors && Object.keys(j.node_errors).length) {
      return res.status(502).json({ error: 'ComfyUI 剔除了无效节点（会导致没有成片）: ' + JSON.stringify(j.node_errors).slice(0, 500) });
    }
    comfyCtl.jobs[j.prompt_id] = { workflow: wfRel, at: Date.now() };
    res.json({ promptId: j.prompt_id, started: up.started, remaps, refWiring, repairs });
  } catch (e) {
    res.status(502).json({ error: String(e && e.message || e).slice(0, 400) });
  }
});
app.get('/api/comfy/status/:id', async (req, res) => {
  const cfg = loadConfig();
  const cc = comfyCfg(cfg);
  const id = req.params.id;
  try {
    const h = await (await fetch(cc.base + '/history/' + id)).json();
    if (!h[id]) {
      const q = await (await fetch(cc.base + '/queue')).json();
      const inRun = (q.queue_running || []).some((x) => x[1] === id);
      const pos = (q.queue_pending || []).findIndex((x) => x[1] === id);
      // 既不在历史也不在队列 = ComfyUI 重启过、任务已蒸发——别让前端永远转圈
      if (!inRun && pos < 0) {
        return res.json({ done: true, ok: false, lost: true, error: '任务已不在 ComfyUI 里（进程重启过，这次出片丢失）— 重新点一次出片即可，会自动重排' });
      }
      return res.json({ done: false, running: inRun, queuePos: pos >= 0 ? pos + 1 : null });
    }
    const entry = h[id];
    if (entry.status && entry.status.status_str === 'error') {
      const msg = JSON.stringify((entry.status.messages || []).slice(-2)).slice(0, 400);
      return res.json({ done: true, ok: false, error: 'ComfyUI 执行失败: ' + msg });
    }
    // 收集视频产物 → 拷到 D:\MINIMAX H3 GENS + 应用视频库（可直接在历史播放器看）
    const files = [];
    for (const out of Object.values(entry.outputs || {})) {
      for (const arr of Object.values(out)) {
        if (!Array.isArray(arr)) continue;
        for (const f of arr) {
          if (f && f.filename && /\.(mp4|webm|mov|avi|mkv)$/i.test(f.filename)) files.push(f);
        }
      }
    }
    if (!files.length) return res.json({ done: true, ok: false, error: '执行完成但没找到视频产物' });
    fs.mkdirSync(cc.saveDir, { recursive: true });
    const job = comfyCtl.jobs[id] || {};
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const saved = [];
    let appUrl = '';
    for (const f of files) {
      // 产物可能落 output 也可能落 temp（VHS_VideoCombine save_output=false 时 type:'temp'）；
      // 条目自带 fullpath 时最可靠，优先用
      const candidates = [
        f.fullpath,
        path.join(cc.dir, f.type === 'temp' ? 'temp' : 'output', f.subfolder || '', f.filename),
        path.join(cc.dir, 'output', f.subfolder || '', f.filename),
        path.join(cc.dir, 'temp', f.subfolder || '', f.filename),
      ].filter(Boolean);
      const src = candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
      if (!src) continue;
      const base = 'MiniMaxH3_' + String(job.workflow || 'gen').replace(/.*\//, '').replace(/\.json$/i, '') + '_' + stamp + path.extname(f.filename);
      const dst = path.join(cc.saveDir, base);
      fs.copyFileSync(src, dst);
      saved.push(dst);
      try {
        fs.mkdirSync(VIDEO_DIR, { recursive: true });
        fs.copyFileSync(src, path.join(VIDEO_DIR, base));
        if (!appUrl) appUrl = '/videos/' + base;
      } catch {}
    }
    if (!saved.length) return res.json({ done: true, ok: false, error: '产物文件不在 ComfyUI output/temp 目录（可能已被清理）— 重跑一次即可' });
    res.json({ done: true, ok: true, saved, url: appUrl });
  } catch (e) {
    // ComfyUI 连不上（掉线/被杀）——按丢失结案，别让前端无限「处理中」
    if (/fetch failed|ECONNREFUSED|aborted/i.test(String(e && e.message || e))) {
      return res.json({ done: true, ok: false, lost: true, error: 'ComfyUI 已不在运行（这次出片丢失）— 重新点一次出片即可，会自动拉起' });
    }
    res.status(502).json({ error: String(e && e.message || e).slice(0, 300) });
  }
});
// 🩺 工作流体检：逐个转换 + 对照 schema 的可选清单查缺（模型文件/输入文件/缺节点），不排队不占 GPU
let comfyHealthCache = { at: 0, data: null };
app.get('/api/comfy/health', async (req, res) => {
  if (comfyHealthCache.data && Date.now() - comfyHealthCache.at < 60000) return res.json(comfyHealthCache.data);
  const cc = comfyCfg(loadConfig());
  const up = await ensureComfy(cc);
  if (!up.ok) return res.status(502).json({ error: up.error });
  let objectInfo;
  try { objectInfo = await comfyObjectInfo(cc); } catch (e) { return res.status(502).json({ error: errStr(e) }); }
  const root = COMFY_WF_ROOT();
  const report = [];
  const files = [];
  const walk = (d, rel) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.isDirectory()) walk(path.join(d, e.name), rel ? rel + '/' + e.name : e.name);
      else if (/\.json$/i.test(e.name)) files.push(rel ? rel + '/' + e.name : e.name);
    }
  };
  walk(root, '');
  for (const rel of files) {
    const issues = [];
    let refsOnly = false;
    let remaps = [];
    try {
      const ui = JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
      const api = comfyConvert(ui, objectInfo);
      remaps = comfyRemapModelPaths(api, objectInfo);
      // 与出片时同款自愈：失效的参考音频链会被自动断开，体检不该再把它算成问题
      comfyPruneDeadLoaders(api, objectInfo, ['LoadAudio']);
      for (const node of Object.values(api)) {
        const specs = { ...((objectInfo[node.class_type].input || {}).required || {}), ...((objectInfo[node.class_type].input || {}).optional || {}) };
        for (const [name, val] of Object.entries(node.inputs)) {
          if (typeof val !== 'string') continue;
          const spec = specs[name];
          const t = Array.isArray(spec) ? spec[0] : null;
          const options = Array.isArray(t) ? t : (t === 'COMBO' && spec[1] && Array.isArray(spec[1].options) ? spec[1].options : null);
          if (options && options.length && !options.includes(val)) {
            // LoadImage/LoadAudio 的缺文件在出片时会被场景参考自动顶掉 → 软问题
            if ((node.class_type === 'LoadImage' && name === 'image') || (node.class_type === 'LoadAudio' && name === 'audio')) {
              issues.push(`带上场景参考即可跑（工作流里存的 ${val} 已不在）`);
            } else {
              issues.push(`缺文件/选项 ${node.class_type}.${name}: ${val}`);
            }
          }
        }
      }
      refsOnly = issues.length > 0 && issues.every((x) => x.startsWith('带上场景参考'));
    } catch (e) { issues.push(errStr(e).slice(0, 160)); }
    report.push({ workflow: rel, ok: !issues.length, refsOnly, issues, remaps });
  }
  comfyHealthCache = { at: Date.now(), data: { report } };
  res.json({ report });
});
function errStr(e) { return String(e && e.message || e); }
// ⏹ 终止：排队中→出队；渲染中→interrupt；ComfyUI 掉线→本就没了，一样算成功
app.post('/api/comfy/cancel', async (req, res) => {
  const cc = comfyCfg(loadConfig());
  const id = String((req.body && req.body.promptId) || '');
  if (!id) return res.status(400).json({ error: 'promptId 必填' });
  let interrupted = false, dequeued = false;
  try {
    const q = await (await fetch(cc.base + '/queue')).json();
    const running = (q.queue_running || []).some((x) => x[1] === id);
    const pending = (q.queue_pending || []).some((x) => x[1] === id);
    if (pending) {
      await fetch(cc.base + '/queue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ delete: [id] }) });
      dequeued = true;
    }
    if (running) {
      await fetch(cc.base + '/interrupt', { method: 'POST' });
      interrupted = true;
    }
    res.json({ ok: true, interrupted, dequeued });
  } catch {
    res.json({ ok: true, interrupted: false, dequeued: false, note: 'ComfyUI 不在运行，任务本就不存在' });
  }
});
app.post('/api/comfy/open-gens', (req, res) => {
  const cc = comfyCfg(loadConfig());
  try { fs.mkdirSync(cc.saveDir, { recursive: true }); } catch {}
  openFolderNative(cc.saveDir);
  res.json({ ok: true });
});

// ---------------- ☁ 云端出片（Wan / DashScope 异步视频）：用导入的厂商端点直接出片 ----------------
// 与本机 ComfyUI 并列的第二条出片通道。i2v 需要公网可达的参考图 → 复用既有 cloudflared 隧道。
const CLOUD_VIDEO_MODELS = [
  { id: 'wan3.0-video', label: 'Wan 3.0（真·多参考 ≤10图 · 原生音频 · 推荐）', ref: true },
  { id: 'wan2.7-i2v', label: 'Wan 2.7 图生视频（参考图驱动）', ref: true },
  { id: 'wan2.7-t2v', label: 'Wan 2.7 文生视频', ref: false },
  { id: 'wan2.5-i2v-preview', label: 'Wan 2.5 图生视频', ref: true },
  { id: 'wan2.5-t2v-preview', label: 'Wan 2.5 文生视频', ref: false },
  { id: 'wan2.2-i2v-plus', label: 'Wan 2.2 图生视频 Plus', ref: true },
  { id: 'wan2.2-i2v-flash', label: 'Wan 2.2 图生视频 Flash（最快最省）', ref: true },
  { id: 'wan2.2-t2v-plus', label: 'Wan 2.2 文生视频 Plus', ref: false },
];
const cloudJobs = {};
function cloudConn() {
  const cfg = loadConfig();
  const list = Array.isArray(cfg.connections) ? cfg.connections : [];
  const hit = list.find((c) => c && c.key && c.ds);
  return hit ? { key: hit.key, ds: String(hit.ds).replace(/\/+$/, ''), name: hit.name } : null;
}
function cloudSaveDir(cfg) { return cfg.cloudSaveDir || 'D:\\WAN CLOUD GENS'; }
app.get('/api/cloudvideo/models', (req, res) => {
  const conn = cloudConn();
  res.json({ ready: !!conn, provider: conn ? conn.name : '', models: CLOUD_VIDEO_MODELS });
});
app.post('/api/cloudvideo/run', async (req, res) => {
  const conn = cloudConn();
  if (!conn) return res.status(400).json({ error: '还没导入带 DashScope 端点的厂商密钥 — 点 🔌 用「📄 厂商密钥文件」导入' });
  const model = String((req.body && req.body.model) || 'wan2.2-i2v-flash');
  const prompt = String((req.body && req.body.prompt) || '').trim();
  const duration = Math.max(3, Math.min(10, Number((req.body && req.body.duration) || 5)));
  const imageUrl = String((req.body && req.body.image) || '');
  if (!prompt) return res.status(400).json({ error: '提示词为空' });
  const spec = CLOUD_VIDEO_MODELS.find((m) => m.id === model) || { ref: false };
  const resolution = String((req.body && req.body.resolution) || '720P');
  // 注入文本里的「参考图N」是给中文模型看的；Wan 认的是 "Image N / Video N / Audio N"（按 media 数组顺序编号）
  const citeForWan = (t) => String(t || '')
    .replace(/「参考图(\d+)」/g, 'Image $1')
    .replace(/「参考视频(\d+)」/g, 'Video $1')
    .replace(/「参考音频(\d+)」/g, 'Audio $1');
  const publish = async (u) => {
    const local = comfyLocalPathOf(u);
    if (!local || !fs.existsSync(local)) return '';
    const base = await ensureTunnel();
    const pub = base + u;
    await waitPublicReachable(pub);
    return pub;
  };
  const input = { prompt: prompt.slice(0, 3800) };
  const parameters = { duration, resolution, prompt_extend: false }; // 关掉改写：用户的提示词一字不动
  let publicNote = '';
  try {
    if (model === 'wan3.0-video') {
      // 旗舰：真·多参考（≤10 图 / 5 视频 / 5 音频），全部场景参考按 @编号顺序进 media[]
      const refs = Array.isArray(req.body && req.body.refs) ? req.body.refs : [];
      const imgs = refs.filter((r) => (r.kind || 'image') === 'image').slice(0, 10);
      const vids = refs.filter((r) => r.kind === 'video').slice(0, 5);
      const auds = refs.filter((r) => r.kind === 'audio').slice(0, 5);
      const media = [];
      for (const r of imgs) { const p = await publish(r.url); if (p) media.push({ type: 'reference_image', url: p }); }
      for (const r of vids) { const p = await publish(r.url); if (p) media.push({ type: 'reference_video', url: p }); }
      for (const r of auds) { const p = await publish(r.url); if (p) media.push({ type: 'reference_audio', url: p }); }
      if (!media.length) return res.status(400).json({ error: 'Wan 3.0 是参考驱动模型 — 场景里至少要有一份参考素材' });
      input.media = media;
      input.prompt = citeForWan(input.prompt).slice(0, 3800);
      parameters.ratio = 'adaptive';
      parameters.audio = true; // 原生音频
      publicNote = `已带 ${media.length} 份参考（图${imgs.length}/视频${vids.length}/音频${auds.length}）`;
    } else if (spec.ref) {
      // i2v 家族：官方 schema 只有单张 img_url，且是「首帧」——不是角色参考
      const pub = await publish(imageUrl);
      if (!pub) return res.status(400).json({ error: '这个模型是「图生视频」，需要场景里至少有一张参考图' });
      input.img_url = pub;
      publicNote = '首帧参考图已公开（i2v 仅支持单张首帧，要多参考请选 Wan 3.0）';
    }
  } catch (e) {
    return res.status(502).json({ error: '参考素材无法公开访问（隧道失败）：' + String(e && e.message || e).slice(0, 140) });
  }
  try {
    const r = await fetch(conn.ds + '/services/aigc/video-generation/video-synthesis', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + conn.key, 'X-DashScope-Async': 'enable' },
      body: JSON.stringify({ model, input, parameters }),
    });
    const j = await r.json().catch(() => ({}));
    const id = j.output && j.output.task_id;
    if (!r.ok || !id) return res.status(502).json({ error: '云端拒绝任务：' + JSON.stringify(j).slice(0, 300) });
    cloudJobs[id] = { model, at: Date.now() };
    res.json({ taskId: id, model, note: publicNote });
  } catch (e) {
    res.status(502).json({ error: String(e && e.message || e).slice(0, 240) });
  }
});
app.get('/api/cloudvideo/status/:id', async (req, res) => {
  const conn = cloudConn();
  if (!conn) return res.status(400).json({ error: '连接已丢失' });
  const id = req.params.id;
  try {
    const r = await fetch(conn.ds + '/tasks/' + id, { headers: { Authorization: 'Bearer ' + conn.key } });
    const j = await r.json().catch(() => ({}));
    const out = j.output || {};
    const st = out.task_status;
    if (st === 'PENDING' || st === 'RUNNING') return res.json({ done: false, state: st });
    if (st !== 'SUCCEEDED') {
      return res.json({ done: true, ok: false, error: '云端失败：' + (out.message || out.code || JSON.stringify(j).slice(0, 200)) });
    }
    const url = out.video_url;
    if (!url) return res.json({ done: true, ok: false, error: '完成但没有视频地址' });
    // 立刻落盘：OSS 链接会过期
    const cfg = loadConfig();
    const dir = cloudSaveDir(cfg);
    fs.mkdirSync(dir, { recursive: true });
    const job = cloudJobs[id] || {};
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const base = 'Wan_' + String(job.model || 'cloud').replace(/[^\w.-]/g, '') + '_' + stamp + '.mp4';
    const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
    fs.writeFileSync(path.join(dir, base), buf);
    let appUrl = '';
    try {
      fs.mkdirSync(VIDEO_DIR, { recursive: true });
      fs.writeFileSync(path.join(VIDEO_DIR, base), buf);
      appUrl = '/videos/' + base;
    } catch {}
    res.json({ done: true, ok: true, saved: [path.join(dir, base)], url: appUrl });
  } catch (e) {
    res.status(502).json({ error: String(e && e.message || e).slice(0, 240) });
  }
});
app.post('/api/cloudvideo/open-gens', (req, res) => {
  const dir = cloudSaveDir(loadConfig());
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  openFolderNative(dir);
  res.json({ ok: true });
});

// 🧠 LLM 门户面板：状态 / 配置 / 一键启动 Hermes / 连通性测试 / 任意 OpenAI 兼容端点拉模型清单
app.get('/api/llm/portal', async (req, res) => {
  const cfg = loadConfig();
  const models = await hermesFetchModels(cfg, 1500);
  res.json({
    llmProvider: cfg.llmProvider || 'auto',
    llmModel: cfg.llmModel || '',
    openaiBase: cfg.openaiBase || '',
    hasOpenaiKey: !!cfg.openaiKey,
    hasAnthropicKey: !!cfg.anthropicKey,
    hasArkKey: !!cfg.apiKey,
    hermesBase: cfg.hermesBase || 'http://127.0.0.1:8645',
    hermesModel: cfg.hermesModel || '',
    hermesInstalled: !!findHermesExe(),
    hermesRunning: !!models,
    hermesModels: models || [],
    llmSpend: cfg.llmSpend || { usd: 0, capUsd: 20 },
  });
});
app.post('/api/llm/portal/hermes/start', async (req, res) => {
  const r = await ensureHermesProxy(loadConfig());
  res.status(r.ok ? 200 : 502).json(r);
});
app.post('/api/llm/portal/models', async (req, res) => {
  // 拉任意 OpenAI 兼容端点的模型清单（BYO 门户选模型用）
  const base = String((req.body && req.body.base) || '').replace(/\/+$/, '');
  const key = String((req.body && req.body.key) || '') || (loadConfig().openaiKey || '');
  if (!/^https?:\/\//.test(base)) return res.status(400).json({ error: 'base 需为 http(s) 地址' });
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 6000);
  try {
    const r = await fetch(base + '/v1/models', { headers: key ? { Authorization: 'Bearer ' + key } : {}, signal: ctl.signal });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(502).json({ error: `HTTP ${r.status}: ${JSON.stringify(j).slice(0, 160)}` });
    res.json({ models: (j.data || []).map((m) => m.id).filter(Boolean) });
  } catch (e) {
    res.status(502).json({ error: '连不上：' + String(e && e.message || e).slice(0, 120) });
  } finally { clearTimeout(t); }
});
// 💬 与所选 LLM 通道自由对话（多轮，非流式）；可附带当前场景提示词作为工作上下文
const CHAT_SYS = '你是 Atelier 452 Director 内置的电影制作副驾，懂 Seedance/即梦等 AI 视频生成、分镜、提示词工程与电影语言（景别/机位/运镜）。'
  + '回答务实简洁，用户用什么语言就用什么语言回答；给提示词建议时直接给可粘贴的成品文本。';
app.post('/api/llm/chat', async (req, res) => {
  const cfg = loadConfig();
  let provider = (req.body && req.body.provider) || cfg.llmProvider || 'auto';
  if (provider === 'auto') {
    provider = cfg.anthropicKey ? 'anthropic' : cfg.openaiKey ? 'openai' : cfg.apiKey ? 'ark' : 'none';
  }
  if (provider === 'none') return res.status(400).json({ error: '没有可用 LLM 通道 — 点 🧠 选一个（Hermes 通道零 Key）' });
  let messages = Array.isArray(req.body && req.body.messages) ? req.body.messages : [];
  messages = messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-24)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 24000) }));
  if (!messages.length) return res.status(400).json({ error: 'messages 为空' });
  const sceneCtx = String((req.body && req.body.sceneContext) || '').slice(0, 24000);
  const sys = CHAT_SYS + (sceneCtx ? '\n\n【用户当前场景的工作内容（供参考）】\n' + sceneCtx : '');
  const t0 = Date.now();
  try {
    const reply = await llmComplete(cfg, provider, messages, sys);
    res.json({ reply, provider, ms: Date.now() - t0 });
  } catch (e) {
    res.status(502).json({ error: String(e && e.message || e).slice(0, 300), provider, ms: Date.now() - t0 });
  }
});

app.post('/api/llm/portal/test', async (req, res) => {
  // 连通性测试：一条最小补全（分钱级），证明所选通道真的能出字
  const cfg = loadConfig();
  let provider = (req.body && req.body.provider) || cfg.llmProvider || 'auto';
  if (provider === 'auto') {
    provider = cfg.anthropicKey ? 'anthropic' : cfg.openaiKey ? 'openai' : cfg.apiKey ? 'ark' : 'none';
  }
  if (provider === 'none') return res.status(400).json({ error: '没有可用通道：先选通道或填 Key（Hermes 通道零 Key）' });
  const t0 = Date.now();
  try {
    const reply = await llmComplete(cfg, provider, [{ role: 'user', content: '连通性测试。只回复两个字：就绪' }],
      '你是连通性探针，只回复"就绪"两个字，不要多话。');
    res.json({ ok: true, provider, reply: String(reply).trim().slice(0, 60), ms: Date.now() - t0 });
  } catch (e) {
    res.status(502).json({ ok: false, provider, error: String(e && e.message || e).slice(0, 300), ms: Date.now() - t0 });
  }
});

async function llmComplete(cfg, provider, messages, systemPrompt) {
  const sys = systemPrompt || SCRIPT_AGENT_SYS;
  if (provider === 'anthropic') {
    // 硬顶闸门：达到上限即拒绝，任何一分钱都不再花
    const spend = getLlmSpend();
    if (spend.usd >= spend.capUsd) {
      throw new Error(`${CLAUDE_CAP_MSG}: 已用 $${spend.usd.toFixed(2)} / $${spend.capUsd} 上限`);
    }
    const model = cfg.llmModel || 'claude-fable-5';
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': cfg.anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 16000,
        system: sys,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      }),
    });
    const j = await r.json().catch(() => ({}));
    if (j && j.usage) trackClaudeSpend(j.model || model, j.usage); // 成功响应即计费
    if (!r.ok) throw new Error(`Claude (${model}) ${r.status}: ${JSON.stringify(j).slice(0, 260)}`);
    if (j.stop_reason === 'refusal') throw new Error(`Claude (${model}) declined the request (refusal)`);
    return (j.content || []).map((b) => b.text || '').join('');
  }
  // openai 兼容 / hermes 门户 / ark 同为 chat/completions 形状
  if (provider === 'hermes') {
    const r0 = await ensureHermesProxy(cfg); // 懒人包：没在跑就当场拉起
    if (!r0.ok) throw new Error(r0.error);
  }
  const base = provider === 'openai' ? (cfg.openaiBase || 'https://api.openai.com') + '/v1'
    : provider === 'hermes' ? (cfg.hermesBase || 'http://127.0.0.1:8645').replace(/\/+$/, '') + '/v1'
    : cfg.endpoint;
  const key = provider === 'openai' ? cfg.openaiKey : provider === 'hermes' ? 'atelier-local' : cfg.apiKey;
  const model = provider === 'hermes' ? await hermesResolveModel(cfg)
    : cfg.llmModel || (provider === 'openai' ? 'gpt-5.6-sol' : 'doubao-seed-1-6-250615');
  const r = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: sys }, ...messages],
      max_tokens: 16000,
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${provider} (${model}) ${r.status}: ${JSON.stringify(j).slice(0, 260)}`);
  return (((j.choices || [])[0] || {}).message || {}).content || '';
}

/** 启发式兜底：按剧本场景头（INT./EXT./第X场/SCENE N）正则分场，每场一镜承载原文 */
function heuristicScriptAnalysis(text) {
  const headRe = /^[ \t]*(INT\.|EXT\.|INT\/EXT|内景|外景|第[一二三四五六七八九十百0-9]+[场幕集]|场景[ \t]*[0-9０-９]+|SCENE[ \t]+[0-9]+|[0-9]+[ \t]*[.、][ \t]*(?:INT|EXT|内|外))/im;
  const lines = String(text).split(/\r?\n/);
  const scenes = [];
  let cur = null;
  for (const line of lines) {
    if (headRe.test(line)) {
      cur = { title: line.trim().slice(0, 60), body: [] };
      scenes.push(cur);
      continue;
    }
    if (!cur) {
      cur = { title: 'Scene 1', body: [] };
      scenes.push(cur);
    }
    cur.body.push(line);
  }
  const out = scenes
    .map((sc, i) => {
      const body = sc.body.join('\n').trim();
      if (!body && scenes.length > 1) return null;
      return {
        title: sc.title || `Scene ${i + 1}`,
        summary: body.slice(0, 160),
        location: '',
        timeOfDay: 'unspecified',
        weather: 'unspecified',
        shots: [{
          title: sc.title || `Shot ${i + 1}`,
          description: body.slice(0, 400),
          script: body,
          prompt: body.slice(0, 300),
          shotSize: 'MS',
          cameraMovement: 'static',
          motionDescription: '',
          emotion: '',
          durationSeconds: 5,
          characters: [],
        }],
      };
    })
    .filter(Boolean);
  return {
    title: '',
    logline: '',
    characters: [],
    locations: [],
    scenes: out.length ? out : [{
      title: 'Imported script', summary: '', location: '', timeOfDay: 'unspecified', weather: 'unspecified',
      shots: [{ title: 'Full text', description: String(text).slice(0, 400), script: String(text), prompt: String(text).slice(0, 300), shotSize: 'MS', cameraMovement: 'static', motionDescription: '', emotion: '', durationSeconds: 5, characters: [] }],
    }],
  };
}

app.post('/api/script/analyze', async (req, res) => {
  const cfg = loadConfig();
  const raw = String((req.body && req.body.text) || '').trim();
  if (!raw) return res.status(400).json({ error: 'text is empty' });
  const MAX = 100_000;
  const text = raw.length > MAX ? raw.slice(0, MAX) : raw; // 超长截断（返回体里注明）
  const truncated = raw.length > MAX;

  // 提供商选择：显式配置优先，auto 按可用密钥排序 Claude → OpenAI → Ark
  let provider = cfg.llmProvider || 'auto';
  if (provider === 'auto') {
    provider = cfg.anthropicKey ? 'anthropic' : cfg.openaiKey ? 'openai' : cfg.apiKey ? 'ark' : 'none';
  }
  if (provider === 'anthropic' && !cfg.anthropicKey) provider = 'none';
  if (provider === 'openai' && !cfg.openaiKey) provider = 'none';
  if (provider === 'ark' && !cfg.apiKey) provider = 'none';

  if (provider === 'none') {
    return res.json({ ok: true, provider: 'heuristic', truncated, note: 'no LLM key configured', analysis: heuristicScriptAnalysis(text) });
  }

  const userMsg = { role: 'user', content: `Break down the following script into the JSON schema. Script begins:\n\n${text}` };
  try {
    // Agent 循环：生成 → 解析校验 → 失败则带错误反馈修复一轮
    let reply = await llmComplete(cfg, provider, [userMsg]);
    let analysis = tolerantJsonParse(reply);
    if (!validScriptAnalysis(analysis)) {
      const repair = {
        role: 'user',
        content: `Your previous output was not valid against the schema (parse result: ${analysis ? 'missing/empty scenes[].shots[], or characters/locations/shot.characters is not a JSON array' : 'not parseable JSON'}). Previous output begins:\n${String(reply).slice(0, 1500)}\n\nOutput ONLY the corrected complete JSON object now.`,
      };
      reply = await llmComplete(cfg, provider, [userMsg, { role: 'assistant', content: String(reply).slice(0, 6000) }, repair]);
      analysis = tolerantJsonParse(reply);
    }
    if (!validScriptAnalysis(analysis)) throw new Error('LLM 两轮输出均无法解析为有效 JSON');
    const spend = getLlmSpend();
    res.json({
      ok: true, provider, model: cfg.llmModel || undefined, truncated, analysis,
      spendUsd: spend.usd, spendCap: spend.capUsd,
    });
  } catch (e) {
    // LLM 失败 → 启发式兜底，同时把简短错误带回给前端提示
    const note = String(e.message || e).replace(/\s+/g, ' ').slice(0, 160);
    const spend = getLlmSpend();
    res.json({
      ok: true, provider: 'heuristic', truncated, note,
      capped: note.includes(CLAUDE_CAP_MSG),
      spendUsd: spend.usd, spendCap: spend.capUsd,
      analysis: heuristicScriptAnalysis(text),
    });
  }
});

// 提示词库只读镜像：仅返回 promptFolders（绝不含任何密钥），供规划器 Style DNA 页浏览
app.get('/api/prompt-library', (req, res) => {
  const cfg = loadConfig();
  res.json({ ok: true, folders: Array.isArray(cfg.promptFolders) ? cfg.promptFolders : [] });
});

// ---------------- 動作分析：视频运动能量序列 + 原画帧提取（纯 ffmpeg 灰度差分，无外部依赖） ----------------
const MOTION_W = 160; // 分析分辨率：160px 宽灰度足以量化整体运动
function motionVideoPath(url) {
  const file = localFileOf(String(url || ''));
  if (!file || !fs.existsSync(file)) throw new Error('视频不存在或无法解析: ' + String(url).slice(0, 80));
  return file;
}

/** 抽灰度帧序列做相邻帧 SAD 差分 → 归一化运动能量曲线 */
app.post('/api/motion/analyze', async (req, res) => {
  try {
    if (!FFMPEG) return res.status(400).json({ error: '未找到 ffmpeg —— 動作分析需要安装 ffmpeg' });
    const file = motionVideoPath(req.body && req.body.videoUrl);
    const fps = Math.max(4, Math.min(24, Number(req.body && req.body.fps) || 12));
    // 探测时长与分辨率（竖屏也统一缩放到 160 宽）
    let duration = 0;
    if (FFPROBE) {
      const p = spawnSync(FFPROBE, ['-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
      duration = Number(String(p.stdout || '').trim()) || 0;
    }
    if (duration > 120) return res.status(400).json({ error: `视频过长（${Math.round(duration)}s）—— 動作分析上限 120 秒` });
    const args = ['-i', file, '-vf', `fps=${fps},scale=${MOTION_W}:-2,format=gray`, '-f', 'rawvideo', '-v', 'error', 'pipe:1'];
    const child = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let errTail = '';
    child.stdout.on('data', (c) => chunks.push(c));
    child.stderr.on('data', (c) => { errTail = (errTail + c.toString()).slice(-400); });
    await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error('ffmpeg 抽帧失败: ' + errTail))));
    });
    const raw = Buffer.concat(chunks);
    // 高度按 160:-2 缩放未知 → 由总字节数与帧数反推：先猜 h = raw.length / (n*W)。
    // 稳妥做法：用探测到的时长×fps 估帧数，取整除关系找出帧大小。
    const approxFrames = Math.max(1, Math.round((duration || 1) * fps));
    let frameSize = Math.round(raw.length / approxFrames);
    // frameSize 必须是 W 的倍数；修正到最近的合法值
    frameSize = Math.max(MOTION_W, Math.round(frameSize / MOTION_W) * MOTION_W);
    const n = Math.floor(raw.length / frameSize);
    if (n < 2) return res.status(400).json({ error: '视频太短，无法分析（不足 2 帧）' });
    const energyRaw = [0];
    for (let i = 1; i < n; i++) {
      const a = (i - 1) * frameSize, b = i * frameSize;
      let sad = 0;
      // 隔 2 像素采样，速度换精度损失可忽略
      for (let o = 0; o < frameSize; o += 2) sad += Math.abs(raw[b + o] - raw[a + o]);
      energyRaw.push(sad / (frameSize / 2) / 255); // 0..1 归一化
    }
    // 3 点滑动平均平滑
    const energy = energyRaw.map((v, i) => {
      const a = energyRaw[Math.max(0, i - 1)], b2 = energyRaw[Math.min(n - 1, i + 1)];
      return Math.round(((a + v + b2) / 3) * 10000) / 10000;
    });
    res.json({ ok: true, fps, duration: duration || n / fps, frames: n, energy });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e).slice(0, 300) });
  }
});

/** 按时间点批量抽帧存入 assets，返回可用作关键帧的图片 URL */
app.post('/api/motion/extract', async (req, res) => {
  try {
    if (!FFMPEG) return res.status(400).json({ error: '未找到 ffmpeg' });
    const file = motionVideoPath(req.body && req.body.videoUrl);
    const times = (Array.isArray(req.body && req.body.times) ? req.body.times : [])
      .map(Number).filter((t) => Number.isFinite(t) && t >= 0).slice(0, 40);
    if (!times.length) return res.status(400).json({ error: 'times 为空' });
    const out = [];
    for (const t of times) {
      const name = `pose_${Date.now().toString(36)}_${Math.round(t * 1000)}.jpg`;
      const dest = path.join(ASSET_DIR, name);
      const r = spawnSync(FFMPEG, ['-ss', String(t), '-i', file, '-frames:v', '1', '-q:v', '3', '-v', 'error', '-y', dest]);
      if (r.status === 0 && fs.existsSync(dest)) out.push({ t, url: '/assets/' + name });
    }
    if (!out.length) return res.status(500).json({ error: '抽帧全部失败' });
    res.json({ ok: true, frames: out });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e).slice(0, 300) });
  }
});

// ---------------- 风格参考图解读：视觉 LLM 融合全部参考图 → StyleDNA ----------------
const STYLE_DNA_KEYS = ['medium', 'qualityTarget', 'colorLanguage', 'lightingLanguage', 'lensLanguage', 'cameraRhythm', 'compositionRules', 'animationStyle', 'negativeDefaults', 'renderNotes'];

const STYLE_INTERPRET_SYS = `You are a world-class animation art director and AI-video prompt engineer. You will be shown a set of style reference images. Interpret ALL of them together — find the shared visual language across every image (medium, rendering technique, palette, light, line, texture, composition, implied motion) and COMBINE those elements into one coherent Style DNA for an AI video generator.

Output ONLY a JSON object with exactly these string fields:
{"medium": "", "qualityTarget": "", "colorLanguage": "", "lightingLanguage": "", "lensLanguage": "", "cameraRhythm": "", "compositionRules": "", "animationStyle": "", "negativeDefaults": "", "renderNotes": ""}

Field rules:
- Every field is a comma-friendly phrase cluster (8-20 words), extremely precise, zero generic filler — "masterpiece", "best quality", "4k", "trending on artstation" are banned.
- Use professional technique vocabulary where the images support it (cel two-tone shadow, line boil, halftone dot screens, subsurface scattering, gouache wash, inverted-hull outlines, animated on twos…). Never invent traits the images do not show; when images disagree, keep what is shared and note deliberate contrasts.
- negativeDefaults: what generators must avoid to protect THIS look (the failure directions opposite to the images).
- renderNotes: practical generator guidance — frame-rate feel, texture treatment, edge handling, drift risks.
- cameraRhythm: pacing/movement grammar implied by the style (used by editors, not joined into image prompts).`;

function validStyleDna(d) {
  return !!(d && typeof d === 'object' && STYLE_DNA_KEYS.every((k) => typeof d[k] === 'string') &&
    STYLE_DNA_KEYS.filter((k) => d[k].trim()).length >= 6);
}

app.post('/api/style/interpret', async (req, res) => {
  const cfg = loadConfig();
  const images = Array.isArray(req.body && req.body.images) ? req.body.images : [];
  const hint = String((req.body && req.body.hint) || '').slice(0, 500);
  const valid = images.filter((s) => typeof s === 'string' && /^data:image\/(png|jpe?g|webp|gif);base64,/.test(s)).slice(0, 20);
  if (!valid.length) return res.status(400).json({ error: 'no valid reference images (data:image/... base64, max 20)' });

  // 提供商选择与剧本智能体一致：显式配置优先，auto 按 Claude → OpenAI 排序（Ark 无视觉对话模型）
  let provider = cfg.llmProvider || 'auto';
  if (provider === 'auto' || provider === 'ark') {
    provider = cfg.anthropicKey ? 'anthropic' : cfg.openaiKey ? 'openai' : 'none';
  }
  if (provider === 'anthropic' && !cfg.anthropicKey) provider = 'none';
  if (provider === 'openai' && !cfg.openaiKey) provider = 'none';
  if (provider === 'none') {
    return res.status(400).json({ error: 'no vision-capable LLM key configured — add a Claude or OpenAI key in ⚙ API Settings' });
  }

  const instruction = `Interpret these ${valid.length} style reference images together and combine their shared elements into one Style DNA JSON.${hint ? `\nCreator's note: ${hint}` : ''}\nOutput ONLY the JSON object.`;
  const content = provider === 'anthropic'
    ? [
        ...valid.map((s) => {
          const m = s.match(/^data:(image\/(?:png|jpe?g|webp|gif));base64,(.+)$/);
          return { type: 'image', source: { type: 'base64', media_type: m[1] === 'image/jpg' ? 'image/jpeg' : m[1], data: m[2] } };
        }),
        { type: 'text', text: instruction },
      ]
    : [
        ...valid.map((s) => ({ type: 'image_url', image_url: { url: s } })),
        { type: 'text', text: instruction },
      ];

  try {
    // 一轮生成 → 解析校验 → 失败带反馈修复一轮（与剧本智能体同构）
    let reply = await llmComplete(cfg, provider, [{ role: 'user', content }], STYLE_INTERPRET_SYS);
    let dna = tolerantJsonParse(reply);
    if (!validStyleDna(dna)) {
      reply = await llmComplete(cfg, provider, [
        { role: 'user', content },
        { role: 'assistant', content: String(reply).slice(0, 4000) },
        { role: 'user', content: 'Your previous output was not a valid Style DNA JSON (all ten fields must be strings, at least six non-empty). Output ONLY the corrected complete JSON object now.' },
      ], STYLE_INTERPRET_SYS);
      dna = tolerantJsonParse(reply);
    }
    if (!validStyleDna(dna)) throw new Error('LLM 两轮输出均无法解析为有效 Style DNA JSON');
    const out = {};
    for (const k of STYLE_DNA_KEYS) out[k] = String(dna[k] || '').trim();
    const spend = getLlmSpend();
    res.json({ ok: true, provider, model: cfg.llmModel || undefined, imageCount: valid.length, dna: out, spendUsd: spend.usd, spendCap: spend.capUsd });
  } catch (e) {
    const note = String(e.message || e).replace(/\s+/g, ' ').slice(0, 300);
    const spend = getLlmSpend();
    res.status(note.includes(CLAUDE_CAP_MSG) ? 402 : 502).json({
      error: note, capped: note.includes(CLAUDE_CAP_MSG), spendUsd: spend.usd, spendCap: spend.capUsd,
    });
  }
});

// ---------------- 工程注册表（持久化在 config.json 的 projects 键；删除只删登记，绝不动磁盘文件） ----------------
const PROJECTS_BASE = path.join(BASE, 'Projects');
// Style DNA「转 JSON」保存目录：命名的风格导出（*.json），页面以更小的方块列出
const STYLE_JSON_DIR = path.join(BASE, 'Prompts', 'JSON files');
fs.mkdirSync(STYLE_JSON_DIR, { recursive: true });
const sanitizeFileName = (s) => String(s || '').replace(/[\\/:*?"<>|]/g, '_').trim();

function loadProjects() {
  const cfg = loadConfig();
  return Array.isArray(cfg.projects) ? cfg.projects : [];
}
function saveProjects(list) {
  const cfg = loadConfig();
  cfg.projects = list;
  saveConfig(cfg);
}
// 文件名冲突自动加 -2、-3 后缀
function uniquePath(p) {
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(p);
  const stem = p.slice(0, p.length - ext.length);
  for (let i = 2; ; i++) {
    const cand = `${stem}-${i}${ext}`;
    if (!fs.existsSync(cand)) return cand;
  }
}

app.get('/api/projects', (req, res) => {
  res.json({ projects: loadProjects(), defaultBase: PROJECTS_BASE, appVersion: APP_VERSION });
});

// 节点色板：与 planner NODE_COLORS 保持一致，新建工程按现有数量循环取色
const PROJECT_COLORS = ['#6d8dff', '#7ee0ff', '#a06dff', '#4fd8a5', '#ffb454', '#ff6d7e'];
app.post('/api/projects', (req, res) => {
  const { name, dir, color } = req.body || {};
  const n = String(name || '').trim();
  if (!n) return res.status(400).json({ error: '缺少工程名称' });
  const target = String(dir || '').trim() || path.join(PROJECTS_BASE, sanitizeFileName(n) || 'project');
  try {
    fs.mkdirSync(target, { recursive: true });
  } catch (e) {
    return res.status(400).json({ error: '无法创建工程目录: ' + String(e.message || e) });
  }
  const now = new Date().toISOString();
  const list = loadProjects();
  const nodeColor = String(color || '').trim() || PROJECT_COLORS[list.length % PROJECT_COLORS.length];
  const project = { id: newId(), name: n, dir: target, note: '', color: nodeColor, createdAt: now, updatedAt: now };
  list.push(project);
  saveProjects(list);
  res.json({ ok: true, project });
});

app.patch('/api/projects/:id', (req, res) => {
  const list = loadProjects();
  const p = list.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: '工程不存在' });
  const { name, dir, note, color } = req.body || {};
  if (name !== undefined && String(name).trim()) p.name = String(name).trim();
  if (dir !== undefined && String(dir).trim() && String(dir).trim() !== p.dir) {
    const target = String(dir).trim();
    try {
      fs.mkdirSync(target, { recursive: true }); // 只建新目录，绝不移动/删除旧目录
    } catch (e) {
      return res.status(400).json({ error: '无法创建工程目录: ' + String(e.message || e) });
    }
    p.dir = target;
  }
  if (note !== undefined) p.note = String(note);
  if (color !== undefined) p.color = String(color);
  p.updatedAt = new Date().toISOString();
  saveProjects(list);
  res.json({ ok: true, project: p });
});

app.delete('/api/projects/:id', (req, res) => {
  const list = loadProjects();
  const next = list.filter((x) => x.id !== req.params.id);
  if (next.length === list.length) return res.status(404).json({ error: '工程不存在' });
  saveProjects(next); // 只删登记，不碰磁盘文件
  res.json({ ok: true });
});

// 在 Windows 资源管理器中打开工程目录
app.post('/api/projects/:id/open', (req, res) => {
  const p = loadProjects().find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: '工程不存在' });
  try {
    fs.mkdirSync(p.dir, { recursive: true });
    openFolderNative(p.dir); // 打开器退出码不代表失败，直接视为成功
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// 把服务器上的生成结果（/videos/... 或 /assets/...）复制进工程目录，或把提示词写成文本文件
app.post('/api/projects/:id/save', (req, res) => {
  const p = loadProjects().find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: '工程不存在' });
  const { src, kind, name, text, filename } = req.body || {};
  try {
    if (kind === 'prompt') {
      if (typeof text !== 'string' || !String(filename || '').trim()) {
        return res.status(400).json({ error: '缺少 text 或 filename' });
      }
      const dir = path.join(p.dir, 'prompts');
      fs.mkdirSync(dir, { recursive: true });
      const safe = sanitizeFileName(filename) || 'prompt.txt';
      const dest = uniquePath(path.join(dir, safe));
      fs.writeFileSync(dest, text);
      return res.json({ ok: true, savedTo: dest });
    }
    if (kind !== 'video' && kind !== 'image') {
      return res.status(400).json({ error: "kind 必须是 'video' | 'image' | 'prompt'" });
    }
    const file = typeof src === 'string' ? localFileOf(src) : null;
    if (!file) return res.status(400).json({ error: '无效的 src（仅支持 /videos/... 或 /assets/...）' });
    const baseDir = src.startsWith('/videos/') ? VIDEO_DIR : ASSET_DIR;
    const real = path.resolve(file);
    if (!real.startsWith(path.resolve(baseDir) + path.sep)) {
      return res.status(400).json({ error: '非法路径' }); // 防路径穿越
    }
    if (!fs.existsSync(real)) return res.status(404).json({ error: '源文件不存在' });
    const dir = path.join(p.dir, kind === 'video' ? 'videos' : 'images');
    fs.mkdirSync(dir, { recursive: true });
    let fname = sanitizeFileName(name) || path.basename(real);
    if (!path.extname(fname)) fname += path.extname(real);
    const dest = uniquePath(path.join(dir, fname));
    fs.copyFileSync(real, dest);
    res.json({ ok: true, savedTo: dest });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ---------------- Style DNA「转 JSON」保存库（<BASE>/Prompts/JSON files，页面以更小方块列出） ----------------
// 把 JSON 描述文件读成 { name, filename, size, savedAt }，按修改时间倒序（最新在前）
function listStyleJson() {
  let names;
  try {
    names = fs.readdirSync(STYLE_JSON_DIR);
  } catch {
    return [];
  }
  return names
    .filter((f) => f.toLowerCase().endsWith('.json'))
    .map((filename) => {
      const st = fs.statSync(path.join(STYLE_JSON_DIR, filename));
      return { name: filename.slice(0, -5), filename, size: st.size, savedAt: st.mtime.toISOString() };
    })
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

app.get('/api/style-json', (req, res) => {
  res.json({ files: listStyleJson(), dir: STYLE_JSON_DIR });
});

// 保存命名的风格 JSON：同名覆盖（重存同一份配置应更新而不是产生 -2 副本）
app.post('/api/style-json', (req, res) => {
  const { name, json } = req.body || {};
  const safe = sanitizeFileName(name);
  if (!safe) return res.status(400).json({ error: '缺少名称' });
  let text;
  if (typeof json === 'string') {
    try { JSON.parse(json); } catch (e) { return res.status(400).json({ error: '无效的 JSON: ' + String(e.message || e) }); }
    text = json;
  } else if (json && typeof json === 'object') {
    text = JSON.stringify(json, null, 2);
  } else {
    return res.status(400).json({ error: '缺少 json 内容' });
  }
  const filename = safe + '.json';
  try {
    const dest = path.join(STYLE_JSON_DIR, filename);
    fs.writeFileSync(dest, text); // 同名覆盖
    const st = fs.statSync(dest);
    res.json({ ok: true, file: { name: safe, filename, size: st.size, savedAt: st.mtime.toISOString() } });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.delete('/api/style-json/:filename', (req, res) => {
  const base = path.basename(req.params.filename || ''); // 只取文件名，防路径穿越
  if (!base || base !== req.params.filename || !base.toLowerCase().endsWith('.json')) {
    return res.status(400).json({ error: '非法文件名' });
  }
  const target = path.resolve(STYLE_JSON_DIR, base);
  if (target !== path.join(path.resolve(STYLE_JSON_DIR), base)) {
    return res.status(400).json({ error: '非法路径' });
  }
  try {
    if (!fs.existsSync(target)) return res.status(404).json({ error: '文件不存在' });
    fs.rmSync(target);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// 创建一段中割生成任务
// Artcraft 连接测试：优先查 credits 余额；credits 端点仅认网页会话时，
// 退化为上传 1×1 微图做真实 key 验证（上传免费，且确定走 API key 认证）
app.get('/api/artcraft/test', async (req, res) => {
  const cfg = loadConfig();
  if (!cfg.artcraftKey) return res.status(400).json({ error: '未配置 Artcraft API Key' });
  try {
    const r = await fetch(ARTCRAFT_API + '/v1/credits/namespace/artcraft', {
      headers: { Authorization: 'Bearer ' + cfg.artcraftKey },
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.success) {
      return res.json({ ok: true, credits: j.sum_total_credits, free: j.free_credits, monthly: j.monthly_credits, banked: j.banked_credits });
    }
    // credits 不可用（cookie-only）→ 用微图上传验证 key 本身
    const px = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const fd = new FormData();
    fd.append('uuid_idempotency_token', crypto.randomUUID());
    fd.append('file', new Blob([px], { type: 'image/png' }), 'connection-test.png');
    const up = await fetch(ARTCRAFT_API + '/v1/media_files/upload/image', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + cfg.artcraftKey },
      body: fd,
    });
    const uj = await up.json().catch(() => ({}));
    if (up.ok && uj.success) return res.json({ ok: true, credits: null });
    res.status(502).json({ error: `Artcraft 连接失败 (${up.status}): ` + JSON.stringify(uj).slice(0, 200) });
  } catch (e) {
    res.status(502).json({ error: 'Artcraft 网络不可达: ' + String(e.message || e).slice(0, 160) });
  }
});

app.post('/api/segments', async (req, res) => {
  const { first, last, prompt: userPrompt, duration, stylePrompt, actingPrompt, inbetweenPrompt } = req.body || {};
  if (!first || !last) return res.status(400).json({ error: '缺少首帧或尾帧图片' });
  const cfg = loadConfig();
  const prompt = await finalizePrompt(cfg, evergreenJoin(cfg, userPrompt)); // 常青锚点 + 中文化 + 9999 硬顶
  const id = newId();
  let firstData, lastData;
  try {
    firstData = resolveToArkImage(first);
    lastData = resolveToArkImage(last);
  } catch (e) {
    return res.status(400).json({ error: String(e.message || e) });
  }
  let bill = null;
  if (pm) {
    bill = pm.charge(req, 'segment', clampDuration(duration));
    if (!bill.ok) return res.status(402).json({ error: bill.error });
  }
  logUsedPrompt(cfg, 'segment', userPrompt);
  // Provider 优先级：Artcraft（用户显式选择）→ 失败自动回退方舟
  let fellBack = '';
  if (useArtcraftFirst(cfg)) {
    try {
      const text = [stylePrompt, inbetweenPrompt, actingPrompt, prompt].map((s) => String(s || '').trim()).filter(Boolean).join('\n');
      const startToken = await artcraftUploadImage(cfg, first);
      const endToken = await artcraftUploadImage(cfg, last);
      const acJobToken = await artcraftOmniGenerate(cfg, {
        model: artcraftModelOf(cfg), prompt: text, startToken, endToken, refTokens: [], duration,
      });
      tasks[id] = { mode: 'artcraft', status: 'running', acJobToken, cost: bill && bill.cost, uid: bill && bill.uid };
      return res.json({ id, mode: 'artcraft', status: 'running' });
    } catch (e) {
      fellBack = String(e.message || e).slice(0, 200);
      console.warn('Artcraft 分段生成失败，回退方舟:', fellBack);
    }
  }
  if (cfg.apiKey) {
    try {
      const arkId = await arkCreate(cfg, firstData, lastData, prompt, duration, stylePrompt, actingPrompt, inbetweenPrompt);
      tasks[id] = { mode: 'ark', status: 'running', arkId, cost: bill && bill.cost, uid: bill && bill.uid };
      if (fellBack) tasks[id].notice = 'Artcraft 失败已自动回退方舟: ' + fellBack;
    } catch (e) {
      if (pm && bill) pm.refund(bill.uid, bill.cost, 'create-failed');
      return res.status(502).json({ error: (fellBack ? `Artcraft 失败（${fellBack}）且方舟也失败: ` : '') + String(e.message || e) });
    }
  } else if (fellBack) {
    if (pm && bill) pm.refund(bill.uid, bill.cost, 'create-failed');
    return res.status(502).json({ error: 'Artcraft 生成失败（未配置方舟 Key 无法回退）: ' + fellBack });
  } else {
    tasks[id] = { mode: 'mock', status: 'running', cost: bill && bill.cost, uid: bill && bill.uid };
    mockGenerate(id, firstData, lastData, duration); // 后台异步
  }
  res.json({ id, mode: tasks[id].mode, status: 'running' });
});

// 预览一体生成将发送的完整提示词（不创建任务、不产生费用）
app.post('/api/whole/preview', (req, res) => {
  const { count, prompt, stylePrompt, actingPrompt, inbetweenPrompt, timings, gaps } = req.body || {};
  const cfg = loadConfig();
  const gapList = Array.isArray(gaps) ? gaps : (Array.isArray(timings) ? timings.map((s) => ({ seconds: s })) : null);
  const text = [
    (stylePrompt !== undefined ? stylePrompt : cfg.stylePrompt) || '',
    wholePromptFor(Number(count) || 0, gapList),
    (inbetweenPrompt !== undefined && inbetweenPrompt !== '' ? inbetweenPrompt : (cfg.inbetweenPrompt || DEFAULT_INBETWEEN_PROMPT)),
    (actingPrompt || '').trim(),
    evergreenJoin(cfg, prompt),
  ].map((s) => s.trim()).filter(Boolean).join('\n');
  res.json({ text: trimPromptToCap(text) }); // 预览只做 9999 硬顶（不花 LLM 翻译费）
});

// Simulate GEN：不调生成 API——产出与真实生成完全一致的出站提示词（含服务端全部注入），
// 并把参考素材按提示词编号（image1/video1/audio1…）打包进独立文件夹，供搬去其它平台
app.post('/api/director/simulate', async (req, res) => {
  try {
    const { refImages = [], refVideos = [], refAudios = [], prompt: userPrompt, duration, model, animMode, refsMeta = [] } = req.body || {};
    const cfg = loadConfig();
    // 场景私有常青：请求带 evergreen（含空串）时覆盖全局；不带则沿用 🌲 全局
    const egCfg = (req.body && typeof req.body.evergreen === 'string') ? { ...cfg, evergreen: req.body.evergreen } : cfg;
    // 与 /api/director 完全同一条出站管线：帧率注入 + 常青锚点 + 中文化开关 + 9999 硬顶
    const fullPrompt = await finalizePrompt(cfg,
      [animModePrompt(animMode === undefined ? '12fps' : animMode), evergreenJoin(egCfg, userPrompt)]
        .filter(Boolean).join('\n'));
    const stamp = new Date();
    const id = 'sim_' + stamp.toISOString().replace(/[:.]/g, '-').slice(0, 19) + '_' + newId().slice(0, 4);
    const dir = path.join(BASE, 'simulations', id);
    fs.mkdirSync(dir, { recursive: true });
    const copied = [];
    const copyList = (urls, prefix) => {
      (Array.isArray(urls) ? urls : []).forEach((u, i) => {
        const f = localFileOf(u);
        if (!f || !fs.existsSync(f)) return;
        const name = prefix + (i + 1) + (path.extname(f).toLowerCase() || '');
        fs.copyFileSync(f, path.join(dir, name));
        copied.push(name);
      });
    };
    copyList(refImages, 'image');
    copyList(refVideos, 'video');
    copyList(refAudios, 'audio');
    fs.writeFileSync(path.join(dir, 'prompt.txt'), fullPrompt, 'utf8');
    const manifest = [
      `Simulate GEN — ${stamp.toLocaleString('zh-CN', { hour12: false })}`,
      `模型: ${model || '(跟随全局档位)'} · 时长: ${duration}s · 帧率: ${animMode || '12fps'}`,
      `提示词字符数: ${fullPrompt.length}`,
      '',
      '参考素材清单（文件名 = 提示词里的编号）:',
      ...(Array.isArray(refsMeta) ? refsMeta : []).map((m) => `  ${m.file} — ${m.roleLabel || ''}${m.weight !== undefined && Number(m.weight) !== 50 ? ` · 影响力 ${m.weight}` : ''}${m.fidelity !== undefined && Number(m.fidelity) !== 50 ? ` · 忠实度 ${m.fidelity}` : ''}${m.note ? ` · 说明: ${m.note}` : ''}`),
    ];
    fs.writeFileSync(path.join(dir, 'manifest.txt'), manifest.join('\n'), 'utf8');
    res.json({ prompt: fullPrompt, folder: dir, files: copied.concat(['prompt.txt', 'manifest.txt']) });
  } catch (e) {
    res.status(500).json({ error: '模拟出片失败: ' + String(e && e.message || e).slice(0, 200) });
  }
});

// 中割一体生成的 SIMULATE GEN：走与 /api/whole 完全同一条提示词组装管线，
// 打包 关键帧（keyframe01…）+ 附加参考（image1/video1/audio1…）+ prompt.txt + manifest.txt，零 API 消耗
app.post('/api/whole/simulate', async (req, res) => {
  try {
    const { images = [], refImages = [], refVideos = [], refAudios = [], prompt: userPrompt, stylePrompt, actingPrompt, inbetweenPrompt, duration, gaps, refsMeta = [] } = req.body || {};
    if (!Array.isArray(images) || images.length < 2) return res.status(400).json({ error: '至少需要 2 张关键帧' });
    const cfg = loadConfig();
    const gapList = Array.isArray(gaps) ? gaps : null;
    const wholeText = buildWholeText(cfg, {
      images, gapList, stylePrompt, actingPrompt, inbetweenPrompt, userPrompt,
      refCounts: {
        image: (refImages || []).length,
        video: (refVideos || []).length,
        audio: (refAudios || []).length,
      },
    });
    const fullPrompt = await finalizePrompt(cfg, wholeText);
    const stamp = new Date();
    const id = 'sim_' + stamp.toISOString().replace(/[:.]/g, '-').slice(0, 19) + '_' + newId().slice(0, 4);
    const dir = path.join(BASE, 'simulations', id);
    fs.mkdirSync(dir, { recursive: true });
    const copied = [];
    const copyList = (urls, prefix, pad) => {
      (Array.isArray(urls) ? urls : []).forEach((u, i) => {
        const f = localFileOf(u);
        if (!f || !fs.existsSync(f)) return;
        const num = pad ? String(i + 1).padStart(2, '0') : String(i + 1);
        const name = prefix + num + (path.extname(f).toLowerCase() || '');
        fs.copyFileSync(f, path.join(dir, name));
        copied.push(name);
      });
    };
    copyList(images, 'keyframe', true);
    copyList(refImages, 'image');
    copyList(refVideos, 'video');
    copyList(refAudios, 'audio');
    fs.writeFileSync(path.join(dir, 'prompt.txt'), fullPrompt, 'utf8');
    const manifest = [
      `Simulate GEN（中割一体生成）— ${stamp.toLocaleString('zh-CN', { hour12: false })}`,
      `关键帧: ${images.length} 张（keyframe01…按动画顺序）· 时长: ${duration}s`,
      `提示词字符数: ${fullPrompt.length}`,
      '',
      '附加参考素材清单（文件名 = 提示词里的编号）:',
      ...(Array.isArray(refsMeta) ? refsMeta : []).map((m) => `  ${m.file} — ${m.roleLabel || ''}${m.weight !== undefined && Number(m.weight) !== 50 ? ` · 影响力 ${m.weight}` : ''}${m.fidelity !== undefined && Number(m.fidelity) !== 50 ? ` · 忠实度 ${m.fidelity}` : ''}${m.note ? ` · 说明: ${m.note}` : ''}`),
    ];
    fs.writeFileSync(path.join(dir, 'manifest.txt'), manifest.join('\n'), 'utf8');
    res.json({ prompt: fullPrompt, folder: dir, files: copied.concat(['prompt.txt', 'manifest.txt']) });
  } catch (e) {
    res.status(500).json({ error: '模拟出片失败: ' + String(e && e.message || e).slice(0, 200) });
  }
});

// ---------------- 直连出片（免 API）：给外部平台窗口喂素材的只读通道 ----------------
// 外部平台页面（Runway 等）跨源 fetch 本地素材 → 构造 File 注入其上传区。
// 仅限 simulations 目录 + 每次启动随机 token，双重锁死任意读取。
const EXTGEN_TOKEN = crypto.randomBytes(16).toString('hex');
app.get('/api/extgen/token', (req, res) => res.json({ token: EXTGEN_TOKEN }));
app.get('/api/extgen/file', (req, res) => {
  try {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (String(req.query.t || '') !== EXTGEN_TOKEN) return res.status(403).end();
    const p = path.resolve(String(req.query.path || ''));
    const simRoot = path.resolve(path.join(BASE, 'simulations'));
    if (!p.startsWith(simRoot + path.sep) || !fs.existsSync(p)) return res.status(404).end();
    const ext = path.extname(p).slice(1).toLowerCase();
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
    fs.createReadStream(p).on('error', () => res.status(404).end()).pipe(res);
  } catch { res.status(404).end(); }
});

// ---- Chrome 扩展直连：任务队列（应用排单 → 真实 Chrome 里的内容脚本认领执行）----
// 每平台一个待办位；扩展轮询认领后应用可轮询进度。CORS 全开（内容脚本从平台域发请求）。
const extgenJobs = {}; // platform -> job（未认领）
const extgenStatus = {}; // id -> {phase, detail, at}
function extgenCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
app.options(['/api/extgen/job', '/api/extgen/status'], (req, res) => { extgenCors(res); res.sendStatus(204); });
app.post('/api/extgen/queue', (req, res) => {
  const { platform, prompt, files = [], promptSelectors = [], fileSelectors = [] } = req.body || {};
  if (!platform) return res.status(400).json({ error: '缺 platform' });
  const id = newId();
  extgenJobs[platform] = { id, platform, prompt: String(prompt || ''), files, promptSelectors, fileSelectors };
  extgenStatus[id] = { phase: 'queued', detail: '', at: Date.now() };
  res.json({ id });
});
app.get('/api/extgen/job', (req, res) => {
  extgenCors(res);
  const platform = String(req.query.platform || '');
  const job = extgenJobs[platform];
  if (!job) return res.json({ job: null });
  delete extgenJobs[platform]; // 认领即出队，多个标签页不会重复填
  res.json({ job });
});
app.post('/api/extgen/status', (req, res) => {
  extgenCors(res);
  const { id, phase, detail } = req.body || {};
  if (id) extgenStatus[id] = { phase: String(phase || ''), detail: String(detail || '').slice(0, 300), at: Date.now() };
  res.json({ ok: true });
});
app.get('/api/extgen/status', (req, res) => {
  extgenCors(res);
  res.json(extgenStatus[String(req.query.id || '')] || { phase: 'unknown' });
});

// ---------------- 提示词导入：模板拆分 / LLM 增强 → CONTEXT + 铁律 + CUT + 负面 自动填充 ----------------
// mode=split：纯启发式按模板标题切分（零花费）；mode=enhance：LLM 把松散提示词增强并结构化
//（走 llmComplete —— Anthropic 通道受 $20 硬顶护栏，失败自动退回 split，永远有结果）。
const INGEST_SYS = [
  '你是 Atelier 452 的资深电影提示词工程师。用户给你一段用于 AI 视频生成的提示词草稿（任意语言、任意松散程度），',
  '你把它增强并结构化为严格 JSON。归属铁律（最高优先级，不得违反）：',
  '- 凡是段落标题含 SHOT / CUT / 镜头 / 分镜 / カット / ショット / SC+数字 之类"镜头"含义的段落 → 进 cuts，',
  '  标题的各种装饰写法一律要认（**SHOT 1 — LEVER** / ## CUT 2 / 【镜头 3】等）；',
  '  忠实沿用草稿的镜头划分、顺序与秒数（标题里的 3.5秒 / 2s 等）；标题里的小标题（如 LEVER）保留在该镜头文本开头。',
  '- 其余一切内容（包括风格规则、负面清单、任何别的标题段落与散文）→ 全部合并进 context，',
  '  一个字都不许丢、不许挪到别处。cuts 之外没有第三个去处。',
  '- 草稿完全没有镜头标题时：context 装全文增强稿，另按叙事拆 2-6 个镜头进 cuts。',
  '增强规则：保持原语言与全部原意；补足画面要素（主体/动作/镜头/光线/氛围）、术语规范化、去冗余；',
  '绝不发明草稿中不存在的剧情或角色，绝不删掉用户的具体要求；@image1/@video1 等引用原样保留。',
  '只输出一个 JSON 对象，无 markdown 围栏、无解释。',
  'JSON schema: {"context": string, "cuts": [{"text": string, "dur": number}]}（dur 没有就 0）',
].join('\n');

// 二分铁律：标题是 SHOT/CUT/镜头/分镜类 → CUT；其余一切（含任何别的标题与散文）→ 只进 CONTEXT
// 兼容各种装饰写法：**SHOT 1 — LEVER** / ## CUT 2 / 【镜头 3】 / > SHOT-4 / SC01 / 裸 CUT
const CUT_WORD = '(?:cuts?|shots?|镜头|分镜|カット|ショット|sc)';
// 带编号：关键词 + 编号 + 任意小标题（整行 ≤90 字符防误伤散文）
const CUT_HEAD_NUM_RE = new RegExp('^\\s*[*_#>【\\-—·\\s]*' + CUT_WORD + '\\s*[-—·.．#]?\\s*\\d+[^\\n]{0,70}$', 'i');
// 裸关键词：关键词后只剩装饰/冒号（"Cut to black" 这类散文不会命中）
const CUT_HEAD_BARE_RE = new RegExp('^\\s*[*_#>【\\-—·\\s]*' + CUT_WORD + '\\s*[】*_]*\\s*[:：]?\\s*$', 'i');
function isCutHead(line) { return CUT_HEAD_NUM_RE.test(line) || CUT_HEAD_BARE_RE.test(line); }
/** 标题里除关键词/编号/时长/装饰外的小标题（如 **SHOT 1 — LEVER** 的 LEVER）——保留进 CUT 首行不丢字 */
function cutHeadTitle(line) {
  let s = String(line)
    .replace(new RegExp('^\\s*[*_#>【\\-—·\\s]*' + CUT_WORD + '\\s*[-—·.．#]?\\s*\\d*', 'i'), '')
    .replace(/[（(]?\d+(?:\.\d+)?\s*(?:秒|s\b)[）)]?/ig, '')
    .replace(/[*_【】>]/g, '')
    .replace(/^[\s\-—·:：.．]+|[\s\-—·:：.．]+$/g, '')
    .trim();
  return s.length >= 2 ? s : '';
}
// 纯 CONTEXT 标签行（仅这些无信息量的标签本身丢弃，正文保留）
const CONTEXT_LABEL_RE = /^\s*(?:#+\s*|【)?\s*(?:context|scene\s*setup|情境|全局情境|全局|背景)\s*(?:】)?\s*[:：]?\s*$/i;
// 非镜头的段落标题（负面/铁律/【任意标签】/markdown 标题等）：出现即结束当前 CUT，之后内容回 CONTEXT
const GENERIC_KEYWORDS = '(?:rules?|铁律|常青|evergreen|negatives?|负面(?:提示词|清单)?|style|风格|mood|情绪|音乐|music|audio|音频|旁白|字幕|参考|notes?)';
const GENERIC_HEAD_RE = new RegExp(
  '^\\s*(?:【[^\\n】]{1,24}】[^\\n]{0,30}'            // 【任意标签】
  + '|#{1,6}\\s+\\S[^\\n]*'                          // markdown 标题
  + '|[*_]{1,3}' + GENERIC_KEYWORDS + '[*_]{1,3}[^\\n]{0,40}'  // **NEGATIVE** 装饰包裹（冒号可免）
  + '|' + GENERIC_KEYWORDS + '[^\\n]{0,24}[:：][^\\n]{0,60}'    // 裸关键词必须带冒号
  + ')\\s*$', 'i');

function ingestHeuristic(text) {
  const t = String(text || '').replace(/\r\n?/g, '\n');
  const out = { context: '', rules: '', negative: '', cuts: [] };
  const ctxParts = [];
  let curCut = null; // 当前收集中的 CUT（直到下一个镜头标题为止都算它的正文）
  const flushCut = () => {
    if (!curCut) return;
    curCut.text = curCut.lines.join('\n').trim();
    if (curCut.text) out.cuts.push({ text: curCut.text, dur: curCut.dur });
    curCut = null;
  };
  for (const line of t.split('\n')) {
    if (isCutHead(line)) {
      flushCut();
      let dur = 0;
      const dm = line.match(/(\d+(?:\.\d+)?)\s*(?:秒|s\b)/i);
      // 标题里的裸编号不当时长（CUT 3 ≠ 3 秒）：只认带单位的
      if (dm) dur = Math.min(30, Number(dm[1]) || 0);
      const title = cutHeadTitle(line);
      curCut = { lines: title ? [title] : [], dur }; // 小标题（如 LEVER）保留为 CUT 首行，不丢字
      continue;
    }
    if (curCut && GENERIC_HEAD_RE.test(line) && !CONTEXT_LABEL_RE.test(line)) {
      // CUT 正文里撞到别的段落标题（负面/铁律/任意标签）→ 该段按铁律回 CONTEXT
      flushCut();
      ctxParts.push(line);
      continue;
    }
    if (curCut) { curCut.lines.push(line); continue; }
    if (CONTEXT_LABEL_RE.test(line)) continue; // 纯 CONTEXT 标签丢弃，正文自然落入 context
    ctxParts.push(line);
  }
  flushCut();
  out.context = ctxParts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return out;
}

app.post('/api/director/ingest', async (req, res) => {
  try {
    const { text, mode } = req.body || {};
    const raw = String(text || '').trim();
    if (!raw) return res.status(400).json({ error: '内容为空' });
    if (raw.length > 20000) return res.status(400).json({ error: '内容过长（>20000 字符），请拆开导入' });
    const shape = (o) => ({
      context: String(o.context || '').trim(),
      rules: String(o.rules || '').trim(),
      negative: String(o.negative || '').trim(),
      cuts: (Array.isArray(o.cuts) ? o.cuts : []).slice(0, 12).map((c) => ({
        text: String((c && c.text) || '').trim(),
        dur: Math.max(0, Math.min(30, Number(c && c.dur) || 0)),
      })).filter((c) => c.text),
    });
    if (mode !== 'enhance') return res.json({ mode: 'split', ...shape(ingestHeuristic(raw)) });
    const cfg = loadConfig();
    // 'auto' 在别处落方舟便宜档，但其 chat 模型点可能未开通（实测 404）——
    // 增强质量优先：auto/空 → Anthropic（$20 硬顶护栏）> 方舟 > OpenAI 兼容
    let provider = cfg.llmProvider;
    if (!provider || provider === 'auto') {
      provider = cfg.anthropicKey ? 'anthropic' : (cfg.apiKey ? 'ark' : (cfg.openaiKey ? 'openai' : ''));
    }
    if (!provider) return res.json({ mode: 'split', notice: '未配置任何 LLM — 已按模板拆分（未增强）', ...shape(ingestHeuristic(raw)) });
    try {
      let reply = await llmComplete(cfg, provider, [{ role: 'user', content: raw }], INGEST_SYS);
      if (reply && typeof reply === 'object') reply = JSON.stringify(reply); // 某些通道可能已解析
      console.warn('[ingest] LLM 原始回复(前200):', String(reply).slice(0, 200));
      let parsed = null;
      try {
        const s0 = String(reply);
        const js = s0.slice(s0.indexOf('{'), s0.lastIndexOf('}') + 1); // 掐头去尾取最外层 JSON
        parsed = JSON.parse(js);
      } catch { throw new Error('LLM 输出不是合法 JSON'); }
      const r = shape(parsed);
      if (!r.context && !r.cuts.length) throw new Error('LLM 输出为空结构');
      return res.json({ mode: 'enhance', ...r });
    } catch (e) {
      return res.json({ mode: 'split', notice: '增强失败已退回模板拆分: ' + String(e && e.message || e).slice(0, 140), ...shape(ingestHeuristic(raw)) });
    }
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e).slice(0, 200) });
  }
});

// 在资源管理器中打开模拟输出目录（仅限 simulations 下，防任意路径）
app.post('/api/fs/open-folder', (req, res) => {
  try {
    const p = path.resolve(String(req.body && req.body.path || ''));
    const simRoot = path.resolve(path.join(BASE, 'simulations'));
    if (!p.startsWith(simRoot) || !fs.existsSync(p)) return res.status(400).json({ error: '只允许打开模拟输出目录' });
    openFolderNative(p);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e).slice(0, 160) });
  }
});

// 一体生成：全部关键帧一次生成一段连续动画
app.post('/api/director', async (req, res) => {
  const { firstFrame, lastFrame, refVideoUrl, refImages = [], refVideos = [], refAudios = [], prompt: userPrompt, duration, model, animMode } = req.body || {};
  // 首帧可选：纯参考素材 + 提示词即可生成（这正是 REFERENCES TOOL 的本职）
  const hasAnyInput = firstFrame || (Array.isArray(refImages) && refImages.length)
    || (Array.isArray(refVideos) && refVideos.length) || (Array.isArray(refAudios) && refAudios.length) || refVideoUrl;
  if (!hasAnyInput) return res.status(400).json({ error: '至少需要一份参考素材（图/视频/音频）或首帧' });
  const cfg = loadConfig();
  const id = newId();
  let bill = null;
  if (pm) {
    bill = pm.charge(req, 'whole', clampDurationFor(model, duration));
    if (!bill.ok) return res.status(402).json({ error: bill.error });
  }
  logUsedPrompt(cfg, 'director', userPrompt);
  // 场景私有常青：请求带 evergreen（含空串）时覆盖全局；不带则沿用 🌲 全局
  const egCfg = (req.body && typeof req.body.evergreen === 'string') ? { ...cfg, evergreen: req.body.evergreen } : cfg;
  // 动画帧率指令：本工具面向动画生产，默认 12fps 卡帧（隐藏注入，客户端可选 variable/off）
  // 出站终审：中文化解释层 + 9999 字符硬顶
  const fullPrompt = await finalizePrompt(cfg,
    [animModePrompt(animMode === undefined ? '12fps' : animMode), evergreenJoin(egCfg, userPrompt)]
      .filter(Boolean).join('\n'));
  // 参考视频总时长预检（Artcraft 能力表：2.5 ≤30s、2.0 ≤15s；超限后端直接 500，先拦下）
  {
    const vidsAll = [...(Array.isArray(refVideos) ? refVideos : []), ...(refVideoUrl ? [refVideoUrl] : [])];
    if (vidsAll.length && FFPROBE) {
      let total = 0;
      for (const u of vidsAll) {
        const f = localFileOf(u);
        if (f && fs.existsSync(f)) {
          const d = probeDurationSec(f);
          if (d) total += d;
        }
      }
      const wantArtcraft25 = String(model || '').includes('2p5')
        || (!String(model || '').startsWith('artcraft:') && isSeedance25(model || cfg.model));
      const capSec = wantArtcraft25 ? 30 : 15;
      if (total > capSec + 0.5) {
        return res.status(400).json({
          error: `参考视频总时长 ${total.toFixed(1)} 秒超过 ${wantArtcraft25 ? '2.5' : '2.0'} 档上限 ${capSec} 秒 — 请剪短或减少参考视频后重试`,
        });
      }
    }
  }
  // Provider 决策：显式 artcraft: 前缀 > 空模型时跟随全局 preferredProvider
  const wantArtcraft = String(model || '').startsWith('artcraft:')
    || (!model && useArtcraftFirst(cfg));
  const artcraftModel = String(model || '').startsWith('artcraft:')
    ? String(model).slice('artcraft:'.length)
    : artcraftModelOf(cfg);
  let fellBack = '';
  if (wantArtcraft) {
    if (!cfg.artcraftKey && String(model || '').startsWith('artcraft:')) {
      return res.status(400).json({ error: '未配置 Artcraft API Key — 在 ⚙ API 设置里粘贴 artcraft_api_... 后重试' });
    }
    if (cfg.artcraftKey) {
      try {
        const startToken = firstFrame ? await artcraftUploadImage(cfg, firstFrame) : null;
        const endToken = lastFrame ? await artcraftUploadImage(cfg, lastFrame) : null;
        const refTokens = [];
        for (const u of (Array.isArray(refImages) ? refImages : []).slice(0, 30)) {
          refTokens.push(await artcraftUploadImage(cfg, u));
        }
        const refVideoTokens = [];
        const vids = [...(Array.isArray(refVideos) ? refVideos : []), ...(refVideoUrl ? [refVideoUrl] : [])].slice(0, 10);
        for (const u of vids) refVideoTokens.push(await artcraftUploadVideo(cfg, u));
        const refAudioTokens = [];
        for (const u of (Array.isArray(refAudios) ? refAudios : []).slice(0, 10)) {
          refAudioTokens.push(await artcraftUploadAudio(cfg, u));
        }
        const genOpts = {
          model: artcraftModel,
          prompt: fullPrompt, startToken, endToken, refTokens, refVideoTokens, refAudioTokens, duration,
          generateAudio: req.body && typeof req.body.generateAudio === 'boolean' ? req.body.generateAudio : undefined,
        };
        let acJobToken;
        let degraded = '';
        try {
          acJobToken = await artcraftOmniGenerate(cfg, genOpts);
        } catch (e) {
          // 5xx + 带视频/音频参考：Artcraft 后端对某些视频素材会内部报错（重试也 500）。
          // 降级重试：只用图片参考 —— 拿到结果并明确告知，好过整单失败
          const is5xx = /\(5\d\d\)/.test(String(e.message || e));
          if (is5xx && (refVideoTokens.length || refAudioTokens.length)) {
            acJobToken = await artcraftOmniGenerate(cfg, { ...genOpts, refVideoTokens: [], refAudioTokens: [] });
            degraded = '⚠ Artcraft 后端拒绝了本次的视频/音频参考（500），已仅用图片参考完成生成。'
              + '若必须用视频参考：换一段视频（短一点/mp4）再试，或稍后重试。';
          } else {
            throw e;
          }
        }
        const acNotice = [degraded, genOpts.estCredits ? `本次预估 ${genOpts.estCredits} credits` : ''].filter(Boolean).join(' ');
        tasks[id] = { mode: 'artcraft', status: 'running', acJobToken, cost: bill && bill.cost, uid: bill && bill.uid, notice: acNotice || undefined };
        return res.json({ id, mode: 'artcraft', status: 'running', notice: acNotice || undefined });
      } catch (e) {
        fellBack = String(e.message || e).slice(0, 200);
        console.warn('Artcraft 导演生成失败，尝试回退方舟:', fellBack);
      }
    }
  }
  if (cfg.apiKey) {
    try {
      const firstDataUrl = firstFrame ? resolveToArkImage(firstFrame) : null;
      const lastDataUrl = lastFrame ? resolveToArkImage(lastFrame) : null;
      const refDataUrls = (Array.isArray(refImages) ? refImages : []).slice(0, 10).map(resolveToArkImage);
      // 参考视频必须公网 URL（与 V2V 同一隧道流程）；方舟单视频参考，多余的忽略（音频参考方舟不支持）
      const arkRefVideo = refVideoUrl || (Array.isArray(refVideos) && refVideos[0]) || null;
      let refVideoPublicUrl = null;
      if (arkRefVideo) {
        const srcFile = localFileOf(arkRefVideo);
        if (!srcFile || !fs.existsSync(srcFile)) throw new Error('参考视频不存在，请重新上传');
        let base = await ensureTunnel();
        try {
          await waitPublicReachable(base + arkRefVideo);
        } catch (err) {
          if (!tunnel.proc) throw err;
          console.warn('隧道自检失败，重建隧道:', String(err.message || err).slice(0, 120));
          try { tunnel.proc.kill(); } catch {}
          tunnel.url = null; tunnel.proc = null;
          base = await ensureTunnel();
          await waitPublicReachable(base + arkRefVideo);
        }
        refVideoPublicUrl = base + arkRefVideo;
      }
      let arkId;
      let arkNote = '';
      try {
        arkId = await arkCreateDirector(cfg, {
          firstDataUrl, lastDataUrl, refVideoPublicUrl, refDataUrls,
          text: fullPrompt, duration, model: String(model || '').startsWith('artcraft:') ? undefined : model,
        });
      } catch (e) {
        // 方舟 2.5 未开通（ModelNotOpen）→ 自动降 2.0 生成，绝不让整单死掉
        if (/ModelNotOpen/i.test(String(e.message || e))) {
          arkId = await arkCreateDirector(cfg, {
            firstDataUrl, lastDataUrl, refVideoPublicUrl, refDataUrls,
            text: fullPrompt, duration: Math.min(Number(duration) || 5, 15),
            model: 'doubao-seedance-2-0-260128',
          });
          arkNote = '⚠ 方舟账号未开通 2.5（ModelNotOpen），已自动改用 2.0 生成（时长上限 15s）。要用 2.5 请在方舟控制台开通该模型。';
        } else {
          throw e;
        }
      }
      tasks[id] = { mode: 'ark', status: 'running', arkId, cost: bill && bill.cost, uid: bill && bill.uid };
      const arkNotices = [fellBack ? 'Artcraft 失败已自动回退方舟: ' + fellBack : '', arkNote].filter(Boolean).join(' ');
      if (arkNotices) tasks[id].notice = arkNotices;
    } catch (e) {
      if (pm && bill) pm.refund(bill.uid, bill.cost, 'create-failed');
      return res.status(502).json({ error: (fellBack ? `Artcraft 失败（${fellBack}）且方舟也失败: ` : '') + String(e.message || e) });
    }
  } else if (fellBack) {
    if (pm && bill) pm.refund(bill.uid, bill.cost, 'create-failed');
    return res.status(502).json({ error: 'Artcraft 生成失败（未配置方舟 Key 无法回退）: ' + fellBack });
  } else {
    // 无 key：可用图片（首帧/尾帧/参考图）交叉溶解模拟
    const files = [];
    try {
      for (const u of [firstFrame, lastFrame, ...(Array.isArray(refImages) ? refImages : [])]) {
        if (!u) continue;
        const f = localFileOf(u);
        if (f && fs.existsSync(f)) files.push(f);
        if (files.length >= 4) break;
      }
      if (!files.length) throw new Error('没有可用的图片输入');
      if (files.length < 2) files.push(files[0]);
    } catch (e) {
      if (pm && bill) pm.refund(bill.uid, bill.cost, 'create-failed');
      return res.status(400).json({ error: String(e.message || e) });
    }
    tasks[id] = { mode: 'mock', status: 'running', cost: bill && bill.cost, uid: bill && bill.uid };
    mockWhole(id, files, clampDurationFor(model, duration));
  }
  res.json({ id, mode: tasks[id].mode, status: 'running' });
});

// 一体生成的提示词组装（真实生成与 SIMULATE GEN 共用同一条管线）
// refCount>0 时插入「附加参考图」编号桥接段：关键帧是图片1—N，附加参考是图片N+1—N+M，
// 并声明下文「参考图K」即指第 K 张附加参考 —— 客户端注入的使用说明按这个约定写。
function buildWholeText(cfg, { images, gapList, stylePrompt, actingPrompt, inbetweenPrompt, userPrompt, refCounts }) {
  const n = images.length;
  const rc = refCounts || {};
  const bridge = [];
  if (rc.image) {
    bridge.push(`除上述 ${n} 张关键帧外，另附 ${rc.image} 张额外参考图，按顺序排在关键帧之后（即图片${n + 1}—图片${n + rc.image}）。` +
      `下文「参考图K」即指其中第 K 张附加参考图（参考图1=图片${n + 1}，依此类推）。` +
      `附加参考图不是关键帧：绝不作为动画序列中的姿势节点，只按下文使用说明作风格/角色/道具等参考。`);
  }
  if (rc.video) bridge.push(`另附 ${rc.video} 段参考视频，下文「参考视频K」按附带顺序对应。`);
  if (rc.audio) bridge.push(`另附 ${rc.audio} 段参考音频，下文「参考音频K」按附带顺序对应。`);
  return [
    (stylePrompt !== undefined ? stylePrompt : cfg.stylePrompt) || '',
    wholePromptFor(n, gapList),
    bridge.join('\n'),
    // 中割运动指令：永远注入
    (inbetweenPrompt !== undefined && inbetweenPrompt !== ''
      ? inbetweenPrompt
      : (cfg.inbetweenPrompt || DEFAULT_INBETWEEN_PROMPT)),
    (actingPrompt || '').trim(),
    evergreenJoin(cfg, userPrompt),
  ].map((s) => s.trim()).filter(Boolean).join('\n');
}

app.post('/api/whole', async (req, res) => {
  const { images = [], refImages = [], refVideos = [], refAudios = [], prompt: userPrompt, stylePrompt, actingPrompt, inbetweenPrompt, duration, timings, gaps } = req.body || {};
  const gapList = Array.isArray(gaps) ? gaps : (Array.isArray(timings) ? timings.map((s) => ({ seconds: s })) : null);
  if (!Array.isArray(images) || images.length < 2) return res.status(400).json({ error: '至少需要 2 张关键帧' });
  if (images.length > 100) return res.status(400).json({ error: '最多 100 张关键帧' });
  const refImgs = Array.isArray(refImages) ? refImages : [];
  const refVids = Array.isArray(refVideos) ? refVideos : [];
  const refAuds = Array.isArray(refAudios) ? refAudios : [];
  const cfg = loadConfig();
  const id = newId();
  let bill = null;
  if (pm) {
    bill = pm.charge(req, 'whole', clampDuration(duration));
    if (!bill.ok) return res.status(402).json({ error: bill.error });
  }
  logUsedPrompt(cfg, 'whole', userPrompt);
  if (Array.isArray(gaps)) for (const g of gaps) logUsedPrompt(cfg, 'gap', g && g.prompt);
  // 参考视频总时长预检（与导演生成同一条规则：2.5 ≤30s、2.0 ≤15s，超限先拦）
  if (refVids.length && FFPROBE) {
    let total = 0;
    for (const u of refVids) {
      const f = localFileOf(u);
      if (f && fs.existsSync(f)) { const d = probeDurationSec(f); if (d) total += d; }
    }
    const is25 = useArtcraftFirst(cfg) ? /2p5/.test(artcraftModelOf(cfg)) : isSeedance25(cfg.model);
    const capSec = is25 ? 30 : 15;
    if (total > capSec + 0.5) {
      if (pm && bill) pm.refund(bill.uid, bill.cost, 'create-failed');
      return res.status(400).json({ error: `参考视频总时长 ${total.toFixed(1)} 秒超过当前档上限 ${capSec} 秒 — 请剪短或减少参考视频后重试` });
    }
  }
  const wholeText = buildWholeText(cfg, {
    images, gapList, stylePrompt, actingPrompt, inbetweenPrompt, userPrompt,
    refCounts: { image: refImgs.length, video: refVids.length, audio: refAuds.length },
  });
  const wholeFinal = await finalizePrompt(cfg, wholeText);
  // Provider 优先级：Artcraft → 失败自动回退方舟
  let fellBack = '';
  if (useArtcraftFirst(cfg)) {
    try {
      const refTokens = [];
      for (const u of images.slice(0, 30)) refTokens.push(await artcraftUploadImage(cfg, u));
      // 附加参考图排在关键帧之后，同一个 30 张图片总池（关键帧优先）
      const refRoom = Math.max(0, 30 - Math.min(images.length, 30));
      for (const u of refImgs.slice(0, refRoom)) refTokens.push(await artcraftUploadImage(cfg, u));
      const refVideoTokens = [];
      for (const u of refVids.slice(0, 10)) refVideoTokens.push(await artcraftUploadVideo(cfg, u));
      const refAudioTokens = [];
      for (const u of refAuds.slice(0, 10)) refAudioTokens.push(await artcraftUploadAudio(cfg, u));
      const genOpts = { model: artcraftModelOf(cfg), prompt: wholeFinal, refTokens, refVideoTokens, refAudioTokens, duration };
      let acJobToken;
      let degraded = '';
      try {
        acJobToken = await artcraftOmniGenerate(cfg, genOpts);
      } catch (e) {
        // 与导演生成同款降级：5xx + 带视频/音频参考 → 只用图片参考重试
        const is5xx = /\(5\d\d\)/.test(String(e.message || e));
        if (is5xx && (refVideoTokens.length || refAudioTokens.length)) {
          acJobToken = await artcraftOmniGenerate(cfg, { ...genOpts, refVideoTokens: [], refAudioTokens: [] });
          degraded = '⚠ Artcraft 后端拒绝了本次的视频/音频参考（500），已仅用关键帧+图片参考完成生成。';
        } else {
          throw e;
        }
      }
      const trimmed = refImgs.length > refRoom ? `⚠ 图片总池 30 张已满：${refImgs.length - refRoom} 张附加参考图被跳过（关键帧优先）。` : '';
      const acNotice = [degraded, trimmed].filter(Boolean).join(' ');
      tasks[id] = { mode: 'artcraft', status: 'running', acJobToken, cost: bill && bill.cost, uid: bill && bill.uid, notice: acNotice || undefined };
      return res.json({ id, mode: 'artcraft', status: 'running', notice: acNotice || undefined });
    } catch (e) {
      fellBack = String(e.message || e).slice(0, 200);
      console.warn('Artcraft 一体生成失败，回退方舟:', fellBack);
    }
  }
  if (cfg.apiKey) {
    try {
      const imageDataUrls = images.map(resolveToArkImage);
      // 方舟图片总池：2.5=30 张、2.0=9 张；关键帧优先，附加参考图占余位；视频/音频参考方舟一体生成不支持
      const arkPool = isSeedance25(cfg.model) ? 30 : 9;
      const arkRefRoom = Math.max(0, arkPool - images.length);
      const refDataUrls = refImgs.slice(0, arkRefRoom).map(resolveToArkImage);
      const arkId = await arkCreateWhole(cfg, imageDataUrls, sanitizeForArk(wholeFinal), duration, refDataUrls);
      tasks[id] = { mode: 'ark', status: 'running', arkId, cost: bill && bill.cost, uid: bill && bill.uid };
      const arkNotices = [
        fellBack ? 'Artcraft 失败已自动回退方舟: ' + fellBack : '',
        refImgs.length > arkRefRoom ? `⚠ 方舟图片总池 ${arkPool} 张已满：${refImgs.length - arkRefRoom} 张附加参考图被跳过（关键帧优先）` : '',
        (refVids.length || refAuds.length) ? '⚠ 方舟一体生成不支持视频/音频参考，本次已忽略（Artcraft 通道支持）' : '',
      ].filter(Boolean);
      if (arkNotices.length) tasks[id].notice = arkNotices.join('；');
    } catch (e) {
      if (pm && bill) pm.refund(bill.uid, bill.cost, 'create-failed');
      return res.status(502).json({ error: (fellBack ? `Artcraft 失败（${fellBack}）且方舟也失败: ` : '') + String(e.message || e) });
    }
  } else if (fellBack) {
    if (pm && bill) pm.refund(bill.uid, bill.cost, 'create-failed');
    return res.status(502).json({ error: 'Artcraft 生成失败（未配置方舟 Key 无法回退）: ' + fellBack });
  } else {
    const files = [];
    try {
      for (const u of images) {
        const f = localFileOf(u);
        if (!f || !fs.existsSync(f)) throw new Error('关键帧文件缺失: ' + u);
        files.push(f);
      }
    } catch (e) {
      if (pm && bill) pm.refund(bill.uid, bill.cost, 'create-failed');
      return res.status(400).json({ error: String(e.message || e) });
    }
    tasks[id] = { mode: 'mock', status: 'running', cost: bill && bill.cost, uid: bill && bill.uid };
    mockWhole(id, files, duration);
  }
  res.json({ id, mode: tasks[id].mode, status: 'running' });
});

// 原画精修：草稿/tie-down → 完成版线稿（Seedream 图生图，同步返回）
app.post('/api/refine', async (req, res) => {
  const { image, prompt, refs = [] } = req.body || {};
  if (!image) return res.status(400).json({ error: '缺少源图片' });
  const cfg = loadConfig();
  const id = newId();
  // 隐藏系统指令永远前置；用户可见的精修提示词与补充描述随后；常青锚点收尾
  const fullPrompt = await finalizePrompt(cfg,
    [GENGA_SYSTEM_PROMPT, (prompt || cfg.refinePrompt || '').trim(), evergreenText(cfg)]
      .filter(Boolean).join('\n'));
  logUsedPrompt(cfg, 'refine', prompt);
  let bill = null;
  if (pm) {
    bill = pm.charge(req, 'refine');
    if (!bill.ok) return res.status(402).json({ error: bill.error });
  }
  const refundBill = () => { if (pm && bill) pm.refund(bill.uid, bill.cost, 'refine-failed'); };
  const provider = cfg.imgProvider || 'ark';
  if (provider === 'openai' && cfg.openaiKey) {
    // GPT Image 2（OpenAI 兼容 Images API：/v1/images/edits，multipart）
    try {
      let buf, mime = 'image/png';
      const local = localFileOf(image);
      if (local) {
        buf = fs.readFileSync(local);
        mime = MIME[path.extname(local).slice(1).toLowerCase()] || 'image/png';
      } else {
        const m = /^data:(image\/[\w.+-]+);base64,(.+)$/s.exec(image);
        if (!m) throw new Error('无效的源图片');
        mime = m[1];
        buf = Buffer.from(m[2], 'base64');
      }
      const fd = new FormData();
      fd.append('model', cfg.openaiImgModel || 'gpt-image-2');
      fd.append('prompt', fullPrompt);
      fd.append('image[]', new Blob([buf], { type: mime }), 'source.png');
      // 角色设定/色卡参考图（多图输入）
      for (let i = 0; i < refs.length && i < 6; i++) {
        const du = resolveToDataUrl(refs[i]);
        const rm = /^data:(image\/[\w.+-]+);base64,(.+)$/s.exec(du);
        if (rm) fd.append('image[]', new Blob([Buffer.from(rm[2], 'base64')], { type: rm[1] }), `ref${i}.png`);
      }
      let r;
      try {
        r = await fetch(cfg.openaiBase + '/v1/images/edits', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + cfg.openaiKey },
          body: fd,
        });
      } catch (e) {
        const code = (e.cause && e.cause.code) || e.message;
        throw new Error(`无法连接 ${cfg.openaiBase}（${code}）。` +
          `大陆网络直连官方 api.openai.com 需要代理；或在 API 设置里把接口地址换成 OpenAI 兼容中转站的基址。`);
      }
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`GPT Image 精修失败 (${r.status}): ` + JSON.stringify(j.error || j).slice(0, 400));
      const item = j.data && j.data[0];
      if (!item) throw new Error('响应缺少图片数据');
      const file = 'refine_' + id + '.png';
      if (item.b64_json) {
        fs.writeFileSync(path.join(ASSET_DIR, file), Buffer.from(item.b64_json, 'base64'));
      } else if (item.url) {
        const ir = await fetch(item.url);
        if (!ir.ok) throw new Error('下载精修结果失败: ' + ir.status);
        fs.writeFileSync(path.join(ASSET_DIR, file), Buffer.from(await ir.arrayBuffer()));
      } else {
        throw new Error('响应既无 b64_json 也无 url');
      }
      return res.json({ url: '/assets/' + file });
    } catch (e) {
      refundBill();
      return res.status(502).json({ error: String(e.message || e) });
    }
  }
  if (cfg.apiKey && provider === 'ark') {
    try {
      const r = await fetch(cfg.endpoint + '/images/generations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
        body: JSON.stringify({
          model: cfg.imgModel,
          prompt: fullPrompt,
          image: refs.length
            ? [resolveToDataUrl(image), ...refs.slice(0, 6).map(resolveToDataUrl)]
            : resolveToDataUrl(image),
          size: '2K',
          response_format: 'url',
          watermark: false,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`Seedream 精修失败 (${r.status}): ` + JSON.stringify(j).slice(0, 400));
      const remote = j.data && j.data[0] && j.data[0].url;
      if (!remote) throw new Error('响应缺少图片 URL: ' + JSON.stringify(j).slice(0, 200));
      const file = 'refine_' + id + '.png';
      const ir = await fetch(remote);
      if (!ir.ok) throw new Error('下载精修结果失败: ' + ir.status);
      fs.writeFileSync(path.join(ASSET_DIR, file), Buffer.from(await ir.arrayBuffer()));
      res.json({ url: '/assets/' + file });
    } catch (e) {
      refundBill();
      res.status(502).json({ error: String(e.message || e) });
    }
  } else {
    // 本地模拟：灰度 + 提对比 + 锐化，近似"清线"效果
    try {
      let src = localFileOf(image);
      if (!src) {
        src = path.join(TMP_DIR, id + '_src.png');
        dataUrlToFile(image, src);
      }
      const out = path.join(ASSET_DIR, 'refine_' + id + '.png');
      await runFfmpeg(['-y', '-i', src, '-vf',
        'format=gray,eq=contrast=1.6:brightness=0.06,unsharp=7:7:1.1,format=rgba',
        '-frames:v', '1', out]);
      res.json({ url: '/assets/refine_' + id + '.png' });
    } catch (e) {
      refundBill();
      res.status(500).json({ error: String(e.message || e) });
    }
  }
});

// 视频转视频（上色/转绘）任务
app.post('/api/v2v', async (req, res) => {
  const { videoUrl, refs = [], prompt: userPrompt, colorPrompt, duration } = req.body || {};
  const srcFile = videoUrl && localFileOf(videoUrl);
  if (!srcFile || !fs.existsSync(srcFile)) return res.status(400).json({ error: '源视频不存在，请先上传或生成' });
  const cfg = loadConfig();
  const id = newId();
  let bill = null;
  if (pm) {
    bill = pm.charge(req, 'v2v', clampDuration(duration));
    if (!bill.ok) return res.status(402).json({ error: bill.error });
  }
  logUsedPrompt(cfg, 'v2v', userPrompt);
  const v2vText = await finalizePrompt(cfg, [
    ((colorPrompt !== undefined ? colorPrompt : cfg.colorPrompt) || '').trim(),
    evergreenJoin(cfg, userPrompt),
  ].filter(Boolean).join('\n'));
  // Provider 优先级：Artcraft（视频直接上传，无需公网隧道！）→ 失败自动回退方舟
  let fellBack = '';
  if (useArtcraftFirst(cfg)) {
    try {
      const videoToken = await artcraftUploadVideo(cfg, videoUrl);
      const refTokens = [];
      for (const u of refs.slice(0, 10)) refTokens.push(await artcraftUploadImage(cfg, u));
      // 统一走 artcraftOmniGenerate：免费预检 + omni_gen 主通道 + 5xx 重试 + 老端点兜底
      const acJobToken = await artcraftOmniGenerate(cfg, {
        model: artcraftModelOf(cfg), prompt: v2vText,
        refTokens, refVideoTokens: [videoToken], duration,
      });
      tasks[id] = { mode: 'artcraft', status: 'running', acJobToken, cost: bill && bill.cost, uid: bill && bill.uid };
      return res.json({ id, mode: 'artcraft', status: 'running' });
    } catch (e) {
      fellBack = String(e.message || e).slice(0, 200);
      console.warn('Artcraft V2V 失败，回退方舟:', fellBack);
    }
  }
  if (cfg.apiKey) {
    try {
      const text = v2vText;
      const refDataUrls = refs.map(resolveToArkImage);
      // reference_video 必须是公网 URL（Ark 明确拒绝 base64 视频）。
      // 刚建立的隧道 Cloudflare 边缘路由可能尚未生效 → 先自检可下载，再交给 Ark；
      // Ark 侧回源下载仍失败时自动重试（指数退避）。
      let base = await ensureTunnel();
      try {
        await waitPublicReachable(base + videoUrl);
      } catch (err) {
        if (!tunnel.proc) throw err;
        // 缓存的隧道已失效：杀掉重建，再自检一次
        console.warn('隧道自检失败，重建隧道:', String(err.message || err).slice(0, 120));
        try { tunnel.proc.kill(); } catch {}
        tunnel.url = null; tunnel.proc = null;
        base = await ensureTunnel();
        await waitPublicReachable(base + videoUrl);
      }
      const arkId = await arkCreateV2VWithRetry(cfg, base + videoUrl, refDataUrls, text, duration);
      tasks[id] = { mode: 'ark', status: 'running', arkId, cost: bill && bill.cost, uid: bill && bill.uid };
      if (fellBack) tasks[id].notice = 'Artcraft 失败已自动回退方舟: ' + fellBack;
    } catch (e) {
      if (pm && bill) pm.refund(bill.uid, bill.cost, 'create-failed');
      return res.status(502).json({ error: (fellBack ? `Artcraft 失败（${fellBack}）且方舟也失败: ` : '') + String(e.message || e) });
    }
  } else if (fellBack) {
    if (pm && bill) pm.refund(bill.uid, bill.cost, 'create-failed');
    return res.status(502).json({ error: 'Artcraft 生成失败（未配置方舟 Key 无法回退）: ' + fellBack });
  } else {
    tasks[id] = { mode: 'mock', status: 'running', cost: bill && bill.cost, uid: bill && bill.uid };
    mockV2V(id, srcFile);
  }
  res.json({ id, mode: tasks[id].mode, status: 'running' });
});

app.get('/api/segments/:id', async (req, res) => {
  const task = tasks[req.params.id];
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if ((task.mode === 'ark' || task.mode === 'artcraft') && task.status === 'running') {
    try {
      if (task.mode === 'artcraft') await artcraftPoll(loadConfig(), task, req.params.id);
      else await arkPoll(loadConfig(), task, req.params.id);
      task.pollFails = 0; // 只统计连续失败
      delete task.warning;
    } catch (e) {
      // 单次轮询/下载出错（网络抖动、429/5xx）不判死刑：任务在远端可能仍在跑甚至已成功
      task.pollFails = (task.pollFails || 0) + 1;
      if (task.pollFails >= 10) {
        task.status = 'failed';
        task.error = String(e.message || e);
      } else {
        task.warning = String(e.message || e); // 保持 running，下次轮询自动重试
      }
    }
  }
  // 公开站：任务失败自动退还积分（一次性）
  if (pm && task.status === 'failed' && task.cost && !task.refunded) {
    task.refunded = true;
    pm.refund(task.uid, task.cost, 'task-failed');
  }
  res.json({ status: task.status, videoUrl: task.videoUrl, error: task.error, mode: task.mode, warning: task.warning, notice: task.notice });
});

// 顺序拼接导出 mp4（统一重编码，保证不同分段能接上）
app.post('/api/concat', async (req, res) => {
  const { urls, fps } = req.body || {};
  if (!Array.isArray(urls) || urls.length === 0) return res.status(400).json({ error: '没有可拼接的分段' });
  if (!FFMPEG) return res.status(400).json({ error: '未找到 ffmpeg，请安装（winget install Gyan.FFmpeg）或设置 FFMPEG_DIR 环境变量' });
  const files = urls.map((u) => path.join(VIDEO_DIR, path.basename(u)));
  for (const f of files) if (!fs.existsSync(f)) return res.status(400).json({ error: '分段文件缺失: ' + path.basename(f) });
  const id = 'export_' + newId();
  const out = path.join(VIDEO_DIR, id + '.mp4');
  try {
    const { w, h } = probeSize(files[0]);
    const args = ['-y'];
    for (const f of files) args.push('-i', f);
    const fit = `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:white,setsar=1,fps=${Number(fps) || 24}`;
    const chains = files.map((_, i) => `[${i}:v]${fit}[v${i}]`).join(';');
    const inputs = files.map((_, i) => `[v${i}]`).join('');
    args.push('-filter_complex', `${chains};${inputs}concat=n=${files.length}:v=1:a=0,format=yuv420p`,
      '-c:v', 'libx264', '-preset', 'fast', out);
    await runFfmpeg(args);
    res.json({ url: '/videos/' + id + '.mp4' });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// webm（浏览器录制）→ mp4
app.post('/api/convert', express.raw({ type: '*/*', limit: '800mb' }), async (req, res) => {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ error: '需要原始视频字节流（请求需带 Content-Type，如 video/webm）' });
  }
  const id = 'export_' + newId();
  const src = path.join(TMP_DIR, id + '.webm');
  const out = path.join(VIDEO_DIR, id + '.mp4');
  try {
    fs.writeFileSync(src, req.body);
    await runFfmpeg(['-y', '-i', src, '-c:v', 'libx264', '-preset', 'fast', '-pix_fmt', 'yuv420p', out]);
    res.json({ url: '/videos/' + id + '.mp4' });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  } finally {
    fs.rm(src, { force: true }, () => {});
  }
});

// 全局兜底：任何路由的未捕获异常 / body 解析错误（含超限）一律返回 JSON，
// 绝不吐 Express 默认 HTML 错误页——前端因此永远能解析出 error 字段。
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const raw = String(err && err.message || err || '服务器内部错误');
  const status = err && (err.status || err.statusCode) || 500;
  const hint = err && err.type === 'entity.too.large' ? '请求体超过 300MB 上限' : '';
  res.status(status).json({ error: hint || raw.slice(0, 300) });
});

const PORT = process.env.PORT || 5893;
// 只绑回环（浏览器/Chrome 扩展/平台窗口全走 localhost）：不暴露局域网，也永远不触发防火墙管理员弹窗
app.listen(PORT, '127.0.0.1', () => {
  const cfg = loadConfig();
  console.log(`Atelier452 Magic http://localhost:${PORT}`);
  console.log(`数据目录: ${BASE}`);
  console.log(`生成模式: ${cfg.apiKey ? 'Seedance API (' + cfg.model + ')' : '本地模拟（未配置 API Key）'}`);
  console.log(`ffmpeg: ${FFMPEG || '未找到'}`);
}).on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.warn(`端口 ${PORT} 已被占用（已有实例在运行），本进程仅作为窗口壳使用`);
  } else {
    throw e;
  }
});
