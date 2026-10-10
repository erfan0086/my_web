'use strict';

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const badRequest = (msg = 'درخواست نامعتبر است', details) => new HttpError(400, msg, details);
const unauthorized = (msg = 'احراز هویت انجام نشده است') => new HttpError(401, msg);
const forbidden = (msg = 'دسترسی مجاز نیست') => new HttpError(403, msg);
const notFound = (msg = 'موردی یافت نشد') => new HttpError(404, msg);
const conflict = (msg = 'تداخل در داده‌ها') => new HttpError(409, msg);

module.exports = { HttpError, badRequest, unauthorized, forbidden, notFound, conflict };
