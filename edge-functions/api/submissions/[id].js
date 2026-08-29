// /api/submissions/:id —— 剧本管线：提交详情 / 阶段确认 / 剧本模块编辑 / 审阅图片
// GET   ?img=<key>   管理员拉取审阅图片（二进制）
// GET   无参数       公开进度查询（含阶段摘要）；带 Bearer ADMIN_TOKEN 返回完整记录
// PATCH action 分发：stage-content / decision / edit-ep / assets-choice / asset-put / publish-done
//       无 action 字段时兼容旧版 {status, note} 状态流转

const PREFIX = 'sub_';

const STATUS_LABELS = {
  received: '已接收',
  reviewing: '人工审核中',
  generating: '撰写管线中',
  published: '已上线',
  rejected: '未通过',
};

const STAGE_LABELS = {
  outline: '大纲',
  synopsis: '分集梗概',
  script: '完整剧本',
  assets: '视觉资产',
  publish: '发布上线',
  done: '已完成',
};

const STAGE_ORDER = ['outline', 'synopsis', 'script', 'assets', 'publish', 'done'];

const STAGE_STATUS_LABELS = {
  empty: '未开始',
  requested: '已请求生成',
  draft: '生成中',
  pending_review: '待确认',
  approved: '已通过',
  rejected: '已驳回',
  awaiting_choice: '待选择',
  generating: '生成中',
  skipped: '已跳过',
  pending: '待发布',
  done: '已完成',
};

const IMG_KEY_RE = /^[a-z0-9_]{1,40}$/;
const ID_RE = /^SR_\d{8}_[A-Za-z0-9]{8}$/;
const MAX_EP_JSON = 200 * 1024;

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function kv() {
  return typeof SUBMISSIONS_KV !== 'undefined' ? SUBMISSIONS_KV : null;
}

function adminOk(request, env) {
  const token = env && env.ADMIN_TOKEN;
  if (!token) return { ok: false, resp: json({ ok: false, error: 'ADMIN_TOKEN_UNSET', message: '未配置管理令牌：请在项目设置 → 环境变量中添加 ADMIN_TOKEN，并重新部署' }, 503) };
  const h = request.headers.get('Authorization') || '';
  if (h !== 'Bearer ' + token) return { ok: false, resp: json({ ok: false, error: 'UNAUTHORIZED', message: '鉴权失败' }, 401) };
  return { ok: true };
}

async function sha256Hex(data) {
  const buf = await crypto.subtle.digest('SHA-256', typeof data === 'string' ? new TextEncoder().encode(data) : data);
  return Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
}

// 管理员（Bearer ADMIN_TOKEN）或提交者（X-Edit-Key / ?key=，比对记录内 editKeyHash）
// hasCreds：请求是否携带了任何凭据（用于 GET 区分「匿名公开查询」与「凭据错误的 401」）
async function editorOk(request, env, rec, url) {
  const adm = adminOk(request, env);
  if (adm.ok) return { ok: true, role: 'admin' };

  const keyHeader = request.headers.get('X-Edit-Key');
  const keyQuery = url ? url.searchParams.get('key') : null;
  const key = String(keyHeader || keyQuery || '').trim();
  const hasCreds = !!(request.headers.get('Authorization') || keyHeader !== null || keyQuery !== null);
  const fail = function (message) {
    return { ok: false, hasCreds: hasCreds, resp: json({ ok: false, error: 'UNAUTHORIZED', message: message }, 401) };
  };
  if (!key || !rec.editKeyHash) return fail('鉴权失败');
  if (await sha256Hex(key) !== rec.editKeyHash) return fail('编辑密钥不正确');
  return { ok: true, role: 'editor' };
}

