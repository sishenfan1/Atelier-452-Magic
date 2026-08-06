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
    refs: [],                         // 参考图 {id, name, url} ≤10
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
    r.onerror = rej;
    r.readAsDataURL(file);
  });
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
    director: {
      first: state.director.first,
      last: state.director.last,
      refVideo: state.director.refVideo,
      refVideoName: state.director.refVideoName,
      refs: state.director.refs,
      history: state.director.history,
    },
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
    const dr = p.director || {};
    state.director.first = dr.first || null;
    state.director.last = dr.last || null;
    state.director.refVideo = dr.refVideo || null;
    state.director.refVideoName = dr.refVideoName || '';
    state.director.refs = Array.isArray(dr.refs) ? dr.refs : [];
    state.director.history = Array.isArray(dr.history) ? dr.history : [];
    state.director.current = state.director.history.length ? 0 : -1;
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
  if (!img.closest('.image-item, .input-cell, .seg-card .pair')) return;
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
    inbetween: ['工作区 1', '中割生成'],
    v2v: ['工作区 2', '视频转绘上色'],
    refine: ['工作区 3', '原画精修'],
    library: ['工作区 4', '提示词库'],
    motion: ['工作区 5', '動作分析'],
    director: ['工作区 6', 'REFERENCES TOOL'],
  };
  const nm = MODE_NAMES[mode];
  if (nm) {
    $('modeCurrentKicker').textContent = nm[0];
    $('modeCurrentTitle').textContent = nm[1];
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
}

