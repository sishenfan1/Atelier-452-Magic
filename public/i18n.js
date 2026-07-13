/* Atelier452 Magic — 中/EN/日 三语。
   机制：精确字符串字典 + 正则规则；MutationObserver 覆盖动态渲染内容。
   字典值为 [英文, 日文] 二元数组；规则为 [正则, 英文替换, 日文替换]。 */
'use strict';

const I18N = {
  // 顶栏 / Tabs
  '工作区 1': ['Workspace 1', 'ワークスペース 1'],
  '工作区 2': ['Workspace 2', 'ワークスペース 2'],
  '工作区 3': ['Workspace 3', 'ワークスペース 3'],
  '中割生成': ['In-betweens', '中割り生成'],
  '关键帧 → 补间动画': ['keyframes → tweened animation', '原画 → 中割りアニメーション'],
  '视频转绘上色': ['Repaint & Color', '転描・彩色'],
  '粗动画 → 参考图成片': ['rough anim → styled final', 'ラフ動画 → 参考画像で仕上げ'],
  '原画精修': ['Lineart Refine', '原画クリンナップ'],
  '草稿 → 完成版原画': ['tie-down → finished genga', 'ラフ → 完成原画'],
  '⚙ API 设置': ['⚙ API Settings', '⚙ API 設定'],
  '本地模拟（未配置 Key）': ['Local mock (no API key)', 'ローカルモック（API キー未設定）'],

  // 工作区 1
  '① 输入关键帧（原画）': ['① Input Keyframes (Genga)', '① キーフレーム入力（原画）'],
  '— 拖拽可排序': ['— drag to reorder', '— ドラッグで並べ替え'],
  '添加关键帧': ['Add keyframes', 'キーフレームを追加'],
  '图片顺序就是镜头顺序': ['image order = shot order', '画像の順序＝カットの順序'],
  '尚未添加关键帧': ['No keyframes yet', 'キーフレームはまだありません'],
  '② 时长与节奏': ['② Duration & Rhythm', '② 尺とテンポ'],
  '一体生成总时长': ['Single-gen total duration', '一括生成の総尺'],
  '自动 = 各关键帧「到下一帧时长」之和（限 4–15 秒），在左上角关键帧列表里逐帧调节': ['Auto = sum of per-keyframe gaps (capped 4–15s); adjust per keyframe in the list', '自動＝各キーフレームの「次のフレームまでの尺」の合計（4〜15 秒に制限）。左上のキーフレーム一覧で個別に調整できます'],
  '分段模式每段时长': ['Per-segment duration (legacy)', 'セグメントごとの尺（旧モード）'],
  '最短 4 秒': ['min 4s', '最短 4 秒'],
  '重映射总时长': ['Remap total duration', 'リマップ後の総尺'],
  '输出 fps': ['Output fps', '出力 fps'],
  '③ 提示词': ['③ Prompts', '③ プロンプト'],
  '演技强度（芝居）': ['Acting intensity (shibai)', '芝居の強さ'],
  '控制角色动作多快、多脆、多夸张 — 自动生成对应的内置演技提示词': ['How fast / snappy / exaggerated the acting is — builds the baked acting prompt', 'キャラの動きの速さ・キレ・誇張の度合いを調整 — 対応する芝居プロンプトを自動生成します'],
  '动作描述（所有分段共用）': ['Action description (shared)', 'アクション描写（全セグメント共通）'],
  '例：挥舞武士刀，动作流畅': ['e.g. swinging a katana, fluid motion', '例：刀を振るう、滑らかな動き'],
  '风格锁定': ['Style lock', '画風ロック'],
  '自动附加，保持画风与首尾帧一致': ['auto-appended; locks style to the keyframes', '自動付加。画風を前後のキーフレームに揃えます'],
  '中割运动锁定': ['In-between motion lock', '中割りモーションロック'],
  '自动附加，强制关键帧之间持续运动': ['auto-appended; forces continuous motion between keyframes', '自動付加。キーフレーム間の連続した動きを強制します'],
  '🎬 一体生成（全部关键帧 → 一段连续动画）': ['🎬 Generate as ONE video (all keyframes → one continuous animation)', '🎬 一括生成（全キーフレーム → 連続した 1 本のアニメ）'],
  '▶ 分段生成（两两补间，旧模式）': ['▶ Segmented generation (pairwise, legacy)', '▶ セグメント生成（2 枚ずつ中割り・旧モード）'],
  '已提交（可继续提交更多任务并行生成，进度见右下角）': ['Submitted (submit more to run in parallel; progress at bottom-right)', '送信しました（続けて投入すれば並列生成できます。進捗は右下に表示）'],
  '④ 连续预览': ['④ Preview', '④ 連続プレビュー'],
  '④ 生成回放': ['④ Generation Playback', '④ 生成プレビュー'],
  '— 点击历史版本载入；空格 播放/暂停；◀ ▶ 逐帧查看': ['— click a history version to load; Space = play/pause; ◀ ▶ step frame by frame', '— 履歴バージョンをクリックで読み込み。スペースで再生／一時停止、◀ ▶ でコマ送り'],
  '还没有生成结果 — 点「🎬 一体生成」后自动在这里循环播放': ['No results yet — after "🎬 Generate" the video loops here automatically', 'まだ結果がありません — 「🎬 一括生成」後、ここで自動ループ再生されます'],
  '⏴ 上一帧': ['⏴ Prev frame', '⏴ 前のコマ'],
  '下一帧 ⏵': ['Next frame ⏵', '次のコマ ⏵'],
  '⏯ 播放 / 暂停（空格）': ['⏯ Play / Pause (Space)', '⏯ 再生／一時停止（スペース）'],
  '▶ 连续播放': ['▶ Play all', '▶ 連続再生'],
  '⧉ 重映射播放': ['⧉ Remap play', '⧉ リマップ再生'],
  '■ 停止': ['■ Stop', '■ 停止'],
  '循环': ['Loop', 'ループ'],
  '自动缓急': ['Auto ease', '自動緩急'],
  '感度': ['Sens.', '感度'],
  '位置显示': ['Time', '時間表示'],
  '帧数显示': ['Frames', 'フレーム表示'],
  '⬇ 拼接导出 (mp4)': ['⬇ Export mp4 (concat)', '⬇ 連結書き出し (mp4)'],
  '⬇ PNG 序列导出 (zip)': ['⬇ Export PNG seq (zip)', '⬇ PNG 連番書き出し (zip)'],
  '按重映射导出': ['Export with remap', 'リマップ適用で書き出し'],
  '自动缓急开启时：感度越高，平缓处抽帧越狠、大动作处保留越多。': ['Auto-ease: higher sensitivity drops more frames in calm parts, keeps more in big motion.', '自動緩急オン時：感度が高いほど、動きの少ない部分は強く間引き、大きな動きのフレームは多く残します。'],
  '⏱ 宏观时间轴': ['⏱ Macro Timeline', '⏱ マクロタイムライン'],
  '— 左右拖动关键帧调整间距（改变与前一帧的时长）；点击两帧之间的段落条编辑该段动作与演技': ['— drag keyframes to adjust spacing; click a gap bar to edit its action & acting', '— キーフレームを左右にドラッグして間隔（前フレームからの尺）を調整。フレーム間のバーをクリックすると、その区間のアクションと芝居を編集できます'],
  '上传至少 2 张关键帧后显示': ['Shown after adding 2+ keyframes', 'キーフレームを 2 枚以上追加すると表示されます'],
  '⑤ 一体生成结果': ['⑤ Single-gen Results', '⑤ 一括生成の結果'],
  '— 全部关键帧一次成片，点历史版本回看': ['— one video per run; click history to review', '— 全キーフレームを一度に映像化。履歴のバージョンをクリックで再確認'],
  '还没有一体生成结果 — 上传关键帧后点「🎬 一体生成」': ['No results yet — add keyframes and hit "🎬 Generate as ONE video"', 'まだ結果がありません — キーフレームを追加して「🎬 一括生成」を押してください'],
  '⑥ 分段时间线': ['⑥ Segment Timeline', '⑥ セグメントタイムライン'],
  '— 分段模式：每段可切版本 / 重新生成 / 详细设置': ['— segmented mode: switch versions / regen / details per segment', '— セグメントモード：各セグメントでバージョン切替／再生成／詳細設定が可能'],
  '输入图像': ['Input Images', '入力画像'],
  '全部关键帧 → 一段连续动画': ['All keyframes → one continuous animation', '全キーフレーム → 連続した 1 本のアニメ'],
  '时长': ['Time', '尺'],
  '演技': ['Act', '芝居'],
  '↳ 这一段的动作描述（可选，如：转身挥刀劈下）': ['↳ Action for this gap (optional)', '↳ この区間のアクション描写（任意。例：振り向きざまに斬り下ろす）'],
  '拖拽排序': ['Drag to reorder', 'ドラッグで並べ替え'],
  '删除': ['Delete', '削除'],
  '全局': ['global', '共通'],

  // 工作区 2
  '① 源视频（粗动画）': ['① Source Video (rough)', '① 元動画（ラフアニメ）'],
  '添加粗动画视频': ['Add rough animation video', 'ラフアニメ動画を追加'],
  '作为上色和成片转绘的第一遍动画': ['first-pass animation to repaint into the final', '彩色・仕上げ転描のベースとなる一次アニメ'],
  '⇊ 使用「中割生成」的拼接结果': ['⇊ Use concat result from Workspace 1', '⇊ 「中割り生成」の連結結果を使用'],
  '② 上色参考图': ['② Color Reference Images', '② 彩色の参考画像'],
  '添加上色参考图': ['Add color references', '彩色の参考画像を追加'],
  '角色、线条、配色和质感参考': ['character / lines / palette / texture refs', 'キャラクター・線画・配色・質感の参考'],
  '点击选择 或 拖入参考图（可多张）': ['Click or drop images (multiple OK)', 'クリックで選択、または参考画像をドロップ（複数可）'],
  '③ 转绘设置': ['③ Repaint Settings', '③ 転描設定'],
  '内置上色提示词': ['Baked coloring prompt', '内蔵の彩色プロンプト'],
  '自动作为主指令': ['used as the main instruction', 'メイン指示として自動使用'],
  '补充描述（可选）': ['Extra notes (optional)', '補足説明（任意）'],
  '例：赛璐璐上色，柔和晨光': ['e.g. cel shading, soft morning light', '例：セル塗り、柔らかな朝の光'],
  '生成时长': ['Duration', '生成する尺'],
  '最短 4 秒，建议与源视频等长': ['min 4s; match source length', '最短 4 秒。元動画と同じ長さを推奨'],
  '🎨 开始转绘上色': ['🎨 Repaint & Color', '🎨 転描・彩色を開始'],
  '④ 转绘结果': ['④ Result', '④ 転描結果'],
  '还没有转绘结果 — 在左侧设置源视频与参考图后点「开始转绘上色」': ['No results yet — set source video & refs, then hit "Repaint & Color"', 'まだ結果がありません — 左側で元動画と参考画像を設定し、「転描・彩色を開始」を押してください'],
  '⑤ 生成历史': ['⑤ History', '⑤ 生成履歴'],
  '— 点击任意版本回看': ['— click any version to review', '— 任意のバージョンをクリックで再確認'],

  // 工作区 3（精修）
  '① 源图片': ['① Source Image', '① 元画像'],
  '添加要精修的图片': ['Add an image to refine', 'クリンナップする画像を追加'],
  '草稿、tie-down 或粗线稿': ['sketch, tie-down or rough lineart', 'ラフ、タイダウン、または粗い線画'],
  '或点击下方关键帧直接选用：': ['or pick a keyframe below:', 'または下のキーフレームから選択：'],
  '② 精修设置': ['② Refine Settings', '② クリンナップ設定'],
  '内置精修提示词': ['Baked refine prompt', '内蔵のクリンナッププロンプト'],
  '自动作为主指令，可按需修改': ['main instruction; edit as needed', 'メイン指示として使用。必要に応じて編集できます'],
  '🖌 开始精修': ['🖌 Refine', '🖌 クリンナップ開始'],
  '③ 精修结果': ['③ Result', '③ クリンナップ結果'],
  '— 左原图 / 右精修后': ['— left: original / right: refined', '— 左：元画像 ／ 右：クリンナップ後'],
  '还没有精修结果 — 选择源图片后点「🖌 开始精修」': ['No results yet — pick a source image and hit "🖌 Refine"', 'まだ結果がありません — 元画像を選んで「🖌 クリンナップ開始」を押してください'],
  '④ 精修历史': ['④ History', '④ クリンナップ履歴'],
  '⬇ 下载': ['⬇ Download', '⬇ ダウンロード'],
  '➕ 添加为关键帧': ['➕ Add as keyframe', '➕ キーフレームとして追加'],
  '原图': ['Before', '元画像'],
  '精修后': ['After', 'クリンナップ後'],

  // 提示词库
  '提示词库': ['Prompt Library', 'プロンプトライブラリ'],
  '— 点击预设一键填入': ['— click a preset to apply', '— プリセットをクリックで即入力'],
  '暂无预设 — 在下方保存当前提示词': ['No presets yet — save the current prompt below', 'プリセットはまだありません — 下で現在のプロンプトを保存してください'],
  '预设名称': ['Preset name', 'プリセット名'],
  '★ 保存当前框内容为预设': ['★ Save current text as preset', '★ 現在の内容をプリセットとして保存'],
  '已填入': ['Applied', '入力しました'],
  '已保存': ['Saved', '保存しました'],
  '已删除': ['Deleted', '削除しました'],
  '已复制': ['Copied', 'コピーしました'],
  '填入': ['Apply', '入力'],
  '复制': ['Copy', 'コピー'],
  '下载': ['Download', 'ダウンロード'],
  '未下载': ['Not downloaded', '未ダウンロード'],
  '张关键帧': ['keyframes', 'キーフレーム'],
  '送去转绘上色': ['Send to Repaint & Color', '転描・彩色へ送る'],
  '保存为预设': ['Save as preset', 'プリセットとして保存'],
  '我的预设': ['My presets', 'マイプリセット'],
  '最近使用': ['Recently used', '最近使用'],
  '新建提示词': ['New prompt', '新規プロンプト'],
  '粘贴/编写后保存为预设': ['paste or write, then save as a preset', '貼り付け・記入してプリセットとして保存'],
  '在此粘贴或编写提示词…': ['Paste or write a prompt here…', 'ここにプロンプトを貼り付け・記入…'],
  '★ 保存为预设': ['★ Save as preset', '★ プリセットとして保存'],
  '还没有使用记录 — 生成一次即自动记录': ['No usage history yet — generate once to auto-record', '使用履歴はまだありません — 一度生成すると自動記録されます'],
  '当前提示词框是空的': ['The prompt box is empty', 'プロンプト欄が空です'],
  // 提示词库浮动面板 + JSON 转换器
  '通用': ['General', '汎用'],
  '分镜': ['Storyboard', '絵コンテ'],
  '质检': ['QA', '品質チェック'],
  '历史': ['History', '履歴'],
  '名称': ['Name', '名前'],
  '名称（可选）': ['Name (optional)', '名前（任意）'],
  '★ 保存': ['★ Save', '★ 保存'],
  '★ 存入库': ['★ Add to library', '★ ライブラリへ保存'],
  '⬇ 下载 .json': ['⬇ Download .json', '⬇ .json をダウンロード'],
  '复制 JSON': ['Copy JSON', 'JSON をコピー'],
  '已下载 .json': ['Downloaded .json', '.json をダウンロードしました'],
  '已复制 JSON': ['Copied JSON', 'JSON をコピーしました'],
  '已存入库': ['Added to library', 'ライブラリへ保存しました'],
  '编辑': ['Edit', '編集'],
  '取消': ['Cancel', 'キャンセル'],
  '此分类还没有提示词 — 在下方新建': ['No prompts in this category yet — create one below', 'このカテゴリにはまだプロンプトがありません — 下で新規作成'],
  '点击提示词即填入目标框': ['Click a prompt to fill the target box', 'プロンプトをクリックすると対象欄に入力されます'],
  '粘贴任意提示词 → 实时转换为标准 JSON（自动识别「负向/negative」行）': ['Paste any prompt → live-converts to standard JSON (auto-detects a "negative:" line)', '任意のプロンプトを貼り付け → 標準 JSON にリアルタイム変換（「negative/负向」行を自動認識）'],
  '在此粘贴提示词…': ['Paste a prompt here…', 'ここにプロンプトを貼り付け…'],
  '拖动移动面板': ['Drag to move the panel', 'ドラッグでパネルを移動'],

  // 工作区 4：提示词库整页
  '工作区 4': ['Workspace 4', 'ワークスペース 4'],
  '存储 · 分区 · JSON': ['store · sections · JSON', '保存・セクション・JSON'],
  '✍ 新提示词': ['✍ New Prompt', '✍ 新規プロンプト'],
  '在此粘贴或撰写提示词…': ['Paste or write a prompt here…', 'ここにプロンプトを貼り付け・記入…'],
  '💾 保存提示词': ['💾 Save Prompt', '💾 プロンプトを保存'],
  '🗂 分区': ['🗂 Sections', '🗂 セクション'],
  '— 点击进入；双击名称重命名；把提示词拖到分区上即可移动': ['— click to open; double-click a name to rename; drag prompts onto a section to move them', '— クリックで開く。名前をダブルクリックで改名。プロンプトをセクションへドラッグで移動'],
  '＋ 新建分区': ['＋ New section', '＋ 新規セクション'],
  '⬅ 全部分区': ['⬅ All sections', '⬅ 全セクション'],
  '📤 上传提示词文件': ['📤 Upload prompt files', '📤 プロンプトファイルをアップロード'],
  '✕ 删除分区': ['✕ Delete section', '✕ セクションを削除'],
  '删除分区': ['Delete section', 'セクションを削除'],
  '双击重命名': ['Double-click to rename', 'ダブルクリックで名前変更'],
  '转为 JSON': ['Translate to JSON', 'JSON に変換'],
  '保存到哪个分区？': ['Save to which section?', 'どのセクションに保存しますか？'],
  '或新建分区…': ['or create a new section…', 'または新規セクション…'],
  '＋ 新建并保存': ['＋ Create & save', '＋ 作成して保存'],
  '此分区还没有提示词 — 在下方新建': ['No prompts in this section yet — create one below', 'このセクションにはまだプロンプトがありません — 下で新規作成'],
  '此分区还没有提示词 — 左侧写好后点「保存提示词」，或上传文件': ['No prompts in this section yet — write one on the left and hit "Save Prompt", or upload files', 'このセクションにはまだプロンプトがありません — 左で記入して「プロンプトを保存」を押すか、ファイルをアップロード'],
  '拖到分区芯片即可移动 →': ['drag onto a section chip to move →', 'セクションチップへドラッグで移動 →'],
  '条提示词': ['prompts', '件のプロンプト'],
  '已移动到': ['Moved to', '移動しました →'],
  '载入左侧编辑框': ['Load into the left editor', '左のエディタに読み込む'],
  '已载入左侧编辑框': ['Loaded into the left editor', '左のエディタに読み込みました'],
  '分区': ['Section', 'セクション'],
  '请先在左侧输入提示词': ['Write a prompt on the left first', '先に左側でプロンプトを入力してください'],
  '已保存到': ['Saved to', '保存しました →'],
  '已导入': ['Imported', 'インポートしました'],
  '至少保留一个分区': ['Keep at least one section', '少なくとも 1 つのセクションが必要です'],
  '其中': ['It contains', '内部の'],
  '条提示词将一并删除': ['prompts will be deleted with it', '件のプロンプトも一緒に削除されます'],
  '默认': ['Default', 'デフォルト'],
  '🎬 一体生成': ['🎬 Generate', '🎬 一括生成'],
  '①+ 角色设定 / 色卡参考': ['①+ Character Sheet / Color Refs', '①+ キャラ設定・色指定の参考'],
  '添加设定参考图': ['Add design reference images', '設定参考画像を追加'],
  '彩色模型表、色卡均可——只取角色设计，不取姿势与颜色': ['color model sheets OK — design only; pose & colors are ignored', 'カラー設定表・色見本もOK。デザインのみ参照し、ポーズと色は使いません'],

  // 弹窗
  '分段详细设置': ['Segment Details', 'セグメント詳細設定'],
  '本段提示词（留空则用公共提示词）': ['Segment prompt (blank = shared prompt)', 'このセグメントのプロンプト（空欄なら共通プロンプトを使用）'],
  '本段时长': ['Segment duration', 'このセグメントの尺'],
  '↻ 用以上设置重新生成': ['↻ Regenerate with these settings', '↻ この設定で再生成'],
  '关闭': ['Close', '閉じる'],
  '段落设置': ['Gap Settings', '区間設定'],
  '本段时长（秒）': ['Gap duration (s)', 'この区間の尺（秒）'],
  '本段演技': ['Gap acting', 'この区間の芝居'],
  '本段动作描述': ['Gap action description', 'この区間のアクション描写'],
  '这两帧之间发生的具体动作（连续、物理可信的运动）': ['what happens between these two keyframes (continuous, physically believable motion)', 'この 2 フレームの間で起こる具体的なアクション（連続的で物理的に自然な動き）'],
  '例：重心下沉，猛地转身，刀刃划出弧线劈下': ['e.g. weight drops, whips around, blade arcs down', '例：重心を落とし、勢いよく振り向き、刃が弧を描いて斬り下ろす'],
  '保存': ['Save', '保存'],
  'API 设置（火山方舟 · Seedance）': ['API Settings (Volcengine Ark · Seedance)', 'API 設定（Volcengine Ark · Seedance）'],
  '留空则使用本地模拟': ['blank = local mock mode', '空欄ならローカルモックを使用'],
  '接入点': ['Endpoint', 'エンドポイント'],
  '华北（cn-beijing）': ['China (cn-beijing)', '中国（cn-beijing）'],
  '海外（BytePlus ap-southeast）': ['Global (BytePlus ap-southeast)', '海外（BytePlus ap-southeast）'],
  '中割模型 ID': ['In-between model ID', '中割りモデル ID'],
  '转绘模型 ID（需支持视频输入）': ['Repaint model ID (needs video input)', '転描モデル ID（動画入力対応が必要）'],
  '精修模型 ID（图生图）': ['Refine model ID (image-to-image)', 'クリンナップモデル ID（画像→画像）'],
  '分辨率': ['Resolution', '解像度'],
  '画幅': ['Ratio', 'アスペクト比'],
  '公网基址（可选）': ['Public base URL (optional)', '公開ベース URL（任意）'],
  '转绘的参考视频需公网可访问；留空自动用 cloudflared 隧道': ['reference video must be publicly reachable; blank = auto cloudflared tunnel', '転描の参考動画は公開アクセス可能である必要があります。空欄なら cloudflared トンネルを自動使用'],
  '清除 Key（转本地模拟）': ['Clear key (switch to mock)', 'キーを消去（ローカルモックへ切替）'],
  '已清除 Key，切换到本地模拟': ['Key cleared; switched to local mock', 'キーを消去し、ローカルモックに切り替えました'],
  '保存失败': ['Save failed', '保存に失敗しました'],

  // 动态状态
  '待生成': ['Pending', '生成待ち'],
  '生成中': ['Generating', '生成中'],
  '失败': ['Failed', '失敗'],
  '未生成': ['Not generated', '未生成'],
  '重生成': ['Regen', '再生成'],
  '详细': ['Detail', '詳細'],
  '已停止': ['Stopped', '停止しました'],
  '播放完成': ['Finished', '再生完了'],
  '抽帧准备中…': ['Preparing frames…', 'フレーム抽出の準備中…'],
  '无可播放分段': ['Nothing to play', '再生できるセグメントがありません'],
  '当前': ['current', '現在'],
  '✓ 完成': ['✓ Done', '✓ 完了'],
  '✕ 失败': ['✕ Failed', '✕ 失敗'],
  '克制': ['Subtle', '控えめ'],
  '自然': ['Natural', 'ナチュラル'],
  '生动': ['Lively', '生き生き'],
  '夸张': ['Exaggerated', '誇張'],
  '极限作画': ['Sakuga', '神作画'],
  '服务器拼接中…': ['Concatenating on server…', 'サーバーで連結中…'],
  '已导出拼接 mp4': ['Exported concat mp4', '連結 mp4 を書き出しました'],
  '转码 mp4 中…': ['Transcoding mp4…', 'mp4 に変換中…'],
  '已导出重映射 mp4': ['Exported remapped mp4', 'リマップ mp4 を書き出しました'],
  '点击编辑本段动作 / 演技 / 时长': ['Click to edit this gap (action / acting / duration)', 'クリックでこの区間のアクション／芝居／尺を編集'],
  '请先选择要精修的源图片': ['Pick a source image to refine first', '先にクリンナップする元画像を選んでください'],
  '当前提示词框是空的': ['The target prompt box is empty', 'プロンプト欄が空です'],
  '点击选择 或 拖入图片（可多选）': ['Click or drop images (multiple OK)', 'クリックで選択、または画像をドロップ（複数可）'],
  '点击选择 或 拖入视频': ['Click or drop a video', 'クリックで選択、または動画をドロップ'],
  '精修引擎': ['Refine engine', 'クリンナップエンジン'],
  'Ark Seedream（火山方舟）': ['Ark Seedream (Volcengine)', 'Ark Seedream（Volcengine）'],
  'GPT Image 2（OpenAI 兼容）': ['GPT Image 2 (OpenAI-compatible)', 'GPT Image 2（OpenAI 互換）'],
  '精修模型 ID（Seedream）': ['Refine model ID (Seedream)', 'クリンナップモデル ID（Seedream）'],
  'OpenAI 兼容接口地址': ['OpenAI-compatible base URL', 'OpenAI 互換 API のベース URL'],
  '官方或中转站基址': ['official or relay base URL', '公式または中継サーバーのベース URL'],
  'GPT Image 模型 ID': ['GPT Image model ID', 'GPT Image モデル ID'],
  '留空保持不变': ['blank = keep current', '空欄なら変更なし'],
  '已配置（留空保持不变）': ['configured (blank = keep)', '設定済み（空欄なら変更なし）'],
};

