#!/usr/bin/env node
import { readStdinJson, evaluatePreToolUse } from '../../lib/hooks.mjs';

const payload = await readStdinJson();
const out = evaluatePreToolUse(payload);
process.stdout.write(JSON.stringify(out) + '\n');
