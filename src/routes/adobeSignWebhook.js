'use strict';

/*
 * adobeSignWebhook.js
 *
 * GET  /webhooks/adobe-sign -- Adobe Sign URL verification challenge
 * POST /webhooks/adobe-sign -- Adobe Sign event delivery
 *
 * Verification (GET):
 *   Adobe Sign sends GET with header X-AdobeSign-ClientId.
 *   Server must respond 200 and echo the value in BOTH:
 *     1. Response header  X-AdobeSign-ClientId
 *     2. JSON body        { xAdobeSignClientId: "..." }
 *   (Both are required for proxy-safe verification.)
 *
 * Event delivery (POST) on AGREEMENT_WORKFLOW_COMPLETED:
 *   1. Respond 200 immediately (Sign retries on non-2xx)
 *   2. Look up job by agreementId in the in-memory store
 *   3. If no job found (server was restarted, store was cleared):
 *      -> Recover from Adobe Sign by querying agreement details
 *      -> externalId.id was encoded as "fileCabinetId|documentId"
 *      -> Re-fetch the section list from DocuWare to get sectionId
 *   4. Download signed combined PDF from Adobe Sign
 *   5. Append the signed PDF as a new section on the same document record
 *   6. Update STATUS index field to "Signed"
 *   7. Mark job SIGNED in store
 */

const express  = require('express');
const router   = express.Router();
const docuware = require('../services/docuware');
const sign     = require('../services/adobeSign');
const jobStore = require('../utils/jobStore');
const logger   = require('../utils/logger');

// ---------------------------------------------------------------------------
// GET: verification challenge
// ---------------------------------------------------------------------------
router.get('/', function(req, res) {
  var clientId = req.headers['x-adobesign-clientid'];
  if (clientId) {
    res.setHeader('X-AdobeSign-ClientId', clientId);
    return res.status(200).json({ xAdobeSignClientId: clientId });
  }
  return res.status(200).json({ status: 'adobe-sign webhook endpoint active' });
});

// ---------------------------------------------------------------------------
// POST: event delivery
// ---------------------------------------------------------------------------
router.post('/', function(req, res) {
  res.status(200).send('OK');

  var event       = req.body || {};
  var eventCode   = event.event;
  var agreementId = event.agreement && event.agreement.id;

  logger.info('[SIGN-WEBHOOK] Event received', { eventCode: eventCode, agreementId: agreementId });

  if (eventCode !== 'AGREEMENT_WORKFLOW_COMPLETED') {
    logger.debug('[SIGN-WEBHOOK] Ignoring event', { eventCode: eventCode });
    return;
  }

  if (!agreementId) {
    logger.warn('[SIGN-WEBHOOK] Completion event missing agreement.id');
    return;
  }

  setImmediate(async function() {
    try {
      await processCompletedAgreement(agreementId);
    } catch (err) {
      logger.error('[SIGN-WEBHOOK] Unhandled error in completion handler', {
        agreementId: agreementId,
        error:       err.message,
        stack:       err.stack,
      });
    }
  });
});

// ---------------------------------------------------------------------------
// processCompletedAgreement
// Core handler -- looks up job, recovers if missing, writes PDF back.
// ---------------------------------------------------------------------------
async function processCompletedAgreement(agreementId) {
  var job = jobStore.get(agreementId);

  if (!job) {
    logger.warn(
      '[SIGN-WEBHOOK] No job in store for agreementId -- ' +
      'attempting recovery from Adobe Sign externalId ' +
      '(this is expected after a server restart)',
      { agreementId: agreementId }
    );

    job = await recoverJobFromAdobeSign(agreementId);

    if (!job) {
      logger.error(
        '[SIGN-WEBHOOK] Recovery failed -- cannot process completion. ' +
        'The agreement may not have been created by this service.',
        { agreementId: agreementId }
      );
      return;
    }
  }

  // Idempotency: skip if already processed
  if (job.status === 'SIGNED') {
    logger.info('[SIGN-WEBHOOK] Duplicate event -- job already SIGNED', {
      agreementId: agreementId,
    });
    return;
  }

  var fileCabinetId = job.fileCabinetId;
  var documentId    = job.documentId;
  var sectionId     = job.sectionId;
  var fileName      = job.fileName;

  logger.info('[SIGN-WEBHOOK] Writing signed PDF back to DocuWare', {
    agreementId: agreementId,
    documentId:  documentId,
    sectionId:   sectionId,
  });

  try {
    // 1. Download signed combined PDF from Adobe Sign
    var signedPdfBuffer = await sign.downloadSignedDocument(agreementId);

    // 2. Append the signed PDF as a NEW section on the same document.
    //    POST .../Documents/{documentId}/Sections?fileName=...
    //    Content-Type: application/pdf (raw binary)
    //    The original section is left untouched -- both PDFs coexist
    //    in the same file cabinet record.
    var signedFileName = fileName.replace(/\.pdf$/i, '_signed.pdf');
    await docuware.appendSection(
      fileCabinetId,
      documentId,
      signedPdfBuffer,
      signedFileName
    );

    // 3. Update STATUS index field (non-fatal -- signed PDF is already
    //    appended; a misconfigured STATUS field should not mark the job as ERROR)
    try {
      await docuware.markDocumentSigned(fileCabinetId, documentId);
    } catch (statusErr) {
      logger.warn('[SIGN-WEBHOOK] Could not set Signed status -- ' +
        'signed PDF was appended successfully. ' +
        'Check DW_STATUS_FIELD and DW_STATUS_SIGNED_VALUE in .env.', {
        documentId: documentId,
        error:      statusErr.message,
        dwResponse: statusErr.response && statusErr.response.data,
      });
    }

    // 4. Mark job complete
    jobStore.set(agreementId, Object.assign({}, job, {
      status:    'SIGNED',
      updatedAt: Date.now(),
    }));

    logger.info('[SIGN-WEBHOOK] Document signed and stored successfully', {
      documentId:  documentId,
      statusField: process.env.DW_STATUS_FIELD        || 'STATUS',
      statusValue: process.env.DW_STATUS_SIGNED_VALUE || 'Signed',
    });

  } catch (err) {
    logger.error('[SIGN-WEBHOOK] Failed to write signed document to DocuWare', {
      agreementId: agreementId,
      documentId:  documentId,
      error:       err.message,
      stack:       err.stack,
    });
    jobStore.set(agreementId, Object.assign({}, job, {
      status:    'ERROR',
      error:     err.message,
      updatedAt: Date.now(),
    }));
  }
}

