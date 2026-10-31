import {
  StreamLanguage,
  type StreamParser,
  type StringStream,
} from "@codemirror/language";

type NginxState = {
  directive: boolean;
  quote: "'" | '"' | null;
  depth: number;
};

const variable = /^\$(?:\{[a-zA-Z0-9_]+\}|[a-zA-Z0-9_]+)/;
const number = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[kKmMgGtTpP]|ms|s|m|h|d|w|y)?$/;
const blocks = new Set([
  "events",
  "http",
  "mail",
  "stream",
  "server",
  "location",
  "upstream",
  "types",
  "charset_map",
  "limit_except",
  "if",
  "geo",
  "map",
  "split_clients",
]);
const booleans = new Set(["on", "off", "true", "false", "yes", "no"]);
const atoms = new Set(["none", "auto", "default", "ssl", "http2", "http3"]);

// A variable starts its own token, including within quoted strings and URLs.
// Escaped characters are consumed together so \#, \$, and \{ stay literal.
function quoted(stream: StringStream, state: NginxState): string {
  while (!stream.eol()) {
    if (stream.match(variable, false)) break;
    const character = stream.next();
    if (character === "\\") stream.next();
    else if (character === state.quote) {
      state.quote = null;
      break;
    }
  }
  return "string";
}

const parser: StreamParser<NginxState> = {
  name: "nginx",
  startState: () => ({ directive: true, quote: null, depth: 0 }),
  token(stream, state) {
    if (state.quote) {
      if (stream.match(variable)) return "variableName";
      return quoted(stream, state);
    }
    if (stream.eatSpace()) return null;

    const character = stream.peek();
    if (character === "#") {
      stream.skipToEnd();
      return "comment";
    }
    if (character === '"' || character === "'") {
      state.quote = character;
      state.directive = false;
      stream.next();
      return quoted(stream, state);
    }
    if (stream.match(variable)) {
      state.directive = false;
      return "variableName";
    }
    if (character === "{" || character === "}" || character === ";") {
      stream.next();
      if (character === "{") state.depth += 1;
      if (character === "}") state.depth = Math.max(0, state.depth - 1);
      state.directive = true;
      return "punctuation";
    }
    if (character === "=") {
      stream.next();
      return "operator";
    }

    while (!stream.eol()) {
      const next = stream.peek()!;
      if (/\s|[{};#"'=]/.test(next) || stream.match(variable, false)) break;
      stream.next();
      if (next === "\\") stream.next();
    }
    // Keep malformed/incomplete input editable without a zero-length token.
    if (stream.pos === stream.start) stream.next();
    const word = stream.current();
    if (state.directive) {
      state.directive = false;
      return blocks.has(word) ? "controlKeyword" : "keyword";
    }
    if (booleans.has(word)) return "bool";
    if (atoms.has(word)) return "atom";
    return number.test(word) ? "number" : "string";
  },
  indent(state, textAfter, context) {
    if (state.quote) return null;
    const closing = /^\s*\}/.test(textAfter) ? 1 : 0;
    return Math.max(0, state.depth - closing) * context.unit;
  },
  languageData: {
    commentTokens: { line: "#" },
    indentOnInput: /^\s*\}/,
    wordChars: "$",
  },
};

// Tokenization provides presentation only; nginx -t remains the syntax check.
export const nginxLanguage = StreamLanguage.define(parser);
