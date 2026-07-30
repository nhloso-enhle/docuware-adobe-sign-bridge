'use strict';

/*
 * withRetry
 * Retries an async function up to maxAttempts times with exponential back-off.
 *
 * Usage:
 *   const result = await withRetry(() => axios.get(url), { label: 'my-call' });
 */

var logger = require('./logger');

async function withRetry(fn, opts) {
  opts = opts || {};
  var maxAttempts = opts.maxAttempts || 3;
  var baseDelayMs = opts.baseDelayMs || 500;
  var label       = opts.label || 'withRetry';

  for (var attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      var isRetryable =
        !err.response ||                       // network error
        err.response.status >= 500;            // server error

      if (!isRetryable || attempt === maxAttempts) {
        throw err;
      }

      var delayMs = baseDelayMs * Math.pow(2, attempt - 1);
      logger.warn('[RETRY] ' + label + ' attempt ' + attempt + ' failed -- retrying in ' + delayMs + 'ms', {
        error: err.message,
        status: err.response && err.response.status,
      });
      await new Promise(function(r) { setTimeout(r, delayMs); });
    }
  }
}

module.exports = { withRetry: withRetry };
