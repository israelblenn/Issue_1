// Shaders for the WebGL scene

export const basicVs = `
precision mediump float;

attribute vec3 aVertexPosition;
attribute vec2 aTextureCoord;

uniform mat4 uMVMatrix;
uniform mat4 uPMatrix;

varying vec3 vVertexPosition;
varying vec2 vTextureCoord;

void main() {
    vec3 vertexPosition = aVertexPosition;
    gl_Position = uPMatrix * uMVMatrix * vec4(vertexPosition, 1.0);
    
    vTextureCoord = aTextureCoord;
    vVertexPosition = vertexPosition;
}
`;

export const basicFs = `
precision mediump float;

varying vec3 vVertexPosition;
varying vec2 vTextureCoord;

uniform sampler2D uTexture;
uniform float uSaturation;

void main() {
    vec4 color = texture2D(uTexture, vTextureCoord);
    // Rec.709 luma; mix gray toward color to control saturation (1.0 = full color, 0.0 = grayscale).
    float luma = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
    vec3 desaturated = mix(vec3(luma), color.rgb, uSaturation);
    gl_FragColor = vec4(desaturated, color.a);
}
`;

export const ripplesVs = `
precision mediump float;

attribute vec3 aVertexPosition;
attribute vec2 aTextureCoord;

uniform mat4 uMVMatrix;
uniform mat4 uPMatrix;

varying vec3 vVertexPosition;
varying vec2 vTextureCoord;

void main() {
    vec3 vertexPosition = aVertexPosition;
    gl_Position = uPMatrix * uMVMatrix * vec4(vertexPosition, 1.0);
    vTextureCoord = aTextureCoord;
    vVertexPosition = vertexPosition;
}
`;

// PingPong shader for ripples
export const ripplesFs = `
precision mediump float;

varying vec3 vVertexPosition;
varying vec2 vTextureCoord;

uniform sampler2D uRipples;

uniform vec2 uMousePosition;
uniform vec2 uVelocity;
uniform vec2 uRaindropPosition;
uniform vec2 uResolution;
uniform int uTime;

uniform float uViscosity;
uniform float uSpeed;
uniform float uSize;
uniform float uDissipation;
uniform float uClickStrength;
uniform float uRaindropStrength;

void main() {
    vec2 uv = vTextureCoord;
    
    // Compute current ripple state based on previous frame (uRipples)
    vec4 currentRipples = texture2D(uRipples, uv);
    vec2 step = 1.0 / uResolution;
    
    vec2 offset1 = vec2(step.x, 0.0);
    vec2 offset2 = vec2(0.0, step.y);
    
    vec4 up = texture2D(uRipples, uv + offset2);
    vec4 down = texture2D(uRipples, uv - offset2);
    vec4 left = texture2D(uRipples, uv - offset1);
    vec4 right = texture2D(uRipples, uv + offset1);

    // simple wave equation
    float force = (up.r + down.r + left.r + right.r) / 2.0 - currentRipples.g;
    
    // Correct distance for aspect ratio to make perfect circles
    vec2 aspect = vec2(uResolution.x / uResolution.y, 1.0);
    float dist = distance(uv * aspect, uMousePosition * aspect);
    float rainDist = distance(uv * aspect, uRaindropPosition * aspect);
    
    float drop = smoothstep(uSize, 0.0, dist) * (length(uVelocity) * uSpeed + uClickStrength);
    drop += smoothstep(uSize * 1.35, 0.0, rainDist) * uRaindropStrength;
    
    force += drop;
    force *= uDissipation;
    
    force = clamp(force, -1.0, 1.0); // Clamp force to prevent explosive UV distortion
    
    // r contains current state, g contains previous state
    gl_FragColor = vec4(force, currentRipples.r, 0.0, 1.0);
}
`;

export const renderVs = `
precision mediump float;

attribute vec3 aVertexPosition;
attribute vec2 aTextureCoord;

varying vec3 vVertexPosition;
varying vec2 vTextureCoord;

void main() {
    vec3 vertexPosition = aVertexPosition;
    gl_Position = vec4(vertexPosition, 1.0);
    vTextureCoord = aTextureCoord;
    vVertexPosition = vertexPosition;
}
`;

