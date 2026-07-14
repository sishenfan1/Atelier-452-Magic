/* Planner i18n layer — EN / 中文 / 日本語.
   Dictionary-keyed exact-string translation over the DOM (MutationObserver),
   decoupled from React; user content never matches UI keys so it stays intact. */
(function () {
  'use strict';

  // 'English UI string': ['中文', '日本語']
  var D = {
    // nav / shell
    'Home': ['主页', 'ホーム'],
    'Projects': ['项目', 'プロジェクト'],
    'Scene Setup': ['场景搭建', 'シーン設定'],
    'Environments': ['环境', '環境'],
    'Dashboard': ['仪表盘', 'ダッシュボード'],
    'Scene Board': ['场景看板', 'シーンボード'],
    'Characters': ['角色', 'キャラクター'],
    'Locations': ['场景地', 'ロケーション'],
    'Style DNA': ['风格 DNA', 'スタイルDNA'],
    'Continuity': ['连贯性', 'コンティニュイティ'],
    'Gen Studio': ['生成工作室', '生成スタジオ'],
    'Timeline': ['时间线', 'タイムライン'],
    'Export': ['导出', '書き出し'],
    'local project': ['本地项目', 'ローカル企画'],
    'AI Director Workspace': ['AI 导演工作台', 'AIディレクター・ワークスペース'],
    // dashboard
    'Project Dashboard': ['项目仪表盘', '企画ダッシュボード'],
    'Project': ['项目', '企画'],
    'Title': ['标题', 'タイトル'],
    'Logline': ['一句话梗概', 'ログライン'],
    'Quick actions': ['快捷操作', 'クイック操作'],
    'Scenes': ['场景', 'シーン'],
    'Shots': ['镜头', 'カット'],
    'Continuity warnings': ['连贯性警告', 'コンティニュイティ警告'],
    'New Scene': ['新建场景', '新規シーン'],
    '+ New Scene': ['+ 新建场景', '+ 新規シーン'],
    'Export JSON': ['导出 JSON', 'JSON書き出し'],
    'Import JSON': ['导入 JSON', 'JSON読み込み'],
    'Reset demo': ['重置演示项目', 'デモをリセット'],
    // board
    'Select or create a scene': ['选择或新建一个场景', 'シーンを選択または作成'],
    'Select a shot': ['选择一个镜头', 'カットを選択'],
    'No scenes yet': ['还没有场景', 'シーンがありません'],
    'No shots yet': ['还没有镜头', 'カットがありません'],
    'This scene has no shots yet': ['这个场景还没有镜头', 'このシーンにはまだカットがありません'],
    'Apply Template': ['应用模板', 'テンプレート適用'],
    'Apply storyboard template': ['应用分镜模板', '絵コンテのテンプレートを適用'],
    '+ Add Shot': ['+ 添加镜头', '+ カット追加'],
    'Traditional': ['传统分镜', '従来型'],
    'AI': ['AI 卡片', 'AIカード'],
    'Move up': ['上移', '上へ'],
    'Move down': ['下移', '下へ'],
    'Move left': ['左移', '左へ'],
    'Move right': ['右移', '右へ'],
    'Move scene up': ['场景上移', 'シーンを上へ'],
    'Move scene down': ['场景下移', 'シーンを下へ'],
    'Move shot earlier': ['镜头前移', 'カットを前へ'],
    'Move shot later': ['镜头后移', 'カットを後ろへ'],
    'Duplicate scene': ['复制场景', 'シーンを複製'],
    'Duplicate shot': ['复制镜头', 'カットを複製'],
    'Delete scene': ['删除场景', 'シーンを削除'],
    'Delete shot': ['删除镜头', 'カットを削除'],
    'Open in inspector': ['在检查器打开', 'インスペクターで開く'],
    'Open in board': ['在看板打开', 'ボードで開く'],
    // inspector sections + fields
    'Basic': ['基本', '基本'],
    'Visual': ['视觉', 'ビジュアル'],
    'AI Prompt': ['AI 提示词', 'AIプロンプト'],
    'Animation': ['动画', 'アニメーション'],
    'Audio': ['音频', 'オーディオ'],
    'References': ['参考图', '参考画像'],
    'Scene': ['场景', 'シーン'],
    'Shot': ['镜头', 'カット'],
    'No.': ['编号', '番号'],
    'Description': ['描述', '説明'],
    'Story purpose': ['叙事目的', '物語上の目的'],
    'Shot size': ['景别', 'ショットサイズ'],
    'Angle': ['角度', 'アングル'],
    'Lens': ['镜头焦段', 'レンズ'],
    'Camera move': ['运镜', 'カメラワーク'],
    'Aspect ratio': ['画幅', 'アスペクト比'],
    'Lighting': ['光线', 'ライティング'],
    'Color palette': ['色盘', 'カラーパレット'],
    'Mood': ['情绪氛围', 'ムード'],
    'Emotion': ['情绪', '感情'],
    'Thumbnail': ['缩略图', 'サムネイル'],
    'Positive prompt': ['正向提示词', 'ポジティブプロンプト'],
    'Negative prompt': ['负向提示词', 'ネガティブプロンプト'],
    'Inherit from parent shot': ['继承父镜头', '親カットから継承'],
    'Parent shot': ['父镜头', '親カット'],
    'Merged positive': ['合并正向', '合成ポジティブ'],
    'Merged negative': ['合并负向', '合成ネガティブ'],
    'Copy': ['复制', 'コピー'],
    '✓ Copied': ['✓ 已复制', '✓ コピー済み'],
    'First frame notes': ['首帧说明', '最初のフレーム'],
    'Last frame notes': ['末帧说明', '最後のフレーム'],
    'Motion description': ['运动描述', 'モーション記述'],
    'Character action': ['角色动作', 'キャラクターの動き'],
    'Camera motion notes': ['运镜说明', 'カメラモーション'],
    'Duration (s)': ['时长（秒）', '尺（秒）'],
    'FPS': ['帧率', 'FPS'],
    'Video model target': ['目标视频模型', '対象動画モデル'],
    'Render notes': ['渲染备注', 'レンダーメモ'],
    'Dialogue': ['台词', 'セリフ'],
    'Voiceover': ['旁白', 'ナレーション'],
    'Music cue': ['音乐提示', '音楽キュー'],
    'SFX cue': ['音效提示', '効果音キュー'],
    'Time of day': ['时段', '時間帯'],
    'Weather': ['天气', '天候'],
    'Outfit': ['服装', '衣装'],
    'Emotional state': ['情绪状态', '感情状態'],
    'Props present': ['在场道具', '登場する小道具'],
    'Injuries / marks': ['伤痕/记号', '傷・マーク'],
    'Location state': ['场景状态', 'ロケーションの状態'],
    'Continuity Notes': ['连贯性备注', 'コンティニュイティメモ'],
    'Notes': ['备注', 'メモ'],
    'Character': ['角色', 'キャラクター'],
    'Location': ['场景地', 'ロケーション'],
    'Style': ['风格', 'スタイル'],
    'Remove': ['移除', '削除'],
    'Send merged prompt to the Generation Studio': ['把合并提示词发送到生成工作室', '合成プロンプトを生成スタジオへ送る'],
    // bibles
    'Character Bible': ['角色圣经', 'キャラクター設定集'],
    'Location Bible': ['场景地圣经', 'ロケーション設定集'],
    'New Character': ['新建角色', '新規キャラクター'],
    'New Location': ['新建场景地', '新規ロケーション'],
    'No characters yet': ['还没有角色', 'キャラクターがいません'],
    'No locations yet': ['还没有场景地', 'ロケーションがありません'],
    'Role': ['定位', '役割'],
    'Visual Age': ['外观年龄', '見た目の年齢'],
    'Personality': ['性格', '性格'],
    'Visual Description': ['外观描述', 'ビジュアル描写'],
    'Outfit Notes': ['服装说明', '衣装メモ'],
    'Voice Notes': ['声音说明', '声のメモ'],
    'Movement Style': ['动作风格', '動きのスタイル'],
    'Emotional Range': ['情绪跨度', '感情の幅'],
    'Relationship Notes': ['关系说明', '関係性メモ'],
    'Prompt Fragment': ['提示词片段', 'プロンプト断片'],
    'Negative Fragment': ['负向片段', 'ネガティブ断片'],
    'Face Refs': ['面部参考', '顔の参考'],
    'Outfit Refs': ['服装参考', '衣装の参考'],
    'Visual Style': ['视觉风格', 'ビジュアルスタイル'],
    'Time Period': ['时代', '時代設定'],
    'Lighting Defaults': ['默认光线', 'デフォルト照明'],
    'Weather Defaults': ['默认天气', 'デフォルト天候'],
    'Reference Images': ['参考图', '参考画像'],
    // style dna / continuity / timeline / export
    'Live preview': ['实时预览', 'ライブプレビュー'],
    'Negative defaults': ['默认负向词', 'デフォルトネガティブ'],
    'Continuity Checker': ['连贯性检查器', 'コンティニュイティチェッカー'],
    'No continuity issues — the cut is clean.': ['没有连贯性问题——剪辑很干净。', 'コンティニュイティの問題なし——きれいな繋ぎです。'],
    'Timeline / Animatic': ['时间线 / 动态分镜', 'タイムライン／ビデオコンテ'],
    'Project Total': ['项目总长', '企画の合計尺'],
    'Scene exports': ['场景导出', 'シーン書き出し'],
    'Per-shot prompt': ['单镜头提示词', 'カット別プロンプト'],
    'Generation Studio': ['生成工作室', '生成スタジオ'],
    'Open in new tab ↗': ['新标签页打开 ↗', '新しいタブで開く ↗'],
    // kawaii mascot cast — greetings & home cards
    'Welcome back, Director! Let’s make something cute today ♡': ['欢迎回来，导演！今天也一起做点可爱的东西吧 ♡', 'おかえりなさい、監督！今日もかわいいものを作りましょ ♡'],
    'Dreams to frames… leave the magic to me ✧': ['把梦境变成画面……魔法就交给我吧 ✧', '夢をフレームに……魔法はわたしにおまかせ ✧'],
    'All your films, neatly filed and ready!': ['你的所有影片，都整理得井井有条！', 'あなたの作品、ぜんぶきちんと整理済みです！'],
    'Places, everyone! The board is set ♡': ['各就各位！看板已经就绪 ♡', 'みんな配置について！ボードの準備完了 ♡'],
    'Every hero needs a heart — meet your cast!': ['每位主角都需要一颗心——来见见你的角色们！', 'ヒーローには心が必要——キャストに会いましょう！'],
    'Let’s grow little worlds to wander in ♪': ['一起种出可以漫步的小世界吧 ♪', 'さまよえる小さな世界を育てましょう ♪'],
    'Style is everything, darling ☆ time to sparkle!': ['风格就是一切，亲爱的 ☆ 闪耀起来！', 'スタイルこそすべてよ、ダーリン ☆ 輝く時間！'],
    'Tick-tock ♪ every second tells your story.': ['滴答滴答 ♪ 每一秒都在讲述你的故事。', 'チクタク ♪ 一秒ごとにあなたの物語。'],
    // PDF script import
    '📄 Import PDF Script': ['📄 导入 PDF 剧本', '📄 PDF脚本を読み込む'],
    'Script Import': ['剧本导入', '脚本インポート'],
    'Extracting PDF text…': ['正在提取 PDF 文本…', 'PDFテキストを抽出中…'],
    'opening file…': ['正在打开文件…', 'ファイルを開いています…'],
    'The agent is reading your script…': ['智能体正在阅读你的剧本…', 'エージェントが脚本を読んでいます…'],
    'Dividing scenes, drafting shots and prompts. Long scripts can take a minute.': ['正在分场、起草镜头与提示词。长剧本可能需要一分钟。', 'シーン分割、カットとプロンプトを作成中。長い脚本は1分ほどかかります。'],
    'Script imported!': ['剧本导入完成！', '脚本のインポート完了！'],
    'Open Scene Board': ['打开场景看板', 'シーンボードを開く'],
    'Import failed': ['导入失败', 'インポート失敗'],
    'Close': ['关闭', '閉じる'],
    'Cannot reach the local studio server — launch the Atelier 452 desktop app first.': ['无法连接本地工作室服务 — 请先启动 Atelier 452 桌面应用。', 'ローカルのスタジオサーバーに接続できません — 先にAtelier 452デスクトップアプリを起動してください。'],
    'No readable text found in this file (scanned PDFs need OCR first).': ['文件中没有可读文本（扫描版 PDF 需先 OCR）。', 'このファイルに読めるテキストがありません（スキャンPDFは先にOCRが必要）。'],
    "Claude spend cap reached — imported with offline rules instead. Recharge at console.anthropic.com, then tell Claude it's recharged to unlock the next $20.": ['已达 Claude 用量上限——本次已用离线规则导入。请到 console.anthropic.com 充值，然后告诉 Claude 已充值，即可解锁下一个 $20 额度。', 'Claudeの利用上限に達したため、今回はオフラインルールで読み込みました。console.anthropic.com でチャージ後、Claudeに「チャージ済み」と伝えると次の$20が解放されます。'],
    'Claude agent': ['Claude 智能体', 'Claudeエージェント'],
    'ChatGPT agent': ['ChatGPT 智能体', 'ChatGPTエージェント'],
    'Doubao agent': ['豆包智能体', 'doubaoエージェント'],
    'Offline rules': ['离线规则', 'オフラインルール'],
    'Your galaxy of films & archives': ['你的影片与档案星系', '作品とアーカイブの銀河'],
    'Board, characters, environments & timeline in one': ['看板、角色、环境与时间线合而为一', 'ボード・キャラ・環境・タイムラインをひとつに'],
    'The visual genome of your film': ['你影片的视觉基因', '作品のビジュアル遺伝子'],
    'Inside Scene Setup — sequence the whole constellation': ['就在场景搭建里——为整个星座排序', 'シーン設定の中に——星座まるごとシーケンス'],
  };

  var LANG = localStorage.getItem('adwLang') || 'en';

  function tr(s) {
    var e = D[s];
    if (!e) return null;
    return LANG === 'zh' ? e[0] : LANG === 'ja' ? e[1] : null;
  }

  var SKIP = { TEXTAREA: 1, INPUT: 1, SCRIPT: 1, STYLE: 1, PRE: 1 };

  function translateTextNode(n) {
    var raw = n.nodeValue;
    if (!raw) return;
    var s = raw.trim();
    if (!s) return;
    var out = tr(s);
    if (out && out !== s) n.nodeValue = raw.replace(s, out);
  }

  function translateAttrs(el) {
    ['placeholder', 'title', 'aria-label'].forEach(function (a) {
      var v = el.getAttribute && el.getAttribute(a);
      if (!v) return;
      var out = tr(v.trim());
      if (out) el.setAttribute(a, out);
    });
  }

  function walk(root) {
    if (LANG === 'en' || !root) return;
    var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        return n.parentElement && SKIP[n.parentElement.tagName]
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT;
      },
    });
    var nodes = [];
    while (w.nextNode()) nodes.push(w.currentNode);
    nodes.forEach(translateTextNode);
    if (root.querySelectorAll) {
      translateAttrs(root);
      root.querySelectorAll('[placeholder],[title],[aria-label]').forEach(translateAttrs);
      root.querySelectorAll('option').forEach(function (o) {
        var out = tr(o.textContent.trim());
        if (out) o.textContent = out;
      });
    }
  }

  var mo = new MutationObserver(function (muts) {
    if (LANG === 'en') return;
    muts.forEach(function (m) {
      m.addedNodes.forEach(function (n) {
        if (n.nodeType === 3) translateTextNode(n);
        else if (n.nodeType === 1 && !SKIP[n.tagName]) walk(n);
      });
      if (m.type === 'characterData' && m.target.nodeType === 3) translateTextNode(m.target);
    });
  });

  function apply() {
    if (LANG === 'en') return;
    walk(document.body);
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  // 切换控件由 AppShell 的 <LangSwitcher/>（React）渲染，本脚本只负责翻译引擎。
  function boot() {
    apply();
    // React 挂载晚于 DOMContentLoaded：重试几轮直到界面出现
    var tries = 0;
    var timer = setInterval(function () {
      if (LANG !== 'en') walk(document.body);
      if (document.querySelector('aside a') || ++tries > 40) clearInterval(timer);
    }, 250);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
