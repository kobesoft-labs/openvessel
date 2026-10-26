// POSIX shell parser (a practical subset plus a few bash-isms).

export type WordPart =
  | { t: 'lit'; v: string }
  | { t: 'sq'; v: string }
  | { t: 'dq'; parts: WordPart[] }
  | { t: 'param'; name: string; op?: string; arg?: Word; arg2?: Word; length?: boolean; index?: string }
  | { t: 'cmd'; src: string }
  | { t: 'arith'; expr: Word }
  | { t: 'tilde'; user: string };

export type Word = WordPart[];

export interface Redir {
  fd: number | null;
  op: string;
  target: Word;
  heredoc?: { body: Word; quoted: boolean; strip: boolean; delim: string; raw?: string };
}

export type Node =
  | { t: 'simple'; assigns: { name: string; value: Word; append: boolean }[]; words: Word[]; redirs: Redir[] }
  | { t: 'pipeline'; cmds: Node[]; bang: boolean }
  | { t: 'andor'; first: Node; rest: { op: '&&' | '||'; node: Node }[] }
  | { t: 'list'; items: { node: Node; async: boolean }[] }
  | { t: 'subshell'; body: Node; redirs: Redir[] }
  | { t: 'group'; body: Node; redirs: Redir[] }
  | { t: 'if'; clauses: { cond: Node; body: Node }[]; else?: Node; redirs: Redir[] }
  | { t: 'while'; until: boolean; cond: Node; body: Node; redirs: Redir[] }
  | { t: 'for'; name: string; words: Word[] | null; body: Node; redirs: Redir[] }
  | { t: 'case'; word: Word; items: CaseItem[]; redirs: Redir[] }
  | { t: 'func'; name: string; body: Node }
  | { t: 'dbracket'; words: Word[]; redirs: Redir[] };

/** A case clause; `term` is how it ends: `;;` (stop), `;&` (run the next body), `;;&` (test the next patterns). */
export interface CaseItem {
  patterns: Word[];
  body: Node | null;
  term: ';;' | ';&' | ';;&';
}

export class ShellSyntaxError extends Error {
  incomplete: boolean;
  constructor(msg: string, incomplete = false) {
    super(msg);
    this.incomplete = incomplete;
  }
}

const RESERVED = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'case', 'esac', 'while', 'until', 'for', 'in', '{', '}', '!', 'function', '[[', ']]']);
const META = new Set([' ', '\t', '\n', ';', '&', '|', '<', '>', '(', ')']);
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Single-character escapes of $'...' (bash). */
const ANSI_C_ESCAPES: Record<string, string> = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };

export function parse(src: string): Node {
  return new Parser(src).parseProgram();
}

export class Parser {
  i = 0;
  pending: Redir[] = [];
  /** Text spliced in by alias expansion: an alias isn't expanded again inside its own text. */
  private aliasRegions: { name: string; start: number; end: number }[] = [];
  /** The last alias ended with a blank: the next word is checked for an alias too. */
  private aliasNextWord = false;
  constructor(
    public s: string,
    private aliases?: Map<string, string>,
  ) {}

  private eof() {
    return this.i >= this.s.length;
  }
  private ch(o = 0) {
    return this.s[this.i + o];
  }

  private fail(msg: string): never {
    throw new ShellSyntaxError(msg, this.eof());
  }

  /** Skips blanks, comments and line continuations (not newlines). */
  private skipBlank() {
    for (;;) {
      const c = this.ch();
      if (c === ' ' || c === '\t' || c === '\r') this.i++;
      else if (c === '\\' && this.ch(1) === '\n') this.i += 2;
      else if (c === '#') {
        while (!this.eof() && this.ch() !== '\n') this.i++;
      } else break;
    }
  }

  /** Skips blanks and newlines (reading pending heredocs). */
  private skipLinebreaks() {
    for (;;) {
      this.skipBlank();
      if (this.ch() === '\n') {
        this.i++;
        this.readHeredocs();
      } else break;
    }
  }

