import { ShaderMaterial, AdditiveBlending, Color, DoubleSide, Vector3 } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * Passes for the Holy Lance.
 *
 * The spear reuses the bolt ribbon strip (`(t, side)` → world position). The
 * rays are the same strip stood on end at the impact point: soft god-beams
 * rising from the floor, not a sustained line column like Nova Beam.
 */
export const HolyPass = Object.freeze({
  SPEAR_CORE: 0,
  SPEAR_GLOW: 1,
  RAY: 2,
  SKY: 3
});

/**
 * SPEAR — a smooth golden lance racing from hand to target.
 *
 * Same layout as the thunder bolt (axis + gentle fan + camera-facing ribbon),
 * but the displacement is *smooth* noise and the palette is warm. Corners and
 * restrikes are deliberately absent: a holy spear should read as one clean
 * weapon, not a discharge.
 */
const SPEAR_VERTEX = /* glsl */ `
  #define PI  3.141592653589793
  #define TAU 6.283185307179586

  uniform float uTime;
  uniform vec3  uOrigin;
  uniform vec3  uTarget;
  uniform vec3  uSide;
  uniform float uSag;
  uniform float uSeed;

  uniform float uStrands;
  uniform float uSpread;
  uniform float uSpreadNear;
  uniform float uSpreadCurve;
  uniform float uTwist;
  uniform float uTwistSpeed;

  uniform float uWave;
  uniform float uWaveScale;
  uniform float uCrawl;
  uniform float uPinch;
  uniform float uConverge;

  uniform float uWidth;
  uniform float uWidthTip;
  uniform float uWidthCurve;
  uniform float uHeadStart;
  uniform float uHeadWidth;
  uniform float uHeadPeak;
  uniform float uTipPoint;
  uniform float uCoreWidth;
  uniform float uWidthScale;
  uniform float uFade;

  attribute float aStrand;

  varying float vT;
  varying float vSide;
  varying float vStrand;
  varying float vViewZ;
  varying float vHead;

  ${noiseGLSL}

  float snoise(float x, float seed) {
    float i = floor(x);
    float f = x - i;
    f = f * f * (3.0 - 2.0 * f);
    return mix(hash11(i + seed), hash11(i + 1.0 + seed), f) * 2.0 - 1.0;
  }

  vec2 wave(float t, float seed, float span) {
    float freq = max(uWaveScale, 0.01) * span;
    float scroll = uTime * uCrawl;
    return vec2(
      snoise(t * freq + scroll, seed),
      snoise(t * freq + scroll * 1.13, seed + 41.7)
    ) * uWave;
  }

  vec3 spearPoint(float t, float seed, float radial, vec3 n1, vec3 n2, float span) {
    vec3 axis = mix(uOrigin, uTarget, t);
    axis.y += uSag * sin(t * PI);

    float pinch = max(uPinch, 1e-3);
    float ends = smoothstep(0.0, pinch, t) *
                 mix(1.0, smoothstep(0.0, pinch, 1.0 - t), clamp(uConverge, 0.0, 1.0));

    // Almost no lateral freeload on the spine — a spear is a shaft, not a beam.
    vec2 offset = wave(t, seed, span) * ends * (0.15 + 0.85 * radial);

    float angle = seed * TAU + (t * uTwist + uTime * uTwistSpeed) * TAU;
    float reach = mix(uSpreadNear, uSpread, pow(clamp(t, 0.0, 1.0), max(uSpreadCurve, 0.01)));
    offset += vec2(cos(angle), sin(angle)) * reach * radial;

    return axis + n1 * offset.x + n2 * offset.y;
  }

  /**
   * Weapon silhouette, not a jet: constant-ish shaft, leaf head near the tip,
   * hard point at the end. Beams use a smooth taper the whole way; this does not.
   */
  float spearHalfWidth(float t, float radial) {
    float shaft = mix(1.0, uWidthTip, pow(clamp(t, 0.0, 1.0), max(uWidthCurve, 0.01)));

    float headStart = clamp(uHeadStart, 0.05, 0.95);
    float peakT = mix(headStart, 1.0, clamp(uHeadPeak, 0.05, 0.95));
    float headUp = smoothstep(headStart, peakT, t);
    float headDown = 1.0 - smoothstep(peakT, 1.0, t);
    float head = headUp * headDown;
    // Soften the leaf so it is not a triangle spike.
    head = pow(max(head, 0.0), 0.85);

    float profile = mix(shaft, uHeadWidth, head);

    // Grip is slightly thicker than mid-shaft.
    profile *= mix(1.18, 1.0, smoothstep(0.0, 0.12, t));

    // Hard point: last fraction pinches to a tip (a beam never does this).
    float tip = max(uTipPoint, 1e-3);
    profile *= mix(0.06, 1.0, 1.0 - smoothstep(1.0 - tip, 1.0, t));

    float halfWidth = uWidth * uWidthScale * profile;
    halfWidth *= mix(uCoreWidth, 0.55, radial);
    return halfWidth * uFade;
  }

  void main() {
    float t = position.x;
    float side = position.y;
    vT = t;
    vSide = side;

    vec3 delta = uTarget - uOrigin;
    float span = max(length(delta), 0.01);
    vec3 dir = delta / span;
    vec3 n1 = uSide - dir * dot(uSide, dir);
    n1 = length(n1) > 1e-4 ? normalize(n1) : normalize(cross(dir, vec3(0.0, 1.0, 0.0)));
    vec3 n2 = normalize(cross(dir, n1));

    float seed = hash11(aStrand * 7.13 + uSeed) * 97.0;
    float radial = uStrands <= 1.0 ? 0.0 : aStrand / (uStrands - 1.0);
    vStrand = radial;

    float headStart = clamp(uHeadStart, 0.05, 0.95);
    float peakT = mix(headStart, 1.0, clamp(uHeadPeak, 0.05, 0.95));
    vHead = smoothstep(headStart, peakT, t) * (1.0 - smoothstep(peakT, 1.0, t));

    vec3 here = spearPoint(t, seed, radial, n1, n2, span);

    float step_ = 0.02;
    float ahead = t + step_;
    float flip = 1.0;
    if (ahead > 1.0) { ahead = t - step_; flip = -1.0; }
    vec3 next = spearPoint(ahead, seed, radial, n1, n2, span);
    vec3 tangent = (next - here) * flip;
    tangent = length(tangent) > 1e-5 ? normalize(tangent) : dir;

    vec3 toCamera = normalize(cameraPosition - here);
    vec3 binormal = cross(tangent, toCamera);
    float bl = length(binormal);
    binormal = bl > 1e-4 ? binormal / bl : n1;

    float halfWidth = spearHalfWidth(t, radial);

    vec4 mv = viewMatrix * vec4(here + binormal * side * halfWidth, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const SPEAR_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uSeed;
  uniform float uProgress;
  uniform float uTipGlow;
  uniform float uTipLength;
  uniform float uCoreSharp;
  uniform float uGlowFalloff;
  uniform float uBranchDim;
  uniform float uBreath;
  uniform float uBreathSpeed;
  uniform float uPassOpacity;
  uniform float uOpacity;
  uniform float uGlow;
  uniform float uFade;
  uniform float uSoftFade;
  uniform vec3  uColorCore;
  uniform vec3  uColorInner;
  uniform vec3  uColorOuter;
  uniform vec3  uColorHalo;

  uniform float uGlobalGlow;
  uniform vec2  uResolution;
  uniform sampler2D uSceneDepth;
  uniform float uCameraNear;
  uniform float uCameraFar;

  varying float vT;
  varying float vSide;
  varying float vStrand;
  varying float vViewZ;
  varying float vHead;

  ${noiseGLSL}
  ${commonGLSL}

  void main() {
    float tip = max(uTipLength, 1e-3);
    float drawn = smoothstep(uProgress, uProgress - tip, vT);
    if (drawn <= 0.002) discard;

    float v = clamp(abs(vSide), 0.0, 1.0);

    #ifdef HOLY_GLOW
      // Tight halo — a weapon rim, not a beam bloom.
      float profile = pow(1.0 - v, max(uGlowFalloff, 0.05));
      vec3 color = mix(uColorHalo, uColorOuter, profile);
      float alpha = profile * 0.75;
    #else
      // Harder edge on the shaft; brighter fill in the leaf head.
      float profile = pow(1.0 - v, max(uCoreSharp, 0.05));
      vec3 color = mix(uColorOuter, uColorInner, smoothstep(0.0, 0.55, profile));
      color = mix(color, uColorCore, smoothstep(0.5, 1.0, profile));
      color = mix(color, uColorCore, vHead * 0.35);
      float alpha = profile;
    #endif

    // Hot point of the spearhead as it travels.
    color += uColorCore * smoothstep(uProgress - tip * 2.0, uProgress, vT) * uTipGlow;
    color += uColorInner * vHead * 0.25;

    float breath = 1.0 - uBreath * (0.5 + 0.5 * sin(uTime * uBreathSpeed + uSeed));

    alpha *= drawn * breath * uFade * uPassOpacity * uOpacity;
    alpha *= mix(1.0, clamp(uBranchDim, 0.0, 1.0), vStrand);

    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.003) discard;

    color *= uGlow * uGlobalGlow;
    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * RAY — soft god-beams rising from the impact point.
 *
 * Each instance is one vertical ribbon. `t` runs from floor to tip; lateral
 * fan and slow sway come from live settings so the pillar reshapes under the
 * editor while paused.
 */
const RAY_VERTEX = /* glsl */ `
  #define PI  3.141592653589793
  #define TAU 6.283185307179586

  uniform float uTime;
  uniform vec3  uOrigin;
  uniform float uSeed;
  uniform float uHeight;
  uniform float uRays;
  uniform float uSpread;
  uniform float uSway;
  uniform float uSwaySpeed;
  uniform float uWidth;
  uniform float uWidthTop;
  uniform float uWidthCurve;
  uniform float uWidthScale;
  uniform float uFade;
  uniform float uReveal;

  attribute float aStrand;

  varying float vT;
  varying float vSide;
  varying float vStrand;
  varying float vViewZ;

  ${noiseGLSL}

  void main() {
    float t = position.x;
    float side = position.y;
    vT = t;
    vSide = side;

    float radial = uRays <= 1.0 ? 0.0 : aStrand / (uRays - 1.0);
    vStrand = radial;

    float seed = hash11(aStrand * 5.91 + uSeed) * 97.0;
    float angle = seed * TAU + aStrand * 1.7;
    float reach = uSpread * (0.35 + 0.65 * radial);

    // Rise only as far as the reveal envelope has opened this frame.
    float climb = t * uHeight * clamp(uReveal, 0.0, 1.0);
    float sway = sin(uTime * uSwaySpeed + seed * 6.0 + t * 2.4) * uSway * t;

    vec3 here = uOrigin;
    here.x += cos(angle) * reach * t + cos(angle + 1.57) * sway;
    here.z += sin(angle) * reach * t + sin(angle + 1.57) * sway;
    here.y += climb;

    // Vertical tangent with a slight outward lean.
    vec3 tangent = normalize(vec3(
      cos(angle) * reach + cos(angle + 1.57) * sway * 0.4,
      uHeight * max(uReveal, 0.05),
      sin(angle) * reach + sin(angle + 1.57) * sway * 0.4
    ));

    vec3 toCamera = normalize(cameraPosition - here);
    vec3 binormal = cross(tangent, toCamera);
    float bl = length(binormal);
    binormal = bl > 1e-4 ? binormal / bl : vec3(1.0, 0.0, 0.0);

    float halfWidth = uWidth * uWidthScale;
    halfWidth *= mix(1.0, uWidthTop, pow(clamp(t, 0.0, 1.0), max(uWidthCurve, 0.01)));
    halfWidth *= uFade;

    vec4 mv = viewMatrix * vec4(here + binormal * side * halfWidth, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const RAY_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uSeed;
  uniform float uCoreSharp;
  uniform float uGlowFalloff;
  uniform float uBranchDim;
  uniform float uBreath;
  uniform float uBreathSpeed;
  uniform float uPassOpacity;
  uniform float uOpacity;
  uniform float uGlow;
  uniform float uFade;
  uniform float uSoftFade;
  uniform float uReveal;
  uniform vec3  uColorCore;
  uniform vec3  uColorInner;
  uniform vec3  uColorOuter;
  uniform vec3  uColorHalo;

  uniform float uGlobalGlow;
  uniform vec2  uResolution;
  uniform sampler2D uSceneDepth;
  uniform float uCameraNear;
  uniform float uCameraFar;

  varying float vT;
  varying float vSide;
  varying float vStrand;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}

  void main() {
    if (uReveal <= 0.002 || uFade <= 0.002) discard;

    float v = clamp(abs(vSide), 0.0, 1.0);

    #ifdef HOLY_GLOW
      float profile = pow(1.0 - v, max(uGlowFalloff, 0.05));
      vec3 color = mix(uColorHalo, uColorOuter, profile);
      float alpha = profile * 0.85;
    #else
      float profile = pow(1.0 - v, max(uCoreSharp, 0.05));
      vec3 color = mix(uColorOuter, uColorInner, smoothstep(0.0, 0.55, profile));
      color = mix(color, uColorCore, smoothstep(0.5, 1.0, profile));
      float alpha = profile;
    #endif

    // Fade toward the tip so the pillar dissolves into air, not a hard cut.
    float tipFade = 1.0 - smoothstep(0.55, 1.0, vT);
    float baseBoost = 1.0 + 0.6 * (1.0 - smoothstep(0.0, 0.18, vT));

    float breath = 1.0 - uBreath * (0.5 + 0.5 * sin(uTime * uBreathSpeed + uSeed + vStrand * 4.0));

    alpha *= tipFade * baseBoost * breath * uFade * uReveal * uPassOpacity * uOpacity;
    alpha *= mix(1.0, clamp(uBranchDim, 0.0, 1.0), vStrand);

    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.003) discard;

    color *= uGlow * uGlobalGlow;
    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * @param {number} pass HolyPass.*
 */
export function createHolyMaterial(pass = HolyPass.SPEAR_CORE) {
  const isRay = pass === HolyPass.RAY;
  const glow = pass === HolyPass.SPEAR_GLOW || (isRay && false);

  // Rays always use a dual-pass pair from the ability (core + glow materials).
  // Callers pass SPEAR_CORE / SPEAR_GLOW for the spear, and for rays they pass
  // RAY with defines set via a second argument — see createHolyRayMaterial.
  const isGlowPass = pass === HolyPass.SPEAR_GLOW;

  const material = new ShaderMaterial({
    defines: isGlowPass ? { HOLY_GLOW: '' } : {},
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uOrigin: { value: new Vector3() },
      uTarget: { value: new Vector3(0, 0, 1) },
      uSide: { value: new Vector3(1, 0, 0) },
      uSag: { value: 0.1 },
      uSeed: { value: 0 },
      uProgress: { value: 0 },
      uFade: { value: 1 },

      uStrands: { value: 3 },
      uSpread: { value: 0.12 },
      uSpreadNear: { value: 0.02 },
      uSpreadCurve: { value: 1.4 },
      uTwist: { value: 0.15 },
      uTwistSpeed: { value: 0.2 },
      uBranchDim: { value: 0.55 },

      uWave: { value: 0.02 },
      uWaveScale: { value: 0.2 },
      uCrawl: { value: 0.4 },
      uPinch: { value: 0.06 },
      uConverge: { value: 1.0 },

      uWidth: { value: 0.055 },
      uWidthTip: { value: 0.85 },
      uWidthCurve: { value: 0.6 },
      uHeadStart: { value: 0.72 },
      uHeadWidth: { value: 2.4 },
      uHeadPeak: { value: 0.45 },
      uTipPoint: { value: 0.05 },
      uCoreWidth: { value: 1.15 },
      uCoreSharp: { value: 4.6 },
      uGlowFalloff: { value: 2.6 },
      uWidthScale: { value: isGlowPass ? 2.8 : 1 },
      uPassOpacity: { value: isGlowPass ? 0.28 : 1 },
      uSoftFade: { value: 0.45 },

      uBreath: { value: 0.12 },
      uBreathSpeed: { value: 3.2 },
      uTipGlow: { value: 1.8 },
      uTipLength: { value: 0.1 },

      uOpacity: { value: 1 },
      uGlow: { value: 2.4 },
      uColorCore: { value: new Color(1, 0.98, 0.9) },
      uColorInner: { value: new Color(1, 0.9, 0.55) },
      uColorOuter: { value: new Color(1, 0.72, 0.28) },
      uColorHalo: { value: new Color(0.85, 0.55, 0.12) },

      // Ray-only (harmless on spear)
      uHeight: { value: 8 },
      uRays: { value: 7 },
      uSway: { value: 0.15 },
      uSwaySpeed: { value: 1.4 },
      uWidthTop: { value: 1.6 },
      uReveal: { value: 0 }
    }),
    vertexShader: SPEAR_VERTEX,
    fragmentShader: SPEAR_FRAGMENT
  });

  material.userData.pass = pass;
  material.userData.syncSpear = (state) => {
    const c = settings.holy;
    const g = settings.global;
    const u = material.uniforms;

    u.uOrigin.value.copy(state.origin);
    u.uTarget.value.copy(state.target);
    u.uSide.value.copy(state.side);
    u.uSeed.value = state.seed;
    u.uProgress.value = state.progress;
    u.uFade.value = state.fade;
    u.uStrands.value = state.strands;

    u.uSag.value = c.sag;
    u.uSpread.value = c.spread;
    u.uSpreadNear.value = c.spreadNear;
    u.uSpreadCurve.value = c.spreadCurve;
    u.uTwist.value = c.twist;
    u.uTwistSpeed.value = c.twistSpeed;
    u.uBranchDim.value = c.branchDim;

    u.uWave.value = c.wave;
    u.uWaveScale.value = c.waveScale;
    u.uCrawl.value = c.crawl;
    u.uPinch.value = c.pinch;
    u.uConverge.value = c.converge;

    u.uWidth.value = c.width;
    u.uWidthTip.value = c.widthTip;
    u.uWidthCurve.value = c.widthCurve;
    u.uHeadStart.value = c.headStart;
    u.uHeadWidth.value = c.headWidth;
    u.uHeadPeak.value = c.headPeak;
    u.uTipPoint.value = c.tipPoint;
    u.uCoreWidth.value = c.coreWidth;
    u.uCoreSharp.value = c.coreSharp;
    u.uGlowFalloff.value = c.glowFalloff;
    u.uWidthScale.value = isGlowPass ? c.glowWidth : 1;
    u.uPassOpacity.value = isGlowPass ? c.glowOpacity : 1;
    u.uSoftFade.value = c.softFade;

    u.uBreath.value = c.breath;
    u.uBreathSpeed.value = c.breathSpeed;
    u.uTipGlow.value = c.tipGlow;
    u.uTipLength.value = c.tipLength;

    u.uOpacity.value = c.opacity * g.opacity;
    u.uGlow.value = c.glow * g.glow;
    u.uColorCore.value.copy(getColor(c.colorCore));
    u.uColorInner.value.copy(getColor(c.colorInner));
    u.uColorOuter.value.copy(getColor(c.colorOuter));
    u.uColorHalo.value.copy(getColor(c.colorHalo));
  };

  return material;
}

