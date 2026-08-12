import { Mesh, Vector3 } from 'three';
import { Ability, AbilityPhase } from './Ability.js';
import {
  createHolyMaterial,
  createHolyRayMaterial,
  createHolySkyboltMaterial,
  HolyPass
} from '../materials/HolyMaterial.js';
import { createBoltRibbonGeometry } from '../assets/ProceduralGeometry.js';
import { ParticleShape } from '../particles/ParticleSystem.js';
import { RateEmitter } from '../particles/ParticleEngine.js';
import { DecalType } from '../effects/GroundDecals.js';
import { BurstMode } from '../effects/BurstSphere.js';
import { LAYER } from '../core/Layers.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { saturate, lerp, Easing, randRange } from '../utils/math.js';

/** Hard ceiling on spear filaments. The editor clamps `strands` here. */
const MAX_STRANDS = 8;
/** Samples along one filament. */
const NODES = 64;
/** Ceiling on god-rays at the impact pillar. */
const MAX_RAYS = 16;
/** Ceiling on skybolt filaments — big judgment strike. */
const MAX_SKY_STRANDS = 24;
const SKY_NODES = 80;
const SPARK_BATCHES = 5;

const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _target = new Vector3();
const _skyOrigin = new Vector3();

/**
 * HOLY LANCE — a clean gold-white skillshot that calls a sky judgment.
 *
 * Beat map:
 *
 *   1. **travel** — a smooth spear leaves the hand and races along the aim
 *      line. Soft motes trail it; pale brands kiss the floor under the tip.
 *   2. **impact** — a *large* kinked lightning bolt crashes from the sky onto
 *      the hit point (Glacial Crown scale), while soft god-rays open around
 *      the landing. Shock rings, electric brands and glitter tear open on the
 *      floor.
 *   3. **fade** — spear, skybolt and pillar collapse into a thread of light.
 *
 * Distinct from Nova Beam (sustained horizontal column) and Storm Lance
 * (horizontal hand bolt). The skybolt is Storm Lance's ribbon language stood
 * vertical and scaled for a monument-sized answer.
 *
 * **Editor rule.** A cast captures one seed. Every metre is resolved against
 * `settings.holy` each frame — including zero-length frames while paused.
 */
