/* =============================================================================
 *  server.js — بکند کامل فروشگاه در یک فایل
 * -----------------------------------------------------------------------------
 *  بدون هیچ وابستگی خارجی (فقط ماژول‌های داخلی Node 18+)
 *
 *  اجرا:     node server.js
 *  سایت:     http://localhost:3000/
 *  پنل:      http://localhost:3000/admin
 *  داده:     data/db.json
 *
 *  دستورات:
 *    node server.js --seed
 *    node server.js --create-admin "نام" email@site.com رمزعبور [admin|editor]
 *
 *  متغیرهای محیطی (همه اختیاری):
 *    PORT=3000                     DATA_DIR=./data
 *    JWT_SECRET=...                JWT_EXPIRES_IN=7d
 *    PRICE_INTERVAL_MINUTES=30     RATE_SOURCE_URL=...
 *    PRICE_WEBHOOK_TOKEN=...       ADMIN_IP_ALLOWLIST=1.2.3.4,5.6.7.8
 *    NODE_ENV=production
 * ===========================================================================*/
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

/* ============================== ۱. تنظیمات ============================== */

const ROOT = __dirname;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const DB_FILE = path.join(DATA_DIR, 'db.json');
const ADMIN_DIR = path.join(ROOT, 'admin');
const SITE_FILES = ['index.html', 'style.css', 'script.js', 'favicon.ico'];

let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  JWT_SECRET = crypto.randomBytes(48).toString('hex');
  console.warn('⚠️  JWT_SECRET تنظیم نشده — یک کلید موقت ساخته شد (برای production حتماً مقداردهی کنید).');
}

function parseDuration(input) {
  const m = /^(\d+)\s*([smhd])$/.exec(String(input || '7d').trim());
  if (!m) return 7 * 24 * 3600;
  return Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[m[2]];
}

const CONFIG = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 3000),
  jwt: { secret: JWT_SECRET, ttl: parseDuration(process.env.JWT_EXPIRES_IN) },
  priceIntervalMinutes: Number(process.env.PRICE_INTERVAL_MINUTES || 30),
  rateSourceUrl: process.env.RATE_SOURCE_URL || '',
  webhookToken: process.env.PRICE_WEBHOOK_TOKEN || '',
  ipAllowlist: (process.env.ADMIN_IP_ALLOWLIST || '').split(',').map((s) => s.trim()).filter(Boolean),
};
const isTest = CONFIG.env === 'test';

/* ============================ ۲. لایه داده ============================== */

const DEFAULT_DATA = () => ({
  meta: { version: 1, createdAt: new Date().toISOString() },
  admins: [],
  products: [],
  settings: {
    baseCurrency: 'IRR',
    rates: { IRR: 1, USD: 100000, EUR: 108000, AED: 27200, TRY: 2900 },
  },
  priceRules: {
    defaultMarginPercent: 15,
    taxPercent: 9,
    rounding: { mode: 'nearest', to: 1000 },
    minProfitAmount: 0,
    updatedAt: null,
    updatedBy: null,
  },
  priceHistory: [],
  priceRuns: [],
});

let db = DEFAULT_DATA();
let writeQueue = Promise.resolve();

async function loadDb() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  try {
    const parsed = JSON.parse(await fsp.readFile(DB_FILE, 'utf8'));
    const base = DEFAULT_DATA();
    db = {
      ...base, ...parsed,
      settings: { ...base.settings, ...(parsed.settings || {}) },
      priceRules: { ...base.priceRules, ...(parsed.priceRules || {}) },
      meta: { ...base.meta, ...(parsed.meta || {}) },
    };
  } catch (err) {
    if (err.code !== 'ENOENT') {
      const backup = `${DB_FILE}.corrupt-${Date.now()}`;
      console.error(`[db] فایل داده خراب است — پشتیبان: ${backup}`);
      try { fs.copyFileSync(DB_FILE, backup); } catch (_) { /* ignore */ }
    }
    db = DEFAULT_DATA();
    await persistDb();
  }
}

