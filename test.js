/* =============================================================================
 *  test.js — تست دود (Smoke test) برای کل بکند
 * -----------------------------------------------------------------------------
 *  اجرا: npm test
 *
 *  سرور را روی یک پورت موقت با یک پوشهٔ دادهٔ موقت بالا می‌آورد،
 *  همهٔ مسیرهای اصلی را چک می‌کند و در پایان می‌بندد.
 * ===========================================================================*/
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.SMOKE_PORT || 4187);
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'shop-smoke-'));
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = __dirname;

const env = {
  ...process.env,
  PORT: String(PORT),
  DATA_DIR,
  NODE_ENV: 'test',
  JWT_SECRET: 'smoke-test-secret',
  PRICE_SCHEDULE: '',
  RATE_SOURCE_URL: '',
  PRICE_WEBHOOK_TOKEN: '',
};

let passed = 0;
let failed = 0;

function check(label, ok, extra = '') {
  if (ok) { passed += 1; console.log(`  ✅ ${label}`); }
  else { failed += 1; console.log(`  ❌ ${label} ${extra}`); }
}

function run(args) {
  return new Promise((resolve, reject) => {
    const c = spawn('node', args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { out += d; });
    c.on('error', reject);
    c.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`خروج ${code}:\n${out}`))));
  });
}

async function api(pathname, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + pathname, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = {};
  try { json = await res.json(); } catch (_) { /* ignore */ }
  return { status: res.status, data: json.data, error: json.error };
}