// 含数字/插值的动态字符串：[正则, EN, JA]
const I18N_RULES = [
  [/^分段 (\d+)\/(\d+)$/, 'Segment $1/$2', 'セグメント $1/$2'],
  [/^重映射播放 (.+)$/, 'Remap play $1', 'リマップ再生 $1'],
  [/^版本 (\d+)$/, 'Version $1', 'バージョン $1'],
  [/^(\d+) 秒$/, '$1 s', '$1 秒'],
  [/^(.+) 秒（超出范围，将按 (\d+)s 生成）$/, '$1 s (out of range; will generate at $2s)', '$1 秒（範囲外のため $2 秒で生成します）'],
  [/^🎬 一体生成 (\d+)帧 → (\d+)s$/, '🎬 Single-gen $1 frames → $2s', '🎬 一括生成 $1 フレーム → $2 秒'],
  [/^🎨 转绘上色 (\d+)s · (\d+) 张参考图$/, '🎨 Repaint $1s · $2 refs', '🎨 転描・彩色 $1 秒 · 参考画像 $2 枚'],
  [/^🖌 精修 (.+)$/, '🖌 Refine $1', '🖌 クリンナップ $1'],
  [/^(.+) · (\d+)s · (\d+) 张参考图$/, '$1 · $2s · $3 refs', '$1 · $2 秒 · 参考画像 $3 枚'],
  [/^(.+) · (\d+)s · (\d+) 张关键帧$/, '$1 · $2s · $3 keyframes', '$1 · $2 秒 · キーフレーム $3 枚'],
  [/^Seedance API$/, 'Seedance API', 'Seedance API'],
];