async function persistDb() {
  const tmp = `${DB_FILE}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(db, null, 2), 'utf8');
  await fsp.rename(tmp, DB_FILE);
}

function saveDb() {
  writeQueue = writeQueue.then(persistDb).catch((e) => console.error('[db] خطا در ذخیره:', e.message));
  return writeQueue;
}

/* ============================= ۳. ابزارها =============================== */

const uid = (p) => `${p}_${crypto.randomBytes(9).toString('hex')}`;
const now = () => new Date().toISOString();

class HttpError extends Error {
  constructor(status, message, details) { super(message); this.status = status; this.details = details; }
}
const badRequest = (m, d) => new HttpError(400, m, d);
const unauthorized = (m = 'احراز هویت انجام نشده است') => new HttpError(401, m);
const forbidden = (m = 'دسترسی مجاز نیست') => new HttpError(403, m);
const notFound = (m = 'موردی یافت نشد') => new HttpError(404, m);
const conflict = (m) => new HttpError(409, m);

function slugify(input, fallback = 'item') {
  const raw = String(input || '').trim().toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^\p{L}\p{N}-]+/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
  return raw || `${fallback}-${crypto.randomBytes(3).toString('hex')}`;
}
function uniqueSlug(desired, existing) {
  const base = slugify(desired);
  let candidate = base;
  let n = 2;
  while (existing.includes(candidate)) candidate = `${base}-${n++}`;
  return candidate;
}
function paginate(list, page, limit) {
  const p = Math.max(1, Number(page) || 1);
  const l = Math.min(200, Math.max(1, Number(limit) || 20));
  const start = (p - 1) * l;
  return { items: list.slice(start, start + l), page: p, limit: l, total: list.length, totalPages: Math.max(1, Math.ceil(list.length / l)) };
}
const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/* --------------------------- اعتبارسنجی ورودی --------------------------- */

function str(v, label, opts = {}) {
  const { min = 0, max = 255, def = null } = opts;
  if (v === undefined || v === null || v === '') {
    if (min > 0) throw badRequest(`${label} الزامی است`);
    return def;
  }
  const s = String(v).trim();
  if (s.length < min) throw badRequest(`${label} باید حداقل ${min} کاراکتر باشد`);
  if (s.length > max) throw badRequest(`${label} باید حداکثر ${max} کاراکتر باشد`);
  return s;
}
function num(v, label, opts = {}) {
  const { min = -Infinity, max = Infinity, int = false, def = null } = opts;
  if (v === undefined || v === null || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw badRequest(`${label} باید عدد باشد`);
  if (int && !Number.isInteger(n)) throw badRequest(`${label} باید عدد صحیح باشد`);
  if (n < min) throw badRequest(`${label} نمی‌تواند کمتر از ${min} باشد`);
  if (n > max) throw badRequest(`${label} نمی‌تواند بیشتر از ${max} باشد`);
  return n;
}
function bool(v, def = false) {
  if (v === undefined || v === null) return def;
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === 1 || v === '1') return true;
  if (v === 'false' || v === 0 || v === '0') return false;
  return def;
}
function oneOf(v, label, allowed, def) {
  if (v === undefined || v === null || v === '') return def;
  if (!allowed.includes(String(v))) throw badRequest(`${label} نامعتبر است (مجاز: ${allowed.join('، ')})`);
  return String(v);
}
function nullable(v, fn) { return v === undefined || v === null || v === '' ? null : fn(v); }
function arr(v, fn, max = 100) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw badRequest('فرمت آرایه نامعتبر است');
  if (v.length > max) throw badRequest(`حداکثر ${max} مورد مجاز است`);
  return v.map(fn);
}
function currencyCode(v, def) {
  const code = String(v === undefined || v === null || v === '' ? def : v).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) throw badRequest('کد ارز باید ۳ حرف لاتین باشد (مثل USD)');
  return code;
}
function email(v, label) {
  const s = str(v, label, { min: 5, max: 160 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw badRequest(`${label} معتبر نیست`);
  return s;
}

const PRODUCT_SPEC = {
  name: (v) => str(v, 'نام کالا', { min: 1, max: 200 }),
  slug: (v) => nullable(v, (x) => str(x, 'شناسه (slug)', { min: 1, max: 200 })),
  sku: (v) => nullable(v, (x) => str(x, 'کد کالا', { max: 64 })),
  brand: (v) => nullable(v, (x) => str(x, 'برند', { max: 120 })),
  category: (v) => nullable(v, (x) => str(x, 'دسته‌بندی', { max: 120 })),
  status: (v) => oneOf(v, 'وضعیت', ['draft', 'active', 'archived'], 'draft'),
  shortDescription: (v) => nullable(v, (x) => str(x, 'توضیح کوتاه', { max: 500 })),
  description: (v) => nullable(v, (x) => str(x, 'توضیحات', { max: 20000 })),
  pricingMode: (v) => oneOf(v, 'حالت قیمت‌گذاری', ['auto', 'manual'], 'auto'),
  marginPercent: (v) => nullable(v, (x) => num(x, 'درصد سود', { min: -100, max: 1000 })),
  manualPrice: (v) => nullable(v, (x) => num(x, 'قیمت دستی', { min: 0 })),
  compareAtPrice: (v) => nullable(v, (x) => num(x, 'قیمت قبل تخفیف', { min: 0 })),
  stock: (v) => num(v, 'موجودی', { min: 0, int: true, def: 0 }),
  trackStock: (v) => bool(v, true),
  lowStockThreshold: (v) => num(v, 'آستانه اتمام موجودی', { min: 0, int: true, def: 0 }),
  weightGrams: (v) => nullable(v, (x) => num(x, 'وزن', { min: 0, int: true })),
  featured: (v) => bool(v, false),
  tags: (v) => arr(v, (x) => str(x, 'برچسب', { min: 1, max: 50 }), 30),
  images: (v) => arr(v, (x) => {
    const u = str(x, 'آدرس تصویر', { min: 1, max: 2000 });
    if (!/^https?:\/\//i.test(u)) throw badRequest('آدرس تصویر باید با http:// یا https:// شروع شود');
    return u;
  }, 20),
  specs: (v) => arr(v, (s) => {
    if (!s || typeof s !== 'object') throw badRequest('فرمت مشخصه نامعتبر است');
    return { key: str(s.key, 'نام مشخصه', { min: 1, max: 80 }), value: str(s.value, 'مقدار مشخصه', { min: 1, max: 300 }) };
  }, 100),
  dimensions: (v) => (v && typeof v === 'object'
    ? {
      length: nullable(v.length, (x) => num(x, 'طول', { min: 0 })),
      width: nullable(v.width, (x) => num(x, 'عرض', { min: 0 })),
      height: nullable(v.height, (x) => num(x, 'ارتفاع', { min: 0 })),
    }
    : null),
  seo: (v) => (v && typeof v === 'object'
    ? {
      title: nullable(v.title, (x) => str(x, 'عنوان سئو', { max: 200 })),
      description: nullable(v.description, (x) => str(x, 'توضیح سئو', { max: 500 })),
    }
    : null),
};

function parseProduct(body, { partial = false } = {}) {
  const source = body && typeof body === 'object' ? body : {};
  const out = {};
  for (const [field, fn] of Object.entries(PRODUCT_SPEC)) {
    const present = Object.prototype.hasOwnProperty.call(source, field) && source[field] !== undefined;
    if (partial) { if (present) out[field] = fn(source[field]); }
    else out[field] = fn(source[field]);
  }
  // cost جداگانه پردازش می‌شود تا در ویرایشِ جزئی ارز بازنویسی نشود
  const cost = source.cost && typeof source.cost === 'object' ? source.cost : {};
  if (partial) {
    if (cost.amount !== undefined) out.cost = { ...out.cost, amount: num(cost.amount, 'قیمت خرید', { min: 0 }) };
    if (cost.currency !== undefined) out.cost = { ...out.cost, currency: currencyCode(cost.currency) };
  } else {
    out.cost = { amount: num(cost.amount, 'قیمت خرید', { min: 0, def: 0 }), currency: currencyCode(cost.currency, db.settings.baseCurrency) };
  }
  return out;
}

/* ------------------------- رمز عبور و توکن (JWT) ------------------------ */

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 32, { N: 16384, r: 8, p: 1 }).toString('hex');
  return `scrypt$${salt}$${hash}`;
}
function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const calc = crypto.scryptSync(String(password), salt, 32, { N: 16384, r: 8, p: 1 });
  const expected = Buffer.from(hash, 'hex');
  return calc.length === expected.length && crypto.timingSafeEqual(calc, expected);
}

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

function signToken(user) {
  const iat = Math.floor(Date.now() / 1000);
  const data = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub: user.id, role: user.role, email: user.email, iat, exp: iat + CONFIG.jwt.ttl })}`;
  return `${data}.${crypto.createHmac('sha256', CONFIG.jwt.secret).update(data).digest('base64url')}`;
}
function verifyToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw unauthorized('توکن نامعتبر است');
  const data = `${parts[0]}.${parts[1]}`;
  const expected = Buffer.from(crypto.createHmac('sha256', CONFIG.jwt.secret).update(data).digest('base64url'));
  const given = Buffer.from(parts[2]);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) throw unauthorized('توکن نامعتبر است');
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); }
  catch (_) { throw unauthorized('توکن نامعتبر است'); }
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) throw unauthorized('توکن منقضی شده است');
  return payload;
}

