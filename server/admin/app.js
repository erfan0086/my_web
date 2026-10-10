/* =========================================================
 * پنل مدیریت فروشگاه — منطق سمت کلاینت (جاوااسکریپت خالی)
 * =======================================================*/
'use strict';

const TOKEN_KEY = 'shop_admin_token';
const LIMIT = 15;

const state = {
  token: localStorage.getItem(TOKEN_KEY) || '',
  user: null,
  view: 'dashboard',
  rates: {},
  rules: null,
  baseCurrency: 'IRR',
  categories: [],
  products: { items: [], page: 1, total: 0, totalPages: 1 },
  selected: new Set(),
  editingId: null,
};

/* ---------------- ابزارها ---------------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function money(value) {
  const n = Number(value || 0);
  return new Intl.NumberFormat('fa-IR').format(Math.round(n));
}
function num(value) {
  return new Intl.NumberFormat('fa-IR').format(Number(value || 0));
}
function dateTime(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('fa-IR', { dateStyle: 'medium', timeStyle: 'short' });
  } catch (_) {
    return iso;
  }
}
function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function toast(message, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

/* ---------------- ارتباط با API ---------------- */
async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload = {};
  try { payload = await res.json(); } catch (_) { /* ignore */ }

  if (res.status === 401) {
    state.token = '';
    localStorage.removeItem(TOKEN_KEY);
    showLogin();
    throw new Error('نشست شما منقضی شده است');
  }
  if (!res.ok || payload.ok === false) {
    const msg = payload?.error?.message || `خطا در ارتباط با سرور (${res.status})`;
    const err = new Error(msg);
    err.details = payload?.error?.details;
    throw err;
  }
  return payload.data;
}

/* ---------------- ورود / خروج ---------------- */
function showLogin() {
  $('#loginView').classList.remove('hidden');
  $('#appView').classList.add('hidden');
}
async function showApp() {
  $('#loginView').classList.add('hidden');
  $('#appView').classList.remove('hidden');
  await refreshAll();
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('#loginEmail').value.trim();
  const password = $('#loginPassword').value;
  const btn = $('#loginBtn');
  btn.disabled = true;
  btn.textContent = 'در حال ورود…';
  $('#loginError').textContent = '';
  try {
    const data = await api('/api/auth/login', { method: 'POST', body: { email, password } });
    state.token = data.token;
    state.user = data.user;
    localStorage.setItem(TOKEN_KEY, data.token);
    applyUser();
    await showApp();
  } catch (err) {
    $('#loginError').textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'ورود';
  }
});

$('#logoutBtn').addEventListener('click', () => {
  state.token = '';
  state.user = null;
  localStorage.removeItem(TOKEN_KEY);
  showLogin();
});

function applyUser() {
  const u = state.user || {};
  $('#meName').textContent = u.name || '—';
  $('#meRole').textContent = u.role === 'admin' ? 'مدیر ارشد' : 'ویرایشگر';
  $('#meAvatar').textContent = (u.name || 'ک').trim().charAt(0);
  const isAdmin = u.role === 'admin';
  $$('.admin-only').forEach((el) => el.classList.toggle('hidden', !isAdmin));
}

/* ---------------- ناوبری ---------------- */
const TITLES = {
  dashboard: ['داشبورد', 'خلاصه وضعیت فروشگاه'],
  products: ['کالاها', 'مدیریت، افزودن و ویرایش کالاها'],
  pricing: ['قیمت‌گذاری خودکار', 'قوانین، نرخ ارز و بروزرسانی خودکار قیمت‌ها'],
  history: ['تاریخچه قیمت', 'گزارش تغییرات قیمت کالاها'],
  users: ['کاربران', 'مدیریت دسترسی ادمین‌ها'],
};