const LANGS = ['zh', 'en', 'ja'];        // 语言循环顺序
const LANG_IDX = { en: 0, ja: 1 };       // 字典数组下标
const NEXT_LABEL = { zh: 'EN', en: '日', ja: '中' };  // 按钮显示"下一个语言"

let LANG = localStorage.getItem('a452lang') || 'zh';
if (!LANGS.includes(LANG)) LANG = 'zh';

function t(zh) {
  if (LANG === 'zh') return zh;
  const idx = LANG_IDX[LANG];
  const entry = I18N[zh];
  if (entry) return entry[idx] || entry[0] || zh;
  for (const [re, en, ja] of I18N_RULES) {
    if (re.test(zh)) {
      const rep = (idx === 1 ? (ja || en) : en);
      return zh.replace(re, rep);
    }
  }
  return zh;
}

function translateNodeText(node) {
  const raw = node.nodeValue;
  const s = raw.trim();
  if (!s) return;
  const out = t(s);
  if (out !== s) node.nodeValue = raw.replace(s, out);
}

const SKIP_TAGS = new Set(['TEXTAREA', 'INPUT', 'SCRIPT', 'STYLE', 'SELECT']);

function translateTree(root) {
  if (LANG === 'zh' || !root) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement && SKIP_TAGS.has(n.parentElement.tagName))
      ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  nodes.forEach(translateNodeText);
  const attrRoot = root.nodeType === 1 ? [root, ...root.querySelectorAll('[placeholder],[title]')]
                                       : [...(root.querySelectorAll ? root.querySelectorAll('[placeholder],[title]') : [])];
  for (const el of attrRoot) {
    for (const attr of ['placeholder', 'title']) {
      const v = el.getAttribute && el.getAttribute(attr);
      if (v) {
        const out = t(v.trim());
        if (out !== v.trim()) el.setAttribute(attr, out);
      }
    }
  }
  // option 元素文本
  if (root.querySelectorAll) {
    for (const opt of root.querySelectorAll('option')) {
      const out = t(opt.textContent.trim());
      if (out !== opt.textContent.trim()) opt.textContent = out;
    }
  }
}

