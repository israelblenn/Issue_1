import './style.css';
import {
  initFluidLayer,
  resizeFluidLayer,
  syncImagePlanesToDom,
  syncPlanePositionsFromDom,
  getWebglLayer,
  setRipplePassHoverHighlight,
  setRaindropSoundHandler,
} from './main.js';
import { nodeImageFilenames, nodeTextFilenames } from 'virtual:nodes-index';

/** @type {string[]} */
const imageUrls = nodeImageFilenames.map((filename) => `/nodes/${filename}`);
const textUrls = nodeTextFilenames.map((filename) => `/nodes/${filename}`);

const MAX_DISPLAY_DIM = 140;
const TEXT_NODE_WIDTH = 240;
const BOUNDARY_MARGIN = 24;
/** Screen-space inset for the pinned credit line (matches prior absolute offset). */
const CREDIT_MARGIN = 12;
const IMAGE_GAP = 32;
/** Base px scale for the idle drift; per-node ax/ay (0.62–1) softens it slightly. */
const BREATH_AMPLITUDE = 3.65;
const PLACEMENT_GAP = IMAGE_GAP + BREATH_AMPLITUDE * 2;
const STATIC_CLUMP_SCALE = 1.05;
const CANDIDATE_COUNT = 420;
const GRID_FALLBACK_STEP = 8;
const AUDIO_FADE_DISTANCE = 260;
const MAX_NODE_VOLUME = 0.9;
const MIN_AUDIBLE_VOLUME = 0.01;
// Peak wet send into the convolver (clamp); actual wet is also bounded by the
// same proximity² envelope as dry so overall level still decays with distance.
const MAX_NODE_REVERB = 0.72;
// Below this proximity the wet send is forced to 0 to avoid noise when silent.
const MIN_WET_PROXIMITY = 0.028;
// (1 - proximity) ** exp — higher = subtler tilt toward room at mid distances.
const REVERB_WET_EXP = 0.82;
// Max fraction of the dry signal that can be "replaced" by wet character at a
// given distance (0..1). Scales with (1 - proximity) ** REVERB_WET_EXP.
const REVERB_SEND_MAX = 0.48;
// Extra drive into the convolver so the tilt remains audible vs dry (then clamp).
const REVERB_WET_GAIN = 2.35;
const REVERB_DURATION_SEC = 2.65;
const REVERB_DECAY = 2.35;
// Convolver output is quiet; gentle makeup keeps the tail audible without dominating.
const REVERB_BUS_MAKEUP = 2.15;
// Level baked into the synthetic IR (1 = original IR energy).
const REVERB_IR_LEVEL = 1.35;
const VOLUME_LERP = 0.18;
/** Horizontal px offset at which node audio reaches full L/R pan (StereoPanner ±1). */
const AUDIO_PAN_PIXEL_SCALE = 340;
const PAN_LERP = 0.2;
/** Per-frame lerp for ripple-pass hover saturation (0..1). Lower = slower fade. */
const HOVER_HIGHLIGHT_LERP = 0.11;

/**
 * @typedef {{ ax: number, ay: number, fx: number, fy: number, px: number, py: number }} BreathSeed
 * @typedef {{
 *   element: HTMLAudioElement,
 *   enabled: boolean,
 *   playing: boolean,
 *   nextPlayAttempt: number,
 *   sourceNode?: MediaElementAudioSourceNode,
 *   dryGain?: GainNode,
 *   wetGain?: GainNode,
 *   dryPanner?: StereoPannerNode,
 *   wetPanner?: StereoPannerNode,
 * }} NodeAudio
 * @typedef {{
 *   el: HTMLDivElement,
 *   img?: HTMLImageElement,
 *   src: string,
 *   x: number,
 *   y: number,
 *   renderX: number,
 *   renderY: number,
 *   w: number,
 *   h: number,
 *   r: number,
 *   breath: BreathSeed,
 *   audio?: NodeAudio,
 *   plane?: any,
 * }} SimNode
 */

/**
 * @param {number} v
 * @param {number} lo
 * @param {number} hi
 */
function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Signed edge-to-edge distance between two axis-aligned image rectangles.
 * Positive values are real empty space; negative values mean overlap.
 *
 * @param {number} ax
 * @param {number} ay
 * @param {SimNode} a
 * @param {number} bx
 * @param {number} by
 * @param {SimNode} b
 */
