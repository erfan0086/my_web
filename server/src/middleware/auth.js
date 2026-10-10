'use strict';

const authService = require('../services/auth.service');
const { unauthorized, forbidden } = require('../lib/httpError');

/** خواندن توکن از هدر Authorization: Bearer <token> */
function extractToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  if (req.query && typeof req.query.token === 'string') return req.query.token;
  return null;
}

function authenticate(req, res, next) {
  const token = extractToken(req);
  if (!token) return next(unauthorized('توکن ارسال نشده است'));

  try {
    const payload = authService.verifyToken(token);
    const user = authService.findById(payload.sub);
    if (!user) return next(unauthorized('کاربر مرتبط با توکن یافت نشد'));
    if (!user.isActive) return next(unauthorized('حساب کاربری غیرفعال است'));
    req.user = { id: user.id, name: user.name, email: user.email, role: user.role };
    return next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') return next(unauthorized('توکن منقضی شده است'));
    return next(unauthorized('توکن نامعتبر است'));
  }
}

/** احراز هویت اختیاری — اگر توکن بود کاربر ست می‌شود، در غیر این صورت عبور می‌کند */
function optionalAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) return next();
  try {
    const payload = authService.verifyToken(token);
    const user = authService.findById(payload.sub);
    if (user && user.isActive) {
      req.user = { id: user.id, name: user.name, email: user.email, role: user.role };
    }
  } catch (_) {
    /* توکن نامعتبر = کاربر مهمان */
  }
  return next();
}

/** محدود کردن به نقش‌های مشخص: requireRole('admin') */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) {
      return next(forbidden('دسترسی فقط برای مدیر ارشد مجاز است'));
    }
    return next();
  };
}

/** محدود کردن IP برای دسترسی به پنل (اگر در .env تنظیم شده باشد) */
function ipAllowlist(req, res, next) {
  const list = require('../config').adminIpAllowlist;
  if (!list.length) return next();
  const ip = (req.ip || '').replace('::ffff:', '');
  if (!list.includes(ip)) return next(forbidden(`دسترسی از IP ${ip} مجاز نیست`));
  return next();
}

module.exports = { authenticate, optionalAuth, requireRole, ipAllowlist };
