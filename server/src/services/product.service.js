'use strict';

const db = require('../db/database');
const { id, now, uniqueSlug, compact, paginate } = require('../lib/utils');
const { notFound, conflict, badRequest } = require('../lib/httpError');
const pricing = require('./pricing.service');

const PUBLIC_FIELDS = [
  'id',
  'name',
  'slug',
  'sku',
  'brand',
  'category',
  'status',
  'shortDescription',
  'description',
  'price',
  'compareAtPrice',
  'pricingMode',
  'stock',
  'trackStock',
  'specs',
  'images',
  'tags',
  'weightGrams',
  'dimensions',
  'featured',
  'createdAt',
  'updatedAt',
  'priceUpdatedAt',
];

/** فیلدهایی که فقط ادمین می‌بیند (مثل قیمت خرید و حاشیه سود) */
function toAdminJson(p) {
  return { ...p };
}

function toPublicJson(p) {
  return PUBLIC_FIELDS.reduce((acc, key) => {
    acc[key] = p[key];
    return acc;
  }, {});
}

function allSlugs(exceptId = null) {
  return db.data.products.filter((p) => p.id !== exceptId).map((p) => p.slug);
}

/** محاسبه و اعمال قیمت بر اساس حالت محصول */
function applyPricing(product, actor) {
  if (product.pricingMode === 'manual') {
    product.price = product.manualPrice ?? product.price ?? 0;
  } else {
    const { price } = pricing.calculatePrice(product);
    product.price = price;
  }
  product.priceUpdatedAt = now();
  product.updatedBy = actor || null;
  return product;
}

function create(input, actor) {
  const slug = uniqueSlug(input.slug || input.name, allSlugs());
  if (input.sku) {
    const dup = db.data.products.find(
      (p) => p.sku && String(p.sku).toLowerCase() === String(input.sku).toLowerCase()
    );
    if (dup) throw conflict(`کد کالای «${input.sku}» قبلاً استفاده شده است`);
  }

  const ts = now();
  const product = {
    id: id('prd'),
    name: input.name,
    slug,
    sku: input.sku || null,
    brand: input.brand || null,
    category: input.category || null,
    status: input.status || 'draft',
    shortDescription: input.shortDescription || null,
    description: input.description || null,
    cost: { amount: Number(input.cost?.amount ?? 0), currency: input.cost?.currency || 'IRR' },
    pricingMode: input.pricingMode || 'auto',
    marginPercent: input.marginPercent ?? null,
    manualPrice: input.manualPrice ?? null,
    price: 0,
    compareAtPrice: input.compareAtPrice ?? null,
    stock: Number(input.stock ?? 0),
    trackStock: input.trackStock !== false,
    lowStockThreshold: Number(input.lowStockThreshold ?? 0),
    specs: input.specs || [],
    images: input.images || [],
    tags: input.tags || [],
    weightGrams: input.weightGrams ?? null,
    dimensions: input.dimensions || null,
    seo: input.seo || null,
    featured: input.featured === true,
    createdAt: ts,
    updatedAt: ts,
    updatedBy: actor || null,
    priceUpdatedAt: null,
  };

  applyPricing(product, actor);
  db.data.products.push(product);
  db.save();
  return product;
}

function update(productId, patch, actor) {
  const product = db.find('products', (p) => p.id === productId);
  if (!product) throw notFound('کالا یافت نشد');

  const data = compact(patch);

  if (data.slug !== undefined) {
    data.slug = uniqueSlug(data.slug || product.name, allSlugs(productId));
  }
  if (data.sku) {
    const dup = db.data.products.find(
      (p) =>
        p.id !== productId &&
        p.sku &&
        String(p.sku).toLowerCase() === String(data.sku).toLowerCase()
    );
    if (dup) throw conflict(`کد کالای «${data.sku}» قبلاً استفاده شده است`);
  }
  if (data.cost) {
    data.cost = { ...product.cost, ...data.cost };
  }

  const next = { ...product, ...data, updatedAt: now(), updatedBy: actor || null };

  const pricingTouched =
    data.cost !== undefined ||
    data.marginPercent !== undefined ||
    data.pricingMode !== undefined ||
    data.manualPrice !== undefined;

  if (pricingTouched) applyPricing(next, actor);

  db.replace('products', productId, next);
  db.save();
  return next;
}

function remove(productId) {
  const ok = db.remove('products', productId);
  if (!ok) throw notFound('کالا یافت نشد');
  db.data.priceHistory = db.data.priceHistory.filter((h) => h.productId !== productId);
  db.save();
  return true;
}

function getById(productId) {
  const product = db.find('products', (p) => p.id === productId || p.slug === productId);
  if (!product) throw notFound('کالا یافت نشد');
  return product;
}