$$('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});

async function switchView(view) {
  state.view = view;
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $$('.view').forEach((v) => v.classList.add('hidden'));
  $(`#view-${view}`).classList.remove('hidden');
  const [title, sub] = TITLES[view] || ['', ''];
  $('#viewTitle').textContent = title;
  $('#viewSubtitle').textContent = sub;
  $('#newProductTop').classList.toggle('hidden', view === 'products');
  await loadView(view);
}

async function loadView(view) {
  try {
    if (view === 'dashboard') await renderDashboard();
    if (view === 'products') await loadProducts();
    if (view === 'pricing') await renderPricing();
    if (view === 'history') await renderHistory();
    if (view === 'users') await renderUsers();
  } catch (err) {
    toast(err.message, 'error');
  }
}

$('#refreshBtn').addEventListener('click', async () => {
  await refreshAll();
  toast('بروزرسانی انجام شد', 'success');
});

async function refreshAll() {
  await Promise.all([loadSettings(), loadCategories()]);
  await loadView(state.view);
}

async function loadSettings() {
  const data = await api('/api/pricing/settings');
  state.rates = data.rates || {};
  state.rules = data.rules;
  state.baseCurrency = data.baseCurrency;
  return data;
}

async function loadCategories() {
  const cats = await api('/api/products/categories');
  state.categories = cats.map((c) => c.name);
  const list = $('#categoryList');
  list.innerHTML = state.categories.map((c) => `<option value="${esc(c)}"></option>`).join('');
  const sel = $('#pCategory');
  const current = sel.value;
  sel.innerHTML =
    '<option value="">همه دسته‌ها</option>' +
    state.categories.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  sel.value = current;
}

/* ---------------- داشبورد ---------------- */
async function renderDashboard() {
  const s = await api('/api/products/stats');
  const cards = [
    ['کل کالاها', s.total, `${s.active} منتشرشده · ${s.draft} پیش‌نویس`],
    ['منتشرشده', s.active, `${s.archived} بایگانی‌شده`],
    ['رو به اتمام', s.lowStock, `آستانه موجودی`],
    ['ناموجود', s.outOfStock, 'موجودی صفر'],
    ['قیمت‌گذاری خودکار', s.autoPriced, `${s.manualPriced} دستی`],
    ['دسته‌بندی‌ها', s.categories, 'تعداد دسته‌ها'],
  ];
  $('#statsGrid').innerHTML = cards
    .map(
      ([label, value, hint]) => `
      <div class="stat">
        <div class="label">${esc(label)}</div>
        <div class="value">${num(value)}</div>
        <div class="hint">${esc(hint)}</div>
      </div>`
    )
    .join('');

  const hist = s.lastPriceChanges || [];
  $('#dashHistory').innerHTML = hist.length
    ? `<thead><tr><th>کالا</th><th>از</th><th>به</th><th>تغییر</th></tr></thead><tbody>${hist
        .map(
          (h) => `<tr>
            <td>${esc(h.productName)}</td>
            <td>${money(h.oldPrice)}</td>
            <td>${money(h.newPrice)}</td>
            <td class="${h.delta > 0 ? 'up' : 'down'}">${h.delta > 0 ? '▲' : '▼'} ${money(Math.abs(h.delta))}</td>
          </tr>`
        )
        .join('')}</tbody>`
    : '<tbody><tr><td class="empty">هنوز تغییر قیمتی ثبت نشده است</td></tr></tbody>';

  const run = s.lastPriceRun;
  $('#dashRun').innerHTML = run
    ? `آخرین اجرا: <strong>${esc(dateTime(run.at))}</strong><br />
       دلیل: ${esc(run.reason)} · بررسی‌شده: ${num(run.scanned)} · تغییر یافته: <strong>${num(run.changed)}</strong>`
    : 'هنوز اجرایی ثبت نشده است.';

  const low = await api('/api/products?lowStock=1&limit=8&sort=stockAsc');
  $('#dashLowStock').innerHTML = low.items.length
    ? `<thead><tr><th>کالا</th><th>موجودی</th><th>آستانه</th></tr></thead><tbody>${low.items
        .map(
          (p) => `<tr><td>${esc(p.name)}</td><td>${num(p.stock)}</td><td>${num(p.lowStockThreshold)}</td></tr>`
        )
        .join('')}</tbody>`
    : '<tbody><tr><td class="empty">همه چیز در موجودی مناسب است ✅</td></tr></tbody>';
}

/* ---------------- کالاها ---------------- */
function productQuery() {
  const params = new URLSearchParams({
    page: String(state.products.page),
    limit: String(LIMIT),
    sort: $('#pSort').value || 'newest',
  });
  const q = $('#pSearch').value.trim();
  if (q) params.set('q', q);
  const status = $('#pStatus').value;
  if (status) params.set('status', status);
  const category = $('#pCategory').value;
  if (category) params.set('category', category);
  return params.toString();
}

async function loadProducts() {
  const data = await api(`/api/products?${productQuery()}`);
  state.products = { items: data.items, page: data.page, total: data.total, totalPages: data.totalPages };
  state.selected.clear();
  updateSelectionBar();
  renderProductsTable();
  renderPager();
}

function renderProductsTable() {
  const rows = state.products.items;
  const body = $('#productsBody');
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="7" class="empty">کالایی یافت نشد</td></tr>';
    return;
  }
  body.innerHTML = rows
    .map((p) => {
      const stockClass = !p.trackStock ? '' : p.stock <= 0 ? 'up' : p.stock <= (p.lowStockThreshold || 0) ? 'down' : '';
      return `<tr data-id="${p.id}">
        <td><input type="checkbox" class="row-check" data-id="${p.id}" ${state.selected.has(p.id) ? 'checked' : ''} /></td>
        <td>
          <div class="pname">${esc(p.name)} ${p.featured ? '⭐' : ''}</div>
          <div class="psku">${esc(p.sku || p.slug || '')}</div>
        </td>
        <td>${esc(p.category || '—')}</td>
        <td class="nowrap">
          ${money(p.price)} <span class="psku">${esc(state.baseCurrency)}</span>
          <span class="badge badge-${p.pricingMode === 'auto' ? 'auto' : 'manual'}">${p.pricingMode === 'auto' ? 'خودکار' : 'دستی'}</span>
          ${p.compareAtPrice ? `<div class="psku"><s>${money(p.compareAtPrice)}</s></div>` : ''}
        </td>
        <td class="${stockClass}">${p.trackStock ? num(p.stock) : 'نامحدود'}</td>
        <td><span class="badge badge-${p.status}">${
          { active: 'منتشرشده', draft: 'پیش‌نویس', archived: 'بایگانی' }[p.status] || p.status
        }</span></td>
        <td class="nowrap">
          <button class="btn btn-sm" data-edit="${p.id}">ویرایش</button>
          <button class="btn btn-sm btn-danger admin-only" data-del="${p.id}">حذف</button>
        </td>
      </tr>`;
    })
    .join('');

  $$('#productsBody .row-check').forEach((cb) => {
    cb.addEventListener('change', () => {
      if (cb.checked) state.selected.add(cb.dataset.id);
      else state.selected.delete(cb.dataset.id);
      updateSelectionBar();
    });
  });
  $$('#productsBody [data-edit]').forEach((b) => b.addEventListener('click', () => openProduct(b.dataset.edit)));
  $$('#productsBody [data-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm('این کالا حذف شود؟')) return;
      try {
        await api(`/api/products/${b.dataset.del}`, { method: 'DELETE' });
        toast('کالا حذف شد', 'success');
        await loadProducts();
      } catch (err) {
        toast(err.message, 'error');
      }
    })
  );
  $$('.admin-only').forEach((el) => el.classList.toggle('hidden', state.user?.role !== 'admin'));
}