export const renderFs = `
precision mediump float;

varying vec3 vVertexPosition;
varying vec2 vTextureCoord;

uniform sampler2D uRenderTexture; // The original scene (texts, images)
uniform sampler2D uRipplesTexture; // The FBO ripple map
uniform vec2 uResolution;
uniform vec4 uHoverRect; // minU, minV, maxU, maxV in render-texture UV (GL origin)
uniform float uHoverStrength; // 0..1 from JS (smooth hover saturation)
uniform float uFisheyeStrength; // 0 = flat; small positive = center magnified, edges compressed
uniform vec2 uFisheyeFocus; // UV (0–1) where the fisheye bulge is centered (typically cursor)

// Map screen UV → flat render-texture UV: radial stretch away from focal (inverse of globe cap).
vec2 fisheyeSceneUv(vec2 uv, vec2 res, vec2 focal, float strength) {
    if (strength <= 0.0) return uv;
    vec2 p = uv - focal;
    float aspect = res.x / max(res.y, 1.0);
    p.x *= aspect;
    float r2 = dot(p, p);
    p *= (1.0 + strength * r2);
    p.x /= aspect;
    return clamp(p + focal, vec2(0.001), vec2(0.999));
}

void main() {
    const float MONO_EFFECT = 1.0; // 0.0 = off, 1.0 = on — single switch for B&W / desaturation !!
    vec2 uv = vTextureCoord;
    vec2 uvScene = fisheyeSceneUv(uv, uResolution, uFisheyeFocus, uFisheyeStrength);
    
    // Ripples live in the same flat UV space as uRenderTexture; sample there so waves lock to the dome-mapped scene.
    vec4 ripples = texture2D(uRipplesTexture, uvScene);
    vec2 texel = 1.0 / uResolution;
    
    // Distort the UVs of the rendered scene based on the ripples velocity
    float distortion = (ripples.r - ripples.g) * 0.03;
    
    // Setup chromatic aberration offsets !! MODIFY THESE VALUES FOR CHROMATIC ABERRATION
    vec2 offsetR = vec2(distortion * 1.0, distortion * 1.0);
    vec2 offsetG = vec2(distortion * 1.0, distortion * 1.0);
    vec2 offsetB = vec2(distortion * 1.0, distortion * 1.0);
    
    // Sample the texture independently for each color channel
    vec4 sampleR = texture2D(uRenderTexture, uvScene + offsetR);
    vec4 sampleG = texture2D(uRenderTexture, uvScene + offsetG);
    vec4 sampleB = texture2D(uRenderTexture, uvScene + offsetB);
    
    vec3 bgColor = vec3(1.0, 1.0, 1.0); // White background
    
    // Mix foreground and background independently for each channel
    // This allows the alpha fringing to reveal the background colors correctly
    float r = sampleR.r + (bgColor.r * (1.0 - sampleR.a));
    float g = sampleG.g + (bgColor.g * (1.0 - sampleG.a));
    float b = sampleB.b + (bgColor.b * (1.0 - sampleB.a));
    vec3 color = vec3(r, g, b);

    float height = ripples.r - ripples.g;
    float left = texture2D(uRipplesTexture, uvScene - vec2(texel.x, 0.0)).r;
    float right = texture2D(uRipplesTexture, uvScene + vec2(texel.x, 0.0)).r;
    float up = texture2D(uRipplesTexture, uvScene + vec2(0.0, texel.y)).r;
    float down = texture2D(uRipplesTexture, uvScene - vec2(0.0, texel.y)).r;
    float curvature = abs(left + right + up + down - 4.0 * ripples.r);
    float caustics = pow(smoothstep(0.01, 0.18, curvature + abs(height) * 0.12), 1.8) * 0.08;
    color += vec3(0.85, 0.95, 1.0) * caustics;

    // Desaturate calm water; full color where the wave is active (displacement, slope, curvature).
    float rippleSignal = abs(height) + curvature * 0.28 + abs(distortion) * 22.0;
    float rippleSat = mix(0.0, 1.0, smoothstep(0.006, 0.11, rippleSignal));

    // Hovered node (audio): force full saturation here so ripples cannot wash it out; must match uHoverRect from JS.
    float hf = 0.0025;
    float hx = smoothstep(uHoverRect.x - hf, uHoverRect.x + hf, uvScene.x) * (1.0 - smoothstep(uHoverRect.z - hf, uHoverRect.z + hf, uvScene.x));
    float hy = smoothstep(uHoverRect.y - hf, uHoverRect.y + hf, uvScene.y) * (1.0 - smoothstep(uHoverRect.w - hf, uHoverRect.w + hf, uvScene.y));
    float hoverSat = clamp(hx * hy * uHoverStrength, 0.0, 1.0);
    float saturation = max(rippleSat, hoverSat);

    // Rec.709 luma, then graded mono (contrast + gamma + slight cool tint) — only the low-saturation side of the mix.
    float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
    float monoL = clamp((luma - 0.5) * 1.32 + 0.5, 0.0, 1.0);
    monoL = pow(max(monoL, 1e-5), 0.88);
    monoL = mix(monoL, monoL * monoL * (3.0 - 2.0 * monoL), 0.38);
    vec3 mono = clamp(vec3(monoL) * vec3(0.98, 0.99, 1.02), 0.0, 1.0);
    color = mix(mono, color, mix(1.0, saturation, MONO_EFFECT));

    gl_FragColor = vec4(color, 1.0); // fully opaque
}
`;
