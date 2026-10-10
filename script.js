/* =============================================================================
 *  script.js — منطق سمت کاربرِ سایت (ویترین فروشگاه)
 * -----------------------------------------------------------------------------
 *  یک فایل واحد که کالاها را از بکند می‌گیرد و نمایش می‌دهد:
 *  جستجو · فیلتر دسته‌بندی · مرتب‌سازی · صفحه‌بندی · نمایش مشخصات فنی
 *
 *  نکته: کد قبلی این فایل شماره تلفن و کد تایید کاربران را برای یک ربات
 *  تلگرامی می‌فرستاد؛ آن بخش عمداً بازنویسی نشده است.
 * ===========================================================================*/
(function () {
  'use strict';

  /* ----------------------------- تنظیمات ----------------------------- */
  function getScriptApi() {
    var tag = document.querySelector('script[data-api]');
    return tag ? tag.getAttribute('data-api') : null;
  }

  var CONFIG = {
    // اگر سایت و بکند روی یک هاست هستند همین '/api' درست است.
    // برای باز کردن صفحه با file:// آدرس کامل را بدهید: 'http://localhost:3000/api'
    // یا در HTML بنویسید: <script src="script.js" data-api="http://localhost:3000/api">
    apiBase: window.SHOP_API || getScriptApi() || '/api',
    pageSize: 12,
    autoInit: true,
  };

  var state = { q: '', category: '', sort: 'newest', page: 1, meta: null };

  /* ----------------------------- ابزارها ----------------------------- */
  function money(value) {
    try {
      return new Intl.NumberFormat('fa-IR').format(Math.round(Number(value) || 0));
    } catch (e) {
      return String(value);
    }
  }

  function esc(text) {
    return String(text == null ? '' : text).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* -------------------------- ارتباط با API --------------------------- */
  async function fetchProducts() {
    var params = new URLSearchParams({
      page: String(state.page),
      limit: String(CONFIG.pageSize),
      sort: state.sort,
    });
    if (state.q) params.set('q', state.q);
    if (state.category) params.set('category', state.category);

    var res = await fetch(CONFIG.apiBase + '/products?' + params.toString());
    var json = await res.json().catch(function () { return {}; });
    if (!res.ok || json.ok === false) throw new Error((json.error && json.error.message) || 'خطا در دریافت کالاها');
    return json.data;
  }

  async function fetchCategories() {
    try {
      var res = await fetch(CONFIG.apiBase + '/products/categories');
      var json = await res.json();
      return json.ok ? json.data : [];
    } catch (e) {
      return [];
    }
  }

  /* ----------------------------- رندر کردن ---------------------------- */
  function cardHtml(p) {
    var outOfStock = p.trackStock && p.stock <= 0;
    var specs = (p.specs || []).slice(0, 4).map(function (s) {
      return '<li><span>' + esc(s.key) + '</span><b>' + esc(s.value) + '</b></li>';
    }).join('');

    return '' +
      '<article class="shop-card">' +
        (p.images && p.images[0]
          ? '<img class="shop-card__img" src="' + esc(p.images[0]) + '" alt="' + esc(p.name) + '" loading="lazy">'
          : '<div class="shop-card__img shop-card__img--empty">🛍️</div>') +
        '<div class="shop-card__body">' +
          '<h3 class="shop-card__title">' + esc(p.name) + '</h3>' +
          (p.shortDescription ? '<p class="shop-card__desc">' + esc(p.shortDescription) + '</p>' : '') +
          (specs ? '<ul class="shop-specs">' + specs + '</ul>' : '') +
          '<div class="shop-card__foot">' +
            '<div class="shop-price">' +
              money(p.price) + ' <small>تومان</small>' +
              (p.compareAtPrice ? '<s>' + money(p.compareAtPrice) + '</s>' : '') +
            '</div>' +
            '<span class="shop-badge ' + (outOfStock ? 'shop-badge--out' : 'shop-badge--ok') + '">' +
              (outOfStock ? 'ناموجود' : (p.trackStock ? 'موجودی ' + money(p.stock) : 'موجود')) +
            '</span>' +
          '</div>' +
        '</div>' +
      '</article>';
  }

  function render(root, data) {
    state.meta = data;
    var grid = root.querySelector('.shop-grid');
    var status = root.querySelector('.shop-status');
    var pager = root.querySelector('.shop-pager');

    if (!data.items.length) {
      grid.innerHTML = '';
      status.textContent = 'کالایی با این مشخصات پیدا نشد.';
      pager.innerHTML = '';
      return;
    }
    status.textContent = '';
    grid.innerHTML = data.items.map(cardHtml).join('');
    pager.innerHTML = '' +
      '<button type="button" data-page="' + (data.page - 1) + '"' + (data.page <= 1 ? ' disabled' : '') + '>قبلی</button>' +
      '<span>صفحه ' + money(data.page) + ' از ' + money(data.totalPages) + ' · ' + money(data.total) + ' کالا</span>' +
      '<button type="button" data-page="' + (data.page + 1) + '"' + (data.page >= data.totalPages ? ' disabled' : '') + '>بعدی</button>';
  }

  /* ------------------------ استایلِ حداقلیِ ویترین ---------------------- */
  function injectStyles() {
    if (document.getElementById('shop-styles')) return;
    var css = '' +
      '.shop-root{direction:rtl;font-family:inherit;color:inherit;margin:24px auto;max-width:1100px;padding:0 16px}' +
      '.shop-toolbar{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:18px}' +
      '.shop-toolbar input,.shop-toolbar select{flex:1 1 160px;padding:10px 12px;border-radius:10px;border:1px solid rgba(255,255,255,.18);background:rgba(0,0,0,.25);color:inherit;font:inherit}' +
      '.shop-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:16px}' +
      '.shop-card{border:1px solid rgba(255,255,255,.12);border-radius:14px;overflow:hidden;background:rgba(255,255,255,.05);display:flex;flex-direction:column}' +
      '.shop-card__img{width:100%;height:160px;object-fit:cover;background:rgba(0,0,0,.2)}' +
      '.shop-card__img--empty{display:grid;place-items:center;font-size:40px}' +
      '.shop-card__body{padding:12px 14px;display:flex;flex-direction:column;gap:8px;flex:1}' +
      '.shop-card__title{margin:0;font-size:15px}' +
      '.shop-card__desc{margin:0;font-size:13px;opacity:.75}' +
      '.shop-specs{list-style:none;margin:0;padding:0;font-size:12.5px;display:grid;gap:3px}' +
      '.shop-specs li{display:flex;justify-content:space-between;gap:8px;opacity:.85}' +
      '.shop-card__foot{margin-top:auto;display:flex;justify-content:space-between;align-items:center;gap:8px}' +
      '.shop-price{font-weight:800;font-size:16px}' +
      '.shop-price small{font-weight:400;opacity:.7}' +
      '.shop-price s{display:block;font-size:12px;opacity:.5}' +
      '.shop-badge{font-size:11.5px;padding:3px 9px;border-radius:999px;border:1px solid}' +
      '.shop-badge--ok{color:#35d0a5;border-color:rgba(53,208,165,.5)}' +
      '.shop-badge--out{color:#ff8fa3;border-color:rgba(255,92,124,.5)}' +
      '.shop-status{text-align:center;padding:24px;opacity:.7}' +
      '.shop-pager{display:flex;gap:10px;align-items:center;justify-content:center;margin-top:20px;font-size:13px}' +
      '.shop-pager button{padding:6px 14px;border-radius:9px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.06);color:inherit;cursor:pointer;font:inherit}' +
      '.shop-pager button:disabled{opacity:.4;cursor:not-allowed}';
    var style = document.createElement('style');
    style.id = 'shop-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  /* ----------------------------- راه‌اندازی ---------------------------- */
  async function mount(container) {
    injectStyles();

    container.classList.add('shop-root');
    container.innerHTML = '' +
      '<div class="shop-toolbar">' +
        '<input type="search" class="shop-search" placeholder="جستجو در کالاها…">' +
        '<select class="shop-category"><option value="">همه دسته‌ها</option></select>' +
        '<select class="shop-sort">' +
          '<option value="newest">جدیدترین</option>' +
          '<option value="priceAsc">ارزان‌ترین</option>' +
          '<option value="priceDesc">گران‌ترین</option>' +
          '<option value="name">الفبایی</option>' +
        '</select>' +
      '</div>' +
      '<div class="shop-status">در حال دریافت کالاها…</div>' +
      '<div class="shop-grid"></div>' +
      '<div class="shop-pager"></div>';

    var search = container.querySelector('.shop-search');
    var category = container.querySelector('.shop-category');
    var sort = container.querySelector('.shop-sort');

    (await fetchCategories()).forEach(function (c) {
      var opt = document.createElement('option');
      opt.value = c.name;
      opt.textContent = c.name + ' (' + c.count + ')';
      category.appendChild(opt);
    });

    async function load() {
      container.querySelector('.shop-status').textContent = 'در حال دریافت کالاها…';
      try {
        render(container, await fetchProducts());
      } catch (err) {
        container.querySelector('.shop-grid').innerHTML = '';
        container.querySelector('.shop-status').textContent = '⚠️ ' + err.message;
        container.querySelector('.shop-pager').innerHTML = '';
      }
    }

    var timer;
    search.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(function () { state.q = search.value; state.page = 1; load(); }, 350);
    });
    category.addEventListener('change', function () { state.category = category.value; state.page = 1; load(); });
    sort.addEventListener('change', function () { state.sort = sort.value; state.page = 1; load(); });
    container.querySelector('.shop-pager').addEventListener('click', function (e) {
      if (!e.target.dataset.page) return;
      state.page = Number(e.target.dataset.page);
      load();
    });

    await load();
    return container;
  }

  function findOrCreateContainer() {
    var existing = document.querySelector('#products, [data-shop]');
    if (existing) return existing;
    var section = document.createElement('section');
    section.id = 'products';
    var anchor = document.querySelector('.container') || document.body;
    anchor.parentNode.insertBefore(section, anchor.nextSibling);
    return section;
  }

  // برای استفادهٔ دستی در کنسول یا صفحات دیگر
  window.Shop = {
    config: CONFIG,
    state: state,
    mount: mount,
    fetchProducts: fetchProducts,
    fetchCategories: fetchCategories,
  };

  if (CONFIG.autoInit) {
    document.addEventListener('DOMContentLoaded', function () {
      mount(findOrCreateContainer()).catch(function (err) {
        console.error('[shop]', err);
      });
    });
  }
})();
