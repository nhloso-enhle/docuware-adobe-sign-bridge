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

  beforeEach(() => {
    process.env.DW_TRANSMITTAL_START_MARKERS = 'TRANSMITTAL LETTER';
    process.env.DW_TRANSMITTAL_END_MARKERS = 'END OF TRANSMITTAL';
    process.env.DW_TRANSMITTAL_NEXT_SECTION_MARKERS = 'GENERAL TERMS';
  });

  afterEach(() => {
    if (startMarkers === undefined) delete process.env.DW_TRANSMITTAL_START_MARKERS;
    else process.env.DW_TRANSMITTAL_START_MARKERS = startMarkers;
    if (endMarkers === undefined) delete process.env.DW_TRANSMITTAL_END_MARKERS;
    else process.env.DW_TRANSMITTAL_END_MARKERS = endMarkers;
    if (nextMarkers === undefined) delete process.env.DW_TRANSMITTAL_NEXT_SECTION_MARKERS;
    else process.env.DW_TRANSMITTAL_NEXT_SECTION_MARKERS = nextMarkers;
  });

  it('extracts the transmittal pages between configured markers', async () => {
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

  it('downloads every clipped PDF section and selects only the transmittal section', async () => {
    const unrelatedBefore = await createPdf(['Invoice']);
    const clippedLetter = await createPdf(['TRANSMITTAL LETTER', 'Letter body']);
    const unrelatedAfter = await createPdf(['Terms']);
    const sections = [
      { Id: 'SEC-1', ContentType: 'application/pdf', OriginalFileName: 'invoice.pdf' },
      { Id: 'SEC-2', ContentType: 'application/pdf', OriginalFileName: 'letter.pdf' },
      { Id: 'SEC-3', ContentType: 'application/pdf', OriginalFileName: 'terms.pdf' },
      { Id: 'SEC-4', ContentType: 'image/tiff', OriginalFileName: 'scan.tif' },
    ];
    const files = new Map([
      ['SEC-1', unrelatedBefore],
      ['SEC-2', clippedLetter],
      ['SEC-3', unrelatedAfter],
    ]);
    const downloadSection = jest.fn(async (sectionId) => files.get(sectionId));

    const selected = await pdfSections.findTransmittalSection(
      sections,
      downloadSection,
      'DOC-1'
    );

    expect(downloadSection.mock.calls).toEqual([['SEC-1'], ['SEC-2'], ['SEC-3']]);
    expect(selected.section.Id).toBe('SEC-2');
    expect(selected.fileName).toBe('letter.pdf');
    expect(selected.pdfSectionCount).toBe(3);
    expect(selected.range).toEqual({ startPage: 0, endPage: 1 });
  });

  it('preserves stapled PDF handling for a single merged PDF section', async () => {
    const stapledPdf = await createPdf([
      'Cover',
      'TRANSMITTAL LETTER',
      'END OF TRANSMITTAL',
      'GENERAL TERMS',
    ]);
    const section = {
      Id: 'SEC-STAPLED',
      ContentType: 'application/pdf',
      OriginalFileName: 'stapled.pdf',
    };
    const downloadSection = jest.fn().mockResolvedValue(stapledPdf);

    const selected = await pdfSections.findTransmittalSection(
      [section],
      downloadSection,
      'DOC-2'
    );

    expect(downloadSection).toHaveBeenCalledTimes(1);
    expect(selected.section).toBe(section);
    expect(selected.range).toEqual({ startPage: 1, endPage: 2 });
  });
});
