'use strict';

/**
 * زمان‌بند بروزرسانی خودکار قیمت
 * ------------------------------
 * اگر RATE_SOURCE_URL در .env تنظیم شده باشد، طبق زمان‌بندی PRICE_SCHEDULE
 * نرخ ارز را از آن آدرس می‌گیرد و بلافاصله همهٔ قیمت‌ها را دوباره محاسبه می‌کند.
 * در غیر این صورت، زمان‌بند فقط محاسبهٔ مجدد را (با نرخ‌های فعلی) تکرار می‌کند.
 */

const cron = require('node-cron');
const config = require('../config');
const pricing = require('../services/pricing.service');
const { badRequest } = require('../lib/httpError');

/** استخراج نرخ‌ها از پاسخ JSON منبع — چند قالب رایج را پشتیبانی می‌کند */
function extractRates(payload) {
  const candidates = [payload, payload?.rates, payload?.data, payload?.data?.rates, payload?.result];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const entries = Object.entries(candidate).filter(
      ([, v]) => v !== null && v !== '' && Number.isFinite(Number(v)) && Number(v) > 0
    );
    // فقط کلیدهایی که شبیه کد ارز ۳ حرفی هستند
    const rateLike = entries.filter(([k]) => /^[A-Za-z]{3}$/.test(String(k)));
    if (rateLike.length) {
      return Object.fromEntries(rateLike.map(([k, v]) => [String(k).toUpperCase(), Number(v)]));
    }
  }
  return null;
}

async function fetchRates(reason = 'scheduler', actor = 'system') {
  const url = config.pricing.rateSourceUrl;
  if (!url) {
    // بدون منبع خارجی: فقط با نرخ‌های فعلی دوباره محاسبه می‌کنیم
    const { run, changes } = pricing.recalculate({ reason: `${reason} (بدون منبع خارجی)`, actor });
    return { fetched: false, rates: pricing.getSettings().rates, run, changedCount: changes.length };
  }

  let payload;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`پاسخ ناموفق از منبع نرخ: ${res.status}`);
    payload = await res.json();
  } catch (err) {
    console.error(`[scheduler] دریافت نرخ ناموفق بود: ${err.message}`);
    return { fetched: false, error: err.message };
  }

  const rates = extractRates(payload);
  if (!rates) throw badRequest('قالب پاسخ منبع نرخ قابل تشخیص نیست');

  const saved = pricing.saveRates(rates, actor);
  const { run, changes } = pricing.recalculate({ reason, actor });
  console.log(
    `[scheduler] بروزرسانی خودکار (${Object.keys(rates).join('، ')}) — ${changes.length} تغییر قیمت`
  );
  return { fetched: true, rates: saved, run, changedCount: changes.length, changes: changes.slice(0, 50) };
}

function startScheduler() {
  const expr = config.pricing.schedule;
  if (!cron.validate(expr)) {
    console.warn(`[scheduler] زمان‌بندی نامعتبر است (${expr}) — زمان‌بند غیرفعال شد`);
    return null;
  }

  const task = cron.schedule(expr, async () => {
    try {
      await fetchRates('scheduled', 'system');
    } catch (err) {
      console.error('[scheduler] خطا در اجرای زمان‌بند:', err.message);
    }
  });

  console.log(`[scheduler] بروزرسانی خودکار قیمت فعال است: "${expr}"`);
  if (config.pricing.rateSourceUrl) {
    console.log(`[scheduler] منبع نرخ: ${config.pricing.rateSourceUrl}`);
  } else {
    console.log('[scheduler] منبع نرخ خارجی تنظیم نشده — فقط محاسبهٔ مجدد انجام می‌شود');
  }
  return task;
}

module.exports = { startScheduler, fetchRates, extractRates };
