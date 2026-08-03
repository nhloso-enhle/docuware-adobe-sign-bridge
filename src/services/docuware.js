'use strict';

/*
 * docuware.js -- DocuWare Platform REST API service
 *
 * Authentication (OAuth2 ROPC via OIDC discovery):
 *
 *  Step 1  GET  {DW_SERVER_URL}/{DW_PLATFORM}/Home/IdentityServiceInfo
 *               -> { IdentityServiceUrl: "https://..." }
 *
 *  Step 2  GET  {IdentityServiceUrl}/.well-known/openid-configuration
 *               -> { token_endpoint: "https://..." }
 *
 *  Step 3  POST {token_endpoint}  (urlencoded)
 *               grant_type = password
 *               client_id  = docuware.platform.net.client
 *               scope      = docuware.platform
 *               username   = <DW_USERNAME>
 *               password   = <DW_PASSWORD>
 *               -> { access_token, token_type, expires_in }
 *
 * Document operations (confirmed against Postman collection):
 *
 *  Get sections   GET  .../FileCabinets/{fc}/Sections?DocId={docId}
 *  Download       GET  .../FileCabinets/{fc}/Sections/{sid}/Data
 *  Replace        POST .../FileCabinets/{fc}/Sections/{sid}/Data?fileName={name}
 *                      Content-Type: application/pdf  (raw binary -- NOT multipart)
 *                      Content-Disposition: file; filename="{name}"
 *                      X-File-ModifiedDate: <ISO-8601>
 *  Update fields  PUT  .../FileCabinets/{fc}/Documents/{docId}/Fields
 */

const axios  = require('axios');
const logger = require('../utils/logger');
const { withRetry } = require('../utils/retry');

// Token cache: { accessToken: string, expiresAt: number }
let _tokenCache = null;

// ---------------------------------------------------------------------------
// platformUrl
// Construct the full DocuWare Platform base URL from env vars.
// e.g. https://yourorg.docuware.cloud/DocuWare/Platform
// ---------------------------------------------------------------------------
function platformUrl() {
  const server   = process.env.DW_SERVER_URL;
  const platform = process.env.DW_PLATFORM;
  if (!server || !platform) {
    throw new Error('DW_SERVER_URL and DW_PLATFORM must both be set in .env');
  }
  return `${server}/${platform}`;
}

// ---------------------------------------------------------------------------
// getTokenEndpoint
// OIDC discovery: IdentityServiceInfo -> openid-configuration -> token_endpoint
// ---------------------------------------------------------------------------
async function getTokenEndpoint() {
  const infoUrl = `${platformUrl()}/Home/IdentityServiceInfo`;
  logger.debug('[DW] Discovering Identity Service', { url: infoUrl });

  const infoRes = await axios.get(infoUrl, {
    headers: { Accept: 'application/json' },
  });

  const identityServiceUrl =
    infoRes.data && (infoRes.data.IdentityServiceUrl || infoRes.data.ServiceUrl);

  if (!identityServiceUrl) {
    throw new Error(
      'DocuWare IdentityServiceInfo did not return an IdentityServiceUrl. ' +
      'Got: ' + JSON.stringify(infoRes.data)
    );
  }

  logger.debug('[DW] IdentityServiceUrl resolved', { identityServiceUrl });

  const oidcRes = await axios.get(
    `${identityServiceUrl}/.well-known/openid-configuration`,
    { headers: { Accept: 'application/json' } }
  );

  const tokenEndpoint = oidcRes.data && oidcRes.data.token_endpoint;
  if (!tokenEndpoint) {
    throw new Error(
      'OIDC discovery did not return a token_endpoint. ' +
      'Got: ' + JSON.stringify(oidcRes.data)
    );
  }

  logger.debug('[DW] Token endpoint resolved', { tokenEndpoint });
  return tokenEndpoint;
}

