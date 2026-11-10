/**
 * A small Python-subset interpreter for the chat harness.
 *
 * The model uses it for exact arithmetic, schedule and date maths and tallies over the
 * records it was given. Programs are parsed into a tree and walked here: nothing is handed
 * to the JavaScript engine, values are only the types defined below, and attribute access
 * goes through fixed method tables. Every program runs inside step, allocation, depth and
 * output budgets, so a hostile or runaway program ends with an error the model can read.
 *
 * Numbers are JavaScript doubles: `6 / 2` prints `3`, and integers above 2**53 lose precision.
 */

export type PythonResult = { ok: true; output: string } | { ok: false; output: string; error: string };
export type PythonOptions = { today?: string; maxSteps?: number };

export const PYTHON_LIMITS = { source: 4000, steps: 200_000, cells: 1_000_000, sequence: 20_000, text: 20_000, output: 4000, depth: 40 } as const;

class PyError extends Error {}
class Tuple { constructor(readonly items: Value[]) {} }
class Dict { readonly map = new Map<string, [Value, Value]>(); }
class PySet { readonly map = new Map<string, Value>(); }
class Fn { constructor(readonly name: string, readonly call: (args: Value[], kwargs: Map<string, Value>) => Value) {} }
class Namespace { constructor(readonly name: string, readonly members: Map<string, Value>) {} }
type Value = number | string | boolean | null | Value[] | Tuple | Dict | PySet | Fn | Namespace;

type Token = { t: "num" | "str" | "fstr" | "name" | "op" | "nl" | "indent" | "dedent" | "eof"; v: string; n?: number; line: number };

const KEYWORDS = new Set(["and", "or", "not", "in", "is", "if", "elif", "else", "for", "while", "def", "return", "break", "continue", "pass", "lambda", "True", "False", "None", "import", "from", "class", "try", "except", "finally", "with", "raise", "global", "nonlocal", "assert", "del", "yield", "async", "await", "as"]);
const OPERATORS = ["**=", "//=", "**", "//", "==", "!=", "<=", ">=", "+=", "-=", "*=", "/=", "%=", "+", "-", "*", "/", "%", "<", ">", "=", "(", ")", "[", "]", "{", "}", ",", ":", ".", ";", "|", "&"];
const NAME = /^[A-Za-z_一-鿿][\w一-鿿]*/;
const NUMBER = /^(?:\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d+)?|\.\d[\d_]*(?:[eE][+-]?\d+)?)/;
const ESCAPES = new Map([["n", "\n"], ["t", "\t"], ["r", "\r"], ["\\", "\\"], ["'", "'"], ['"', '"'], ["0", "\0"]]);

