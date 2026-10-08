// Windowed rendering for big folders: only rows near the viewport exist in the DOM.

export class VirtualList {
  /**
   * @param {HTMLElement} scroller element with overflow:auto
   * @param {{rowHeight:number, count:number, renderRow:(i:number)=>HTMLElement, overscan?:number, header?:number}} opts
   */
  constructor(scroller, opts) {
    this.scroller = scroller;
    this.opts = { overscan: 8, header: 0, ...opts };
    this.spacer = document.createElement("div");
    this.spacer.className = "v-spacer";
    this.layer = document.createElement("div");
    this.layer.className = "v-layer";
    this.spacer.append(this.layer);
    scroller.append(this.spacer);
    this.rows = new Map();
    this._onScroll = () => this.update();
    scroller.addEventListener("scroll", this._onScroll, { passive: true });
    this._ro = new ResizeObserver(() => this.update());
    this._ro.observe(scroller);
    this.setCount(opts.count);
  }

  setCount(count, rowHeight = this.opts.rowHeight) {
    this.opts.count = count;
    this.opts.rowHeight = rowHeight;
    this.spacer.style.height = `${count * rowHeight}px`;
    this.refresh();
  }

  refresh() {
    for (const el of this.rows.values()) el.remove();
    this.rows.clear();
    this.update();
  }

  update() {
    const { rowHeight, count, overscan, header } = this.opts;
    const top = Math.max(0, this.scroller.scrollTop - header);
    const height = this.scroller.clientHeight;
    const first = Math.max(0, Math.floor(top / rowHeight) - overscan);
    const last = Math.min(count - 1, Math.ceil((top + height) / rowHeight) + overscan);
    for (const [i, el] of this.rows) {
      if (i < first || i > last) { el.remove(); this.rows.delete(i); }
    }
    for (let i = first; i <= last; i++) {
      if (this.rows.has(i)) continue;
      const el = this.opts.renderRow(i);
      el.style.position = "absolute";
      el.style.top = `${i * rowHeight}px`;
      el.style.left = "0";
      el.style.right = "0";
      el.style.height = `${rowHeight}px`;
      this.layer.append(el);
      this.rows.set(i, el);
    }
  }

  scrollToRow(i) {
    const { rowHeight, header } = this.opts;
    const top = i * rowHeight + header;
    const st = this.scroller.scrollTop;
    const h = this.scroller.clientHeight;
    if (top < st + header) this.scroller.scrollTop = top - header;
    else if (top + rowHeight > st + h) this.scroller.scrollTop = top + rowHeight - h;
  }

  destroy() {
    this.scroller.removeEventListener("scroll", this._onScroll);
    this._ro.disconnect();
    this.spacer.remove();
    this.rows.clear();
  }
}