function rectEdgeDistance(ax, ay, a, bx, by, b) {
  const gapX = Math.abs(ax - bx) - (a.w + b.w) * 0.5;
  const gapY = Math.abs(ay - by) - (a.h + b.h) * 0.5;

  if (gapX > 0 && gapY > 0) return Math.hypot(gapX, gapY);
  if (gapX > 0) return gapX;
  if (gapY > 0) return gapY;
  return Math.max(gapX, gapY);
}

/**
 * @param {number} x
 * @param {number} y
 * @param {SimNode} node
 * @param {{ node: SimNode, x: number, y: number }[]} placed
 */
function minRectGapToPlaced(x, y, node, placed) {
  let minGap = Infinity;
  for (const other of placed) {
    const gap = rectEdgeDistance(x, y, node, other.x, other.y, other.node);
    if (gap < minGap) minGap = gap;
  }
  return minGap;
}

function makeBreathSeed() {
  const TAU = Math.PI * 2;
  return {
    ax: 0.62 + Math.random() * 0.38,
    ay: 0.62 + Math.random() * 0.38,
    // ~17–26 s per cycle — slow enough that larger amplitude stays gentle.
    fx: 0.038 + Math.random() * 0.028,
    fy: 0.038 + Math.random() * 0.028,
    px: Math.random() * TAU,
    py: Math.random() * TAU,
  };
}

/**
 * @param {string} src
 */
function nodeNameFromSrc(src) {
  const filename = src.split('/').pop() || '';
  return filename.replace(/\.[^.]+$/, '');
}

/**
 * @param {string} src
 */
async function findNodeAudioUrl(src) {
  const audioUrl = `/nodes/${nodeNameFromSrc(src)}.mp3`;
  try {
    const response = await fetch(audioUrl, { method: 'HEAD' });
    if (response.ok) return audioUrl;
  } catch (error) {
    console.warn(`Unable to check audio file ${audioUrl}`, error);
  }
  return null;
}

/** @type {AudioContext | null} */
let audioCtx = null;
/** @type {ConvolverNode | null} */
let reverbConvolver = null;
/** @type {GainNode | null} */
let reverbOutGain = null;

/**
 * Build a synthetic exponentially-decaying noise impulse response. Mirrors a
 * generic room reverb tail and avoids loading an external IR asset.
 *
 * @param {BaseAudioContext} ctx
 * @param {number} durationSec
 * @param {number} decay
 */
function generateImpulseResponse(ctx, durationSec, decay) {
  const sampleRate = ctx.sampleRate;
  const length = Math.max(1, Math.floor(sampleRate * durationSec));
  const buffer = ctx.createBuffer(2, length, sampleRate);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      const envelope = Math.pow(1 - i / length, decay);
      data[i] = (Math.random() * 2 - 1) * envelope * REVERB_IR_LEVEL;
    }
  }
  return buffer;
}

/**
 * Short sine chirp + filtered noise burst through dry + shared convolver (room tail).
 * No-op until the shared AudioContext exists (first pointerdown with Web Audio available).
 *
 * @param {number} strength shader uRaindropStrength (typically 32..60)
 * @param {number} [dropNormX=0.5] horizontal raindrop position 0=left … 1=right of the ripple/viewport
 */