function tokenize(source: string): Token[] {
  const tokens: Token[] = [], indents = [0];
  let i = 0, line = 1, depth = 0, lineStart = true;
  const fail = (message: string): never => { throw new PyError(`第 ${line} 行：${message}`); };
  while (i < source.length) {
    if (lineStart && depth === 0) {
      let width = 0;
      while (source[i] === " " || source[i] === "\t") { width += source[i] === "\t" ? 4 : 1; i++; }
      if (i >= source.length || source[i] === "\n" || source[i] === "\r" || source[i] === "#") {
        while (i < source.length && source[i] !== "\n") i++;
        if (i < source.length) { i++; line++; }
        continue;
      }
      if (width > indents.at(-1)!) { indents.push(width); tokens.push({ t: "indent", v: "", line }); }
      else {
        while (width < indents.at(-1)!) { indents.pop(); tokens.push({ t: "dedent", v: "", line }); }
        if (width !== indents.at(-1)) fail("缩进不一致");
      }
      lineStart = false;
    }
    const c = source[i];
    if (c === "\n") { if (depth === 0) { tokens.push({ t: "nl", v: "", line }); lineStart = true; } i++; line++; continue; }
    if (c === " " || c === "\t" || c === "\r") { i++; continue; }
    if (c === "#") { while (i < source.length && source[i] !== "\n") i++; continue; }
    if (c === "\\" && source[i + 1] === "\n") { i += 2; line++; continue; }
    const rest = source.slice(i, i + 80);
    const quoted = /^([fFrR]{0,2})('''|"""|'|")/.exec(rest);
    if (quoted) {
      const prefix = quoted[1].toLowerCase(), quote = quoted[2], raw = prefix.includes("r"), start = line;
      let text = "";
      i += quoted[0].length;
      for (;;) {
        if (i >= source.length) { line = start; fail("字符串没有结束"); }
        if (source.startsWith(quote, i)) { i += quote.length; break; }
        const ch = source[i];
        if (ch === "\n") { if (quote.length === 1) fail("字符串没有结束"); line++; }
        if (ch === "\\" && !raw && i + 1 < source.length) {
          const next = source[i + 1];
          text += next === "\n" ? "" : ESCAPES.get(next) ?? `\\${next}`;
          if (next === "\n") line++;
          i += 2;
        } else { text += ch; i++; }
        if (text.length > PYTHON_LIMITS.text) fail("字符串过长");
      }
      tokens.push({ t: prefix.includes("f") ? "fstr" : "str", v: text, line: start });
      continue;
    }
    const number = NUMBER.exec(rest);
    if (number) {
      const value = Number(number[0].replace(/_/g, ""));
      if (!Number.isFinite(value)) fail("数字无效");
      tokens.push({ t: "num", v: number[0], n: value, line }); i += number[0].length; continue;
    }
    const name = NAME.exec(rest);
    if (name) { tokens.push({ t: "name", v: name[0], line }); i += name[0].length; continue; }
    const operator = OPERATORS.find((item) => source.startsWith(item, i));
    if (!operator) fail(`无法识别的字符 ${JSON.stringify(c)}`);
    if ("([{".includes(operator!)) depth++;
    if (")]}".includes(operator!)) depth = Math.max(0, depth - 1);
    tokens.push({ t: "op", v: operator!, line }); i += operator!.length;
  }
  if (tokens.length && tokens.at(-1)!.t !== "nl") tokens.push({ t: "nl", v: "", line });
  while (indents.length > 1) { indents.pop(); tokens.push({ t: "dedent", v: "", line }); }
  tokens.push({ t: "eof", v: "", line });
  return tokens;
}

type Clause = { target: Expr; iter: Expr; conds: Expr[] };
type FormatPart = string | { e: Expr; spec: string; repr: boolean };
type Expr = { line: number } & (
  | { k: "num"; v: number } | { k: "str"; v: string } | { k: "const"; v: boolean | null } | { k: "name"; id: string }
  | { k: "fstr"; parts: FormatPart[] }
  | { k: "list" | "tuple" | "set"; items: Expr[] } | { k: "dict"; pairs: [Expr, Expr][] }
  | { k: "comp"; kind: "list" | "dict" | "set"; elt: Expr; key?: Expr; clauses: Clause[] }
  | { k: "unary"; op: string; e: Expr } | { k: "bin"; op: string; a: Expr; b: Expr } | { k: "logic"; op: "and" | "or"; a: Expr; b: Expr }
  | { k: "cmp"; first: Expr; ops: string[]; rest: Expr[] } | { k: "cond"; test: Expr; a: Expr; b: Expr }
  | { k: "call"; fn: Expr; args: Expr[]; kwargs: [string, Expr][] }
  | { k: "index"; e: Expr; i: Expr } | { k: "slice"; e: Expr; lo: Expr | null; hi: Expr | null; step: Expr | null }
  | { k: "attr"; e: Expr; name: string } | { k: "lambda"; params: string[]; body: Expr }
);
type Stmt = { line: number } & (
  | { k: "expr"; e: Expr } | { k: "assign"; targets: Expr[]; value: Expr } | { k: "aug"; target: Expr; op: string; value: Expr }
  | { k: "if"; branches: [Expr, Stmt[]][]; orelse: Stmt[] } | { k: "for"; target: Expr; iter: Expr; body: Stmt[] }
  | { k: "while"; test: Expr; body: Stmt[] } | { k: "def"; name: string; params: string[]; defaults: (Expr | null)[]; body: Stmt[] }
  | { k: "return"; e: Expr | null } | { k: "break" } | { k: "continue" } | { k: "pass" } | { k: "import"; name: string }
);

const UNSUPPORTED = new Map(["class", "try", "with", "raise", "global", "nonlocal", "assert", "del", "yield", "async", "await"].map((word) => [word, `不支持 ${word}`]));

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}
  private get tok() { return this.tokens[this.pos]; }
  private kind(): Token["t"] { return this.tokens[this.pos].t; }
  private fail(message: string, token = this.tok): never { throw new PyError(`第 ${token.line} 行：${message}`); }
  private is(value: string, type: Token["t"] = "op") { const token = this.tok; return token.t === type && token.v === value; }
  private word(value: string) { return this.is(value, "name"); }
  private accept(value: string, type: Token["t"] = "op") { if (this.is(value, type)) { this.pos++; return true; } return false; }
  private expect(value: string, type: Token["t"] = "op") { if (!this.accept(value, type)) this.fail(`这里需要 ${value}`); }
  private name(): string {
    const token = this.tok;
    if (token.t !== "name" || KEYWORDS.has(token.v)) this.fail("这里需要一个名称");
    this.pos++; return token.v;
  }

  program(): Stmt[] {
    const body: Stmt[] = [];
    for (let token = this.tok; token.t !== "eof"; token = this.tok) {
      if (token.t === "nl") { this.pos++; continue; }
      if (token.t === "indent") this.fail("意外的缩进");
      body.push(...this.statement());
    }
    return body;
  }
  private block(): Stmt[] {
    this.expect(":");
    if (this.kind() !== "nl") return this.simpleLine();
    this.pos++;
    if (this.kind() !== "indent") this.fail("这里需要缩进的代码块");
    this.pos++;
    const body: Stmt[] = [];
    for (let kind = this.kind(); kind !== "dedent" && kind !== "eof"; kind = this.kind()) {
      if (kind === "nl") this.pos++; else body.push(...this.statement());
    }
    if (this.kind() === "dedent") this.pos++;
    return body;
  }
  private simpleLine(): Stmt[] {
    const list = [this.simple()];
    while (this.accept(";")) { if (this.tok.t === "nl") break; list.push(this.simple()); }
    if (this.tok.t !== "nl" && this.tok.t !== "eof") this.fail("这一行的语法无法识别");
    if (this.tok.t === "nl") this.pos++;
    return list;
  }
  private statement(): Stmt[] {
    const token = this.tok, line = token.line;
    if (token.t === "name") {
      if (UNSUPPORTED.has(token.v)) this.fail(UNSUPPORTED.get(token.v)!);
      if (token.v === "if") {
        this.pos++;
        const branches: [Expr, Stmt[]][] = [[this.expression(), this.block()]];
        let orelse: Stmt[] = [];
        for (;;) {
          if (this.accept("elif", "name")) branches.push([this.expression(), this.block()]);
          else if (this.accept("else", "name")) { orelse = this.block(); break; }
          else break;
        }
        return [{ k: "if", branches, orelse, line }];
      }
      if (token.v === "for") {
        this.pos++;
        const target = this.targets(); this.expect("in", "name");
        return [{ k: "for", target, iter: this.expressionList(), body: this.block(), line }];
      }
      if (token.v === "while") { this.pos++; return [{ k: "while", test: this.expression(), body: this.block(), line }]; }
      if (token.v === "def") {
        this.pos++;
        const name = this.name(), params: string[] = [], defaults: (Expr | null)[] = [];
        this.expect("(");
        while (!this.is(")")) {
          if (this.is("*") || this.is("**")) this.fail("不支持 *args / **kwargs");
          params.push(this.name());
          defaults.push(this.accept("=") ? this.expression() : null);
          if (!this.accept(",")) break;
        }
        this.expect(")");
        return [{ k: "def", name, params, defaults, body: this.block(), line }];
      }
    }
    return this.simpleLine();
  }
  private simple(): Stmt {
    const token = this.tok, line = token.line;
    if (token.t === "name") {
      if (UNSUPPORTED.has(token.v)) this.fail(UNSUPPORTED.get(token.v)!);
      if (token.v === "pass") { this.pos++; return { k: "pass", line }; }
      if (token.v === "break") { this.pos++; return { k: "break", line }; }
      if (token.v === "continue") { this.pos++; return { k: "continue", line }; }
      if (token.v === "return") { this.pos++; return { k: "return", e: this.tok.t === "nl" || this.is(";") ? null : this.expressionList(), line }; }
      if (token.v === "import" || token.v === "from") {
        this.pos++;
        const name = this.name();
        if (token.v === "from" || name !== "math" || this.tok.t !== "nl") this.fail("只能写 import math；日期用 today()、add_days()、days_between()、weekday()，统计用 mean()、median()");
        return { k: "import", name, line };
      }
    }
    const first = this.expressionList();
    const augmented = ["+=", "-=", "*=", "/=", "//=", "%=", "**="].find((op) => this.is(op));
    if (augmented) { this.pos++; this.assignable(first, false); return { k: "aug", target: first, op: augmented.slice(0, -1), value: this.expressionList(), line }; }
    if (this.is("=")) {
      const targets = [first];
      let value = first;
      while (this.accept("=")) { value = this.expressionList(); targets.push(value); }
      targets.pop();
      for (const target of targets) this.assignable(target, true);
      return { k: "assign", targets, value, line };
    }
    return { k: "expr", e: first, line };
  }
  private assignable(target: Expr, unpack: boolean) {
    if (target.k === "name" || target.k === "index") return;
    if (unpack && (target.k === "tuple" || target.k === "list")) { for (const item of target.items) this.assignable(item, true); return; }
    throw new PyError(`第 ${target.line} 行：不能给这个表达式赋值`);
  }
  /** `a, b` in a `for` header or comprehension, stopping before `in`. */
  private targets(): Expr {
    const line = this.tok.line, items = [this.postfix()];
    let tuple = false;
    while (this.accept(",")) { tuple = true; if (this.word("in")) break; items.push(this.postfix()); }
    const target: Expr = tuple ? { k: "tuple", items, line } : items[0];
    this.assignable(target, true);
    return target;
  }
  private expressionList(): Expr {
    const line = this.tok.line, first = this.expression();
    if (!this.is(",")) return first;
    const items = [first];
    while (this.accept(",")) {
      if (this.tok.t === "nl" || this.is("=") || this.is(")") || this.is(":")) break;
      items.push(this.expression());
    }
    return { k: "tuple", items, line };
  }
  expression(): Expr {
    const line = this.tok.line;
    if (this.word("lambda")) {
      this.pos++;
      const params: string[] = [];
      while (!this.is(":")) { params.push(this.name()); if (!this.accept(",")) break; }
      this.expect(":");
      return { k: "lambda", params, body: this.expression(), line };
    }
    const value = this.or();
    if (this.accept("if", "name")) {
      const test = this.or(); this.expect("else", "name");
      return { k: "cond", test, a: value, b: this.expression(), line };
    }
    return value;
  }
  private or(): Expr {
    let left = this.and();
    while (this.word("or")) { const line = this.tok.line; this.pos++; left = { k: "logic", op: "or", a: left, b: this.and(), line }; }
    return left;
  }
  private and(): Expr {
    let left = this.not();
    while (this.word("and")) { const line = this.tok.line; this.pos++; left = { k: "logic", op: "and", a: left, b: this.not(), line }; }
    return left;
  }
  private not(): Expr {
    if (this.word("not")) { const line = this.tok.line; this.pos++; return { k: "unary", op: "not", e: this.not(), line }; }
    return this.comparison();
  }
  private comparison(): Expr {
    const line = this.tok.line, first = this.union(), ops: string[] = [], rest: Expr[] = [];
    for (;;) {
      let op = ["==", "!=", "<=", ">=", "<", ">"].find((item) => this.is(item));
      if (op) this.pos++;
      else if (this.word("in")) { this.pos++; op = "in"; }
      else if (this.word("not") && this.tokens[this.pos + 1].t === "name" && this.tokens[this.pos + 1].v === "in") { this.pos += 2; op = "not in"; }
      else if (this.word("is")) { this.pos++; op = this.accept("not", "name") ? "is not" : "is"; }
      else break;
      ops.push(op); rest.push(this.union());
    }
    return ops.length ? { k: "cmp", first, ops, rest, line } : first;
  }
  private binary(next: () => Expr, operators: string[]): Expr {
    let left = next();
    for (;;) {
      const op = operators.find((item) => this.is(item));
      if (!op) return left;
      const line = this.tok.line; this.pos++;
      left = { k: "bin", op, a: left, b: next(), line };
    }
  }
  private union(): Expr { return this.binary(() => this.binary(() => this.sum(), ["&"]), ["|"]); }
  private sum(): Expr { return this.binary(() => this.product(), ["+", "-"]); }
  private product(): Expr { return this.binary(() => this.unary(), ["*", "/", "//", "%"]); }
  private unary(): Expr {
    const line = this.tok.line;
    if (this.accept("-")) return { k: "unary", op: "-", e: this.unary(), line };
    if (this.accept("+")) return { k: "unary", op: "+", e: this.unary(), line };
    return this.power();
  }
  private power(): Expr {
    const base = this.postfix();
    if (this.is("**")) { const line = this.tok.line; this.pos++; return { k: "bin", op: "**", a: base, b: this.unary(), line }; }
    return base;
  }
  private postfix(): Expr {
    let value = this.atom();
    for (;;) {
      const line = this.tok.line;
      if (this.accept("(")) {
        const args: Expr[] = [], kwargs: [string, Expr][] = [];
        while (!this.is(")")) {
          if (this.is("*") || this.is("**")) this.fail("不支持 * 展开参数");
          if (this.tok.t === "name" && !KEYWORDS.has(this.tok.v) && this.tokens[this.pos + 1].t === "op" && this.tokens[this.pos + 1].v === "=") {
            const key = this.name(); this.pos++; kwargs.push([key, this.expression()]);
          } else {
            const argument = this.expression();
            args.push(this.word("for") ? { k: "comp", kind: "list", elt: argument, clauses: this.clauses(), line } : argument);
          }
          if (!this.accept(",")) break;
        }
        this.expect(")");
        value = { k: "call", fn: value, args, kwargs, line };
      } else if (this.accept("[")) {
        let lo: Expr | null = null, hi: Expr | null = null, step: Expr | null = null, slice = false;
        if (!this.is(":")) lo = this.expressionList();
        if (this.accept(":")) {
          slice = true;
          if (!this.is("]") && !this.is(":")) hi = this.expression();
          if (this.accept(":") && !this.is("]")) step = this.expression();
        }
        this.expect("]");
        value = slice ? { k: "slice", e: value, lo, hi, step, line } : { k: "index", e: value, i: lo!, line };
      } else if (this.accept(".")) {
        const token = this.tok;
        if (token.t !== "name") this.fail("这里需要属性名");
        this.pos++;
        value = { k: "attr", e: value, name: token.v, line };
      } else return value;
    }
  }
  private clauses(): Clause[] {
    const clauses: Clause[] = [];
    while (this.accept("for", "name")) {
      const target = this.targets(); this.expect("in", "name");
      const iter = this.or(), conds: Expr[] = [];
      while (this.accept("if", "name")) conds.push(this.or());
      clauses.push({ target, iter, conds });
    }
    return clauses;
  }
  private atom(): Expr {
    const token = this.tok, line = token.line;
    if (token.t === "num") { this.pos++; return { k: "num", v: token.n!, line }; }
    if (token.t === "str" || token.t === "fstr") {
      const parts: FormatPart[] = [];
      let formatted = false;
      while (this.tok.t === "str" || this.tok.t === "fstr") {
        if (this.tok.t === "fstr") { formatted = true; parts.push(...this.formatParts(this.tok)); } else parts.push(this.tok.v);
        this.pos++;
      }
      return formatted ? { k: "fstr", parts, line } : { k: "str", v: parts.join(""), line };
    }
    if (token.t === "name") {
      if (token.v === "True" || token.v === "False") { this.pos++; return { k: "const", v: token.v === "True", line }; }
      if (token.v === "None") { this.pos++; return { k: "const", v: null, line }; }
      if (UNSUPPORTED.has(token.v)) this.fail(UNSUPPORTED.get(token.v)!);
      if (KEYWORDS.has(token.v)) this.fail(`这里不能出现 ${token.v}`);
      this.pos++; return { k: "name", id: token.v, line };
    }
    if (this.accept("(")) {
      if (this.accept(")")) return { k: "tuple", items: [], line };
      const first = this.expression();
      if (this.word("for")) { const clauses = this.clauses(); this.expect(")"); return { k: "comp", kind: "list", elt: first, clauses, line }; }
      if (!this.is(",")) { this.expect(")"); return first; }
      const items = [first];
      while (this.accept(",")) { if (this.is(")")) break; items.push(this.expression()); }
      this.expect(")");
      return { k: "tuple", items, line };
    }
    if (this.accept("[")) {
      if (this.accept("]")) return { k: "list", items: [], line };
      const first = this.expression();
      if (this.word("for")) { const clauses = this.clauses(); this.expect("]"); return { k: "comp", kind: "list", elt: first, clauses, line }; }
      const items = [first];
      while (this.accept(",")) { if (this.is("]")) break; items.push(this.expression()); }
      this.expect("]");
      return { k: "list", items, line };
    }
    if (this.accept("{")) {
      if (this.accept("}")) return { k: "dict", pairs: [], line };
      const first = this.expression();
      if (this.accept(":")) {
        const value = this.expression();
        if (this.word("for")) { const clauses = this.clauses(); this.expect("}"); return { k: "comp", kind: "dict", key: first, elt: value, clauses, line }; }
        const pairs: [Expr, Expr][] = [[first, value]];
        while (this.accept(",")) { if (this.is("}")) break; const key = this.expression(); this.expect(":"); pairs.push([key, this.expression()]); }
        this.expect("}");
        return { k: "dict", pairs, line };
      }
      if (this.word("for")) { const clauses = this.clauses(); this.expect("}"); return { k: "comp", kind: "set", elt: first, clauses, line }; }
      const items = [first];
      while (this.accept(",")) { if (this.is("}")) break; items.push(this.expression()); }
      this.expect("}");
      return { k: "set", items, line };
    }
    return this.fail(token.t === "nl" || token.t === "eof" ? "表达式不完整" : `这里不能出现 ${token.v || "缩进"}`);
  }
  private formatParts(token: Token): FormatPart[] {
    const text = token.v, parts: FormatPart[] = [];
    let literal = "", i = 0;
    const fail = (message: string): never => { throw new PyError(`第 ${token.line} 行：f-string ${message}`); };
    while (i < text.length) {
      const c = text[i];
      if ((c === "{" || c === "}") && text[i + 1] === c) { literal += c; i += 2; continue; }
      if (c === "}") fail("里有多余的 }");
      if (c !== "{") { literal += c; i++; continue; }
      let depth = 0, end = i + 1, colon = -1, quote = "";
      for (; end < text.length; end++) {
        const ch = text[end];
        if (quote) { if (ch === quote) quote = ""; continue; }
        if (ch === "'" || ch === '"') quote = ch;
        else if ("([{".includes(ch)) depth++;
        else if (")]".includes(ch) || (ch === "}" && depth > 0)) depth--;
        else if (ch === "}") break;
        else if (ch === ":" && depth === 0 && colon < 0) colon = end;
      }
      if (end >= text.length) fail("缺少 }");
      let source = text.slice(i + 1, colon < 0 ? end : colon);
      const spec = colon < 0 ? "" : text.slice(colon + 1, end);
      const repr = /!r\s*$/.test(source);
      source = source.replace(/![rs]\s*$/, "");
      if (!source.trim()) fail("的 {} 里需要表达式");
      const inner = new Parser(tokenize(source.trim()).map((item) => ({ ...item, line: token.line })));
      const e = inner.expression();
      if (inner.tok.t !== "nl" && inner.tok.t !== "eof") fail("里的表达式无法识别");
      if (literal) { parts.push(literal); literal = ""; }
      parts.push({ e, spec, repr });
      i = end + 1;
    }
    if (literal) parts.push(literal);
    return parts;
  }
}

class Break {}
class Continue {}
class Return { constructor(readonly value: Value) {} }
type Scope = { vars: Map<string, Value>; parent: Scope | null };

/** Work done outside the tree walk (comparing, printing, hashing) is charged to the running program. */
let charge: (count: number) => void = () => undefined;
const weight = (value: Value): number => typeof value === "string" || Array.isArray(value) ? value.length : value instanceof Tuple ? value.items.length : value instanceof Dict || value instanceof PySet ? value.map.size : 0;
const typeName = (value: Value): string => value === null ? "NoneType" : typeof value === "number" ? "number" : typeof value === "string" ? "str" : typeof value === "boolean" ? "bool"
  : Array.isArray(value) ? "list" : value instanceof Tuple ? "tuple" : value instanceof Dict ? "dict" : value instanceof PySet ? "set" : value instanceof Namespace ? "module" : "function";
const isNumber = (value: Value): value is number | boolean => typeof value === "number" || typeof value === "boolean";
const truthy = (value: Value): boolean => value === null ? false : typeof value === "boolean" ? value : typeof value === "number" ? value !== 0 : typeof value === "string" ? value.length > 0
  : Array.isArray(value) ? value.length > 0 : value instanceof Tuple ? value.items.length > 0 : value instanceof Dict || value instanceof PySet ? value.map.size > 0 : true;

function hashKey(value: Value): string {
  if (value === null) return "z";
  if (isNumber(value)) return `n${Number(value)}`;
  if (typeof value === "string") return `s${value}`;
  if (value instanceof Tuple) { charge(value.items.length); return `t${JSON.stringify(value.items.map(hashKey))}`; }
  throw new PyError(`${typeName(value)} 不能作为字典的键或集合的元素`);
}
function formatNumber(value: number): string {
  if (Number.isNaN(value)) return "nan";
  if (!Number.isFinite(value)) return value > 0 ? "inf" : "-inf";
  return Object.is(value, -0) ? "0" : String(value);
}
/** Python-style text for a value, cut off once it is longer than anything the caller can keep. */
function show(value: Value, quoted: boolean): string {
  const limit = PYTHON_LIMITS.text * 2;
  let out = "";
  const write = (item: Value, quote: boolean, depth: number) => {
    if (out.length > limit) return;
    charge(1);
    if (depth > 12) out += "...";
    else if (item === null) out += "None";
    else if (typeof item === "boolean") out += item ? "True" : "False";
    else if (typeof item === "number") out += formatNumber(item);
    else if (typeof item === "string") out += quote ? `'${item.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n")}'` : item;
    else if (item instanceof Fn) out += `<function ${item.name}>`;
    else if (item instanceof Namespace) out += `<module ${item.name}>`;
    else if (item instanceof Dict) {
      out += "{";
      let first = true;
      for (const [key, entry] of item.map.values()) { if (!first) out += ", "; first = false; write(key, true, depth + 1); out += ": "; write(entry, true, depth + 1); }
      out += "}";
    } else {
      const items = Array.isArray(item) ? item : item instanceof Tuple ? item.items : [...item.map.values()];
      if (item instanceof PySet && !items.length) { out += "set()"; return; }
      out += Array.isArray(item) ? "[" : item instanceof Tuple ? "(" : "{";
      items.forEach((entry, index) => { if (index) out += ", "; write(entry, true, depth + 1); });
      out += Array.isArray(item) ? "]" : item instanceof Tuple ? (items.length === 1 ? ",)" : ")") : "}";
    }
  };
  write(value, quoted, 0);
  return out.length > limit ? `${out.slice(0, limit)}…` : out;
}
function equal(a: Value, b: Value, depth = 0): boolean {
  if (depth > 40) throw new PyError("比较的结构嵌套过深");
  charge(1);
  if (isNumber(a) && isNumber(b)) return Number(a) === Number(b);
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return a === b;
  const left = Array.isArray(a) ? a : a instanceof Tuple ? a.items : null, right = Array.isArray(b) ? b : b instanceof Tuple ? b.items : null;
  if (left && right) return Array.isArray(a) === Array.isArray(b) && left.length === right.length && left.every((item, index) => equal(item, right[index], depth + 1));
  if (a instanceof Dict && b instanceof Dict) return a.map.size === b.map.size && [...a.map].every(([key, [, item]]) => b.map.has(key) && equal(item, b.map.get(key)![1], depth + 1));
  if (a instanceof PySet && b instanceof PySet) return a.map.size === b.map.size && [...a.map.keys()].every((key) => b.map.has(key));
  return a === b;
}
function order(a: Value, b: Value, depth = 0): number {
  if (depth > 40) throw new PyError("比较的结构嵌套过深");
  charge(1);
  if (isNumber(a) && isNumber(b)) return Number(a) < Number(b) ? -1 : Number(a) > Number(b) ? 1 : 0;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  const left = Array.isArray(a) ? a : a instanceof Tuple ? a.items : null, right = Array.isArray(b) ? b : b instanceof Tuple ? b.items : null;
  if (left && right && Array.isArray(a) === Array.isArray(b)) {
    for (let index = 0; index < Math.min(left.length, right.length); index++) { const result = order(left[index], right[index], depth + 1); if (result) return result; }
    return left.length - right.length;
  }
  throw new PyError(`${typeName(a)} 和 ${typeName(b)} 不能比较大小`);
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
function dayNumber(value: Value): number {
  const match = typeof value === "string" ? DATE.exec(value) : null;
  const time = match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : NaN;
  if (!match || Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== value) throw new PyError("日期要写成 'YYYY-MM-DD'");
  return Math.round(time / 86_400_000);
}
const dayText = (day: number) => new Date(day * 86_400_000).toISOString().slice(0, 10);

function formatValue(value: Value, spec: string): string {
  if (!spec) return show(value, false);
  const match = /^(?:(.)?([<>^]))?(\+)?(0)?(\d+)?(,)?(?:\.(\d+))?([dfs%eg])?$/.exec(spec);
  if (!match) throw new PyError(`不支持的格式 ${JSON.stringify(spec)}`);
  const [, fill, align, plus, zero, widthText, comma, precisionText, type] = match;
  const width = Math.min(Number(widthText || 0), 200), precision = precisionText === undefined ? undefined : Math.min(Number(precisionText), 20);
  let body: string;
  if (isNumber(value) && type !== "s") {
    const number = Number(value);
    if (!Number.isFinite(number)) body = formatNumber(number);
    else if (type === "f") body = number.toFixed(precision ?? 6);
    else if (type === "%") body = `${(number * 100).toFixed(precision ?? 6)}%`;
    else if (type === "e") body = number.toExponential(precision ?? 6);
    else if (type === "d") body = String(Math.trunc(number));
    else body = precision === undefined ? formatNumber(number) : String(Number(number.toPrecision(Math.max(1, precision))));
    if (comma) body = body.replace(/^(-?\d+)/, (digits) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ","));
    if (plus && number >= 0) body = `+${body}`;
  } else {
    if (type && type !== "s") throw new PyError(`格式 ${JSON.stringify(spec)} 只能用于数字`);
    body = show(value, false);
    if (precision !== undefined) body = body.slice(0, precision);
  }
  if (body.length >= width) return body;
  const pad = (fill ?? (zero ? "0" : " ")).repeat(width - body.length), side = align ?? (isNumber(value) || zero ? ">" : "<");
  return side === "<" ? body + pad : side === ">" ? pad + body : pad.slice(0, Math.floor(pad.length / 2)) + body + pad.slice(Math.floor(pad.length / 2));
}

class Interpreter {
  private steps = 0;
  private cells = 0;
  private depth = 0;
  private output = "";
  private truncated = false;
  private readonly globals: Scope = { vars: new Map(), parent: null };
  private readonly builtins = new Map<string, Value>();
  private readonly maxSteps: number;

  constructor(private readonly options: PythonOptions) {
    this.maxSteps = Math.min(options.maxSteps ?? PYTHON_LIMITS.steps, PYTHON_LIMITS.steps);
    this.installBuiltins();
  }

  run(body: Stmt[]): string {
    const last = body.at(-1);
    for (const statement of body) {
      if (statement === last && statement.k === "expr") {
        const value = this.eval(statement.e, this.globals);
        if (value !== null) this.print(show(value, true) + "\n");
      } else {
        try { this.exec(statement, this.globals); }
        catch (signal) {
          if (signal instanceof Return || signal instanceof Break || signal instanceof Continue) throw new PyError(`第 ${statement.line} 行：return、break、continue 只能写在函数或循环里`);
          throw signal;
        }
      }
    }
    return this.result();
  }
  result() { return this.output + (this.truncated ? "\n…（输出过长，后面的内容已省略）" : ""); }

  tick(count = 1) { this.steps += count; if (this.steps > this.maxSteps) throw new PyError("运算步数超出上限，请缩小循环或数据量"); }
  private allocate(count: number) { this.cells += count; if (this.cells > PYTHON_LIMITS.cells) throw new PyError("占用的内存超出上限"); }
  private list<T extends Value[]>(items: T): T {
    if (items.length > PYTHON_LIMITS.sequence) throw new PyError(`列表最多 ${PYTHON_LIMITS.sequence} 项`);
    this.allocate(items.length + 1); return items;
  }
  private text(value: string): string {
    if (value.length > PYTHON_LIMITS.text) throw new PyError(`字符串最多 ${PYTHON_LIMITS.text} 个字符`);
    this.allocate(value.length + 1); return value;
  }
  private print(text: string) {
    if (this.truncated) return;
    const room = PYTHON_LIMITS.output - this.output.length;
    if (text.length > room) { this.output += text.slice(0, Math.max(0, room)); this.truncated = true; } else this.output += text;
  }
  private at(node: { line: number }, error: unknown): never {
    if (error instanceof PyError && !/^第 \d+ 行/.test(error.message)) throw new PyError(`第 ${node.line} 行：${error.message}`);
    throw error;
  }

  private lookup(name: string, scope: Scope): Value {
    for (let current: Scope | null = scope; current; current = current.parent) if (current.vars.has(name)) return current.vars.get(name)!;
    if (this.builtins.has(name)) return this.builtins.get(name)!;
    throw new PyError(`没有定义 ${name}`);
  }
  private iterate(value: Value): Value[] {
    if (Array.isArray(value)) return value;
    if (value instanceof Tuple) return value.items;
    if (typeof value === "string") { this.tick(value.length); return Array.from(value); }
    if (value instanceof Dict) { this.tick(value.map.size); return [...value.map.values()].map(([key]) => key); }
    if (value instanceof PySet) { this.tick(value.map.size); return [...value.map.values()]; }
    throw new PyError(`${typeName(value)} 不能遍历`);
  }
  private number(value: Value, what = "这里"): number {
    if (!isNumber(value)) throw new PyError(`${what}需要数字，得到的是 ${typeName(value)}`);
    return Number(value);
  }
  private integer(value: Value, what = "这里"): number {
    const number = this.number(value, what);
    if (!Number.isInteger(number)) throw new PyError(`${what}需要整数`);
    return number;
  }
  private position(index: Value, length: number): number {
    const value = this.integer(index, "下标"), resolved = value < 0 ? value + length : value;
    if (resolved < 0 || resolved >= length) throw new PyError("下标超出范围");
    return resolved;
  }
  private assign(target: Expr, value: Value, scope: Scope) {
    if (target.k === "name") { scope.vars.set(target.id, value); return; }
    if (target.k === "tuple" || target.k === "list") {
      const items = this.iterate(value);
      if (items.length !== target.items.length) throw new PyError(`解包需要 ${target.items.length} 个值，实际有 ${items.length} 个`);
      target.items.forEach((item, index) => this.assign(item, items[index], scope));
      return;
    }
    if (target.k === "index") {
      const container = this.eval(target.e, scope), key = this.eval(target.i, scope);
      if (Array.isArray(container)) container[this.position(key, container.length)] = value;
      else if (container instanceof Dict) this.setItem(container, key, value);
      else throw new PyError(`${typeName(container)} 不支持按下标赋值`);
      return;
    }
    throw new PyError("不能给这个表达式赋值");
  }
  private setItem(dict: Dict, key: Value, value: Value) {
    const hash = hashKey(key);
    if (!dict.map.has(hash)) { if (dict.map.size >= PYTHON_LIMITS.sequence) throw new PyError(`字典最多 ${PYTHON_LIMITS.sequence} 项`); this.allocate(2); }
    dict.map.set(hash, [key, value]);
  }
  private addItem(set: PySet, value: Value) {
    const hash = hashKey(value);
    if (!set.map.has(hash)) { if (set.map.size >= PYTHON_LIMITS.sequence) throw new PyError(`集合最多 ${PYTHON_LIMITS.sequence} 项`); this.allocate(1); set.map.set(hash, value); }
  }

  private exec(statement: Stmt, scope: Scope): void {
    this.tick();
    try {
      switch (statement.k) {
        case "expr": this.eval(statement.e, scope); return;
        case "assign": { const value = this.eval(statement.value, scope); for (const target of statement.targets) this.assign(target, value, scope); return; }
        case "aug": this.assign(statement.target, this.binary(statement.op, this.eval(statement.target, scope), this.eval(statement.value, scope)), scope); return;
        case "if":
          for (const [test, body] of statement.branches) if (truthy(this.eval(test, scope))) { this.body(body, scope); return; }
          this.body(statement.orelse, scope); return;
        case "for":
          for (let items = this.iterate(this.eval(statement.iter, scope)), index = 0; index < items.length; index++) {
            this.tick(); this.assign(statement.target, items[index], scope);
            try { this.body(statement.body, scope); } catch (signal) { if (signal instanceof Break) break; if (!(signal instanceof Continue)) throw signal; }
          }
          return;
        case "while":
          while (truthy(this.eval(statement.test, scope))) {
            this.tick();
            try { this.body(statement.body, scope); } catch (signal) { if (signal instanceof Break) break; if (!(signal instanceof Continue)) throw signal; }
          }
          return;
        case "def": {
          const defaults = statement.defaults.map((item) => item ? this.eval(item, scope) : undefined);
          scope.vars.set(statement.name, this.closure(statement.name, statement.params, defaults, scope, (local) => {
            try { this.body(statement.body, local); } catch (signal) { if (signal instanceof Return) return signal.value; throw signal; }
            return null;
          }));
          return;
        }
        case "return": throw new Return(statement.e ? this.eval(statement.e, scope) : null);
        case "break": throw new Break();
        case "continue": throw new Continue();
        case "import": scope.vars.set(statement.name, this.builtins.get("math")!); return;
        case "pass": return;
      }
    } catch (error) { this.at(statement, error); }
  }
  private body(body: Stmt[], scope: Scope) { for (const statement of body) this.exec(statement, scope); }
  private closure(name: string, params: string[], defaults: (Value | undefined)[], scope: Scope, run: (local: Scope) => Value): Fn {
    return new Fn(name, (args, kwargs) => {
      if (args.length > params.length) throw new PyError(`${name}() 最多接收 ${params.length} 个参数`);
      const local: Scope = { vars: new Map(), parent: scope };
      params.forEach((param, index) => {
        const value = index < args.length ? args[index] : kwargs.has(param) ? kwargs.get(param)! : defaults[index];
        if (value === undefined) throw new PyError(`${name}() 缺少参数 ${param}`);
        local.vars.set(param, value);
      });
      for (const key of kwargs.keys()) if (!params.includes(key)) throw new PyError(`${name}() 没有参数 ${key}`);
      if (++this.depth > PYTHON_LIMITS.depth) { this.depth--; throw new PyError("函数调用层数过深"); }
      try { return run(local); } finally { this.depth--; }
    });
  }

  private comprehension(node: Extract<Expr, { k: "comp" }>, scope: Scope): Value {
    const local: Scope = { vars: new Map(), parent: scope };
    const list: Value[] = [], dict = new Dict(), set = new PySet();
    const walk = (index: number) => {
      if (index === node.clauses.length) {
        this.tick();
        if (node.kind === "dict") this.setItem(dict, this.eval(node.key!, local), this.eval(node.elt, local));
        else if (node.kind === "set") this.addItem(set, this.eval(node.elt, local));
        else { if (list.length >= PYTHON_LIMITS.sequence) throw new PyError(`列表最多 ${PYTHON_LIMITS.sequence} 项`); this.allocate(1); list.push(this.eval(node.elt, local)); }
        return;
      }
      const clause = node.clauses[index];
      for (let items = this.iterate(this.eval(clause.iter, local)), position = 0; position < items.length; position++) {
        this.tick(); this.assign(clause.target, items[position], local);
        if (clause.conds.every((cond) => truthy(this.eval(cond, local)))) walk(index + 1);
      }
    };
    walk(0);
    return node.kind === "dict" ? dict : node.kind === "set" ? set : list;
  }

  private eval(node: Expr, scope: Scope): Value {
    this.tick();
    try {
      switch (node.k) {
        case "num": case "str": case "const": return node.v;
        case "name": return this.lookup(node.id, scope);
        case "fstr": return this.text(node.parts.map((part) => typeof part === "string" ? part : part.repr ? show(this.eval(part.e, scope), true) : formatValue(this.eval(part.e, scope), part.spec)).join(""));
        case "list": return this.list(node.items.map((item) => this.eval(item, scope)));
        case "tuple": return new Tuple(this.list(node.items.map((item) => this.eval(item, scope))));
        case "set": { const set = new PySet(); for (const item of node.items) this.addItem(set, this.eval(item, scope)); return set; }
        case "dict": { const dict = new Dict(); for (const [key, value] of node.pairs) this.setItem(dict, this.eval(key, scope), this.eval(value, scope)); return dict; }
        case "comp": return this.comprehension(node, scope);
        case "unary": {
          const value = this.eval(node.e, scope);
          return node.op === "not" ? !truthy(value) : node.op === "-" ? -this.number(value) : this.number(value);
        }
        case "logic": { const left = this.eval(node.a, scope); return (node.op === "and") === truthy(left) ? this.eval(node.b, scope) : left; }
        case "bin": return this.binary(node.op, this.eval(node.a, scope), this.eval(node.b, scope));
        case "cmp": {
          let left = this.eval(node.first, scope);
          for (let index = 0; index < node.ops.length; index++) {
            const right = this.eval(node.rest[index], scope);
            if (!this.compare(node.ops[index], left, right)) return false;
            left = right;
          }
          return true;
        }
        case "cond": return truthy(this.eval(node.test, scope)) ? this.eval(node.a, scope) : this.eval(node.b, scope);
        case "lambda": return this.closure("lambda", node.params, node.params.map(() => undefined), scope, (local) => this.eval(node.body, local));
        case "call": {
          const args = node.args.map((item) => this.eval(item, scope)), kwargs = new Map(node.kwargs.map(([key, item]) => [key, this.eval(item, scope)]));
          this.tick(args.reduce((total: number, item) => total + weight(item), 0));
          if (node.fn.k === "attr") {
            const owner = this.eval(node.fn.e, scope);
            this.tick(weight(owner));
            if (owner instanceof Namespace) return this.invoke(this.member(owner, node.fn.name), args, kwargs);
            return this.method(owner, node.fn.name, args, kwargs);
          }
          return this.invoke(this.eval(node.fn, scope), args, kwargs);
        }
        case "attr": {
          const owner = this.eval(node.e, scope);
          if (owner instanceof Namespace) return this.member(owner, node.name);
          throw new PyError(`方法 ${node.name} 需要直接调用，例如 x.${node.name}()`);
        }
        case "index": {
          const container = this.eval(node.e, scope), key = this.eval(node.i, scope);
          if (Array.isArray(container)) return container[this.position(key, container.length)];
          if (container instanceof Tuple) return container.items[this.position(key, container.items.length)];
          if (typeof container === "string") { this.tick(container.length); const chars = Array.from(container); return chars[this.position(key, chars.length)]; }
          if (container instanceof Dict) { const found = container.map.get(hashKey(key)); if (!found) throw new PyError(`字典里没有键 ${show(key, true)}`); return found[1]; }
          throw new PyError(`${typeName(container)} 不支持下标`);
        }
        case "slice": {
          const container = this.eval(node.e, scope);
          const items = Array.isArray(container) ? container : container instanceof Tuple ? container.items : typeof container === "string" ? Array.from(container) : null;
          if (!items) throw new PyError(`${typeName(container)} 不支持切片`);
          const bound = (expr: Expr | null) => { const value = expr ? this.eval(expr, scope) : null; return value === null ? null : this.integer(value, "切片"); };
          const step = bound(node.step) ?? 1, length = items.length;
          if (step === 0) throw new PyError("切片步长不能为 0");
          const clamp = (value: number | null, fallback: number) => value === null ? fallback : Math.max(step > 0 ? 0 : -1, Math.min(step > 0 ? length : length - 1, value < 0 ? value + length : value));
          const start = clamp(bound(node.lo), step > 0 ? 0 : length - 1), stop = clamp(bound(node.hi), step > 0 ? length : -1), picked: Value[] = [];
          for (let index = start; step > 0 ? index < stop : index > stop; index += step) picked.push(items[index]);
          this.tick(picked.length);
          return typeof container === "string" ? this.text(picked.join("")) : container instanceof Tuple ? new Tuple(this.list(picked)) : this.list(picked);
        }
      }
    } catch (error) { this.at(node, error); }
  }
  private member(owner: Namespace, name: string): Value {
    const value = owner.members.get(name);
    if (value === undefined) throw new PyError(`${owner.name} 没有 ${name}`);
    return value;
  }
  private invoke(fn: Value, args: Value[], kwargs: Map<string, Value>): Value {
    if (!(fn instanceof Fn)) throw new PyError(`${typeName(fn)} 不能调用`);
    return fn.call(args, kwargs);
  }
  private compare(op: string, left: Value, right: Value): boolean {
    switch (op) {
      case "==": return equal(left, right);
      case "!=": return !equal(left, right);
      case "is": return left === right || (left === null && right === null);
      case "is not": return left !== right;
      case "in": case "not in": {
        let found: boolean;
        if (typeof right === "string") { if (typeof left !== "string") throw new PyError("in 的左边需要字符串"); this.tick(right.length); found = right.includes(left); }
        else if (right instanceof Dict || right instanceof PySet) found = right.map.has(hashKey(left));
        else found = this.iterate(right).some((item) => equal(item, left));
        return (op === "in") === found;
      }
      case "<": return order(left, right) < 0;
      case "<=": return order(left, right) <= 0;
      case ">": return order(left, right) > 0;
      default: return order(left, right) >= 0;
    }
  }
  private binary(op: string, left: Value, right: Value): Value {
    if (isNumber(left) && isNumber(right)) {
      const a = Number(left), b = Number(right);
      switch (op) {
        case "+": return a + b;
        case "-": return a - b;
        case "*": return a * b;
        case "/": if (b === 0) throw new PyError("不能除以 0"); return a / b;
        case "//": if (b === 0) throw new PyError("不能除以 0"); return Math.floor(a / b);
        case "%": if (b === 0) throw new PyError("不能除以 0"); return a - Math.floor(a / b) * b;
        case "**": return Math.pow(a, b);
      }
    }
    if (op === "+") {
      if (typeof left === "string" && typeof right === "string") return this.text(left + right);
      if (Array.isArray(left) && Array.isArray(right)) return this.list([...left, ...right]);
      if (left instanceof Tuple && right instanceof Tuple) return new Tuple(this.list([...left.items, ...right.items]));
    }
    if (op === "*") {
      const sequence = isNumber(left) ? right : left, count = isNumber(left) ? left : right;
      if (isNumber(count) && (typeof sequence === "string" || Array.isArray(sequence))) {
        const times = Math.max(0, this.integer(count, "重复次数"));
        if (sequence.length * times > PYTHON_LIMITS.sequence) throw new PyError("重复后的结果过长");
        this.tick(sequence.length * times);
        if (typeof sequence === "string") return this.text(sequence.repeat(times));
        const repeated: Value[] = [];
        for (let round = 0; round < times; round++) repeated.push(...sequence);
        return this.list(repeated);
      }
    }
    if (left instanceof PySet && right instanceof PySet && (op === "|" || op === "&" || op === "-")) {
      const result = new PySet();
      this.tick(left.map.size + right.map.size);
      for (const [key, item] of left.map) if (op === "|" || (op === "&") === right.map.has(key)) this.addItem(result, item);
      if (op === "|") for (const item of right.map.values()) this.addItem(result, item);
      return result;
    }
    if (op === "%" && typeof left === "string") throw new PyError("不支持 % 格式化，请用 f-string");
    throw new PyError(`${typeName(left)} 和 ${typeName(right)} 不能做 ${op} 运算`);
  }

  private sort(items: Value[], kwargs: Map<string, Value>): Value[] {
    const key = kwargs.get("key") ?? null, reverse = truthy(kwargs.get("reverse") ?? false);
    this.tick(items.length * Math.max(1, Math.ceil(Math.log2(items.length + 1))));
    const keyed = items.map((item) => [key === null ? item : this.invoke(key, [item], new Map()), item] as const);
    keyed.sort(reverse ? (a, b) => order(b[0], a[0]) : (a, b) => order(a[0], b[0]));
    return this.list(keyed.map(([, item]) => item));
  }
  private method(owner: Value, name: string, args: Value[], kwargs: Map<string, Value>): Value {
    const need = (minimum: number, maximum = minimum) => { if (args.length < minimum || args.length > maximum) throw new PyError(`${name}() 的参数数量不对`); };
    const string = (value: Value | undefined, what = name): string => { if (typeof value !== "string") throw new PyError(`${what}() 需要字符串参数`); return value; };
    if (typeof owner === "string") {
      switch (name) {
        case "upper": need(0); return owner.toUpperCase();
        case "lower": need(0); return owner.toLowerCase();
        case "title": need(0); return owner.replace(/[A-Za-z]+/g, (word) => word[0].toUpperCase() + word.slice(1).toLowerCase());
        case "capitalize": need(0); return owner.slice(0, 1).toUpperCase() + owner.slice(1).toLowerCase();
        case "strip": case "lstrip": case "rstrip": {
          need(0, 1);
          const chars = args.length ? new Set(Array.from(string(args[0]))) : null, drop = (c: string) => chars ? chars.has(c) : /\s/.test(c);
          let start = 0, end = owner.length;
          if (name !== "rstrip") while (start < end && drop(owner[start])) start++;
          if (name !== "lstrip") while (end > start && drop(owner[end - 1])) end--;
          return owner.slice(start, end);
        }
        case "split": {
          need(0, 1);
          if (args.length && args[0] !== null) { const separator = string(args[0]); if (!separator) throw new PyError("分隔符不能为空"); return this.list(owner.split(separator)); }
          return this.list(owner.split(/\s+/).filter(Boolean));
        }
        case "splitlines": need(0); return this.list(owner.split(/\r?\n/));
        case "join": { need(1); const parts = this.iterate(args[0]).map((item) => string(item, "join")); return this.text(parts.join(owner)); }
        case "replace": need(2); { const from = string(args[0]); if (!from) throw new PyError("replace() 的第一个参数不能为空"); return this.text(owner.split(from).join(string(args[1]))); }
        case "startswith": need(1); return owner.startsWith(string(args[0]));
        case "endswith": need(1); return owner.endsWith(string(args[0]));
        case "find": need(1); return owner.indexOf(string(args[0]));
        case "count": { need(1); const part = string(args[0]); return part ? owner.split(part).length - 1 : owner.length + 1; }
        case "isdigit": need(0); return /^\d+$/.test(owner);
        case "isalpha": need(0); return /^\p{L}+$/u.test(owner);
        case "zfill": need(1); return this.text(owner.padStart(Math.min(this.integer(args[0]), 200), "0"));
        case "ljust": case "rjust": {
          need(1, 2);
          const width = Math.min(this.integer(args[0]), 200), fill = args.length > 1 ? string(args[1]) : " ";
          if (fill.length !== 1) throw new PyError("填充字符只能是一个字符");
          return this.text(name === "ljust" ? owner.padEnd(width, fill) : owner.padStart(width, fill));
        }
        case "format": {
          let next = 0;
          return this.text(owner.replace(/\{\{|\}\}|\{(\w*)(?::([^{}]*))?\}/g, (match, field: string, spec: string | undefined) => {
            if (match === "{{") return "{";
            if (match === "}}") return "}";
            const value = field === "" ? args[next++] : /^\d+$/.test(field) ? args[Number(field)] : kwargs.get(field);
            if (value === undefined) throw new PyError("format() 的参数不够");
            return formatValue(value, spec ?? "");
          }));
        }
      }
    } else if (Array.isArray(owner)) {
      switch (name) {
        case "append": need(1); if (owner.length >= PYTHON_LIMITS.sequence) throw new PyError(`列表最多 ${PYTHON_LIMITS.sequence} 项`); this.allocate(1); owner.push(args[0]); return null;
        case "extend": { need(1); const items = this.iterate(args[0]); if (owner.length + items.length > PYTHON_LIMITS.sequence) throw new PyError(`列表最多 ${PYTHON_LIMITS.sequence} 项`); this.allocate(items.length); owner.push(...items); return null; }
        case "insert": need(2); if (owner.length >= PYTHON_LIMITS.sequence) throw new PyError(`列表最多 ${PYTHON_LIMITS.sequence} 项`); this.allocate(1); this.tick(owner.length); owner.splice(this.integer(args[0]), 0, args[1]); return null;
        case "pop": { need(0, 1); if (!owner.length) throw new PyError("不能从空列表 pop"); return owner.splice(this.position(args.length ? args[0] : -1, owner.length), 1)[0]; }
        case "remove": { need(1); this.tick(owner.length); const index = owner.findIndex((item) => equal(item, args[0])); if (index < 0) throw new PyError("列表里没有这个值"); owner.splice(index, 1); return null; }
        case "index": { need(1); this.tick(owner.length); const index = owner.findIndex((item) => equal(item, args[0])); if (index < 0) throw new PyError("列表里没有这个值"); return index; }
        case "count": need(1); this.tick(owner.length); return owner.filter((item) => equal(item, args[0])).length;
        case "sort": { need(0); const sorted = this.sort(owner, kwargs); owner.splice(0, owner.length, ...sorted); return null; }
        case "reverse": need(0); owner.reverse(); return null;
        case "copy": need(0); return this.list([...owner]);
      }
    } else if (owner instanceof Tuple) {
      if (name === "count") { need(1); return owner.items.filter((item) => equal(item, args[0])).length; }
      if (name === "index") { need(1); const index = owner.items.findIndex((item) => equal(item, args[0])); if (index < 0) throw new PyError("元组里没有这个值"); return index; }
    } else if (owner instanceof Dict) {
      switch (name) {
        case "get": need(1, 2); return owner.map.get(hashKey(args[0]))?.[1] ?? (args.length > 1 ? args[1] : null);
        case "keys": need(0); return this.list([...owner.map.values()].map(([key]) => key));
        case "values": need(0); return this.list([...owner.map.values()].map(([, value]) => value));
        case "items": need(0); return this.list([...owner.map.values()].map(([key, value]) => new Tuple([key, value])));
        case "pop": { need(1, 2); const hash = hashKey(args[0]), found = owner.map.get(hash); if (!found) { if (args.length > 1) return args[1]; throw new PyError(`字典里没有键 ${show(args[0], true)}`); } owner.map.delete(hash); return found[1]; }
        case "setdefault": { need(1, 2); const found = owner.map.get(hashKey(args[0])); if (found) return found[1]; const value = args.length > 1 ? args[1] : null; this.setItem(owner, args[0], value); return value; }
        case "update": { need(1); if (!(args[0] instanceof Dict)) throw new PyError("update() 需要字典"); for (const [key, value] of args[0].map.values()) this.setItem(owner, key, value); return null; }
        case "copy": { need(0); const copy = new Dict(); for (const [key, value] of owner.map.values()) this.setItem(copy, key, value); return copy; }
      }
    } else if (owner instanceof PySet) {
      switch (name) {
        case "add": need(1); this.addItem(owner, args[0]); return null;
        case "discard": case "remove": need(1); owner.map.delete(hashKey(args[0])); return null;
        case "union": case "intersection": case "difference": { need(1); const other = new PySet(); for (const item of this.iterate(args[0])) this.addItem(other, item); return this.binary(name === "union" ? "|" : name === "intersection" ? "&" : "-", owner, other); }
      }
    }
    throw new PyError(`${typeName(owner)} 没有方法 ${name}()`);
  }

  private installBuiltins() {
    const define = (name: string, call: (args: Value[], kwargs: Map<string, Value>) => Value) => this.builtins.set(name, new Fn(name, call));
    const count = (name: string, args: Value[], minimum: number, maximum = minimum) => { if (args.length < minimum || args.length > maximum) throw new PyError(`${name}() 的参数数量不对`); };
    const numbers = (name: string, args: Value[]): number[] => (args.length === 1 ? this.iterate(args[0]) : args).map((item) => this.number(item, `${name}()`));
    define("print", (args, kwargs) => {
      const separator = kwargs.get("sep") ?? " ", end = kwargs.get("end") ?? "\n";
      if (typeof separator !== "string" || typeof end !== "string") throw new PyError("print() 的 sep 和 end 需要字符串");
      if (!this.truncated) this.print(args.map((item) => show(item, false)).join(separator) + end);
      return null;
    });
    define("len", (args) => { count("len", args, 1); const value = args[0]; return typeof value === "string" ? Array.from(value).length : value instanceof Dict || value instanceof PySet ? value.map.size : this.iterate(value).length; });
    define("sum", (args) => { count("sum", args, 1, 2); return numbers("sum", [args[0]]).reduce((total, item) => total + item, args.length > 1 ? this.number(args[1]) : 0); });
    for (const name of ["min", "max"] as const) define(name, (args, kwargs) => {
      const items = args.length === 1 ? this.iterate(args[0]) : args, key = kwargs.get("key") ?? null;
      if (!items.length) { if (kwargs.has("default")) return kwargs.get("default")!; throw new PyError(`${name}() 的参数为空`); }
      let best = items[0], bestKey = key === null ? best : this.invoke(key, [best], new Map());
      for (const item of items.slice(1)) {
        const itemKey = key === null ? item : this.invoke(key, [item], new Map()), result = order(itemKey, bestKey);
        if (name === "min" ? result < 0 : result > 0) { best = item; bestKey = itemKey; }
      }
      return best;
    });
    define("sorted", (args, kwargs) => { count("sorted", args, 1); return this.sort([...this.iterate(args[0])], kwargs); });
    define("reversed", (args) => { count("reversed", args, 1); return this.list([...this.iterate(args[0])].reverse()); });
    define("range", (args) => {
      count("range", args, 1, 3);
      const [a, b, c] = args.map((item) => this.integer(item, "range()")), start = args.length > 1 ? a : 0, stop = args.length > 1 ? b : a, step = args.length > 2 ? c : 1;
      if (step === 0) throw new PyError("range() 的步长不能为 0");
      const length = Math.max(0, Math.ceil((stop - start) / step));
      if (length > PYTHON_LIMITS.sequence) throw new PyError(`range() 最多 ${PYTHON_LIMITS.sequence} 项`);
      this.tick(length);
      return this.list(Array.from({ length }, (_, index) => start + index * step));
    });
    define("round", (args) => {
      count("round", args, 1, 2);
      const value = this.number(args[0], "round()"), digits = args.length > 1 && args[1] !== null ? this.integer(args[1], "round()") : 0;
      if (!Number.isFinite(value)) return value;
      if (digits > 0) return Number(value.toFixed(Math.min(digits, 15)));
      const scale = Math.pow(10, -digits), scaled = value / scale, rounded = Math.round(scaled);
      return (Math.abs(scaled % 1) === 0.5 && rounded % 2 !== 0 ? rounded - 1 : rounded) * scale;
    });
    define("abs", (args) => { count("abs", args, 1); return Math.abs(this.number(args[0], "abs()")); });
    define("int", (args) => {
      count("int", args, 1);
      const value = args[0], number = typeof value === "string" && /^\s*[+-]?\d[\d_]*\s*$/.test(value) ? Number(value.replace(/_/g, "")) : isNumber(value) ? Math.trunc(Number(value)) : NaN;
      if (!Number.isFinite(number)) throw new PyError(`不能把 ${show(value, true)} 转成整数`);
      return number;
    });
    define("float", (args) => {
      count("float", args, 1);
      const value = args[0], number = typeof value === "string" && value.trim() ? Number(value) : isNumber(value) ? Number(value) : NaN;
      if (Number.isNaN(number)) throw new PyError(`不能把 ${show(value, true)} 转成数字`);
      return number;
    });
    define("str", (args) => { count("str", args, 0, 1); return args.length ? this.text(show(args[0], false)) : ""; });
    define("repr", (args) => { count("repr", args, 1); return this.text(show(args[0], true)); });
    define("bool", (args) => { count("bool", args, 0, 1); return args.length ? truthy(args[0]) : false; });
    define("list", (args) => { count("list", args, 0, 1); return this.list(args.length ? [...this.iterate(args[0])] : []); });
    define("tuple", (args) => { count("tuple", args, 0, 1); return new Tuple(this.list(args.length ? [...this.iterate(args[0])] : [])); });
    define("set", (args) => { count("set", args, 0, 1); const set = new PySet(); if (args.length) for (const item of this.iterate(args[0])) this.addItem(set, item); return set; });
    define("dict", (args, kwargs) => {
      count("dict", args, 0, 1);
      const dict = new Dict();
      if (args[0] instanceof Dict) for (const [key, value] of args[0].map.values()) this.setItem(dict, key, value);
      else if (args.length) for (const pair of this.iterate(args[0])) { const items = this.iterate(pair); if (items.length !== 2) throw new PyError("dict() 需要成对的键和值"); this.setItem(dict, items[0], items[1]); }
      for (const [key, value] of kwargs) this.setItem(dict, key, value);
      return dict;
    });
    define("enumerate", (args) => { count("enumerate", args, 1, 2); const start = args.length > 1 ? this.integer(args[1]) : 0; return this.list(this.iterate(args[0]).map((item, index) => new Tuple([start + index, item]))); });
    define("zip", (args) => {
      const lists = args.map((item) => this.iterate(item)), length = lists.length ? Math.min(...lists.map((list) => list.length)) : 0;
      return this.list(Array.from({ length }, (_, index) => new Tuple(lists.map((list) => list[index]))));
    });
    define("map", (args) => { count("map", args, 2); return this.list(this.iterate(args[1]).map((item) => this.invoke(args[0], [item], new Map()))); });
    define("filter", (args) => { count("filter", args, 2); return this.list(this.iterate(args[1]).filter((item) => truthy(args[0] === null ? item : this.invoke(args[0], [item], new Map())))); });
    define("any", (args) => { count("any", args, 1); return this.iterate(args[0]).some(truthy); });
    define("all", (args) => { count("all", args, 1); return this.iterate(args[0]).every(truthy); });
    define("divmod", (args) => { count("divmod", args, 2); return new Tuple([this.binary("//", args[0], args[1]), this.binary("%", args[0], args[1])]); });
    define("isinstance", () => { throw new PyError("不支持 isinstance()"); });
    define("mean", (args) => { const items = numbers("mean", args); if (!items.length) throw new PyError("mean() 的参数为空"); return items.reduce((total, item) => total + item, 0) / items.length; });
    define("median", (args) => {
      const items = numbers("median", args).sort((a, b) => a - b), middle = items.length >> 1;
      if (!items.length) throw new PyError("median() 的参数为空");
      return items.length % 2 ? items[middle] : (items[middle - 1] + items[middle]) / 2;
    });
    const unary = (name: string, operation: (value: number) => number) => new Fn(name, (args) => {
      count(name, args, 1);
      const result = operation(this.number(args[0], `${name}()`));
      if (Number.isNaN(result)) throw new PyError(`${name}() 的参数超出定义域`);
      return result;
    });
    const math = new Map<string, Value>([
      ["pi", Math.PI], ["e", Math.E], ["inf", Infinity],
      ["sqrt", unary("sqrt", Math.sqrt)], ["floor", unary("floor", Math.floor)], ["ceil", unary("ceil", Math.ceil)], ["fabs", unary("fabs", Math.abs)],
      ["exp", unary("exp", Math.exp)], ["log", unary("log", Math.log)], ["log2", unary("log2", Math.log2)], ["log10", unary("log10", Math.log10)], ["trunc", unary("trunc", Math.trunc)],
      ["pow", new Fn("pow", (args) => { count("pow", args, 2); return Math.pow(this.number(args[0]), this.number(args[1])); })],
    ]);
    this.builtins.set("math", new Namespace("math", math));
    for (const name of ["sqrt", "floor", "ceil", "pow"]) this.builtins.set(name, math.get(name)!);
    define("today", (args) => { count("today", args, 0); if (!this.options.today) throw new PyError("当前日期不可用"); return this.options.today; });
    define("add_days", (args) => { count("add_days", args, 2); const days = this.integer(args[1], "add_days()"); if (Math.abs(days) > 36_600) throw new PyError("天数超出范围"); return dayText(dayNumber(args[0]) + days); });
    define("days_between", (args) => { count("days_between", args, 2); return dayNumber(args[1]) - dayNumber(args[0]); });
    define("weekday", (args) => { count("weekday", args, 1); return ((dayNumber(args[0]) + 3) % 7 + 7) % 7 + 1; });
    define("weekday_name", (args) => { count("weekday_name", args, 1); return `周${"一二三四五六日"[((dayNumber(args[0]) + 3) % 7 + 7) % 7]}`; });
  }
}

/** Runs one program. Never throws: every failure becomes `error`, with any output printed so far. */
export function runPython(source: string, options: PythonOptions = {}): PythonResult {
  if (typeof source !== "string" || !source.trim()) return { ok: false, output: "", error: "没有可运行的代码" };
  if (source.length > PYTHON_LIMITS.source) return { ok: false, output: "", error: `代码最多 ${PYTHON_LIMITS.source} 个字符` };
  let interpreter: Interpreter | null = null;
  try {
    const program = new Parser(tokenize(source.replace(/\r\n?/g, "\n"))).program();
    const running = interpreter = new Interpreter(options);
    charge = (count) => running.tick(count);
    return { ok: true, output: interpreter.run(program) };
  } catch (error) {
    const output = interpreter?.result() ?? "";
    if (error instanceof PyError) return { ok: false, output, error: error.message };
    if (error instanceof RangeError) return { ok: false, output, error: "表达式或调用嵌套过深" };
    return { ok: false, output, error: "代码无法运行" };
  } finally { charge = () => undefined; }
}
