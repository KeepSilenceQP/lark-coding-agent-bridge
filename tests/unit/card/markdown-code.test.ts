import { createLarkChannel } from '@larksuite/channel';
import { micromark, parse, postprocess, preprocess } from 'micromark';
import { describe, expect, it, vi } from 'vitest';
import { preserveListCodeContent } from '../../../src/card/markdown-code.js';
import { renderCard } from '../../../src/card/run-renderer.js';
import { initialState, reduce } from '../../../src/card/run-state.js';
import { renderText } from '../../../src/card/text-renderer.js';

const reported = [
  '2. Read the revision',
  '   Equivalent to:',
  '',
  '   ```sql',
  '   SELECT revision',
  '   FROM state_revision;',
  '   ```',
  '',
  '3. Compare the revision',
].join('\n');

function codeBlocks(markdown: string): Array<{ inList: boolean; value: string; info?: string }> {
  const events = postprocess(parse().document().write(preprocess()(markdown, undefined, true)));
  const result: ReturnType<typeof codeBlocks> = [];
  let lists = 0;
  let block: ReturnType<typeof codeBlocks>[number] | undefined;
  for (const [event, token, context] of events) {
    if (token.type === 'listOrdered' || token.type === 'listUnordered') lists += event === 'enter' ? 1 : -1;
    if (token.type === 'codeFenced' || token.type === 'codeIndented') {
      if (event === 'enter') block = { inList: lists > 0, value: '' };
      else if (block) { result.push(block); block = undefined; }
    }
    if (event !== 'enter' || !block) continue;
    if (token.type === 'codeFlowValue') block.value += context.sliceSerialize(token) + '\n';
    if (token.type === 'codeFencedFenceInfo') block.info = context.sliceSerialize(token);
  }
  return result;
}

