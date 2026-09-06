// EPUB reader built on epub.js. Unlike PDFs (where annotations are burned into the
// file), EPUB highlights are stored as sidecar data (CFI ranges) on the server and
// re-applied on open — epub.js renders highlights from CFIs, it doesn't rewrite the
// book file.

import ePub from 'epubjs';
import { fileUrl, getEpubAnnotations, saveEpubAnnotations } from './api.js';

export class EpubReader {
  constructor(els) {
    this.els = els;          // { root, close, title, area, prev, next, progress, highlightBtn }
    this.book = null;
    this.rendition = null;
    this.item = null;
    this.annotations = [];
    this.highlightOn = false;
    this._wire();
  }

  _wire() {
    this.els.close.addEventListener('click', () => this.close());
    this.els.prev.addEventListener('click', () => this.rendition?.prev());
    this.els.next.addEventListener('click', () => this.rendition?.next());
    this.els.highlightBtn?.addEventListener('click', () => {
      this.highlightOn = !this.highlightOn;
      this.els.highlightBtn.classList.toggle('active', this.highlightOn);
    });
    document.addEventListener('keydown', (e) => {
      if (this.els.root.hidden) return;
      if (e.key === 'ArrowRight') this.rendition?.next();
      else if (e.key === 'ArrowLeft') this.rendition?.prev();
      else if (e.key === 'Escape') this.close();
    });
  }

  async open(item) {
    this.item = item;
    this.els.title.textContent = item.title || item.fileName;
    this.els.root.hidden = false;
    this.els.area.innerHTML = '';

    this.book = ePub(fileUrl(item.id), { openAs: 'epub' });
    this.rendition = this.book.renderTo(this.els.area, {
      width: '100%', height: '100%', flow: 'paginated', spread: 'auto'
    });
    await this.rendition.display();

    // Keep the reading surface a light "paper" regardless of app theme so the
    // book's own (usually black) text stays legible.
    this.rendition.themes.default({
      body: { background: '#fdfcf9', color: '#1a1a1a', padding: '0 8px' }
    });

    this.rendition.on('relocated', (loc) => {
      try {
        const pct = this.book.locations?.length ? this.book.locations.percentageFromCfi(loc.start.cfi) : null;
        if (this.els.progress && pct != null) this.els.progress.textContent = `${Math.round(pct * 100)}%`;
      } catch { /* locations not ready */ }
    });
    // Generate locations for a progress readout (async, best-effort).
    this.book.ready.then(() => this.book.locations.generate(1600)).catch(() => {});

    // Load + apply saved highlights.
    try {
      this.annotations = await getEpubAnnotations(item.id);
      for (const a of this.annotations) this._applyHighlight(a.cfi, a.color, false);
    } catch { this.annotations = []; }

    // New highlight on text selection while the highlight tool is on.
    this.rendition.on('selected', (cfiRange, contents) => {
      if (!this.highlightOn) return;
      const color = '#ffe066';
      this._applyHighlight(cfiRange, color, true);
      this.annotations.push({ cfi: cfiRange, color, at: Date.now() });
      this._persist();
      contents.window.getSelection()?.removeAllRanges();
    });
  }

  _applyHighlight(cfi, color, isNew) {
    try {
      this.rendition.annotations.add('highlight', cfi, {}, (e) => this._removeHighlight(cfi, e),
        'rxmd-hl', { fill: color || '#ffe066', 'fill-opacity': '0.35' });
    } catch { /* stale cfi */ }
  }

  _removeHighlight(cfi) {
    try { this.rendition.annotations.remove(cfi, 'highlight'); } catch { /* ignore */ }
    this.annotations = this.annotations.filter((a) => a.cfi !== cfi);
    this._persist();
  }

  _persist() {
    saveEpubAnnotations(this.item.id, this.annotations).catch(() => {});
  }

  close() {
    try { this.rendition?.destroy(); } catch { /* ignore */ }
    try { this.book?.destroy(); } catch { /* ignore */ }
    this.rendition = null; this.book = null; this.item = null;
    this.els.root.hidden = true;
    this.onClose?.();
  }
}