export class HolyAbility extends Ability {
  constructor(context) {
    super('holy', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    this.spearGeometry = createBoltRibbonGeometry(NODES, MAX_STRANDS);
    this.rayGeometry = createBoltRibbonGeometry(NODES, MAX_RAYS);
    this.skyGeometry = createBoltRibbonGeometry(SKY_NODES, MAX_SKY_STRANDS);

    this.spearCore = createHolyMaterial(HolyPass.SPEAR_CORE);
    this.spearGlow = createHolyMaterial(HolyPass.SPEAR_GLOW);
    this.spearMaterials = [this.spearGlow, this.spearCore];

    this.rayGlow = createHolyRayMaterial(true);
    this.rayCore = createHolyRayMaterial(false);
    this.rayMaterials = [this.rayGlow, this.rayCore];

    this.skyGlow = createHolySkyboltMaterial(true);
    this.skyCore = createHolySkyboltMaterial(false);
    this.skyMaterials = [this.skyGlow, this.skyCore];

    this.spearMeshes = [];
    for (const [index, material] of this.spearMaterials.entries()) {
      const mesh = new Mesh(this.spearGeometry, material);
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.layers.set(LAYER.VFX);
      mesh.renderOrder = 12 + index;
      this.group.add(mesh);
      this.spearMeshes.push(mesh);
    }

    this.rayMeshes = [];
    for (const [index, material] of this.rayMaterials.entries()) {
      const mesh = new Mesh(this.rayGeometry, material);
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.layers.set(LAYER.VFX);
      mesh.renderOrder = 14 + index;
      mesh.visible = false;
      this.group.add(mesh);
      this.rayMeshes.push(mesh);
    }

    this.skyMeshes = [];
    for (const [index, material] of this.skyMaterials.entries()) {
      const mesh = new Mesh(this.skyGeometry, material);
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.layers.set(LAYER.VFX);
      mesh.renderOrder = 16 + index;
      mesh.visible = false;
      this.group.add(mesh);
      this.skyMeshes.push(mesh);
    }

    this._seed = 0;
    this._strandCount = 1;
    this._rayCount = 1;
    this._skyCount = 1;
    this._brandDistance = 0;
    this._pillarReveal = 0;
    this._skyProgress = 0;

    this._state = {
      origin: new Vector3(),
      target: new Vector3(),
      side: new Vector3(),
      progress: 0,
      fade: 1,
      seed: 0,
      strands: 1,
      rays: 1,
      reveal: 0
    };
  }

  createParticles() {
    const particles = this.ctx.particles;

    // Soft gold sparks — streaks, not electric snaps.
    this.sparks = particles.get('holy.sparks', {
      capacity: 3200,
      shape: ParticleShape.STREAK,
      additive: true,
      stretch: true,
      softFade: 0.3
    });
    this.sparks.uniforms.uDrag.value = 1.2;
    this.sparks.uniforms.uEndSize.value = 0.2;
    this.sparks.uniforms.uSizeIn.value = 0.03;
    this.sparks.uniforms.uFadeIn.value = 0.04;
    this.sparks.uniforms.uFadeOut.value = 0.5;

    // Rising motes / dust of light.
    this.motes = particles.get('holy.motes', {
      capacity: 2800,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.45
    });
    this.motes.uniforms.uDrag.value = 1.5;
    this.motes.uniforms.uEndSize.value = 0.12;
    this.motes.uniforms.uSizeIn.value = 0.08;
    this.motes.uniforms.uFadeIn.value = 0.1;
    this.motes.uniforms.uFadeOut.value = 0.45;

    // Soft glitter at impact.
    this.glitter = particles.get('holy.glitter', {
      capacity: 2400,
      shape: ParticleShape.SOFT,
      additive: true,
      softFade: 0.35
    });
    this.glitter.uniforms.uDrag.value = 0.9;
    this.glitter.uniforms.uEndSize.value = 0.08;
    this.glitter.uniforms.uSizeIn.value = 0.02;
    this.glitter.uniforms.uFadeIn.value = 0.03;
    this.glitter.uniforms.uFadeOut.value = 0.55;

    // Light haze off the radiant brand (non-additive so it has body).
    this.haze = particles.get('holy.haze', {
      capacity: 1600,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 1.0
    });
    this.haze.uniforms.uDrag.value = 1.6;
    this.haze.uniforms.uEndSize.value = 2.4;
    this.haze.uniforms.uSizeIn.value = 0.14;
    this.haze.uniforms.uFadeIn.value = 0.18;
    this.haze.uniforms.uFadeOut.value = 0.35;

    this.sparkEmitter = new RateEmitter();
    this.moteEmitter = new RateEmitter();
    this.glitterEmitter = new RateEmitter();
    this.hazeEmitter = new RateEmitter();
    this.skySparkEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return (
      this._strandCount * this.spearMeshes.length +
      this._rayCount * this.rayMeshes.length +
      this._skyCount * this.skyMeshes.length
    );
  }

  get impactDuration() {
    return Math.max(0.05, settings.holy.lifetime * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.holy.fadeTime);
  }

  /** 0..1 through the wind-up before the spear leaves the hands. */
  get releaseCharge() {
    return saturate(this.age / Math.max(0.01, settings.holy.charge));
  }

  lightShimmer() {
    const c = settings.holy;
    return 0.88 + 0.12 * Math.sin(this.age * c.breathSpeed) * Math.sin(this.age * 2.1);
  }

  /**
   * Hold the spear at the hand until the cast clip has reached the throw.
   *
   * Same trick as Nova Beam's charge: the base class would send the front on
   * frame one, which is why the VFX used to leave before the hands got there.
   */
  advance(dt) {
    const c = this.config;
    const charge = Math.max(0, c.charge);
    if (this.age < charge) return false;

    const speed = c.speed * settings.global.speed;
    const since = this.age - charge;
    this.front += speed * Easing.outQuad(saturate(since / 0.06)) * dt;

    const previousU = this.u;
    this.u = saturate(this.front / this.length);
    this.pointAt(this.u, this.position);
    return this.u >= 1 && previousU < 1;
  }

  /* ------------------------------------------------------------------ */
  /* Geometry helpers — metres from live settings                        */
  /* ------------------------------------------------------------------ */

  _handPoint(out) {
    const c = settings.holy;
    out
      .copy(this.origin)
      .addScaledVector(this.direction, c.handForward)
      .addScaledVector(this.side, c.handSide);
    out.y = c.handHeight;
    return out;
  }

  _impactPoint(out) {
    this.pointAt(1, out);
    out.y = settings.holy.endHeight;
    return out;
  }

  _axisPoint(s, out) {
    const c = settings.holy;
    const t = saturate(s);
    out
      .copy(this.origin)
      .addScaledVector(this.direction, lerp(c.handForward, this.length, t))
      .addScaledVector(this.side, c.handSide * (1 - t));
    out.y = lerp(c.handHeight, c.endHeight, t) + c.sag * Math.sin(t * Math.PI);
    return out;
  }

  _bundleRadius(s) {
    const c = settings.holy;
    return lerp(c.spreadNear, c.spread, Math.pow(saturate(s), Math.max(0.01, c.spreadCurve)));
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.sparkEmitter.reset();
    this.moteEmitter.reset();
    this.glitterEmitter.reset();
    this.hazeEmitter.reset();
    this.skySparkEmitter.reset();
    this._brandDistance = 0;
    this._pillarReveal = 0;
    this._skyProgress = 0;
    this._seed = Math.random() * 100;

    for (const mesh of this.rayMeshes) mesh.visible = false;
    for (const mesh of this.skyMeshes) mesh.visible = false;
    this._muzzleFired = false;

    this._syncUniforms(1);
  }

  /** Sky entry point above the impact — live height from settings. */
  _skyPoint(out) {
    this.pointAt(1, out);
    out.y = settings.holy.skyHeight;
    return out;
  }

  /** Ground contact under the skybolt. */
  _skyGround(out) {
    this.pointAt(1, out);
    out.y = settings.holy.skyEndHeight;
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Sync                                                                */
  /* ------------------------------------------------------------------ */

  _syncUniforms(fade) {
    const c = settings.holy;
    const g = settings.global;
    const state = this._state;

    this._handPoint(state.origin);
    this._impactPoint(state.target);
    state.side.copy(this.side);
    state.progress = this.phase === AbilityPhase.TRAVEL ? this.u : 1;
    state.fade = fade;
    state.seed = this._seed;

    this._strandCount = Math.max(1, Math.min(MAX_STRANDS, Math.round(c.strands)));
    state.strands = this._strandCount;
    this.spearGeometry.instanceCount = this._strandCount;

    for (const material of this.spearMaterials) material.userData.syncSpear(state);

    this._rayCount = Math.max(1, Math.min(MAX_RAYS, Math.round(c.pillarRays)));
    state.rays = this._rayCount;
    state.reveal = this._pillarReveal;
    this.rayGeometry.instanceCount = this._rayCount;
    this._impactPoint(state.origin);
    for (const material of this.rayMaterials) material.userData.syncRay(state);

    /* skybolt — origin high, target on the floor; progress sky → ground */
    this._skyCount = Math.max(1, Math.min(MAX_SKY_STRANDS, Math.round(c.skyStrands)));
    this.skyGeometry.instanceCount = this._skyCount;
    this._skyPoint(_skyOrigin);
    this._skyGround(_target);
    state.origin.copy(_skyOrigin);
    state.target.copy(_target);
    state.side.copy(this.side);
    state.progress = this._skyProgress;
    state.fade = fade;
    state.seed = this._seed + 17.3;
    state.strands = this._skyCount;
    for (const material of this.skyMaterials) material.userData.syncSky(state);

    /* particles */
    this.sparks.setGradient(
      getColor(c.colorSparkA),
      getColor(c.colorSparkB),
      getColor(c.colorSparkC),
      getColor(c.colorSparkD)
    );
    this.sparks.uniforms.uGravity.value.set(0, c.sparkGravity, 0);
    this.sparks.uniforms.uSizeScale.value = c.sparkSize * g.particleSize * 7;
    this.sparks.uniforms.uLifeScale.value = c.sparkLifetime * 0.5 * g.particleLifetime;
    this.sparks.uniforms.uSpeedScale.value = g.particleSpeed;
    this.sparks.uniforms.uOpacity.value = g.opacity;
    this.sparks.uniforms.uGlow.value = c.glow * 0.55 * g.glow;
    this.sparks.uniforms.uStretch.value = c.sparkStretch;
    this.sparks.uniforms.uTurbulence.value = 0.2 * g.turbulence;

    this.motes.setGradient(
      getColor(c.colorMoteA),
      getColor(c.colorMoteB),
      getColor(c.colorMoteC),
      getColor(c.colorMoteD)
    );
    this.motes.uniforms.uGravity.value.set(0, c.moteRise, 0);
    this.motes.uniforms.uSizeScale.value = c.moteSize * g.particleSize * 7;
    this.motes.uniforms.uLifeScale.value = c.moteLifetime * 0.5 * g.particleLifetime;
    this.motes.uniforms.uSpeedScale.value = g.particleSpeed;
    this.motes.uniforms.uOpacity.value = g.opacity;
    this.motes.uniforms.uGlow.value = 1.0 * g.glow;
    this.motes.uniforms.uTurbulence.value = c.moteTurbulence * g.turbulence;

    this.glitter.setGradient(
      getColor(c.colorGlitterA),
      getColor(c.colorGlitterB),
      getColor(c.colorGlitterC),
      getColor(c.colorGlitterD)
    );
    this.glitter.uniforms.uGravity.value.set(0, c.glitterRise, 0);
    this.glitter.uniforms.uSizeScale.value = c.glitterSize * g.particleSize * 7;
    this.glitter.uniforms.uLifeScale.value = c.glitterLifetime * 0.5 * g.particleLifetime;
    this.glitter.uniforms.uSpeedScale.value = g.particleSpeed;
    this.glitter.uniforms.uOpacity.value = g.opacity;
    this.glitter.uniforms.uGlow.value = 1.2 * g.glow;
    this.glitter.uniforms.uTurbulence.value = 0.35 * g.turbulence;

    this.haze.setGradient(
      getColor(c.colorHazeA),
      getColor(c.colorHazeB),
      getColor(c.colorHazeC),
      getColor(c.colorHazeD)
    );
    this.haze.uniforms.uGravity.value.set(0, c.hazeRise, 0);
    this.haze.uniforms.uSizeScale.value = c.hazeSize * g.particleSize;
    this.haze.uniforms.uLifeScale.value = c.hazeLifetime * 0.5 * g.particleLifetime;
    this.haze.uniforms.uSpeedScale.value = c.hazeSpeed * g.particleSpeed;
    this.haze.uniforms.uOpacity.value = c.hazeOpacity * g.opacity;
    this.haze.uniforms.uTurbulence.value = 0.3 * g.turbulence;
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Flash when the spear *actually* leaves the hands (end of charge), not on
   * click. Called once from travel when the front first moves.
   */
  _muzzleFx() {
    const c = settings.holy;
    const g = settings.global;
    this._handPoint(_pos);

    this.ctx.bursts.spawn(BurstMode.AIR, _pos, {
      radius: c.muzzleSize * 0.25,
      endRadius: c.muzzleSize * g.explosionIntensity,
      life: 0.35,
      intensity: c.muzzleIntensity,
      opacity: 0.85,
      fresnel: 1.8,
      displace: 0.35,
      colorA: getColor(c.colorMuzzleA),
      colorB: getColor(c.colorMuzzleB),
      colorC: getColor(c.colorMuzzleC)
    });

    _emit.position = _pos;
    _emit.radius = 0.15;
    _emit.direction = _dir.copy(this.direction);
    _emit.speed = c.sparkSpeed * 1.2;
    _emit.speedVariance = 0.7;
    _emit.spread = 0.7;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.16;
    _emit.sizeVariance = 0.6;
    _emit.life = c.sparkLifetime;
    _emit.lifeVariance = 0.45;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = frame.uTime.value;
    this.sparks.emit(Math.round(28 * g.particleCount), _emit);
    this.motes.emit(Math.round(18 * g.particleCount), _emit);

    this.ctx.flash.trigger(getColor(c.colorCastFlash), c.castFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.7 * g.explosionIntensity;
  }

  _spearFx(dt, scale) {
    const c = settings.holy;
    const g = settings.global;
    const time = frame.uTime.value;
    const reach = this.phase === AbilityPhase.TRAVEL ? Math.max(0.02, this.u) : 1;

    let sparkCount = Math.round(this.sparkEmitter.tick(dt, c.sparkRate * scale) * g.particleCount);
    if (sparkCount > 0) {
      _emit.direction = _dir.copy(this.direction).multiplyScalar(0.35).setY(0.4).normalize();
      _emit.speed = c.sparkSpeed;
      _emit.speedVariance = 0.75;
      _emit.spread = 0.9;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.12;
      _emit.sizeVariance = 0.65;
      _emit.life = c.sparkLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;

      const batches = Math.min(sparkCount, SPARK_BATCHES);
      const per = Math.ceil(sparkCount / batches);
      while (sparkCount > 0) {
        const s = randRange(0.05, 1) * reach;
        this._axisPoint(s, _pos);
        _emit.position = _pos;
        _emit.radius = this._bundleRadius(s) * 1.2 + 0.04;
        this.sparks.emit(Math.min(per, sparkCount), _emit);
        sparkCount -= per;
      }
    }

    const moteCount = Math.round(this.moteEmitter.tick(dt, c.moteRate * scale) * g.particleCount);
    if (moteCount > 0) {
      const s = Math.random() * reach;
      this._axisPoint(s, _pos);
      _emit.position = _pos;
      _emit.radius = this._bundleRadius(s) * 1.5 + 0.15;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.moteSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 1.0;
      _emit.size = 0.07;
      _emit.sizeVariance = 0.55;
      _emit.life = c.moteLifetime;
      _emit.lifeVariance = 0.45;
      _emit.spin = 0;
      _emit.time = time;
      this.motes.emit(moteCount, _emit);
    }

    const hazeCount = Math.round(this.hazeEmitter.tick(dt, c.hazeRate * scale) * g.particleCount);
    if (hazeCount > 0) {
      this.pointAt(Math.random() * reach, _pos).setY(0.12);
      _emit.position = _pos;
      _emit.radius = c.brandRadius * 1.8;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.hazeSpeed;
      _emit.speedVariance = 0.6;
      _emit.spread = 0.85;
      _emit.size = 0.7;
      _emit.sizeVariance = 0.45;
      _emit.life = c.hazeLifetime;
      _emit.lifeVariance = 0.35;
      _emit.spin = 0.25;
      _emit.time = time;
      this.haze.emit(hazeCount, _emit);
    }
  }

  /** Pale radiant brands under the travelling tip — light, not scorched earth. */
  _groundFx() {
    const c = settings.holy;
    const step = 1 / Math.max(0.05, c.brandRate);

    while (this.front - this._brandDistance >= step) {
      this._brandDistance += step;
      const s = saturate(this._brandDistance / this.length);
      this.pointAt(s, _pos);
      const wander = this._bundleRadius(s) * 0.6;
      _pos.x += this.side.x * randRange(-wander, wander);
      _pos.z += this.side.z * randRange(-wander, wander);

      this.ctx.decals.spawn(DecalType.FROST, _pos, {
        radius: c.brandRadius * randRange(0.75, 1.2),
        life: c.brandLife,
        intensity: c.brandIntensity,
        colorA: getColor(c.colorBrandA),
        colorB: getColor(c.colorBrandB),
        height: 0.012
      });

      this.ctx.decals.spawn(DecalType.DUSTRING, _pos, {
        radius: c.brandRadius * 0.7 * randRange(0.8, 1.15),
        life: c.brandLife * 0.7,
        intensity: c.brandIntensity * 0.55,
        colorA: getColor(c.colorBrandB),
        colorB: getColor(c.colorBrandA),
        height: 0.01
      });
    }
  }

  _pillarFx(dt, scale) {
    const c = settings.holy;
    const g = settings.global;
    const time = frame.uTime.value;
    this._impactPoint(_pos);

    const glitterCount = Math.round(
      this.glitterEmitter.tick(dt, c.glitterRate * scale) * g.particleCount
    );
    if (glitterCount > 0) {
      _emit.position = _pos;
      _emit.radius = c.pillarSpread * 1.4 + 0.3;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.glitterSpeed;
      _emit.speedVariance = 0.7;
      _emit.spread = 1.0;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.08;
      _emit.sizeVariance = 0.6;
      _emit.life = c.glitterLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.glitter.emit(glitterCount, _emit);
    }

    const moteCount = Math.round(this.moteEmitter.tick(dt, c.moteRate * 0.55 * scale) * g.particleCount);
    if (moteCount > 0) {
      _emit.position = _pos;
      _emit.radius = c.pillarSpread * 0.9 + 0.2;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.moteSpeed * 1.1;
      _emit.speedVariance = 0.65;
      _emit.spread = 0.95;
      _emit.size = 0.07;
      _emit.life = c.moteLifetime;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0;
      _emit.time = time;
      this.motes.emit(moteCount, _emit);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    this._pillarReveal = 0;
    this._skyProgress = 0;
    const c = settings.holy;
    const charging = this.age < Math.max(0, c.charge);

    this._syncUniforms(1);

    if (charging) {
      // Park the light and FX on the hands while the clip winds up.
      this._handPoint(this.position);
      this._chargeFx(dt);
      this.ctx.shake.rumble(c.chargeShake * this.releaseCharge * settings.global.cameraShake, dt);
      return;
    }

    if (!this._muzzleFired) {
      this._muzzleFired = true;
      this._muzzleFx();
    }

    this._axisPoint(this.u, this.position);
    this._spearFx(dt, 1);
    this._groundFx();
    this.ctx.shake.rumble(c.rumble * settings.global.cameraShake, dt);
  }

  /** Soft build-up in the hands before the spear is released. */
  _chargeFx(dt) {
    const c = settings.holy;
    const g = settings.global;
    const charge = this.releaseCharge;
    if (charge < 0.08) return;

    this._handPoint(_pos);
    const moteCount = Math.round(this.moteEmitter.tick(dt, c.moteRate * 0.55 * charge) * g.particleCount);
    if (moteCount > 0) {
      _emit.position = _pos;
      _emit.radius = 0.12 + 0.1 * charge;
      _emit.direction = _dir.copy(this.direction).multiplyScalar(0.4).setY(0.5).normalize();
      _emit.speed = c.moteSpeed * 0.7;
      _emit.speedVariance = 0.5;
      _emit.spread = 0.7;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.06;
      _emit.sizeVariance = 0.5;
      _emit.life = c.moteLifetime * 0.7;
      _emit.lifeVariance = 0.35;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = frame.uTime.value;
      this.motes.emit(moteCount, _emit);
    }
  }

  onImpact() {
    const c = settings.holy;
    const g = settings.global;
    const time = frame.uTime.value;

    this._impactPoint(_pos);
    for (const mesh of this.rayMeshes) mesh.visible = true;
    for (const mesh of this.skyMeshes) mesh.visible = true;
    this._skyProgress = 0;

    // Storm shell + air shell stacked for a monument-sized hit.
    this.ctx.bursts.spawn(BurstMode.STORM, _pos, {
      radius: c.burstSize * 0.25,
      endRadius: c.burstSize * 1.35 * g.explosionIntensity,
      life: 0.95,
      intensity: c.burstIntensity * 1.25,
      opacity: 0.95,
      fresnel: 1.7,
      displace: 0.7,
      squash: 0.7,
      colorA: getColor(c.colorSkyBurstA),
      colorB: getColor(c.colorSkyBurstB),
      colorC: getColor(c.colorSkyBurstC)
    });

    this.ctx.bursts.spawn(BurstMode.AIR, _pos, {
      radius: c.burstSize * 0.2,
      endRadius: c.burstSize * g.explosionIntensity,
      life: 0.8,
      intensity: c.burstIntensity,
      opacity: 0.9,
      fresnel: 1.9,
      displace: 0.4,
      squash: 0.75,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    this.pointAt(1, _target);
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, _target, {
      radius: c.shockRadius * g.explosionIntensity,
      life: 0.9,
      width: 0.05,
      intensity: 1.15,
      colorA: getColor(c.colorShockA),
      colorB: getColor(c.colorShockB)
    });

    // Second wider ring — Glacial Crown footprint scale.
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, _target, {
      radius: c.shockRadius * 1.55 * g.explosionIntensity,
      life: 1.1,
      width: 0.035,
      intensity: 0.75,
      colorA: getColor(c.colorSkyOuter),
      colorB: getColor(c.colorSkyCore)
    });

    this.ctx.decals.spawn(DecalType.FROST, _target, {
      radius: c.brandRadius * 3.2,
      life: c.brandLife * 1.6,
      intensity: c.brandIntensity * 1.4,
      colorA: getColor(c.colorBrandA),
      colorB: getColor(c.colorBrandB),
      height: 0.014
    });

    this.ctx.decals.spawn(DecalType.DUSTRING, _target, {
      radius: c.brandRadius * 2.6,
      life: c.brandLife,
      intensity: c.brandIntensity * 0.75,
      colorA: getColor(c.colorBrandB),
      colorB: getColor(c.colorBrandA),
      height: 0.012
    });

    // Electric burn plate under the skybolt — reads as the strike grounding out.
    this.ctx.decals.spawn(DecalType.ARC, _target, {
      radius: c.skyArcRadius,
      life: c.skyArcLife,
      width: c.skyArcBranches,
      intensity: c.skyArcIntensity,
      colorA: getColor(c.colorSkyEmber),
      colorB: getColor(c.colorSkyArc)
    });
    this.ctx.decals.spawn(DecalType.ARC, _target, {
      radius: c.skyArcRadius * 1.7,
      life: c.skyArcLife * 1.2,
      width: c.skyArcBranches * 0.85,
      intensity: c.skyArcIntensity * 0.7,
      colorA: getColor(c.colorSkyEmber),
      colorB: getColor(c.colorSkyArc)
    });

    _emit.position = _pos;
    _emit.radius = Math.max(0.5, c.skySpread * 0.9);
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.glitterSpeed * 2.0;
    _emit.speedVariance = 0.85;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = 0.14;
    _emit.sizeVariance = 0.75;
    _emit.life = c.glitterLifetime * 1.4;
    _emit.lifeVariance = 0.55;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.glitter.emit(Math.round(c.burstGlitter * g.particleCount), _emit);
    this.sparks.emit(Math.round(c.burstSparks * g.particleCount), _emit);
    this.motes.emit(Math.round(c.burstMotes * g.particleCount), _emit);

    // Extra radial spark burst when judgment lands.
    _emit.direction = _dir.set(0, 0.35, 0).normalize();
    _emit.speed = c.sparkSpeed * 2.4;
    _emit.spread = 1.0;
    _emit.size = 0.18;
    _emit.life = c.sparkLifetime * 1.6;
    this.sparks.emit(Math.round(c.skyBurstSparks * g.particleCount), _emit);

    this.ctx.shake.add(
      c.impactShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      28
    );
    this.ctx.flash.trigger(getColor(c.colorFlash), c.impactFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 2.2 * g.explosionIntensity;
  }

  onFade(dt, t) {
    const c = settings.holy;
    // t: 0..1 hold, 1..2 fade-out
    const hold = t <= 1;
    const fade = hold ? 1 : 1 - Easing.inCubic(saturate(t - 1));

    if (hold) {
      const snap = Math.max(0.02, c.pillarSnap);
      this._pillarReveal = Easing.outCubic(saturate(this.impactTime / snap));

      // Skybolt crashes down fast, then holds full while restriking.
      const strike = Math.max(0.02, c.skyStrikeTime);
      this._skyProgress = Easing.outCubic(saturate(this.impactTime / strike));
    } else {
      this._pillarReveal = fade;
      this._skyProgress = fade > 0.001 ? 1 : 0;
    }

    this._syncUniforms(fade);
    this._axisPoint(1, this.position);

    this._spearFx(dt, fade * (hold ? 0.45 : 0.2));
    this._pillarFx(dt, fade * (hold ? 1 : 0.4));
    this._skyFx(dt, fade * (hold ? 1 : 0.35));

    if (hold) {
      this.ctx.shake.rumble(c.holdShake * settings.global.cameraShake, dt);
    }
  }

  /** Sparks and motes shed along the live skybolt while it stands. */
  _skyFx(dt, scale) {
    if (this._skyProgress < 0.08) return;
    const c = settings.holy;
    const g = settings.global;
    const time = frame.uTime.value;

    let sparkCount = Math.round(this.skySparkEmitter.tick(dt, c.skySparkRate * scale) * g.particleCount);
    if (sparkCount > 0) {
      _emit.direction = _dir.set(0, -0.2, 0).normalize();
      _emit.speed = c.sparkSpeed * 1.4;
      _emit.speedVariance = 0.9;
      _emit.spread = 1.0;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = 0.14;
      _emit.sizeVariance = 0.7;
      _emit.life = c.sparkLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;

      const batches = Math.min(sparkCount, SPARK_BATCHES);
      const per = Math.ceil(sparkCount / batches);
      while (sparkCount > 0) {
        const s = randRange(0.05, Math.max(0.08, this._skyProgress));
        // Point along sky → ground axis.
        this._skyPoint(_skyOrigin);
        this._skyGround(_target);
        _pos.lerpVectors(_skyOrigin, _target, s);
        _emit.position = _pos;
        _emit.radius = lerp(c.skySpreadNear, c.skySpread, s) * 1.2 + 0.08;
        this.sparks.emit(Math.min(per, sparkCount), _emit);
        sparkCount -= per;
      }
    }
  }

  onDestroy() {
    this._strandCount = 1;
    this._rayCount = 1;
    this._skyCount = 1;
    this._pillarReveal = 0;
    this._skyProgress = 0;
    this.spearGeometry.instanceCount = 1;
    this.rayGeometry.instanceCount = 1;
    this.skyGeometry.instanceCount = 1;
    for (const material of this.spearMaterials) material.uniforms.uFade.value = 0;
    for (const material of this.rayMaterials) {
      material.uniforms.uFade.value = 0;
      material.uniforms.uReveal.value = 0;
    }
    for (const material of this.skyMaterials) {
      material.uniforms.uFade.value = 0;
      material.uniforms.uProgress.value = 0;
    }
    for (const mesh of this.rayMeshes) mesh.visible = false;
    for (const mesh of this.skyMeshes) mesh.visible = false;
  }

  dispose() {
    this.spearGeometry.dispose();
    this.rayGeometry.dispose();
    this.skyGeometry.dispose();
    for (const material of this.spearMaterials) material.dispose();
    for (const material of this.rayMaterials) material.dispose();
    for (const material of this.skyMaterials) material.dispose();
    super.dispose();
  }
}
