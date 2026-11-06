'use strict';

/*
 * POST /webhooks/docuware
 *
 * Receives document triggers from DocuWare -- either:
 *   A) Webhooks module (DocuWare Configuration -> Integrations -> Webhooks)
 *   B) Workflow Web Service Activity (Workflow Designer)
 *
 * The workflow activity is acknowledged only after the signing agreement and
 * its URL index field are ready, so the following native email step cannot
 * run ahead of the URL update.
 */

const express  = require('express');
const router   = express.Router();
const docuware = require('../services/docuware');
const sign     = require('../services/adobeSign');
const jobStore = require('../utils/jobStore');
const logger   = require('../utils/logger');
const pdfSections = require('../services/pdfSections');
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

  var body          = req.body || {};
  var documentId    = body.documentId;
  var signers       = body.signers;
  var agreementName = body.agreementName;
  var message       = body.message;
  var fileCabinetId = body.fileCabinetId || process.env.DW_FILE_CABINET_ID;

  // Validate before making changes in DocuWare or Adobe Sign.
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
      if (typeof signers[i].email !== 'string' || !signers[i].email.trim()) {
        validationError =
          'Signer at index ' + i + ' has no email address. ' +
          'Check that the signer email token resolves to a value for this document.';
        break;
      }
      if (signers[i].role && typeof signers[i].role !== 'string') {
        validationError = 'Signer at index ' + i + ' has an invalid role.';
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
    logger.error('[DW-WEBHOOK] Validation failed', {
      error:        validationError,
      documentId:   documentId,
      fileCabinetId: fileCabinetId,
      signers:      signers,
    });
    return res.status(400).json({ error: validationError });
  }

  logger.info('[DW-WEBHOOK] Starting signing flow', {
    documentId:    String(documentId),
    fileCabinetId: fileCabinetId,
  });

  var agreementId = null;
  try {
    // Keep the workflow activity open until its URL index field is ready.
    try {
      await docuware.markDocumentPending(fileCabinetId, String(documentId));
    } catch (statusErr) {
      logger.warn('[DW-WEBHOOK] Could not set Pending Signature status -- continuing.', {
        documentId: documentId,
        error:      statusErr.message,
        dwResponse: statusErr.response && statusErr.response.data,
      });
    }

    var sections = await docuware.getDocumentSections(fileCabinetId, String(documentId));
    var pdfSection = null;
    for (var s = 0; s < sections.length; s++) {
      if ((sections[s].ContentType || '').toLowerCase().indexOf('pdf') !== -1) {
        pdfSection = sections[s];
        break;
      }
    }
    if (!pdfSection) throw new Error('Document has no PDF section to sign');

    var sectionId = pdfSection.Id;
    var fileName  = pdfSection.OriginalFileName
      || pdfSection.DisplayName
      || ('document-' + documentId + '.pdf');
    logger.info('[DW-WEBHOOK] Selected section', { sectionId: sectionId, fileName: fileName });

    var masterPdf = await docuware.downloadSection(fileCabinetId, sectionId);
    var extracted = await pdfSections.extractTransmittalLetter(masterPdf);
    var transientDocumentId = await sign.uploadTransientDocument(
      extracted.pdfBuffer,
      fileName.replace(/\.pdf$/i, '') + '_transmittal.pdf'
    );

    var encodedExternalId = fileCabinetId + '|' + String(documentId);
    var result = await sign.createAgreement({
      transientDocumentId: transientDocumentId,
      agreementName:       agreementName || ('DocuWare Document ' + documentId),
      signers:             signers,
      externalId:          encodedExternalId,
      message:             message,
    });
    agreementId = result.agreementId;
    if (!agreementId) throw new Error('Adobe Sign did not return an agreement ID');

    jobStore.set(agreementId, {
      agreementId:   agreementId,
      fileCabinetId: fileCabinetId,
      documentId:    String(documentId),
      sectionId:     sectionId,
      fileName:      fileName,
      startPage:     extracted.startPage,
      endPage:       extracted.endPage,
      status:        'PENDING',
      createdAt:     Date.now(),
      updatedAt:     Date.now(),
    });

    var signingUrl = await sign.getSigningUrl(agreementId, signers);
    await docuware.updateIndexFields(fileCabinetId, String(documentId), [{
      FieldName: process.env.DW_SIGNATURE_URL_FIELD || 'E_SIGNATURE_URL',
      Item: signingUrl,
      ItemElementName: 'String',
    }]);

    logger.info('[DW-WEBHOOK] Signing URL written to DocuWare index field', {
      documentId: documentId,
      agreementId: agreementId,
      fieldName: process.env.DW_SIGNATURE_URL_FIELD || 'E_SIGNATURE_URL',
      signerCount: signers.length,
    });
    return res.status(200).json({ status: 'ready', agreementId: agreementId });
  } catch (err) {
    if (agreementId) {
      var job = jobStore.get(agreementId);
      if (job) {
        jobStore.set(agreementId, Object.assign({}, job, {
          status: 'ERROR',
          error: err.message,
          updatedAt: Date.now(),
        }));
      }
    }
    logger.error('[DW-WEBHOOK] Processing failed before workflow can continue', {
      documentId: documentId,
      error:      err.message,
      dwResponse: err.response && err.response.data,
      stack:      err.stack,
    });
    return res.status(500).json({ error: 'Could not prepare document for signature' });
  }
});

module.exports = router;