  private readHeredocs() {
    const list = this.pending;
    this.pending = [];
    for (const r of list) {
      const hd = r.heredoc!;
      const lines: string[] = [];
      for (;;) {
        if (this.eof()) break;
        let end = this.s.indexOf('\n', this.i);
        if (end === -1) end = this.s.length;
        let line = this.s.slice(this.i, end);
        this.i = Math.min(end + 1, this.s.length);
        if (hd.strip) line = line.replace(/^\t+/, '');
        if (line === hd.delim) break;
        lines.push(line);
      }
      const raw = lines.length ? lines.join('\n') + '\n' : '';
      hd.raw = raw;
      hd.body = hd.quoted ? [{ t: 'sq', v: raw }] : [{ t: 'dq', parts: new Parser(raw).parseDqContent(true) }];
    }
  }

  /** Peeks a reserved word at the current position (command position). */
  private peekReserved(): string | null {
    this.skipBlank();
    let j = this.i;
    while (j < this.s.length && !META.has(this.s[j]) && !'"\'`$\\'.includes(this.s[j])) j++;
    const w = this.s.slice(this.i, j);
    if (!RESERVED.has(w)) return null;
    // `{` and `}` must be followed by a delimiter
    const next = this.s[j];
    if (next !== undefined && !META.has(next)) return null;
    return w;
  }

  private expectReserved(w: string) {
    this.skipLinebreaks();
    if (this.peekReserved() !== w) this.fail(`syntax error: expected '${w}'`);
    this.i += w.length;
  }

  parseProgram(): Node {
    const list = this.parseList([]);
    this.skipLinebreaks();
    if (!this.eof()) this.fail(`syntax error near unexpected token '${this.s.slice(this.i, this.i + 10)}'`);
    return list;
  }

  /**
   * Parses the next complete command (a list up to the end of the line), or null at the end.
   * Scripts run one such command at a time, so an alias defined on a line applies from the next
   * line on, and a syntax error further down doesn't stop the lines before it (as in bash).
   */
  parseNext(): Node | null {
    this.skipLinebreaks();
    if (this.eof()) return null;
    const items: { node: Node; async: boolean }[] = [];
    for (;;) {
      const node = this.parseAndOr();
      this.skipBlank();
      let async = false;
      if (this.ch() === '&' && this.ch(1) !== '&') {
        this.i++;
        async = true;
      } else if (this.ch() === ';' && this.ch(1) !== ';' && this.ch(1) !== '&') {
        this.i++;
      } else if (!this.eof() && this.ch() !== '\n') {
        this.fail(`syntax error near unexpected token '${this.ch() === ';' ? this.s.slice(this.i, this.i + 2) : this.ch()}'`);
      }
      items.push({ node, async });
      this.skipBlank();
      if (this.eof()) {
        this.readHeredocs();
        break;
      }
      if (this.ch() === '\n') {
        this.i++;
        this.readHeredocs();
        break;
      }
    }
    if (items.length === 1 && !items[0].async) return items[0].node;
    return { t: 'list', items };
  }

  /**
   * Alias expansion at a command word: the alias text replaces the word in the input, so it may
   * hold several commands, pipes or reserved words. Returns true when it expanded one.
   */
  private tryAlias(): boolean {
    if (!this.aliases?.size) return false;
    this.skipBlank();
    let j = this.i;
    while (j < this.s.length && !META.has(this.s[j]) && !'"\'`$\\'.includes(this.s[j])) j++;
    // a quoted or expanded part makes it a different word
    if (j === this.i || (j < this.s.length && !META.has(this.s[j]))) return false;
    const w = this.s.slice(this.i, j);
    const v = this.aliases.get(w);
    if (v === undefined) return false;
    if (this.aliasRegions.some((r) => r.name === w && this.i >= r.start && this.i < r.end)) return false;
    // an alias ending in a blank makes the word after its text an alias candidate too, also when
    // the first word of that text is itself an alias (alias q='e ': `q x` checks x)
    const keep = this.aliasNextWord && this.aliasRegions.some((r) => r.start <= this.i && j < r.end);
    const delta = v.length - w.length;
    for (const r of this.aliasRegions) if (r.end > this.i) r.end += delta;
    this.s = this.s.slice(0, this.i) + v + this.s.slice(j);
    this.aliasRegions.push({ name: w, start: this.i, end: this.i + v.length });
    this.aliasNextWord = keep || /[ \t]$/.test(v);
    return true;
  }

