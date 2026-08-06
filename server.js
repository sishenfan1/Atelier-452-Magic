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
  llmProvider: 'auto',   // 'auto' | 'anthropic' | 'openai' | 'ark'
  anthropicKey: '',
  llmModel: '',          // 留空则按提供商用默认：claude-fable-5 / gpt-5.6-sol / doubao-seed-1-6-250615
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
      const cfg = { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
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
    duration: clampDuration(duration),
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

// ---------- 导演生成：首尾帧 + 参考视频 + 参考图混合单次生成（Seedance 2.0 / 2.5） ----------
const SEEDANCE_25_MODEL = 'doubao-seedance-2-5-260628'; // 方舟模型卡已公开；API 开放即插即用
function isSeedance25(model) { return /2-5/.test(String(model || '')); }
function clampDurationFor(model, d) {
  return isSeedance25(model) ? clampDuration(d, 5, 4, 30) : clampDuration(d);
}

async function arkCreateDirector(cfg, opts) {
  const { firstDataUrl, lastDataUrl, refVideoPublicUrl, refDataUrls = [], text, duration, model } = opts;
  const safeText = sanitizeForArk(text);
  const content = [{ type: 'text', text: safeText }];
  content.push({ type: 'image_url', image_url: { url: firstDataUrl }, role: 'first_frame' });
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

async function arkCreateWhole(cfg, imageDataUrls, text, duration) {
  const safeText = sanitizeForArk(text);
  const content = [{ type: 'text', text: safeText }];
  for (const img of imageDataUrls) {
    content.push({ type: 'image_url', image_url: { url: img }, role: 'reference_image' });
  }
  const body = {
    model: cfg.model,
    content,
    duration: clampDuration(duration),
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
    duration: clampDuration(duration),
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
filesApp.listen(FILES_PORT).on('error', (e) => {
  console.warn('只读文件端口未启动（可能已有实例在跑）:', e.code);
});

// ---------- 资源上传 / 工程持久化 ----------
app.post('/api/upload', (req, res) => {
  const { dataUrl, name } = req.body || {};
  const m = /^data:(image|video)\/([\w.+-]+);base64,(.+)$/s.exec(dataUrl || '');
  if (!m) return res.status(400).json({ error: '仅支持 base64 图片或视频' });
  const extMap = { jpeg: 'jpg', quicktime: 'mov', 'x-matroska': 'mkv' };
  const ext = extMap[m[2]] || m[2];
  const file = newId() + '.' + ext;
  fs.writeFileSync(path.join(ASSET_DIR, file), Buffer.from(m[3], 'base64'));
  res.json({ url: '/assets/' + file, name: name || file });
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
    imgModel: cfg.imgModel,
    imgProvider: cfg.imgProvider,
    openaiBase: cfg.openaiBase,
    hasOpenaiKey: !!cfg.openaiKey,
    openaiImgModel: cfg.openaiImgModel,
    llmProvider: cfg.llmProvider || 'auto',
    hasAnthropicKey: !!cfg.anthropicKey,
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
  if (llmModel !== undefined) cur.llmModel = llmModel;
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
  saveConfig(cur);
  res.json({ ok: true, hasKey: !!cur.apiKey });
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
  // openai 兼容 与 ark 同为 chat/completions 形状
  const base = provider === 'openai' ? (cfg.openaiBase || 'https://api.openai.com') + '/v1' : cfg.endpoint;
  const key = provider === 'openai' ? cfg.openaiKey : cfg.apiKey;
  const model = cfg.llmModel || (provider === 'openai' ? 'gpt-5.6-sol' : 'doubao-seed-1-6-250615');
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
    spawn('explorer', [p.dir], { detached: true }).unref(); // explorer 退出码不代表失败，直接视为成功
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
app.post('/api/segments', async (req, res) => {
  const { first, last, prompt, duration, stylePrompt, actingPrompt, inbetweenPrompt } = req.body || {};
  if (!first || !last) return res.status(400).json({ error: '缺少首帧或尾帧图片' });
  const cfg = loadConfig();
  const id = newId();
  let firstData, lastData;
  try {
    firstData = resolveToDataUrl(first);
    lastData = resolveToDataUrl(last);
  } catch (e) {
    return res.status(400).json({ error: String(e.message || e) });
  }
  let bill = null;
  if (pm) {
    bill = pm.charge(req, 'segment', clampDuration(duration));
    if (!bill.ok) return res.status(402).json({ error: bill.error });
  }
  logUsedPrompt(cfg, 'segment', prompt);
  if (cfg.apiKey) {
    try {
      const arkId = await arkCreate(cfg, firstData, lastData, prompt, duration, stylePrompt, actingPrompt, inbetweenPrompt);
      tasks[id] = { mode: 'ark', status: 'running', arkId, cost: bill && bill.cost, uid: bill && bill.uid };
    } catch (e) {
      if (pm && bill) pm.refund(bill.uid, bill.cost, 'create-failed');
      return res.status(502).json({ error: String(e.message || e) });
    }
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
    (prompt || '').trim(),
  ].map((s) => s.trim()).filter(Boolean).join('\n');
  res.json({ text });
});

// 一体生成：全部关键帧一次生成一段连续动画
app.post('/api/director', async (req, res) => {
  const { firstFrame, lastFrame, refVideoUrl, refImages = [], prompt, duration, model } = req.body || {};
  if (!firstFrame) return res.status(400).json({ error: '缺少首帧图片' });
  const cfg = loadConfig();
  const id = newId();
  let bill = null;
  if (pm) {
    bill = pm.charge(req, 'whole', clampDurationFor(model, duration));
    if (!bill.ok) return res.status(402).json({ error: bill.error });
  }
  logUsedPrompt(cfg, 'director', prompt);
  if (cfg.apiKey) {
    try {
      const firstDataUrl = resolveToDataUrl(firstFrame);
      const lastDataUrl = lastFrame ? resolveToDataUrl(lastFrame) : null;
      const refDataUrls = (Array.isArray(refImages) ? refImages : []).slice(0, 10).map(resolveToDataUrl);
      // 参考视频必须公网 URL（与 V2V 同一隧道流程）
      let refVideoPublicUrl = null;
      if (refVideoUrl) {
        const srcFile = localFileOf(refVideoUrl);
        if (!srcFile || !fs.existsSync(srcFile)) throw new Error('参考视频不存在，请重新上传');
        let base = await ensureTunnel();
        try {
          await waitPublicReachable(base + refVideoUrl);
        } catch (err) {
          if (!tunnel.proc) throw err;
          console.warn('隧道自检失败，重建隧道:', String(err.message || err).slice(0, 120));
          try { tunnel.proc.kill(); } catch {}
          tunnel.url = null; tunnel.proc = null;
          base = await ensureTunnel();
          await waitPublicReachable(base + refVideoUrl);
        }
        refVideoPublicUrl = base + refVideoUrl;
      }
      const arkId = await arkCreateDirector(cfg, {
        firstDataUrl, lastDataUrl, refVideoPublicUrl, refDataUrls,
        text: String(prompt || ''), duration, model,
      });
      tasks[id] = { mode: 'ark', status: 'running', arkId, cost: bill && bill.cost, uid: bill && bill.uid };
    } catch (e) {
      if (pm && bill) pm.refund(bill.uid, bill.cost, 'create-failed');
      return res.status(502).json({ error: String(e.message || e) });
    }
  } else {
    // 无 key：首尾帧交叉溶解模拟（参考视频/参考图忽略）
    const files = [];
    try {
      const f1 = localFileOf(firstFrame);
      if (!f1 || !fs.existsSync(f1)) throw new Error('首帧文件缺失');
      files.push(f1);
      if (lastFrame) {
        const f2 = localFileOf(lastFrame);
        if (f2 && fs.existsSync(f2)) files.push(f2);
      }
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

app.post('/api/whole', async (req, res) => {
  const { images = [], prompt, stylePrompt, actingPrompt, inbetweenPrompt, duration, timings, gaps } = req.body || {};
  const gapList = Array.isArray(gaps) ? gaps : (Array.isArray(timings) ? timings.map((s) => ({ seconds: s })) : null);
  if (!Array.isArray(images) || images.length < 2) return res.status(400).json({ error: '至少需要 2 张关键帧' });
  if (images.length > 100) return res.status(400).json({ error: '最多 100 张关键帧' });
  const cfg = loadConfig();
  const id = newId();
  let bill = null;
  if (pm) {
    bill = pm.charge(req, 'whole', clampDuration(duration));
    if (!bill.ok) return res.status(402).json({ error: bill.error });
  }
  logUsedPrompt(cfg, 'whole', prompt);
  if (Array.isArray(gaps)) for (const g of gaps) logUsedPrompt(cfg, 'gap', g && g.prompt);
  if (cfg.apiKey) {
    try {
      const text = [
        (stylePrompt !== undefined ? stylePrompt : cfg.stylePrompt) || '',
        wholePromptFor(images.length, gapList),
        // 中割运动指令：永远注入
        (inbetweenPrompt !== undefined && inbetweenPrompt !== ''
          ? inbetweenPrompt
          : (cfg.inbetweenPrompt || DEFAULT_INBETWEEN_PROMPT)),
        (actingPrompt || '').trim(),
        (prompt || '').trim(),
      ].map((s) => s.trim()).filter(Boolean).join('\n');
      const imageDataUrls = images.map(resolveToDataUrl);
      const arkId = await arkCreateWhole(cfg, imageDataUrls, text, duration);
      tasks[id] = { mode: 'ark', status: 'running', arkId, cost: bill && bill.cost, uid: bill && bill.uid };
    } catch (e) {
      if (pm && bill) pm.refund(bill.uid, bill.cost, 'create-failed');
      return res.status(502).json({ error: String(e.message || e) });
    }
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
  // 隐藏系统指令永远前置；用户可见的精修提示词与补充描述随后
  const fullPrompt = [GENGA_SYSTEM_PROMPT, (prompt || cfg.refinePrompt || '').trim()]
    .filter(Boolean).join('\n');
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
  const { videoUrl, refs = [], prompt, colorPrompt, duration } = req.body || {};
  const srcFile = videoUrl && localFileOf(videoUrl);
  if (!srcFile || !fs.existsSync(srcFile)) return res.status(400).json({ error: '源视频不存在，请先上传或生成' });
  const cfg = loadConfig();
  const id = newId();
  let bill = null;
  if (pm) {
    bill = pm.charge(req, 'v2v', clampDuration(duration));
    if (!bill.ok) return res.status(402).json({ error: bill.error });
  }
  if (cfg.apiKey) {
    try {
      logUsedPrompt(cfg, 'v2v', prompt);
      const text = [
        ((colorPrompt !== undefined ? colorPrompt : cfg.colorPrompt) || '').trim(),
        (prompt || '').trim(),
      ].filter(Boolean).join('\n');
      const refDataUrls = refs.map(resolveToDataUrl);
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
    } catch (e) {
      if (pm && bill) pm.refund(bill.uid, bill.cost, 'create-failed');
      return res.status(502).json({ error: String(e.message || e) });
    }
  } else {
    tasks[id] = { mode: 'mock', status: 'running', cost: bill && bill.cost, uid: bill && bill.uid };
    mockV2V(id, srcFile);
  }
  res.json({ id, mode: tasks[id].mode, status: 'running' });
});

app.get('/api/segments/:id', async (req, res) => {
  const task = tasks[req.params.id];
  if (!task) return res.status(404).json({ error: '任务不存在' });
  if (task.mode === 'ark' && task.status === 'running') {
    try {
      await arkPoll(loadConfig(), task, req.params.id);
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
  res.json({ status: task.status, videoUrl: task.videoUrl, error: task.error, mode: task.mode, warning: task.warning });
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

const PORT = process.env.PORT || 5893;
app.listen(PORT, () => {
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
