// /api/submissions
// POST 提交新剧本创意（公开）；GET 查看提交列表（管理员 Bearer ADMIN_TOKEN）
// KV 依赖：控制台绑定命名空间，变量名 SUBMISSIONS_KV（key 仅支持字母/数字/下划线）

const PREFIX = 'sub_';

const PAIRINGS = { bg: 'BG 男女', bl: 'BL 男男', gl: 'GL 女女' };
const CATEGORIES = {
  'fated-mates': '狼人命定',
  billionaire: '亿万总裁',
  mafia: '黑帮契约',
  rebirth: '重生复仇',
  'hidden-identity': '隐藏身份',
  contract: '契约婚姻',
};
const EPISODES = ['60', '72', '80'];

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

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function kv() {
  return typeof SUBMISSIONS_KV === 'undefined' ? null : SUBMISSIONS_KV;
}

function clean(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function genId() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let s = '';
  for (const b of bytes) s += alphabet[b % 62];
  const d = new Date();
  const ymd = '' + d.getUTCFullYear() +
    String(d.getUTCMonth() + 1).padStart(2, '0') +
    String(d.getUTCDate()).padStart(2, '0');
  return 'SR_' + ymd + '_' + s;
}

function genEditKey() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let s = '';
  for (const b of bytes) s += alphabet[b % 62];
  return s;
}

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
}

function adminOk(request, env) {
  const token = (env && env.ADMIN_TOKEN) || '';
  if (!token) return { ok: false, resp: json({ ok: false, error: 'ADMIN_TOKEN_UNSET', message: '未配置 ADMIN_TOKEN 环境变量，请在控制台项目设置中添加' }, 503) };
  if ((request.headers.get('Authorization') || '') !== 'Bearer ' + token) {
    return { ok: false, resp: json({ ok: false, message: '鉴权失败' }, 401) };
  }
  return { ok: true };
}

async function onRequestPost(context) {
  const { request, env, waitUntil } = context;
  const store = kv();
  if (!store) return json({ ok: false, error: 'KV_UNBOUND', message: 'KV 存储未绑定：请在 EdgeOne 控制台为项目绑定命名空间（变量名 SUBMISSIONS_KV）' }, 503);

  let body;
  try { body = await request.json(); } catch (_) { return json({ ok: false, error: 'BAD_JSON', message: '请求体不是合法 JSON' }, 400); }

  const title = clean(body.title, 100);
  const idea = clean(body.idea, 1000);
  const pairing = clean(body.pairing, 8);
  const category = clean(body.category, 32);
  const episodes = clean(body.episodes, 4);
  if (!title || !idea) return json({ ok: false, error: 'MISSING_FIELDS', message: '剧名与一句话 logline 为必填项' }, 400);
  if (!PAIRINGS[pairing]) return json({ ok: false, error: 'BAD_PAIRING', message: '配对取向不合法（bg / bl / gl）' }, 400);
  if (!CATEGORIES[category]) return json({ ok: false, error: 'BAD_CATEGORY', message: '题材母题不合法' }, 400);
  if (EPISODES.indexOf(episodes) < 0) return json({ ok: false, error: 'BAD_EPISODES', message: '集数体量不合法（60 / 72 / 80）' }, 400);

  const editKey = genEditKey();
  const now = new Date().toISOString();
  const rec = {
    id: genId(),
    createdAt: now,
    status: 'received',
    statusNote: '',
    stage: 'outline',
    title: title,
    idea: idea,
    pairing: pairing,
    category: category,
    episodes: episodes,
    benchmark: clean(body.benchmark, 200),
    contact: clean(body.contact, 200),
    editKeyHash: await sha256Hex(editKey),
    events: [{ t: now, type: 'submitted', stage: '', label: '创意提交，进入管线' }],
  };
  await store.put(PREFIX + rec.id, JSON.stringify(rec));

  const webhook = (env && env.FEISHU_WEBHOOK) || '';
  if (webhook && waitUntil) waitUntil(notifyFeishu(webhook, (env && env.FEISHU_WEBHOOK_SECRET) || '', rec));

  return json({ ok: true, id: rec.id, editKey: editKey, status: rec.status, statusLabel: '已接收' });
}

