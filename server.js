/* =============================================================================
 *  سرور فروشگاه — بکند کامل در یک فایل (Node.js + Express)
 * -----------------------------------------------------------------------------
 *  شامل: مدیریت کالاها · احراز هویت ادمین · موتور قیمت‌گذاری خودکار ·
 *        زمان‌بند بروزرسانی نرخ ارز · وب‌هوک قیمت · تاریخچه تغییرات
 *
 *  اجرا:   node server.js        (یا npm start)
 *  داده:   data/db.json
 *  پنل:    /admin
 * ===========================================================================*/
'use strict';

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jsonwebtoken = require('jsonwebtoken');
const cron = require('node-cron');
const { z } = require('zod');

/* ============================== ۱. تنظیمات ============================== */

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const DB_FILE = path.join(DATA_DIR, 'db.json');

let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  JWT_SECRET = crypto.randomBytes(48).toString('hex');
  console.warn('⚠️  JWT_SECRET تنظیم نشده — یک کلید موقت ساخته شد. در production حتماً مقداردهی کنید.');
}

const CONFIG = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 3000),
  jwt: { secret: JWT_SECRET, expiresIn: process.env.JWT_EXPIRES_IN || '7d' },
  schedule: process.env.PRICE_SCHEDULE || '*/30 * * * *',
  rateSourceUrl: process.env.RATE_SOURCE_URL || '',
  webhookToken: process.env.PRICE_WEBHOOK_TOKEN || '',
  ipAllowlist: (process.env.ADMIN_IP_ALLOWLIST || '').split(',').map((s) => s.trim()).filter(Boolean),
};

/* ============================ ۲. لایه داده ============================== */
/* کل داده در یک فایل JSON اتمیک. برای مهاجرت به SQLite/Postgres کافی است
   همین بخش بازنویسی شود؛ بقیهٔ کد فقط از db و saveDb() استفاده می‌کند.   */

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

/* ============================= ۳. ابزارها ============================== */

const id = (p) => `${p}_${crypto.randomBytes(9).toString('hex')}`;
const now = () => new Date().toISOString();
const compact = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

class HttpError extends Error {
  constructor(status, message, details) { super(message); this.status = status; this.details = details; }
}
const badRequest = (m = 'درخواست نامعتبر است', d) => new HttpError(400, m, d);
const unauthorized = (m = 'احراز هویت انجام نشده است') => new HttpError(401, m);
const forbidden = (m = 'دسترسی مجاز نیست') => new HttpError(403, m);
const notFound = (m = 'موردی یافت نشد') => new HttpError(404, m);
const conflict = (m = 'تداخل در داده‌ها') => new HttpError(409, m);

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

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
function paginate(list, { page = 1, limit = 20 } = {}) {
  const p = Math.max(1, Number(page) || 1);
  const l = Math.min(200, Math.max(1, Number(limit) || 20));
  const start = (p - 1) * l;
  return { items: list.slice(start, start + l), page: p, limit: l, total: list.length, totalPages: Math.max(1, Math.ceil(list.length / l)) };
}

/* ========================= ۴. اعتبارسنجی (zod) ========================== */

const money = z.coerce.number({ invalid_type_error: 'مقدار باید عدد باشد' }).finite('مقدار باید عدد باشد').min(0, 'مقدار نمی‌تواند منفی باشد');
const currencyCode = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'کد ارز باید ۳ حرف لاتین باشد');

const productFields = {
  name: z.string().trim().min(1, 'نام کالا الزامی است').max(200),
  slug: z.string().trim().max(200).optional(),
  sku: z.string().trim().max(64).optional().nullable(),
  brand: z.string().trim().max(120).optional().nullable(),
  category: z.string().trim().max(120).optional().nullable(),
  status: z.enum(['draft', 'active', 'archived']).default('draft'),
  shortDescription: z.string().trim().max(500).optional().nullable(),
  description: z.string().trim().max(20000).optional().nullable(),
  cost: z.object({ amount: money.default(0), currency: currencyCode.default('IRR') }).default({ amount: 0, currency: 'IRR' }),
  pricingMode: z.enum(['auto', 'manual']).default('auto'),
  marginPercent: z.coerce.number().finite().min(-100, 'سود باید بین ‎-100‎ و 1000 باشد').max(1000).optional().nullable(),
  manualPrice: money.optional().nullable(),
  compareAtPrice: money.optional().nullable(),
  stock: z.coerce.number().int('موجودی باید عدد صحیح باشد').min(0).default(0),
  trackStock: z.boolean().default(true),
  lowStockThreshold: z.coerce.number().int().min(0).default(0),
  specs: z.array(z.object({
    key: z.string().trim().min(1, 'نام مشخصه الزامی است').max(80),
    value: z.string().trim().min(1, 'مقدار مشخصه الزامی است').max(300),
  })).max(100).default([]),
  images: z.array(z.string().trim().url('آدرس تصویر معتبر نیست').max(2000)).max(20).default([]),
  tags: z.array(z.string().trim().min(1).max(50)).max(30).default([]),
  weightGrams: z.coerce.number().int().min(0).optional().nullable(),
  dimensions: z.object({
    length: z.coerce.number().min(0).optional().nullable(),
    width: z.coerce.number().min(0).optional().nullable(),
    height: z.coerce.number().min(0).optional().nullable(),
  }).optional().nullable(),
  seo: z.object({
    title: z.string().trim().max(200).optional().nullable(),
    description: z.string().trim().max(500).optional().nullable(),
  }).optional().nullable(),
  featured: z.boolean().default(false),
};

