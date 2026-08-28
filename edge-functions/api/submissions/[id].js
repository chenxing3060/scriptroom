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

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
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
    lines.push('请安排生成并写入：' + link);
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
