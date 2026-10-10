'use strict';

const crypto = require('crypto');

const id = (prefix = 'id') => `${prefix}_${crypto.randomBytes(9).toString('hex')}`;

const now = () => new Date().toISOString();

/** ساخت slug از متن (فارسی/انگلیسی) */
function slugify(input, fallback = 'item') {
  const raw = String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    // حروف فارسی/عربی و انگلیسی و اعداد و خط تیره را نگه می‌داریم
    .replace(/[^\p{L}\p{N}-]+/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
  return raw || `${fallback}-${crypto.randomBytes(3).toString('hex')}`;
}

/** یک slug یکتا نسبت به لیست موجود */
function uniqueSlug(desired, existing) {
  const base = slugify(desired);
  let candidate = base;
  let n = 2;
  while (existing.includes(candidate)) {
    candidate = `${base}-${n}`;
    n += 1;
  }
  return candidate;
}

/** حذف فیلدهای undefined از آبجکت (برای PATCH) */
function compact(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

function paginate(list, { page = 1, limit = 20 } = {}) {
  const p = Math.max(1, Number(page) || 1);
  const l = Math.min(200, Math.max(1, Number(limit) || 20));
  const start = (p - 1) * l;
  return {
    items: list.slice(start, start + l),
    page: p,
    limit: l,
    total: list.length,
    totalPages: Math.max(1, Math.ceil(list.length / l)),
  };
}

module.exports = { id, now, slugify, uniqueSlug, compact, paginate };
