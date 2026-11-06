# dw-sign-bridge

> **DocuWare ↔ Adobe Acrobat Sign e-signature webhook bridge**
>
> A Node.js / Express service that extracts and sends only a detected
> transmittal letter to Adobe Acrobat Sign, writes its signing URL to DocuWare,
> and replaces only those pages in the original PDF after signing.
> DocuWare's native workflow sends the email containing the URL.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Request / Event Flow](#2-request--event-flow)
3. [Project Structure](#3-project-structure)
4. [Prerequisites](#4-prerequisites)
5. [Environment Variables](#5-environment-variables)
6. [DocuWare Configuration](#6-docuware-configuration)
7. [Adobe Acrobat Sign Configuration](#7-adobe-acrobat-sign-configuration)
8. [Running the Service](#8-running-the-service)
9. [Exposing the Service Publicly](#9-exposing-the-service-publicly)
10. [API Reference](#10-api-reference)
11. [Security](#11-security)
12. [Error Handling & Retry Logic](#12-error-handling--retry-logic)
13. [Production Hardening](#13-production-hardening)
14. [Troubleshooting](#14-troubleshooting)

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            DocuWare Cloud                                   │
│                                                                             │
│  ┌─────────────┐   Workflow HTTP   ┌─────────────────────────────────────┐ │
│  │  Workflow   │─────Activity─────▶│   POST /webhooks/docuware           │ │
│  │  Designer   │                   │   (this service)                    │ │
│  └─────────────┘                   └──────────────┬──────────────────────┘ │
│                                                   │  ① authenticate        │
│  ┌─────────────┐   ⑥ replace transmittal section  │  ② download PDF sections│
│  │ File Cabinet│◀──────────────────────────────── │  ③ find/extract letter │
│  │  (doc store)│   ④ write E_SIGNATURE_URL        │                        │
│  └─────────────┘                                   │                        │
│  Workflow continues → native Send Email activity │                        │
└───────────────────────────────────────────────────┼────────────────────────┘
                                                    │ ⑤ upload letter to Sign
                                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Adobe Acrobat Sign                                  │
│                                                                             │
│  POST /api/rest/v6/transientDocuments  ──▶  transientDocumentId            │
│  POST /api/rest/v6/agreements          ──▶  agreementId                    │
│  POST /api/rest/v6/webhooks            ──▶  webhook registered             │
│                                                                             │
│  ──── DocuWare emails the signing URL; recipient signs in Sign UI ────     │
│                                                                             │
│  POST /webhooks/adobe-sign (AGREEMENT_WORKFLOW_COMPLETED event)            │
│       ──▶  GET  /api/rest/v6/agreements/{id}/combinedDocument              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Components

| File | Purpose |
|------|---------|
| `src/server.js` | Express entry point, middleware wiring, startup validation |
| `src/routes/docuwareWebhook.js` | Inbound route from DocuWare workflow HTTP activity |
| `src/routes/adobeSignWebhook.js` | Inbound callback from Adobe Sign on signing completion |
| `src/routes/status.js` | `/health` and `/status/jobs` monitoring endpoints |
| `src/services/docuware.js` | All DocuWare Platform API calls (auth, download, replace, update) |
| `src/services/adobeSign.js` | All Adobe Sign API calls (upload, create agreement, download) |
| `src/services/pdfSections.js` | Transmittal marker detection, PDF extraction, and page replacement |
| `src/middleware/auth.js` | Shared-secret verification for DocuWare; challenge handler for Sign |
| `src/utils/jobStore.js` | In-memory agreementId → DocuWare document correlation store |
| `src/utils/logger.js` | Winston logger with console transport |

---

## 2. Request / Event Flow

```
DocuWare Workflow
       │
       │  POST /webhooks/docuware
       │  Headers: DocuWare HMAC signature or Authorization: Bearer <API key>
       │  Body:    { documentId, fileCabinetId, signers, agreementName, message }
       ▼
  ┌─────────────────────────────────────────────────────────────┐
  │  STEP 1 – Validate and retrieve every PDF section           │
  │  STEP 2 – Locate the transmittal and extract its pages       │
  │  STEP 3 – Create Adobe Sign agreement with the letter        │
  │  STEP 4 – Fetch the first signer's signing URL               │
  │  STEP 5 – Write URL to E_SIGNATURE_URL index field           │
  │  STEP 6 – Return success; workflow sends native DocuWare email│
  └─────────────────────────────────────────────────────────────┘
       │
       │  Recipient follows DocuWare's email URL and signs
       ▼
Adobe Sign (AGREEMENT_WORKFLOW_COMPLETED)
       │
       │  POST /webhooks/adobe-sign
       │  Body:  { event: "AGREEMENT_WORKFLOW_COMPLETED", agreement: { id } }
       ▼
  ┌─────────────────────────────────────────────────────────────┐
  │  STEP 1 – Respond 200 immediately                           │
  │  STEP 2 – Lookup job by agreementId                         │
  │  STEP 3 – downloadSignedDocument()   →  signed PDF Buffer   │
  │  STEP 4 – Re-detect letter and replace only those pages     │
  │  STEP 5 – markDocumentSigned()       →  STATUS = "Signed"   │
  │  STEP 6 – jobStore.set(…, SIGNED)                           │
  └─────────────────────────────────────────────────────────────┘
```

The DocuWare workflow activity waits for a successful response so its native
email step cannot run before the signing URL index field has been updated.
The Adobe Sign completion webhook is acknowledged immediately and processed
asynchronously.

### Stapled and clipped DocuWare documents

The bridge handles both layouts without combining unrelated PDFs:

- **Stapled (merged):** When the DocuWare document has one PDF section, the
  existing page-marker detection extracts the transmittal from that PDF and
  replaces only those pages after signing.
- **Clipped (separate PDFs):** When it has multiple PDF sections, the bridge
  downloads each PDF section and searches them for the configured start marker.
  Exactly one section must match. Only that section's transmittal is sent to
  Adobe Sign; after completion, the signed pages replace the transmittal in
  that same section. The other PDF sections remain untouched. If no end or
  next-section marker is found in the matched clipped PDF, its pages from the
  start marker through the end of that PDF are treated as the transmittal.

If multiple clipped PDFs contain a start marker, the bridge stops rather than
choosing a section ambiguously. A document without a matching transmittal also
fails before its signing URL or workflow email is created.

---

## 3. Project Structure

```
dw-sign-bridge/
├── src/
│   ├── server.js                   # Entry point
│   ├── routes/
│   │   ├── docuwareWebhook.js      # POST /webhooks/docuware
│   │   ├── adobeSignWebhook.js     # GET|POST /webhooks/adobe-sign
│   │   └── status.js               # /health, /status/jobs
│   ├── services/
│   │   ├── docuware.js             # DocuWare Platform API
│   │   └── adobeSign.js            # Adobe Acrobat Sign REST API v6
│   ├── middleware/
│   │   └── auth.js                 # Shared-secret & Sign challenge verification
│   └── utils/
│       ├── jobStore.js             # In-memory job tracker
│       └── logger.js               # Winston logger
├── .env.example                    # Template – copy to .env and fill in
├── .gitignore
├── package.json
└── README.md
```

---

## 4. Prerequisites

| Requirement | Version |
|-------------|---------|
| Node.js | ≥ 18.0.0 |
| npm | ≥ 9.0.0 |
| DocuWare Cloud | Any current version |
| Adobe Acrobat Sign | Standard, Business, or Enterprise plan |
| Public HTTPS URL | Required for Adobe Sign webhooks (see §9) |

---

## 5. Environment Variables

Copy `.env.example` to `.env` and fill in every value.

```bash
cp .env.example .env
```

### DocuWare

| Variable | Required | Description |
|----------|----------|-------------|
| `DW_SERVER_URL` | ✅ | Base URL of your DocuWare Cloud instance, e.g. `https://yourorg.docuware.cloud` |
| `DW_PLATFORM` | ✅ | Platform path segment — almost always `DocuWare/Platform` |
| `DW_USERNAME` | ✅ | Service account email with permission to read/update the target file cabinet |
| `DW_PASSWORD` | ✅ | Service account password |
| `DW_CLIENT_ID` | ✅ | `docuware.platform.net.client` (standard DocuWare Cloud value) |
| `DW_SCOPE` | ✅ | `docuware.platform` (standard DocuWare Cloud value) |
| `DW_FILE_CABINET_ID` | ✅ | GUID of the file cabinet, e.g. `e6ecd4a1-fa7b-4644-b1fb-df7ce7e8cd2d` |
| `DW_STATUS_FIELD` | ❌ | Index field DBName for signing status (default: `STATUS`) |
| `DW_STATUS_SIGNED_VALUE` | ❌ | Value written when signing completes (default: `Signed`) |
| `DW_STATUS_PENDING_VALUE` | ❌ | Value written when signing starts (default: `Pending Signature`) |
| `DW_SIGNATURE_URL_FIELD` | ❌ | Text index field DBName for the recipient URL (default: `E_SIGNATURE_URL`) |
| `DW_TRANSMITTAL_START_MARKERS` | ❌ | Pipe-separated page text anchors (default: `TRANSMITTAL LETTER|ENCLOSED PLEASE FIND`) |
| `DW_TRANSMITTAL_END_MARKERS` | ❌ | Pipe-separated inclusive end-page anchors (default: `END OF TRANSMITTAL`) |
| `DW_TRANSMITTAL_NEXT_SECTION_MARKERS` | ❌ | Pipe-separated following-section anchors; that page is excluded (default: `GENERAL TERMS`) |
| `DW_ORGANIZATION_PASSPHRASE` | ✅ | HMAC secret for DocuWare Webhooks module calls |
| `DW_BRIDGE_API_KEY` | ✅ | Bearer token for DocuWare Workflow Web Service Activity calls |

### Adobe Acrobat Sign

| Variable | Required | Description |
|----------|----------|-------------|
| `ADOBE_SIGN_API_BASE_URL` | ✅ | Adobe Sign `api_access_point`, e.g. `https://api.na4.adobesign.com` |
| `ADOBE_SIGN_CLIENT_ID` | ✅ | OAuth application client ID |
| `ADOBE_SIGN_CLIENT_SECRET` | ✅ | OAuth application client secret |
| `ADOBE_SIGN_REFRESH_TOKEN` | ✅ | OAuth refresh token |
| `ADOBE_SIGN_WEBHOOK_URL` | ✅ | Public HTTPS base URL of this service, e.g. `https://your.domain.com` |

### Server

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | ❌ | HTTP listening port (default: `3000`) |
| `NODE_ENV` | ❌ | `production` or `development` |
| `LOG_LEVEL` | ❌ | `error` \| `warn` \| `info` \| `http` \| `debug` (default: `info`) |

---

## 6. DocuWare Configuration

### 6.1 Service Account

Create a dedicated DocuWare service account (e.g. `sign-bridge@yourorg.com`) and
grant it the following permissions on the target file cabinet:

- **Read** documents
- **Edit index entries** (index field update)
- **Check-out / Check-in** (section replacement)

### 6.2 Index Fields

The bridge uses the `STATUS` text field to track signing state and the
`E_SIGNATURE_URL` text field to pass the recipient's Adobe Sign URL to the
native workflow email.

To create or verify the field in DocuWare Administration:
1. Open **DocuWare Administration** → **File Cabinets** → your cabinet
2. Under **Index Fields**, confirm a field exists with:
   - **DBName**: `STATUS` (or your custom value in `DW_STATUS_FIELD`)
   - **Type**: `Text`
   - Optional: configure a **Select List** with values `Pending Signature` and `Signed`
3. Add a text index field with DBName `E_SIGNATURE_URL` (or configure
   `DW_SIGNATURE_URL_FIELD` to the field's DBName). Give the service account
   permission to edit both fields.
4. Configure the text anchors in `.env` to match the transmittal and following
   section titles used in your PDFs. Start and end markers are included in the
   extracted letter; the following-section marker page is not. The service
   fails safely when markers are missing or the start marker is ambiguous.
   For clipped documents, where each PDF is a separate section, all PDF
   sections are downloaded and searched. The end of the matched PDF is used
   when no end or following-section marker is present.

### 6.3 Workflow Web Service Activity and Native Email

In **DocuWare Workflow Designer**, add a **Web Service Activity** at the point
where the transmittal letter is ready. Configure the existing bridge's
`POST /webhooks/docuware` endpoint:

| Setting | Value |
|---------|-------|
| **Method** | `POST` |
| **URL** | `https://your.domain.com/webhooks/docuware` |
| **Content-Type** | `application/json` |
| **Authentication** | Bearer token using the `DW_BRIDGE_API_KEY` value |
| **Body** | See below |

**Body template** (use DocuWare's variable substitution syntax):

```json
{
  "documentId":    "{{DocumentId}}",
  "fileCabinetId": "e6ecd4a1-fa7b-4644-b1fb-df7ce7e8cd2d",
  "agreementName": "{{DOCUMENT_TYPE}} - {{DOCUMENT_NUMBER}}",
  "message":       "Please review and sign this document at your earliest convenience.",
  "signers": [
    {
      "email": "{{SIGNER_EMAIL}}",
      "name":  "{{SIGNER_NAME}}"
    }
  ]
}
```

> **Tip:** `{{DocumentId}}` is a built-in DocuWare workflow token.
> `{{SIGNER_EMAIL}}` should be mapped to an index field that contains the
> intended signer's email address.

The middleware does not send the DocuWare notification email. Configure the
next workflow step as DocuWare's native **Send Email** activity, with no
attachment, and include the `E_SIGNATURE_URL` index field in the message body.
The Web Service Activity returns success only after the agreement is created
and that field is updated. Configure the Email activity recipient separately
as appropriate for your workflow.

The bridge suppresses Adobe Sign initiation, in-flight, and completion emails
through the agreement's `emailOption.sendOptions` settings, so DocuWare remains
the notification channel.
Adobe Sign may take a few seconds to expose a newly created agreement to its
signer. The bridge retries only the `AGREEMENT_NOT_EXPOSED` response with
bounded backoff and reads the recipient URL from Adobe's `esignUrl` response
field before treating URL retrieval as a failure.

---

## 7. Adobe Acrobat Sign Configuration

### 7.1 Find Your API Shard

1. Log into your Adobe Sign account
2. Go to **Account** → **Adobe Sign API** → **API Information**
3. Note the **API Access Point** — this is your `ADOBE_SIGN_API_BASE_URL`
   (e.g. `https://api.na4.adobesign.com`)

### 7.2 Configure OAuth

Create a **Customer** OAuth application under **Account** → **Adobe Sign API**
→ **API Applications**. Grant the account scopes used by the bridge:
`agreement_read:account`, `agreement_send:account`, `agreement_write:account`,
and `webhook_write:account`. Use its client ID and secret for
`ADOBE_SIGN_CLIENT_ID` and `ADOBE_SIGN_CLIENT_SECRET`, then complete the OAuth
authorization-code exchange to obtain `ADOBE_SIGN_REFRESH_TOKEN`. The
`api_access_point` from that exchange is `ADOBE_SIGN_API_BASE_URL`.

Keep the client secret and refresh token private. The service refreshes its
short-lived access token automatically.

### 7.3 Adobe Sign Webhook Registration

The bridge auto-registers an account-level webhook at startup.
No manual setup is required in the Sign UI.  Adobe Sign will send a `GET`
challenge to `https://your.domain.com/webhooks/adobe-sign` first to verify the
URL — the bridge handles this automatically.

**Required scope** for webhook registration: `webhook_write:account`.

---

## 8. Running the Service

### Installation

```bash
git clone https://github.com/your-org/dw-sign-bridge.git
cd dw-sign-bridge
npm install
cp .env.example .env
# Edit .env with your actual values
```

### Development

```bash
npm run dev   # starts with nodemon (hot reload)
```

### Production

```bash
NODE_ENV=production npm start
```

### Using PM2 (recommended for production)

```bash
npm install -g pm2
pm2 start src/server.js --name dw-sign-bridge
pm2 save
pm2 startup   # follow the instructions to run on system boot
```

### Using Docker

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src/ ./src/
EXPOSE 3000
CMD ["node", "src/server.js"]
```

```bash
docker build -t dw-sign-bridge .
docker run -d \
  --name dw-sign-bridge \
  --env-file .env \
  -p 3000:3000 \
  dw-sign-bridge
```

---

## 9. Exposing the Service Publicly

Both Adobe Sign (webhook callbacks) and DocuWare (workflow HTTP activity) must
be able to reach this service over **public HTTPS**.

### Option A – Cloudflare Tunnel (recommended for Ricoh / corporate environments)

```bash
# Install cloudflared
# https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/

cloudflared tunnel --url http://localhost:3000
# Cloudflare provides a stable *.trycloudflare.com URL for testing, or
# configure a custom domain via the Cloudflare dashboard for production.
```

Set `ADOBE_SIGN_WEBHOOK_URL` to the Cloudflare Tunnel URL (no trailing slash).

### Option B – Reverse proxy (nginx)

If the server already has a public IP, place nginx in front:

```nginx
server {
    listen 443 ssl;
    server_name sign-bridge.yourorg.com;

    ssl_certificate     /etc/ssl/certs/yourorg.crt;
    ssl_certificate_key /etc/ssl/private/yourorg.key;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }
}
```

### Option C – ngrok (development / testing only)

```bash
ngrok http 3000
# Use the https://xxxxx.ngrok.io URL as ADOBE_SIGN_WEBHOOK_URL
```

---

## 10. API Reference

### `POST /webhooks/docuware`

Triggered by DocuWare Workflow Web Service Activity.

**Headers:**
```
Content-Type:  application/json
Authorization: Bearer <DW_BRIDGE_API_KEY>

Alternatively, the DocuWare Webhooks module may authenticate with
`x-docuware-signature` using `DW_ORGANIZATION_PASSPHRASE`.
```

**Request body:**
```jsonc
{
  "documentId":    "12345",          // required – DocuWare document ID
  "fileCabinetId": "e6ecd4a1-...",   // optional – falls back to DW_FILE_CABINET_ID
  "signers": [                       // required – at least one signer
    {
      "email": "jane@example.com",
      "name":  "Jane Doe",           // optional but recommended
      "order": 1                     // optional – signing order (default: 1)
    }
  ],
  "agreementName": "Invoice #001",   // optional
  "message": "Please sign."          // optional – email message to signers
}
```

**Success response (after URL field update):**
```json
{ "status": "ready", "agreementId": "..." }
```
HTTP 200 means the agreement exists and the signing URL has been written to
the configured DocuWare index field. Invalid input returns HTTP 400; processing
errors return HTTP 500 so the workflow does not proceed to its Email activity.

---

### `GET /webhooks/adobe-sign`

Adobe Sign URL verification challenge — handled automatically.
**Response:** HTTP 200 with `x-adobesign-clientid` header echoed.

---

### `POST /webhooks/adobe-sign`

Adobe Sign event delivery.

**Handled event:** `AGREEMENT_WORKFLOW_COMPLETED`

All other events receive HTTP 200 and are silently ignored.

---

### `GET /health`

Liveness probe. No authentication required.

```json
{ "status": "ok", "timestamp": "2024-09-15T10:30:00.000Z" }
```

---

### `GET /status/jobs`

Lists all tracked signature jobs (pending, signed, or errored).
**Requires** `X-Admin-Key` when `ADMIN_API_KEY` is configured.

```json
{
  "jobs": [
    {
      "agreementId":   "CBJ...",
      "fileCabinetId": "e6ecd4a1-...",
      "documentId":    "12345",
      "sectionId":     "67890",
      "fileName":      "invoice.pdf",
      "status":        "SIGNED",
      "createdAt":     1694776200000,
      "updatedAt":     1694779800000
    }
  ]
}
```

---

### `GET /status/jobs/:agreementId`

Single job detail. **Requires** `X-Admin-Key` when `ADMIN_API_KEY` is configured.

---

## 11. Security

### Shared Secret (DocuWare → Bridge)

Configure DocuWare's Workflow Web Service Activity to send
`Authorization: Bearer <DW_BRIDGE_API_KEY>`. Alternatively, the DocuWare
Webhooks module sends an HMAC signature verified with
`DW_ORGANIZATION_PASSPHRASE`. Requests without valid authentication receive
`HTTP 401`.

Generate a strong secret:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Adobe Sign URL Verification

Adobe Sign performs a `GET` challenge before activating any webhook, sending an
`x-adobesign-clientid` header.  The bridge automatically echoes this header back,
which is the only verification mechanism available on Standard/Business plans.
Enterprise plans may additionally use HMAC signatures — see Adobe's documentation
for the `x-adobesign-signature` header.

### TLS

Always run behind HTTPS in production.  Adobe Sign will **refuse** to deliver
events to plain HTTP endpoints.

### Credentials in `.env`

- Never commit `.env` to source control — it is in `.gitignore` by default.
- Rotate the DocuWare service account password and the Adobe Sign Integration
  Key periodically.
- Use a secrets manager (HashiCorp Vault, AWS Secrets Manager, Azure Key Vault)
  in place of `.env` in enterprise deployments.

---

## 12. Error Handling & Retry Logic

### Axios Retry

All outbound HTTP calls (DocuWare and Adobe Sign) are wrapped with
`axios-retry`:
- **3 retries** with exponential back-off
- Retries on network errors and HTTP 5xx responses
- Does **not** retry 4xx (client errors — fix the request)

### Async Error Isolation

Processing happens inside `setImmediate` callbacks.  An unhandled rejection
inside one job does **not** crash the server or affect other concurrent jobs.
Errors are logged at `error` level and the job is marked `ERROR` in the job
store.

### Adobe Sign Retry

If Adobe Sign cannot reach `POST /webhooks/adobe-sign`, it retries delivery
with exponential back-off up to 72 hours.  The bridge will process the event
whenever Sign successfully delivers it, provided the service is running.

---

## 13. Production Hardening

The following improvements are recommended before deploying to production:

### Replace In-Memory Job Store

`src/utils/jobStore.js` uses a plain `Map` — jobs are lost if the process
restarts.  Replace with Redis or a relational database:

```js
// Redis example (using ioredis)
const Redis = require('ioredis');
const redis = new Redis(process.env.REDIS_URL);

async function set(agreementId, job) {
  await redis.set(`job:${agreementId}`, JSON.stringify(job), 'EX', 604800); // 7 days
}
async function get(agreementId) {
  const raw = await redis.get(`job:${agreementId}`);
  return raw ? JSON.parse(raw) : null;
}
```

### Adobe Sign Token Rotation

The service uses the OAuth2 refresh-token flow. Rotate and renew the configured
client secret and refresh token according to your organization's credential
policy.

### DocuWare Token Refresh

The current token cache expires and re-authenticates automatically.  For
very-high-throughput deployments, consider pre-emptive refresh on a timer
to avoid latency spikes.

### Rate Limiting

Add `express-rate-limit` to protect the `/webhooks/docuware` endpoint from
flood attacks:

```js
const rateLimit = require('express-rate-limit');
app.use('/webhooks/docuware', rateLimit({ windowMs: 60_000, max: 100 }));
```

### Idempotency

Adobe Sign may deliver webhook events more than once.  Before processing a
`AGREEMENT_WORKFLOW_COMPLETED` event, check whether the job is already in
`SIGNED` state and skip if so:

```js
const job = jobStore.get(agreementId);
if (!job || job.status === 'SIGNED') return; // already processed
```
(This check is already present in the route handler.)

---

## 14. Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| `HTTP 401` on `/webhooks/docuware` | Missing/invalid Bearer token or HMAC | Check `DW_BRIDGE_API_KEY` or `DW_ORGANIZATION_PASSPHRASE` and DocuWare auth setup |
| Workflow fails before the Send Email activity | The letter markers, Adobe Sign URL, or DocuWare URL index field are not configured | Check the service log, configure matching `DW_TRANSMITTAL_*` markers, and verify `DW_SIGNATURE_URL_FIELD` |
| `[DW] Discovering Identity Service...` hangs | `DW_SERVER_URL` incorrect | Verify you can reach `https://yourorg.docuware.cloud` from the server |
| `Invalid URL` during auth | `DW_PLATFORM` missing a slash | Ensure `DW_PLATFORM=DocuWare/Platform` (no leading or trailing slash) |
| `401 Unauthorized` from DocuWare API | Wrong credentials or scope | Double-check `DW_USERNAME`, `DW_PASSWORD`, `DW_CLIENT_ID`, `DW_SCOPE` |
| `No sections found` error | Wrong `documentId` or permissions | Confirm the service account can read the file cabinet |
| Adobe Sign `404` on agreement download | Agreement not yet `COMPLETED` | Ensure you are processing only `AGREEMENT_WORKFLOW_COMPLETED` events |
| Adobe Sign webhook not delivered | URL not publicly reachable or not HTTPS | Confirm the public URL is reachable and TLS is valid |
| `STATUS` field not updating | Wrong `DW_STATUS_FIELD` DBName | Open DocuWare Administration → field must use exact DBName, case-sensitive |
| Section not replaced | DocuWare service account lacks check-in permission | Grant **Edit** permission on the file cabinet |

### Enable Debug Logging

```bash
LOG_LEVEL=debug npm start
```

This logs every DocuWare and Adobe Sign HTTP request/response detail.
