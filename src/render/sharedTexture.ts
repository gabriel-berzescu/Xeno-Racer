/**
 * A data texture that every material shares, not copies (owner: render).
 *
 * three builds the uniform table of a built-in material (MeshStandard, MeshPhysical, Lambert, ...) by cloning the one of its ShaderLib
 * entry (UniformsUtils.cloneUniforms), and clones every Texture it finds in it: a texture put into ShaderLib reaches each material as
 * a copy of its own, frozen at whatever the texture was then, and a later `needsUpdate` of the original is seen by none of them. That
 * is why the shared uniforms of shaderPatches.ts (the fog table, the cascades, the lamps) are typed arrays, which are copied by
 * reference. A texture that has to be shared (the sun visibility map, which a race swaps for another on the next circuit) answers
 * `clone()` with itself, so the table of every material points at the one object and whatever is written to it reaches them all.
 */
import { DataTexture } from 'three';

export class SharedDataTexture extends DataTexture {
  override clone(): this {
    return this;
  }
}
