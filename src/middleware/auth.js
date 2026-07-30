'use strict';

/*
 * auth.js
 *
 * DocuWare calls this service in two different ways, each with different auth:
 *
 * 1. Webhooks module (DocuWare Configuration -> Integrations -> Webhooks)
 *    DocuWare automatically adds:
 *      x-docuware-signature: <hex HMAC-SHA512 of canonical JSON body>
 *    Secret: organization passphrase (Configuration -> Org Settings -> Security)
 *    Verify with: verifyDwHmac
 *
 * 2. Workflow Web Service Activity (Workflow Designer -> Web Service step)
 *    DocuWare calls whatever URL is registered in the Web Services config.
 *    The Web Service config supports setting auth headers: None, Basic,
 *    or Bearer Token. x-docuware-signature is NOT sent by this activity.
 *    Configure DocuWare to send:
 *      Authorization: Bearer <DW_BRIDGE_API_KEY>
 *    Verify with: verifyBearerToken
 *
 * The inbound DocuWare webhook route accepts EITHER method.
 * An invalid credential (present but wrong) always returns 401.
 * If neither header is present, the request is rejected.
 *
 * Ref: DocuWare knowledge center -- web-services, electronic-signatures-with-docusign-overview
 */

const crypto = require('crypto');
const logger = require('../utils/logger');

// ---------------------------------------------------------------------------
// HMAC helpers (used for Webhooks module path)
// ---------------------------------------------------------------------------

function normalizeSignature(sig) {
  if (!sig) return null;
  return String(sig)
    .trim()
    .replace(/^sha256=/i, '')
    .replace(/^sha512=/i, '')
    .replace(/^hmac=/i,   '')
    .replace(/^hmac-/i,   '')
    .replace(/^"(.*)"$/,  '$1');
}

/*
 * DocuWare signs a compact (whitespace-free) JSON serialisation of the body.
 * Re-serialising normalises any whitespace differences introduced by Express.
 */
function getCanonicalBody(rawBody) {
  const obj = JSON.parse(rawBody.toString('utf8'));
  return Buffer.from(JSON.stringify(obj));
}

function safeEqual(a, b) {
  try {
    const ba = Buffer.from(a, 'hex');
    const bb = Buffer.from(b, 'hex');
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

function checkHmac(req) {
  const passphrase = (process.env.DW_ORGANIZATION_PASSPHRASE || '').trim();
  if (!passphrase) return { skipped: true };

  const receivedHeader = req.headers['x-docuware-signature'];
  if (!receivedHeader) return { present: false };

  const rawBody = req.rawBody;
  if (!rawBody || rawBody.length === 0) return { error: 'empty_body' };

  let canonicalBody;
  try {
    canonicalBody = getCanonicalBody(rawBody);
  } catch {
    return { error: 'invalid_json' };
  }

  const receivedSig = normalizeSignature(receivedHeader);
  const expected    = crypto
    .createHmac('sha512', passphrase)
    .update(canonicalBody)
    .digest('hex');

  return { present: true, valid: safeEqual(receivedSig, expected) };
}

// ---------------------------------------------------------------------------
// verifyDwInbound
//
// Single middleware that covers both DocuWare call paths:
//
//   Path A -- Webhooks module:
//     x-docuware-signature present and valid -> pass
//     x-docuware-signature present and invalid -> 401 (always reject wrong sigs)
//
//   Path B -- Workflow Web Service Activity:
//     Authorization: Bearer <DW_BRIDGE_API_KEY> present and valid -> pass
//     Authorization: Bearer present and invalid -> 401
//
//   Neither header present -> 401
//
// Env vars:
//   DW_ORGANIZATION_PASSPHRASE  -- for HMAC path (Webhooks module)
//   DW_BRIDGE_API_KEY           -- for Bearer path (Web Service Activity)
//     Configure in DocuWare: Web Services -> your service -> Authentication:
//     Bearer Token -> paste DW_BRIDGE_API_KEY value
// ---------------------------------------------------------------------------
function verifyDwInbound(req, res, next) {

  // --- Path A: x-docuware-signature (Webhooks module) ----------------------
  const hmacResult = checkHmac(req);

  if (hmacResult.error === 'empty_body') {
    return res.status(400).json({ error: 'Empty or non-JSON request body' });
  }
  if (hmacResult.error === 'invalid_json') {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }
  if (hmacResult.present === true) {
    // Header was supplied -- must be valid; wrong value is always rejected
    if (hmacResult.valid) {
      logger.info('[AUTH] DocuWare HMAC signature verified (Webhooks module)', { ip: req.ip });
      return next();
    }
    logger.warn('[AUTH] Invalid x-docuware-signature', {
      ip:   req.ip,
      hint: 'Verify DW_ORGANIZATION_PASSPHRASE matches DocuWare Configuration -> ' +
            'Organization Settings -> Security tab.',
    });
    return res.status(401).json({
      error: 'Invalid x-docuware-signature',
      hint:  'Verify DW_ORGANIZATION_PASSPHRASE in .env.',
    });
  }

  // --- Path B: Bearer token (Workflow Web Service Activity) ----------------
  const apiKey         = (process.env.DW_BRIDGE_API_KEY || '').trim();
  const authHeader     = req.headers['authorization'] || '';
  const bearerMatch    = authHeader.match(/^Bearer\s+(.+)$/i);
  const providedToken  = bearerMatch ? bearerMatch[1].trim() : null;

  if (providedToken) {
    if (!apiKey) {
      logger.warn('[AUTH] Bearer token received but DW_BRIDGE_API_KEY not set -- rejecting', {
        ip: req.ip,
      });
      return res.status(401).json({
        error: 'Bearer token received but DW_BRIDGE_API_KEY is not configured on the server.',
      });
    }
    // Constant-time comparison for Bearer token
    try {
      const tokA = Buffer.from(providedToken);
      const tokB = Buffer.from(apiKey);
      const valid = tokA.length === tokB.length && crypto.timingSafeEqual(tokA, tokB);
      if (valid) {
        logger.info('[AUTH] Bearer token verified (Workflow Web Service Activity)', { ip: req.ip });
        return next();
      }
    } catch {}
    logger.warn('[AUTH] Invalid Bearer token', { ip: req.ip });
    return res.status(401).json({ error: 'Invalid Authorization Bearer token' });
  }

  // --- Neither header present ----------------------------------------------
  logger.warn('[AUTH] No recognised auth header on /webhooks/docuware', {
    ip:   req.ip,
    hint: 'Send either:\n' +
          '  x-docuware-signature (Webhooks module -- automatic)\n' +
          '  Authorization: Bearer <DW_BRIDGE_API_KEY> (Web Service Activity -- ' +
          'configure in DocuWare: Web Services -> your service -> ' +
          'Authentication: Bearer Token)',
  });
  return res.status(401).json({
    error: 'Unauthorized: no valid auth header provided',
    hint:  'DocuWare Webhooks module sends x-docuware-signature automatically. ' +
           'For Workflow Web Service Activity, configure Bearer Token auth in ' +
           'DocuWare Configuration -> Web Services -> your service entry.',
  });
}

// ---------------------------------------------------------------------------
// verifyAdminKey -- for GET /status/jobs
// ---------------------------------------------------------------------------
function verifyAdminKey(req, res, next) {
  const expected = process.env.ADMIN_API_KEY;
  if (!expected) return next();
  const provided = req.headers['x-admin-key'];
  if (!provided || provided !== expected) {
    return res.status(401).json({ error: 'Invalid or missing x-admin-key' });
  }
  next();
}

module.exports = { verifyDwInbound, verifyAdminKey };