/** لیست مدیریتی با فیلتر و مرتب‌سازی */
function list(query = {}) {
  let rows = [...db.data.products];

  const q = (query.q || '').trim().toLowerCase();
  if (q) {
    rows = rows.filter((p) =>
      [p.name, p.sku, p.brand, p.category, p.slug, ...(p.tags || [])]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q))
    );
  }
  if (query.status) rows = rows.filter((p) => p.status === query.status);
  if (query.category) rows = rows.filter((p) => p.category === query.category);
  if (query.pricingMode) rows = rows.filter((p) => p.pricingMode === query.pricingMode);
  if (query.lowStock) rows = rows.filter((p) => p.trackStock && p.stock <= (p.lowStockThreshold || 0));
  if (query.sort) rows = sortRows(rows, query.sort);
  else rows = rows.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));

  return paginate(rows, { page: query.page, limit: query.limit });
}

function sortRows(rows, sort) {
  const copy = [...rows];
  switch (sort) {
    case 'priceAsc':
      return copy.sort((a, b) => a.price - b.price);
    case 'priceDesc':
      return copy.sort((a, b) => b.price - a.price);
    case 'name':
      return copy.sort((a, b) => a.name.localeCompare(b.name, 'fa'));
    case 'stockAsc':
      return copy.sort((a, b) => a.stock - b.stock);
    case 'oldest':
      return copy.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    case 'newest':
    default:
      return copy.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }
}

/** لیست عمومیِ فروشگاه — فقط کالاهای منتشرشده */
function listPublic(query = {}) {
  let rows = db.data.products.filter((p) => p.status === 'active');

  const q = (query.q || '').trim().toLowerCase();
  if (q) {
    rows = rows.filter((p) =>
      [p.name, p.sku, p.brand, p.category, p.shortDescription, ...(p.tags || [])]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q))
    );
  }
  if (query.category) rows = rows.filter((p) => p.category === query.category);
  if (query.brand) rows = rows.filter((p) => p.brand === query.brand);
  if (query.featured !== undefined) rows = rows.filter((p) => Boolean(p.featured) === query.featured);
  if (query.inStock) rows = rows.filter((p) => !p.trackStock || p.stock > 0);
  if (query.minPrice !== undefined) rows = rows.filter((p) => p.price >= query.minPrice);
  if (query.maxPrice !== undefined) rows = rows.filter((p) => p.price <= query.maxPrice);

  rows = sortRows(rows, query.sort);
  const page = paginate(rows, { page: query.page, limit: query.limit });
  return { ...page, items: page.items.map(toPublicJson) };
}

/** عملیات گروهی مورد استفاده در پنل */
function bulk({ ids, action, category, marginPercent }, actor) {
  const result = { affected: 0, deleted: 0, repriced: 0 };

  if (action === 'delete') {
    for (const pid of ids) {
      if (db.remove('products', pid)) result.deleted += 1;
    }
    db.data.priceHistory = db.data.priceHistory.filter((h) => !ids.includes(h.productId));
    db.save();
    return result;
  }

  if (action === 'reprice') {
    const { changes } = pricing.recalculate({ ids, reason: 'bulk', actor, save: false });
    result.repriced = changes.length;
    result.affected = changes.length;
    db.save();
    return result;
  }

  for (const pid of ids) {
    const product = db.find('products', (p) => p.id === pid);
    if (!product) continue;
    switch (action) {
      case 'activate':
        product.status = 'active';
        break;
      case 'deactivate':
        product.status = 'draft';
        break;
      case 'archive':
        product.status = 'archived';
        break;
      case 'setCategory':
        if (!category) throw badRequest('دسته‌بندی جدید مشخص نشده است');
        product.category = category;
        break;
      case 'setMargin':
        if (marginPercent === undefined) throw badRequest('درصد سود مشخص نشده است');
        if (product.pricingMode === 'manual') break;
        product.marginPercent = marginPercent;
        applyPricing(product, actor);
        break;
      default:
        throw badRequest('عملیات گروهی نامعتبر است');
    }
    product.updatedAt = now();
    product.updatedBy = actor || null;
    result.affected += 1;
  }
  db.save();
  return result;
}

/** آمار مورد نیاز داشبورد */
function stats() {
  const products = db.data.products;
  const lastRun = db.data.priceRuns[0] || null;
  return {
    total: products.length,
    active: products.filter((p) => p.status === 'active').length,
    draft: products.filter((p) => p.status === 'draft').length,
    archived: products.filter((p) => p.status === 'archived').length,
    outOfStock: products.filter((p) => p.trackStock && p.stock <= 0).length,
    lowStock: products.filter(
      (p) => p.trackStock && p.stock > 0 && p.stock <= (p.lowStockThreshold || 0)
    ).length,
    autoPriced: products.filter((p) => p.pricingMode === 'auto').length,
    manualPriced: products.filter((p) => p.pricingMode === 'manual').length,
    categories: [...new Set(products.map((p) => p.category).filter(Boolean))].length,
    inventoryValue: Math.round(
      products.reduce((sum, p) => {
        let rate = 1;
        try {
          rate = pricing.rateOf(p.cost?.currency);
        } catch (_) {
          rate = 1;
        }
        return sum + (p.cost?.amount || 0) * rate * p.stock;
      }, 0)
    ),
    lastPriceRun: lastRun,
    lastPriceChanges: db.data.priceHistory.slice(0, 5),
  };
}

module.exports = {
  create,
  update,
  remove,
  getById,
  list,
  listPublic,
  bulk,
  stats,
  toPublicJson,
  toAdminJson,
  applyPricing,
};
