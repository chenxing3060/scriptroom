// /api/submissions/:id
// GET 凭提交编号查询进度（编号含 8 位随机字符，不可枚举）；PATCH 管理员更新审核状态

const PREFIX = 'sub_';

const STATUS_LABELS = {
  received: '已接收',
  reviewing: '人工审核中',
  generating: '撰写管线中',
  published: '已上线',
  rejected: '未通过',
};

const ID_RE = /^SR_\d{8}_[A-Za-z0-9]{8}$/;

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function kv() {
  return typeof SUBMISSIONS_KV === 'undefined' ? null : SUBMISSIONS_KV;
}

function adminOk(request, env) {
  const token = (env && env.ADMIN_TOKEN) || '';
  if (!token) return { ok: false, resp: json({ ok: false, error: 'ADMIN_TOKEN_UNSET', message: '未配置 ADMIN_TOKEN 环境变量' }, 503) };
  if ((request.headers.get('Authorization') || '') !== 'Bearer ' + token) {
    return { ok: false, resp: json({ ok: false, message: '鉴权失败' }, 401) };
  }
  return { ok: true };
}

async function loadRecord(store, id) {
  const raw = await store.get(PREFIX + id);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

async function onRequestGet(context) {
  const { request, params, env } = context;
  const store = kv();
  if (!store) return json({ ok: false, error: 'KV_UNBOUND', message: 'KV 存储未绑定' }, 503);
  const id = String(params.id || '');
  if (!ID_RE.test(id)) return json({ ok: false, error: 'BAD_ID', message: '提交编号格式不正确' }, 400);

  const rec = await loadRecord(store, id);
  if (!rec) return json({ ok: false, error: 'NOT_FOUND', message: '未找到该提交编号对应的记录' }, 404);

  const auth = adminOk(request, env);
  if (auth.ok) return json({ ok: true, submission: rec });

  return json({
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
  });
}

async function onRequestPatch(context) {
  const { request, params, env } = context;
  const store = kv();
  if (!store) return json({ ok: false, error: 'KV_UNBOUND', message: 'KV 存储未绑定' }, 503);
  const auth = adminOk(request, env);
  if (!auth.ok) return auth.resp;

  const id = String(params.id || '');
  if (!ID_RE.test(id)) return json({ ok: false, error: 'BAD_ID', message: '提交编号格式不正确' }, 400);

  let body;
  try { body = await request.json(); } catch (_) { return json({ ok: false, error: 'BAD_JSON', message: '请求体不是合法 JSON' }, 400); }

  const status = typeof body.status === 'string' ? body.status.trim() : '';
  if (!STATUS_LABELS[status]) {
    return json({ ok: false, error: 'BAD_STATUS', message: '状态不合法，可选：' + Object.keys(STATUS_LABELS).join(' / ') }, 400);
  }

  const rec = await loadRecord(store, id);
  if (!rec) return json({ ok: false, error: 'NOT_FOUND', message: '未找到该提交编号对应的记录' }, 404);

  rec.status = status;
  rec.statusNote = typeof body.note === 'string' ? body.note.trim().slice(0, 300) : '';
  rec.updatedAt = new Date().toISOString();
  await store.put(PREFIX + id, JSON.stringify(rec));
  return json({ ok: true, id: id, status: rec.status, statusLabel: STATUS_LABELS[rec.status], statusNote: rec.statusNote });
}

export async function onRequest(context) {
  const m = context.request.method;
  if (m === 'GET') return onRequestGet(context);
  if (m === 'PATCH') return onRequestPatch(context);
  return json({ ok: false, message: 'Method Not Allowed' }, 405);
}
