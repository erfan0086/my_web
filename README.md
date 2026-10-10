# my_web

این ریپازیتوری دو بخش دارد:

| مسیر | توضیح |
|---|---|
| `index.html` · `style.css` · `script.js` | صفحهٔ استاتیک فرانت‌اند (دست‌نخورده باقی مانده) |
| `server/` | **بکند Node.js/Express** + پنل ادمین + API بروزرسانی خودکار قیمت |

برای شروع کار با بکند و پنل ادمین، مستندات کامل را اینجا بخوانید:
**[server/README.md](server/README.md)**

```bash
cd server
npm install
cp .env.example .env
npm run seed
npm start        # پنل: http://localhost:3000/admin
```

ورود پیش‌فرض دادهٔ نمونه: `admin@shop.local` / `admin12345`
(قبل از انتشار حتماً تغییر دهید.)
