'use strict';

/**
 * تست دود (Smoke test) — بعد از هر دیپلوی، مسیرهای اصلی را چک می‌کند.
 * اجرا: npm test
 *
 * سرور را روی یک پورت موقت با یک پوشهٔ دادهٔ موقت بالا می‌آورد،
 * سناریوی کامل را اجرا می‌کند و در پایان سرور را می‌بندد.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.SMOKE_PORT || 4187);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'shop-smoke-'));
const BASE = `http://127.0.0.1:${PORT}`;
const CHILD_ENV = {
  ...process.env,
  PORT: String(PORT),
  DATA_DIR,
  NODE_ENV: 'test',
  JWT_SECRET: 'smoke-test-secret',
  PRICE_SCHEDULE: '', // در تست زمان‌بند را خاموش می‌کنیم
  RATE_SOURCE_URL: '',
  PRICE_WEBHOOK_TOKEN: '',
};

let passed = 0;
let failed = 0;

function check(label, condition, extra = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✅ ${label}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${label} ${extra}`);
  }
}

async function api(pathname, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = {};
  try { json = await res.json(); } catch (_) { /* ignore */ }
  return { status: res.status, body: json, data: json.data };
}

async function waitForServer(timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return true;
    } catch (_) { /* هنوز بالا نیامده */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function main() {
  // ---- ۱) ساخت ادمین در پوشهٔ دادهٔ موقت (قبل از بالا آمدن سرور) ----
  process.env.DATA_DIR = DATA_DIR;
  const db = require('../src/db/database');
  const authService = require('../src/services/auth.service');
  await db.load();
  await authService.createAdmin(
    { name: 'تست', email: 'admin@test.local', password: 'admin12345', role: 'admin' },
    'smoke'
  );
  await authService.createAdmin(
    { name: 'ویرایشگر', email: 'editor@test.local', password: 'editor12345', role: 'editor' },
    'smoke'
  );

  // ---- ۲) بالا آوردن سرور ----
  console.log(`\n▶ سرور تست روی پورت ${PORT} بالا می‌آید…`);
  const child = spawn('node', [path.join(__dirname, '..', 'src', 'index.js')], {
    env: CHILD_ENV,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));

  try {
    const up = await waitForServer();
    if (!up) throw new Error(`سرور بالا نیامد.\n${logs.join('')}`);

    console.log('\n▸ سلامت و احراز هویت');
    const health = await api('/api/health');
    check('GET /api/health پاسخ می‌دهد', health.status === 200);

    const badLogin = await api('/api/auth/login', {
      method: 'POST',
      body: { email: 'admin@test.local', password: 'wrongpassword' },
    });
    check('رمز اشتباه ⇒ ۴۰۱', badLogin.status === 401, `واقعی: ${badLogin.status}`);

    const shortPassword = await api('/api/auth/login', {
      method: 'POST',
      body: { email: 'admin@test.local', password: '123' },
    });
    check('رمز کوتاه ⇒ ۴۰۰ ولیدیشن', shortPassword.status === 400, `واقعی: ${shortPassword.status}`);

    const login = await api('/api/auth/login', {
      method: 'POST',
      body: { email: 'admin@test.local', password: 'admin12345' },
    });
    check('ورود موفق ⇒ توکن می‌دهد', login.status === 200 && Boolean(login.data?.token));
    const adminToken = login.data.token;

    const noToken = await api('/api/products/stats');
    check('دسترسی بدون توکن ⇒ ۴۰۱', noToken.status === 401);

    console.log('\n▸ مدیریت کالاها');
    const created = await api('/api/products', {
      method: 'POST',
      token: adminToken,
      body: {
        name: 'کالای تست',
        category: 'تست',
        cost: { amount: 20, currency: 'USD' },
        marginPercent: 25,
        stock: 5,
        status: 'active',
        specs: [{ key: 'رنگ', value: 'آبی' }],
      },
    });
    check('ایجاد کالا ⇒ ۲۰۱', created.status === 201);
    // 20 × 100000 × 1.25 × 1.09 = 2,725,000 (گرد کردن به ۱۰۰۰)
    check(
      `قیمت خودکار درست محاسبه شد (${created.data?.price})`,
      created.data?.price === 2725000
    );
    const productId = created.data.id;

    const invalid = await api('/api/products', {
      method: 'POST',
      token: adminToken,
      body: { name: '', cost: { amount: -5, currency: 'US' } },
    });
    check('دادهٔ نامعتبر ⇒ ۴۰۰', invalid.status === 400);

    const patched = await api(`/api/products/${productId}`, {
      method: 'PATCH',
      token: adminToken,
      body: { cost: { amount: 40 } },
    });
    check(
      'ویرایشِ جزئی ارز را تغییر نمی‌دهد',
      patched.data?.cost?.currency === 'USD',
      `واقعی: ${patched.data?.cost?.currency}`
    );
    check('با تغییر قیمت خرید، قیمت فروش بروز شد', patched.data?.price === 5450000);

    const publicList = await api('/api/products?q=کالای تست');
    const publicItem = publicList.data?.items?.[0];
    check('لیست عمومی فقط کالای منتشرشده را می‌دهد', publicList.data?.total === 1);
    check('لیست عمومی قیمت خرید را لو نمی‌دهد', publicItem && !('cost' in publicItem));

    console.log('\n▸ قیمت‌گذاری خودکار');
    const rateUpdate = await api('/api/pricing/rates', {
      method: 'PUT',
      token: adminToken,
      body: { rates: { IRR: 1, USD: 200000 } },
    });
    check('تغییر نرخ ارز ⇒ ۲۰۰', rateUpdate.status === 200);
    check(
      'با دوبرابر شدن نرخ دلار، قیمت هم دوبرابر شد',
      rateUpdate.data?.changes?.find((c) => c.productId === productId)?.newPrice === 10900000,
      JSON.stringify(rateUpdate.data?.changes)
    );

    const afterRate = await api(`/api/products/${productId}`, { token: adminToken });
    check('قیمت جدید روی کالا ذخیره شد', afterRate.data?.price === 10900000);

    const history = await api('/api/pricing/history?limit=10', { token: adminToken });
    check(
      'تغییر قیمت در تاریخچه ثبت شد',
      Array.isArray(history.data) && history.data.some((h) => h.productId === productId)
    );

    const manual = await api(`/api/products/${productId}`, {
      method: 'PATCH',
      token: adminToken,
      body: { pricingMode: 'manual', manualPrice: 1234567 },
    });
    check('حالت دستی اعمال شد', manual.data?.price === 1234567);

    const recalc = await api('/api/pricing/recalculate', {
      method: 'POST',
      token: adminToken,
      body: { reason: 'smoke' },
    });
    check('کالای دستی در محاسبهٔ خودکار نادیده گرفته شد', recalc.data?.run?.skippedManual === 1);
    const afterRecalc = await api(`/api/products/${productId}`, { token: adminToken });
    check('قیمت دستی بعد از محاسبهٔ مجدد تغییر نکرد', afterRecalc.data?.price === 1234567);

    const rules = await api('/api/pricing/rules', {
      method: 'PATCH',
      token: adminToken,
      body: { defaultMarginPercent: 20, rounding: { mode: 'up', to: 5000 } },
    });
    check('ذخیرهٔ قوانین ⇒ ۲۰۰', rules.status === 200);
    check(
      'قانون جدید اعمال شد',
      rules.data?.rules?.defaultMarginPercent === 20 && rules.data?.rules?.rounding?.to === 5000
    );

    const preview = await api('/api/pricing/preview', { token: adminToken });
    check('پیش‌نمایش خروجی دارد', Array.isArray(preview.data?.rows) && preview.data.rows.length > 0);

    console.log('\n▸ سطح دسترسی');
    const editorLogin = await api('/api/auth/login', {
      method: 'POST',
      body: { email: 'editor@test.local', password: 'editor12345' },
    });
    const editorToken = editorLogin.data.token;
    const editorRules = await api('/api/pricing/rules', {
      method: 'PATCH',
      token: editorToken,
      body: { taxPercent: 5 },
    });
    check('ویرایشگر به قوانین قیمت دسترسی ندارد ⇒ ۴۰۳', editorRules.status === 403);
    const editorDelete = await api(`/api/products/${productId}`, {
      method: 'DELETE',
      token: editorToken,
    });
    check('ویرایشگر نمی‌تواند حذف کند ⇒ ۴۰۳', editorDelete.status === 403);
    const editorEdit = await api(`/api/products/${productId}`, {
      method: 'PATCH',
      token: editorToken,
      body: { stock: 9 },
    });
    check('ویرایشگر می‌تواند کالا ویرایش کند', editorEdit.status === 200);

    console.log('\n▸ پنل ادمین و مسیرهای استاتیک');
    for (const p of ['/admin/', '/admin/app.js', '/admin/styles.css']) {
      const res = await fetch(`${BASE}${p}`);
      check(`${p} سرو می‌شود`, res.status === 200);
    }
    const notFound = await fetch(`${BASE}/api/nothing-here`);
    check('مسیر ناشناخته ⇒ ۴۰۴', notFound.status === 404);

    console.log('\n▸ عملیات گروهی و حذف');
    const bulk = await api('/api/products/bulk', {
      method: 'POST',
      token: adminToken,
      body: { ids: [productId], action: 'deactivate' },
    });
    check('عملیات گروهی اجرا شد', bulk.status === 200 && bulk.data?.affected === 1);
    const del = await api(`/api/products/${productId}`, { method: 'DELETE', token: adminToken });
    check('حذف کالا ⇒ ۲۰۰', del.status === 200);
    const gone = await api(`/api/products/${productId}`, { token: adminToken });
    check('کالای حذف‌شده دیگر یافت نمی‌شود ⇒ ۴۰۴', gone.status === 404);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    if (!child.killed) child.kill('SIGKILL');
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }

  console.log(`\n———————————————`);
  console.log(`✅ موفق: ${passed}   ❌ ناموفق: ${failed}`);
  if (failed > 0) {
    console.log(`\nلاگ سرور:\n${logs.join('')}`);
    process.exit(1);
  }
  console.log('همهٔ تست‌ها گذشتند 🎉');
}

main().catch((err) => {
  console.error('❌ خطا در اجرای تست:', err);
  process.exit(1);
});
