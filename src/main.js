import {
  Curtains,
  Plane,
  Vec2,
  PingPongPlane,
  RenderTarget,
  ShaderPass
} from 'curtainsjs';
import { TextTexture } from './TextTexture.js';
import { ripplesVs, ripplesFs, renderVs, renderFs, basicVs, basicFs } from './shaders.js';

import './style.css';

/** Fired when the ripple shader applies a new random raindrop (strength ≈ 32..60). */
/** @type {((strength: number) => void) | null} */
let raindropSoundHandler = null;

/**
 * @param {(strength: number) => void | null} fn
 */
export function setRaindropSoundHandler(fn) {
  raindropSoundHandler = fn;
}

class WebGLLayer {
  constructor() {
    this.curtains = new Curtains({
      container: "canvas",
      pixelRatio: Math.min(3, window.devicePixelRatio),
      antialias: false,
    });

    this.curtains.onSuccess(() => {
      document.body.classList.add("webgl-ready");
      this.size = this.curtains.getBoundingRect();

      this.addRipples();
      this.addRenderPasses();
      this.addTextPlanes();
      this.addImagePlanes();

      // Keep planes in sync with force-directed DOM transforms.
      this.curtains.onRender(() => {
        this.smoothFisheyeFocus();
        this.updateDynamicPlanes();
      });

      // Initial layout can lag first WebGL sizing; mimic a window resize so planes draw on first paint.
      this.curtains.resize(true);
      requestAnimationFrame(() => {
        this.curtains.resize(true);
        (this.imagePlanes || []).forEach((plane) => plane.resize());
        (this.textPlanes || []).forEach((plane) => plane.resize());
      });
    }).onError(() => {
      console.error("WebGL failed to initialize");
      document.body.classList.remove("webgl-ready");
    });
  }

  onMouseMove(e) {
    if (this.ripples) {
      const mousePos = {
        x: e.targetTouches ? e.targetTouches[0].clientX : e.clientX,
        y: e.targetTouches ? e.targetTouches[0].clientY : e.clientY,
      };

      this.mouse.last.copy(this.mouse.current);
      this.mouse.updateVelocity = true;

      if (!this.mouse.lastTime) {
        this.mouse.lastTime = (performance || Date).now();
      }

      if (
        this.mouse.last.x === 0 &&
        this.mouse.last.y === 0 &&
        this.mouse.current.x === 0 &&
        this.mouse.current.y === 0
      ) {
        this.mouse.updateVelocity = false;
      }

      this.mouse.current.set(mousePos.x, mousePos.y);

      const webglCoords = this.ripples.mouseToPlaneCoords(this.mouse.current);
      const mx = (webglCoords.x + 1.0) / 2.0;
      const my = (webglCoords.y + 1.0) / 2.0;
      this.ripples.uniforms.mousePosition.value.set(mx, my);
      if (this.fisheyeFocusTarget) {
        this.fisheyeFocusTarget.set(mx, my);
      }

      if (this.mouse.updateVelocity) {
        const time = (performance || Date).now();
        const delta = Math.max(14, time - this.mouse.lastTime);
        this.mouse.lastTime = time;

        this.mouse.velocity.set(
          (this.mouse.current.x - this.mouse.last.x) / delta,
          (this.mouse.current.y - this.mouse.last.y) / delta
        );
      }
    }
  }

