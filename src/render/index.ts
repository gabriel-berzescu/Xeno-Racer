/**
 * Render module public API (owner: render). Matches src/core/systems.ts exactly:
 *   createRenderSystem(canvas, graphics) -> RenderSystem
 *   createEffects(render, track, quality) -> EffectsSystem
 *   createCameraRig(track, tvCameras)     -> CameraRig
 *
 * Other modules must import from here only, never from the files behind it.
 */
export { createCameraRig } from './cameraRig';
export { createDrivingLine, LINE_LAYERS, type DrivingLine, type LineSource } from './drivingLine';
export { createEffects } from './effects';
export { createRenderSystem } from './renderSystem';
export { lightningStrength } from './environment';
// the render system with the extras the base contract does not list: lightning(), precompile(), stats, debug hooks
export type { XenoRenderSystem, ViewSpec } from './renderSystem';
export type { MirrorFrame } from './mirrors';
