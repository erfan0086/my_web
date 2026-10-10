'use strict';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db/database');
const config = require('../config');
const { id, now } = require('../lib/utils');
const { unauthorized, conflict, notFound, badRequest } = require('../lib/httpError');

const ROLES = ['admin', 'editor'];

const publicUser = (u) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role: u.role,
  isActive: u.isActive,
  lastLoginAt: u.lastLoginAt,
  createdAt: u.createdAt,
});

function signToken(user) {
  return jwt.sign({ sub: user.id, role: user.role, email: user.email }, config.jwt.secret, {
    expiresIn: config.jwt.expiresIn,
  });
}

async function login(email, password) {
  const user = db.find('admins', (a) => a.email === String(email).trim().toLowerCase());
  // پیام یکسان برای ایمیل/رمز اشتباه (عدم افشای وجود حساب)
  if (!user) throw unauthorized('ایمیل یا رمز عبور اشتباه است');
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) throw unauthorized('ایمیل یا رمز عبور اشتباه است');
  if (!user.isActive) throw unauthorized('این حساب غیرفعال است');

  user.lastLoginAt = now();
  db.save();
  return { token: signToken(user), user: publicUser(user) };
}

async function createAdmin(input, actor) {
  const email = String(input.email).trim().toLowerCase();
  if (db.find('admins', (a) => a.email === email)) {
    throw conflict('این ایمیل قبلاً ثبت شده است');
  }
  const admin = {
    id: id('adm'),
    name: input.name,
    email,
    role: input.role,
    passwordHash: await bcrypt.hash(input.password, 12),
    isActive: true,
    createdAt: now(),
    updatedAt: now(),
    lastLoginAt: null,
  };
  db.insert('admins', admin);
  db.save();
  console.log(`[auth] ادمین جدید ساخته شد: ${email} (توسط ${actor || 'سیستم'})`);
  return publicUser(admin);
}

async function updateAdmin(adminId, patch, actor) {
  const admin = db.find('admins', (a) => a.id === adminId);
  if (!admin) throw notFound('کاربر یافت نشد');

  const next = { ...admin, updatedAt: now() };
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.role !== undefined) next.role = patch.role;
  if (patch.isActive !== undefined) next.isActive = patch.isActive;
  if (patch.email !== undefined) {
    const email = String(patch.email).toLowerCase();
    const dup = db.find('admins', (a) => a.email === email && a.id !== adminId);
    if (dup) throw conflict('این ایمیل قبلاً استفاده شده است');
    next.email = email;
  }
  if (patch.password !== undefined) {
    next.passwordHash = await bcrypt.hash(patch.password, 12);
  }

  // جلوگیری از قفل شدن سیستم: آخرین ادمین نباید غیرفعال یا تنزل رتبه شود
  const remainingAdmins = db.data.admins.filter((a) => a.role === 'admin' && a.id !== adminId);
  if (remainingAdmins.length === 0 && (next.role !== 'admin' || next.isActive === false)) {
    throw badRequest('حداقل یک مدیر ارشد (admin) باید فعال باقی بماند');
  }

  db.replace('admins', adminId, next);
  db.save();
  console.log(`[auth] کاربر ${next.email} بروزرسانی شد (توسط ${actor || 'سیستم'})`);
  return publicUser(next);
}

async function removeAdmin(adminId, actor) {
  const admin = db.find('admins', (a) => a.id === adminId);
  if (!admin) throw notFound('کاربر یافت نشد');
  const remaining = db.data.admins.filter((a) => a.role === 'admin' && a.id !== adminId);
  if (remaining.length === 0) throw badRequest('آخرین مدیر ارشد را نمی‌توان حذف کرد');
  db.remove('admins', adminId);
  db.save();
  console.log(`[auth] کاربر ${admin.email} حذف شد (توسط ${actor || 'سیستم'})`);
  return true;
}

async function changePassword(adminId, currentPassword, newPassword) {
  const admin = db.find('admins', (a) => a.id === adminId);
  if (!admin) throw notFound('کاربر یافت نشد');
  const ok = await bcrypt.compare(currentPassword, admin.passwordHash);
  if (!ok) throw unauthorized('رمز فعلی اشتباه است');
  admin.passwordHash = await bcrypt.hash(newPassword, 12);
  admin.updatedAt = now();
  db.save();
  return true;
}

function listAdmins() {
  return db.data.admins.map(publicUser);
}

function verifyToken(token) {
  return jwt.verify(token, config.jwt.secret);
}

function findById(adminId) {
  return db.find('admins', (a) => a.id === adminId);
}

module.exports = {
  ROLES,
  login,
  createAdmin,
  updateAdmin,
  removeAdmin,
  changePassword,
  listAdmins,
  verifyToken,
  findById,
  publicUser,
};
