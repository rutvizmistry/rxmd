import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { EventBus, PDFLinkService, PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs';
import 'pdfjs-dist/web/pdf_viewer.css';
import { MarkupManager, DEFAULT_UNDERLINE_OPTS } from './markup.js';

// The PDF worker was previously configured in the (now removed) extract.js.
// Set it here so the reader can render.
pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

const EditorType = pdfjsLib.AnnotationEditorType; // NONE:0 FREETEXT:3 STAMP:13 HIGHLIGHT:9 INK:15
const P = pdfjsLib.AnnotationEditorParamsType;

// underline is not a pdf.js editor; it maps to NONE (text stays selectable) and
// is handled by MarkupManager.
const TOOL_MODE = {
  cursor: EditorType.NONE,
  highlight: EditorType.HIGHLIGHT,
  underline: EditorType.NONE,
  freetext: EditorType.FREETEXT,
  ink: EditorType.INK,
  stamp: EditorType.STAMP
};

// Which contextual controls each tool exposes.
const TOOL_UI = {
  cursor:    { swatch: false, thickness: null, opacity: false, font: false },
  highlight: { swatch: true, thickness: { min: 8, max: 24, def: 12, param: P.HIGHLIGHT_THICKNESS }, opacity: false, font: false },
  underline: { swatch: true, opacity: false, font: false },
  freetext:  { swatch: true, opacity: false, font: true },
  ink:       { swatch: true, thickness: { min: 1, max: 24, def: 3, param: P.INK_THICKNESS }, opacity: true },
  stamp:     { swatch: false, opacity: false, font: false }
};

// Tools that carry a color (drives swatch/picker + the active-swatch highlight).
const HAS_COLOR = new Set(['highlight', 'underline', 'freetext', 'ink']);
const PALETTE = ['#111111', '#d1180b', '#f59e0b', '#fff066', '#22c55e', '#3a9bdc', '#8b5cf6', '#ec4899'];

// Dark-mode shade presets (page canvas filter + gutter background).
export const DARK_SHADES = {
  charcoal: { label: 'Charcoal', filter: 'invert(0.9) hue-rotate(180deg) brightness(1.05)', bg: '#1e1e1e' },
  black:    { label: 'Black',    filter: 'invert(1) hue-rotate(180deg)',                     bg: '#0c0c0c' },
  slate:    { label: 'Slate',    filter: 'invert(0.86) hue-rotate(180deg) brightness(1.08)', bg: '#22262b' },
  gray:     { label: 'Dark gray',filter: 'invert(0.82) hue-rotate(180deg) brightness(1.12)', bg: '#2c2f33' }
};

export class Reader {
  constructor(els) {
    this.els = els;
    this.article = null;
    this.pdfDoc = null;
    this.tool = 'cursor';
    this.dirty = false;
    this.pdfDark = false;

    this.pdfShade = 'charcoal';

    // Per-tool remembered settings so each tool keeps its own color/size.
    this.state = {
      color: { highlight: '#fff066', underline: '#d1180b', freetext: '#111111', ink: '#d1180b' },
      highlightThickness: 12,
      inkThickness: 3,
      inkOpacity: 100,
      fontSize: 16
    };

    this.eventBus = new EventBus();
    this.linkService = new PDFLinkService({ eventBus: this.eventBus });
    this.pdfViewer = new PDFViewer({
      container: els.container,
      viewer: els.viewer,
      eventBus: this.eventBus,
      linkService: this.linkService,
      annotationEditorMode: EditorType.NONE,
      annotationMode: pdfjsLib.AnnotationMode.ENABLE
    });
    this.linkService.setViewer(this.pdfViewer);

    this.markup = new MarkupManager(this.pdfViewer, this.eventBus, els.container);
    this.markup.onChange = () => { this.dirty = true; };

    this.eventBus.on('pagesinit', () => {
      this.pdfViewer.currentScaleValue = 'page-width';
      this.updateZoomLabel();
    });
    this.eventBus.on('annotationeditorstateschanged', () => { this.dirty = true; });
    this.eventBus.on('scalechanging', () => this.updateZoomLabel());

    this.buildSwatches();
    this.wireUI();
  }

  buildSwatches() {
    this.els.swatches.innerHTML = '';
    this.swatchEls = PALETTE.map((c) => {
      const b = document.createElement('button');
      b.className = 'swatch';
      b.style.background = c;
      b.dataset.color = c;
      b.title = c;
      b.addEventListener('click', () => this.setColor(c));
      this.els.swatches.appendChild(b);
      return b;
    });
  }

  wireUI() {
    const { els } = this;
    els.close.addEventListener('click', () => this.close());
    els.tools.forEach((btn) => btn.addEventListener('click', () => this.setTool(btn.dataset.tool)));
    els.color.addEventListener('input', () => this.setColor(els.color.value));
    els.thickness.addEventListener('input', () => this.onThickness(+els.thickness.value));
    els.opacity.addEventListener('input', () => this.onOpacity(+els.opacity.value));
    els.fontSize.addEventListener('input', () => this.onFontSize(+els.fontSize.value));
    els.zoomIn.addEventListener('click', () => this.zoom(0.15));
    els.zoomOut.addEventListener('click', () => this.zoom(-0.15));
    els.save.addEventListener('click', () => this.save());
    els.pdfDarkBtn.addEventListener('click', () => this.setPdfDark(!this.pdfDark, true));
    els.undo.addEventListener('click', () => this.editAction('undo'));
    els.redo.addEventListener('click', () => this.editAction('redo'));
    els.del.addEventListener('click', () => this.editAction('delete'));
    this.wireUnderlineDialog();
    document.addEventListener('keydown', (e) => {
      if (els.root.hidden) return;
      if (e.key === 'Escape' && this.tool === 'cursor') this.close();
    });
  }

  wireUnderlineDialog() {
    const els = this.els;
    if (!els.underlineOptsBtn) return;
    els.underlineOptsBtn.addEventListener('click', () => {
      if (els.ulPdfName) els.ulPdfName.textContent = this.article?.title || this.article?.fileName || 'this PDF';
      this.syncUnderlineDialog();
      els.underlineDialog.showModal();
    });
    const apply = (persist) => {
      const opts = {
        descenderRatio: +els.ulDescenderRatio.value,
        clearancePt: +els.ulClearance.value
      };
      els.ulDescenderRatioVal.textContent = opts.descenderRatio.toFixed(2);
      els.ulClearanceVal.textContent = opts.clearancePt.toFixed(1);
      this.markup.setOpts(opts); // re-flows live previews
      if (persist) this.saveUnderlineOpts?.(this.article?.id, { ...this.markup.opts }, false);
    };
    els.ulDescenderRatio.addEventListener('input', () => apply(true));
    els.ulClearance.addEventListener('input', () => apply(true));
    els.ulResetBtn.addEventListener('click', () => {
      els.ulDescenderRatio.value = DEFAULT_UNDERLINE_OPTS.descenderRatio;
      els.ulClearance.value = DEFAULT_UNDERLINE_OPTS.clearancePt;
      apply(true);
    });
    els.ulDefaultBtn.addEventListener('click', () => {
      this.saveUnderlineOpts?.(this.article?.id, { ...this.markup.opts }, true);
      els.ulDefaultBtn.textContent = 'Saved as default ✓';
      setTimeout(() => { els.ulDefaultBtn.textContent = 'Set as default'; }, 1400);
    });
  }

  // Reflect the active PDF's placement values in the dialog sliders.
  syncUnderlineDialog() {
    const els = this.els;
    if (!els.ulDescenderRatio) return;
    els.ulDescenderRatio.value = this.markup.opts.descenderRatio;
    els.ulClearance.value = this.markup.opts.clearancePt;
    els.ulDescenderRatioVal.textContent = (+this.markup.opts.descenderRatio).toFixed(2);
    els.ulClearanceVal.textContent = (+this.markup.opts.clearancePt).toFixed(1);
  }

  async open(article, bytes, onSaved) {
    this.article = article;
    this.onSaved = onSaved;
    this.dirty = false;
    this.els.title.textContent = article.title || article.fileName;
    this.els.root.hidden = false;

    this.markup.clear();
    // Load this PDF's saved underline placement (falls back to the shared default).
    const saved = await this.loadUnderlineOpts?.(article.id);
    this.markup.opts = { ...DEFAULT_UNDERLINE_OPTS, ...(saved || {}) };
    this.syncUnderlineDialog();
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this.pdfDoc = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
    this.pdfViewer.setDocument(this.pdfDoc);
    this.linkService.setDocument(this.pdfDoc, null);
    this.setTool('cursor');
    this.setPdfDark(this.pdfDark, false);
  }

  setTool(tool) {
    if (!TOOL_MODE.hasOwnProperty(tool)) return;
    this.tool = tool;
    this.els.tools.forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
    try {
      this.pdfViewer.annotationEditorMode = { mode: TOOL_MODE[tool] };
    } catch (e) {
      console.warn('Could not switch annotation mode', e);
    }
    this.markup.setActive(tool === 'underline', this.state.color.underline);
    this.syncParamsUI();
    this.applyToolParams();
  }

  // Show/hide contextual controls + set slider ranges for the active tool.
  syncParamsUI() {
    const ui = TOOL_UI[this.tool] || {};
    const showParams = !!(ui.swatch || ui.thickness || ui.opacity || ui.font);
    this.els.params.classList.toggle('hidden-params', !showParams);
    this.els.thicknessWrap.hidden = !ui.thickness;
    this.els.opacityWrap.hidden = !ui.opacity;
    this.els.fontSizeWrap.hidden = !ui.font;
    if (this.els.underlineOptsBtn) this.els.underlineOptsBtn.hidden = this.tool !== 'underline';

    if (ui.thickness) {
      const t = ui.thickness;
      this.els.thickness.min = t.min; this.els.thickness.max = t.max;
      this.els.thickness.value = this.tool === 'highlight' ? this.state.highlightThickness : this.state.inkThickness;
    }
    if (ui.opacity) this.els.opacity.value = this.state.inkOpacity;
    if (ui.font) this.els.fontSize.value = this.state.fontSize;

    const color = this.state.color[this.tool];
    if (color) {
      this.els.color.value = color;
      this.swatchEls.forEach((s) => s.classList.toggle('active', s.dataset.color.toLowerCase() === color.toLowerCase()));
    } else {
      this.swatchEls.forEach((s) => s.classList.remove('active'));
    }
  }

  // Push the active tool's remembered params into the editor.
  applyToolParams() {
    const ui = TOOL_UI[this.tool] || {};
    if (HAS_COLOR.has(this.tool)) this.emitColor(this.state.color[this.tool]);
    if (ui.thickness) this.dispatch(ui.thickness.param, +this.els.thickness.value);
    if (ui.opacity) this.dispatch(P.INK_OPACITY, this.state.inkOpacity / 100);
    if (ui.font) this.dispatch(P.FREETEXT_SIZE, this.state.fontSize);
  }

  dispatch(type, value) {
    this.eventBus.dispatch('switchannotationeditorparams', { source: this, type, value });
  }

  // Highlight needs HIGHLIGHT_DEFAULT_COLOR to recolor *new* highlights
  // (HIGHLIGHT_COLOR only affects an already-selected one). Send both so it
  // works whether or not an annotation is selected.
  emitColor(color) {
    if (this.tool === 'highlight') {
      this.dispatch(P.HIGHLIGHT_DEFAULT_COLOR, color);
      this.dispatch(P.HIGHLIGHT_COLOR, color);
    } else if (this.tool === 'freetext') {
      this.dispatch(P.FREETEXT_COLOR, color);
    } else if (this.tool === 'ink') {
      this.dispatch(P.INK_COLOR, color);
    } else if (this.tool === 'underline') {
      this.markup.setColor(color);
    }
  }

  setColor(color) {
    if (!HAS_COLOR.has(this.tool)) return;
    this.state.color[this.tool] = color;
    this.els.color.value = color;
    this.swatchEls.forEach((s) => s.classList.toggle('active', s.dataset.color.toLowerCase() === color.toLowerCase()));
    this.emitColor(color);
  }

  onThickness(v) {
    const ui = TOOL_UI[this.tool];
    if (!ui || !ui.thickness) return;
    if (this.tool === 'highlight') this.state.highlightThickness = v; else this.state.inkThickness = v;
    this.dispatch(ui.thickness.param, v);
  }

  onOpacity(v) {
    if (this.tool !== 'ink') return;
    this.state.inkOpacity = v;
    this.dispatch(P.INK_OPACITY, v / 100);
  }

  onFontSize(v) {
    if (this.tool !== 'freetext') return;
    this.state.fontSize = v;
    this.dispatch(P.FREETEXT_SIZE, v);
  }

  editAction(name) {
    this.eventBus.dispatch('editingaction', { source: this, name });
  }

  setPdfDark(on, persist) {
    this.pdfDark = on;
    this.els.viewer.classList.toggle('pdf-dark', on);
    this.els.root.classList.toggle('pdf-dark-bg', on);
    this.els.pdfDarkBtn.classList.toggle('active', on);
    this.applyShade();
    if (persist) this.onPdfDarkChange?.(on);
  }

  setPdfShade(name, persist) {
    if (!DARK_SHADES[name]) return;
    this.pdfShade = name;
    if (this.els.pdfShade) this.els.pdfShade.value = name;
    // Choosing a shade implies dark mode is on.
    if (!this.pdfDark) this.setPdfDark(true, persist);
    else this.applyShade();
    if (persist) this.onPdfShadeChange?.(name);
  }

  applyShade() {
    const s = DARK_SHADES[this.pdfShade] || DARK_SHADES.charcoal;
    this.els.viewer.style.setProperty('--pdf-dark-filter', s.filter);
    this.els.root.style.setProperty('--pdf-dark-bg', s.bg);
  }

  zoom(delta) {
    const next = Math.min(4, Math.max(0.25, (this.pdfViewer.currentScale || 1) + delta));
    this.pdfViewer.currentScale = next;
    this.updateZoomLabel();
  }

  updateZoomLabel() {
    this.els.zoomLevel.textContent = Math.round((this.pdfViewer.currentScale || 1) * 100) + '%';
  }

  async save() {
    if (!this.pdfDoc || !this.article) return;
    if (!this.saveBytes) { console.warn('No saveBytes handler (dev preview).'); return; }
    const btn = this.els.save;
    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      let bytes = await this.pdfDoc.saveDocument();
      // Burn any pending underline markups into the saved bytes.
      bytes = await this.markup.burnInto(bytes);
      // Hand the annotated bytes to the app, which PUTs them to the server so it
      // can overwrite the library copy on disk.
      await this.saveBytes(this.article, bytes);
      this.markup.clear();
      this.dirty = false;
      btn.textContent = 'Saved ✓';
      await this.reload(bytes);
      setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1200);
      this.onSaved?.(this.article);
    } catch (err) {
      console.error('Save failed', err);
      btn.textContent = 'Save failed';
      setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1600);
    }
  }

  async reload(bytes) {
    const scale = this.pdfViewer.currentScale;
    const scroll = this.els.container.scrollTop;
    const old = this.pdfDoc;
    this.pdfDoc = await pdfjsLib.getDocument({ data: new Uint8Array(bytes.slice(0)), isEvalSupported: false }).promise;
    this.pdfViewer.setDocument(this.pdfDoc);
    this.linkService.setDocument(this.pdfDoc, null);
    this.eventBus.on('pagesloaded', () => {
      this.pdfViewer.currentScale = scale;
      this.els.container.scrollTop = scroll;
    }, { once: true });
    old?.destroy();
  }

  async close() {
    if (this.dirty && !confirm('You have unsaved annotations. Close without saving?')) return;
    this.els.root.hidden = true;
    this.markup.clear();
    this.pdfViewer.setDocument(null);
    if (this.pdfDoc) { await this.pdfDoc.destroy(); this.pdfDoc = null; }
    this.article = null;
    this.dirty = false;
  }
}
