#!/usr/bin/env node
import { readStdinJson, evaluateSessionStart } from '../../lib/hooks.mjs';

const payload = await readStdinJson();
const out = evaluateSessionStart(payload);
process.stdout.write(JSON.stringify(out) + '\n');
