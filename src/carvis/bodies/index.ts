import type { BodyStyle } from '../../core/contracts';
import type { BlueprintFactory } from '../blueprint';
import { makeCoupe } from './coupe';
import { makeFormula } from './formula';
import { makeFormula04 } from './formula04';
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
  // (a single-seater of 2004, CarVisualSpec.formulaEra, has a body of its own; the Volta's 2026 car, no era, the one it always had)
  formula: (s) => (s.formulaEra === 2004 ? makeFormula04(s) : makeFormula(s)),
  // (the hypercar's own body is still to come: until then it is drawn with the prototype's at its own sizes)
  hyper: makePrototype,
};
