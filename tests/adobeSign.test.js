'use strict';

jest.mock('axios', () => ({
  get: jest.fn(),
  post: jest.fn(),
}));

const axios = require('axios');
const adobeSign = require('../src/services/adobeSign');

describe('Adobe Sign recipient signing URL', () => {
  beforeAll(() => {
    process.env.ADOBE_SIGN_CLIENT_ID = 'test-client';
    process.env.ADOBE_SIGN_CLIENT_SECRET = 'test-secret';
    process.env.ADOBE_SIGN_REFRESH_TOKEN = 'test-refresh-token';
    process.env.ADOBE_SIGN_API_BASE_URL = 'https://api.example.com';
  });

  beforeEach(() => {
    jest.clearAllMocks();
    axios.post.mockImplementation((url) => Promise.resolve({
      data: url.indexOf('/oauth/') !== -1
        ? { access_token: 'access-token', expires_in: 3600 }
        : { id: 'AGR-123' },
    }));
    axios.get.mockResolvedValue({
      data: {
        signingUrlSetInfos: [{
          signingUrls: [
            { email: 'later@example.com', signingUrl: 'https://sign.example.com/later' },
            { email: 'first@example.com', signingUrl: 'https://sign.example.com/first' },
          ],
        }],
      },
    });
  });

  it('returns the URL for the earliest signer in the agreement', async () => {
    const url = await adobeSign.getSigningUrl('AGR-123', [
      { email: 'later@example.com', role: 'SIGNER', order: 2 },
      { email: 'first@example.com', role: 'SIGNER', order: 1 },
    ]);

    expect(url).toBe('https://sign.example.com/first');
    expect(axios.get).toHaveBeenCalledWith(
      'https://api.example.com/api/rest/v6/agreements/AGR-123/signingUrls',
      { headers: { Authorization: 'Bearer access-token' } }
    );
  });

  it('disables Adobe Sign emails so DocuWare owns the notification', async () => {
    await adobeSign.createAgreement({
      transientDocumentId: 'TRANS-1',
      agreementName: 'Transmittal',
      signers: [{ email: 'signer@example.com' }],
      externalId: 'cabinet|document',
    });

    const request = axios.post.mock.calls.find(function(call) {
      return call[0].endsWith('/agreements');
    });
    expect(request[1].emailOption).toEqual({ sendOptions: 'NONE' });
    expect(request[1].externalId).toEqual({
      id: 'DW_BRIDGE:cabinet|document',
    });
  });
});
