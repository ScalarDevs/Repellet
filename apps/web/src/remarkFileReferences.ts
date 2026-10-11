import type { Nodes, Root, Text } from 'mdast';
import type { Plugin } from 'unified';
import { workspaceFilePath } from './toolActivity';

type Candidate = {
  start: number;
  end: number;
  literal: string;
  path: string | null;
  inlineCode?: boolean;
};

const fileTag = /^<file\s+path\s*=\s*(?:"([^"]*)"|'([^']*)')\s*\/>$/;

function fileTagPath(value: string): string | null {
  const match = fileTag.exec(value);
  return match ? workspaceFilePath(match[1] ?? match[2]) : null;
}

function candidates(source: string, protectedRanges: Array<[number, number]>): Candidate[] {
  const result: Candidate[] = [];
  const starts = /<\/?file(?=[\s/>]|$)/g;
  let match: RegExpExecArray | null;
  while ((match = starts.exec(source))) {
    if (protectedRanges.some(([start, end]) => match!.index >= start && match!.index < end))
      continue;
    let quote = '';
    let end = match.index + match[0].length;
    for (; end < source.length; end++) {
      const char = source[end];
      if (quote) {
        if (char === quote) quote = '';
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === '>') {
        end++;
        break;
      }
    }
    const literal = source.slice(match.index, end);
    result.push({
      start: match.index,
      end,
      literal,
      path: fileTagPath(literal),
    });
    starts.lastIndex = end;
  }
  return result;
}

function inlineCodeCandidates(
  source: string,
  root: Root,
  protectedRanges: Array<[number, number]>,
): Candidate[] {
  const result: Candidate[] = [];
  walk(root, (node) => {
    if (node.type !== 'inlineCode') return;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    const path = fileTagPath(node.value);
    if (start === undefined || end === undefined || !path) return;
    // An inline-code node nested in an authored link or another protected node
    // must remain literal with the surrounding Markdown structure.
    if (
      protectedRanges.some(
        ([rangeStart, rangeEnd]) =>
          rangeStart <= start && rangeEnd >= end && (rangeStart !== start || rangeEnd !== end),
      )
    )
      return;
    result.push({
      start,
      end,
      literal: source.slice(start, end),
      path,
      inlineCode: true,
    });
  });
  return result;
}

function maskedLiteral(candidate: Candidate): string {
  if (!candidate.inlineCode) return candidate.literal.replace(/[^\r\n]/g, 'x');
  const opening = candidate.literal.match(/^`+/)?.[0] ?? '';
  const closing = candidate.literal.match(/`+$/)?.[0] ?? '';
  const contentEnd = candidate.literal.length - closing.length;
  return (
    opening + candidate.literal.slice(opening.length, contentEnd).replace(/[^\r\n]/g, 'x') + closing
  );
}

function walk(node: Nodes, visit: (node: Nodes) => void) {
  visit(node);
  if ('children' in node) for (const child of node.children) walk(child, visit);
}

function escaped(source: string, start: number) {
  let slashes = 0;
  while (start > 0 && source[--start] === '\\') slashes++;
  return slashes % 2 === 1;
}

/** Recognize only file tags, without enabling raw HTML or interpreting code examples. */
export const remarkFileReferences: Plugin<[], Root> = function () {
  const parse = this.parser;
  if (!parse) throw new Error('File references require a Markdown parser');

  this.parser = (source, file) => {
    if (!/<\/?file(?=[\s/>]|$)/.test(source)) return parse(source, file);
    const original = parse(source, file) as Root;
    const protectedRanges: Array<[number, number]> = [];
    const protect = (node: Nodes, html: boolean) => {
      if (
        [
          'code',
          'inlineCode',
          'link',
          'linkReference',
          'image',
          'imageReference',
          'definition',
        ].includes(node.type) ||
        (html && node.type === 'html')
      ) {
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        if (start !== undefined && end !== undefined) protectedRanges.push([start, end]);
      }
    };
    walk(original, (node) => protect(node, false));
    const tags = [
      ...candidates(source, protectedRanges),
      ...inlineCodeCandidates(source, original, protectedRanges),
    ].sort((a, b) => a.start - b.start);
    if (!tags.length) return original;

    // A standalone custom tag otherwise starts an HTML block and swallows following
    // Markdown. Mask tags at identical offsets to discover code/link/HTML boundaries.
    let probe = '';
    let cursor = 0;
    for (const tag of tags) {
      probe += source.slice(cursor, tag.start) + maskedLiteral(tag);
      cursor = tag.end;
    }
    probe += source.slice(cursor);
    walk(parse(probe, file) as Root, (node) => protect(node, true));

    const references = new Map<number, Candidate>();
    let markdown = '';
    cursor = 0;
    for (const tag of tags) {
      if (
        escaped(source, tag.start) ||
        protectedRanges.some(
          ([start, end]) =>
            tag.start < end &&
            tag.end > start &&
            !(tag.inlineCode && start === tag.start && end === tag.end),
        )
      )
        continue;
      markdown += source.slice(cursor, tag.start);
      references.set(markdown.length, tag);
      // A private placeholder is restored by position, so authored Markdown links
      // cannot impersonate a file reference. Neither paths nor labels enter markup.
      markdown += '[file](repellet-file-reference)';
      cursor = tag.end;
    }
    if (!references.size) return parse(source, file);
    markdown += source.slice(cursor);
    const tree = parse(markdown, file) as Root;
    function restore(node: Nodes) {
      if (!('children' in node)) return;
      node.children = node.children.map((child) => {
        const tag = references.get(child.position?.start.offset ?? -1);
        if (child.type === 'link' && child.url === 'repellet-file-reference' && tag) {
          const text: Text = { type: 'text', value: tag.path ?? tag.literal };
          if (tag.path) {
            text.data = {
              hName: 'span',
              hProperties: { 'data-file-reference': tag.path },
            };
          }
          return text;
        }
        restore(child);
        return child;
      }) as typeof node.children;
    }
    restore(tree);
    return tree;
  };
};
