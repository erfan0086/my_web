# ---- بکند فروشگاه + پنل ادمین ----
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data

WORKDIR /app

# نصب وابستگی‌ها (بدون پکیج‌های توسعه)
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# پوشه داده (فایل db.json اینجا ساخته می‌شود)
RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 3000

CMD ["node", "src/index.js"]
