// Atelier452 直连填充 — Chrome 扩展内容脚本
// 在你已登录的真实 Chrome 里运行：轮询本机 Atelier452（localhost:5893）的填充任务，
// 认领后把最终提示词填进平台的提示词框，并把参考素材【严格按编号顺序、逐个】注入上传区。
// 铁律：只填充，绝不点击任何「生成」按钮 —— 额度永远由你亲手花。
(() => {
  const BASE = 'http://localhost:5893';
  const HOST_PLATFORM = [
    ['app.runwayml.com', 'runway'],
    ['pika.art', 'pika'],
    ['klingai.com', 'kling'],
    ['hailuoai.video', 'hailuo'],
    ['jimeng.jianying.com', 'dreamina'],
  ];
  const platform = (HOST_PLATFORM.find(([h]) => location.hostname.endsWith(h)) || [])[1];
  if (!platform) return;
  if (window.__a452ContentActive) return; // 单例
  window.__a452ContentActive = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- 状态横幅 ----
  function banner() {
    let el = document.getElementById('a452-extgen-banner');
    if (!el) {
      el = document.createElement('div');
      el.id = 'a452-extgen-banner';
      el.style.cssText = 'position:fixed;top:10px;right:10px;z-index:2147483647;max-width:380px;'
        + 'background:rgba(22,16,52,.96);color:#eae6ff;border:1px solid rgba(167,139,250,.6);'
        + 'border-radius:12px;padding:10px 34px 10px 12px;font:12px/1.5 "Segoe UI","Microsoft YaHei",sans-serif;'
        + 'box-shadow:0 12px 40px rgba(0,0,0,.5);white-space:pre-wrap;';
      const x = document.createElement('button');
      x.textContent = '✕';
      x.style.cssText = 'position:absolute;top:6px;right:6px;border:0;background:none;color:#a79ede;cursor:pointer;font-size:12px;';
      x.onclick = () => el.remove();
      el.appendChild(x);
      const txt = document.createElement('div');
      txt.id = 'a452-extgen-banner-text';
      el.appendChild(txt);
      document.documentElement.appendChild(el);
    }
    return el;
  }
  const say = (t) => {
    banner();
    const el = document.getElementById('a452-extgen-banner-text');
    if (el) el.textContent = 'Atelier452 直连填充\n' + t;
  };

  async function report(id, phase, detail) {
    try {
      await fetch(BASE + '/api/extgen/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, phase, detail: String(detail || '').slice(0, 300) }),
      });
    } catch {}
  }

  // ---- 查找与填充 ----
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 40 && r.height > 14 && cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  function findPromptBox(extraSelectors) {
    const sels = (extraSelectors || []).concat([
      'textarea[placeholder*="prompt" i]', 'textarea[placeholder*="describe" i]',
      'textarea[placeholder*="提示" i]', 'textarea[placeholder*="描述" i]',
      'div[contenteditable="true"][role="textbox"]', 'div[contenteditable="true"]', 'textarea',
    ]);
    for (const s of sels) {
      let list = [];
      try { list = [...document.querySelectorAll(s)].filter(visible); } catch {}
      if (list.length) {
        list.sort((a, b) => {
          const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
          return rb.width * rb.height - ra.width * ra.height;
        });
        return list[0];
      }
    }
    return null;
  }
  function setPrompt(el, text) {
    el.focus();
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('insertText', false, text);
    }
  }
  function fileInput(extraSelectors) {
    const sels = (extraSelectors || []).concat(['input[type="file"]']);
    for (const s of sels) {
      let list = [];
      try { list = [...document.querySelectorAll(s)]; } catch {}
      if (list.length) {
        list.sort((a, b) => (b.multiple ? 1 : 0) - (a.multiple ? 1 : 0));
        return list[0];
      }
    }
    return null;
  }
  function injectOne(file, anchorEl, extraSelectors) {
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = fileInput(extraSelectors);
    if (input) {
      try {
        input.files = dt.files;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return 'input';
      } catch (e) { console.warn('[a452] input 注入失败', e); }
    }
    const target = anchorEl || document.body;
    const r = target.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, dataTransfer: dt };
    try {
      target.dispatchEvent(new DragEvent('dragenter', opts));
      target.dispatchEvent(new DragEvent('dragover', opts));
      target.dispatchEvent(new DragEvent('drop', opts));
      return 'drop';
    } catch (e) { console.warn('[a452] drop 注入失败', e); return null; }
  }

  // ---- 执行一单任务 ----
  let busy = false;
  async function runJob(job) {
    busy = true;
    try {
      await report(job.id, 'claimed', location.hostname);
      say('任务已认领。等待页面出现提示词输入框…');
      let box = null;
      for (let i = 0; i < 120 && !box; i++) {
        box = findPromptBox(job.promptSelectors);
        if (!box) await sleep(500);
      }
      if (!box) {
        say('⚠ 没找到提示词输入框（请先进入创作页面，任务会重试）。');
        await report(job.id, 'error', '未找到提示词输入框');
        busy = false;
        return;
      }
      setPrompt(box, job.prompt || '');
      await report(job.id, 'prompt-filled', '');
      say('✓ 提示词已填入。开始按顺序导入参考素材…');
      // 素材：严格按清单顺序逐个注入，每个之间等平台消化
      let okCount = 0;
      const files = job.files || [];
      for (let i = 0; i < files.length; i++) {
        const meta = files[i];
        say(`导入素材 ${i + 1}/${files.length}：${meta.name} …`);
        await report(job.id, 'importing', `${i + 1}/${files.length} ${meta.name}`);
        try {
          const resp = await fetch(meta.url);
          if (!resp.ok) throw new Error('HTTP ' + resp.status);
          const blob = await resp.blob();
          const file = new File([blob], meta.name, { type: meta.mime || blob.type || 'application/octet-stream' });
          const how = injectOne(file, box.closest('form') || box.parentElement, job.fileSelectors);
          if (how) okCount += 1;
        } catch (e) {
          console.warn('[a452] 素材导入失败', meta.name, e);
        }
        await sleep(1200); // 给平台上传/回显留时间，保证顺序不乱
      }
      window.__a452LastJob = job.id;
      await report(job.id, 'done', `${okCount}/${files.length}`);
      say(`✓ 完成：提示词已填入；素材按顺序导入 ${okCount}/${files.length} 份。\n`
        + (okCount < files.length ? '未成功的素材请从素材包文件夹手动拖入（顺序按文件名编号）。\n' : '')
        + '⚠ 本扩展绝不代点「生成」—— 确认无误后由你亲自点击。');
    } finally {
      busy = false;
    }
  }

  // ---- 轮询本机任务队列 ----
  async function poll() {
    if (busy) return;
    try {
      const r = await fetch(BASE + '/api/extgen/job?platform=' + platform);
      if (!r.ok) return;
      const j = await r.json();
      if (j && j.job) runJob(j.job);
    } catch {}
  }
  setInterval(poll, 2000);
  poll();
})();