function renderPager() {
  const { page, totalPages, total } = state.products;
  let html = `<span class="muted sm">${num(total)} کالا · صفحه ${num(page)} از ${num(totalPages)}</span>`;
  html += `<button class="btn btn-sm" ${page <= 1 ? 'disabled' : ''} data-page="${page - 1}">قبلی</button>`;
  html += `<button class="btn btn-sm" ${page >= totalPages ? 'disabled' : ''} data-page="${page + 1}">بعدی</button>`;
  $('#pager').innerHTML = html;
  $$('#pager [data-page]').forEach((b) =>
    b.addEventListener('click', () => {
      state.products.page = Number(b.dataset.page);
      loadProducts().catch((e) => toast(e.message, 'error'));
    })
  );
}

function updateSelectionBar() {
  const n = state.selected.size;
  $('#selectedCount').textContent = n ? `${num(n)} مورد انتخاب شده` : 'هیچ موردی انتخاب نشده';
}

$('#selectAll').addEventListener('change', (e) => {
  const checked = e.target.checked;
  $$('#productsBody .row-check').forEach((cb) => {
    cb.checked = checked;
    if (checked) state.selected.add(cb.dataset.id);
    else state.selected.delete(cb.dataset.id);
  });
  updateSelectionBar();
});

['#pSearch', '#pStatus', '#pCategory', '#pSort'].forEach((sel) => {
  $(sel).addEventListener('input', debounce(() => {
    state.products.page = 1;
    loadProducts().catch((e) => toast(e.message, 'error'));
  }, 350));
});

