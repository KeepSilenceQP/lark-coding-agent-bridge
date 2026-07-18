import { describe, expect, it } from 'vitest';

import { createPromptRedactor } from '../../../src/agent/prompt-redaction';

describe('prompt redaction', () => {
  it('redacts short lines from a multiline prompt when embedded in an error', () => {
    const redact = createPromptRedactor(['role\n密令']);

    expect(redact('failed while reading 密令')).toBe(
      'failed while reading [REDACTED_PROMPT]',
    );
  });
});
