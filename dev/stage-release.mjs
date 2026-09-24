#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { stageRelease } from '../lib/releases.mjs';
const { values } = parseArgs({ options: { source: { type: 'string' }, destination: { type: 'string' } } });
console.log(JSON.stringify(stageRelease(values), null, 2));