$$('[data-bulk]').forEach((btn) =>
  btn.addEventListener('click', async () => {
    const ids = [...state.selected];
    if (!ids.length) return toast('ابتدا حداقل یک کالا را انتخاب کنید', 'error');
    const action = btn.dataset.bulk;
    if (action === 'delete' && !confirm(`${ids.length} کالا حذف شود؟`)) return;
    try {
      const res = await api('/api/products/bulk', { method: 'POST', body: { ids, action } });
      toast(`انجام شد: ${num(res.affected || res.deleted || res.repriced || 0)} مورد`, 'success');
      await loadProducts();
    } catch (err) {
      toast(err.message, 'error');
    }
  })
);

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/* ---------------- مودال کالا ---------------- */
$('#newProductBtn').addEventListener('click', () => openProduct(null));
$('#newProductTop').addEventListener('click', () => openProduct(null));
$('#closeModal').addEventListener('click', closeModal);
$('#cancelModal').addEventListener('click', closeModal);
$('#productModal').addEventListener('click', (e) => {
  if (e.target.id === 'productModal') closeModal();
});

function closeModal() {
  $('#productModal').classList.add('hidden');
  state.editingId = null;
}

$$('.tab').forEach((tab) =>
  tab.addEventListener('click', () => {
    $$('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    $$('.tab-pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === tab.dataset.tab));
  })
);

function costCurrencyOptions() {
  const codes = Object.keys(state.rates).filter((c) => c !== state.baseCurrency);
  const all = [state.baseCurrency, ...codes.filter((c) => c !== state.baseCurrency)];
  return [...new Set(all)]
    .map((c) => `<option value="${c}">${c}</option>`)
    .join('');
}

function fillProductForm(p) {
  $('#modalTitle').textContent = p ? `ویرایش: ${p.name}` : 'کالای جدید';
  $('#fName').value = p?.name || '';
  $('#fSku').value = p?.sku || '';
  $('#fCategory').value = p?.category || '';
  $('#fBrand').value = p?.brand || '';
  $('#fStatus').value = p?.status || 'active';
  $('#fShort').value = p?.shortDescription || '';
  $('#fDesc').value = p?.description || '';
  $('#fTags').value = (p?.tags || []).join('، ');
  $('#fFeatured').checked = Boolean(p?.featured);

  $('#fPricingMode').value = p?.pricingMode || 'auto';
  $('#fCostCurrency').innerHTML = costCurrencyOptions();
  $('#fCostCurrency').value = p?.cost?.currency || state.baseCurrency;
  $('#fCost').value = p?.cost?.amount ?? 0;
  $('#fMargin').value = p?.marginPercent ?? '';
  $('#fManualPrice').value = p?.manualPrice ?? p?.price ?? '';
  $('#fCompareAt').value = p?.compareAtPrice ?? '';
  $('#fStock').value = p?.stock ?? 0;
  $('#fLowStock').value = p?.lowStockThreshold ?? 0;
  $('#fTrackStock').checked = p?.trackStock !== false;

  $('#fSeoTitle').value = p?.seo?.title || '';
  $('#fSeoDesc').value = p?.seo?.description || '';

  renderSpecs(p?.specs || []);
  renderImages(p?.images || []);
  togglePricingFields();
  updateEstimate();
}

