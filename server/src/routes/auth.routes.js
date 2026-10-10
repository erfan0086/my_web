'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const authService = require('../services/auth.service');
const { authenticate } = require('../middleware/auth');
const validate = require('../middleware/validate');
const asyncHandler = require('../lib/asyncHandler');
const { loginSchema, changePasswordSchema } = require('../lib/schemas');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: { message: 'تلاش‌های ورود زیاد است. کمی بعد دوباره امتحان کنید.' } },
});

/** ورود ادمین */
router.post(
  '/login',
  loginLimiter,
  validate(loginSchema),
  asyncHandler(async (req, res) => {
    const result = await authService.login(req.body.email, req.body.password);
    res.json({ ok: true, data: result });
  })
);

router.post(
  '/logout',
  (req, res) => {
    // توکن در سمت کلاینت نگهداری می‌شود؛ این اندپوینت فقط برای وضوحِ جریان کار است.
    res.json({ ok: true, data: { message: 'خروج انجام شد. توکن را از مرورگر حذف کنید.' } });
  }
);

/** اطلاعات کاربر جاری */
router.get(
  '/me',
  authenticate,
  (req, res) => {
    res.json({ ok: true, data: { user: req.user, permissions: permissionsOf(req.user.role) } });
  }
);

router.post(
  '/change-password',
  authenticate,
  validate(changePasswordSchema),
  asyncHandler(async (req, res) => {
    await authService.changePassword(req.user.id, req.body.currentPassword, req.body.newPassword);
    res.json({ ok: true, data: { message: 'رمز عبور با موفقیت تغییر کرد' } });
  })
);

function permissionsOf(role) {
  return {
    products: ['editor', 'admin'].includes(role),
    pricing: ['editor', 'admin'].includes(role),
    manageAdmins: role === 'admin',
  };
}

module.exports = router;
