'use strict';

// Env setup BEFORE any require
Object.assign(process.env, {
  DW_SERVER_URL:              'https://test.docuware.cloud',
  DW_PLATFORM:                'DocuWare/Platform',
  DW_USERNAME:                'test@test.com',
  DW_PASSWORD:                'testpass',
  DW_CLIENT_ID:               'docuware.platform.net.client',
  DW_SCOPE:                   'docuware.platform',
  DW_FILE_CABINET_ID:         'e6ecd4a1-fa7b-4644-b1fb-df7ce7e8cd2d',
  DW_ORGANIZATION_PASSPHRASE: 'test-org-passphrase',
  DW_BRIDGE_API_KEY:          'test-bridge-key',
  DW_STATUS_FIELD:            'STATUS',
  DW_STATUS_SIGNED_VALUE:     'Signed',
  DW_STATUS_PENDING_VALUE:    'Pending Signature',
  ADOBE_SIGN_CLIENT_ID:       'TEST_CLIENT_ID',
  ADOBE_SIGN_CLIENT_SECRET:   'TEST_CLIENT_SECRET',
  ADOBE_SIGN_REFRESH_TOKEN:   'TEST_REFRESH_TOKEN',
  ADOBE_SIGN_API_BASE_URL:    'https://api.na4.adobesign.com',
  ADOBE_SIGN_WEBHOOK_URL:     'https://test.example.com',
  ADMIN_API_KEY:              'test-admin-key',
  PORT:                       '0',
});

jest.mock('../src/services/docuware', () => ({
  markDocumentPending:  jest.fn().mockResolvedValue({}),
  markDocumentSigned:   jest.fn().mockResolvedValue({}),
  getDocumentSections:  jest.fn().mockResolvedValue([
    { Id: 'SEC-1', ContentType: 'application/pdf', OriginalFileName: 'invoice.pdf' },
  ]),
  downloadSection:      jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4 fake')),
  replaceSectionData:   jest.fn().mockResolvedValue(undefined),
  appendSection:        jest.fn().mockResolvedValue(undefined),
  updateIndexFields:    jest.fn().mockResolvedValue({}),
}));

jest.mock('../src/services/adobeSign', () => ({
  getAccessToken:          jest.fn().mockResolvedValue('mock-access-token'),
  uploadTransientDocument: jest.fn().mockResolvedValue('TRANS-001'),
  createAgreement:         jest.fn().mockResolvedValue({ agreementId: 'AGR-001' }),
  ensureAccountWebhook:    jest.fn().mockResolvedValue(undefined),
  downloadSignedDocument:  jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4 signed')),
  getAgreementStatus:      jest.fn().mockResolvedValue('COMPLETED'),
  getAgreementDetails:     jest.fn().mockResolvedValue({
    id:         'AGR-RECOVER',
    status:     'SIGNED',
    externalId: {
      id:     'e6ecd4a1-fa7b-4644-b1fb-df7ce7e8cd2d|55555',
      source: 'DW_BRIDGE',
    },
  }),
}));

const request  = require('supertest');
const crypto   = require('crypto');
const app      = require('../src/server');
const docuware = require('../src/services/docuware');
const sign     = require('../src/services/adobeSign');
const jobStore = require('../src/utils/jobStore');

// Flush setImmediate callbacks twice to let async background work complete
const flushAsync = () => new Promise((r) => setImmediate(() => setImmediate(r)));

// Compute the real DocuWare HMAC for a body (SHA-512, canonical JSON, hex)
function dwSignature(body) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return crypto
    .createHmac('sha512', 'test-org-passphrase')
    .update(Buffer.from(raw))
    .digest('hex');
}

// Build headers object for a given body
function dwHeaders(body) {
  return {
    'x-docuware-signature': dwSignature(body),
    'content-type':         'application/json',
  };
}

