'use strict';

/**
 * دادهٔ نمونه برای شروع سریع.
 * اجرا: npm run seed
 * توجه: اگر از قبل ادمین/کالا وجود داشته باشد چیزی اضافه نمی‌شود.
 */

const db = require('../src/db/database');
const authService = require('../src/services/auth.service');
const productService = require('../src/services/product.service');

const PRODUCTS = [
  {
    name: 'اشتراک تلگرام پریمیوم — ۳ ماهه',
    category: 'اشتراک',
    brand: 'Telegram',
    cost: { amount: 12, currency: 'USD' },
    marginPercent: 25,
    stock: 40,
    lowStockThreshold: 5,
    shortDescription: 'فعالسازی رسمی روی اکانت شما، بدون نیاز به رمز عبور',
    description:
      'اشتراک تلگرام پریمیوم به مدت سه ماه روی شمارهٔ شما فعال می‌شود. شامل حذف تبلیغات، دانلود سریع‌تر، استیکرهای اختصاصی و محدودیت‌های بالاتر است.',
    specs: [
      { key: 'مدت اعتبار', value: '۳ ماه' },
      { key: 'نوع فعالسازی', value: 'روی اکانت شخصی' },
      { key: 'نیاز به رمز عبور', value: 'خیر' },
      { key: 'زمان تحویل', value: '۵ تا ۳۰ دقیقه' },
      { key: 'گارانتی', value: 'تا پایان دوره' },
    ],
    tags: ['پریمیوم', 'تلگرام', 'پرفروش'],
    featured: true,
    status: 'active',
  },
  {
    name: 'اشتراک تلگرام پریمیوم — ۱۲ ماهه',
    category: 'اشتراک',
    brand: 'Telegram',
    cost: { amount: 38, currency: 'USD' },
    marginPercent: 20,
    stock: 25,
    lowStockThreshold: 5,
    shortDescription: 'یک سال دسترسی کامل به امکانات پریمیوم',
    specs: [
      { key: 'مدت اعتبار', value: '۱۲ ماه' },
      { key: 'نوع فعالسازی', value: 'روی اکانت شخصی' },
      { key: 'پشتیبانی', value: '۲۴ ساعته' },
    ],
    tags: ['پریمیوم', 'تلگرام', 'سالیانه'],
    status: 'active',
  },
  {
    name: 'گیفت کارت اپل — ۵۰ دلار',
    category: 'گیفت کارت',
    brand: 'Apple',
    cost: { amount: 50, currency: 'USD' },
    marginPercent: 12,
    stock: 12,
    lowStockThreshold: 3,
    specs: [
      { key: 'مبلغ', value: '۵۰ دلار' },
      { key: 'منطقه', value: 'USA' },
      { key: 'نوع کد', value: 'دیجیتال' },
    ],
    tags: ['گیفت کارت', 'اپل'],
    status: 'active',
  },
  {
    name: 'شارژ حساب کاربری — بسته ۱۰۰ هزار تومانی',
    category: 'شارژ',
    cost: { amount: 100000, currency: 'IRR' },
    marginPercent: 10,
    stock: 999,
    lowStockThreshold: 0,
    specs: [{ key: 'مبلغ', value: '۱۰۰٬۰۰۰ تومان' }],
    tags: ['شارژ', 'کیف پول'],
    status: 'active',
  },
  {
    name: 'پک ویژه استیکر و تم پریمیوم',
    category: 'محتوا',
    cost: { amount: 5, currency: 'USD' },
    marginPercent: 40,
    stock: 0,
    lowStockThreshold: 10,
    status: 'active',
    specs: [{ key: 'تعداد آیتم', value: '۳۰+' }],
    tags: ['استیکر', 'تم'],
  },
  {
    name: 'اشتراک ویژه آزمایشی — پیش‌نویس',
    category: 'اشتراک',
    cost: { amount: 3, currency: 'USD' },
    stock: 5,
    status: 'draft',
    specs: [{ key: 'مدت اعتبار', value: '۷ روز' }],
    tags: ['آزمایشی'],
  },
];

(async () => {
  await db.load();

  const email = process.env.ADMIN_EMAIL || 'admin@shop.local';
  const password = process.env.ADMIN_PASSWORD || 'admin12345';

  if (!db.data.admins.length) {
    const admin = await authService.createAdmin(
      { name: 'مدیر اصلی', email, password, role: 'admin' },
      'seed'
    );
    console.log(`✅ ادمین ساخته شد: ${admin.email} / ${password}`);
  } else {
    console.log('ادمین از قبل وجود دارد — رد شد.');
  }

  if (!db.data.products.length) {
    for (const p of PRODUCTS) {
      productService.create(p, 'seed');
    }
    console.log(`✅ ${PRODUCTS.length} کالای نمونه ساخته شد.`);
  } else {
    console.log('کالا از قبل وجود دارد — رد شد.');
  }

  console.log('\nورود به پنل:');
  console.log(`  ایمیل: ${email}`);
  console.log(`  رمز:   ${password}`);
  console.log(`  آدرس:  http://localhost:${process.env.PORT || 3000}/admin`);
})().catch((err) => {
  console.error('❌ خطا:', err);
  process.exit(1);
});