// ---------------------------------------------------------------------------
// recoverJobFromAdobeSign
//
// Called when the in-memory job store has no entry for an agreementId --
// typically because the server restarted and the store was cleared.
//
// At agreement creation time we set externalId.id = "fileCabinetId|documentId"
// and externalId.source = "DW_BRIDGE".  This function reads that back from
// Adobe Sign and re-fetches the DocuWare section list to reconstruct the
// job object needed to complete the flow.
//
// Returns a job-shaped object on success, or null if recovery is not possible.
// ---------------------------------------------------------------------------
async function recoverJobFromAdobeSign(agreementId) {
  var details;
  try {
    details = await sign.getAgreementDetails(agreementId);
  } catch (err) {
    logger.error('[SIGN-WEBHOOK] Could not fetch agreement details for recovery', {
      agreementId: agreementId,
      error:       err.message,
    });
    return null;
  }

  var externalId = details.externalId;
  if (!externalId || externalId.source !== 'DW_BRIDGE' || !externalId.id) {
    logger.warn('[SIGN-WEBHOOK] Agreement externalId missing or not from DW_BRIDGE', {
      agreementId: agreementId,
      externalId:  externalId,
    });
    return null;
  }

  // externalId.id was encoded as "fileCabinetId|documentId"
  var parts = externalId.id.split('|');
  if (parts.length !== 2) {
    logger.warn('[SIGN-WEBHOOK] externalId.id not in expected "fileCabinetId|documentId" format', {
      externalId: externalId.id,
    });
    return null;
  }

  var fileCabinetId = parts[0];
  var documentId    = parts[1];

  logger.info('[SIGN-WEBHOOK] Recovered DocuWare details from externalId', {
    fileCabinetId: fileCabinetId,
    documentId:    documentId,
  });

  // Re-fetch the section list to get the sectionId and fileName
  var sections;
  try {
    sections = await docuware.getDocumentSections(fileCabinetId, documentId);
  } catch (err) {
    logger.error('[SIGN-WEBHOOK] Could not fetch DocuWare sections during recovery', {
      documentId: documentId,
      error:      err.message,
    });
    return null;
  }

  var pdfSection = null;
  for (var s = 0; s < sections.length; s++) {
    if ((sections[s].ContentType || '').toLowerCase().indexOf('pdf') !== -1) {
      pdfSection = sections[s];
      break;
    }
  }
  if (!pdfSection) pdfSection = sections[0];

  var sectionId = pdfSection.Id;
  var fileName  = pdfSection.OriginalFileName
    || pdfSection.DisplayName
    || ('document-' + documentId + '.pdf');

  logger.info('[SIGN-WEBHOOK] Job recovered successfully', {
    agreementId:   agreementId,
    fileCabinetId: fileCabinetId,
    documentId:    documentId,
    sectionId:     sectionId,
    fileName:      fileName,
  });

  return {
    agreementId:   agreementId,
    fileCabinetId: fileCabinetId,
    documentId:    documentId,
    sectionId:     sectionId,
    fileName:      fileName,
    status:        'PENDING',
    createdAt:     Date.now(),
    updatedAt:     Date.now(),
    recovered:     true,
  };
}

module.exports = router;