const schemas = {
  createProduct: z.object(productFields),
  // در ویرایش جزئی، فرستادنِ فقط amount نباید ارز را به پیش‌فرض برگرداند
  updateProduct: z.object({
    ...productFields,
    cost: z.object({ amount: money.optional(), currency: currencyCode.optional() }).optional(),
  }).partial(),
  login: z.object({
    email: z.string().trim().toLowerCase().email('ایمیل معتبر نیست'),
    password: z.string().min(6, 'رمز عبور باید حداقل ۶ کاراکتر باشد'),
  }),
  changePassword: z.object({
    currentPassword: z.string().min(1, 'رمز فعلی الزامی است'),
    newPassword: z.string().min(8, 'رمز جدید باید حداقل ۸ کاراکتر باشد'),
  }),
  createAdmin: z.object({
    name: z.string().trim().min(1, 'نام الزامی است').max(120),
    email: z.string().trim().toLowerCase().email('ایمیل معتبر نیست'),
    password: z.string().min(8, 'رمز عبور باید حداقل ۸ کاراکتر باشد'),
    role: z.enum(['admin', 'editor']).default('editor'),
  }),
  updateAdmin: z.object({
    name: z.string().trim().min(1).max(120).optional(),
    email: z.string().trim().toLowerCase().email().optional(),
    password: z.string().min(8).optional(),
    role: z.enum(['admin', 'editor']).optional(),
    isActive: z.boolean().optional(),
  }).partial(),
  bulk: z.object({
    ids: z.array(z.string().min(1)).min(1, 'حداقل یک مورد انتخاب کنید').max(500),
    action: z.enum(['activate', 'deactivate', 'archive', 'delete', 'reprice', 'setCategory', 'setMargin']),
    category: z.string().trim().max(120).optional(),
    marginPercent: z.coerce.number().finite().min(-100).max(1000).optional(),
  }),
  publicQuery: z.object({
    q: z.string().trim().max(200).optional(),
    category: z.string().trim().max(120).optional(),
    brand: z.string().trim().max(120).optional(),
    status: z.string().trim().optional(),
    pricingMode: z.string().trim().optional(),
    featured: z.coerce.boolean().optional(),
    minPrice: z.coerce.number().min(0).optional(),
    maxPrice: z.coerce.number().min(0).optional(),
    inStock: z.coerce.boolean().optional(),
    lowStock: z.coerce.boolean().optional(),
    sort: z.enum(['newest', 'oldest', 'priceAsc', 'priceDesc', 'name', 'stockAsc']).default('newest'),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(200).default(20),
  }),
  rules: z.object({
    defaultMarginPercent: z.coerce.number().finite().min(-100).max(1000).optional(),
    taxPercent: z.coerce.number().finite().min(0).max(100).optional(),
    minProfitAmount: z.coerce.number().finite().min(0).optional(),
    rounding: z.object({ mode: z.enum(['none', 'nearest', 'up', 'down']).optional(), to: z.coerce.number().min(0).optional() }).optional(),
  }).strict(),
  rates: z.object({
    rates: z.record(z.coerce.number().positive('نرخ ارز باید عددی مثبت باشد'))
      .refine((o) => Object.keys(o).length > 0, { message: 'حداقل یک نرخ ارز ارسال کنید' }),
  }),
  recalc: z.object({
    ids: z.array(z.string().min(1)).max(500).optional(),
    reason: z.string().max(80).optional(),
  }).optional().default({}),
};

function validate(schema, source = 'body') {
  return (req, res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      const details = result.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
      const first = details[0];
      return next(badRequest(first ? `${first.field}: ${first.message}` : 'داده‌های ورودی نامعتبر است', details));
    }
    req[source] = result.data;
    next();
  };
}

/* ======================= ۵. احراز هویت و دسترسی ========================= */

const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, isActive: u.isActive, lastLoginAt: u.lastLoginAt, createdAt: u.createdAt });

const signToken = (u) => jsonwebtoken.sign({ sub: u.id, role: u.role, email: u.email }, CONFIG.jwt.secret, { expiresIn: CONFIG.jwt.expiresIn });

