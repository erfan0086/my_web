'use strict';

/** رَپر برای هدایت خودکار خطاهای async به میان‌افزار خطا */
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = asyncHandler;