  /** Parses a compound list until one of the terminators (reserved words, `)`, `;;`). */
  private parseList(terms: string[]): Node {
    const items: { node: Node; async: boolean }[] = [];
    for (;;) {
      this.skipLinebreaks();
      if (this.eof()) break;
      const c = this.ch();
      if (c === ')' && terms.includes(')')) break;
      if (c === ';' && this.ch(1) === ';' && terms.includes(';;')) break;
      if (c === ';' && this.ch(1) === '&' && terms.includes(';;')) break;
      const rw = this.peekReserved();
      if (rw && terms.includes(rw)) break;
      if (c === ')' || c === '}' && !terms.length) this.fail(`syntax error near unexpected token '${c}'`);
      const node = this.parseAndOr();
      this.skipBlank();
      let async = false;
      if (this.ch() === '&' && this.ch(1) !== '&') {
        this.i++;
        async = true;
      } else if (this.ch() === ';' && this.ch(1) !== ';' && this.ch(1) !== '&') {
        this.i++;
      } else if (this.ch() === '\n') {
        // handled by skipLinebreaks
      } else if (!this.eof()) {
        const c2 = this.ch();
        if (!(c2 === ')' || (c2 === ';' && (this.ch(1) === ';' || (this.ch(1) === '&' && terms.includes(';;')))) || this.peekReserved())) {
          this.fail(`syntax error near unexpected token '${c2}'`);
        }
      }
      items.push({ node, async });
    }
    if (items.length === 1 && !items[0].async) return items[0].node;
    return { t: 'list', items };
  }

  private parseAndOr(): Node {
    const first = this.parsePipeline();
    const rest: { op: '&&' | '||'; node: Node }[] = [];
    for (;;) {
      this.skipBlank();
      const two = this.s.slice(this.i, this.i + 2);
      if (two === '&&' || two === '||') {
        this.i += 2;
        this.skipLinebreaks();
        rest.push({ op: two, node: this.parsePipeline() });
      } else break;
    }
    return rest.length ? { t: 'andor', first, rest } : first;
  }

  private parsePipeline(): Node {
    this.skipBlank();
    let bang = false;
    if (this.peekReserved() === '!') {
      this.i++;
      bang = true;
    }
    const cmds = [this.parseCommand()];
    for (;;) {
      this.skipBlank();
      if (this.ch() === '|' && this.ch(1) !== '|') {
        this.i++;
        if (this.ch() === '&') {
          // |& : stderr too
          this.i++;
          const prev = cmds[cmds.length - 1] as any;
          (prev.redirs ??= []).push({ fd: 2, op: '>&', target: [{ t: 'lit', v: '1' }] });
        }
        this.skipLinebreaks();
        cmds.push(this.parseCommand());
      } else break;
    }
    if (cmds.length === 1 && !bang) return cmds[0];
    return { t: 'pipeline', cmds, bang };
  }

  private parseCommand(): Node {
    this.skipBlank();
    while (this.tryAlias());
    const rw = this.peekReserved();
    let node: Node | null = null;
    switch (rw) {
      case 'if':
        node = this.parseIf();
        break;
      case 'while':
      case 'until':
        node = this.parseWhile(rw === 'until');
        break;
      case 'for':
        node = this.parseFor();
        break;
      case 'case':
        node = this.parseCase();
        break;
      case '{': {
        this.i++;
        const body = this.parseList(['}']);
        this.expectReserved('}');
        node = { t: 'group', body, redirs: [] };
        break;
      }
      case '[[':
        node = this.parseDbracket();
        break;
      case 'function': {
        this.i += 8;
        this.skipBlank();
        const name = this.readName();
        this.skipBlank();
        if (this.ch() === '(' && this.ch(1) === ')') this.i += 2;
        this.skipLinebreaks();
        return { t: 'func', name, body: this.parseCommand() };
      }
      default:
        if (rw && rw !== '!') this.fail(`syntax error near unexpected token '${rw}'`);
    }
    if (!node && this.ch() === '(') {
      this.i++;
      if (this.ch() === '(') {
        // (( arithmetic )) command
        this.i++;
        const start = this.i;
        let depth = 0;
        while (!this.eof()) {
          if (this.ch() === '(') depth++;
          else if (this.ch() === ')') {
            if (depth === 0 && this.ch(1) === ')') break;
            depth--;
          }
          this.i++;
        }
        const expr = this.s.slice(start, this.i);
        this.i += 2;
        node = { t: 'simple', assigns: [], words: [[{ t: 'lit', v: '((' }], [{ t: 'dq', parts: new Parser(expr).parseDqContent(true) }]], redirs: [] };
        return node;
      }
      const body = this.parseList([')']);
      this.skipLinebreaks();
      if (this.ch() !== ')') this.fail("syntax error: expected ')'");
      this.i++;
      node = { t: 'subshell', body, redirs: [] };
    }
    if (node) {
      (node as any).redirs = this.parseRedirs();
      return node;
    }
    return this.parseSimple();
  }

