/* 公开站前端层：Google 登录、积分、充值、新手引导、功能气泡。
   本地/桌面模式（/api/site 404 或 publicMode=false）下自动隐身，只保留引导与气泡。 */
'use strict';

(function () {
  const $$ = (id) => document.getElementById(id);
  const zhEn = (zh, en) => (typeof LANG !== 'undefined' && LANG === 'en' ? en : zh);

  let SITE = { publicMode: false, packs: [], devLogin: false, googleClientId: '' };
  let ME = { signedIn: false };

  // ---------------- 功能气泡（blurbs） ----------------
  const TIPS = [
    ['btnWhole', '把全部关键帧交给 Seedance 一次生成整段连续动画（推荐）', 'Send ALL keyframes to Seedance as ONE continuous generation (recommended)'],
    ['btnBatch', '旧模式：相邻两帧各生成一段再拼接，段与段之间没有上下文', 'Legacy: pairwise segments stitched together, no shared context'],
    ['acting', '1-100 档演技强度：越高动作越快越夸张（sakuga），自动写入提示词', 'Acting 1-100: higher = faster, snappier, more exaggerated (sakuga). Auto-injected into the prompt'],
    ['segSeconds', '分段模式下每一段补间的生成时长', 'Duration of each pairwise segment (legacy mode)'],
    ['remapSeconds', '把预览重采样到这个总时长（不重新生成，本地重排帧）', 'Resample the preview to this total duration (local, no regeneration)'],
    ['remapFps', '输出帧率：12fps 即动画常用的"一拍二"节奏', 'Output fps: 12fps ≈ animating on twos'],
    ['chkTame', '按运动量智能抽帧：动作大处保留多，平缓处抽得狠', 'Motion-aware frame dropping: keeps busy frames, drops calm ones'],
    ['btnPlaySeq', '按 24fps 连播所有已生成分段', 'Play all generated segments at 24fps'],
    ['btnPlayRemap', '按重映射时长和 fps 播放', 'Play with the remapped duration and fps'],
    ['btnExportMp4', '服务器端拼接导出完整 mp4', 'Export the full mp4 (server-side concat)'],
    ['btnExportZip', '导出每一帧 PNG（进后期软件用）', 'Export every frame as PNG (for compositing)'],
    ['macroTimeline', '拖动关键帧调整间距；点击两帧之间的段落条编辑该段动作与演技', 'Drag keyframes to adjust spacing; click a gap bar to edit its action & acting'],
    ['stylePrompt', '自动附加到每次生成，锁定画风不跑偏', 'Auto-appended to every generation to lock the art style'],
    ['globalPrompt', '整段动画的动作描述；每段还可在时间轴上单独写', 'Overall action description; per-gap actions live on the timeline'],
    ['btnUseConcat', '直接引用工作区 1 的拼接结果作为源视频', 'Use the concat result from Workspace 1 as the source'],
    ['btnV2VGenerate', '把粗动画按参考图转绘成成片（动作与镜头保持不变）', 'Repaint the rough animation to final quality per the reference images (motion preserved)'],
    ['v2vDuration', '建议与源视频等长（自动带入）', 'Match the source video length (auto-filled)'],
    ['colorPrompt', '内置上色主指令，可编辑并持久化', 'Baked coloring instruction; editable and persisted'],
    ['btnRefine', '把草稿/tie-down 精修成干净的完成版原画线稿', 'Refine a rough sketch / tie-down into clean finished lineart'],
    ['refinePrompt', '内置精修主指令，可编辑并持久化', 'Baked refine instruction; editable and persisted'],
    ['wholeTotalVal', '各关键帧间距之和 = 一次生成的总时长（4-15 秒）', 'Sum of all gaps = total duration of the single generation (4-15s)'],
  ];

  function installTips() {
    for (const [id, zh, en] of TIPS) {
      const el = $$(id);
      if (!el) continue;
      const host = el.closest('.timing-card') || el;
      host.setAttribute('data-tip', zhEn(zh, en));
      host.classList.add('has-tip');
    }
  }

  // ---------------- 新手引导（聚光灯分步） ----------------
  const TOUR = [
    ['.mode-tabs', '三大工作区', 'Three workspaces',
      '① 中割生成：关键帧 → 补间动画；② 视频转绘上色：粗动画 → 成片；③ 原画精修：草稿 → 完成版原画。',
      '① In-betweens: keyframes → animation; ② Repaint & Color: rough → final; ③ Lineart Refine: sketch → finished genga.'],
    ['#dropZone', '第一步：上传关键帧', 'Step 1: add keyframes',
      '把你的原画按镜头顺序拖进来（顺序可再调整）。每张图下方可设置到下一帧的时长、演技和动作。',
      'Drop your keyframes in shot order (reorderable). Under each: gap duration, acting and action.'],
    ['#macroTimeline', '宏观时间轴', 'Macro timeline',
      '所有关键帧按时间比例排在这条轨道上。左右拖动调整间距；点击段落条给每一段写动作。',
      'Keyframes laid out proportionally. Drag to adjust spacing; click a gap bar to write its action.'],
    ['#btnWhole', '一键成片', 'Generate',
      '所有关键帧一次生成为一段连续动画（不是幻灯片！），支持多任务并行，进度在右下角。',
      'All keyframes become ONE continuous animation (not a slideshow!). Multiple jobs run in parallel; progress at bottom-right.'],
    ['#tabV2V', '然后：转绘上色', 'Then: repaint & color',
      '把线稿粗动画 + 上色参考图交给模型，输出最终成片。',
      'Feed the rough lineart animation + color refs to get the final footage.'],
    ['#userArea', '积分', 'Credits',
      '生成按秒计积分，失败自动退还。点击余额可充值。',
      'Generations cost credits per second; failures are auto-refunded. Click your balance to top up.'],
  ];

  let tourIdx = -1;
  let tourEls = null;

  function tourUI() {
    if (tourEls) return tourEls;
    const dim = document.createElement('div');
    dim.className = 'tour-dim';
    const spot = document.createElement('div');
    spot.className = 'tour-spot';
    const card = document.createElement('div');
    card.className = 'tour-card';
    document.body.append(dim, spot, card);
    tourEls = { dim, spot, card };
    return tourEls;
  }

  function endTour() {
    if (!tourEls) return;
    tourEls.dim.remove(); tourEls.spot.remove(); tourEls.card.remove();
    tourEls = null;
    tourIdx = -1;
    localStorage.setItem('a452tour', '1');
  }

  function showTourStep(i) {
    const ui = tourUI();
    while (i < TOUR.length) {
      const target = document.querySelector(TOUR[i][0]);
      if (target && target.offsetParent !== null) break;
      i++;
    }
    if (i >= TOUR.length) return endTour();
    tourIdx = i;
    const [sel, tzh, ten, bzh, ben] = TOUR[i];
    const target = document.querySelector(sel);
    target.scrollIntoView({ block: 'center', behavior: 'instant' });
    const r = target.getBoundingClientRect();
    const pad = 8;
    Object.assign(ui.spot.style, {
      left: (r.left - pad) + 'px', top: (r.top - pad) + 'px',
      width: (r.width + pad * 2) + 'px', height: (r.height + pad * 2) + 'px',
    });
    ui.card.innerHTML = `
      <div class="tour-step">${i + 1} / ${TOUR.length}</div>
      <h4>${zhEn(tzh, ten)}</h4>
      <p>${zhEn(bzh, ben)}</p>
      <div class="tour-actions">
        <button class="btn ghost tour-skip">${zhEn('跳过', 'Skip')}</button>
        <button class="btn primary tour-next">${i === TOUR.length - 1 ? zhEn('完成', 'Done') : zhEn('下一步', 'Next')}</button>
      </div>`;
    const cw = 320;
    let cx = r.left + r.width / 2 - cw / 2;
    cx = Math.max(12, Math.min(cx, innerWidth - cw - 12));
    let cy = r.bottom + 16;
    if (cy > innerHeight - 220) cy = Math.max(12, r.top - 200);
    Object.assign(ui.card.style, { left: cx + 'px', top: cy + 'px', width: cw + 'px' });
    ui.card.querySelector('.tour-skip').onclick = endTour;
    ui.card.querySelector('.tour-next').onclick = () => showTourStep(tourIdx + 1);
  }

  function maybeStartTour() {
    if (localStorage.getItem('a452tour')) return;
    setTimeout(() => showTourStep(0), 900);
  }

  // ---------------- 登录 / 积分 ----------------
  async function fetchSite() {
    try {
      const r = await fetch('/api/site');
      if (r.ok) SITE = await r.json();
    } catch {}
  }
  async function refreshMe() {
    if (!SITE.publicMode) return;
    try {
      ME = await (await fetch('/api/me')).json();
    } catch { ME = { signedIn: false }; }
    renderUserArea();
    if (!ME.signedIn) showLogin();
  }
  window.refreshMe = refreshMe;

  function renderUserArea() {
    const area = $$('userArea');
    if (!area) return;
    if (!SITE.publicMode) { area.hidden = true; return; }
    area.hidden = false;
    if (!ME.signedIn) { area.innerHTML = ''; return; }
    area.innerHTML = `
      <button class="chip credit-chip" id="btnCredits" title="${zhEn('点击充值', 'Click to top up')}">⚡ ${ME.credits}</button>
      <span class="hint">${escapeHtmlSafe(ME.email)}</span>
      <button class="btn ghost" id="btnLogout">${zhEn('退出', 'Sign out')}</button>`;
    $$('btnCredits').onclick = openBuyDialog;
    $$('btnLogout').onclick = async () => {
      await fetch('/api/auth/logout', { method: 'POST' });
      location.reload();
    };
  }
  function escapeHtmlSafe(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function showLogin() {
    let ov = $$('loginOverlay');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'loginOverlay';
      ov.innerHTML = `
        <div class="login-card">
          <div class="login-logo">✦ Atelier452 Magic</div>
          <p class="login-sub">${zhEn('关键帧 → 中割 → 转绘成片，一站式 AI 动画工作台', 'Keyframes → in-betweens → final footage. An AI animation studio.')}</p>
          <div id="gsiButton"></div>
          <div id="devLoginRow" hidden>
            <input type="text" id="devEmail" placeholder="dev@test.local">
            <button class="btn" id="btnDevLogin">Dev sign in</button>
          </div>
          <p class="hint">${zhEn(`新用户赠送 ${SITE.freeCredits || 0} 积分`, `${SITE.freeCredits || 0} free credits for new users`)}</p>
        </div>`;
      document.body.appendChild(ov);
    }
    ov.hidden = false;
    // Google Identity Services
    if (SITE.googleClientId) {
      const init = () => {
        window.google.accounts.id.initialize({
          client_id: SITE.googleClientId,
          callback: async (resp) => {
            const r = await fetch('/api/auth/google', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ credential: resp.credential }),
            });
            if (r.ok) location.reload();
            else alert((await r.json()).error || 'Sign-in failed');
          },
        });
        window.google.accounts.id.renderButton($$('gsiButton'), { theme: 'filled_black', size: 'large', width: 280 });
      };
      if (window.google && window.google.accounts) init();
      else {
        const s = document.createElement('script');
        s.src = 'https://accounts.google.com/gsi/client';
        s.onload = init;
        document.head.appendChild(s);
      }
    }
    if (SITE.devLogin) {
      $$('devLoginRow').hidden = false;
      $$('btnDevLogin').onclick = async () => {
        const r = await fetch('/api/auth/dev', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: $$('devEmail').value || 'dev@test.local' }),
        });
        if (r.ok) location.reload();
      };
    }
  }

  function openBuyDialog() {
    let dlg = $$('buyDialog');
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.id = 'buyDialog';
      document.body.appendChild(dlg);
    }
    dlg.innerHTML = `
      <h3>⚡ ${zhEn('充值积分', 'Buy credits')}</h3>
      <div class="hint">${zhEn('一体生成 3 积分/秒 · 转绘 4 积分/秒 · 精修 5 积分/次 · 失败自动退还', 'Single-gen 3 cr/s · Repaint 4 cr/s · Refine 5 cr · failures auto-refunded')}</div>
      <div class="pack-list">
        ${SITE.packs.map((p) => `
          <button class="pack" data-pack="${p.id}">
            <b>${p.credits}</b><span>credits</span>
            <em>$${(p.amount / 100).toFixed(2)}</em>
          </button>`).join('')}
      </div>
      <div class="dialog-actions"><button class="btn ghost" id="buyClose">${zhEn('关闭', 'Close')}</button></div>
      <div class="hint accent" id="buyStatus"></div>`;
    dlg.querySelectorAll('.pack').forEach((b) => {
      b.onclick = async () => {
        $$('buyStatus').textContent = '…';
        const r = await fetch('/api/pay/checkout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pack: b.dataset.pack }),
        });
        const j = await r.json();
        if (r.ok && j.url) location.href = j.url;
        else $$('buyStatus').textContent = j.error || 'Error';
      };
    });
    $$('buyClose').onclick = () => dlg.close();
    dlg.showModal();
  }

  // ---------------- 启动 ----------------
  window.addEventListener('DOMContentLoaded', async () => {
    installTips();
    const helpBtn = $$('btnTour');
    if (helpBtn) helpBtn.onclick = () => { localStorage.removeItem('a452tour'); showTourStep(0); };
    await fetchSite();
    if (SITE.publicMode) {
      await refreshMe();
      if (new URLSearchParams(location.search).get('paid') === '1') {
        setTimeout(refreshMe, 1500); // webhook 入账后刷新余额
      }
      if (ME.signedIn) maybeStartTour();
    } else {
      maybeStartTour();
    }
  });
})();