// ---------------- 关键帧管理 ----------------
async function addFiles(files) {
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue;
    try {
      const url = await uploadAsset(f);
      state.images.push({ id: nextImgId++, name: f.name, url, hold: 2 });
    } catch (e) {
      alert('上传失败: ' + e.message);
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
    seg.error = String(e.message || e);
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
    setExportStatus('导出失败: ' + (e.message || e));
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
    list.innerHTML = `<div class="hint">${t('保存失败')}: ${escapeHtml(String(e.message || e))}</div>`;
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
    showSaveToast(t('保存失败') + ': ' + String(e.message || e), false);
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
        finishJob(job, false, String(e.message || e));
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
        finishJob(job, false, String(e.message || e));
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
        finishJob(job, false, String(e.message || e));
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
          seg.error = String(e.message || e);
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
function setWholeStatus(t) { $('wholeStatus').textContent = t || ''; }

async function wholeGenerate() {
  if (state.images.length < 2) { alert('请先上传至少 2 张关键帧'); return; }
  if (state.images.length > 100) { alert('最多 100 张关键帧'); return; }
  if (state.images.length > 9 &&
      !confirm(`当前 ${state.images.length} 张关键帧，超过 Seedance 官方参考图上限（9 张），API 可能拒绝。仍要尝试提交吗？`)) return;
  // 提交时快照当前设置，允许随后立刻改设置再提交下一个任务并行跑
  const gaps = wholeGaps();
  const totalDur = Math.max(4, Math.min(15, Math.round(wholeTotalSeconds())));
  const frames = state.images.length;
  const note = $('globalPrompt').value.trim();
  const actingLevel = Number($('acting').value);
  const tierName = actingTier(actingLevel).name;
  const body = JSON.stringify({
    images: state.images.map((im) => im.url),
    prompt: note,
    stylePrompt: $('stylePrompt').value.trim(),
    inbetweenPrompt: $('inbetweenPrompt').value.trim(),
    actingPrompt: buildActingPrompt(),
    duration: totalDur,
    gaps,
  });
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
    finishJob(job, false, String(e.message || e));
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
      <video src="${h.videoUrl}" muted loop controls preload="metadata"></video>
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
    finishJob(job, false, String(e.message || e));
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
    const d = Math.max(4, Math.min(15, Math.round(v.duration)));
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
      alert('上传失败: ' + e.message);
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
    finishJob(job, false, String(e.message || e));
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
      <video src="${h.videoUrl}" muted preload="metadata"></video>
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
  const clamped = Math.max(4, Math.min(15, Math.round(t)));
  el.textContent = t.toFixed(1) + ' 秒' + (t < 4 || t > 15 ? `（超出范围，将按 ${clamped}s 生成）` : '');
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
        ? `<video src="${ver.videoUrl}" controls muted loop preload="metadata"></video>`
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
async function refreshConfig() {
  const res = await fetch('/api/config');
  const cfg = await res.json();
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
    alert('上传失败: ' + err.message);
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
    try { setRefineSource(await uploadAsset(f), f.name); } catch (err) { alert('上传失败: ' + err.message); }
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
    } catch (err) { alert('上传失败: ' + err.message); }
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
    } catch (err) { alert('上传失败: ' + err.message); }
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
    alert('上传失败: ' + err.message);
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
    try { setV2VSource(await uploadAsset(f), f.name); } catch (err) { alert('上传失败: ' + err.message); }
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
    setV2VStatus('失败: ' + e.message);
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
$('btnExportZip').onclick = () => exportZip().catch((e) => setExportStatus('导出失败: ' + e.message));

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
  $('cfgOpenaiKey').value = '';
  $('cfgAnthropicKey').value = '';
  const res = await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  $('cfgStatus').textContent = res.ok ? '已保存' : '保存失败';
  $('cfgKey').value = '';
  refreshConfig();
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
function setDirStatus(t) { $('dirStatus').textContent = t || ''; }

/** 四维演技滑杆 → 中文提示词片段（0 = 关闭该维度） */
function directorActingText() {
  const parts = [];
  const overall = Number($('dirActOverall').value);
  const face = Number($('dirActFace').value);
  const body = Number($('dirActBody').value);
  const tempo = Number($('dirActTempo').value);
  if (overall > 0) parts.push(`表演强度${overall}/100，${actingTier(overall).name}`);
  if (face > 0) parts.push(face >= 66 ? '表情大开大合、情绪外放到极致' : face >= 33 ? '表情鲜明、情绪清晰可读' : '微表情细腻克制');
  if (body > 0) parts.push(body >= 66 ? '肢体动作极度夸张、全身戏剧化表演' : body >= 33 ? '肢体语言丰富、动作幅度明显' : '肢体收敛、小幅度动作');
  if (tempo > 0) parts.push(tempo >= 66 ? '节奏急促爆发、动作干脆凌厉' : tempo >= 33 ? '节奏明快有张力' : '节奏沉稳缓慢、留白呼吸');
  return parts.join('，');
}
function syncDirActing() {
  const label = (v) => (v > 0 ? v : '关');
  $('dirActOverallVal').textContent = label(Number($('dirActOverall').value));
  $('dirActFaceVal').textContent = label(Number($('dirActFace').value));
  $('dirActBodyVal').textContent = label(Number($('dirActBody').value));
  $('dirActTempoVal').textContent = label(Number($('dirActTempo').value));
  const t = directorActingText();
  $('dirActPreview').textContent = t ? '→ ' + t : '';
}
for (const id of ['dirActOverall', 'dirActFace', 'dirActBody', 'dirActTempo']) {
  $(id).oninput = syncDirActing;
}

// 模型切换：时长上限联动（2.0 → 15s，2.5 → 30s）
$('dirModel').onchange = () => {
  const is25 = /2-5/.test($('dirModel').value);
  const slider = $('dirDuration');
  slider.max = is25 ? 30 : 15;
  if (Number(slider.value) > Number(slider.max)) slider.value = slider.max;
  $('dirDurationVal').textContent = slider.value + ' 秒';
  $('dirModelHint').textContent = is25
    ? '2.5：4-30 秒 · 480P/720P（1080P 自动降档）· 方舟 API 尚未开放调用，开放后此处即插即用'
    : '2.0：4-15 秒 · 使用 ⚙ API 设置里的当前模型与分辨率';
};
$('dirDuration').oninput = (e) => { $('dirDurationVal').textContent = e.target.value + ' 秒'; };

// 首帧 / 尾帧上传
function setDirFrame(slot, url, name) {
  state.director[slot] = url ? { url, name: name || '' } : null;
  const img = $(slot === 'first' ? 'dirFirstImg' : 'dirLastImg');
  const lbl = $(slot === 'first' ? 'dirFirstLabel' : 'dirLastLabel');
  if (url) { img.src = url; img.hidden = false; lbl.hidden = true; }
  else { img.hidden = true; img.removeAttribute('src'); lbl.hidden = false; }
  if (slot === 'last') $('dirLastClear').hidden = !url;
  scheduleSave();
}
$('dirFirstDrop').onclick = () => $('dirFirstFile').click();
$('dirLastDrop').onclick = () => $('dirLastFile').click();
$('dirFirstFile').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try { setDirFrame('first', await uploadAsset(f), f.name); setDirStatus(''); }
  catch (err) { setDirStatus('首帧上传失败: ' + (err.message || err)); }
};
$('dirLastFile').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try { setDirFrame('last', await uploadAsset(f), f.name); setDirStatus(''); }
  catch (err) { setDirStatus('尾帧上传失败: ' + (err.message || err)); }
};
$('dirLastClear').onclick = () => setDirFrame('last', null);