/* ====================== ۴. موتور قیمت‌گذاری خودکار ======================= */
/*
 *  قیمت تمام‌شده = مبلغ خرید × نرخ ارز
 *  بعد از سود   = قیمت تمام‌شده × (۱ + سود/۱۰۰)
 *  بعد از مالیات= بعد از سود × (۱ + مالیات/۱۰۰)
 *  حداقل سود    = max(بعد از مالیات، قیمت تمام‌شده + minProfitAmount)
 *  قیمت نهایی   = گرد کردن(مقدار بالا)
 */

const HISTORY_LIMIT = 2000;

function rateOf(currency) {
  const code = String(currency || db.settings.baseCurrency).toUpperCase();
  const rate = db.settings.rates[code];
  if (rate === undefined) throw badRequest(`نرخ ارز «${code}» تعریف نشده است. ابتدا آن را در بخش قیمت‌گذاری ثبت کنید.`);
  return Number(rate);
}
function roundByMode(value, { mode, to }) {
  const unit = Number(to) || 0;
  if (!unit || mode === 'none') return Math.round(value);
  const d = value / unit;
  if (mode === 'up') return Math.ceil(d) * unit;
  if (mode === 'down') return Math.floor(d) * unit;
  return Math.round(d) * unit;
}
function calculatePrice(product) {
  const rules = db.priceRules;
  const costAmount = Number(product?.cost?.amount ?? 0);
  const costCurrency = (product?.cost?.currency || db.settings.baseCurrency).toUpperCase();
  const rate = rateOf(costCurrency);
  const marginPercent = product?.marginPercent === null || product?.marginPercent === undefined
    ? rules.defaultMarginPercent
    : Number(product.marginPercent);

  const costInBase = costAmount * rate;
  const afterMargin = costInBase * (1 + marginPercent / 100);
  const taxAmount = afterMargin * (Number(rules.taxPercent) / 100);
  const afterTax = afterMargin + taxAmount;
  const floor = rules.minProfitAmount > 0 ? costInBase + Number(rules.minProfitAmount) : null;
  const beforeRounding = floor !== null ? Math.max(afterTax, floor) : afterTax;
  const price = roundByMode(beforeRounding, rules.rounding);

  return {
    price,
    breakdown: {
      baseCurrency: db.settings.baseCurrency, costAmount, costCurrency, rate,
      costInBase: Math.round(costInBase), marginPercent,
      afterMargin: Math.round(afterMargin), taxPercent: rules.taxPercent, taxAmount: Math.round(taxAmount),
      minProfitApplied: floor !== null && floor > afterTax,
      beforeRounding: Math.round(beforeRounding), rounding: rules.rounding,
      profit: Math.round(price / (1 + Number(rules.taxPercent) / 100) - costInBase),
    },
  };
}
function saveRules(input, actor) {
  const body = input && typeof input === 'object' ? input : {};
  const rules = { ...db.priceRules };
  if (body.defaultMarginPercent !== undefined) rules.defaultMarginPercent = num(body.defaultMarginPercent, 'درصد سود', { min: -100, max: 1000 });
  if (body.taxPercent !== undefined) rules.taxPercent = num(body.taxPercent, 'درصد مالیات', { min: 0, max: 100 });
  if (body.minProfitAmount !== undefined) rules.minProfitAmount = num(body.minProfitAmount, 'حداقل سود', { min: 0 });
  if (body.rounding && typeof body.rounding === 'object') {
    const mode = oneOf(body.rounding.mode, 'روش گرد کردن', ['none', 'nearest', 'up', 'down'], rules.rounding.mode);
    const to = num(body.rounding.to === undefined ? rules.rounding.to : body.rounding.to, 'واحد گرد کردن', { min: 0 });
    rules.rounding = { mode, to };
  }
  rules.updatedAt = now();
  rules.updatedBy = actor || null;
  db.priceRules = rules;
  return rules;
}
function saveRates(input, actor) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.keys(input).length) {
    throw badRequest('حداقل یک نرخ ارز ارسال کنید');
  }
  const clean = {};
  for (const [code, value] of Object.entries(input)) {
    const key = currencyCode(code, null);
    const v = Number(value);
    if (!Number.isFinite(v) || v <= 0) throw badRequest(`نرخ ارز ${key} باید عددی مثبت باشد`);
    clean[key] = v;
  }
  clean[db.settings.baseCurrency] = 1;
  db.settings.rates = clean;
  return { ...clean };
}
function recalculate({ ids = null, reason = 'manual', actor = null, save = true } = {}) {
  const wanted = ids && ids.length ? new Set(ids) : null;
  const ratesSnapshot = { ...db.settings.rates };
  const changes = [];
  let scanned = 0, skippedManual = 0, errors = 0;

  for (const product of db.products) {
    if (wanted && !wanted.has(product.id)) continue;
    scanned += 1;
    if (product.pricingMode === 'manual') { skippedManual += 1; continue; }
    try {
      const { price } = calculatePrice(product);
      const oldPrice = Number(product.price);
      if (price !== oldPrice) {
        product.price = price;
        product.priceUpdatedAt = now();
        product.updatedAt = now();
        product.updatedBy = actor;
        const delta = price - oldPrice;
        db.priceHistory.unshift({
          id: uid('ph'), productId: product.id, productName: product.name, sku: product.sku || null,
          oldPrice, newPrice: price, delta,
          deltaPercent: oldPrice > 0 ? Number(((delta / oldPrice) * 100).toFixed(2)) : null,
          reason, actor, ratesSnapshot, at: now(),
        });
        changes.push({ productId: product.id, name: product.name, sku: product.sku || null, oldPrice, newPrice: price, delta });
      }
    } catch (err) {
      errors += 1;
      console.warn(`[pricing] محصول ${product.id} محاسبه نشد: ${err.message}`);
    }
  }
  if (db.priceHistory.length > HISTORY_LIMIT) db.priceHistory.length = HISTORY_LIMIT;

  const run = { id: uid('run'), at: now(), reason, actor, scanned, changed: changes.length, skippedManual, errors };
  db.priceRuns.unshift(run);
  if (db.priceRuns.length > 100) db.priceRuns.length = 100;

  if (save) saveDb();
  return { run, changes };
}
function previewPrices() {
  const rows = [];
  let changed = 0, errors = 0;
  for (const p of db.products) {
    if (p.pricingMode === 'manual') {
      rows.push({ productId: p.id, name: p.name, mode: 'manual', oldPrice: p.price, newPrice: p.manualPrice ?? p.price, changed: false });
      continue;
    }
    try {
      const { price, breakdown } = calculatePrice(p);
      const isChanged = price !== Number(p.price);
      if (isChanged) changed += 1;
      rows.push({ productId: p.id, name: p.name, sku: p.sku || null, mode: 'auto', oldPrice: Number(p.price), newPrice: price, changed: isChanged, breakdown });
    } catch (err) {
      errors += 1;
      rows.push({ productId: p.id, name: p.name, mode: 'auto', error: err.message });
    }
  }
  return { rows, changed, errors, rules: db.priceRules, rates: db.settings.rates };
}
async function fetchRates(reason = 'scheduler', actor = 'system') {
  const url = CONFIG.rateSourceUrl;
  if (!url) {
    const { run, changes } = recalculate({ reason: `${reason} (بدون منبع خارجی)`, actor });
    return { fetched: false, rates: { ...db.settings.rates }, run, changedCount: changes.length };
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`پاسخ ناموفق از منبع نرخ: ${res.status}`);
    const payload = await res.json();

    let found = null;
    for (const c of [payload, payload?.rates, payload?.data, payload?.data?.rates, payload?.result]) {
      if (!c || typeof c !== 'object' || Array.isArray(c)) continue;
      const entries = Object.entries(c)
        .filter(([k, v]) => /^[A-Za-z]{3}$/.test(String(k)) && v !== null && v !== '' && Number.isFinite(Number(v)) && Number(v) > 0)
        .map(([k, v]) => [String(k).toUpperCase(), Number(v)]);
      if (entries.length) { found = Object.fromEntries(entries); break; }
    }
    if (!found) throw new Error('قالب پاسخ منبع نرخ قابل تشخیص نیست');

    const rates = saveRates(found, actor);
    const { run, changes } = recalculate({ reason, actor });
    console.log(`[pricing] بروزرسانی خودکار (${Object.keys(found).join('، ')}) — ${changes.length} تغییر قیمت`);
    return { fetched: true, rates, run, changedCount: changes.length, changes: changes.slice(0, 50) };
  } catch (err) {
    console.error(`[pricing] دریافت نرخ ناموفق بود: ${err.message}`);
    return { fetched: false, error: err.message };
  }
}
function startScheduler() {
  const mins = CONFIG.priceIntervalMinutes;
  if (!Number.isFinite(mins) || mins <= 0) {
    console.log('[pricing] بروزرسانی خودکار غیرفعال است (PRICE_INTERVAL_MINUTES=0)');
    return;
  }
  setInterval(() => { fetchRates('scheduled', 'system').catch((e) => console.error('[pricing]', e.message)); }, mins * 60 * 1000);
  if (!isTest) console.log(`[pricing] بروزرسانی خودکار هر ${mins} دقیقه${CONFIG.rateSourceUrl ? ` ← ${CONFIG.rateSourceUrl}` : ' (بدون منبع خارجی)'}`);
}

