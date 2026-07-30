'use strict';

/*
 * In-memory store correlating Adobe Sign agreementId to DocuWare document details.
 * Replace with Redis or a database for production durability.
 *
 * Job schema:
 * {
 *   agreementId:   string,
 *   fileCabinetId: string,
 *   documentId:    string,
 *   sectionId:     string,
 *   fileName:      string,
 *   status:        'PENDING' | 'SIGNED' | 'ERROR',
 *   createdAt:     number,
 *   updatedAt:     number,
 *   error?:        string,
 * }
 */

var store = new Map();

function set(agreementId, job) {
  store.set(agreementId, Object.assign({}, job, { updatedAt: Date.now() }));
}

function get(agreementId) {
  return store.get(agreementId) || null;
}

function remove(agreementId) {
  store.delete(agreementId);
}

function all() {
  return Array.from(store.values());
}

module.exports = { set: set, get: get, remove: remove, all: all };
