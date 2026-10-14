/** Minimal typings for the untyped `n8ao` package (the parts the render module uses). */
declare module 'n8ao' {
  import type { Pass } from 'postprocessing';
  import type { Camera, Color, Scene } from 'three';

  export interface N8AOConfiguration {
    aoSamples: number;
    aoRadius: number;
    aoTones: number;
    denoiseSamples: number;
    denoiseRadius: number;
    distanceFalloff: number;
    intensity: number;
    denoiseIterations: number;
    renderMode: number;
    color: Color;
    gammaCorrection: boolean;
    screenSpaceRadius: boolean;
    halfRes: boolean;
    depthAwareUpsampling: boolean;
    colorMultiply: boolean;
    transparencyAware: boolean;
    accumulate: boolean;
    neuralDenoise: boolean;
    [key: string]: unknown;
  }

  export class N8AOPostPass extends Pass {
    constructor(scene: Scene, camera: Camera, width?: number, height?: number);
    scene: Scene;
    camera: Camera;
    autosetGamma: boolean;
    autoDetectTransparency: boolean;
    configuration: N8AOConfiguration;
    setQualityMode(mode: 'Performance' | 'Low' | 'Medium' | 'High' | 'Ultra' | 'Neural-Low' | 'Neural-Medium' | 'Neural-High'): void;
    setDisplayMode(mode: 'Combined' | 'AO' | 'No AO' | 'Split' | 'Split AO'): void;
  }
}