  private parseRedirs(): Redir[] {
    const out: Redir[] = [];
    for (;;) {
      this.skipBlank();
      const r = this.tryRedir();
      if (!r) break;
      out.push(r);
    }
    return out;
  }

  private readName(): string {
    const m = /^[A-Za-z_][A-Za-z0-9_.:-]*/.exec(this.s.slice(this.i));
    if (!m) this.fail('syntax error: expected name');
    this.i += m[0].length;
    return m[0];
  }

  private parseIf(): Node {
    this.i += 2;
    const clauses: { cond: Node; body: Node }[] = [];
    let elseBody: Node | undefined;
    const cond = this.parseList(['then']);
    this.expectReserved('then');
    const body = this.parseList(['elif', 'else', 'fi']);
    clauses.push({ cond, body });
    for (;;) {
      this.skipLinebreaks();
      const rw = this.peekReserved();
      if (rw === 'elif') {
        this.i += 4;
        const c = this.parseList(['then']);
        this.expectReserved('then');
        const b = this.parseList(['elif', 'else', 'fi']);
        clauses.push({ cond: c, body: b });
      } else if (rw === 'else') {
        this.i += 4;
        elseBody = this.parseList(['fi']);
      } else if (rw === 'fi') {
        this.i += 2;
        break;
      } else this.fail("syntax error: expected 'fi'");
    }
    return { t: 'if', clauses, else: elseBody, redirs: [] };
  }

  private parseWhile(until: boolean): Node {
    this.i += until ? 5 : 5;
    const cond = this.parseList(['do']);
    this.expectReserved('do');
    const body = this.parseList(['done']);
    this.expectReserved('done');
    return { t: 'while', until, cond, body, redirs: [] };
  }

  private parseFor(): Node {
    this.i += 3;
    this.skipBlank();
    const name = this.readName();
    this.skipBlank();
    let words: Word[] | null = null;
    this.skipLinebreaks();
    if (this.peekReserved() === 'in') {
      this.i += 2;
      words = [];
      for (;;) {
        this.skipBlank();
        const c = this.ch();
        if (c === undefined || c === ';' || c === '\n') break;
        words.push(this.readWord());
      }
    }
    this.skipBlank();
    if (this.ch() === ';') this.i++;
    this.expectReserved('do');
    const body = this.parseList(['done']);
    this.expectReserved('done');
    return { t: 'for', name, words, body, redirs: [] };
  }

  private parseCase(): Node {
    this.i += 4;
    this.skipBlank();
    const word = this.readWord();
    this.expectReserved('in');
    const items: CaseItem[] = [];
    for (;;) {
      this.skipLinebreaks();
      if (this.peekReserved() === 'esac') {
        this.i += 4;
        break;
      }
      if (this.eof()) this.fail("syntax error: expected 'esac'");
      if (this.ch() === '(') this.i++;
      const patterns: Word[] = [];
      for (;;) {
        this.skipBlank();
        patterns.push(this.readWord());
        this.skipBlank();
        if (this.ch() === '|') {
          this.i++;
          continue;
        }
        if (this.ch() === ')') {
          this.i++;
          break;
        }
        this.fail("syntax error in case pattern");
      }
      const body = this.parseList(['esac', ';;']);
      let term: CaseItem['term'] = ';;';
      this.skipLinebreaks();
      if (this.ch() === ';' && (this.ch(1) === ';' || this.ch(1) === '&')) {
        term = this.ch(1) === '&' ? ';&' : ';;';
        this.i += 2;
        if (term === ';;' && this.ch() === '&') {
          term = ';;&';
          this.i++;
        }
      }
      items.push({ patterns, body: body.t === 'list' && body.items.length === 0 ? null : body, term });
    }
    return { t: 'case', word, items, redirs: [] };
  }

