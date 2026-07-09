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

// ---------------- 模式切换 ----------------
function switchMode(mode) {
  stopPlayback();
  $('viewInbetween').hidden = mode !== 'inbetween';
  $('viewV2V').hidden = mode !== 'v2v';
  $('tabInbetween').classList.toggle('active', mode === 'inbetween');
  $('tabV2V').classList.toggle('active', mode === 'v2v');
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

async function extractFrames(version) {
  if (version.frames || version.extracting) return;
  version.extracting = true;
  try {
    await doExtractFrames(version);
  } finally {
    version.extracting = false;
  }
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

// ---------------- 一体生成：全部关键帧 → 单次连续动画 ----------------
function setWholeStatus(t) { $('wholeStatus').textContent = t || ''; }

async function wholeGenerate() {
  if (state.images.length < 2) { alert('请先上传至少 2 张关键帧'); return; }
  if (state.images.length > 9) { alert('Seedance 最多支持 9 张参考图，请减少关键帧'); return; }
  if (state.whole.running) return;
  state.whole.running = true;
  $('btnWhole').disabled = true;
  setWholeStatus('提交一体生成任务中…');
  const timings = wholeTimings();
  const totalDur = Math.max(4, Math.min(15, Math.round(wholeTotalSeconds())));
  try {
    const res = await fetch('/api/whole', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        images: state.images.map((im) => im.url),
        prompt: $('globalPrompt').value.trim(),
        stylePrompt: $('stylePrompt').value.trim(),
        actingPrompt: buildActingPrompt(),
        duration: totalDur,
        timings,
      }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || res.statusText);
    const t0 = Date.now();
    for (;;) {
      await new Promise((r) => setTimeout(r, 4000));
      const p = await (await fetch('/api/segments/' + json.id)).json();
      if (p.status === 'succeeded') {
        state.whole.history.unshift({
          videoUrl: p.videoUrl,
          time: new Date().toLocaleString('zh-CN', { hour12: false }),
          duration: totalDur,
          frames: state.images.length,
          note: $('globalPrompt').value.trim(),
        });
        state.whole.current = 0;
        setWholeStatus('一体生成完成');
        renderWhole();
        scheduleSave();
        return;
      }
      if (p.status === 'failed') throw new Error(p.error || '生成失败');
      setWholeStatus(`一体生成中… ${Math.round((Date.now() - t0) / 1000)}s（${state.images.length} 张关键帧 → ${totalDur}s 成片）`);
    }
  } catch (e) {
    setWholeStatus('失败: ' + (e.message || e));
  } finally {
    state.whole.running = false;
    $('btnWhole').disabled = false;
  }
}

function renderWhole() {
  const w = state.whole;
  const cur = w.history[w.current];
  $('wholeResult').hidden = !cur;
  $('wholeResultEmpty').hidden = !!cur;
  if (cur && $('wholeResult').getAttribute('src') !== cur.videoUrl) $('wholeResult').src = cur.videoUrl;
  const hist = $('wholeHistory');
  hist.innerHTML = '';
  w.history.forEach((h, idx) => {
    const card = document.createElement('div');
    card.className = 'hist-card' + (idx === w.current ? ' active' : '');
    card.innerHTML = `
      <video src="${h.videoUrl}" muted preload="metadata"></video>
      <div class="meta"><b>版本 ${w.history.length - idx}</b>
        ${escapeHtml(h.time)} · ${h.duration}s · ${h.frames} 张关键帧${h.note ? '<br>' + escapeHtml(h.note) : ''}</div>
      <button class="btn tov2v" title="送去转绘上色">🎨</button>
      <button class="btn dl" title="下载">⬇</button>`;
    card.onclick = () => { w.current = idx; renderWhole(); };
    card.querySelector('.dl').onclick = (e) => {
      e.stopPropagation();
      download(h.videoUrl, `whole_${w.history.length - idx}.mp4`);
    };
    card.querySelector('.tov2v').onclick = async (e) => {
      e.stopPropagation();
      await setV2VSource(h.videoUrl, `一体生成 版本 ${w.history.length - idx}`);
      switchMode('v2v');
    };
    hist.appendChild(card);
  });
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
  if (v.running) return;
  v.running = true;
  $('btnV2VGenerate').disabled = true;
  setV2VStatus('提交任务中…（首次会启动公网文件隧道，约 10 秒）');
  try {
    const res = await fetch('/api/v2v', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoUrl: v.sourceUrl,
        refs: v.refs.map((r) => r.url),
        prompt: $('v2vExtraPrompt').value.trim(),
        colorPrompt: $('colorPrompt').value.trim(),
        duration: Number($('v2vDuration').value),
      }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || res.statusText);
    const t0 = Date.now();
    for (;;) {
      await new Promise((r) => setTimeout(r, 4000));
      const p = await (await fetch('/api/segments/' + json.id)).json();
      if (p.status === 'succeeded') {
        v.history.unshift({
          videoUrl: p.videoUrl,
          time: new Date().toLocaleString('zh-CN', { hour12: false }),
          duration: Number($('v2vDuration').value),
          sourceUrl: v.sourceUrl,
          refs: v.refs.length,
          refUrls: v.refs.map((r) => r.url),
          colorPrompt: $('colorPrompt').value.trim(),
          note: $('v2vExtraPrompt').value.trim(),
        });
        v.current = 0;
        setV2VStatus('转绘完成');
        renderV2V();
        scheduleSave();
        return;
      }
      if (p.status === 'failed') throw new Error(p.error || '转绘失败');
      setV2VStatus(`转绘中… ${Math.round((Date.now() - t0) / 1000)}s`);
    }
  } catch (e) {
    setV2VStatus('失败: ' + (e.message || e));
  } finally {
    v.running = false;
    $('btnV2VGenerate').disabled = false;
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
}

function renderImageList() {
  const ul = $('imageList');
  ul.innerHTML = '';
  state.images.forEach((im, idx) => {
    const li = document.createElement('li');
    li.className = 'image-item';
    li.draggable = true;
    const isLast = idx === state.images.length - 1;
    li.innerHTML = `
      <div class="im-row"><span class="idx">${idx + 1}</span><img src="${im.url}"><span class="name">${escapeHtml(im.name)}</span><button class="del" title="删除">✕</button></div>
      ${isLast ? '' : `<div class="hold-row"><span class="lbl">→ 下一帧</span>
        <input type="range" class="hold" min="0.5" max="6" step="0.5" value="${im.hold ?? 2}" draggable="false">
        <b>${(im.hold ?? 2).toFixed(1)}s</b></div>`}`;
    li.querySelector('.del').onclick = () => removeImage(im.id);
    const hold = li.querySelector('.hold');
    if (hold) {
      hold.addEventListener('mousedown', (e) => e.stopPropagation());
      hold.addEventListener('input', (e) => {
        im.hold = Number(e.target.value);
        li.querySelector('.hold-row b').textContent = im.hold.toFixed(1) + 's';
        updateWholeTotal();
        scheduleSave();
      });
    }
    li.addEventListener('dragstart', (e) => {
      if (e.target.tagName === 'INPUT') { e.preventDefault(); return; }
      e.dataTransfer.setData('text/plain', String(idx));
      li.classList.add('dragging');
    });
    li.addEventListener('dragend', () => li.classList.remove('dragging'));
    li.addEventListener('dragover', (e) => e.preventDefault());
    li.addEventListener('drop', (e) => {
      e.preventDefault();
      const from = Number(e.dataTransfer.getData('text/plain'));
      if (!Number.isNaN(from) && from !== idx) moveImage(from, idx);
    });
    ul.appendChild(li);
  });
  updateWholeTotal();
}

// 各关键帧「到下一帧时长」合计（即一体生成总时长）
function wholeTimings() {
  return state.images.slice(0, -1).map((im) => Number(im.hold ?? 2));
}
function wholeTotalSeconds() {
  return wholeTimings().reduce((a, b) => a + b, 0);
}
function updateWholeTotal() {
  const el = $('wholeTotalVal');
  if (state.images.length < 2) { el.textContent = '—'; return; }
  const t = wholeTotalSeconds();
  const clamped = Math.max(4, Math.min(15, Math.round(t)));
  el.textContent = t.toFixed(1) + ' 秒' + (t < 4 || t > 15 ? `（超出范围，将按 ${clamped}s 生成）` : '');
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
        seg.active = Number(btn.dataset.ver);
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
  if (!$('stylePrompt').value) $('stylePrompt').value = cfg.stylePrompt || '';
  if (!$('colorPrompt').value) $('colorPrompt').value = cfg.colorPrompt || '';
  return cfg;
}

// ---------------- 事件绑定 ----------------
$('tabInbetween').onclick = () => switchMode('inbetween');
$('tabV2V').onclick = () => switchMode('v2v');

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
    resolution: $('cfgResolution').value,
    ratio: $('cfgRatio').value,
    publicBase: $('cfgPublicBase').value.trim(),
  };
  if ($('cfgKey').value.trim()) body.apiKey = $('cfgKey').value.trim();
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
syncSliderLabels();
refreshConfig();
renderAll();
renderV2V();
renderWhole();
setBadge('已停止');
loadProject();
