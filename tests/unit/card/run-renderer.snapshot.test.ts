import { describe, expect, it } from 'vitest';
import { renderCard } from '../../../src/card/run-renderer.js';
import {
  initialState,
  markIdleTimeout,
  markInterrupted,
  reduce,
  type RunState,
} from '../../../src/card/run-state.js';
import { renderText } from '../../../src/card/text-renderer.js';
import type { AgentEvent } from '../../../src/agent/types.js';
import { normalizeCard } from '../../helpers/card-normalize.js';

describe('run card renderer snapshots', () => {
  it('renders initial running state', () => {
    expectCard(initialState).toMatchSnapshot();
  });

  it('renders active and completed thinking', () => {
    expectCard(stateFrom([{ type: 'thinking', delta: 'checking options' }])).toMatchSnapshot();
    expectCard(stateFrom([
      { type: 'thinking', delta: 'checking options' },
      { type: 'text', delta: 'final answer' },
      { type: 'done', terminationReason: 'normal' },
    ])).toMatchSnapshot();
  });

  it('renders tool running, done, and error states', () => {
    expectCard(stateFrom([
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
    ])).toMatchSnapshot();

    expectCard(stateFrom([
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
      { type: 'tool_result', id: 'tool-1', output: '/repo', isError: false },
      { type: 'done', terminationReason: 'normal' },
    ])).toMatchSnapshot();

    expectCard(stateFrom([
      { type: 'tool_use', id: 'tool-2', name: 'Read', input: { file_path: '/missing.ts' } },
      { type: 'tool_result', id: 'tool-2', output: 'ENOENT', isError: true },
      { type: 'done', terminationReason: 'normal' },
    ])).toMatchSnapshot();
  });

  it('collapses consecutive tools while preserving the latest running tool', () => {
    expectCard(stateFrom([
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
      { type: 'tool_result', id: 'tool-1', output: '/repo', isError: false },
      { type: 'tool_use', id: 'tool-2', name: 'Read', input: { file_path: '/repo/a.ts' } },
      { type: 'tool_result', id: 'tool-2', output: 'a', isError: false },
      { type: 'tool_use', id: 'tool-3', name: 'Edit', input: { file_path: '/repo/a.ts' } },
    ])).toMatchSnapshot();

    expectCard(stateFrom([
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
      { type: 'tool_result', id: 'tool-1', output: '/repo', isError: false },
      { type: 'tool_use', id: 'tool-2', name: 'Read', input: { file_path: '/repo/a.ts' } },
      { type: 'tool_result', id: 'tool-2', output: 'a', isError: false },
      { type: 'tool_use', id: 'tool-3', name: 'Edit', input: { file_path: '/repo/a.ts' } },
      { type: 'tool_result', id: 'tool-3', output: 'ok', isError: false },
      { type: 'done', terminationReason: 'normal' },
    ])).toMatchSnapshot();
  });

  it('renders done, error, interrupted, and idle-timeout terminal states', () => {
    expectCard(stateFrom([{ type: 'done', terminationReason: 'normal' }])).toMatchSnapshot();
    expectCard(stateFrom([{ type: 'error', message: 'process failed', terminationReason: 'failed' }])).toMatchSnapshot();
    expectCard(markInterrupted(stateFrom([{ type: 'text', delta: 'partial' }]))).toMatchSnapshot();
    expectCard(markIdleTimeout(stateFrom([{ type: 'text', delta: 'partial' }]), 15)).toMatchSnapshot();
  });

  it('renders markdown text mode without card-only controls', () => {
    const state = stateFrom([
      { type: 'thinking', delta: 'hidden reasoning' },
      { type: 'text', delta: 'Answer' },
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
      { type: 'tool_result', id: 'tool-1', output: '/repo', isError: false },
      { type: 'text', delta: 'Done' },
    ]);

    expect(renderText(state)).toMatchSnapshot();
    expect(renderText(markInterrupted(state))).toMatchSnapshot();
    expect(renderText(markIdleTimeout(state, 10))).toMatchSnapshot();
    expect(renderText(stateFrom([{ type: 'error', message: 'process failed', terminationReason: 'failed' }]))).toMatchSnapshot();
  });

  it('injects signed bridge callback values for managed run controls', () => {
    const card = renderCard(initialState, {
      signCallback: (action) => `token-for-${action}`,
    }) as {
      body?: { elements?: Array<{ tag?: string; behaviors?: Array<{ value?: Record<string, unknown> }> }> };
    };
    const button = card.body?.elements?.find((element) => element.tag === 'button');

    expect(button?.behaviors?.[0]?.value).toEqual({
      cmd: 'stop',
      __bridge_cb: true,
      bridge_token: 'token-for-stop',
    });
  });

  it('keeps local paths in user-visible cards and text fallbacks', () => {
    const sensitivePath = '/Users/example/private/customer/repo/secret.txt';
    const state = stateFrom([
      { type: 'text', delta: `I read ${sensitivePath}` },
      { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: sensitivePath } },
      { type: 'tool_result', id: 'tool-1', output: `content from ${sensitivePath}`, isError: false },
      { type: 'done', terminationReason: 'normal' },
    ]);

    const card = JSON.stringify(renderCard(state));
    const text = renderText(state);
    expect(card).toContain(sensitivePath);
    expect(text).toContain(sensitivePath);
  });

  it('keeps web links clickable and renders local file links as paths', () => {
    const answer = [
      '[Web docs](https://example.com/docs?q=bridge)',
      '[Original sample](/Users/example/repo/AGENT_LOOP_GUIDE.md:412)',
      '[POSIX file](</Users/example/repo/Guide (draft).md:12>)',
      '[Titled spaced file](</Users/example/repo/Guide (draft).md:13> "source")',
      '[File URI](file:///Users/example/repo/src/main.ts)',
      '[Windows file](C:/repo/src/main.ts:7)',
      '[Titled file](/Users/example/repo/titled.ts "source")',
      '`[Inline example](/Users/example/repo/inline.ts:3)`',
      '`cross-line code',
      '[Cross-line example](/Users/example/repo/cross-line.ts:5)`',
      'still code`',
      '    [Indented example](/Users/example/repo/indented.ts:6)',
      '```markdown',
      '[Fenced example](/Users/example/repo/fenced.ts:4)',
      '```',
      'An unmatched ` stays literal.',
      '[After unmatched](/Users/example/repo/after-unmatched.ts:8)',
    ].join('\n');
    const state = stateFrom([
      { type: 'text', delta: answer },
      { type: 'done', terminationReason: 'normal' },
    ]);

    for (const rendered of [renderText(state), JSON.stringify(renderCard(state))]) {
      expect(rendered).toContain('[Web docs](https://example.com/docs?q=bridge)');
      expect(rendered).toContain('`/Users/example/repo/AGENT_LOOP_GUIDE.md:412`');
      expect(rendered).toContain('`/Users/example/repo/Guide (draft).md:12`');
      expect(rendered).toContain('`/Users/example/repo/Guide (draft).md:13`');
      expect(rendered).toContain('`/Users/example/repo/src/main.ts`');
      expect(rendered).toContain('`C:/repo/src/main.ts:7`');
      expect(rendered).toContain('`/Users/example/repo/titled.ts`');
      expect(rendered).toContain('`/Users/example/repo/after-unmatched.ts:8`');
      expect(rendered).not.toContain('[Original sample](');
      expect(rendered).not.toContain('[POSIX file](');
      expect(rendered).not.toContain('[Titled spaced file](');
      expect(rendered).not.toContain('[File URI](');
      expect(rendered).not.toContain('[Windows file](');
      expect(rendered).not.toContain('[Titled file](');
      expect(rendered).not.toContain('[After unmatched](');
      expect(rendered).toContain('`[Inline example](/Users/example/repo/inline.ts:3)`');
      expect(rendered).toContain('[Cross-line example](/Users/example/repo/cross-line.ts:5)');
      expect(rendered).toContain('[Indented example](/Users/example/repo/indented.ts:6)');
      expect(rendered).toContain('[Fenced example](/Users/example/repo/fenced.ts:4)');
    }
  });
});

function stateFrom(events: AgentEvent[]): RunState {
  return events.reduce((state, event) => reduce(state, event), initialState);
}

function expectCard(state: RunState) {
  return expect(normalizeCard(renderCard(state)));
}
