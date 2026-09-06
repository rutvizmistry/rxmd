// Underline text-markup support. pdf.js can render Underline annotations but has
// no editor to create them, so we: capture the text selection → store the quad
// in PDF coordinates → draw a live CSS overlay → burn real /Underline annotations
// into the file with pdf-lib on save (pdf.js then renders them from QuadPoints).

// Vertical placement. The underline must sit a fixed distance below the text
// baseline. We anchor to the real baseline from pdf.js's text items (a PDF-space
// value that never changes with zoom) rather than the browser selection rect,
// whose bottom drifts by a few points depending on the zoom level at capture time
// — which used to make underlines drawn at different zooms sit at different heights.
//
// pdf.js draws a burned Underline not at the quad bottom but PDFJS_LIFT_PT above it
// (see UnderlineAnnotation in pdf.js: `points[5] + 1.3`), so we lower the stored
// quad bottom by that amount to compensate. The visible line ends up
// (descenderRatio·fontSize + clearancePt) below the baseline. Both default to 0 —
// the line sits right on the baseline (classic underline) — and are per-document
// knobs (see DEFAULT_UNDERLINE_OPTS) for journals that need it lower.
const PDFJS_LIFT_PT = 1.3;     // pdf.js's built-in underline lift above the quad bottom
const ASCENT_RATIO = 0.8;      // ascender height as a fraction of font size (for the quad top)

// Per-document placement knobs (tunable from the reader's Underline placement dialog,
// since different journals' fonts and text layers seat the line a little differently).
// The visible line sits (descenderRatio × fontSize + clearancePt) below the baseline;
// 0/0 places it on the baseline, the classic underline look.
export const DEFAULT_UNDERLINE_OPTS = {
  descenderRatio: 0, // proportional drop, scales with font size (raise to clear descenders)
  clearancePt: 0     // extra fixed gap below the baseline, in PDF points
};
// Fallback drop when no baseline is known (rect-bottom ≈ descender line).
const FALLBACK_DROP_PT = PDFJS_LIFT_PT + 1.5;

