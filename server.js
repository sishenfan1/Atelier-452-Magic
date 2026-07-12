const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

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

function loadConfig() {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
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
    const onData = (d) => {
      buf += d.toString();
      const m = buf.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m && !tunnel.url) {
        tunnel.url = m[0];
        tunnel.proc = proc;
        console.log('文件隧道已建立:', tunnel.url);
        resolve(tunnel.url);
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', reject);
    proc.on('close', () => { if (tunnel.proc === proc) { tunnel.url = null; tunnel.proc = null; } });
    setTimeout(() => { if (!tunnel.url) reject(new Error('cloudflared 隧道启动超时（30s）')); }, 30000);
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
  dataUrlToFile(firstDataUrl, a);
  dataUrlToFile(lastDataUrl, b);
  const d = clampDuration(duration);
  const fit = 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:white,setsar=1';
  try {
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
async function arkCreate(cfg, firstDataUrl, lastDataUrl, prompt, duration, stylePrompt, actingPrompt, inbetweenPrompt) {
  const style = (stylePrompt !== undefined ? stylePrompt : cfg.stylePrompt) || '';
  // 中割运动指令：永远注入，保证首尾帧之间不是"无运动的渐变"
  const inbetween = (inbetweenPrompt !== undefined && inbetweenPrompt !== ''
    ? inbetweenPrompt
    : (cfg.inbetweenPrompt || DEFAULT_INBETWEEN_PROMPT));
  const text = [style.trim(), inbetween.trim(), (actingPrompt || '').trim(), (prompt || '').trim()]
    .filter(Boolean).join('\n');
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
  if (!res.ok) throw new Error(`Ark 创建任务失败 (${res.status}): ` + JSON.stringify(json).slice(0, 500));
  if (!json.id) throw new Error('Ark 响应缺少任务 id: ' + JSON.stringify(json).slice(0, 300));
  return json.id;
}

async function arkPoll(cfg, task, localId) {
  const res = await fetch(cfg.endpoint + '/contents/generations/tasks/' + task.arkId, {
    headers: { Authorization: 'Bearer ' + cfg.apiKey },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Ark 查询失败 (${res.status}): ` + JSON.stringify(json).slice(0, 300));
  const status = json.status;
  if (status === 'succeeded') {
    const remote = json.content && json.content.video_url;
    if (!remote) throw new Error('任务成功但没有 video_url');
    // 结果链接 24h 过期，立刻下载到本地
    const file = path.join(VIDEO_DIR, localId + '.mp4');
    const vres = await fetch(remote);
    if (!vres.ok) throw new Error('下载生成视频失败: ' + vres.status);
    fs.writeFileSync(file, Buffer.from(await vres.arrayBuffer()));
    task.status = 'succeeded';
    task.videoUrl = '/videos/' + localId + '.mp4';
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
  const content = [{ type: 'text', text }];
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
  if (!res.ok) throw new Error(`Ark 创建一体生成任务失败 (${res.status}): ` + JSON.stringify(json).slice(0, 500));
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
  const content = [{ type: 'text', text }];
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
  if (!res.ok) throw new Error(`Ark 创建 V2V 任务失败 (${res.status}): ` + JSON.stringify(json).slice(0, 500));
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

// 公开站模式（A452_PUBLIC=1）：登录、积分、每用户工程、支付。桌面模式下为 null。
const pm = require(path.join(__dirname, 'public-mode.js')).install(app, { DATA_DIR });

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
  try {
    res.json(JSON.parse(fs.readFileSync(PROJECT_PATH, 'utf8')));
  } catch {
    res.json({});
  }
});

app.post('/api/project', (req, res) => {
  fs.writeFileSync(PROJECT_PATH, JSON.stringify(req.body || {}, null, 1));
  res.json({ ok: true });
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
    presets: cfg.presets || [],
    usedPrompts: cfg.usedPrompts || [],
    publicBase: cfg.publicBase,
    tunnel: !!findCloudflared(),
    ffmpeg: !!FFMPEG,
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
  saveConfig(cur);
  res.json({ ok: true, hasKey: !!cur.apiKey });
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
    } catch (e) {
      task.status = 'failed';
      task.error = String(e.message || e);
    }
  }
  // 公开站：任务失败自动退还积分（一次性）
  if (pm && task.status === 'failed' && task.cost && !task.refunded) {
    task.refunded = true;
    pm.refund(task.uid, task.cost, 'task-failed');
  }
  res.json({ status: task.status, videoUrl: task.videoUrl, error: task.error, mode: task.mode });
});

// 顺序拼接导出 mp4（统一重编码，保证不同分段能接上）
app.post('/api/concat', async (req, res) => {
  const { urls, fps } = req.body || {};
  if (!Array.isArray(urls) || urls.length === 0) return res.status(400).json({ error: '没有可拼接的分段' });
  const files = urls.map((u) => path.join(VIDEO_DIR, path.basename(u)));
  for (const f of files) if (!fs.existsSync(f)) return res.status(400).json({ error: '分段文件缺失: ' + path.basename(f) });
  const { w, h } = probeSize(files[0]);
  const id = 'export_' + newId();
  const out = path.join(VIDEO_DIR, id + '.mp4');
  const args = ['-y'];
  for (const f of files) args.push('-i', f);
  const fit = `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:white,setsar=1,fps=${Number(fps) || 24}`;
  const chains = files.map((_, i) => `[${i}:v]${fit}[v${i}]`).join(';');
  const inputs = files.map((_, i) => `[v${i}]`).join('');
  args.push('-filter_complex', `${chains};${inputs}concat=n=${files.length}:v=1:a=0,format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'fast', out);
  try {
    await runFfmpeg(args);
    res.json({ url: '/videos/' + id + '.mp4' });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// webm（浏览器录制）→ mp4
app.post('/api/convert', express.raw({ type: '*/*', limit: '800mb' }), async (req, res) => {
  const id = 'export_' + newId();
  const src = path.join(TMP_DIR, id + '.webm');
  const out = path.join(VIDEO_DIR, id + '.mp4');
  fs.writeFileSync(src, req.body);
  try {
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