function clean(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function stageOf(rec) {
  return rec.stage && STAGE_LABELS[rec.stage] ? rec.stage : 'outline';
}

function entryOf(rec, stage) {
  return (rec.stages && rec.stages[stage]) || null;
}

function statusOf(rec, stage) {
  const e = entryOf(rec, stage);
  return e && e.status ? e.status : 'empty';
}

function stageSummary(rec) {
  const st = stageOf(rec);
  const ss = st === 'done' ? 'done' : statusOf(rec, st);
  return {
    stage: st,
    stageLabel: STAGE_LABELS[st],
    stageStatus: ss,
    stageStatusLabel: STAGE_STATUS_LABELS[ss] || ss,
  };
}

function stageStatuses(rec) {
  const out = {};
  for (const s of STAGE_ORDER) out[s] = statusOf(rec, s);
  return out;
}

function touch(rec) {
  rec.updatedAt = new Date().toISOString();
}

function addEvent(rec, type, stage, label) {
  if (!Array.isArray(rec.events)) rec.events = [];
  rec.events.push({ t: new Date().toISOString(), type: type, stage: stage || '', label: clean(label, 80) });
  if (rec.events.length > 60) rec.events = rec.events.slice(-60);
}

async function loadRecord(store, id) {
  const raw = await store.get(PREFIX + id);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

async function saveRecord(store, rec) {
  const s = JSON.stringify(rec);
  if (s.length > 20 * 1024 * 1024) throw new Error('记录体积超限（>20MB），无法保存');
  await store.put(PREFIX + rec.id, s);
}

function sanitizeScene(sc) {
  if (!sc || typeof sc !== 'object') return null;
  const lines = Array.isArray(sc.lines)
    ? sc.lines.filter(function (l) { return l && typeof l === 'object'; }).map(function (l) {
        return { s: clean(l.s, 40), l: clean(l.l, 2000), lZh: clean(l.lZh, 2000) };
      })
    : [];
  return { no: Number(sc.no) || 0, slug: clean(sc.slug, 200), action: clean(sc.action, 2000), lines: lines };
}

function sanitizeEpisode(ep, opts) {
  const scenes = Array.isArray(ep.scenes) ? ep.scenes.map(sanitizeScene).filter(Boolean) : [];
  const o = { ep: Number(ep.ep) || 0, title: clean(ep.title, 120), hook: clean(ep.hook, 300), scenes: scenes };
  if (opts && opts.edited) o.edited = true;
  return o;
}

function sanitizeSynopsisEp(e) {
  if (!e || typeof e !== 'object') return null;
  return {
    ep: Number(e.ep) || 0,
    title: clean(e.title, 120),
    hook: clean(e.hook, 300),
    beat: clean(e.beat, 600),
    paymark: clean(e.paymark, 40),
  };
}

function sanitizeAssetItem(it) {
  if (!it || typeof it !== 'object') return null;
  return { key: clean(it.key, 40), label: clean(it.label, 60), aspect: clean(it.aspect, 12), mime: clean(it.mime, 40) || 'image/jpeg' };
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function errOut(status, error, message) {
  return { err: { s: status, b: { ok: false, error: error, message: message } } };
}

/* ============ v1.7 真实 AI 生成引擎（Moonshot / 速创） ============ */

const PAIRING_NAMES = { bg: 'BG 男女主', bl: 'BL 男男', gl: 'GL 女女' };
const CATEGORY_NAMES = {
  'fated-mates': '狼人命定 Fated Mates', billionaire: '亿万总裁 Billionaire',
  mafia: '黑帮契约 Mafia', rebirth: '重生复仇 Rebirth',
  'hidden-identity': '隐藏身份 Hidden Identity', contract: '契约婚姻 Contract Marriage',
};
const GEN_SYS = '你是北美本土竖屏女频短剧（60-80集）的资深编剧策划，深谙 ReelShort / DramaBox 风格：强钩子、快节奏、高频卡点。输出必须是合法 JSON（无 markdown、无注释、无尾随逗号），英文字段用地道北美口语，中文字段简洁有力。';
const LOCK_MS = 90 * 1000;
const SYN_BATCH = 12;   // 梗概每批集数
const OUTLINE_STEPS = 3; // 大纲拆 3 批：设定 / 人物 / 五幕
/* kimi-k3 单批生成实测 20-50s；EdgeOne 边缘函数 fetch 默认超时 15s（必 504），
   需经 eo.timeoutSetting 显式放宽（平台上限 300s），AbortController 作双保险 */
const FETCH_TIMEOUT_MS = 110 * 1000;

/* 带超时的 fetch（AbortController 手动实现，兼容各边缘运行时）；超时/网络错误返回 {err}。
   EdgeOne 运行时通过 eo.timeoutSetting 放宽出网超时（默认 15s），本地 Node 忽略该字段 */
async function fetchT(url, opt, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, ms);
  try {
    const merged = Object.assign({}, opt, { signal: ctrl.signal });
    merged.eo = { timeoutSetting: { connectTimeout: 15000, readTimeout: ms, writeTimeout: 30000 } };
    return await fetch(url, merged);
  } catch (e) {
    const name = (e && e.name) || 'network';
    return { err: name === 'AbortError' ? 'FETCH_TIMEOUT（>' + Math.round(ms / 1000) + 's，稍后自动重试）' : 'FETCH_FAIL（' + name + '）' };
  } finally {
    clearTimeout(timer);
  }
}

/* Moonshot（OpenAI 兼容）非流式调用，json_object 模式；不传 temperature（k 系列仅允许 1）。
   默认 kimi-k3（纯思考模型，默认 effort=max 太慢）：降 reasoning_effort=low，单批 10-30s；
   思考 token 计入 max_tokens，调用侧已给足余量；content 为干净 JSON */
async function kimiChat(env, userPrompt, maxTokens, rec) {
  const key = env.KIMI_API_KEY || '';
  if (!key) return { err: 'KIMI_KEY_UNSET（请在项目环境变量配置 KIMI_API_KEY）' };
  const baseUrl = (env.KIMI_BASE_URL || 'https://api.moonshot.cn/v1').replace(/\/+$/, '');
  const model = env.KIMI_MODEL || 'kimi-k3';
  const body = {
    model: model,
    messages: [{ role: 'system', content: GEN_SYS }, { role: 'user', content: userPrompt }],
    max_tokens: maxTokens, response_format: { type: 'json_object' },
  };
  if (/^kimi-k/.test(model)) body.reasoning_effort = 'low';
  /* 429 引擎过载自动退避重试（最多 2 次），仍失败则透出错误由前端 8s 循环兜底 */
  let res = null, last429 = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise(function (r) { setTimeout(r, 5000); });
    res = await fetchT(baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, FETCH_TIMEOUT_MS);
    if (res.err) return { err: 'KIMI_' + res.err };
    if (res.status !== 429) break;
    last429 = res;
  }
  if (res.status === 429) {
    let m429 = '';
    try { m429 = ((await last429.json()) || {}).error || {}; } catch (_) {}
    return { err: 'KIMI_HTTP_429' + (m429.message ? '：' + String(m429.message).slice(0, 80) : '（引擎过载，稍后自动重试）') };
  }
  if (!res.ok) {
    let msg = '';
    try { msg = ((await res.json()) || {}).error || {}; } catch (_) {}
    return { err: 'KIMI_HTTP_' + res.status + (msg.message ? '：' + String(msg.message).slice(0, 80) : '') };
  }
  let data;
  try { data = await res.json(); } catch (_) { return { err: 'KIMI_BAD_RESPONSE' }; }
  const c = data && data.choices && data.choices[0];
  if (!c || !c.message || !c.message.content) return { err: 'KIMI_EMPTY_CONTENT' };
  /* 记录实际使用的模型（回显上游 data.model），供工作台/接口直接核验 */
  if (rec) rec.genModel = data.model || model;
  return { text: c.message.content };
}

/* 容错 JSON 解析：strip 代码块 / 截取最外层花括号 */
function parseJsonLoose(s) {
  if (!s || typeof s !== 'string') return null;
  let t = s.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(t); } catch (_) {}
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (_) {} }
  return null;
}

/* 速创官方异步生图 API（api.wuyinkeji.com，GPT-Image-2，0.1 元/张）：
   ① POST /image_gpt（Authorization 头裸 key）→ {code:200,data:{id}}
   ② GET  /detail?key=..&id=.. → {code:200,data:{status,result:[url]}}（status 0/1 生成中 2 完成 3 失败）
   ③ GET  result url（需 Referer 防盗链头）→ 图片字节（JPEG 或 PNG） */
const SC_API_BASE = 'https://api.wuyinkeji.com/api/async';
const SC_SIZE_MAP = {
  square: '1:1', portrait_4_3: '3:4', portrait_16_9: '9:16',
  landscape_4_3: '4:3', landscape_16_9: '16:9',
};

function scBase(env) { return String(env.SUCHUANG_API_BASE || SC_API_BASE).replace(/\/+$/, ''); }

function scErrMsg(code, msg) {
  const m = String(msg || '');
  if (code === 403) return '速创密钥无效（请检查 SUCHUANG_API_KEY）';
  if (code === 400 && /余额|权限/.test(m)) return '速创账户余额不足或未开通生图产品（请在速创控制台充值，0.1 元/张，充值后自动恢复无需改码）';
  return '速创 ' + code + (m ? '：' + m.slice(0, 80) : '');
}

/* 提交异步生图任务 → {taskId} */
async function scSubmit(env, prompt, size) {
  const key = env.SUCHUANG_API_KEY || '';
  if (!key) return { err: 'SUCHUANG_KEY_UNSET（请在项目环境变量配置 SUCHUANG_API_KEY）' };
  const ep = env.SUCHUANG_IMAGE_EP || 'image_gpt';
  const res = await fetchT(scBase(env) + '/' + ep, {
    method: 'POST',
    headers: { 'Authorization': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: String(prompt).slice(0, 3000), size: SC_SIZE_MAP[size] || '1:1' }),
  }, FETCH_TIMEOUT_MS);
  if (res.err) return { err: 'SC_SUBMIT_' + res.err };
  if (!res.ok) return { err: 'SC_SUBMIT_HTTP_' + res.status };
  let j;
  try { j = await res.json(); } catch (_) { return { err: 'SC_SUBMIT_BAD_JSON' }; }
  if (j.code !== 200 || !(j.data && j.data.id)) return { err: scErrMsg(j.code, j.msg) };
  return { taskId: String(j.data.id) };
}

