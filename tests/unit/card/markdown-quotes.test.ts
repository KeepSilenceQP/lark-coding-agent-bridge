import { createLarkChannel } from '@larksuite/channel';
import { describe, expect, it, vi } from 'vitest';
import { preserveListQuoteContent } from '../../../src/card/markdown-quotes.js';
import { renderCard } from '../../../src/card/run-renderer.js';
import { initialState, reduce } from '../../../src/card/run-state.js';
import { renderText } from '../../../src/card/text-renderer.js';

const original = [
  '1. Mobile Use 操作 guide：',
  '',
  '   > 每次调用 `mobile_use__do_action` 都必须传 `display_text`。',
  '',
  '2. Fornax 工具 Schema：',
  '   - `required` 只有 `action`',
].join('\n');
const safe = original.replace('   > ', '   ');

describe('CardKit list quote content preservation', () => {
  it('keeps the reported sentence as a list paragraph', () => {
    expect(preserveListQuoteContent(original)).toBe(safe);
    expect(preserveListQuoteContent(safe)).toBe(safe);
  });

  it('handles same-line quotes, nested lists, multiple quote levels and lazy continuation', () => {
    const source = '- > first\n  > > second\n  > continuation\n  lazy continuation\n\n  - > third';
    expect(preserveListQuoteContent(source)).toBe(
      '- first\n  second\n  continuation\n  lazy continuation\n\n  - third',
    );
  });

  it('keeps outer quote markers when a quoted list contains another quote', () => {
    const source = '> root\n> - guide\n>   > nested\n>   > next';
    expect(preserveListQuoteContent(source)).toBe('> root\n> - guide\n>   nested\n>   next');
  });

  it.each([
    '> standalone\n> continued\n\n> > nested standalone',
    '   > an indented top-level quote',
    '```md\n1. example\n\n   > literal\n```',
    '~~~md\n- > literal\n~~~',
    '1. Code:\n\n   ```md\n   > literal\n   ```',
    '1. Code:\n\n       > indented code',
    '- `> inline code` and a > b\n\n\\> escaped',
    '```md\n- > incomplete streamed code fence',
  ])('does not rewrite quote-like content in %j', (source) => {
    expect(preserveListQuoteContent(source)).toBe(source);
  });

  it('removes only quote container syntax around code, leaving the code payload unchanged', () => {
    const source = '- guide\n\n  > ```md\n  > > literal\n  > ```\n  > [docs](https://example.com)';
    expect(preserveListQuoteContent(source)).toBe(
      '- guide\n\n  ```md\n  > literal\n  ```\n  [docs](https://example.com)',
    );
  });

  it('preserves tabs, CRLF and unicode content', () => {
    expect(preserveListQuoteContent('- guide\r\n\r\n\t> 中文😀\r\n')).toBe(
      '- guide\r\n\r\n\t中文😀\r\n',
    );
  });

  it('uses the same fallback for partial streaming text, completed text and cards without changing agent state', () => {
    let state = initialState;
    for (const delta of [original.slice(0, 45), original.slice(45)]) {
      state = reduce(state, { type: 'text', delta });
      expect(renderText(state)).not.toContain('   >');
    }
    state = reduce(state, { type: 'done', terminationReason: 'normal' });
    expect(renderText(state)).toBe(safe);
    const card = renderCard(state) as { body: { elements: Array<{ content: string }> } };
    expect(card.body.elements[0]?.content).toBe(safe);
    expect(state.blocks[0]).toMatchObject({ content: original });
  });

  it('handles reasoning while leaving tool output code examples intact', () => {
    let state = reduce(initialState, { type: 'thinking', delta: original });
    state = reduce(state, { type: 'tool_use', id: 't1', name: 'Read', input: {} });
    state = reduce(state, { type: 'tool_result', id: 't1', output: original, isError: false });
    const card = renderCard(state) as {
      body: { elements: Array<{ elements?: Array<{ content: string }> }> };
    };
    expect(card.body.elements[0]?.elements?.[0]?.content).toBe(safe);
    expect(card.body.elements[1]?.elements?.[0]?.content).toContain(original);
  });

  it('passes the preserved text through the real SDK markdown stream', async () => {
    const channel = createLarkChannel({ appId: 'test', appSecret: 'test' });
    const raw = channel.rawClient;
    vi.spyOn(raw.cardkit.v1.card, 'create').mockResolvedValue({ code: 0, data: { card_id: 'card_1' } });
    vi.spyOn(raw.im.v1.message, 'reply').mockResolvedValue({ code: 0, data: { message_id: 'om_1' } });
    vi.spyOn(raw.cardkit.v1.card, 'settings').mockResolvedValue({ code: 0 });
    const content = vi.spyOn(raw.cardkit.v1.cardElement, 'content').mockResolvedValue({ code: 0 });
    const state = reduce(initialState, { type: 'text', delta: original });
    await channel.stream('oc_test', {
      markdown: async (controller) => {
        await controller.setContent(renderText(state));
        await controller.setContent(renderText(reduce(state, { type: 'done', terminationReason: 'normal' })));
      },
    }, { replyTo: 'om_parent' });
    expect(content).toHaveBeenCalled();
    expect(content.mock.calls.at(-1)?.[0]?.data?.content).toBe(safe);
  });
});
