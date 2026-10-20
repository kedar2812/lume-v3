/*
 * Test files as text: OpenDocument's flat XML, which LibreOffice turns into .docx, .xlsx, .pptx and PDF in the test
 * itself. Fictional words only.
 */

const NS = [
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"',
  'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"',
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"',
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"',
  'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"',
  'xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0"',
  'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"',
  'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"',
].join(" ");
const doc = (mimetype: string, inner: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<office:document ${NS} office:version="1.3" office:mimetype="${mimetype}">${inner}</office:document>\n`;

/** A text document with each paragraph on a page of its own. */
export const fodt = (pages: string[]) =>
  doc(
    "application/vnd.oasis.opendocument.text",
    `<office:automatic-styles><style:style style:name="Break" style:family="paragraph"><style:paragraph-properties fo:break-before="page"/></style:style></office:automatic-styles>` +
      `<office:body><office:text>${pages
        .map((p, i) => `<text:p${i ? ' text:style-name="Break"' : ""}>${p}</text:p>`)
        .join("")}</office:text></office:body>`,
  );

/** A spreadsheet of one sheet: a name and a number on each row. */
export const fods = (rows: [string, number][]) =>
  doc(
    "application/vnd.oasis.opendocument.spreadsheet",
    `<office:body><office:spreadsheet><table:table table:name="Prices">${rows
      .map(
        ([name, n]) =>
          `<table:table-row><table:table-cell office:value-type="string"><text:p>${name}</text:p></table:table-cell>` +
          `<table:table-cell office:value-type="float" office:value="${n}"><text:p>${n}</text:p></table:table-cell></table:table-row>`,
      )
      .join("")}</table:table></office:spreadsheet></office:body>`,
  );

/** A presentation, one slide per title. */
export const fodp = (slides: string[]) =>
  doc(
    "application/vnd.oasis.opendocument.presentation",
    `<office:master-styles><style:master-page style:name="Default"/></office:master-styles>` +
      `<office:body><office:presentation>${slides
        .map(
          (title, i) =>
            `<draw:page draw:name="Slide ${i + 1}" draw:master-page-name="Default"><draw:frame svg:x="2cm" svg:y="2cm" svg:width="20cm" svg:height="3cm"><draw:text-box><text:p>${title}</text:p></draw:text-box></draw:frame></draw:page>`,
        )
        .join("")}</office:presentation></office:body>`,
  );

/** A JPEG with an EXIF orientation (1–8) put in front of its other parts, as a phone camera writes it. */
export function withOrientation(jpeg: Buffer, orientation: number): Buffer {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error("not a JPEG");
  // prettier-ignore
  const exif = Buffer.from([
    0xff, 0xe1, 0x00, 0x22, // APP1, 34 bytes
    0x45, 0x78, 0x69, 0x66, 0x00, 0x00, // "Exif\0\0"
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // big-endian TIFF, first IFD at 8
    0x00, 0x01, // one entry
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00, // Orientation, SHORT
    0x00, 0x00, 0x00, 0x00, // no next IFD
  ]);
  return Buffer.concat([jpeg.subarray(0, 2), exif, jpeg.subarray(2)]);
}