  private parseDbracket(): Node {
    this.i += 2;
    const words: Word[] = [];
    for (;;) {
      this.skipBlank();
      if (this.eof()) this.fail("syntax error: expected ']]'");
      if (this.s.startsWith(']]', this.i)) {
        this.i += 2;
        break;
      }
      const c = this.ch();
      if (c === '&' && this.ch(1) === '&') {
        this.i += 2;
        words.push([{ t: 'lit', v: '&&' }]);
      } else if (c === '|' && this.ch(1) === '|') {
        this.i += 2;
        words.push([{ t: 'lit', v: '||' }]);
      } else if (c === '(' || c === ')' || c === '<' || c === '>') {
        this.i++;
        words.push([{ t: 'lit', v: c }]);
      } else if (c === '\n') this.i++;
      else words.push(this.readWord(true));
    }
    return { t: 'dbracket', words, redirs: [] };
  }

  private parseSimple(): Node {
    const assigns: { name: string; value: Word; append: boolean }[] = [];
    const words: Word[] = [];
    const redirs: Redir[] = [];
    for (;;) {
      this.skipBlank();
      const c = this.ch();
      if (c === undefined || c === '\n' || c === ';' || c === '&' || c === '|' || c === ')') {
        if (c === '&' && this.ch(1) === '>') {
          const r = this.tryRedir();
          if (r) {
            redirs.push(r);
            continue;
          }
        }
        break;
      }
      const r = this.tryRedir();
      if (r) {
        redirs.push(r);
        continue;
      }
      if (c === '(') {
        // function definition: name ( )
        if (words.length === 1 && assigns.length === 0 && this.s.slice(this.i).match(/^\(\s*\)/)) {
          const name = wordToLiteral(words[0]);
          if (name === null) this.fail('syntax error: bad function name');
          this.i = this.s.indexOf(')', this.i) + 1;
          this.skipLinebreaks();
          return { t: 'func', name, body: this.parseCommand() };
        }
        this.fail("syntax error near unexpected token '('");
      }
      if (words.length === 0) {
        const m = /^([A-Za-z_][A-Za-z0-9_]*)(\+?)=/.exec(this.s.slice(this.i, this.i + 256));
        if (m) {
          this.i += m[0].length;
          let value: Word;
          if (this.ch() === '(') {
            // array assignment: keep as a space-joined string
            const end = this.s.indexOf(')', this.i);
            const inner = this.s.slice(this.i + 1, end === -1 ? this.s.length : end);
            this.i = end === -1 ? this.s.length : end + 1;
            value = [{ t: 'lit', v: inner.trim() }];
          } else {
            const c2 = this.ch();
            value = c2 === undefined || META.has(c2) ? [] : this.readWord(false, true);
          }
          assigns.push({ name: m[1], value, append: m[2] === '+' });
          continue;
        }
      }
      if (words.length === 0 ? this.tryAlias() : this.aliasNextWord && ((this.aliasNextWord = false), this.tryAlias())) continue;
      words.push(this.readWord());
    }
    this.aliasNextWord = false;
    if (words.length === 0 && assigns.length === 0 && redirs.length === 0) {
      this.fail(`syntax error near unexpected token '${this.ch() ?? 'newline'}'`);
    }
    return { t: 'simple', assigns, words, redirs };
  }