  addRipples() {
    this.mouse = {
      last: new Vec2(),
      current: new Vec2(),
      velocity: new Vec2(),
      updateVelocity: false,
      lastTime: null,
    };
    this.raindrops = {
      position: new Vec2(0.5, 0.5),
      strength: 0,
      nextDropTime: 0,
    };

    this.ripples = new PingPongPlane(this.curtains, document.getElementById("canvas"), {
      vertexShader: ripplesVs,
      fragmentShader: ripplesFs,
      autoloadSources: false,
      watchScroll: false,
      sampler: "uRipples",
      texturesOptions: {
        floatingPoint: "half-float"
      },
      uniforms: {
        mousePosition: {
          name: "uMousePosition",
          type: "2f",
          value: this.mouse.current,
        },
        velocity: {
          name: "uVelocity",
          type: "2f",
          value: this.mouse.velocity,
        },
        raindropPosition: {
          name: "uRaindropPosition",
          type: "2f",
          value: this.raindrops.position,
        },
        resolution: {
          name: "uResolution",
          type: "2f",
          value: new Vec2(this.size.width, this.size.height),
        },
        time: {
          name: "uTime",
          type: "1i",
          value: -1,
        },
        speed: {
          name: "uSpeed",
          type: "1f",
          value: 12.0,
        },
        size: {
          name: "uSize",
          type: "1f",
          value: 0.015,
        },
        dissipation: {
          name: "uDissipation",
          type: "1f",
          value: 0.98,
        },
        clickStrength: {
          name: "uClickStrength",
          type: "1f",
          value: 0.0,
        },
        raindropStrength: {
          name: "uRaindropStrength",
          type: "1f",
          value: 0.0,
        }
      },
    });

    this.ripples.onRender(() => {
      this.updateRaindrops();

      this.mouse.velocity.set(
        this.curtains.lerp(this.mouse.velocity.x, 0, 0.05),
        this.curtains.lerp(this.mouse.velocity.y, 0, 0.05)
      );

      this.ripples.uniforms.velocity.value = this.mouse.velocity.clone();
      this.ripples.uniforms.clickStrength.value = this.curtains.lerp(this.ripples.uniforms.clickStrength.value, 0, 0.1);
      this.ripples.uniforms.raindropStrength.value = this.curtains.lerp(this.ripples.uniforms.raindropStrength.value, 0, 0.18);
      this.ripples.uniforms.time.value++;
    }).onAfterResize(() => {
      const boundingRect = this.ripples.getBoundingRect();
      this.ripples.uniforms.resolution.value.set(boundingRect.width, boundingRect.height);
    });

    window.addEventListener("mousemove", this.onMouseMove.bind(this));
    window.addEventListener("touchmove", this.onMouseMove.bind(this));
    
    const triggerClick = () => {
      this.ripples.uniforms.clickStrength.value = 100.0;
    };
    window.addEventListener("mousedown", triggerClick);
    window.addEventListener("touchstart", triggerClick);
  }

  updateRaindrops() {
    const now = (performance || Date).now();
    if (now < this.raindrops.nextDropTime) return;

    this.raindrops.position.set(Math.random(), Math.random());
    this.ripples.uniforms.raindropPosition.value = this.raindrops.position.clone();
    this.ripples.uniforms.raindropStrength.value = 32.0 + Math.random() * 28.0;
    this.raindrops.nextDropTime = now + 2400 + Math.random() * 4400;
    raindropSoundHandler?.(this.ripples.uniforms.raindropStrength.value);
  }

  addRenderPasses() {
    this.scrollTarget = new RenderTarget(this.curtains);

    this.renderPass = new ShaderPass(this.curtains, {
      fragmentShader: renderFs,
      depth: false,
      uniforms: {
        resolution: {
          name: "uResolution",
          type: "2f",
          value: new Vec2(this.size.width, this.size.height),
        },
        hoverRect: {
          name: "uHoverRect",
          type: "4f",
          value: [0, 0, 1, 1],
        },
        hoverStrength: {
          name: "uHoverStrength",
          type: "1f",
          value: 0,
        },
        fisheyeStrength: {
          name: "uFisheyeStrength",
          type: "1f",
          value: 0.1, // !! Mod for FISHEYE STRENGTH
        },
        fisheyeFocus: {
          name: "uFisheyeFocus",
          type: "2f",
          value: new Vec2(0.5, 0.5),
        },
      },
    });

    this.renderPass.onAfterResize(() => {
      const boundingRect = this.renderPass.getBoundingRect();
      this.renderPass.uniforms.resolution.value.set(boundingRect.width, boundingRect.height);
    });

    this.renderPass.createTexture({
      sampler: "uRipplesTexture",
      fromTexture: this.ripples.getTexture()
    });

    this.fisheyeFocusTarget = new Vec2(0.5, 0.5);
    /** @type {number | undefined} */
    this._fisheyeEasePrevTime = undefined;

    document.documentElement.addEventListener("mouseleave", () => {
      this.fisheyeFocusTarget?.set(0.5, 0.5);
    });
  }

  /**
   * Ease fisheye center toward the cursor (watery lag); ripple mouse stays instant.
   */
  smoothFisheyeFocus() {
    const fp = this.renderPass?.uniforms?.fisheyeFocus?.value;
    const tgt = this.fisheyeFocusTarget;
    if (!fp || !tgt) return;

    const now = (performance || Date).now();
    if (this._fisheyeEasePrevTime == null) {
      this._fisheyeEasePrevTime = now;
      return;
    }

    let dt = (now - this._fisheyeEasePrevTime) / 1000;
    this._fisheyeEasePrevTime = now;
    dt = Math.min(Math.max(dt, 0), 0.06);

    const tau = 0.32;
    const alpha = 1 - Math.exp(-dt / tau);

    fp.x += (tgt.x - fp.x) * alpha;
    fp.y += (tgt.y - fp.y) * alpha;
  }