function extractToken(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  if (typeof req.query.token === 'string') return req.query.token;
  return null;
}

function authenticate(req, res, next) {
  const token = extractToken(req);
  if (!token) return next(unauthorized('توکن ارسال نشده است'));
  try {
    const payload = jsonwebtoken.verify(token, CONFIG.jwt.secret);
    const user = db.admins.find((a) => a.id === payload.sub);
    if (!user) return next(unauthorized('کاربر مرتبط با توکن یافت نشد'));
    if (!user.isActive) return next(unauthorized('حساب کاربری غیرفعال است'));
    req.user = { id: user.id, name: user.name, email: user.email, role: user.role };
    next();
  } catch (err) {
    next(err.name === 'TokenExpiredError' ? unauthorized('توکن منقضی شده است') : unauthorized('توکن نامعتبر است'));
  }
}

function optionalAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) return next();
  try {
    const payload = jsonwebtoken.verify(token, CONFIG.jwt.secret);
    const user = db.admins.find((a) => a.id === payload.sub);
    if (user && user.isActive) req.user = { id: user.id, name: user.name, email: user.email, role: user.role };
  } catch (_) { /* مهمان */ }
  next();
}

const requireAdmin = (req, res, next) => (req.user?.role === 'admin' ? next() : next(forbidden('دسترسی فقط برای مدیر ارشد مجاز است')));

function ipAllowlist(req, res, next) {
  if (!CONFIG.ipAllowlist.length) return next();
  const ip = (req.ip || '').replace('::ffff:', '');
  if (!CONFIG.ipAllowlist.includes(ip)) return next(forbidden(`دسترسی از IP ${ip} مجاز نیست`));
  next();
}

// محدودکنندهٔ ساده برای جلوگیری از حملهٔ رمز (بدون نیاز به پکیج اضافه)
const loginAttempts = new Map();
function limitLogin(req, res, next) {
  const key = (req.ip || 'unknown').replace('::ffff:', '');
  const rec = loginAttempts.get(key) || { count: 0, resetAt: Date.now() + 15 * 60 * 1000 };
  if (Date.now() > rec.resetAt) { rec.count = 0; rec.resetAt = Date.now() + 15 * 60 * 1000; }
  rec.count += 1;
  loginAttempts.set(key, rec);
  if (rec.count > 20) return res.status(429).json({ ok: false, error: { message: 'تلاش‌های ورود زیاد است. کمی بعد دوباره امتحان کنید.' } });
  next();
}

/* ====================== ۶. موتور قیمت‌گذاری خودکار ======================= */
/*
 *   قیمت تمام‌شده در ارز پایه = مبلغ خرید × نرخ ارز
 *   بعد از سود      = قیمت تمام‌شده × (۱ + سود/۱۰۰)
 *   بعد از مالیات   = بعد از سود × (۱ + مالیات/۱۰۰)
 *   حداقل سود       = max(بعد از مالیات، قیمت تمام‌شده + minProfitAmount)
 *   قیمت نهایی      = گرد کردن(مقدار بالا)
 */

const HISTORY_LIMIT = 2000;
const RUNS_LIMIT = 100;

function rateOf(currency) {
  const code = String(currency || db.settings.baseCurrency).toUpperCase();
  const rate = db.settings.rates[code];
  if (rate === undefined) throw badRequest(`نرخ ارز «${code}» تعریف نشده است. ابتدا آن را در تنظیمات قیمت‌گذاری ثبت کنید.`);
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

  return {
    price: roundByMode(beforeRounding, rules.rounding),
    breakdown: {
      baseCurrency: db.settings.baseCurrency, costAmount, costCurrency, rate,
      costInBase: Math.round(costInBase), marginPercent,
      afterMargin: Math.round(afterMargin), taxPercent: rules.taxPercent, taxAmount: Math.round(taxAmount),
      minProfitApplied: floor !== null && floor > afterTax,
      beforeRounding: Math.round(beforeRounding), rounding: rules.rounding,
      profit: Math.round(roundByMode(beforeRounding, rules.rounding) / (1 + Number(rules.taxPercent) / 100) - costInBase),
    },
  };
}

function saveRules(input, actor) {
  const next = { ...db.priceRules, ...input, updatedAt: now(), updatedBy: actor || null };
  if (input.rounding) next.rounding = { ...db.priceRules.rounding, ...input.rounding };
  db.priceRules = next;
  return next;
}

function saveRates(input, actor) {
  const clean = {};
  for (const [code, value] of Object.entries(input)) {
    const key = String(code).trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(key)) throw badRequest(`کد ارز نامعتبر: ${code}`);
    const v = Number(value);
    if (!Number.isFinite(v) || v <= 0) throw badRequest(`نرخ ارز ${key} باید عددی مثبت باشد`);
    clean[key] = v;
  }
  clean[db.settings.baseCurrency] = 1;
  db.settings.rates = clean;
  return { ...clean };
}

