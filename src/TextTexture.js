/**
 * @typedef {{ kind: 'text', text: string, el: HTMLElement }} TextSeg
 * @typedef {{ kind: 'break' }} BreakSeg
 * @typedef {TextSeg | BreakSeg} LayoutSeg
 */

/**
 * Walk the text-plane DOM: newlines inside text nodes and `<br>` become explicit
 * breaks; other elements contribute styled text runs (same as inline formatting).
 *
 * @param {HTMLElement} root
 * @returns {LayoutSeg[]}
 */
function buildTextSegments(root) {
  /** @type {LayoutSeg[]} */
  const segments = [];

  /**
   * @param {Node} node
   * @param {HTMLElement} styleEl
   */
  function walk(node, styleEl) {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node.textContent.replace(/\r\n|\r/g, '\n');
      const parts = t.split('\n');
      parts.forEach((piece, idx) => {
        if (idx > 0) segments.push({ kind: 'break' });
        const line = piece.replace(/\t/g, ' ');
        if (line.length) {
          segments.push({ kind: 'text', text: line, el: styleEl });
        }
      });
      return;
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = /** @type {HTMLElement} */ (node);
      if (el.tagName === 'BR') {
        segments.push({ kind: 'break' });
        return;
      }
      for (const c of el.childNodes) {
        walk(c, el);
      }
    }
  }

  for (const c of root.childNodes) {
    walk(c, root);
  }

  if (segments.length === 0) {
    const t = root.textContent.replace(/\r\n|\r/g, '\n');
    const parts = t.split('\n');
    parts.forEach((piece, idx) => {
      if (idx > 0) segments.push({ kind: 'break' });
      const line = piece.replace(/\t/g, ' ');
      if (line.length) {
        segments.push({ kind: 'text', text: line, el: root });
      }
    });
  }

  return segments;
}

export class TextTexture {
  constructor({
    plane,
    textElement,
    skipFontLoading = false,
    verticalAlign = "top",
    adjustAscenderRatio = 0.1,
    allowedLineEndSpace = 0.5,
    fillType = "fill",
    sampler = "uTextTexture",
    texturesOptions = {},
    resolution = 1,
    onBeforeWordMeasuring = () => {},
    onAfterWordMeasuring = () => {},
    onBeforeWordWriting = () => {},
    onAfterWordWriting = () => {},
  } = {}) {
    const acceptedTypes = ["Plane", "PingPongPlane", "ShaderPass"];

    if (!plane || !plane.type || !acceptedTypes.find((type) => type === plane.type)) {
      console.error("TextTexture: can't be created without a plane");
      return;
    }

    if (!plane.gl) {
      console.error("TextTexture: can't be created because the WebGL context is missing");
      return;
    }

    this.plane = plane;
    this.textElement = textElement || this.plane.htmlElement;
    this.resolution = resolution;
    this.skipFontLoading = skipFontLoading;
    this.adjustAscenderRatio = adjustAscenderRatio;
    this.allowedLineEndSpace = allowedLineEndSpace;

    this.onBeforeWordMeasuring = onBeforeWordMeasuring;
    this.onAfterWordMeasuring = onAfterWordMeasuring;
    this.onBeforeWordWriting = onBeforeWordWriting;
    this.onAfterWordWriting = onAfterWordWriting;

    /** @type {LayoutSeg[]} */
    this.segments = buildTextSegments(this.textElement);

    this.content = {
      verticalAlign: verticalAlign,
      text: this.textElement.textContent.replace(/\r\n|\r/g, '\n'),
    };

    this.canvas = document.createElement("canvas");
    this.context = this.canvas.getContext("2d");

    this.content.style = window.getComputedStyle(this.textElement);
    this.content.style.fillType = fillType !== "fill" && fillType !== "stroke" ? "fill" : fillType;

    this.setCanvasSize();
    this.setWords();
    
    texturesOptions = Object.assign(texturesOptions, { sampler: sampler });
    
    this.plane.loadCanvas(this.canvas, texturesOptions, (texture) => {
      this.texture = texture;
      this.texture.shouldUpdate = false;
      
      this.loadFont();
    });

    this.plane._onAfterResizeCallback = () => {
      this._onAfterResizeCallback && this._onAfterResizeCallback();
      this.resize();
    };

    this.plane.onAfterResize = (callback) => {
      if (callback) {
        this._onAfterResizeCallback = callback;
      }
      return this.plane;
    };
  }