/* ========================== ۵. منطق کالاها ============================= */

const PUBLIC_FIELDS = ['id', 'name', 'slug', 'sku', 'brand', 'category', 'status', 'shortDescription', 'description', 'price', 'compareAtPrice', 'pricingMode', 'stock', 'trackStock', 'specs', 'images', 'tags', 'weightGrams', 'dimensions', 'featured', 'createdAt', 'updatedAt', 'priceUpdatedAt'];
const toPublic = (p) => PUBLIC_FIELDS.reduce((acc, k) => { acc[k] = p[k]; return acc; }, {});
const allSlugs = (exceptId = null) => db.products.filter((p) => p.id !== exceptId).map((p) => p.slug);
const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, isActive: u.isActive, lastLoginAt: u.lastLoginAt, createdAt: u.createdAt });

function applyPricing(product, actor) {
  product.price = product.pricingMode === 'manual'
    ? (product.manualPrice ?? product.price ?? 0)
    : calculatePrice(product).price;
  product.priceUpdatedAt = now();
  product.updatedBy = actor || null;
  return product;
}
function createProduct(input, actor) {
  const slug = uniqueSlug(input.slug || input.name, allSlugs());
  if (input.sku && db.products.some((p) => p.sku && String(p.sku).toLowerCase() === String(input.sku).toLowerCase())) {
    throw conflict(`کد کالای «${input.sku}» قبلاً استفاده شده است`);
  }
  const ts = now();
  const product = {
    id: uid('prd'), name: input.name, slug,
    sku: input.sku || null, brand: input.brand || null, category: input.category || null,
    status: input.status || 'draft',
    shortDescription: input.shortDescription || null, description: input.description || null,
    cost: { amount: Number(input.cost?.amount ?? 0), currency: input.cost?.currency || db.settings.baseCurrency },
    pricingMode: input.pricingMode || 'auto',
    marginPercent: input.marginPercent ?? null, manualPrice: input.manualPrice ?? null,
    price: 0, compareAtPrice: input.compareAtPrice ?? null,
    stock: Number(input.stock ?? 0), trackStock: input.trackStock !== false,
    lowStockThreshold: Number(input.lowStockThreshold ?? 0),
    specs: input.specs || [], images: input.images || [], tags: input.tags || [],
    weightGrams: input.weightGrams ?? null, dimensions: input.dimensions || null,
    seo: input.seo || null, featured: input.featured === true,
    createdAt: ts, updatedAt: ts, updatedBy: actor || null, priceUpdatedAt: null,
  };
  applyPricing(product, actor);
  db.products.push(product);
  saveDb();
  return product;
}
function updateProduct(productId, patch, actor) {
  const index = db.products.findIndex((p) => p.id === productId);
  if (index === -1) throw notFound('کالا یافت نشد');
  const product = db.products[index];
  const data = compact(patch);

  if (data.slug !== undefined) data.slug = uniqueSlug(data.slug || product.name, allSlugs(productId));
  if (data.sku && db.products.some((p) => p.id !== productId && p.sku && String(p.sku).toLowerCase() === String(data.sku).toLowerCase())) {
    throw conflict(`کد کالای «${data.sku}» قبلاً استفاده شده است`);
  }
  if (data.cost) data.cost = { ...product.cost, ...data.cost };

  const next = { ...product, ...data, updatedAt: now(), updatedBy: actor || null };
  if (['cost', 'marginPercent', 'pricingMode', 'manualPrice'].some((k) => data[k] !== undefined)) applyPricing(next, actor);

  db.products[index] = next;
  saveDb();
  return next;
}
function sortRows(rows, sort) {
  const copy = [...rows];
  switch (sort) {
    case 'priceAsc': return copy.sort((a, b) => a.price - b.price);
    case 'priceDesc': return copy.sort((a, b) => b.price - a.price);
    case 'name': return copy.sort((a, b) => a.name.localeCompare(b.name, 'fa'));
    case 'stockAsc': return copy.sort((a, b) => a.stock - b.stock);
    case 'oldest': return copy.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    default: return copy.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }
}
function productStats() {
  const p = db.products;
  return {
    total: p.length,
    active: p.filter((x) => x.status === 'active').length,
    draft: p.filter((x) => x.status === 'draft').length,
    archived: p.filter((x) => x.status === 'archived').length,
    outOfStock: p.filter((x) => x.trackStock && x.stock <= 0).length,
    lowStock: p.filter((x) => x.trackStock && x.stock > 0 && x.stock <= (x.lowStockThreshold || 0)).length,
    autoPriced: p.filter((x) => x.pricingMode === 'auto').length,
    manualPriced: p.filter((x) => x.pricingMode === 'manual').length,
    categories: new Set(p.map((x) => x.category).filter(Boolean)).size,
    inventoryValue: Math.round(p.reduce((sum, x) => {
      let rate = 1;
      try { rate = rateOf(x.cost?.currency); } catch (_) { rate = 1; }
      return sum + (x.cost?.amount || 0) * rate * x.stock;
    }, 0)),
    lastPriceRun: db.priceRuns[0] || null,
    lastPriceChanges: db.priceHistory.slice(0, 5),
  };
}