/** محاسبهٔ مجدد قیمت کالاهای «خودکار» + ثبت تاریخچه */
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
          id: id('ph'), productId: product.id, productName: product.name, sku: product.sku || null,
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
  const run = { id: id('run'), at: now(), reason, actor, scanned, changed: changes.length, skippedManual, errors };
  db.priceRuns.unshift(run);
  if (db.priceRuns.length > RUNS_LIMIT) db.priceRuns.length = RUNS_LIMIT;

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

/** دریافت نرخ از منبع خارجی + اعمال فوری */
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
    for (const candidate of [payload, payload?.rates, payload?.data, payload?.data?.rates, payload?.result]) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
      const entries = Object.entries(candidate)
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
  if (!CONFIG.schedule || !cron.validate(CONFIG.schedule)) {
    console.warn(`[pricing] زمان‌بند غیرفعال (زمان‌بندی نامعتبر یا خالی: "${CONFIG.schedule}")`);
    return;
  }
  cron.schedule(CONFIG.schedule, () => { fetchRates('scheduled', 'system').catch((e) => console.error('[pricing]', e.message)); });
  console.log(`[pricing] بروزرسانی خودکار قیمت فعال: "${CONFIG.schedule}" ${CONFIG.rateSourceUrl ? `← ${CONFIG.rateSourceUrl}` : '(بدون منبع خارجی)'}`);
}

/* ========================== ۷. منطق کالاها ============================= */

const PUBLIC_FIELDS = ['id', 'name', 'slug', 'sku', 'brand', 'category', 'status', 'shortDescription', 'description', 'price', 'compareAtPrice', 'pricingMode', 'stock', 'trackStock', 'specs', 'images', 'tags', 'weightGrams', 'dimensions', 'featured', 'createdAt', 'updatedAt', 'priceUpdatedAt'];

const toPublic = (p) => PUBLIC_FIELDS.reduce((acc, k) => { acc[k] = p[k]; return acc; }, {});
const allSlugs = (exceptId = null) => db.products.filter((p) => p.id !== exceptId).map((p) => p.slug);

