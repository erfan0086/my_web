'use strict';

const { z } = require('zod');

const STATUSES = ['draft', 'active', 'archived'];
const PRICING_MODES = ['auto', 'manual'];

const money = z.coerce
  .number({ invalid_type_error: 'مقدار باید عدد باشد' })
  .finite('مقدار باید عدد باشد')
  .min(0, 'مقدار نمی‌تواند منفی باشد');
const currencyCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, 'کد ارز باید ۳ حرف لاتین باشد');

const specSchema = z.object({
  key: z.string().trim().min(1, 'نام مشخصه الزامی است').max(80),
  value: z.string().trim().min(1, 'مقدار مشخصه الزامی است').max(300),
});

const productBase = {
  name: z.string().trim().min(1, 'نام کالا الزامی است').max(200),
  slug: z.string().trim().max(200).optional(),
  sku: z.string().trim().max(64).optional().nullable(),
  brand: z.string().trim().max(120).optional().nullable(),
  category: z.string().trim().max(120).optional().nullable(),
  status: z.enum(STATUSES).default('draft'),
  shortDescription: z.string().trim().max(500).optional().nullable(),
  description: z.string().trim().max(20000).optional().nullable(),
  cost: z
    .object({
      amount: money.default(0),
      currency: currencyCode.default('IRR'),
    })
    .default({ amount: 0, currency: 'IRR' }),
  pricingMode: z.enum(PRICING_MODES).default('auto'),
  marginPercent: z.coerce.number().finite().min(-100).max(1000).optional().nullable(),
  manualPrice: money.optional().nullable(),
  compareAtPrice: money.optional().nullable(),
  stock: z.coerce.number().int().min(0).default(0),
  trackStock: z.boolean().default(true),
  lowStockThreshold: z.coerce.number().int().min(0).default(0),
  specs: z.array(specSchema).max(100).default([]),
  images: z.array(z.string().trim().url('آدرس تصویر معتبر نیست').max(2000)).max(20).default([]),
  tags: z.array(z.string().trim().min(1).max(50)).max(30).default([]),
  weightGrams: z.coerce.number().int().min(0).optional().nullable(),
  dimensions: z
    .object({
      length: z.coerce.number().min(0).optional().nullable(),
      width: z.coerce.number().min(0).optional().nullable(),
      height: z.coerce.number().min(0).optional().nullable(),
    })
    .optional()
    .nullable(),
  seo: z
    .object({
      title: z.string().trim().max(200).optional().nullable(),
      description: z.string().trim().max(500).optional().nullable(),
    })
    .optional()
    .nullable(),
  featured: z.boolean().default(false),
};

const createProductSchema = z.object(productBase);

// در ویرایشِ جزئی، ارسالِ فقط «amount» نباید ارز را به پیش‌فرض برگرداند
const costUpdateSchema = z.object({
  amount: money.optional(),
  currency: currencyCode.optional(),
});
const updateProductSchema = z
  .object({ ...productBase, cost: costUpdateSchema.optional() })
  .partial();

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('ایمیل معتبر نیست'),
  password: z.string().min(6, 'رمز عبور باید حداقل ۶ کاراکتر باشد'),
});

const createAdminSchema = z.object({
  name: z.string().trim().min(1, 'نام الزامی است').max(120),
  email: z.string().trim().toLowerCase().email('ایمیل معتبر نیست'),
  password: z.string().min(8, 'رمز عبور باید حداقل ۸ کاراکتر باشد'),
  role: z.enum(['admin', 'editor']).default('editor'),
});

const updateAdminSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    email: z.string().trim().toLowerCase().email().optional(),
    password: z.string().min(8).optional(),
    role: z.enum(['admin', 'editor']).optional(),
    isActive: z.boolean().optional(),
  })
  .partial();

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'رمز فعلی الزامی است'),
  newPassword: z.string().min(8, 'رمز جدید باید حداقل ۸ کاراکتر باشد'),
});

const bulkSchema = z.object({
  ids: z.array(z.string().min(1)).min(1, 'حداقل یک مورد انتخاب کنید').max(500),
  action: z.enum(['activate', 'deactivate', 'archive', 'delete', 'reprice', 'setCategory', 'setMargin']),
  category: z.string().trim().max(120).optional(),
  marginPercent: z.coerce.number().finite().min(-100).max(1000).optional(),
});

const publicQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  category: z.string().trim().max(120).optional(),
  brand: z.string().trim().max(120).optional(),
  featured: z.coerce.boolean().optional(),
  minPrice: z.coerce.number().min(0).optional(),
  maxPrice: z.coerce.number().min(0).optional(),
  inStock: z.coerce.boolean().optional(),
  sort: z.enum(['newest', 'oldest', 'priceAsc', 'priceDesc', 'name']).default('newest'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

module.exports = {
  STATUSES,
  PRICING_MODES,
  createProductSchema,
  updateProductSchema,
  loginSchema,
  createAdminSchema,
  updateAdminSchema,
  changePasswordSchema,
  bulkSchema,
  publicQuerySchema,
};
