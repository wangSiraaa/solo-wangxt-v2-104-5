/**
 * Rendering-intent names, shared by the WASM wrapper (lcms.ts), the settings
 * record and the handoff package format. Kept free of any WASM imports so
 * pure modules (and Node tests) can validate intents without LittleCMS.
 */
export type RenderingIntent =
  | 'perceptual'
  | 'relative-colorimetric'
  | 'saturation'
  | 'absolute-colorimetric';

export const RENDERING_INTENTS: RenderingIntent[] = [
  'perceptual',
  'relative-colorimetric',
  'saturation',
  'absolute-colorimetric',
];
