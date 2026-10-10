'use strict';

/** ساخت ادمین از خط فرمان: node scripts/create-admin.js name email password [admin|editor] */

const [, , name, email, password, role = 'admin'] = process.argv;
const db = require('../src/db/database');
const authService = require('../src/services/auth.service');

(async () => {
  if (!name || !email || !password) {
    console.log('کاربرد: npm run create-admin -- "نام" email@site.com رمزعبور [admin|editor]');
    process.exit(1);
  }
  await db.load();
  const admin = await authService.createAdmin({ name, email, password, role }, 'cli');
  console.log('✅ ادمین ساخته شد:', admin);
})().catch((err) => {
  console.error('❌ خطا:', err.message);
  process.exit(1);
});
