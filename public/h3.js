/* Local MiniMax H3 UI - additive; does not replace app.js */
'use strict';
(function () {
  const $ = (id) => document.getElementById(id);
  const MAX = { images: 9, videos: 3, audios: 3 };
  const files = { images: [], videos: [], audios: [] };
  const objectUrls = [];

  function setPill(el, ok, label) {
    if (!el) return;
    el.textContent = label;
    el.classList.toggle('ok', !!ok);
    el.classList.toggle('bad', !ok);
  }

  async function pingHealth() {
    const api = $('h3HealthApi');
    const comfy = $('h3HealthComfy');
    try {
      const r = await fetch('/api/h3/health', { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      const apiOk = !!(j && j.ok);
      const comfyOk = !!(j && (j.comfy === true || j.comfyui === true));
      setPill(api, apiOk, apiOk ? 'H3 API 8787 - up' : ('H3 API 8787 - ' + (j.error || 'down')));
      setPill(comfy, comfyOk, comfyOk ? 'ComfyUI 8188 - up' : 'ComfyUI 8188 - down');
      return j;
    } catch {
      setPill(api, false, 'H3 API 8787 - down');
      setPill(comfy, false, 'ComfyUI 8188 - down');
      return { ok: false, error: 'h3_api down' };
    }
  }

  window.h3OnShow = function h3OnShow() {
    pingHealth();
  };

  function setStatus(msg, isErr) {
    const el = $('h3Status');
    if (!el) return;
    el.textContent = msg || '';
    el.classList.toggle('err', !!isErr);
  }

  function chipHost(kind) {
    return $('h3Chips' + kind.charAt(0).toUpperCase() + kind.slice(1));
  }

  function renderChips(kind) {
    const host = chipHost(kind);
    if (!host) return;
    host.innerHTML = '';
    files[kind].forEach((file, i) => {
      const chip = document.createElement('span');
      chip.className = 'h3-chip';
      const tag = kind === 'images' ? ('<Picture ' + (i + 1) + '>')
        : kind === 'videos' ? ('<Video ' + (i + 1) + '>')
        : ('<Audio ' + (i + 1) + '>');
      chip.title = tag + ' - reference only, not a first frame';
      if (kind === 'images' && file.type && file.type.startsWith('image/')) {
        const img = document.createElement('img');
        const url = URL.createObjectURL(file);
        objectUrls.push(url);
        img.src = url;
        chip.appendChild(img);
      }
      const name = document.createElement('em');
      name.textContent = tag + '  ' + file.name;
      chip.appendChild(name);
      const del = document.createElement('button');
      del.type = 'button';
      del.textContent = 'x';
      del.onclick = () => {
        files[kind].splice(i, 1);
        renderChips(kind);
      };
      chip.appendChild(del);
      host.appendChild(chip);
    });
  }

  function addFiles(kind, list) {
    const cap = MAX[kind];
    const next = files[kind].concat([...list]);
    files[kind] = next.slice(0, cap);
    renderChips(kind);
  }

  function bindDrop(id, kind, acceptPrefix) {
    const el = $(id);
    if (!el) return;
    const input = el.querySelector('input[type=file]');
    el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('over'); });
    el.addEventListener('dragleave', () => el.classList.remove('over'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('over');
      const picked = [...(e.dataTransfer.files || [])].filter((f) => {
        const t = f.type || '';
        if (t.startsWith(acceptPrefix)) return true;
        if (kind === 'images' && /\.(png|jpe?g|webp|gif|bmp)$/i.test(f.name)) return true;
        if (kind === 'videos' && /\.(mp4|webm|mov|mkv)$/i.test(f.name)) return true;
        if (kind === 'audios' && /\.(mp3|wav|flac|ogg|m4a)$/i.test(f.name)) return true;
        return false;
      });
      if (picked.length) addFiles(kind, picked);
    });
    if (input) {
      input.addEventListener('change', () => {
        addFiles(kind, [...input.files]);
        input.value = '';
      });
    }
  }

  async function startH3() {
    setStatus('Starting local H3...');
    try {
      const r = await fetch('/api/h3/start', { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (j.already) setStatus('H3 already running');
      else setStatus('Started (will not kill Comfy / Magic). Waiting for 8787...');
      for (let i = 0; i < 24; i++) {
        await new Promise((res) => setTimeout(res, 1500));
        const h = await pingHealth();
        if (h && h.ok) {
          setStatus('H3 is up');
          return;
        }
      }
      setStatus('Still down - check the pills, or start D:\\Atelier452\\minimax-h3 manually.', true);
    } catch (e) {
      setStatus(String(e.message || e), true);
    }
  }

  async function generate() {
    const prompt = (($('h3Prompt') && $('h3Prompt').value) || '').trim();
    if (!prompt) {
      setStatus('Enter a prompt. Use <Picture 1> / <Video 1> / <Audio 1> tags.', true);
      return;
    }
    const duration = Number($('h3Duration') && $('h3Duration').value);
    if (!(duration >= 4 && duration <= 15)) {
      setStatus('Duration must be 4-15 seconds.', true);
      return;
    }
    const btn = $('btnH3Generate');
    if (btn) btn.disabled = true;
    const vid = $('h3Video');
    if (vid) {
      vid.removeAttribute('src');
      try { vid.load(); } catch {}
      vid.hidden = true;
    }
    setStatus('Queued on RTX 5090 via MiniMax H3 (Ref2VA if refs attached).');
    const fd = new FormData();
    fd.append('prompt', prompt);
    fd.append('duration_seconds', String(duration));
    fd.append('width', '1344');
    fd.append('height', '768');
    fd.append('turbo', ($('h3Turbo') && $('h3Turbo').checked) ? 'true' : 'false');
    files.images.forEach((f) => fd.append('ref_images', f));
    files.videos.forEach((f) => fd.append('ref_videos', f));
    files.audios.forEach((f) => fd.append('ref_audios', f));
    try {
      const r = await fetch('/api/h3/generate', { method: 'POST', body: fd });
      const data = await r.json().catch(() => ({}));
      if (!data.ok) throw new Error(data.error || JSON.stringify(data));
      const name = (data.output_path || '').split(/[\\/]/).pop();
      setStatus('Done - MiniMax H3' + (data.output_path ? '\n' + data.output_path : ''));
      if (vid && (data.url || name)) {
        vid.src = data.url || ('/api/h3/outputs/' + encodeURIComponent(name));
        vid.hidden = false;
        vid.play().catch(() => {});
      }
    } catch (e) {
      setStatus(String(e.message || e), true);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function init() {
    bindDrop('h3DropImages', 'images', 'image/');
    bindDrop('h3DropVideos', 'videos', 'video/');
    bindDrop('h3DropAudios', 'audios', 'audio/');
    const start = $('btnH3Start');
    if (start) start.onclick = startH3;
    const gen = $('btnH3Generate');
    if (gen) gen.onclick = generate;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
