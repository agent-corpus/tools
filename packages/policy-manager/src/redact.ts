// Redaction for text that is written to the audit log: the exact command of an ambiguous request
// and the classifier's free-text rationale. The audit log is private, but it is also what a human
// reads in a risk review, so values that look like secrets never reach it.
//
// Text is split into words by hand (quotes keep a quoted value together) and every pattern is
// anchored or linear, so hostile input cannot make the redaction slow.

/** Names that carry a secret as a substring: `DB_PASSWORD`, `--api-key`, `x-auth-token`. */
const SECRET_NAME =
  /(?:token|secret|pass(?:word|wd|phrase)?|pwd|api[-_]?key|apikey|credential|bearer|cookie|private[-_]?key|access[-_]?key|signature)/i;
/** `auth` only as a whole word, so `--author` is not a secret but `--auth` and `Authorization` are. */
const AUTH_NAME = /(?:^|[^a-z])auth(?:orization)?(?:[^a-z]|$)/i;
const TOKEN_PREFIX =
  /^(?:gh[pousr]_|github_pat_|sk-|xox[baprs]-|AKIA|ASIA|AIza|eyJ|glpat-|npm_|shpat_)/;
const LONG_OPAQUE = /^[A-Za-z0-9+/=_-]{32,}$/;
/** Programs whose `-pPASSWORD` attaches the password to the flag. Elsewhere `-p…` is not secret. */
const ATTACHED_PASSWORD = /^(?:mysql|mysqldump|mysqladmin|mysqlcheck|mariadb|mariadb-dump)$/;
/** Flags whose next word is a credential, whatever the word looks like. */
const CREDENTIAL_FLAG = /^(?:-u|-U|--user|--proxy-user|--oauth2-bearer)$/;

const isSecretName = (name: string): boolean => SECRET_NAME.test(name) || AUTH_NAME.test(name);

function words(text: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote = "";
  let inWord = false;
  const flush = () => {
    if (inWord) out.push(current);
    current = "";
    inWord = false;
  };
  for (const char of text) {
    if (quote) {
      current += char;
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") {
      quote = char;
      current += char;
      inWord = true;
    } else if (/\s/.test(char)) {
      flush();
      out.push(char);
      inWord = false;
    } else {
      current += char;
      inWord = true;
    }
  }
  flush();
  return out;
}

/** `https://user:pass@host/x?token=1` keeps host and path but loses userinfo and query values. */
function redactUrl(word: string): string {
  const scheme = word.match(/^["']?[a-z][a-z0-9+.-]*:\/\//i)?.[0];
  if (!scheme) return word;
  const rest = word.slice(scheme.length);
  const cut = rest.search(/[?#]/);
  const head = cut < 0 ? rest : rest.slice(0, cut);
  const slash = head.indexOf("/");
  const authority = slash < 0 ? head : head.slice(0, slash);
  const path = slash < 0 ? "" : head.slice(slash);
  const at = authority.lastIndexOf("@");
  const host = at < 0 ? authority : `[REDACTED]@${authority.slice(at + 1)}`;
  return `${scheme}${host}${path}${cut >= 0 && rest[cut] === "?" ? "?[REDACTED]" : ""}`;
}

/** `-H "X-Api-Key: abc"` and `"Authorization: Bearer abc"`, one quoted word. */
function redactHeader(word: string): string | undefined {
  const colon = word.indexOf(":");
  if (colon <= 0 || word.startsWith("//", colon + 1)) return undefined;
  const name = word.slice(0, colon).replace(/^["']/, "");
  if (!/^[A-Za-z][\w-]*$/.test(name) || !isSecretName(name)) return undefined;
  const quote = /["']$/.test(word) ? (word.at(-1) as string) : "";
  return `${word.slice(0, colon + 1)} [REDACTED]${quote}`;
}

/** Redacts a shell command or other free text, keeping it recognisable and at most `max` long. */
export function redactText(text: string, max = 300): string {
  let hideNext = false;
  let program = "";
  let atStart = true;
  const out = words(text).map((raw) => {
    if (/^\s$/.test(raw)) return raw;
    if (/^(?:\||\|\||&&|;|&)$/.test(raw)) {
      atStart = true;
      return raw;
    }
    if (atStart && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(raw)) {
      program =
        raw
          .replace(/^["']|["']$/g, "")
          .split(/[\\/]/)
          .pop() ?? "";
      atStart = false;
    }
    if (hideNext) {
      // `Authorization: Bearer abc` carries the secret in the word after the scheme.
      hideNext = /^["']?(?:bearer|basic|token)["']?$/i.test(raw);
      return hideNext ? raw : "[REDACTED]";
    }
    // URL credentials first: a `?token=` in the query must not hide userinfo before it.
    const piece = redactUrl(raw);
    if (CREDENTIAL_FLAG.test(piece)) {
      hideNext = true;
      return piece;
    }
    // `Authorization:` alone: the value, and a scheme before it, are the words that follow.
    if (/^["']?[A-Za-z][\w-]*:["']?$/.test(piece) && isSecretName(piece.replace(/[:"']/g, ""))) {
      hideNext = true;
      return piece;
    }
    const header = redactHeader(piece);
    if (header) return header;
    const eq = piece.indexOf("=");
    const name = eq >= 0 ? piece.slice(0, eq) : piece;
    // `mysql -pSECRET`: a short option with its value attached.
    if (/^-p./.test(piece) && eq < 0 && ATTACHED_PASSWORD.test(program)) return "-p[REDACTED]";
    if (/^-[A-Za-z]./.test(piece) && eq < 0 && isSecretName(piece))
      return `${piece.slice(0, 2)}[REDACTED]`;
    if (isSecretName(name)) {
      if (eq >= 0) return `${name}=[REDACTED]`;
      // A bare flag takes its value from the next word; a header name waits for its value.
      if (/^-{1,2}[A-Za-z]/.test(piece) || /:["']?$/.test(piece)) hideNext = true;
      return piece;
    }
    // A quoted token is still a token: judge the word without its surrounding quote.
    const bare = piece.replace(/^["']|["']$/g, "");
    return TOKEN_PREFIX.test(bare) || LONG_OPAQUE.test(bare) ? "[REDACTED]" : piece;
  });
  const joined = out.join("");
  return joined.length > max ? `${joined.slice(0, max)}…` : joined;
}