/**
 * God-ray material (core or glow pass). Separate factory so the vertex program
 * is the vertical ray path, not the spear.
 *
 * @param {boolean} glow
 */
export function createHolyRayMaterial(glow = false) {
  const material = new ShaderMaterial({
    defines: glow ? { HOLY_GLOW: '' } : {},
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uOrigin: { value: new Vector3() },
      uSeed: { value: 0 },
      uFade: { value: 1 },
      uReveal: { value: 0 },

      uHeight: { value: 8 },
      uRays: { value: 7 },
      uSpread: { value: 0.55 },
      uSway: { value: 0.18 },
      uSwaySpeed: { value: 1.2 },
      uBranchDim: { value: 0.7 },

      uWidth: { value: 0.08 },
      uWidthTop: { value: 1.8 },
      uWidthCurve: { value: 0.85 },
      uCoreSharp: { value: 2.8 },
      uGlowFalloff: { value: 1.8 },
      uWidthScale: { value: glow ? 5.5 : 1 },
      uPassOpacity: { value: glow ? 0.32 : 1 },
      uSoftFade: { value: 0.7 },

      uBreath: { value: 0.15 },
      uBreathSpeed: { value: 2.4 },

      uOpacity: { value: 1 },
      uGlow: { value: 2.2 },
      uColorCore: { value: new Color(1, 0.98, 0.92) },
      uColorInner: { value: new Color(1, 0.92, 0.6) },
      uColorOuter: { value: new Color(1, 0.75, 0.3) },
      uColorHalo: { value: new Color(0.9, 0.55, 0.15) }
    }),
    vertexShader: RAY_VERTEX,
    fragmentShader: RAY_FRAGMENT
  });

  material.userData.syncRay = (state) => {
    const c = settings.holy;
    const g = settings.global;
    const u = material.uniforms;

    u.uOrigin.value.copy(state.origin);
    u.uSeed.value = state.seed;
    u.uFade.value = state.fade;
    u.uReveal.value = state.reveal;

    u.uHeight.value = c.pillarHeight;
    u.uRays.value = state.rays;
    u.uSpread.value = c.pillarSpread;
    u.uSway.value = c.pillarSway;
    u.uSwaySpeed.value = c.pillarSwaySpeed;
    u.uBranchDim.value = c.pillarBranchDim;

    u.uWidth.value = c.pillarWidth;
    u.uWidthTop.value = c.pillarWidthTop;
    u.uWidthCurve.value = c.pillarWidthCurve;
    u.uCoreSharp.value = c.pillarCoreSharp;
    u.uGlowFalloff.value = c.pillarGlowFalloff;
    u.uWidthScale.value = glow ? c.pillarGlowWidth : 1;
    u.uPassOpacity.value = glow ? c.pillarGlowOpacity : 1;
    u.uSoftFade.value = c.softFade;

    u.uBreath.value = c.breath;
    u.uBreathSpeed.value = c.breathSpeed;

    u.uOpacity.value = c.opacity * g.opacity;
    u.uGlow.value = c.pillarGlow * g.glow;
    u.uColorCore.value.copy(getColor(c.colorCore));
    u.uColorInner.value.copy(getColor(c.colorInner));
    u.uColorOuter.value.copy(getColor(c.colorOuter));
    u.uColorHalo.value.copy(getColor(c.colorHalo));
  };

  return material;
}

