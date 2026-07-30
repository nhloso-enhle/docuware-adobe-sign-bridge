'use strict';

const express  = require('express');
const router   = express.Router();
const jobStore = require('../utils/jobStore');
const { verifyAdminKey } = require('../middleware/auth');

router.get('/health', function(_req, res) {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

router.get('/status/jobs', verifyAdminKey, function(_req, res) {
  res.json({ jobs: jobStore.all() });
});

router.get('/status/jobs/:agreementId', verifyAdminKey, function(req, res) {
  var job = jobStore.get(req.params.agreementId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

module.exports = router;
