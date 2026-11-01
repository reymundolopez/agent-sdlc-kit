#!/usr/bin/env node
import { readStdinJson, evaluatePreInvocation } from '../../lib/hooks.mjs';

const payload = await readStdinJson();
const out = evaluatePreInvocation(payload);
process.stdout.write(JSON.stringify(out) + '\n');
