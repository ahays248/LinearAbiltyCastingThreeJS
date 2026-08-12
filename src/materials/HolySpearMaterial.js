import { MeshStandardMaterial, Color } from 'three';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * Dark forged body of the holy spear — cold metal that takes stage lights.
 * Hot menace lives on the edge material and the aura, not as a soft gold pipe.
 *
 * @param {import('../world/Environment.js').Environment} [environment]
 */
export function createHolySpearMaterial(environment) {
  const material = new MeshStandardMaterial({
    color: 0x2a2420,
    emissive: 0x4a3010,
    emissiveIntensity: 0.35,
    metalness: 0.88,
    roughness: 0.38,
    flatShading: true,
    transparent: false,
    depthWrite: true
  });

  if (environment?.registerShadowCaster) {
    environment.registerShadowCaster(material);
  }

  /**
   * @param {number} [glowScale=1]
   * @param {number} [pulse=1] extra menace pulse during summon (1 = calm)
   */
  material.userData.sync = (glowScale = 1, pulse = 1) => {
    const c = settings.holy;
    const g = settings.global;
    material.color.copy(getColor(c.colorSpearBody));
    material.emissive.copy(getColor(c.colorSpearEmber));
    material.emissiveIntensity = c.spearEmissive * 0.35 * glowScale * pulse * g.glow;
    material.metalness = c.spearMetalness;
    material.roughness = c.spearRoughness;
  };

  return material;
}

/**
 * Hot edge / blade / barb material — white-hot menace on a dark body.
 */
export function createHolySpearEdgeMaterial(environment) {
  const material = new MeshStandardMaterial({
    color: 0xffe8b0,
    emissive: 0xffaa33,
    emissiveIntensity: 2.4,
    metalness: 0.55,
    roughness: 0.22,
    flatShading: true,
    transparent: false,
    depthWrite: true
  });

  if (environment?.registerShadowCaster) {
    environment.registerShadowCaster(material);
  }

  material.userData.sync = (glowScale = 1, pulse = 1) => {
    const c = settings.holy;
    const g = settings.global;
    material.color.copy(getColor(c.colorSpearEdge));
    material.emissive.copy(getColor(c.colorSpearGlow));
    material.emissiveIntensity = c.spearEdgeEmissive * glowScale * pulse * g.glow;
    material.metalness = Math.max(0.2, c.spearMetalness * 0.7);
    material.roughness = Math.max(0.12, c.spearRoughness * 0.7);
  };

  return material;
}

/**
 * Soft additive aura — thicker and hotter during summon pulse so the weapon
 * reads as cursed light, not a friendly glowstick.
 */
export function createHolySpearAuraMaterial() {
  const material = new MeshStandardMaterial({
    color: 0xff9020,
    emissive: 0xff7010,
    emissiveIntensity: 2.8,
    metalness: 0,
    roughness: 1,
    transparent: true,
    opacity: 0.28,
    depthWrite: false,
    flatShading: true
  });

  material.userData.sync = (glowScale = 1, pulse = 1) => {
    const c = settings.holy;
    const g = settings.global;
    material.emissive.copy(getColor(c.colorSpearGlow));
    material.color.copy(getColor(c.colorSpearGlow));
    material.emissiveIntensity = c.spearAura * 2.8 * glowScale * pulse * g.glow;
    material.opacity = Math.min(0.62, c.spearAura * 0.38 * glowScale * pulse * g.opacity);
  };

  return material;
}