  setCanvasSize() {
    this.pixelRatio = this.plane.renderer.pixelRatio;

    // curtains' getBoundingRect() returns values in PHYSICAL pixels (already DPR-scaled).
    // We need the plane size in CSS pixels for consistent 2D canvas coordinate math.
    const planeBBox = this.plane.getBoundingRect();
    const planeCssWidth  = planeBBox.width  / this.pixelRatio;
    const planeCssHeight = planeBBox.height / this.pixelRatio;
    const planeCssTop    = planeBBox.top    / this.pixelRatio;
    const planeCssLeft   = planeBBox.left   / this.pixelRatio;

    // The 2D canvas is drawn at `resolution` times CSS pixels for sharpness.
    this.canvas.width  = planeCssWidth  * this.resolution;
    this.canvas.height = planeCssHeight * this.resolution;

    // Scale so that all 2D drawing coordinates are in CSS pixels.
    this.context.setTransform(1, 0, 0, 1, 0, 0); // reset any previous scale
    this.context.scale(this.resolution, this.resolution);

    // getBoundingClientRect() is always in CSS pixels — no adjustment needed.
    this.content.boundingRect = this.textElement.getBoundingClientRect();

    this.content.innerBoundingRect = {
      width:  this.content.boundingRect.width  - parseFloat(this.content.style.paddingLeft) - parseFloat(this.content.style.paddingRight),
      height: this.content.boundingRect.height - parseFloat(this.content.style.paddingTop)  - parseFloat(this.content.style.paddingBottom),
      top:    parseFloat(this.content.style.paddingTop)  + (this.content.boundingRect.top  - planeCssTop),
      left:   parseFloat(this.content.style.paddingLeft) + (this.content.boundingRect.left - planeCssLeft),
    };

    this.content.innerBoundingRect.right  = this.content.innerBoundingRect.left + this.content.innerBoundingRect.width;
    this.content.innerBoundingRect.bottom = this.content.innerBoundingRect.top  + this.content.innerBoundingRect.height;
  }

  /**
   * Split on ASCII space (0x20) only; preserve NBSP and other chars in `word`.
   * Leading runs of spaces become NBSP prefix so canvas measures them; runs after
   * a word set `spaceAfterCount` for extra gap width.
   *
   * @param {string} chunk
   * @param {HTMLElement} styleEl
   */
  pushWordsFromSpaceChunk(chunk, styleEl) {
    const s = chunk.replace(/\t/g, ' ');
    if (!s.length) return;

    let i = 0;
    let leadingSpaceCount = 0;
    while (i < s.length && s[i] === ' ') {
      leadingSpaceCount++;
      i++;
    }

    let buf = '';

    const flush = (trailingSpaceCount) => {
      if (!buf.length && !leadingSpaceCount) return;
      const prefix = leadingSpaceCount ? '\u00A0'.repeat(leadingSpaceCount) : '';
      this.content.words.push({
        word: prefix + buf,
        spaceAfterCount: trailingSpaceCount,
        styleEl,
      });
      leadingSpaceCount = 0;
      buf = '';
    };

    while (i < s.length) {
      const c = s[i];
      if (c !== ' ') {
        buf += c;
        i++;
        continue;
      }
      let sp = 0;
      while (i < s.length && s[i] === ' ') {
        sp++;
        i++;
      }
      flush(sp);
    }
    flush(0);
  }

  /**
   * @param {string} str
   * @param {HTMLElement} styleEl
   */
  addWordsFromString(str, styleEl) {
    const s = str.replace(/\t/g, ' ');
    if (!s.length) return;

    const separatedWords = s.split('-');
    /** @type {string[]} */
    const chunks = [];

    const wordsLength = separatedWords.length;
    separatedWords.forEach((word, index) => {
      if (index < wordsLength - 1) {
        chunks.push(word);
        chunks.push('-');
      } else {
        chunks.push(word);
      }
    });

    chunks.forEach((piece) => {
      if (piece === '-') {
        this.content.words.push({ word: '-', spaceAfterCount: 0, styleEl });
      } else {
        this.pushWordsFromSpaceChunk(piece, styleEl);
      }
    });
  }

  setWords() {
    this.content.words = [];
    for (const seg of this.segments) {
      if (seg.kind === 'break') {
        this.content.words.push({ hardBreak: true });
      } else {
        this.addWordsFromString(seg.text, seg.el);
      }
    }
  }

  loadFont() {
    if (!this.skipFontLoading && document.fonts) {
      /** @type {Set<HTMLElement>} */
      const fontEls = new Set([this.textElement]);
      for (const seg of this.segments) {
        if (seg.kind === 'text') fontEls.add(seg.el);
      }
      const fontSources = [...fontEls];

      Promise.all(
        fontSources.map((el) => {
          const s = window.getComputedStyle(el);
          return document.fonts.load(
            `${s.fontStyle} ${s.fontWeight} ${s.fontSize} ${s.fontFamily}`,
          );
        }),
      ).then(() => {
        this.content.fontLoaded = true;
        if (this.texture) {
          this.plane.resize();
          this.writeTexture(true); // force re-measure
        }
      });
    } else {
      this.content.fontLoaded = true;
      if (this.texture && !this.content.firstWrite) {
          this.writeTexture();
      }
    }
  }