/* 轮询任务 → {pending:true} 生成中 / {urls:[...]} 完成 / {err} 失败 */
async function scPoll(env, taskId) {
  const key = env.SUCHUANG_API_KEY || '';
  const res = await fetchT(scBase(env) + '/detail?key=' + encodeURIComponent(key) + '&id=' + encodeURIComponent(taskId), {}, FETCH_TIMEOUT_MS);
  if (res.err) return { err: 'SC_POLL_' + res.err };
  if (!res.ok) return { err: 'SC_POLL_HTTP_' + res.status };
  let j;
  try { j = await res.json(); } catch (_) { return { err: 'SC_POLL_BAD_JSON' }; }
  if (j.code !== 200) return { err: scErrMsg(j.code, j.msg) };
  const d = j.data || {};
  if (Number(d.status) === 2) {
    const urls = Array.isArray(d.result) ? d.result.filter(function (u) { return typeof u === 'string' && u; }) : [];
    if (!urls.length) return { err: 'SC_EMPTY_RESULT（任务完成但无图片 URL）' };
    return { urls: urls };
  }
  if (Number(d.status) === 3) return { err: 'SC_TASK_FAILED（速创生图任务失败）' };
  return { pending: true };
}

/* 下载成品图（带防盗链头）→ {bytes,mime}；Pages KV 单值上限 25MB，GPT-Image-2 PNG 实测 1-2MB，留 8MB 余量 */
async function scDownload(env, url) {
  const res = await fetchT(url, {
    headers: { 'Referer': 'https://api.wuyinkeji.com/', 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
  }, FETCH_TIMEOUT_MS);
  if (res.err) return { err: 'SC_DL_' + res.err };
  if (!res.ok) return { err: 'SC_DL_HTTP_' + res.status };
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length < 2048) return { err: 'SC_IMG_TOO_SMALL（' + bytes.length + 'B）' };
  if (bytes.length > 8 * 1024 * 1024) return { err: 'SC_IMG_TOO_LARGE（' + Math.round(bytes.length / 1024) + 'KB > 8MB）' };
  const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8;
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (!isJpg && !isPng) return { err: 'SC_IMG_NOT_IMAGE（非 JPEG/PNG）' };
  return { bytes: bytes, mime: isJpg ? 'image/jpeg' : 'image/png' };
}

function outlineCtx(rec) {
  const o = (rec.stages && rec.stages.outline && rec.stages.outline.content) || {};
  const chars = Array.isArray(o.mainChars)
    ? o.mainChars.map(function (m) { return m.name + '（' + (m.role || '') + '）'; }).join('、') : '';
  return {
    o: o, chars: chars,
    brief: '剧名《' + rec.title + '》｜' + (PAIRING_NAMES[rec.pairing] || rec.pairing || '') +
      '｜母题：' + (CATEGORY_NAMES[rec.category] || rec.category || '') + '｜' + (Number(rec.episodes) || 72) + '集' +
      '｜Logline：' + (rec.idea || o.logline || ''),
  };
}

/* ---- 大纲：3 批（设定→人物→五幕），每批一次 Kimi 调用 ---- */
async function genOutlineStep(store, rec, env) {
  const entry = rec.stages.outline;
  const total = Number(rec.episodes) || 72;
  const step = (entry.genBatch && entry.genBatch.step) || 1;
  const ctx = outlineCtx(rec);
  let r, parsed;

  if (step === 1) {
    r = await kimiChat(env, ctx.brief + '\n\n生成本剧大纲的基础设定 JSON（本次只做设定，不含人物与分幕）：\n' +
      '{"logline":"英文一句话 logline","loglineZh":"中文一句话","genreTags":["3个英文题材标签"],"' +
      'setting":"世界观设定120字（时代/地点/规则/氛围）","themes":["3个核心主题词"],"' +
      'cpDynamics":"主角关系与推拉动力学120字","paywallStrategy":"付费卡点策略100字（卡点密度与钩子类型）"}\n只输出 JSON。', 3500, rec);
    if (r.err) throw new Error(r.err);
    parsed = parseJsonLoose(r.text);
    if (!parsed || !parsed.setting) throw new Error('大纲设定批次结构不完整');
    entry.content = Object.assign({}, parsed);
    entry.genBatch = { kind: 'outline', step: 2 };
    entry.status = 'draft';
    addEvent(rec, 'progress', 'outline', '大纲生成中：设定完成');
  } else if (step === 2) {
    r = await kimiChat(env, ctx.brief + '\n已有设定：' + JSON.stringify(entry.content).slice(0, 900) +
      '\n\n基于以上设定生成 6 个主要人物 JSON：\n' +
      '{"mainChars":[{"name":"英文名","role":"身份/立场","want":"核心欲望","flaw":"性格缺陷","arc":"成长弧光"}]}\n' +
      '恰好 6 人：男女主 + 各 1 个核心对手 + 2 个关键配角。只输出 JSON。', 4000, rec);
    if (r.err) throw new Error(r.err);
    parsed = parseJsonLoose(r.text);
    if (!parsed || !Array.isArray(parsed.mainChars) || parsed.mainChars.length < 4) throw new Error('人物批次结构不完整');
    entry.content.mainChars = parsed.mainChars;
    entry.genBatch = { kind: 'outline', step: 3 };
    addEvent(rec, 'progress', 'outline', '大纲生成中：人物完成');
  } else {
    r = await kimiChat(env, ctx.brief + '\n已有设定与人物：' + JSON.stringify(entry.content).slice(0, 1600) +
      '\n\n生成五幕主线结构 JSON（恰好 5 幕，eps 覆盖 1 到 ' + total + ' 集且连续不重叠）：\n' +
      '{"fiveActs":[{"act":"第一幕","title":"幕标题","eps":"1-14","summary":"本幕剧情120字","keyTurns":["转折1","转折2"]}]}\n只输出 JSON。', 4000, rec);
    if (r.err) throw new Error(r.err);
    parsed = parseJsonLoose(r.text);
    if (!parsed || !Array.isArray(parsed.fiveActs) || parsed.fiveActs.length < 4) throw new Error('五幕批次结构不完整');
    entry.content.fiveActs = parsed.fiveActs;
    delete entry.genBatch;
    entry.status = 'pending_review';
    entry.progress = null;
    addEvent(rec, 'ready', 'outline', '「大纲」已生成（AI）');
  }
  entry.updatedAt = new Date().toISOString();
  if (rec.status === 'received') rec.status = 'generating';
  touch(rec);
  await saveRecord(store, rec);
  return { data: { stage: 'outline', stageStatus: entry.status, generated: entry.status === 'pending_review', submission: rec } };
}