  private tryRedir(): Redir | null {
    const rest = this.s.slice(this.i, this.i + 4);
    const m = /^(\d)?(&>>|&>|<<<|<<-|<<|>>|>&|<&|>\||<>|>|<)/.exec(rest);
    if (!m) return null;
    // `2>` etc: digit must be immediately followed by the operator
    this.i += m[0].length;
    const fd = m[1] !== undefined ? Number(m[1]) : null;
    const op = m[2];
    this.skipBlank();
    if (op === '<<' || op === '<<-') {
      const delimWord = this.readWord();
      const quoted = delimWord.some((p) => p.t !== 'lit') || wordToRawish(delimWord).includes('\\');
      const delim = wordToRawish(delimWord).replace(/\\/g, '');
      const r: Redir = { fd, op: '<<', target: [], heredoc: { body: [], quoted, strip: op === '<<-', delim } };
      this.pending.push(r);
      return r;
    }
    const c = this.ch();
    if (c === undefined || c === '\n' || META.has(c)) this.fail(`syntax error near unexpected token '${c ?? 'newline'}'`);
    return { fd, op, target: this.readWord() };
  }

  /** Reads a word (stops at metacharacters). */
  readWord(inDbracket = false, assignValue = false): Word {
    const parts: WordPart[] = [];
    let lit = '';
    const flush = () => {
      if (lit) parts.push({ t: 'lit', v: lit });
      lit = '';
    };
    const start = this.i;
    while (!this.eof()) {
      const c = this.ch();
      if (META.has(c)) {
        if (inDbracket && (c === '<' || c === '>') ) break;
        break;
      }
      if (inDbracket && c === ']' && this.ch(1) === ']' && this.i === start) break;
      if (c === '\\') {
        if (this.ch(1) === '\n') {
          this.i += 2;
          continue;
        }
        flush();
        parts.push({ t: 'sq', v: this.ch(1) ?? '' });
        this.i += 2;
        continue;
      }
      if (c === "'") {
        flush();
        const end = this.s.indexOf("'", this.i + 1);
        if (end === -1) {
          this.i = this.s.length;
          this.fail('unexpected EOF while looking for matching quote');
        }
        parts.push({ t: 'sq', v: this.s.slice(this.i + 1, end) });
        this.i = end + 1;
        continue;
      }
      if (c === '$' && this.ch(1) === "'") {
        flush();
        this.i += 2;
        parts.push({ t: 'sq', v: this.readAnsiC() });
        continue;
      }
      if (c === '"') {
        flush();
        this.i++;
        parts.push({ t: 'dq', parts: this.parseDqContent(false) });
        continue;
      }
      if (c === '$' || c === '`') {
        const p = this.readDollar();
        if (p) {
          flush();
          parts.push(p);
          continue;
        }
      }
      if (c === '~' && this.i === start) {
        const m = /^~([A-Za-z0-9_.-]*)/.exec(this.s.slice(this.i));
        const after = this.s[this.i + m![0].length];
        if (after === undefined || after === '/' || META.has(after) || (assignValue && after === ':')) {
          flush();
          parts.push({ t: 'tilde', user: m![1] });
          this.i += m![0].length;
          continue;
        }
      }
      lit += c;
      this.i++;
    }
    flush();
    return parts;
  }

  private readAnsiC(): string {
    let out = '';
    while (!this.eof()) {
      const c = this.ch();
      if (c === "'") {
        this.i++;
        return out;
      }
      if (c === '\\') {
        const n = this.ch(1);
        this.i += 2;
        const simple = ANSI_C_ESCAPES[n ?? ''];
        if (simple !== undefined) {
          out += simple;
          continue;
        }
        if (n !== undefined && n >= '0' && n <= '7') {
          // \nnn: one to three octal digits
          const m = /^[0-7]{0,2}/.exec(this.s.slice(this.i))!;
          out += String.fromCharCode(parseInt(n + m[0], 8) & 0xff);
          this.i += m[0].length;
          continue;
        }
        const hex = n === 'x' ? 2 : n === 'u' ? 4 : n === 'U' ? 8 : 0;
        if (hex) {
          const m = new RegExp(`^[0-9a-fA-F]{1,${hex}}`).exec(this.s.slice(this.i));
          if (!m) {
            out += '\\' + n;
            continue;
          }
          const cp = parseInt(m[0], 16);
          out += n === 'x' ? String.fromCharCode(cp) : cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
          this.i += m[0].length;
          continue;
        }
        if (n === 'c' && this.i < this.s.length) {
          // \cX: control character
          out += String.fromCharCode(this.s.charCodeAt(this.i) & 0x1f);
          this.i++;
          continue;
        }
        // unknown escapes are kept as they are
        out += '\\' + (n ?? '');
        continue;
      }
      out += c;
      this.i++;
    }
    this.fail('unexpected EOF while looking for matching quote');
  }

