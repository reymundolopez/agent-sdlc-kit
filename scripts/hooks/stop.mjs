#!/usr/bin/env node
import { readStdinJson, evaluateStop } from '../../lib/hooks.mjs';

const payload = await readStdinJson();
const out = evaluateStop(payload);
process.stdout.write(JSON.stringify(out) + '\n');
