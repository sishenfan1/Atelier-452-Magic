/* AI 动画工作台 — 前端逻辑（中割生成 + 成片上色 + 工程持久化） */
'use strict';

const $ = (id) => document.getElementById(id);
const PREVIEW_FPS = 24;          // 分段抽帧基准帧率
const FRAME_MAX_W = 854;         // 预览帧缓存最大宽度（控制内存）

// ---------------- 状态 ----------------
const state = {
  images: [],        // {id, name, url}
  segments: [],      // 与相邻图片对一一对应，引用 segCache 里的对象
  segCache: new Map(), // key "imgIdA>imgIdB" -> {key,status,error,versions,active,prompt,seconds}
  playing: null,
  exporting: false,
  v2v: {
    sourceUrl: null, sourceName: '',
    refs: [],        // {id, name, url}
    history: [],     // {videoUrl, time, duration, refs, note}
    current: -1,     // 正在展示的历史下标
    running: false,
  },
  whole: {
    history: [],     // {videoUrl, time, duration, frames, note}
    current: -1,
    running: false,
  },
  refine: {
    sourceUrl: null, sourceName: '',
    refs: [],        // 角色设定/色卡参考 {id, name, url}
    history: [],     // {src, out, time, note}
    current: -1,
  },
  presets: [],       // {id, name, text}
  usedPrompts: [],   // 自动记录的已用提示词 {t, kind, text}
  pendingTasks: [],  // 已提交未完成的生成任务 {id, kind, ...提交时元数据}，刷新后恢复轮询
  director: {
    first: null, last: null,          // 首/尾帧 {url, name}
    refVideo: null, refVideoName: '', // 参考视频 url
    refs: [],                         // 当前档参考素材 {id, name, url, kind, role, note}
    refsStash: { t20: [], t25: [] },  // 双档参考记忆：2.0 与 2.5 各存一套，切档互不丢失
    refTier: null,                    // 当前参考集所属档（'20' | '25'）
    cuts: [],                         // 分镜头提示词 [{text, dur}]（dur 秒，0.1 精度，0=不限）
    negative: '',                     // 负面提示词
    mood: '',                         // 全局场面情绪锁
    history: [],                      // {videoUrl, time, duration, model, note}
    current: -1,
    running: false,
  },
  motion: {
    srcUrl: null, srcName: '',
    fps: 0, duration: 0,
    energy: [],      // 归一化运动能量序列（分析结果缓存，参数变化不必重新差分）
    poses: [],       // 原画候補 {t, url, accepted}
  },
};
let nextImgId = 1;
let nextRefId = 1;

// ---------------- 工具 ----------------
function fileToDataUrl(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    // 根因修复：FileReader 失败给的是 ProgressEvent（无 message）——曾导致「上传失败: undefined」。
    // 这里必须包成带可读信息的真 Error。
    r.onerror = () => rej(new Error(`读取文件「${file.name}」失败：${(r.error && r.error.message) || '文件可能已被移动、占用或损坏'}`));
    r.onabort = () => rej(new Error(`读取文件「${file.name}」被中断`));
    r.readAsDataURL(file);
  });
}

/** 任何异常值 → 可读错误文案（杜绝 undefined/null/[object Object] 出现在提示里） */
function errMsg(e) {
  if (e == null) return '未知错误';
  if (typeof e === 'string') return e || '未知错误';
  if (e.message) return e.message;
  if (e.error) return errMsg(e.error);
  if (e.name && e.name !== 'Error') return e.name;
  try { const s = JSON.stringify(e); if (s && s !== '{}') return s.slice(0, 200); } catch {}
  return String(e) === '[object Object]' ? '未知错误' : String(e);
}
const fmt = (n, d = 2) => n.toFixed(d);
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

async function uploadAsset(file) {
  // base64 编码后约膨胀 1.37 倍，服务器 json 上限 300MB → 原文件约 220MB
  if (file.size > 220 * 1024 * 1024) throw new Error('文件过大：请控制在约 220MB 以内');
  const dataUrl = await fileToDataUrl(file);
  const res = await fetch('/api/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataUrl, name: file.name }),
  });
  if (!res.ok) {
    if (res.status === 413) throw new Error('文件过大：base64 编码后超过 300MB，原文件请控制在约 220MB 以内');
    const txt = await res.text().catch(() => '');
    let msg = '';
    try { msg = JSON.parse(txt).error || ''; } catch {}
    throw new Error(msg || `上传失败 HTTP ${res.status} ${txt.slice(0, 120)}`);
  }
  const json = await res.json();
  return json.url;
}

// ---------------- 工程持久化 ----------------
let saveTimer = 0;
let projectLoaded = false; // 恢复完成前禁止写盘，避免用近乎空白的快照覆盖 project.json
let pendingSave = false;   // 恢复期间收到的保存请求先记账，恢复完成后补一次
function scheduleSave() {
  if (!projectLoaded) { pendingSave = true; return; }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveProject, 800);
}
function snapshot() {
  return {
    nextImgId,
    nextRefId,
    images: state.images,
    segCache: [...state.segCache.entries()].map(([key, s]) => ({
      key,
      prompt: s.prompt,
      seconds: s.seconds,
      active: s.active,
      versions: s.versions.map((v) => ({
        videoUrl: v.videoUrl,
        time: v.time,
        prompt: v.prompt,
        seconds: v.seconds,
      })),
    })),
    settings: {
      segSeconds: $('segSeconds').value,
      globalPrompt: $('globalPrompt').value,
      remapSeconds: $('remapSeconds').value,
      remapFps: $('remapFps').value,
      acting: $('acting').value,
      tame: $('chkTame').checked,
      sensitivity: $('sensitivity').value,
      loop: $('chkLoop').checked,
      exportRemap: $('chkExportRemap').checked,
    },
    v2v: {
      sourceUrl: state.v2v.sourceUrl,
      sourceName: state.v2v.sourceName,
      refs: state.v2v.refs,
      history: state.v2v.history,
      duration: $('v2vDuration').value,
      extraPrompt: $('v2vExtraPrompt').value,
    },
    whole: {
      history: state.whole.history,
    },
    refine: {
      sourceUrl: state.refine.sourceUrl,
      sourceName: state.refine.sourceName,
      refs: state.refine.refs,
      history: state.refine.history,
    },
    motion: {
      srcUrl: state.motion.srcUrl,
      srcName: state.motion.srcName,
      fps: state.motion.fps,
      duration: state.motion.duration,
      energy: state.motion.energy,
      poses: state.motion.poses,
    },
    director: captureDirectorLive(), // 向后兼容字段（旧版本打开也能读）
    dirScenes: dirScenesSnapshot(),
    dirSceneActive: state.dirSceneActive || 0,
    pendingTasks: state.pendingTasks,
  };
}
function saveProject() {
  if (!projectLoaded) { pendingSave = true; return; }
  fetch('/api/project', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(snapshot()),
  }).catch(() => {});
}
// 恢复完成（含全新空工程）后解除写盘封锁，并补发恢复期间攒下的保存
function markProjectLoaded() {
  projectLoaded = true;
  if (pendingSave) { pendingSave = false; scheduleSave(); }
}
async function loadProject() {
  try {
    const res = await fetch('/api/project');
    const p = await res.json().catch(() => null);
    if (!res.ok || (p && p.corrupt)) {
      // 工程文件损坏/读取失败：保持写盘封锁，绝不让空快照覆盖尚可抢救的数据
      console.warn('工程加载失败', p && p.error);
      alert('工程加载失败' + (p && p.error ? '：' + p.error : '（服务器错误）') + '\n为防止数据被覆盖，自动保存已停用；请检查数据目录后重新打开应用。');
      return;
    }
    if (p && p.restoredFromBackup) console.warn('工程已从 .bak 备份恢复');
    if (!p || !p.images) { markProjectLoaded(); return; }
    // 计数器只增不减：避免与恢复并发的上传拿到重复 id
    nextImgId = Math.max(nextImgId, p.nextImgId || 1);
    nextRefId = Math.max(nextRefId, p.nextRefId || 1);
    state.images = p.images || [];
    for (const s of p.segCache || []) {
      state.segCache.set(s.key, {
        key: s.key,
        status: s.versions.length ? 'success' : 'idle',
        error: null,
        prompt: s.prompt || '',
        seconds: s.seconds || null,
        active: s.active >= 0 ? s.active : s.versions.length - 1,
        versions: s.versions.map((v) => ({
          videoUrl: v.videoUrl,
          time: v.time || '',
          prompt: v.prompt || '',
          seconds: v.seconds || s.seconds || null,
          frames: null,
          diffs: null,
          w: 0,
          h: 0,
        })),
      });
    }
    const st = p.settings || {};
    if (st.segSeconds) { $('segSeconds').value = st.segSeconds; }
    // 已有手动填入的提示词（如镜头包/adwPrompt 直通）时不覆盖
    if (st.globalPrompt && !$('globalPrompt').value.trim()) $('globalPrompt').value = st.globalPrompt;
    if (st.remapSeconds) $('remapSeconds').value = st.remapSeconds;
    if (st.remapFps) $('remapFps').value = st.remapFps;
    if (st.acting) $('acting').value = st.acting;
    $('chkTame').checked = !!st.tame;
    if (st.sensitivity) $('sensitivity').value = st.sensitivity;
    if (st.loop !== undefined) $('chkLoop').checked = !!st.loop;
    $('chkExportRemap').checked = !!st.exportRemap;
    const v = p.v2v || {};
    state.v2v.sourceUrl = v.sourceUrl || null;
    state.v2v.sourceName = v.sourceName || '';
    state.v2v.refs = v.refs || [];
    state.v2v.history = v.history || [];
    state.v2v.current = state.v2v.history.length ? 0 : -1;
    if (v.duration) $('v2vDuration').value = v.duration;
    if (v.extraPrompt) $('v2vExtraPrompt').value = v.extraPrompt;
    const w = p.whole || {};
    state.whole.history = w.history || [];
    state.whole.current = state.whole.history.length ? 0 : -1;
    renderWhole();
    const rf = p.refine || {};
    state.refine.sourceUrl = rf.sourceUrl || null;
    state.refine.sourceName = rf.sourceName || '';
    state.refine.refs = rf.refs || [];
    state.refine.history = rf.history || [];
    state.refine.current = state.refine.history.length ? 0 : -1;
    state.pendingTasks = Array.isArray(p.pendingTasks) ? p.pendingTasks : [];
    const mo = p.motion || {};
    state.motion.srcUrl = mo.srcUrl || null;
    state.motion.srcName = mo.srcName || '';
    state.motion.fps = Number(mo.fps) || 0;
    state.motion.duration = Number(mo.duration) || 0;
    state.motion.energy = Array.isArray(mo.energy) ? mo.energy : [];
    state.motion.poses = Array.isArray(mo.poses) ? mo.poses : [];
    restoreMotionUI();
    // 多场景：优先恢复场景集；旧工程只有 director 单场 → 自动迁移为「场景 1」
    if (Array.isArray(p.dirScenes) && p.dirScenes.length) {
      state.dirScenes = p.dirScenes.filter((s) => s && typeof s === 'object');
      state.dirSceneActive = Math.max(0, Math.min(Number(p.dirSceneActive) || 0, state.dirScenes.length - 1));
    } else {
      state.dirScenes = [{ id: 'sc-legacy', name: '场景 1', data: p.director || {} }];
      state.dirSceneActive = 0;
    }
    applyDirectorData((state.dirScenes[state.dirSceneActive] || {}).data || {});
    if (typeof renderDirSceneTabs === 'function') renderDirSceneTabs();
    restoreDirectorUI();
    renderRefine();
    syncSliderLabels();
    rebuildSegments();
    renderAll();
    renderV2V();
    markProjectLoaded();
    // 恢复刷新前仍在轮询的生成任务，找回已提交（已付费）的结果
    for (const entry of state.pendingTasks.slice()) resumePendingTask(entry);
  } catch (e) {
    console.warn('工程恢复失败', e);
    // 恢复失败时保持写盘封锁：此刻内存里是空工程，放开保存会覆盖磁盘上的真实数据
    setWholeStatus('工程恢复失败，本次会话不会自动保存 — 请刷新页面重试');
  }
}

// ---------------- 演技强度（芝居）→ 内置提示词 ----------------
const ACTING_TIERS = [
  { max: 20, name: '克制', text:
    '表演极度克制安静：角色动作幅度很小、缓慢而柔和，姿态变化细微，情绪内敛，没有夸张表情，节奏平稳沉静。Subtle, minimal, calm character acting with slow gentle motion.' },
  { max: 40, name: '自然', text:
    '表演自然写实：动作幅度适中、流畅自然，姿态过渡平滑，表情自然不夸张，节奏舒缓从容。Natural, realistic character acting with smooth transitions.' },
  { max: 60, name: '生动', text:
    '表演生动有力：动作明快，关键姿势清晰明确，表情丰富，有明显的动作重音和节奏感。Lively, expressive acting with clear strong key poses and accents.' },
  { max: 80, name: '夸张', text:
    '表演夸张有张力（芝居）：动作迅速果断，关键姿势之间切换干脆利落，姿势夸张醒目，表情强烈，缓急对比明显——关键姿势停顿、过渡极快。Snappy, fast, exaggerated character acting with prominent key poses and strong timing contrast.' },
  { max: 100, name: '极限作画', text:
    '极限作画演技（sakuga）：动作极快极猛，关键姿势极端夸张、冲击力拉满，帧与帧之间变化剧烈，动作重音快速利落，强烈的挤压拉伸和动态变形，表情极度夸张，暴烈的节奏对比。Sakuga-level acting: extremely fast and snappy movement between extremely prominent key poses, intense smears and dynamic deformation, explosive timing.' },
];
function actingTier(v) {
  return ACTING_TIERS.find((t) => v <= t.max) || ACTING_TIERS[ACTING_TIERS.length - 1];
}
function buildActingPrompt() {
  const v = Number($('acting').value);
  return `角色演技强度 ${v}/100。${actingTier(v).text}`;
}
function syncActingLabel() {
  const v = Number($('acting').value);
  $('actingVal').textContent = v;
  $('actingTier').textContent = actingTier(v).name;
}

function syncSliderLabels() {
  syncActingLabel();
  $('segSecondsVal').textContent = $('segSeconds').value + ' 秒';
  $('sensitivityVal').textContent = $('sensitivity').value + ' %';
  $('remapSecondsVal').textContent = $('remapSeconds').value + 's';
  $('remapFpsVal').textContent = $('remapFps').value;
  $('v2vDurationVal').textContent = $('v2vDuration').value + ' 秒';
  updateWholeTotal();
}

// ---------------- 图片悬停放大气泡 ----------------
const imgPeek = document.createElement('div');
imgPeek.id = 'imgPeek';
imgPeek.innerHTML = '<img alt="">';
document.body.appendChild(imgPeek);
const imgPeekImg = imgPeek.querySelector('img');

function positionPeek(e) {
  const pad = 18;
  const w = imgPeek.offsetWidth, h = imgPeek.offsetHeight;
  let x = e.clientX + pad, y = e.clientY + pad;
  if (x + w > innerWidth - 8) x = e.clientX - w - pad;
  if (y + h > innerHeight - 8) y = Math.max(8, innerHeight - h - 8);
  imgPeek.style.left = x + 'px';
  imgPeek.style.top = y + 'px';
}
document.addEventListener('mouseover', (e) => {
  const img = e.target.closest('img');
  if (!img || img.closest('#imgPeek')) return;
  if (!img.closest('.image-item, .input-cell, .seg-card .pair, .ref-cell, .dir-frame')) return;
  imgPeekImg.src = img.src;
  imgPeek.classList.add('show');
  positionPeek(e);
});
document.addEventListener('mousemove', (e) => {
  if (imgPeek.classList.contains('show')) positionPeek(e);
});
document.addEventListener('mouseout', (e) => {
  if (e.target.closest && e.target.closest('img')) imgPeek.classList.remove('show');
});

// ---------------- KEYFRAME TIMELINE：canvas 时间轴（时距 + 缓动双轴拖拽） ----------------
// 左右拖手柄 = 调与前帧的时距（涟漪式）；上下拖 = 调该段插值缓动 gapEase ∈ [-1,1]
// （+ = ease-out 先快后慢，- = ease-in 先慢后快）。段曲线绘制该段速度分布。
const KF_PAD = 16;
const MT_MIN_GAP = 0.1;   // 段最短 0.1s
const MT_MAX_GAP = 6;     // 段最长 6s
const KF_H = 200;

function mtTimes() {
  const times = [0];
  for (const g of wholeTimings()) times.push(times[times.length - 1] + g);
  return times;
}

/** 段速度形状：幂缓动 s=uᵖ（入）/ 1-(1-u)ᵖ（出）的导数，e≈0 时为常速 */
function easeVelocity(u, e) {
  if (Math.abs(e) < 0.03) return 1;
  const p = 1 + 2 * Math.abs(e);
  return e < 0 ? p * Math.pow(u, p - 1) : p * Math.pow(1 - u, p - 1);
}
function easeLabel(e) {
  if (Math.abs(e) < 0.03) return '线性';
  return (e > 0 ? 'ease-out ' : 'ease-in ') + Math.round(Math.abs(e) * 100) + '%';
}
/** 生成提示词用的缓动措辞（拼入段动作描述，让模型理解节奏意图） */
function easePromptText(e) {
  if (Math.abs(e) < 0.03) return '';
  const strength = Math.abs(e) >= 0.66 ? '强烈' : Math.abs(e) >= 0.33 ? '明显' : '轻微';
  return e > 0 ? `${strength}缓出节奏（起势快，收势渐慢定格）` : `${strength}缓入节奏（起势缓慢蓄力，加速冲向下一帧）`;
}

let kfDrag = null;   // {i, startX, startY, origHold, origEase, scale}
let kfHover = null;  // {type:'key'|'gap', i}

function kfGeom() {
  const canvas = $('macroCanvas');
  const W = canvas.clientWidth;
  const times = mtTimes();
  const total = Math.max(times[times.length - 1], 0.001);
  // 视频版布局：上 34px 标题带（MOTION ENERGY / 图例），曲线区，下 16px 时间码带
  return {
    canvas, W, H: KF_H, times, total,
    x: (t) => KF_PAD + (t / total) * (W - KF_PAD * 2),
    yTop: 42, yBase: KF_H - 18, curveH: KF_H - 18 - 52,
  };
}

/** 段丘形：钟形山丘，峰位随缓动偏移（缓出 = 峰偏左，缓入 = 峰偏右，线性 = 居中对称） */
function kfHillHeight(u, e) {
  const peak = 0.5 - Math.max(-1, Math.min(1, e)) * 0.32;
  const a = 1 + 3 * peak, b = 1 + 3 * (1 - peak);
  const raw = Math.pow(u, a - 1) * Math.pow(1 - u, b - 1);
  const rawPeak = Math.pow(peak, a - 1) * Math.pow(1 - peak, b - 1) || 1;
  return raw / rawPeak; // 0..1，峰值恒 1
}

function fmtTimecode(t) {
  const s = Math.floor(t);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function renderMacroTimeline() {
  const show = state.images.length >= 2;
  $('macroCanvas').hidden = !show;
  $('macroHint').hidden = show;
  if (show) drawKeyframeTimeline();
}
function layoutMacroTimeline() {
  if (!$('macroCanvas').hidden) drawKeyframeTimeline();
}

function drawKeyframeTimeline() {
  const g = kfGeom();
  const { canvas, W, H, times, x } = g;
  if (W === 0) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  // 近纯黑底（视频同款）
  ctx.fillStyle = '#0A0D0A';
  ctx.fillRect(0, 0, W, H);

  // 内嵌标题带：MOTION ENERGY / 副标题（视频左上角样式）
  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(140,150,140,.85)';
  ctx.font = '8px ui-monospace, Consolas, monospace';
  ctx.fillText('M O T I O N   E N E R G Y', KF_PAD, 15);
  ctx.fillStyle = 'rgba(240,244,240,.95)';
  ctx.font = 'bold 11px "Segoe UI", system-ui, sans-serif';
  ctx.fillText('关键帧节奏 · 補正後の動き量', KF_PAD, 30);

  // 右上图例：● 起点(绿) ● 極点(白) ● 終点(绿) ● カット(红)
  const legend = [
    ['起点', '#8DE31A'], ['極点', '#E5E7EB'], ['終点', '#8DE31A'], ['カット', '#E5484D'],
  ];
  ctx.font = '9px "Segoe UI", system-ui, sans-serif';
  let lx = W - KF_PAD;
  for (let li = legend.length - 1; li >= 0; li--) {
    const [name, color] = legend[li];
    const tw = ctx.measureText(name).width;
    lx -= tw;
    ctx.fillStyle = 'rgba(200,205,200,.8)';
    ctx.textAlign = 'left';
    ctx.fillText(name, lx, 15);
    lx -= 9;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(lx + 3, 11.5, 2.5, 0, Math.PI * 2);
    ctx.fill();
    lx -= 14;
  }

  // 基线（极淡）
  ctx.fillStyle = 'rgba(148,163,184,.22)';
  ctx.fillRect(KF_PAD, g.yBase, W - KF_PAD * 2, 1);

  // 连续运动能量曲线：逐段钟形丘连成一条平滑曲线（峰位随缓动偏移），
  // 一次路径完成，暗军绿渐变填充 + 亮描边（视频同款）
  const nSeg = state.images.length - 1;
  const pts = [];
  for (let i = 0; i < nSeg; i++) {
    const e = Number(state.images[i].gapEase || 0);
    const x0 = x(times[i]), x1 = x(times[i + 1]);
    const N = Math.max(16, Math.floor((x1 - x0) / 3));
    for (let k = i === 0 ? 0 : 1; k <= N; k++) {
      const u = k / N;
      pts.push([x0 + u * (x1 - x0), g.yBase - (0.06 + 0.94 * kfHillHeight(u, e)) * g.curveH * 0.92]);
    }
  }
  if (pts.length) {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], g.yBase);
    for (const [px, py] of pts) ctx.lineTo(px, py);
    ctx.lineTo(pts[pts.length - 1][0], g.yBase);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, g.yTop, 0, g.yBase);
    grad.addColorStop(0, 'rgba(92,128,58,.66)');   // 暗军绿（视频色）
    grad.addColorStop(0.7, 'rgba(60,86,42,.30)');
    grad.addColorStop(1, 'rgba(40,58,30,.06)');
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (const [px, py] of pts) ctx.lineTo(px, py);
    ctx.strokeStyle = 'rgba(222,232,214,.85)'; // 亮描边
    ctx.lineWidth = 1.3;
    ctx.stroke();
  }

  // hover 段：轻微提亮该段区域
  if (kfHover && kfHover.type === 'gap') {
    const x0 = x(times[kfHover.i]), x1 = x(times[kfHover.i + 1]);
    ctx.fillStyle = 'rgba(200,246,93,.06)';
    ctx.fillRect(x0, g.yTop - 6, x1 - x0, g.yBase - g.yTop + 6);
    // 光标处小提示：时长 + 缓动 + 标记
    const im = state.images[kfHover.i];
    const info = (times[kfHover.i + 1] - times[kfHover.i]).toFixed(1) + 's'
      + ((im.gapPrompt || '').trim() ? ' ✎' : '') + (im.gapActing > 0 ? ' ★' : '')
      + (Math.abs(Number(im.gapEase || 0)) >= 0.03 ? ' · ' + easeLabel(Number(im.gapEase)) : '');
    ctx.fillStyle = 'rgba(200,205,200,.75)';
    ctx.font = '9px ui-monospace, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(info, (x0 + x1) / 2, g.yTop - 10);
  }

  // 关键帧竖线：全高细线 + 顶端小圆点（固定高度；首尾绿・中间白・拖动/悬停黄）
  state.images.forEach((im, i) => {
    const xi = x(times[i]);
    const isEnd = i === 0 || i === state.images.length - 1;
    const active = (kfDrag && kfDrag.i === i) || (!kfDrag && kfHover && kfHover.type === 'key' && kfHover.i === i);
    const color = active ? '#E8F566' : isEnd ? '#8DE31A' : '#E5E7EB';
    ctx.strokeStyle = active ? 'rgba(232,245,102,.95)' : isEnd ? 'rgba(141,227,26,.8)' : 'rgba(229,231,235,.75)';
    ctx.lineWidth = active ? 1.8 : 1;
    ctx.beginPath();
    ctx.moveTo(xi, g.yTop - 2);
    ctx.lineTo(xi, g.yBase);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(xi, g.yTop - 5, active ? 4 : 3, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  });

  // 底部时间码：仅左右两端（视频同款极简）
  ctx.fillStyle = 'rgba(140,150,140,.7)';
  ctx.font = '8.5px ui-monospace, Consolas, monospace';
  ctx.textAlign = 'left';
  ctx.fillText(fmtTimecode(0), KF_PAD, H - 5);
  ctx.textAlign = 'right';
  ctx.fillText(fmtTimecode(g.total), W - KF_PAD, H - 5);

  // 拖动中的浮动标签：时距 + 缓动
  if (kfDrag) {
    const im = state.images[kfDrag.i - 1];
    const label = Number(im.hold ?? 2).toFixed(1) + 's · ' + easeLabel(Number(im.gapEase || 0));
    const xi = x(times[kfDrag.i]);
    ctx.font = '10.5px ui-monospace, Consolas, monospace';
    const tw = ctx.measureText(label).width + 14;
    const bx = Math.min(Math.max(xi - tw / 2, 4), W - tw - 4);
    ctx.fillStyle = 'rgba(5,8,5,.94)';
    ctx.strokeStyle = 'rgba(232,245,102,.85)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(bx, g.yTop + 4, tw, 19, 4);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#E8F566';
    ctx.textAlign = 'center';
    ctx.fillText(label, bx + tw / 2, g.yTop + 17);
  }
}

// 命中检测：竖线（全高 ±6px）优先，其次段落区
function kfHitTest(mx, my) {
  const g = kfGeom();
  for (let i = state.images.length - 1; i >= 0; i--) {
    const xi = g.x(g.times[i]);
    if (Math.abs(mx - xi) <= 6 && my > g.yTop - 12 && my < g.yBase + 4) return { type: 'key', i };
  }
  for (let i = 0; i < state.images.length - 1; i++) {
    if (mx > g.x(g.times[i]) + 8 && mx < g.x(g.times[i + 1]) - 8 && my > g.yTop - 8 && my < g.yBase + 4) {
      return { type: 'gap', i };
    }
  }
  return null;
}

(() => {
  const canvas = $('macroCanvas');
  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    return { mx: e.clientX - r.left, my: e.clientY - r.top };
  };
  canvas.addEventListener('pointerdown', (e) => {
    const { mx, my } = pos(e);
    const hit = kfHitTest(mx, my);
    if (!hit) return;
    if (hit.type === 'gap') { openGapDialog(hit.i); return; }
    if (hit.i === 0) return; // 首帧固定在 0s
    e.preventDefault();
    try { canvas.setPointerCapture(e.pointerId); } catch {}
    const g = kfGeom();
    kfDrag = {
      i: hit.i,
      startX: e.clientX,
      startY: e.clientY,
      origHold: Number(state.images[hit.i - 1].hold ?? 2),
      origEase: Number(state.images[hit.i - 1].gapEase || 0),
      scale: (g.W - KF_PAD * 2) / g.total, // 按下瞬间的像素/秒
    };
    canvas.style.cursor = 'grabbing';
    drawKeyframeTimeline();
  });
  canvas.addEventListener('pointermove', (e) => {
    const { mx, my } = pos(e);
    if (kfDrag) {
      const im = state.images[kfDrag.i - 1];
      const dHold = (e.clientX - kfDrag.startX) / kfDrag.scale;
      im.hold = Math.round(Math.min(MT_MAX_GAP, Math.max(MT_MIN_GAP, kfDrag.origHold + dHold)) * 10) / 10;
      const dEase = (kfDrag.startY - e.clientY) / 40; // 上拖 40px = +1 缓出
      im.gapEase = Math.round(Math.min(1, Math.max(-1, kfDrag.origEase + dEase)) * 20) / 20;
      updateWholeTotal();
      drawKeyframeTimeline();
      return;
    }
    const hit = kfHitTest(mx, my);
    const changed = JSON.stringify(hit) !== JSON.stringify(kfHover);
    kfHover = hit;
    canvas.style.cursor = hit ? (hit.type === 'key' ? (hit.i === 0 ? 'default' : 'grab') : 'pointer') : 'default';
    if (changed) drawKeyframeTimeline();
  });
  const endDrag = (e) => {
    if (!kfDrag) return;
    try { canvas.releasePointerCapture(e.pointerId); } catch {}
    kfDrag = null;
    canvas.style.cursor = 'grab';
    renderImageList(); // 同步左侧小滑杆并触发保存
    scheduleSave();
    drawKeyframeTimeline();
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('pointerleave', () => {
    if (!kfDrag && kfHover) { kfHover = null; drawKeyframeTimeline(); }
  });
})();

// 段落编辑弹窗
let gapDlgIdx = -1;
function openGapDialog(i) {
  gapDlgIdx = i;
  const im = state.images[i];
  $('gapDialogTitle').textContent = `段落 ${i + 1} → ${i + 2}（关键帧 ${i + 1} 到 ${i + 2} 之间）`;
  $('gapDlgSeconds').value = Number(im.hold ?? 2).toFixed(1);
  $('gapDlgActing').value = im.gapActing ?? 0;
  $('gapDlgActingVal').textContent = (im.gapActing ?? 0) > 0 ? im.gapActing : '全局';
  $('gapDlgEase').value = Math.round(Number(im.gapEase || 0) * 100);
  $('gapDlgEaseVal').textContent = easeLabel(Number(im.gapEase || 0));
  $('gapDlgPrompt').value = im.gapPrompt || '';
  $('gapDialog').showModal();
}

// ---------------- 模式切换 ----------------
function switchMode(mode) {
  stopPlayback();
  $('viewInbetween').hidden = mode !== 'inbetween';
  $('viewV2V').hidden = mode !== 'v2v';
  $('viewRefine').hidden = mode !== 'refine';
  $('viewLibrary').hidden = mode !== 'library';
  $('viewMotion').hidden = mode !== 'motion';
  $('viewDirector').hidden = mode !== 'director';
  $('tabInbetween').classList.toggle('active', mode === 'inbetween');
  $('tabV2V').classList.toggle('active', mode === 'v2v');
  $('tabRefine').classList.toggle('active', mode === 'refine');
  $('tabLibrary').classList.toggle('active', mode === 'library');
  $('tabMotion').classList.toggle('active', mode === 'motion');
  $('tabDirector').classList.toggle('active', mode === 'director');
  // 收起式导航：同步当前工作区徽章，选择后浮层立即收起（离开 hover 前也不再挡视线）
  const MODE_NAMES = {
    inbetween: ['工作区 1', '中割生成', 1],
    v2v: ['工作区 2', '视频转绘上色', 2],
    refine: ['工作区 3', '原画精修', 3],
    library: ['工作区 4', '提示词库', 4],
    motion: ['工作区 5', '動作分析', 5],
    director: ['工作区 6', 'REFERENCES TOOL', 6],
  };
  const nm = MODE_NAMES[mode];
  if (nm) {
    $('modeCurrentKicker').textContent = nm[0];
    $('modeCurrentTitle').textContent = nm[1];
    $('modeCount').textContent = nm[2] + ' / 6';
  }
  const tabsEl = $('modeTabs');
  tabsEl.classList.add('force-hide');
  setTimeout(() => tabsEl.classList.remove('force-hide'), 250);
  if (mode === 'inbetween') layoutMacroTimeline(); // 隐藏时宽度为 0，回来时重排
  if (mode === 'library') renderLibraryPage();
  if (mode === 'motion') {
    $('motionUseV2V').hidden = !state.v2v.sourceUrl || !!state.motion.srcUrl;
    drawMotionChart(); // 隐藏时 canvas 宽度为 0
  }
  if (mode === 'director') {
    // 自愈：任何历史异常都不能把生成按钮锁死（并发模式下按钮永远可点）。
    // 只碰 disabled，不覆写文案 —— 覆写会破坏两行排版与多语翻译
    $('btnDirectorGen').disabled = false;
  }
}

// ---------------- 关键帧管理 ----------------
async function addFiles(files) {
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue;
    try {
      const url = await uploadAsset(f);
      state.images.push({ id: nextImgId++, name: f.name, url, hold: 2 });
    } catch (e) {
      alert('上传失败: ' + errMsg(e));
    }
  }
  rebuildSegments();
  renderAll();
  scheduleSave();
}

function removeImage(id) {
  state.images = state.images.filter((im) => im.id !== id);
  rebuildSegments();
  renderAll();
  scheduleSave();
}

function moveImage(fromIdx, toIdx) {
  const [it] = state.images.splice(fromIdx, 1);
  state.images.splice(toIdx, 0, it);
  rebuildSegments();
  renderAll();
  scheduleSave();
}

// 相邻对 -> 分段；同一图片对的已有生成结果通过 segCache 复用
function rebuildSegments() {
  stopPlayback();
  state.segments = [];
  for (let i = 0; i < state.images.length - 1; i++) {
    const key = state.images[i].id + '>' + state.images[i + 1].id;
    let seg = state.segCache.get(key);
    if (!seg) {
      seg = { key, status: 'idle', error: null, versions: [], active: -1, prompt: '', seconds: null };
      state.segCache.set(key, seg);
    }
    state.segments.push(seg);
  }
}

// ---------------- 中割生成 ----------------
async function generateSegment(i, overrides = {}) {
  const seg = state.segments[i];
  if (!seg || seg.status === 'running') return;
  const first = state.images[i], last = state.images[i + 1];
  let prompt = overrides.prompt ?? (seg.prompt || $('globalPrompt').value);
  // 段缓动措辞注入：让生成模型理解该段的节奏意图（KEYFRAME TIMELINE 上下拖调整）
  const segEaseText = easePromptText(Number(first.gapEase || 0));
  if (segEaseText && !String(prompt).includes(segEaseText)) prompt = prompt ? `${prompt}，${segEaseText}` : segEaseText;
  const seconds = overrides.seconds ?? (seg.seconds || Number($('segSeconds').value));
  seg.status = 'running';
  seg.error = null;
  renderTimeline();
  try {
    const res = await fetch('/api/segments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        first: first.url,
        last: last.url,
        prompt,
        duration: seconds,
        stylePrompt: $('stylePrompt').value.trim(),
        inbetweenPrompt: $('inbetweenPrompt').value.trim(),
        actingPrompt: buildActingPrompt(),
      }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || res.statusText);
    trackPendingTask({ id: json.id, kind: 'segment', segKey: seg.key, prompt, seconds });
    try {
      await pollTask(seg, json.id, { prompt, seconds });
    } finally {
      untrackPendingTask(json.id);
    }
  } catch (e) {
    seg.status = 'error';
    seg.error = errMsg(e);
  }
  renderTimeline();
  scheduleSave();
}

async function pollTask(seg, taskId, meta = {}) {
  for (;;) {
    const res = await fetch('/api/segments/' + taskId);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || ('轮询失败 ' + res.status));
    if (json.status === 'succeeded') {
      const version = {
        videoUrl: json.videoUrl,
        time: new Date().toLocaleString('zh-CN', { hour12: false }),
        prompt: meta.prompt || '',
        seconds: meta.seconds || null,
        frames: null,
        diffs: null,
        w: 0,
        h: 0,
      };
      seg.versions.push(version);
      seg.active = seg.versions.length - 1;
      seg.status = 'success';
      extractFrames(version).catch((e) => console.warn('抽帧失败', e));
      return;
    }
    if (json.status === 'failed') throw new Error(json.error || '生成失败');
    if (json.status !== 'running') throw new Error('任务状态未知');
    await new Promise((r) => setTimeout(r, 2500));
  }
}

async function batchGenerate() {
  if (state.segments.length === 0) { alert('请先上传至少 2 张关键帧'); return; }
  await Promise.all(state.segments.map((_, i) => generateSegment(i)));
}

// ---------------- 抽帧（预览缓存 24fps） ----------------
function loadVideo(url) {
  return new Promise((res, rej) => {
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    v.onloadeddata = () => { v.pause(); res(v); };
    v.onerror = () => rej(new Error('视频加载失败 ' + url));
    v.src = url;
    const p = v.play();
    if (p) p.catch(() => {});
  });
}

// 抽帧串行队列：同一时间只跑一个，避免多视频同时解码卡死页面
let extractChain = Promise.resolve();
function extractFrames(version) {
  if (version.frames) return Promise.resolve();
  if (version.extractPromise) return version.extractPromise;
  version.extractPromise = extractChain
    .then(() => (version.frames ? null : doExtractFrames(version)))
    .then((r) => { version.extractFailed = false; return r; })
    .catch((e) => { version.extractFailed = true; throw e; }) // 标记终态失败，避免播放端无限重试
    .finally(() => { version.extractPromise = null; });
  extractChain = version.extractPromise.catch(() => {});
  return version.extractPromise;
}

// 释放某分段中非当前版本的帧缓存（ImageBitmap 显存/内存）
function releaseInactiveFrames(seg) {
  seg.versions.forEach((v, vi) => {
    if (vi !== seg.active && v.frames) {
      for (const b of v.frames) { if (b.close) b.close(); }
      v.frames = null;
      v.diffs = null;
    }
  });
}

async function doExtractFrames(version) {
  const v = await loadVideo(version.videoUrl);
  const scale = Math.min(1, FRAME_MAX_W / v.videoWidth);
  const w = Math.round(v.videoWidth * scale), h = Math.round(v.videoHeight * scale);
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  const dv = document.createElement('canvas');
  dv.width = 64; dv.height = 36;
  const dctx = dv.getContext('2d', { willReadFrequently: true });

  const n = Math.max(2, Math.round(v.duration * PREVIEW_FPS));
  const frames = [], diffs = [];
  let prevLuma = null;
  for (let i = 0; i < n; i++) {
    const t = Math.min(i / PREVIEW_FPS, Math.max(0, v.duration - 0.01));
    await seekTo(v, t);
    ctx.drawImage(v, 0, 0, w, h);
    frames.push(await createImageBitmap(cv));
    dctx.drawImage(v, 0, 0, 64, 36);
    const data = dctx.getImageData(0, 0, 64, 36).data;
    const luma = new Float32Array(64 * 36);
    for (let p = 0; p < luma.length; p++) {
      luma[p] = data[p * 4] * 0.299 + data[p * 4 + 1] * 0.587 + data[p * 4 + 2] * 0.114;
    }
    if (prevLuma) {
      let s = 0;
      for (let p = 0; p < luma.length; p++) s += Math.abs(luma[p] - prevLuma[p]);
      diffs.push(s / luma.length);
    }
    prevLuma = luma;
    if (i % 6 === 5) await new Promise((r) => setTimeout(r, 0)); // 让出主线程，避免长循环卡 UI
  }
  diffs.unshift(diffs[0] ?? 0);
  version.frames = frames;
  version.diffs = diffs;
  version.w = w; version.h = h;
  renderTimeline();
}

function seekTo(v, t) {
  return new Promise((res) => {
    if (Math.abs(v.currentTime - t) < 0.001) return res();
    v.onseeked = () => res();
    v.currentTime = t;
  });
}

// ---------------- 播放调度 ----------------
function readySegments() {
  return state.segments
    .map((seg, i) => ({ seg, i, ver: seg.versions[seg.active] }))
    .filter((x) => x.ver && x.ver.frames);
}

function buildGlobalFrames() {
  const list = [];
  for (const { i, ver } of readySegments()) {
    for (let f = 0; f < ver.frames.length; f++) {
      list.push({ segIdx: i, ver, frameIdx: f, diff: ver.diffs[f] });
    }
  }
  return list;
}

function buildRemapSchedule(globalFrames) {
  const M = Math.max(2, Math.round(Number($('remapSeconds').value) * Number($('remapFps').value)));
  const n = globalFrames.length;
  if (n === 0) return [];
  const useTame = $('chkTame').checked;
  const s = Number($('sensitivity').value) / 100;
  let weights;
  if (useTame && s > 0) {
    const maxDiff = Math.max(...globalFrames.map((f) => f.diff), 1e-6);
    weights = globalFrames.map((f) => (1 - s) + s * (f.diff / maxDiff));
  } else {
    weights = new Array(n).fill(1);
  }
  const cum = new Float64Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) { acc += weights[i]; cum[i] = acc; }
  const total = cum[n - 1];
  const picks = [];
  for (let j = 0; j < M; j++) {
    const target = (j + 0.5) * total / M;
    let lo = 0, hi = n - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; (cum[mid] < target) ? lo = mid + 1 : hi = mid; }
    picks.push(globalFrames[lo]);
  }
  return picks;
}

function startPlayback(mode) {
  stopPlayback();
  // 只要有任一分段的当前版本还没抽帧，就先抽全再播放，避免悄悄跳过分段
  const pending = state.segments
    .map((s) => s.versions[s.active])
    .filter((v) => v && v.videoUrl && !v.frames && !v.extractFailed);
  if (pending.length) {
    setBadge('抽帧准备中…');
    Promise.all(pending.map((v) => extractFrames(v).catch(() => {})))
      .then(() => { if (!state.playing) startPlayback(mode); });
    return;
  }
  const globalFrames = buildGlobalFrames();
  if (globalFrames.length === 0) {
    const anyFailed = state.segments.some((s) => {
      const v = s.versions[s.active];
      return v && v.extractFailed;
    });
    setBadge(anyFailed ? '分段视频文件缺失或无法解码，请重新生成' : '无可播放分段');
    return;
  }
  let schedule, fps;
  if (mode === 'remap') {
    schedule = buildRemapSchedule(globalFrames);
    fps = Number($('remapFps').value);
  } else {
    schedule = globalFrames;
    fps = PREVIEW_FPS;
  }
  state.playing = { mode, schedule, fps, startTime: performance.now(), timerId: 0, lastDrawn: -1 };
  $('btnPlaySeq').classList.toggle('active', mode === 'seq');
  $('btnPlayRemap').classList.toggle('active', mode === 'remap');
  tick();
}

// setTimeout 驱动（rAF 在窗口后台会停），按经过时间定位帧
function tick() {
  const p = state.playing;
  if (!p) return;
  const elapsed = (performance.now() - p.startTime) / 1000;
  let idx = Math.floor(elapsed * p.fps);
  if (idx >= p.schedule.length) {
    if ($('chkLoop').checked) {
      p.startTime = performance.now();
      idx = 0;
    } else {
      drawFrame(p.schedule[p.schedule.length - 1], p.schedule.length - 1, p);
      stopPlayback('播放完成');
      return;
    }
  }
  if (idx !== p.lastDrawn) {
    drawFrame(p.schedule[idx], idx, p);
    p.lastDrawn = idx;
  }
  p.timerId = setTimeout(tick, 1000 / p.fps / 2);
}

function stopPlayback(msg) {
  if (state.playing) clearTimeout(state.playing.timerId);
  state.playing = null;
  $('btnPlaySeq').classList.remove('active');
  $('btnPlayRemap').classList.remove('active');
  setBadge(msg || '已停止');
  if (!msg) { $('badgeTime').textContent = ''; $('badgeFrame').textContent = ''; }
  highlightPlaying(-1);
}

const canvas = $('previewCanvas');
const cctx = canvas.getContext('2d');

function drawFrame(item, idx, p) {
  const bmp = item.ver.frames[item.frameIdx];
  if (canvas.width !== item.ver.w || canvas.height !== item.ver.h) {
    canvas.width = item.ver.w;
    canvas.height = item.ver.h;
  }
  cctx.fillStyle = '#fff';
  cctx.fillRect(0, 0, canvas.width, canvas.height);
  cctx.drawImage(bmp, 0, 0);

  const total = p.schedule.length;
  if (p.mode === 'remap') {
    setBadge(`重映射播放 ${$('remapSeconds').value}s / ${p.fps}fps`);
  } else {
    setBadge(`分段 ${item.segIdx + 1}/${state.segments.length}`);
  }
  $('badgeTime').textContent = $('chkShowPos').checked
    ? `${fmt(idx / p.fps)}s / ${fmt(total / p.fps)}s` : '';
  $('badgeFrame').textContent = $('chkShowFrames').checked ? `${idx + 1} / ${total} f` : '';

  highlightPlaying(item.segIdx);
  const progress = item.frameIdx / Math.max(1, item.ver.frames.length - 1);
  highlightInput(progress < 0.5 ? item.segIdx : item.segIdx + 1);
}

function setBadge(t) { $('badgeStatus').textContent = t; }

function highlightPlaying(segIdx) {
  document.querySelectorAll('#timeline .seg-card').forEach((el, i) =>
    el.classList.toggle('playing', i === segIdx));
  if (segIdx < 0) highlightInput(-1);
}
function highlightInput(imgIdx) {
  document.querySelectorAll('#inputGrid .input-cell').forEach((el, i) =>
    el.classList.toggle('active', i === imgIdx));
}

// ---------------- 导出 ----------------
function setExportStatus(t) { $('exportStatus').textContent = t || ''; }

async function concatReady() {
  // 服务器端拼接只需要 videoUrl，与是否已抽帧无关：始终按分段顺序取当前版本，避免悄悄丢段
  const withVideo = state.segments
    .map((seg) => seg.versions[seg.active])
    .filter((v) => v && v.videoUrl);
  if (!withVideo.length) return null;
  const res = await fetch('/api/concat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ urls: withVideo.map((v) => v.videoUrl), fps: PREVIEW_FPS }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || '拼接失败');
  return json.url;
}

async function exportMp4() {
  if (state.exporting) return;
  state.exporting = true;
  try {
    if ($('chkExportRemap').checked) {
      await exportRemapMp4();
    } else {
      setExportStatus('服务器拼接中…');
      const url = await concatReady();
      if (!url) throw new Error('还没有生成完成的分段');
      download(url, 'inbetween_full.mp4');
      setExportStatus('已导出拼接 mp4');
    }
  } catch (e) {
    setExportStatus('导出失败: ' + errMsg(e));
  } finally {
    state.exporting = false;
  }
}

async function exportRemapMp4() {
  stopPlayback();
  // 导出前把所有分段当前版本的帧抽全，防止只导出部分分段
  const pending = state.segments
    .map((s) => s.versions[s.active])
    .filter((v) => v && v.videoUrl && !v.frames && !v.extractFailed);
  if (pending.length) {
    setExportStatus('抽帧准备中…');
    await Promise.all(pending.map((v) => extractFrames(v).catch(() => {})));
  }
  const missing = state.segments.some((s) => {
    const v = s.versions[s.active];
    return v && v.videoUrl && !v.frames;
  });
  if (missing) throw new Error('部分分段视频缺失或无法解码，无法完整导出重映射');
  const schedule = buildRemapSchedule(buildGlobalFrames());
  if (schedule.length === 0) throw new Error('无可导出帧');
  const fps = Number($('remapFps').value);
  const first = schedule[0];
  canvas.width = first.ver.w; canvas.height = first.ver.h;
  const stream = canvas.captureStream(fps);
  const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9', videoBitsPerSecond: 12_000_000 });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise((r) => (rec.onstop = r));
  rec.start();
  setExportStatus(`重映射录制中（${fmt(schedule.length / fps, 1)}s 实时）…`);
  const t0 = performance.now();
  await new Promise((resolve) => {
    const step = () => {
      const idx = Math.floor((performance.now() - t0) / 1000 * fps);
      if (idx >= schedule.length) return resolve();
      const item = schedule[Math.min(idx, schedule.length - 1)];
      cctx.fillStyle = '#fff';
      cctx.fillRect(0, 0, canvas.width, canvas.height);
      cctx.drawImage(item.ver.frames[item.frameIdx], 0, 0, canvas.width, canvas.height);
      setTimeout(step, 1000 / fps / 2);
    };
    step();
  });
  rec.stop();
  await done;
  setExportStatus('转码 mp4 中…');
  const blob = new Blob(chunks, { type: 'video/webm' });
  const res = await fetch('/api/convert', { method: 'POST', body: blob });
  if (!res.ok) {
    if (res.status === 413) throw new Error('转码失败：视频过大（上限 800MB）');
    const txt = await res.text().catch(() => '');
    let msg = '';
    try { msg = JSON.parse(txt).error || ''; } catch {}
    throw new Error(msg || ('转码失败 HTTP ' + res.status));
  }
  const json = await res.json();
  download(json.url, 'inbetween_remap.mp4');
  setExportStatus('已导出重映射 mp4');
}

async function exportZip() {
  const globalFrames = buildGlobalFrames();
  if (globalFrames.length === 0) { alert('还没有生成完成的分段（或帧未抽取，先播放一次）'); return; }
  const schedule = $('chkExportRemap').checked ? buildRemapSchedule(globalFrames) : globalFrames;
  setExportStatus(`打包 ${schedule.length} 帧 PNG…`);
  const cv = document.createElement('canvas');
  const ctx = cv.getContext('2d');
  const entries = [];
  for (let i = 0; i < schedule.length; i++) {
    const item = schedule[i];
    cv.width = item.ver.w; cv.height = item.ver.h;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.drawImage(item.ver.frames[item.frameIdx], 0, 0);
    const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
    entries.push({ name: `frame_${String(i + 1).padStart(4, '0')}.png`, data: new Uint8Array(await blob.arrayBuffer()) });
    if (i % 10 === 0) setExportStatus(`打包 PNG ${i + 1}/${schedule.length}…`);
  }
  const zip = makeZip(entries);
  const url = URL.createObjectURL(new Blob([zip], { type: 'application/zip' }));
  download(url, 'inbetween_frames.zip');
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  setExportStatus(`已导出 ${schedule.length} 帧 PNG zip`);
}

// 最小 zip 实现（STORE 无压缩）
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function makeZip(entries) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const crc = crc32(e.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, e.data.length, true);
    local.setUint32(22, e.data.length, true);
    local.setUint16(26, name.length, true);
    parts.push(new Uint8Array(local.buffer), name, e.data);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(6, 20, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, e.data.length, true);
    cd.setUint32(24, e.data.length, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + e.data.length;
  }
  let cdSize = 0;
  for (const c of central) cdSize += c.length;
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cdSize + 22);
  let pos = 0;
  for (const p of [...parts, ...central, new Uint8Array(end.buffer)]) { out.set(p, pos); pos += p.length; }
  return out;
}

function download(url, name) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ---------------- 存入项目文件夹 ----------------
// payload: { src, kind:'video'|'image', name? } 或 { text, filename, kind:'prompt' }
let projSavePayload = null;
const saveToast = document.createElement('div');
saveToast.className = 'save-toast';
document.body.appendChild(saveToast);
let saveToastTimer = 0;
function showSaveToast(msg, ok = true) {
  saveToast.textContent = msg;
  saveToast.classList.toggle('err', !ok);
  saveToast.classList.add('show');
  clearTimeout(saveToastTimer);
  saveToastTimer = setTimeout(() => saveToast.classList.remove('show'), 2600);
}

async function openProjSave(payload) {
  projSavePayload = payload;
  const list = $('projSaveList');
  list.innerHTML = `<div class="hint">${t('读取项目列表…')}</div>`;
  $('projSaveDialog').showModal();
  try {
    const res = await fetch('/api/projects');
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || res.statusText);
    const projects = json.projects || [];
    list.innerHTML = '';
    if (projects.length === 0) {
      list.innerHTML = `<div class="hint">${t('该目录下还没有项目 — 在 Director 仪表盘新建')}</div>`;
      return;
    }
    for (const p of projects) {
      const row = document.createElement('button');
      row.className = 'proj-row';
      row.title = p.dir;
      row.innerHTML = `
        <span class="proj-ico">📁</span>
        <span class="proj-name">${escapeHtml(p.name)}</span>
        <span class="proj-dir">${escapeHtml(p.dir)}</span>`;
      row.onclick = () => saveToProject(p);
      list.appendChild(row);
    }
  } catch (e) {
    list.innerHTML = `<div class="hint">${t('保存失败')}: ${escapeHtml(errMsg(e))}</div>`;
  }
}

async function saveToProject(p) {
  const payload = projSavePayload;
  if (!payload) return;
  $('projSaveDialog').close();
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(p.id)}/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const json = await res.json();
    if (!res.ok || !json.ok) throw new Error(json.error || res.statusText);
    showSaveToast(`${t('已存入')} 📁 ${p.name}`);
  } catch (e) {
    showSaveToast(t('保存失败') + ': ' + errMsg(e), false);
  }
}

// ---------------- 生成队列：多任务并行 + 进度 ----------------
let nextJobId = 1;
const jobs = [];

function addJob(label, estSec) {
  const job = { id: nextJobId++, label, estSec, startedAt: performance.now(), status: 'running', error: null };
  jobs.push(job);
  renderJobs();
  return job;
}
function finishJob(job, ok, error) {
  if (!job) return; // addJob 失败等极端场景下的空 job 保护
  job.status = ok ? 'succeeded' : 'failed';
  job.error = error || null;
  renderJobs();
  if (window.refreshMe) window.refreshMe(); // 公开站：刷新积分余额
  // 成功 8 秒后自动消失；失败保留 60 秒供查看
  setTimeout(() => {
    const i = jobs.indexOf(job);
    if (i >= 0) { jobs.splice(i, 1); renderJobs(); }
  }, ok ? 8000 : 60000);
}
function renderJobs() {
  const el = $('jobStack');
  el.innerHTML = '';
  for (const j of jobs) {
    const sec = (performance.now() - j.startedAt) / 1000;
    const pct = j.status === 'running' ? Math.min(95, (sec / j.estSec) * 100) : 100;
    const card = document.createElement('div');
    card.className = 'job-card ' + j.status;
    card.innerHTML = `
      <div class="job-head"><span>${escapeHtml(j.label)}</span>
        <span>${j.status === 'running' ? Math.round(sec) + 's' : (j.status === 'succeeded' ? '✓ 完成' : '✕ 失败')}</span></div>
      <div class="job-bar"><i style="width:${pct.toFixed(0)}%"></i></div>
      ${j.error ? `<div class="job-err">${escapeHtml(j.error)}</div>` : ''}`;
    card.onclick = () => {
      if (j.status !== 'running') {
        const i = jobs.indexOf(j);
        if (i >= 0) { jobs.splice(i, 1); renderJobs(); }
      }
    };
    el.appendChild(card);
  }
  el.hidden = jobs.length === 0;
}
setInterval(() => { if (jobs.some((j) => j.status === 'running')) renderJobs(); }, 1000);

async function pollUntilDone(taskId) {
  for (;;) {
    await new Promise((r) => setTimeout(r, 4000));
    const res = await fetch('/api/segments/' + taskId);
    const p = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(p.error || ('轮询失败 ' + res.status));
    if (p.status === 'succeeded') return p;
    if (p.status === 'failed') throw new Error(p.error || '生成失败');
    if (p.status !== 'running') throw new Error('任务状态未知');
  }
}

// ---------------- 未完成任务登记：刷新/重启后恢复轮询，找回已付费的结果 ----------------
function trackPendingTask(entry) {
  state.pendingTasks.push(entry);
  scheduleSave();
}
function untrackPendingTask(id) {
  const i = state.pendingTasks.findIndex((x) => x && x.id === id);
  if (i >= 0) { state.pendingTasks.splice(i, 1); scheduleSave(); }
}
/** 恢复一条工程快照里的未完成任务：继续轮询并把结果补进对应历史 */
async function resumePendingTask(entry) {
  if (!entry || !entry.id) return;
  try {
    if (entry.kind === 'whole') {
      const job = addJob(`🎬 一体生成 ${entry.frames || '?'}帧 → ${entry.duration || '?'}s（恢复）`, 60 + (entry.duration || 8) * 25);
      try {
        const p = await pollUntilDone(entry.id);
        state.whole.history.unshift({
          videoUrl: p.videoUrl,
          time: new Date().toLocaleString('zh-CN', { hour12: false }),
          duration: entry.duration || 0,
          frames: entry.frames || 0,
          note: entry.note || '',
          acting: entry.acting,
          actingTier: entry.actingTier,
          dl: false,
        });
        state.whole.current = 0;
        renderWhole();
        finishJob(job, true);
      } catch (e) {
        finishJob(job, false, errMsg(e));
      }
    } else if (entry.kind === 'v2v') {
      const job = addJob(`🎨 转绘上色 ${entry.duration || '?'}s（恢复）`, 90 + (entry.duration || 8) * 30);
      try {
        const p = await pollUntilDone(entry.id);
        state.v2v.history.unshift({
          videoUrl: p.videoUrl,
          time: new Date().toLocaleString('zh-CN', { hour12: false }),
          duration: entry.duration || 0,
          sourceUrl: entry.sourceUrl || null,
          refs: (entry.refs || []).length,
          refUrls: entry.refs || [],
          colorPrompt: entry.colorPrompt || '',
          note: entry.note || '',
        });
        state.v2v.current = 0;
        renderV2V();
        finishJob(job, true);
      } catch (e) {
        finishJob(job, false, errMsg(e));
      }
    } else if (entry.kind === 'director') {
      const job = addJob(`🎬 导演生成 ${entry.duration || '?'}s（恢复）`, 60 + (entry.duration || 8) * 25);
      try {
        const p = await pollUntilDone(entry.id);
        state.director.history.unshift({
          videoUrl: p.videoUrl,
          time: new Date().toLocaleString('zh-CN', { hour12: false }),
          duration: entry.duration || 0,
          model: entry.model || '',
          note: entry.note || '',
        });
        state.director.current = 0;
        renderDirector();
        finishJob(job, true);
      } catch (e) {
        finishJob(job, false, errMsg(e));
      }
    } else if (entry.kind === 'segment' && entry.segKey) {
      const seg = state.segCache.get(entry.segKey);
      if (seg && seg.status !== 'running') {
        seg.status = 'running';
        seg.error = null;
        renderTimeline();
        try {
          await pollTask(seg, entry.id, { prompt: entry.prompt || '', seconds: entry.seconds || null });
        } catch (e) {
          seg.status = 'error';
          seg.error = errMsg(e);
        }
        renderTimeline();
      }
    }
  } finally {
    untrackPendingTask(entry.id);
    scheduleSave();
  }
}

// ---------------- 一体生成：全部关键帧 → 单次连续动画 ----------------
function setWholeStatus(t) {
  $('wholeStatus').textContent = t || '';
  // 镜像到右栏一体生成按钮下方（与导演区 dirGoStatus 同款：在哪个按钮点的都看得到）
  const side = $('wholeStatusSide');
  if (side) {
    side.textContent = t || '';
    side.classList.toggle('warn', /^⚠|失败|已满|超过/.test(String(t || '')));
  }
}

/** 组装一次一体生成的完整请求（真实生成与 SIMULATE GEN 共用同一条管线）；被拦时返回 null */
function assembleWholeRequest() {
  if (state.images.length < 2) { alert('请先上传至少 2 张关键帧'); return null; }
  if (state.images.length > 100) { alert('最多 100 张关键帧'); return null; }
  const gaps = wholeGaps();
  const totalDur = Math.max(4, Math.min(modelIs25() ? 30 : 15, Math.round(wholeTotalSeconds())));
  const frames = state.images.length;
  const note = $('globalPrompt').value.trim();
  const refs = ibRefsAll();
  // 参考使用说明与导演区同一套注入文案；编号约定（参考图K=图片N+K）由服务端桥接段声明
  const refNotes = buildRefNotesLines(refs);
  const prompt = [note, refNotes.length ? '参考素材使用说明：\n' + refNotes.join('\n') : '']
    .filter(Boolean).join('\n');
  return {
    frames, totalDur, note,
    actingLevel: Number($('acting').value),
    body: {
      images: state.images.map((im) => im.url),
      refImages: refs.filter((r) => (r.kind || 'image') === 'image').map((r) => r.url),
      refVideos: refs.filter((r) => r.kind === 'video').map((r) => r.url),
      refAudios: refs.filter((r) => r.kind === 'audio').map((r) => r.url),
      prompt,
      stylePrompt: $('stylePrompt').value.trim(),
      inbetweenPrompt: $('inbetweenPrompt').value.trim(),
      actingPrompt: buildActingPrompt(),
      duration: totalDur,
      gaps,
    },
    refsMeta: buildRefsMeta(refs),
  };
}

async function wholeGenerate() {
  const req = assembleWholeRequest();
  if (!req) return;
  if (state.images.length > 9 &&
      !confirm(`当前 ${state.images.length} 张关键帧，超过 Seedance 官方参考图上限（9 张），API 可能拒绝。仍要尝试提交吗？`)) return;
  // 提交时快照当前设置，允许随后立刻改设置再提交下一个任务并行跑
  const { frames, totalDur, note, actingLevel } = req;
  const tierName = actingTier(actingLevel).name;
  const body = JSON.stringify(req.body);
  const job = addJob(`🎬 一体生成 ${frames}帧 → ${totalDur}s`, 60 + totalDur * 25);
  setWholeStatus('已提交（可继续提交更多任务并行生成，进度见右下角）');
  try {
    const res = await fetch('/api/whole', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || res.statusText);
    trackPendingTask({ id: json.id, kind: 'whole', duration: totalDur, frames, note, acting: actingLevel, actingTier: tierName });
    let p;
    try {
      p = await pollUntilDone(json.id);
    } finally {
      untrackPendingTask(json.id);
    }
    state.whole.history.unshift({
      videoUrl: p.videoUrl,
      time: new Date().toLocaleString('zh-CN', { hour12: false }),
      duration: totalDur,
      frames,
      note,
      acting: actingLevel,
      actingTier: tierName,
      dl: false,
    });
    state.whole.current = 0;
    loadGenPlayer(p.videoUrl); // 新结果自动载入 ④ 生成回放
    renderWhole();
    scheduleSave();
    finishJob(job, true);
  } catch (e) {
    finishJob(job, false, errMsg(e));
  }
}

/** 下载文件名：带芝居等级与档位，如 一体生成_v3_芝居78夸张.mp4 */
function wholeFileName(h, ver) {
  const shibai = h.acting ? `_芝居${h.acting}${h.actingTier || ''}` : '';
  return `一体生成_v${ver}${shibai}_${h.duration}s.mp4`;
}

function renderWhole() {
  const w = state.whole;
  // 顶部旧播放器已废弃 —— 点击历史卡片载入 ④ 生成回放大播放器
  $('wholeResult').hidden = true;
  $('wholeResultEmpty').hidden = w.history.length > 0;
  const hist = $('wholeHistory');
  hist.innerHTML = '';
  w.history.forEach((h, idx) => {
    const ver = w.history.length - idx;
    const card = document.createElement('div');
    card.className = 'gen-card' + (h.dl ? '' : ' undownloaded') + (h.videoUrl === genPlayerUrl ? ' playing' : '');
    card.dataset.url = h.videoUrl;
    card.innerHTML = `
      <div class="gen-thumb-wrap" data-hover-video="${escapeHtml(h.videoUrl)}"><img class="gen-thumb-img" src="/api/media/thumb?src=${encodeURIComponent(h.videoUrl)}" loading="lazy" onerror="this.style.visibility='hidden'"></div>
      <div class="gen-meta">
        <b>v${ver}</b>
        ${h.acting ? `<span class="chip shibai-chip">芝居 ${h.acting} · ${escapeHtml(h.actingTier || '')}</span>` : ''}
        ${h.dl ? '' : `<span class="chip dl-chip">${t('未下载')}</span>`}
        <span class="gen-sub">${escapeHtml(h.time)} · ${h.duration}s · ${h.frames} ${t('张关键帧')}</span>
        ${h.note ? `<span class="gen-note">${escapeHtml(h.note)}</span>` : ''}
        <span class="gen-actions">
          <button class="btn dl" title="${t('下载')}">⬇ ${t('下载')}</button>
          <button class="btn proj" title="${t('存入项目文件夹')}">💾 ${t('项目')}</button>
          <button class="btn tov2v" title="${t('送去转绘上色')}">🎨</button>
        </span>
      </div>`;
    const video = card.querySelector('video');
    card.addEventListener('mouseenter', () => { video.play().catch(() => {}); });
    card.addEventListener('mouseleave', () => { video.pause(); });
    card.addEventListener('click', () => { loadGenPlayer(h.videoUrl); });
    card.querySelector('.dl').onclick = (e) => {
      e.stopPropagation();
      download(h.videoUrl, wholeFileName(h, ver));
      h.dl = true;
      renderWhole();
      scheduleSave();
    };
    card.querySelector('.proj').onclick = (e) => {
      e.stopPropagation();
      openProjSave({ src: h.videoUrl, kind: 'video', name: wholeFileName(h, ver) });
    };
    card.querySelector('.tov2v').onclick = async (e) => {
      e.stopPropagation();
      await setV2VSource(h.videoUrl, `一体生成 v${ver}`);
      switchMode('v2v');
    };
    hist.appendChild(card);
  });
  // 首次渲染时自动载入当前版本，循环播放
  if (w.history.length && !genPlayerUrl) {
    const cur = w.history[Math.min(w.current || 0, w.history.length - 1)];
    if (cur) loadGenPlayer(cur.videoUrl);
  }
}

// ---------------- ④ 生成回放大播放器（替代旧连续预览画布） ----------------
const STEP_FPS = 12; // 逐帧步进上限：每步 1/12 秒
const genPlayer = $('genPlayer');
let genPlayerUrl = '';

function loadGenPlayer(url) {
  if (!url) return;
  genPlayerUrl = url;
  if (genPlayer.getAttribute('src') !== url) genPlayer.src = url;
  genPlayer.hidden = false;
  $('genPlayerEmpty').hidden = true;
  $('genPlayerControls').hidden = false;
  genPlayer.play().catch(() => {});
  updateGenPlayerInfo();
  // 高亮当前载入的历史卡片
  document.querySelectorAll('#wholeHistory .gen-card').forEach((el) =>
    el.classList.toggle('playing', el.dataset.url === url));
}

function updateGenPlayerInfo() {
  const dur = genPlayer.duration;
  if (!genPlayerUrl || !Number.isFinite(dur) || dur <= 0) { $('genPlayerInfo').textContent = ''; return; }
  const total = Math.max(1, Math.round(dur * STEP_FPS));
  const cur = Math.min(total, Math.floor(genPlayer.currentTime * STEP_FPS) + 1);
  $('genPlayerInfo').textContent =
    `${fmt(genPlayer.currentTime)}s / ${fmt(dur)}s · ${cur} / ${total} f · ${STEP_FPS}fps${genPlayer.paused ? ' · ⏸' : ''}`;
}

function stepGenFrame(dir) {
  if (!genPlayerUrl || !Number.isFinite(genPlayer.duration)) return;
  genPlayer.pause(); // 逐帧查看：先定格
  const step = 1 / STEP_FPS;
  const max = Math.max(0, genPlayer.duration - step / 2);
  genPlayer.currentTime = Math.max(0, Math.min(max, genPlayer.currentTime + dir * step));
}

function toggleGenPlayer() {
  if (!genPlayerUrl) return;
  if (genPlayer.paused) genPlayer.play().catch(() => {});
  else genPlayer.pause();
}

$('btnFramePrev').onclick = () => stepGenFrame(-1);
$('btnFrameNext').onclick = () => stepGenFrame(1);
$('btnPlayPause').onclick = toggleGenPlayer;
for (const ev of ['timeupdate', 'seeked', 'play', 'pause', 'loadedmetadata']) {
  genPlayer.addEventListener(ev, updateGenPlayerInfo);
}
// 键盘：空格 = 播放/暂停；← → = 12fps 逐帧（仅中割工作区可见、焦点不在输入控件时）
document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' && e.code !== 'ArrowLeft' && e.code !== 'ArrowRight') return;
  if ($('viewInbetween').hidden || !genPlayerUrl) return;
  const el = document.activeElement;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
  if (document.querySelector('dialog[open]')) return; // 弹窗打开时不劫持快捷键
  // 空格让聚焦的按钮正常触发；方向键保留给逐帧步进（点完播放器按钮后仍可步进）
  if (e.code === 'Space' && el && el.tagName === 'BUTTON') return;
  e.preventDefault();
  if (e.code === 'Space') toggleGenPlayer();
  else stepGenFrame(e.code === 'ArrowRight' ? 1 : -1);
});

// ---------------- 原画精修（Seedream 图生图） ----------------
function setRefineStatus(tx) { $('refineStatus').textContent = tx || ''; }

function setRefineSource(url, name) {
  state.refine.sourceUrl = url;
  state.refine.sourceName = name || '';
  renderRefine();
  scheduleSave();
}

async function refineGenerate() {
  const rf = state.refine;
  if (!rf.sourceUrl) { alert(t('请先选择要精修的源图片')); return; }
  const note = $('refineExtraPrompt').value.trim(); // 提交时快照，避免并行任务记录到之后改过的值
  const prompt = [$('refinePrompt').value.trim(), note].filter(Boolean).join('\n');
  const src = rf.sourceUrl;
  const job = addJob(`🖌 精修 ${rf.sourceName || 'image'}`, 25);
  setRefineStatus(t('已提交（可继续提交更多任务并行生成，进度见右下角）'));
  try {
    const res = await fetch('/api/refine', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: src, prompt, refs: rf.refs.map((r) => r.url) }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || res.statusText);
    rf.history.unshift({
      src,
      out: json.url,
      time: new Date().toLocaleString('zh-CN', { hour12: false }),
      note,
    });
    rf.current = 0;
    renderRefine();
    scheduleSave();
    finishJob(job, true);
  } catch (e) {
    finishJob(job, false, errMsg(e));
  }
}

function renderRefine() {
  const rf = state.refine;
  // 角色设定/色卡参考网格
  const rg = $('refineRefGrid');
  rg.innerHTML = '';
  rf.refs.forEach((r, idx) => {
    const cell = document.createElement('div');
    cell.className = 'input-cell';
    cell.innerHTML = `<img src="${r.url}"><span class="num">${idx + 1}</span><button class="del-ref" title="${t('删除')}">✕</button>`;
    cell.querySelector('.del-ref').onclick = () => {
      rf.refs.splice(idx, 1);
      renderRefine();
      scheduleSave();
    };
    rg.appendChild(cell);
  });
  // 关键帧快选网格
  const grid = $('refinePickGrid');
  grid.innerHTML = '';
  state.images.forEach((im, idx) => {
    const cell = document.createElement('div');
    cell.className = 'input-cell' + (rf.sourceUrl === im.url ? ' active' : '');
    cell.style.cursor = 'pointer';
    cell.innerHTML = `<img src="${im.url}"><span class="num">${idx + 1}</span>`;
    cell.onclick = () => setRefineSource(im.url, im.name);
    grid.appendChild(cell);
  });
  // 结果对比
  const cur = rf.history[rf.current];
  $('refineCompare').hidden = !cur;
  $('refineActions').hidden = !cur;
  $('refineEmpty').hidden = !!cur || !!rf.sourceUrl;
  if (!cur && rf.sourceUrl) {
    // 只选了源图：左边显示原图
    $('refineCompare').hidden = false;
    $('refineBefore').src = rf.sourceUrl;
    $('refineAfter').removeAttribute('src');
  } else if (cur) {
    $('refineBefore').src = cur.src;
    $('refineAfter').src = cur.out;
  }
  // 历史
  const hist = $('refineHistory');
  hist.innerHTML = '';
  rf.history.forEach((h, idx) => {
    const card = document.createElement('div');
    card.className = 'hist-card' + (idx === rf.current ? ' active' : '');
    card.innerHTML = `
      <img src="${h.out}" style="width:120px;border-radius:4px;background:#fff">
      <div class="meta"><b>${t('版本')} ${rf.history.length - idx}</b>${escapeHtml(h.time)}${h.note ? '<br>' + escapeHtml(h.note) : ''}</div>
      <button class="btn dl">⬇</button>
      <button class="btn proj" title="${t('存入项目文件夹')}">💾</button>`;
    card.onclick = () => { rf.current = idx; renderRefine(); };
    card.querySelector('.dl').onclick = (e) => {
      e.stopPropagation();
      download(h.out, `refine_${rf.history.length - idx}.png`);
    };
    card.querySelector('.proj').onclick = (e) => {
      e.stopPropagation();
      openProjSave({ src: h.out, kind: 'image', name: `refine_${rf.history.length - idx}.png` });
    };
    hist.appendChild(card);
  });
}

// ---------------- 提示词库（分区文件夹 · 整页工作区 4 + 可拖拽浮动面板 · JSON 转换器） ----------------
let presetTargetId = null;
let libTab = null;          // 浮动面板当前页签：分区 id | 'used' | 'json'
let plOpenFolderId = null;  // 整页视图当前打开的分区
let plLastJson = null;      // 整页 JSON 预览的最近一次结果（供下载/复制）
if (!state.folders) state.folders = [];

const newPromptId = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const newFolderId = () => 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const getFolder = (id) => state.folders.find((f) => f.id === id);

function saveFolders() {
  fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ promptFolders: state.folders }),
  }).catch(() => {});
}

/** 分区数据加载：优先 cfg.promptFolders；为空时从旧版分类预设一次性迁移 */
function loadFoldersFrom(cfg) {
  let folders = Array.isArray(cfg.promptFolders)
    ? cfg.promptFolders.filter((f) => f && f.id && Array.isArray(f.prompts))
    : [];
  if (folders.length === 0) {
    const presets = cfg.presets || [];
    const catNames = { general: '默认', storyboard: '分镜', qa: '质检' };
    for (const [cat, name] of Object.entries(catNames)) {
      const prompts = presets
        .filter((p) => (p.category || 'general') === cat)
        .map((p) => ({ id: p.id || newPromptId(), name: p.name, text: p.text, createdAt: '' }));
      if (cat === 'general' || prompts.length) folders.push({ id: 'f-' + cat, name, prompts });
    }
    if (folders.length === 0) folders = [{ id: 'f-default', name: '默认', prompts: [] }];
    state.folders = folders;
    saveFolders(); // 持久化迁移结果
    return;
  }
  state.folders = folders;
}

/** 在分区间移动/重排提示词（拖拽的落点逻辑） */
function movePrompt(pid, fromId, toId, toIndex) {
  const from = getFolder(fromId);
  const to = getFolder(toId);
  if (!from || !to) return;
  const i = from.prompts.findIndex((x) => x.id === pid);
  if (i < 0) return;
  const [p] = from.prompts.splice(i, 1);
  if (toIndex === undefined || toIndex < 0 || toIndex > to.prompts.length) to.prompts.push(p);
  else to.prompts.splice(toIndex, 0, p);
  saveFolders();
  renderLibraryPage();
  if (!$('libraryPanel').hidden) renderLibrary();
}

function rebuildFolderSelect(sel, selectedId) {
  sel.innerHTML = '';
  for (const f of state.folders) {
    const o = document.createElement('option');
    o.value = f.id;
    o.textContent = f.name;
    if (f.id === selectedId) o.selected = true;
    sel.appendChild(o);
  }
}

function libStatusMsg(msg) { $('libStatus').textContent = msg || ''; }

function positionLibrary(x, y) {
  const p = $('libraryPanel');
  const w = p.offsetWidth || 580;
  x = Math.max(8, Math.min(innerWidth - w - 8, x));
  y = Math.max(8, Math.min(innerHeight - 64, y));
  p.style.left = x + 'px';
  p.style.top = y + 'px';
}

function openLibrary(targetId, tab) {
  presetTargetId = targetId || null;
  if (tab) libTab = tab;
  const p = $('libraryPanel');
  const wasHidden = p.hidden;
  p.hidden = false;
  if (wasHidden) {
    const pos = JSON.parse(localStorage.getItem('a452libPos') || 'null');
    positionLibrary(pos ? pos.x : innerWidth - (p.offsetWidth || 580) - 40, pos ? pos.y : 84);
  }
  libStatusMsg(presetTargetId ? t('点击提示词即填入目标框') : '');
  renderLibrary();
}

function closeLibrary() {
  $('libraryPanel').hidden = true;
  presetTargetId = null;
}

/** 标题栏/右缘把手共用的拖拽逻辑（pointer 捕获，松手记忆位置） */
function dragLibraryFrom(e, grabDx, grabDy) {
  const p = $('libraryPanel');
  const rect = p.getBoundingClientRect();
  const dx = grabDx !== undefined ? grabDx : e.clientX - rect.left;
  const dy = grabDy !== undefined ? grabDy : e.clientY - rect.top;
  const move = (ev) => positionLibrary(ev.clientX - dx, ev.clientY - dy);
  const up = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    const r = p.getBoundingClientRect();
    localStorage.setItem('a452libPos', JSON.stringify({ x: r.left, y: r.top }));
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
}

/** 应用/复制一段提示词：有目标框则填入（面板保持打开），独立模式则复制到剪贴板 */
function applyPromptText(text, label) {
  const ta = presetTargetId ? $(presetTargetId) : null;
  if (ta) {
    ta.value = text;
    ta.dispatchEvent(new Event('change'));
    libStatusMsg(t('已填入') + ': ' + label);
  } else {
    navigator.clipboard.writeText(text).catch(() => {});
    libStatusMsg(t('已复制') + ': ' + label);
  }
}

function libRow(f, p) {
  const row = document.createElement('div');
  row.className = 'lib-row';
  row.title = p.text;
  row.innerHTML = `
    <span class="lib-name">${escapeHtml(p.name)}</span>
    <span class="lib-text">${escapeHtml(p.text.slice(0, 90))}${p.text.length > 90 ? '…' : ''}</span>
    <button class="btn lapply">${presetTargetId ? t('填入') : t('复制')}</button>
    <button class="btn ledit" title="${t('编辑')}">✎</button>
    <button class="btn ldel" title="${t('删除')}">✕</button>`;
  row.querySelector('.lapply').onclick = () => applyPromptText(p.text, p.name);
  row.querySelector('.ldel').onclick = () => {
    if (!confirm(`${t('删除')} “${p.name}”？`)) return;
    f.prompts = f.prompts.filter((x) => x.id !== p.id);
    saveFolders();
    renderLibrary();
    renderLibraryPage();
  };
  row.querySelector('.ledit').onclick = () => {
    // 行内编辑：名称 / 内容 / 所在分区
    row.classList.add('lib-edit');
    row.innerHTML = '';
    const nameIn = document.createElement('input');
    nameIn.type = 'text'; nameIn.className = 'input-base'; nameIn.value = p.name;
    const textIn = document.createElement('textarea');
    textIn.className = 'input-base'; textIn.rows = 3; textIn.value = p.text;
    const catSel = document.createElement('select');
    catSel.className = 'input-base';
    rebuildFolderSelect(catSel, f.id);
    const rowBtns = document.createElement('div');
    rowBtns.className = 'lib-new-row';
    const saveB = document.createElement('button');
    saveB.className = 'btn primary'; saveB.textContent = t('保存');
    saveB.onclick = () => {
      p.name = nameIn.value.trim() || p.name;
      p.text = textIn.value;
      if (catSel.value !== f.id) movePrompt(p.id, f.id, catSel.value);
      saveFolders();
      renderLibrary();
      renderLibraryPage();
    };
    const cancelB = document.createElement('button');
    cancelB.className = 'btn ghost'; cancelB.textContent = t('取消');
    cancelB.onclick = () => renderLibrary();
    rowBtns.append(catSel, saveB, cancelB);
    row.append(nameIn, textIn, rowBtns);
  };
  return row;
}

function renderLibrary() {
  // 动态页签：全部分区 + 历史 + JSON
  const tabs = $('libTabs');
  tabs.innerHTML = '';
  const defs = [
    ...state.folders.map((f) => ({ id: f.id, label: `📁 ${f.name}` })),
    { id: 'used', label: t('历史') },
    { id: 'json', label: 'JSON' },
  ];
  if (!defs.some((d) => d.id === libTab)) libTab = defs[0].id;
  for (const d of defs) {
    const b = document.createElement('button');
    b.dataset.tab = d.id;
    b.textContent = d.label;
    b.classList.toggle('active', d.id === libTab);
    tabs.appendChild(b);
  }

  const folder = getFolder(libTab);
  $('libListPane').hidden = !folder;
  $('libUsedPane').hidden = libTab !== 'used';
  $('libJsonPane').hidden = libTab !== 'json';

  if (folder) {
    const list = $('libList');
    list.innerHTML = '';
    if (folder.prompts.length === 0) {
      list.innerHTML = `<div class="hint">${t('此分区还没有提示词 — 在下方新建')}</div>`;
    }
    for (const p of folder.prompts) list.appendChild(libRow(folder, p));
    rebuildFolderSelect($('libNewCat'), folder.id);
  }

  if (libTab === 'used') {
    const used = $('usedList');
    used.innerHTML = '';
    const items = (state.usedPrompts || []).slice(0, 40);
    if (items.length === 0) {
      used.innerHTML = `<div class="hint">${t('还没有使用记录 — 生成一次即自动记录')}</div>`;
    }
    for (const u of items) {
      const row = document.createElement('div');
      row.className = 'used-row';
      row.title = u.text;
      row.innerHTML = `
        <span class="used-kind">${escapeHtml(u.kind || '')}</span>
        <span class="used-text">${escapeHtml(u.text.slice(0, 80))}${u.text.length > 80 ? '…' : ''}</span>
        <button class="btn uapply">${presetTargetId ? t('填入') : t('复制')}</button>
        <button class="btn usave" title="${t('保存为预设')}">★</button>`;
      row.querySelector('.uapply').onclick = () => applyPromptText(u.text, u.text.slice(0, 16));
      row.querySelector('.usave').onclick = () => {
        const first = state.folders[0];
        if (!first) return;
        first.prompts.push({ id: newPromptId(), name: u.text.slice(0, 24), text: u.text, createdAt: new Date().toISOString() });
        saveFolders();
        libTab = first.id;
        renderLibrary();
        renderLibraryPage();
      };
      used.appendChild(row);
    }
  }

  if (libTab === 'json') {
    rebuildFolderSelect($('jsonCat'), $('jsonCat').value);
    updateJsonPreview();
  }
}

// ---- JSON 转换器：粘贴提示词 → 标准 JSON ----
function promptToJsonFrom(raw, name, folderName) {
  let prompt = raw;
  let negative = '';
  const m = raw.match(/^\s*(?:negative(?:\s*prompt)?|负向(?:提示词)?|ネガティブ)\s*[:：]\s*([\s\S]+)$/im);
  if (m) {
    negative = m[1].trim();
    prompt = raw.slice(0, m.index).trim();
  }
  return {
    schema: 'a452-prompt',
    version: 1,
    name: name || (prompt.slice(0, 24) || 'prompt'),
    folder: folderName || '',
    prompt,
    negative,
    tags: [],
    createdAt: new Date().toISOString(),
    source: 'Atelier452 Prompt Library',
  };
}

function promptToJsonObj() {
  const f = getFolder($('jsonCat').value);
  return promptToJsonFrom($('jsonInput').value.trim(), $('jsonName').value.trim(), f ? f.name : '');
}

function updateJsonPreview() {
  const raw = $('jsonInput').value.trim();
  $('jsonPreview').textContent = raw ? JSON.stringify(promptToJsonObj(), null, 2) : '';
}

function downloadJsonObj(o) {
  const blob = new Blob([JSON.stringify(o, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (o.name || 'prompt').replace(/[\\/:*?"<>|\s]+/g, '_') + '.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// ================= 工作区 4：提示词库整页 =================
function plStatusMsg(msg) {
  $('plStatus').textContent = msg || '';
  if (msg) setTimeout(() => { if ($('plStatus').textContent === msg) $('plStatus').textContent = ''; }, 4000);
}

function renderLibraryPage() {
  const view = $('viewLibrary');
  if (!view || view.hidden) return;
  const folder = plOpenFolderId ? getFolder(plOpenFolderId) : null;
  if (plOpenFolderId && !folder) plOpenFolderId = null;
  $('plGridPanel').hidden = !!folder;
  $('plFolderPanel').hidden = !folder;

  if (!folder) {
    // 分区总览：卡片网格
    const grid = $('plFolderGrid');
    grid.innerHTML = '';
    for (const f of state.folders) grid.appendChild(plFolderCard(f));
    return;
  }

  // 分区内部：标题 + 其他分区拖放芯片 + 提示词列表
  $('plFolderTitle').textContent = `📂 ${folder.name}（${folder.prompts.length}）`;
  $('plFolderTitle').ondblclick = () => plRenameFolder(folder, $('plFolderTitle'));
  const chips = $('plFolderChips');
  chips.innerHTML = '';
  const others = state.folders.filter((x) => x.id !== folder.id);
  if (others.length) {
    const lbl = document.createElement('span');
    lbl.className = 'hint';
    lbl.textContent = t('拖到分区芯片即可移动 →');
    chips.appendChild(lbl);
    for (const o of others) chips.appendChild(plDropChip(o));
  }
  const list = $('plPromptList');
  list.innerHTML = '';
  if (folder.prompts.length === 0) {
    list.innerHTML = `<div class="hint">${t('此分区还没有提示词 — 左侧写好后点「保存提示词」，或上传文件')}</div>`;
  }
  folder.prompts.forEach((p, idx) => list.appendChild(plPromptRow(folder, p, idx)));
}

/** 总览网格里的分区卡片：单击进入，双击重命名，可作为拖放目标 */
function plFolderCard(f) {
  const card = document.createElement('div');
  card.className = 'pl-folder';
  card.innerHTML = `
    <div class="pl-folder-icon">📁</div>
    <div class="pl-folder-name">${escapeHtml(f.name)}</div>
    <div class="pl-folder-count">${f.prompts.length} ${t('条提示词')}</div>`;
  card.onclick = () => { plOpenFolderId = f.id; renderLibraryPage(); };
  card.ondblclick = (e) => { e.stopPropagation(); plRenameFolder(f, card.querySelector('.pl-folder-name')); };
  bindPromptDrop(card, f);
  return card;
}

/** 分区视图顶部的其他分区芯片：拖放目标 + 点击跳转 */
function plDropChip(f) {
  const chip = document.createElement('button');
  chip.className = 'pl-chip';
  chip.textContent = `📁 ${f.name}（${f.prompts.length}）`;
  chip.onclick = () => { plOpenFolderId = f.id; renderLibraryPage(); };
  bindPromptDrop(chip, f);
  return chip;
}

/** 把元素变成「提示词拖放目标」：拖进来就移动到分区 f */
function bindPromptDrop(el, f) {
  el.addEventListener('dragover', (e) => {
    if (![...e.dataTransfer.types].includes('text/a452-prompt')) return;
    e.preventDefault();
    el.classList.add('pl-drop-hot');
  });
  el.addEventListener('dragleave', () => el.classList.remove('pl-drop-hot'));
  el.addEventListener('drop', (e) => {
    el.classList.remove('pl-drop-hot');
    const raw = e.dataTransfer.getData('text/a452-prompt');
    if (!raw) return;
    e.preventDefault();
    try {
      const d = JSON.parse(raw);
      if (d.fid === f.id) return;
      movePrompt(d.pid, d.fid, f.id);
      plStatusMsg(t('已移动到') + ` ${f.name}`);
    } catch {}
  });
}

/** 分区内的提示词行：可拖拽（跨分区移动 / 同分区排序） */
function plPromptRow(f, p, idx) {
  const row = document.createElement('div');
  row.className = 'lib-row pl-row';
  row.draggable = true;
  row.title = p.text;
  row.innerHTML = `
    <span class="pl-grip">⠿</span>
    <span class="lib-name">${escapeHtml(p.name)}</span>
    <span class="lib-text">${escapeHtml(p.text.slice(0, 110))}${p.text.length > 110 ? '…' : ''}</span>
    <button class="btn pcopy">${t('复制')}</button>
    <button class="btn pload" title="${t('载入左侧编辑框')}">✎</button>
    <button class="btn pjson" title="${t('转为 JSON')}">{ }</button>
    <button class="btn pproj" title="${t('存入项目文件夹')}">💾</button>
    <button class="btn pdel" title="${t('删除')}">✕</button>`;
  row.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/a452-prompt', JSON.stringify({ pid: p.id, fid: f.id }));
    e.dataTransfer.effectAllowed = 'move';
    row.classList.add('pl-dragging');
  });
  row.addEventListener('dragend', () => row.classList.remove('pl-dragging'));
  // 行内排序：拖到另一行上方/下方
  row.addEventListener('dragover', (e) => {
    if (![...e.dataTransfer.types].includes('text/a452-prompt')) return;
    e.preventDefault();
    const r = row.getBoundingClientRect();
    row.classList.toggle('pl-insert-before', e.clientY < r.top + r.height / 2);
    row.classList.toggle('pl-insert-after', e.clientY >= r.top + r.height / 2);
  });
  row.addEventListener('dragleave', () => row.classList.remove('pl-insert-before', 'pl-insert-after'));
  row.addEventListener('drop', (e) => {
    const before = row.classList.contains('pl-insert-before');
    row.classList.remove('pl-insert-before', 'pl-insert-after');
    const raw = e.dataTransfer.getData('text/a452-prompt');
    if (!raw) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      const d = JSON.parse(raw);
      if (d.pid === p.id) return;
      let target = idx + (before ? 0 : 1);
      if (d.fid === f.id) {
        const from = f.prompts.findIndex((x) => x.id === d.pid);
        if (from >= 0 && from < target) target -= 1;
      }
      movePrompt(d.pid, d.fid, f.id, target);
    } catch {}
  });
  row.querySelector('.pcopy').onclick = () => {
    navigator.clipboard.writeText(p.text).catch(() => {});
    plStatusMsg(t('已复制') + ': ' + p.name);
  };
  row.querySelector('.pload').onclick = () => {
    $('plText').value = p.text;
    $('plName').value = p.name;
    plStatusMsg(t('已载入左侧编辑框'));
  };
  row.querySelector('.pjson').onclick = () => {
    const o = promptToJsonFrom(p.text, p.name, f.name);
    $('plJsonPreview').textContent = JSON.stringify(o, null, 2);
    plLastJson = o;
    $('plJsonDownload').disabled = false;
    $('plJsonCopy').disabled = false;
    $('plJsonProj').disabled = false;
  };
  row.querySelector('.pproj').onclick = () =>
    openProjSave({ text: p.text, filename: p.name + '.txt', kind: 'prompt' });
  row.querySelector('.pdel').onclick = () => {
    if (!confirm(`${t('删除')} “${p.name}”？`)) return;
    f.prompts = f.prompts.filter((x) => x.id !== p.id);
    saveFolders();
    renderLibraryPage();
  };
  return row;
}

/** 双击分区名 → 行内重命名（输入框嵌入原元素内，提交后整体重绘） */
function plRenameFolder(f, nameEl) {
  if (nameEl.querySelector('input')) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'input-base';
  input.value = f.name;
  nameEl.textContent = '';
  nameEl.appendChild(input);
  input.focus();
  input.select();
  const commit = () => {
    const v = input.value.trim();
    if (v) { f.name = v; saveFolders(); }
    renderLibraryPage();
    if (!$('libraryPanel').hidden) renderLibrary();
  };
  input.onblur = commit;
  input.onkeydown = (e) => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') { input.value = f.name; input.blur(); }
  };
}

function plAddFolder(name) {
  const f = { id: newFolderId(), name: name || `${t('分区')} ${state.folders.length + 1}`, prompts: [] };
  state.folders.push(f);
  saveFolders();
  renderLibraryPage();
  if (!$('libraryPanel').hidden) renderLibrary();
  return f;
}

/** 「保存提示词」弹窗：列出全部分区 + 新建分区选项 */
function openSaveDialog() {
  const text = $('plText').value.trim();
  if (!text) { plStatusMsg(t('请先在左侧输入提示词')); return; }
  const wrap = $('plSaveFolders');
  wrap.innerHTML = '';
  for (const f of state.folders) {
    const b = document.createElement('button');
    b.className = 'btn pl-save-folder';
    b.innerHTML = `📁 ${escapeHtml(f.name)} <span class="hint">（${f.prompts.length}）</span>`;
    b.onclick = () => doSavePrompt(f);
    wrap.appendChild(b);
  }
  $('plNewFolderName').value = '';
  $('plSaveDialog').showModal();
}

function doSavePrompt(folder) {
  const text = $('plText').value.trim();
  if (!text) return;
  const name = $('plName').value.trim() || text.slice(0, 24);
  folder.prompts.push({ id: newPromptId(), name, text, createdAt: new Date().toISOString() });
  saveFolders();
  $('plSaveDialog').close();
  $('plText').value = '';
  $('plName').value = '';
  plStatusMsg(t('已保存到') + ` 📁 ${folder.name}`);
  renderLibraryPage();
  if (!$('libraryPanel').hidden) renderLibrary();
}

/** 上传 .txt/.md/.json 文件 → 当前分区（json 识别 a452-prompt 结构） */
async function plImportFiles(files, folder) {
  let n = 0;
  for (const file of files) {
    try {
      const raw = await file.text();
      let name = file.name.replace(/\.(txt|json|md)$/i, '');
      let text = raw.trim();
      if (/\.json$/i.test(file.name)) {
        try {
          const o = JSON.parse(raw);
          if (Array.isArray(o)) {
            for (const item of o) {
              if (item && item.prompt) {
                folder.prompts.push({
                  id: newPromptId(),
                  name: item.name || item.prompt.slice(0, 24),
                  text: item.negative ? `${item.prompt}\nnegative: ${item.negative}` : item.prompt,
                  createdAt: new Date().toISOString(),
                });
                n++;
              }
            }
            continue;
          }
          if (o && o.prompt) {
            name = o.name || name;
            text = o.negative ? `${o.prompt}\nnegative: ${o.negative}` : o.prompt;
          }
        } catch {}
      }
      if (!text) continue;
      folder.prompts.push({ id: newPromptId(), name, text, createdAt: new Date().toISOString() });
      n++;
    } catch {}
  }
  saveFolders();
  renderLibraryPage();
  if (!$('libraryPanel').hidden) renderLibrary();
  plStatusMsg(t('已导入') + ` ${n} ` + t('条提示词'));
}

// ---------------- 成片上色（V2V） ----------------
function setV2VStatus(t) { $('v2vStatus').textContent = t || ''; }

async function setV2VSource(url, name) {
  state.v2v.sourceUrl = url;
  state.v2v.sourceName = name;
  renderV2V();
  // 探测源视频时长，自动带入
  try {
    const v = await loadVideo(url);
    const d = Math.max(4, Math.min(modelIs25() ? 30 : 15, Math.round(v.duration)));
    $('v2vDuration').value = d;
    $('v2vDurationVal').textContent = d + ' 秒';
    $('v2vSourceInfo').textContent = `${name} · ${fmt(v.duration, 1)}s · ${v.videoWidth}×${v.videoHeight}`;
  } catch {}
  scheduleSave();
}

async function v2vAddRefs(files) {
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue;
    try {
      const url = await uploadAsset(f);
      state.v2v.refs.push({ id: nextRefId++, name: f.name, url });
    } catch (e) {
      alert('上传失败: ' + errMsg(e));
    }
  }
  renderV2V();
  scheduleSave();
}

async function v2vGenerate() {
  const v = state.v2v;
  if (!v.sourceUrl) { alert('请先设置源视频'); return; }
  if (v.refs.length === 0) { alert('请至少上传 1 张上色参考图'); return; }
  if (v.refs.length > 9 &&
      !confirm(`当前 ${v.refs.length} 张参考图 + 1 个视频，超过 Seedance 官方文件上限，API 可能拒绝。仍要尝试提交吗？`)) return;
  // 快照当前设置，允许并行提交多个转绘任务
  const duration = Number($('v2vDuration').value);
  const snap = {
    videoUrl: v.sourceUrl,
    refs: v.refs.map((r) => r.url),
    prompt: $('v2vExtraPrompt').value.trim(),
    colorPrompt: $('colorPrompt').value.trim(),
    duration,
  };
  const job = addJob(`🎨 转绘上色 ${duration}s · ${snap.refs.length} 张参考图`, 90 + duration * 30);
  setV2VStatus('已提交（可继续提交更多任务并行生成，进度见右下角）');
  try {
    const res = await fetch('/api/v2v', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(snap),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || res.statusText);
    trackPendingTask({ id: json.id, kind: 'v2v', duration, sourceUrl: snap.videoUrl, refs: snap.refs, colorPrompt: snap.colorPrompt, note: snap.prompt });
    let p;
    try {
      p = await pollUntilDone(json.id);
    } finally {
      untrackPendingTask(json.id);
    }
    v.history.unshift({
      videoUrl: p.videoUrl,
      time: new Date().toLocaleString('zh-CN', { hour12: false }),
      duration,
      sourceUrl: snap.videoUrl,
      refs: snap.refs.length,
      refUrls: snap.refs,
      colorPrompt: snap.colorPrompt,
      note: snap.prompt,
    });
    v.current = 0;
    renderV2V();
    scheduleSave();
    finishJob(job, true);
  } catch (e) {
    finishJob(job, false, errMsg(e));
  }
}

function renderV2V() {
  const v = state.v2v;
  // 源视频
  const src = $('v2vSource');
  if (v.sourceUrl) {
    if (src.getAttribute('src') !== v.sourceUrl) src.src = v.sourceUrl;
    src.hidden = false;
    if (!$('v2vSourceInfo').textContent) $('v2vSourceInfo').textContent = v.sourceName;
  } else {
    src.hidden = true;
    $('v2vSourceInfo').textContent = '';
  }
  // 参考图
  const grid = $('refGrid');
  grid.innerHTML = '';
  v.refs.forEach((r, idx) => {
    const cell = document.createElement('div');
    cell.className = 'input-cell';
    cell.innerHTML = `<img src="${r.url}"><span class="num">${idx + 1}</span><button class="del-ref" title="移除">✕</button>`;
    cell.querySelector('.del-ref').onclick = () => {
      v.refs.splice(idx, 1);
      renderV2V();
      scheduleSave();
    };
    grid.appendChild(cell);
  });
  // 结果与历史
  const cur = v.history[v.current];
  $('v2vResult').hidden = !cur;
  $('v2vResultEmpty').hidden = !!cur;
  if (cur && $('v2vResult').getAttribute('src') !== cur.videoUrl) $('v2vResult').src = cur.videoUrl;
  const hist = $('v2vHistory');
  hist.innerHTML = '';
  v.history.forEach((h, idx) => {
    const card = document.createElement('div');
    card.className = 'hist-card' + (idx === v.current ? ' active' : '');
    const note = h.note ? '<br>' + escapeHtml(h.note) : '';
    card.innerHTML = `
      <div class="hist-card-thumb" data-hover-video="${escapeHtml(h.videoUrl)}"><img src="/api/media/thumb?src=${encodeURIComponent(h.videoUrl)}" loading="lazy" onerror="this.style.visibility='hidden'"></div>
      <div class="meta"><b>版本 ${v.history.length - idx}</b>
        ${escapeHtml(h.time || '')} · ${h.duration || 0}s · ${h.refs || 0} 张参考图${note}</div>
      <button class="btn dl">⬇</button>
      <button class="btn proj" title="${t('存入项目文件夹')}">💾</button>`;
    card.onclick = () => { v.current = idx; renderV2V(); };
    card.querySelector('.dl').onclick = (e) => {
      e.stopPropagation();
      download(h.videoUrl, `v2v_${v.history.length - idx}.mp4`);
    };
    card.querySelector('.proj').onclick = (e) => {
      e.stopPropagation();
      openProjSave({ src: h.videoUrl, kind: 'video', name: `v2v_${v.history.length - idx}.mp4` });
    };
    hist.appendChild(card);
  });
}

// ---------------- 渲染（中割） ----------------
function renderAll() {
  renderImageList();
  renderInputGrid();
  renderTimeline();
  renderRefine();
}

function renderImageList() {
  const ul = $('imageList');
  ul.innerHTML = '';
  state.images.forEach((im, idx) => {
    const li = document.createElement('li');
    li.className = 'image-item';
    li.draggable = false; // 仅当从缩略图行按下时才临时开启，避免抢滑杆的拖动
    const isLast = idx === state.images.length - 1;
    const gapActing = im.gapActing ?? 0;
    li.innerHTML = `
      <div class="im-row"><span class="grip" title="拖拽排序">⠿</span><span class="idx">${idx + 1}</span><img src="${im.url}"><span class="name">${escapeHtml(im.name)}</span><button class="del" title="删除">✕</button></div>
      ${isLast ? '' : `<div class="gap-box">
        <div class="hold-row"><span class="lbl">时长</span>
          <input type="range" class="hold" min="0.1" max="6" step="0.1" value="${im.hold ?? 2}" draggable="false">
          <b class="hold-val">${(im.hold ?? 2).toFixed(1)}s</b></div>
        <div class="hold-row"><span class="lbl">演技</span>
          <input type="range" class="gapacting" min="0" max="100" step="1" value="${gapActing}" draggable="false">
          <b class="gapacting-val">${gapActing > 0 ? gapActing : '全局'}</b></div>
        <textarea class="gap-prompt" rows="1" placeholder="↳ 这一段的动作描述（可选，如：转身挥刀劈下）" draggable="false">${escapeHtml(im.gapPrompt || '')}</textarea>
      </div>`}`;
    li.querySelector('.del').onclick = () => removeImage(im.id);
    const hold = li.querySelector('.hold');
    if (hold) {
      hold.addEventListener('input', (e) => {
        im.hold = Number(e.target.value);
        li.querySelector('.hold-val').textContent = im.hold.toFixed(1) + 's';
        updateWholeTotal();
        scheduleSave();
      });
      const ga = li.querySelector('.gapacting');
      ga.addEventListener('input', (e) => {
        im.gapActing = Number(e.target.value);
        li.querySelector('.gapacting-val').textContent = im.gapActing > 0 ? im.gapActing : '全局';
        scheduleSave();
      });
      const gp = li.querySelector('.gap-prompt');
      gp.addEventListener('change', (e) => { im.gapPrompt = e.target.value; scheduleSave(); });
      gp.dataset.minGrow = '80'; // 聚焦自动展开的最小高度（全局委托 taGrow 读取）
    }
    // 排序拖拽只从缩略图行发起：按下时临时开启 draggable，结束即关闭
    const row = li.querySelector('.im-row');
    row.addEventListener('mousedown', () => { li.draggable = true; });
    row.addEventListener('mouseup', () => { li.draggable = false; });
    li.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', String(idx));
      li.classList.add('dragging');
    });
    li.addEventListener('dragend', () => {
      li.draggable = false;
      li.classList.remove('dragging');
    });
    li.addEventListener('dragover', (e) => e.preventDefault());
    li.addEventListener('drop', (e) => {
      e.preventDefault();
      const from = Number(e.dataTransfer.getData('text/plain'));
      if (!Number.isNaN(from) && from !== idx) moveImage(from, idx);
    });
    ul.appendChild(li);
  });
  renderMacroTimeline();
  updateWholeTotal();
}

// 各关键帧「到下一帧时长」合计（即一体生成总时长）
function wholeTimings() {
  return state.images.slice(0, -1).map((im) => Number(im.hold ?? 2));
}
function wholeTotalSeconds() {
  return wholeTimings().reduce((a, b) => a + b, 0);
}

// 每段演技微调（0 = 跟随全局滑杆）的精简描述
const GAP_ACTING_SHORT = [
  { max: 20, t: '克制——幅度小、缓慢柔和、内敛' },
  { max: 40, t: '自然——幅度适中、流畅写实' },
  { max: 60, t: '生动——明快有力、关键姿势清晰、有动作重音' },
  { max: 80, t: '夸张——迅猛利落（snappy）、姿势夸张、缓急分明' },
  { max: 100, t: '极限作画（sakuga）——极快极猛、极端夸张的关键姿势、暴烈节奏' },
];
function gapActingText(v) {
  const tier = GAP_ACTING_SHORT.find((x) => v <= x.max) || GAP_ACTING_SHORT[GAP_ACTING_SHORT.length - 1];
  return `强度${v}/100，${tier.t}`;
}
// 组装每段设置：时长 + 本段动作 + 本段演技
function wholeGaps() {
  return state.images.slice(0, -1).map((im) => {
    const easeText = easePromptText(Number(im.gapEase || 0));
    const base = (im.gapPrompt || '').trim();
    return {
      seconds: Number(im.hold ?? 2),
      prompt: easeText ? (base ? `${base}，${easeText}` : easeText) : base,
      actingText: im.gapActing > 0 ? gapActingText(im.gapActing) : '',
    };
  });
}
function updateWholeTotal() {
  const el = $('wholeTotalVal');
  if (state.images.length < 2) { el.textContent = '—'; layoutMacroTimeline(); return; }
  const t = wholeTotalSeconds();
  const maxD = modelIs25() ? 30 : 15; // 2.5 单次可达 30 秒
  const clamped = Math.max(4, Math.min(maxD, Math.round(t)));
  el.textContent = t.toFixed(1) + ' 秒' + (t < 4 || t > maxD ? `（超出范围，将按 ${clamped}s 生成）` : '');
  layoutMacroTimeline();
}

function renderInputGrid() {
  const grid = $('inputGrid');
  grid.innerHTML = '';
  state.images.forEach((im, idx) => {
    const cell = document.createElement('div');
    cell.className = 'input-cell';
    cell.innerHTML = `<img src="${im.url}"><span class="num">${idx + 1}</span>`;
    grid.appendChild(cell);
  });
}

const STATUS_TEXT = { idle: '待生成', running: '生成中', success: 'success', error: '失败' };

function renderTimeline() {
  const tl = $('timeline');
  tl.innerHTML = '';
  state.segments.forEach((seg, i) => {
    const a = state.images[i], b = state.images[i + 1];
    const card = document.createElement('div');
    card.className = 'seg-card';
    const ver = seg.versions[seg.active];
    const versionButtons = seg.versions.length
      ? seg.versions.map((v, vi) => {
        const title = [v.time, v.seconds ? `${v.seconds}s` : '', v.prompt].filter(Boolean).join(' · ');
        return `<button type="button" class="version-pill ${vi === seg.active ? 'active' : ''}" data-ver="${vi}" title="${escapeHtml(title)}">v${vi + 1}</button>`;
      }).join('')
      : '<span class="version-empty">生成历史会保留在这里</span>';
    card.innerHTML = `
      <div class="head"><span class="title">${i + 1} → ${i + 2}</span>
        <span class="seg-status ${seg.status}">${STATUS_TEXT[seg.status]}</span></div>
      <div class="pair"><img src="${a.url}"><span class="arrow">→</span><img src="${b.url}"></div>
      ${ver
        ? `<video src="${ver.videoUrl}" controls muted loop preload="none" poster="/api/media/thumb?src=${encodeURIComponent(ver.videoUrl)}"></video>`
        : `<div class="empty-video ${seg.status === 'running' ? 'spin' : ''}">${seg.status === 'running' ? '' : '未生成'}</div>`}
      <div class="version-strip" aria-label="生成历史">${versionButtons}</div>
      <div class="foot">
        <button class="btn regen" ${seg.status === 'running' ? 'disabled' : ''}>生成新版本</button>
        <button class="btn detail">详细</button>
      </div>
      ${seg.error ? `<div class="err-msg">${escapeHtml(seg.error)}</div>` : ''}`;
    card.querySelectorAll('.version-pill').forEach((btn) => {
      btn.onclick = () => {
        stopPlayback();
        seg.active = Number(btn.dataset.ver);
        releaseInactiveFrames(seg); // 释放旧版本帧缓存，防止内存膨胀
        const v = seg.versions[seg.active];
        if (v && !v.frames) extractFrames(v).catch(console.warn);
        renderTimeline();
        scheduleSave();
      };
    });
    card.querySelector('.regen').onclick = () => generateSegment(i);
    card.querySelector('.detail').onclick = () => openDetail(i);
    tl.appendChild(card);
  });
  $('btnBatch').disabled = state.segments.some((s) => s.status === 'running');
}

// ---------------- 详细设置弹窗 ----------------
let detailIdx = -1;
function openDetail(i) {
  detailIdx = i;
  const seg = state.segments[i];
  $('detailTitle').textContent = `分段 ${i + 1} → ${i + 2} 详细设置`;
  $('detailPrompt').value = seg.prompt || '';
  $('detailSeconds').value = seg.seconds || Number($('segSeconds').value);
  $('detailSecondsVal').textContent = $('detailSeconds').value + ' 秒';
  $('detailDialog').showModal();
}

// ---------------- API 设置 ----------------
// 全局模型状态（顶栏 2.0/2.5 切换；一体生成时长上限随之 15s/30s）
let serverModelId = '';
let serverProvider = 'ark';
function modelIs25() { return /2-5/.test(serverModelId); }
function syncModelSeg() {
  document.querySelectorAll('#modelSeg button').forEach((b) => {
    b.classList.toggle('active', b.dataset.model === serverModelId);
  });
  document.querySelectorAll('#providerSeg button').forEach((b) => {
    b.classList.toggle('active', b.dataset.provider === serverProvider);
  });
  updateWholeTotal();
}

/** Artcraft 连接测试：验证 key + 显示 credits 余额 */
async function artcraftTest(silent) {
  const el = $('artcraftTestStatus');
  el.textContent = '测试中…';
  try {
    const r = await fetch('/api/artcraft/test');
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.ok) {
      el.textContent = j.credits == null
        ? '✓ 已连接 Artcraft（key 验证通过）'
        : `✓ 已连接 Artcraft · 余额 ${Number(j.credits).toLocaleString()} credits`;
      el.style.color = 'var(--accent2)';
      return true;
    }
    el.textContent = '✗ ' + (j.error || ('连接失败 ' + r.status));
    el.style.color = '#ff6b81';
    return false;
  } catch (e) {
    if (!silent) { el.textContent = '✗ ' + errMsg(e); el.style.color = '#ff6b81'; }
    return false;
  }
}

async function refreshConfig() {
  const res = await fetch('/api/config');
  const cfg = await res.json();
  serverModelId = cfg.model || '';
  serverProvider = cfg.preferredProvider || 'ark';
  syncModelSeg();
  if (typeof dirSyncTier === 'function') dirSyncTier(); // 参考区档位/徽标跟随全局模型
  if (typeof ibSyncTier === 'function') ibSyncTier(); // 中割参考区双档记忆同样跟随
  if ($('dirTranslate')) $('dirTranslate').checked = cfg.translatePrompts === true;
  $('verChip').textContent = cfg.appVersion ? 'v' + cfg.appVersion : '';
  const chip = $('modeChip');
  if (cfg.hasKey) {
    chip.textContent = 'Seedance API';
    chip.classList.remove('mock');
  } else {
    chip.textContent = '本地模拟（未配置 Key）';
    chip.classList.add('mock');
  }
  $('cfgEndpoint').value = cfg.endpoint;
  $('cfgModel').value = cfg.model;
  $('cfgV2VModel').value = cfg.v2vModel || '';
  $('cfgResolution').value = cfg.resolution;
  $('cfgRatio').value = cfg.ratio;
  $('cfgPublicBase').value = cfg.publicBase || '';
  $('cfgImgModel').value = cfg.imgModel || '';
  $('cfgImgProvider').value = cfg.imgProvider || 'ark';
  $('cfgOpenaiBase').value = cfg.openaiBase || 'https://api.openai.com';
  $('cfgOpenaiImgModel').value = cfg.openaiImgModel || 'gpt-image-2';
  $('cfgOpenaiKey').placeholder = cfg.hasOpenaiKey ? '已配置（留空保持不变）' : 'sk-...';
  $('cfgLlmProvider').value = cfg.llmProvider || 'auto';
  $('cfgLlmModel').value = cfg.llmModel || '';
  $('cfgAnthropicKey').placeholder = cfg.hasAnthropicKey ? '已配置（留空保持不变）' : 'sk-ant-...';
  $('cfgArtcraftKey').placeholder = cfg.hasArtcraftKey ? '已配置（留空保持不变）' : 'artcraft_api_...';
  if (typeof cfg.llmSpendUsd === 'number') {
    $('cfgLlmSpend').textContent = `已用 $${cfg.llmSpendUsd.toFixed(2)} / $${cfg.llmSpendCap || 20}`;
  }
  if (!$('stylePrompt').value) $('stylePrompt').value = cfg.stylePrompt || '';
  if (!$('inbetweenPrompt').value) $('inbetweenPrompt').value = cfg.inbetweenPrompt || '';
  if (!$('colorPrompt').value) $('colorPrompt').value = cfg.colorPrompt || '';
  if (!$('refinePrompt').value) $('refinePrompt').value = cfg.refinePrompt || '';
  state.presets = cfg.presets || [];
  state.usedPrompts = cfg.usedPrompts || [];
  loadFoldersFrom(cfg);
  renderLibraryPage();
  return cfg;
}

// ---------------- 事件绑定 ----------------
$('tabInbetween').onclick = () => switchMode('inbetween');
$('tabV2V').onclick = () => switchMode('v2v');
$('tabRefine').onclick = () => switchMode('refine');
$('tabLibrary').onclick = () => switchMode('library');
$('tabMotion').onclick = () => switchMode('motion');
$('tabDirector').onclick = () => switchMode('director');

// 精修：源图上传 / 生成 / 结果操作
$('refineFileInput').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const url = await uploadAsset(f);
    setRefineSource(url, f.name);
  } catch (err) {
    alert('上传失败: ' + errMsg(err));
  }
};
const rfz = $('refineDropZone');
rfz.addEventListener('dragover', (e) => { e.preventDefault(); rfz.classList.add('over'); });
rfz.addEventListener('dragleave', () => rfz.classList.remove('over'));
rfz.addEventListener('drop', async (e) => {
  e.preventDefault();
  rfz.classList.remove('over');
  const f = [...e.dataTransfer.files].find((x) => x.type.startsWith('image/'));
  if (f) {
    try { setRefineSource(await uploadAsset(f), f.name); } catch (err) { alert('上传失败: ' + errMsg(err)); }
  }
});
// 精修参考图（角色设定/色卡）上传
$('refineRefInput').onchange = async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue;
    try {
      const url = await uploadAsset(f);
      state.refine.refs.push({ id: nextRefId++, name: f.name, url });
    } catch (err) { alert('上传失败: ' + errMsg(err)); }
  }
  renderRefine();
  scheduleSave();
};
const rrdz = $('refineRefDrop');
rrdz.addEventListener('dragover', (e) => { e.preventDefault(); rrdz.classList.add('over'); });
rrdz.addEventListener('dragleave', () => rrdz.classList.remove('over'));
rrdz.addEventListener('drop', async (e) => {
  e.preventDefault();
  rrdz.classList.remove('over');
  for (const f of [...e.dataTransfer.files]) {
    if (!f.type.startsWith('image/')) continue;
    try {
      const url = await uploadAsset(f);
      state.refine.refs.push({ id: nextRefId++, name: f.name, url });
    } catch (err) { alert('上传失败: ' + errMsg(err)); }
  }
  renderRefine();
  scheduleSave();
});

// 右栏大生成按钮 + 提示词库独立入口（顶栏按钮 + 右缘把手）
$('btnWholeTop').onclick = wholeGenerate;
$('btnLibrary').onclick = () => openLibrary(null);
// 右缘把手：按住直接把面板"拖出来"，松手即定位；单击也可打开
$('libraryEdge').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  openLibrary(null);
  const p = $('libraryPanel');
  const w = p.offsetWidth || 580;
  positionLibrary(e.clientX - w + 20, e.clientY - 16);
  dragLibraryFrom(e, w - 20, 16);
});
// 标题栏拖动
$('libDragHandle').addEventListener('pointerdown', (e) => {
  if (e.target.closest('button')) return;
  e.preventDefault();
  dragLibraryFrom(e);
});
$('libClose').onclick = closeLibrary;
document.addEventListener('keydown', (e) => {
  if (e.code === 'Escape' && !$('libraryPanel').hidden) closeLibrary();
});
// 页签切换
$('libTabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (!b) return;
  libTab = b.dataset.tab;
  renderLibrary();
});
// 新建提示词（选分区）
$('libNewSave').onclick = () => {
  const text = $('libNewText').value.trim();
  if (!text) { libStatusMsg(t('当前提示词框是空的')); return; }
  const name = $('libNewName').value.trim() || text.slice(0, 24);
  const folder = getFolder($('libNewCat').value) || state.folders[0];
  if (!folder) return;
  folder.prompts.push({ id: newPromptId(), name, text, createdAt: new Date().toISOString() });
  $('libNewText').value = '';
  $('libNewName').value = '';
  saveFolders();
  libTab = folder.id;
  renderLibrary();
  renderLibraryPage();
  libStatusMsg(t('已保存') + ': ' + name);
};
// JSON 转换器
$('jsonInput').addEventListener('input', updateJsonPreview);
$('jsonName').addEventListener('input', updateJsonPreview);
$('jsonCat').addEventListener('change', updateJsonPreview);
$('jsonDownload').onclick = () => {
  const o = promptToJsonObj();
  if (!o.prompt && !o.negative) { libStatusMsg(t('当前提示词框是空的')); return; }
  const url = URL.createObjectURL(new Blob([JSON.stringify(o, null, 2)], { type: 'application/json' }));
  download(url, o.name.replace(/[\\/:*?"<>|]/g, '_') + '.json');
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  libStatusMsg(t('已下载 .json'));
};
$('jsonCopy').onclick = () => {
  const o = promptToJsonObj();
  if (!o.prompt && !o.negative) return;
  navigator.clipboard.writeText(JSON.stringify(o, null, 2)).catch(() => {});
  libStatusMsg(t('已复制 JSON'));
};
$('jsonToLib').onclick = () => {
  const o = promptToJsonObj();
  if (!o.prompt) { libStatusMsg(t('当前提示词框是空的')); return; }
  const folder = getFolder($('jsonCat').value) || state.folders[0];
  if (!folder) return;
  folder.prompts.push({
    id: newPromptId(),
    name: o.name,
    text: o.prompt + (o.negative ? '\nnegative: ' + o.negative : ''),
    createdAt: new Date().toISOString(),
  });
  saveFolders();
  libTab = folder.id;
  renderLibrary();
  renderLibraryPage();
  libStatusMsg(t('已存入库') + ': ' + o.name);
};

// ---- 工作区 4：提示词库整页 ----
$('plSave').onclick = openSaveDialog;
$('plSaveCancel').onclick = () => $('plSaveDialog').close();
$('plSaveNewFolder').onclick = () => {
  const name = $('plNewFolderName').value.trim();
  const f = plAddFolder(name || undefined);
  doSavePrompt(f);
};
$('plAddFolder').onclick = () => plAddFolder();
$('plBack').onclick = () => { plOpenFolderId = null; renderLibraryPage(); };
$('plDeleteFolder').onclick = () => {
  const f = getFolder(plOpenFolderId);
  if (!f) return;
  if (state.folders.length <= 1) { plStatusMsg(t('至少保留一个分区')); return; }
  if (f.prompts.length && !confirm(`${t('删除分区')} 📁 ${f.name}？${t('其中')} ${f.prompts.length} ${t('条提示词将一并删除')}`)) return;
  state.folders = state.folders.filter((x) => x.id !== f.id);
  plOpenFolderId = null;
  saveFolders();
  renderLibraryPage();
  if (!$('libraryPanel').hidden) renderLibrary();
};
$('plUpload').onchange = (e) => {
  const f = getFolder(plOpenFolderId);
  const files = [...e.target.files];
  e.target.value = '';
  if (f && files.length) plImportFiles(files, f);
};
$('plJson').onclick = () => {
  const raw = $('plText').value.trim();
  if (!raw) { plStatusMsg(t('请先在左侧输入提示词')); return; }
  plLastJson = promptToJsonFrom(raw, $('plName').value.trim(), '');
  $('plJsonPreview').textContent = JSON.stringify(plLastJson, null, 2);
  $('plJsonDownload').disabled = false;
  $('plJsonCopy').disabled = false;
  $('plJsonProj').disabled = false;
};
$('plJsonDownload').onclick = () => { if (plLastJson) downloadJsonObj(plLastJson); };
$('plJsonCopy').onclick = () => {
  if (!plLastJson) return;
  navigator.clipboard.writeText(JSON.stringify(plLastJson, null, 2)).catch(() => {});
  plStatusMsg(t('已复制 JSON'));
};
$('plJsonProj').onclick = () => {
  if (!plLastJson) return;
  openProjSave({ text: JSON.stringify(plLastJson, null, 2), filename: (plLastJson.name || 'prompt') + '.json', kind: 'prompt' });
};

// 存入项目文件夹弹窗
$('projSaveCancel').onclick = () => $('projSaveDialog').close();

$('btnRefine').onclick = refineGenerate;
$('btnRefineDownload').onclick = () => {
  const cur = state.refine.history[state.refine.current];
  if (cur) download(cur.out, 'refined.png');
};
$('btnRefineProj').onclick = () => {
  const cur = state.refine.history[state.refine.current];
  if (cur) openProjSave({ src: cur.out, kind: 'image', name: 'refined.png' });
};
$('btnRefineAddKey').onclick = () => {
  const cur = state.refine.history[state.refine.current];
  if (!cur) return;
  state.images.push({ id: nextImgId++, name: 'refined_' + nextImgId + '.png', url: cur.out, hold: 2 });
  rebuildSegments();
  renderAll();
  scheduleSave();
  switchMode('inbetween');
};
$('refinePrompt').onchange = () => {
  fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refinePrompt: $('refinePrompt').value }),
  }).catch(() => {});
};

// 提示词库：📚 按钮（事件委托，动态节点也生效）→ 填入模式打开浮动面板
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.plib');
  if (!btn) return;
  e.preventDefault();
  openLibrary(btn.dataset.target);
});

$('fileInput').onchange = (e) => { addFiles([...e.target.files]); e.target.value = ''; };
const dz = $('dropZone');
dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
dz.addEventListener('dragleave', () => dz.classList.remove('over'));
dz.addEventListener('drop', (e) => {
  e.preventDefault();
  dz.classList.remove('over');
  addFiles([...e.dataTransfer.files]);
});

// V2V 源视频与参考图
$('v2vFileInput').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const url = await uploadAsset(f);
    setV2VSource(url, f.name);
  } catch (err) {
    alert('上传失败: ' + errMsg(err));
  }
};
const vdz = $('v2vDropZone');
vdz.addEventListener('dragover', (e) => { e.preventDefault(); vdz.classList.add('over'); });
vdz.addEventListener('dragleave', () => vdz.classList.remove('over'));
vdz.addEventListener('drop', async (e) => {
  e.preventDefault();
  vdz.classList.remove('over');
  const f = [...e.dataTransfer.files].find((x) => x.type.startsWith('video/'));
  if (f) {
    try { setV2VSource(await uploadAsset(f), f.name); } catch (err) { alert('上传失败: ' + errMsg(err)); }
  }
});
$('btnUseConcat').onclick = async () => {
  setV2VStatus('拼接中割结果中…');
  try {
    const url = await concatReady();
    if (!url) throw new Error('「中割生成」还没有可用分段');
    await setV2VSource(url, '中割拼接结果');
    setV2VStatus('');
  } catch (e) {
    setV2VStatus('失败: ' + errMsg(e));
  }
};
$('refFileInput').onchange = (e) => { v2vAddRefs([...e.target.files]); e.target.value = ''; };
const rdz = $('refDropZone');
rdz.addEventListener('dragover', (e) => { e.preventDefault(); rdz.classList.add('over'); });
rdz.addEventListener('dragleave', () => rdz.classList.remove('over'));
rdz.addEventListener('drop', (e) => {
  e.preventDefault();
  rdz.classList.remove('over');
  v2vAddRefs([...e.dataTransfer.files]);
});
$('btnV2VGenerate').onclick = v2vGenerate;

// 滑杆
$('segSeconds').oninput = (e) => { $('segSecondsVal').textContent = e.target.value + ' 秒'; scheduleSave(); };
$('sensitivity').oninput = (e) => { $('sensitivityVal').textContent = e.target.value + ' %'; scheduleSave(); };
$('acting').oninput = () => { syncActingLabel(); scheduleSave(); };
$('btnWhole').onclick = wholeGenerate;
$('remapSeconds').oninput = (e) => { $('remapSecondsVal').textContent = e.target.value + 's'; scheduleSave(); };
$('remapFps').oninput = (e) => { $('remapFpsVal').textContent = e.target.value; scheduleSave(); };
$('detailSeconds').oninput = (e) => ($('detailSecondsVal').textContent = e.target.value + ' 秒');
$('v2vDuration').oninput = (e) => { $('v2vDurationVal').textContent = e.target.value + ' 秒'; scheduleSave(); };
$('globalPrompt').onchange = scheduleSave;
$('v2vExtraPrompt').onchange = scheduleSave;
for (const id of ['chkLoop', 'chkTame', 'chkExportRemap']) $(id).onchange = scheduleSave;

// 提示词持久化到服务器配置
$('stylePrompt').onchange = () => {
  fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stylePrompt: $('stylePrompt').value }),
  }).catch(() => {});
};
$('inbetweenPrompt').onchange = () => {
  fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ inbetweenPrompt: $('inbetweenPrompt').value }),
  }).catch(() => {});
};
$('colorPrompt').onchange = () => {
  fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ colorPrompt: $('colorPrompt').value }),
  }).catch(() => {});
};

$('btnBatch').onclick = batchGenerate;
$('btnPlaySeq').onclick = () => startPlayback('seq');
$('btnPlayRemap').onclick = () => startPlayback('remap');
$('btnStop').onclick = () => stopPlayback();
$('btnExportMp4').onclick = exportMp4;
$('btnExportZip').onclick = () => exportZip().catch((e) => setExportStatus('导出失败: ' + errMsg(e)));

$('detailClose').onclick = () => $('detailDialog').close();
$('detailRegen').onclick = () => {
  const seg = state.segments[detailIdx];
  if (!seg) return;
  seg.prompt = $('detailPrompt').value;
  seg.seconds = Number($('detailSeconds').value);
  $('detailDialog').close();
  generateSegment(detailIdx, { prompt: seg.prompt || undefined, seconds: seg.seconds });
};

$('btnSettings').onclick = () => $('settingsDialog').showModal();
$('cfgClose').onclick = () => $('settingsDialog').close();
$('cfgSave').onclick = async () => {
  const body = {
    endpoint: $('cfgEndpoint').value,
    model: $('cfgModel').value,
    v2vModel: $('cfgV2VModel').value,
    imgModel: $('cfgImgModel').value,
    imgProvider: $('cfgImgProvider').value,
    openaiBase: $('cfgOpenaiBase').value.trim(),
    openaiImgModel: $('cfgOpenaiImgModel').value.trim(),
    resolution: $('cfgResolution').value,
    ratio: $('cfgRatio').value,
    publicBase: $('cfgPublicBase').value.trim(),
    llmProvider: $('cfgLlmProvider').value,
    llmModel: $('cfgLlmModel').value.trim(),
  };
  if ($('cfgKey').value.trim()) body.apiKey = $('cfgKey').value.trim();
  if ($('cfgOpenaiKey').value.trim()) body.openaiKey = $('cfgOpenaiKey').value.trim();
  if ($('cfgAnthropicKey').value.trim()) body.anthropicKey = $('cfgAnthropicKey').value.trim();
  const savedArtcraftKey = !!$('cfgArtcraftKey').value.trim();
  if (savedArtcraftKey) body.artcraftKey = $('cfgArtcraftKey').value.trim();
  $('cfgOpenaiKey').value = '';
  $('cfgAnthropicKey').value = '';
  $('cfgArtcraftKey').value = '';
  const res = await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  $('cfgStatus').textContent = res.ok ? '已保存' : '保存失败';
  $('cfgKey').value = '';
  refreshConfig();
  // 刚保存了 Artcraft Key → 立即验证连接并显示余额（key 已安全落盘，输入框清空只是防泄露）
  if (savedArtcraftKey && res.ok) artcraftTest(false);
};
$('cfgClearKey').onclick = async () => {
  await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: null }),
  });
  $('cfgStatus').textContent = '已清除 Key，切换到本地模拟';
  refreshConfig();
};

// 测试钩子：程序化添加图片（供自动化验证用）
window.__addImagesFromUrls = async (urls) => {
  for (const u of urls) {
    const blob = await (await fetch(u)).blob();
    const f = new File([blob], u.split('/').pop() || 'img.png', { type: blob.type || 'image/png' });
    const url = await uploadAsset(f);
    state.images.push({ id: nextImgId++, name: f.name, url });
  }
  rebuildSegments();
  renderAll();
  scheduleSave();
};
window.__state = state;

// ---------------- 启动 ----------------
// 接收来自 AI Director Workspace 的合并提示词（/studio?adwPrompt=…）
// 这里只取参数，实际填入放在工程恢复完成之后，避免被恢复的旧提示词覆盖
const adwPromptParam = (() => {
  const p = new URLSearchParams(location.search).get('adwPrompt');
  if (p) history.replaceState(null, '', location.pathname);
  return p || '';
})();

// ---------------- 工作区 6：导演生成（首尾帧 + 参考视频 + 参考图 · 演技滑杆组） ----------------
function setDirStatus(t) {
  $('dirStatus').textContent = t || '';
  // 镜像到右栏大按钮下方：用户盯着大按钮点，中栏的状态行看不见
  const mirror = $('dirGoStatus');
  if (mirror) {
    mirror.textContent = t || '';
    mirror.classList.toggle('warn', /^⚠|失败|已满|找不到|已定位/.test(t || ''));
  }
}

/**
 * 演技滑杆（角色四维 + 场面三维）→ 结构化表演指导块（0 = 关闭该维度）。
 * 写法遵循 acting-system + film-prompt-engineer 技能：
 * ① 写"可拍摄的行为"，不写情绪标签，不把数值泄进提示词（"80/100"只会干扰模型）；
 * ② 角色表演与画面运动分块加标签作用域，互不打架（角色可以沉稳、画面照样可以疾风骤雨）；
 * ③ 状态不写过程（模型拍"正在"而不是"变成"）；夸张叠在重量之上，先有物理再有夸张；
 * ④ 有角色表演时挂 Aiden 签名 tagline：保持关键姿态，表演性格外强。
 */
const DIR_ACT_TEXT = {
  face: [
    '面部走微表情叙事：情绪只从眼神与嘴角泄出——视线移开又收回、眨眼节奏随心境变化、嘴角一瞬的抽动，思考先于言语在眼睛里可读，眼神始终鲜活有神采',
    '表情鲜明立体：眉、眼、口型随情绪清楚变化，反应在对方动作结束前就已开始浮现，前一个表情的余韵自然带进下一个，眼里永远有光',
    '表情大开大合：卡通级的挤压拉伸表情，惊讶时五官放大、得意时眉飞色舞、每个表情做到位并短暂保持再切换，俏皮劲十足，眼神夸张但始终鲜活',
  ],
  body: [
    '肢体收敛经济：动作小而准，重心稳定，全程由微动作驱动——指尖摩挲、摆弄道具、整理衣角、不易察觉的重心倒换，绝不空摆姿势也绝不僵住',
    '肢体语言丰富：动作幅度明显、关键姿势清晰，每个动作带预备与跟随，姿态之间的过渡有惯性有重量',
    '全身戏剧化表演：肢体极度夸张，关键姿势极端醒目并保持半拍，带挤压拉伸与动态变形，起跳蹬地有力、落地有真实重量，角色是在"表演这个动作"而不是让动作发生',
  ],
  tempo: [
    '角色节奏沉稳从容：动作之间留呼吸口，停顿里有内容——打量、犹豫、下决定；停顿期间微动作不断（呼吸起伏、眨眼、指尖轻动），绝不空等冻结',
    '角色节奏明快：动作干脆利落、重音清楚，快慢交替形成对比，关键动作后有短暂的定住',
    '角色节奏暴烈：蓄力→爆发的极端对比，关键动作瞬间完成并定格半秒再走下一拍，全程无匀速段',
  ],
  velocity: [
    '画面中一切运动舒缓从容，每条动作弧线完整可读，没有突兀的速度跳变；慢不等于停——所有元素保持细微的持续活动',
    '画面整体运动轻快流畅，所有运动方向明确、速度统一协调',
    '全画面高速运动：动作凌厉迅猛带方向性动态模糊，但每个运动物体仍保有重量与惯性，绝不漂浮滑行',
  ],
  fx: [
    '环境低语级动态：尘埃缓缓浮动、布料窗帘轻摆、光斑微颤、水面细纹——微动作铺满全画面但绝不抢戏',
    '道具与环境实时响应角色：碰到的东西会动会响，扬起的灰尘、翻动的纸页清晰可见并服务于动作',
    '环境全面参与演出：烟尘、碎片、光效随动作喷薄而出、迅猛扫过画面，道具被大开大合地使用，但特效永远不遮挡角色的脸和关键姿势',
  ],
  physics: [
    '低重力质感：物体如在水中般缓落，惯性绵长延展，接触轻柔——但仍保有质量感，是慢而有重量，不是失重乱飘',
    '真实物理：重力、质量、惯性、摩擦全部符合现实，每次碰撞有因果与残留痕迹，运动有可信的加速与减速',
    '物理反馈迅猛：坠落干脆、碰撞剧烈带反弹与碎屑，重击有反冲与贯穿跟随，武器道具有真实重量、手腕手臂随之受力反应',
  ],
};
// Higgsfield 工艺基座（CINEDANCE V4 物理锁 + 第一帧法则 + Lira 进行时状态律）：
// 任一滑杆激活即注入，管住 AI 视频最常见的四种假——空帧起手、滑步漂浮、橡皮变形、朝向含糊
const DIR_MOTION_QUALITY =
  '【运动质量】动作从第一帧就已在进行——禁空帧起手、禁静置亮相、禁慢动作耍帅；' +
  '一切姿态写作进行时状态；每个动作有蓄力、加速减速与跟随；' +
  '脚下有真实的接触与重量转移（脚跟着地→重心转移→脚尖蹬地），绝不滑步、绝不漂浮、绝无橡皮般的变形；' +
  '布料与头发滞后身体半拍；视线方向与躯干朝向分别清晰可读；构图遵循三分法。' +
  '画面永不完全静止：无大动作时角色仍保持连续的微动作生命——可见的呼吸起伏、自然眨眼与视线微移、' +
  '重心不易察觉的调整、手指的小动作；环境同样保有微量活动（发丝衣角轻摆、浮尘漂移、光影微颤），' +
  '任何角色静止如摆件超过一秒即为废片。';
function dirActTier3(v) { return v >= 66 ? 2 : v >= 33 ? 1 : 0; }
function directorActingText() {
  const overall = Number($('dirActOverall').value);
  const face = Number($('dirActFace').value);
  const body = Number($('dirActBody').value);
  const tempo = Number($('dirActTempo').value);
  const velocity = Number($('dirActVelocity').value);
  const fx = Number($('dirActFx').value);
  const physics = Number($('dirActPhysics').value);

  const actor = [];
  if (overall > 0) actor.push(actingTier(overall).text);
  if (face > 0) actor.push(DIR_ACT_TEXT.face[dirActTier3(face)]);
  if (body > 0) actor.push(DIR_ACT_TEXT.body[dirActTier3(body)]);
  if (tempo > 0) actor.push(DIR_ACT_TEXT.tempo[dirActTier3(tempo)]);

  const scene = [];
  if (velocity > 0) scene.push(DIR_ACT_TEXT.velocity[dirActTier3(velocity)]);
  if (fx > 0) scene.push(DIR_ACT_TEXT.fx[dirActTier3(fx)]);
  if (physics > 0) scene.push(DIR_ACT_TEXT.physics[dirActTier3(physics)]);

  const blocks = [];
  if (actor.length) blocks.push('【表演指导】' + actor.join('；') + '。角色全程保持同一张脸、同一套发型与服装，绝不变形走样。');
  if (scene.length) blocks.push('【画面运动】' + scene.join('；') + '。');
  if (actor.length || scene.length) blocks.push(DIR_MOTION_QUALITY);
  if (actor.length) blocks.push('保持关键姿态，表演性格外强。');
  return blocks.join('\n');
}
function syncDirActing() {
  const label = (v) => (v > 0 ? v : '关');
  $('dirActOverallVal').textContent = label(Number($('dirActOverall').value));
  $('dirActFaceVal').textContent = label(Number($('dirActFace').value));
  $('dirActBodyVal').textContent = label(Number($('dirActBody').value));
  $('dirActTempoVal').textContent = label(Number($('dirActTempo').value));
  $('dirActVelocityVal').textContent = label(Number($('dirActVelocity').value));
  $('dirActFxVal').textContent = label(Number($('dirActFx').value));
  $('dirActPhysicsVal').textContent = label(Number($('dirActPhysics').value));
  const t = directorActingText();
  $('dirActPreview').textContent = t ? '→ ' + t : '';
}
for (const id of ['dirActOverall', 'dirActFace', 'dirActBody', 'dirActTempo', 'dirActVelocity', 'dirActFx', 'dirActPhysics']) {
  $(id).oninput = syncDirActing;
}

// 模型切换：时长上限联动（2.0 → 15s，2.5 → 30s）
// Artcraft 各模型特性（时长上限 / 是否支持音频）——依据官方 Omni API 文档
const ARTCRAFT_MODEL_META = {
  seedance_2p5: { max: 30, audio: true, label: 'Seedance 2.5 · 最长 30 秒' },
  seedance_2p5_u: { max: 30, audio: true, label: 'Seedance 2.5 Ultra · 最长 30 秒 · 宽限内容（恐怖/动作等）' },
  seedance_2p0: { max: 15, audio: false, label: 'Seedance 2.0 · 4-15 秒' },
  seedance_2p0_bpu: { max: 15, audio: false, label: 'Seedance 2.0 Plus Ultra · 4-15 秒 · 宽限内容（恐怖/动作等）' },
  seedance_2p0_bp: { max: 15, audio: false, label: 'Seedance 2.0 Plus · 4-15 秒 · 宽限人脸/IP' },
  seedance_2p0_bpu_fast: { max: 15, audio: false, label: 'Seedance 2.0 Plus Ultra Fast · 4-15 秒 · 宽限内容+提速' },
  seedance_2p0_bp_fast: { max: 15, audio: false, label: 'Seedance 2.0 Plus Fast · 4-15 秒 · 宽限人脸/IP+提速' },
  kling_3p0_pro: { max: 10, audio: true, label: 'Kling 3.0 Pro · 5/10 秒 · 支持音频' },
  kling_3p0_standard: { max: 10, audio: true, label: 'Kling 3.0 Standard · 5/10 秒 · 支持音频' },
  veo_3p1: { max: 8, audio: true, label: 'Veo 3.1 · ≤8 秒 · 原生音频' },
  veo_3p1_fast: { max: 8, audio: true, label: 'Veo 3.1 Fast · ≤8 秒 · 原生音频' },
  sora_2: { max: 12, audio: true, label: 'Sora 2 · ≤12 秒 · 同步音频' },
  sora_2_pro: { max: 12, audio: true, label: 'Sora 2 Pro · ≤12 秒 · 同步音频' },
  minimax_h3: { max: 10, audio: false, label: 'Minimax H3 · ≤10 秒' },
};

$('dirModel').onchange = () => {
  const val = $('dirModel').value;
  const is25 = /2-5/.test(val);
  const isArtcraft = val.startsWith('artcraft:');
  const meta = isArtcraft ? ARTCRAFT_MODEL_META[val.slice('artcraft:'.length)] : null;
  const slider = $('dirDuration');
  slider.max = meta ? meta.max : is25 ? 30 : 15;
  if (Number(slider.value) > Number(slider.max)) slider.value = slider.max;
  $('dirDurationVal').textContent = slider.value + ' 秒';
  $('dirAudioWrap').hidden = !(meta && meta.audio);
  $('dirModelHint').textContent = meta
    ? `Artcraft 通道：${meta.label} · 首尾帧 + 参考图直传（消耗 Artcraft credits）· 参考视频暂不走此通道`
    : is25
      ? '2.5：4-30 秒 · 480P/720P（1080P 自动降档）· 需已在方舟控制台开通该模型'
      : '2.0：4-15 秒 · 使用 ⚙ API 设置里的当前模型与分辨率';
  dirSyncTier(); // 上限 + 双档参考集 + 生效模型徽标一并同步
  scheduleSave(); // 模型选择随工程持久化
};
$('dirDuration').oninput = (e) => { $('dirDurationVal').textContent = e.target.value + ' 秒'; };
$('dirAnimMode').onchange = () => { state.director.animMode = $('dirAnimMode').value; scheduleSave(); };

// 首帧/尾帧已从 REFERENCES TOOL 移除（本工具只做参考驱动生成）；保留空实现兼容旧工程 restore
function setDirFrame(slot, url, name) {
  state.director[slot] = url ? { url, name: name || '' } : null;
  scheduleSave();
}

// ---------------- 参考素材体系：图/视频/音频三类，按模型精确上限，逐条 role + 说明词 ----------------
// Seedance 2.5 官方参考上限：30 图 + 10 视频 + 10 音频（三个独立上限）；2.0：9 图 + 3 视频 + 3 音频
function dirRefCaps() {
  const val = $('dirModel').value;
  const is25 = /2p5|2-5/.test(val) || (!val && modelIs25());
  return is25 ? { image: 30, video: 10, audio: 10 } : { image: 9, video: 3, audio: 3 };
}
let dirRefKind = 'image'; // 当前分区 tab

const DIR_REF_ROLES = {
  style: ['风格参考', '沿用其画风、笔触与质感'],
  action: ['动作参考', '模仿其肢体动态与运动轨迹'],
  character: ['角色一致性', '严格保持该角色的外观、发型与服装不变'],
  props: ['道具还原', '严格复刻该道具的造型、材质、比例与细节'],
  scene: ['场景环境', '沿用其环境、空间与光线氛围'],
  performance: ['表演情绪', '模仿其表情、情绪与表演方式'],
  rhythm: ['节奏韵律', '按其节奏与韵律驱动画面运动'],
};
// 场面情绪锁：纯场景 MOOD 提示词（不管角色演技，只锁氛围/节奏/画面能量）。
// 全局一个 + 每个 CUT 一个；选'无'零注入。文案按 film-prompt-engineer 片型矩阵手写。
const DIR_MOODS = [
  ['', '情绪锁：无', ''],
  ['explosive', '💥 爆裂激烈', '场面情绪锁：爆裂激烈（EXPLOSIVE/URGENT/FAST）——节奏凌厉逼人、动作密集爆发、画面能量拉满，环境元素（尘土、火花、碎片）随动作炸开，紧迫感贯穿每一帧，绝无松弛段落'],
  ['urgent', '⏱ 紧迫追逐', '场面情绪锁：紧迫追逐——争分夺秒，所有运动都朝目标压进，节奏步步收紧，画面带被追赶的张力，呼吸急促，没有一秒停顿松弛'],
  ['triumphant', '🔥 热血高燃', '场面情绪锁：热血高燃——向上攀升的能量，动作充满决意与力量感，节奏层层推向高潮，胜利前夜的沸腾气势'],
  ['epic', '⛰ 史诗恢弘', '场面情绪锁：史诗恢弘——大开大合的气魄，画面有重量与规模感，运动庄严有力、从容不迫，令人屏息的敬畏氛围'],
  ['chaotic', '🌪 混乱失控', '场面情绪锁：混乱失控——多方向运动互相冲撞，节奏破碎急促，画面处于崩解边缘的动荡，秩序正在瓦解'],
  ['tension', '🕳 悬疑压抑', '场面情绪锁：悬疑压抑——表面安静底下绷着弦，微小动静被放大，节奏刻意压慢蓄力，空气凝滞，随时要断裂的紧张感'],
  ['horror', '👁 恐怖阴森', '场面情绪锁：恐怖阴森——阴影主导画面，运动迟缓而不祥，安静得不自然，偶发的突兀动静令人心悸，寒意渗进每个角落'],
  ['meditative', '🧘 冥想沉静', '场面情绪锁：冥想沉静（meditative/slow/calm）——一切缓慢从容，长呼吸的节奏，画面安定少动，留白与静谧主导，时间仿佛被拉长'],
  ['serene', '🌤 温柔治愈', '场面情绪锁：温柔治愈——柔和光线包裹画面，动作轻缓圆润，氛围安全而有暖意，微风般的节奏，让人安心'],
  ['dreamy', '💫 梦幻恍惚', '场面情绪锁：梦幻恍惚——漂浮般的运动质感，边界柔化，时间感模糊，如梦似幻的悬浮氛围，现实感被稀释'],
  ['romantic', '🌹 浪漫柔情', '场面情绪锁：浪漫柔情——画面被温柔的光晕浸润，动作亲昵舒缓，节奏如慢舞，空气里都是涌动的情绪'],
  ['melancholy', '🌧 忧郁哀伤', '场面情绪锁：忧郁哀伤——画面情绪下沉，节奏迟缓滞重，运动带着无力感与眷恋，整体低回克制'],
  ['nostalgic', '📼 怀旧温存', '场面情绪锁：怀旧温存——旧时光的质感，节奏舒缓带追忆感，画面像被岁月轻轻磨过，温热而略带酸楚'],
  ['cold', '🧊 冷峻疏离', '场面情绪锁：冷峻疏离——克制到近乎无情的画面，运动精准冷静，空间空旷，情绪被冰封在表面之下'],
  ['whimsical', '🎈 俏皮欢快', '场面情绪锁：俏皮欢快——轻盈跳跃的节奏，动作带弹性与幽默感，画面明快鲜活，处处透着玩心与惊喜'],
];
function moodPromptOf(id) {
  const m = DIR_MOODS.find((x) => x[0] === id);
  return m ? m[2] : '';
}
function moodOptionsHtml(selected) {
  return DIR_MOODS.map(([id, label]) => `<option value="${id}" ${id === (selected || '') ? 'selected' : ''}>${label}</option>`).join('');
}

const DIR_KIND_META = {
  image: { icon: '🖼', name: '参考图', accept: 'image/*', defaultRole: 'style' },
  video: { icon: '🎞', name: '参考视频', accept: 'video/*', defaultRole: 'action' },
  audio: { icon: '🎵', name: '参考音频', accept: 'audio/*', defaultRole: 'rhythm' },
};

function dirRefsOf(kind) {
  return state.director.refs.filter((r) => (r.kind || 'image') === kind);
}

// 参考素材拖拽重排：同类内移动，@编号按新位置自动重算（image7 拖到顶 = image1）
let dirDragRefId = null;
function dirReorderRef(srcId, targetId, before) {
  const kindItems = dirRefsOf(dirRefKind);
  const src = kindItems.find((x) => x.id === srcId);
  if (!src || srcId === targetId) return;
  const order = kindItems.filter((x) => x.id !== srcId);
  const ti = order.findIndex((x) => x.id === targetId);
  if (ti < 0) return;
  order.splice(before ? ti : ti + 1, 0, src);
  // 回写：当前类的元素按新顺序填回它们在总数组中原有的槽位（不打乱其他类型）
  const slots = [];
  state.director.refs.forEach((x, i) => { if ((x.kind || 'image') === dirRefKind) slots.push(i); });
  slots.forEach((slot, k) => { state.director.refs[slot] = order[k]; });
  renderDirRefs(); // 内部会刷新 @chip 预览（编号已变）
  scheduleSave();
  const newIdx = order.findIndex((x) => x.id === srcId) + 1;
  setDirStatus(`已移动到第 ${newIdx} 位 — 该素材现在是 @${(dirRefKind === 'image' ? 'image' : dirRefKind)}${newIdx}，提示词里的旧编号请留意`);
}

function renderDirRefs() {
  const caps = dirRefCaps();
  for (const k of ['image', 'video', 'audio']) {
    const el = $('dirCnt' + k[0].toUpperCase() + k.slice(1));
    if (el) el.textContent = `${dirRefsOf(k).length}/${caps[k]}`;
  }
  $('dirRefCaps').textContent = `— 图 ≤${caps.image} · 视频 ≤${caps.video} · 音频 ≤${caps.audio}`;
  const copyAll = $('dirRefCopyAll');
  if (copyAll) copyAll.title = `把当前档全部参考（含 role 与说明词）复制到 Seedance ${state.director.refTier === '25' ? '2.0' : '2.5'} 档`;
  document.querySelectorAll('#dirRefTabs button').forEach((b) => {
    b.classList.toggle('active', b.dataset.kind === dirRefKind);
  });
  const meta = DIR_KIND_META[dirRefKind];
  $('dirRefFiles').accept = meta.accept;
  $('dirRefAdd').textContent = `＋ 添加${meta.name}`;
  $('dirRefAdd').disabled = dirRefsOf(dirRefKind).length >= caps[dirRefKind];

  const list = $('dirRefList');
  list.innerHTML = '';
  dirRefsOf(dirRefKind).forEach((r, i) => {
    const row = document.createElement('div');
    row.className = 'dir-ref-row';
    row.dataset.refId = r.id; // 供问题引用定位器按 id 找到说明词框
    // 视频参考：只放一张服务端抽帧的 JPEG 缩略图（不常驻 <video> 解码器，否则几十个参考就把页面拖死），
    // 悬停回放由全局 [data-hover-video] 委托按需创建、移开即销毁。
    const thumb = (r.kind || 'image') === 'image'
      ? `<img src="${r.url}" alt="${escapeHtml(r.name)}" title="${escapeHtml(r.name)}">`
      : (r.kind === 'video'
        ? `<img src="/api/media/thumb?src=${encodeURIComponent(r.url)}" alt="${escapeHtml(r.name)}" title="${escapeHtml(r.name)}" loading="lazy" onerror="this.style.visibility='hidden'">`
        : `<span class="dir-ref-icon" title="${escapeHtml(r.name)}">${DIR_KIND_META[r.kind].icon}</span>`);
    const hoverAttr = r.kind === 'video' ? ` data-hover-video="${escapeHtml(r.url)}"` : '';
    const roleOpts = Object.entries(DIR_REF_ROLES)
      .map(([k, [label]]) => `<option value="${k}" ${(r.role || meta.defaultRole) === k ? 'selected' : ''}>${label}</option>`)
      .join('');
    const otherLabel = (state.director.refTier === '25') ? '2.0' : '2.5';
    row.innerHTML = `
      <div class="ref-cell"${hoverAttr}>${thumb}<button type="button" aria-label="移除">✕</button></div>
      <div class="dir-ref-meta">
        <div class="dir-ref-head">
          <span class="dir-ref-drag" title="按住拖拽调整顺序 — @编号随位置自动重算">⠿</span>
          <span class="dir-ref-idx">${DIR_KIND_META[r.kind || 'image'].icon} ${i + 1} · ${escapeHtml((r.name || '').slice(0, 18))}</span>
          <select class="dir-ref-role" title="这份参考对模型的作用（注入后台提示词）">${roleOpts}</select>
          <button type="button" class="dir-ref-usage" data-token="${(r.kind || 'image') + (i + 1)}"></button>
          <button type="button" class="dir-ref-copy" title="把这份参考连同 role 与说明词复制到 Seedance ${otherLabel} 档的参考集">⇄ ${otherLabel}</button>
        </div>
        <textarea class="dir-ref-note" rows="1" data-min-grow="80" maxlength="160"
          placeholder="补充说明：这份素材是什么 / 想让模型学到什么">${escapeHtml(r.note || '')}</textarea>
        <div class="ref-sliders">
          <label title="这份参考对整体生成的影响力权重：100=最高优先级（与其它参考冲突时以此为准），0=仅作最轻微参考。50=中性不注入">
            <span>影响力</span><input type="range" class="ref-weight" min="0" max="100" step="1" value="${r.weight === undefined ? 50 : Number(r.weight)}"><b>${r.weight === undefined ? 50 : Number(r.weight)}</b></label>
          <label title="忠实度：100=必须原封不动逐细节复刻这份素材；0=完全创作自由，绝不把它当构图用。50=中性不注入">
            <span>忠实度</span><input type="range" class="ref-fidelity" min="0" max="100" step="1" value="${r.fidelity === undefined ? 50 : Number(r.fidelity)}"><b>${r.fidelity === undefined ? 50 : Number(r.fidelity)}</b></label>
        </div>
      </div>`;
    // 被引用指示器：@image1 · N处 —— 点击循环跳遍所有出现这个引用的提示词位置
    const usageBtn = row.querySelector('.dir-ref-usage');
    usageBtn.onclick = () => {
      const token = usageBtn.dataset.token;
      if (typeof collectMentionOccurrences === 'function' && !collectMentionOccurrences(token).length) {
        setDirStatus(`@${token} 还没有被任何提示词引用 — 在任意提示词框输入 @ 即可引用它`);
        return;
      }
      jumpToMentionProblem(token);
    };
    row.querySelector('.ref-cell button').onclick = () => {
      state.director.refs = state.director.refs.filter((x) => x.id !== r.id);
      renderDirRefs();
      scheduleSave();
    };
    row.querySelector('.dir-ref-role').onchange = (e) => { r.role = e.target.value; scheduleSave(); };
    row.querySelector('.dir-ref-note').onchange = (e) => { r.note = e.target.value; scheduleSave(); };
    row.querySelector('.dir-ref-note').addEventListener('input', (e) => { r.note = e.target.value; renderMentionPreview(); });
    for (const [cls, key] of [['ref-weight', 'weight'], ['ref-fidelity', 'fidelity']]) {
      const s = row.querySelector('.' + cls);
      s.oninput = () => { r[key] = Number(s.value); s.nextElementSibling.textContent = s.value; scheduleSave(); };
    }
    row.querySelector('.dir-ref-copy').onclick = () => dirCopyRefToOtherTier(r, true);
    if (typeof attachMentionAutocomplete === 'function') attachMentionAutocomplete(row.querySelector('.dir-ref-note'));
    // 拖拽重排（同类内）：把 image7 拖到顶就变 image1，其余顺延
    const handle = row.querySelector('.dir-ref-drag');
    handle.onmousedown = () => { row.draggable = true; };
    row.addEventListener('dragstart', (e) => {
      dirDragRefId = r.id;
      row.classList.add('dragging');
      try { e.dataTransfer.setData('text/plain', String(r.id)); } catch {}
      e.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragend', () => { row.classList.remove('dragging'); row.draggable = false; dirDragRefId = null; });
    row.addEventListener('dragover', (e) => {
      if (dirDragRefId === null || dirDragRefId === r.id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      row.classList.toggle('drop-above', e.offsetY < row.offsetHeight / 2);
      row.classList.toggle('drop-below', e.offsetY >= row.offsetHeight / 2);
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-above', 'drop-below'));
    row.addEventListener('drop', (e) => {
      row.classList.remove('drop-above', 'drop-below');
      if (dirDragRefId === null || dirDragRefId === r.id) return;
      e.preventDefault();
      e.stopPropagation(); // 不触发面板级的文件拖入处理
      dirReorderRef(dirDragRefId, r.id, e.offsetY < row.offsetHeight / 2);
    });
    list.appendChild(row);
  });
  // 参考增删/换模型会改变编号 → 提示词里的 @chip 预览同步刷新
  if (typeof renderMentionPreview === 'function') renderMentionPreview();
}

document.querySelectorAll('#dirRefTabs button').forEach((b) => {
  b.onclick = () => { dirRefKind = b.dataset.kind; renderDirRefs(); };
});
$('dirRefAdd').onclick = () => $('dirRefFiles').click();
$('dirRefFiles').onchange = async (e) => {
  const caps = dirRefCaps();
  const room = caps[dirRefKind] - dirRefsOf(dirRefKind).length;
  const files = Array.from(e.target.files || []).slice(0, Math.max(0, room));
  e.target.value = '';
  for (const f of files) {
    try {
      setDirStatus(`${DIR_KIND_META[dirRefKind].name}上传中… ${f.name}`);
      const url = await uploadAsset(f);
      state.director.refs.push({
        id: nextRefId++, name: f.name, url,
        kind: dirRefKind, role: DIR_KIND_META[dirRefKind].defaultRole, note: '',
      });
      setDirStatus('');
    } catch (err) { setDirStatus(`${DIR_KIND_META[dirRefKind].name}上传失败: ` + errMsg(err)); }
  }
  renderDirRefs();
  scheduleSave();
};

// 生成——支持任意多个任务并发：点一次开一个任务，按钮永不锁定
let dirRunning = 0;
function updateDirRunPill() {
  const pill = $('dirRunCount');
  if (!pill) return;
  pill.hidden = dirRunning <= 0;
  pill.textContent = `⏳ ${dirRunning} 个生成进行中`;
}
/** 每份参考的 role + 影响力/忠实度滑杆 + 说明词 → 使用说明行（导演生成与中割一体生成共用同一套注入文案） */
function buildRefNotesLines(refs, resolveFn) {
  const kindCounters = { image: 0, video: 0, audio: 0 };
  const rs = resolveFn || ((t) => String(t || '').trim());
  return refs.map((r) => {
    const kind = r.kind || 'image';
    kindCounters[kind] += 1;
    const roleDef = DIR_REF_ROLES[r.role || DIR_KIND_META[kind].defaultRole];
    const roleText = roleDef ? `${roleDef[0]}——${roleDef[1]}` : '';
    const note = rs((r.note || '').trim()); // 导演区：说明里也可 @引用其它素材（悬空引用同样计入拦截）
    // 影响力 / 忠实度滑杆 → 档位指令（50 为中性不注入，避免提示词臃肿）
    const w = r.weight === undefined ? 50 : Number(r.weight);
    const f = r.fidelity === undefined ? 50 : Number(r.fidelity);
    const weightText = w >= 85 ? '【最高权重】此参考优先级最高，与其它参考冲突时一律以此为准'
      : w >= 65 ? '高权重参考，优先遵循'
      : w <= 15 ? '最低权重，仅作最轻微的参考'
      : w <= 35 ? '低权重参考，其它参考优先' : '';
    const fidelityText = f >= 85 ? '必须原封不动地使用这份素材的画面内容与构图，逐细节复刻，禁止任何再创作'
      : f >= 65 ? '高度贴近原素材，仅允许细微变化'
      : f <= 15 ? '完全创作自由：任何情况下都不得将其用作构图或画面布局，仅作气质与要素的启发'
      : f <= 35 ? '大幅再创作：只取其要素与精神，画面构图自由重构' : '';
    const clauses = [roleText, weightText, fidelityText].filter(Boolean).join('；');
    if (!clauses && !note) return null;
    return `${DIR_KIND_META[kind].name}${kindCounters[kind]}（${clauses}）${note ? '：' + note : ''}`;
  }).filter(Boolean);
}

/** 参考文件编号命名（image1/video1…与提示词编号一一对应）+ 打包清单元数据（Simulate GEN 用） */
function buildRefsMeta(refs) {
  const metaCounters = { image: 0, video: 0, audio: 0 };
  return refs.map((r) => {
    const kind = r.kind || 'image';
    metaCounters[kind] += 1;
    const roleDef = DIR_REF_ROLES[r.role || DIR_KIND_META[kind].defaultRole];
    return {
      file: kind + metaCounters[kind],
      roleLabel: roleDef ? roleDef[0] : '',
      note: (r.note || '').trim(),
      weight: r.weight, fidelity: r.fidelity,
    };
  });
}

/** 组装一次生成的完整请求（真实生成与 Simulate GEN 共用同一条管线）；被拦时返回 null */
function assembleDirectorRequest() {
  if (!state.director.refs.length) {
    setDirStatus('至少需要一份参考素材（图/视频/音频）');
    return null;
  }
  // @引用解析：@image1 → 「参考图1」；找不到的编号直接拦下，避免模型收到悬空引用
  const unknownAll = [];
  const rs = (t) => {
    const r = resolveMentions(String(t || '').trim());
    unknownAll.push(...r.unknown);
    return r.text;
  };
  const contextText = rs($('dirPrompt').value);
  const cutsBlock = buildDirCutsBlock(rs);
  const negativeRaw = rs($('dirNegative').value);
  const model = $('dirModel').value || undefined;
  let duration = Number($('dirDuration').value);
  if (cutsBlock.totalSec) {
    // 全部镜头都设了时长 → 生成时长自动对齐分镜总和
    const slider = $('dirDuration');
    duration = Math.min(Number(slider.max), Math.max(Number(slider.min), Math.round(cutsBlock.totalSec)));
    slider.value = duration;
    $('dirDurationVal').textContent = duration + ' 秒';
  }
  const acting = directorActingText();
  // 每份参考的 role + 说明 → @引用式指令块（后台注入，指挥模型如何使用每份素材）
  const refNotes = buildRefNotesLines(state.director.refs, rs);
  // 悬空 @引用统一拦截门：情境 / 分镜（含 60/30/10）/ 负面 / 每份参考的说明词全覆盖
  if (unknownAll.length) {
    setDirStatus('⚠ 找不到引用 ' + Array.from(new Set(unknownAll)).join('、') + ' — 已跳到问题位置，改完再点生成');
    // 直接把用户带到第一处问题引用并高亮选中（与红 chip 点击同一套定位器）
    const first = Array.from(new Set(unknownAll))[0];
    const m = /^@(image|img|图|圖|video|vid|视频|audio|aud|音频)(\d+)$/i.exec(first);
    if (m) {
      const kind = MENTION_ALIAS[m[1].toLowerCase()] || MENTION_ALIAS[m[1]];
      if (kind) {
        mentionJump.key = null; // 重置循环，从第一处开始
        jumpToMentionProblem(kind + Number(m[2]));
      }
    }
    return null;
  }
  const globalMood = moodPromptOf(state.director.mood || '');
  const prompt = [
    contextText,
    globalMood ? '【' + globalMood.replace('场面情绪锁：', '场面情绪 · 全局】') : '',
    cutsBlock.text,
    refNotes.length ? '参考素材使用说明：\n' + refNotes.join('\n') : '',
    acting,
    negativeRaw ? '【负面清单】画面中绝不出现：' + negativeRaw : '',
  ].filter(Boolean).join('\n');
  // 点击瞬间快照（注入前的原文 + 当时的全部参考）：生成期间用户改框也不影响历史记录
  const genSnapshot = {
    context: $('dirPrompt').value,
    cuts: state.director.cuts.map((c) => ({ text: c.text || '', dur: Number(c.dur) || 0, fixedCam: !!c.fixedCam, movingHold: !!c.movingHold, mood: c.mood || '', comp: c.comp ? { on: !!c.comp.on, p60: c.comp.p60 || '', p30: c.comp.p30 || '', p10: c.comp.p10 || '' } : undefined })),
    negative: $('dirNegative').value,
    mood: state.director.mood || '',
    animMode: $('dirAnimMode').value,
    refs: state.director.refs.map((r) => ({
      name: r.name || '', url: r.url, kind: r.kind || 'image',
      role: r.role || DIR_KIND_META[r.kind || 'image'].defaultRole, note: r.note || '',
      weight: r.weight, fidelity: r.fidelity,
    })),
  };
  // 参考文件的编号命名（与提示词编号一一对应）+ 打包清单元数据
  const refsMeta = buildRefsMeta(state.director.refs);
  return {
    prompt, duration, model, genSnapshot, refsMeta,
    animMode: $('dirAnimMode').value,
    generateAudio: !$('dirAudioWrap').hidden ? $('dirAudio').checked : undefined,
    refImages: dirRefsOf('image').map((r) => r.url),
    refVideos: dirRefsOf('video').map((r) => r.url),
    refAudios: dirRefsOf('audio').map((r) => r.url),
  };
}

async function directorGenerate() {
  const reqData = assembleDirectorRequest();
  if (!reqData) return;
  const { prompt, duration, model, genSnapshot } = reqData;
  dirRunning += 1;
  updateDirRunPill();
  setDirStatus('创建任务中…');
  let job = null;
  try {
    job = addJob(`🎬 导演生成 ${duration}s${model ? (dirEffectiveIs25() ? ' · 2.5' : ' · 2.0') : ''}`, 60 + duration * 25);
    const res = await fetch('/api/director', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firstFrame: null, // 首帧/尾帧已移除 — 纯参考驱动
        lastFrame: null,
        refImages: reqData.refImages,
        refVideos: reqData.refVideos,
        refAudios: reqData.refAudios,
        prompt, duration, model,
        animMode: reqData.animMode,
        generateAudio: reqData.generateAudio,
        // 场景私有常青：undefined = 不传该键 → 服务端沿用 🌲 全局
        ...(state.director.evergreen !== undefined ? { evergreen: state.director.evergreen } : {}),
      }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || ('请求失败 ' + res.status));
    trackPendingTask({ id: json.id, kind: 'director', duration, model: model || '', note: $('dirPrompt').value.trim().slice(0, 80) });
    setDirStatus('生成中…（可离开此页，结果会自动入历史）');
    const p = await pollUntilDone(json.id);
    untrackPendingTask(json.id);
    state.director.history.unshift({
      videoUrl: p.videoUrl,
      time: new Date().toLocaleString('zh-CN', { hour12: false }),
      duration, model: model || '2.0', note: genSnapshot.context.trim().slice(0, 120),
      // 原始输入全文（滑杆注入与参考指令之前的用户原文，含 @token）——供一键复用
      rawPrompt: genSnapshot.context,
      // 点击瞬间的完整快照：情境 + 分镜 + 负面 + 帧率 + 全部参考素材及其 role/说明词
      inputs: genSnapshot,
    });
    state.director.current = 0;
    renderDirector();
    setDirStatus(p.notice ? '完成 ✓ ' + p.notice : '完成 ✓');
    finishJob(job, true);
    scheduleSave();
  } catch (e) {
    setDirStatus('失败: ' + errMsg(e).slice(0, 400));
    finishJob(job, false, errMsg(e));
  } finally {
    dirRunning = Math.max(0, dirRunning - 1);
    updateDirRunPill();
    $('btnDirectorGen').disabled = false; // 双保险：无论如何按钮都保持可用
  }
}
$('btnDirectorGen').onclick = directorGenerate;

// 结果 + 历史
function renderDirector() {
  const h = state.director.history;
  const cur = h[state.director.current];
  const v = $('dirResult');
  if (cur) { v.src = cur.videoUrl; v.hidden = false; $('dirResultEmpty').hidden = true; }
  else { v.hidden = true; $('dirResultEmpty').hidden = false; }
  $('dirFrameGrabRow').hidden = !cur;
  const list = $('dirHistory');
  list.innerHTML = '';
  // 旧历史（未存全文）：note 是原文前 120 字 → 去提示词库（存了全文）按前缀回捞
  const fullPromptFor = (item) => {
    if (item.rawPrompt !== undefined) return item.rawPrompt;
    const note = String(item.note || '').trim();
    if (!note) return '';
    const hit = (state.usedPrompts || []).find((u) => u && u.kind === 'director' && String(u.text || '').startsWith(note));
    return hit ? hit.text : note;
  };
  h.forEach((item, i) => {
    const card = document.createElement('div');
    card.className = 'gen-card' + (i === state.director.current ? ' playing' : '');
    const reusable = fullPromptFor(item);
    card.innerHTML = `${item.videoUrl ? `<div class="hist-thumb-wrap" data-hover-video="${escapeHtml(item.videoUrl)}"><img class="dir-hist-thumb" src="/api/media/thumb?src=${encodeURIComponent(item.videoUrl)}" loading="lazy" onerror="this.style.visibility='hidden'"></div>` : ''}
      <div class="head"><b>${item.model === 'doubao-seedance-2-5-260628' ? '2.5' : '2.0'} · ${item.duration}s</b><span class="hint">${item.time}</span></div>
      <div class="hint">${escapeHtml(item.note || '')}</div>`;
    if (String(reusable).trim()) {
      const reuse = document.createElement('button');
      reuse.type = 'button';
      reuse.className = 'btn ghost reuse-prompt';
      reuse.textContent = '↩ 复用提示词';
      reuse.title = '把这一条生成时的原始输入（滑杆与参考指令注入之前的原文）填回动作描述框';
      reuse.onclick = (e) => {
        e.stopPropagation(); // 不触发卡片的切换播放
        const ta = $('dirPrompt');
        if (item.inputs) {
          // 完整重现：情境 + 分镜 + 负面 + 帧率 + 当时的全部参考素材（含 role/说明词）
          ta.value = item.inputs.context || '';
          state.director.cuts = (item.inputs.cuts || []).map((c) => ({ text: c.text || '', dur: Number(c.dur) || 0, fixedCam: !!c.fixedCam, movingHold: !!c.movingHold, mood: c.mood || '', comp: c.comp ? { on: !!c.comp.on, p60: c.comp.p60 || '', p30: c.comp.p30 || '', p10: c.comp.p10 || '' } : { on: false, p60: '', p30: '', p10: '' } }));
          state.director.mood = item.inputs.mood || '';
          if ($('dirMood')) $('dirMood').value = state.director.mood;
          state.director.negative = item.inputs.negative || '';
          $('dirNegative').value = state.director.negative;
          if (item.inputs.animMode) { $('dirAnimMode').value = item.inputs.animMode; state.director.animMode = item.inputs.animMode; }
          let refsRestored = false;
          if (Array.isArray(item.inputs.refs)) {
            const snap = item.inputs.refs;
            if (!state.director.refs.length
              || confirm(`同时把参考区替换为该次生成时的 ${snap.length} 份参考素材（含 role 与说明词）？\n「取消」= 只还原提示词，保留当前参考。`)) {
              state.director.refs = snap.map((r) => ({
                id: nextRefId++, name: r.name || '', url: r.url,
                kind: r.kind || 'image', role: r.role || DIR_KIND_META[r.kind || 'image'].defaultRole, note: r.note || '',
                weight: r.weight, fidelity: r.fidelity,
              }));
              renderDirRefs();
              refsRestored = true;
            }
          }
          renderDirCuts();
          scheduleSave();
          setDirStatus(refsRestored
            ? '已完整重现该次生成：提示词（情境+分镜+负面+帧率）与全部参考素材 ✓'
            : '已还原该次生成的提示词（情境+分镜+负面+帧率）✓ 参考区保持不变');
        } else {
          ta.value = reusable;
          setDirStatus('已填回该次生成的原始提示词 ✓（@引用会按当前参考区重新解析）');
        }
        ta.dispatchEvent(new Event('input', { bubbles: true })); // 刷新 @chip 预览
        // confirm 弹窗归还焦点是异步的：下一拍再 focus 并显式展开，
        // 避免 activeElement 被静默设置导致后续 focusin 永不触发、框无法展开
        setTimeout(() => {
          ta.focus();
          if (typeof taGrow === 'function') taGrow(ta);
        }, 0);
      };
      card.appendChild(reuse);
    }
    card.onclick = () => { state.director.current = i; renderDirector(); };
    list.appendChild(card);
  });
}
function restoreDirectorUI() {
  // 旧版单参考视频字段 → 迁移进分类参考池（kind=video）
  if (state.director.refVideo) {
    state.director.refs.push({
      id: nextRefId++, name: state.director.refVideoName || '参考视频', url: state.director.refVideo,
      kind: 'video', role: 'action', note: '',
    });
    state.director.refVideo = null;
    state.director.refVideoName = '';
  }
  if (state.director.animMode) $('dirAnimMode').value = state.director.animMode;
  if (typeof renderDirCuts === 'function') renderDirCuts();
  dirSyncTier();
  renderDirector();
  syncDirActing();
}

// ---------------- 模块化布局引擎：面板折叠 / 拖拽重排 / 栏宽调节（全部持久化） ----------------
const LAYOUT_KEY = 'a452LayoutV1';
function layoutState() {
  try { return JSON.parse(localStorage.getItem(LAYOUT_KEY)) || {}; } catch { return {}; }
}
function layoutSave(patch) {
  const s = { ...layoutState(), ...patch };
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(s)); } catch {}
}

(() => {
  // 1) 给每个视图容器里的面板分配稳定 pid（视图 id + 初始序号）
  const containers = [];
  document.querySelectorAll('main.layout').forEach((main) => {
    let idx = 0;
    main.querySelectorAll('.col-left, .col-center, .col-right').forEach((col, ci) => {
      const ckey = main.id + ':' + ci;
      col.dataset.ckey = ckey;
      containers.push(col);
      col.querySelectorAll(':scope > .panel').forEach((p) => {
        p.dataset.pid = main.id + ':' + idx++;
      });
    });
    // col 不分栏的面板（直接挂在 main 下）也编号，避免遗漏
    main.querySelectorAll(':scope > .panel').forEach((p) => {
      p.dataset.pid = p.dataset.pid || main.id + ':' + idx++;
    });
  });

  const st = layoutState();

  // 2) 恢复顺序（模板结构变化时 pid 对不上就跳过该容器，绝不丢面板）
  if (st.order) {
    for (const col of containers) {
      const want = st.order[col.dataset.ckey];
      if (!Array.isArray(want)) continue;
      const byPid = {};
      col.querySelectorAll(':scope > .panel').forEach((p) => { byPid[p.dataset.pid] = p; });
      for (const pid of want) if (byPid[pid]) col.appendChild(byPid[pid]);
    }
  }
  // 3) 恢复折叠 + 栏宽
  if (st.collapsed) {
    document.querySelectorAll('.panel[data-pid]').forEach((p) => {
      if (st.collapsed[p.dataset.pid] && p.querySelector(':scope > h2')) p.classList.add('collapsed');
    });
  }
  if (st.colL) document.documentElement.style.setProperty('--studio-colL', st.colL + 'px');
  if (st.colR) document.documentElement.style.setProperty('--studio-colR', st.colR + 'px');

  function persistOrder() {
    const order = {};
    for (const col of containers) {
      order[col.dataset.ckey] = Array.from(col.querySelectorAll(':scope > .panel')).map((p) => p.dataset.pid);
    }
    layoutSave({ order });
  }
  function persistCollapsed() {
    const collapsed = {};
    document.querySelectorAll('.panel.collapsed[data-pid]').forEach((p) => { collapsed[p.dataset.pid] = 1; });
    layoutSave({ collapsed });
  }

  // 4) h2 = 折叠开关 + 拖拽把手
  let dragPanel = null;
  let didDrag = false;
  document.querySelectorAll('.panel[data-pid] > h2').forEach((h2) => {
    h2.setAttribute('draggable', 'true');
    h2.title = (h2.title ? h2.title + ' · ' : '') + '点击折叠 / 拖动移动面板';
  });
  document.addEventListener('click', (e) => {
    const h2 = e.target.closest('.panel[data-pid] > h2');
    if (!h2 || didDrag) { didDrag = false; return; }
    if (e.target.closest('button, input, select, a')) return; // h2 内控件不触发折叠
    h2.parentElement.classList.toggle('collapsed');
    persistCollapsed();
    layoutMacroTimeline(); // 展开后 canvas 需要重排
  });
  document.addEventListener('dragstart', (e) => {
    const h2 = e.target.closest && e.target.closest('.panel[data-pid] > h2');
    if (!h2) return;
    dragPanel = h2.parentElement;
    didDrag = true;
    dragPanel.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', dragPanel.dataset.pid); } catch {}
  });
  const clearDropMarks = () => {
    document.querySelectorAll('.panel.drop-before, .panel.drop-after').forEach((p) => p.classList.remove('drop-before', 'drop-after'));
    document.querySelectorAll('.col-drop-tail').forEach((c) => c.classList.remove('col-drop-tail'));
  };
  document.addEventListener('dragover', (e) => {
    if (!dragPanel) return;
    const col = e.target.closest && e.target.closest('[data-ckey]');
    if (!col || col.closest('main') !== dragPanel.closest('main')) return; // 只允许同视图内移动
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    clearDropMarks();
    const over = e.target.closest('.panel[data-pid]');
    if (over && over !== dragPanel) {
      const r = over.getBoundingClientRect();
      over.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
    } else if (!over) {
      col.classList.add('col-drop-tail'); // 空白区 → 追加到该栏末尾
    }
  });
  document.addEventListener('drop', (e) => {
    if (!dragPanel) return;
    const col = e.target.closest && e.target.closest('[data-ckey]');
    if (!col || col.closest('main') !== dragPanel.closest('main')) return;
    e.preventDefault();
    const over = e.target.closest('.panel[data-pid]');
    if (over && over !== dragPanel) {
      const r = over.getBoundingClientRect();
      col.insertBefore(dragPanel, e.clientY < r.top + r.height / 2 ? over : over.nextSibling);
    } else if (!over) {
      col.appendChild(dragPanel);
    }
    clearDropMarks();
    persistOrder();
    layoutMacroTimeline();
  });
  document.addEventListener('dragend', () => {
    if (dragPanel) dragPanel.classList.remove('dragging');
    dragPanel = null;
    clearDropMarks();
    setTimeout(() => { didDrag = false; }, 0);
  });

  // 5) 栏宽拖把手（左栏右缘 / 右栏左缘；双击重置该栏）
  document.querySelectorAll('main.layout .col-left, main.layout .col-right').forEach((col) => {
    const isLeft = col.classList.contains('col-left');
    const grip = document.createElement('div');
    grip.className = 'col-resizer';
    grip.title = '拖动调整栏宽 · 双击恢复默认';
    col.appendChild(grip);
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { grip.setPointerCapture(e.pointerId); } catch {}
      grip.classList.add('active');
      const varName = isLeft ? '--studio-colL' : '--studio-colR';
      const startW = col.getBoundingClientRect().width;
      const startX = e.clientX;
      const onMove = (ev) => {
        const dw = isLeft ? ev.clientX - startX : startX - ev.clientX;
        const w = Math.round(Math.min(560, Math.max(200, startW + dw)));
        document.documentElement.style.setProperty(varName, w + 'px');
        layoutSave(isLeft ? { colL: w } : { colR: w });
      };
      const onUp = (ev) => {
        try { grip.releasePointerCapture(ev.pointerId); } catch {}
        grip.classList.remove('active');
        grip.removeEventListener('pointermove', onMove);
        grip.removeEventListener('pointerup', onUp);
        layoutMacroTimeline();
      };
      grip.addEventListener('pointermove', onMove);
      grip.addEventListener('pointerup', onUp);
    });
    grip.addEventListener('dblclick', () => {
      const varName = isLeft ? '--studio-colL' : '--studio-colR';
      document.documentElement.style.removeProperty(varName);
      layoutSave(isLeft ? { colL: 0 } : { colR: 0 });
      layoutMacroTimeline();
    });
  });

  // 6) 一键重置
  $('btnLayoutReset').onclick = () => {
    if (!confirm('重置所有面板布局（折叠状态 / 排列顺序 / 栏宽）？')) return;
    try { localStorage.removeItem(LAYOUT_KEY); } catch {}
    location.reload();
  };
})();

// 顶栏全局模型切换：一键写入 config（model + v2vModel 同步），全部工作区生效
document.querySelectorAll('#modelSeg button').forEach((btn) => {
  btn.onclick = async () => {
    const id = btn.dataset.model;
    if (id === serverModelId) return;
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: id, v2vModel: id }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      serverModelId = id;
      syncModelSeg();
      if (typeof dirSyncTier === 'function') dirSyncTier(); // 参考区上限+双档参考集+徽标同步
      if (typeof ibSyncTier === 'function') ibSyncTier(); // 中割参考区同步换档
      showSaveToast(/2-5/.test(id)
        ? '已切换 Seedance 2.5 — 参考区已换到 2.5 档参考集（30图/10视频/10音频）'
        : '已切换 Seedance 2.0 — 参考区已换到 2.0 档参考集（9图/3视频/3音频）');
    } catch (e) {
      showSaveToast('模型切换失败: ' + errMsg(e), false);
    }
  };
});

// 顶栏 provider 切换：Artcraft 优先（失败自动回退方舟）/ 纯方舟
document.querySelectorAll('#providerSeg button').forEach((btn) => {
  btn.onclick = async () => {
    const p = btn.dataset.provider;
    if (p === serverProvider) return;
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preferredProvider: p }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      serverProvider = p;
      syncModelSeg();
      if (typeof updateDirGoModel === 'function') updateDirGoModel();
      showSaveToast(p === 'artcraft'
        ? '生成通道已切换：Artcraft 优先（44 模型 · 失败自动回退方舟）'
        : '生成通道已切换：方舟直连');
    } catch (e) {
      showSaveToast('通道切换失败: ' + errMsg(e), false);
    }
  };
});
$('btnArtcraftTest').onclick = () => artcraftTest(false);

syncSliderLabels();
refreshConfig();
// 所有多行文本框：聚焦自动展开（事件委托，动态创建的框也生效）
// 最小高度默认 140，可用 data-min-grow 按框覆盖（如关键帧动作描述框 80）
const taGrow = (el) => {
  const minH = Number(el.dataset.minGrow) || 140;
  el.style.height = 'auto';
  el.style.height = Math.min(420, Math.max(el.scrollHeight + 4, minH)) + 'px';
};
document.addEventListener('focusin', (e) => {
  if (e.target.tagName === 'TEXTAREA') taGrow(e.target);
});
// 点击也驱动展开：confirm/系统弹窗抢走窗口焦点后，focus() 只改 activeElement
// 而不触发 focusin（实测），此时再点"已活动"的框 focusin 永远不来 → 用 pointerdown 兜底
document.addEventListener('pointerdown', (e) => {
  if (e.target.tagName === 'TEXTAREA') setTimeout(() => taGrow(e.target), 0);
});
document.addEventListener('input', (e) => {
  if (e.target.tagName === 'TEXTAREA' && document.activeElement === e.target) taGrow(e.target);
});
// 失焦时不立刻收起：mousedown 会先触发 focusout，若同步收起，下方按钮会在
// mousedown 与 mouseup 之间位移，导致第一次点击被吞。按住时等 pointerup 后再收起。
let taPointerHeld = false;
document.addEventListener('pointerdown', () => { taPointerHeld = true; }, true);
document.addEventListener('pointerup', () => { taPointerHeld = false; }, true);
document.addEventListener('pointercancel', () => { taPointerHeld = false; }, true);
document.addEventListener('focusout', (e) => {
  if (e.target.tagName !== 'TEXTAREA') return;
  const el = e.target;
  const collapse = () => { if (document.activeElement !== el) el.style.height = ''; };
  if (taPointerHeld) {
    document.addEventListener('pointerup', () => setTimeout(collapse, 0), { once: true });
  } else {
    setTimeout(collapse, 150);
  }
});

// 段落编辑弹窗
$('gapDlgActing').oninput = (e) => {
  $('gapDlgActingVal').textContent = Number(e.target.value) > 0 ? e.target.value : '全局';
};
$('gapDlgEase').oninput = (e) => {
  $('gapDlgEaseVal').textContent = easeLabel(Number(e.target.value) / 100);
};
$('gapDlgSave').onclick = () => {
  const im = state.images[gapDlgIdx];
  if (im) {
    im.hold = Math.min(6, Math.max(0.1, Number($('gapDlgSeconds').value) || 2));
    im.gapActing = Number($('gapDlgActing').value) || 0;
    im.gapEase = Math.round(Number($('gapDlgEase').value)) / 100;
    im.gapPrompt = $('gapDlgPrompt').value;
    renderImageList();
    scheduleSave();
  }
  $('gapDialog').close();
};
$('gapDlgClose').onclick = () => $('gapDialog').close();

// 窗口缩放时重排时间轴
let mtResizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(mtResizeTimer);
  mtResizeTimer = setTimeout(layoutMacroTimeline, 150);
});

renderAll();
renderV2V();
renderWhole();
setBadge('已停止');
// 先恢复工程，再应用 adwPrompt 直通、再向父窗口宣布就绪：
// 保证镜头包（a452-shot-handoff）不会与恢复过程竞争，避免关键帧/提示词被覆盖或 id 重复
loadProject().then(() => {
  if (adwPromptParam) {
    $('globalPrompt').value = adwPromptParam;
    scheduleSave();
    setWholeStatus('已接收来自 Director Workspace 的镜头提示词 ✓');
  }
  try {
    if (window.parent && window.parent !== window) window.parent.postMessage({ type: 'a452-studio-ready' }, '*');
  } catch {}
});

// 关窗/刷新前把未落盘的改动冲刷到服务器（防抖 800ms 内关窗会丢最后一次编辑）
window.addEventListener('pagehide', () => {
  clearTimeout(saveTimer);
  if (!projectLoaded) return; // 恢复未完成时内存是空工程，禁止覆盖磁盘
  const body = JSON.stringify(snapshot());
  // Blob 必须带 application/json，否则服务器 express.json() 不解析
  let ok = false;
  try { ok = navigator.sendBeacon('/api/project', new Blob([body], { type: 'application/json' })); } catch {}
  if (!ok) {
    fetch('/api/project', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
  }
});

// ---------------- 风格 DNA 停靠区（从策划端 postMessage 接收，可拖入任意提示词框） ----------------
let dnaProfiles = []; // [{ id, name, fragment }]

function renderDnaDock() {
  const dock = document.getElementById('dnaDock');
  const empty = document.getElementById('dnaDockEmpty');
  if (!dock) return;
  dock.innerHTML = '';
  const has = dnaProfiles.length > 0;
  if (empty) empty.hidden = has;
  for (const p of dnaProfiles) {
    if (!p || !p.fragment) continue;
    const chip = document.createElement('div');
    chip.className = 'dna-chip';
    chip.draggable = true;
    chip.title = p.fragment;
    chip.innerHTML = `<span class="dna-chip-name">${escapeHtml(p.name || 'DNA')}</span>`;
    chip.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/a452-dna', p.fragment);
      e.dataTransfer.setData('text/plain', p.fragment);
      e.dataTransfer.effectAllowed = 'copy';
      chip.classList.add('dragging');
    });
    chip.addEventListener('dragend', () => chip.classList.remove('dragging'));
    dock.appendChild(chip);
  }
}

/** 把一段文字插入到某个 textarea 的光标处（或追加），并触发保存 */
function insertIntoTextarea(ta, text) {
  const cur = ta.value;
  const start = ta.selectionStart ?? cur.length;
  const end = ta.selectionEnd ?? cur.length;
  const needsSep = start > 0 && !/\s$/.test(cur.slice(0, start)) ? ', ' : '';
  const next = cur.slice(0, start) + needsSep + text + cur.slice(end);
  ta.value = next;
  const caret = start + needsSep.length + text.length;
  try { ta.setSelectionRange(caret, caret); } catch {}
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.dispatchEvent(new Event('change', { bubbles: true }));
}

// 所有 textarea 都能作为 DNA 拖放目标
document.addEventListener('dragover', (e) => {
  const ta = e.target instanceof HTMLTextAreaElement ? e.target : null;
  if (ta && Array.from(e.dataTransfer.types || []).includes('text/a452-dna')) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    ta.classList.add('dna-drop-target');
  }
});
document.addEventListener('dragleave', (e) => {
  if (e.target instanceof HTMLTextAreaElement) e.target.classList.remove('dna-drop-target');
});
document.addEventListener('drop', (e) => {
  const ta = e.target instanceof HTMLTextAreaElement ? e.target : null;
  if (!ta) return;
  const frag = e.dataTransfer.getData('text/a452-dna');
  if (!frag) return; // 非 DNA 拖放交给浏览器默认处理
  e.preventDefault();
  ta.classList.remove('dna-drop-target');
  insertIntoTextarea(ta, frag);
});

// ---------------- 洋葱皮 Onion Skin：相邻关键帧半透明叠加对比 ----------------
let onionIdx = 0;
let onionDrawSeq = 0; // 竞态令牌：连续翻帧时只有最后一次绘制生效
const onionImgCache = new Map();

function onionLoad(url) {
  if (onionImgCache.has(url)) return onionImgCache.get(url);
  const p = new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => { onionImgCache.delete(url); reject(new Error('图片加载失败')); };
    img.src = url;
  });
  onionImgCache.set(url, p);
  return p;
}

// 把一帧涂成纯色调（保留轮廓与明暗），用于红/绿叠加层
function onionTint(img, color, w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const x = c.getContext('2d');
  x.drawImage(img, 0, 0, w, h);
  x.globalCompositeOperation = 'source-atop';
  x.fillStyle = color;
  x.fillRect(0, 0, w, h);
  return c;
}

async function drawOnion() {
  const seq = ++onionDrawSeq;
  const n = state.images.length;
  if (!n) return;
  onionIdx = Math.max(0, Math.min(onionIdx, n - 1));
  $('onionInfo').textContent = `${onionIdx + 1} / ${n}`;
  $('onionPrev').disabled = onionIdx === 0;
  $('onionNext').disabled = onionIdx === n - 1;
  const wantPrev = $('onionPrevChk').checked && onionIdx > 0;
  const wantNext = $('onionNextChk').checked && onionIdx < n - 1;
  try {
    const [cur, prev, next] = await Promise.all([
      onionLoad(state.images[onionIdx].url),
      wantPrev ? onionLoad(state.images[onionIdx - 1].url) : null,
      wantNext ? onionLoad(state.images[onionIdx + 1].url) : null,
    ]);
    if (seq !== onionDrawSeq) return; // 已被更新的绘制取代
    const canvas = $('onionCanvas');
    const w = (canvas.width = cur.naturalWidth || 1280);
    const h = (canvas.height = cur.naturalHeight || 720);
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(cur, 0, 0, w, h);
    ctx.globalAlpha = Number($('onionAlpha').value) / 100;
    if (prev) ctx.drawImage(onionTint(prev, 'rgba(255,45,85,.55)', w, h), 0, 0);
    if (next) ctx.drawImage(onionTint(next, 'rgba(48,209,88,.55)', w, h), 0, 0);
    ctx.globalAlpha = 1;
  } catch (err) {
    if (seq === onionDrawSeq) setWholeStatus('洋葱皮绘制失败: ' + errMsg(err));
  }
}

$('btnOnion').onclick = () => {
  if (state.images.length < 2) { setWholeStatus('洋葱皮需要至少 2 张关键帧'); return; }
  $('onionDialog').showModal();
  drawOnion();
};
$('onionPrev').onclick = () => { onionIdx--; drawOnion(); };
$('onionNext').onclick = () => { onionIdx++; drawOnion(); };
$('onionAlpha').oninput = (e) => { $('onionAlphaVal').textContent = e.target.value + ' %'; drawOnion(); };
$('onionPrevChk').onchange = drawOnion;
$('onionNextChk').onchange = drawOnion;
$('onionClose').onclick = () => $('onionDialog').close();
$('onionDialog').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft') { e.preventDefault(); onionIdx--; drawOnion(); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); onionIdx++; drawOnion(); }
});

// ---------------- 動作分析：视频 → 运动能量曲线 → 原画拾取 ----------------
// 「動きの句読点を、原画として拾う」——上传参考视频，差分出运动能量，
// 在极值处自动拾取关键姿势，联络表逐张确认后一键送入中割关键帧。
let motionAnalyzing = false;

function motionFmtTime(t) {
  const s = Math.floor(t);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}.${String(Math.round((t - s) * 10))}`;
}

function restoreMotionUI() {
  const m = state.motion;
  if (m.srcUrl) {
    $('motionVideo').src = m.srcUrl;
    $('motionVideo').hidden = false;
    $('motionEmpty').hidden = true;
    $('motionSrcInfo').textContent = m.srcName || '';
    $('btnAnalyzeMotion').disabled = false;
  }
  if (m.energy.length) $('motionChartPanel').hidden = false;
  if (m.poses.length) {
    $('motionSheetPanel').hidden = false;
    renderMotionSheet();
  }
  updateMotionStats();
  drawMotionChart();
}

function updateMotionStats() {
  const m = state.motion;
  const show = m.poses.length > 0 || m.energy.length > 0;
  $('motionStats').hidden = !show;
  $('statPoses').textContent = m.poses.length;
  $('statAccepted').textContent = m.poses.filter((p) => p.accepted).length;
  const d = Math.round(m.duration);
  $('statDuration').textContent = `${Math.floor(d / 60)}:${String(d % 60).padStart(2, '0')}`;
  const nAcc = m.poses.filter((p) => p.accepted).length;
  $('poseSendCount').textContent = nAcc;
  $('btnPosesToKeys').disabled = nAcc === 0;
}

async function motionSetSource(url, name) {
  state.motion.srcUrl = url;
  state.motion.srcName = name;
  state.motion.energy = [];
  state.motion.poses = [];
  $('motionVideo').src = url;
  $('motionVideo').hidden = false;
  $('motionEmpty').hidden = true;
  $('motionSrcInfo').textContent = name;
  $('btnAnalyzeMotion').disabled = false;
  $('motionChartPanel').hidden = true;
  $('motionSheetPanel').hidden = true;
  $('motionStatus').textContent = '';
  updateMotionStats();
  scheduleSave();
}

$('motionFile').onchange = async (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f) return;
  if (!f.type.startsWith('video/')) { $('motionStatus').textContent = '请选择视频文件'; return; }
  $('motionStatus').textContent = '上传中…';
  try {
    const url = await uploadAsset(f);
    await motionSetSource(url, f.name);
  } catch (err) {
    $('motionStatus').textContent = '上传失败: ' + errMsg(err);
  }
};

$('motionUseV2V').onclick = () => {
  if (state.v2v.sourceUrl) motionSetSource(state.v2v.sourceUrl, state.v2v.sourceName || 'v2v 源视频');
};

// 原画选点：能量局部极大值 + 感度阈值 + 最小间隔贪心 + 上限 + 可选首尾帧
function pickKeyTimes() {
  const m = state.motion;
  const e = m.energy;
  if (!e.length || !m.fps) return [];
  const sens = Number($('motionSens').value);              // 10..100 高=多拾
  const minGap = Number($('motionGap').value) / 10;        // 0.2..2.0s
  const maxN = Number($('motionMax').value);
  const keepEnds = $('motionEnds').checked;
  const maxE = Math.max(...e, 0.0001);
  const thr = maxE * (1 - sens / 100) * 0.9;               // 感度 100 → 阈值≈0
  const cand = [];
  for (let i = 1; i < e.length - 1; i++) {
    if (e[i] >= e[i - 1] && e[i] >= e[i + 1] && e[i] > thr) cand.push({ t: i / m.fps, v: e[i] });
  }
  cand.sort((a, b) => b.v - a.v);
  const picked = [];
  const ends = keepEnds ? [0, Math.max(0, m.duration - 0.05)] : [];
  const clash = (t) => picked.some((p) => Math.abs(p - t) < minGap) || ends.some((p) => Math.abs(p - t) < minGap);
  for (const c of cand) {
    if (picked.length >= maxN) break;
    if (!clash(c.t)) picked.push(c.t);
  }
  return [...ends, ...picked].sort((a, b) => a - b);
}

$('btnAnalyzeMotion').onclick = async () => {
  const m = state.motion;
  if (!m.srcUrl || motionAnalyzing) return;
  motionAnalyzing = true;
  $('btnAnalyzeMotion').disabled = true;
  try {
    if (!m.energy.length) {
      $('motionStatus').textContent = '差分运动能量中…';
      const r = await fetch('/api/motion/analyze', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoUrl: m.srcUrl, fps: 12 }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || `分析失败 (${r.status})`);
      m.fps = j.fps; m.duration = j.duration; m.energy = j.energy;
      $('motionChartPanel').hidden = false;
    }
    const times = pickKeyTimes();
    if (!times.length) throw new Error('没有拾取到原画 — 调高抽出感度试试');
    $('motionStatus').textContent = `抽取 ${times.length} 张原画帧中…`;
    const r2 = await fetch('/api/motion/extract', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoUrl: m.srcUrl, times }),
    });
    const j2 = await r2.json().catch(() => ({}));
    if (!r2.ok || !j2.ok) throw new Error(j2.error || `抽帧失败 (${r2.status})`);
    m.poses = j2.frames.map((f) => ({ t: f.t, url: f.url, accepted: true }));
    $('motionSheetPanel').hidden = false;
    renderMotionSheet();
    updateMotionStats();
    drawMotionChart();
    $('motionStatus').textContent = `完成 — ${m.poses.length} 张原画候補 ✓`;
    scheduleSave();
  } catch (err) {
    $('motionStatus').textContent = StringerrMsg(err);
  } finally {
    motionAnalyzing = false;
    $('btnAnalyzeMotion').disabled = !state.motion.srcUrl;
  }
};

// 参数变化 → 实时更新标签；已有能量时按钮转为重新拾取
$('motionSens').oninput = (e) => { $('motionSensVal').textContent = e.target.value; };
$('motionGap').oninput = (e) => { $('motionGapVal').textContent = (e.target.value / 10).toFixed(1) + 's'; };
$('motionMax').oninput = (e) => { $('motionMaxVal').textContent = e.target.value; };

// ---- MOTION ENERGY 图表：能量面积图 + 原画竖线（点击跳帧/切换选用） ----
function drawMotionChart() {
  const canvas = $('motionChart');
  const m = state.motion;
  if (!canvas || canvas.clientWidth === 0) return;
  const W = (canvas.width = canvas.clientWidth * (window.devicePixelRatio || 1));
  const H = (canvas.height = 150 * (window.devicePixelRatio || 1));
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  if (!m.energy.length) return;
  const maxE = Math.max(...m.energy, 0.0001);
  const px = (i) => (i / (m.energy.length - 1)) * W;
  const py = (v) => H - 12 - (v / maxE) * (H - 34);
  // 面积
  ctx.beginPath();
  ctx.moveTo(0, H - 12);
  m.energy.forEach((v, i) => ctx.lineTo(px(i), py(v)));
  ctx.lineTo(W, H - 12);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, 'rgba(200,246,93,.55)');
  grad.addColorStop(1, 'rgba(200,246,93,.06)');
  ctx.fillStyle = grad;
  ctx.fill();
  // 轮廓线
  ctx.beginPath();
  m.energy.forEach((v, i) => (i ? ctx.lineTo(px(i), py(v)) : ctx.moveTo(px(0), py(v))));
  ctx.strokeStyle = 'rgba(200,246,93,.9)';
  ctx.lineWidth = 1.5 * (window.devicePixelRatio || 1);
  ctx.stroke();
  // 底线
  ctx.fillStyle = 'rgba(148,163,184,.35)';
  ctx.fillRect(0, H - 12, W, 1);
  // 原画竖线
  for (const p of m.poses) {
    const x = (p.t / Math.max(m.duration, 0.001)) * W;
    ctx.fillStyle = p.accepted ? 'rgba(200,246,93,.95)' : 'rgba(148,163,184,.4)';
    ctx.fillRect(x - 1, 8, 2, H - 20);
    if (p.accepted) {
      ctx.beginPath();
      ctx.arc(x, 8, 3.5 * (window.devicePixelRatio || 1), 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // 播放头
  const vid = $('motionVideo');
  if (vid && !vid.hidden && vid.duration) {
    const x = (vid.currentTime / vid.duration) * W;
    ctx.fillStyle = 'rgba(255,255,255,.85)';
    ctx.fillRect(x - 0.5, 0, 1, H);
  }
}

$('motionChart').onclick = (e) => {
  const m = state.motion;
  if (!m.duration) return;
  const rect = $('motionChart').getBoundingClientRect();
  const t = ((e.clientX - rect.left) / rect.width) * m.duration;
  // 命中原画竖线（±2% 时长）→ 跳帧并切换选用；否则仅跳帧
  const hit = m.poses.find((p) => Math.abs(p.t - t) < m.duration * 0.02);
  $('motionVideo').currentTime = hit ? hit.t : t;
  if (hit) {
    hit.accepted = !hit.accepted;
    renderMotionSheet();
    updateMotionStats();
    scheduleSave();
  }
  drawMotionChart();
};
$('motionVideo').addEventListener('timeupdate', () => { if (!$('viewMotion').hidden) drawMotionChart(); });
window.addEventListener('resize', () => { if (!$('viewMotion').hidden) drawMotionChart(); });

// ---- 原画候補联络表 ----
function renderMotionSheet() {
  const sheet = $('motionSheet');
  sheet.innerHTML = '';
  state.motion.poses.forEach((p, i) => {
    const card = document.createElement('div');
    card.className = 'pose-card' + (p.accepted ? ' accepted' : '');
    card.innerHTML = `<img src="${p.url}" alt="pose ${i + 1}" draggable="false">
      <span class="pose-tick">${p.accepted ? '✓' : ''}</span>
      <div class="pose-meta"><span>${String(i + 1).padStart(2, '0')}${i === 0 ? ' / 開始' : ''}</span><span>${motionFmtTime(p.t)}</span></div>`;
    card.onclick = () => {
      p.accepted = !p.accepted;
      $('motionVideo').currentTime = p.t;
      renderMotionSheet();
      updateMotionStats();
      drawMotionChart();
      scheduleSave();
    };
    sheet.appendChild(card);
  });
}

$('btnPosesAll').onclick = () => { state.motion.poses.forEach((p) => (p.accepted = true)); renderMotionSheet(); updateMotionStats(); drawMotionChart(); scheduleSave(); };
$('btnPosesNone').onclick = () => { state.motion.poses.forEach((p) => (p.accepted = false)); renderMotionSheet(); updateMotionStats(); drawMotionChart(); scheduleSave(); };

// 送入中割：接受的原画按时间序作为关键帧加入工作区 1
$('btnPosesToKeys').onclick = async () => {
  const picked = state.motion.poses.filter((p) => p.accepted).sort((a, b) => a.t - b.t);
  if (!picked.length) return;
  $('motionSheetStatus').textContent = '送入中…';
  let n = 0;
  for (const p of picked) {
    // 帧已在 assets 里 — 直接推入关键帧序列，无需重新上传
    state.images.push({ id: nextImgId++, name: `pose_${motionFmtTime(p.t)}.jpg`, url: p.url, hold: 2 });
    n++;
  }
  rebuildSegments();
  renderAll();
  scheduleSave();
  $('motionSheetStatus').textContent = '';
  switchMode('inbetween');
  setWholeStatus(`已从動作分析送入 ${n} 张原画关键帧 ✓`);
};

// ---------------- ⟨/⟩ JSON 脚本导出：MARS-LSP 式时间轴结构 ----------------
function buildShotScript() {
  const timings = wholeTimings();
  let t = 0;
  const keyframes = state.images.map((im, i) => {
    const entry = {
      index: i + 1,
      time_seconds: Math.round(t * 100) / 100,
      hold_to_next_seconds: i < timings.length ? timings[i] : null,
      name: im.name,
      url: im.url,
    };
    if (i < timings.length) t += timings[i];
    return entry;
  });
  let cursor = 0;
  const timeline = state.images.slice(0, -1).map((im, i) => {
    const seg = {
      beat: i + 1,
      from_keyframe: i + 1,
      to_keyframe: i + 2,
      start_seconds: Math.round(cursor * 100) / 100,
      end_seconds: Math.round((cursor + timings[i]) * 100) / 100,
      duration_seconds: timings[i],
      motion: (im.gapPrompt || '').trim() || null,
      acting_level: im.gapActing > 0 ? im.gapActing : null,
      easing: Math.abs(Number(im.gapEase || 0)) >= 0.03
        ? { type: Number(im.gapEase) > 0 ? 'ease-out' : 'ease-in', strength: Math.abs(Number(im.gapEase)) }
        : { type: 'linear', strength: 0 },
    };
    cursor += timings[i];
    return seg;
  });
  return {
    format: 'a452-mars-lsp',
    version: 1,
    source: 'Atelier452 Gen Studio · 中割生成',
    duration_seconds: Math.round(wholeTotalSeconds() * 100) / 100,
    global_prompt: $('globalPrompt').value.trim() || null,
    acting_level_default: Number($('acting').value),
    keyframe_count: state.images.length,
    keyframes,
    timeline,
  };
}

$('btnJsonScript').onclick = () => {
  if (!state.images.length) { setWholeStatus('先上传关键帧，再导出 JSON 脚本'); return; }
  $('jsonScriptPre').textContent = JSON.stringify(buildShotScript(), null, 2);
  $('jsonScriptDialog').showModal();
};
$('jsonScriptCopy').onclick = async () => {
  try {
    await navigator.clipboard.writeText($('jsonScriptPre').textContent);
    $('jsonScriptCopy').textContent = '已复制 ✓';
    setTimeout(() => ($('jsonScriptCopy').textContent = '复制 JSON'), 1400);
  } catch {}
};
$('jsonScriptDownload').onclick = () => {
  const blob = new Blob([$('jsonScriptPre').textContent], { type: 'application/json' });
  download(URL.createObjectURL(blob), 'shot-script.json');
};
$('jsonScriptClose').onclick = () => $('jsonScriptDialog').close();

// ---------------- 镜头包直通：Scene Setup → Gen Studio 全量入位 ----------------
async function dataUrlToFile(src, name) {
  const blob = await (await fetch(src)).blob();
  const ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
  return new File([blob], `${name}.${ext}`, { type: blob.type || 'image/png' });
}

/** 接收镜头包：提示词 → 动作描述；缩略图 → 关键帧；参考图 → 转绘+精修参考 */
async function receiveShotHandoff(d) {
  try {
    if (d.prompt) {
      $('globalPrompt').value = d.prompt;
      scheduleSave();
    }
    // 关键帧（镜头缩略图）→ 工作区 1 输入关键帧
    const keyFiles = [];
    for (const src of (d.keyframes || []).slice(0, 15)) {
      try { keyFiles.push(await dataUrlToFile(src, d.title ? `${d.title}-key` : 'shot-key')); } catch {}
    }
    if (keyFiles.length) await addFiles(keyFiles);
    // 角色/场景参考图 → 工作区 2 上色参考 + 工作区 3 精修参考（各上传一次，双处登记）
    let nRefs = 0;
    for (const r of (d.refs || []).slice(0, 12)) {
      try {
        const f = await dataUrlToFile(r.src, r.label || 'ref');
        if (!f.type.startsWith('image/')) continue;
        const url = await uploadAsset(f);
        state.v2v.refs.push({ id: nextRefId++, name: f.name, url });
        state.refine.refs.push({ id: nextRefId++, name: f.name, url });
        nRefs++;
      } catch {}
    }
    if (nRefs) { renderV2V(); renderRefine(); scheduleSave(); }
    switchMode('inbetween');
    setWholeStatus(
      `已接收镜头「${d.title || ''}」✓ ` +
      [d.prompt ? '提示词' : '', keyFiles.length ? `${keyFiles.length} 关键帧` : '', nRefs ? `${nRefs} 参考图` : '']
        .filter(Boolean).join(' · ') + ' 已入位',
    );
  } catch (err) {
    setWholeStatus('镜头包接收失败: ' + errMsg(err));
  }
}

// 与策划端（父窗口 iframe）握手：接收 DNA 列表 / 镜头包
// 只信任同源与本机（localhost/127.0.0.1 任意端口，覆盖策划端 3452/3453 与 Electron），
// 阻止任意网页 window.open 本页后驱动本地 API（与 server.js 的 CORS 锁配套）
function isTrustedMessageOrigin(origin) {
  if (origin === location.origin) return true;
  try {
    const host = new URL(origin).hostname;
    return host === 'localhost' || host === '127.0.0.1';
  } catch {
    return false;
  }
}
window.addEventListener('message', (e) => {
  if (!isTrustedMessageOrigin(e.origin)) return;
  const d = e.data;
  if (!d) return;
  if (d.type === 'a452-style-dna' && Array.isArray(d.profiles)) {
    dnaProfiles = d.profiles.filter((p) => p && p.fragment);
    renderDnaDock();
    return;
  }
  if (d.type === 'a452-shot-handoff') {
    receiveShotHandoff(d);
  }
});
renderDnaDock();
// 「a452-studio-ready」握手已移至 loadProject().then(...)（见「启动」段）：
// 必须等工程恢复完成后再邀请父窗口发镜头包，否则会与恢复竞争
// ---------------- 应用内媒体选择器 ----------------
// 系统文件对话框在 Windows/Chromium 下不渲染缩略图，挑素材全靠文件名。
// 这里自带一个真缩略图浏览器：/api/fs/list 列目录、/api/fs/thumb 出图（ffmpeg 缓存）、
// /api/fs/import 服务器直拷（不过 base64，任意大小稳定）。
const fsPk = {
  kinds: ['image'], multi: true, onDone: null, nativeInput: null,
  dir: '', roots: [], quick: [], sel: new Map(), limit: Infinity,
};

function fsKindIcon(kind) { return kind === 'video' ? '🎞' : kind === 'audio' ? '🎵' : '🖼'; }

function fsRenderKinds() {
  const bar = $('fsKinds');
  bar.hidden = !!fsPk.lockKinds;
  bar.querySelectorAll('button').forEach((b) => b.classList.toggle('on', fsPk.kinds.includes(b.dataset.k)));
}
document.querySelectorAll('#fsKinds button').forEach((b) => {
  b.onclick = () => {
    const k = b.dataset.k;
    if (fsPk.kinds.includes(k)) {
      if (fsPk.kinds.length === 1) return; // 至少保留一类
      fsPk.kinds = fsPk.kinds.filter((x) => x !== k);
    } else {
      fsPk.kinds = fsPk.kinds.concat(k);
    }
    fsRenderKinds();
    if (fsPk.dir) fsLoadDir(fsPk.dir);
  };
});

async function openMediaPicker(opts) {
  fsPk.kinds = opts.kinds || ['image'];
  fsPk.lockKinds = !!opts.lockKinds;
  fsPk.multi = opts.multi !== false;
  fsPk.limit = opts.limit || Infinity;
  fsPk.onDone = opts.onDone;
  fsPk.nativeInput = opts.nativeInput || null;
  fsPk.sel.clear();
  fsRenderKinds();
  $('fsTitle').textContent = opts.title || '📁 选择媒体';
  $('fsHint').textContent = fsPk.multi
    ? `可多选${Number.isFinite(fsPk.limit) ? `（还可选 ${fsPk.limit} 个）` : ''} · 单击选中 · 双击直接添加`
    : '单击选中 · 双击直接添加';
  $('fsNative').hidden = !fsPk.nativeInput && !window.a452Native;
  $('fsPicker').hidden = false;
  fsUpdateFoot();
  if (!fsPk.roots.length) {
    try {
      const r = await fetch('/api/fs/roots').then((x) => x.json());
      fsPk.roots = r.roots || []; fsPk.quick = r.quick || [];
    } catch {}
  }
  fsRenderSide();
  const kindKey = fsPk.kinds.join(',');
  const last = localStorage.getItem('a452FsDir:' + kindKey) || localStorage.getItem('a452FsDir:*')
    || ((fsPk.quick.find((q) => q.name.includes('桌面')) || fsPk.quick[0] || fsPk.roots[0] || {}).path);
  if (last) fsLoadDir(last);
  else $('fsGrid').innerHTML = '<div class="fs-empty">左侧选择一个位置开始浏览</div>';
}

function closeMediaPicker() { $('fsPicker').hidden = true; fsPk.sel.clear(); }

function fsRenderSide() {
  const side = $('fsSide');
  side.innerHTML = '';
  const addLoc = (loc) => {
    const b = document.createElement('button');
    b.className = 'fs-loc' + (fsPk.dir === loc.path ? ' active' : '');
    b.textContent = loc.name;
    b.title = loc.path;
    b.onclick = () => fsLoadDir(loc.path);
    side.appendChild(b);
  };
  const sep = (t) => {
    const s = document.createElement('div');
    s.className = 'fs-sep'; s.textContent = t;
    side.appendChild(s);
  };
  sep('快捷位置');
  fsPk.quick.forEach(addLoc);
  sep('磁盘');
  fsPk.roots.forEach(addLoc);
}

async function fsLoadDir(dir) {
  const grid = $('fsGrid');
  grid.innerHTML = '<div class="fs-empty">读取中…</div>';
  let data;
  try {
    const res = await fetch('/api/fs/list?dir=' + encodeURIComponent(dir));
    data = await res.json();
    if (!res.ok) throw new Error(data.error || '读取失败');
  } catch (e) {
    grid.innerHTML = `<div class="fs-empty">⚠ ${escapeHtml(errMsg(e))}</div>`;
    return;
  }
  fsPk.dir = data.dir;
  const kindKey = fsPk.kinds.join(',');
  localStorage.setItem('a452FsDir:' + kindKey, data.dir);
  localStorage.setItem('a452FsDir:*', data.dir);
  fsRenderSide();

  // 面包屑
  const crumbs = $('fsCrumbs');
  crumbs.innerHTML = '';
  const parts = data.dir.split(/[\\/]+/).filter(Boolean);
  let acc = '';
  parts.forEach((p, i) => {
    acc = i === 0 ? p + '\\' : acc + (acc.endsWith('\\') ? '' : '\\') + p;
    const target = acc;
    const b = document.createElement('button');
    b.textContent = p;
    b.onclick = () => fsLoadDir(target);
    crumbs.appendChild(b);
    if (i < parts.length - 1) {
      const s = document.createElement('span');
      s.className = 'sep';
      s.textContent = ' › ';
      crumbs.appendChild(s);
    }
  });

  grid.innerHTML = '';
  if (data.parent) {
    const up = document.createElement('div');
    up.className = 'fs-cell fs-dir';
    up.innerHTML = '<div class="fs-fallback">↩</div><div class="fs-name">上一级</div>';
    up.onclick = () => fsLoadDir(data.parent);
    grid.appendChild(up);
  }
  for (const d of data.dirs) {
    const cell = document.createElement('div');
    cell.className = 'fs-cell fs-dir';
    cell.title = d.name;
    const fb = document.createElement('div');
    fb.className = 'fs-fallback';
    fb.textContent = '📁';
    const nm = document.createElement('div');
    nm.className = 'fs-name';
    nm.textContent = d.name;
    cell.appendChild(fb); cell.appendChild(nm);
    cell.onclick = () => fsLoadDir(d.path);
    grid.appendChild(cell);
  }
  const files = (data.files || []).filter((f) => fsPk.kinds.includes(f.kind));
  for (const f of files) {
    const cell = document.createElement('div');
    cell.className = 'fs-cell';
    cell.title = f.name;
    if (f.kind === 'video') cell.dataset.vpath = f.path; // 悬停流式小回放
    if (f.kind === 'audio') {
      const fb = document.createElement('div');
      fb.className = 'fs-fallback';
      fb.textContent = '🎵';
      cell.appendChild(fb);
    } else {
      cell.classList.add('fs-loading'); // 占位闪烁：缩略图到达前绝不白屏
      const img = document.createElement('img');
      img.className = 'fs-thumb';
      img.loading = 'lazy';
      img.src = '/api/fs/thumb?path=' + encodeURIComponent(f.path) + '&mt=' + f.mtime;
      img.onload = () => cell.classList.remove('fs-loading');
      img.onerror = () => {
        cell.classList.remove('fs-loading');
        const fb = document.createElement('div');
        fb.className = 'fs-fallback';
        fb.textContent = fsKindIcon(f.kind);
        img.replaceWith(fb);
      };
      cell.appendChild(img);
    }
    const badge = document.createElement('span');
    badge.className = 'fs-badge';
    badge.textContent = fsKindIcon(f.kind);
    const check = document.createElement('span');
    check.className = 'fs-check';
    check.textContent = '✓';
    const nm = document.createElement('div');
    nm.className = 'fs-name';
    nm.textContent = f.name;
    cell.appendChild(badge); cell.appendChild(check); cell.appendChild(nm);
    cell.onclick = () => {
      if (fsPk.sel.has(f.path)) { fsPk.sel.delete(f.path); cell.classList.remove('sel'); }
      else {
        if (!fsPk.multi) {
          fsPk.sel.clear();
          grid.querySelectorAll('.fs-cell.sel').forEach((c) => c.classList.remove('sel'));
        }
        if (fsPk.sel.size >= fsPk.limit) { fsUpdateFoot(`最多只能选 ${fsPk.limit} 个`); return; }
        fsPk.sel.set(f.path, f); cell.classList.add('sel');
      }
      fsUpdateFoot();
    };
    cell.ondblclick = () => {
      if (!fsPk.sel.has(f.path)) {
        if (!fsPk.multi) fsPk.sel.clear();
        if (fsPk.sel.size < fsPk.limit) fsPk.sel.set(f.path, f);
      }
      fsConfirm();
    };
    grid.appendChild(cell);
  }
  if (!files.length) {
    const empty = document.createElement('div');
    empty.className = 'fs-empty';
    empty.textContent = '此目录没有' + fsPk.kinds.map((k) => ({ image: '图片', video: '视频', audio: '音频' }[k])).join('/');
    grid.appendChild(empty);
  }
  if (data.truncated) fsUpdateFoot('目录文件过多，只显示最新 800 个');
}

function fsUpdateFoot(msg) {
  $('fsSelCount').textContent = msg || (fsPk.sel.size ? `已选 ${fsPk.sel.size} 个` : '未选择');
  $('fsConfirm').disabled = !fsPk.sel.size;
}

async function fsConfirm() {
  if (!fsPk.sel.size) return;
  const picked = Array.from(fsPk.sel.values());
  $('fsConfirm').disabled = true;
  $('fsSelCount').textContent = '导入中…';
  try {
    const res = await fetch('/api/fs/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: picked.map((f) => f.path) }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || ('导入失败 ' + res.status));
    closeMediaPicker();
    if (fsPk.onDone) fsPk.onDone(json.items || []);
  } catch (e) {
    fsUpdateFoot('⚠ ' + errMsg(e).slice(0, 80));
    $('fsConfirm').disabled = false;
  }
}

$('fsClose').onclick = closeMediaPicker;
$('fsConfirm').onclick = fsConfirm;
$('fsNative').onclick = () => {
  const input = fsPk.nativeInput;
  closeMediaPicker();
  if (input) input.click();
};
$('fsPicker').addEventListener('click', (e) => { if (e.target === $('fsPicker')) closeMediaPicker(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('fsPicker').hidden) closeMediaPicker();
});

// ---- 接入各上传入口 ----
// REFERENCES TOOL：参考素材（当前分区的类型 + 剩余额度）
$('dirRefAdd').onclick = () => {
  const caps = dirRefCaps();
  const rooms = {
    image: caps.image - dirRefsOf('image').length,
    video: caps.video - dirRefsOf('video').length,
    audio: caps.audio - dirRefsOf('audio').length,
  };
  const totalRoom = Math.max(0, rooms.image) + Math.max(0, rooms.video) + Math.max(0, rooms.audio);
  if (totalRoom <= 0) { setDirStatus('参考位已全部用满'); return; }
  openMediaPicker({
    kinds: ['image', 'video', 'audio'], // 三类全开，顶部筛选钮可自由切换
    limit: totalRoom, nativeInput: $('dirRefFiles'),
    title: '📁 添加参考素材',
    onDone: (items) => {
      let added = 0, skipped = 0;
      for (const it of items) {
        const kind = it.kind || 'image';
        if (rooms[kind] <= 0) { skipped += 1; continue; }
        rooms[kind] -= 1;
        state.director.refs.push({
          id: nextRefId++, name: it.name, url: it.url,
          kind, role: DIR_KIND_META[kind].defaultRole, note: '',
        });
        added += 1;
      }
      renderDirRefs();
      scheduleSave();
      setDirStatus(added ? `已添加 ${added} 份参考${skipped ? `（${skipped} 份因该类型已满被跳过）` : ''}` : (skipped ? '对应类型的参考位已满' : ''));
    },
  });
};
$('dirRefAddNative').onclick = () => $('dirRefFiles').click();


// 中割关键帧
$('btnKfBrowse').onclick = () => openMediaPicker({
  kinds: ['image'], lockKinds: true, title: '📁 添加关键帧',
  onDone: (items) => {
    for (const it of items) state.images.push({ id: nextImgId++, name: it.name, url: it.url, hold: 2 });
    rebuildSegments();
    renderAll();
    scheduleSave();
  },
});

// ---- 从资源管理器拖拽文件 → REFERENCES TOOL（按 MIME 自动分类图/视频/音频） ----
(() => {
  const panel = $('dirRefList') && $('dirRefList').closest('section');
  if (!panel) return;
  panel.addEventListener('dragover', (e) => {
    if (Array.from(e.dataTransfer.types || []).includes('Files')) {
      e.preventDefault();
      panel.classList.add('file-drop-hot');
    }
  });
  panel.addEventListener('dragleave', () => panel.classList.remove('file-drop-hot'));
  panel.addEventListener('drop', async (e) => {
    if (!e.dataTransfer.files || !e.dataTransfer.files.length) return;
    e.preventDefault();
    panel.classList.remove('file-drop-hot');
    const caps = dirRefCaps();
    let added = 0, full = 0;
    for (const f of Array.from(e.dataTransfer.files)) {
      const kind = f.type.startsWith('image/') ? 'image' : f.type.startsWith('video/') ? 'video'
        : f.type.startsWith('audio/') ? 'audio' : null;
      if (!kind) continue;
      if (dirRefsOf(kind).length >= caps[kind]) { full += 1; continue; }
      try {
        setDirStatus(`${DIR_KIND_META[kind].name}上传中… ${f.name}`);
        const url = await uploadAsset(f);
        state.director.refs.push({
          id: nextRefId++, name: f.name, url,
          kind, role: DIR_KIND_META[kind].defaultRole, note: '',
        });
        added += 1;
      } catch (err) { setDirStatus(`${DIR_KIND_META[kind].name}上传失败: ` + errMsg(err)); }
    }
    renderDirRefs();
    scheduleSave();
    if (added) setDirStatus(`已添加 ${added} 份参考${full ? `（${full} 份因额度已满被跳过）` : ''}`);
    else if (full) setDirStatus('对应类型的参考位已满');
  });
})();


// ---------------- Ctrl+V 粘贴截图 → 参考图（REFERENCES TOOL 激活时） ----------------
document.addEventListener('paste', async (e) => {
  if ($('viewDirector').hidden) return; // 只在工作区 6 生效
  if (!$('fsPicker').hidden) return;
  const files = Array.from((e.clipboardData && e.clipboardData.files) || [])
    .filter((f) => f.type.startsWith('image/'));
  if (!files.length) {
    // 有些来源只放了位图没带文件对象 → 走 Electron 原生剪贴板兜底；纯文本粘贴不受影响
    const hasText = e.clipboardData && e.clipboardData.getData && e.clipboardData.getData('text');
    if (!hasText && window.a452Native && window.a452Native.readClipboardImage) {
      e.preventDefault();
      pasteClipboardAsRef();
    }
    return;
  }
  e.preventDefault();
  const caps = dirRefCaps();
  let added = 0;
  for (const f of files) {
    if (dirRefsOf('image').length >= caps.image) { setDirStatus(`参考图已满（${caps.image}）`); break; }
    try {
      setDirStatus('粘贴图上传中…');
      const url = await uploadAsset(f);
      const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false }).replace(/:/g, '');
      const name = f.name && !/^image\.\w+$/i.test(f.name) ? f.name : `粘贴截图_${stamp}.png`;
      state.director.refs.push({
        id: nextRefId++, name, url,
        kind: 'image', role: DIR_KIND_META.image.defaultRole, note: '',
      });
      added += 1;
    } catch (err) { setDirStatus('粘贴上传失败: ' + errMsg(err)); return; }
  }
  if (added) {
    dirRefKind = 'image';
    renderDirRefs();
    scheduleSave();
    setDirStatus(`已粘贴 ${added} 张参考图 ✓`);
  }
});

// ---------------- 生成结果：暂停帧一键存为参考图 ----------------
$('btnDirGrabFrame').onclick = async () => {
  const v = $('dirResult');
  if (v.hidden || !v.videoWidth) { setDirStatus('还没有可截取的画面'); return; }
  const caps = dirRefCaps();
  if (dirRefsOf('image').length >= caps.image) { setDirStatus(`参考图已满（${caps.image}）`); return; }
  try {
    const canvas = document.createElement('canvas');
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    canvas.getContext('2d').drawImage(v, 0, 0);
    const blob = await new Promise((resolve, reject) => {
      try { canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('截帧失败'))), 'image/png'); }
      catch (err) { reject(err); }
    });
    const t = v.currentTime.toFixed(2);
    const name = `帧截取_${t}s.png`;
    const url = await uploadAsset(new File([blob], name, { type: 'image/png' }));
    state.director.refs.push({
      id: nextRefId++, name, url,
      kind: 'image', role: 'character', note: `取自生成结果 ${t}s 处的画面，保持该画面的角色与风格`,
    });
    dirRefKind = 'image';
    renderDirRefs();
    scheduleSave();
    setDirStatus(`已把 ${t}s 的画面存为参考图 ✓`);
  } catch (err) {
    setDirStatus('截帧失败: ' + errMsg(err));
  }
};

// ---------------- @引用系统：提示词直接引用参考素材 ----------------
// @image1 / @img1 / @图1 → 第 1 张参考图；@video1/@视频1、@audio1/@音频1 同理。
// 输入 @ 弹出参考列表下拉；粘贴进来的 @token 一样实时解析；
// 生成时统一替换为「参考图N」——与后台"参考素材使用说明"指令块的编号完全一致。
const MENTION_ALIAS = {
  image: 'image', img: 'image', 图: 'image', 圖: 'image',
  video: 'video', vid: 'video', 视频: 'video',
  audio: 'audio', aud: 'audio', 音频: 'audio',
};
const MENTION_RE = /@(image|img|图|圖|video|vid|视频|audio|aud|音频)(\d+)/gi;
const MENTION_KIND_ZH = { image: '参考图', video: '参考视频', audio: '参考音频' };

/** 当前全部参考 → mention 候选（token 按各类型内的顺序编号） */
function dirMentionTokens() {
  const counters = { image: 0, video: 0, audio: 0 };
  return state.director.refs.map((r) => {
    const kind = r.kind || 'image';
    counters[kind] += 1;
    return {
      token: kind + counters[kind],           // image1 / video2 / audio1
      zhLabel: MENTION_KIND_ZH[kind] + counters[kind],
      kind, n: counters[kind], name: r.name || '', url: r.url,
      role: DIR_REF_ROLES[r.role || DIR_KIND_META[kind].defaultRole],
    };
  });
}

/** 文本中的 @token → 「参考图N」；返回 {text, unknown[]} */
function resolveMentions(text) {
  const counters = { image: 0, video: 0, audio: 0 };
  for (const r of state.director.refs) counters[(r.kind || 'image')] += 1;
  const unknown = [];
  const out = String(text || '').replace(MENTION_RE, (m, alias, num) => {
    const kind = MENTION_ALIAS[alias.toLowerCase()] || MENTION_ALIAS[alias];
    const n = Number(num);
    if (!kind || n < 1 || n > counters[kind]) { unknown.push(m); return m; }
    return '「' + MENTION_KIND_ZH[kind] + n + '」';
  });
  return { text: out, unknown };
}

// ---- 实时解析预览（chip 条：绿=已解析到素材，红=找不到） ----
/** 所有含 @引用 的输入框（CONTEXT + 每个 CUT 正文与 60/30/10 三框 + 负面），按页面顺序 */
function dirMentionSources() {
  const list = [{ ta: $('dirPrompt'), label: 'CONTEXT' }];
  document.querySelectorAll('#dirCuts .cut-box').forEach((box, i) => {
    const ta = box.querySelector('textarea');
    if (ta) list.push({ ta, label: `CUT ${i + 1}` });
    box.querySelectorAll('.cut-comp input').forEach((inp, k) => {
      list.push({ ta: inp, label: `CUT ${i + 1} · ${['%60', '%30', '%10'][k] || '构图'}` });
    });
  });
  if ($('dirNegative')) list.push({ ta: $('dirNegative'), label: '负面' });
  return list.filter((s) => s.ta);
}

function renderMentionPreview() {
  const box = $('dirMentionPreview');
  if (!box) return;
  const tokens = dirMentionTokens();
  const byToken = new Map(tokens.map((t) => [t.token, t]));
  const seen = new Set();
  const chips = [];
  const scanText = (text) => {
    let m;
    MENTION_RE.lastIndex = 0;
    while ((m = MENTION_RE.exec(String(text || '')))) {
      const kind = MENTION_ALIAS[m[1].toLowerCase()] || MENTION_ALIAS[m[1]];
      const key = kind ? kind + Number(m[2]) : m[0];
      if (seen.has(key)) continue;
      seen.add(key);
      chips.push({ raw: m[0], key, hit: byToken.get(key) || null });
    }
  };
  for (const src of dirMentionSources()) scanText(src.ta.value);
  // 参考素材的说明词也在扫描范围（从 state 扫——未显示的分区同样覆盖）
  for (const ref of state.director.refs) scanText(ref.note);
  box.innerHTML = '';
  box.hidden = !chips.length;
  for (const c of chips) {
    const chip = document.createElement('span');
    chip.className = 'mention-chip' + (c.hit ? '' : ' bad');
    if (c.hit) { chip.dataset.pvKind = c.hit.kind; chip.dataset.pvUrl = c.hit.url; } // 悬停大预览
    if (c.hit && c.hit.kind === 'image') {
      const img = document.createElement('img');
      img.src = c.hit.url;
      chip.appendChild(img);
    } else {
      const ic = document.createElement('span');
      ic.className = 'mc-icon';
      ic.textContent = c.hit ? DIR_KIND_META[c.hit.kind].icon : '⚠';
      chip.appendChild(ic);
    }
    const label = document.createElement('span');
    label.textContent = c.hit
      ? `@${c.hit.token} → ${c.hit.zhLabel}${c.hit.name ? ' · ' + c.hit.name.slice(0, 14) : ''}`
      : `${c.raw} 找不到对应参考 · 点我定位`;
    chip.appendChild(label);
    if (c.hit) {
      chip.title = `${c.hit.zhLabel}（${c.hit.role ? c.hit.role[0] : ''}）${c.hit.name} — 点击跳到出现这个引用的位置；连续点循环跳遍每一处`;
      chip.classList.add('clickable');
    } else {
      chip.title = '点击跳到出现这个引用的位置并高亮选中；再点跳到下一处，直到全部修完';
    }
    chip.onclick = () => jumpToMentionProblem(c.key); // 好引用同样可点：循环跳转所有出现位置
    box.appendChild(chip);
  }
  refreshRefUsageChips(); // 参考行上的「被引用 N 处」指示器随每次输入实时刷新
  if (typeof mbRefreshAll === 'function') mbRefreshAll(); // @气泡有效性同步（参考增删/换档/改名）
}

/** 每条参考行上的被引用指示器：@image1 · N处 / 未引用 —— 点击循环跳到每一处 */
function refreshRefUsageChips() {
  document.querySelectorAll('#dirRefList .dir-ref-usage').forEach((btn) => {
    const token = btn.dataset.token;
    const n = collectMentionOccurrences(token).length;
    btn.textContent = n ? `@${token} · ${n}处` : `@${token}`;
    btn.classList.toggle('used', n > 0);
    btn.title = n
      ? `这份参考被 ${n} 处提示词引用 — 点击跳到出现位置，连续点循环跳遍每一处`
      : '还没有提示词引用这份参考 — 在任意提示词框输入 @ 即可引用';
  });
}

// 问题引用定位器：点 chip / 生成被拦 → 跳到下一处出现位置并高亮选中
// 覆盖全部可去位置：CONTEXT / 每个 CUT 正文 / 60/30/10 三框 / 负面 / 每份参考的说明词
//（说明词在未显示的分区时自动切 tab 再定位）
const mentionJump = { key: null, idx: -1 };
function flashAndSelect(el, start, end) {
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.focus();
  try { el.setSelectionRange(start, end); } catch {}
  el.classList.add('mention-flash');
  setTimeout(() => el.classList.remove('mention-flash'), 1000);
}
/** 收集某个引用键（如 image1）在全部可去位置的出现列表（好引用与坏引用通吃）：
 *  CONTEXT / 每个 CUT 正文 / 60/30/10 三框 / 负面 / 每份参考的说明词 */
function collectMentionOccurrences(key) {
  const normKey = (m) => {
    const kind = MENTION_ALIAS[m[1].toLowerCase()] || MENTION_ALIAS[m[1]];
    return kind ? kind + Number(m[2]) : m[0];
  };
  const occ = [];
  for (const src of dirMentionSources()) {
    let m;
    MENTION_RE.lastIndex = 0;
    while ((m = MENTION_RE.exec(src.ta.value))) {
      if (normKey(m) !== key) continue;
      const el = src.ta;
      const start = m.index;
      const end = m.index + m[0].length;
      occ.push({ label: src.label, raw: m[0], jump: () => flashAndSelect(el, start, end) });
    }
  }
  // 参考说明词：从 state 扫（哪怕那个分区当前没显示）
  for (const ref of state.director.refs) {
    const rKind = ref.kind || 'image';
    let m;
    MENTION_RE.lastIndex = 0;
    while ((m = MENTION_RE.exec(String(ref.note || '')))) {
      if (normKey(m) !== key) continue;
      const start = m.index;
      const end = m.index + m[0].length;
      const pos = dirRefsOf(rKind).findIndex((x) => x.id === ref.id) + 1;
      occ.push({
        label: `参考素材 · ${DIR_KIND_META[rKind].icon} ${DIR_KIND_META[rKind].name}${pos} 的说明词`,
        raw: m[0],
        jump: () => {
          if (dirRefKind !== rKind) { dirRefKind = rKind; renderDirRefs(); } // 自动切到对应分区
          const row = document.querySelector(`#dirRefList .dir-ref-row[data-ref-id="${ref.id}"]`);
          const ta = row && row.querySelector('.dir-ref-note');
          if (ta) flashAndSelect(ta, start, end);
        },
      });
    }
  }
  return occ;
}
function jumpToMentionProblem(key) {
  const occ = collectMentionOccurrences(key);
  if (!occ.length) { renderMentionPreview(); return; } // 已全部修完 → chips 自刷新
  if (mentionJump.key !== key) { mentionJump.key = key; mentionJump.idx = 0; }
  else mentionJump.idx = (mentionJump.idx + 1) % occ.length;
  const o = occ[mentionJump.idx];
  o.jump();
  setDirStatus(`已定位 ${o.raw} — ${o.label}，第 ${mentionJump.idx + 1}/${occ.length} 处，改完再点跳下一处`);
}

// ---- @ 自动补全下拉 ----
const mentionAc = { ta: null, items: [], active: 0, start: -1 };

function mentionMenuHide() {
  $('mentionMenu').hidden = true;
  mentionAc.ta = null;
  mentionAc.items = [];
  if (typeof pvKill === 'function') pvKill(); // 补全菜单收起时同时收掉悬停大预览
}

function mentionMenuShow(ta) {
  const caret = ta.selectionStart;
  const before = ta.value.slice(0, caret);
  const m = /@([A-Za-z0-9一-龥_.-]*)$/.exec(before);
  if (!m) { mentionMenuHide(); return; }
  const q = m[1].toLowerCase();
  const items = dirMentionTokens().filter((t) =>
    !q || t.token.startsWith(q) || t.zhLabel.includes(q) || (t.name || '').toLowerCase().includes(q));
  const menu = $('mentionMenu');
  menu.innerHTML = '';
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'm-empty';
    empty.textContent = state.director.refs.length ? '没有匹配的参考' : '参考区还没有素材 — 先在左侧添加';
    menu.appendChild(empty);
  }
  items.forEach((t, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'm-item' + (i === mentionAc.active ? ' active' : '');
    btn.dataset.pvKind = t.kind; // 悬停大预览
    btn.dataset.pvUrl = t.url;
    if (t.kind === 'image') {
      const img = document.createElement('img');
      img.className = 'm-thumb';
      img.src = t.url;
      btn.appendChild(img);
    } else {
      const ic = document.createElement('span');
      ic.className = 'm-icon';
      ic.textContent = DIR_KIND_META[t.kind].icon;
      btn.appendChild(ic);
    }
    const tok = document.createElement('span');
    tok.className = 'm-token';
    tok.textContent = '@' + t.token;
    const name = document.createElement('span');
    name.className = 'm-name';
    name.textContent = (t.role ? t.role[0] + ' · ' : '') + (t.name || t.zhLabel);
    btn.appendChild(tok);
    btn.appendChild(name);
    btn.onmousedown = (e) => { e.preventDefault(); mentionPick(t); };
    menu.appendChild(btn);
  });
  mentionAc.ta = ta;
  mentionAc.items = items;
  mentionAc.start = caret - m[1].length - 1;
  const r = ta.getBoundingClientRect();
  menu.style.left = Math.min(r.left, window.innerWidth - 380) + 'px';
  menu.style.top = Math.min(r.bottom + 4, window.innerHeight - 270) + 'px';
  menu.hidden = false;
}

function mentionPick(t) {
  const ta = mentionAc.ta;
  if (!ta) return;
  const caret = ta.selectionStart;
  ta.value = ta.value.slice(0, mentionAc.start) + '@' + t.token + ' ' + ta.value.slice(caret);
  const pos = mentionAc.start + t.token.length + 2;
  ta.setSelectionRange(pos, pos);
  mentionMenuHide();
  ta.focus();
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

/** 给一个 textarea 挂上 @ 自动补全（提示词框 + 每条参考的说明框通用） */
function attachMentionAutocomplete(ta) {
  if (!ta || ta.dataset.mentionAc) return;
  ta.dataset.mentionAc = '1';
  // 同一批输入框自动获得 @气泡浮层（链接成功的引用可视化 + 可拖动换位）
  if (typeof attachMentionBubbles === 'function') { try { attachMentionBubbles(ta); } catch {} }
  ta.addEventListener('input', () => {
    mentionAc.active = 0;
    mentionMenuShow(ta);
  });
  ta.addEventListener('keydown', (e) => {
    if ($('mentionMenu').hidden || mentionAc.ta !== ta) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = mentionAc.items.length;
      if (!n) return;
      mentionAc.active = (mentionAc.active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      mentionMenuShow(ta);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      if (mentionAc.items.length) { e.preventDefault(); mentionPick(mentionAc.items[mentionAc.active]); }
    } else if (e.key === 'Escape') {
      mentionMenuHide();
    }
  });
  ta.addEventListener('blur', () => setTimeout(() => { if (mentionAc.ta === ta) mentionMenuHide(); }, 150));
}

attachMentionAutocomplete($('dirPrompt'));
$('dirPrompt').addEventListener('input', renderMentionPreview);
// 负面清单同样在 @引用扫描范围（dirMentionSources）→ 一并给自动补全 + 气泡
if ($('dirNegative')) {
  attachMentionAutocomplete($('dirNegative'));
  $('dirNegative').addEventListener('input', renderMentionPreview);
}

// ---------------- Electron 原生对话框通道 ----------------
// 桌面版（window.a452Native 存在）走主进程 dialog.showOpenDialog——有真缩略图；
// 纯浏览器环境自动回退到 <input type=file>。选中的路径走 /api/fs/import 服务器直拷。
async function nativePickAndImport(kind, multi, fallbackInput, onItems) {
  if (!window.a452Native) {
    if (fallbackInput) fallbackInput.click();
    return;
  }
  try {
    const paths = await window.a452Native.pickFiles({ kind, multi });
    if (!paths || !paths.length) return;
    const res = await fetch('/api/fs/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || ('导入失败 ' + res.status));
    onItems(json.items || []);
  } catch (e) {
    setDirStatus('导入失败: ' + errMsg(e));
    if (fallbackInput) fallbackInput.click();
  }
}

// 参考区「📂 系统对话框」按钮：桌面版直接用原生对话框（带缩略图）
$('dirRefAddNative').onclick = () => {
  const caps = dirRefCaps();
  const room = caps[dirRefKind] - dirRefsOf(dirRefKind).length;
  if (room <= 0) { setDirStatus(`${DIR_KIND_META[dirRefKind].name}已满（${caps[dirRefKind]}）`); return; }
  nativePickAndImport(dirRefKind, true, $('dirRefFiles'), (items) => {
    for (const it of items.slice(0, room)) {
      state.director.refs.push({
        id: nextRefId++, name: it.name, url: it.url,
        kind: dirRefKind, role: DIR_KIND_META[dirRefKind].defaultRole, note: '',
      });
    }
    renderDirRefs();
    scheduleSave();
    setDirStatus(items.length ? `已添加 ${Math.min(items.length, room)} 份${DIR_KIND_META[dirRefKind].name}` : '');
  });
};

// 应用内选择器右下角「系统对话框」按钮：桌面版同样换成原生对话框
$('fsNative').onclick = () => {
  const kinds = fsPk.kinds.slice();
  const multi = fsPk.multi;
  const onDone = fsPk.onDone;
  const input = fsPk.nativeInput;
  closeMediaPicker();
  if (window.a452Native) {
    nativePickAndImport(kinds.length === 1 ? kinds[0] : 'media', multi, input, (items) => {
      if (onDone) onDone(items);
    });
  } else if (input) {
    input.click();
  }
};

// ---------------- 桌面版全局兜底：所有 <input type=file> 一律走主进程原生对话框 ----------------
// 渲染进程弹的文件对话框（Chromium 沙箱工具进程）在 Windows 上不渲染缩略图；
// 主进程 dialog.showOpenDialog 正常。这里在捕获阶段拦下每一个 file input 的点击，
// 换成原生对话框选路径 → /api/fs/file 取回 blob → 塞回同一个 input 并派发 change，
// 所有既有上传逻辑零改动照常工作。纯浏览器环境（无 a452Native）完全不受影响。
function kindOfAccept(accept) {
  const a = String(accept || '');
  if (a.includes('video')) return 'video';
  if (a.includes('audio')) return 'audio';
  if (a.includes('image')) return 'image';
  return null; // 非媒体类 input（如 .txt/.json）不接管
}

async function nativePickIntoInput(input) {
  const kind = kindOfAccept(input.accept);
  const paths = await window.a452Native.pickFiles({ kind: kind || 'media', multi: input.multiple });
  if (!paths || !paths.length) return;
  const dt = new DataTransfer();
  for (const p of paths) {
    try {
      const r = await fetch('/api/fs/file?path=' + encodeURIComponent(p));
      if (!r.ok) continue;
      const blob = await r.blob();
      const name = p.split(/[\\/]/).pop() || 'file';
      dt.items.add(new File([blob], name, { type: blob.type || '' }));
    } catch {}
  }
  if (!dt.files.length) return;
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

document.addEventListener('click', (e) => {
  if (!window.a452Native) return;
  const input = e.target instanceof HTMLInputElement && e.target.type === 'file' ? e.target : null;
  if (!input || !kindOfAccept(input.accept)) return; // 只接管媒体类
  e.preventDefault();
  e.stopImmediatePropagation();
  nativePickIntoInput(input);
}, true);

// ---------------- 剪贴板图片 → 参考图：三层通道，哪层焦点都能粘 ----------------
// ① 工作台内 Ctrl+V（既有 paste 监听）② 外层壳 Ctrl+V → postMessage 转发进来
// ③ 📋 按钮 / paste 无文件时 → Electron 主进程原生剪贴板（与焦点完全无关）
async function addClipboardRefBlob(blob, name) {
  const caps = dirRefCaps();
  if (dirRefsOf('image').length >= caps.image) { setDirStatus(`参考图已满（${caps.image}）`); return false; }
  const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false }).replace(/:/g, '');
  const finalName = name && !/^(image|clipboard)\.\w+$/i.test(name) ? name : `粘贴截图_${stamp}.png`;
  setDirStatus('粘贴图上传中…');
  const url = await uploadAsset(new File([blob], finalName, { type: blob.type || 'image/png' }));
  state.director.refs.push({
    id: nextRefId++, name: finalName, url,
    kind: 'image', role: DIR_KIND_META.image.defaultRole, note: '',
  });
  dirRefKind = 'image';
  renderDirRefs();
  scheduleSave();
  setDirStatus('已粘贴为参考图 ✓');
  return true;
}

/** 原生剪贴板读取（Electron 主进程，无焦点/权限问题）；纯浏览器退回异步剪贴板 API */
async function pasteClipboardAsRef() {
  try {
    if (window.a452Native && window.a452Native.readClipboardImage) {
      const b64 = await window.a452Native.readClipboardImage();
      if (b64) {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        await addClipboardRefBlob(new Blob([bytes], { type: 'image/png' }), '');
        return true;
      }
      setDirStatus('剪贴板里没有图片 — 先截图或复制一张图');
      return false;
    }
    if (navigator.clipboard && navigator.clipboard.read) {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const type = item.types.find((t) => t.startsWith('image/'));
        if (type) {
          await addClipboardRefBlob(await item.getType(type), '');
          return true;
        }
      }
      setDirStatus('剪贴板里没有图片 — 先截图或复制一张图');
      return false;
    }
    setDirStatus('此环境无法读取剪贴板，请直接 Ctrl+V');
    return false;
  } catch (e) {
    setDirStatus('读取剪贴板失败: ' + errMsg(e));
    return false;
  }
}
$('dirRefPaste').onclick = pasteClipboardAsRef;

// 外层壳（策划端）转发来的剪贴板图片
window.addEventListener('message', async (e) => {
  if (!isTrustedMessageOrigin(e.origin)) return;
  const d = e.data;
  if (!d || d.type !== 'a452-clipboard-image' || !d.buf) return;
  try {
    await addClipboardRefBlob(new Blob([d.buf], { type: d.mime || 'image/png' }), d.name || '');
  } catch (err) { setDirStatus('粘贴上传失败: ' + errMsg(err)); }
});

// ---------------- 常青提示词：全局质量/风格锚（注入所有工作区每一次生成） ----------------
async function egRefreshBadge() {
  try {
    const cfg = await (await fetch('/api/config')).json();
    const text = String(cfg.evergreen || '').trim();
    const active = !!text;
    $('btnEvergreen').textContent = active ? '🌲●' : '🌲';
    $('btnEvergreen').classList.toggle('primary', active);
    const bar = $('egBar');
    if (bar) {
      bar.classList.toggle('active', active);
      $('egBarText').textContent = active
        ? `常青锚点生效中：${text.slice(0, 90)}${text.length > 90 ? '…' : ''}`
        : '常青锚点：未设置 — 点这里写全片恒定的画质与风格锚（每一次生成都会自动带上）';
    }
    // 右栏面板改为「场景私有常青」编辑器，由 egPanelApply 负责 —— 这里只在场景沿用全局时刷新显示
    if (typeof egPanelApply === 'function' && state.director && state.director.evergreen === undefined) egPanelApply(cfg.evergreen || '');
    return cfg.evergreen || '';
  } catch { return ''; }
}
$('egBar').onclick = () => $('btnEvergreen').click();
$('btnEvergreen').onclick = async () => {
  $('egStatus').textContent = '';
  $('egText').value = await egRefreshBadge();
  $('egDialog').showModal();
};
$('egSave').onclick = async () => {
  try {
    const res = await fetch('/api/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ evergreen: $('egText').value }),
    });
    if (!res.ok) throw new Error('保存失败 ' + res.status);
    $('egStatus').textContent = '已保存 ✓ 之后的每一次生成都会带上这段锚点';
    egRefreshBadge();
  } catch (e) { $('egStatus').textContent = '保存失败: ' + errMsg(e); }
};
$('egClear').onclick = () => { $('egText').value = ''; };
$('egClose').onclick = () => $('egDialog').close();

// 工作区 6 右栏：场景私有常青编辑器。
// 语义：state.director.evergreen === undefined → 本场景沿用 🌲 全局常青；
//       字符串（含空串）→ 本场景专属（空串 = 本场景不注入任何常青）。
// 其它工作区（中割/转绘/精修）继续走全局常青，不受影响。
function egPanelApply(globalText) {
  const panel = $('egPanelText');
  if (!panel) return;
  const own = state.director ? state.director.evergreen : undefined;
  const scope = $('egPanelScope');
  if (own === undefined) {
    if (document.activeElement !== panel) panel.value = globalText !== undefined ? globalText : panel.value;
    if (scope) scope.textContent = '— 沿用 🌲 全局常青（编辑并保存后转为本场景专属）';
  } else {
    if (document.activeElement !== panel) panel.value = own;
    if (scope) scope.textContent = own.trim()
      ? '— 本场景专属：只注入当前场景的生成'
      : '— 本场景专属：空 = 本场景不注入任何常青';
  }
}
async function egPanelLoad() {
  if (state.director && state.director.evergreen !== undefined) { egPanelApply(); return; }
  await egRefreshBadge(); // 内部会以全局文本刷新面板
}
if ($('egPanelSave')) {
  $('egPanelSave').onclick = () => {
    state.director.evergreen = $('egPanelText').value; // 从此本场景专属
    egPanelApply();
    scheduleSave();
    $('egPanelStatus').textContent = '已保存 ✓ 仅本场景生效';
    setTimeout(() => { $('egPanelStatus').textContent = ''; }, 4000);
  };
}
if ($('egPanelUseGlobal')) {
  $('egPanelUseGlobal').onclick = async () => {
    state.director.evergreen = undefined; // 回到沿用全局
    scheduleSave();
    await egPanelLoad();
    $('egPanelStatus').textContent = '已切回沿用 🌲 全局常青 ✓';
    setTimeout(() => { $('egPanelStatus').textContent = ''; }, 4000);
  };
}
egPanelLoad();

// ---------------- 双档参考记忆 + 生效模型徽标 ----------------
// 2.0 与 2.5 各自记忆一套参考素材（图/视频/音频）：切档自动收起旧档、取出新档，
// 来回切换不丢任何素材；生成按钮下方始终显示这一单实际会用的模型。
function dirEffectiveIs25() {
  const val = $('dirModel').value;
  return /2p5|2-5/.test(val) || (!val && modelIs25());
}

function updateDirGoModel() {
  const el = $('dirGoModel');
  if (!el) return;
  const val = $('dirModel').value;
  let label;
  if (val.startsWith('artcraft:')) {
    const key = val.slice('artcraft:'.length);
    const meta = ARTCRAFT_MODEL_META[key];
    label = (meta ? meta.label.split('·')[0].trim() : key) + ' · Artcraft';
  } else if (val) {
    label = `Seedance ${/2-5/.test(val) ? '2.5' : '2.0'} · 方舟直连`;
  } else {
    label = `Seedance ${modelIs25() ? '2.5' : '2.0'} · ${serverProvider === 'artcraft' ? 'Artcraft' : '方舟'}`;
  }
  el.textContent = '当前模型：' + label;
  el.classList.toggle('is25', dirEffectiveIs25());
  // 下拉首项动态标注，不再写死"Seedance 2.0（当前配置）"误导人
  const opt = $('dirModel').querySelector('option[value=""]');
  if (opt) opt.textContent = `跟随全局档位 — 当前 Seedance ${modelIs25() ? '2.5' : '2.0'}`;
}

// ---- 跨档复制：把参考（连同 role + 说明词）带到另一档的参考集 ----
function dirOtherTier() { return state.director.refTier === '25' ? '20' : '25'; }
function dirTierCaps(tier) {
  return tier === '25' ? { image: 30, video: 10, audio: 10 } : { image: 9, video: 3, audio: 3 };
}
/** 复制单份参考到另一档；返回 'added' | 'updated' | 'full'。verbose=true 时直接反馈状态栏 */
function dirCopyRefToOtherTier(r, verbose) {
  if (!state.director.refsStash || typeof state.director.refsStash !== 'object') {
    state.director.refsStash = { t20: [], t25: [] };
  }
  const target = dirOtherTier();
  const key = 't' + target;
  const list = state.director.refsStash[key] = Array.isArray(state.director.refsStash[key]) ? state.director.refsStash[key] : [];
  const kind = r.kind || 'image';
  const label = `Seedance ${target === '25' ? '2.5' : '2.0'}`;
  const dup = list.find((x) => x.url === r.url);
  if (dup) {
    dup.name = r.name; dup.role = r.role; dup.note = r.note; dup.kind = kind; dup.weight = r.weight; dup.fidelity = r.fidelity;
    scheduleSave();
    if (verbose) setDirStatus(`该素材已在 ${label} 档 — 已同步其 role 与说明词 ✓`);
    return 'updated';
  }
  const caps = dirTierCaps(target);
  if (list.filter((x) => (x.kind || 'image') === kind).length >= caps[kind]) {
    if (verbose) setDirStatus(`${label} 档的${DIR_KIND_META[kind].name}位已满（上限 ${caps[kind]}）`);
    return 'full';
  }
  list.push({ id: nextRefId++, name: r.name, url: r.url, kind, role: r.role, note: r.note, weight: r.weight, fidelity: r.fidelity });
  scheduleSave();
  if (verbose) setDirStatus(`已复制到 ${label} 档 ✓（顶栏切档即可看到）`);
  return 'added';
}
// 一键把当前档全部参考带到另一档
$('dirRefCopyAll').onclick = () => {
  if (!state.director.refs.length) { setDirStatus('当前档没有参考可复制'); return; }
  let added = 0, updated = 0, full = 0;
  for (const r of state.director.refs) {
    const res = dirCopyRefToOtherTier(r, false);
    if (res === 'added') added += 1;
    else if (res === 'updated') updated += 1;
    else full += 1;
  }
  const label = `Seedance ${dirOtherTier() === '25' ? '2.5' : '2.0'}`;
  setDirStatus(`已带到 ${label} 档：新增 ${added} 份${updated ? `、同步更新 ${updated} 份` : ''}${full ? `、${full} 份因对方档位已满被跳过` : ''} ✓`);
};

function dirSyncTier() {
  if (!state.director.refsStash || typeof state.director.refsStash !== 'object') {
    state.director.refsStash = { t20: [], t25: [] };
  }
  const tier = dirEffectiveIs25() ? '25' : '20';
  if (!state.director.refTier) {
    state.director.refTier = tier; // 首次：现有参考归入当前档，不做交换
  } else if (state.director.refTier !== tier) {
    state.director.refsStash['t' + state.director.refTier] = state.director.refs;
    const incoming = state.director.refsStash['t' + tier];
    state.director.refs = Array.isArray(incoming) ? incoming : [];
    state.director.refTier = tier;
    setDirStatus(`已切到 Seedance ${tier === '25' ? '2.5' : '2.0'} 档参考集（${state.director.refs.length} 份素材）— 两档互相独立记忆，切回即恢复`);
    scheduleSave();
  }
  renderDirRefs();
  updateDirGoModel();
}

// ---------------- 分镜提示词系统：CONTEXT + CUT 盒（0.1s 时长滑杆）+ 负面 ----------------
// 空的 CUT 盒 = 完全不注入；每个设了时长的 CUT 注入硬性秒数；
// 全部 CUT 都设时长时按累计时间戳 [x.xs–y.ys] 编排并自动对齐总时长。
const DIR_MIN_CUTS = 4;

function dirEnsureCuts() {
  if (!Array.isArray(state.director.cuts)) state.director.cuts = [];
  while (state.director.cuts.length < DIR_MIN_CUTS) state.director.cuts.push({ text: '', dur: 0 });
}

function renderDirCuts() {
  const wrap = $('dirCuts');
  if (!wrap) return;
  dirEnsureCuts();
  wrap.innerHTML = '';
  state.director.cuts.forEach((cut, i) => {
    const box = document.createElement('div');
    box.className = 'cut-box' + (Number(cut.dur) > 0 ? ' timed' : '');
    const head = document.createElement('div');
    head.className = 'cut-head';
    const title = document.createElement('span');
    title.textContent = `🎬 CUT ${i + 1}`;
    head.appendChild(title);
    // 本镜头场面情绪锁
    const moodSel = document.createElement('select');
    moodSel.className = 'mood-select';
    moodSel.title = '本镜头的场面情绪锁 — 只锁氛围/节奏/画面能量';
    moodSel.innerHTML = moodOptionsHtml(cut.mood || '');
    moodSel.onchange = () => { cut.mood = moodSel.value; scheduleSave(); };
    head.appendChild(moodSel);
    // 运镜切换钮：固定机位 / moving hold（互斥）
    const mkToggle = (label, key, otherKey, extraClass, tip) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cut-toggle' + (extraClass ? ' ' + extraClass : '') + (cut[key] ? ' on' : '');
      b.textContent = label;
      b.title = tip;
      b.onclick = () => {
        cut[key] = !cut[key];
        if (cut[key]) cut[otherKey] = false; // 互斥：锁死机位与手持晃动不能共存
        renderDirCuts();
        scheduleSave();
      };
      return b;
    };
    head.appendChild(mkToggle('📌 固定机位', 'fixedCam', 'movingHold', '',
      '注入硬性指令：本镜头零运镜——机位完全锁死，画框纹丝不动'));
    head.appendChild(mkToggle('🎥 moving hold', 'movingHold', 'fixedCam', 'hold',
      '注入硬性指令：moving hold 活动保持 + 手持摇曳质感'));
    // 60/30/10 构图章程开关（film-prompt-engineer 铁律：60%主导/30%次要/10%强调=叙事焦点）
    if (!cut.comp || typeof cut.comp !== 'object') cut.comp = { on: false, p60: '', p30: '', p10: '' };
    const compBtn = document.createElement('button');
    compBtn.type = 'button';
    compBtn.className = 'cut-toggle comp' + (cut.comp.on ? ' on' : '');
    compBtn.textContent = '🎨 60/30/10';
    compBtn.title = '构图章程：画面 60% 主导 / 30% 次要 / 10% 强调（强调项即视觉焦点）。开启且填了内容才注入';
    compBtn.onclick = () => {
      cut.comp.on = !cut.comp.on;
      renderDirCuts();
      scheduleSave();
    };
    head.appendChild(compBtn);
    const clr = document.createElement('button');
    clr.type = 'button';
    clr.className = 'cut-toggle cut-clear';
    clr.textContent = '🗑 清零';
    clr.title = '一键清空这个镜头：文字清空 + 时长归 0 + 运镜开关全关';
    clr.onclick = () => {
      cut.text = ''; cut.dur = 0; cut.fixedCam = false; cut.movingHold = false; cut.mood = ''; cut.comp = { on: false, p60: '', p30: '', p10: '' };
      renderDirCuts();
      syncDurationFromCuts();
      renderMentionPreview();
      scheduleSave();
    };
    head.appendChild(clr);
    if (i >= DIR_MIN_CUTS) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'cut-del';
      del.textContent = '✕';
      del.title = '删除这个镜头';
      del.onclick = () => {
        state.director.cuts.splice(i, 1);
        renderDirCuts();
        scheduleSave();
      };
      head.appendChild(del);
    }
    const ta = document.createElement('textarea');
    ta.className = 'dir-ta';
    ta.rows = 2;
    ta.placeholder = `镜头 ${i + 1} 的画面与动作（留空 = 此镜头不存在，不影响提示词）`;
    ta.value = cut.text || '';
    ta.oninput = () => { cut.text = ta.value; syncDurationFromCuts(); renderMentionPreview(); scheduleSave(); };
    attachMentionAutocomplete(ta);
    const durRow = document.createElement('div');
    durRow.className = 'cut-dur';
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0'; slider.max = '30'; slider.step = '0.1';
    slider.value = String(Number(cut.dur) || 0);
    const label = document.createElement('b');
    const fmt = (v) => (v > 0 ? `严格 ${v.toFixed(1)} 秒` : '时长不限');
    label.textContent = fmt(Number(cut.dur) || 0);
    slider.oninput = () => {
      cut.dur = Math.round(Number(slider.value) * 10) / 10;
      label.textContent = fmt(cut.dur);
      box.classList.toggle('timed', cut.dur > 0);
      syncDurationFromCuts(); // 分镜秒数实时同步总时长，不用再去生成面板手调
      scheduleSave();
    };
    durRow.appendChild(slider);
    durRow.appendChild(label);
    box.appendChild(head);
    box.appendChild(ta);
    box.appendChild(durRow);
    if (cut.comp.on) {
      const compRow = document.createElement('div');
      compRow.className = 'cut-comp';
      for (const [key, tag, ph] of [['p60', '%60', '主导（占据画面主体的东西）'], ['p30', '%30', '次要（衬托层）'], ['p10', '%10', '强调（视觉焦点）']]) {
        const lab = document.createElement('label');
        const b = document.createElement('b');
        b.textContent = tag;
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.value = cut.comp[key] || '';
        inp.placeholder = ph;
        inp.oninput = () => { cut.comp[key] = inp.value; renderMentionPreview(); scheduleSave(); };
        attachMentionAutocomplete(inp); // 60/30/10 三框同样支持 @引用参考素材
        lab.appendChild(b);
        lab.appendChild(inp);
        compRow.appendChild(lab);
      }
      box.appendChild(compRow);
    }
    wrap.appendChild(box);
  });
}

/** 分镜秒数 → 生成面板总时长实时同步（所有启用镜头都设了时长才生效） */
function syncDurationFromCuts() {
  const used = state.director.cuts.filter((c) => String(c.text || '').trim());
  if (!used.length || !used.every((c) => Number(c.dur) > 0)) return;
  const total = used.reduce((s, c) => s + Number(c.dur), 0);
  const slider = $('dirDuration');
  const v = Math.min(Number(slider.max), Math.max(Number(slider.min), Math.round(total)));
  slider.value = v;
  $('dirDurationVal').textContent = `${v} 秒（分镜合计 ${total.toFixed(1)}s）`;
}

$('dirAddCut').onclick = () => {
  dirEnsureCuts();
  state.director.cuts.push({ text: '', dur: 0 });
  renderDirCuts();
  scheduleSave();
  const boxes = $('dirCuts').querySelectorAll('.cut-box textarea');
  const last = boxes[boxes.length - 1];
  if (last) last.focus();
};

// 负面提示词与情境框：输入即入 state / 触发保存 / 联动 @chip 扫描
$('dirNegative').addEventListener('input', () => { state.director.negative = $('dirNegative').value; renderMentionPreview(); scheduleSave(); });
$('dirPrompt').addEventListener('input', () => scheduleSave());
$('dirCtxClear').onclick = () => {
  $('dirPrompt').value = '';
  $('dirPrompt').dispatchEvent(new Event('input', { bubbles: true }));
};
// 全局场面情绪锁
$('dirMood').innerHTML = moodOptionsHtml(state.director.mood || '');
$('dirMood').onchange = () => { state.director.mood = $('dirMood').value; scheduleSave(); };
$('dirNegClear').onclick = () => {
  $('dirNegative').value = '';
  $('dirNegative').dispatchEvent(new Event('input', { bubbles: true }));
};

// 出站中文化翻译开关（默认关 — 原文一字不动直发；开 = 大段英文全文译中）
$('dirTranslate').onchange = async () => {
  try {
    const res = await fetch('/api/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ translatePrompts: $('dirTranslate').checked }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    setDirStatus($('dirTranslate').checked
      ? '出站中文化已开启 — 大段英文会被 LLM 全文译中（可能损失措辞精度）'
      : '出站中文化已关闭 ✓ 你的原文将一字不动直接出站');
  } catch (e) {
    $('dirTranslate').checked = !$('dirTranslate').checked; // 保存失败回滚
    setDirStatus('开关保存失败: ' + errMsg(e));
  }
};

/**
 * 组装分镜块。resolveFn 对每段文字做 @解析并收集悬空引用。
 * @returns {{ text: string, totalSec: number|null }} totalSec 仅在全部启用镜头都设了时长时给出
 */
// 运镜切换钮的注入文案（按 CINEDANCE 物理化写法：写可见结果，不写抽象概念）
const CUT_FIXED_CAM_EMBED =
  '（机位锁死：三脚架完全固定，零运镜——不推、不拉、不摇、不移、不跟、无变焦、无手持晃动，画框纹丝不动，仅画面内的主体在运动）';
const CUT_MOVING_HOLD_EMBED =
  '（moving hold 活动保持：角色保持关键姿态的同时全程微动——呼吸起伏、重心细微调整、发丝衣角轻摆，绝不冻结；' +
  '镜头为手持肩扛质感：轻微的呼吸式晃动、缓慢的漂移与人手修正感，摇曳但不失控）';
function buildDirCutsBlock(resolveFn) {
  dirEnsureCuts();
  const used = state.director.cuts
    .map((c) => ({
      text: String(c.text || '').trim(),
      dur: Math.round((Number(c.dur) || 0) * 10) / 10,
      fixedCam: !!c.fixedCam,
      movingHold: !!c.movingHold,
      mood: c.mood || '',
      comp: c.comp && c.comp.on ? { p60: String(c.comp.p60 || '').trim(), p30: String(c.comp.p30 || '').trim(), p10: String(c.comp.p10 || '').trim() } : null,
    }))
    .filter((c) => c.text);
  if (!used.length) return { text: '', totalSec: null };
  const allTimed = used.every((c) => c.dur > 0);
  let t = 0;
  const lines = used.map((c, k) => {
    // 60/30/10 构图章程（开关开启 + 至少一项有内容才注入）
    let compEmbed = '';
    if (c.comp && (c.comp.p60 || c.comp.p30 || c.comp.p10)) {
      const parts = [];
      if (c.comp.p60) parts.push(`60% 由「${resolveFn(c.comp.p60)}」主导占据`);
      if (c.comp.p30) parts.push(`30% 为「${resolveFn(c.comp.p30)}」作次要衬托`);
      if (c.comp.p10) parts.push(`10% 为「${resolveFn(c.comp.p10)}」点睛强调——强调项即视觉焦点`);
      compEmbed = `（构图章程 60/30/10：画面${parts.join('，')}；该占比在整个镜头内严格保持，不许漂移）`;
    }
    const moodEmbed = c.mood ? `（${moodPromptOf(c.mood)}）` : '';
    const body = resolveFn(c.text)
      + moodEmbed
      + compEmbed
      + (c.fixedCam ? CUT_FIXED_CAM_EMBED : '')
      + (c.movingHold ? CUT_MOVING_HOLD_EMBED : '');
    if (allTimed) {
      const s = t;
      t = Math.round((t + c.dur) * 10) / 10;
      return `镜头 ${k + 1} [${s.toFixed(1)}s–${t.toFixed(1)}s]（本镜头时长严格 ${c.dur.toFixed(1)} 秒，不许拖长或缩短）：${body}`;
    }
    const durTxt = c.dur > 0 ? `（本镜头时长严格 ${c.dur.toFixed(1)} 秒）` : '';
    return `镜头 ${k + 1}${durTxt}：${body}`;
  });
  const header = `【镜头结构】全片共 ${used.length} 个镜头、${Math.max(0, used.length - 1)} 次硬切（HARD CUT），镜头间直切、禁自加淡入淡出等转场，禁增删镜头；每镜时长按标注严格执行${allTimed ? `，全片总时长 ${t.toFixed(1)} 秒` : ''}。`;
  return { text: header + '\n' + lines.join('\n'), totalSec: allTimed ? t : null };
}

renderDirCuts();

// ---------------- Simulate GEN：不花钱拿到出站级最终提示词 + 素材编号打包 ----------------
let simFolder = '';
/** 模拟出片结果 → 同一个 simDialog（导演生成与中割一体生成共用） */
function showSimResult(json) {
  simFolder = json.folder || '';
  $('simPromptText').value = json.prompt || '';
  $('simFolderInfo').textContent = `素材包：${json.folder}（${(json.files || []).length} 个文件：参考素材按 image1/video1/audio1 编号命名，与提示词一一对应 + prompt.txt + manifest.txt）`;
  $('simStatus').textContent = `最终提示词 ${String(json.prompt || '').length} 字符`;
  $('simDialog').showModal();
}
async function simulateGen() {
  const reqData = assembleDirectorRequest(); // 与真实生成完全同一条组装管线（含悬空引用拦截）
  if (!reqData) return;
  setDirStatus('模拟出片中…（组装最终提示词 + 打包素材）');
  try {
    const res = await fetch('/api/director/simulate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        refImages: reqData.refImages,
        refVideos: reqData.refVideos,
        refAudios: reqData.refAudios,
        prompt: reqData.prompt,
        duration: reqData.duration,
        model: reqData.model,
        animMode: reqData.animMode,
        refsMeta: reqData.refsMeta,
        ...(state.director.evergreen !== undefined ? { evergreen: state.director.evergreen } : {}),
      }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || ('请求失败 ' + res.status));
    showSimResult(json);
    setDirStatus('模拟出片完成 ✓ 未产生任何生成费用');
  } catch (e) {
    setDirStatus('模拟出片失败: ' + errMsg(e));
  }
}
$('btnSimulateGen').onclick = simulateGen;
$('simClose').onclick = () => $('simDialog').close();
$('simCopy').onclick = async () => {
  const text = $('simPromptText').value;
  try {
    await navigator.clipboard.writeText(text);
    $('simStatus').textContent = '已复制到剪贴板 ✓ 直接去其它平台粘贴';
  } catch {
    // 剪贴板 API 被拒时退回选中复制
    $('simPromptText').focus();
    $('simPromptText').select();
    document.execCommand('copy');
    $('simStatus').textContent = '已复制（选中方式）✓';
  }
};
$('simOpenFolder').onclick = async () => {
  if (!simFolder) return;
  try {
    const res = await fetch('/api/fs/open-folder', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: simFolder }),
    });
    if (!res.ok) throw new Error('打开失败 ' + res.status);
  } catch (e) { $('simStatus').textContent = '打开文件夹失败: ' + errMsg(e); }
};

// ---------------- 悬停即播：所有历史卡与视频参考的迷你回放 ----------------
// 性能铁律：页面上任何时刻最多存在一个悬停回放 <video>。
// 缩略图一律是服务端抽帧的 JPEG（/api/media/thumb），悬停时才在 [data-hover-video]
// 容器里创建覆盖层视频，移开立即卸载 src 并销毁 —— 常驻几十个视频解码器正是之前卡顿的根源。
let hoverLive = null; // 当前唯一的悬停回放视频
function killHoverLive() {
  if (!hoverLive) return;
  try { hoverLive.pause(); } catch {}
  try { hoverLive.removeAttribute('src'); hoverLive.load(); } catch {} // 释放解码器与网络
  hoverLive.remove();
  hoverLive = null;
}
document.addEventListener('mouseover', (e) => {
  if (!(e.target instanceof Element)) return;
  const host = e.target.closest('[data-hover-video]');
  if (!host) return;
  if (hoverLive && hoverLive.parentElement === host) return; // 同一容器内移动
  killHoverLive();
  const v = document.createElement('video');
  v.className = 'hover-video-live';
  v.src = host.dataset.hoverVideo;
  v.poster = '/api/media/thumb?src=' + encodeURIComponent(host.dataset.hoverVideo); // 起播前不闪黑
  v.muted = true; v.loop = true; v.autoplay = true; v.playsInline = true;
  host.appendChild(v);
  hoverLive = v;
  v.play().catch(() => {});
});
document.addEventListener('mouseout', (e) => {
  if (!(e.target instanceof Element)) return;
  const host = e.target.closest('[data-hover-video]');
  if (!host) return;
  if (e.relatedTarget instanceof Element && host.contains(e.relatedTarget)) return;
  if (hoverLive && hoverLive.parentElement === host) killHoverLive();
});
// 中割分镜卡自带播放器（preload=none + poster，静息零解码）：悬停播放、移开暂停
document.addEventListener('mouseover', (e) => {
  if (!(e.target instanceof Element)) return;
  const card = e.target.closest('.seg-card');
  const v = card && card.querySelector('video[src]');
  if (v && v.paused) { v.muted = true; v.loop = true; v.play().catch(() => {}); }
});
document.addEventListener('mouseout', (e) => {
  if (!(e.target instanceof Element)) return;
  const card = e.target.closest('.seg-card');
  if (!card) return;
  if (e.relatedTarget instanceof Element && card.contains(e.relatedTarget)) return;
  const v = card.querySelector('video[src]');
  if (v && !v.paused) v.pause();
});

// 应用内选择器：视频格子悬停 → 流式小回放（/api/fs/file 直读本地文件）
document.addEventListener('mouseenter', () => {}, true); // 占位保证捕获层就绪
document.addEventListener('mouseover', (e) => {
  if (!(e.target instanceof Element)) return;
  const cell = e.target.closest('#fsGrid .fs-cell[data-vpath]');
  if (!cell || cell.querySelector('.fs-hover-video')) return;
  const v = document.createElement('video');
  v.className = 'fs-hover-video';
  v.src = '/api/fs/file?path=' + encodeURIComponent(cell.dataset.vpath);
  v.muted = true; v.loop = true; v.autoplay = true; v.playsInline = true;
  cell.appendChild(v);
  v.play().catch(() => {});
});
document.addEventListener('mouseout', (e) => {
  if (!(e.target instanceof Element)) return;
  const cell = e.target.closest('#fsGrid .fs-cell[data-vpath]');
  if (!cell) return;
  if (e.relatedTarget instanceof Element && cell.contains(e.relatedTarget)) return;
  const v = cell.querySelector('.fs-hover-video');
  if (v) v.remove();
});

// ---------------- 中割一体生成：参考素材体系（REFERENCES TOOL 核心能力移植） ----------------
// 与导演区同一套：图/视频/音频三类 tab、role+说明词、影响力/忠实度滑杆（同一套注入文案）、
// 2.0/2.5 双档独立记忆 + ⇄ 互拷、拖拽重排、悬停回放缩略图。档位跟随 ⚙ 全局模型。
function ibEnsure() {
  if (!state.whole || typeof state.whole !== 'object') state.whole = { history: [], current: -1 };
  const w = state.whole;
  if (!Array.isArray(w.refs)) w.refs = [];
  if (!w.refsStash || typeof w.refsStash !== 'object') w.refsStash = { t20: [], t25: [] };
  return w;
}
let ibRefKind = 'image';
function ibRefsAll() { return ibEnsure().refs; }
function ibRefsOf(kind) { return ibRefsAll().filter((r) => (r.kind || 'image') === kind); }
function ibEffectiveIs25() { return modelIs25(); } // 跟随 ⚙ 全局模型（与导演区「跟随全局档位」同一判定）
function ibTier() { return ibEffectiveIs25() ? '25' : '20'; }
function ibOtherTier() { return (ibEnsure().refTier === '25') ? '20' : '25'; }
function ibRefCaps() { return dirTierCaps(ibEnsure().refTier || ibTier()); }

function ibSyncTier() {
  const w = ibEnsure();
  const tier = ibTier();
  if (!w.refTier) {
    w.refTier = tier; // 首次：现有参考归入当前档
  } else if (w.refTier !== tier) {
    w.refsStash['t' + w.refTier] = w.refs;
    const incoming = w.refsStash['t' + tier];
    w.refs = Array.isArray(incoming) ? incoming : [];
    w.refTier = tier;
    setWholeStatus(`参考素材已切到 Seedance ${tier === '25' ? '2.5' : '2.0'} 档（${w.refs.length} 份）— 两档独立记忆，切回即恢复`);
    scheduleSave();
  }
  renderIbRefs();
}

/** 复制单份参考到另一档；返回 'added' | 'updated' | 'full' */
function ibCopyRefToOtherTier(r, verbose) {
  const w = ibEnsure();
  const target = ibOtherTier();
  const key = 't' + target;
  const list = w.refsStash[key] = Array.isArray(w.refsStash[key]) ? w.refsStash[key] : [];
  const kind = r.kind || 'image';
  const label = `Seedance ${target === '25' ? '2.5' : '2.0'}`;
  const dup = list.find((x) => x.url === r.url);
  if (dup) {
    dup.name = r.name; dup.role = r.role; dup.note = r.note; dup.kind = kind; dup.weight = r.weight; dup.fidelity = r.fidelity;
    scheduleSave();
    if (verbose) setWholeStatus(`该素材已在 ${label} 档 — 已同步其 role 与说明词 ✓`);
    return 'updated';
  }
  const caps = dirTierCaps(target);
  if (list.filter((x) => (x.kind || 'image') === kind).length >= caps[kind]) {
    if (verbose) setWholeStatus(`${label} 档的${DIR_KIND_META[kind].name}位已满（上限 ${caps[kind]}）`);
    return 'full';
  }
  list.push({ id: nextRefId++, name: r.name, url: r.url, kind, role: r.role, note: r.note, weight: r.weight, fidelity: r.fidelity });
  scheduleSave();
  if (verbose) setWholeStatus(`已复制到 ${label} 档 ✓（⚙ 里换到对应模型即可看到）`);
  return 'added';
}

// 拖拽重排（同类内），与导演区同款
let ibDragRefId = null;
function ibReorderRef(srcId, targetId, before) {
  const w = ibEnsure();
  const kindItems = ibRefsOf(ibRefKind);
  const src = kindItems.find((x) => x.id === srcId);
  if (!src || srcId === targetId) return;
  const order = kindItems.filter((x) => x.id !== srcId);
  const ti = order.findIndex((x) => x.id === targetId);
  if (ti < 0) return;
  order.splice(before ? ti : ti + 1, 0, src);
  const slots = [];
  w.refs.forEach((x, i) => { if ((x.kind || 'image') === ibRefKind) slots.push(i); });
  slots.forEach((slot, k) => { w.refs[slot] = order[k]; });
  renderIbRefs();
  scheduleSave();
}

function renderIbRefs() {
  if (!$('ibRefList')) return;
  const w = ibEnsure();
  const caps = ibRefCaps();
  for (const k of ['image', 'video', 'audio']) {
    const el = $('ibCnt' + k[0].toUpperCase() + k.slice(1));
    if (el) el.textContent = `${ibRefsOf(k).length}/${caps[k]}`;
  }
  $('ibRefCaps').textContent = `— 图 ≤${caps.image} · 视频 ≤${caps.video} · 音频 ≤${caps.audio}`;
  const tierLabel = $('ibRefTierLabel');
  if (tierLabel) tierLabel.textContent = `Seedance ${(w.refTier || ibTier()) === '25' ? '2.5' : '2.0'}`;
  const copyAll = $('ibRefCopyAll');
  if (copyAll) copyAll.title = `把当前档全部参考（含 role 与说明词）复制到 Seedance ${ibOtherTier() === '25' ? '2.5' : '2.0'} 档`;
  document.querySelectorAll('#ibRefTabs button').forEach((b) => {
    b.classList.toggle('active', b.dataset.kind === ibRefKind);
  });
  const meta = DIR_KIND_META[ibRefKind];
  $('ibRefFiles').accept = meta.accept;
  $('ibRefAdd').disabled = ibRefsOf(ibRefKind).length >= caps[ibRefKind];

  const list = $('ibRefList');
  list.innerHTML = '';
  ibRefsOf(ibRefKind).forEach((r, i) => {
    const row = document.createElement('div');
    row.className = 'dir-ref-row';
    row.dataset.refId = r.id;
    const thumb = (r.kind || 'image') === 'image'
      ? `<img src="${r.url}" alt="${escapeHtml(r.name)}" title="${escapeHtml(r.name)}">`
      : (r.kind === 'video'
        ? `<img src="/api/media/thumb?src=${encodeURIComponent(r.url)}" alt="${escapeHtml(r.name)}" title="${escapeHtml(r.name)}" loading="lazy" onerror="this.style.visibility='hidden'">`
        : `<span class="dir-ref-icon" title="${escapeHtml(r.name)}">${DIR_KIND_META[r.kind].icon}</span>`);
    const hoverAttr = r.kind === 'video' ? ` data-hover-video="${escapeHtml(r.url)}"` : '';
    const roleOpts = Object.entries(DIR_REF_ROLES)
      .map(([k, [label]]) => `<option value="${k}" ${(r.role || meta.defaultRole) === k ? 'selected' : ''}>${label}</option>`)
      .join('');
    const otherLabel = ibOtherTier() === '25' ? '2.5' : '2.0';
    row.innerHTML = `
      <div class="ref-cell"${hoverAttr}>${thumb}<button type="button" aria-label="移除">✕</button></div>
      <div class="dir-ref-meta">
        <div class="dir-ref-head">
          <span class="dir-ref-drag" title="按住拖拽调整顺序 — 编号随位置自动重算">⠿</span>
          <span class="dir-ref-idx">${DIR_KIND_META[r.kind || 'image'].icon} ${i + 1} · ${escapeHtml((r.name || '').slice(0, 18))}</span>
          <select class="dir-ref-role" title="这份参考对模型的作用（注入后台提示词）">${roleOpts}</select>
          <button type="button" class="dir-ref-copy" title="把这份参考连同 role 与说明词复制到 Seedance ${otherLabel} 档的参考集">⇄ ${otherLabel}</button>
        </div>
        <textarea class="dir-ref-note" rows="1" data-min-grow="80" maxlength="160"
          placeholder="补充说明：这份素材是什么 / 想让模型学到什么">${escapeHtml(r.note || '')}</textarea>
        <div class="ref-sliders">
          <label title="这份参考对整体生成的影响力权重：100=最高优先级（与其它参考冲突时以此为准），0=仅作最轻微参考。50=中性不注入">
            <span>影响力</span><input type="range" class="ref-weight" min="0" max="100" step="1" value="${r.weight === undefined ? 50 : Number(r.weight)}"><b>${r.weight === undefined ? 50 : Number(r.weight)}</b></label>
          <label title="忠实度：100=必须原封不动逐细节复刻这份素材；0=完全创作自由，绝不把它当构图用。50=中性不注入">
            <span>忠实度</span><input type="range" class="ref-fidelity" min="0" max="100" step="1" value="${r.fidelity === undefined ? 50 : Number(r.fidelity)}"><b>${r.fidelity === undefined ? 50 : Number(r.fidelity)}</b></label>
        </div>
      </div>`;
    row.querySelector('.ref-cell button').onclick = () => {
      const w2 = ibEnsure();
      w2.refs = w2.refs.filter((x) => x.id !== r.id);
      renderIbRefs();
      scheduleSave();
    };
    row.querySelector('.dir-ref-role').onchange = (e) => { r.role = e.target.value; scheduleSave(); };
    row.querySelector('.dir-ref-note').onchange = (e) => { r.note = e.target.value; scheduleSave(); };
    for (const [cls, key] of [['ref-weight', 'weight'], ['ref-fidelity', 'fidelity']]) {
      const s = row.querySelector('.' + cls);
      s.oninput = () => { r[key] = Number(s.value); s.nextElementSibling.textContent = s.value; scheduleSave(); };
    }
    row.querySelector('.dir-ref-copy').onclick = () => ibCopyRefToOtherTier(r, true);
    const handle = row.querySelector('.dir-ref-drag');
    handle.onmousedown = () => { row.draggable = true; };
    row.addEventListener('dragstart', (e) => {
      ibDragRefId = r.id;
      row.classList.add('dragging');
      try { e.dataTransfer.setData('text/plain', String(r.id)); } catch {}
      e.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragend', () => { row.classList.remove('dragging'); row.draggable = false; ibDragRefId = null; });
    row.addEventListener('dragover', (e) => {
      if (ibDragRefId === null || ibDragRefId === r.id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      row.classList.toggle('drop-above', e.offsetY < row.offsetHeight / 2);
      row.classList.toggle('drop-below', e.offsetY >= row.offsetHeight / 2);
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-above', 'drop-below'));
    row.addEventListener('drop', (e) => {
      row.classList.remove('drop-above', 'drop-below');
      if (ibDragRefId === null || ibDragRefId === r.id) return;
      e.preventDefault();
      e.stopPropagation();
      ibReorderRef(ibDragRefId, r.id, e.offsetY < row.offsetHeight / 2);
    });
    list.appendChild(row);
  });
}

if ($('ibRefTabs')) {
  document.querySelectorAll('#ibRefTabs button').forEach((b) => {
    b.onclick = () => { ibRefKind = b.dataset.kind; renderIbRefs(); };
  });
  // 应用内媒体选择器（三类全开，与导演区同款；配额按当前档计算）
  $('ibRefAdd').onclick = () => {
    const caps = ibRefCaps();
    const rooms = {
      image: Math.max(0, caps.image - ibRefsOf('image').length),
      video: Math.max(0, caps.video - ibRefsOf('video').length),
      audio: Math.max(0, caps.audio - ibRefsOf('audio').length),
    };
    const totalRoom = rooms.image + rooms.video + rooms.audio;
    if (totalRoom <= 0) { setWholeStatus('当前档各类型参考位都已满'); return; }
    openMediaPicker({
      kinds: ['image', 'video', 'audio'],
      limit: totalRoom, nativeInput: $('ibRefFiles'),
      title: '📁 添加参考素材（中割）',
      onDone: (items) => {
        let added = 0, skipped = 0;
        for (const it of items) {
          const kind = it.kind || 'image';
          if (rooms[kind] <= 0) { skipped += 1; continue; }
          rooms[kind] -= 1;
          ibEnsure().refs.push({
            id: nextRefId++, name: it.name, url: it.url,
            kind, role: DIR_KIND_META[kind].defaultRole, note: '',
          });
          added += 1;
        }
        renderIbRefs();
        scheduleSave();
        setWholeStatus(added ? `已添加 ${added} 份参考${skipped ? `（${skipped} 份因该类型已满被跳过）` : ''}` : (skipped ? '对应类型的参考位已满' : ''));
      },
    });
  };
  $('ibRefAddNative').onclick = () => $('ibRefFiles').click();
  $('ibRefFiles').onchange = async (e) => {
    const caps = ibRefCaps();
    const room = caps[ibRefKind] - ibRefsOf(ibRefKind).length;
    const files = Array.from(e.target.files || []).slice(0, Math.max(0, room));
    e.target.value = '';
    for (const f of files) {
      try {
        setWholeStatus(`${DIR_KIND_META[ibRefKind].name}上传中… ${f.name}`);
        const url = await uploadAsset(f);
        ibEnsure().refs.push({
          id: nextRefId++, name: f.name, url,
          kind: ibRefKind, role: DIR_KIND_META[ibRefKind].defaultRole, note: '',
        });
        setWholeStatus('');
      } catch (err) { setWholeStatus(`${DIR_KIND_META[ibRefKind].name}上传失败: ` + errMsg(err)); }
    }
    renderIbRefs();
    scheduleSave();
  };
  $('ibRefCopyAll').onclick = () => {
    const refs = ibRefsAll();
    if (!refs.length) { setWholeStatus('当前档没有参考可复制'); return; }
    let added = 0, updated = 0, full = 0;
    for (const r of refs) {
      const res = ibCopyRefToOtherTier(r, false);
      if (res === 'added') added += 1;
      else if (res === 'updated') updated += 1;
      else full += 1;
    }
    const label = `Seedance ${ibOtherTier() === '25' ? '2.5' : '2.0'}`;
    setWholeStatus(`已带到 ${label} 档：新增 ${added} 份${updated ? `、同步更新 ${updated} 份` : ''}${full ? `、${full} 份因对方档位已满被跳过` : ''} ✓`);
  };
  // 从资源管理器拖文件 → 中割参考（按 MIME 自动分类，与导演区同款）
  (() => {
    const panel = $('ibRefPanel');
    if (!panel) return;
    panel.addEventListener('dragover', (e) => {
      if (Array.from(e.dataTransfer.types || []).includes('Files')) {
        e.preventDefault();
        panel.classList.add('file-drop-hot');
      }
    });
    panel.addEventListener('dragleave', () => panel.classList.remove('file-drop-hot'));
    panel.addEventListener('drop', async (e) => {
      panel.classList.remove('file-drop-hot');
      if (!e.dataTransfer.files || !e.dataTransfer.files.length) return;
      e.preventDefault();
      const caps = ibRefCaps();
      const rooms = {
        image: Math.max(0, caps.image - ibRefsOf('image').length),
        video: Math.max(0, caps.video - ibRefsOf('video').length),
        audio: Math.max(0, caps.audio - ibRefsOf('audio').length),
      };
      let added = 0, skipped = 0;
      for (const f of Array.from(e.dataTransfer.files)) {
        const kind = f.type.startsWith('video/') ? 'video' : f.type.startsWith('audio/') ? 'audio' : f.type.startsWith('image/') ? 'image' : null;
        if (!kind || rooms[kind] <= 0) { skipped += 1; continue; }
        try {
          setWholeStatus(`${DIR_KIND_META[kind].name}上传中… ${f.name}`);
          const url = await uploadAsset(f);
          rooms[kind] -= 1;
          ibEnsure().refs.push({ id: nextRefId++, name: f.name, url, kind, role: DIR_KIND_META[kind].defaultRole, note: '' });
          added += 1;
        } catch (err) { setWholeStatus('上传失败: ' + errMsg(err)); }
      }
      renderIbRefs();
      scheduleSave();
      setWholeStatus(added ? `已添加 ${added} 份参考${skipped ? `（${skipped} 份被跳过：类型不支持或已满）` : ''}` : '');
    });
  })();
}

// SIMULATE GEN（中割）：不发生成请求 —— 最终提示词 + 关键帧与参考素材编号打包
async function ibSimulateGen() {
  const req = assembleWholeRequest();
  if (!req) return;
  setWholeStatus('模拟出片中…（组装最终提示词 + 打包关键帧与参考素材）');
  try {
    const res = await fetch('/api/whole/simulate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...req.body, refsMeta: req.refsMeta }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || ('请求失败 ' + res.status));
    showSimResult(json);
    setWholeStatus('模拟出片完成 ✓ 未产生任何生成费用');
  } catch (e) {
    setWholeStatus('⚠ 模拟出片失败: ' + errMsg(e));
  }
}
if ($('btnWholeSimulate')) $('btnWholeSimulate').onclick = ibSimulateGen;

// QoL：三个提示词框的一键清空
for (const [btnId, taId] of [['globalPromptClear', 'globalPrompt'], ['stylePromptClear', 'stylePrompt'], ['inbetweenPromptClear', 'inbetweenPrompt']]) {
  const btn = $(btnId);
  if (btn) btn.onclick = () => {
    const ta = $(taId);
    ta.value = '';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new Event('change', { bubbles: true }));
    ta.focus();
  };
}

// ---------------- @ 气泡：链接成功的引用变成可拖动的可视气泡 ----------------
// 原理：每个可 @ 的输入框上盖一层与其字体/内边距/换行逐像素一致的镜像浮层（.i18n-skip 绝不被翻译）。
// 浮层文字整体透明，只有解析成功的 @token 渲染成彩色气泡（不占额外排版空间——只有背景与圆角，
// 字形与底下输入框完全重叠）。气泡可按住拖动：拖到本框任意位置、甚至另一个提示词框里放下，
// 文本随之搬家；单击气泡 = 在输入框里选中该 token。输入框仍是唯一事实来源，无任何富文本改造。
// 惰性初始化：attachMentionBubbles 在脚本更早处就会被 init 调用，普通 const 会踩 TDZ
function mbReg() { if (!window.__mbRegistry) window.__mbRegistry = new Set(); return window.__mbRegistry; } // { el, overlay, inner }

function mbTokenSet() {
  const set = new Set();
  try { for (const t of dirMentionTokens()) set.add(t.token); } catch {}
  return set;
}

function mbRender(entry) {
  const { el, inner } = entry;
  const valid = mbTokenSet();
  const text = String(el.value || '');
  let html = '';
  let last = 0;
  let m;
  MENTION_RE.lastIndex = 0;
  while ((m = MENTION_RE.exec(text))) {
    const kind = MENTION_ALIAS[m[1].toLowerCase()] || MENTION_ALIAS[m[1]];
    const key = kind ? kind + Number(m[2]) : null;
    html += escapeHtml(text.slice(last, m.index));
    if (key && valid.has(key)) {
      html += `<span class="mention-bubble mb-${kind}" data-token="${key}" data-start="${m.index}" data-end="${m.index + m[0].length}" title="@${key} — 单击弹出全部参考清单当场换绑 · 按住拖动换位置（可拖进其它提示词框）">${escapeHtml(m[0])}</span>`;
    } else {
      html += escapeHtml(m[0]); // 悬空引用不成泡：红 chip 定位器负责它
    }
    last = m.index + m[0].length;
  }
  html += escapeHtml(text.slice(last));
  inner.innerHTML = html || '';
  entry.overlay.scrollTop = el.scrollTop;
  entry.overlay.scrollLeft = el.scrollLeft;
}

function mbSyncGeometry(entry) {
  const { el, overlay, inner } = entry;
  if (!el.isConnected) return;
  const cs = getComputedStyle(el);
  overlay.style.top = el.offsetTop + 'px';
  overlay.style.left = el.offsetLeft + 'px';
  overlay.style.width = el.offsetWidth + 'px';
  overlay.style.height = el.offsetHeight + 'px';
  for (const p of ['font', 'lineHeight', 'letterSpacing', 'textAlign', 'textIndent']) inner.style[p] = cs[p];
  inner.style.padding = cs.padding;
  inner.style.borderWidth = cs.borderWidth;
  inner.style.borderStyle = 'solid';
  inner.style.borderColor = 'transparent';
  if (el.tagName === 'TEXTAREA') {
    inner.style.whiteSpace = 'pre-wrap';
    inner.style.wordBreak = cs.wordBreak;
    inner.style.overflowWrap = cs.overflowWrap === 'normal' ? 'break-word' : cs.overflowWrap;
  } else {
    inner.style.whiteSpace = 'pre';
  }
}

function mbEntryOf(el) {
  for (const entry of mbReg()) if (entry.el === el) return entry;
  return null;
}
function attachMentionBubbles(el) {
  if (!el) return;
  // data-mb 标记不可靠：渲染期元素可能短暂离档、浮层被剪 —— 以注册表为准判定是否已挂
  const existing = mbEntryOf(el);
  if (existing) return;
  if (el.dataset.mb) {
    // 半途状态（标记在、浮层没了）：清掉可能残留的孤儿浮层后重挂
    const sib = el.parentElement && el.parentElement.querySelector('.mb-overlay');
    if (sib && sib.__mbEl === el) sib.remove();
  }
  el.dataset.mb = '1';
  const parent = el.parentElement;
  if (!parent) { delete el.dataset.mb; return; }
  const pcs = getComputedStyle(parent);
  if (pcs.position === 'static') parent.style.position = 'relative';
  const overlay = document.createElement('div');
  overlay.className = 'mb-overlay i18n-skip';
  overlay.__mbEl = el;
  const inner = document.createElement('div');
  inner.className = 'mb-inner';
  overlay.appendChild(inner);
  parent.insertBefore(overlay, el.nextSibling);
  const entry = { el, overlay, inner };
  mbReg().add(entry);
  const sync = () => { try { mbSyncGeometry(entry); mbRender(entry); } catch {} };
  el.addEventListener('input', sync);
  el.addEventListener('change', sync);
  el.addEventListener('scroll', () => { overlay.scrollTop = el.scrollTop; overlay.scrollLeft = el.scrollLeft; });
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(() => { mbSyncGeometry(entry); });
    ro.observe(el);
  }
  sync();
}

/** 参考增删改名/换档后：token 有效性变了 → 所有浮层重渲染。
 *  同时自愈两类状态：①元素已被换掉 → 剪掉孤儿浮层；②元素还在但浮层丢了（渲染期误剪）→ 重挂 */
function mbRefreshAll() {
  for (const entry of Array.from(mbReg())) {
    if (!entry.el.isConnected) { entry.overlay.remove(); mbReg().delete(entry); continue; }
    if (!entry.overlay.isConnected) { mbReg().delete(entry); delete entry.el.dataset.mb; attachMentionBubbles(entry.el); continue; }
    mbSyncGeometry(entry);
    mbRender(entry);
  }
  // 自愈兜底：所有带 @自动补全 的输入框都应有浮层。renderDirCuts 在元素入 DOM 前就调用
  // attachMentionAutocomplete（当时还没有 parent，浮层挂不上）——等它们入档后在这里补挂。
  document.querySelectorAll('[data-mention-ac]').forEach((el) => {
    if (!mbEntryOf(el)) { delete el.dataset.mb; attachMentionBubbles(el); }
  });
}

// ---- 拖拽引擎：单击=选中 token；拖动=文本搬家（支持拖进其它提示词框） ----
const mbDrag = { active: false, moved: false, srcEntry: null, token: '', start: 0, end: 0, ghost: null, caretEl: null, target: null };

function mbEntryOfNode(node) {
  for (const entry of mbReg()) if (entry.inner.contains(node)) return entry;
  return null;
}

function mbOffsetFromPoint(x, y) {
  let node = null, offset = 0;
  if (document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(x, y);
    if (r) { node = r.startContainer; offset = r.startOffset; }
  } else if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(x, y);
    if (p) { node = p.offsetNode; offset = p.offset; }
  }
  if (!node) return null;
  const entry = mbEntryOfNode(node);
  if (!entry) return null;
  // 把 (node, offset) 折算成 inner 全文里的字符位
  let pos = 0;
  const walk = (parent) => {
    for (const child of parent.childNodes) {
      if (child === node) { pos += (child.nodeType === 3 ? offset : 0); return true; }
      if (child.nodeType === 1) {
        if (child.contains(node)) { const done = walk(child); return done; }
        pos += (child.textContent || '').length;
      } else {
        pos += child.nodeValue.length;
      }
    }
    return false;
  };
  if (node === entry.inner) {
    let k = 0;
    for (const child of entry.inner.childNodes) {
      if (k >= offset) break;
      pos += (child.textContent || child.nodeValue || '').length;
      k += 1;
    }
  } else if (!walk(entry.inner)) return null;
  return { entry, pos };
}

function mbShowCaret(entry, pos) {
  if (!mbDrag.caretEl) {
    mbDrag.caretEl = document.createElement('div');
    mbDrag.caretEl.className = 'mb-drop-caret i18n-skip';
    document.body.appendChild(mbDrag.caretEl);
  }
  // 用 Range 找该字符位的屏幕坐标
  let count = 0, rect = null;
  for (const child of entry.inner.childNodes) {
    const len = (child.textContent || child.nodeValue || '').length;
    if (pos <= count + len) {
      const textNode = child.nodeType === 3 ? child : child.firstChild;
      const innerOff = Math.max(0, Math.min(pos - count, textNode ? textNode.nodeValue.length : 0));
      const r = document.createRange();
      try {
        if (textNode) { r.setStart(textNode, innerOff); r.setEnd(textNode, innerOff); rect = r.getBoundingClientRect(); }
      } catch {}
      break;
    }
    count += len;
  }
  if (!rect || (!rect.height && !rect.top)) { // 末尾/空框兜底：贴框
    const er = entry.el.getBoundingClientRect();
    rect = { left: er.left + 8, top: er.top + 6, height: 16 };
  }
  mbDrag.caretEl.style.left = (rect.left - 1) + 'px';
  mbDrag.caretEl.style.top = rect.top + 'px';
  mbDrag.caretEl.style.height = Math.max(14, rect.height) + 'px';
  mbDrag.caretEl.hidden = false;
}

document.addEventListener('pointerdown', (e) => {
  const bub = e.target instanceof Element ? e.target.closest('.mention-bubble') : null;
  if (!bub) return;
  const entry = mbEntryOfNode(bub);
  if (!entry) return;
  e.preventDefault(); // 不把焦点交给浮层
  mbDrag.active = true;
  mbDrag.moved = false;
  mbDrag.srcEntry = entry;
  mbDrag.token = bub.textContent;
  mbDrag.start = Number(bub.dataset.start);
  mbDrag.end = Number(bub.dataset.end);
  mbDrag.x0 = e.clientX; mbDrag.y0 = e.clientY;
  mbDrag.target = null;
});
document.addEventListener('pointermove', (e) => {
  if (!mbDrag.active) return;
  if (!mbDrag.moved) {
    if (Math.abs(e.clientX - mbDrag.x0) + Math.abs(e.clientY - mbDrag.y0) < 5) return;
    mbDrag.moved = true;
    // 拖拽期间浮层可命中（caretRangeFromPoint 需要）+ 幽灵气泡跟手
    for (const en of mbReg()) en.overlay.classList.add('mb-hittable');
    if (!mbDrag.ghost) {
      mbDrag.ghost = document.createElement('div');
      mbDrag.ghost.className = 'mention-bubble mb-ghost i18n-skip';
      mbDrag.ghost.textContent = mbDrag.token;
      document.body.appendChild(mbDrag.ghost);
    }
  }
  mbDrag.ghost.style.left = (e.clientX + 10) + 'px';
  mbDrag.ghost.style.top = (e.clientY - 24) + 'px';
  const hit = mbOffsetFromPoint(e.clientX, e.clientY);
  mbDrag.target = hit;
  if (hit) mbShowCaret(hit.entry, hit.pos);
  else if (mbDrag.caretEl) mbDrag.caretEl.hidden = true;
});
document.addEventListener('pointerup', (e) => {
  if (!mbDrag.active) return;
  const { srcEntry, token, start, end, moved, target } = mbDrag;
  mbDrag.active = false;
  for (const en of mbReg()) en.overlay.classList.remove('mb-hittable');
  if (mbDrag.ghost) { mbDrag.ghost.remove(); mbDrag.ghost = null; }
  if (mbDrag.caretEl) mbDrag.caretEl.hidden = true;
  if (!moved) {
    // 单击：弹出可滚动的全部参考清单，当场把这个引用换绑到别的素材
    mbShowSwapMenu(srcEntry, token, start, end, e);
    return;
  }
  if (!target) return; // 没落在任何提示词框上 → 原地不动
  const srcEl = srcEntry.el;
  const dstEl = target.entry.el;
  let insertAt = Math.max(0, Math.min(target.pos, String(dstEl.value || '').length));
  if (dstEl === srcEl) {
    if (insertAt >= start && insertAt <= end) return; // 落回自己身上
    let v = srcEl.value;
    v = v.slice(0, start) + v.slice(end);
    if (insertAt > start) insertAt -= (end - start);
    srcEl.value = v.slice(0, insertAt) + token + v.slice(insertAt);
    srcEl.dispatchEvent(new Event('input', { bubbles: true }));
    srcEl.dispatchEvent(new Event('change', { bubbles: true }));
    flashAndSelect(srcEl, insertAt, insertAt + token.length);
  } else {
    // 跨框搬家：源框删除，目标框插入
    const sv = srcEl.value;
    srcEl.value = sv.slice(0, start) + sv.slice(end);
    srcEl.dispatchEvent(new Event('input', { bubbles: true }));
    srcEl.dispatchEvent(new Event('change', { bubbles: true }));
    const dv = dstEl.value;
    dstEl.value = dv.slice(0, insertAt) + token + dv.slice(insertAt);
    dstEl.dispatchEvent(new Event('input', { bubbles: true }));
    dstEl.dispatchEvent(new Event('change', { bubbles: true }));
    flashAndSelect(dstEl, insertAt, insertAt + token.length);
  }
});

// ---------------- 气泡换绑菜单：单击气泡 → 全部参考的可滚动清单，点选当场换绑 ----------------
let mbSwapMenuEl = null;
function mbSwapClose() {
  if (!mbSwapMenuEl) return;
  if (mbSwapMenuEl._closer) document.removeEventListener('pointerdown', mbSwapMenuEl._closer, true);
  if (mbSwapMenuEl._keyer) document.removeEventListener('keydown', mbSwapMenuEl._keyer, true);
  mbSwapMenuEl.remove();
  mbSwapMenuEl = null;
  if (typeof pvKill === 'function') pvKill(); // 关菜单同时收掉悬停大预览
}
function mbShowSwapMenu(entry, token, start, end, evt) {
  mbSwapClose();
  const el = entry.el;
  // 原 token 可能是别名写法（@图1/@img2）→ 折算成规范键，用来标出「当前」项
  const pm = /^@(image|img|图|圖|video|vid|视频|audio|aud|音频)(\d+)$/i.exec(token);
  const curCanon = pm ? ((MENTION_ALIAS[pm[1].toLowerCase()] || MENTION_ALIAS[pm[1]]) + Number(pm[2])) : null;
  const items = dirMentionTokens();
  const menu = document.createElement('div');
  menu.className = 'mention-menu mb-swap-menu';
  const head = document.createElement('div');
  head.className = 'mbs-head';
  head.textContent = `把 ${token} 换成：`;
  menu.appendChild(head);
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'm-empty';
    empty.textContent = '参考区还没有素材 — 先在左侧添加';
    menu.appendChild(empty);
  }
  items.forEach((t) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'm-item mbs-item' + (t.token === curCanon ? ' current' : '');
    btn.dataset.pvKind = t.kind; // 悬停大预览
    btn.dataset.pvUrl = t.url;
    if (t.kind === 'image') {
      const img = document.createElement('img');
      img.className = 'm-thumb';
      img.src = t.url;
      btn.appendChild(img);
    } else if (t.kind === 'video') {
      const img = document.createElement('img');
      img.className = 'm-thumb';
      img.loading = 'lazy';
      img.src = '/api/media/thumb?src=' + encodeURIComponent(t.url);
      img.onerror = () => { img.style.visibility = 'hidden'; };
      btn.appendChild(img);
    } else {
      const ic = document.createElement('span');
      ic.className = 'm-icon';
      ic.textContent = DIR_KIND_META[t.kind].icon;
      btn.appendChild(ic);
    }
    const tok = document.createElement('span');
    tok.className = 'm-token';
    tok.textContent = '@' + t.token;
    const name = document.createElement('span');
    name.className = 'm-name';
    name.textContent = (t.role ? t.role[0] + ' · ' : '') + (t.name || t.zhLabel);
    btn.appendChild(tok);
    btn.appendChild(name);
    if (t.token === curCanon) {
      const cur = document.createElement('span');
      cur.className = 'mbs-cur';
      cur.textContent = '当前';
      btn.appendChild(cur);
    }
    btn.onmousedown = (ev) => ev.preventDefault(); // 不抢输入框焦点
    btn.onclick = () => {
      mbSwapClose();
      const newTok = '@' + t.token;
      if (t.token === curCanon) { flashAndSelect(el, start, end); return; } // 点当前项 = 只定位不改
      const v = el.value;
      el.value = v.slice(0, start) + newTok + v.slice(end);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      flashAndSelect(el, start, start + newTok.length);
      setDirStatus(`已把 ${token} 换成 ${newTok} ✓`);
    };
    menu.appendChild(btn);
  });
  document.body.appendChild(menu);
  // 定位：优先贴气泡下沿，退回鼠标点；视口裁剪（隐藏窗格 innerWidth=0 时也不出负值）
  let ax = evt && evt.clientX || 0, ay = (evt && evt.clientY || 0) + 12;
  const bub = entry.overlay.querySelector(`.mention-bubble[data-start="${start}"]`);
  if (bub) {
    const r = bub.getBoundingClientRect();
    if (r.width || r.height) { ax = r.left; ay = r.bottom + 4; }
  }
  const vw = window.innerWidth || 1280, vh = window.innerHeight || 800;
  menu.style.left = Math.max(8, Math.min(ax, vw - (menu.offsetWidth || 300) - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(ay, vh - (menu.offsetHeight || 220) - 8)) + 'px';
  mbSwapMenuEl = menu;
  // 外点 / Esc 关闭（推迟到下一轮事件，免得本次点击立刻把菜单关掉）
  const closer = (ev2) => { if (!menu.contains(ev2.target)) mbSwapClose(); };
  const keyer = (ev2) => { if (ev2.key === 'Escape') mbSwapClose(); };
  menu._closer = closer;
  menu._keyer = keyer;
  setTimeout(() => {
    if (mbSwapMenuEl !== menu) return;
    document.addEventListener('pointerdown', closer, true);
    document.addEventListener('keydown', keyer, true);
  }, 0);
}

// ---------------- 悬停大预览：换绑菜单 / @补全菜单 / 对照 chip → 浮动大图（视频直接播放） ----------------
// 任何带 data-pv-url 的条目：悬停在旁边弹一块大预览（图 = 原图放大；视频 = 静音循环播放，
// poster 用服务端代表帧，起播前不闪黑）。同一时刻只有一块，移开/点击/菜单关闭即销毁。
let pvPopEl = null;
function pvKill() {
  if (!pvPopEl) return;
  const v = pvPopEl.querySelector('video');
  if (v) { try { v.pause(); } catch {} try { v.removeAttribute('src'); v.load(); } catch {} }
  pvPopEl.remove();
  pvPopEl = null;
}
document.addEventListener('mouseover', (e) => {
  if (!(e.target instanceof Element)) return;
  const host = e.target.closest('[data-pv-url]');
  if (!host) { return; }
  if (pvPopEl && pvPopEl._host === host) return;
  pvKill();
  const kind = host.dataset.pvKind || 'image';
  if (kind === 'audio') return; // 音频没有画面
  const pop = document.createElement('div');
  pop.className = 'mb-preview-pop i18n-skip';
  if (kind === 'video') {
    const v = document.createElement('video');
    v.poster = '/api/media/thumb?src=' + encodeURIComponent(host.dataset.pvUrl);
    v.src = host.dataset.pvUrl;
    v.muted = true; v.loop = true; v.autoplay = true; v.playsInline = true;
    pop.appendChild(v);
    v.play().catch(() => {});
  } else {
    const img = document.createElement('img');
    img.src = host.dataset.pvUrl;
    pop.appendChild(img);
  }
  pop._host = host;
  document.body.appendChild(pop);
  const r = host.getBoundingClientRect();
  const vw = window.innerWidth || 1280, vh = window.innerHeight || 800;
  const pw = 356, ph = 280; // 预估占位（CSS max-width/height 会实际约束）
  let x = r.right + 12;
  if (x + pw > vw - 8) x = Math.max(8, r.left - pw - 12);
  const y = Math.max(8, Math.min(r.top - 40, vh - ph - 8));
  pop.style.left = x + 'px';
  pop.style.top = y + 'px';
  pvPopEl = pop;
});
document.addEventListener('mouseout', (e) => {
  if (!(e.target instanceof Element) || !pvPopEl) return;
  const host = e.target.closest('[data-pv-url]');
  if (!host || pvPopEl._host !== host) return;
  if (e.relatedTarget instanceof Element && host.contains(e.relatedTarget)) return;
  pvKill();
});
document.addEventListener('pointerdown', () => { pvKill(); }); // 任意点击（选中/外点/关菜单）即收

// ---------------- ✍ 提示词区折叠：一键收起露出历史；跳转定位时自动展开 ----------------
(() => {
  const btn = $('dirPromptCollapse');
  const panel = $('dirPromptPanel');
  if (!btn || !panel) return;
  const KEY = 'a452DirPromptCollapsed';
  const apply = (collapsed) => {
    panel.classList.toggle('collapsed', collapsed);
    btn.title = collapsed ? '展开提示词区' : '收起整个提示词区，露出下方的历史生成';
  };
  apply(localStorage.getItem(KEY) === '1');
  // h2 是面板拖拽把手 —— 箭头点击不能触发拖拽
  btn.addEventListener('mousedown', (e) => e.stopPropagation());
  btn.addEventListener('pointerdown', (e) => e.stopPropagation());
  btn.onclick = (e) => {
    e.stopPropagation();
    const collapsed = !panel.classList.contains('collapsed');
    apply(collapsed);
    try { localStorage.setItem(KEY, collapsed ? '1' : '0'); } catch {}
  };
})();
// 问题引用/气泡定位跳进被收起的提示词区时先自动展开（flashAndSelect 是所有定位的必经之路）
if (typeof flashAndSelect === 'function') {
  const _flash = flashAndSelect;
  flashAndSelect = function (el, start, end) {
    const collapsed = el && el.closest && el.closest('#dirPromptPanel.collapsed');
    if (collapsed) {
      collapsed.classList.remove('collapsed');
      try { localStorage.setItem('a452DirPromptCollapsed', '0'); } catch {}
    }
    return _flash(el, start, end);
  };
}

// ---------------- 历史滚动盒：高度实时钉在「预览屏下沿 → 视口底」之间 ----------------
(() => {
  const sticky = $('dirPlayerSticky');
  const hist = $('dirHistory');
  if (!sticky || !hist) return;
  const sync = () => {
    // 预览钉在 top:58px；历史盒最大高度 = 视口 - 预览底部 - 面板内衬余量
    const max = Math.max(180, (window.innerHeight || 800) - 58 - sticky.offsetHeight - 34);
    hist.style.maxHeight = max + 'px';
  };
  if (window.ResizeObserver) new ResizeObserver(sync).observe(sticky);
  window.addEventListener('resize', sync);
  const v = $('dirResult');
  if (v) v.addEventListener('loadedmetadata', sync); // 视频换源改变播放器高度时同步
  sync();
})();

// ---------------- 直连出片（免 API）：把最终提示词 + 素材包自动填进外部平台 ----------------
let simFilesList = [];
(() => {
  const row = $('simExtRow');
  const btn = $('simSendExt');
  if (!row || !btn) return;
  // 仅桌面版可用；浏览器里保持隐藏
  const showRow = () => { row.hidden = !(window.a452Native && window.a452Native.extGenOpen); };
  showRow();
  const _show = showSimResult;
  showSimResult = function (json) {
    simFilesList = (json && json.files || []).filter((f) => !/\.txt$/i.test(f));
    showRow();
    return _show(json);
  };
  const PLATFORM_URLS = {
    runway: 'https://app.runwayml.com/',
    pika: 'https://pika.art/',
    kling: 'https://app.klingai.com/',
    hailuo: 'https://hailuoai.video/',
    dreamina: 'https://jimeng.jianying.com/',
  };
  const buildFiles = async () => {
    const tk = await fetch('/api/extgen/token').then((r) => r.json());
    // 顺序 = simFilesList 顺序 = keyframe01… → image1… → video1… → audio1…（编号即导入顺序）
    return simFilesList.map((name) => ({
      name,
      url: location.origin + '/api/extgen/file?path=' + encodeURIComponent(simFolder + '\\' + name) + '&t=' + tk.token,
    }));
  };
  let statusPoll = null;
  const PHASE_TEXT = {
    queued: '任务已排队 — 去 Chrome 的平台标签页（已自动打开），扩展会在 2 秒内认领',
    claimed: '✓ Chrome 扩展已认领任务，正在找提示词输入框…',
    'prompt-filled': '✓ 提示词已填入，开始按顺序导入素材…',
    importing: '正在按顺序导入素材',
    done: '✓ 全部完成 — 提示词已填入、素材按序导入。生成按钮由你亲自点',
    error: '⚠ 扩展报告问题',
  };
  const watchStatus = (id) => {
    if (statusPoll) clearInterval(statusPoll);
    let quiet = 0;
    statusPoll = setInterval(async () => {
      try {
        const s = await fetch('/api/extgen/status?id=' + id).then((r) => r.json());
        const base = PHASE_TEXT[s.phase] || s.phase;
        $('simStatus').textContent = base + (s.detail ? `：${s.detail}` : '');
        if (s.phase === 'done' || s.phase === 'error') { clearInterval(statusPoll); statusPoll = null; }
        if (s.phase === 'queued' && ++quiet > 20) { // 40 秒没人认领 → 提示装扩展
          $('simStatus').textContent = '⚠ 任务无人认领 — Chrome 里可能还没装扩展（点 🧩 装扩展），或平台标签页没开。提示词已在剪贴板、素材包文件夹已打开作兜底。';
          clearInterval(statusPoll); statusPoll = null;
        }
      } catch {}
    }, 2000);
  };
  // 主通道：真实 Chrome + 扩展（登录态现成；素材严格按编号顺序逐个导入）
  btn.onclick = async () => {
    if (!simFolder) { $('simStatus').textContent = '⚠ 先完成一次 SIMULATE GEN 再直连'; return; }
    btn.disabled = true;
    $('simStatus').textContent = '排队直连任务…';
    try {
      const platform = $('simExtPlatform').value;
      const prof = (window.a452Native && window.a452Native.extGenProfile)
        ? await window.a452Native.extGenProfile(platform) : null;
      const files = await buildFiles();
      const q = await fetch('/api/extgen/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          platform,
          prompt: $('simPromptText').value,
          files,
          promptSelectors: (prof && prof.promptSelectors) || [],
          fileSelectors: (prof && prof.fileSelectors) || [],
        }),
      }).then((r) => r.json());
      // 兜底照旧：剪贴板 + 素材文件夹（走备用窗口通道的主进程会做；这里直接复制）
      try { await navigator.clipboard.writeText($('simPromptText').value); } catch {}
      // 在用户默认浏览器（Chrome）里打开平台 —— 主窗口的外链策略会转交系统浏览器
      window.open((prof && prof.url) || PLATFORM_URLS[platform] || PLATFORM_URLS.runway, '_blank');
      watchStatus(q.id);
      $('simStatus').textContent = PHASE_TEXT.queued;
    } catch (e) {
      $('simStatus').textContent = '⚠ 直连失败: ' + errMsg(e);
    } finally {
      btn.disabled = false;
    }
  };
  // 一次性安装扩展
  const installBtn = $('simExtInstall');
  if (installBtn) installBtn.onclick = async () => {
    if (!(window.a452Native && window.a452Native.extGenExtDir)) return;
    const dir = await window.a452Native.extGenExtDir();
    $('simStatus').textContent = `扩展文件夹已打开：${dir}\n安装：Chrome 地址栏输入 chrome://extensions → 右上角打开「开发者模式」→「加载已解压的扩展程序」→ 选这个文件夹。装一次永久生效。`;
  };
  // 备用通道：应用内置窗口（不装扩展也能用，需单独登录一次）
  const winBtn = $('simSendExtWin');
  if (winBtn) winBtn.onclick = async () => {
    if (!(window.a452Native && window.a452Native.extGenOpen)) return;
    if (!simFolder) { $('simStatus').textContent = '⚠ 先完成一次 SIMULATE GEN 再直连'; return; }
    winBtn.disabled = true;
    try {
      const files = await buildFiles();
      const res = await window.a452Native.extGenOpen({
        platform: $('simExtPlatform').value,
        prompt: $('simPromptText').value,
        files,
        folder: simFolder,
      });
      $('simStatus').textContent = res && res.ok
        ? `已打开 ${res.name} 备用窗口：自动填充中（只填不点生成）。首次使用请先在该窗口登录 — 登录态会记住。`
        : '⚠ 直连失败: ' + ((res && res.error) || '未知错误');
    } catch (e) {
      $('simStatus').textContent = '⚠ 直连失败: ' + errMsg(e);
    } finally {
      winBtn.disabled = false;
    }
  };
})();

// ---------------- 🔑 API Key 钥匙串：多账号管理 / 一键切换 / 随时监控 ----------------
async function renderKeychain() {
  const wrap = $('keyList');
  if (!wrap) return;
  let data;
  try {
    data = await fetch('/api/keychain').then((r) => r.json());
  } catch (e) {
    wrap.innerHTML = `<div class="hint">读取失败: ${escapeHtml(errMsg(e))}</div>`;
    return;
  }
  wrap.innerHTML = '';
  const fmtT = (t) => (t ? new Date(t).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
  for (const [pf, group] of Object.entries(data.platforms || {})) {
    const sec = document.createElement('section');
    sec.className = 'key-platform';
    const activeEntry = group.entries.find((e) => e.active);
    sec.innerHTML = `
      <div class="key-pf-head">
        <b>${escapeHtml(group.label)}</b>
        <span class="key-pf-active">${activeEntry
          ? `当前生效：<b>${escapeHtml(activeEntry.label || '未命名')}</b> · ${escapeHtml(activeEntry.masked)}`
          : '当前无生效 Key'}</span>
      </div>`;
    const list = document.createElement('div');
    list.className = 'key-rows';
    if (!group.entries.length) {
      const empty = document.createElement('div');
      empty.className = 'hint';
      empty.textContent = '还没有 Key — 在下面添加';
      list.appendChild(empty);
    }
    for (const en of group.entries) {
      const row = document.createElement('div');
      row.className = 'key-row' + (en.active ? ' active' : '');
      row.innerHTML = `
        <span class="key-active-dot" title="${en.active ? '当前生效' : '未启用'}">${en.active ? '●' : '○'}</span>
        <input class="key-label" value="${escapeHtml(en.label || '')}" maxlength="40" placeholder="账号备注" title="点击可改名，回车保存">
        <code class="key-masked" title="Key 只显示掩码，完整内容永不回传界面">${escapeHtml(en.masked)}</code>
        <span class="key-times hint" title="添加时间 / 最近启用">${fmtT(en.addedAt)} · ${en.activatedAt ? '启用 ' + fmtT(en.activatedAt) : '未用过'}</span>
        ${en.active ? '<span class="key-in-use">生效中</span>' : '<button type="button" class="btn key-use">启用</button>'}
        <button type="button" class="btn ghost key-del" title="删除这把 Key">🗑</button>`;
      const labelInput = row.querySelector('.key-label');
      const saveLabel = async () => {
        await fetch('/api/keychain/label', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ platform: pf, id: en.id, label: labelInput.value.trim() }) });
        $('keyStatus').textContent = '备注已保存 ✓';
      };
      labelInput.addEventListener('change', saveLabel);
      labelInput.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); labelInput.blur(); } });
      const useBtn = row.querySelector('.key-use');
      if (useBtn) useBtn.onclick = async () => {
        const r = await fetch('/api/keychain/select', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ platform: pf, id: en.id }) }).then((x) => x.json());
        $('keyStatus').textContent = r.ok ? `已切换 ${group.label} 当前生效 Key ✓ 立即对所有生成生效` : ('⚠ ' + (r.error || '切换失败'));
        await renderKeychain();
        if (typeof refreshConfig === 'function') refreshConfig(); // 顶栏模式徽标/hasKey 状态同步
      };
      row.querySelector('.key-del').onclick = async () => {
        if (!confirm(`删除 ${group.label} 的「${en.label || en.masked}」？\n（仅从钥匙串移除，不影响平台账号本身）`)) return;
        const r = await fetch('/api/keychain/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ platform: pf, id: en.id }) }).then((x) => x.json());
        $('keyStatus').textContent = r.ok ? '已删除 ✓' + (en.active ? '（生效 Key 已自动切到列表首位）' : '') : ('⚠ ' + (r.error || '删除失败'));
        await renderKeychain();
        if (typeof refreshConfig === 'function') refreshConfig();
      };
      list.appendChild(row);
    }
    // 添加行
    const addRow = document.createElement('div');
    addRow.className = 'key-add-row';
    addRow.innerHTML = `
      <input class="key-add-label" placeholder="账号备注（如：主号 / 小号2）" maxlength="40">
      <input class="key-add-key" type="password" placeholder="粘贴 ${escapeHtml(group.label)} 的 API Key" autocomplete="off">
      <label class="check" title="添加后立即设为当前生效"><input type="checkbox" class="key-add-activate" checked> 立即启用</label>
      <button type="button" class="btn primary key-add-btn">＋ 添加</button>`;
    addRow.querySelector('.key-add-btn').onclick = async () => {
      const key = addRow.querySelector('.key-add-key').value.trim();
      if (!key) { $('keyStatus').textContent = '⚠ 先粘贴 Key'; return; }
      const r = await fetch('/api/keychain/add', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          platform: pf,
          label: addRow.querySelector('.key-add-label').value.trim(),
          key,
          activate: addRow.querySelector('.key-add-activate').checked,
        }),
      }).then((x) => x.json());
      $('keyStatus').textContent = r.ok ? '已添加 ✓' : ('⚠ ' + (r.error || '添加失败'));
      await renderKeychain();
      if (typeof refreshConfig === 'function') refreshConfig();
    };
    sec.appendChild(list);
    sec.appendChild(addRow);
    wrap.appendChild(sec);
  }
}
if ($('btnKeychain')) {
  $('btnKeychain').onclick = async () => {
    $('keyStatus').textContent = '';
    $('keyDialog').showModal();
    await renderKeychain();
  };
  $('keyClose').onclick = () => $('keyDialog').close();
  $('keyRefresh').onclick = () => renderKeychain();
  $('keyDialog').addEventListener('click', (e) => { if (e.target === $('keyDialog')) $('keyDialog').close(); });
}

// ---------------- REFERENCES TOOL 多场景：并行工作台，＋ 开新实例，切换零丢失 ----------------
// 每个场景 = 完整独立的一套导演态（参考素材+双档记忆 / CONTEXT / CUT / 负面 / 情绪锁 /
// 模型 / 时长 / 帧率 / 演技滑杆 / 生成历史）。切换时先把当前活场景捕获进 state.dirScenes，
// 再装载目标场景；保存管线（snapshot）每次都同步捕获 → 重启后原样恢复。
const DIR_ACT_IDS = ['dirActOverall', 'dirActFace', 'dirActBody', 'dirActTempo', 'dirActVelocity', 'dirActFx', 'dirActPhysics'];

function ensureDirScenes() {
  if (!Array.isArray(state.dirScenes) || !state.dirScenes.length) {
    state.dirScenes = [{ id: 'sc-' + Date.now().toString(36), name: '场景 1', data: null }];
    state.dirSceneActive = 0;
  }
  if (typeof state.dirSceneActive !== 'number' || state.dirSceneActive < 0 || state.dirSceneActive >= state.dirScenes.length) {
    state.dirSceneActive = 0;
  }
  return state.dirScenes;
}

/** 当前活着的导演态（DOM + state）→ 可序列化场景数据 */
function captureDirectorLive() {
  const acting = {};
  for (const id of DIR_ACT_IDS) acting[id] = $(id) ? Number($(id).value) : 0;
  return {
    first: state.director.first,
    last: state.director.last,
    refVideo: state.director.refVideo,
    refVideoName: state.director.refVideoName,
    animMode: $('dirAnimMode') ? $('dirAnimMode').value : (state.director.animMode || '12fps'),
    model: $('dirModel') ? $('dirModel').value : '',
    refs: state.director.refs,
    refsStash: state.director.refsStash,
    refTier: state.director.refTier,
    cuts: state.director.cuts,
    negative: $('dirNegative') ? $('dirNegative').value : (state.director.negative || ''),
    mood: state.director.mood,
    context: $('dirPrompt') ? $('dirPrompt').value : '',
    history: state.director.history,
    current: state.director.current,
    duration: $('dirDuration') ? Number($('dirDuration').value) : 5,
    audio: $('dirAudio') ? $('dirAudio').checked : false,
    acting,
    evergreen: state.director.evergreen, // undefined = 沿用全局（序列化时自动省键）
  };
}

/** 场景数据 → 装回 live（state + DOM + 全部渲染）。loadProject 与场景切换共用 */
function applyDirectorData(dr) {
  dr = dr || {};
  state.director.first = dr.first || null;
  state.director.last = dr.last || null;
  state.director.refVideo = dr.refVideo || null;
  state.director.refVideoName = dr.refVideoName || '';
  state.director.animMode = dr.animMode || '12fps';
  if ($('dirAnimMode')) $('dirAnimMode').value = state.director.animMode;
  if ($('dirModel')) {
    // 模型选择随场景持久化；空白场景归位「跟随全局档位」
    const m = typeof dr.model === 'string' ? dr.model : '';
    const opt = Array.from($('dirModel').options).some((o) => o.value === m);
    $('dirModel').value = opt ? m : '';
  }
  state.director.refs = Array.isArray(dr.refs) ? dr.refs : [];
  state.director.refsStash = (dr.refsStash && typeof dr.refsStash === 'object') ? dr.refsStash : { t20: [], t25: [] };
  state.director.refTier = dr.refTier || null;
  state.director.cuts = Array.isArray(dr.cuts) ? dr.cuts : [];
  state.director.negative = typeof dr.negative === 'string' ? dr.negative : '';
  state.director.mood = typeof dr.mood === 'string' ? dr.mood : '';
  if ($('dirMood')) $('dirMood').value = state.director.mood;
  if ($('dirPrompt')) $('dirPrompt').value = typeof dr.context === 'string' ? dr.context : '';
  if ($('dirNegative')) $('dirNegative').value = state.director.negative;
  state.director.history = Array.isArray(dr.history) ? dr.history : [];
  state.director.current = (typeof dr.current === 'number' && dr.current >= 0 && dr.current < state.director.history.length)
    ? dr.current : (state.director.history.length ? 0 : -1);
  if ($('dirDuration')) {
    $('dirDuration').value = Number(dr.duration) >= 4 ? Number(dr.duration) : 5;
    $('dirDuration').dispatchEvent(new Event('input', { bubbles: true }));
  }
  if ($('dirAudio')) $('dirAudio').checked = !!dr.audio;
  const acting = dr.acting || {};
  for (const id of DIR_ACT_IDS) {
    const el = $(id);
    if (!el) continue;
    el.value = Number(acting[id]) || 0;
    el.dispatchEvent(new Event('input', { bubbles: true })); // 标签/预览沿用现有 handler
  }
  // 场景私有常青：undefined = 沿用 🌲 全局；字符串（含空）= 本场景专属
  state.director.evergreen = (typeof dr.evergreen === 'string') ? dr.evergreen : undefined;
  if (typeof egPanelLoad === 'function') { try { egPanelLoad(); } catch {} }
}

/** 场景切换后的整面重渲染（loadProject 尾部本来就会 renderAll，这里给切换用） */
function dirSceneRerender() {
  dirEnsureCuts();
  renderDirCuts();
  dirSyncTier(); // 内含 renderDirRefs + updateDirGoModel
  renderDirector();
  if (typeof renderMentionPreview === 'function') renderMentionPreview();
  // 播放器复位：不跨场景残留上一场的画面
  const v = $('dirResult');
  if (v) {
    const cur = state.director.history[state.director.current];
    if (cur && cur.videoUrl) { v.src = cur.videoUrl; v.hidden = false; }
    else { v.removeAttribute('src'); v.hidden = true; }
  }
  if ($('dirResultEmpty')) $('dirResultEmpty').hidden = !!(state.director.history || []).length;
  if ($('dirFrameGrabRow')) $('dirFrameGrabRow').hidden = !(state.director.history || []).length;
  if (typeof restoreDirectorUI === 'function') restoreDirectorUI();
}

/** 快照钩子：保存前把活场景捕获回场景集（重启后 DOM 字段也原样回来） */
function dirScenesSnapshot() {
  ensureDirScenes();
  const sc = state.dirScenes[state.dirSceneActive];
  if (sc && $('dirPrompt')) sc.data = captureDirectorLive();
  return state.dirScenes.map((s) => ({ id: s.id, name: s.name, data: s.data }));
}

function dirSceneSwitch(idx) {
  ensureDirScenes();
  if (idx === state.dirSceneActive || idx < 0 || idx >= state.dirScenes.length) return;
  state.dirScenes[state.dirSceneActive].data = captureDirectorLive();
  state.dirSceneActive = idx;
  applyDirectorData(state.dirScenes[idx].data || {});
  dirSceneRerender();
  renderDirSceneTabs();
  scheduleSave();
  setDirStatus(`已切到「${state.dirScenes[idx].name}」— 各场景互相独立，随切随回`);
}

function dirSceneAdd() {
  ensureDirScenes();
  state.dirScenes[state.dirSceneActive].data = captureDirectorLive();
  const n = state.dirScenes.length + 1;
  state.dirScenes.push({ id: 'sc-' + Date.now().toString(36), name: `场景 ${n}`, data: null });
  state.dirSceneActive = state.dirScenes.length - 1;
  applyDirectorData({ evergreen: '' }); // 全新空白实例：常青也清空（本场景不注入，需要就现写或点「沿用全局」）
  dirSceneRerender();
  renderDirSceneTabs();
  scheduleSave();
  setDirStatus('已开新空白场景 — 原场景完好保存在左边的标签里');
}

function dirSceneRemove(idx) {
  ensureDirScenes();
  if (state.dirScenes.length <= 1) { setDirStatus('至少保留一个场景'); return; }
  const sc = state.dirScenes[idx];
  const hasStuff = sc && sc.data && ((sc.data.refs || []).length || (sc.data.history || []).length || (sc.data.context || '').trim());
  const liveStuff = idx === state.dirSceneActive && (state.director.refs.length || state.director.history.length || ($('dirPrompt') && $('dirPrompt').value.trim()));
  if ((hasStuff || liveStuff) && !confirm(`删除「${sc.name}」？该场景的提示词、参考素材与生成历史将一并移除（生成的视频文件仍在磁盘）。`)) return;
  state.dirScenes.splice(idx, 1);
  if (state.dirSceneActive >= state.dirScenes.length) state.dirSceneActive = state.dirScenes.length - 1;
  else if (idx < state.dirSceneActive) state.dirSceneActive -= 1;
  else if (idx === state.dirSceneActive) {
    applyDirectorData(state.dirScenes[state.dirSceneActive].data || {});
    dirSceneRerender();
  }
  renderDirSceneTabs();
  scheduleSave();
}

function renderDirSceneTabs() {
  const bar = $('dirSceneTabs');
  if (!bar) return;
  ensureDirScenes();
  bar.innerHTML = '';
  state.dirScenes.forEach((sc, i) => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'dir-scene-tab' + (i === state.dirSceneActive ? ' active' : '');
    tab.title = '单击切换 · 双击改名';
    const label = document.createElement('span');
    label.textContent = sc.name || `场景 ${i + 1}`;
    tab.appendChild(label);
    if (state.dirScenes.length > 1) {
      const x = document.createElement('span');
      x.className = 'dir-scene-x';
      x.textContent = '✕';
      x.title = '删除这个场景';
      x.onclick = (e) => { e.stopPropagation(); dirSceneRemove(i); };
      tab.appendChild(x);
    }
    tab.onclick = () => dirSceneSwitch(i);
    tab.ondblclick = (e) => {
      e.preventDefault();
      const name = prompt('场景名称：', sc.name || '');
      if (name && name.trim()) { sc.name = name.trim().slice(0, 24); renderDirSceneTabs(); scheduleSave(); }
    };
    bar.appendChild(tab);
  });
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'dir-scene-add';
  add.textContent = '＋ 新场景';
  add.title = '开一个全新空白的 REFERENCES TOOL 实例 — 现有场景原样保留，随时切回';
  add.onclick = dirSceneAdd;
  bar.appendChild(add);
}
if ($('dirSceneTabs')) renderDirSceneTabs();