// 动态渲染内容自动翻译
const i18nObserver = new MutationObserver((muts) => {
  if (LANG === 'zh') return;
  for (const m of muts) {
    for (const node of m.addedNodes) {
      if (node.nodeType === 3) translateNodeText(node);
      else if (node.nodeType === 1 && !SKIP_TAGS.has(node.tagName)) translateTree(node);
    }
    if (m.type === 'characterData' && m.target.nodeType === 3 &&
        m.target.parentElement && !SKIP_TAGS.has(m.target.parentElement.tagName)) {
      translateNodeText(m.target);
    }
  }
});

// 应用当前语言（页面加载后调用）：zh 保持原文；en/ja 翻译整树并监听动态内容
function applyLang() {
  if (LANG === 'zh') return;
  translateTree(document.body);
  i18nObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  document.documentElement.lang = LANG;
}

// 切换语言：统一存储后刷新页面，DOMContentLoaded 时再应用 — 避免混合语言状态
function setLang(lang) {
  if (!LANGS.includes(lang) || lang === LANG) return;
  LANG = lang;
  localStorage.setItem('a452lang', lang);
  location.reload();
}

window.addEventListener('DOMContentLoaded', () => {
  // 三语并排分段控件（#langSeg 中的 data-lang 按钮），当前语言高亮
  const seg = document.getElementById('langSeg');
  if (seg) {
    seg.querySelectorAll('button[data-lang]').forEach((b) => {
      const lang = b.dataset.lang;
      b.classList.toggle('active', lang === LANG);
      b.setAttribute('aria-pressed', lang === LANG ? 'true' : 'false');
      b.onclick = () => setLang(lang);
    });
  }
  // 兼容旧的单按钮（若存在）
  const btn = document.getElementById('btnLang');
  if (btn) {
    btn.textContent = NEXT_LABEL[LANG] || 'EN';
    btn.onclick = () => setLang(LANGS[(LANGS.indexOf(LANG) + 1) % LANGS.length]);
  }
  applyLang();
});
