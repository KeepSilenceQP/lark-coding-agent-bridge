/**
 * Codex surfaces understand Markdown links whose destination is an absolute
 * local path and open them in the local editor. Feishu/CardKit instead treats
 * a leading slash as a relative web URL, producing a broken HTTP link.
 *
 * Keep real links untouched, but render local-file destinations as copyable
 * inline-code paths. Code examples are deliberately left unchanged.
 */
export function renderLocalFileLinksAsPaths(markdown: string): string {
  const lines = markdown.split(/(\n)/);
  let fence: { marker: '`' | '~'; length: number } | undefined;
  let inlineCodeRun: number | undefined;

  return lines
    .map((line, index) => {
      if (line === '\n') return line;

      const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (fence) {
        if (
          fenceMatch &&
          fenceMatch[1]?.[0] === fence.marker &&
          fenceMatch[1].length >= fence.length
        ) {
          fence = undefined;
        }
        return line;
      }

      if (!inlineCodeRun && fenceMatch) {
        const marker = fenceMatch[1];
        if (marker) {
          fence = {
            marker: marker[0] as '`' | '~',
            length: marker.length,
          };
        }
        return line;
      }

      if (!inlineCodeRun && /^(?: {4}|\t)/.test(line)) return line;

      const startedOutsideInlineCode = !inlineCodeRun;
      const transformed = transformLine(line, inlineCodeRun);
      inlineCodeRun = transformed.inlineCodeRun;
      if (
        startedOutsideInlineCode &&
        inlineCodeRun &&
        !hasMatchingBacktickRun(lines, index + 1, inlineCodeRun)
      ) {
        inlineCodeRun = undefined;
      }
      return transformed.output;
    })
    .join('');
}

function transformLine(
  line: string,
  initialInlineCodeRun?: number,
): { output: string; inlineCodeRun?: number } {
  let output = '';
  let cursor = 0;
  let inlineCodeRun = initialInlineCodeRun;

  while (cursor < line.length) {
    if (inlineCodeRun) {
      const closing = findMatchingBacktickRun(line, cursor, inlineCodeRun);
      if (closing < 0) {
        output += line.slice(cursor);
        return { output, inlineCodeRun };
      }
      const end = closing + inlineCodeRun;
      output += line.slice(cursor, end);
      cursor = end;
      inlineCodeRun = undefined;
      continue;
    }

    if (line[cursor] === '`') {
      const runLength = countRun(line, cursor, '`');
      const closing = findMatchingBacktickRun(line, cursor + runLength, runLength);
      if (closing < 0) {
        output += line.slice(cursor);
        return { output, inlineCodeRun: runLength };
      }
      const end = closing + runLength;
      output += line.slice(cursor, end);
      cursor = end;
      continue;
    }

    const parsed = parseLinkAt(line, cursor);
    if (parsed) {
      const localPath = localPathFromTarget(parsed.target);
      if (localPath) {
        output += inlineCode(localPath);
      } else {
        output += line.slice(cursor, parsed.end);
      }
      cursor = parsed.end;
      continue;
    }

    output += line[cursor];
    cursor++;
  }

  return { output, inlineCodeRun };
}