/* ---- 分集梗概：每批 SYN_BATCH 集 ---- */
async function genSynopsisStep(store, rec, env) {
  const entry = rec.stages.synopsis;
  const total = Number(rec.episodes) || 72;
  entry.content = entry.content && typeof entry.content === 'object' ? entry.content : {};
  if (!Array.isArray(entry.content.episodes)) entry.content.episodes = [];
  const eps = entry.content.episodes;
  if (eps.length >= total) {
    entry.status = 'pending_review';
    entry.updatedAt = new Date().toISOString();
    addEvent(rec, 'ready', 'synopsis', '「分集梗概」已生成（AI）');
    await saveRecord(store, rec);
    return { data: { stage: 'synopsis', stageStatus: 'pending_review', generated: true, submission: rec } };
  }
  const from = eps.length + 1;
  const to = Math.min(eps.length + SYN_BATCH, total);
  const ctx = outlineCtx(rec);
  const acts = Array.isArray(ctx.o.fiveActs)
    ? ctx.o.fiveActs.map(function (a) { return a.act + '（' + (a.eps || '') + '）' + (a.summary || '').slice(0, 60); }).join('；') : '';
  const prev = eps.slice(-2).map(function (e) { return 'EP' + e.ep + ' ' + e.title + '：' + (e.hook || ''); }).join('\n');

  const r = await kimiChat(env, ctx.brief + '\n五幕结构：' + (acts || '未提供') +
    '\n人物：' + (ctx.chars || '未提供') +
    (prev ? '\n前情（最后2集钩子，需衔接）：\n' + prev : '') +
    '\n\n生成第 ' + from + ' 至 ' + to + ' 集的分集梗概 JSON（恰好 ' + (to - from + 1) + ' 集，ep 连续）：\n' +
    '{"episodes":[{"ep":' + from + ',"title":"英文短集名","hook":"结尾钩子（本集最后悬念）40字内","beat":"本集剧情节拍70字","paymark":"付费卡点标记，如 第3卡；无卡点则空字符串"}]}\n只输出 JSON。', 6000, rec);
  if (r.err) throw new Error(r.err);
  const parsed = parseJsonLoose(r.text);
  if (!parsed || !Array.isArray(parsed.episodes) || !parsed.episodes.length) throw new Error('梗概批次结构不完整');

  const map = {};
  for (const e of eps) map[e.ep] = e;
  for (const e of parsed.episodes) {
    const se = sanitizeSynopsisEp(e);
    if (se && se.ep >= from && se.ep <= to) map[se.ep] = se;
  }
  entry.content.episodes = Object.keys(map).map(Number).sort(function (a, b) { return a - b; }).map(function (k) { return map[k]; });
  const done = entry.content.episodes.length;
  entry.status = done >= total ? 'pending_review' : 'draft';
  entry.progress = { total: total, done: done };
  entry.updatedAt = new Date().toISOString();
  if (rec.status === 'received') rec.status = 'generating';
  touch(rec);
  addEvent(rec, done >= total ? 'ready' : 'progress', 'synopsis',
    done >= total ? '「分集梗概」已生成（AI）' : '梗概生成中：' + done + '/' + total + ' 集');
  await saveRecord(store, rec);
  return { data: { stage: 'synopsis', stageStatus: entry.status, generated: done >= total, submission: rec } };
}

/* ---- 完整剧本：每批 1 集（2 场景 × 4-5 行对白） ---- */
async function genScriptStep(store, rec, env) {
  const entry = rec.stages.script;
  const total = Number(rec.episodes) || 72;
  entry.content = entry.content && typeof entry.content === 'object' ? entry.content : {};
  if (!Array.isArray(entry.content.episodes)) entry.content.episodes = [];
  const eps = entry.content.episodes;
  if (eps.length >= total) {
    entry.status = 'pending_review';
    entry.updatedAt = new Date().toISOString();
    addEvent(rec, 'ready', 'script', '「完整剧本」已生成（AI）');
    await saveRecord(store, rec);
    return { data: { stage: 'script', stageStatus: 'pending_review', generated: true, submission: rec } };
  }
  const from = eps.length + 1;
  const to = Math.min(eps.length + 1, total);
  const syn = (rec.stages.synopsis && rec.stages.synopsis.content && rec.stages.synopsis.content.episodes) || [];
  const need = syn.filter(function (e) { return e.ep >= from && e.ep <= to; });
  if (!need.length) throw new Error('缺少第 ' + from + ' 集分集梗概，无法撰写剧本');
  const ctx = outlineCtx(rec);
  const charBrief = Array.isArray(ctx.o.mainChars)
    ? ctx.o.mainChars.map(function (m) { return m.name + '：' + (m.role || '') + '｜欲望 ' + (m.want || '') + '｜缺陷 ' + (m.flaw || ''); }).join('\n') : '';
  const prevEp = eps.length ? eps[eps.length - 1] : null;

  const r = await kimiChat(env, ctx.brief + '\n人物表：\n' + (charBrief || '未提供') +
    (prevEp ? '\n上一集（EP' + prevEp.ep + '）结尾钩子：' + (prevEp.hook || '') + '，本集开头需自然承接' : '') +
    '\n本集梗概：' + need.map(function (e) { return 'EP' + e.ep + '《' + e.title + '》节拍：' + (e.beat || '') + '；结尾钩子：' + (e.hook || ''); }).join('\n') +
    '\n\n撰写第 ' + from + ' 集完整剧本 JSON：\n' +
    '{"episodes":[{"ep":' + from + ',"title":"沿用梗概英文集名","hook":"本集结尾钩子","scenes":[{"no":1,"slug":"INT. 场景名 - 日/夜","action":"场景与动作描述","lines":[{"s":"角色英文名","l":"英文台词（北美口语）","lZh":"中文台词"}]},{"no":2,"slug":"EXT. 场景名 - 日/夜","action":"...","lines":[...]}]}]}\n' +
    '恰好 2 个场景、每场景 4-5 行对白，只输出 JSON。', 6000, rec);
  if (r.err) throw new Error(r.err);
  const parsed = parseJsonLoose(r.text);
  if (!parsed || !Array.isArray(parsed.episodes) || !parsed.episodes.length) throw new Error('剧本批次结构不完整');

  const map = {};
  for (const e of eps) map[e.ep] = e;
  for (const e of parsed.episodes) {
    const se = sanitizeEpisode(e);
    if (se && se.ep >= from && se.ep <= to && JSON.stringify(se).length <= MAX_EP_JSON) map[se.ep] = se;
  }
  entry.content.episodes = Object.keys(map).map(Number).sort(function (a, b) { return a - b; }).map(function (k) { return map[k]; });
  const done = entry.content.episodes.length;
  entry.progress = { total: total, written: done };
  entry.status = done >= total ? 'pending_review' : 'draft';
  entry.updatedAt = new Date().toISOString();
  if (rec.status === 'received') rec.status = 'generating';
  touch(rec);
  addEvent(rec, done >= total ? 'ready' : 'progress', 'script',
    done >= total ? '「完整剧本」已生成（AI）' : '剧本撰写中：' + done + '/' + total + ' 集');
  await saveRecord(store, rec);
  return { data: { stage: 'script', stageStatus: entry.status, generated: done >= total, submission: rec } };
}

/* ---- 视觉资产：先 1 批生成 5 条生图 prompt，再逐张速创生图 ---- */
const ASSET_PLAN = [
  { key: 'key_art', label: 'Key Art 主视觉', size: 'portrait_16_9' },
  { key: 'char_lead', label: '主角人设', size: 'portrait_4_3' },
  { key: 'char_second', label: '对手人设', size: 'portrait_4_3' },
  { key: 'scene_main', label: '核心场景', size: 'landscape_4_3' },
  { key: 'scene_twist', label: '高潮剧情', size: 'landscape_4_3' },
];

