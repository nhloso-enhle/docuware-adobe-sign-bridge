'use strict';

const { PDFDocument } = require('pdf-lib');
var pdfjsPromise;

function getPdfJs() {
  if (!pdfjsPromise) pdfjsPromise = import('pdfjs-dist/build/pdf.mjs');
  return pdfjsPromise;
}

function parseMarkers(value, fallback) {
  const markers = (value || fallback).split('|')
    .map(function(marker) { return marker.trim().toLocaleLowerCase(); })
    .filter(Boolean);
  if (markers.length === 0) {
    throw new Error('At least one transmittal page marker must be configured');
  }
  return markers;
}

function containsMarker(text, markers) {
  var normalized = text.toLocaleLowerCase();
  return markers.some(function(marker) { return normalized.includes(marker); });
}

async function getPageTexts(pdfBuffer) {
  var pages = [];
  var pdfjs = await getPdfJs();
  var loadingTask = pdfjs.getDocument({
    data: new Uint8Array(pdfBuffer),
    useSystemFonts: true,
  });
  var document = await loadingTask.promise;
  try {
    for (var pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      var page = await document.getPage(pageNumber);
      var content = await page.getTextContent();
      pages.push(content.items.map(function(item) {
        return item.str || '';
      }).join(' '));
      page.cleanup();
    }
  } finally {
    await document.destroy();
  }
  return pages;
}

async function findTransmittalPages(pdfBuffer, options) {
  options = options || {};
  var pages = await getPageTexts(pdfBuffer);
  var starts = parseMarkers(
    process.env.DW_TRANSMITTAL_START_MARKERS,
    'TRANSMITTAL LETTER|ENCLOSED PLEASE FIND'
  );
  var ends = parseMarkers(
    process.env.DW_TRANSMITTAL_END_MARKERS,
    'END OF TRANSMITTAL'
  );
  var followingSections = (process.env.DW_TRANSMITTAL_NEXT_SECTION_MARKERS || 'GENERAL TERMS')
    .split('|')
    .map(function(marker) { return marker.trim().toLocaleLowerCase(); })
    .filter(Boolean);

  var startPages = [];
  pages.forEach(function(text, index) {
    if (containsMarker(text, starts)) startPages.push(index);
  });
  if (startPages.length !== 1) {
    if (startPages.length === 0 && options.allowMissingStart) return null;
    throw new Error(
      startPages.length === 0
        ? 'Could not find a transmittal letter start marker in the PDF'
        : 'Found multiple transmittal letter start markers; refusing an ambiguous split'
    );
  }

  var startPage = startPages[0];
  for (var index = startPage; index < pages.length; index++) {
    if (containsMarker(pages[index], ends)) {
      return { startPage: startPage, endPage: index };
    }
    if (index > startPage && containsMarker(pages[index], followingSections)) {
      return { startPage: startPage, endPage: index - 1 };
    }
  }

  if (options.endAtDocumentEnd) {
    return { startPage: startPage, endPage: pages.length - 1 };
  }
  throw new Error('Could not find a transmittal letter end or following-section marker in the PDF');
}

function isPdfSection(section) {
  var contentType = (section.ContentType || '').toLowerCase();
  var fileName = section.OriginalFileName || section.DisplayName || '';
  return contentType.indexOf('pdf') !== -1 || /\.pdf$/i.test(fileName);
}

function getSectionFileName(section, documentId) {
  return section.OriginalFileName || section.DisplayName || ('document-' + documentId + '.pdf');
}

async function findTransmittalSection(sections, downloadSection, documentId) {
  var pdfList = sections.filter(isPdfSection);
  if (pdfList.length === 0) throw new Error('Document has no PDF sections to sign');

  if (pdfList.length === 1) {
    var section = pdfList[0];
    var pdfBuffer = await downloadSection(section.Id);
    var range = await findTransmittalPages(pdfBuffer);
    return {
      section: section,
      fileName: getSectionFileName(section, documentId),
      pdfBuffer: pdfBuffer,
      range: range,
      pdfSectionCount: pdfList.length,
      isClipped: false,
    };
  }

  var matches = [];
  for (var i = 0; i < pdfList.length; i++) {
    var candidate = pdfList[i];
    var candidateBuffer = await downloadSection(candidate.Id);
    var candidateRange = await findTransmittalPages(candidateBuffer, {
      allowMissingStart: true,
      endAtDocumentEnd: true,
    });
    if (candidateRange) {
      matches.push({
        section: candidate,
        fileName: getSectionFileName(candidate, documentId),
        pdfBuffer: candidateBuffer,
        range: candidateRange,
        pdfSectionCount: pdfList.length,
        isClipped: true,
      });
    }
  }

  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? 'Could not find a transmittal letter in any PDF section'
        : 'Found transmittal markers in multiple PDF sections; refusing an ambiguous selection'
    );
  }
  return matches[0];
}

async function extractTransmittalLetter(pdfBuffer, range) {
  range = range || await findTransmittalPages(pdfBuffer);
  var source = await PDFDocument.load(pdfBuffer);
  var letter = await PDFDocument.create();
  var indices = [];
  for (var i = range.startPage; i <= range.endPage; i++) indices.push(i);
  var copiedPages = await letter.copyPages(source, indices);
  copiedPages.forEach(function(page) { letter.addPage(page); });

  return {
    startPage: range.startPage,
    endPage: range.endPage,
    pdfBuffer: Buffer.from(await letter.save()),
  };
}

async function replacePageRange(masterBuffer, signedBuffer, startPage, endPage) {
  var master = await PDFDocument.load(masterBuffer);
  var signed = await PDFDocument.load(signedBuffer);
  if (!Number.isInteger(startPage) || !Number.isInteger(endPage) ||
      startPage < 0 || endPage < startPage || endPage >= master.getPageCount()) {
    throw new Error('The transmittal page range is invalid for the current master PDF');
  }
  if (signed.getPageCount() === 0) {
    throw new Error('The signed PDF contains no pages');
  }

  for (var i = endPage; i >= startPage; i--) master.removePage(i);
  var signedPages = await master.copyPages(signed, signed.getPageIndices());
  signedPages.forEach(function(page, index) {
    master.insertPage(startPage + index, page);
  });
  return Buffer.from(await master.save());
}

module.exports = {
  findTransmittalPages: findTransmittalPages,
  findTransmittalSection: findTransmittalSection,
  extractTransmittalLetter: extractTransmittalLetter,
  replacePageRange: replacePageRange,
};
