'use strict';

const express = require('express');
const productService = require('../services/product.service');
const pricing = require('../services/pricing.service');
const { authenticate, optionalAuth, requireRole } = require('../middleware/auth');
const validate = require('../middleware/validate');
const asyncHandler = require('../lib/asyncHandler');
const {
  createProductSchema,
  updateProductSchema,
  bulkSchema,
  publicQuerySchema,
} = require('../lib/schemas');
const { notFound, forbidden } = require('../lib/httpError');

const router = express.Router();

const isStaff = (req) => Boolean(req.user);

/**
 * لیست کالاها
 * - کاربر عادی: فقط کالاهای منتشرشده و بدون فیلدهای محرمانه
 * - ادمین/ویرایشگر: همهٔ کالاها با قیمت خرید و حاشیهٔ سود
 */
router.get(
  '/',
  optionalAuth,
  validate(publicQuerySchema, 'query'),
  (req, res) => {
    if (isStaff(req)) {
      const result = productService.list(req.query);
      return res.json({
        ok: true,
        data: { ...result, items: result.items.map(productService.toAdminJson) },
      });
    }
    const result = productService.listPublic(req.query);
    return res.json({ ok: true, data: result });
  }
);

/** آمار داشبورد (فقط ادمین) */
router.get(
  '/stats',
  authenticate,
  (req, res) => {
    res.json({ ok: true, data: productService.stats() });
  }
);

router.get(
  '/categories',
  (req, res) => {
    const map = new Map();
    for (const p of require('../db/database').data.products) {
      if (!p.category) continue;
      map.set(p.category, (map.get(p.category) || 0) + 1);
    }
    res.json({
      ok: true,
      data: [...map.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    });
  }
);

/** عملیات گروهی (ادمین) */
router.post(
  '/bulk',
  authenticate,
  validate(bulkSchema),
  (req, res) => {
    const result = productService.bulk(req.body, req.user.email);
    res.json({ ok: true, data: result });
  }
);

/** ایجاد کالا */
router.post(
  '/',
  authenticate,
  validate(createProductSchema),
  (req, res) => {
    const product = productService.create(req.body, req.user.email);
    res.status(201).json({ ok: true, data: product });
  }
);

/** دریافت یک کالا با id یا slug */
router.get(
  '/:idOrSlug',
  optionalAuth,
  (req, res, next) => {
    const product = productService.getById(req.params.idOrSlug);
    if (product.status !== 'active' && !isStaff(req)) return next(notFound('کالا یافت نشد'));
    const payload = isStaff(req) ? productService.toAdminJson(product) : productService.toPublicJson(product);
    res.json({ ok: true, data: payload });
  }
);

/** بروزرسانی کالا */
router.patch(
  '/:id',
  authenticate,
  validate(updateProductSchema),
  (req, res) => {
    const product = productService.update(req.params.id, req.body, req.user.email);
    res.json({ ok: true, data: product });
  }
);

/** حذف کالا — فقط مدیر ارشد */
router.delete(
  '/:id',
  authenticate,
  requireRole('admin'),
  (req, res, next) => {
    if (!req.user || req.user.role !== 'admin') return next(forbidden());
    productService.remove(req.params.id, req.user.email);
    res.json({ ok: true, data: { message: 'کالا حذف شد' } });
  }
);

/** تاریخچهٔ قیمت یک کالا */
router.get(
  '/:id/price-history',
  authenticate,
  (req, res) => {
    const limit = Number(req.query.limit) || 50;
    res.json({ ok: true, data: pricing.history({ productId: req.params.id, limit }) });
  }
);

module.exports = router;
