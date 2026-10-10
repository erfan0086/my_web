'use strict';

/**
 * موتور قیمت‌گذاری خودکار
 * ----------------------
 * فرمول (همه‌چیز در «ارز پایه» محاسبه می‌شود):
 *
 *   قیمت تمام‌شده در ارز پایه = cost.amount × نرخ ارز محصول
 *   بعد از سود                 = قیمت تمام‌شده × (1 + درصد سود / 100)
 *   بعد از مالیات              = بعد از سود × (1 + درصد مالیات / 100)
 *   اعمال حداقل سود           = max(بعد از مالیات، قیمت تمام‌شده + حداقل سود)
 *   قیمت نهایی                = گرد کردن(مقدار بالا)
 *
 * اگر محصول در حالت manual باشد، فقط manualPrice ثبت می‌شود و قوانین اعمال نمی‌شود.
 */

const db = require('../db/database');
const { id, now } = require('../lib/utils');
const { badRequest } = require('../lib/httpError');

const HISTORY_LIMIT = 2000;
const RUNS_LIMIT = 100;
const ROUNDING_MODES = ['none', 'nearest', 'up', 'down'];

function getSettings() {
  return {
    baseCurrency: db.data.settings.baseCurrency,
    rates: { ...db.data.settings.rates },
    rules: { ...db.data.priceRules },
  };
}

function normalizeRules(input = {}) {
  const current = db.data.priceRules;
  const next = { ...current };

  if (input.defaultMarginPercent !== undefined && input.defaultMarginPercent !== null) {
    const v = Number(input.defaultMarginPercent);
    if (!Number.isFinite(v) || v < -100 || v > 1000) {
      throw badRequest('درصد سود باید عددی بین ‎-100‎ و 1000 باشد');
    }
    next.defaultMarginPercent = v;
  }
  if (input.taxPercent !== undefined && input.taxPercent !== null) {
    const v = Number(input.taxPercent);
    if (!Number.isFinite(v) || v < 0 || v > 100) {
      throw badRequest('درصد مالیات باید عددی بین 0 و 100 باشد');
    }
    next.taxPercent = v;
  }
  if (input.minProfitAmount !== undefined && input.minProfitAmount !== null) {
    const v = Number(input.minProfitAmount);
    if (!Number.isFinite(v) || v < 0) {
      throw badRequest('حداقل سود باید عددی نامنفی باشد');
    }
    next.minProfitAmount = v;
  }
  if (input.rounding !== undefined && input.rounding !== null) {
    const mode = input.rounding.mode || current.rounding.mode;
    if (!ROUNDING_MODES.includes(mode)) {
      throw badRequest(`حالت گرد کردن نامعتبر است (مجاز: ${ROUNDING_MODES.join('، ')})`);
    }
    const to = Number(input.rounding.to ?? current.rounding.to ?? 0);
    if (!Number.isFinite(to) || to < 0) {
      throw badRequest('واحد گرد کردن باید عددی نامنفی باشد');
    }
    next.rounding = { mode, to };
  }
  return next;
}

function saveRules(input, actor) {
  const next = normalizeRules(input);
  next.updatedAt = now();
  next.updatedBy = actor || null;
  db.data.priceRules = next;
  return next;
}

function normalizeRates(input = {}) {
  const clean = {};
  for (const [code, value] of Object.entries(input)) {
    const key = String(code || '').trim().toUpperCase();
    const v = Number(value);
    if (!/^[A-Z]{3}$/.test(key)) {
      throw badRequest(`کد ارز نامعتبر: ${code} (باید ۳ حرف لاتین باشد)`);
    }
    if (!Number.isFinite(v) || v <= 0) {
      throw badRequest(`نرخ ارز ${key} باید عددی مثبت باشد`);
    }
    clean[key] = v;
  }
  return clean;
}

function saveRates(input, actor) {
  const clean = normalizeRates(input);
  const base = db.data.settings.baseCurrency;
  clean[base] = 1;
  db.data.settings.rates = clean;
  db.data.settings.updatedAt = now();
  db.data.settings.updatedBy = actor || null;
  return { ...clean };
}

function rateOf(currency) {
  const code = String(currency || db.data.settings.baseCurrency).toUpperCase();
  const rate = db.data.settings.rates[code];
  if (rate === undefined) {
    throw badRequest(`نرخ ارز «${code}» تعریف نشده است. ابتدا آن را در تنظیمات قیمت‌گذاری ثبت کنید.`);
  }
  return Number(rate);
}

function roundByMode(value, { mode, to }) {
  const unit = Number(to) || 0;
  if (!unit || mode === 'none') return Math.round(value);
  const divided = value / unit;
  switch (mode) {
    case 'up':
      return Math.ceil(divided) * unit;
    case 'down':
      return Math.floor(divided) * unit;
    case 'nearest':
    default:
      return Math.round(divided) * unit;
  }
}

/**
 * محاسبهٔ قیمت یک محصول بدون ذخیره‌سازی.
 * خروجی شامل جزئیات (breakdown) است تا در پنل قابل نمایش باشد.
 */