// ---------------------------------------------------------------------------
// getAccessToken
// Returns a cached Bearer token, refreshing it 60s before expiry.
// ---------------------------------------------------------------------------
async function getAccessToken() {
  const now = Date.now();
  if (_tokenCache && _tokenCache.expiresAt > now + 60000) {
    logger.debug('[DW] Reusing cached access token');
    return _tokenCache.accessToken;
  }

  logger.info('[DW] Requesting new access token');
  const tokenEndpoint = await getTokenEndpoint();

  const params = new URLSearchParams({
    grant_type: 'password',
    scope:      process.env.DW_SCOPE     || 'docuware.platform',
    client_id:  process.env.DW_CLIENT_ID || 'docuware.platform.net.client',
    username:   process.env.DW_USERNAME,
    password:   process.env.DW_PASSWORD,
  });

  const res = await withRetry(
    () => axios.post(tokenEndpoint, params.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept':       'application/json',
      },
    }),
    { label: 'dw-token' }
  );

  const access_token = res.data.access_token;
  const expires_in   = res.data.expires_in;

  if (!access_token) {
    throw new Error(
      'DocuWare token response missing access_token. Got: ' +
      JSON.stringify(res.data)
    );
  }

  _tokenCache = {
    accessToken: access_token,
    expiresAt:   now + (expires_in || 3600) * 1000,
  };

  logger.info('[DW] Access token acquired', { expiresIn: expires_in });
  return access_token;
}

// ---------------------------------------------------------------------------
// authHeaders
// Returns an object with Authorization + Accept + any extra headers.
// Must be called with await inside an async function.
// ---------------------------------------------------------------------------
async function authHeaders(extra) {
  const token = await getAccessToken();
  return Object.assign(
    { Authorization: 'Bearer ' + token, Accept: 'application/json' },
    extra || {}
  );
}

// ---------------------------------------------------------------------------
// getDocumentSections
// GET .../FileCabinets/{fc}/Sections?DocId={documentId}
// Returns an array of section objects: [{ Id, ContentType, OriginalFileName, ... }]
// ---------------------------------------------------------------------------
async function getDocumentSections(fileCabinetId, documentId) {
  const url = `${platformUrl()}/FileCabinets/${fileCabinetId}/Sections`;
  logger.info('[DW] Fetching document sections', { fileCabinetId, documentId });

  // The arrow function passed to withRetry MUST be async so that
  // 'await authHeaders()' is valid inside it.
  const res = await withRetry(
    async () => axios.get(url, {
      params:  { DocId: documentId },
      headers: await authHeaders(),
    }),
    { label: 'dw-getSections' }
  );

  let sections = (res.data && res.data.Section) ? res.data.Section : res.data;
  if (!Array.isArray(sections)) {
    sections = sections ? [sections] : [];
  }

  if (sections.length === 0) {
    throw new Error('Document ' + documentId + ' has no sections');
  }

  logger.debug('[DW] Sections retrieved', { documentId, count: sections.length });
  return sections;
}

// ---------------------------------------------------------------------------
// downloadSection
// GET .../FileCabinets/{fc}/Sections/{sectionId}/Data
// Returns a Buffer containing the raw PDF bytes.
// ---------------------------------------------------------------------------
async function downloadSection(fileCabinetId, sectionId) {
  const url = `${platformUrl()}/FileCabinets/${fileCabinetId}/Sections/${sectionId}/Data`;
  logger.info('[DW] Downloading section', { sectionId });

  const res = await withRetry(
    async () => axios.get(url, {
      headers:      await authHeaders({ Accept: 'application/pdf,*/*' }),
      responseType: 'arraybuffer',
    }),
    { label: 'dw-downloadSection' }
  );

  const buf = Buffer.from(res.data);
  logger.info('[DW] Section downloaded', { sectionId, bytes: buf.length });
  return buf;
}

// ---------------------------------------------------------------------------
// replaceSectionData
// POST .../FileCabinets/{fc}/Sections/{sectionId}/Data?fileName={name}
//
// Per Postman collection the body is RAW BINARY (not multipart/form-data):
//   Content-Type:        application/pdf
//   Content-Disposition: file; filename="{name}"
//   X-File-ModifiedDate: <ISO-8601 timestamp>
// ---------------------------------------------------------------------------
async function replaceSectionData(fileCabinetId, sectionId, pdfBuffer, fileName) {
  const url = `${platformUrl()}/FileCabinets/${fileCabinetId}/Sections/${sectionId}/Data`;
  logger.info('[DW] Replacing section', { sectionId, fileName, bytes: pdfBuffer.length });

  // Resolve the token before entering withRetry so the async arrow
  // function only needs to handle the actual HTTP call.
  const token = await getAccessToken();

  await withRetry(
    () => axios.post(url, pdfBuffer, {
      params: { fileName: fileName },
      headers: {
        'Authorization':         'Bearer ' + token,
        'Content-Type':          'application/pdf',
        'Content-Disposition':   'file; filename="' + fileName + '"',
        'X-File-ModifiedDate':   new Date().toISOString(),
        'Accept':                'application/json',
      },
      maxContentLength: Infinity,
      maxBodyLength:    Infinity,
    }),
    { label: 'dw-replaceSection' }
  );

  logger.info('[DW] Section replaced successfully', { sectionId });
}

