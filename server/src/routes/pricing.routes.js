'use strict';

const express = require('express');
const { z } = require('zod');
const db = require('../db/database');
const config = require('../config');
const pricing = require('../services/pricing.service');
const { fetchRates } = require('../jobs/priceScheduler');
const { authenticate, requireRole } = require('../middleware/auth');
const validate = require('../middleware/validate');
const asyncHandler = require('../lib/asyncHandler');
const { badRequest, unauthorized } = require('../lib/httpError');

const router = express.Router();

const rulesSchema = z
  .object({
    defaultMarginPercent: z.coerce.number().finite().min(-100).max(1000).optional(),
    taxPercent: z.coerce.number().finite().min(0).max(100).optional(),
    minProfitAmount: z.coerce.number().finite().min(0).optional(),
    rounding: z
      .object({
        mode: z.enum(pricing.ROUNDING_MODES).optional(),
        to: z.coerce.number().min(0).optional(),
      })
      .optional(),
  })
  .strict();

const ratesSchema = z.object({
  rates: z
    .record(z.coerce.number().positive('نرخ ارز باید عددی مثبت باشد'))
    .refine((obj) => Object.keys(obj).length > 0, { message: 'حداقل یک نرخ ارز ارسال کنید' }),
});

const recalcSchema = z
  .object({
    ids: z.array(z.string().min(1)).max(500).optional(),
    reason: z.string().max(80).optional(),
  })
  .optional()
  .default({});

/** نمایش تنظیمات فعلی (ارز پایه، نرخ‌ها، قوانین) */
router.get(
  '/settings',
  authenticate,
  (req, res) => {
    res.json({
      ok: true,
      data: {
        ...pricing.getSettings(),
        lastRuns: db.data.priceRuns.slice(0, 10),
      },
    });
  }
);

/** بروزرسانی قوانین محاسبه + اجرای فوریِ محاسبهٔ مجدد */
router.patch(
  '/rules',
  authenticate,
  requireRole('admin'),
  validate(rulesSchema),
  (req, res) => {
    const rules = pricing.saveRules(req.body, req.user.email);
    const { run, changes } = pricing.recalculate({ reason: 'rules-updated', actor: req.user.email });
    res.json({ ok: true, data: { rules, run, changedCount: changes.length, changes: changes.slice(0, 50) } });
  }
);

/** بروزرسانی نرخ ارز + محاسبهٔ خودکار تمام قیمت‌ها */
router.put(
  '/rates',
  authenticate,
  requireRole('admin'),
  validate(ratesSchema),
  (req, res) => {
    const rates = pricing.saveRates(req.body.rates, req.user.email);
    const { run, changes } = pricing.recalculate({ reason: 'rate-updated', actor: req.user.email });
    res.json({ ok: true, data: { rates, run, changedCount: changes.length, changes: changes.slice(0, 50) } });
  }
);

/**
 * وب‌هوک دریافت نرخ ارز — برای اینکه یک سرویس خارجی/cron بتواند بدون لاگین
 * نرخ‌ها را بفرستد. با هدر x-price-token احراز هویت می‌شود
 * (اگر PRICE_WEBHOOK_TOKEN در .env خالی باشد غیرفعال است).
 */
router.post(
  '/rates/webhook',
  validate(ratesSchema),
  (req, res, next) => {
    const provided = req.headers['x-price-token'];
    if (!config.pricing.webhookToken) return next(unauthorized('وب‌هوک قیمت غیرفعال است'));
    if (provided !== config.pricing.webhookToken) return next(unauthorized('توکن وب‌هوک نامعتبر است'));
    const rates = pricing.saveRates(req.body.rates, 'webhook');
    const { run, changes } = pricing.recalculate({ reason: 'webhook', actor: 'webhook' });
    res.json({ ok: true, data: { rates, run, changedCount: changes.length, changes: changes.slice(0, 50) } });
  }
);

/** پیش‌نمایش تغییرات قیمت بدون ذخیره */
router.get(
  '/preview',
  authenticate,
  (req, res) => {
    res.json({ ok: true, data: pricing.preview() });
  }
);

/** اجرای دستیِ محاسبهٔ مجدد */
router.post(
  '/recalculate',
  authenticate,
  validate(recalcSchema),
  (req, res) => {
    const { run, changes } = pricing.recalculate({
      ids: req.body.ids,
      reason: req.body.reason || 'manual',
      actor: req.user.email,
    });
    res.json({ ok: true, data: { run, changedCount: changes.length, changes: changes.slice(0, 500) } });
  }
);

/** همین حالا نرخ را از منبع خارجی بگیر و اعمال کن */
router.post(
  '/fetch-rates',
  authenticate,
  requireRole('admin'),
  asyncHandler(async (req, res, next) => {
    if (!config.pricing.rateSourceUrl) {
      return next(badRequest('RATE_SOURCE_URL در تنظیمات تعریف نشده است'));
    }
    const result = await fetchRates('manual-fetch', req.user.email);
    res.json({ ok: true, data: result });
  })
);

/** تاریخچه تغییرات قیمت */
router.get(
  '/history',
  authenticate,
  (req, res) => {
    const limit = Number(req.query.limit) || 100;
    const productId = req.query.productId || null;
    res.json({ ok: true, data: pricing.history({ productId, limit }) });
  }
);

module.exports = router;
