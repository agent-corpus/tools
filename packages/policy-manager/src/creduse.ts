import { checkShape, HelperError, matchArgs } from "./helpers.js";
import { scan } from "./shellscan.js";

/**
 * A credential a command reads only to hand it to one consumer: the secret flows from `source`
 * straight into one of `consumers` and is never printed, saved or passed anywhere else. Tokens use
 * the `credentialHelpers` syntax; in a consumer, `$SECRET` marks the one argument that carries the
 * secret (a header such as `Authorization: Bearer $SECRET`). A consumer without it gets the secret
 * as an environment variable.
 */
export interface CredentialUse {
  source: Array<string | string[]>;
  consumers: Array<Array<string | string[]>>;
}

export const MAX_CREDENTIAL_USES = 20;
/** Variable names a consumer reads a credential from. */
const AUTH_VARIABLE =
  /^[A-Z][A-Z0-9_]*(?:_TOKEN|_PAT|_PASSWORD|_SECRET|_API_KEY|_ACCESS_KEY)$|^(?:TOKEN|PAT|PASSWORD)$/;
/** Variables that load code or change how a program starts: never a credential channel. */
const LOADER_VARIABLE =
  /^(?:NODE_OPTIONS|NODE_PATH|LD_\w+|DYLD_\w+|BASH_ENV|ENV|PYTHON\w*|PERL5?\w*|RUBY\w*|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|GIT_\w+|NPM_CONFIG_\w+|SHELLOPTS|PS4|PROMPT_COMMAND|IFS|PATH)$/;

/** Validates the profile's `credentialUses`. */
export function parseCredentialUses(raw: unknown): CredentialUse[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_CREDENTIAL_USES)
    throw new HelperError(`credentialUses must list at most ${MAX_CREDENTIAL_USES} entries`);
  return raw.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new HelperError("each credential use must be an object");
    const { source, consumers, ...extra } = entry as Record<string, unknown>;
    if (Object.keys(extra).length)
      throw new HelperError(`unknown credential use key: ${Object.keys(extra)[0]}`);
    const where = `credentialUses[${index}]`;
    if (!Array.isArray(consumers) || consumers.length === 0 || consumers.length > 20)
      throw new HelperError(`${where} must list 1 to 20 consumers`);
    const shapes = consumers.map((shape) => checkShape(shape, where));
    for (const shape of shapes)
      if (
        shape.filter((token) => typeof token === "string" && token.includes("$SECRET")).length > 1
      )
        throw new HelperError(`${where}: a consumer may carry $SECRET in one argument only`);
    return { source: checkShape(source, where), consumers: shapes };
  });
}

/**
 * The consumer command, with the secret left out, when `script` is exactly one listed source
 * feeding one listed consumer: `NAME=$(source) consumer ...` (an environment value for that one
 * command) or `consumer ... "Authorization: Bearer $(source)" ...` (the one argument marked
 * `$SECRET`). Nothing else may be in the script: no other expansion, operator, redirection or
 * here-document. Undefined otherwise, so the request is judged as it is.
 */
export function credentialUse(script: string, uses: CredentialUse[]): string | undefined {
  if (!uses.length || (script.match(/\$/g) ?? []).length !== 1 || /[`\\]/.test(script))
    return undefined;
  if (!script.includes("$(")) return undefined;
  const { segments, complete } = scan(script);
  if (!complete || segments.length !== 2) return undefined;
  const [inner, outer] = segments as [(typeof segments)[0], (typeof segments)[0]];
  if (inner[0]?.after !== "$(" || outer[0]?.after) return undefined;
  if ([...inner, ...outer].some((word) => word.redirect || word.heredoc || word.herestring))
    return undefined;
  if (!inner.every((word) => word.literal)) return undefined;
  const source = inner.map((word) => word.text);
  const carrier = outer.filter((word) => !word.literal);
  if (carrier.length !== 1) return undefined;
  const secretWord = carrier[0];
  // The env form only for a variable named like a credential the consumer reads for auth
  // (`GITHUB_TOKEN`, `NPM_TOKEN`, `DB_PASSWORD`), never a loader or option variable.
  const name = /^([A-Za-z_]\w*)=\$$/.exec(secretWord?.text ?? "")?.[1];
  const env = !!name && outer[0] === secretWord;
  if (env && (!AUTH_VARIABLE.test(name ?? "") || LOADER_VARIABLE.test(name ?? "")))
    return undefined;
  const args = outer.filter((word) => word !== secretWord || !env).map((word) => word.text);
  for (const use of uses) {
    if (!matchArgs(use.source, source)) continue;
    for (const consumer of use.consumers) {
      const marked = consumer.findIndex(
        (token) => typeof token === "string" && token.includes("$SECRET"),
      );
      if (env ? marked >= 0 : marked < 0) continue;
      const shape = consumer.map((token) =>
        typeof token === "string" ? token.replace("$SECRET", "$") : token,
      );
      if (!matchArgs(shape, args)) continue;
      if (!env && args[marked] !== secretWord?.text) continue;
      // The consumer as it runs, with a placeholder where the secret goes.
      return args
        .map((word, i) => (i === marked ? word.replace(/\$$/, "SECRET") : word))
        .map((word) => `'${word.replace(/'/g, "'\\''")}'`)
        .join(" ");
    }
  }
  return undefined;
}