  addTextPlanes() {
    this.textPlanes = [];
    document.querySelectorAll(".text-plane").forEach(textEl => {
      // Credit stays DOM-only (above canvas) so fisheye / ripples do not affect it.
      if (textEl.id === "credit") return;

      const textPlane = new Plane(this.curtains, textEl, {
        vertexShader: basicVs,
        fragmentShader: basicFs,
        transparent: true,
        uniforms: {
          saturation: {
            name: "uSaturation",
            type: "1f",
            value: 1.0,
          },
        },
      });

      const textTexture = new TextTexture({
        plane: textPlane,
        textElement: textEl,
        sampler: "uTexture",
        // 2× DPR gives sharpness headroom for moderate zoom; capped at 6 to limit VRAM usage.
        resolution: Math.min(window.devicePixelRatio * 2, 6),
      });
      textPlane.userData.textTexture = textTexture;
      this.textPlanes.push(textPlane);
    });

    this.watchPixelRatio();
  }

  // Re-render text textures whenever the browser zoom level changes (which changes devicePixelRatio).
  watchPixelRatio() {
    const updateOnDPRChange = () => {
      const newDPR = window.devicePixelRatio;
      // Re-render every text plane's texture at the new DPR.
      (this.textPlanes || []).forEach(plane => {
        const tt = plane.userData.textTexture;
        if (tt) {
          tt.resolution = Math.min(newDPR * 2, 6);
          tt.resize();
        }
      });
      // Set up the listener again for the next DPR change.
      window
        .matchMedia(`(resolution: ${newDPR}dppx)`)
        .addEventListener("change", updateOnDPRChange, { once: true });
    };

    window
      .matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
      .addEventListener("change", updateOnDPRChange, { once: true });
  }

  addImagePlanes() {
    this.imagePlanes = [];
    document.querySelectorAll(".image-plane").forEach(imgEl => {
      const plane = new Plane(this.curtains, imgEl, {
        vertexShader: basicVs,
        fragmentShader: basicFs,
        transparent: true,
        uniforms: {
          saturation: {
            name: "uSaturation",
            type: "1f",
            value: 1.0,
          },
        },
      });
      this.imagePlanes.push(plane);
    });
  }

  updateDynamicPlanes() {
    (this.imagePlanes || []).forEach(plane => {
      plane.updatePosition();
    });
    (this.textPlanes || []).forEach(plane => {
      plane.updatePosition();
    });
  }
}

let webglLayer = null;
export function initFluidLayer() {
  if (webglLayer) return webglLayer;
  webglLayer = new WebGLLayer();
  return webglLayer;
}

export function getWebglLayer() {
  return webglLayer;
}

/**
 * Highlight the hovered node's screen rect in the ripple render pass so it stays fully saturated
 * even when rippleSignal is low. Scene planes render full color; calm water is grayed only in this pass via rippleSat.
 *
 * @param {HTMLElement | null} el — element whose rect defines the highlight; keep non-null while fading out.
 * @param {number} [strength=0] — 0..1; lerped on the JS side for smooth hover saturation.
 */
export function setRipplePassHoverHighlight(el, strength = 0) {
  const layer = getWebglLayer();
  const uniforms = layer?.renderPass?.uniforms;
  if (!uniforms?.hoverStrength || !uniforms?.hoverRect) return;

  const s = Math.max(0, Math.min(1, Number(strength) || 0));
  uniforms.hoverStrength.value = s;

  if (!el) {
    return;
  }

  const canvas = document.getElementById("canvas");
  const c = canvas?.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  if (!c || c.width <= 0 || c.height <= 0) {
    return;
  }

  let minU = (r.left - c.left) / c.width;
  let maxU = (r.right - c.left) / c.width;
  let minV = 1.0 - (r.bottom - c.top) / c.height;
  let maxV = 1.0 - (r.top - c.top) / c.height;
  if (minU > maxU) [minU, maxU] = [maxU, minU];
  if (minV > maxV) [minV, maxV] = [maxV, minV];

  const hr = uniforms.hoverRect.value;
  hr[0] = Math.max(0, Math.min(1, minU));
  hr[1] = Math.max(0, Math.min(1, minV));
  hr[2] = Math.max(0, Math.min(1, maxU));
  hr[3] = Math.max(0, Math.min(1, maxV));
}

/** Re-run Curtains sizing after viewport / container layout changes (fixes blank first paint). */
export function resizeFluidLayer() {
  if (!webglLayer?.curtains?.gl) return;
  webglLayer.curtains.resize(true);
}

/** Re-measure each plane from its DOM node (needed after `<img>` loads or text layout changes). */
export function syncImagePlanesToDom() {
  const planes = [
    ...(webglLayer?.imagePlanes || []),
    ...(webglLayer?.textPlanes || []),
  ];
  if (!planes.length) return;
  for (const plane of planes) {
    if (plane?.resize) plane.resize();
  }
}

/** Apply DOM bounding rects / transforms to WebGL planes (call after moving `.graph-node` elements). */
export function syncPlanePositionsFromDom() {
  if (!webglLayer?.curtains?.gl) return;
  webglLayer.updateDynamicPlanes();
}