// 参考视频
$('dirRefVideoBtn').onclick = () => $('dirRefVideoFile').click();
$('dirRefVideoFile').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  setDirStatus('参考视频上传中…');
  try {
    const url = await uploadAsset(f);
    state.director.refVideo = url;
    state.director.refVideoName = f.name;
    restoreDirectorRefVideo();
    setDirStatus('');
    scheduleSave();
  } catch (err) { setDirStatus('参考视频上传失败: ' + (err.message || err)); }
};
$('dirRefVideoClear').onclick = () => {
  state.director.refVideo = null;
  state.director.refVideoName = '';
  restoreDirectorRefVideo();
  scheduleSave();
};
function restoreDirectorRefVideo() {
  const has = !!state.director.refVideo;
  $('dirRefVideoName').textContent = has ? state.director.refVideoName || '参考视频已就绪' : '未选择 — Seedance 会参考它的运动与节奏';
  $('dirRefVideoClear').hidden = !has;
  const v = $('dirRefVideoPreview');
  if (has) { v.src = state.director.refVideo; v.hidden = false; } else { v.hidden = true; v.removeAttribute('src'); }
}

// 参考图池（≤10）
function renderDirRefs() {
  const list = $('dirRefList');
  list.innerHTML = '';
  state.director.refs.forEach((r) => {
    const cell = document.createElement('div');
    cell.className = 'ref-cell';
    cell.innerHTML = `<img src="${r.url}" alt="${escapeHtml(r.name)}" title="${escapeHtml(r.name)}"><button type="button" aria-label="移除">✕</button>`;
    cell.querySelector('button').onclick = () => {
      state.director.refs = state.director.refs.filter((x) => x.id !== r.id);
      renderDirRefs();
      scheduleSave();
    };
    list.appendChild(cell);
  });
  $('dirRefAdd').disabled = state.director.refs.length >= 10;
}
$('dirRefAdd').onclick = () => $('dirRefFiles').click();
$('dirRefFiles').onchange = async (e) => {
  const files = Array.from(e.target.files || []).slice(0, 10 - state.director.refs.length);
  e.target.value = '';
  for (const f of files) {
    try {
      const url = await uploadAsset(f);
      state.director.refs.push({ id: nextRefId++, name: f.name, url });
    } catch (err) { setDirStatus('参考图上传失败: ' + (err.message || err)); }
  }
  renderDirRefs();
  scheduleSave();
};

// 生成
async function directorGenerate() {
  if (state.director.running) return;
  if (!state.director.first) { setDirStatus('请先上传首帧'); return; }
  const model = $('dirModel').value || undefined;
  const duration = Number($('dirDuration').value);
  const acting = directorActingText();
  const prompt = [$('dirPrompt').value.trim(), acting].filter(Boolean).join('\n');
  state.director.running = true;
  $('btnDirectorGen').disabled = true;
  setDirStatus('创建任务中…');
  const job = addJob(`🎬 导演生成 ${duration}s${model ? ' · 2.5' : ''}`, 60 + duration * 25);
  try {
    const res = await fetch('/api/director', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firstFrame: state.director.first.url,
        lastFrame: state.director.last ? state.director.last.url : null,
        refVideoUrl: state.director.refVideo || null,
        refImages: state.director.refs.map((r) => r.url),
        prompt, duration, model,
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
      duration, model: model || '2.0', note: $('dirPrompt').value.trim().slice(0, 120),
    });
    state.director.current = 0;
    renderDirector();
    setDirStatus('完成 ✓');
    finishJob(job, true);
    scheduleSave();
  } catch (e) {
    setDirStatus('失败: ' + String(e.message || e).slice(0, 400));
    finishJob(job, false, String(e.message || e));
  } finally {
    state.director.running = false;
    $('btnDirectorGen').disabled = false;
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
  const list = $('dirHistory');
  list.innerHTML = '';
  h.forEach((item, i) => {
    const card = document.createElement('div');
    card.className = 'gen-card' + (i === state.director.current ? ' playing' : '');
    card.innerHTML = `<div class="head"><b>${item.model === 'doubao-seedance-2-5-260628' ? '2.5' : '2.0'} · ${item.duration}s</b><span class="hint">${item.time}</span></div>
      <div class="hint">${escapeHtml(item.note || '')}</div>`;
    card.onclick = () => { state.director.current = i; renderDirector(); };
    list.appendChild(card);
  });
}
function restoreDirectorUI() {
  if (state.director.first) setDirFrame('first', state.director.first.url, state.director.first.name);
  if (state.director.last) setDirFrame('last', state.director.last.url, state.director.last.name);
  restoreDirectorRefVideo();
  renderDirRefs();
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
    if (seq === onionDrawSeq) setWholeStatus('洋葱皮绘制失败: ' + (err && err.message || err));
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
    $('motionStatus').textContent = '上传失败: ' + (err && err.message || err);
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
    $('motionStatus').textContent = String(err && err.message || err);
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
    setWholeStatus('镜头包接收失败: ' + (err && err.message || err));
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
