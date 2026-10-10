# my_web

این ریپازیتوری دو بخش دارد:

| مسیر | توضیح | وضعیت انتشار |
|---|---|---|
| `index.html` · `style.css` · `script.js` | صفحهٔ استاتیک فرانت‌اند (دست‌نخورده باقی مانده) | GitHub Pages: https://erfan0086.github.io/my_web/ |
| `server/` | **بکند Node.js/Express** + پنل ادمین + API بروزرسانی خودکار قیمت | نیاز به هاست Node (Render / Railway / Docker / VPS) |

> GitHub Pages فقط فایل استاتیک سرو می‌کند؛ برای اجرای بکند و پنل ادمین باید آن را روی یک
> هاست Node دیپلوی کنید. راهنمای کامل: **[server/README.md](server/README.md#-دیپلوی-انتشار-روی-اینترنت)**

## شروع سریع (اجرای محلی)

```bash
cd server
npm install
cp .env.example .env
npm run seed
npm start        # پنل: http://localhost:3000/admin
```

ورود پیش‌فرض دادهٔ نمونه: `admin@shop.local` / `admin12345`
(قبل از انتشار حتماً تغییر دهید.)

## دیپلوی

فایل‌های آماده در ریپو:

- `render.yaml` — دیپلوی یک‌کلیکی روی Render
- `railway.json` — تنظیمات Railway (Root Directory: `server`)
- `server/Dockerfile` — اجرا با Docker روی هر هاستی
- `.github/workflows/ci.yml` — اجرای خودکار تست‌ها بعد از هر push/PR

```bash
cd server && npm test      # ۳۲ تست روی مسیرهای اصلی
```
