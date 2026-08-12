import { MeshStandardMaterial, Color } from 'three';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * Solid holy spear — metal + emissive glow, not a ribbon shader.
 *
 * Built on MeshStandardMaterial so the weapon takes stage lights and shadows.
 * That is what sells "summoned object" over "energy beam": a beam has no
 * silhouette under a key light; a spear does.
 *
 * @param {import('../world/Environment.js').Environment} [environment]
 */
export function createHolySpearMaterial(environment) {
  const material = new MeshStandardMaterial({
    color: 0xffe08a,
    emissive: 0xffc04a,
    emissiveIntensity: 1.4,
    metalness: 0.72,
    roughness: 0.28,
    flatShading: false,
    transparent: false,
    depthWrite: true
  });

  if (environment?.registerShadowCaster) {
    environment.registerShadowCaster(material);
  }

  /**
   * Push live palette / glow. Called every frame, including while paused.
   * @param {number} [glowScale=1] 0..1+ dim during charge / fade
   */
  material.userData.sync = (glowScale = 1) => {
    const c = settings.holy;
    const g = settings.global;
    material.color.copy(getColor(c.colorSpearBody));
    material.emissive.copy(getColor(c.colorSpearGlow));
    material.emissiveIntensity = c.spearEmissive * glowScale * g.glow;
    material.metalness = c.spearMetalness;
    material.roughness = c.spearRoughness;
    material.opacity = 1;
    material.transparent = false;
  };

  return material;
}

/**
 * Soft additive aura around the solid spear — thin halo so it still reads as
 * holy without becoming a beam. Separate mesh, slightly larger scale.
 */
export function createHolySpearAuraMaterial() {
  const material = new MeshStandardMaterial({
    color: 0xffd27a,
    emissive: 0xffd27a,
    emissiveIntensity: 2.2,
    metalness: 0,
    roughness: 1,
    transparent: true,
    opacity: 0.35,
    depthWrite: false
  });

  material.userData.sync = (glowScale = 1) => {
    const c = settings.holy;
    const g = settings.global;
    material.emissive.copy(getColor(c.colorSpearGlow));
    material.color.copy(getColor(c.colorSpearGlow));
    material.emissiveIntensity = c.spearAura * 2.4 * glowScale * g.glow;
    material.opacity = Math.min(0.55, c.spearAura * 0.4 * glowScale * g.opacity);
  };

  return material;
}
