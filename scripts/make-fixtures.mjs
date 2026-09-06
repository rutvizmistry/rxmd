// Generates sample "article" PDFs so we can exercise extraction + the reader
// without needing real files. Output goes to public/samples/.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'samples');
await mkdir(outDir, { recursive: true });

const articles = [
  {
    file: 'lancet-statin.pdf',
    title: 'Efficacy and Safety of High-Intensity Statin Therapy in Primary Prevention',
    authors: 'A. R. Mehta, J. L. Okafor, S. Kowalski, D. Fernandez',
    doi: '10.1016/S0140-6736(23)01234-5',
    abstract: 'Background: Statins reduce cardiovascular events, yet their role in low-risk primary prevention remains debated. We conducted a randomized controlled trial across 42 centres. Methods: A total of 8,214 adults without prior cardiovascular disease were randomized to high-intensity statin therapy or placebo. Findings: High-intensity statin therapy reduced the composite endpoint of myocardial infarction and stroke by 27 percent over five years.'
  },
  {
    file: 'nejm-immunotherapy.pdf',
    title: 'Checkpoint Inhibition Combined with Chemotherapy in Advanced Non–Small-Cell Lung Cancer',
    authors: 'H. Tanaka, M. O’Brien, P. Nwosu, L. Andersson',
    doi: '10.1056/NEJMoa2100001',
    abstract: 'Background: Immune checkpoint inhibitors have transformed the treatment of non-small-cell lung cancer. Methods: In this phase 3 trial we assigned 1,020 patients to pembrolizumab plus chemotherapy or chemotherapy alone. Results: Median overall survival was significantly longer in the combination group.'
  },
  {
    file: 'bmj-sleep.pdf',
    title: 'Association Between Sleep Duration and Incident Type 2 Diabetes: A Cohort Study',
    authors: 'R. Z. Mistry, K. Sharma, T. Bianchi',
    doi: '10.1136/bmj.n2233',
    abstract: 'Objective: To examine the relation between habitual sleep duration and the risk of type 2 diabetes. Design: Prospective cohort study of 240,000 participants. Results: Both short and long sleep duration were associated with increased incidence of type 2 diabetes, describing a U-shaped relation.'
  }
];

for (const a of articles) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(a.title);
  pdf.setAuthor(a.authors);
  const page = pdf.addPage([595, 842]); // A4
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const wrap = (text, f, size, max) => {
    const words = text.split(' ');
    const lines = [];
    let line = '';
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (f.widthOfTextAtSize(test, size) > max && line) { lines.push(line); line = w; }
      else line = test;
    }
    if (line) lines.push(line);
    return lines;
  };
  let y = 800;
  const margin = 56;
  const width = 595 - margin * 2;
  for (const l of wrap(a.title, bold, 19, width)) { page.drawText(l, { x: margin, y, size: 19, font: bold, color: rgb(0.1, 0.15, 0.2) }); y -= 24; }
  y -= 8;
  for (const l of wrap(a.authors, font, 11, width)) { page.drawText(l, { x: margin, y, size: 11, font, color: rgb(0.3, 0.35, 0.4) }); y -= 15; }
  y -= 10;
  page.drawText('doi: ' + a.doi, { x: margin, y, size: 9, font, color: rgb(0.4, 0.45, 0.5) }); y -= 22;
  page.drawText('Abstract', { x: margin, y, size: 13, font: bold }); y -= 18;
  for (const l of wrap(a.abstract, font, 10.5, width)) { page.drawText(l, { x: margin, y, size: 10.5, font, color: rgb(0.15, 0.2, 0.25) }); y -= 15; }
  // a second page of body text
  const p2 = pdf.addPage([595, 842]);
  p2.drawText('Introduction', { x: margin, y: 800, size: 13, font: bold });
  const body = 'This section describes the study rationale, methods, and statistical analysis plan in detail. '.repeat(8);
  let yy = 780;
  for (const l of wrap(body, font, 10.5, width)) { p2.drawText(l, { x: margin, y: yy, size: 10.5, font }); yy -= 15; if (yy < 60) break; }

  const bytes = await pdf.save();
  await writeFile(resolve(outDir, a.file), bytes);
  console.log('wrote', a.file);
}
console.log('Fixtures written to', outDir);
