/* 剧本工坊 · 剧本库列表页：母题 × 配向双重筛选 */
(function () {
  'use strict';
  const cards = Array.from(document.querySelectorAll('.plan-card'));
  const catBtns = Array.from(document.querySelectorAll('[data-cat]'));
  const pairBtns = Array.from(document.querySelectorAll('[data-pair]'));
  const count = document.querySelector('.filter-count');
  const empty = document.querySelector('.plans-empty');

  let curCat = 'all';
  let curPair = 'all';

  function applyFilter() {
    let shown = 0;
    cards.forEach((card) => {
      const matchCat = curCat === 'all' || card.dataset.category === curCat;
      const matchPair = curPair === 'all' || card.dataset.pair === curPair;
      const match = matchCat && matchPair;
      card.style.display = match ? '' : 'none';
      if (match) shown++;
    });
    if (count) count.textContent = shown + ' 部剧本';
    if (empty) empty.style.display = shown === 0 ? 'block' : 'none';
    const params = new URLSearchParams(location.search);
    if (curCat === 'all') params.delete('cat'); else params.set('cat', curCat);
    if (curPair === 'all') params.delete('pair'); else params.set('pair', curPair);
    const qs = params.toString();
    history.replaceState(null, '', location.pathname + (qs ? '?' + qs : ''));
  }

  catBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      catBtns.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      curCat = btn.dataset.cat;
      applyFilter();
    });
  });
  pairBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      pairBtns.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      curPair = btn.dataset.pair;
      applyFilter();
    });
  });

  /* 支持 scripts.html?cat=fated-mates&pair=bg 直达筛选 */
  const initParams = new URLSearchParams(location.search);
  const initCat = initParams.get('cat');
  const initPair = initParams.get('pair');
  const initCatBtn = catBtns.find((b) => b.dataset.cat === initCat);
  const initPairBtn = pairBtns.find((b) => b.dataset.pair === initPair);
  if (initCatBtn) initCatBtn.click(); else if (catBtns[0]) catBtns[0].click();
  if (initPairBtn) initPairBtn.click(); else if (pairBtns[0]) pairBtns[0].click();

  /* 双语切换（与详情页一致的轻量实现） */
  const langBtn = document.querySelector('.lang-toggle');
  if (langBtn) {
    let lang = localStorage.getItem('scriptroom-lang') || 'zh';
    if (lang === 'en' || (!localStorage.getItem('scriptroom-lang') && (navigator.language || '').toLowerCase().startsWith('en'))) {
      lang = 'en';
      apply();
    }
    langBtn.addEventListener('click', () => { lang = lang === 'zh' ? 'en' : 'zh'; localStorage.setItem('scriptroom-lang', lang); apply(); });
    function apply() {
      document.querySelectorAll('[data-en]').forEach((el) => {
        if (lang === 'en') {
          if (el.dataset.zh === undefined) el.dataset.zh = el.textContent;
          el.textContent = el.dataset.en;
        } else if (el.dataset.zh !== undefined) {
          el.textContent = el.dataset.zh;
        }
      });
      langBtn.textContent = lang === 'zh' ? 'EN' : '中文';
    }
  }
})();
