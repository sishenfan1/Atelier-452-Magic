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
  const dataUrl = await fileToDataUrl(file);
  const res = await fetch('/api/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataUrl, name: file.name }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || '上传失败');
  return json.url;
}

// ---------------- 工程持久化 ----------------
let saveTimer = 0;
function scheduleSave() {
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
  };
}
function saveProject() {
  fetch('/api/project', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(snapshot()),
  }).catch(() => {});
}
async function loadProject() {
  try {
    const p = await (await fetch('/api/project')).json();
    if (!p || !p.images) return;
    nextImgId = p.nextImgId || 1;
    nextRefId = p.nextRefId || 1;
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
    if (st.globalPrompt) $('globalPrompt').value = st.globalPrompt;
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
    renderRefine();
    syncSliderLabels();
    rebuildSegments();
    renderAll();
    renderV2V();
  } catch (e) {
    console.warn('工程恢复失败', e);
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

// ---------------- 输入框聚焦自动展开 ----------------
function autoExpand(el, minH = 120) {
  const grow = () => {
    el.style.height = 'auto';
    el.style.height = Math.min(420, Math.max(el.scrollHeight + 4, minH)) + 'px';
  };
  el.addEventListener('focus', grow);
  el.addEventListener('input', () => { if (document.activeElement === el) grow(); });
  el.addEventListener('blur', () => { el.style.height = ''; });
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

// ---------------- 宏观时间轴：关键帧标记可拖拽调间距 ----------------
const MT_PAD = 44;        // 左右留白，容纳首尾缩略图
const MT_MIN_GAP = 0.1;   // 段最短 0.1s
const MT_MAX_GAP = 6;     // 段最长 6s
let mtKeyNodes = [];
let mtGapNodes = [];

function mtTimes() {
  const times = [0];
  for (const g of wholeTimings()) times.push(times[times.length - 1] + g);
  return times;
}

// 全量重建（结构变化时）
function renderMacroTimeline() {
  const el = $('macroTimeline');
  const hint = $('macroHint');
  mtKeyNodes = [];
  mtGapNodes = [];
  if (state.images.length < 2) {
    el.innerHTML = '';
    el.classList.remove('active');
    hint.hidden = false;
    return;
  }
  hint.hidden = true;
  el.classList.add('active');
  el.innerHTML = '<div class="mt-track"></div>';
  for (let i = 0; i < state.images.length - 1; i++) {
    const gap = document.createElement('div');
    gap.className = 'mt-gap';
    gap.onclick = () => openGapDialog(i);
    el.appendChild(gap);
    mtGapNodes.push(gap);
  }
  state.images.forEach((im, i) => {
    const k = document.createElement('div');
    k.className = 'mt-key' + (i === 0 ? ' fixed' : '');
    k.innerHTML = `<img src="${im.url}" draggable="false"><span class="mt-idx">${i + 1}</span><span class="mt-time"></span>`;
    if (i > 0) attachKeyDrag(k, i);
    el.appendChild(k);
    mtKeyNodes.push(k);
  });
  layoutMacroTimeline();
}

// 轻量布局（数值变化时，拖拽中高频调用）
function layoutMacroTimeline() {
  const el = $('macroTimeline');
  if (!el.classList.contains('active') || el.clientWidth === 0) return;
  const times = mtTimes();
  const total = Math.max(times[times.length - 1], 0.001);
  const scale = (el.clientWidth - MT_PAD * 2) / total;
  mtKeyNodes.forEach((k, i) => {
    k.style.left = (MT_PAD + times[i] * scale) + 'px';
    k.querySelector('.mt-time').textContent = times[i].toFixed(1) + 's';
  });
  mtGapNodes.forEach((g, i) => {
    const im = state.images[i];
    g.style.left = (MT_PAD + times[i] * scale) + 'px';
    g.style.width = Math.max(10, (times[i + 1] - times[i]) * scale) + 'px';
    const dur = (times[i + 1] - times[i]).toFixed(1);
    g.innerHTML = `<span>${dur}s${(im.gapPrompt || '').trim() ? ' ✎' : ''}${im.gapActing > 0 ? ' ★' + im.gapActing : ''}</span>`;
    g.title = (im.gapPrompt || '').trim() || '点击编辑本段动作 / 演技 / 时长';
  });
}

// 拖动关键帧 i：改变它与前一帧的间距（涟漪式，后续帧整体平移）
function attachKeyDrag(node, i) {
  node.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    node.setPointerCapture(e.pointerId);
    node.classList.add('dragging');
    const el = $('macroTimeline');
    const startTotal = Math.max(wholeTotalSeconds(), 0.001);
    const scale = (el.clientWidth - MT_PAD * 2) / startTotal; // 用按下瞬间的比例做换算
    const startX = e.clientX;
    const origGap = Number(state.images[i - 1].hold ?? 2);
    const onMove = (ev) => {
      const delta = (ev.clientX - startX) / scale;
      const g = Math.min(MT_MAX_GAP, Math.max(MT_MIN_GAP, origGap + delta));
      state.images[i - 1].hold = Math.round(g * 10) / 10;
      layoutMacroTimeline();
      updateWholeTotal();
    };
    const onUp = (ev) => {
      node.releasePointerCapture(ev.pointerId);
      node.classList.remove('dragging');
      node.removeEventListener('pointermove', onMove);
      node.removeEventListener('pointerup', onUp);
      renderImageList(); // 同步左侧小滑杆并触发保存
      scheduleSave();
    };
    node.addEventListener('pointermove', onMove);
    node.addEventListener('pointerup', onUp);
  });
}

// 段落编辑弹窗
let gapDlgIdx = -1;
function openGapDialog(i) {
  gapDlgIdx = i;
  const im = state.images[i];
  $('gapDialogTitle').textContent = `段落 ${i + 1} → ${i + 2}（关键帧 ${i + 1} 到 ${i + 2} 之间）`;
  $('gapDlgSeconds').value = Number(im.hold ?? 2).toFixed(1);
  $('gapDlgActing').value = im.gapActing ?? 0;
  $('gapDlgActingVal').textContent = (im.gapActing ?? 0) > 0 ? im.gapActing : '全局';
  $('gapDlgPrompt').value = im.gapPrompt || '';
  $('gapDialog').showModal();
}

// ---------------- 模式切换 ----------------
function switchMode(mode) {
  stopPlayback();
  $('viewInbetween').hidden = mode !== 'inbetween';
  $('viewV2V').hidden = mode !== 'v2v';
  $('viewRefine').hidden = mode !== 'refine';
  $('tabInbetween').classList.toggle('active', mode === 'inbetween');
  $('tabV2V').classList.toggle('active', mode === 'v2v');
  $('tabRefine').classList.toggle('active', mode === 'refine');
  if (mode === 'inbetween') layoutMacroTimeline(); // 隐藏时宽度为 0，回来时重排
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
  const prompt = overrides.prompt ?? (seg.prompt || $('globalPrompt').value);
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
    await pollTask(seg, json.id, { prompt, seconds });
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
    const json = await res.json();
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
  const globalFrames = buildGlobalFrames();
  if (globalFrames.length === 0) {
    const pending = state.segments
      .map((s) => s.versions[s.active])
      .filter((v) => v && !v.frames);
    if (pending.length) {
      setBadge('抽帧准备中…');
      Promise.all(pending.map((v) => extractFrames(v).catch(() => {})))
        .then(() => { if (!state.playing) startPlayback(mode); });
    } else {
      setBadge('无可播放分段');
    }
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
  const ready = readySegments();
  if (ready.length === 0) {
    // 帧未抽也允许拼接：只要有成功版本
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
  const res = await fetch('/api/concat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ urls: ready.map((x) => x.ver.videoUrl), fps: PREVIEW_FPS }),
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
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || '转码失败');
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
    const p = await (await fetch('/api/segments/' + taskId)).json();
    if (p.status === 'succeeded') return p;
    if (p.status === 'failed') throw new Error(p.error || '生成失败');
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
    const p = await pollUntilDone(json.id);
    const actingLevel = Number($('acting').value);
    state.whole.history.unshift({
      videoUrl: p.videoUrl,
      time: new Date().toLocaleString('zh-CN', { hour12: false }),
      duration: totalDur,
      frames,
      note,
      acting: actingLevel,
      actingTier: actingTier(actingLevel).name,
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
  const prompt = [$('refinePrompt').value.trim(), $('refineExtraPrompt').value.trim()].filter(Boolean).join('\n');
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
      note: $('refineExtraPrompt').value.trim(),
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
      <button class="btn dl">⬇</button>`;
    card.onclick = () => { rf.current = idx; renderRefine(); };
    card.querySelector('.dl').onclick = (e) => {
      e.stopPropagation();
      download(h.out, `refine_${rf.history.length - idx}.png`);
    };
    hist.appendChild(card);
  });
}

// ---------------- 提示词库（可拖拽浮动面板 · 分类存储 · JSON 转换器） ----------------
let presetTargetId = null;
let libTab = 'general'; // general | storyboard | qa | used | json
const LIB_CATS = ['general', 'storyboard', 'qa'];

function savePresets() {
  fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ presets: state.presets }),
  }).catch(() => {});
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

function libRow(p) {
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
    state.presets = state.presets.filter((x) => x.id !== p.id);
    savePresets();
    renderLibrary();
  };
  row.querySelector('.ledit').onclick = () => {
    // 行内编辑：名称 / 内容 / 分类
    row.classList.add('lib-edit');
    row.innerHTML = '';
    const nameIn = document.createElement('input');
    nameIn.type = 'text'; nameIn.className = 'input-base'; nameIn.value = p.name;
    const textIn = document.createElement('textarea');
    textIn.className = 'input-base'; textIn.rows = 3; textIn.value = p.text;
    const catSel = document.createElement('select');
    catSel.className = 'input-base';
    for (const c of LIB_CATS) {
      const o = document.createElement('option');
      o.value = c;
      o.textContent = c === 'general' ? t('通用') : c === 'storyboard' ? t('分镜') : t('质检');
      if ((p.category || 'general') === c) o.selected = true;
      catSel.appendChild(o);
    }
    const rowBtns = document.createElement('div');
    rowBtns.className = 'lib-new-row';
    const saveB = document.createElement('button');
    saveB.className = 'btn primary'; saveB.textContent = t('保存');
    saveB.onclick = () => {
      p.name = nameIn.value.trim() || p.name;
      p.text = textIn.value;
      p.category = catSel.value;
      savePresets();
      renderLibrary();
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
  // 页签高亮
  $('libTabs').querySelectorAll('button').forEach((b) =>
    b.classList.toggle('active', b.dataset.tab === libTab));
  const isCat = LIB_CATS.includes(libTab);
  $('libListPane').hidden = !isCat;
  $('libUsedPane').hidden = libTab !== 'used';
  $('libJsonPane').hidden = libTab !== 'json';

  if (isCat) {
    const list = $('libList');
    list.innerHTML = '';
    const items = state.presets.filter((p) => (p.category || 'general') === libTab);
    if (items.length === 0) {
      list.innerHTML = `<div class="hint">${t('此分类还没有提示词 — 在下方新建')}</div>`;
    }
    for (const p of items) list.appendChild(libRow(p));
    $('libNewCat').value = libTab;
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
        state.presets.push({ id: 'p' + Date.now(), name: u.text.slice(0, 24), text: u.text, category: 'general' });
        savePresets();
        libTab = 'general';
        renderLibrary();
      };
      used.appendChild(row);
    }
  }

  if (libTab === 'json') updateJsonPreview();
}

// ---- JSON 转换器：粘贴提示词 → 标准 JSON ----
function promptToJsonObj() {
  const raw = $('jsonInput').value.trim();
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
    name: $('jsonName').value.trim() || (prompt.slice(0, 24) || 'prompt'),
    category: $('jsonCat').value,
    prompt,
    negative,
    tags: [],
    createdAt: new Date().toISOString(),
    source: 'Atelier452 Prompt Library',
  };
}

function updateJsonPreview() {
  const raw = $('jsonInput').value.trim();
  $('jsonPreview').textContent = raw ? JSON.stringify(promptToJsonObj(), null, 2) : '';
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
    const p = await pollUntilDone(json.id);
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
      <button class="btn dl">⬇</button>`;
    card.onclick = () => { v.current = idx; renderV2V(); };
    card.querySelector('.dl').onclick = (e) => {
      e.stopPropagation();
      download(h.videoUrl, `v2v_${v.history.length - idx}.mp4`);
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
      autoExpand(gp, 80);
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
  return state.images.slice(0, -1).map((im) => ({
    seconds: Number(im.hold ?? 2),
    prompt: (im.gapPrompt || '').trim(),
    actingText: im.gapActing > 0 ? gapActingText(im.gapActing) : '',
  }));
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
      ${seg.error ? `<div class="err-msg">${seg.error}</div>` : ''}`;
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
  if (!$('stylePrompt').value) $('stylePrompt').value = cfg.stylePrompt || '';
  if (!$('inbetweenPrompt').value) $('inbetweenPrompt').value = cfg.inbetweenPrompt || '';
  if (!$('colorPrompt').value) $('colorPrompt').value = cfg.colorPrompt || '';
  if (!$('refinePrompt').value) $('refinePrompt').value = cfg.refinePrompt || '';
  state.presets = cfg.presets || [];
  state.usedPrompts = cfg.usedPrompts || [];
  return cfg;
}

// ---------------- 事件绑定 ----------------
$('tabInbetween').onclick = () => switchMode('inbetween');
$('tabV2V').onclick = () => switchMode('v2v');
$('tabRefine').onclick = () => switchMode('refine');

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
// 新建提示词（带分类）
$('libNewSave').onclick = () => {
  const text = $('libNewText').value.trim();
  if (!text) { libStatusMsg(t('当前提示词框是空的')); return; }
  const name = $('libNewName').value.trim() || text.slice(0, 24);
  const category = $('libNewCat').value;
  state.presets.push({ id: 'p' + Date.now(), name, text, category });
  $('libNewText').value = '';
  $('libNewName').value = '';
  savePresets();
  libTab = category;
  renderLibrary();
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
  state.presets.push({
    id: 'p' + Date.now(),
    name: o.name,
    text: o.prompt + (o.negative ? '\nnegative: ' + o.negative : ''),
    category: o.category,
  });
  savePresets();
  libTab = o.category;
  renderLibrary();
  libStatusMsg(t('已存入库') + ': ' + o.name);
};

$('btnRefine').onclick = refineGenerate;
$('btnRefineDownload').onclick = () => {
  const cur = state.refine.history[state.refine.current];
  if (cur) download(cur.out, 'refined.png');
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
  };
  if ($('cfgKey').value.trim()) body.apiKey = $('cfgKey').value.trim();
  if ($('cfgOpenaiKey').value.trim()) body.openaiKey = $('cfgOpenaiKey').value.trim();
  $('cfgOpenaiKey').value = '';
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
(() => {
  const p = new URLSearchParams(location.search).get('adwPrompt');
  if (!p) return;
  $('globalPrompt').value = p;
  scheduleSave();
  setWholeStatus('已接收来自 Director Workspace 的镜头提示词 ✓');
  history.replaceState(null, '', location.pathname);
})();

syncSliderLabels();
refreshConfig();
// 主要提示词框：聚焦自动展开
for (const id of ['globalPrompt', 'stylePrompt', 'inbetweenPrompt', 'colorPrompt', 'v2vExtraPrompt', 'detailPrompt', 'gapDlgPrompt', 'refinePrompt', 'refineExtraPrompt']) {
  autoExpand($(id));
}

// 段落编辑弹窗
$('gapDlgActing').oninput = (e) => {
  $('gapDlgActingVal').textContent = Number(e.target.value) > 0 ? e.target.value : '全局';
};
$('gapDlgSave').onclick = () => {
  const im = state.images[gapDlgIdx];
  if (im) {
    im.hold = Math.min(6, Math.max(0.1, Number($('gapDlgSeconds').value) || 2));
    im.gapActing = Number($('gapDlgActing').value) || 0;
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
loadProject();
