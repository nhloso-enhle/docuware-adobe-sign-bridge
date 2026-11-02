'use strict';

/*
 * adobeSign.js -- Adobe Acrobat Sign REST API v6 service
 *
 * -------------------------------------------------------------------------
 * AUTHENTICATION -- OAuth2 Refresh Token flow (from oauthDoc.jsp)
 * -------------------------------------------------------------------------
 *
 * Authorization Code exchange (one-time, done manually):
 *
 *   POST https://api.na4.adobesign.com/oauth/v2/token
 *   Content-Type: application/x-www-form-urlencoded
 *
 *   code=<code>&client_id=<id>&client_secret=<secret>
 *   &redirect_uri=<uri>&grant_type=authorization_code
 *
 *   Response includes:
 *   {
 *     "access_token":    "...",
 *     "refresh_token":   "...",   <- store as ADOBE_SIGN_REFRESH_TOKEN
 *     "expires_in":      3600,
 *     "token_type":      "Bearer",
 *     "api_access_point":"https://api.na4.adobesign.com/",  <- store (strip /)
 *     "web_access_point":"https://nhlosokhumalo.na4.adobesign.com/"
 *   }
 *
 *   IMPORTANT: api_access_point is the authoritative base URL for ALL
 *   subsequent calls -- REST API and OAuth endpoints alike.
 *   Store it verbatim (strip trailing slash) as ADOBE_SIGN_API_BASE_URL.
 *
 * Runtime token refresh:
 *
 *   POST {ADOBE_SIGN_API_BASE_URL}/oauth/v2/refresh
 *   Note: the OAuth endpoints are at the ROOT of the API host, NOT under
 *   /api/rest/v6/.
 *
 *   Parameters: grant_type, client_id, client_secret, refresh_token
 *
 *   Response: { access_token, expires_in, token_type }
 *   Refresh tokens expire after 60 days of inactivity.
 *
 * -------------------------------------------------------------------------
 * PARTNER vs CUSTOMER application type
 * -------------------------------------------------------------------------
 *
 *   CUSTOMER -- access only your own account.
 *               Use this for internal integrations (e.g. Ricoh SA).
 *               Scope: agreement_send:account webhook_write:account etc.
 *
 *   PARTNER  -- access any authorized Sign account.
 *               Requires Adobe certification before full account access.
 *               Scope modifiers (:account, :group, :self) still required.
 *               If you selected PARTNER by mistake for an internal tool,
 *               create a new CUSTOMER application.
 *
 * -------------------------------------------------------------------------
 * REST API endpoints used
 * -------------------------------------------------------------------------
 *
 *   POST /api/rest/v6/transientDocuments
 *   POST /api/rest/v6/agreements
 *   POST /api/rest/v6/webhooks
 *   GET  /api/rest/v6/agreements/{id}/combinedDocument
 */

const axios    = require('axios');
const FormData = require('form-data');
const logger   = require('../utils/logger');
const { withRetry } = require('../utils/retry');

var _tokenCache = null; // { value: string, expiresAt: number }

// ---------------------------------------------------------------------------
// apiBase -- e.g. https://api.na4.adobesign.com/api/rest/v6
// Built from ADOBE_SIGN_API_BASE_URL which must be the api_access_point
// value returned by the Authorization Code exchange response.
// ---------------------------------------------------------------------------
function apiBase() {
  var base = process.env.ADOBE_SIGN_API_BASE_URL;
  if (!base) throw new Error('ADOBE_SIGN_API_BASE_URL is not set');
  return base.replace(/\/$/, '') + '/api/rest/v6';
}

// ---------------------------------------------------------------------------
// refreshTokenEndpoint
// OAuth endpoints are at the ROOT of the API host (NOT under /api/rest/v6).
// Per oauthDoc.jsp: POST {api_access_point}/oauth/v2/refresh
// ---------------------------------------------------------------------------
function refreshTokenEndpoint() {
  var base = process.env.ADOBE_SIGN_API_BASE_URL;
  if (!base) throw new Error('ADOBE_SIGN_API_BASE_URL is not set');
  return base.replace(/\/$/, '') + '/oauth/v2/refresh';
}

// ---------------------------------------------------------------------------
// refreshAccessToken
// Parameters required per oauthDoc.jsp Refresh Request section:
//   grant_type, client_id, client_secret, refresh_token
// (No redirect_uri -- that is only needed for the initial code exchange.)
// ---------------------------------------------------------------------------
async function refreshAccessToken() {
  var clientId     = process.env.ADOBE_SIGN_CLIENT_ID;
  var clientSecret = process.env.ADOBE_SIGN_CLIENT_SECRET;
  var refreshToken = process.env.ADOBE_SIGN_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      'ADOBE_SIGN_CLIENT_ID, ADOBE_SIGN_CLIENT_SECRET, and ' +
      'ADOBE_SIGN_REFRESH_TOKEN must all be set in .env'
    );
  }

  var url = refreshTokenEndpoint();
  logger.info('[SIGN] Refreshing access token', { url: url });

  var params = new URLSearchParams({
    grant_type:    'refresh_token',
    client_id:     clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  });

  var res = await withRetry(
    function() {
      return axios.post(url, params.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
    },
    { label: 'sign-refresh-token' }
  );

  var access_token = res.data.access_token;
  var expires_in   = res.data.expires_in || 3600;

  if (!access_token) {
    throw new Error(
      'Adobe Sign token refresh did not return an access_token. ' +
      'Got: ' + JSON.stringify(res.data)
    );
  }

  logger.info('[SIGN] Access token refreshed', { expiresIn: expires_in });
  return { access_token: access_token, expires_in: expires_in };
}

