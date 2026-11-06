// YAML for page files and item frontmatter: YAML 1.2 with the core schema
// (so yes, no, on and off stay text), one document, unique keys, and no
// anchors, aliases or tags. Every value keeps where it was in the file, so
// a problem can say its line and column.

import { LineCounter, isMap, isPair, isScalar, isSeq, parseAllDocuments, visit } from 'yaml';
import type { Document, Node as YamlNode } from 'yaml';
import { utf8 } from './sha256.ts';

/** Where a value is in a key path: mapping keys and list indexes. */
export type Path = (string | number)[];

export interface Problem {
  severity: 'error' | 'warning';
  /** A stable code, the same in every implementation (see fixtures/). */
  code: string;
  /** One plain sentence. */
  message: string;
  /** "Did you mean status?", when there is a likely intent. */
  hint?: string;
  /** What the hint suggests, alone (status). */
  suggestion?: string;
  path: Path;
  /** 1-based. */
  line: number;
  /** 1-based, in characters. */
  column: number;
}

export interface Pos { line: number; column: number; endLine: number; endColumn: number }

export interface ParsedYaml {
  /** The data, or undefined when the text could not be read. */
  value: unknown;
  problems: Problem[];
  /** Where the key (or, for 'value', the value) at a path is. Falls back to
   * the nearest parent that exists, then to line 1. */
  locate(path: Path, which?: 'key' | 'value'): Pos;
}

export const MAX_BYTES = 256 * 1024;

const START: Pos = { line: 1, column: 1, endLine: 1, endColumn: 1 };

function problem(code: string, message: string, at: Pos, path: Path = [], hint?: string): Problem {
  return { severity: 'error', code, message, ...(hint ? { hint } : {}), path, line: at.line, column: at.column };
}

const YAML_MESSAGES: Record<string, string> = {
  DUPLICATE_KEY: 'This key appears twice in the same mapping.',
  BAD_INDENT: 'The indentation here is off.',
  MISSING_CHAR: 'A closing ] or } or quote is missing.',
  MULTILINE_IMPLICIT_KEY: 'A key must be on one line; a value that goes on needs quotes or a | block.',
  BLOCK_AS_IMPLICIT_KEY: 'A key must be on one line.',
  TAB_AS_INDENT: 'Tabs cannot indent YAML; use spaces.',
  UNEXPECTED_TOKEN: 'Something here is not valid YAML.',
  BAD_SCALAR_START: 'A value cannot start with this character; put it in quotes.',
};

/** Reads YAML text the way page files are read. `opts.what` names the text
 * in messages ("The page file", "The frontmatter"). */
export function parseYaml(text: string, opts: { what?: string; lineOffset?: number } = {}): ParsedYaml {
  const what = opts.what ?? 'The file';
  const lineOffset = opts.lineOffset ?? 0;
  const lc = new LineCounter();
  const problems: Problem[] = [];
  const at = (offset: number): { line: number; column: number } => {
    const p = lc.linePos(offset);
    return { line: p.line + lineOffset, column: p.col };
  };
  const span = (range: [number, number, number] | null | undefined): Pos => {
    if (!range) return { ...START, line: START.line + lineOffset, endLine: START.line + lineOffset };
    const a = at(range[0]);
    const b = at(range[1]);
    return { line: a.line, column: a.column, endLine: b.line, endColumn: b.column };
  };
  const none: ParsedYaml = { value: undefined, problems, locate: () => span(null) };

  if (text.length > MAX_BYTES || utf8(text).length > MAX_BYTES) {
    problems.push(problem('too-large', `${what} is over ${MAX_BYTES / 1024} KB. Page files are short; put the data in item files.`, span(null)));
    return none;
  }
  const docs = parseAllDocuments(text, {
    version: '1.2', schema: 'core', lineCounter: lc, uniqueKeys: true, merge: false, prettyErrors: false, strict: true, keepSourceTokens: false,
  });
  const list: Document.Parsed[] = Array.isArray(docs) ? docs : [];
  if (!Array.isArray(docs)) {
    problems.push(problem('yaml-syntax', `${what} can't be read as YAML.`, span(null)));
    return none;
  }
  if (list.length === 0 || (list.length === 1 && list[0].contents == null)) {
    problems.push(problem('empty', `${what} is empty.`, span(null)));
    return none;
  }
  if (list.length > 1) {
    const second = list[1];
    problems.push(problem('yaml-multi-doc', `${what} holds more than one YAML document. Remove the --- line and what follows, or move it to its own file.`, span(second.range as [number, number, number])));
    return none;
  }
  const doc = list[0];
  // The first error only: the ones after it are mostly the same mistake
  // seen again further on.
  for (const e of doc.errors.slice(0, 1)) {
    const p = at(e.pos[0]);
    const pos: Pos = { line: p.line, column: p.column, endLine: p.line, endColumn: p.column };
    const plain = YAML_MESSAGES[e.code] ?? `This is not valid YAML: ${e.message.split('\n')[0].replace(/ at line \d+, column \d+:?$/, '')}.`;
    problems.push(problem(e.code === 'DUPLICATE_KEY' ? 'yaml-duplicate-key' : 'yaml-syntax', plain, pos));
  }
  if (problems.length) return none;

  // Anchors, aliases and tags: refused, wherever they are.
  visit(doc, {
    Alias(_k, node) {
      problems.push(problem('yaml-alias', `Aliases (*${node.source}) are not allowed in ${what.toLowerCase().replace(/^the /, 'a ')}. Write the value out again.`, span(node.range)));
    },
    Node(_k, node) {
      const n = node as YamlNode & { anchor?: string; tag?: string };
      if (n.anchor) problems.push(problem('yaml-anchor', `Anchors (&${n.anchor}) are not allowed in ${what.toLowerCase().replace(/^the /, 'a ')}. Write the value out where it is used.`, span(n.range)));
      if (n.tag) problems.push(problem('yaml-tag', `Tags such as ${n.tag.replace(/^tag:yaml\.org,2002:/, '!!')} are not allowed in ${what.toLowerCase().replace(/^the /, 'a ')}. Remove it, and quote the value if it must stay text.`, span(n.range)));
    },
  });
  if (problems.length) return none;

  const value = doc.toJS({ maxAliasCount: 0 }) as unknown;

  const locate = (path: Path, which: 'key' | 'value' = 'key'): Pos => {
    let node: unknown = doc.contents;
    let last: Pos = span((doc.contents as YamlNode | null)?.range ?? null);
    for (let i = 0; i < path.length; i++) {
      const seg = path[i];
      const final = i === path.length - 1;
      if (isMap(node)) {
        const pair = node.items.find((p) => isPair(p) && isScalar(p.key) && String(p.key.value) === String(seg));
        if (!pair) return last;
        const keyNode = pair.key as YamlNode;
        const valNode = pair.value as YamlNode | null;
        if (final) return which === 'key' ? span(keyNode.range) : span(valNode?.range ?? keyNode.range);
        last = span(keyNode.range);
        node = valNode;
      } else if (isSeq(node) && typeof seg === 'number') {
        const item = node.items[seg] as YamlNode | undefined;
        if (!item) return last;
        last = span(item.range);
        if (final) return last;
        node = item;
      } else {
        return last;
      }
    }
    return last;
  };
  return { value, problems, locate };
}
