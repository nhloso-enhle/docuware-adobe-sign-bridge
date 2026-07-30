/**
 * In-memory agreement → DocuWare document mapping.
 *
 * In production, replace this with Redis, a database, or another
 * persistent store so mappings survive a process restart.
 *
 * Schema of each entry:
 * {
 *   agreementId:    string,   // Adobe Sign agreement ID
 *   fileCabinetId:  string,   // DocuWare file cabinet GUID
 *   documentId:     number,   // DocuWare document ID (integer)
 *   sectionId:      string,   // DocuWare section ID of the primary PDF
 *   fileName:       string,   // Original file name
 *   createdAt:      Date,
 * }
 */

const store = new Map();

function saveMapping(agreementId, data) {
  store.set(agreementId, { ...data, agreementId, createdAt: new Date() });
}

function getMapping(agreementId) {
  return store.get(agreementId) || null;
}

function deleteMapping(agreementId) {
  store.delete(agreementId);
}

function allMappings() {
  return Array.from(store.values());
}

module.exports = { saveMapping, getMapping, deleteMapping, allMappings };