function parseLinkAt(
  line: string,
  start: number,
): { target: string; end: number } | undefined {
  const labelOpen =
    line[start] === '[' ? start : line[start] === '!' && line[start + 1] === '[' ? start + 1 : -1;
  if (labelOpen < 0) return undefined;

  const labelClose = findClosingBracket(line, labelOpen);
  if (labelClose < 0 || line[labelClose + 1] !== '(') return undefined;

  let cursor = labelClose + 2;
  while (cursor < line.length && /\s/.test(line[cursor] ?? '')) cursor++;
  if (cursor >= line.length) return undefined;

  if (line[cursor] === '<') {
    const targetStart = cursor + 1;
    const targetEnd = findUnescaped(line, '>', targetStart);
    if (targetEnd < 0) return undefined;
    cursor = targetEnd + 1;
    const whitespaceStart = cursor;
    while (cursor < line.length && /\s/.test(line[cursor] ?? '')) cursor++;
    const end =
      line[cursor] === ')' ? cursor + 1 : parseOptionalTitleAndClose(line, whitespaceStart);
    if (end < 0) return undefined;
    return {
      target: line.slice(targetStart, targetEnd),
      end,
    };
  }

  const targetStart = cursor;
  let nestedParens = 0;
  let escaped = false;
  for (; cursor < line.length; cursor++) {
    const char = line[cursor];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '(') {
      nestedParens++;
      continue;
    }
    if (char && /\s/.test(char) && nestedParens === 0) {
      const end = parseOptionalTitleAndClose(line, cursor);
      if (end < 0) return undefined;
      return {
        target: line.slice(targetStart, cursor),
        end,
      };
    }
    if (char !== ')') continue;
    if (nestedParens > 0) {
      nestedParens--;
      continue;
    }
    return {
      target: line.slice(targetStart, cursor).trim(),
      end: cursor + 1,
    };
  }

  return undefined;
}

function parseOptionalTitleAndClose(line: string, start: number): number {
  const remainder = line.slice(start);
  const match = remainder.match(
    /^\s+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\((?:\\.|[^)\\])*\))\s*\)/,
  );
  return match ? start + match[0].length : -1;
}

function localPathFromTarget(target: string): string | undefined {
  if (/^file:\/\//i.test(target)) return pathFromFileUri(target);
  if (/^(?:\/(?!\/)|~\/|[A-Za-z]:[\\/]|\\\\)/.test(target)) {
    return unescapeMarkdownPath(target);
  }
  return undefined;
}

function pathFromFileUri(target: string): string {
  try {
    const url = new URL(target);
    let pathname = decodeURIComponent(url.pathname);
    if (url.hostname && url.hostname !== 'localhost') {
      pathname = `//${url.hostname}${pathname}`;
    } else if (/^\/[A-Za-z]:\//.test(pathname)) {
      pathname = pathname.slice(1);
    }
    return pathname || target;
  } catch {
    return target.replace(/^file:\/\//i, '');
  }
}

function unescapeMarkdownPath(path: string): string {
  return path.replace(/\\([ ()<>])/g, '$1');
}

function inlineCode(value: string): string {
  const longestRun = Math.max(0, ...Array.from(value.matchAll(/`+/g), (match) => match[0].length));
  const delimiter = '`'.repeat(longestRun + 1);
  const needsPadding = value.startsWith('`') || value.endsWith('`');
  return `${delimiter}${needsPadding ? ` ${value} ` : value}${delimiter}`;
}

function findClosingBracket(line: string, open: number): number {
  let depth = 0;
  let escaped = false;
  for (let cursor = open + 1; cursor < line.length; cursor++) {
    const char = line[cursor];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '[') {
      depth++;
      continue;
    }
    if (char !== ']') continue;
    if (depth === 0) return cursor;
    depth--;
  }
  return -1;
}

function findUnescaped(line: string, needle: string, start: number): number {
  let escaped = false;
  for (let cursor = start; cursor < line.length; cursor++) {
    const char = line[cursor];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === needle) return cursor;
  }
  return -1;
}

function findMatchingBacktickRun(line: string, start: number, length: number): number {
  for (let cursor = start; cursor < line.length; cursor++) {
    if (line[cursor] !== '`') continue;
    const runLength = countRun(line, cursor, '`');
    if (runLength === length) return cursor;
    cursor += runLength - 1;
  }
  return -1;
}

function hasMatchingBacktickRun(lines: string[], start: number, length: number): boolean {
  for (let index = start; index < lines.length; index++) {
    const line = lines[index];
    if (line && line !== '\n' && findMatchingBacktickRun(line, 0, length) >= 0) return true;
  }
  return false;
}

function countRun(line: string, start: number, char: string): number {
  let cursor = start;
  while (line[cursor] === char) cursor++;
  return cursor - start;
}
