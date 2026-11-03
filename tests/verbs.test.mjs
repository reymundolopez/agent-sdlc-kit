import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseIssueMarkdown } from '../lib/verbs.mjs';

describe('agent-sdlc-kit Verbs & AC Parser Unit Suite', () => {
  it('extracts checkbox acceptance criteria when present', () => {
    const body = `
## Summary
Some overview.

## Acceptance Criteria
- [ ] Cart drawer displays discount toggle
- [x] WhatsApp message includes slogan
- [ ] 30-day payment term default
`;
    const res = parseIssueMarkdown('Feature title', body);
    assert.strictEqual(res.acceptanceCriteria.length, 3);
    assert.strictEqual(res.acceptanceCriteria[0], 'Cart drawer displays discount toggle');
    assert.strictEqual(res.acceptanceCriteria[1], 'WhatsApp message includes slogan');
    assert.strictEqual(res.acceptanceCriteria[2], '30-day payment term default');
  });

  it('extracts bullet points and numbered lists when checkboxes are absent', () => {
    const body = `
Here is feedback from the user:

• User want to be able to load the local version using tailscale
• On http://localhost:5173/caja
  • What is the purpose of the buttons: Todos, Vestidos, Tops
  • The client selection is not clear
  • Remove Simular Venta Rapida
1. First numbered requirement
2. Second numbered requirement
`;
    const res = parseIssueMarkdown('Issue Title', body);
    assert.ok(res.acceptanceCriteria.length >= 6);
    assert.ok(res.acceptanceCriteria.some(ac => ac.includes('load the local version using tailscale')));
    assert.ok(res.acceptanceCriteria.some(ac => ac.includes('What is the purpose of the buttons')));
    assert.ok(res.acceptanceCriteria.some(ac => ac.includes('First numbered requirement')));
  });

  it('extracts target files mentioned in backticks', () => {
    const body = `
Please modify \`apps/spirit/src/components/CajaView.tsx\` and \`apps/backend/src/main.ts\`.
`;
    const res = parseIssueMarkdown('Target Files Test', body);
    assert.ok(res.targetFiles.includes('apps/spirit/src/components/CajaView.tsx'));
    assert.ok(res.targetFiles.includes('apps/backend/src/main.ts'));
  });
});
