/* 剧本工坊 · 管线编辑工作台：AI 生成 → 在线编辑修改 → 确认后自动进入下一阶段 */
(function () {
  'use strict';
  var $ = function (s, el) { return (el || document).querySelector(s); };
  var $$ = function (s, el) { return Array.prototype.slice.call((el || document).querySelectorAll(s)); };

  var TOKEN_KEY = 'sr_admin_token';
  var STAGE_LABELS = { outline: '大纲', synopsis: '分集梗概', script: '完整剧本', assets: '视觉资产', publish: '发布上线', done: '已完成' };
  var STAGE_FLOW = ['outline', 'synopsis', 'script', 'assets', 'publish', 'done'];
  var STAGE_STATUS_LABELS = {
    empty: '未开始', requested: '已请求生成', draft: '生成中', pending_review: '待编辑确认', approved: '已确认', rejected: '已驳回（旧）',
    awaiting_choice: '待选择', generating: '生成中', skipped: '已跳过', pending: '待发布', done: '已完成',
  };
  var PAIRINGS = { bg: 'BG 男女', bl: 'BL 男男', gl: 'GL 女女' };
  var CATEGORIES = {
    'fated-mates': '狼人命定', billionaire: '亿万总裁', mafia: '黑帮契约',
    rebirth: '重生复仇', 'hidden-identity': '隐藏身份', contract: '契约婚姻',
  };

  var STAGE_ICONS = { outline: '📌', synopsis: '🗂️', script: '🎬', assets: '🖼️', publish: '🚀', done: '🏁' };
  var POLL_SECS = 15;

  var state = { token: '', role: 'admin', editKey: '', editId: '', list: [], rec: null, curEp: 0, dirty: false, epDirty: false, sumStage: '', waitTimer: null, pollTimer: null };

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function api(method, path, body, raw) {
    var opt = { method: method, headers: {} };
    if (state.role === 'editor' && state.editKey) opt.headers['X-Edit-Key'] = state.editKey;
    else opt.headers['Authorization'] = 'Bearer ' + state.token;
    if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    return fetch(path, opt).then(function (r) {
      if (raw) return r;
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok || j.ok === false) throw new Error(j.message || ('HTTP ' + r.status));
        return j;
      });
    });
  }

  function fmtTime(iso) {
    if (!iso) return '';
    var t = new Date(iso);
    return isNaN(t.getTime()) ? String(iso) : t.toLocaleString('zh-CN');
  }

  function stageOfRec(rec) { return rec && rec.stage && STAGE_LABELS[rec.stage] ? rec.stage : 'outline'; }
  function entryOf(rec, stage) { return (rec && rec.stages && rec.stages[stage]) || null; }
  function statusOf(rec, stage) { var e = entryOf(rec, stage); return e && e.status ? e.status : 'empty'; }

  /* 列表 item 的阶段状态（无 stages 结构，读 stageStatuses） */
  function itemStatus(item, stage) {
    if (item.stageStatuses && item.stageStatuses[stage]) return item.stageStatuses[stage];
    if (stage === item.stage) return item.stageStatus || 'empty';
    return 'empty';
  }

  /* 阶段子进度 0-1（lite=true 时 script/assets 用简化档，供列表页无 stages 内容时用） */
  function stageFracByStatus(stage, st, entry, lite) {
    if (stage === 'outline' || stage === 'synopsis') {
      if (st === 'approved') return 1;
      if (st === 'pending_review' || st === 'rejected') return 0.85;
      if (st === 'requested' || st === 'draft') return 0.15;
      return 0;
    }
    if (stage === 'script') {
      if (st === 'approved' || st === 'pending_review' || st === 'rejected') return 1;
      if (st === 'requested') return 0.1;
      if (st === 'draft') {
        if (lite) return 0.5;
        var p = entry && entry.progress;
        var w = p ? Number(p.written) || 0 : 0;
        var t = p ? Number(p.total) || 0 : 0;
        return t ? Math.min(w / t, 0.9) : 0.5;
      }
      return 0;
    }
    if (stage === 'assets') {
      if (st === 'approved' || st === 'skipped' || st === 'pending_review' || st === 'rejected') return 1;
      if (st === 'awaiting_choice') return 0.2;
      if (st === 'generating') {
        if (lite) return 0.55;
        var items = entry && entry.content && entry.content.items;
        return Math.min((items ? items.length : 0) / 5, 0.9);
      }
      return 0;
    }
    if (stage === 'publish') {
      if (st === 'done') return 1;
      if (st === 'pending') return 0.5;
      return 0;
    }
    return 0;
  }

  /* 总体进度：5 个内容阶段各占 20%；rec 可为详情记录或列表 item */
  function overallProgress(rec, lite) {
    var cur = stageOfRec(rec);
    if (cur === 'done') return { pct: 100, stageNo: '已完成', stageLabel: '已完成' };
    var order = ['outline', 'synopsis', 'script', 'assets', 'publish'];
    var sum = 0;
    for (var i = 0; i < order.length; i++) {
      var st = rec.stages ? statusOf(rec, order[i]) : itemStatus(rec, order[i]);
      sum += stageFracByStatus(order[i], st, rec.stages ? entryOf(rec, order[i]) : null, lite);
    }
    var idx = order.indexOf(cur);
    if (idx < 0) idx = 0;
    return { pct: Math.round(sum / order.length * 100), stageNo: '阶段 ' + (idx + 1) + '/5', stageLabel: STAGE_LABELS[cur] };
  }

  function fmtShort(iso) {
    var t = new Date(iso);
    if (!iso || isNaN(t.getTime())) return '';
    function p(n) { return String(n).padStart(2, '0'); }
    return p(t.getMonth() + 1) + '-' + p(t.getDate()) + ' ' + p(t.getHours()) + ':' + p(t.getMinutes());
  }

  function durationText(iso) {
    var t = new Date(iso).getTime();
    if (!iso || isNaN(t)) return '—';
    var h = Math.max(0, (Date.now() - t) / 3600000);
    if (h >= 48) return Math.round(h / 24) + ' 天';
    return Math.max(1, Math.round(h)) + ' 小时';
  }

  /* 已等待时长（秒级跳动，供等待态使用） */
  function elapsedText(iso) {
    var t = new Date(iso).getTime();
    if (!iso || isNaN(t)) return '—';
    var s = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (s < 60) return s + ' 秒';
    var m = Math.floor(s / 60);
    if (m < 60) return m + ' 分 ' + (s % 60) + ' 秒';
    return Math.floor(m / 60) + ' 时 ' + (m % 60) + ' 分';
  }

  function clearTimers() {
    if (state.waitTimer) { clearInterval(state.waitTimer); state.waitTimer = null; }
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
  }

  /* ---------- 门禁：管理员令牌 / 提交者编号+密钥 ---------- */

  function showGate() {
    $('#pl-app').hidden = true;
    $('#pl-token').hidden = false;
  }

  function initGate() {
    $$('.pl-gate-tab').forEach(function (b) {
      b.addEventListener('click', function () {
        $$('.pl-gate-tab').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        var g = b.getAttribute('data-gate');
        $('#pl-gate-admin').hidden = g !== 'admin';
        $('#pl-gate-editor').hidden = g !== 'editor';
      });
    });

    $('#pl-token-btn').addEventListener('click', function () { verifyToken(false); });
    $('#pl-token-input').addEventListener('keydown', function (e) { if (e.key === 'Enter') verifyToken(false); });
    $('#pl-editor-btn').addEventListener('click', function () { editorLogin(false); });
    $('#pl-editor-key').addEventListener('keydown', function (e) { if (e.key === 'Enter') editorLogin(false); });

    var qs = new URLSearchParams(location.search);
    var urlId = qs.get('id'), urlKey = qs.get('key');

    if (urlId && urlKey) {
      editorLogin(true, urlId, urlKey);
      return;
    }
    var saved = localStorage.getItem(TOKEN_KEY);
    if (saved) { state.token = saved; verifyToken(true); return; }
    if (urlId) {
      var k = localStorage.getItem('sr_edit_key_' + urlId);
      if (k) { editorLogin(true, urlId, k); return; }
    }
    showGate();
  }

  function verifyToken(silent) {
    var input = $('#pl-token-input');
    var v = (input.value || '').trim();
    if (v) state.token = v;
    if (!state.token) { if (!silent) showTokenErr('请输入 ADMIN_TOKEN'); return; }
    state.role = 'admin';
    api('GET', '/api/submissions').then(function () {
      localStorage.setItem(TOKEN_KEY, state.token);
      enterApp();
    }).catch(function (ex) {
      localStorage.removeItem(TOKEN_KEY);
      state.token = '';
      showGate();
      showTokenErr(ex.message === '鉴权失败' ? '令牌不正确，请重新输入' : ('验证失败：' + ex.message));
    });
  }

  function editorLogin(silent, presetId, presetKey) {
    var id = (presetId || ($('#pl-editor-id') || {}).value || '').trim();
    var key = (presetKey || ($('#pl-editor-key') || {}).value || '').trim();
    if (!id || !key) { if (!silent) showEditorErr('请输入提交编号与编辑密钥'); return; }
    state.role = 'editor';
    state.editKey = key;
    state.editId = id;
    fetch('/api/submissions/' + encodeURIComponent(id), { headers: { 'X-Edit-Key': key } })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok && j.ok !== false, j: j }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.j.message || ('HTTP ' + res.ok));
        localStorage.setItem('sr_edit_key_' + id, key);
        enterApp();
      })
      .catch(function (ex) {
        state.editKey = '';
        state.editId = '';
        state.role = 'admin';
        showGate();
        if (!silent) {
          showEditorErr(ex.message === '鉴权失败' || ex.message === '编辑密钥不正确' ? '编号或编辑密钥不正确，请重新输入' : ('验证失败：' + ex.message));
        } else {
          var qs = new URLSearchParams(location.search);
          if (qs.get('id') && qs.get('key')) {
            history.replaceState(null, '', location.pathname + '?id=' + encodeURIComponent(qs.get('id')));
          }
        }
      });
  }

  function showTokenErr(msg) { var e = $('#pl-token-err'); e.textContent = msg; e.hidden = false; }
  function showEditorErr(msg) { var e = $('#pl-editor-err'); e.textContent = msg; e.hidden = false; }

  function enterApp() {
    $('#pl-token-err').hidden = true;
    $('#pl-editor-err').hidden = true;
    $('#pl-token').hidden = true;
    $('#pl-app').hidden = false;
    var id = new URLSearchParams(location.search).get('id');
    if (id) openDetail(id);
    else if (state.role === 'editor' && state.editId) openDetail(state.editId);
    else if (state.role === 'admin') loadList();
    else showGate();
  }

  function exitToGate() {
    clearTimers();
    state.role = 'admin';
    state.editKey = '';
    state.editId = '';
    state.rec = null;
    state.sumStage = '';
    history.replaceState(null, '', location.pathname);
    showGate();
  }

  /* ---------- 列表视图 ---------- */

  function loadList() {
    clearTimers();
    state.sumStage = '';
    $('#pl-detail-view').hidden = true;
    $('#pl-list-view').hidden = false;
    var box = $('#pl-list');
    box.innerHTML = '<p class="pl-muted">加载中…</p>';
    api('GET', '/api/submissions').then(function (j) {
      state.list = j.submissions || [];
      renderList();
    }).catch(function (ex) { box.innerHTML = '<p class="pl-err">加载失败：' + esc(ex.message) + '</p>'; });
  }

  function miniTrack(r) {
    var segs = STAGE_FLOW.map(function (s) {
      var ss = itemStatus(r, s);
      return '<i class="st-' + esc(ss) + '" title="' + esc(STAGE_LABELS[s] + ' · ' + (STAGE_STATUS_LABELS[ss] || ss)) + '"></i>';
    }).join('');
    var ov = overallProgress(r, true);
    return '<div class="pl-mini-track">' + segs + '</div><span class="pl-badge" style="margin-left:8px">' + ov.pct + '%</span>';
  }

  function renderList() {
    var box = $('#pl-list');
    $('#pl-count').textContent = state.list.length + ' 条提交';
    if (!state.list.length) {
      box.innerHTML = '<p class="pl-muted">暂无提交。用户在「撰写新剧本」页提交后，创意将出现在这里，随后进入五阶段创作管线。</p>';
      return;
    }
    var rows = state.list.map(function (r) {
      var badge = '<span class="pl-badge st-' + esc(r.stageStatus || 'empty') + '">' +
        esc(STAGE_LABELS[r.stage] || r.stage || '大纲') + ' · ' + esc(STAGE_STATUS_LABELS[r.stageStatus] || r.stageStatus || '未开始') + '</span>';
      return '<tr class="pl-row" data-id="' + esc(r.id) + '">' +
        '<td class="pl-mono">' + esc(r.id) + '</td>' +
        '<td><b>' + esc(r.title) + '</b></td>' +
        '<td>' + esc(PAIRINGS[r.pairing] || r.pairing || '—') + '</td>' +
        '<td>' + esc(CATEGORIES[r.category] || r.category || '—') + '</td>' +
        '<td>' + esc(r.episodes || '?') + ' 集</td>' +
        '<td>' + badge + '</td>' +
        '<td>' + miniTrack(r) + '</td>' +
        '<td class="pl-muted pl-time">' + esc(fmtTime(r.updatedAt || r.createdAt)) + '</td>' +
        '</tr>';
    }).join('');
    box.innerHTML = '<div class="pl-table-wrap"><table class="pl-table"><thead><tr><th>编号</th><th>剧名</th><th>配向</th><th>母题</th><th>体量</th><th>当前阶段</th><th>进度</th><th>更新时间</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
    $$('.pl-row', box).forEach(function (tr) {
      tr.addEventListener('click', function () { openDetail(tr.getAttribute('data-id')); });
    });
  }

  /* ---------- 详情视图 ---------- */

  function openDetail(id) {
    $('#pl-list-view').hidden = true;
    $('#pl-detail-view').hidden = false;
    history.replaceState(null, '', location.pathname + '?id=' + encodeURIComponent(id));
    loadDetail(id);
  }

  function loadDetail(id) {
    clearTimers();
    state.sumStage = '';
    $('#pl-stage-panel').innerHTML = '<p class="pl-muted">加载中…</p>';
    api('GET', '/api/submissions/' + encodeURIComponent(id)).then(function (j) {
      state.rec = j.submission;
      state.dirty = false;
      state.epDirty = false;
      renderDetail();
    }).catch(function (ex) {
      $('#pl-stage-panel').innerHTML = '<p class="pl-err">加载失败：' + esc(ex.message) + '</p>';
    });
  }

  function renderDetail() {
    var rec = state.rec;
    var back = $('#pl-back');
    if (back) back.textContent = state.role === 'editor' ? '← 退出编辑（返回入口）' : '← 返回提交列表';
    $('#pl-head').innerHTML =
      '<div class="pl-head-row"><h2>《' + esc(rec.title) + '》</h2>' +
      '<button id="pl-reload" class="pl-btn pl-btn-ghost" type="button">刷新状态</button></div>' +
      '<div class="pl-meta">' +
      '<span class="pl-chip">' + esc(PAIRINGS[rec.pairing] || rec.pairing) + '</span>' +
      '<span class="pl-chip">' + esc(CATEGORIES[rec.category] || rec.category) + '</span>' +
      '<span class="pl-chip">' + esc(rec.episodes) + ' 集 × 90s 竖屏</span>' +
      '<span class="pl-chip pl-mono">' + esc(rec.id) + '</span>' +
      '<span class="pl-chip">提交于 ' + esc(fmtTime(rec.createdAt)) + '</span>' +
      '</div>' +
      (rec.idea ? '<p class="pl-idea">' + esc(rec.idea) + '</p>' : '') +
      (rec.benchmark ? '<p class="pl-muted">对标：' + esc(rec.benchmark) + '</p>' : '');
    $('#pl-reload').addEventListener('click', function () { loadDetail(rec.id); });
    renderTimeline();
    renderStagePanel();
  }

  function eventDotClass(type) {
    var map = { request: 'st-requested', progress: 'st-draft', ready: 'st-pending_review', approved: 'st-approved',
      rejected: 'st-rejected', 'assets-choice': 'st-awaiting_choice', asset: 'st-generating', published: 'st-done' };
    return map[type] || '';
  }

  function renderTimeline() {
    var rec = state.rec;
    var cur = stageOfRec(rec);
    var ov = overallProgress(rec, false);
    var nodes = STAGE_FLOW.map(function (s) {
      var ss = s === 'done' ? (cur === 'done' ? 'done' : 'empty') : statusOf(rec, s);
      var entry = entryOf(rec, s);
      var time = entry && entry.updatedAt ? fmtShort(entry.updatedAt) : '';
      var sub = '';
      if (s === 'script' && entry && entry.progress) sub = entry.progress.written + '/' + entry.progress.total + ' 集';
      var sum = (ss === 'approved' || ss === 'skipped' || ss === 'done') ? ' data-sum="' + s + '" title="点击查看阶段摘要"' : '';
      return '<div class="pl-node' + (s === cur ? ' active' : '') + ' st-' + esc(ss) + '"' + sum + '>' +
        '<div class="pl-node-icon">' + STAGE_ICONS[s] + '</div>' +
        '<div class="pl-node-dot"></div>' +
        '<div class="pl-node-label">' + esc(STAGE_LABELS[s]) + '</div>' +
        '<div class="pl-node-status">' + esc(STAGE_STATUS_LABELS[ss] || ss) + (sub ? ' · ' + esc(sub) : '') + '</div>' +
        (time ? '<div class="pl-node-time">' + esc(time) + '</div>' : '') +
        '</div>';
    }).join('');
    var html = '<div class="pl-overall"><div class="pl-overall-bar"><i style="width:' + ov.pct + '%"></i></div>' +
      '<span>总体进度 ' + ov.pct + '% · ' + ov.stageNo + '（' + esc(ov.stageLabel) + '）· 已持续 ' + esc(durationText(rec.createdAt)) + '</span></div>' +
      '<div class="pl-track">' + nodes + '</div>';
    if (rec.events && rec.events.length) {
      var evs = rec.events.slice().reverse().map(function (e) {
        return '<div class="pl-event"><span class="pl-event-dot ' + esc(eventDotClass(e.type)) + '"></span>' +
          '<span class="pl-event-time">' + esc(fmtShort(e.t)) + '</span><span>' + esc(e.label) + '</span></div>';
      }).join('');
      html += '<details class="pl-events-box"><summary>进度事件（' + rec.events.length + '）</summary>' + evs + '</details>';
    }
    $('#pl-timeline').innerHTML = html;
    $$('#pl-timeline .pl-node[data-sum]').forEach(function (n) {
      n.addEventListener('click', function () {
        state.sumStage = n.getAttribute('data-sum');
        renderStagePanel();
      });
    });
  }

  /* ---------- 阶段面板 ---------- */

  function stBadge(status) { return ' <span class="pl-badge st-' + esc(status) + '">' + esc(STAGE_STATUS_LABELS[status] || status) + '</span>'; }

  function waitHtml(title, sub) {
    return '<div class="pl-wait"><div class="pl-wait-icon">⏳</div><h3>' + esc(title) + '</h3>' +
      '<p class="pl-muted">' + esc(sub) + '</p>' +
      '<p class="pl-elapsed" id="pl-elapsed" hidden></p>' +
      '<p class="pl-subbar" id="pl-wait-bar" hidden><i style="width:0%"></i></p>' +
      '<button type="button" class="pl-btn pl-btn-ghost" id="pl-wait-reload">刷新状态</button>' +
      '<p class="pl-poll-tip" id="pl-poll-tip" hidden></p></div>';
  }

  function legacyRejectedNote() {
    return '<p class="pl-muted" style="margin:0 0 14px">该阶段在旧审核流程中曾被驳回，现可直接编辑修改后确认推进。</p>';
  }

  function confirmBar(withSave, hint) {
    return '<div class="pl-confirm">' +
      (withSave ? '<button type="button" class="pl-btn pl-btn-ghost" id="pl-save">保存修改</button>' : '') +
      '<button type="button" class="pl-btn pl-btn-ok" id="pl-confirm">✓ 确认无误，进入下一阶段</button>' +
      (hint ? '<span class="pl-confirm-hint">' + esc(hint) + '</span>' : '') +
      '</div>';
  }

  function renderStagePanel() {
    clearTimers();
    var rec = state.rec;
    if (state.sumStage) {
      $('#pl-stage-panel').innerHTML = renderStageSummary(state.sumStage);
      var back = $('#pl-sum-back');
      if (back) back.addEventListener('click', function () { state.sumStage = ''; renderStagePanel(); });
      return;
    }
    var stage = stageOfRec(rec);
    var entry = entryOf(rec, stage) || {};
    var status = entry.status || 'empty';
    var html = '';
    if (stage === 'outline') html = panelOutline(rec, entry, status);
    else if (stage === 'synopsis') html = panelSynopsis(rec, entry, status);
    else if (stage === 'script') html = panelScript(rec, entry, status);
    else if (stage === 'assets') html = panelAssets(rec, entry, status);
    else html = panelPublish(rec, entry, status);
    $('#pl-stage-panel').innerHTML = html;
    bindPanel(stage, status);
  }

  /* ---- 已完成阶段只读摘要（点击时间轴已确认节点） ---- */
  function renderStageSummary(stage) {
    var rec = state.rec;
    var entry = entryOf(rec, stage) || {};
    var c = entry.content || {};
    var rows = '';
    function row(k, v) { rows += '<dt>' + esc(k) + '</dt><dd>' + v + '</dd>'; }
    if (stage === 'outline') {
      row('Logline（英文）', esc(c.logline || '—'));
      row('Logline（中文）', esc(c.loglineZh || '—'));
      row('题材标签', esc((c.genreTags || []).join('、') || '—'));
      var mc = c.mainChars || [];
      row('主要人物', mc.length + ' 位' + (mc.length ? '：' + esc(mc.map(function (m) { return m.nameZh || m.name || '?'; }).join('、')) : ''));
      row('五幕主线', ((c.fiveActs || []).length) + ' 幕');
    } else if (stage === 'synopsis') {
      var eps = c.episodes || [];
      var pays = eps.filter(function (e) { return e.paymark; }).length;
      row('分集梗概', eps.length + ' / ' + (rec.episodes || '?') + ' 集');
      row('付费卡点', pays + ' 处');
      var ol = entryOf(rec, 'outline');
      var acts = (ol && ol.content && ol.content.fiveActs) || [];
      row('幕划分', acts.length ? esc(acts.map(function (a) { return a.title + '（' + (a.epRange || '') + '）'; }).join(' / ')) : '—');
    } else if (stage === 'script') {
      var seps = c.episodes || [];
      var edited = seps.filter(function (e) { return e.edited; }).length;
      var scenes = 0, lines = 0;
      seps.forEach(function (e) { (e.scenes || []).forEach(function (sc) { scenes++; lines += (sc.lines || []).length; }); });
      row('已生成', seps.length + ' / ' + (rec.episodes || '?') + ' 集');
      row('已人工编辑', edited + ' 集');
      row('场景总数', scenes + ' 个');
      row('对白行总数', lines + ' 行');
    } else if (stage === 'assets') {
      if (entry.status === 'skipped') row('视觉资产', '已跳过生图');
      else {
        var items = c.items || [];
        row('图片数量', items.length + ' 张');
        row('图片清单', items.length ? esc(items.map(function (it) { return it.label || it.key; }).join('、')) : '—');
      }
    } else {
      row('飞书文档', c.feishuDocUrl ? '<a class="pl-link" target="_blank" rel="noopener" href="' + esc(c.feishuDocUrl) + '">打开文档 →</a>' : '—');
      row('线上页面', c.pageUrl ? '<a class="pl-link" target="_blank" rel="noopener" href="' + esc(c.pageUrl) + '">打开页面 →</a>' : '—');
      row('发布时间', c.deployedAt ? esc(fmtTime(c.deployedAt)) : '—');
    }
    row('更新时间', entry.updatedAt ? esc(fmtTime(entry.updatedAt)) : '—');
    return '<h3 class="pl-stage-title">' + (STAGE_ICONS[stage] || '') + '「' + esc(STAGE_LABELS[stage]) + '」阶段摘要' + stBadge(entry.status || 'approved') + '</h3>' +
      '<div class="pl-sum-card"><dl>' + rows + '</dl></div>' +
      '<div class="pl-confirm"><button type="button" class="pl-btn pl-btn-ghost" id="pl-sum-back">← 返回当前阶段</button></div>';
  }

  /* ---- 阶段 1：大纲（可编辑表单） ---- */
  function reqBar(stage, label, hint) {
    return '<div class="pl-req-row">' +
      '<button type="button" class="pl-btn pl-btn-req" data-req="' + esc(stage) + '">✦ 请求 AI 撰写' + esc(label) + '</button>' +
      '<span class="pl-muted" style="margin:0">' + esc(hint) + '</span></div>';
  }

  function panelOutline(rec, entry, status) {
    if (status === 'requested' || status === 'draft' || status === 'generating')
      return waitHtml('大纲撰写中…', '已请求 AI 撰写剧本大纲（世界观 / 人物 / 五幕主线 / 付费卡点策略），生成后可在此直接编辑。');
    var c = (entry && entry.content) || {};
    var charRows = (c.mainChars || []).map(function (m) { return charRowTpl(m); }).join('');
    var actCards = (c.fiveActs || []).map(function (a) { return actCardTpl(a); }).join('');
    function fld(label, id, val, rows) {
      return '<div class="pl-field"><label>' + esc(label) + '</label>' +
        '<textarea id="' + id + '" class="pl-ta" rows="' + (rows || 3) + '">' + esc(val || '') + '</textarea></div>';
    }
    var isEmpty = status === 'empty';
    return '<h3 class="pl-stage-title">阶段 1/5 · 剧本大纲' + stBadge(status) + '</h3>' +
      (status === 'rejected' ? legacyRejectedNote() : '') +
      (isEmpty ? reqBar('outline', '大纲', '点击后由 AI 生成初稿；生成期间也可直接在下方手动填写。') : '') +
      '<p class="pl-muted" style="margin:0 0 16px">' + (isEmpty
        ? '大纲尚未生成：可请求 AI 撰写，或直接在下方手动填写（保存后即可确认推进）。'
        : 'AI 已生成大纲初稿，所有字段均可直接修改。') + '</p>' +
      fld('Logline（英文）', 'ol-logline', c.logline, 3) +
      fld('Logline（中文）', 'ol-loglineZh', c.loglineZh, 3) +
      '<div class="pl-field"><label>题材标签（逗号分隔）</label>' +
      '<input id="ol-tags" class="pl-in" value="' + esc((c.genreTags || []).join(', ')) + '" placeholder="如：亿万总裁, 野性攻, 命定占有"></div>' +
      fld('世界观设定', 'ol-setting', c.setting, 4) +
      fld('主题与情绪', 'ol-themes', c.themes, 3) +
      fld('CP 动力学', 'ol-cpDynamics', c.cpDynamics, 4) +
      fld('付费卡点策略', 'ol-paywallStrategy', c.paywallStrategy, 4) +
      '<div class="pl-field"><label>主要人物</label>' +
      '<div class="pl-table-wrap"><table class="pl-table"><thead><tr><th style="width:16%">人物（英）</th><th style="width:14%">人物（中）</th><th style="width:22%">定位</th><th>人物弧光</th><th style="width:34px"></th></tr></thead>' +
      '<tbody id="pl-char-tbody">' + (charRows || '') + '</tbody></table></div>' +
      '<button type="button" class="pl-mini ol-add-char" style="margin-top:8px">+ 添加人物</button></div>' +
      '<div class="pl-field"><label>五幕主线</label>' +
      '<div id="pl-acts">' + (actCards || '<p class="pl-muted">暂无幕，点击下方添加。</p>') + '</div>' +
      '<button type="button" class="pl-mini ol-add-act">+ 添加幕</button></div>' +
      confirmBar(true, isEmpty ? '手动填写后「保存修改」即进入待确认状态；AI 生成的初稿也会出现在此表单中，可继续修改。' : '修改后可先「保存修改」暂存；直接点确认也会自动保存再推进。');
  }

  function charRowTpl(m) {
    m = m || {};
    return '<tr class="ol-char-row">' +
      '<td><input class="pl-in ol-name" value="' + esc(m.name || '') + '" placeholder="Name"></td>' +
      '<td><input class="pl-in ol-namezh" value="' + esc(m.nameZh || '') + '" placeholder="中文名"></td>' +
      '<td><input class="pl-in ol-role" value="' + esc(m.role || '') + '" placeholder="攻/受·定位·年龄"></td>' +
      '<td><textarea class="pl-ta ol-arc" rows="2">' + esc(m.arc || '') + '</textarea></td>' +
      '<td><button type="button" class="pl-mini ol-del-char" title="删除此行">×</button></td>' +
      '</tr>';
  }

  function actCardTpl(a) {
    a = a || {};
    return '<div class="pl-act ol-act">' +
      '<div class="pl-act-head">' +
      '<input class="pl-in ol-act-title" style="flex:1;min-width:160px" value="' + esc(a.title || '') + '" placeholder="幕标题，如 第一幕 · The Claim">' +
      '<input class="pl-in ol-act-range" style="width:130px" value="' + esc(a.epRange || '') + '" placeholder="EP01-12">' +
      '<button type="button" class="pl-mini ol-del-act" title="删除此幕">×</button>' +
      '</div>' +
      '<textarea class="pl-ta ol-act-summary" rows="3" placeholder="本幕剧情概要">' + esc(a.summary || '') + '</textarea>' +
      '</div>';
  }

  function collectOutline() {
    var chars = $$('#pl-stage-panel .ol-char-row').map(function (tr) {
      return {
        name: ($('.ol-name', tr) || {}).value || '',
        nameZh: ($('.ol-namezh', tr) || {}).value || '',
        role: ($('.ol-role', tr) || {}).value || '',
        arc: ($('.ol-arc', tr) || {}).value || '',
      };
    });
    var acts = $$('#pl-stage-panel .ol-act').map(function (d, i) {
      return {
        act: i + 1,
        title: ($('.ol-act-title', d) || {}).value || '',
        epRange: ($('.ol-act-range', d) || {}).value || '',
        summary: ($('.ol-act-summary', d) || {}).value || '',
      };
    });
    var tags = (($('#ol-tags') || {}).value || '').split(/[,，、]/).map(function (s) { return s.trim(); }).filter(Boolean);
    return {
      logline: (($('#ol-logline') || {}).value || '').trim(),
      loglineZh: (($('#ol-loglineZh') || {}).value || '').trim(),
      genreTags: tags,
      setting: (($('#ol-setting') || {}).value || '').trim(),
      themes: (($('#ol-themes') || {}).value || '').trim(),
      cpDynamics: (($('#ol-cpDynamics') || {}).value || '').trim(),
      paywallStrategy: (($('#ol-paywallStrategy') || {}).value || '').trim(),
      mainChars: chars,
      fiveActs: acts,
    };
  }

  /* ---- 阶段 2：分集梗概（可编辑表格） ---- */
  function synopsisRow(e) {
    e = e || {};
    return '<tr class="sy-row" data-ep="' + esc(e.ep || '') + '">' +
      '<td class="pl-mono">EP' + String(e.ep || '').padStart(2, '0') + '</td>' +
      '<td><input class="pl-in sy-title" value="' + esc(e.title || '') + '" placeholder="标题"></td>' +
      '<td><input class="pl-in sy-hook" value="' + esc(e.hook || '') + '" placeholder="结尾钩子"></td>' +
      '<td><input class="pl-in sy-beat" value="' + esc(e.beat || '') + '" placeholder="剧情节拍"></td>' +
      '<td><input class="pl-in sy-paymark" value="' + esc(e.paymark || '') + '" placeholder="付费卡点标记"></td>' +
      '</tr>';
  }

  function panelSynopsis(rec, entry, status) {
    if (status === 'requested' || status === 'draft')
      return waitHtml('分集梗概撰写中…', '已请求 AI 撰写全 ' + (rec.episodes || '?') + ' 集分集梗概与钩子，生成后可在此直接编辑。');
    var eps = (entry.content && entry.content.episodes) || [];
    var isEmpty = status === 'empty';
    if (!eps.length && !isEmpty) return waitHtml('分集梗概生成中…', '尚未写入内容。');
    var ol = entryOf(rec, 'outline');
    var acts = (ol && ol.content && ol.content.fiveActs) || [];
    var rows = eps.map(synopsisRow).join('');
    var groupNote = acts.length
      ? '<p class="pl-muted">幕划分：' + acts.map(function (a) { return esc(a.title) + '（' + esc(a.epRange || '') + '）'; }).join(' / ') + '</p>'
      : '';
    return '<h3 class="pl-stage-title">阶段 2/5 · 分集梗概' + stBadge(status) + '</h3>' +
      (status === 'rejected' ? legacyRejectedNote() : '') +
      (isEmpty ? reqBar('synopsis', '分集梗概', '点击后由 AI 生成全集梗概；也可点击表格下方「+ 添加一集」手动撰写。') : '') +
      '<p class="pl-muted">' + (isEmpty
        ? '分集梗概尚未生成：可请求 AI 撰写，或手动逐集添加（保存后即可确认推进）。'
        : '共 ' + eps.length + ' / ' + (rec.episodes || '?') + ' 集' + (eps.length < Number(rec.episodes) ? '（尚未写完）' : '') + '，每集的标题 / 钩子 / 节拍 / 付费标记均可直接修改。') + '</p>' +
      groupNote +
      '<div class="pl-block"><div class="pl-table-wrap pl-ep-scroll"><table class="pl-table"><thead><tr><th>集</th><th style="width:18%">标题</th><th style="width:26%">钩子</th><th style="width:28%">剧情节拍</th><th style="width:14%">付费标记</th></tr></thead>' +
      '<tbody' + (isEmpty ? ' id="pl-sy-tbody"' : '') + '>' + rows + '</tbody></table></div>' +
      (isEmpty ? '<button type="button" class="pl-mini sy-add-ep" style="margin-top:8px">+ 添加一集</button>' : '') +
      '</div>' +
      confirmBar(true, isEmpty ? '手动添加并填写集数后「保存修改」即进入待确认状态；AI 生成的梗概也会填入此表，可继续修改。' : '修改后可先「保存修改」暂存；直接点确认也会自动保存再推进。');
  }

  function collectSynopsis() {
    var eps = $$('#pl-stage-panel .sy-row').map(function (tr) {
      return {
        ep: Number(tr.getAttribute('data-ep')),
        title: ($('.sy-title', tr) || {}).value || '',
        hook: ($('.sy-hook', tr) || {}).value || '',
        beat: ($('.sy-beat', tr) || {}).value || '',
        paymark: ($('.sy-paymark', tr) || {}).value || '',
      };
    });
    return { episodes: eps };
  }

  /* ---- 阶段 3：完整剧本（模块化编辑器） ---- */
  function panelScript(rec, entry, status) {
    if (status === 'empty')
      return '<h3 class="pl-stage-title">阶段 3/5 · 完整剧本' + stBadge(status) + '</h3>' +
        reqBar('script', '完整剧本', '点击后由 AI 按已确认的分集梗概分批撰写全集剧本；生成期间可随时「刷新状态」查看进度。');
    if (status === 'requested' || status === 'draft') {
      var p = entry && entry.progress;
      return waitHtml('完整剧本生成中…',
        (p ? '已生成 ' + p.written + ' / ' + p.total + ' 集。' : '已请求 AI 分批撰写全集完整剧本。') +
        '生成完成后可逐集在线编辑。');
    }
    var eps = (entry.content && entry.content.episodes) || [];
    if (!eps.length) return waitHtml('完整剧本生成中…', '内容尚未写入。');
    var total = Number(rec.episodes) || 72;
    if (!state.curEp || !eps.some(function (e) { return e.ep === state.curEp; })) state.curEp = eps[0].ep;
    var grid = '';
    for (var i = 1; i <= total; i++) {
      var e = null;
      for (var k = 0; k < eps.length; k++) if (eps[k].ep === i) { e = eps[k]; break; }
      var cls = 'pl-ep-btn' + (e ? ' written' : '') + (e && e.edited ? ' edited' : '') + (i === state.curEp ? ' active' : '');
      grid += '<button type="button" class="' + cls + '" data-ep="' + i + '">' + i + (e && e.edited ? '<i>改</i>' : '') + '</button>';
    }
    var editedCount = eps.filter(function (x) { return x.edited; }).length;
    var genPct = Math.round(eps.length / total * 100);
    return '<h3 class="pl-stage-title">阶段 3/5 · 完整剧本' + stBadge(status) + '</h3>' +
      (status === 'rejected' ? legacyRejectedNote() : '') +
      '<div class="pl-script-stat"><div class="pl-subbar"><i style="width:' + genPct + '%"></i></div>' +
      '<span class="pl-muted">生成 ' + eps.length + '/' + total + ' 集（' + genPct + '%）· 已人工编辑 ' + editedCount + ' 集。点击左侧集数查看与编辑，编辑后记得点「保存本集」。</span></div>' +
      '<div class="pl-script-layout">' +
      '<div class="pl-ep-grid">' + grid + '</div>' +
      '<div class="pl-ep-editor" id="pl-ep-editor"></div>' +
      '</div>' +
      confirmBar(false, '逐集编辑并「保存本集」后，点确认按钮进入视觉资产阶段。');
  }

  function renderEpEditor() {
    var rec = state.rec;
    var entry = entryOf(rec, 'script') || {};
    var eps = (entry.content && entry.content.episodes) || [];
    var ep = null;
    for (var i = 0; i < eps.length; i++) if (eps[i].ep === state.curEp) { ep = eps[i]; break; }
    var box = $('#pl-ep-editor');
    if (!box) return;
    state.epDirty = false;
    if (!ep) { box.innerHTML = '<p class="pl-muted">第 ' + state.curEp + ' 集尚未生成。</p>'; return; }
    var scenesHtml = (ep.scenes || []).map(function (sc, si) {
      var lines = (sc.lines || []).map(function (l, li) {
        return '<div class="pl-line-row">' +
          '<input class="pl-in pl-in-speaker" value="' + esc(l.s) + '" placeholder="角色">' +
          '<input class="pl-in pl-in-en" value="' + esc(l.l) + '" placeholder="英文对白">' +
          '<input class="pl-in pl-in-zh" value="' + esc(l.lZh) + '" placeholder="中文对照">' +
          '<button type="button" class="pl-mini del-line" title="删除此行">×</button>' +
          '</div>';
      }).join('');
      return '<div class="pl-scene">' +
        '<div class="pl-scene-head"><span>场景 ' + (si + 1) + '</span><button type="button" class="pl-mini del-scene">删除场景</button></div>' +
        '<input class="pl-in pl-in-slug" value="' + esc(sc.slug) + '" placeholder="场景标注，如 INT. MANSION - HALL - NIGHT">' +
        '<textarea class="pl-ta pl-ta-action" rows="2" placeholder="动作 / 导演提示">' + esc(sc.action) + '</textarea>' +
        '<div class="pl-lines">' + (lines || '<p class="pl-muted">暂无对白</p>') + '</div>' +
        '<button type="button" class="pl-mini add-line">+ 对白行</button>' +
        '</div>';
    }).join('');
    box.innerHTML =
      '<div class="pl-ep-form" data-ep="' + ep.ep + '">' +
      '<div class="pl-ep-form-head"><b>EP' + String(ep.ep).padStart(2, '0') + '</b>' +
      (ep.edited ? '<span class="pl-edited-tag">已编辑</span>' : '') + '</div>' +
      '<input class="pl-in pl-in-title" value="' + esc(ep.title) + '" placeholder="本集标题">' +
      '<input class="pl-in pl-in-hook" value="' + esc(ep.hook) + '" placeholder="本集钩子（结尾悬念）">' +
      '<div class="pl-scenes">' + (scenesHtml || '<p class="pl-muted">暂无场景，点击下方添加。</p>') + '</div>' +
      '<div class="pl-ep-actions">' +
      '<button type="button" class="pl-mini add-scene">+ 添加场景</button>' +
      '<button type="button" class="pl-btn pl-btn-save" id="pl-save-ep">保存本集</button>' +
      '</div></div>';
  }

  function sceneTpl() {
    return '<div class="pl-scene">' +
      '<div class="pl-scene-head"><span>场景</span><button type="button" class="pl-mini del-scene">删除场景</button></div>' +
      '<input class="pl-in pl-in-slug" placeholder="场景标注，如 INT. MANSION - HALL - NIGHT">' +
      '<textarea class="pl-ta pl-ta-action" rows="2" placeholder="动作 / 导演提示"></textarea>' +
      '<div class="pl-lines"></div>' +
      '<button type="button" class="pl-mini add-line">+ 对白行</button>' +
      '</div>';
  }

  function lineTpl() {
    return '<div class="pl-line-row">' +
      '<input class="pl-in pl-in-speaker" placeholder="角色">' +
      '<input class="pl-in pl-in-en" placeholder="英文对白">' +
      '<input class="pl-in pl-in-zh" placeholder="中文对照">' +
      '<button type="button" class="pl-mini del-line" title="删除此行">×</button>' +
      '</div>';
  }

  function bindEpEditor() {
    var box = $('#pl-ep-editor');
    if (!box) return;

    $$('.pl-ep-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        if (state.epDirty && !confirm('当前剧集有未保存的修改，继续切换将丢失，确定？')) return;
        state.curEp = Number(b.getAttribute('data-ep'));
        renderStagePanel();
      });
    });

    box.addEventListener('click', function (ev) {
      var t = ev.target;
      if (!t || t.nodeType !== 1) return;
      if (t.classList.contains('add-scene')) {
        var cont = $('.pl-scenes', box);
        if (cont) cont.insertAdjacentHTML('beforeend', sceneTpl());
        state.epDirty = true;
      } else if (t.classList.contains('del-scene')) {
        var sc = t.closest('.pl-scene');
        if (sc) sc.remove();
        state.epDirty = true;
      } else if (t.classList.contains('add-line')) {
        var sc2 = t.closest('.pl-scene');
        var lines = sc2 ? $('.pl-lines', sc2) : null;
        if (lines) lines.insertAdjacentHTML('beforeend', lineTpl());
        state.epDirty = true;
      } else if (t.classList.contains('del-line')) {
        var row = t.closest('.pl-line-row');
        if (row) row.remove();
        state.epDirty = true;
      } else if (t.id === 'pl-save-ep') {
        saveCurrentEp(t);
      }
    });
  }

  function collectEpData() {
    var form = $('#pl-ep-editor .pl-ep-form');
    if (!form) return null;
    var scenes = $$('.pl-scene', form).map(function (scEl, si) {
      var lines = $$('.pl-line-row', scEl).map(function (lr) {
        return {
          s: ($('.pl-in-speaker', lr) || {}).value || '',
          l: ($('.pl-in-en', lr) || {}).value || '',
          lZh: ($('.pl-in-zh', lr) || {}).value || '',
        };
      });
      return {
        no: si + 1,
        slug: ($('.pl-in-slug', scEl) || {}).value || '',
        action: ($('.pl-ta-action', scEl) || {}).value || '',
        lines: lines,
      };
    });
    return {
      ep: Number(form.getAttribute('data-ep')),
      title: ($('.pl-in-title', form) || {}).value || '',
      hook: ($('.pl-in-hook', form) || {}).value || '',
      scenes: scenes,
    };
  }

  function saveCurrentEp(btn) {
    var d = collectEpData();
    if (!d) return;
    btn.disabled = true;
    btn.textContent = '保存中…';
    api('PATCH', '/api/submissions/' + state.rec.id, {
      action: 'edit-ep', ep: d.ep, data: { title: d.title, hook: d.hook, scenes: d.scenes },
    }).then(function () {
      var entry = entryOf(state.rec, 'script');
      var eps = entry.content.episodes;
      var ne = { ep: d.ep, title: d.title, hook: d.hook, scenes: d.scenes, edited: true };
      var idx = -1;
      for (var i = 0; i < eps.length; i++) if (eps[i].ep === d.ep) { idx = i; break; }
      if (idx >= 0) eps[idx] = ne; else eps.push(ne);
      state.epDirty = false;
      renderStagePanel();
    }).catch(function (ex) {
      alert('保存失败：' + ex.message);
      btn.disabled = false;
      btn.textContent = '保存本集';
    });
  }

  /* ---- 阶段 4：视觉资产 ---- */
  function panelAssets(rec, entry, status) {
    if (status === 'empty')
      return waitHtml('等待选择…', '剧本已确认，即将进入视觉资产选择。');
    if (status === 'awaiting_choice')
      return '<h3 class="pl-stage-title">阶段 4/5 · 视觉资产' + stBadge(status) + '</h3>' +
        '<p class="pl-muted">选择「生成」将由 AI 产出 Key Art 封面 / 角色设定图 / 场景概念图（需数分钟，完成后可在此查看确认）；' +
        '选择「跳过生图」则直接进入发布阶段，线上页面将以主题色渐变占位封面、不展示资产区块。</p>' +
        '<div class="pl-choice-btns">' +
        '<button type="button" class="pl-btn pl-btn-ok" id="pl-assets-gen">生成视觉资产</button>' +
        '<button type="button" class="pl-btn pl-btn-ghost" id="pl-assets-skip">跳过生图</button>' +
        '</div>';
    if (status === 'generating')
      return waitHtml('视觉资产生成中…', '已选择生成，AI 正在产出图片并逐张上传（Key Art / 角色设定 / 场景概念）。');
    var items = (entry.content && entry.content.items) || [];
    var gal = items.map(function (it) {
      return '<figure class="pl-asset"><img data-imgkey="' + esc(it.key) + '" alt="' + esc(it.label) + '">' +
        '<figcaption>' + esc(it.label) + (it.aspect ? ' · ' + esc(it.aspect) : '') + '</figcaption></figure>';
    }).join('');
    return '<h3 class="pl-stage-title">阶段 4/5 · 视觉资产' + stBadge(status) + '</h3>' +
      (status === 'rejected' ? legacyRejectedNote() : '') +
      '<div class="pl-asset-grid">' + (gal || '<p class="pl-muted">暂无图片</p>') + '</div>' +
      confirmBar(false, '确认图片效果后点确认按钮进入发布阶段。');
  }

  function loadAssetImages() {
    $$('#pl-stage-panel img[data-imgkey]').forEach(function (img) {
      var key = img.getAttribute('data-imgkey');
      api('GET', '/api/submissions/' + state.rec.id + '?img=' + encodeURIComponent(key), undefined, true)
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); })
        .then(function (b) { img.src = URL.createObjectURL(b); })
        .catch(function () { img.alt = '图片加载失败'; });
    });
  }

  function assetsChoice(choice) {
    if (choice === 'skip' && !confirm('确认跳过视觉资产生成，直接进入发布阶段？')) return;
    if (choice === 'generate' && !confirm('确认开始生成视觉资产？AI 将产出封面 / 角色 / 场景图，需要数分钟。')) return;
    api('PATCH', '/api/submissions/' + state.rec.id, { action: 'assets-choice', choice: choice })
      .then(function () { loadDetail(state.rec.id); })
      .catch(function (ex) { alert('操作失败：' + ex.message); });
  }

  /* ---- 阶段 5：发布 ---- */
  function panelPublish(rec, entry, status) {
    if (status === 'done' || stageOfRec(rec) === 'done') {
      var c = (entry && entry.content) || {};
      return '<h3 class="pl-stage-title">已完成 🎉</h3>' +
        (c.feishuDocUrl ? '<p><a class="pl-link" target="_blank" rel="noopener" href="' + esc(c.feishuDocUrl) + '">飞书在线文档（可编辑 / 导出 Word · PDF）→</a></p>' : '') +
        (c.pageUrl ? '<p><a class="pl-link" target="_blank" rel="noopener" href="' + esc(c.pageUrl) + '">线上剧本详情页 →</a></p>' : '') +
        (c.deployedAt ? '<p class="pl-muted">发布于 ' + esc(fmtTime(c.deployedAt)) + '</p>' : '');
    }
    return waitHtml('等待发布…',
      '全部阶段已确认。发布动作：创建飞书文档并归档 → 生成线上详情页并注册剧本库 → 加密上线。完成后此处将显示访问链接。');
  }

  /* ---------- 保存与确认 ---------- */

  function requestGenerate(stage) {
    api('PATCH', '/api/submissions/' + state.rec.id, { action: 'request-generate', stage: stage })
      .then(function () { loadDetail(state.rec.id); })
      .catch(function (ex) { alert('请求失败：' + ex.message); });
  }

  function saveStageEdits(stage, done, btn) {
    var content = stage === 'outline' ? collectOutline() : collectSynopsis();
    var st = statusOf(state.rec, stage);
    var toReview = st === 'rejected' || st === 'empty';
    if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
    api('PATCH', '/api/submissions/' + state.rec.id, {
      action: 'stage-content', stage: stage, ready: toReview, content: content,
    }).then(function () {
      state.dirty = false;
      var entry = entryOf(state.rec, stage);
      if (entry) {
        entry.content = content;
        if (toReview) entry.status = 'pending_review';
      }
      renderStagePanel();
      if (done) done();
    }).catch(function (ex) {
      alert('保存失败：' + ex.message);
      if (btn) { btn.disabled = false; btn.textContent = '保存修改'; }
    });
  }

  function confirmStage(stage) {
    var st = statusOf(state.rec, stage);
    if (stage === 'script' && state.epDirty) {
      alert('当前剧集有未保存的修改，请先点击「保存本集」。');
      return;
    }
    if ((stage === 'outline' || stage === 'synopsis') && st === 'empty' && !state.dirty) {
      alert('该阶段内容为空：请先点击「请求 AI 撰写」生成初稿，或在表单中手动填写后再确认。');
      return;
    }
    if (!confirm('确认「' + STAGE_LABELS[stage] + '」内容无误？确认后将自动进入下一阶段。')) return;
    var id = state.rec.id;
    var proceed = function () {
      api('PATCH', '/api/submissions/' + id, { action: 'decision', stage: stage, decision: 'approved' })
        .then(function () {
          state.dirty = false;
          state.epDirty = false;
          loadDetail(id);
        })
        .catch(function (ex) { alert('确认失败：' + ex.message); });
    };
    if ((stage === 'outline' || stage === 'synopsis') && (state.dirty || st === 'rejected' || st === 'empty')) {
      saveStageEdits(stage, proceed);
    } else if (st === 'rejected') {
      api('PATCH', '/api/submissions/' + id, { action: 'stage-content', stage: stage, ready: true })
        .then(proceed)
        .catch(function (ex) { alert('操作失败：' + ex.message); });
    } else {
      proceed();
    }
  }

  /* ---------- 面板事件绑定 ---------- */

  /* 等待态可视化：已等待时长每秒跳动 + 剧本生成进度条 + 15 秒自动轮询（含倒计时，有未保存编辑时暂停） */
  function startWaitViz(stage) {
    var rec = state.rec;
    var entry = entryOf(rec, stage) || {};
    var since = entry.updatedAt || rec.updatedAt || rec.createdAt;
    var elapsedEl = $('#pl-elapsed');
    var barEl = $('#pl-wait-bar');
    var tipEl = $('#pl-poll-tip');

    var p = entry.progress;
    if (barEl && p && Number(p.total) > 0) {
      barEl.hidden = false;
      var bar = $('i', barEl);
      if (bar) bar.style.width = Math.min(100, Math.round(Number(p.written) / Number(p.total) * 100)) + '%';
    }

    function tickElapsed() {
      if (elapsedEl) elapsedEl.textContent = '⏱ 已等待 ' + elapsedText(since);
    }
    if (elapsedEl) { elapsedEl.hidden = false; tickElapsed(); }
    state.waitTimer = setInterval(tickElapsed, 1000);

    var left = POLL_SECS;
    function tip() {
      if (!tipEl) return;
      tipEl.textContent = state.dirty
        ? '检测到未保存的编辑，自动刷新已暂停'
        : '每 ' + POLL_SECS + ' 秒自动刷新，' + left + ' 秒后检查最新进度（也可点上方「刷新状态」）';
    }
    if (tipEl) { tipEl.hidden = false; tip(); }
    state.pollTimer = setInterval(function () {
      if (state.dirty) { left = POLL_SECS; tip(); return; }
      left--;
      if (left <= 0) { loadDetail(state.rec.id); return; }
      tip();
    }, 1000);
  }

  function bindPanel(stage, status) {
    var waitReload = $('#pl-wait-reload');
    if (waitReload) waitReload.addEventListener('click', function () { loadDetail(state.rec.id); });

    if (stage === 'script' && (status === 'pending_review' || status === 'rejected')) {
      renderEpEditor();
      bindEpEditor();
    }
    if (stage === 'assets') {
      if (status === 'awaiting_choice') {
        var g = $('#pl-assets-gen');
        var s = $('#pl-assets-skip');
        if (g) g.addEventListener('click', function () { assetsChoice('generate'); });
        if (s) s.addEventListener('click', function () { assetsChoice('skip'); });
      }
      loadAssetImages();
    }

    if ($('#pl-elapsed')) startWaitViz(stage);
  }

  /* ---------- init ---------- */

  function init() {
    initGate();
    $('#pl-refresh').addEventListener('click', loadList);
    $('#pl-back').addEventListener('click', function () {
      if (state.role === 'editor') { exitToGate(); return; }
      history.replaceState(null, '', location.pathname);
      loadList();
    });

    var panel = $('#pl-stage-panel');
    panel.addEventListener('input', function () {
      var st = stageOfRec(state.rec);
      if (st === 'outline' || st === 'synopsis') state.dirty = true;
      else if (st === 'script') state.epDirty = true;
    });
    panel.addEventListener('click', function (ev) {
      var t = ev.target;
      if (!t || t.nodeType !== 1) return;
      var stage = stageOfRec(state.rec);
      if (t.classList.contains('ol-add-char')) {
        var tb = $('#pl-char-tbody');
        if (tb) { tb.insertAdjacentHTML('beforeend', charRowTpl({})); state.dirty = true; }
      } else if (t.classList.contains('ol-del-char')) {
        var tr = t.closest('tr');
        if (tr) { tr.remove(); state.dirty = true; }
      } else if (t.classList.contains('ol-add-act')) {
        var ac = $('#pl-acts');
        if (ac) { ac.insertAdjacentHTML('beforeend', actCardTpl({})); state.dirty = true; }
      } else if (t.classList.contains('ol-del-act')) {
        var d = t.closest('.ol-act');
        if (d) { d.remove(); state.dirty = true; }
      } else if (t.classList.contains('sy-add-ep')) {
        var sy = $('#pl-sy-tbody');
        if (sy) {
          var next = $$('.sy-row', sy).length + 1;
          sy.insertAdjacentHTML('beforeend', synopsisRow({ ep: next }));
          state.dirty = true;
        }
      } else if (t.classList.contains('pl-btn-req')) {
        var reqStage = t.getAttribute('data-req');
        if (reqStage && !t.disabled) {
          t.disabled = true;
          t.textContent = '已请求，等待生成…';
          requestGenerate(reqStage);
        }
      } else if (t.id === 'pl-save') {
        if (stage === 'outline' || stage === 'synopsis') saveStageEdits(stage, null, t);
      } else if (t.id === 'pl-confirm') {
        confirmStage(stage);
      }
    });
  }

  init();
})();
