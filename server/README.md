# بکند فروشگاه + پنل ادمین + قیمت‌گذاری خودکار

یک بکند کامل با **Node.js / Express** که سه کار اصلی را انجام می‌دهد:

1. **مدیریت کالاها** — تعریف، ویرایش، جستجو، فیلتر، موجودی و عملیات گروهی
2. **پنل ادمین** — یک رابط فارسی/راست‌چین برای بروزرسانی کالاها و مشخصات فنی آن‌ها
3. **API بروزرسانی خودکار قیمت** — موتور قاعده‌محور + زمان‌بند (cron) + وب‌هوک دریافت نرخ ارز

داده‌ها در یک فایل JSON ذخیره می‌شوند (`server/data/db.json`)، بنابراین برای اجرا هیچ دیتابیسی لازم نیست.

---

## 🚀 اجرای سریع

```bash
cd server
npm install
cp .env.example .env          # سپس JWT_SECRET را یک مقدار تصادفی بگذارید
npm run seed                  # ساخت ادمین پیش‌فرض + ۶ کالای نمونه
npm start                     # http://localhost:3000/admin
```

ورود پیش‌فرض (فقط برای تست محلی):

| ایمیل | رمز |
|---|---|
| `admin@shop.local` | `admin12345` |

ساخت ادمین جدید از خط فرمان:

```bash
npm run create-admin -- "نام شما" you@site.com رمزعبور admin
```

---

## 📁 ساختار پروژه

```
server/
├── admin/                 # پنل ادمین (فایل‌های استاتیک: HTML/CSS/JS خالی)
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── src/
│   ├── index.js           # نقطه شروع: راه‌اندازی Express و زمان‌بند
│   ├── config.js          # خواندن متغیرهای محیطی
│   ├── db/database.js     # لایه داده (فایل JSON) — تنها نقطه اتصال به ذخیره‌سازی
│   ├── lib/               # اعتبارسنجی (zod)، خطاها، ابزارها
│   ├── middleware/        # احراز هویت، نقش‌ها، اعتبارسنجی، مدیریت خطا
│   ├── routes/            # auth · products · pricing · admins
│   ├── services/          # منطق کسب‌وکار: محصولات، قیمت‌گذاری، کاربران
│   └── jobs/              # زمان‌بند بروزرسانی خودکار قیمت
├── scripts/seed.js        # دادهٔ نمونه
└── data/db.json           # داده‌ها (در git ذخیره نمی‌شود)
```

برای تغییر دیتابیس به SQLite/Postgres/Mongo فقط `src/db/database.js` را بازنویسی کنید؛
بقیهٔ کد فقط از `db.data` و `db.save()` استفاده می‌کند.

---

## 🔐 احراز هویت و نقش‌ها

| نقش | دسترسی |
|---|---|
| `admin` | همه‌چیز: کالاها، قوانین قیمت، نرخ ارز، مدیریت کاربران، حذف |
| `editor` | فقط مدیریت کالاها (ایجاد/ویرایش/انتشار) — بدون دسترسی به قوانین قیمت و کاربران |

توکن JWT از طریق هدر ارسال می‌شود:

```
Authorization: Bearer <token>
```

---

## 💱 قیمت‌گذاری خودکار

### فرمول

همه‌چیز در **ارز پایه** (`baseCurrency`، پیش‌فرض `IRR`) محاسبه می‌شود:

```
قیمت تمام‌شده در ارز پایه = مبلغ خرید × نرخ ارز کالا
بعد از سود        = قیمت تمام‌شده × (۱ + درصد سود/۱۰۰)
بعد از مالیات     = بعد از سود × (۱ + درصد مالیات/۱۰۰)
اعمال حداقل سود   = max(بعد از مالیات، قیمت تمام‌شده + حداقل سود)
قیمت نهایی        = گرد کردن(مقدار بالا)
```

قوانین قابل تنظیم:

| قانون | توضیح |
|---|---|
| `defaultMarginPercent` | درصد سود پیش‌فرض (هر کالا می‌تواند مقدار اختصاصی خودش را داشته باشد) |
| `taxPercent` | مالیات/ارزش افزوده |
| `minProfitAmount` | حداقل سود خالص به ارز پایه |
| `rounding.mode` | `nearest`، `up`، `down`، `none` |
| `rounding.to` | واحد گرد کردن (مثلاً `1000` ⇒ قیمت‌ها مضرب ۱۰۰۰ می‌شوند) |

هر کالا دو حالت دارد:

- **`auto`** — قیمت از روی فرمول محاسبه می‌شود و با هر تغییر نرخ/قانون، خودکار بروز می‌شود
- **`manual`** — قیمت ثابت است و قوانین روی آن اعمال نمی‌شود

### سه راه برای بروزرسانی خودکار

**۱) زمان‌بند داخلی (cron)** — در `.env`:

```env
PRICE_SCHEDULE=*/30 * * * *
RATE_SOURCE_URL=https://example.com/api/rates      # اختیاری
```

هر بار اجرا: نرخ را از `RATE_SOURCE_URL` می‌گیرد (قالب‌های `{"USD": ...}`، `{"rates": {...}}` یا `{"data": {"rates": {...}}}` را می‌فهمد)، ذخیره می‌کند و **همهٔ قیمت‌ها را دوباره محاسبه می‌کند**. اگر `RATE_SOURCE_URL` خالی باشد، فقط با نرخ‌های فعلی محاسبه تکرار می‌شود.

**۲) وب‌هوک** — برای اینکه یک سرویس/اسکریپت خارجی بدون لاگین نرخ بفرستد:

```env
PRICE_WEBHOOK_TOKEN=یک-رشته-تصادفی
```

```bash
curl -X POST http://localhost:3000/api/pricing/rates/webhook \
  -H "Content-Type: application/json" \
  -H "x-price-token: یک-رشته-تصادفی" \
  -d '{"rates": {"USD": 152000, "EUR": 165000}}'
```

با این یک فراخوان، همهٔ قیمت‌های `auto` بلافاصله بروزرسانی می‌شوند.

**۳) دستی از پنل یا API** — ذخیرهٔ نرخ‌ها یا قوانین در پنل، بلافاصله باعث محاسبهٔ مجدد همهٔ کالاها می‌شود.

هر تغییر قیمت در **تاریخچه** (`priceHistory`) با زمان، دلیل، عامل و نرخِ لحظه ثبت می‌شود.

---

## 📡 مستندات API

همهٔ پاسخ‌ها این شکل را دارند: `{ "ok": true, "data": ... }` یا `{ "ok": false, "error": { "message": ... } }`

### سلامت

| متد | مسیر | توضیح |
|---|---|---|
| GET | `/api/health` | وضعیت سرور |

### احراز هویت

| متد | مسیر | توضیح |
|---|---|---|
| POST | `/api/auth/login` | `{email, password}` ⇒ `{token, user}` |
| GET | `/api/auth/me` | اطلاعات کاربر 🔒 |
| POST | `/api/auth/change-password` | `{currentPassword, newPassword}` 🔒 |
| POST | `/api/auth/logout` | فقط برای تکمیل جریان کار |

### کالاها

| متد | مسیر | توضیح |
|---|---|---|
| GET | `/api/products` | لیست عمومی (فقط منتشرشده، بدون قیمت خرید) — با توکن: لیست کامل مدیریتی |
| GET | `/api/products/stats` | آمار داشبورد 🔒 |
| GET | `/api/products/categories` | فهرست دسته‌ها |
| GET | `/api/products/:idOrSlug` | یک کالا (با id یا slug) |
| POST | `/api/products` | ایجاد کالا 🔒 |
| PATCH | `/api/products/:id` | ویرایش (فقط فیلدهای ارسالی) 🔒 |
| DELETE | `/api/products/:id` | حذف 👑 |
| GET | `/api/products/:id/price-history` | تاریخچه قیمت یک کالا 🔒 |
| POST | `/api/products/bulk` | عملیات گروهی 🔒 |

پارامترهای جستجو (عمومی): `q`, `category`, `brand`, `featured`, `minPrice`, `maxPrice`, `inStock`, `sort` (`newest|oldest|priceAsc|priceDesc|name`), `page`, `limit`
اضافه برای ادمین: `status` (`active|draft|archived`), `pricingMode`, `lowStock=1`

نمونه ایجاد کالا:

```bash
curl -X POST http://localhost:3000/api/products \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "name": "هدست بلوتوث پرو",
    "category": "اکسسوری",
    "brand": "ProAudio",
    "status": "active",
    "cost": { "amount": 20, "currency": "USD" },
    "marginPercent": 30,
    "stock": 25,
    "lowStockThreshold": 3,
    "specs": [{"key": "باتری", "value": "۳۰ ساعت"}, {"key": "رنگ", "value": "مشکی"}],
    "images": ["https://example.com/a.jpg"],
    "tags": ["صوتی", "جدید"],
    "featured": true
  }'
```

عملیات گروهی:

```jsonc
// POST /api/products/bulk
{ "ids": ["prd_x", "prd_y"], "action": "activate" }   // یا deactivate | archive | delete
{ "ids": ["prd_x"], "action": "reprice" }             // محاسبه مجدد قیمت
{ "ids": ["prd_x"], "action": "setCategory", "category": "اکسسوری" }
{ "ids": ["prd_x"], "action": "setMargin", "marginPercent": 25 }
```

### قیمت‌گذاری 🔒