function applyPricing(product, actor) {
  product.price = product.pricingMode === 'manual'
    ? product.manualPrice ?? product.price ?? 0
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
    id: id('prd'), name: input.name, slug,
    sku: input.sku || null, brand: input.brand || null, category: input.category || null,
    status: input.status || 'draft',
    shortDescription: input.shortDescription || null, description: input.description || null,
    cost: { amount: Number(input.cost?.amount ?? 0), currency: input.cost?.currency || 'IRR' },
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
  const product = db.products.find((p) => p.id === productId);
  if (!product) throw notFound('کالا یافت نشد');

  const data = compact(patch);
  if (data.slug !== undefined) data.slug = uniqueSlug(data.slug || product.name, allSlugs(productId));
  if (data.sku && db.products.some((p) => p.id !== productId && p.sku && String(p.sku).toLowerCase() === String(data.sku).toLowerCase())) {
    throw conflict(`کد کالای «${data.sku}» قبلاً استفاده شده است`);
  }
  if (data.cost) data.cost = { ...product.cost, ...data.cost };

  const next = { ...product, ...data, updatedAt: now(), updatedBy: actor || null };
  const pricingTouched = ['cost', 'marginPercent', 'pricingMode', 'manualPrice'].some((k) => data[k] !== undefined);
  if (pricingTouched) applyPricing(next, actor);

  db.products[db.products.findIndex((p) => p.id === productId)] = next;
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

function matchQuery(p, q) {
  const needle = q.trim().toLowerCase();
  return [p.name, p.sku, p.brand, p.category, p.slug, ...(p.tags || [])]
    .filter(Boolean).some((v) => String(v).toLowerCase().includes(needle));
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

/* ============================ ۸. مسیرها =============================== */

function buildApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  app.use(cors({ origin: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  if (CONFIG.env !== 'test') {
    app.use((req, res, next) => {
      const t = Date.now();
      res.on('finish', () => {
        const ms = Date.now() - t;
        const level = res.statusCode >= 400 ? '⚠️ ' : '  ';
        console.log(`${level}${req.method} ${req.originalUrl} ${res.statusCode} — ${ms}ms`);
      });
      next();
    });
  }

  /* -------- سلامت -------- */
  app.get('/api/health', (req, res) => res.json({
    ok: true,
    data: {
      status: 'ok', time: now(), products: db.products.length, admins: db.admins.length,
      baseCurrency: db.settings.baseCurrency, schedule: CONFIG.schedule || 'غیرفعال',
    },
  }));

  /* -------- احراز هویت -------- */
  app.post('/api/auth/login', limitLogin, validate(schemas.login), wrap(async (req, res) => {
    const user = db.admins.find((a) => a.email === req.body.email);
    if (!user || !(await bcrypt.compare(req.body.password, user.passwordHash))) throw unauthorized('ایمیل یا رمز عبور اشتباه است');
    if (!user.isActive) throw unauthorized('این حساب غیرفعال است');
    user.lastLoginAt = now();
    saveDb();
    res.json({ ok: true, data: { token: signToken(user), user: publicUser(user) } });
  }));

  app.post('/api/auth/logout', (req, res) => res.json({ ok: true, data: { message: 'خروج انجام شد. توکن را از مرورگر حذف کنید.' } }));

  app.get('/api/auth/me', authenticate, (req, res) => res.json({
    ok: true,
    data: {
      user: req.user,
      permissions: { products: true, pricing: true, manageAdmins: req.user.role === 'admin' },
    },
  }));

  app.post('/api/auth/change-password', authenticate, validate(schemas.changePassword), wrap(async (req, res) => {
    const admin = db.admins.find((a) => a.id === req.user.id);
    if (!(await bcrypt.compare(req.body.currentPassword, admin.passwordHash))) throw unauthorized('رمز فعلی اشتباه است');
    admin.passwordHash = await bcrypt.hash(req.body.newPassword, 12);
    admin.updatedAt = now();
    saveDb();
    res.json({ ok: true, data: { message: 'رمز عبور با موفقیت تغییر کرد' } });
  }));

  /* -------- کالاها -------- */
  app.get('/api/products', optionalAuth, validate(schemas.publicQuery, 'query'), (req, res) => {
    const isStaff = Boolean(req.user);
    let rows = isStaff ? [...db.products] : db.products.filter((p) => p.status === 'active');
    const q = (req.query.q || '').trim();
    if (q) rows = rows.filter((p) => matchQuery(p, q));
    if (req.query.category) rows = rows.filter((p) => p.category === req.query.category);
    if (req.query.brand) rows = rows.filter((p) => p.brand === req.query.brand);
    if (isStaff && req.query.status) rows = rows.filter((p) => p.status === req.query.status);
    if (isStaff && req.query.pricingMode) rows = rows.filter((p) => p.pricingMode === req.query.pricingMode);
    if (isStaff && req.query.lowStock) rows = rows.filter((p) => p.trackStock && p.stock <= (p.lowStockThreshold || 0));
    if (req.query.featured !== undefined) rows = rows.filter((p) => Boolean(p.featured) === req.query.featured);
    if (req.query.inStock) rows = rows.filter((p) => !p.trackStock || p.stock > 0);
    if (req.query.minPrice !== undefined) rows = rows.filter((p) => p.price >= req.query.minPrice);
    if (req.query.maxPrice !== undefined) rows = rows.filter((p) => p.price <= req.query.maxPrice);

    const page = paginate(sortRows(rows, req.query.sort), req.query);
    res.json({ ok: true, data: { ...page, items: isStaff ? page.items : page.items.map(toPublic) } });
  });

  app.get('/api/products/stats', authenticate, (req, res) => res.json({ ok: true, data: productStats() }));

  app.get('/api/products/categories', (req, res) => {
    const map = new Map();
    for (const p of db.products) if (p.category) map.set(p.category, (map.get(p.category) || 0) + 1);
    res.json({ ok: true, data: [...map].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count) });
  });

  app.post('/api/products/bulk', authenticate, validate(schemas.bulk), (req, res) => {
    const { ids, action, category, marginPercent } = req.body;
    const out = { affected: 0, deleted: 0, repriced: 0 };

    if (action === 'delete') {
      db.products = db.products.filter((p) => !ids.includes(p.id));
      db.priceHistory = db.priceHistory.filter((h) => !ids.includes(h.productId));
      saveDb();
      return res.json({ ok: true, data: { ...out, deleted: ids.length } });
    }
    if (action === 'reprice') {
      const { changes } = recalculate({ ids, reason: 'bulk', actor: req.user.email, save: false });
      saveDb();
      return res.json({ ok: true, data: { ...out, repriced: changes.length, affected: changes.length } });
    }

    for (const productId of ids) {
      const product = db.products.find((p) => p.id === productId);
      if (!product) continue;
      switch (action) {
        case 'activate': product.status = 'active'; break;
        case 'deactivate': product.status = 'draft'; break;
        case 'archive': product.status = 'archived'; break;
        case 'setCategory':
          if (!category) throw badRequest('دسته‌بندی جدید مشخص نشده است');
          product.category = category; break;
        case 'setMargin':
          if (marginPercent === undefined) throw badRequest('درصد سود مشخص نشده است');
          if (product.pricingMode === 'manual') break;
          product.marginPercent = marginPercent;
          applyPricing(product, req.user.email);
          break;
        default: throw badRequest('عملیات گروهی نامعتبر است');
      }
      product.updatedAt = now();
      product.updatedBy = req.user.email;
      out.affected += 1;
    }
    saveDb();
    res.json({ ok: true, data: out });
  });

  app.post('/api/products', authenticate, validate(schemas.createProduct), (req, res) => {
    res.status(201).json({ ok: true, data: createProduct(req.body, req.user.email) });
  });

  app.get('/api/products/:idOrSlug', optionalAuth, (req, res, next) => {
    const product = db.products.find((p) => p.id === req.params.idOrSlug || p.slug === req.params.idOrSlug);
    if (!product) return next(notFound('کالا یافت نشد'));
    if (product.status !== 'active' && !req.user) return next(notFound('کالا یافت نشد'));
    res.json({ ok: true, data: req.user ? product : toPublic(product) });
  });

  app.get('/api/products/:id/price-history', authenticate, (req, res) => {
    const limit = Number(req.query.limit) || 50;
    res.json({ ok: true, data: db.priceHistory.filter((h) => h.productId === req.params.id).slice(0, Math.min(500, limit)) });
  });

  app.patch('/api/products/:id', authenticate, validate(schemas.updateProduct), (req, res) => {
    res.json({ ok: true, data: updateProduct(req.params.id, req.body, req.user.email) });
  });

  app.delete('/api/products/:id', authenticate, requireAdmin, (req, res) => {
    const before = db.products.length;
    db.products = db.products.filter((p) => p.id !== req.params.id);
    if (db.products.length === before) throw notFound('کالا یافت نشد');
    db.priceHistory = db.priceHistory.filter((h) => h.productId !== req.params.id);
    saveDb();
    res.json({ ok: true, data: { message: 'کالا حذف شد' } });
  });

  /* -------- قیمت‌گذاری -------- */
  app.get('/api/pricing/settings', authenticate, (req, res) => res.json({
    ok: true,
    data: { baseCurrency: db.settings.baseCurrency, rates: { ...db.settings.rates }, rules: db.priceRules, lastRuns: db.priceRuns.slice(0, 10) },
  }));

  app.patch('/api/pricing/rules', authenticate, requireAdmin, validate(schemas.rules), (req, res) => {
    const rules = saveRules(req.body, req.user.email);
    const { run, changes } = recalculate({ reason: 'rules-updated', actor: req.user.email });
    res.json({ ok: true, data: { rules, run, changedCount: changes.length, changes: changes.slice(0, 50) } });
  });

  app.put('/api/pricing/rates', authenticate, requireAdmin, validate(schemas.rates), (req, res) => {
    const rates = saveRates(req.body.rates, req.user.email);
    const { run, changes } = recalculate({ reason: 'rate-updated', actor: req.user.email });
    res.json({ ok: true, data: { rates, run, changedCount: changes.length, changes: changes.slice(0, 50) } });
  });

  // وب‌هوک: یک سرویس خارجی بدون لاگین نرخ می‌فرستد ⇒ همهٔ قیمت‌ها خودکار بروز می‌شود
  app.post('/api/pricing/rates/webhook', validate(schemas.rates), (req, res, next) => {
    if (!CONFIG.webhookToken) return next(unauthorized('وب‌هوک قیمت غیرفعال است'));
    if (req.headers['x-price-token'] !== CONFIG.webhookToken) return next(unauthorized('توکن وب‌هوک نامعتبر است'));
    const rates = saveRates(req.body.rates, 'webhook');
    const { run, changes } = recalculate({ reason: 'webhook', actor: 'webhook' });
    res.json({ ok: true, data: { rates, run, changedCount: changes.length, changes: changes.slice(0, 50) } });
  });

  app.get('/api/pricing/preview', authenticate, (req, res) => res.json({ ok: true, data: previewPrices() }));

  app.post('/api/pricing/recalculate', authenticate, validate(schemas.recalc), (req, res) => {
    const { run, changes } = recalculate({ ids: req.body.ids, reason: req.body.reason || 'manual', actor: req.user.email });
    res.json({ ok: true, data: { run, changedCount: changes.length, changes: changes.slice(0, 500) } });
  });

  app.post('/api/pricing/fetch-rates', authenticate, requireAdmin, wrap(async (req, res, next) => {
    if (!CONFIG.rateSourceUrl) return next(badRequest('RATE_SOURCE_URL در تنظیمات تعریف نشده است'));
    res.json({ ok: true, data: await fetchRates('manual-fetch', req.user.email) });
  }));

  app.get('/api/pricing/history', authenticate, (req, res) => {
    const limit = Math.min(500, Number(req.query.limit) || 100);
    const rows = req.query.productId ? db.priceHistory.filter((h) => h.productId === req.query.productId) : db.priceHistory;
    res.json({ ok: true, data: rows.slice(0, limit) });
  });

  /* -------- کاربران (فقط مدیر ارشد) -------- */
  app.get('/api/admins', authenticate, requireAdmin, (req, res) => res.json({ ok: true, data: db.admins.map(publicUser) }));

  app.post('/api/admins', authenticate, requireAdmin, validate(schemas.createAdmin), wrap(async (req, res) => {
    if (db.admins.some((a) => a.email === req.body.email)) throw conflict('این ایمیل قبلاً ثبت شده است');
    const admin = {
      id: id('adm'), name: req.body.name, email: req.body.email, role: req.body.role,
      passwordHash: await bcrypt.hash(req.body.password, 12),
      isActive: true, createdAt: now(), updatedAt: now(), lastLoginAt: null,
    };
    db.admins.push(admin);
    saveDb();
    res.status(201).json({ ok: true, data: publicUser(admin) });
  }));

  app.patch('/api/admins/:id', authenticate, requireAdmin, validate(schemas.updateAdmin), wrap(async (req, res) => {
    const admin = db.admins.find((a) => a.id === req.params.id);
    if (!admin) throw notFound('کاربر یافت نشد');
    const next = { ...admin, ...req.body, updatedAt: now() };
    if (req.body.password) next.passwordHash = await bcrypt.hash(req.body.password, 12);
    if (req.body.email) {
      if (db.admins.some((a) => a.email === req.body.email && a.id !== admin.id)) throw conflict('این ایمیل قبلاً استفاده شده است');
      next.email = req.body.email;
    }
    const others = db.admins.filter((a) => a.role === 'admin' && a.id !== admin.id);
    if (!others.length && (next.role !== 'admin' || next.isActive === false)) throw badRequest('حداقل یک مدیر ارشد (admin) باید فعال باقی بماند');
    db.admins[db.admins.findIndex((a) => a.id === admin.id)] = next;
    saveDb();
    res.json({ ok: true, data: publicUser(next) });
  }));

  app.delete('/api/admins/:id', authenticate, requireAdmin, (req, res) => {
    const admin = db.admins.find((a) => a.id === req.params.id);
    if (!admin) throw notFound('کاربر یافت نشد');
    if (!db.admins.some((a) => a.role === 'admin' && a.id !== admin.id)) throw badRequest('آخرین مدیر ارشد را نمی‌توان حذف کرد');
    db.admins = db.admins.filter((a) => a.id !== admin.id);
    saveDb();
    res.json({ ok: true, data: { message: 'کاربر حذف شد' } });
  });

  /* -------- پنل ادمین -------- */
  const adminDir = path.join(__dirname, 'admin');
  app.use('/admin', ipAllowlist, express.static(adminDir, { extensions: ['html'] }), (req, res, next) => {
    if (req.path !== '/' && req.path !== '') return next();
    res.sendFile(path.join(adminDir, 'index.html'));
  });
  /* -------- سایت (فقط فایل‌های مجاز؛ کل پوشه باز نمی‌شود) -------- */
  const SITE_FILES = ['index.html', 'style.css', 'script.js', 'favicon.ico'];
  SITE_FILES.forEach((file) => {
    app.get(`/${file}`, (req, res, next) => {
      fs.access(path.join(__dirname, file), fs.constants.F_OK, (err) => (err ? next() : res.sendFile(path.join(__dirname, file))));
    });
  });
  app.get('/', (req, res, next) => {
    fs.access(path.join(__dirname, 'index.html'), fs.constants.F_OK, (err) => (err ? res.redirect('/admin') : res.sendFile(path.join(__dirname, 'index.html'))));
  });

  /* -------- خطاها -------- */
  app.use('/api', (req, res) => res.status(404).json({ ok: false, error: { message: 'مسیر یافت نشد', path: req.originalUrl } }));

  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    const status = err.status || 500;
    if (status >= 500 || CONFIG.env !== 'production') console.error(`[error] ${req.method} ${req.originalUrl} ->`, err.message);
    res.status(status).json({
      ok: false,
      error: {
        message: status >= 500 && CONFIG.env === 'production' ? 'خطای داخلی سرور' : err.message,
        details: err.details,
        stack: CONFIG.env === 'development' && status >= 500 ? err.stack : undefined,
      },
    });
  });

  return app;
}

/* ============================ ۹. اجرا ================================= */

async function main() {
  await loadDb();
  const app = buildApp();
  app.listen(CONFIG.port, '0.0.0.0', () => {
    console.log(`✅ سرور روی پورت ${CONFIG.port} اجرا شد`);
    console.log(`   پنل ادمین:  http://localhost:${CONFIG.port}/admin`);
    console.log(`   API عمومی:  http://localhost:${CONFIG.port}/api/products`);
    if (!db.admins.length) console.warn('⚠️  هیچ ادمینی ندارید. با «node server.js --create-admin نام ایمیل رمز» بسازید.');
    startScheduler();
  });
}

/* --- حالت‌های خط فرمان: ساخت ادمین / دادهٔ نمونه --- */
const argv = process.argv.slice(2);

async function cliCreateAdmin() {
  const [name, email, password, role = 'admin'] = argv.slice(1);
  if (!name || !email || !password) {
    console.log('کاربرد: node server.js --create-admin "نام" email@site.com رمزعبور [admin|editor]');
    process.exit(1);
  }
  await loadDb();
  if (db.admins.some((a) => a.email === String(email).toLowerCase())) throw new Error('این ایمیل قبلاً ثبت شده است');
  db.admins.push({
    id: id('adm'), name, email: String(email).toLowerCase(),
    role: role === 'editor' ? 'editor' : 'admin',
    passwordHash: await bcrypt.hash(password, 12),
    isActive: true, createdAt: now(), updatedAt: now(), lastLoginAt: null,
  });
  await persistDb();
  console.log(`✅ ادمین ساخته شد: ${email}`);
}

const SAMPLE_PRODUCTS = [
  { name: 'اشتراک تلگرام پریمیوم — ۳ ماهه', category: 'اشتراک', brand: 'Telegram', cost: { amount: 12, currency: 'USD' }, marginPercent: 25, stock: 40, lowStockThreshold: 5, featured: true, status: 'active', tags: ['پریمیوم', 'پرفروش'], shortDescription: 'فعالسازی روی اکانت شما، بدون نیاز به رمز عبور', specs: [{ key: 'مدت اعتبار', value: '۳ ماه' }, { key: 'زمان تحویل', value: '۵ تا ۳۰ دقیقه' }, { key: 'گارانتی', value: 'تا پایان دوره' }] },
  { name: 'اشتراک تلگرام پریمیوم — ۱۲ ماهه', category: 'اشتراک', brand: 'Telegram', cost: { amount: 38, currency: 'USD' }, marginPercent: 20, stock: 25, lowStockThreshold: 5, status: 'active', tags: ['پریمیوم', 'سالیانه'], specs: [{ key: 'مدت اعتبار', value: '۱۲ ماه' }, { key: 'پشتیبانی', value: '۲۴ ساعته' }] },
  { name: 'گیفت کارت اپل — ۵۰ دلار', category: 'گیفت کارت', brand: 'Apple', cost: { amount: 50, currency: 'USD' }, marginPercent: 12, stock: 12, lowStockThreshold: 3, status: 'active', tags: ['گیفت کارت'], specs: [{ key: 'مبلغ', value: '۵۰ دلار' }, { key: 'منطقه', value: 'USA' }] },
  { name: 'شارژ حساب کاربری — ۱۰۰ هزار تومان', category: 'شارژ', cost: { amount: 100000, currency: 'IRR' }, marginPercent: 10, stock: 999, status: 'active', tags: ['شارژ'], specs: [{ key: 'مبلغ', value: '۱۰۰٬۰۰۰ تومان' }] },
  { name: 'پک ویژه استیکر و تم', category: 'محتوا', cost: { amount: 5, currency: 'USD' }, marginPercent: 40, stock: 0, lowStockThreshold: 10, status: 'active', tags: ['استیکر'], specs: [{ key: 'تعداد آیتم', value: '۳۰+' }] },
  { name: 'اشتراک آزمایشی ۷ روزه', category: 'اشتراک', cost: { amount: 3, currency: 'USD' }, stock: 5, status: 'draft', tags: ['آزمایشی'], specs: [{ key: 'مدت اعتبار', value: '۷ روز' }] },
];

async function cliSeed() {
  await loadDb();
  const email = process.env.ADMIN_EMAIL || 'admin@shop.local';
  const password = process.env.ADMIN_PASSWORD || 'admin12345';
  if (!db.admins.length) {
    db.admins.push({
      id: id('adm'), name: 'مدیر اصلی', email, role: 'admin',
      passwordHash: await bcrypt.hash(password, 12),
      isActive: true, createdAt: now(), updatedAt: now(), lastLoginAt: null,
    });
    console.log(`✅ ادمین ساخته شد: ${email} / ${password}`);
  } else {
    console.log('ادمین از قبل وجود دارد — رد شد.');
  }
  if (!db.products.length) {
    SAMPLE_PRODUCTS.forEach((p) => createProduct(p, 'seed'));
    console.log(`✅ ${SAMPLE_PRODUCTS.length} کالای نمونه ساخته شد.`);
  } else {
    console.log('کالا از قبل وجود دارد — رد شد.');
  }
  console.log(`\nورود: http://localhost:${CONFIG.port}/admin  ←  ${email} / ${password}`);
}

if (require.main === module) {
  (async () => {
    if (argv[0] === '--create-admin') return cliCreateAdmin();
    if (argv[0] === '--seed') return cliSeed();
    return main();
  })().catch((err) => {
    console.error('❌ خطا:', err.message);
    process.exit(1);
  });
}

module.exports = { buildApp, loadDb, CONFIG, get db() { return db; } };
