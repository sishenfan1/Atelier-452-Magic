const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const ROOT = __dirname;
const VIDEO_DIR = path.join(ROOT, 'videos');
const TMP_DIR = path.join(ROOT, 'tmp');
const DATA_DIR = path.join(ROOT, 'data');
const ASSET_DIR = path.join(DATA_DIR, 'assets');
const PROJECT_PATH = path.join(DATA_DIR, 'project.json');
const CONFIG_PATH = path.join(ROOT, 'config.json');
fs.mkdirSync(VIDEO_DIR, { recursive: true });
fs.mkdirSync(TMP_DIR, { recursive: true });
fs.mkdirSync(ASSET_DIR, { recursive: true });

const DEFAULT_STYLE_PROMPT =
  '画面风格必须与首帧和尾帧图片保持完全一致：相同的线条、笔触、色彩和质感。' +
  '严禁改变画风，严禁添加原图中不存在的颜色或上色，严禁增加阴影、光效或背景细节。' +
  '如果原图是黑白线稿，则全程保持纯黑白线稿。只在两帧之间生成自然的动作过渡。';

const DEFAULT_COLOR_PROMPT =
  '把视频1（粗略的线稿动画）转绘为最终成片：严格保持视频1的动作、时间节奏、构图和镜头完全不变，' +
  '人物造型与线条结构与视频1一致。按照参考图片的配色、上色风格和画面质感为整段视频完整上色，' +
  '输出干净精致的最终动画成片。不要添加参考图中不存在的新元素，不要改变任何动作，不要切换镜头。';

const DEFAULT_CONFIG = {
  apiKey: '',
  endpoint: 'https://ark.cn-beijing.volces.com/api/v3',
  model: 'doubao-seedance-1-5-pro-251215',
  v2vModel: 'doubao-seedance-2-0-260128',
  resolution: '720p',
  ratio: 'adaptive',
  stylePrompt: DEFAULT_STYLE_PROMPT,
  colorPrompt: DEFAULT_COLOR_PROMPT,
  publicBase: '',
};

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
async function arkCreate(cfg, firstDataUrl, lastDataUrl, prompt, duration, stylePrompt, actingPrompt) {
  const style = (stylePrompt !== undefined ? stylePrompt : cfg.stylePrompt) || '';
  const text = [style.trim(), (actingPrompt || '').trim(), (prompt || '').trim()].filter(Boolean).join('\n');
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
function wholePromptFor(n, timings) {
  let text = `共有 ${n} 张参考图片。图片1到图片${n}是同一段动画按时间顺序排列的关键帧原画：` +
    `动画从图片1开始，依次经过每一张关键帧的姿势与构图，到图片${n}结束。` +
    `所有参考图片按顺序串联为一段连续、连贯的完整动画：一镜到底，不切镜头，不淡入淡出，` +
    `角色和场景全程保持同一个，只做动作上的连续过渡。这是一次单独完整的生成，关键帧仅作为动画的关键姿势使用。`;
  if (Array.isArray(timings) && timings.length === n - 1 && timings.every((d) => Number(d) > 0)) {
    const total = timings.reduce((a, b) => a + Number(b), 0);
    let t = 0;
    const lines = timings.map((d, i) => {
      const dur = Number(d);
      const start = t.toFixed(1);
      t += dur;
      return `第${i + 1}段（图片${i + 1}→图片${i + 2}）：从第${start}秒到第${t.toFixed(1)}秒，时长${dur.toFixed(1)}秒——` +
        `先在图片${i + 1}的关键姿势上短暂停留，随后用约${Math.round(dur * 24)}张中间帧平滑连续地过渡到图片${i + 2}的姿势`;
    });
    text += `\n整段动画的时间分配（总时长约${total.toFixed(1)}秒）：\n` +
      lines.join('；\n') +
      `。\n每张关键帧必须严格按照上述时间点出现，各段的节奏由分配的时长决定：时长越长，停留和中间帧越多、动作越缓；时长越短，过渡越快。`;
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

// ---------- HTTP ----------
const app = express();
app.use(express.json({ limit: '300mb' }));
app.use(express.static(path.join(ROOT, 'public')));
app.use('/videos', express.static(VIDEO_DIR));
app.use('/assets', express.static(ASSET_DIR));

// 只读文件服务（隧道只暴露这个端口，不暴露 API）
const filesApp = express();
filesApp.use('/videos', express.static(VIDEO_DIR));
filesApp.use('/assets', express.static(ASSET_DIR));
filesApp.listen(FILES_PORT);

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
    colorPrompt: cfg.colorPrompt,
    publicBase: cfg.publicBase,
    tunnel: !!findCloudflared(),
    ffmpeg: !!FFMPEG,
  });
});

