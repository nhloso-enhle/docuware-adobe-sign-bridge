'use strict';

/*
 * POST /webhooks/docuware
 *
 * Receives document triggers from DocuWare -- either:
 *   A) Webhooks module (DocuWare Configuration -> Integrations -> Webhooks)
 *   B) Workflow Web Service Activity (Workflow Designer)
 *
 * CRITICAL: Always responds HTTP 200 immediately, even on validation errors.
 * DocuWare treats any non-200 response as a failed delivery and retries
 * every 2 minutes indefinitely. Validation problems are logged as errors
 * so they can be diagnosed without causing retry loops.
 */

const express  = require('express');
const router   = express.Router();
const docuware = require('../services/docuware');
const sign     = require('../services/adobeSign');
const jobStore = require('../utils/jobStore');
const logger   = require('../utils/logger');
const { verifyDwInbound } = require('../middleware/auth');

var VALID_ROLES = [
  'SIGNER', 'APPROVER', 'ACCEPTOR', 'FORM_FILLER',
  'CERTIFIED_RECIPIENT', 'DELEGATE_TO_SIGNER', 'DELEGATE_TO_APPROVER',
];

router.post('/', verifyDwInbound, async function(req, res) {

  // Log the full body immediately after auth passes.
  // If you see auth verified but nothing after this, the body parse failed.
  logger.info('[DW-WEBHOOK] Request received', {
    contentType:  req.headers['content-type'],
    bodyKeys:     Object.keys(req.body || {}),
    documentId:   (req.body || {}).documentId,
    signersCount: Array.isArray((req.body || {}).signers) ? req.body.signers.length : 'not an array',
  });

  // Always respond 200 first -- DocuWare retries on anything else.
  // Processing and any errors happen asynchronously after this line.
  res.status(200).json({ status: 'accepted' });

  var body          = req.body || {};
  var documentId    = body.documentId;
  var signers       = body.signers;
  var agreementName = body.agreementName;
  var message       = body.message;
  var fileCabinetId = body.fileCabinetId || process.env.DW_FILE_CABINET_ID;

  // Validate after responding so DocuWare never retries due to our errors.
  var validationError = null;

  if (!documentId) {
    validationError =
      'Missing documentId. Check the webhook body template in DocuWare -- ' +
      'ensure {{DWDOCID}} or the equivalent token is included.';
  } else if (!Array.isArray(signers) || signers.length === 0) {
    validationError =
      'signers must be a non-empty array. Check the webhook body template -- ' +
      'the signers array may be missing or the token may resolve to an empty value.';
  } else if (!fileCabinetId) {
    validationError =
      'fileCabinetId not in body and DW_FILE_CABINET_ID not set in .env.';
  } else {
    for (var i = 0; i < signers.length; i++) {
      if (!signers[i].email) {
        validationError =
          'Signer at index ' + i + ' has no email address. ' +
          'Check that the signer email token resolves to a value for this document.';
        break;
      }
      if (signers[i].role &&
          VALID_ROLES.indexOf(signers[i].role.toUpperCase()) === -1) {
        validationError =
          'Invalid role "' + signers[i].role + '" for signer ' +
          signers[i].email + '. Valid values: ' + VALID_ROLES.join(', ');
        break;
      }
    }
  }

  if (validationError) {
    logger.error('[DW-WEBHOOK] Validation failed -- 200 already sent, not retrying', {
      error:        validationError,
      documentId:   documentId,
      fileCabinetId: fileCabinetId,
      signers:      signers,
    });
    return;
  }

  setImmediate(async function() {
    logger.info('[DW-WEBHOOK] Starting signing flow', {
      documentId:    String(documentId),
      fileCabinetId: fileCabinetId,
    });

    try {
      // 1. Mark document as Pending Signature (non-fatal)
      try {
        await docuware.markDocumentPending(fileCabinetId, String(documentId));
      } catch (statusErr) {
        logger.warn('[DW-WEBHOOK] Could not set Pending Signature status -- ' +
          'continuing. Check DW_STATUS_FIELD and DW_STATUS_PENDING_VALUE in .env.', {
          documentId: documentId,
          error:      statusErr.message,
          dwResponse: statusErr.response && statusErr.response.data,
        });
      }

      // 2. Get sections
      var sections = await docuware.getDocumentSections(fileCabinetId, String(documentId));

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

      logger.info('[DW-WEBHOOK] Selected section', { sectionId: sectionId, fileName: fileName });

      // 3. Download PDF bytes
      var pdfBuffer = await docuware.downloadSection(fileCabinetId, sectionId);

      // 4. Upload to Adobe Sign
      var transientDocumentId = await sign.uploadTransientDocument(pdfBuffer, fileName);

      // 5. Create agreement
      var encodedExternalId = fileCabinetId + '|' + String(documentId);
      var result = await sign.createAgreement({
        transientDocumentId: transientDocumentId,
        agreementName:       agreementName || ('DocuWare Document ' + documentId),
        signers:             signers,
        externalId:          encodedExternalId,
        message:             message,
      });
      var agreementId = result.agreementId;

      // 6. Store job for Adobe Sign callback
      jobStore.set(agreementId, {
        agreementId:   agreementId,
        fileCabinetId: fileCabinetId,
        documentId:    String(documentId),
        sectionId:     sectionId,
        fileName:      fileName,
        status:        'PENDING',
        createdAt:     Date.now(),
        updatedAt:     Date.now(),
      });

      logger.info('[DW-WEBHOOK] Document sent for signature', {
        documentId:  documentId,
        agreementId: agreementId,
        signerCount: signers.length,
      });

    } catch (err) {
      logger.error('[DW-WEBHOOK] Processing failed', {
        documentId: documentId,
        error:      err.message,
        dwResponse: err.response && err.response.data,
        stack:      err.stack,
      });
    }
  });
});

module.exports = router;