function togglePricingFields() {
  const manual = $('#fPricingMode').value === 'manual';
  $$('.auto-only').forEach((el) => el.classList.toggle('hidden', manual));
  $$('.manual-only').forEach((el) => el.classList.toggle('hidden', !manual));
}
$('#fPricingMode').addEventListener('change', () => {
  togglePricingFields();
  updateEstimate();
});

function renderSpecs(specs) {
  const wrap = $('#specsList');
  wrap.innerHTML = '';
  if (!specs.length) specs = [{ key: '', value: '' }];
  specs.forEach((spec) => addSpecRow(spec.key, spec.value));
}
function addSpecRow(key = '', value = '') {
  const row = document.createElement('div');
  row.className = 'spec-row';
  row.innerHTML = `
    <input type="text" class="input spec-key" placeholder="نام مشخصه (مثلاً رنگ)" value="${esc(key)}" />
    <input type="text" class="input spec-value" placeholder="مقدار (مثلاً مشکی)" value="${esc(value)}" />
    <button type="button" class="btn btn-sm btn-danger spec-del">حذف</button>`;
  row.querySelector('.spec-del').addEventListener('click', () => {
    row.remove();
    if (!$('#specsList').children.length) addSpecRow();
  });
  $('#specsList').appendChild(row);
}
$('#addSpecBtn').addEventListener('click', () => addSpecRow());

function renderImages(images) {
  const wrap = $('#imagesList');
  wrap.innerHTML = '';
  if (!images.length) images = [''];
  images.forEach((url) => addImageRow(url));
}
function addImageRow(url = '') {
  const row = document.createElement('div');
  row.className = 'img-row';
  row.innerHTML = `
    <input type="url" class="input img-url" placeholder="https://…" value="${esc(url)}" />
    <button type="button" class="btn btn-sm btn-danger img-del">حذف</button>`;
  row.querySelector('.img-del').addEventListener('click', () => {
    row.remove();
    if (!$('#imagesList').children.length) addImageRow();
  });
  $('#imagesList').appendChild(row);
}
$('#addImageBtn').addEventListener('click', () => addImageRow());

function updateEstimate() {
  const box = $('#priceCalc');
  const mode = $('#fPricingMode').value;
  if (mode === 'manual') {
    box.textContent = `قیمت ثبت‌شده: ${money($('#fManualPrice').value || 0)} ${state.baseCurrency} (قوانین اعمال نمی‌شود)`;
    return;
  }
  const rate = Number(state.rates[$('#fCostCurrency').value] ?? 1);
  const cost = Number($('#fCost').value || 0);
  const marginRaw = $('#fMargin').value;
  const margin = marginRaw === '' ? Number(state.rules?.defaultMarginPercent || 0) : Number(marginRaw);
  const tax = Number(state.rules?.taxPercent || 0);
  const costBase = cost * rate;
  let price = costBase * (1 + margin / 100) * (1 + tax / 100);
  const minProfit = Number(state.rules?.minProfitAmount || 0);
  if (minProfit > 0) price = Math.max(price, costBase + minProfit);
  const to = Number(state.rules?.rounding?.to || 0);
  if (to > 0) {
    const m = state.rules?.rounding?.mode || 'nearest';
    const d = price / to;
    price = (m === 'up' ? Math.ceil(d) : m === 'down' ? Math.floor(d) : Math.round(d)) * to;
  } else {
    price = Math.round(price);
  }
  box.textContent =
    `قیمت خرید: ${money(cost)} ${$('#fCostCurrency').value} × نرخ ${money(rate)}\n` +
    `سود ${margin}% + مالیات ${tax}%  ⇒  قیمت نهایی: ${money(price)} ${state.baseCurrency}`;
}
['#fCost', '#fMargin', '#fCostCurrency'].forEach((sel) =>
  $(sel).addEventListener('input', updateEstimate)
);