function calculatePrice(product) {
  const rules = db.data.priceRules;
  const baseCurrency = db.data.settings.baseCurrency;
  const costAmount = Number(product?.cost?.amount ?? 0);
  const costCurrency = (product?.cost?.currency || baseCurrency).toUpperCase();
  const rate = rateOf(costCurrency);

  const costInBase = costAmount * rate;
  const marginPercent =
    product?.marginPercent === null || product?.marginPercent === undefined
      ? rules.defaultMarginPercent
      : Number(product.marginPercent);

  const afterMargin = costInBase * (1 + marginPercent / 100);
  const taxAmount = afterMargin * (Number(rules.taxPercent) / 100);
  const afterTax = afterMargin + taxAmount;

  const floorPrice = rules.minProfitAmount > 0 ? costInBase + Number(rules.minProfitAmount) : null;
  const beforeRounding = floorPrice !== null ? Math.max(afterTax, floorPrice) : afterTax;
  const price = roundByMode(beforeRounding, rules.rounding);

  return {
    price,
    breakdown: {
      baseCurrency,
      costAmount,
      costCurrency,
      rate,
      costInBase: Math.round(costInBase),
      marginPercent,
      afterMargin: Math.round(afterMargin),
      taxPercent: rules.taxPercent,
      taxAmount: Math.round(taxAmount),
      minProfitApplied: floorPrice !== null && floorPrice > afterTax,
      beforeRounding: Math.round(beforeRounding),
      rounding: rules.rounding,
      profit: Math.round(price / (1 + Number(rules.taxPercent) / 100) - costInBase),
    },
  };
}

function pushHistory(entry) {
  db.data.priceHistory.unshift(entry);
  if (db.data.priceHistory.length > HISTORY_LIMIT) {
    db.data.priceHistory.length = HISTORY_LIMIT;
  }
}

/**
 * محاسبهٔ مجدد قیمت همه (یا بخشی از) محصولاتِ حالتِ خودکار.
 * فقط محصولاتی که قیمتشان واقعاً تغییر کرده در تاریخچه ثبت می‌شوند.
 */
function recalculate({ ids = null, reason = 'manual', actor = null, save = true } = {}) {
  const targetIds = ids && ids.length ? new Set(ids) : null;
  const ratesSnapshot = { ...db.data.settings.rates };
  const changes = [];
  let scanned = 0;
  let skippedManual = 0;
  let errors = 0;

  for (const product of db.data.products) {
    if (targetIds && !targetIds.has(product.id)) continue;
    scanned += 1;

    if (product.pricingMode === 'manual') {
      skippedManual += 1;
      continue;
    }

    try {
      const { price } = calculatePrice(product);
      const oldPrice = Number(product.price);
      if (price !== oldPrice) {
        product.price = price;
        product.priceUpdatedAt = now();
        product.updatedAt = now();
        product.updatedBy = actor;
        const delta = price - oldPrice;
        pushHistory({
          id: id('ph'),
          productId: product.id,
          productName: product.name,
          sku: product.sku || null,
          oldPrice,
          newPrice: price,
          delta,
          deltaPercent: oldPrice > 0 ? Number(((delta / oldPrice) * 100).toFixed(2)) : null,
          reason,
          actor,
          ratesSnapshot,
          at: now(),
        });
        changes.push({
          productId: product.id,
          name: product.name,
          sku: product.sku || null,
          oldPrice,
          newPrice: price,
          delta,
        });
      }
    } catch (err) {
      errors += 1;
      // نرخ یک ارز ممکن است تعریف نشده باشد -> بقیه محصولات متوقف نمی‌شوند
      console.warn(`[pricing] محصول ${product.id} محاسبه نشد: ${err.message}`);
    }
  }

  const run = {
    id: id('run'),
    at: now(),
    reason,
    actor,
    scanned,
    changed: changes.length,
    skippedManual,
    errors,
  };
  db.data.priceRuns.unshift(run);
  if (db.data.priceRuns.length > RUNS_LIMIT) db.data.priceRuns.length = RUNS_LIMIT;

  if (save) db.save();
  return { run, changes };
}

/** پیش‌نمایش: چه محصولاتی تغییر قیمت خواهند داشت (بدون ذخیره) */
function preview() {
  const rows = [];
  let changed = 0;
  let errors = 0;
  for (const product of db.data.products) {
    if (product.pricingMode === 'manual') {
      rows.push({ productId: product.id, name: product.name, mode: 'manual', oldPrice: product.price, newPrice: product.manualPrice ?? product.price, changed: false });
      continue;
    }
    try {
      const { price, breakdown } = calculatePrice(product);
      const isChanged = price !== Number(product.price);
      if (isChanged) changed += 1;
      rows.push({
        productId: product.id,
        name: product.name,
        sku: product.sku || null,
        mode: 'auto',
        oldPrice: Number(product.price),
        newPrice: price,
        changed: isChanged,
        breakdown,
      });
    } catch (err) {
      errors += 1;
      rows.push({ productId: product.id, name: product.name, mode: 'auto', error: err.message });
    }
  }
  return { rows, changed, errors, rules: db.data.priceRules, rates: db.data.settings.rates };
}

function history({ productId, limit = 100 } = {}) {
  let rows = db.data.priceHistory;
  if (productId) rows = rows.filter((r) => r.productId === productId);
  return rows.slice(0, Math.min(500, Number(limit) || 100));
}

module.exports = {
  getSettings,
  saveRules,
  saveRates,
  normalizeRates,
  calculatePrice,
  recalculate,
  preview,
  history,
  rateOf,
  roundByMode,
  ROUNDING_MODES,
};