// ---------------------------------------------------------------------------
// appendSection
// POST .../FileCabinets/{fc}/Documents/{docId}/Sections?fileName={name}
//
// Appends the signed PDF as a NEW section on the existing document record
// so that both the original and signed PDFs co-exist in the same file
// cabinet entry. The existing sections are untouched.
//
// Same headers as replaceSectionData (raw binary application/pdf body)
// but targets the document-level Sections collection instead of a specific
// section's Data endpoint.
// ---------------------------------------------------------------------------
async function appendSection(fileCabinetId, documentId, pdfBuffer, fileName) {
  var url = platformUrl() + '/FileCabinets/' + fileCabinetId + '/Documents/' + documentId + '/Sections';
  logger.info('[DW] Appending signed PDF as new section', {
    documentId: documentId,
    fileName:   fileName,
    bytes:      pdfBuffer.length,
  });

  var token = await getAccessToken();

  await withRetry(
    function() {
      return axios.post(url, pdfBuffer, {
        params: { fileName: fileName },
        headers: {
          'Authorization':         'Bearer ' + token,
          'Content-Type':          'application/pdf',
          'Content-Disposition':   'file; filename="' + fileName + '"',
          'X-File-ModifiedDate':   new Date().toISOString(),
          'Accept':                'application/json',
        },
        maxContentLength: Infinity,
        maxBodyLength:    Infinity,
      });
    },
    { label: 'dw-appendSection' }
  );

  logger.info('[DW] Signed PDF section appended successfully', {
    documentId: documentId,
    fileName:   fileName,
  });
}

// ---------------------------------------------------------------------------
// updateIndexFields
// PUT .../FileCabinets/{fc}/Documents/{docId}/Fields
// Body: { Field: [{ FieldName, Item, ItemElementName }] }
// ---------------------------------------------------------------------------
async function updateIndexFields(fileCabinetId, documentId, fields) {
  const url = `${platformUrl()}/FileCabinets/${fileCabinetId}/Documents/${documentId}/Fields`;
  logger.info('[DW] Updating index fields', { documentId, fields: fields });

  const token = await getAccessToken();

  const payload = {
    Field: fields.map(function(f) {
      return {
        FieldName:       f.FieldName,
        Item:            f.Item,
        ItemElementName: f.ItemElementName || 'String',
      };
    }),
  };

  const res = await withRetry(
    () => axios.put(url, payload, {
      headers: {
        'Authorization':  'Bearer ' + token,
        'Content-Type':   'application/json',
        'Accept':         'application/json',
      },
    }),
    { label: 'dw-updateFields' }
  );

  logger.info('[DW] Index fields updated', { documentId });
  return res.data;
}

// ---------------------------------------------------------------------------
// Status convenience helpers
// ---------------------------------------------------------------------------
async function markDocumentPending(fileCabinetId, documentId) {
  return updateIndexFields(fileCabinetId, documentId, [{
    FieldName:       process.env.DW_STATUS_FIELD        || 'STATUS',
    Item:            process.env.DW_STATUS_PENDING_VALUE || 'Pending Signature',
    ItemElementName: 'String',
  }]);
}

async function markDocumentSigned(fileCabinetId, documentId) {
  return updateIndexFields(fileCabinetId, documentId, [{
    FieldName:       process.env.DW_STATUS_FIELD       || 'STATUS',
    Item:            process.env.DW_STATUS_SIGNED_VALUE || 'Signed',
    ItemElementName: 'String',
  }]);
}

module.exports = {
  getAccessToken,
  getDocumentSections,
  downloadSection,
  replaceSectionData,
  appendSection,
  updateIndexFields,
  markDocumentPending,
  markDocumentSigned,
};