async function genAssetsStep(store, rec, env) {
  const entry = rec.stages.assets;
  entry.content = entry.content && typeof entry.content === 'object' ? entry.content : {};
  if (!Array.isArray(entry.content.items)) entry.content.items = [];
  const items = entry.content.items;
  const remaining = ASSET_PLAN.filter(function (p) { return !items.some(function (i) { return i && i.key === p.key; }); });

  if (!remaining.length) {
    entry.status = 'pending_review';
    entry.updatedAt = new Date().toISOString();
    addEvent(rec, 'ready', 'assets', '「视觉资产」已生成（AI）');
    await saveRecord(store, rec);
    return { data: { stage: 'assets', stageStatus: 'pending_review', generated: true, submission: rec } };
  }

  const ctx = outlineCtx(rec);
  if (!entry.content.prompts || !entry.content.prompts[remaining[0].key]) {
    const r = await kimiChat(env, ctx.brief + '\n设定：' + String(ctx.o.setting || '').slice(0, 200) +
      '\n人物：' + (ctx.chars || '') +
      '\n\n为本剧生成 5 张视觉资产的英文生图 prompt JSON（每条 50-80 词，统一 cinematic 短剧海报风格，含主体/构图/光线/情绪，不含文字水印描述）：\n' +
      '{"key_art":"主视觉海报 prompt（男女主同框张力构图）","char_lead":"主角单人立绘 prompt","char_second":"对手单人立绘 prompt","scene_main":"核心场景概念图 prompt","scene_twist":"高潮剧情概念图 prompt"}\n只输出 JSON。', 3500, rec);
    if (r.err) throw new Error(r.err);
    const prompts = parseJsonLoose(r.text);
    if (prompts) entry.content.prompts = prompts;
  }

  const plan = remaining[0];
  const prompt = (entry.content.prompts && entry.content.prompts[plan.key]) || ('cinematic short drama poster, ' + (ctx.o.logline || rec.idea || rec.title));

  /* ① 已有本图的进行中任务 → 轮询（status 0/1 生成中 2 完成 3 失败）；超 10 分钟视为僵死任务自动重提 */
  const task = entry.imgTask && entry.imgTask.id && entry.imgTask.key === plan.key ? entry.imgTask : null;
  if (task && Date.now() - new Date(task.at).getTime() > 10 * 60 * 1000) {
    addEvent(rec, 'progress', 'assets', plan.label + ' 生图任务超时，自动重新提交');
    delete entry.imgTask;
    delete entry.pendingImg;
    await saveRecord(store, rec);
  } else if (task) {
    const p = await scPoll(env, task.id);
    if (p.err) {
      delete entry.imgTask;
      throw new Error(p.err);
    }
    if (p.pending) {
      if (entry.pendingImg !== plan.key) {
        entry.pendingImg = plan.key;
        addEvent(rec, 'progress', 'assets', plan.label + ' 速创生图中（任务已提交，自动轮询取图）');
      }
      entry.updatedAt = new Date().toISOString();
      await saveRecord(store, rec);
      return { data: { stage: 'assets', stageStatus: 'generating', generating: true, submission: rec } };
    }
    /* 完成 → 下载真图入库 */
    const dl = await scDownload(env, p.urls[0]);
    if (dl.err) {
      delete entry.imgTask;
      throw new Error(dl.err);
    }
    delete entry.imgTask;
    delete entry.pendingImg;
    await store.put(PREFIX + rec.id + '_img_' + plan.key, dl.bytes);
    items.push({ key: plan.key, label: plan.label, aspect: plan.size, mime: dl.mime });
    entry.status = items.length >= ASSET_PLAN.length ? 'pending_review' : 'generating';
    entry.progress = { total: ASSET_PLAN.length, done: items.length };
    entry.updatedAt = new Date().toISOString();
    touch(rec);
    addEvent(rec, 'asset', 'assets', '速创生图完成：' + plan.label + '（' + items.length + '/' + ASSET_PLAN.length + '）');
    await saveRecord(store, rec);
    return { data: { stage: 'assets', stageStatus: entry.status, generated: entry.status === 'pending_review', submission: rec } };
  }

  /* ② 无进行中任务 → 提交新的异步生图任务，下一拍轮询 */
  if (entry.imgTask) delete entry.imgTask;
  const s = await scSubmit(env, prompt, plan.size);
  if (s.err) throw new Error(s.err);
  entry.imgTask = { id: s.taskId, key: plan.key, at: new Date().toISOString() };
  entry.pendingImg = plan.key;
  entry.updatedAt = new Date().toISOString();
  touch(rec);
  addEvent(rec, 'progress', 'assets', plan.label + ' 已提交速创生图任务（每张约 30-120 秒，自动轮询）');
  await saveRecord(store, rec);
  return { data: { stage: 'assets', stageStatus: 'generating', generating: true, submission: rec } };
}

/* ---- action：驱动一拍生成（前端等待态循环调用） ---- */
async function actDrive(store, rec, body, env) {
  const stage = stageOf(rec);
  const genStages = { outline: 1, synopsis: 1, script: 1, assets: 1 };
  if (!genStages[stage]) return errOut(400, 'NOT_GENERATING', '当前阶段「' + STAGE_LABELS[stage] + '」无需生成驱动');

  const now = Date.now();
  if (rec.genLock && now - new Date(rec.genLock).getTime() < LOCK_MS) {
    return { data: { locked: true, stage: stage, stageStatus: statusOf(rec, stage), submission: rec } };
  }
  rec.genLock = new Date().toISOString();
  await saveRecord(store, rec);

  try {
    rec.stages = rec.stages || {};
    if (stage === 'outline') rec.stages.outline = rec.stages.outline || { status: 'empty', updatedAt: '', feedback: '', content: {} };
    const entry = entryOf(rec, stage) || {};
    const st = entry.status || 'empty';
    let result;

    if (stage === 'outline' && (st === 'requested' || st === 'empty' || st === 'draft')) result = await genOutlineStep(store, rec, env);
    else if (stage === 'synopsis' && (st === 'requested' || st === 'empty' || st === 'draft')) result = await genSynopsisStep(store, rec, env);
    else if (stage === 'script' && (st === 'requested' || st === 'empty' || st === 'draft')) result = await genScriptStep(store, rec, env);
    else if (stage === 'assets' && st === 'generating') result = await genAssetsStep(store, rec, env);
    else {
      delete rec.genLock;
      await saveRecord(store, rec);
      return { data: { idle: true, stage: stage, stageStatus: st, submission: rec } };
    }

    delete rec.genLock;
    await saveRecord(store, rec);
    return result;
  } catch (e) {
    delete rec.genLock;
    touch(rec);
    addEvent(rec, 'progress', stage, '生成失败：' + String((e && e.message) || 'GEN_FAIL').slice(0, 50));
    await saveRecord(store, rec);
    return { data: { error: String((e && e.message) || 'GEN_FAIL').slice(0, 150), stage: stage, submission: rec } };
  }
}

/* ---------------- GET ---------------- */

