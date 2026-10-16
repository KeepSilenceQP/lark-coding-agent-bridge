import { parse, postprocess, preprocess } from 'micromark';

/**
 * CardKit silently drops blockquotes inside lists (including on static card
 * creation). Render those quotes as ordinary list content instead. Only remove
 * parsed quote prefixes: regexes also hit Markdown examples and shell input in
 * fenced/indented code. The agent's stored Markdown is never modified.
 */
export function preserveListQuoteContent(markdown: string): string {
  if (!markdown.includes('>')) return markdown;

  const events = postprocess(parse().document().write(preprocess()(markdown, undefined, true)));
  const quotes: boolean[] = [];
  const removals: Array<[number, number]> = [];
  let lists = 0;
  let prefixLine = 0;
  let prefixIndex = 0;

  for (const [event, token] of events) {
    if (token.type === 'listOrdered' || token.type === 'listUnordered') {
      lists += event === 'enter' ? 1 : -1;
    } else if (token.type === 'blockQuote') {
      if (event === 'enter') quotes.push(lists > 0);
      else quotes.pop();
    } else if (event === 'enter' && token.type === 'blockQuotePrefix') {
      // Container prefixes interleave on continuation lines: an outer quote's
      // prefix can occur while an inner quote is still open. Match prefixes
      // from left to right to their quote depth, rather than using stack.top.
      if (token.start.line !== prefixLine) {
        prefixLine = token.start.line;
        prefixIndex = 0;
      }
      if (quotes[prefixIndex]) removals.push([token.start.offset, token.end.offset]);
      prefixIndex++;
    }
  }

  let cursor = 0;
  const parts: string[] = [];
  for (const [start, end] of removals) {
    parts.push(markdown.slice(cursor, start));
    cursor = end;
  }
  parts.push(markdown.slice(cursor));
  return parts.join('');
}