async function onRequestGet(context) {
  const { request, env } = context;
  const store = kv();
  if (!store) return json({ ok: false, error: 'KV_UNBOUND', message: 'KV 存储未绑定' }, 503);
  const auth = adminOk(request, env);
  if (!auth.ok) return auth.resp;

  const keys = [];
  try {
    let cursor;
    do {
      const opts = { prefix: PREFIX, limit: 256 };
      if (cursor) opts.cursor = cursor;
      const res = await store.list(opts);
      const ks = (res && res.keys) || [];
      for (let i = 0; i < ks.length; i++) {
        const k = ks[i];
        keys.push(typeof k === 'string' ? k : (k && (k.key || k.name)) || String(k));
      }
      cursor = res ? res.cursor : null;
    } while (cursor);
  } catch (e) {
    return json({ ok: false, error: 'LIST_FAILED', message: 'KV list 调用失败：' + String((e && e.message) || e) }, 500);
  }

  const records = [];
  for (const key of keys) {
    if (key.indexOf('_img_') >= 0) continue;
    const raw = await store.get(key);
    if (raw) { try { records.push(JSON.parse(raw)); } catch (_) {} }
  }
  records.sort(function (a, b) { return (a.createdAt || '') < (b.createdAt || '') ? 1 : -1; });

  const items = records.map(function (rec) {
    const stage = rec.stage && STAGE_LABELS[rec.stage] ? rec.stage : 'outline';
    const entry = (rec.stages && rec.stages[stage]) || null;
    const stageStatus = stage === 'done' ? 'done' : entry && entry.status ? entry.status : 'empty';
    const item = {};
    for (const k of ['id', 'createdAt', 'updatedAt', 'status', 'statusNote', 'stage', 'title', 'idea', 'pairing', 'category', 'episodes', 'benchmark', 'contact']) {
      if (rec[k] !== undefined) item[k] = rec[k];
    }
    item.stageLabel = STAGE_LABELS[stage];
    item.stageStatus = stageStatus;
    item.stageStatusLabel = STAGE_STATUS_LABELS[stageStatus] || stageStatus;
    item.stageStatuses = {};
    for (const s of STAGE_ORDER) {
      const e = (rec.stages && rec.stages[s]) || null;
      item.stageStatuses[s] = e && e.status ? e.status : 'empty';
    }
    return item;
  });
  return json({ ok: true, count: items.length, submissions: items });
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function feishuPayload(rec) {
  const ideaShort = rec.idea.length > 160 ? rec.idea.slice(0, 160) + '…' : rec.idea;
  return {
    msg_type: 'interactive',
    card: {
      config: { wide_screen_mode: true },
      header: { template: 'rose', title: { tag: 'plain_text', content: '🎬 剧本工坊 · 新创意提交' } },
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: '**《' + esc(rec.title) + '》**\n' +
              '配向：' + PAIRINGS[rec.pairing] + ' · 母题：' + CATEGORIES[rec.category] + ' · ' + rec.episodes + ' 集\n' +
              (rec.benchmark ? '对标：' + esc(rec.benchmark) + '\n' : '') +
              '\n' + esc(ideaShort),
          },
        },
        { tag: 'hr' },
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: '编号：`' + rec.id + '`\n' +
              (rec.contact ? '联系方式：' + esc(rec.contact) + '\n' : '') +
              '时间：' + rec.createdAt,
          },
        },
        { tag: 'note', elements: [{ tag: 'plain_text', content: '管理端：GET /api/submissions （Bearer ADMIN_TOKEN）' }] },
      ],
    },
  };
}

async function feishuSign(timestamp, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(timestamp + '\n' + secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new Uint8Array(0)));
  let bin = '';
  for (const b of sig) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function notifyFeishu(webhook, secret, rec) {
  const payload = feishuPayload(rec);
  try {
    if (secret) {
      const ts = String(Math.floor(Date.now() / 1000));
      payload.timestamp = ts;
      payload.sign = await feishuSign(ts, secret);
    }
    await fetch(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  } catch (_) {}
}

export async function onRequest(context) {
  const m = context.request.method;
  if (m === 'POST') return onRequestPost(context);
  if (m === 'GET') return onRequestGet(context);
  return json({ ok: false, message: 'Method Not Allowed' }, 405);
}