/* ======================= ۶. سرور HTTP و مسیرها ========================== */

const routes = [];

/** پاسخ با کد HTTP دلخواه (مثلاً ۲۰۱ برای ایجاد) — بدون تداخل با فیلد statusِ کالا */
function created(data) { return { _status: 201, _data: data }; }

function addRoute(method, pattern, handler) {
  const keys = [];
  const regex = new RegExp(`^${pattern.replace(/:([A-Za-z0-9_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
  routes.push({ method, regex, keys, handler });
}
const get = (p, h) => addRoute('GET', p, h);
const post = (p, h) => addRoute('POST', p, h);
const patch = (p, h) => addRoute('PATCH', p, h);
const put = (p, h) => addRoute('PUT', p, h);
const del = (p, h) => addRoute('DELETE', p, h);

function requireAuth(ctx) {
  if (!ctx.user) throw unauthorized('توکن ارسال نشده است');
  return ctx.user;
}
function requireAdmin(ctx) {
  const user = requireAuth(ctx);
  if (user.role !== 'admin') throw forbidden('دسترسی فقط برای مدیر ارشد مجاز است');
  return user;
}

/* --------------- سلامت --------------- */
get('/api/health', () => ({
  state: 'ok', time: now(), products: db.products.length, admins: db.admins.length,
  baseCurrency: db.settings.baseCurrency, priceIntervalMinutes: CONFIG.priceIntervalMinutes,
}));

/* --------------- احراز هویت --------------- */
const loginAttempts = new Map();
post('/api/auth/login', (ctx) => {
  const ip = ctx.ip;
  const rec = loginAttempts.get(ip) || { count: 0, resetAt: Date.now() + 15 * 60 * 1000 };
  if (Date.now() > rec.resetAt) { rec.count = 0; rec.resetAt = Date.now() + 15 * 60 * 1000; }
  rec.count += 1;
  loginAttempts.set(ip, rec);
  if (rec.count > 20) throw new HttpError(429, 'تلاش‌های ورود زیاد است. کمی بعد دوباره امتحان کنید.');

  const body = ctx.body;
  const emailValue = email(body.email, 'ایمیل');
  const password = str(body.password, 'رمز عبور', { min: 6 });
  const user = db.admins.find((a) => a.email === emailValue);
  if (!user || !verifyPassword(password, user.passwordHash)) throw unauthorized('ایمیل یا رمز عبور اشتباه است');
  if (!user.isActive) throw unauthorized('این حساب غیرفعال است');
  user.lastLoginAt = now();
  saveDb();
  return { token: signToken(user), user: publicUser(user) };
});
post('/api/auth/logout', () => ({ message: 'خروج انجام شد. توکن را از مرورگر حذف کنید.' }));
get('/api/auth/me', (ctx) => {
  const user = requireAuth(ctx);
  return { user, permissions: { products: true, pricing: true, manageAdmins: user.role === 'admin' } };
});
post('/api/auth/change-password', (ctx) => {
  const user = requireAuth(ctx);
  const admin = db.admins.find((a) => a.id === user.id);
  if (!verifyPassword(str(ctx.body.currentPassword, 'رمز فعلی', { min: 1 }), admin.passwordHash)) throw unauthorized('رمز فعلی اشتباه است');
  admin.passwordHash = hashPassword(str(ctx.body.newPassword, 'رمز جدید', { min: 8, max: 200 }));
  admin.updatedAt = now();
  saveDb();
  return { message: 'رمز عبور با موفقیت تغییر کرد' };
});

/* --------------- کالاها --------------- */
get('/api/products', (ctx) => {
  const q = ctx.query;
  const isStaff = Boolean(ctx.user);
  let rows = isStaff ? [...db.products] : db.products.filter((p) => p.status === 'active');

  const needle = str(q.get('q'), 'عبارت جستجو', { max: 200 }) || '';
  if (needle) {
    const n = needle.trim().toLowerCase();
    rows = rows.filter((p) => [p.name, p.sku, p.brand, p.category, p.slug, ...(p.tags || [])]
      .filter(Boolean).some((v) => String(v).toLowerCase().includes(n)));
  }
  const category = q.get('category');
  if (category) rows = rows.filter((p) => p.category === category);
  const brand = q.get('brand');
  if (brand) rows = rows.filter((p) => p.brand === brand);
  if (isStaff && q.get('status')) rows = rows.filter((p) => p.status === q.get('status'));
  if (isStaff && q.get('pricingMode')) rows = rows.filter((p) => p.pricingMode === q.get('pricingMode'));
  if (isStaff && q.get('lowStock') === '1') rows = rows.filter((p) => p.trackStock && p.stock <= (p.lowStockThreshold || 0));
  if (q.get('featured') !== null) rows = rows.filter((p) => Boolean(p.featured) === (q.get('featured') === '1' || q.get('featured') === 'true'));
  if (q.get('inStock') === '1' || q.get('inStock') === 'true') rows = rows.filter((p) => !p.trackStock || p.stock > 0);
  if (q.get('minPrice')) rows = rows.filter((p) => p.price >= Number(q.get('minPrice')));
  if (q.get('maxPrice')) rows = rows.filter((p) => p.price <= Number(q.get('maxPrice')));

  const sort = oneOf(q.get('sort'), 'نوع مرتب‌سازی', ['newest', 'oldest', 'priceAsc', 'priceDesc', 'name', 'stockAsc'], 'newest');
  const page = paginate(sortRows(rows, sort), q.get('page'), q.get('limit'));
  return { ...page, items: isStaff ? page.items : page.items.map(toPublic) };
});

get('/api/products/stats', (ctx) => { requireAuth(ctx); return productStats(); });

get('/api/products/categories', () => {
  const map = new Map();
  for (const p of db.products) if (p.category) map.set(p.category, (map.get(p.category) || 0) + 1);
  return [...map].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
});

post('/api/products/bulk', (ctx) => {
  const actor = requireAuth(ctx).email;
  const body = ctx.body;
  const ids = arr(body.ids, (x) => str(x, 'شناسه', { min: 1 }), 500);
  if (!ids.length) throw badRequest('حداقل یک مورد را انتخاب کنید');
  const action = oneOf(body.action, 'عملیات گروهی', ['activate', 'deactivate', 'archive', 'delete', 'reprice', 'setCategory', 'setMargin']);
  const out = { affected: 0, deleted: 0, repriced: 0 };

  if (action === 'delete') {
    db.products = db.products.filter((p) => !ids.includes(p.id));
    db.priceHistory = db.priceHistory.filter((h) => !ids.includes(h.productId));
    saveDb();
    return { ...out, deleted: ids.length };
  }
  if (action === 'reprice') {
    const { changes } = recalculate({ ids, reason: 'bulk', actor, save: false });
    saveDb();
    return { ...out, repriced: changes.length, affected: changes.length };
  }
  for (const productId of ids) {
    const product = db.products.find((p) => p.id === productId);
    if (!product) continue;
    switch (action) {
      case 'activate': product.status = 'active'; break;
      case 'deactivate': product.status = 'draft'; break;
      case 'archive': product.status = 'archived'; break;
      case 'setCategory':
        product.category = str(body.category, 'دسته‌بندی جدید', { min: 1, max: 120 });
        break;
      case 'setMargin':
        if (product.pricingMode === 'manual') break;
        product.marginPercent = num(body.marginPercent, 'درصد سود', { min: -100, max: 1000 });
        applyPricing(product, actor);
        break;
      default: break;
    }
    product.updatedAt = now();
    product.updatedBy = actor;
    out.affected += 1;
  }
  saveDb();
  return out;
});

post('/api/products', (ctx) => {
  const actor = requireAuth(ctx).email;
  return created(createProduct(parseProduct(ctx.body, { partial: false }), actor));
});

get('/api/products/:idOrSlug', (ctx) => {
  const product = db.products.find((p) => p.id === ctx.params.idOrSlug || p.slug === ctx.params.idOrSlug);
  if (!product) throw notFound('کالا یافت نشد');
  if (product.status !== 'active' && !ctx.user) throw notFound('کالا یافت نشد');
  return ctx.user ? product : toPublic(product);
});

get('/api/products/:id/price-history', (ctx) => {
  requireAuth(ctx);
  const limit = Math.min(500, Number(ctx.query.get('limit')) || 50);
  return db.priceHistory.filter((h) => h.productId === ctx.params.id).slice(0, limit);
});

patch('/api/products/:id', (ctx) => {
  const actor = requireAuth(ctx).email;
  return updateProduct(ctx.params.id, parseProduct(ctx.body, { partial: true }), actor);
});

del('/api/products/:id', (ctx) => {
  requireAdmin(ctx);
  const before = db.products.length;
  db.products = db.products.filter((p) => p.id !== ctx.params.id);
  if (db.products.length === before) throw notFound('کالا یافت نشد');
  db.priceHistory = db.priceHistory.filter((h) => h.productId !== ctx.params.id);
  saveDb();
  return { message: 'کالا حذف شد' };
});

/* --------------- قیمت‌گذاری --------------- */
get('/api/pricing/settings', (ctx) => {
  requireAuth(ctx);
  return { baseCurrency: db.settings.baseCurrency, rates: { ...db.settings.rates }, rules: db.priceRules, lastRuns: db.priceRuns.slice(0, 10) };
});
patch('/api/pricing/rules', (ctx) => {
  const user = requireAdmin(ctx);
  const rules = saveRules(ctx.body, user.email);
  const { run, changes } = recalculate({ reason: 'rules-updated', actor: user.email });
  return { rules, run, changedCount: changes.length, changes: changes.slice(0, 50) };
});
put('/api/pricing/rates', (ctx) => {
  const user = requireAdmin(ctx);
  const rates = saveRates(ctx.body.rates, user.email);
  const { run, changes } = recalculate({ reason: 'rate-updated', actor: user.email });
  return { rates, run, changedCount: changes.length, changes: changes.slice(0, 50) };
});
post('/api/pricing/rates/webhook', (ctx) => {
  if (!CONFIG.webhookToken) throw unauthorized('وب‌هوک قیمت غیرفعال است');
  if (ctx.headers['x-price-token'] !== CONFIG.webhookToken) throw unauthorized('توکن وب‌هوک نامعتبر است');
  const rates = saveRates(ctx.body.rates, 'webhook');
  const { run, changes } = recalculate({ reason: 'webhook', actor: 'webhook' });
  return { rates, run, changedCount: changes.length, changes: changes.slice(0, 50) };
});
get('/api/pricing/preview', (ctx) => { requireAuth(ctx); return previewPrices(); });
post('/api/pricing/recalculate', (ctx) => {
  const user = requireAuth(ctx);
  const body = ctx.body && typeof ctx.body === 'object' ? ctx.body : {};
  const { run, changes } = recalculate({
    ids: body.ids ? arr(body.ids, (x) => str(x, 'شناسه', { min: 1 }), 500) : null,
    reason: str(body.reason, 'دلیل', { max: 80 }) || 'manual',
    actor: user.email,
  });
  return { run, changedCount: changes.length, changes: changes.slice(0, 500) };
});
post('/api/pricing/fetch-rates', async (ctx) => {
  requireAdmin(ctx);
  if (!CONFIG.rateSourceUrl) throw badRequest('RATE_SOURCE_URL در تنظیمات تعریف نشده است');
  return fetchRates('manual-fetch', ctx.user.email);
});
get('/api/pricing/history', (ctx) => {
  requireAuth(ctx);
  const limit = Math.min(500, Number(ctx.query.get('limit')) || 100);
  const productId = ctx.query.get('productId');
  const rows = productId ? db.priceHistory.filter((h) => h.productId === productId) : db.priceHistory;
  return rows.slice(0, limit);
});

/* --------------- کاربران --------------- */
get('/api/admins', (ctx) => { requireAdmin(ctx); return db.admins.map(publicUser); });
post('/api/admins', (ctx) => {
  requireAdmin(ctx);
  const body = ctx.body;
  const emailValue = email(body.email, 'ایمیل');
  if (db.admins.some((a) => a.email === emailValue)) throw conflict('این ایمیل قبلاً ثبت شده است');
  const admin = {
    id: uid('adm'),
    name: str(body.name, 'نام', { min: 1, max: 120 }),
    email: emailValue,
    role: oneOf(body.role, 'نقش', ['admin', 'editor'], 'editor'),
    passwordHash: hashPassword(str(body.password, 'رمز عبور', { min: 8, max: 200 })),
    isActive: true, createdAt: now(), updatedAt: now(), lastLoginAt: null,
  };
  db.admins.push(admin);
  saveDb();
  return created(publicUser(admin));
});
patch('/api/admins/:id', (ctx) => {
  requireAdmin(ctx);
  const index = db.admins.findIndex((a) => a.id === ctx.params.id);
  if (index === -1) throw notFound('کاربر یافت نشد');
  const admin = db.admins[index];
  const body = ctx.body;
  const next = { ...admin, updatedAt: now() };

  if (body.name !== undefined) next.name = str(body.name, 'نام', { min: 1, max: 120 });
  if (body.role !== undefined) next.role = oneOf(body.role, 'نقش', ['admin', 'editor'], admin.role);
  if (body.isActive !== undefined) next.isActive = bool(body.isActive, admin.isActive);
  if (body.email !== undefined) {
    const emailValue = email(body.email, 'ایمیل');
    if (db.admins.some((a) => a.email === emailValue && a.id !== admin.id)) throw conflict('این ایمیل قبلاً استفاده شده است');
    next.email = emailValue;
  }
  if (body.password !== undefined) next.passwordHash = hashPassword(str(body.password, 'رمز عبور', { min: 8, max: 200 }));

  const others = db.admins.filter((a) => a.role === 'admin' && a.id !== admin.id);
  if (!others.length && (next.role !== 'admin' || next.isActive === false)) {
    throw badRequest('حداقل یک مدیر ارشد (admin) باید فعال باقی بماند');
  }
  db.admins[index] = next;
  saveDb();
  return publicUser(next);
});
del('/api/admins/:id', (ctx) => {
  requireAdmin(ctx);
  const admin = db.admins.find((a) => a.id === ctx.params.id);
  if (!admin) throw notFound('کاربر یافت نشد');
  if (!db.admins.some((a) => a.role === 'admin' && a.id !== admin.id)) throw badRequest('آخرین مدیر ارشد را نمی‌توان حذف کرد');
  db.admins = db.admins.filter((a) => a.id !== admin.id);
  saveDb();
  return { message: 'کاربر حذف شد' };
});

/* ======================== ۷. بخش‌های HTTP =============================== */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function sendFile(res, filePath, cache = true) {
  return fsp.stat(filePath).then((stat) => {
    if (!stat.isFile()) return false;
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': cache ? 'no-cache' : 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    return new Promise((resolve, reject) => {
      const stream = fs.createReadStream(filePath);
      stream.on('error', reject);
      stream.on('end', () => resolve(true));
      stream.pipe(res);
    });
  }).catch(() => false);
}

async function serveStatic(ctx) {
  const p = ctx.pathname;

  if (p === '/admin' || p === '/admin/') return sendFile(ctx.res, path.join(ADMIN_DIR, 'index.html'));
  if (p.startsWith('/admin/')) {
    const file = path.resolve(ADMIN_DIR, p.slice('/admin/'.length));
    if (file.startsWith(ADMIN_DIR + path.sep)) {
      if (await sendFile(ctx.res, file)) return true;
    }
    return false;
  }
  if (p === '/') return sendFile(ctx.res, path.join(ROOT, 'index.html'));
  if (SITE_FILES.includes(p.slice(1))) return sendFile(ctx.res, path.join(ROOT, p.slice(1)));
  return false;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) { reject(new HttpError(413, 'حجم درخواست زیاد است')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch (_) {
        reject(badRequest('بدنهٔ درخواست JSON معتبر نیست'));
      }
    });
    req.on('error', reject);
  });
}

function attachUser(ctx) {
  const header = ctx.headers.authorization || '';
  let token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (!token && typeof ctx.query.get('token') === 'string') token = ctx.query.get('token');
  if (!token) return;
  try {
    const payload = verifyToken(token);
    const user = db.admins.find((a) => a.id === payload.sub);
    if (user && user.isActive) ctx.user = { id: user.id, name: user.name, email: user.email, role: user.role };
  } catch (_) { /* مهمان */ }
}

function guardAdminIp(ctx) {
  if (!CONFIG.ipAllowlist.length) return;
  if (ctx.pathname.startsWith('/admin') && !CONFIG.ipAllowlist.includes(ctx.ip)) {
    throw forbidden(`دسترسی از IP ${ctx.ip} مجاز نیست`);
  }
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); }
  catch (_) { pathname = url.pathname; }

  const ctx = {
    req, res, headers: req.headers, pathname,
    query: url.searchParams, params: {}, body: {}, user: null,
    ip: (req.socket.remoteAddress || '').replace('::ffff:', ''),
  };

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,x-price-token');

  try {
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    if (['POST', 'PATCH', 'PUT'].includes(req.method)) ctx.body = await readBody(req);
    attachUser(ctx);
    guardAdminIp(ctx);

    for (const route of routes) {
      if (route.method !== req.method) continue;
      const match = route.regex.exec(pathname);
      if (!match) continue;
      match.slice(1).forEach((value, i) => { ctx.params[route.keys[i]] = decodeURIComponent(value); });
      const result = await route.handler(ctx);
      if (result === undefined || result === null) return;
      const wrapped = result && result._status !== undefined;
      const status = wrapped ? result._status : 200;
      const data = wrapped ? result._data : result;
      sendJson(res, status, { ok: true, data });
      if (!isTest) console.log(`  ${req.method} ${pathname} ${status} — ${Date.now() - started}ms`);
      return;
    }

    if (await serveStatic(ctx)) {
      if (!isTest) console.log(`  ${req.method} ${pathname} 200 — ${Date.now() - started}ms`);
      return;
    }

    if (pathname.startsWith('/api')) {
      sendJson(res, 404, { ok: false, error: { message: 'مسیر یافت نشد', path: pathname } });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('صفحه یافت نشد — 404');
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500 || !isTest) console.error(`[error] ${req.method} ${pathname} ->`, err.message);
    if (!res.headersSent) {
      sendJson(res, status, {
        ok: false,
        error: {
          message: status >= 500 && CONFIG.env === 'production' ? 'خطای داخلی سرور' : err.message,
          details: err.details,
        },
      });
    } else {
      res.end();
    }
  }
});

/* ====================== ۸. اجرا و دستورات CLI =========================== */

const SAMPLE_PRODUCTS = [
  { name: 'اشتراک تلگرام پریمیوم — ۳ ماهه', category: 'اشتراک', brand: 'Telegram', cost: { amount: 12, currency: 'USD' }, marginPercent: 25, stock: 40, lowStockThreshold: 5, featured: true, status: 'active', tags: ['پریمیوم', 'پرفروش'], shortDescription: 'فعالسازی روی اکانت شما، بدون نیاز به رمز عبور', specs: [{ key: 'مدت اعتبار', value: '۳ ماه' }, { key: 'زمان تحویل', value: '۵ تا ۳۰ دقیقه' }, { key: 'گارانتی', value: 'تا پایان دوره' }] },
  { name: 'اشتراک تلگرام پریمیوم — ۱۲ ماهه', category: 'اشتراک', brand: 'Telegram', cost: { amount: 38, currency: 'USD' }, marginPercent: 20, stock: 25, lowStockThreshold: 5, status: 'active', tags: ['پریمیوم', 'سالیانه'], specs: [{ key: 'مدت اعتبار', value: '۱۲ ماه' }, { key: 'پشتیبانی', value: '۲۴ ساعته' }] },
  { name: 'گیفت کارت اپل — ۵۰ دلار', category: 'گیفت کارت', brand: 'Apple', cost: { amount: 50, currency: 'USD' }, marginPercent: 12, stock: 12, lowStockThreshold: 3, status: 'active', tags: ['گیفت کارت'], specs: [{ key: 'مبلغ', value: '۵۰ دلار' }, { key: 'منطقه', value: 'USA' }] },
  { name: 'شارژ حساب کاربری — ۱۰۰ هزار تومان', category: 'شارژ', cost: { amount: 100000, currency: 'IRR' }, marginPercent: 10, stock: 999, status: 'active', tags: ['شارژ'], specs: [{ key: 'مبلغ', value: '۱۰۰٬۰۰۰ تومان' }] },
  { name: 'پک ویژه استیکر و تم', category: 'محتوا', cost: { amount: 5, currency: 'USD' }, marginPercent: 40, stock: 0, lowStockThreshold: 10, status: 'active', tags: ['استیکر'], specs: [{ key: 'تعداد آیتم', value: '۳۰+' }] },
  { name: 'اشتراک آزمایشی ۷ روزه', category: 'اشتراک', cost: { amount: 3, currency: 'USD' }, stock: 5, status: 'draft', tags: ['آزمایشی'], specs: [{ key: 'مدت اعتبار', value: '۷ روز' }] },
];

async function cliCreateAdmin(argv) {
  const [name, emailValue, password, role = 'admin'] = argv;
  if (!name || !emailValue || !password) {
    console.log('کاربرد: node server.js --create-admin "نام" email@site.com رمزعبور [admin|editor]');
    process.exit(1);
  }
  await loadDb();
  const normalized = String(emailValue).toLowerCase();
  if (db.admins.some((a) => a.email === normalized)) throw new Error('این ایمیل قبلاً ثبت شده است');
  db.admins.push({
    id: uid('adm'), name, email: normalized,
    role: role === 'editor' ? 'editor' : 'admin',
    passwordHash: hashPassword(password),
    isActive: true, createdAt: now(), updatedAt: now(), lastLoginAt: null,
  });
  await persistDb();
  console.log(`✅ ادمین ساخته شد: ${normalized}`);
}

async function cliSeed() {
  await loadDb();
  const emailValue = (process.env.ADMIN_EMAIL || 'admin@shop.local').toLowerCase();
  const password = process.env.ADMIN_PASSWORD || 'admin12345';
  if (!db.admins.length) {
    db.admins.push({
      id: uid('adm'), name: 'مدیر اصلی', email: emailValue, role: 'admin',
      passwordHash: hashPassword(password),
      isActive: true, createdAt: now(), updatedAt: now(), lastLoginAt: null,
    });
    console.log(`✅ ادمین ساخته شد: ${emailValue} / ${password}`);
  } else {
    console.log('ادمین از قبل وجود دارد — رد شد.');
  }
  if (!db.products.length) {
    SAMPLE_PRODUCTS.forEach((p) => createProduct(parseProduct(p, { partial: false }), 'seed'));
    console.log(`✅ ${SAMPLE_PRODUCTS.length} کالای نمونه ساخته شد.`);
  } else {
    console.log('کالا از قبل وجود دارد — رد شد.');
  }
  console.log(`\nپنل: http://localhost:${CONFIG.port}/admin  ←  ${emailValue} / ${password}`);
}

async function main() {
  await loadDb();
  server.listen(CONFIG.port, '0.0.0.0', () => {
    console.log(`✅ سرور روی پورت ${CONFIG.port} اجرا شد`);
    console.log(`   سایت:       http://localhost:${CONFIG.port}/`);
    console.log(`   پنل ادمین:  http://localhost:${CONFIG.port}/admin`);
    console.log(`   API عمومی:  http://localhost:${CONFIG.port}/api/products`);
    if (!db.admins.length) console.warn('⚠️  هیچ ادمینی ندارید: node server.js --create-admin "نام" ایمیل رمز');
    startScheduler();
  });
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const runner = argv[0] === '--create-admin' ? cliCreateAdmin(argv.slice(1))
    : argv[0] === '--seed' ? cliSeed()
      : main();
  runner.catch((err) => { console.error('❌ خطا:', err.message); process.exit(1); });
}

module.exports = { server, main, loadDb, CONFIG, get db() { return db; } };
