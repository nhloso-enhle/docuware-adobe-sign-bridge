'use strict';

/*
 * POST /webhooks/docuware
 *
 * Receives notifications from DocuWare -- either from:
 *   A) DocuWare Webhooks module (Integrations -> Webhooks in DW Configuration)
 *      Fires automatically when a document is stored or index data changes.
 *   B) Workflow Designer Web Service activity
 *      Fires when a workflow step calls this endpoint.
 *
 * In both cases DocuWare sends the header:
 *   x-docuware-signature: Base64(HMAC-SHA256(body, orgPassphrase))
 *
 * Configure the request body in DocuWare to send JSON matching this shape:
 * {
 *   "documentId":    "{{DWDOCID}}",
 *   "fileCabinetId": "e6ecd4a1-...",
 *   "signers": [
 *     { "email": "{{SIGNER_EMAIL}}", "name": "{{SIGNER_NAME}}" }
 *   ],
 *   "agreementName": "{{DOCUMENT_TYPE}} {{DOCUMENT_NUMBER}}",
 *   "message":       "Please review and sign."
 * }
 *
 * Use DocuWare's variable tokens ({{FieldName}}) to inject index field values.
 * DWDOCID is a built-in system token for the document ID.
 *
 * Response:
 *   202 Accepted  -- processing started in background
 *   400 Bad Request -- missing/invalid fields
 *   401 Unauthorized -- invalid or missing x-docuware-signature
 */

const express  = require('express');
const router   = express.Router();
const docuware = require('../services/docuware');
const sign     = require('../services/adobeSign');
const jobStore = require('../utils/jobStore');
const logger   = require('../utils/logger');
const { verifyDwInbound } = require('../middleware/auth');

router.post('/', verifyDwInbound, async function(req, res) {

  var body          = req.body || {};
  var documentId    = body.documentId;
  var signers       = body.signers;
  var agreementName = body.agreementName;
  var message       = body.message;
  var fileCabinetId = body.fileCabinetId || process.env.DW_FILE_CABINET_ID;

  if (!documentId) {
    return res.status(400).json({ error: 'Missing required field: documentId' });
  }
  if (!Array.isArray(signers) || signers.length === 0) {
    return res.status(400).json({ error: 'Missing required field: signers (non-empty array)' });
  }
  for (var i = 0; i < signers.length; i++) {
    if (!signers[i].email) {
      return res.status(400).json({ error: 'Each signer must have an email address' });
    }
  }
  if (!fileCabinetId) {
    return res.status(400).json({
      error: 'fileCabinetId not provided and DW_FILE_CABINET_ID is not set',
    });
  }

  // Respond 202 immediately -- DocuWare web service activity has a short timeout
  res.status(202).json({ status: 'accepted', message: 'Processing started' });

  setImmediate(async function() {
    logger.info('[DW-WEBHOOK] Starting signing flow', {
      documentId:    documentId,
      fileCabinetId: fileCabinetId,
    });

    try {
      // 1. Mark document as Pending Signature
      await docuware.markDocumentPending(fileCabinetId, documentId);

      // 2. Get sections: GET .../FileCabinets/{fc}/Sections?DocId={documentId}
      var sections = await docuware.getDocumentSections(fileCabinetId, documentId);

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

      logger.info('[DW-WEBHOOK] Selected section', {
        sectionId: sectionId,
        fileName:  fileName,
      });

      // 3. Download PDF bytes: GET .../Sections/{sectionId}/Data
      var pdfBuffer = await docuware.downloadSection(fileCabinetId, sectionId);

      // 4. Upload to Adobe Sign as transient document
      var transientDocumentId = await sign.uploadTransientDocument(pdfBuffer, fileName);

      // 5. Create agreement (sends email invite to signers)
      var name   = agreementName || ('DocuWare Document ' + documentId);
      // Encode fileCabinetId and documentId together so that if the server
      // restarts and the in-memory job store is lost, the completion webhook
      // handler can recover all necessary DocuWare details from Adobe Sign.
      var encodedExternalId = fileCabinetId + '|' + documentId;

      var result = await sign.createAgreement({
        transientDocumentId: transientDocumentId,
        agreementName:       name,
        signers:             signers,
        externalId:          encodedExternalId,
        message:             message,
      });
      var agreementId = result.agreementId;

      // 6. Store job for Adobe Sign callback
      jobStore.set(agreementId, {
        agreementId:   agreementId,
        fileCabinetId: fileCabinetId,
        documentId:    documentId,
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
        stack:      err.stack,
      });
    }
  });
});

module.exports = router;
