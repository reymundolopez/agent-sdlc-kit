#!/usr/bin/env node
import { readStdinJson, evaluatePostToolUse } from '../../lib/hooks.mjs';

const payload = await readStdinJson();
const out = evaluatePostToolUse(payload);
process.stdout.write(JSON.stringify(out) + '\n');
