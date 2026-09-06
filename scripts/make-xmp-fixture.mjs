// Creates a PDF with an embedded XMP metadata stream (like a real Nature PDF)
// so we can verify RxMD reads prism:publicationName without Crossref.
import { PDFDocument, PDFName, StandardFonts, rgb } from 'pdf-lib';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'samples');
await mkdir(outDir, { recursive: true });

const pdf = await PDFDocument.create();
const page = pdf.addPage([595, 842]);
const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
page.drawText('A July Article in a Nice Journal', { x: 56, y: 780, size: 18, font: bold, color: rgb(0.1, 0.15, 0.2) });

const xmp = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:prism="http://prismstandard.org/namespaces/basic/2.0/"
    xmlns:dc="http://purl.org/dc/elements/1.1/">
   <prism:publicationName>Nature Reviews Rheumatology</prism:publicationName>
   <prism:coverDate>2026-07-01</prism:coverDate>
   <prism:volume>22</prism:volume>
   <prism:number>7</prism:number>
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">A July Article in a Nice Journal</rdf:li></rdf:Alt></dc:title>
   <dc:creator><rdf:Seq><rdf:li>Jane Q. Author</rdf:li><rdf:li>John Coauthor</rdf:li></rdf:Seq></dc:creator>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

const stream = pdf.context.stream(xmp, { Type: 'Metadata', Subtype: 'XML' });
const ref = pdf.context.register(stream);
pdf.catalog.set(PDFName.of('Metadata'), ref);

const bytes = await pdf.save();
await writeFile(resolve(outDir, 'xmp-july.pdf'), bytes);
console.log('wrote xmp-july.pdf');
