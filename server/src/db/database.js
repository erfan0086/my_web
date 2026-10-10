'use strict';

/**
 * یک دیتابیس سادهٔ مبتنی بر فایل JSON.
 * - کل داده در حافظه نگه داشته می‌شود و روی دیسک به صورت اتمیک (tmp + rename) نوشته می‌شود.
 * - تمام نوشتن‌ها از یک صف عبور می‌کنند تا تداخل پیش نیاید.
 * - برای جابجایی بعدی به SQLite/Postgres، فقط همین فایل باید عوض شود
 *   (همهٔ سرویس‌ها از طریق db.data و db.save() کار می‌کنند).
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const config = require('../config');

const DEFAULT_DATA = () => ({
  meta: { version: 1, createdAt: new Date().toISOString() },
  admins: [],
  products: [],
  settings: {
    // نرخ تبدیل هر ارز به «ارز پایه» (مثلاً ۱ دلار = ۱۰۰۰۰۰ تومان)
    baseCurrency: 'IRR',
    rates: { IRR: 1, USD: 100000, EUR: 108000, AED: 27200, TRY: 2900 },
  },
  priceRules: {
    defaultMarginPercent: 15,
    taxPercent: 9,
    rounding: { mode: 'nearest', to: 1000 },
    minProfitAmount: 0,
    updatedAt: null,
    updatedBy: null,
  },
  priceHistory: [],
  priceRuns: [],
});

class JsonDatabase {
  constructor(file) {
    this.file = file;
    this.data = DEFAULT_DATA();
    this.writeQueue = Promise.resolve();
    this.loaded = false;
  }

  async load() {
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    try {
      const raw = await fsp.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      const base = DEFAULT_DATA();
      // ادغام سطحی تا اضافه شدن فیلدهای جدید در نسخه‌های بعدی مشکلی ایجاد نکند
      this.data = {
        ...base,
        ...parsed,
        settings: { ...base.settings, ...(parsed.settings || {}) },
        priceRules: { ...base.priceRules, ...(parsed.priceRules || {}) },
        meta: { ...base.meta, ...(parsed.meta || {}) },
      };
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // فایل وجود دارد ولی خراب است -> نسخهٔ پشتیبان می‌گیریم و از نو شروع می‌کنیم
        const backup = `${this.file}.corrupt-${Date.now()}`;
        console.error(`[db] فایل داده خراب است. پشتیبان در ${backup}`);
        try {
          fs.copyFileSync(this.file, backup);
        } catch (_) {
          /* ignore */
        }
      }
      this.data = DEFAULT_DATA();
      await this.persist();
    }
    this.loaded = true;
    return this.data;
  }

  /** نوشتن اتمیک و صف‌بندی‌شده روی دیسک */
  save() {
    this.writeQueue = this.writeQueue.then(() => this.persist()).catch((err) => {
      console.error('[db] خطا در ذخیره‌سازی:', err.message);
    });
    return this.writeQueue;
  }

  async persist() {
    const dir = path.dirname(this.file);
    await fsp.mkdir(dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    const json = JSON.stringify(this.data, null, 2);
    await fsp.writeFile(tmp, json, 'utf8');
    await fsp.rename(tmp, this.file);
  }

  // ---- کمکی‌های عمومی ----
  find(collection, predicate) {
    return this.data[collection].find(predicate) || null;
  }

  filter(collection, predicate) {
    return this.data[collection].filter(predicate);
  }

  insert(collection, doc) {
    this.data[collection].push(doc);
    return doc;
  }

  /** جایگزینی یک سند بر اساس id */
  replace(collection, id, doc) {
    const list = this.data[collection];
    const idx = list.findIndex((item) => item.id === id);
    if (idx === -1) return null;
    list[idx] = doc;
    return doc;
  }

  remove(collection, id) {
    const list = this.data[collection];
    const idx = list.findIndex((item) => item.id === id);
    if (idx === -1) return false;
    list.splice(idx, 1);
    return true;
  }
}

const db = new JsonDatabase(config.dbFile);

module.exports = db;
module.exports.DEFAULT_DATA = DEFAULT_DATA;
