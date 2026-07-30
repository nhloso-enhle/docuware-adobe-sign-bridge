'use strict';

require('dotenv').config();

const express = require('express');
const morgan  = require('morgan');
const logger  = require('./utils/logger');
const sign    = require('./services/adobeSign');

const docuwareWebhookRoute  = require('./routes/docuwareWebhook');
const adobeSignWebhookRoute = require('./routes/adobeSignWebhook');
const statusRoutes          = require('./routes/status');

// Required environment variables
var REQUIRED_ENV = [
  // DocuWare
  'DW_SERVER_URL',
  'DW_PLATFORM',
  'DW_USERNAME',
  'DW_PASSWORD',
  'DW_FILE_CABINET_ID',
  // Adobe Sign OAuth2
  'ADOBE_SIGN_CLIENT_ID',
  'ADOBE_SIGN_CLIENT_SECRET',
  'ADOBE_SIGN_REFRESH_TOKEN',
  'ADOBE_SIGN_API_BASE_URL',
  'ADOBE_SIGN_WEBHOOK_URL',
  // DocuWare inbound auth (HMAC for Webhooks module, Bearer for Web Service Activity)
  'DW_ORGANIZATION_PASSPHRASE',
  'DW_BRIDGE_API_KEY',
];

var missing = REQUIRED_ENV.filter(function(k) { return !process.env[k]; });
if (missing.length > 0) {
  console.error('\n[FATAL] Missing required environment variables:');
  missing.forEach(function(k) { console.error('  ' + k); });
  console.error('\nCopy .env.example to .env, fill in every value, then restart.\n');
  process.exit(1);
}

var app = express();

app.use(morgan('combined', {
  stream: { write: function(msg) { logger.http(msg.trim()); } },
}));

// Capture the raw request body before JSON parsing so that
// verifyDwHmac can compute the HMAC-SHA256 over the exact bytes DocuWare sent.
app.use(express.json({
  limit: '50mb',
  verify: function(req, _res, buf) {
    req.rawBody = buf;
  },
}));

app.use('/',                    statusRoutes);
app.use('/webhooks/docuware',   docuwareWebhookRoute);
app.use('/webhooks/adobe-sign', adobeSignWebhookRoute);

// 404
app.use(function(req, res) {
  res.status(404).json({
    error:  'Not found',
    path:   req.path,
    method: req.method,
    hint:   'Valid endpoints: POST /webhooks/docuware | GET+POST /webhooks/adobe-sign | GET /health',
  });
});

// Global error handler
// eslint-disable-next-line no-unused-vars
app.use(function(err, req, res, _next) {
  logger.error('Unhandled error', { path: req.path, error: err.message });
  res.status(500).json({ error: 'Internal server error', detail: err.message });
});

var PORT = parseInt(process.env.PORT || '3000', 10);

async function start() {
  // Start listening FIRST so the port is open before Adobe Sign tries to
  // verify the webhook URL.  The verification GET arrives within milliseconds
  // of the registration POST, so the server must already be accepting
  // connections when ensureAccountWebhook() is called.
  await new Promise(function(resolve, reject) {
    app.listen(PORT, function() {
      logger.info('DW <-> Adobe Sign Bridge running on port ' + PORT);
      logger.info('  DocuWare : ' + process.env.DW_SERVER_URL);
      logger.info('  Cabinet  : ' + process.env.DW_FILE_CABINET_ID);
      logger.info('  Sign API : ' + process.env.ADOBE_SIGN_API_BASE_URL);
      logger.info('  Callback : ' + process.env.ADOBE_SIGN_WEBHOOK_URL);
      logger.info('  POST /webhooks/docuware       <- DocuWare workflow trigger');
      logger.info('  GET|POST /webhooks/adobe-sign <- Adobe Sign callback');
      logger.info('  GET  /health');
      logger.info('  GET  /status/jobs');
      resolve();
    }).on('error', reject);
  });

  // NOW register the webhook -- server is accepting connections so Adobe
  // Sign's verification GET to /webhooks/adobe-sign will succeed.
  try {
    logger.info('[STARTUP] Registering Adobe Sign account webhook...');
    await sign.ensureAccountWebhook();
  } catch (err) {
    logger.warn(
      '[STARTUP] Adobe Sign webhook registration failed -- continuing. ' +
      'Error: ' + err.message
    );
  }
}

start().catch(function(err) {
  logger.error('Failed to start server', { error: err.message });
  process.exit(1);
});

module.exports = app;