async function waitForServer(timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return true; } catch (_) { /* هنوز بالا نیامده */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function main() {
  console.log('\n▸ آماده‌سازی دادهٔ موقت');
  await run(['server.js', '--create-admin', 'مدیر', 'admin@test.local', 'admin12345', 'admin']);
  await run(['server.js', '--create-admin', 'ویرایشگر', 'editor@test.local', 'editor12345', 'editor']);
  check('ساخت ادمین از خط فرمان', true);

  console.log(`\n▶ بالا آوردن سرور روی پورت ${PORT}…`);
  const child = spawn('node', ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const logs = [];
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));

  try {
    if (!(await waitForServer())) throw new Error(`سرور بالا نیامد.\n${logs.join('')}`);

    console.log('\n▸ سلامت و احراز هویت');
    check('GET /api/health', (await api('/api/health')).status === 200);
    check('رمز اشتباه ⇒ ۴۰۱', (await api('/api/auth/login', { method: 'POST', body: { email: 'admin@test.local', password: 'wrongpassword' } })).status === 401);
    check('رمز کوتاه ⇒ ۴۰۰', (await api('/api/auth/login', { method: 'POST', body: { email: 'admin@test.local', password: '123' } })).status === 400);
    const login = await api('/api/auth/login', { method: 'POST', body: { email: 'admin@test.local', password: 'admin12345' } });
    check('ورود موفق ⇒ توکن', login.status === 200 && Boolean(login.data?.token));
    const admin = login.data.token;
    check('بدون توکن ⇒ ۴۰۱', (await api('/api/products/stats')).status === 401);
    check('توکن نامعتبر ⇒ ۴۰۱', (await api('/api/products/stats', { token: 'x.y.z' })).status === 401);

    console.log('\n▸ مدیریت کالاها');
    const created = await api('/api/products', { method: 'POST', token: admin, body: {
      name: 'کالای تست', category: 'تست', cost: { amount: 20, currency: 'USD' },
      marginPercent: 25, stock: 5, status: 'active', specs: [{ key: 'رنگ', value: 'آبی' }],
    } });
    check('ایجاد کالا ⇒ ۲۰۱', created.status === 201);
    // 20 × 100000 × 1.25 × 1.09 = 2,725,000
    check(`قیمت خودکار صحیح (${created.data?.price})`, created.data?.price === 2725000);
    const productId = created.data.id;

    check('دادهٔ نامعتبر ⇒ ۴۰۰', (await api('/api/products', { method: 'POST', token: admin, body: { name: '', cost: { amount: -5, currency: 'US' } } })).status === 400);
    check('کد کالای تکراری ⇒ ۴۰۹', (await api('/api/products', { method: 'POST', token: admin, body: { name: 'الف', sku: 'DUP' } })).status === 201
      && (await api('/api/products', { method: 'POST', token: admin, body: { name: 'ب', sku: 'DUP' } })).status === 409);
    check('ارز تعریف‌نشده ⇒ ۴۰۰', (await api('/api/products', { method: 'POST', token: admin, body: { name: 'ج', cost: { amount: 1, currency: 'JPY' } } })).status === 400);

    const patched = await api(`/api/products/${productId}`, { method: 'PATCH', token: admin, body: { cost: { amount: 40 } } });
    check('ویرایش جزئی ارز را عوض نمی‌کند', patched.data?.cost?.currency === 'USD', `واقعی: ${patched.data?.cost?.currency}`);
    check('با قیمت خرید جدید، فروش بروز شد', patched.data?.price === 5450000);

    const list = await api('/api/products?q=کالای تست');
    check('لیست عمومی فقط منتشرشده‌ها', list.data?.total === 1);
    check('لیست عمومی قیمت خرید را نمی‌دهد', list.data?.items?.[0] && !('cost' in list.data.items[0]));
    check('جستجوی ناموفق خالی است', (await api('/api/products?q=xyzxyz')).data?.total === 0);

    console.log('\n▸ قیمت‌گذاری خودکار');
    const rates = await api('/api/pricing/rates', { method: 'PUT', token: admin, body: { rates: { IRR: 1, USD: 200000 } } });
    check('تغییر نرخ ارز ⇒ ۲۰۰', rates.status === 200);
    check('نرخ دوبرابر ⇒ قیمت دوبرابر', rates.data?.changes?.find((c) => c.productId === productId)?.newPrice === 10900000);
    check('قیمت جدید ذخیره شد', (await api(`/api/products/${productId}`, { token: admin })).data?.price === 10900000);
    const history = await api('/api/pricing/history?limit=10', { token: admin });
    check('تاریخچه ثبت شد', history.data?.some((h) => h.productId === productId));

    await api(`/api/products/${productId}`, { method: 'PATCH', token: admin, body: { pricingMode: 'manual', manualPrice: 1234567 } });
    check('حالت دستی اعمال شد', (await api(`/api/products/${productId}`, { token: admin })).data?.price === 1234567);
    const recalc = await api('/api/pricing/recalculate', { method: 'POST', token: admin, body: { reason: 'smoke' } });
    check('کالای دستی نادیده گرفته شد', recalc.data?.run?.skippedManual === 1);
    check('قیمت دستی تغییر نکرد', (await api(`/api/products/${productId}`, { token: admin })).data?.price === 1234567);

    const rules = await api('/api/pricing/rules', { method: 'PATCH', token: admin, body: { defaultMarginPercent: 20, rounding: { mode: 'up', to: 5000 } } });
    check('ذخیرهٔ قوانین ⇒ ۲۰۰', rules.status === 200 && rules.data?.rules?.defaultMarginPercent === 20);
    check('پیش‌نمایش دارد خروجی', (await api('/api/pricing/preview', { token: admin })).data?.rows?.length > 0);
    check('وب‌هوک بدون توکن ⇒ ۴۰۱', (await api('/api/pricing/rates/webhook', { method: 'POST', body: { rates: { USD: 1 } } })).status === 401);

    console.log('\n▸ سطح دسترسی');
    const editor = (await api('/api/auth/login', { method: 'POST', body: { email: 'editor@test.local', password: 'editor12345' } })).data.token;
    check('ویرایشگر به قوانین قیمت ⇒ ۴۰۳', (await api('/api/pricing/rules', { method: 'PATCH', token: editor, body: { taxPercent: 5 } })).status === 403);
    check('ویرایشگر به کاربران ⇒ ۴۰۳', (await api('/api/admins', { token: editor })).status === 403);
    check('ویرایشگر نمی‌تواند حذف کند ⇒ ۴۰۳', (await api(`/api/products/${productId}`, { method: 'DELETE', token: editor })).status === 403);
    check('ویرایشگر می‌تواند ویرایش کند ⇒ ۲۰۰', (await api(`/api/products/${productId}`, { method: 'PATCH', token: editor, body: { stock: 9 } })).status === 200);

    console.log('\n▸ پنل ادمین');
    for (const p of ['/admin/', '/admin/app.js', '/admin/styles.css']) {
      check(`${p} سرو می‌شود`, (await fetch(BASE + p)).status === 200);
    }

    console.log('\n▸ گروهی و حذف');
    check('عملیات گروهی', (await api('/api/products/bulk', { method: 'POST', token: admin, body: { ids: [productId], action: 'deactivate' } })).data?.affected === 1);
    check('حذف کالا ⇒ ۲۰۰', (await api(`/api/products/${productId}`, { method: 'DELETE', token: admin })).status === 200);
    check('بعد از حذف ⇒ ۴۰۴', (await api(`/api/products/${productId}`, { token: admin })).status === 404);
    check('مسیر ناشناخته ⇒ ۴۰۴', (await fetch(`${BASE}/api/nothing`)).status === 404);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    if (!child.killed) child.kill('SIGKILL');
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }

  console.log('\n———————————————');
  console.log(`✅ موفق: ${passed}   ❌ ناموفق: ${failed}`);
  if (failed) {
    console.log(`\nلاگ سرور:\n${logs.join('')}`);
    process.exit(1);
  }
  console.log('همهٔ تست‌ها گذشتند 🎉');
}

main().catch((err) => {
  console.error('❌ خطا در اجرای تست:', err);
  process.exit(1);
});