function playRaindropDripSound(strength, dropNormX = 0.5) {
  if (!audioCtx || !reverbConvolver) return;
  if (audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  const ctx = audioCtx;

  const t = ctx.currentTime;
  const norm = clamp((strength - 26) / 40, 0.12, 1);
  // Viewport-centered pan: left side → negative pan (left speaker), right → positive.
  const pan = clamp((dropNormX - 0.5) * 2, -1, 1);

  const osc = ctx.createOscillator();
  osc.type = 'sine';
  const f0 = 1750 + Math.random() * 1200;
  const f1 = Math.max(120, 200 + Math.random() * 160);
  osc.frequency.setValueAtTime(f0, t);
  osc.frequency.exponentialRampToValueAtTime(f1, t + 1); // pitch

  const env = ctx.createGain();
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(2 * norm, t + 0.002); // volume
  env.gain.exponentialRampToValueAtTime(0.0005, t + 0.088);
  osc.connect(env);

  const drySend = ctx.createGain();
  const wetSend = ctx.createGain();
  drySend.gain.value = 0.002 * Math.pow(norm, 0.9); //reverb
  wetSend.gain.value = 0.1 * (0.5 + 0.5 * norm);
  const oscDryPan = ctx.createStereoPanner();
  const oscWetPan = ctx.createStereoPanner();
  oscDryPan.pan.value = pan;
  oscWetPan.pan.value = pan;
  env.connect(drySend);
  env.connect(wetSend);
  drySend.connect(oscDryPan);
  oscDryPan.connect(ctx.destination);
  wetSend.connect(oscWetPan);
  oscWetPan.connect(reverbConvolver);

  osc.start(t);
  osc.stop(t + 0.1);

  const noiseDur = 0.016;
  const noiseLen = Math.max(1, Math.floor(ctx.sampleRate * noiseDur));
  const noiseBuf = ctx.createBuffer(1, noiseLen, ctx.sampleRate);
  const nd = noiseBuf.getChannelData(0);
  for (let i = 0; i < noiseLen; i++) {
    nd[i] = (Math.random() * 2 - 1) * (1 - i / noiseLen);
  }
  const ns = ctx.createBufferSource();
  ns.buffer = noiseBuf;
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 2600;
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(0, t);
  ng.gain.linearRampToValueAtTime(0.038 * norm, t + 0.0008);
  ng.gain.exponentialRampToValueAtTime(0.0004, t + 0.018);
  ns.connect(hp);
  hp.connect(ng);

  const nDry = ctx.createGain();
  const nWet = ctx.createGain();
  nDry.gain.value = 0.024 * norm;
  nWet.gain.value = 0.055 * norm;
  const noiseDryPan = ctx.createStereoPanner();
  const noiseWetPan = ctx.createStereoPanner();
  noiseDryPan.pan.value = pan;
  noiseWetPan.pan.value = pan;
  ng.connect(nDry);
  ng.connect(nWet);
  nDry.connect(noiseDryPan);
  noiseDryPan.connect(ctx.destination);
  nWet.connect(noiseWetPan);
  noiseWetPan.connect(reverbConvolver);

  ns.start(t);
  ns.stop(t + noiseDur + 0.008);
}

/**
 * Lazily build the shared AudioContext + reverb bus. Must be called from a
 * user-gesture handler the first time so the context starts in `running`.
 */
function ensureAudioContext() {
  if (audioCtx) {
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return audioCtx;
  }
  const Ctx = window.AudioContext || /** @type {any} */ (window).webkitAudioContext;
  if (!Ctx) return null;
  try {
    audioCtx = new Ctx();
    reverbConvolver = audioCtx.createConvolver();
    reverbConvolver.buffer = generateImpulseResponse(audioCtx, REVERB_DURATION_SEC, REVERB_DECAY);
    reverbOutGain = audioCtx.createGain();
    reverbOutGain.gain.value = REVERB_BUS_MAKEUP;
    reverbConvolver.connect(reverbOutGain);
    reverbOutGain.connect(audioCtx.destination);
  } catch (error) {
    console.warn('Web Audio unavailable; falling back to plain volume', error);
    audioCtx = null;
    reverbConvolver = null;
    reverbOutGain = null;
  }
  return audioCtx;
}

/**
 * Wire a node's audio element through Web Audio (dry + wet sends) the first
 * time the AudioContext is available. Safe to call every frame.
 *
 * @param {NodeAudio} audio
 */
function connectNodeAudio(audio) {
  if (!audioCtx || !reverbConvolver || audio.dryGain) return;
  try {
    if (!audio.sourceNode) {
      audio.sourceNode = audioCtx.createMediaElementSource(audio.element);
    }
    const dryGain = audioCtx.createGain();
    const wetGain = audioCtx.createGain();
    const dryPanner = audioCtx.createStereoPanner();
    const wetPanner = audioCtx.createStereoPanner();
    dryGain.gain.value = 0;
    wetGain.gain.value = 0;
    dryPanner.pan.value = 0;
    wetPanner.pan.value = 0;
    audio.sourceNode.connect(dryGain);
    dryGain.connect(dryPanner);
    dryPanner.connect(audioCtx.destination);
    audio.sourceNode.connect(wetGain);
    wetGain.connect(wetPanner);
    wetPanner.connect(reverbConvolver);
    audio.dryGain = dryGain;
    audio.wetGain = wetGain;
    audio.dryPanner = dryPanner;
    audio.wetPanner = wetPanner;
    // Element.volume is no longer the master gain once we're routing through
    // Web Audio—the dry/wet gains take over.
    audio.element.volume = 1;
  } catch (error) {
    console.warn('Failed to attach node audio to Web Audio graph', error);
  }
}

/**
 * @param {SimNode[]} nodes
 */
async function attachNodeAudio(nodes) {
  await Promise.all(
    nodes.map(async (node) => {
      const audioUrl = await findNodeAudioUrl(node.src);
      if (!audioUrl) return;

      const element = new Audio(audioUrl);
      element.loop = true;
      element.preload = 'auto';
      element.volume = 0;

      node.audio = {
        element,
        enabled: true,
        playing: false,
        nextPlayAttempt: 0,
      };

      element.addEventListener('error', () => {
        if (node.audio) {
          node.audio.enabled = false;
          node.audio.playing = false;
        }
      });
    }),
  );
}

/**
 * @param {SimNode} node
 * @param {number} x
 * @param {number} y
 */
function distanceFromNodeEdge(node, x, y) {
  const dx = Math.max(Math.abs(x - node.renderX) - node.w * 0.5, 0);
  const dy = Math.max(Math.abs(y - node.renderY) - node.h * 0.5, 0);
  return Math.hypot(dx, dy);
}

/**
 * Find the node directly under the cursor (cursor inside its bounding rect),
 * or null when the cursor is outside every node.
 *
 * @param {SimNode[]} nodes
 * @param {{ x: number, y: number, active: boolean }} cursor
 */
function findHoveredNode(nodes, cursor) {
  if (!cursor.active) return null;
  for (const node of nodes) {
    if (distanceFromNodeEdge(node, cursor.x, cursor.y) === 0) return node;
  }
  return null;
}

/**
 * Pair each SimNode with its corresponding WebGL plane (by DOM element).
 * Safe to call every frame: it only attaches planes once they exist.
 *
 * @param {SimNode[]} nodes — graph nodes and optional pinned UI (e.g. credit) that share the same plane linking rules.
 */
function tryLinkPlanesToNodes(nodes) {
  const layer = getWebglLayer();
  if (!layer) return;
  const allPlanes = [...(layer.imagePlanes || []), ...(layer.textPlanes || [])];
  if (allPlanes.length === 0) return;
  for (const node of nodes) {
    if (node.plane) continue;
    const plane = allPlanes.find((p) => p.htmlElement === node.el);
    if (plane) node.plane = plane;
  }
}

/**
 * @param {SimNode[]} nodes
 * @param {{ x: number, y: number, active: boolean }} cursor
 * @param {SimNode | null} hovered
 */
function updateNodeAudio(nodes, cursor, hovered) {
  const now = performance.now();

  for (const node of nodes) {
    const audio = node.audio;
    if (!audio?.enabled) continue;

    // Compute proximity once; we need it for both dry and wet targets.
    const edgeDistance = cursor.active ? distanceFromNodeEdge(node, cursor.x, cursor.y) : Infinity;
    const proximity = 1 - clamp(edgeDistance / AUDIO_FADE_DISTANCE, 0, 1);

    let targetDry;
    let targetWet;
    if (hovered) {
      if (node === hovered) {
        // Cursor sitting on this node: full clean signal, no reverb.
        targetDry = MAX_NODE_VOLUME;
        targetWet = 0;
      } else {
        // Cursor on a different node: silence everything else (dry and wet).
        targetDry = 0;
        targetWet = 0;
      }
    } else {
      // Same loudness envelope as before Web Audio: proximity² × max volume.
      // Reverb send is carved out of that budget so far = quieter overall, not
      // a loud wet tail fighting a quiet dry signal.
      const base = proximity * proximity * MAX_NODE_VOLUME;
      if (proximity <= MIN_WET_PROXIMITY) {
        targetDry = base;
        targetWet = 0;
      } else {
        const room = Math.pow(1 - proximity, REVERB_WET_EXP);
        const tilt = REVERB_SEND_MAX * room;
        targetDry = base * (1 - tilt);
        targetWet = Math.min(MAX_NODE_REVERB, base * tilt * REVERB_WET_GAIN);
      }
    }

    // Pick up dry/wet routing the first frame after the AudioContext exists.
    connectNodeAudio(audio);

    let effectiveLevel;
    if (audio.dryGain && audio.wetGain && audio.dryPanner && audio.wetPanner) {
      const dry = audio.dryGain.gain.value + (targetDry - audio.dryGain.gain.value) * VOLUME_LERP;
      const wet = audio.wetGain.gain.value + (targetWet - audio.wetGain.gain.value) * VOLUME_LERP;
      audio.dryGain.gain.value = clamp(dry, 0, MAX_NODE_VOLUME);
      audio.wetGain.gain.value = clamp(wet, 0, MAX_NODE_REVERB);

      // Pan so the sound appears on the side of the node relative to the cursor
      // (cursor to the right → negative pan → more in the left speaker).
      let targetPan = 0;
      if (cursor.active && !(hovered && node !== hovered)) {
        targetPan = clamp((node.renderX - cursor.x) / AUDIO_PAN_PIXEL_SCALE, -1, 1);
      }
      const pan =
        audio.dryPanner.pan.value + (targetPan - audio.dryPanner.pan.value) * PAN_LERP;
      audio.dryPanner.pan.value = clamp(pan, -1, 1);
      audio.wetPanner.pan.value = audio.dryPanner.pan.value;
      // Pause when the shared distance envelope is effectively silent (not max(d,w),
      // which kept audio "on" from a loud wet path alone).
      const env =
        hovered && node === hovered
          ? MAX_NODE_VOLUME
          : hovered
            ? 0
            : proximity * proximity * MAX_NODE_VOLUME;
      effectiveLevel = env;
    } else {
      // Fallback: no AudioContext yet (pre user-gesture). Plain element.volume,
      // no reverb path available—the wet target is just dropped.
      const next = audio.element.volume + (targetDry - audio.element.volume) * VOLUME_LERP;
      audio.element.volume = clamp(next, 0, MAX_NODE_VOLUME);
      effectiveLevel = audio.element.volume;
    }

    if (effectiveLevel > MIN_AUDIBLE_VOLUME) {
      if (audio.element.paused && now >= audio.nextPlayAttempt) {
        audio.nextPlayAttempt = now + 1000;
        audio.element
          .play()
          .then(() => {
            audio.playing = true;
          })
          .catch(() => {
            audio.playing = false;
          });
      }
    } else if (!audio.element.paused) {
      audio.element.pause();
      audio.playing = false;
    }
  }
}

/**
 * @param {HTMLElement} container
 * @param {string} src
 * @returns {SimNode}
 */
function createNodeElement(container, src) {
  const el = document.createElement('div');
  el.className = 'graph-node image-plane';
  const img = document.createElement('img');
  img.src = src;
  img.alt = '';
  img.decoding = 'async';
  img.draggable = false;
  img.setAttribute('data-sampler', 'uTexture');
  el.appendChild(img);
  container.appendChild(el);

  return {
    el,
    img,
    src,
    x: 0,
    y: 0,
    renderX: 0,
    renderY: 0,
    w: MAX_DISPLAY_DIM,
    h: MAX_DISPLAY_DIM,
    r: MAX_DISPLAY_DIM * 0.5,
    breath: makeBreathSeed(),
  };
}

/**
 * @param {HTMLElement} container
 * @param {string} text
 * @param {string} src
 * @returns {SimNode}
 */
function createTextNodeElement(container, text, src) {
  const el = document.createElement('div');
  el.className = 'graph-node text-plane';
  el.textContent = text;
  el.setAttribute('data-sampler', 'uTexture');
  el.setAttribute('aria-label', src.split('/').pop() || 'Text node');
  el.style.width = `${TEXT_NODE_WIDTH}px`;
  container.appendChild(el);

  const rect = el.getBoundingClientRect();
  const w = rect.width || TEXT_NODE_WIDTH;
  const h = rect.height || TEXT_NODE_WIDTH * 0.6;

  return {
    el,
    src,
    x: 0,
    y: 0,
    renderX: 0,
    renderY: 0,
    w,
    h,
    r: Math.hypot(w, h) * 0.5,
    breath: makeBreathSeed(),
  };
}

/**
 * Seed positions with a blue-noise ellipse distribution: random and clumped,
 * with the ellipse stretched to roughly match the viewport aspect ratio. Each
 * node picks the best of many random candidates, favoring even spacing without
 * creating visible rings/spokes.
 *
 * @param {SimNode[]} nodes
 * @param {number} cx
 * @param {number} cy
 * @param {number} w
 * @param {number} h
 */
function placeInitialCluster(nodes, cx, cy, w, h) {
  const N = nodes.length;
  if (N === 0) return;

  let maxR = 0;
  let maxDim = 0;
  for (const n of nodes) if (n.r > maxR) maxR = n.r;
  for (const n of nodes) maxDim = Math.max(maxDim, n.w, n.h);

  const aspect = Math.max(0.1, w / Math.max(1, h));
  // Keep roughly the same area as the old disk while stretching the shape to
  // the viewport ratio: rx / ry ~= viewport width / viewport height.
  const naturalAreaRadius = Math.sqrt(N) * (maxDim + PLACEMENT_GAP) * STATIC_CLUMP_SCALE * 0.5;
  const naturalRx = naturalAreaRadius * Math.sqrt(aspect);
  const naturalRy = naturalAreaRadius / Math.sqrt(aspect);
  const maxRx = w * 0.5 - BOUNDARY_MARGIN - maxDim * 0.5;
  const maxRy = h * 0.5 - BOUNDARY_MARGIN - maxDim * 0.5;
  const baseRx = Math.max(maxDim * 0.5, Math.min(maxRx, naturalRx));
  const baseRy = Math.max(maxDim * 0.5, Math.min(maxRy, naturalRy));

  /** @type {{ node: SimNode, x: number, y: number }[]} */
  const placed = [];
  const sorted = [...nodes].sort((a, b) => b.r - a.r);

  for (const node of sorted) {
    const nodeAvailRx = Math.max(
      0,
      Math.min(cx - (BOUNDARY_MARGIN + node.w * 0.5), w - BOUNDARY_MARGIN - node.w * 0.5 - cx),
    );
    const nodeAvailRy = Math.max(
      0,
      Math.min(cy - (BOUNDARY_MARGIN + node.h * 0.5), h - BOUNDARY_MARGIN - node.h * 0.5 - cy),
    );
    const initialRx = Math.min(baseRx, nodeAvailRx);
    const initialRy = Math.min(baseRy, nodeAvailRy);

    let bestX = cx;
    let bestY = cy;
    let bestScore = -Infinity;
    let bestValidX = cx;
    let bestValidY = cy;
    let bestValidScore = -Infinity;

    for (let pass = 0; pass < 4; pass++) {
      // Start with a compact centered ellipse. If that cannot satisfy the 32px
      // gap, gradually expand toward the full available viewport.
      const t = pass / 3;
      const searchRx = initialRx + (nodeAvailRx - initialRx) * t;
      const searchRy = initialRy + (nodeAvailRy - initialRy) * t;

      for (let c = 0; c < CANDIDATE_COUNT; c++) {
        const angle = Math.random() * Math.PI * 2;
        // sqrt random radius gives uniform area distribution inside the ellipse.
        const radius = Math.sqrt(Math.random());
        const nx = Math.cos(angle) * radius;
        const ny = Math.sin(angle) * radius;
        const x = cx + nx * searchRx;
        const y = cy + ny * searchRy;

        const minGap = minRectGapToPlaced(x, y, node, placed);

        // Prefer valid clearance candidates near the center. If the viewport
        // is too small to satisfy the gap for every image, bestScore remains as a
        // graceful fallback, but normal viewports use bestValidScore.
        const centerBias = nx * nx + ny * ny;
        const score = (placed.length === 0 ? PLACEMENT_GAP : minGap) - centerBias * maxDim * 0.55;
        if (score > bestScore) {
          bestScore = score;
          bestX = x;
          bestY = y;
        }
        if ((placed.length === 0 || minGap >= PLACEMENT_GAP) && score > bestValidScore) {
          bestValidScore = score;
          bestValidX = x;
          bestValidY = y;
        }
      }

      if (bestValidScore > -Infinity) break;
    }

    if (bestValidScore === -Infinity) {
      const left = BOUNDARY_MARGIN + node.w * 0.5;
      const right = w - BOUNDARY_MARGIN - node.w * 0.5;
      const top = BOUNDARY_MARGIN + node.h * 0.5;
      const bottom = h - BOUNDARY_MARGIN - node.h * 0.5;

      for (let y = top; y <= bottom; y += GRID_FALLBACK_STEP) {
        for (let x = left; x <= right; x += GRID_FALLBACK_STEP) {
          const minGap = minRectGapToPlaced(x, y, node, placed);
          if (placed.length > 0 && minGap < PLACEMENT_GAP) continue;

          const dx = x - cx;
          const dy = y - cy;
          const distFromCenter = Math.hypot(dx, dy);
          const score = PLACEMENT_GAP - distFromCenter * 0.01 + Math.random() * 0.001;
          if (score > bestValidScore) {
            bestValidScore = score;
            bestValidX = x;
            bestValidY = y;
          }
        }
      }
    }

    const x = bestValidScore > -Infinity ? bestValidX : bestX;
    const y = bestValidScore > -Infinity ? bestValidY : bestY;
    node.x = clamp(x, BOUNDARY_MARGIN + node.w * 0.5, w - BOUNDARY_MARGIN - node.w * 0.5);
    node.y = clamp(y, BOUNDARY_MARGIN + node.h * 0.5, h - BOUNDARY_MARGIN - node.h * 0.5);
    placed.push({ node, x: node.x, y: node.y });
  }
}

/**
 * @param {SimNode} node
 */
function applyLoadedImageMetrics(node) {
  const nw = node.img.naturalWidth || 1;
  const nh = node.img.naturalHeight || 1;
  const scale = MAX_DISPLAY_DIM / Math.max(nw, nh);
  const dw = nw * scale;
  const dh = nh * scale;
  node.img.style.width = `${dw}px`;
  node.img.style.height = `${dh}px`;
  node.el.style.width = `${dw}px`;
  node.el.style.height = `${dh}px`;
  node.w = dw;
  node.h = dh;
  node.r = Math.hypot(dw, dh) * 0.5;
}

let planeSyncFlushRaf = 0;
function scheduleImagePlaneSync() {
  if (planeSyncFlushRaf) return;
  const run = (attempt) => {
    planeSyncFlushRaf = requestAnimationFrame(() => {
      planeSyncFlushRaf = 0;
      const layer = getWebglLayer();
      const hasPlanes =
        (layer?.imagePlanes?.length ?? 0) > 0 || (layer?.textPlanes?.length ?? 0) > 0;
      if (!layer || (!hasPlanes && attempt < 120)) {
        run(attempt + 1);
        return;
      }
      if (!hasPlanes) return;
      syncImagePlanesToDom();
      resizeFluidLayer();
    });
  };
  run(0);
}

async function loadTextContents() {
  const results = await Promise.all(
    textUrls.map(async (src) => {
      try {
        const response = await fetch(src);
        if (!response.ok) throw new Error(`Failed to fetch ${src}: ${response.status}`);
        return { src, text: await response.text() };
      } catch (error) {
        console.error(error);
        return null;
      }
    }),
  );

  return results.filter(Boolean);
}

/**
 * @param {SimNode} n
 * @param {number} [timeSec]
 */
function applyPinnedNodeTransform(n, timeSec = 0) {
  const bx = Math.sin(timeSec * n.breath.fx * Math.PI * 2 + n.breath.px) * n.breath.ax * BREATH_AMPLITUDE;
  const by = Math.cos(timeSec * n.breath.fy * Math.PI * 2 + n.breath.py) * n.breath.ay * BREATH_AMPLITUDE;
  n.renderX = n.x + bx;
  n.renderY = n.y + by;
  n.el.style.transform = `translate(${n.renderX}px, ${n.renderY}px) translate(-50%, -50%)`;
}

/**
 * @param {SimNode[]} nodes
 * @param {number} [timeSec]
 */
function applyTransforms(nodes, timeSec = 0) {
  for (const n of nodes) {
    applyPinnedNodeTransform(n, timeSec);
  }
}

/**
 * Keep the credit line pinned to the top-left while still using the same
 * transform stack as graph nodes so its WebGL plane tracks the DOM.
 *
 * @param {SimNode | null} credit
 */
function syncPinnedCreditLayout(credit) {
  if (!credit) return;
  const rect = credit.el.getBoundingClientRect();
  credit.w = rect.width;
  credit.h = rect.height;
  credit.r = Math.hypot(credit.w, credit.h) * 0.5;
  credit.x = CREDIT_MARGIN + credit.w * 0.5;
  credit.y = CREDIT_MARGIN + credit.h * 0.5;
}

/**
 * Credit stays fixed (no idle breath); same transform pattern as graph nodes.
 *
 * @param {SimNode} credit
 */
function applyCreditPinnedTransform(credit) {
  credit.renderX = credit.x;
  credit.renderY = credit.y;
  credit.el.style.transform = `translate(${credit.renderX}px, ${credit.renderY}px) translate(-50%, -50%)`;
}

async function main() {
  const graph = document.getElementById('graph');
  if (!graph) return;

  if (imageUrls.length === 0 && textUrls.length === 0) {
    const creditEl = document.getElementById('credit');
    graph.replaceChildren();
    if (creditEl) graph.appendChild(creditEl);
    const msg = document.createElement('p');
    msg.textContent = 'No nodes found in public/nodes.';
    graph.appendChild(msg);
    return;
  }

  let width = 0;
  let height = 0;
  /** @type {SimNode | null} */
  let creditPinned = null;

  const syncLayoutAndWebGL = () => {
    const rect = graph.getBoundingClientRect();
    width = rect.width;
    height = rect.height;
    syncPinnedCreditLayout(creditPinned);
    if (creditPinned) applyCreditPinnedTransform(creditPinned);
    resizeFluidLayer();
  };

  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => syncLayoutAndWebGL()).observe(graph);
  }
  window.addEventListener('resize', syncLayoutAndWebGL);
  window.visualViewport?.addEventListener('resize', syncLayoutAndWebGL);

  syncLayoutAndWebGL();

  // Hide the layout until image dimensions are known and the static clump has
  // been generated, so the first painted frame is already final.
  graph.style.visibility = 'hidden';

  const textContents = await loadTextContents();

  /** @type {SimNode[]} */
  const imageNodes = imageUrls.map((src) => createNodeElement(graph, src));
  const textNodes = textContents.map(({ src, text }) => createTextNodeElement(graph, text, src));
  const nodes = [...imageNodes, ...textNodes];

  const creditEl = document.getElementById('credit');
  creditPinned =
    creditEl && creditEl.classList.contains('text-plane')
      ? {
          el: /** @type {HTMLDivElement} */ (creditEl),
          src: '',
          x: 0,
          y: 0,
          renderX: 0,
          renderY: 0,
          w: 0,
          h: 0,
          r: 0,
          breath: makeBreathSeed(), // unused: credit uses applyCreditPinnedTransform (no breath)
        }
      : null;
  if (creditPinned) {
    graph.appendChild(creditPinned.el);
  }
  syncLayoutAndWebGL();

  const cursor = { x: 0, y: 0, active: false };

  const updateCursor = (event) => {
    cursor.x = event.clientX;
    cursor.y = event.clientY;
    cursor.active = true;
  };

  window.addEventListener('pointermove', updateCursor);
  window.addEventListener('pointerdown', (event) => {
    updateCursor(event);
    // The first pointerdown unlocks Web Audio (gesture requirement) and lets
    // the reverb bus start producing sound.
    ensureAudioContext();
    for (const node of nodes) {
      if (node.audio) node.audio.nextPlayAttempt = 0;
    }
    const hoveredRaw = findHoveredNode(nodes, cursor);
    const hovered = hoveredRaw?.audio?.enabled ? hoveredRaw : null;
    updateNodeAudio(nodes, cursor, hovered);
  });
  window.addEventListener('pointerleave', () => {
    cursor.active = false;
  });
  window.addEventListener('blur', () => {
    cursor.active = false;
  });
  attachNodeAudio(nodes);

  let revealed = false;
  let breathRaf = 0;
  let hoverHighlightRectEl = null;
  let hoverHighlightStrength = 0;

  const startBreathing = () => {
    const startedAt = performance.now();
    const tick = () => {
      const timeSec = (performance.now() - startedAt) / 1000;
      applyTransforms(nodes, timeSec);
      if (creditPinned) {
        applyCreditPinnedTransform(creditPinned);
      }
      syncPlanePositionsFromDom();
      tryLinkPlanesToNodes(creditPinned ? [...nodes, creditPinned] : nodes);
      const hoveredRaw = findHoveredNode(nodes, cursor);
      // Hover highlight + silencing other audio only when the hovered node has audio.
      const hovered = hoveredRaw?.audio?.enabled ? hoveredRaw : null;
      const targetHL = hovered ? 1 : 0;
      if (hovered) hoverHighlightRectEl = hovered.el;
      hoverHighlightStrength += (targetHL - hoverHighlightStrength) * HOVER_HIGHLIGHT_LERP;
      if (hoverHighlightStrength < 0.002 && targetHL === 0) {
        hoverHighlightRectEl = null;
      }
      setRipplePassHoverHighlight(hoverHighlightRectEl, hoverHighlightStrength);
      updateNodeAudio(nodes, cursor, hovered);
      breathRaf = requestAnimationFrame(tick);
    };
    if (!breathRaf) breathRaf = requestAnimationFrame(tick);
  };

  function revealWhenReady() {
    if (revealed) return;
    revealed = true;
    placeInitialCluster(nodes, width * 0.5, height * 0.5, width, height);
    syncPinnedCreditLayout(creditPinned);
    applyTransforms(nodes);
    if (creditPinned) {
      applyCreditPinnedTransform(creditPinned);
    }
    syncPlanePositionsFromDom();
    scheduleImagePlaneSync();
    graph.style.visibility = '';
    startBreathing();
  }

  let remainingImages = imageNodes.length;
  const markImageReady = () => {
    remainingImages--;
    if (remainingImages <= 0) revealWhenReady();
  };

  if (remainingImages === 0) {
    revealWhenReady();
  }

  for (const node of imageNodes) {
    const onLoad = () => {
      applyLoadedImageMetrics(node);
      scheduleImagePlaneSync();
      markImageReady();
    };

    if (node.img.complete && node.img.naturalWidth > 0) {
      onLoad();
    } else {
      node.img.addEventListener('load', onLoad, { once: true });
      node.img.addEventListener(
        'error',
        () => {
          markImageReady();
        },
        { once: true },
      );
    }
  }

  setRaindropSoundHandler(playRaindropDripSound);
  initFluidLayer();
  syncLayoutAndWebGL();
}

main();