  /**
   * @param {HTMLElement} el
   */
  applyCanvasFontFromElement(el) {
    const s = window.getComputedStyle(el);
    this.context.font = `${s.fontStyle} ${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
  }

  writeTexture(measureText = true) {
    // Clear in CSS-pixel space (context is scaled by this.resolution)
    this.context.clearRect(0, 0, this.canvas.width / this.resolution, this.canvas.height / this.resolution);

    this.context.lineHeight = this.content.style.lineHeight;

    const startingPos = this.content.innerBoundingRect.left;
    const lineHeight = parseFloat(this.content.style.lineHeight) || parseFloat(this.content.style.fontSize) * 1.2;
    const fontSize = parseFloat(this.content.style.fontSize);

    this.context.textBaseline = "top";
    const lineHeightRatio = lineHeight / fontSize;
    let adjustTopPos = fontSize * this.adjustAscenderRatio + (lineHeightRatio - 1) * fontSize / 2;

    const position = {
      x: startingPos,
      y: this.content.innerBoundingRect.top + adjustTopPos,
    };

    if (measureText || !this.lines) {
      this.lines = [];
      this.content.words.forEach((w, i) => {
        if (w.hardBreak) {
          if (position.x !== startingPos) {
            position.x = startingPos;
            position.y += lineHeight;
          } else {
            position.y += lineHeight;
          }
          return;
        }

        const styleEl = w.styleEl || this.textElement;
        this.applyCanvasFontFromElement(styleEl);
        const wordStyle = window.getComputedStyle(styleEl);

        let displayWord = w.word;
        if (wordStyle.textTransform === 'uppercase') {
          displayWord = w.word.toUpperCase();
        } else if (wordStyle.textTransform === 'lowercase') {
          displayWord = w.word.toLowerCase();
        }

        const wordWidth = this.context.measureText(displayWord).width;
        const spaceWidth = this.context.measureText(' ').width;

        if (i > 0 && position.x + wordWidth > this.content.innerBoundingRect.right) {
          position.x = startingPos;
          position.y += lineHeight;
        }

        if (position.x === startingPos) {
          this.lines.push([]);
        }

        const line = this.lines[this.lines.length - 1];
        line.push({
          word: displayWord,
          wordWidth: wordWidth,
          position: { x: position.x, y: position.y },
          spaceAfterCount: w.spaceAfterCount || 0,
          styleEl,
        });

        position.x += wordWidth;
        const extra = w.spaceAfterCount || 0;
        if (extra > 0) {
          position.x += spaceWidth * extra;
        }
      });
    }

    const offset = { x: 0, y: 0 };
    if (!this.lines.length || !this.lines[0].length) {
      if (measureText) {
        this.texture.resize();
      }
      this.texture.needUpdate();
      this.content.firstWrite = true;
      return;
    }

    const firstY = this.lines[0][0].position.y;
    const lastLine = this.lines[this.lines.length - 1];
    const lastWord = lastLine[lastLine.length - 1];
    const totalHeight = lastWord.position.y + lineHeight - firstY;

    if (this.content.verticalAlign === "center") {
      offset.y = (this.content.innerBoundingRect.height - totalHeight) * 0.5;
    } else if (this.content.verticalAlign === "bottom") {
      offset.y = this.content.innerBoundingRect.height - totalHeight + adjustTopPos;
    }

    this.lines.forEach((line) => {
      const ta = this.content.style.textAlign;
      if (ta !== 'right' && ta !== 'end' && ta !== 'center') {
        offset.x = 0;
      }

      const firstW = line[0];
      const lastW = line[line.length - 1];
      this.applyCanvasFontFromElement(lastW.styleEl || this.textElement);
      const alignSpaceW = this.context.measureText(' ').width;
      const lineEndX =
        lastW.position.x + lastW.wordWidth + alignSpaceW * (lastW.spaceAfterCount || 0);
      const lineWidth = lineEndX - firstW.position.x;

      line.forEach((word) => {
        const styleEl = word.styleEl || this.textElement;
        this.applyCanvasFontFromElement(styleEl);
        const st = window.getComputedStyle(styleEl);
        this.context.fillStyle = st.color;
        this.context.strokeStyle = st.color;

        if (this.content.style.textAlign === "right" || this.content.style.textAlign === "end") {
          offset.x = this.content.innerBoundingRect.right - (line[0].position.x + lineWidth);
        } else if (this.content.style.textAlign === "center") {
          offset.x = (this.content.innerBoundingRect.right - (line[0].position.x + lineWidth)) / 2 - this.content.innerBoundingRect.left;
        }

        if (this.content.style.fillType === "stroke") {
          this.context.miterLimit = 2;
          this.context.strokeText(word.word, word.position.x + offset.x, word.position.y + offset.y);
        } else {
          this.context.fillText(word.word, word.position.x + offset.x, word.position.y + offset.y);
        }
      });
    });

    if (measureText) {
      this.texture.resize();
    }
    this.texture.needUpdate();
    this.content.firstWrite = true;
  }

  resize() {
    if (this.texture) {
      this.setCanvasSize();
      this.writeTexture();
    }
  }

  dispose() {
    this.content = {};
    this.textElement = null;
    this.plane = null;
  }
}