async function openProduct(id) {
  state.editingId = id || null;
  let product = null;
  if (id) {
    try {
      product = await api(`/api/products/${id}`);
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
  }
  fillProductForm(product);
  $('#productModal').classList.remove('hidden');
}

function collectForm() {
  const specs = $$('#specsList .spec-row')
    .map((row) => ({
      key: row.querySelector('.spec-key').value.trim(),
      value: row.querySelector('.spec-value').value.trim(),
    }))
    .filter((s) => s.key && s.value);

  const images = $$('#imagesList .img-url')
    .map((i) => i.value.trim())
    .filter(Boolean);

  const marginRaw = $('#fMargin').value;
  const compareRaw = $('#fCompareAt').value;

  return {
    name: $('#fName').value.trim(),
    sku: $('#fSku').value.trim() || null,
    category: $('#fCategory').value.trim() || null,
    brand: $('#fBrand').value.trim() || null,
    status: $('#fStatus').value,
    shortDescription: $('#fShort').value.trim() || null,
    description: $('#fDesc').value.trim() || null,
    tags: $('#fTags').value.split(/[،,]/).map((t) => t.trim()).filter(Boolean),
    featured: $('#fFeatured').checked,
    pricingMode: $('#fPricingMode').value,
    cost: { amount: Number($('#fCost').value || 0), currency: $('#fCostCurrency').value },
    marginPercent: marginRaw === '' ? null : Number(marginRaw),
    manualPrice:
      $('#fPricingMode').value === 'manual' ? Number($('#fManualPrice').value || 0) : null,
    compareAtPrice: compareRaw === '' ? null : Number(compareRaw),
    stock: Number($('#fStock').value || 0),
    trackStock: $('#fTrackStock').checked,
    lowStockThreshold: Number($('#fLowStock').value || 0),
    specs,
    images,
    seo: { title: $('#fSeoTitle').value.trim() || null, description: $('#fSeoDesc').value.trim() || null },
  };
}

// جلوگیری از ارسال واقعی فرم هنگام زدن Enter (جلوگیری از ریلود صفحه)
$('#productForm').addEventListener('submit', (e) => {
  e.preventDefault();
  $('#saveProductBtn').click();
});

$('#saveProductBtn').addEventListener('click', async () => {
  const form = $('#productForm');
  if (!form.reportValidity()) return;
  const payload = collectForm();
  const btn = $('#saveProductBtn');
  btn.disabled = true;
  try {
    if (state.editingId) {
      await api(`/api/products/${state.editingId}`, { method: 'PATCH', body: payload });
      toast('کالا بروزرسانی شد', 'success');
    } else {
      await api('/api/products', { method: 'POST', body: payload });
      toast('کالا ایجاد شد', 'success');
    }
    closeModal();
    await Promise.all([loadProducts(), loadCategories()]);
  } catch (err) {
    const detail = err.details?.[0];
    toast(detail ? `${detail.field}: ${detail.message}` : err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

/* ---------------- قیمت‌گذاری ---------------- */
async function renderPricing() {
  const settings = await loadSettings();
  const r = settings.rules;
  $('#rMargin').value = r.defaultMarginPercent;
  $('#rTax').value = r.taxPercent;
  $('#rMinProfit').value = r.minProfitAmount;
  $('#rRoundMode').value = r.rounding.mode;
  $('#rRoundTo').value = r.rounding.to;
  $('#baseCurrency').textContent = settings.baseCurrency;
  renderRates(settings.rates, settings.baseCurrency);
  await renderPreview();
}

function renderRates(rates, base) {
  const wrap = $('#ratesList');
  wrap.innerHTML = Object.entries(rates)
    .sort(([a], [b]) => (a === base ? -1 : b === base ? 1 : a.localeCompare(b)))
    .map(
      ([code, value]) => `
      <div class="rate-row">
        <span class="rate-code">${esc(code)}</span>
        <input type="number" class="input rate-value" data-code="${esc(code)}" value="${value}" ${
        code === base ? 'disabled' : ''
      } />
        ${code === base ? '<span class="muted sm">ارز پایه</span>' : `<button class="btn btn-sm btn-danger" data-remove-rate="${esc(code)}">حذف</button>`}
      </div>`
    )
    .join('');

  $$('[data-remove-rate]').forEach((btn) =>
    btn.addEventListener('click', () => {
      delete state.rates[btn.dataset.removeRate];
      renderRates(state.rates, state.baseCurrency);
    })
  );
  $$('.rate-value').forEach((inp) =>
    inp.addEventListener('input', () => { state.rates[inp.dataset.code] = Number(inp.value); })
  );
}

$('#addRateBtn').addEventListener('click', () => {
  const code = $('#newRateCode').value.trim().toUpperCase();
  const value = Number($('#newRateValue').value);
  if (!/^[A-Z]{3}$/.test(code)) return toast('کد ارز باید ۳ حرف لاتین باشد (مثل USD)', 'error');
  if (!Number.isFinite(value) || value <= 0) return toast('نرخ باید عددی مثبت باشد', 'error');
  state.rates[code] = value;
  $('#newRateCode').value = '';
  $('#newRateValue').value = '';
  renderRates(state.rates, state.baseCurrency);
  toast(`ارز ${code} افزوده شد (برای اعمال، ذخیره کنید)`, 'info');
});

$('#saveRatesBtn').addEventListener('click', async () => {
  const btn = $('#saveRatesBtn');
  btn.disabled = true;
  try {
    const data = await api('/api/pricing/rates', { method: 'PUT', body: { rates: state.rates } });
    $('#rateResult').textContent =
      `✅ نرخ‌ها ذخیره شد.\nبررسی: ${num(data.run.scanned)} کالا · تغییر قیمت: ${num(data.changedCount)} کالا`;
    toast(`${num(data.changedCount)} قیمت بروزرسانی شد`, 'success');
    await renderPricing();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

$('#rulesForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#saveRulesBtn');
  btn.disabled = true;
  try {
    const data = await api('/api/pricing/rules', {
      method: 'PATCH',
      body: {
        defaultMarginPercent: Number($('#rMargin').value),
        taxPercent: Number($('#rTax').value),
        minProfitAmount: Number($('#rMinProfit').value),
        rounding: { mode: $('#rRoundMode').value, to: Number($('#rRoundTo').value) },
      },
    });
    toast(`قوانین ذخیره شد — ${num(data.changedCount)} قیمت تغییر کرد`, 'success');
    $('#rateResult').textContent = `قوانین جدید اعمال شد. تعداد تغییرات: ${num(data.changedCount)}`;
    await renderPricing();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

$('#recalcBtn').addEventListener('click', async () => {
  try {
    const data = await api('/api/pricing/recalculate', { method: 'POST', body: { reason: 'panel' } });
    toast(`${num(data.changedCount)} قیمت بروزرسانی شد`, 'success');
    $('#rateResult').textContent = `اجرا شد: بررسی ${num(data.run.scanned)} · تغییر ${num(data.changedCount)}`;
    await renderPreview();
  } catch (err) {
    toast(err.message, 'error');
  }
});

$('#previewBtn').addEventListener('click', () => renderPreview().catch((e) => toast(e.message, 'error')));

async function renderPreview() {
  const data = await api('/api/pricing/preview');
  const rows = data.rows;
  $('#previewBody').innerHTML = rows.length
    ? rows
        .map((row) => {
          if (row.error) {
            return `<tr><td>${esc(row.name)}</td><td colspan="5" class="up">${esc(row.error)}</td></tr>`;
          }
          const delta = row.newPrice - row.oldPrice;
          const b = row.breakdown;
          return `<tr>
            <td>${esc(row.name)}</td>
            <td><span class="badge badge-${row.mode === 'auto' ? 'auto' : 'manual'}">${row.mode === 'auto' ? 'خودکار' : 'دستی'}</span></td>
            <td>${money(row.oldPrice)}</td>
            <td><strong>${money(row.newPrice)}</strong></td>
            <td class="${delta > 0 ? 'up' : delta < 0 ? 'down' : ''}">${
              delta === 0 ? '—' : `${delta > 0 ? '▲' : '▼'} ${money(Math.abs(delta))}`
            }</td>
            <td class="psku">${
              b ? `خرید ${money(b.costAmount)} ${esc(b.costCurrency)} × ${money(b.rate)} + ${b.marginPercent}% + ${b.taxPercent}%` : '—'
            }</td>
          </tr>`;
        })
        .join('')
    : '<tr><td colspan="6" class="empty">کالایی برای نمایش وجود ندارد</td></tr>';
}

/* ---------------- تاریخچه ---------------- */
async function renderHistory() {
  const limit = Number($('#historyLimit').value) || 100;
  const rows = await api(`/api/pricing/history?limit=${limit}`);
  $('#historyBody').innerHTML = rows.length
    ? rows
        .map(
          (h) => `<tr>
            <td class="psku">${esc(dateTime(h.at))}</td>
            <td>${esc(h.productName)}</td>
            <td>${money(h.oldPrice)}</td>
            <td>${money(h.newPrice)}</td>
            <td class="${h.delta > 0 ? 'up' : 'down'}">${h.delta > 0 ? '▲' : '▼'} ${money(Math.abs(h.delta))} (${
              h.deltaPercent ?? '—'
            }%)</td>
            <td class="psku">${esc(h.reason)}${h.actor ? ` · ${esc(h.actor)}` : ''}</td>
          </tr>`
        )
        .join('')
    : '<tr><td colspan="6" class="empty">تغییری ثبت نشده است</td></tr>';
}
$('#historyLimit').addEventListener('change', () => renderHistory().catch((e) => toast(e.message, 'error')));

/* ---------------- کاربران ---------------- */
async function renderUsers() {
  if (state.user?.role !== 'admin') return;
  const users = await api('/api/admins');
  $('#usersBody').innerHTML = users
    .map(
      (u) => `<tr>
        <td>${esc(u.name)}</td>
        <td class="psku">${esc(u.email)}</td>
        <td>${u.role === 'admin' ? 'مدیر ارشد' : 'ویرایشگر'}</td>
        <td>${u.isActive ? '<span class="badge badge-active">فعال</span>' : '<span class="badge badge-archived">غیرفعال</span>'}</td>
        <td class="nowrap">
          <button class="btn btn-sm" data-toggle="${u.id}" data-active="${u.isActive}">${
            u.isActive ? 'غیرفعال کردن' : 'فعال کردن'
          }</button>
          <button class="btn btn-sm btn-danger" data-deluser="${u.id}">حذف</button>
        </td>
      </tr>`
    )
    .join('');

  $$('[data-toggle]').forEach((b) =>
    b.addEventListener('click', async () => {
      try {
        await api(`/api/admins/${b.dataset.toggle}`, {
          method: 'PATCH',
          body: { isActive: b.dataset.active !== 'true' },
        });
        toast('وضعیت کاربر تغییر کرد', 'success');
        await renderUsers();
      } catch (err) {
        toast(err.message, 'error');
      }
    })
  );
  $$('[data-deluser]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm('این کاربر حذف شود؟')) return;
      try {
        await api(`/api/admins/${b.dataset.deluser}`, { method: 'DELETE' });
        toast('کاربر حذف شد', 'success');
        await renderUsers();
      } catch (err) {
        toast(err.message, 'error');
      }
    })
  );
}

$('#userForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/admins', {
      method: 'POST',
      body: {
        name: $('#uName').value.trim(),
        email: $('#uEmail').value.trim(),
        password: $('#uPassword').value,
        role: $('#uRole').value,
      },
    });
    $('#userForm').reset();
    toast('کاربر جدید ساخته شد', 'success');
    await renderUsers();
  } catch (err) {
    toast(err.message, 'error');
  }
});

/* ---------------- شروع ---------------- */
(async function init() {
  if (!state.token) return showLogin();
  try {
    const me = await api('/api/auth/me');
    state.user = me.user;
    applyUser();
    await showApp();
    await switchView('dashboard');
  } catch (err) {
    showLogin();
  }
})();
