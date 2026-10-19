import type { BodyStyle } from '../../core/contracts';
import type { BlueprintFactory } from '../blueprint';
import { makeCoupe } from './coupe';
import { makeGT } from './gt';
import { makeHatch } from './hatch';
import { makePrototype } from './prototype';
import { makeSuv } from './suv';

export const BLUEPRINTS: Record<BodyStyle, BlueprintFactory> = {
  gt: makeGT,
  hatch: makeHatch,
  coupe: makeCoupe,
  prototype: makePrototype,
  suv: makeSuv,
};
