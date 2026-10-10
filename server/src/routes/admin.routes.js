'use strict';

const express = require('express');
const authService = require('../services/auth.service');
const { authenticate, requireRole } = require('../middleware/auth');
const validate = require('../middleware/validate');
const asyncHandler = require('../lib/asyncHandler');
const { createAdminSchema, updateAdminSchema } = require('../lib/schemas');

const router = express.Router();

router.use(authenticate, requireRole('admin'));

router.get('/', (req, res) => {
  res.json({ ok: true, data: authService.listAdmins() });
});

router.post('/', validate(createAdminSchema), asyncHandler(async (req, res) => {
  const admin = await authService.createAdmin(req.body, req.user.email);
  res.status(201).json({ ok: true, data: admin });
}));

router.patch('/:id', validate(updateAdminSchema), asyncHandler(async (req, res) => {
  const admin = await authService.updateAdmin(req.params.id, req.body, req.user.email);
  res.json({ ok: true, data: admin });
}));

router.delete('/:id', (req, res) => {
  authService.removeAdmin(req.params.id, req.user.email);
  res.json({ ok: true, data: { message: 'کاربر حذف شد' } });
});

module.exports = router;
