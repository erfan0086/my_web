'use strict';

const { badRequest } = require('../lib/httpError');

/** اعتبارسنجی بدنه/کوئری با اسکیمای zod و جایگزینی دادهٔ پاک‌شده */
function validate(schema, source = 'body') {
  return (req, res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      const details = result.error.issues.map((i) => ({
        field: i.path.join('.'),
        message: i.message,
      }));
      const first = details[0];
      return next(
        badRequest(first ? `${first.field}: ${first.message}` : 'داده‌های ورودی نامعتبر است', details)
      );
    }
    req[source] = result.data;
    return next();
  };
}

module.exports = validate;