async function onRequestGet(context) {
  const { request, params, env } = context;
  const store = kv();
  if (!store) return json({ ok: false, error: 'KV_UNBOUND', message: 'KV 存储未绑定：请在项目设置 → KV 存储中绑定命名空间（变量名 SUBMISSIONS_KV），并重新部署' }, 503);

  const id = String(params.id || '');
  if (!ID_RE.test(id)) return json({ ok: false, error: 'BAD_ID', message: '提交编号格式不正确' }, 400);

  const url = new URL(request.url);
  const imgKey = url.searchParams.get('img');

  if (imgKey) {
    if (!IMG_KEY_RE.test(imgKey)) return json({ ok: false, error: 'BAD_IMG_KEY', message: '图片 key 不合法' }, 400);
    const rec = await loadRecord(store, id);
    if (!rec) return json({ ok: false, error: 'NOT_FOUND', message: '未找到该提交编号对应的记录' }, 404);
    const auth = await editorOk(request, env, rec, url);
    if (!auth.ok) return auth.resp;
    const data = await store.get(PREFIX + id + '_img_' + imgKey, { type: 'arrayBuffer' });
    if (!data) return json({ ok: false, error: 'NOT_FOUND', message: '未找到该图片' }, 404);
    let mime = 'image/jpeg';
    const items = rec.stages && rec.stages.assets && rec.stages.assets.content && rec.stages.assets.content.items;
    if (Array.isArray(items)) {
      const it = items.find(function (x) { return x && x.key === imgKey; });
      if (it && it.mime) mime = it.mime;
    }
    return new Response(data, { headers: { 'Content-Type': mime, 'Cache-Control': 'no-store' } });
  }

  const rec = await loadRecord(store, id);
  if (!rec) return json({ ok: false, error: 'NOT_FOUND', message: '未找到该提交编号对应的记录' }, 404);

  const auth = await editorOk(request, env, rec, url);
  if (auth.ok) {
    const resp = Object.assign({ ok: true, submission: rec, role: auth.role }, stageSummary(rec));
    resp.stageStatuses = stageStatuses(rec);
    return json(resp);
  }
  if (auth.hasCreds) return auth.resp;

  const pub = Object.assign({
    ok: true,
    id: rec.id,
    title: rec.title,
    pairing: rec.pairing,
    category: rec.category,
    episodes: rec.episodes,
    status: rec.status,
    statusLabel: STATUS_LABELS[rec.status] || rec.status,
    statusNote: rec.statusNote || '',
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt || rec.createdAt,
  }, stageSummary(rec));
  pub.stageStatuses = stageStatuses(rec);
  return json(pub);
}

/* ---------------- PATCH：action 分发 ---------------- */

async function onRequestPatch(context) {
  const { request, params, env, waitUntil } = context;
  const store = kv();
  if (!store) return json({ ok: false, error: 'KV_UNBOUND', message: 'KV 存储未绑定：请在项目设置 → KV 存储中绑定命名空间（变量名 SUBMISSIONS_KV），并重新部署' }, 503);

  const id = String(params.id || '');
  if (!ID_RE.test(id)) return json({ ok: false, error: 'BAD_ID', message: '提交编号格式不正确' }, 400);

  let body;
  try { body = await request.json(); } catch (_) { return json({ ok: false, error: 'BAD_JSON', message: '请求体不是合法 JSON' }, 400); }

  const rec = await loadRecord(store, id);
  if (!rec) return json({ ok: false, error: 'NOT_FOUND', message: '未找到该提交编号对应的记录' }, 404);

  const auth = await editorOk(request, env, rec, new URL(request.url));
  if (!auth.ok) return auth.resp;

  const action = clean(body.action, 32);
  let out;
  try {
    if (!action) out = await actLegacyStatus(store, rec, body);
    else if (action === 'stage-content') out = await actStageContent(store, rec, body);
    else if (action === 'request-generate') out = await actRequestGenerate(store, rec, body);
    else if (action === 'drive') out = await actDrive(store, rec, body, env);
    else if (action === 'decision') out = await actDecision(store, rec, body);
    else if (action === 'edit-ep') out = await actEditEp(store, rec, body);
    else if (action === 'assets-choice') out = await actAssetsChoice(store, rec, body);
    else if (action === 'asset-put') out = await actAssetPut(store, rec, body);
    else if (action === 'publish-done') out = await actPublishDone(store, rec, body);
    else return json({ ok: false, error: 'BAD_ACTION', message: '未知 action：' + action }, 400);
  } catch (e) {
    return json({ ok: false, error: 'ACTION_ERROR', message: e && e.message ? e.message : '操作失败' }, 400);
  }

  if (out.err) return json(out.err.b, out.err.s);
  if (out.notify) {
    out.notify.id = rec.id;
    out.notify.title = rec.title;
    out.notify.origin = new URL(request.url).origin;
    if (waitUntil && env && env.FEISHU_WEBHOOK) waitUntil(notifyStage(env, out.notify));
  }
  return json(Object.assign({ ok: true }, out.data || {}));
}

/* ---- action：阶段内容写入（agent 调用） ---- */
async function actStageContent(store, rec, body) {
  const stage = clean(body.stage, 16);
  if (['outline', 'synopsis', 'script', 'assets'].indexOf(stage) < 0)
    return errOut(400, 'BAD_STAGE', '阶段不合法（可选 outline / synopsis / script / assets）');

  rec.stages = rec.stages || {};
  const entry = (rec.stages[stage] = rec.stages[stage] || { status: 'empty', updatedAt: '', feedback: '', content: {} });
  if (entry.status === 'approved') return errOut(409, 'STAGE_LOCKED', '该阶段已通过确认，内容已锁定');

  const ready = body.ready !== false;
  const content = body.content;

  if (stage === 'script') {
    entry.content = entry.content && typeof entry.content === 'object' ? entry.content : {};
    if (!Array.isArray(entry.content.episodes)) entry.content.episodes = [];
    if (content && Array.isArray(content.episodes)) {
      const map = {};
      for (const e of entry.content.episodes) map[e.ep] = e;
      for (const e of content.episodes) {
        if (!e || typeof e !== 'object') continue;
        const n = Number(e.ep);
        if (!n || n < 1 || n > 200) continue;
        const se = sanitizeEpisode(e);
        if (JSON.stringify(se).length > MAX_EP_JSON) continue;
        map[n] = se;
      }
      entry.content.episodes = Object.keys(map).map(Number).sort(function (a, b) { return a - b; }).map(function (k) { return map[k]; });
    }
    const total = Number(rec.episodes) || 72;
    entry.progress = { total: total, written: entry.content.episodes.length };
    if (!ready && entry.status !== 'pending_review' && entry.status !== 'rejected') entry.status = 'draft';
  } else if (content && typeof content === 'object') {
    entry.content = content;
    if (stage === 'synopsis' && Array.isArray(entry.content.episodes)) {
      entry.content.episodes = entry.content.episodes.map(sanitizeSynopsisEp).filter(Boolean);
    }
    if (stage === 'assets' && Array.isArray(entry.content.items)) {
      entry.content.items = entry.content.items.map(sanitizeAssetItem).filter(Boolean);
    }
  }

  if (ready) entry.status = 'pending_review';
  entry.updatedAt = new Date().toISOString();
  if (rec.status === 'received') rec.status = 'generating';

  const cur = stageOf(rec);
  if (STAGE_ORDER.indexOf(stage) > STAGE_ORDER.indexOf(cur)) rec.stage = stage;
  touch(rec);
  if (ready) addEvent(rec, 'ready', stage, '「' + STAGE_LABELS[stage] + '」已生成');
  else if (stage === 'script' && entry.progress)
    addEvent(rec, 'progress', stage, '剧本已写 ' + entry.progress.written + '/' + entry.progress.total + ' 集');
  await saveRecord(store, rec);
  return { data: { stage: stage, stageStatus: entry.status, progress: entry.progress || null }, notify: { type: 'ready', stage: stage, stageLabel: STAGE_LABELS[stage] } };
}

