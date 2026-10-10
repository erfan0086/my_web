'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));

function randomSecret() {
  return crypto.randomBytes(48).toString('hex');
}

let jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) {
  jwtSecret = randomSecret();
  console.warn('[config] هشدار: JWT_SECRET تنظیم نشده است. یک کلید موقت ساخته شد.');
  console.warn('[config] برای محیط production حتماً JWT_SECRET را در فایل .env قرار دهید.');
}

const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 3000),
  dataDir: DATA_DIR,
  dbFile: path.join(DATA_DIR, 'db.json'),
  jwt: {
    secret: jwtSecret,
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  },
  pricing: {
    // زمان‌بند بروزرسانی خودکار قیمت
    schedule: process.env.PRICE_SCHEDULE || '*/30 * * * *',
    rateSourceUrl: process.env.RATE_SOURCE_URL || '',
    webhookToken: process.env.PRICE_WEBHOOK_TOKEN || '',
  },
  adminIpAllowlist: (process.env.ADMIN_IP_ALLOWLIST || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};

module.exports = config;
