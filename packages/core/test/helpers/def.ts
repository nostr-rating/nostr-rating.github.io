import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseGameDefinition } from '../../src/game/definition.js';

export const rawDef = JSON.parse(readFileSync(resolve(__dirname, '../../../../configs/smash_sp.json'), 'utf8'));
export const def = parseGameDefinition(rawDef);