  /** Parses the inside of double quotes (until `"` unless `toEnd`). */
  parseDqContent(toEnd: boolean): WordPart[] {
    const parts: WordPart[] = [];
    let lit = '';
    const flush = () => {
      if (lit) parts.push({ t: 'sq', v: lit });
      lit = '';
    };
    while (!this.eof()) {
      const c = this.ch();
      if (c === '"' && !toEnd) {
        this.i++;
        flush();
        return parts;
      }
      if (c === '\\') {
        const n = this.ch(1);
        if (n === '$' || n === '`' || n === '"' || n === '\\' || n === '\n') {
          if (n !== '\n') lit += n;
          this.i += 2;
          continue;
        }
        lit += c;
        this.i++;
        continue;
      }
      if (c === '$' || c === '`') {
        const p = this.readDollar();
        if (p) {
          flush();
          parts.push(p);
          continue;
        }
      }
      lit += c;
      this.i++;
    }
    if (!toEnd) this.fail('unexpected EOF while looking for matching `"`');
    flush();
    return parts;
  }

  /** Reads $x ${...} $(...) $((...)) or `...`; returns null if `$` is literal. */
  private readDollar(): WordPart | null {
    const c = this.ch();
    if (c === '`') {
      let j = this.i + 1;
      let src = '';
      while (j < this.s.length && this.s[j] !== '`') {
        if (this.s[j] === '\\' && '$`\\'.includes(this.s[j + 1])) {
          src += this.s[j + 1];
          j += 2;
          continue;
        }
        src += this.s[j++];
      }
      if (j >= this.s.length) {
        this.i = j;
        this.fail('unexpected EOF while looking for matching ``');
      }
      this.i = j + 1;
      return { t: 'cmd', src };
    }
    const n = this.ch(1);
    if (n === '(' && this.ch(2) === '(') {
      // $(( arithmetic ))
      const start = this.i + 3;
      let j = start;
      let depth = 0;
      while (j < this.s.length) {
        const cj = this.s[j];
        if (cj === '(') depth++;
        else if (cj === ')') {
          if (depth === 0 && this.s[j + 1] === ')') break;
          depth--;
        }
        j++;
      }
      if (j >= this.s.length) {
        this.i = j;
        this.fail('unexpected EOF in arithmetic');
      }
      const inner = this.s.slice(start, j);
      this.i = j + 2;
      return { t: 'arith', expr: new Parser(inner).parseDqContent(true) };
    }
    if (n === '(') {
      const start = this.i + 2;
      const end = findMatchingParen(this.s, start);
      if (end === -1) {
        this.i = this.s.length;
        this.fail('unexpected EOF while looking for matching `)`');
      }
      this.i = end + 1;
      return { t: 'cmd', src: this.s.slice(start, end) };
    }
    if (n === '{') {
      const start = this.i + 2;
      let j = start;
      let depth = 0;
      while (j < this.s.length) {
        const cj = this.s[j];
        if (cj === '\\') {
          j += 2;
          continue;
        }
        if (cj === "'" && depth >= 0) {
          // quotes inside ${} words
          const e = this.s.indexOf("'", j + 1);
          j = e === -1 ? this.s.length : e + 1;
          continue;
        }
        if (cj === '{') depth++;
        else if (cj === '}') {
          if (depth === 0) break;
          depth--;
        }
        j++;
      }
      if (j >= this.s.length) {
        this.i = this.s.length;
        this.fail('unexpected EOF while looking for matching `}`');
      }
      const inner = this.s.slice(start, j);
      this.i = j + 1;
      return parseBraceParam(inner);
    }
    if (n !== undefined && /[A-Za-z_]/.test(n)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.s.slice(this.i + 1))!;
      this.i += 1 + m[0].length;
      return { t: 'param', name: m[0] };
    }
    if (n !== undefined && /[0-9@*#?$!\-]/.test(n)) {
      this.i += 2;
      return { t: 'param', name: n };
    }
    return null;
  }
}