| متد | مسیر | توضیح |
|---|---|---|
| GET | `/api/pricing/settings` | ارز پایه + نرخ‌ها + قوانین + اجراهای اخیر |
| PATCH | `/api/pricing/rules` | تغییر قوانین ⇒ محاسبهٔ مجدد فوری 👑 |
| PUT | `/api/pricing/rates` | تغییر نرخ ارز ⇒ محاسبهٔ مجدد فوری 👑 |
| POST | `/api/pricing/rates/webhook` | همان کار بالا با توکن وب‌هوک |
| GET | `/api/pricing/preview` | پیش‌نمایش تغییرات **بدون ذخیره** |
| POST | `/api/pricing/recalculate` | اجرای دستی: `{ids?, reason?}` |
| POST | `/api/pricing/fetch-rates` | دریافت نرخ از `RATE_SOURCE_URL` همین حالا 👑 |
| GET | `/api/pricing/history` | تاریخچه تغییرات (`?productId=&limit=`) |

### کاربران 👑

| متد | مسیر | توضیح |
|---|---|---|
| GET | `/api/admins` | فهرست ادمین‌ها |
| POST | `/api/admins` | `{name, email, password, role}` |
| PATCH | `/api/admins/:id` | تغییر نام/ایمیل/رمز/نقش/فعال بودن |
| DELETE | `/api/admins/:id` | حذف (آخرین مدیر ارشد حذف نمی‌شود) |

🔒 = نیاز به لاگین · 👑 = فقط نقش `admin`

---

## 🔗 اتصال فرانت‌اند

فروشگاه شما می‌تواند بدون احراز هویت این‌ها را صدا بزند:

```js
const res = await fetch('/api/products?sort=newest&limit=12');
const { data } = await res.json();
// data.items -> لیست کالاها    data.totalPages -> تعداد صفحه‌ها
```

## 🧩 نمونه استفاده در فرانت‌اند

این تکه‌کد را می‌توانید مستقیماً در `script.js` سایت (یا هر صفحهٔ دیگر) بگذارید تا
ویترین کالاها را از همین بکند بگیرد:

```js
const API = '/api';   // اگر فرانت روی دامنه/پورت دیگری است، آدرس کامل را بنویسید

async function loadProducts({ q = '', page = 1, limit = 12 } = {}) {
  const params = new URLSearchParams({ page, limit, sort: 'newest' });
  if (q) params.set('q', q);

  const res = await fetch(`${API}/products?${params}`);
  const { ok, data, error } = await res.json();
  if (!ok) throw new Error(error.message);

  return data; // { items, page, limit, total, totalPages }
}

function productCard(p) {
  const price = new Intl.NumberFormat('fa-IR').format(p.price);
  const specs = (p.specs || [])
    .map((s) => `<li><b>${s.key}:</b> ${s.value}</li>`)
    .join('');

  return `
    <div class="product">
      <img src="${p.images[0] || ''}" alt="${p.name}" />
      <h3>${p.name}</h3>
      <p>${p.shortDescription || ''}</p>
      <ul>${specs}</ul>
      <div class="price">${price} تومان</div>
      <button ${p.trackStock && p.stock <= 0 ? 'disabled' : ''}>
        ${p.trackStock && p.stock <= 0 ? 'ناموجود' : 'افزودن به سبد'}
      </button>
    </div>`;
}

// استفاده:
loadProducts({ q: 'پریمیوم' }).then((data) => {
  document.querySelector('#products').innerHTML = data.items.map(productCard).join('');
});
```

---

## ⚙️ متغیرهای محیطی

| متغیر | پیش‌فرض | توضیح |
|---|---|---|
| `PORT` | `3000` | پورت سرور |
| `JWT_SECRET` | تصادفی موقت | **حتماً در production مقداردهی شود** |
| `JWT_EXPIRES_IN` | `7d` | عمر توکن |
| `ADMIN_IP_ALLOWLIST` | خالی | محدود کردن IP دسترسی به پنل (مثال: `1.2.3.4,5.6.7.8`) |
| `PRICE_SCHEDULE` | `*/30 * * * *` | زمان‌بند بروزرسانی قیمت |
| `RATE_SOURCE_URL` | خالی | منبع JSON نرخ ارز |
| `PRICE_WEBHOOK_TOKEN` | خالی | فعال‌سازی وب‌هوک قیمت |
| `DATA_DIR` | `./data` | محل فایل داده |

---

## 🛡️ نکات امنیتی قبل از انتشار

- `JWT_SECRET` را با یک رشتهٔ تصادفی بلند مقداردهی کنید
- رمز پیش‌فرض ادمین نمونه را تغییر دهید (پنل › کاربران، یا `npm run create-admin`)
- پنل را پشت HTTPS اجرا کنید و در صورت امکان `ADMIN_IP_ALLOWLIST` را پر کنید
- فایل `data/` را در بکاپ نگه دارید و در گیت ذخیره نکنید
- برای ترافیک بالا، `src/db/database.js` را با SQLite/Postgres جایگزین کنید
