'use strict';

const config = require('../config');

// eslint-disable-next-line no-unused-vars
function notFoundHandler(req, res, next) {
  res.status(404).json({ ok: false, error: { message: 'مسیر یافت نشد', path: req.originalUrl } });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const status = err.status || 500;
  const isServerError = status >= 500;

  if (isServerError || config.env !== 'production') {
    console.error(`[error] ${req.method} ${req.originalUrl} ->`, err);
  }

  res.status(status).json({
    ok: false,
    error: {
      message: isServerError && config.env === 'production' ? 'خطای داخلی سرور' : err.message,
      details: err.details || undefined,
      stack: config.env === 'development' && isServerError ? err.stack : undefined,
    },
  });
}

module.exports = { errorHandler, notFoundHandler };
