// Redaction for text that is written to the audit log: the exact command of an ambiguous request
// and the classifier's free-text rationale. The audit log is private, but it is also what a human
// reads in a risk review, so values that look like secrets never reach it.

const SECRET_NAME =
  /(?:token|secret|pass(?:word|wd)?|pwd|api[-_]?key|apikey|auth|credential|bearer|cookie|private[-_]?key|access[-_]?key|signature|sas)/i;
const TOKEN_PREFIX =
  /^(?:gh[pousr]_|github_pat_|sk-|xox[baprs]-|AKIA|ASIA|AIza|eyJ|glpat-|npm_|shpat_)/;
const LONG_OPAQUE = /^[A-Za-z0-9+/=_-]{32,}$/;

function redactWord(word: string): string {
  if (TOKEN_PREFIX.test(word) || LONG_OPAQUE.test(word)) return "[REDACTED]";
  // `https://user:pass@host/x?token=1` keeps the host and path but loses userinfo and query values.
  const url = word.match(/^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*@)?([^?#]*)(\?[^#]*)?(#.*)?$/i);
  if (url) return `${url[1]}${url[2] ? "[REDACTED]@" : ""}${url[3]}${url[4] ? "?[REDACTED]" : ""}`;
  return word;
}

/** Redacts a shell command or other free text, keeping it recognisable and at most `max` long. */
export function redactText(text: string, max = 300): string {
  const words = text.split(/(\s+)/);
  let hideNext = false;
  const out = words.map((piece) => {
    if (/^\s*$/.test(piece)) return piece;
    if (hideNext) {
      // `Authorization: Bearer abc` carries the secret in the word after the scheme.
      hideNext = /^["']?(?:bearer|basic|token)["']?$/i.test(piece);
      return hideNext ? piece : "[REDACTED]";
    }
    const eq = piece.indexOf("=");
    const name = eq >= 0 ? piece.slice(0, eq) : piece;
    if (SECRET_NAME.test(name)) {
      if (eq >= 0) return `${name}=[REDACTED]`;
      if (/^-{1,2}[A-Za-z]/.test(piece) || /^(?:authorization|bearer)/i.test(piece))
        hideNext = true;
      return piece;
    }
    // `Authorization: Bearer x` and `-H "X-Api-Key: x"` split across words.
    if (/^["']?[A-Za-z-]*(?:authorization|api[-_]?key|token|cookie):?["']?$/i.test(piece))
      hideNext = true;
    return redactWord(piece);
  });
  const joined = out.join("");
  return joined.length > max ? `${joined.slice(0, max)}…` : joined;
}
