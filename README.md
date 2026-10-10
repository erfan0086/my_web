# my_web

فروشگاه: یک بکند Node.js و یک پنل ادمین، در کمترین تعداد فایل ممکن.

```
my_web/
├── index.html        صفحهٔ سایت (دست‌نخورده)
├── style.css         استایل سایت (دست‌نخورده)
├── script.js         منطق سایت: گرفتن و نمایش کالاها از API  ← یک فایل
├── server.js         کل بکند: API + احراز هویت + قیمت‌گذاری خودکار  ← یک فایل
├── test.js           ۳۸ تست خودکار برای همهٔ مسیرها
├── admin/
│   ├── index.html    پنل ادمین
│   ├── styles.css    استایل پنل
│   └── app.js        منطق پنل
├── Dockerfile        اجرا با داکر
├── render.yaml       دیپلوی یک‌کلیکی روی Render
└── package.json
```

## اجرای سریع

```bash
npm install
cp .env.example .env          # JWT_SECRET را یک مقدار تصادفی بگذارید
npm run seed                  # ادمین + ۶ کالای نمونه
npm start                     # http://localhost:3000/admin
```

ورود نمونه: `admin@shop.local` / `admin12345`

دستورات:

| دستور | کار |
|---|---|
| `npm start` | اجرای سرور |
| `npm run seed` | ساخت ادمین و کالاهای نمونه |
| `npm run create-admin -- "نام" email رمز admin` | ساخت ادمین جدید |
| `npm test` | اجرای ۳۸ تست روی همهٔ مسیرها |

## API

همهٔ پاسخ‌ها: `{ "ok": true, "data": ... }` یا `{ "ok": false, "error": { "message": ... } }`
توکن را در هدر بفرستید: `Authorization: Bearer <token>`
🔒 = نیاز به لاگین · 👑 = فقط مدیر ارشد

### عمومی (بدون لاگین)

| متد | مسیر | توضیح |
|---|---|---|
| GET | `/api/health` | وضعیت سرور |
| GET | `/api/products` | لیست کالاهای منتشرشده (بدون قیمت خرید) |
| GET | `/api/products/:idOrSlug` | یک کالا |
| GET | `/api/products/categories` | دسته‌ها |
| POST | `/api/auth/login` | `{email, password}` ⇒ `{token, user}` |

پارامترها: `q` `category` `brand` `featured` `minPrice` `maxPrice` `inStock` `sort` (`newest|oldest|priceAsc|priceDesc|name|stockAsc`) `page` `limit`

### مدیریت 🔒

| متد | مسیر | توضیح |
|---|---|---|
| GET | `/api/products/stats` | آمار داشبورد |
| POST | `/api/products` | ایجاد کالا |
| PATCH | `/api/products/:id` | ویرایش (فقط فیلدهای ارسالی) |
| DELETE | `/api/products/:id` | حذف 👑 |
| POST | `/api/products/bulk` | عملیات گروهی: `activate/deactivate/archive/delete/reprice/setCategory/setMargin` |
| GET | `/api/products/:id/price-history` | تاریخچه قیمت کالا |
| GET/POST | `/api/admins` | مدیریت کاربران 👑 |
| PATCH/DELETE | `/api/admins/:id` | ویرایش/حذف کاربر 👑 |
| GET | `/api/auth/me` | اطلاعات من |
| POST | `/api/auth/change-password` | تغییر رمز |

نمونه ایجاد کالا:

```bash
curl -X POST http://localhost:3000/api/products \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "name": "هدست بلوتوث پرو",
    "category": "اکسسوری",
    "cost": {"amount": 20, "currency": "USD"},
    "marginPercent": 30,
    "stock": 25,
    "status": "active",
    "specs": [{"key": "باتری", "value": "۳۰ ساعت"}],
    "images": ["https://example.com/a.jpg"],
    "tags": ["صوتی"]
  }'
```

## قیمت‌گذاری خودکار 🔒

```
قیمت = گردکردن( (قیمت خرید × نرخ ارز) × (۱ + سود%) × (۱ + مالیات%) )
```