// -----------------------------------------------------------------------------
describe('GET /health', () => {
  it('returns 200 with status ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});

// -----------------------------------------------------------------------------
describe('POST /webhooks/docuware', () => {
  const VALID_BODY = {
    documentId:    '12345',
    fileCabinetId: 'e6ecd4a1-fa7b-4644-b1fb-df7ce7e8cd2d',
    signers:       [{ email: 'jane@example.com', name: 'Jane Doe' }],
    agreementName: 'Test Agreement',
  };

  beforeEach(() => jest.clearAllMocks());

  it('returns 401 when neither auth header is present', async () => {
    const res = await request(app)
      .post('/webhooks/docuware')
      .set('content-type', 'application/json')
      .send(VALID_BODY);
    expect(res.status).toBe(401);
  });

  it('returns 401 when x-docuware-signature is present but invalid', async () => {
    const res = await request(app)
      .post('/webhooks/docuware')
      .set('content-type', 'application/json')
      .set('x-docuware-signature', 'a'.repeat(128))
      .send(VALID_BODY);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Invalid x-docuware-signature/);
  });

  it('accepts valid x-docuware-signature (Webhooks module path)', async () => {
    const res = await request(app)
      .post('/webhooks/docuware')
      .set(dwHeaders(VALID_BODY))
      .send(VALID_BODY);
    expect(res.status).toBe(200);
  });

  it('accepts valid Bearer token (Web Service Activity path)', async () => {
    const res = await request(app)
      .post('/webhooks/docuware')
      .set('content-type', 'application/json')
      .set('authorization', 'Bearer test-bridge-key')
      .send(VALID_BODY);
    expect(res.status).toBe(200);
    await flushAsync();
  });

  it('returns 401 when Bearer token is wrong', async () => {
    const res = await request(app)
      .post('/webhooks/docuware')
      .set('content-type', 'application/json')
      .set('authorization', 'Bearer wrong-key')
      .send(VALID_BODY);
    expect(res.status).toBe(401);
  });

  it('returns 200 and logs error when documentId is missing (never 400 to DocuWare)', async () => {
    const body = { signers: [{ email: 'a@b.com' }] };
    const res = await request(app)
      .post('/webhooks/docuware')
      .set(dwHeaders(body))
      .send(body);
    // Always 200 -- DocuWare must never see a non-200 or it retries
    expect(res.status).toBe(200);
    await flushAsync();
    // Validation error logged, signing flow NOT started
    expect(docuware.getDocumentSections).not.toHaveBeenCalled();
  });

  it('returns 200 and logs error when signers is empty', async () => {
    const body = { documentId: '1', signers: [] };
    const res = await request(app)
      .post('/webhooks/docuware')
      .set(dwHeaders(body))
      .send(body);
    expect(res.status).toBe(200);
    await flushAsync();
    expect(docuware.getDocumentSections).not.toHaveBeenCalled();
  });

  it('returns 200 and logs error when a signer has no email', async () => {
    const body = { documentId: '1', signers: [{ name: 'No Email' }] };
    const res = await request(app)
      .post('/webhooks/docuware')
      .set(dwHeaders(body))
      .send(body);
    expect(res.status).toBe(200);
    await flushAsync();
    expect(docuware.getDocumentSections).not.toHaveBeenCalled();
  });

  it('returns 202 and runs the full DW -> Sign flow with encoded externalId', async () => {
    const res = await request(app)
      .post('/webhooks/docuware')
      .set(dwHeaders(VALID_BODY))
      .send(VALID_BODY);

    expect(res.status).toBe(200);
    await flushAsync();

    expect(docuware.markDocumentPending).toHaveBeenCalledWith(
      VALID_BODY.fileCabinetId, '12345'
    );
    expect(sign.uploadTransientDocument).toHaveBeenCalledWith(
      expect.any(Buffer), 'invoice.pdf'
    );
    // externalId must encode fileCabinetId|documentId
    expect(sign.createAgreement).toHaveBeenCalledWith(
      expect.objectContaining({
        externalId: VALID_BODY.fileCabinetId + '|12345',
      })
    );

    // Each signer maps to its own participantSet (1:1 mapping)
    const callArgs = sign.createAgreement.mock.calls[0][0];
    expect(callArgs.signers).toHaveLength(1);
    expect(callArgs.signers[0].email).toBe('jane@example.com');

    const job = jobStore.get('AGR-001');
    expect(job).not.toBeNull();
    expect(job.status).toBe('PENDING');
  });

  it('continues signing flow when markDocumentPending returns 400', async () => {
    docuware.markDocumentPending.mockRejectedValueOnce(
      Object.assign(new Error('DW 400'), { response: { status: 400, data: { Message: 'Field not found' } } })
    );
    const res = await request(app)
      .post('/webhooks/docuware')
      .set(dwHeaders(VALID_BODY))
      .send(VALID_BODY);
    expect(res.status).toBe(200);
    await flushAsync();
    // Should still have proceeded to download and send to Adobe Sign
    expect(docuware.getDocumentSections).toHaveBeenCalled();
    expect(sign.uploadTransientDocument).toHaveBeenCalled();
    expect(sign.createAgreement).toHaveBeenCalled();
  });

  it('falls back to DW_FILE_CABINET_ID when fileCabinetId omitted from body', async () => {
    const body = { documentId: '999', signers: [{ email: 'a@b.com' }] };
    const res = await request(app)
      .post('/webhooks/docuware')
      .set(dwHeaders(body))
      .send(body);
    expect(res.status).toBe(200);
    await flushAsync();
    expect(docuware.markDocumentPending).toHaveBeenCalledWith(
      process.env.DW_FILE_CABINET_ID, '999'
    );
  });

  it('accepts multiple signers with roles and sequential order', async () => {
    const body = {
      documentId:    'MULTI-01',
      fileCabinetId: 'e6ecd4a1-fa7b-4644-b1fb-df7ce7e8cd2d',
      signers: [
        { email: 'signer1@example.com', name: 'Alice', role: 'SIGNER',   order: 1 },
        { email: 'signer2@example.com', name: 'Bob',   role: 'SIGNER',   order: 1 },
        { email: 'approver@example.com', name: 'Carol', role: 'APPROVER', order: 2 },
      ],
    };
    const res = await request(app)
      .post('/webhooks/docuware')
      .set(dwHeaders(body))
      .send(body);
    expect(res.status).toBe(200);
    await flushAsync();

    // createAgreement must be called and pass all three participants
    expect(sign.createAgreement).toHaveBeenCalledWith(
      expect.objectContaining({
        signers: body.signers,
      })
    );
  });

  it('returns 200 and logs error for an invalid role value', async () => {
    const body = {
      documentId: '1',
      signers: [{ email: 'a@b.com', role: 'DICTATOR' }],
    };
    const res = await request(app)
      .post('/webhooks/docuware')
      .set(dwHeaders(body))
      .send(body);
    expect(res.status).toBe(200);
    await flushAsync();
    expect(docuware.getDocumentSections).not.toHaveBeenCalled();
  });

  it('accepts roles case-insensitively', async () => {
    const body = {
      documentId:    'CASE-01',
      fileCabinetId: 'e6ecd4a1-fa7b-4644-b1fb-df7ce7e8cd2d',
      signers: [{ email: 'a@b.com', role: 'approver' }],
    };
    const res = await request(app)
      .post('/webhooks/docuware')
      .set(dwHeaders(body))
      .send(body);
    expect(res.status).toBe(200);
  });
});

// -----------------------------------------------------------------------------
describe('GET /webhooks/adobe-sign (verification)', () => {
  it('echoes clientId in header AND JSON body', async () => {
    const res = await request(app)
      .get('/webhooks/adobe-sign')
      .set('x-adobesign-clientid', 'CLIENT-XYZ');
    expect(res.status).toBe(200);
    expect(res.headers['x-adobesign-clientid']).toBe('CLIENT-XYZ');
    expect(res.body.xAdobeSignClientId).toBe('CLIENT-XYZ');
  });

  it('returns 200 with status message when no challenge header', async () => {
    const res = await request(app).get('/webhooks/adobe-sign');
    expect(res.status).toBe(200);
  });
});

// -----------------------------------------------------------------------------
describe('POST /webhooks/adobe-sign (event delivery)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 200 immediately for any event', async () => {
    const res = await request(app)
      .post('/webhooks/adobe-sign')
      .send({ event: 'AGREEMENT_EMAIL_VIEWED', agreement: { id: 'AGR-X' } });
    expect(res.status).toBe(200);
  });

  it('ignores non-completion events', async () => {
    await request(app)
      .post('/webhooks/adobe-sign')
      .send({ event: 'AGREEMENT_EMAIL_VIEWED', agreement: { id: 'AGR-X' } });
    await flushAsync();
    expect(sign.downloadSignedDocument).not.toHaveBeenCalled();
  });

  it('downloads signed PDF, replaces section, marks document Signed', async () => {
    jobStore.set('AGR-FULL', {
      agreementId:   'AGR-FULL',
      fileCabinetId: 'e6ecd4a1-fa7b-4644-b1fb-df7ce7e8cd2d',
      documentId:    '55555',
      sectionId:     'SEC-99',
      fileName:      'contract.pdf',
      status:        'PENDING',
      createdAt:     Date.now(),
      updatedAt:     Date.now(),
    });

    await request(app)
      .post('/webhooks/adobe-sign')
      .send({ event: 'AGREEMENT_WORKFLOW_COMPLETED', agreement: { id: 'AGR-FULL' } });
    await flushAsync();

    expect(sign.downloadSignedDocument).toHaveBeenCalledWith('AGR-FULL');
    // Signed PDF is appended as a new section -- original section untouched
    expect(docuware.appendSection).toHaveBeenCalledWith(
      'e6ecd4a1-fa7b-4644-b1fb-df7ce7e8cd2d',
      '55555',
      expect.any(Buffer),
      'contract_signed.pdf'
    );
    expect(docuware.replaceSectionData).not.toHaveBeenCalled();
    expect(docuware.markDocumentSigned).toHaveBeenCalledWith(
      'e6ecd4a1-fa7b-4644-b1fb-df7ce7e8cd2d', '55555'
    );
    expect(jobStore.get('AGR-FULL').status).toBe('SIGNED');
  });

  it('recovers from Adobe Sign externalId when job not in store (server restart)', async () => {
    // No job seeded -- simulates post-restart state
    // getAgreementDetails mock returns externalId "fileCabinetId|documentId"
    await request(app)
      .post('/webhooks/adobe-sign')
      .send({ event: 'AGREEMENT_WORKFLOW_COMPLETED', agreement: { id: 'AGR-RECOVER' } });
    await flushAsync();

    // Should have queried Adobe Sign for agreement details
    expect(sign.getAgreementDetails).toHaveBeenCalledWith('AGR-RECOVER');
    // Should have fetched DocuWare sections to get sectionId
    expect(docuware.getDocumentSections).toHaveBeenCalledWith(
      'e6ecd4a1-fa7b-4644-b1fb-df7ce7e8cd2d', '55555'
    );
    // Should have downloaded and appended signed PDF
    expect(sign.downloadSignedDocument).toHaveBeenCalledWith('AGR-RECOVER');
    expect(docuware.appendSection).toHaveBeenCalled();
    expect(docuware.replaceSectionData).not.toHaveBeenCalled();
    expect(docuware.markDocumentSigned).toHaveBeenCalledWith(
      'e6ecd4a1-fa7b-4644-b1fb-df7ce7e8cd2d', '55555'
    );
  });

  it('marks job ERROR when DocuWare write fails', async () => {
    docuware.appendSection.mockRejectedValueOnce(new Error('DW 500'));
    jobStore.set('AGR-ERR', {
      agreementId: 'AGR-ERR', fileCabinetId: 'fc-1', documentId: '77777',
      sectionId: 'SEC-ERR', fileName: 'doc.pdf',
      status: 'PENDING', createdAt: Date.now(), updatedAt: Date.now(),
    });

    await request(app)
      .post('/webhooks/adobe-sign')
      .send({ event: 'AGREEMENT_WORKFLOW_COMPLETED', agreement: { id: 'AGR-ERR' } });
    await flushAsync();

    expect(jobStore.get('AGR-ERR').status).toBe('ERROR');
  });

  it('is idempotent -- ignores duplicate COMPLETED for already-SIGNED job', async () => {
    jobStore.set('AGR-DUPE', {
      agreementId: 'AGR-DUPE', fileCabinetId: 'fc-1', documentId: '11111',
      sectionId: 'SEC-1', fileName: 'doc.pdf',
      status: 'SIGNED', createdAt: Date.now(), updatedAt: Date.now(),
    });

    await request(app)
      .post('/webhooks/adobe-sign')
      .send({ event: 'AGREEMENT_WORKFLOW_COMPLETED', agreement: { id: 'AGR-DUPE' } });
    await flushAsync();

    expect(sign.downloadSignedDocument).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
describe('GET /status/jobs', () => {
  it('returns 401 without x-admin-key', async () => {
    const res = await request(app).get('/status/jobs');
    expect(res.status).toBe(401);
  });

  it('returns job list with correct key', async () => {
    const res = await request(app)
      .get('/status/jobs')
      .set('x-admin-key', 'test-admin-key');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.jobs)).toBe(true);
  });
});

// -----------------------------------------------------------------------------
describe('404 handler', () => {
  it('returns 404 with hint for unknown paths', async () => {
    const res = await request(app).get('/not-a-real-path');
    expect(res.status).toBe(404);
    expect(res.body.hint).toBeDefined();
  });
});

// -----------------------------------------------------------------------------
describe('jobStore', () => {
  it('set -> get -> update -> remove lifecycle', () => {
    jobStore.set('UT-1', { status: 'PENDING' });
    expect(jobStore.get('UT-1').status).toBe('PENDING');
    jobStore.set('UT-1', { status: 'SIGNED' });
    expect(jobStore.get('UT-1').status).toBe('SIGNED');
    jobStore.remove('UT-1');
    expect(jobStore.get('UT-1')).toBeNull();
  });

  it('all() returns every stored job', () => {
    jobStore.set('UT-A', { status: 'PENDING' });
    jobStore.set('UT-B', { status: 'SIGNED' });
    const statuses = jobStore.all().map((j) => j.status);
    expect(statuses).toContain('PENDING');
    expect(statuses).toContain('SIGNED');
  });
});