// ---------------------------------------------------------------------------
// getAccessToken -- cached, refreshed 60s before expiry
// ---------------------------------------------------------------------------
async function getAccessToken() {
  var now = Date.now();
  if (_tokenCache && _tokenCache.expiresAt > now + 60000) {
    return _tokenCache.value;
  }
  var result = await refreshAccessToken();
  _tokenCache = {
    value:     result.access_token,
    expiresAt: now + result.expires_in * 1000,
  };
  return _tokenCache.value;
}

async function authHeader() {
  return { Authorization: 'Bearer ' + (await getAccessToken()) };
}

// ---------------------------------------------------------------------------
// uploadTransientDocument
// POST /api/rest/v6/transientDocuments
// Body: multipart/form-data, single "File" part.
// ---------------------------------------------------------------------------
async function uploadTransientDocument(pdfBuffer, fileName) {
  fileName = fileName || 'document.pdf';
  var form = new FormData();
  form.append('File', pdfBuffer, { filename: fileName, contentType: 'application/pdf' });

  logger.info('[SIGN] Uploading transient document', { fileName: fileName, bytes: pdfBuffer.length });

  var auth = await authHeader();
  var res = await withRetry(
    function() {
      return axios.post(apiBase() + '/transientDocuments', form, {
        headers: Object.assign({}, auth, form.getHeaders()),
        maxContentLength: Infinity,
        maxBodyLength:    Infinity,
      });
    },
    { label: 'sign-uploadTransient' }
  );

  var transientDocumentId = res.data.transientDocumentId;
  logger.info('[SIGN] Transient document uploaded', { transientDocumentId: transientDocumentId });
  return transientDocumentId;
}

// ---------------------------------------------------------------------------
// createAgreement
// POST /api/rest/v6/agreements
// ---------------------------------------------------------------------------
async function createAgreement(opts) {
  /*
   * Adobe Sign participantSetsInfo structure (per API spec):
   *
   *   participantSetsInfo: [
   *     { memberInfos: [{ email, name }], order: 1, role: "SIGNER" },
   *     { memberInfos: [{ email, name }], order: 2, role: "APPROVER" },
   *     ...
   *   ]
   *
   * Each signer maps to its own participantSet.
   * Signing is SEQUENTIAL across different order values.
   * To sign in PARALLEL, give multiple signers the same order value --
   * Adobe Sign will deliver to all of them simultaneously at that step.
   * Default order is the signer's position in the array (1-based).
   * Default role is SIGNER.
   */
  var participantSetsInfo = opts.signers.map(function(signer, idx) {
    return {
      memberInfos: [{ email: signer.email, name: signer.name || '' }],
      order:       signer.order != null ? signer.order : idx + 1,
      role:        (signer.role || 'SIGNER').toUpperCase(),
    };
  });

  var payload = {
      fileInfos: [{ transientDocumentId: opts.transientDocumentId }],
      name: opts.agreementName,
      participantSetsInfo: participantSetsInfo,
      signatureType: opts.signatureType || 'ESIGN',
      state: 'AUTHORING',
      message: opts.message || 'Please review and sign the attached document.',
      // Combine the namespace directly into the id string:
      externalId: { 
          id: `DW_BRIDGE:${opts.externalId}` 
      }
  };

  logger.info('[SIGN] Creating agreement', { name: opts.agreementName, signerCount: opts.signers.length });
  var auth = await authHeader();
  var res = await withRetry(
    function() {
      return axios.post(apiBase() + '/agreements', payload, {
        headers: Object.assign({}, auth, { 'Content-Type': 'application/json' }),
      });
    },
    { label: 'sign-createAgreement' }
  );

  logger.info('[SIGN] Agreement created', { agreementId: res.data.id });
  return { agreementId: res.data.id };
}