describe('CardKit list code content preservation', () => {
  it('keeps the reported SQL outside a list and retains explicit numbering', () => {
    const safe = preserveListCodeContent(reported);
    expect(safe).toContain('2\\. Read the revision');
    expect(safe).toContain('3\\. Compare the revision');
    expect(safe).toContain('```sql\nSELECT revision\nFROM state_revision;\n```');
    expect(codeBlocks(safe)).toEqual([{ inList: false, value: 'SELECT revision\nFROM state_revision;\n', info: 'sql' }]);
    expect(preserveListCodeContent(safe)).toBe(safe);
  });

  it.each([
    '- outer\n  - inner\n\n    ~~~~md\n    ```literal\n    - > example\n      keep indent\n    ~~~~\n\n    continuation\n\n      deeper paragraph\n\n  after\n\n- next',
    '12. outer\n\n    4. inner\n\n       ```ts\n       if (x) {\n         y();\n       }\n       ```\n\n       continuation\n\n    5. next',
    '> 2. quoted list\n>\n>    ```sql\n>    SELECT 1;\n>    ```\n>\n>    continued\n>\n> 3. next',
    '- ```sql\n  SELECT 1;\n  ```\n\n- next',
    '> - ```sql\n>   SELECT 1;\n>   ```',
    '- code\n\n      ```literal\n        nested indentation\n      last\n\n  continuation',
    '- code\r\n\r\n  ```sql\r\n  SELECT 1;\r\n  ```\r\n\r\n  continued',
    '- code\n\n\t```sql\n\tSELECT 1;\n\t```',
    '- code\n\n\t\tSELECT 1;',
    '> - code\n>\n>       SELECT 1;',
    '- before\n\n  ```sql\n  SELECT 1;\n\n- next',
    '- before\n\n  ```sql\n  SELECT 1;\n',
    '- before\n\n  ```sql\n  SELECT 1;',
    '- before\n\n  ```sql\n',
    '- before\n\n  ```sql',
  ])('preserves code payload and does not create accidental continuation code in %j', (source) => {
    const original = codeBlocks(source);
    expect(original.length).toBeGreaterThan(0);
    const safe = preserveListCodeContent(source);
    const actual = codeBlocks(safe);
    expect(actual.map(({ value, info }) => ({ value, info }))).toEqual(original.map(({ value, info }) => ({ value, info })));
    expect(actual.every((block) => !block.inList)).toBe(true);
    const codeHtml = (value: string) => Array.from(micromark(value).matchAll(/<pre><code[^>]*>([\s\S]*?)<\/code><\/pre>/g), (match) => match[1]);
    expect(codeHtml(safe)).toEqual(codeHtml(source));
    expect(preserveListCodeContent(safe)).toBe(safe);
  });

  it('closes an incomplete fence before the following list item without swallowing it', () => {
    const source = '- before\n\n  ```sql\n  SELECT 1;\n\n- next';
    const safe = preserveListCodeContent(source);
    expect(safe).toContain('```sql\nSELECT 1;\n\n\n```\n\\- next');
    expect(codeBlocks(safe)).toEqual([{ inList: false, value: 'SELECT 1;\n', info: 'sql' }]);
  });

  it('retains exact internal blank lines, spaces and literal tabs in fenced code', () => {
    const source = '- code\n\n  ```text\n  first\n\n    second\tvalue\n  \tthird\n  ```';
    expect(preserveListCodeContent(source)).toContain('```text\nfirst\n\n  second\tvalue\n\tthird\n```');
  });

  it('retains exact code whitespace while wrapping indented code in a safe fence', () => {
    const source = '- code\n\n      first\n\n        second\tvalue\n      \tthird\n      ```literal';
    expect(preserveListCodeContent(source)).toContain('````\nfirst\n\n  second\tvalue\n\tthird\n```literal\n````');
  });

  it.each([
    '```md\n1. item\n\n   ```example\n   > literal\n```',
    '~~~md\n- code\n\n    literal\n~~~',
    '> top-level quote\n>\n> ```sql\n> SELECT 1;\n> ```',
    '1. simple\n   continuation\n2. another\n\n- nested\n  - child',
    '    top-level indented code\n      indentation',
    '- inline `code` and `> quote`',
  ])('leaves unrelated Markdown unchanged in %j', (source) => {
    expect(preserveListCodeContent(source)).toBe(source);
  });

  it('preserves partial streaming code, renderers, and the original agent state', () => {
    let state = initialState;
    for (const delta of [reported.slice(0, 64), reported.slice(64)]) {
      state = reduce(state, { type: 'text', delta });
      expect(codeBlocks(renderText(state)).every((block) => !block.inList)).toBe(true);
    }
    state = reduce(state, { type: 'done', terminationReason: 'normal' });
    const safe = preserveListCodeContent(reported);
    expect(renderText(state)).toBe(safe);
    const card = renderCard(state) as { body: { elements: Array<{ content: string }> } };
    expect(card.body.elements[0]?.content).toBe(safe);
    expect(state.blocks[0]).toMatchObject({ content: reported });
  });

  it('sends the preserved code through the real SDK stream', async () => {
    const channel = createLarkChannel({ appId: 'test', appSecret: 'test' });
    const raw = channel.rawClient;
    vi.spyOn(raw.cardkit.v1.card, 'create').mockResolvedValue({ code: 0, data: { card_id: 'card_1' } });
    vi.spyOn(raw.im.v1.message, 'reply').mockResolvedValue({ code: 0, data: { message_id: 'om_1' } });
    vi.spyOn(raw.cardkit.v1.card, 'settings').mockResolvedValue({ code: 0 });
    const content = vi.spyOn(raw.cardkit.v1.cardElement, 'content').mockResolvedValue({ code: 0 });
    const state = reduce(reduce(initialState, { type: 'text', delta: reported }), { type: 'done', terminationReason: 'normal' });
    await channel.stream('oc_test', { markdown: async (controller) => { await controller.setContent(renderText(state)); } }, { replyTo: 'om_parent' });
    const sent = content.mock.calls.at(-1)?.[0]?.data?.content;
    expect(sent).toBe(preserveListCodeContent(reported));
    expect(codeBlocks(sent!)).toEqual([{ inList: false, value: 'SELECT revision\nFROM state_revision;\n', info: 'sql' }]);
  });
});
