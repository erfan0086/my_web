'use strict';

const path = require('path');
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

const config = require('./config');
const db = require('./db/database');
const routes = {
  auth: require('./routes/auth.routes'),
  products: require('./routes/product.routes'),
  pricing: require('./routes/pricing.routes'),
  admins: require('./routes/admin.routes'),
};
const { errorHandler, notFoundHandler } = require('./middleware/error');
const { ipAllowlist } = require('./middleware/auth');
const { startScheduler } = require('./jobs/priceScheduler');

async function main() {
  await db.load();

  const app = express();
  // 1 = اعتماد به یک لایه پروکسی (برای دریافت IP واقعی پشت reverse proxy)
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  app.use(cors({ origin: true, credentials: false }));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  if (config.env !== 'test') app.use(morgan(config.env === 'production' ? 'combined' : 'dev'));

  // ---- API ----
  app.get('/api/health', (req, res) => {
    res.json({
      ok: true,
      data: {
        status: 'ok',
        time: new Date().toISOString(),
        products: db.data.products.length,
        admins: db.data.admins.length,
        baseCurrency: db.data.settings.baseCurrency,
        schedule: config.pricing.schedule,
      },
    });
  });

  app.use('/api/auth', routes.auth);
  app.use('/api/products', routes.products);
  app.use('/api/pricing', routes.pricing);
  app.use('/api/admins', routes.admins);

  app.use('/api', notFoundHandler);

  // ---- پنل ادمین (فایل‌های استاتیک) ----
  const adminDir = path.join(__dirname, '..', 'admin');
  app.use(
    '/admin',
    ipAllowlist,
    express.static(adminDir, { extensions: ['html'], fallthrough: true }),
    (req, res, next) => {
      if (req.path !== '/' && req.path !== '') return next();
      res.sendFile(path.join(adminDir, 'index.html'));
    }
  );

  app.get('/', (req, res) => res.redirect('/admin'));

  app.use(errorHandler);

  app.listen(config.port, '0.0.0.0', () => {
    console.log(`✅ سرور روی پورت ${config.port} اجرا شد`);
    console.log(`   پنل ادمین: http://localhost:${config.port}/admin`);
    console.log(`   API عمومی: http://localhost:${config.port}/api/products`);
    if (!db.data.admins.length) {
      console.warn('⚠️  هیچ ادمینی وجود ندارد. با اجرای «npm run create-admin» اولین ادمین را بسازید.');
    }
  });

  startScheduler();
}

main().catch((err) => {
  console.error('خطا در راه‌اندازی سرور:', err);
  process.exit(1);
});
