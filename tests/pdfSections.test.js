'use strict';

const { PDFDocument, StandardFonts } = require('pdf-lib');
const pdfSections = require('../src/services/pdfSections');

async function createPdf(pageTexts) {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  pageTexts.forEach(function(text) {
    var page = document.addPage();
    page.drawText(text, { x: 50, y: 700, size: 12, font: font });
  });
  return Buffer.from(await document.save());
}

describe('PDF section handling', () => {
  const startMarkers = process.env.DW_TRANSMITTAL_START_MARKERS;
  const endMarkers = process.env.DW_TRANSMITTAL_END_MARKERS;
  const nextMarkers = process.env.DW_TRANSMITTAL_NEXT_SECTION_MARKERS;

  afterEach(() => {
    if (startMarkers === undefined) delete process.env.DW_TRANSMITTAL_START_MARKERS;
    else process.env.DW_TRANSMITTAL_START_MARKERS = startMarkers;
    if (endMarkers === undefined) delete process.env.DW_TRANSMITTAL_END_MARKERS;
    else process.env.DW_TRANSMITTAL_END_MARKERS = endMarkers;
    if (nextMarkers === undefined) delete process.env.DW_TRANSMITTAL_NEXT_SECTION_MARKERS;
    else process.env.DW_TRANSMITTAL_NEXT_SECTION_MARKERS = nextMarkers;
  });

  it('extracts the transmittal pages between configured markers', async () => {
    process.env.DW_TRANSMITTAL_START_MARKERS = 'TRANSMITTAL LETTER';
    process.env.DW_TRANSMITTAL_END_MARKERS = 'END OF TRANSMITTAL';
    process.env.DW_TRANSMITTAL_NEXT_SECTION_MARKERS = 'GENERAL TERMS';
    const master = await createPdf([
      'Cover page',
      'TRANSMITTAL LETTER',
      'End of Transmittal',
      'GENERAL TERMS',
      'Appendix',
    ]);

    const extracted = await pdfSections.extractTransmittalLetter(master);
    const original = await PDFDocument.load(master);
    const letter = await PDFDocument.load(extracted.pdfBuffer);

    expect(extracted).toMatchObject({ startPage: 1, endPage: 2 });
    expect(original.getPageCount()).toBe(5);
    expect(letter.getPageCount()).toBe(2);
  });

  it('replaces only the detected page range in the master document', async () => {
    const master = await createPdf(['Cover', 'Unsigned letter', 'Terms']);
    const signedLetter = await createPdf(['Signed letter', 'Signature certificate']);
    const replacement = await pdfSections.replacePageRange(master, signedLetter, 1, 1);
    const result = await PDFDocument.load(replacement);

    expect(result.getPageCount()).toBe(4);
  });

  it('fails instead of signing a document without a detectable transmittal', async () => {
    const master = await createPdf(['Cover', 'General terms']);
    await expect(pdfSections.extractTransmittalLetter(master))
      .rejects.toThrow('Could not find a transmittal letter start marker');
  });
});