function hexToRgb01(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '#d1180b');
  const n = m ? parseInt(m[1], 16) : 0xd1180b;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export class MarkupManager {
  constructor(pdfViewer, eventBus, container) {
    this.pdfViewer = pdfViewer;
    this.container = container;
    this.markups = []; // { page, quad:[8 pdf pts], rect:[4], color, anchor? }
    this.active = false;
    this.color = '#d1180b';
    this.onChange = null;
    this.opts = { ...DEFAULT_UNDERLINE_OPTS };
    this.baselines = new Map(); // pageNumber → [{ baseline, x0, x1, fontPt }] in PDF space

    container.addEventListener('mouseup', () => {
      if (this.active) setTimeout(() => this.captureSelection(), 0);
    });
    eventBus.on('pagerendered', ({ pageNumber }) => {
      this.cacheBaselines(pageNumber);
      this.redrawPage(pageNumber);
    });
  }

  // Cache each text run's baseline (transform[5]) and x-range in PDF coordinates so
  // captureSelection can place underlines relative to the real baseline, zoom-free.
  async cacheBaselines(pageNumber) {
    if (this.baselines.has(pageNumber)) return;
    const pageView = this.pdfViewer.getPageView(pageNumber - 1);
    const pdfPage = pageView?.pdfPage;
    if (!pdfPage) return;
    try {
      const { items } = await pdfPage.getTextContent();
      const rows = [];
      for (const it of items) {
        if (!it.str || !it.transform) continue;
        const t = it.transform;
        const fontPt = Math.hypot(t[2], t[3]) || Math.abs(t[3]);
        if (!fontPt) continue;
        rows.push({ baseline: t[5], x0: t[4], x1: t[4] + (it.width || 0), fontPt });
      }
      this.baselines.set(pageNumber, rows);
    } catch { /* text layer unavailable — captureSelection falls back to the rect */ }
  }

  // Best-matching text baseline for a selection rectangle (already in PDF coords).
  // The selected line's baseline sits just above the rectangle's bottom edge, so we
  // pick the horizontally-overlapping run whose baseline is CLOSEST to that bottom
  // edge. Choosing by proximity (not by overlap width) is essential for justified
  // text, where a line is split into many runs and the full-width run on the line
  // *above* can overlap a short selection more than the selection's own run does.
  baselineForRect(pageNumber, xLeft, xRight, yBottom, yTop) {
    const rows = this.baselines.get(pageNumber);
    if (!rows) return null;
    const margin = 2; // pt of slack so a slightly short rect still catches its baseline
    let best = null, bestDist = Infinity;
    for (const r of rows) {
      if (r.baseline < yBottom - margin || r.baseline > yTop + margin) continue;
      if (Math.min(r.x1, xRight) - Math.max(r.x0, xLeft) <= 0) continue; // must overlap in x
      const dist = Math.abs(r.baseline - yBottom);
      if (dist < bestDist) { bestDist = dist; best = r; }
    }
    return best;
  }

  // Quad-bottom PDF-y for a baseline anchor under the current placement options.
  // The extra −PDFJS_LIFT_PT cancels pdf.js's built-in lift so the drawn line lands
  // exactly (descenderRatio·fontSize + clearancePt) below the baseline.
  bottomForAnchor(anchor) {
    return anchor.baseline - (this.opts.descenderRatio * anchor.fontPt + this.opts.clearancePt) - PDFJS_LIFT_PT;
  }

  // Apply new placement options and re-flow every baseline-anchored underline so the
  // live preview updates immediately. Fallback marks (no anchor) keep their position.
  setOpts(opts) {
    this.opts = { ...DEFAULT_UNDERLINE_OPTS, ...this.opts, ...opts };
    for (const m of this.markups) {
      if (!m.anchor) continue;
      const botY = this.bottomForAnchor(m.anchor);
      m.quad[5] = m.quad[7] = botY;         // both bottom corners
      m.rect[1] = Math.min(botY, m.quad[1]); // rect min-y follows the bottom
    }
    this.redrawAll();
    if (this.markups.some((m) => m.anchor)) this.onChange?.();
  }

  setActive(on, color) {
    this.active = on;
    if (color) this.color = color;
    this.container.classList.toggle('underline-cursor', on);
    // Pre-warm baselines for every rendered page so the first underline drawn right
    // after switching tools uses the baseline anchor, not the less-accurate fallback.
    if (on) {
      const n = this.pdfViewer.pagesCount || 0;
      for (let i = 1; i <= n; i++) {
        if (this.pdfViewer.getPageView(i - 1)?.pdfPage) this.cacheBaselines(i);
      }
    }
  }

  setColor(color) { this.color = color; }

  captureSelection() {
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    const rects = [...range.getClientRects()].filter((r) => r.width > 1 && r.height > 1);
    const touched = new Set();
    for (const rect of rects) {
      const cx = (rect.left + rect.right) / 2;
      const cy = (rect.top + rect.bottom) / 2;
      const pageDiv = document.elementFromPoint(cx, cy)?.closest('.page');
      if (!pageDiv) continue;
      const num = +pageDiv.dataset.pageNumber;
      const pageView = this.pdfViewer.getPageView(num - 1);
      if (!pageView?.viewport) continue;

      const pr = pageDiv.getBoundingClientRect();
      const cs = getComputedStyle(pageDiv);
      const bl = parseFloat(cs.borderLeftWidth) || 0;
      const bt = parseFloat(cs.borderTopWidth) || 0;
      const toPdf = (x, y) => pageView.viewport.convertToPdfPoint(x - pr.left - bl, y - pr.top - bt);
      const tl = toPdf(rect.left, rect.top);
      const tr = toPdf(rect.right, rect.top);
      const bLf = toPdf(rect.left, rect.bottom);
      const bRt = toPdf(rect.right, rect.bottom);

      // Place the quad bottom relative to the true text baseline when we know it, so
      // the line sits a fixed distance below the descenders regardless of zoom. The
      // PDFJS_LIFT_PT offset cancels pdf.js's built-in lift so the drawn line lands at
      // exactly (baseline − descenders − clearance). Fall back to the rect bottom
      // (≈ the descender line) when no baseline is available.
      const xL = Math.min(tl[0], bLf[0]), xR = Math.max(tr[0], bRt[0]);
      const base = this.baselineForRect(num, xL, xR, Math.min(bLf[1], bRt[1]), Math.max(tl[1], tr[1]));
      let topY, botY, anchor = null;
      if (base) {
        anchor = { baseline: base.baseline, fontPt: base.fontPt };
        botY = this.bottomForAnchor(anchor);
        topY = base.baseline + ASCENT_RATIO * base.fontPt;
      } else {
        botY = Math.min(bLf[1], bRt[1]) - FALLBACK_DROP_PT;
        topY = Math.max(tl[1], tr[1]);
      }
      bLf[1] = bRt[1] = botY;
      tl[1] = tr[1] = topY;
      const quad = [tl[0], tl[1], tr[0], tr[1], bLf[0], bLf[1], bRt[0], bRt[1]];
      const xs = [tl[0], tr[0], bLf[0], bRt[0]];
      const ys = [tl[1], tr[1], bLf[1], bRt[1]];
      this.markups.push({
        page: num,
        quad,
        rect: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
        color: this.color,
        anchor
      });
      touched.add(num);
    }
    if (touched.size) {
      sel.removeAllRanges();
      touched.forEach((n) => this.redrawPage(n));
      this.onChange?.();
    }
  }

  redrawPage(pageNumber) {
    const pageView = this.pdfViewer.getPageView(pageNumber - 1);
    if (!pageView?.div || !pageView.viewport) return;
    let layer = pageView.div.querySelector(':scope > .rxmd-markup-layer');
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'rxmd-markup-layer';
      pageView.div.appendChild(layer);
    }
    layer.textContent = '';
    for (const m of this.markups) {
      if (m.page !== pageNumber) continue;
      // Draw where pdf.js will render the burned line (quad bottom + 1.3pt) so the
      // live preview matches the saved result exactly.
      const [x1, y1] = pageView.viewport.convertToViewportPoint(m.quad[4], m.quad[5] + PDFJS_LIFT_PT); // bottom-left
      const [x2, y2] = pageView.viewport.convertToViewportPoint(m.quad[6], m.quad[7] + PDFJS_LIFT_PT); // bottom-right
      const line = document.createElement('div');
      line.className = 'rxmd-underline';
      line.style.left = Math.min(x1, x2) + 'px';
      line.style.top = Math.max(y1, y2) + 'px';
      line.style.width = Math.abs(x2 - x1) + 'px';
      line.style.background = m.color;
      layer.appendChild(line);
    }
  }

  redrawAll() {
    const pages = new Set(this.markups.map((m) => m.page));
    pages.forEach((n) => this.redrawPage(n));
  }

  hasPending() { return this.markups.length > 0; }

  clear() {
    this.markups = [];
    this.baselines.clear();
    this.container.querySelectorAll('.rxmd-markup-layer').forEach((l) => (l.textContent = ''));
  }

  // Inject the pending underlines into the PDF bytes and return new bytes.
  async burnInto(bytes) {
    if (!this.markups.length) return bytes;
    const { PDFDocument, PDFName } = await import('pdf-lib');
    const doc = await PDFDocument.load(bytes);
    const pages = doc.getPages();
    for (const m of this.markups) {
      const page = pages[m.page - 1];
      if (!page) continue;
      const [r, g, b] = hexToRgb01(m.color);
      const annot = doc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Underline'),
        Rect: m.rect,
        QuadPoints: m.quad,
        C: [r, g, b],
        CA: 1,
        F: 4
      });
      page.node.addAnnot(doc.context.register(annot));
    }
    // Classic xref (no object streams) keeps the markup annotations parseable by
    // simpler PDF readers too.
    return doc.save({ useObjectStreams: false });
  }
}