// ---------------------------------------------------------------------------
// ensureAccountWebhook
// POST /api/rest/v6/webhooks
// Registered once at startup AFTER app.listen() resolves.
// Scope must include webhook_write:account.
// ---------------------------------------------------------------------------
async function ensureAccountWebhook() {
  var webhookUrl = process.env.ADOBE_SIGN_WEBHOOK_URL + '/webhooks/adobe-sign';
  var payload = {
    name:  'DW-Sign-Bridge',
    scope: 'ACCOUNT',
    state: 'ACTIVE',
    webhookSubscriptionEvents: ['AGREEMENT_WORKFLOW_COMPLETED'],
    webhookUrlInfo: { url: webhookUrl },
  };

  var url  = apiBase() + '/webhooks';
  var auth = await authHeader();
  logger.info('[SIGN] Registering account-level webhook', { webhookUrl: webhookUrl, apiEndpoint: url });

  try {
    var res = await axios.post(url, payload, {
      headers: Object.assign({}, auth, { 'Content-Type': 'application/json' }),
    });
    logger.info('[SIGN] Webhook registered', { webhookId: res.data && res.data.id });
  } catch (err) {
    var status  = err.response && err.response.status;
    var errBody = err.response && err.response.data;
    var code    = errBody && (errBody.code || errBody.reason || '');

    if (status === 409 || (code && code.toString().indexOf('DUPLICATE') !== -1)) {
      logger.info('[SIGN] Webhook already registered');
      return;
    }

    logger.error('[SIGN] Webhook registration failed', {
      status:  status,
      code:    code,
      message: errBody && errBody.message,
      hint: status === 403
        ? 'Ensure the OAuth app has webhook_write:account scope. ' +
          'For PARTNER apps, the account must have authorized your app.'
        : status === 401
        ? 'Check ADOBE_SIGN_CLIENT_ID, ADOBE_SIGN_CLIENT_SECRET, and ' +
          'ADOBE_SIGN_REFRESH_TOKEN. Refresh tokens expire after 60 days ' +
          'of inactivity.'
        : 'Check ADOBE_SIGN_API_BASE_URL equals the api_access_point from ' +
          'your initial Authorization Code token exchange.',
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// downloadSignedDocument
// GET /api/rest/v6/agreements/{id}/combinedDocument
// ---------------------------------------------------------------------------
async function downloadSignedDocument(agreementId) {
  var url  = apiBase() + '/agreements/' + agreementId + '/combinedDocument';
  var auth = await authHeader();
  logger.info('[SIGN] Downloading signed document', { agreementId: agreementId });

  var res = await withRetry(
    function() {
      return axios.get(url, {
        headers:      Object.assign({}, auth, { Accept: 'application/pdf' }),
        responseType: 'arraybuffer',
      });
    },
    { label: 'sign-downloadSigned' }
  );

  var buf = Buffer.from(res.data);
  logger.info('[SIGN] Signed PDF downloaded', { agreementId: agreementId, bytes: buf.length });
  return buf;
}

/*
 * getAgreementDetails
 * GET /api/rest/v6/agreements/{id}
 * Returns the full agreement object, including externalId which encodes
 * the DocuWare fileCabinetId|documentId used for job recovery after restart.
 */
async function getAgreementDetails(agreementId) {
  var auth = await authHeader();
  var res = await withRetry(
    function() {
      return axios.get(apiBase() + '/agreements/' + agreementId, { headers: auth });
    },
    { label: 'sign-getDetails' }
  );
  return res.data;
}

async function getAgreementStatus(agreementId) {
  var details = await getAgreementDetails(agreementId);
  return details.status;
}

/*
 * recoverJobFromAdobeSign
 * Fetches agreement details from Adobe Sign when a webhook arrives for an unknown
 * agreementId (typically after a server restart). Parses the DW_BRIDGE externalId
 * to recover the DocuWare context.
 */
async function recoverJobFromAdobeSign(agreementId) {
  try {
    var agreementData = await getAgreementDetails(agreementId);
    var externalIdObj = agreementData.externalId;
    var externalIdString = externalIdObj ? externalIdObj.id : null;

    // Validate the DW_BRIDGE prefix namespace
    if (!externalIdString || !externalIdString.startsWith('DW_BRIDGE:')) {
      logger.warn(
        '[SIGN-WEBHOOK] Agreement externalId missing or not from DW_BRIDGE',
        { agreementId: agreementId, externalId: externalIdObj }
      );
      return null;
    }

    // Strip the prefix and split the DocuWare identifiers
    // Format stored: "DW_BRIDGE:07923215-c8d1-4e6a-b727-c1fd7b6ab7a7|43"
    var rawData = externalIdString.replace('DW_BRIDGE:', '');
    var parts = rawData.split('|');
    var docGuid = parts[0];
    var cabinetId = parts[1];

    if (!docGuid) {
      logger.warn('[SIGN-WEBHOOK] Extracted DocuWare GUID is invalid', { agreementId: agreementId });
      return null;
    }

    logger.info(
      '[SIGN-WEBHOOK] Recovery successful! Re-hydrated job context from externalId.',
      { agreementId: agreementId, docGuid: docGuid, cabinetId: cabinetId }
    );

    // Return the job object so your webhook processor can resume execution
    return {
      agreementId: agreementId,
      docGuid: docGuid,
      cabinetId: cabinetId
    };

  } catch (err) {
    logger.error(
      '[SIGN-WEBHOOK] Exception occurred during job recovery: ' + err.message,
      { agreementId: agreementId }
    );
    return null;
  }
}

module.exports = {
  getAccessToken:          getAccessToken,
  uploadTransientDocument: uploadTransientDocument,
  createAgreement:         createAgreement,
  ensureAccountWebhook:    ensureAccountWebhook,
  downloadSignedDocument:  downloadSignedDocument,
  getAgreementDetails:     getAgreementDetails,
  getAgreementStatus:      getAgreementStatus,
};