/**
 * SKYBOLT — a judgment strike from the sky onto the impact point.
 *
 * Same ribbon rule as Storm Lance (piecewise-linear kinks, camera-facing),
 * but the axis is *vertical*: `uOrigin` is high above the target and
 * `uTarget` is the ground hit. `uProgress` grows from sky toward floor so the
 * bolt *comes down*. Every metre is live from `settings.holy`.
 */
const SKY_VERTEX = /* glsl */ `
  #define PI  3.141592653589793
  #define TAU 6.283185307179586

  uniform float uTime;
  uniform vec3  uOrigin;
  uniform vec3  uTarget;
  uniform vec3  uSide;
  uniform float uSeed;
  uniform float uRestrike;

  uniform float uStrands;
  uniform float uSpread;
  uniform float uSpreadNear;
  uniform float uSpreadCurve;
  uniform float uTwist;
  uniform float uTwistSpeed;

  uniform float uJitter;
  uniform float uJitterScale;
  uniform float uOctaves;
  uniform float uJitterFalloff;
  uniform float uCrawl;
  uniform float uPinch;
  uniform float uConverge;

  uniform float uWidth;
  uniform float uWidthTip;
  uniform float uWidthCurve;
  uniform float uCoreWidth;
  uniform float uWidthScale;
  uniform float uStrandFlash;
  uniform float uFlickerSpeed;
  uniform float uFade;

  attribute float aStrand;

  varying float vT;
  varying float vSide;
  varying float vStrand;
  varying float vFlash;
  varying float vViewZ;

  ${noiseGLSL}

  float vnoise(float x, float seed) {
    float i = floor(x);
    float f = x - i;
    return mix(hash11(i + seed), hash11(i + 1.0 + seed), f) * 2.0 - 1.0;
  }

  vec2 kink(float t, float seed, float span) {
    vec2 o = vec2(0.0);
    float amp = 1.0;
    float freq = max(uJitterScale, 0.01) * span;
    float scroll = uTime * uCrawl;
    for (int i = 0; i < 5; i++) {
      float on = step(float(i), uOctaves - 1.0);
      o.x += on * amp * vnoise(t * freq + scroll, seed + 13.0 * float(i));
      o.y += on * amp * vnoise(t * freq + scroll * 1.17, seed + 71.3 + 13.0 * float(i));
      amp *= uJitterFalloff;
      freq *= 2.0;
      scroll *= 1.63;
    }
    return o;
  }

  vec3 boltPoint(float t, float seed, float radial, vec3 n1, vec3 n2, float span) {
    vec3 axis = mix(uOrigin, uTarget, t);

    float pinch = max(uPinch, 1e-3);
    float ends = smoothstep(0.0, pinch, t) *
                 mix(1.0, smoothstep(0.0, pinch, 1.0 - t), clamp(uConverge, 0.0, 1.0));

    vec2 offset = kink(t, seed, span) * uJitter * ends;

    float angle = seed * TAU + (t * uTwist + uTime * uTwistSpeed) * TAU;
    float reach = mix(uSpreadNear, uSpread, pow(clamp(t, 0.0, 1.0), max(uSpreadCurve, 0.01)));
    offset += vec2(cos(angle), sin(angle)) * reach * radial;

    return axis + n1 * offset.x + n2 * offset.y;
  }

  void main() {
    float t = position.x;
    float side = position.y;
    vT = t;
    vSide = side;

    vec3 delta = uTarget - uOrigin;
    float span = max(length(delta), 0.01);
    vec3 dir = delta / span;
    vec3 n1 = uSide - dir * dot(uSide, dir);
    n1 = length(n1) > 1e-4 ? normalize(n1) : normalize(cross(dir, vec3(1.0, 0.0, 0.0)));
    vec3 n2 = normalize(cross(dir, n1));

    float strike = floor(uTime * max(uRestrike, 0.01));
    float seed = hash11(aStrand * 7.13 + uSeed + strike * 3.77) * 97.0;
    float radial = uStrands <= 1.0 ? 0.0 : aStrand / (uStrands - 1.0);
    vStrand = radial;

    vec3 here = boltPoint(t, seed, radial, n1, n2, span);

    float step_ = 0.02;
    float ahead = t + step_;
    float flip = 1.0;
    if (ahead > 1.0) { ahead = t - step_; flip = -1.0; }
    vec3 next = boltPoint(ahead, seed, radial, n1, n2, span);
    vec3 tangent = (next - here) * flip;
    tangent = length(tangent) > 1e-5 ? normalize(tangent) : dir;

    vec3 toCamera = normalize(cameraPosition - here);
    vec3 binormal = cross(tangent, toCamera);
    float bl = length(binormal);
    binormal = bl > 1e-4 ? binormal / bl : n1;

    float flash = mix(1.0, hash11(floor(uTime * uFlickerSpeed) + aStrand * 3.7 + uSeed), uStrandFlash);
    vFlash = flash;

    float halfWidth = uWidth * uWidthScale;
    halfWidth *= mix(1.0, uWidthTip, pow(clamp(t, 0.0, 1.0), max(uWidthCurve, 0.01)));
    halfWidth *= mix(uCoreWidth, 1.0, radial);
    halfWidth *= flash * uFade;

    vec4 mv = viewMatrix * vec4(here + binormal * side * halfWidth, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const SKY_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uSeed;
  uniform float uProgress;
  uniform float uTipGlow;
  uniform float uTipLength;
  uniform float uCoreSharp;
  uniform float uGlowFalloff;
  uniform float uBranchDim;
  uniform float uFlicker;
  uniform float uFlickerSpeed;
  uniform float uPassOpacity;
  uniform float uOpacity;
  uniform float uGlow;
  uniform float uFade;
  uniform float uSoftFade;
  uniform vec3  uColorCore;
  uniform vec3  uColorInner;
  uniform vec3  uColorOuter;
  uniform vec3  uColorHalo;

  uniform float uGlobalGlow;
  uniform vec2  uResolution;
  uniform sampler2D uSceneDepth;
  uniform float uCameraNear;
  uniform float uCameraFar;

  varying float vT;
  varying float vSide;
  varying float vStrand;
  varying float vFlash;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}

  void main() {
    // Progress grows sky → ground, so the leading edge is the *strike front*.
    float tip = max(uTipLength, 1e-3);
    float drawn = smoothstep(uProgress, uProgress - tip, vT);
    if (drawn <= 0.002) discard;

    float v = clamp(abs(vSide), 0.0, 1.0);

    #ifdef HOLY_GLOW
      float profile = pow(1.0 - v, max(uGlowFalloff, 0.05));
      vec3 color = mix(uColorHalo, uColorOuter, profile);
      float alpha = profile;
    #else
      float profile = pow(1.0 - v, max(uCoreSharp, 0.05));
      vec3 color = mix(uColorOuter, uColorInner, smoothstep(0.0, 0.5, profile));
      color = mix(color, uColorCore, smoothstep(0.45, 1.0, profile));
      float alpha = profile;
    #endif

    color += uColorCore * smoothstep(uProgress - tip * 2.0, uProgress, vT) * uTipGlow;

    float flicker = 1.0 - uFlicker * hash11(floor(uTime * uFlickerSpeed) + uSeed);

    alpha *= drawn * flicker * vFlash * uFade * uPassOpacity * uOpacity;
    alpha *= mix(1.0, clamp(uBranchDim, 0.0, 1.0), vStrand);

    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.003) discard;

    color *= uGlow * uGlobalGlow;
    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * @param {boolean} glow  wide halo pass when true
 */
export function createHolySkyboltMaterial(glow = false) {
  const material = new ShaderMaterial({
    defines: glow ? { HOLY_GLOW: '' } : {},
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uOrigin: { value: new Vector3() },
      uTarget: { value: new Vector3(0, 0, 0) },
      uSide: { value: new Vector3(1, 0, 0) },
      uSeed: { value: 0 },
      uRestrike: { value: 18 },
      uProgress: { value: 0 },
      uFade: { value: 1 },

      uStrands: { value: 12 },
      uSpread: { value: 1.8 },
      uSpreadNear: { value: 0.35 },
      uSpreadCurve: { value: 0.7 },
      uTwist: { value: 0.55 },
      uTwistSpeed: { value: 1.1 },
      uBranchDim: { value: 0.55 },

      uJitter: { value: 0.85 },
      uJitterScale: { value: 0.55 },
      uOctaves: { value: 4 },
      uJitterFalloff: { value: 0.52 },
      uCrawl: { value: 4.5 },
      uPinch: { value: 0.08 },
      uConverge: { value: 1.0 },

      uWidth: { value: 0.12 },
      uWidthTip: { value: 0.55 },
      uWidthCurve: { value: 0.9 },
      uCoreWidth: { value: 1.8 },
      uCoreSharp: { value: 3.2 },
      uGlowFalloff: { value: 1.9 },
      uWidthScale: { value: glow ? 9 : 1 },
      uPassOpacity: { value: glow ? 0.42 : 1 },
      uSoftFade: { value: 0.8 },

      uFlicker: { value: 0.35 },
      uFlickerSpeed: { value: 28 },
      uStrandFlash: { value: 0.45 },
      uTipGlow: { value: 2.8 },
      uTipLength: { value: 0.07 },

      uOpacity: { value: 1 },
      uGlow: { value: 3.2 },
      uColorCore: { value: new Color(1, 1, 1) },
      uColorInner: { value: new Color(1, 0.95, 0.75) },
      uColorOuter: { value: new Color(0.7, 0.85, 1) },
      uColorHalo: { value: new Color(0.35, 0.45, 1) }
    }),
    vertexShader: SKY_VERTEX,
    fragmentShader: SKY_FRAGMENT
  });

  /**
   * @param {object} state { origin, target, side, progress, fade, seed, strands }
   */
  material.userData.syncSky = (state) => {
    const c = settings.holy;
    const g = settings.global;
    const u = material.uniforms;

    u.uOrigin.value.copy(state.origin);
    u.uTarget.value.copy(state.target);
    u.uSide.value.copy(state.side);
    u.uSeed.value = state.seed;
    u.uProgress.value = state.progress;
    u.uFade.value = state.fade;
    u.uStrands.value = state.strands;

    u.uRestrike.value = c.skyRestrike;
    u.uSpread.value = c.skySpread;
    u.uSpreadNear.value = c.skySpreadNear;
    u.uSpreadCurve.value = c.skySpreadCurve;
    u.uTwist.value = c.skyTwist;
    u.uTwistSpeed.value = c.skyTwistSpeed;
    u.uBranchDim.value = c.skyBranchDim;

    u.uJitter.value = c.skyJitter;
    u.uJitterScale.value = c.skyJitterScale;
    u.uOctaves.value = c.skyOctaves;
    u.uJitterFalloff.value = c.skyJitterFalloff;
    u.uCrawl.value = c.skyCrawl;
    u.uPinch.value = c.skyPinch;
    u.uConverge.value = c.skyConverge;

    u.uWidth.value = c.skyWidth;
    u.uWidthTip.value = c.skyWidthTip;
    u.uWidthCurve.value = c.skyWidthCurve;
    u.uCoreWidth.value = c.skyCoreWidth;
    u.uCoreSharp.value = c.skyCoreSharp;
    u.uGlowFalloff.value = c.skyGlowFalloff;
    u.uWidthScale.value = glow ? c.skyGlowWidth : 1;
    u.uPassOpacity.value = glow ? c.skyGlowOpacity : 1;
    u.uSoftFade.value = c.softFade;

    u.uFlicker.value = c.skyFlicker;
    u.uFlickerSpeed.value = c.skyFlickerSpeed;
    u.uStrandFlash.value = c.skyStrandFlash;
    u.uTipGlow.value = c.skyTipGlow;
    u.uTipLength.value = c.skyTipLength;

    u.uOpacity.value = c.opacity * g.opacity;
    u.uGlow.value = c.skyGlow * g.glow;
    u.uColorCore.value.copy(getColor(c.colorSkyCore));
    u.uColorInner.value.copy(getColor(c.colorSkyInner));
    u.uColorOuter.value.copy(getColor(c.colorSkyOuter));
    u.uColorHalo.value.copy(getColor(c.colorSkyHalo));
  };

  return material;
}
