import { parse, postprocess, preprocess } from 'micromark';

type Token = ReturnType<typeof postprocess>[number][1];
interface Edit { start: number; end: number; text: string }

/**
 * CardKit silently omits code blocks nested in Markdown lists. Flatten only
 * lists containing code into ordinary labelled paragraphs, keeping their
 * explicit numbers/bullets, and render their code as independent fences.
 *
 * Flatten the whole affected container: moving only its fence leaves later
 * continuation paragraphs indented, which can turn them into accidental code.
 * Parsed tokens distinguish real container syntax from Markdown code examples.
 * The original agent state is never changed.
 */
export function preserveListCodeContent(markdown: string): string {
  if (!/`{3}|~{3}| {4}|\t/.test(markdown)) return markdown;
  const events = postprocess(parse().document().write(preprocess()(markdown, undefined, true)));
  const lists: Token[] = [];
  const affected = new Set<Token>();
  const code = new Set<Token>();
  for (const [event, token] of events) {
    if (isList(token)) {
      if (event === 'enter') lists.push(token);
      else lists.pop();
    } else if (event === 'enter' && isCode(token) && lists.length) {
      code.add(token);
      for (const list of lists) affected.add(list);
    }
  }
  if (!code.size) return markdown;

  const edits: Edit[] = [];
  let quoteDepth = 0;
  let prefixLine = 0;
  let prefixIndex = 0;
  let listPrefixLine = 0;
  let block: { token: Token; parts: string[]; fences: string[]; quoteDepth: number; sameLine: boolean } | undefined;
  for (const [event, token, context] of events) {
    if (isList(token)) {
      if (event === 'enter') lists.push(token);
      else lists.pop();
    } else if (token.type === 'blockQuote') {
      quoteDepth += event === 'enter' ? 1 : -1;
    }
    if (event === 'enter' && token.type === 'listItemPrefix') listPrefixLine = token.start.line;
    if (event === 'enter' && token.type === 'listItemIndent') {
      if (token.start.line !== prefixLine) { prefixLine = token.start.line; prefixIndex = 0; }
      const list = lists[prefixIndex++];
      if (!block && list && affected.has(list)) edits.push({ start: token.start.offset, end: token.end.offset, text: '' });
    }
    if (event === 'enter' && token.type === 'listItemMarker' && affected.has(lists.at(-1)!)) {
      edits.push({ start: token.start.offset, end: token.start.offset, text: '\\' });
    }
    if (event === 'enter' && code.has(token)) {
      block = { token, parts: [], fences: [], quoteDepth, sameLine: listPrefixLine === token.start.line };
    }
    if (!block) continue;
    if (event === 'enter') {
      if (token.type === 'codeFencedFence') {
        const fence = context.sliceSerialize(token);
        block.parts.push(fence);
        block.fences.push(fence);
      } else if (token.type === 'codeFlowValue') {
        block.parts.push(context.sliceSerialize(token));
      } else if (token.type === 'lineEnding' || token.type === 'lineEndingBlank') {
        // Container prefixes can be included in a lineEnding token's span.
        block.parts.push(markdown.slice(token.start.offset, token.end.offset).match(/^(?:\r\n|\r|\n)/)?.[0] ?? '');
      }
    }
    if (event === 'exit' && token === block.token) {
      const eol = markdown.includes('\r\n') ? '\r\n' : '\n';
      let rendered = block.parts.join('');
      if (token.type === 'codeIndented') {
        const longest = Math.max(2, ...Array.from(rendered.matchAll(/`+/g), (match) => match[0].length));
        const fence = '`'.repeat(longest + 1);
        rendered = `${fence}${eol}${rendered}${eol}${fence}`;
      } else if (block.fences.length === 1) {
        // A list can terminate an unclosed fence. Preserve its terminal code
        // line ending, but do not add a body line to an empty opener. Keep the
        // next source item off the newly inserted closing line.
        if (block.parts.length !== 2 || !/[\r\n]$/.test(rendered)) rendered += eol;
        rendered += block.fences[0]!.match(/^(?:`+|~+)/)![0];
        if (token.end.offset < markdown.length && !/^[\r\n]/.test(markdown.slice(token.end.offset))) rendered += eol;
      }
      const quotePrefix = '> '.repeat(block.quoteDepth);
      rendered = rendered.replace(/\r\n|\r|\n/g, (ending) => ending + quotePrefix);
      if (block.sameLine) rendered = `${eol}${quotePrefix}${eol}${quotePrefix}${rendered}`;
      edits.push({ start: token.start.offset, end: token.end.offset, text: rendered });
      block = undefined;
    }
  }

  let cursor = 0;
  const parts: string[] = [];
  for (const edit of edits.sort((a, b) => a.start - b.start)) {
    parts.push(markdown.slice(cursor, edit.start), edit.text);
    cursor = edit.end;
  }
  parts.push(markdown.slice(cursor));
  return parts.join('');
}

function isList(token: Token): boolean {
  return token.type === 'listOrdered' || token.type === 'listUnordered';
}

function isCode(token: Token): boolean {
  return token.type === 'codeFenced' || token.type === 'codeIndented';
}