قوانین قابل تنظیم: درصد سود پیش‌فرض، درصد مالیات، حداقل سود، روش گرد کردن
(`nearest|up|down|none`) و واحد گرد کردن (مثلاً ۱۰۰۰).
هر کالا یا `auto` است (قیمت از فرمول) یا `manual` (قیمت ثابت).

| متد | مسیر | توضیح |
|---|---|---|
| GET | `/api/pricing/settings` | ارز پایه، نرخ‌ها، قوانین |
| PATCH | `/api/pricing/rules` | تغییر قوانین ⇒ بروزرسانی فوری همهٔ قیمت‌ها 👑 |
| PUT | `/api/pricing/rates` | تغییر نرخ ارز ⇒ بروزرسانی فوری 👑 |
| POST | `/api/pricing/rates/webhook` | همان، با هدر `x-price-token` (بدون لاگین) |
| GET | `/api/pricing/preview` | پیش‌نمایش تغییرات بدون ذخیره |
| POST | `/api/pricing/recalculate` | اجرای دستی |
| POST | `/api/pricing/fetch-rates` | گرفتن نرخ از `RATE_SOURCE_URL` همین حالا 👑 |
| GET | `/api/pricing/history` | تاریخچه تغییرات |

### سه راه بروزرسانی خودکار

**۱. زمان‌بند (cron)** — در `.env`:
```env
PRICE_SCHEDULE=*/30 * * * *
RATE_SOURCE_URL=https://example.com/api/rates   # اختیاری
```
هر بار اجرا نرخ را می‌گیرد و همهٔ قیمت‌ها را دوباره حساب می‌کند
(قالب‌های `{"USD":…}`، `{"rates":{…}}` و `{"data":{"rates":{…}}}` را می‌فهمد).

**۲. وب‌هوک** — با `PRICE_WEBHOOK_TOKEN`:
```bash
curl -X POST http://localhost:3000/api/pricing/rates/webhook \
  -H "Content-Type: application/json" -H "x-price-token: توکن-شما" \
  -d '{"rates": {"USD": 152000, "EUR": 165000}}'
```

**۳. دستی** — ذخیرهٔ نرخ/قوانین در پنل ادمین.

هر تغییر قیمت در تاریخچه با زمان، دلیل، عامل و نرخِ لحظه ثبت می‌شود.

## پنل ادمین

`/admin` — پنل فارسی/راست‌چین با ۵ بخش: داشبورد، کالاها (فرم ۴ تبّه با مشخصات فنی)،
قیمت‌گذاری خودکار، تاریخچه قیمت، کاربران. دو نقش: `admin` (همه‌چیز) و `editor` (فقط کالاها).

## دیپلوی

> GitHub Pages فقط فایل استاتیک سرو می‌کند و **نمی‌تواند بکند Node.js را اجرا کند**.
> برای اجرای واقعی، بکند را روی یک هاست Node ببرید.

**Render (یک‌کلیکی):** `New → Blueprint` و این ریپازیتوری را انتخاب کنید (`render.yaml`).

**Docker:**
```bash
docker build -t my-web .
docker run -d -p 3000:3000 -e JWT_SECRET=یک-رشته-تصادفی -v shop-data:/app/data my-web
```

**VPS:**
```bash
npm ci --omit=dev && npm run seed && pm2 start server.js --name shop
```

متغیرهای مهم روی هاست: `JWT_SECRET` (الزامی)، `PRICE_SCHEDULE`، `RATE_SOURCE_URL`، `DATA_DIR`.
داده در `data/db.json` است — برای ماندگاری یک Volume وصل کنید یا دیتابیس واقعی بگذارید.

بعد از دیپلوی: `npm test` و `curl https://آدرس-سرویس/api/health`

## نکته دربارهٔ فایل قدیمی سایت

`script.js` قبلاً شماره تلفن و کد تایید بازدیدکنندگان را برای یک ربات تلگرامی می‌فرستاد؛
آن بخش در نسخهٔ جدید **بازنویسی نشده** و `index.html` و `style.css` هم دست‌نخورده مانده‌اند.
`script.js` حالا فقط ویترین فروشگاه را از `/api/products` می‌گیرد و نمایش می‌دهد.
اگر بکند روی هاست/پورت دیگری است، آدرس را این‌طور بدهید:

```html
<script src="script.js" data-api="https://آدرس-بکند/api"></script>
```
