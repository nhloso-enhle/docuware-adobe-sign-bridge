# dw-sign-bridge

> **DocuWare ↔ Adobe Acrobat Sign e-signature webhook bridge**
>
> A production-ready Node.js / Express service that accepts a document from a
> DocuWare workflow, sends it to Adobe Acrobat Sign for electronic signature,
> and writes the completed signed PDF back to DocuWare — automatically
> updating the document's `STATUS` index field to `"Signed"`.

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
│  ┌─────────────┐   ④ replaceSectionData           │  ② download PDF        │
│  │ File Cabinet│◀──────────────────────────────── │                        │
│  │  (doc store)│   ⑤ updateIndexFields            │                        │
│  └─────────────┘      STATUS="Signed"             │                        │
└───────────────────────────────────────────────────┼────────────────────────┘
                                                    │ ③ upload PDF to Sign
                                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Adobe Acrobat Sign                                  │
│                                                                             │
│  POST /api/rest/v6/transientDocuments  ──▶  transientDocumentId            │
│  POST /api/rest/v6/agreements          ──▶  agreementId                    │
│  POST /api/rest/v6/webhooks            ──▶  webhook registered             │
│                                                                             │
│  ──── signer receives email, reviews & signs in Sign UI ────               │
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
| `src/middleware/auth.js` | Shared-secret verification for DocuWare; challenge handler for Sign |
| `src/utils/jobStore.js` | In-memory agreementId → DocuWare document correlation store |
| `src/utils/logger.js` | Winston logger with console transport |

---

## 2. Request / Event Flow

```
DocuWare Workflow
       │
       │  POST /webhooks/docuware
       │  Headers: X-DW-Webhook-Secret: <secret>
       │  Body:    { documentId, fileCabinetId, signers, agreementName, message }
       ▼
  ┌─────────────────────────────────────────────────────────────┐
  │  STEP 1 – Validate payload & respond 202 immediately        │
  │  STEP 2 – markDocumentPending()  →  STATUS = "Pending..."   │
  │  STEP 3 – getDocumentSections()  →  find first PDF section  │
  │  STEP 4 – downloadSection()      →  Buffer (PDF bytes)      │
  │  STEP 5 – uploadTransientDocument()  →  transientDocumentId │
  │  STEP 6 – createAgreement()          →  agreementId         │
  │  STEP 7 – registerWebhookForAgreement()                     │
  │  STEP 8 – jobStore.set(agreementId, { documentId, ... })    │
  └─────────────────────────────────────────────────────────────┘
       │
       │  Signer receives email invitation
       │  Signs document in Adobe Sign UI
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
  │  STEP 4 – replaceSectionData()       →  section overwritten │
  │  STEP 5 – markDocumentSigned()       →  STATUS = "Signed"   │
  │  STEP 6 – jobStore.set(…, SIGNED)                           │
  └─────────────────────────────────────────────────────────────┘
```

> **Why 202 / 200 immediately?**
> Both DocuWare HTTP activities and Adobe Sign webhook delivery have short
> timeouts (typically 10–30 s).  The service acknowledges immediately and
> handles processing asynchronously via `setImmediate` to avoid HTTP-level
> timeouts while still delivering reliable processing.

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
| `DW_WEBHOOK_SECRET` | ⚠️ | Shared secret DocuWare sends in `X-DW-Webhook-Secret`. Strongly recommended. |

### Adobe Acrobat Sign

| Variable | Required | Description |
|----------|----------|-------------|
| `ADOBE_SIGN_BASE_URL` | ✅ | Your Sign shard URL, e.g. `https://api.na4.adobesign.com` |
| `ADOBE_SIGN_INTEGRATION_KEY` | ✅ | OAuth Integration Key from Sign account → API → API Applications |
| `ADOBE_SIGN_WEBHOOK_URL` | ✅ | Public HTTPS base URL of this service, e.g. `https://your.domain.com` |
| `ADOBE_SIGN_WEBHOOK_SECRET` | ❌ | Shared secret (optional; enterprise tier only) |

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

The bridge requires a text index field to track signing state.  By default it
looks for a field with the DBName `STATUS`.

To create or verify the field in DocuWare Administration:
1. Open **DocuWare Administration** → **File Cabinets** → your cabinet
2. Under **Index Fields**, confirm a field exists with:
   - **DBName**: `STATUS` (or your custom value in `DW_STATUS_FIELD`)
   - **Type**: `Text`
   - Optional: configure a **Select List** with values `Pending Signature` and `Signed`

### 6.3 Workflow HTTP Activity

In **DocuWare Workflow Designer**, add an **HTTP Activity** step to the workflow
at the point where you want to trigger signing:

| Setting | Value |
|---------|-------|
| **Method** | `POST` |
| **URL** | `https://your.domain.com/webhooks/docuware` |
| **Content-Type** | `application/json` |
| **Header** | `X-DW-Webhook-Secret: <your DW_WEBHOOK_SECRET value>` |
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

---

## 7. Adobe Acrobat Sign Configuration

### 7.1 Find Your API Shard

1. Log into your Adobe Sign account
2. Go to **Account** → **Adobe Sign API** → **API Information**
3. Note the **API Access Point** — this is your `ADOBE_SIGN_BASE_URL`
   (e.g. `https://api.na4.adobesign.com`)

### 7.2 Create an Integration Key

1. Go to **Account** → **Adobe Sign API** → **API Applications**
2. Click **Create an Application (Integration Key)**
3. Give it a name (e.g. `DocuWare Bridge`)
4. Enable the following scopes:
   - `agreement_send`
   - `agreement_read`
   - `agreement_write`
   - `user_read`
5. Copy the **Integration Key** — this is your `ADOBE_SIGN_INTEGRATION_KEY`

> **Note:** The Integration Key is effectively a long-lived access token.
> Guard it like a password and rotate it if compromised.

### 7.3 Adobe Sign Webhook Registration

The bridge auto-registers a per-agreement webhook when each agreement is created.
No manual setup is required in the Sign UI.  Adobe Sign will send a `GET`
challenge to `https://your.domain.com/webhooks/adobe-sign` first to verify the
URL — the bridge handles this automatically.

**Required scopes** for webhook registration: `webhook_write` (included in the
Integration Key scopes above by default on Business/Enterprise plans).

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

Triggered by DocuWare Workflow HTTP Activity.

**Headers:**
```
Content-Type:       application/json
X-DW-Webhook-Secret: <DW_WEBHOOK_SECRET>
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

**Response:**
```json
{ "status": "accepted", "message": "Processing started" }
```
HTTP 202 — processing continues asynchronously.

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
**Requires** `X-DW-Webhook-Secret` header.

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

Single job detail. **Requires** `X-DW-Webhook-Secret` header.

---

## 11. Security

### Shared Secret (DocuWare → Bridge)

Set `DW_WEBHOOK_SECRET` to a strong random string and configure the DocuWare
workflow HTTP activity to send it in the `X-DW-Webhook-Secret` header.  The
middleware rejects any request without a matching secret with `HTTP 401`.

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

### Full OAuth2 Flow for Adobe Sign

The Integration Key is convenient but non-rotatable without regeneration.
For production, implement the full OAuth2 Authorization Code flow and store
refresh tokens, as documented in Adobe's developer guides.

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
| `HTTP 401` on `/webhooks/docuware` | Wrong or missing `X-DW-Webhook-Secret` | Check the header value in the DocuWare workflow matches `DW_WEBHOOK_SECRET` |
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