/* ---- action：请求 AI 撰写（提交者/管理员在工作台调用） ---- */
async function actRequestGenerate(store, rec, body) {
  const stage = clean(body.stage, 16);
  if (['outline', 'synopsis', 'script'].indexOf(stage) < 0)
    return errOut(400, 'BAD_STAGE', '阶段不合法（可选 outline / synopsis / script）');
  if (stageOf(rec) !== stage) return errOut(400, 'STAGE_NOT_ACTIVE', '仅可对当前阶段「' + STAGE_LABELS[stageOf(rec)] + '」请求生成');
  rec.stages = rec.stages || {};
  const entry = (rec.stages[stage] = rec.stages[stage] || { status: 'empty', updatedAt: '', feedback: '', content: {} });
  if (entry.status !== 'empty' && entry.status !== 'requested')
    return errOut(400, 'REQUEST_NOT_ALLOWED', '该阶段当前状态为「' + (STAGE_STATUS_LABELS[entry.status] || entry.status) + '」，无需请求生成');
  entry.status = 'requested';
  entry.updatedAt = new Date().toISOString();
  touch(rec);
  addEvent(rec, 'request', stage, '请求 AI 撰写「' + STAGE_LABELS[stage] + '」');
  await saveRecord(store, rec);
  return { data: { stage: stage, stageStatus: 'requested' }, notify: { type: 'request', stage: stage, stageLabel: STAGE_LABELS[stage] } };
}

/* ---- action：阶段确认（用户在工作台调用） ---- */
async function actDecision(store, rec, body) {
  const stage = clean(body.stage, 16);
  const decision = clean(body.decision, 16);
  const note = clean(body.note, 300);
  if (['outline', 'synopsis', 'script', 'assets'].indexOf(stage) < 0)
    return errOut(400, 'BAD_STAGE', '该阶段不可确认（仅 outline / synopsis / script / assets）');
  if (stageOf(rec) !== stage) return errOut(400, 'STAGE_NOT_ACTIVE', '仅可对当前阶段「' + STAGE_LABELS[stageOf(rec)] + '」进行确认');
  const entry = entryOf(rec, stage);
  const st = entry ? entry.status : 'empty';
  if (st !== 'pending_review')
    return errOut(400, 'DECISION_NOT_ALLOWED', '该阶段当前状态为「' + (STAGE_STATUS_LABELS[st] || st) + '」，不可确认');
  if (decision !== 'approved' && decision !== 'rejected') return errOut(400, 'BAD_DECISION', 'decision 必须为 approved 或 rejected');
  if (decision === 'rejected' && !note) return errOut(400, 'FEEDBACK_REQUIRED', '驳回时请填写反馈意见');

  entry.status = decision === 'approved' ? 'approved' : 'rejected';
  entry.feedback = decision === 'rejected' ? note : '';
  entry.updatedAt = new Date().toISOString();

  const notify = { type: 'decision', stage: stage, stageLabel: STAGE_LABELS[stage], decision: decision, note: note };

  if (decision === 'approved') {
    const next = STAGE_ORDER[STAGE_ORDER.indexOf(stage) + 1];
    if (next === 'assets') {
      rec.stages.assets = rec.stages.assets || { status: 'empty', updatedAt: '', feedback: '', content: { items: [] } };
      if (rec.stages.assets.status === 'empty') rec.stages.assets.status = 'awaiting_choice';
      rec.stage = 'assets';
    } else if (next === 'publish') {
      rec.stages.publish = rec.stages.publish || { status: 'pending', updatedAt: '', content: {} };
      rec.stages.publish.status = 'pending';
      rec.stage = 'publish';
    } else if (next) {
      rec.stage = next;
    }
    notify.next = rec.stage;
    notify.nextLabel = STAGE_LABELS[rec.stage];
  }
  touch(rec);
  addEvent(rec, decision, stage, decision === 'approved'
    ? '「' + STAGE_LABELS[stage] + '」已确认' + (notify.next ? ' → ' + notify.nextLabel : '')
    : '「' + STAGE_LABELS[stage] + '」被驳回');
  await saveRecord(store, rec);
  return { data: Object.assign({ decided: stage, decision: decision }, stageSummary(rec)), notify: notify };
}

/* ---- action：单集模块编辑（用户在工作台调用） ---- */
async function actEditEp(store, rec, body) {
  if (stageOf(rec) !== 'script') return errOut(400, 'NOT_SCRIPT_STAGE', '仅「完整剧本」阶段可编辑单集');
  const entry = entryOf(rec, 'script');
  const st = entry ? entry.status : 'empty';
  if (st !== 'pending_review' && st !== 'rejected')
    return errOut(400, 'EDIT_NOT_ALLOWED', '剧本当前状态为「' + (STAGE_STATUS_LABELS[st] || st) + '」，不可编辑（需为 待确认/已驳回）');
  const ep = Number(body.ep);
  if (!ep || ep < 1 || ep > 200) return errOut(400, 'BAD_EP', '集数编号不合法');
  const d = body.data;
  if (!d || typeof d !== 'object') return errOut(400, 'BAD_DATA', '缺少单集数据');

  const se = sanitizeEpisode({ ep: ep, title: d.title, hook: d.hook, scenes: d.scenes }, { edited: true });
  if (JSON.stringify(se).length > MAX_EP_JSON) return errOut(400, 'EP_TOO_LARGE', '单集体积超过 200KB 上限');

  entry.content = entry.content && typeof entry.content === 'object' ? entry.content : {};
  if (!Array.isArray(entry.content.episodes)) entry.content.episodes = [];
  const eps = entry.content.episodes;
  const idx = eps.findIndex(function (e) { return e.ep === ep; });
  if (idx >= 0) eps[idx] = se;
  else { eps.push(se); eps.sort(function (a, b) { return a.ep - b.ep; }); }
  entry.progress = { total: Number(rec.episodes) || 72, written: eps.length };
  entry.updatedAt = new Date().toISOString();
  touch(rec);
  await saveRecord(store, rec);
  return { data: { ep: ep, saved: true, progress: entry.progress } };
}

/* ---- action：视觉资产生成/跳过选择（用户在工作台调用） ---- */
async function actAssetsChoice(store, rec, body) {
  const choice = clean(body.choice, 8);
  if (choice !== 'generate' && choice !== 'skip') return errOut(400, 'BAD_CHOICE', 'choice 必须为 generate 或 skip');
  if (stageOf(rec) !== 'assets') return errOut(400, 'STAGE_NOT_ACTIVE', '仅「视觉资产」阶段可进行选择');
  const entry = entryOf(rec, 'assets');
  if (!entry || entry.status !== 'awaiting_choice')
    return errOut(400, 'CHOICE_NOT_ALLOWED', '视觉资产阶段当前状态不可选择（需为 待选择）');

  entry.choice = choice;
  entry.content = entry.content && typeof entry.content === 'object' ? entry.content : { items: [] };
  if (!Array.isArray(entry.content.items)) entry.content.items = [];
  if (choice === 'skip') {
    entry.status = 'skipped';
    rec.stages.publish = rec.stages.publish || { status: 'pending', updatedAt: '', content: {} };
    rec.stages.publish.status = 'pending';
    rec.stage = 'publish';
  } else {
    entry.status = 'generating';
  }
  entry.updatedAt = new Date().toISOString();
  touch(rec);
  addEvent(rec, 'assets-choice', 'assets', choice === 'skip' ? '跳过视觉资产生成' : '开始生成视觉资产');
  await saveRecord(store, rec);
  return { data: { choice: choice, stageStatus: entry.status, stage: rec.stage }, notify: { type: 'assets-choice', choice: choice } };
}