function findMatchingParen(s: string, start: number): number {
  let depth = 0;
  let j = start;
  while (j < s.length) {
    const c = s[j];
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === "'") {
      const e = s.indexOf("'", j + 1);
      if (e === -1) return -1;
      j = e + 1;
      continue;
    }
    if (c === '"') {
      j++;
      while (j < s.length && s[j] !== '"') {
        if (s[j] === '\\') j++;
        else if (s[j] === '$' && s[j + 1] === '(') {
          const e = findMatchingParen(s, j + 2);
          if (e === -1) return -1;
          j = e;
        }
        j++;
      }
      j++;
      continue;
    }
    if (c === '#' && (j === start || /\s/.test(s[j - 1]))) {
      while (j < s.length && s[j] !== '\n') j++;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      if (depth === 0) return j;
      depth--;
    }
    j++;
  }
  return -1;
}

function parseBraceParam(inner: string): WordPart {
  if (inner.startsWith('#') && inner.length > 1 && /^#[A-Za-z_0-9@*#?]/.test(inner) && !/^#[#%]/.test(inner.slice(1))) {
    const m = /^([^[]*)\[(.*)\]$/.exec(inner.slice(1));
    if (m) return { t: 'param', name: m[1], length: true, index: m[2] };
    return { t: 'param', name: inner.slice(1), length: true };
  }
  const m = /^([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*#?$!\-])/.exec(inner);
  if (!m) throw new ShellSyntaxError(`bad substitution: \${${inner}}`);
  const name = m[1];
  let rest = inner.slice(name.length);
  if (!rest) return { t: 'param', name };
  // ${a[0]}: indexed arrays exist only for BASH_REMATCH; other names treat [0] as the plain value
  let index: string | undefined;
  if (rest.startsWith('[')) {
    const e = rest.indexOf(']');
    index = rest.slice(1, e);
    rest = rest.slice(e + 1);
    if (!rest) return { t: 'param', name, index };
  }
  const opm = /^(:-|:=|:\?|:\+|-|=|\?|\+|##|#|%%|%|\/\/|\/#|\/%|\/|\^\^|\^|,,|,|:)/.exec(rest);
  if (!opm) throw new ShellSyntaxError(`bad substitution: \${${inner}}`);
  const op = opm[1];
  const argSrc = rest.slice(op.length);
  if (op.startsWith('/')) {
    // ${x/pat/rep}
    let k = 0;
    let pat = '';
    while (k < argSrc.length && argSrc[k] !== '/') {
      if (argSrc[k] === '\\') pat += argSrc[k++];
      pat += argSrc[k++];
    }
    const rep = argSrc.slice(k + 1);
    return { t: 'param', name, index, op, arg: new Parser(pat).readWordAll(), arg2: new Parser(rep).readWordAll() };
  }
  if (op === ':') {
    // ${x:off:len}
    const [off, len] = argSrc.split(':');
    return { t: 'param', name, index, op: ':', arg: [{ t: 'lit', v: off }], arg2: len !== undefined ? [{ t: 'lit', v: len }] : undefined };
  }
  return { t: 'param', name, index, op, arg: new Parser(argSrc).readWordAll() };
}

// helper used for ${...} arguments: reads the whole string as one word (spaces kept literally)
(Parser.prototype as any).readWordAll = function (this: Parser): Word {
  const parts: WordPart[] = [];
  while (this.i < this.s.length) {
    const w = this.readWord();
    parts.push(...w);
    if (this.i < this.s.length) {
      parts.push({ t: 'lit', v: this.s[this.i] });
      this.i++;
    }
  }
  return parts;
};
export interface Parser {
  readWordAll(): Word;
}

export function wordToLiteral(w: Word): string | null {
  let s = '';
  for (const p of w) {
    if (p.t === 'lit' || p.t === 'sq') s += p.v;
    else return null;
  }
  return s;
}

function wordToRawish(w: Word): string {
  let s = '';
  for (const p of w) {
    if (p.t === 'lit' || p.t === 'sq') s += p.v;
    else if (p.t === 'dq') s += wordToRawish(p.parts);
  }
  return s;
}

export function isName(s: string) {
  return NAME_RE.test(s);
}