app.post('/api/config', (req, res) => {
  const cur = loadConfig();
  const { apiKey, endpoint, model, v2vModel, resolution, ratio, stylePrompt, colorPrompt, publicBase } = req.body || {};
  if (stylePrompt !== undefined) cur.stylePrompt = stylePrompt;
  if (colorPrompt !== undefined) cur.colorPrompt = colorPrompt;
  if (publicBase !== undefined) cur.publicBase = publicBase;
  if (v2vModel) cur.v2vModel = v2vModel;
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
  const { first, last, prompt, duration, stylePrompt, actingPrompt } = req.body || {};
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
  if (cfg.apiKey) {
    try {
      const arkId = await arkCreate(cfg, firstData, lastData, prompt, duration, stylePrompt, actingPrompt);
      tasks[id] = { mode: 'ark', status: 'running', arkId };
    } catch (e) {
      return res.status(502).json({ error: String(e.message || e) });
    }
  } else {
    tasks[id] = { mode: 'mock', status: 'running' };
    mockGenerate(id, firstData, lastData, duration); // 后台异步
  }
  res.json({ id, mode: tasks[id].mode, status: 'running' });
});

// 预览一体生成将发送的完整提示词（不创建任务、不产生费用）
app.post('/api/whole/preview', (req, res) => {
  const { count, prompt, stylePrompt, actingPrompt, timings } = req.body || {};
  const cfg = loadConfig();
  const text = [
    (stylePrompt !== undefined ? stylePrompt : cfg.stylePrompt) || '',
    wholePromptFor(Number(count) || 0, timings),
    (actingPrompt || '').trim(),
    (prompt || '').trim(),
  ].map((s) => s.trim()).filter(Boolean).join('\n');
  res.json({ text });
});

// 一体生成：全部关键帧一次生成一段连续动画
app.post('/api/whole', async (req, res) => {
  const { images = [], prompt, stylePrompt, actingPrompt, duration, timings } = req.body || {};
  if (!Array.isArray(images) || images.length < 2) return res.status(400).json({ error: '至少需要 2 张关键帧' });
  if (images.length > 9) return res.status(400).json({ error: 'Seedance 最多支持 9 张参考图，请减少关键帧数量' });
  const cfg = loadConfig();
  const id = newId();
  if (cfg.apiKey) {
    try {
      const text = [
        (stylePrompt !== undefined ? stylePrompt : cfg.stylePrompt) || '',
        wholePromptFor(images.length, timings),
        (actingPrompt || '').trim(),
        (prompt || '').trim(),
      ].map((s) => s.trim()).filter(Boolean).join('\n');
      const imageDataUrls = images.map(resolveToDataUrl);
      const arkId = await arkCreateWhole(cfg, imageDataUrls, text, duration);
      tasks[id] = { mode: 'ark', status: 'running', arkId };
    } catch (e) {
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
      return res.status(400).json({ error: String(e.message || e) });
    }
    tasks[id] = { mode: 'mock', status: 'running' };
    mockWhole(id, files, duration);
  }
  res.json({ id, mode: tasks[id].mode, status: 'running' });
});

// 视频转视频（上色/转绘）任务
app.post('/api/v2v', async (req, res) => {
  const { videoUrl, refs = [], prompt, colorPrompt, duration } = req.body || {};
  const srcFile = videoUrl && localFileOf(videoUrl);
  if (!srcFile || !fs.existsSync(srcFile)) return res.status(400).json({ error: '源视频不存在，请先上传或生成' });
  const cfg = loadConfig();
  const id = newId();
  if (cfg.apiKey) {
    try {
      const base = await ensureTunnel();
      const publicUrl = base + videoUrl;
      const text = [
        ((colorPrompt !== undefined ? colorPrompt : cfg.colorPrompt) || '').trim(),
        (prompt || '').trim(),
      ].filter(Boolean).join('\n');
      const refDataUrls = refs.map(resolveToDataUrl);
      const arkId = await arkCreateV2V(cfg, publicUrl, refDataUrls, text, duration);
      tasks[id] = { mode: 'ark', status: 'running', arkId };
    } catch (e) {
      return res.status(502).json({ error: String(e.message || e) });
    }
  } else {
    tasks[id] = { mode: 'mock', status: 'running' };
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
  console.log(`AI 中割动画工作台 http://localhost:${PORT}`);
  console.log(`生成模式: ${cfg.apiKey ? 'Seedance API (' + cfg.model + ')' : '本地模拟（未配置 API Key）'}`);
  console.log(`ffmpeg: ${FFMPEG || '未找到'}`);
});
