/**
 * Render module public API (owner: render). Matches src/core/systems.ts exactly:
 *   createRenderSystem(canvas, graphics) -> RenderSystem
 *   createEffects(render, track, quality) -> EffectsSystem
 *   createCameraRig(track, tvCameras)     -> CameraRig
 *
 * Other modules must import from here only, never from the files behind it.
 */
export { createCameraRig } from './cameraRig';
export { createEffects } from './effects';
export { createRenderSystem } from './renderSystem';