/* ---- action：上传单张审阅图片（agent 调用） ---- */
async function actAssetPut(store, rec, body) {
  if (stageOf(rec) !== 'assets') return errOut(400, 'STAGE_NOT_ACTIVE', '仅「视觉资产」阶段可上传图片');
  const entry = entryOf(rec, 'assets');
  const st = entry ? entry.status : 'empty';
  if (st !== 'generating' && st !== 'rejected')
    return errOut(400, 'ASSET_PUT_NOT_ALLOWED', '当前状态不可上传图片（需先在工作台选择「生成视觉资产」）');
  const key = clean(body.key, 40);
  if (!IMG_KEY_RE.test(key)) return errOut(400, 'BAD_IMG_KEY', '图片 key 不合法（小写字母/数字/下划线，≤40 字符）');
  const b64 = typeof body.dataBase64 === 'string' ? body.dataBase64 : '';
  if (!b64) return errOut(400, 'MISSING_DATA', '缺少图片数据（dataBase64）');
  let bytes;
  try { bytes = base64ToBytes(b64); } catch (_) { return errOut(400, 'BAD_BASE64', 'base64 解码失败'); }
  if (bytes.length > 400 * 1024) return errOut(413, 'IMG_TOO_LARGE', '单张图片超过 400KB 上限');

  await store.put(PREFIX + rec.id + '_img_' + key, bytes);

  entry.content = entry.content && typeof entry.content === 'object' ? entry.content : { items: [] };
  if (!Array.isArray(entry.content.items)) entry.content.items = [];
  const meta = {
    key: key,
    label: clean(body.label, 60) || key,
    aspect: clean(body.aspect, 12),
    mime: clean(body.mime, 40) || 'image/jpeg',
  };
  const i = entry.content.items.findIndex(function (x) { return x && x.key === key; });
  if (i >= 0) entry.content.items[i] = meta;
  else entry.content.items.push(meta);
  if (entry.status === 'rejected') entry.status = 'generating';
  entry.updatedAt = new Date().toISOString();
  touch(rec);
  addEvent(rec, 'asset', 'assets', '已上传：' + meta.label);
  await saveRecord(store, rec);
  return { data: { key: key, items: entry.content.items.length } };
}

/* ---- action：发布完成（agent 调用） ---- */
async function actPublishDone(store, rec, body) {
  if (stageOf(rec) !== 'publish') return errOut(400, 'STAGE_NOT_ACTIVE', '仅「发布上线」阶段可标记完成');
  const feishuDocUrl = clean(body.feishuDocUrl, 500);
  const pageUrl = clean(body.pageUrl, 500);
  if (!feishuDocUrl || !pageUrl) return errOut(400, 'MISSING_FIELDS', '缺少 feishuDocUrl / pageUrl');
  const now = new Date().toISOString();
  rec.stages = rec.stages || {};
  rec.stages.publish = { status: 'done', updatedAt: now, content: { feishuDocUrl: feishuDocUrl, pageUrl: pageUrl, deployedAt: now } };
  rec.stage = 'done';
  rec.status = 'published';
  touch(rec);
  addEvent(rec, 'published', 'publish', '剧本已上线');
  await saveRecord(store, rec);
  return { data: { stage: 'done', feishuDocUrl: feishuDocUrl, pageUrl: pageUrl }, notify: { type: 'published', feishuDocUrl: feishuDocUrl, pageUrl: pageUrl } };
}

/* ---- 旧版兼容：状态流转 ---- */
async function actLegacyStatus(store, rec, body) {
  const status = clean(body.status, 16);
  if (!STATUS_LABELS[status]) return errOut(400, 'BAD_STATUS', 'status 必须为 received / reviewing / generating / published / rejected');
  rec.status = status;
  rec.statusNote = typeof body.note === 'string' ? body.note.trim().slice(0, 300) : '';
  touch(rec);
  addEvent(rec, 'status', stageOf(rec), '状态 → ' + (STATUS_LABELS[status] || status));
  await saveRecord(store, rec);
  return { data: { id: rec.id, status: rec.status, statusLabel: STATUS_LABELS[rec.status], statusNote: rec.statusNote } };
}

/* ---------------- 飞书通知 ---------------- */

async function notifyStage(env, n) {
  const webhook = env.FEISHU_WEBHOOK || '';
  if (!webhook) return;
  const link = (n.origin || '') + '/pipeline.html?id=' + n.id;
  let title = '';
  const lines = ['剧名：**《' + n.title + '》**', '编号：`' + n.id + '`'];

  if (n.type === 'request') {
    title = '📥 请求生成「' + n.stageLabel + '」';
    lines.push('提交者已在编辑工作台请求 AI 撰写该阶段内容');
    lines.push('管线将自动分批生成（Moonshot 文本 / 速创生图），完成会再次通知：' + link);
  } else if (n.type === 'ready') {
    title = '📝 「' + n.stageLabel + '」已生成，可编辑确认';
    lines.push('请前往编辑工作台编辑并确认：' + link);
  } else if (n.type === 'decision' && n.decision === 'approved') {
    title = '✅ 「' + n.stageLabel + '」已确认';
    lines.push('进入「' + n.nextLabel + '」阶段');
    lines.push(link);
  } else if (n.type === 'decision') {
    title = '❌ 「' + n.stageLabel + '」已驳回';
    lines.push('反馈：' + n.note);
    lines.push('等待重新生成：' + link);
  } else if (n.type === 'assets-choice') {
    title = n.choice === 'skip' ? '🖼️ 已选择跳过视觉资产生成' : '🖼️ 已选择生成视觉资产';
    lines.push(n.choice === 'skip' ? '直接进入发布阶段' : '等待 AI 生成图片并上传');
    lines.push(link);
  } else if (n.type === 'published') {
    title = '🎉 剧本已上线';
    lines.push('线上页面：' + n.pageUrl);
    lines.push('飞书文档：' + n.feishuDocUrl);
  } else {
    return;
  }

  const payload = {
    msg_type: 'interactive',
    card: {
      config: { wide_screen_mode: true },
      header: { template: 'rose', title: { tag: 'plain_text', content: '剧本工坊 · ' + title } },
      elements: [{ tag: 'div', text: { tag: 'lark_md', content: lines.join('\n') } }],
    },
  };

  const headers = { 'Content-Type': 'application/json' };
  const secret = env.FEISHU_WEBHOOK_SECRET || '';
  if (secret) {
    const ts = String(Math.floor(Date.now() / 1000));
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(ts + '\n' + secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new Uint8Array(0)));
    let bin = '';
    for (let i = 0; i < sig.length; i++) bin += String.fromCharCode(sig[i]);
    payload.timestamp = ts;
    payload.sign = btoa(bin);
  }
  try { await fetch(webhook, { method: 'POST', headers: headers, body: JSON.stringify(payload) }); } catch (_) {}
}

export { onRequest };

async function onRequest(context) {
  const m = context.request.method;
  if (m === 'GET') return onRequestGet(context);
  if (m === 'PATCH') return onRequestPatch(context);
  return json({ ok: false, message: 'Method Not Allowed' }, 405);
}
