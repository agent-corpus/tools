import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import {
  canonical,
  git,
  inside,
  isProtectedPath,
  resolveWord,
  sensitive,
  tempRoots,
  withEvidence,
} from "./evidence.js";
import { aliasDirectory, gitAlias, KNOWN_GIT, shellArgs } from "./gitalias.js";
import { defaultProfilePath } from "./profile.js";
import { readOnly } from "./reads.js";
import { type Command, command, innerScript, scan, type Word } from "./shellscan.js";
import {
  codeTouchesState,
  findReachesState,
  namesState,
  namesStateSecret,
  stateText,
} from "./statepaths.js";
import type { Decision, Request } from "./types.js";

/**
 * Hard human items: requests that always go to a person, are never sent to the AI classifier, and
 * that no classification can approve. Credentials, protected configuration, unrecoverable loss and
 * the profile's humanPatterns, plus two built-in guards on the policy manager's own approvals.
 */
export const HARD_RULES = [
  /** Credential or secret retrieval, and reads of credential paths. */
  "credential-read",
  /** Writes to harness permission and hook settings. */
  "harness-settings",
  /** Writes to the policy profile itself. */
  "policy-profile",
  /**
   * Writing, moving, deleting or changing the policy service's own state (`acp-<uid>-*` in the
   * temp directory: audit logs, token, socket, grants, cache). Reading the audit logs is allowed.
   */
  "policy-state",
  /**
   * A shell or interpreter that reads its script from standard input, a here-string or a file the
   * policy cannot read (`cat x.sh | sh`, `sh < x.sh`, `. <(curl ...)`, `| pwsh`). A literal
   * `echo`, `printf` or quoted here-document piped in is unwrapped and judged instead.
   */
  "opaque-script",
  /** `git push --force`/`--mirror`, and `+` refspecs: they overwrite remote history. */
  "force-push",
  /** Deleting a local or remote branch whose commits are not verified merged. */
  "delete-unmerged-branch",
  /** `git worktree remove --force`/`prune`: discards a worktree's uncommitted and untracked work. */
  "remove-worktree-force",
  /** `git clean`: deletes untracked files. */
  "git-clean",
  /** A command matching the profile's `humanPatterns`. */
  "human-patterns",
  /**
   * The deterministic floor under the classifier: cloud and infrastructure writes and deletes
   * (az, aws, gcloud, kubectl, helm, terraform, pulumi...), GitHub repository, release and secret
   * deletion, package publishing, and a recursive `rm` outside a linked feature worktree, the
   * temp directory and the profile's scratch roots. None of these is provably recoverable.
   */
  "cloud-write",
  "repo-delete",
  "publish",
  "rm-outside",
  /** Any other decision the engine filed as sensitive: protected paths and configuration. */
  "protected",
  /** An agent running `approve` itself. */
  "self-approve",
  /** A classification record for another session or CLI, or with anything added. */
  "foreign-classification-record",
] as const;
export type HardRule = (typeof HARD_RULES)[number];

/** The reason of session's approve guard (an agent running `approve`). */
export const APPROVE_GUARD =
  "Only the user may approve a request, by running approve in their own terminal";
const FOREIGN_RECORD_REASON = /^A classification record/;

/** The engine's own reasons for hard cases it parsed. */
const REASON_RULES: Array<[RegExp, HardRule]> = [
  [/^Force or mirror pushes overwrite remote history$/, "force-push"],
  [/^Forced refspecs overwrite remote history$/, "force-push"],
  [/^Local branch deletion requires human approval/, "delete-unmerged-branch"],
  [/^Remote branch deletion may lose work/, "delete-unmerged-branch"],
  [/^Remote branch has commits that are not fetched/, "delete-unmerged-branch"],
  [/^Remote branch deletion is only verified for origin/, "delete-unmerged-branch"],
  [/^Only branch deletions with verified merge state/, "delete-unmerged-branch"],
  [/^Forced worktree removal requires human approval$/, "remove-worktree-force"],
  [/^git clean deletes untracked files$/, "git-clean"],
  [/^Matches an organization human-approval pattern$/, "human-patterns"],
  // A protected-or-credential path decision is judged by its path below, not by its wording.
  [
    /^(?!.*protected or credential path).*(?:credential|secret|Printing the environment)/i,
    "credential-read",
  ],
];

const SHELL_TOOLS = new Set(["Bash", "bash", "exec_command", "shell", "powershell"]);
/** Tools that read or search a directory tree, by path (Claude Code, Codex, Copilot names). */
const TREE_TOOLS = new Set([
  ...["grep", "glob", "ls", "notebookread", "list_dir", "list_directory", "search", "find"],
  ...["grep_search", "file_search", "view_image"],
]);
const WRITE_TOOLS = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "create",
  "edit",
  "write_file",
]);

/**
 * Harness permission, hook and MCP settings, matched on a path with `/` separators. Each names
 * files that change what the harness lets run, or that run with the user's rights.
 */
const HARNESS_SETTINGS = [
  // Claude Code: settings (permissions, hooks), hook scripts, and user MCP servers.
  /(?<![\w-])\.claude\/settings(?:\.local)?\.json$/i,
  /(?<![\w-])\.claude\/hooks(?:\/|$)/i,
  /(?<![\w-])\.claude\.json$/i,
  // Codex: hooks, hook scripts, configuration (approval policy, sandbox, MCP) and command rules.
  /(?<![\w-])\.codex\/(?:hooks\.json|config\.toml)$/i,
  /(?<![\w-])\.codex\/(?:hooks|rules)(?:\/|$)/i,
  // Copilot: user hooks, configuration and saved permissions, and repository hooks.
  /(?<![\w-])\.copilot\/(?:config\.json|settings\.json|permissions-config\.json|hooks(?:\/|$))/i,
  /(?<![\w-])\.github\/hooks(?:\/[^/]*\.json)?$/i,
];
/** File names a write in an unknown directory could be a harness setting through. */
const SETTINGS_NAMES =
  /^(?:settings(?:\.local)?\.json|\.claude\.json|hooks\.json|config\.toml|config\.json|policy\.json|permissions-config\.json|hooks|rules)$/i;
const PROFILE_NAME = /(?<![\w-])policy-manager\/policy\.json$/i;

const slashes = (path: string) => path.replace(/\\/g, "/");

/**
 * `path` with `/` separators, runs of separators collapsed and no trailing one. Done by splitting,
 * not a regular expression, so a long run of slashes in hook input costs linear time.
 */
function normalize(path: string): string {
  return slashes(path)
    .split("/")
    .filter((part, index) => part !== "" || index === 0)
    .join("/");
}

/** Settings in a harness directory moved by an environment variable. */
function configuredSettings(path: string): boolean {
  const dirs: Array<[string | undefined, RegExp]> = [
    [
      process.env.CLAUDE_CONFIG_DIR,
      /^(?:settings(?:\.local)?\.json|\.claude\.json|hooks(?:\/|$))/i,
    ],
    [process.env.CODEX_HOME, /^(?:hooks\.json|config\.toml|(?:hooks|rules)(?:\/|$))/i],
    [
      process.env.COPILOT_HOME,
      /^(?:config\.json|settings\.json|permissions-config\.json|hooks(?:\/|$))/i,
    ],
  ];
  const target = slashes(path);
  return dirs.some(([dir, name]) => {
    if (!dir) return false;
    const root = resolvedRoot(dir);
    return target.startsWith(root) && name.test(target.slice(root.length));
  });
}
const roots = new Map<string, string>();
/** `dir` resolved with `/` separators and a trailing `/` (memoized: asked once per word). */
function resolvedRoot(dir: string): string {
  let root = roots.get(dir);
  if (root === undefined) {
    root = `${slashes(resolve(dir))}/`;
    if (roots.size > 64) roots.clear();
    roots.set(dir, root);
  }
  return root;
}

/** A policy service state directory (`acp-<uid>-...`, any user's) or a path inside one. */
const POLICY_STATE = /(?:^|\/)acp-(?:\d+|user)-[^/]*(?:\/|$)/i;
export const policyStatePath = (path: string) => POLICY_STATE.test(normalize(path));

/** The hard rules a path names. */
function pathRules(path: string, rules: Set<HardRule>, credentials: boolean): void {
  // Pure for a given environment, and asked for the same words many times: memoized.
  const key = `${credentials ? 1 : 0}${process.env.CLAUDE_CONFIG_DIR}|${process.env.CODEX_HOME}|${process.env.COPILOT_HOME}|${path}`;
  let found = pathMemo.get(key);
  if (!found) {
    found = [];
    const target = normalize(path);
    if (target === slashes(defaultProfilePath()) || PROFILE_NAME.test(target))
      found.push("policy-profile");
    if (HARNESS_SETTINGS.some((pattern) => pattern.test(target)) || configuredSettings(target))
      found.push("harness-settings");
    if (credentials && sensitive(target)) found.push("credential-read");
    if (pathMemo.size > 8192) pathMemo.clear();
    pathMemo.set(key, found);
  }
  for (const rule of found) rules.add(rule);
}
const pathMemo = new Map<string, HardRule[]>();

/** Absolute forms of a shell word in each directory it could be resolved in. */
function resolutions(word: string, cwds: Set<string>): string[] {
  const found: string[] = [];
  for (const cwd of cwds)
    try {
      found.push(resolveWord(cwd, word));
    } catch {
      /* `~user` and the like: matched as written */
    }
  return found;
}

/** Global options that take the next word as their value. */
const GIT_VALUED = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--config-env",
  "--super-prefix",
]);

/** Whether `flag` is a long option `name` or an abbreviation Git accepts (at least `min` long). */
function long(flag: string, name: string, min = 4): boolean {
  const given = flag.split("=")[0] as string;
  return given.length >= min && name.startsWith(given);
}
const short = (flag: string, letters: RegExp) =>
  /^-[a-zA-Z]+$/.test(flag) && letters.test(flag.slice(1));

const FORCE_PUSH = ["--force", "--force-with-lease", "--force-if-includes", "--mirror", "--prune"];
const forcing = (flag: string) =>
  FORCE_PUSH.some((name) => long(flag, name, 3)) || short(flag, /f/);

/** The rules a Git invocation with a literal, known subcommand falls under. */
function gitRules(sub: string, rest: string[], rules: Set<HardRule>): void {
  const flags = rest.filter((word) => word.startsWith("-"));
  const positional = rest.filter((word) => !word.startsWith("-"));
  const has = (test: (flag: string) => boolean) => flags.some(test);
  if (sub === "push") {
    if (has(forcing) || positional.some((word) => word.startsWith("+"))) rules.add("force-push");
    if (
      has((f) => long(f, "--delete") || short(f, /d/)) ||
      positional.slice(1).some((w) => w.startsWith(":"))
    )
      rules.add("delete-unmerged-branch");
  } else if (sub === "branch") {
    if (has((f) => long(f, "--delete") || short(f, /[dD]/))) rules.add("delete-unmerged-branch");
  } else if (sub === "update-ref") {
    if (has((f) => f === "-d" || long(f, "--stdin"))) rules.add("delete-unmerged-branch");
  } else if (sub === "worktree") {
    if (
      positional[0] === "prune" ||
      (positional[0] === "remove" && has((f) => long(f, "--force") || short(f, /f/)))
    )
      rules.add("remove-worktree-force");
  } else if (sub === "clean") {
    if (!has((f) => long(f, "--dry-run") || short(f, /n/))) rules.add("git-clean");
  }
}

/**
 * The rules an opaque Git invocation could reach, judged on every word of the script: its program
 * or subcommand is not a literal known word, or an alias or environment could change what runs.
 */
function opaqueGitRules(words: string[], keywords: boolean, rules: Set<HardRule>): void {
  const has = (word: string) => words.includes(word);
  const flags = words.filter((word) => word.startsWith("-") || word.startsWith("+"));
  if (has("clean") && !flags.some((f) => long(f, "--dry-run") || short(f, /n/)))
    rules.add("git-clean");
  if (flags.some((f) => forcing(f) || f.startsWith("+")) && (!keywords || has("push")))
    rules.add("force-push");
  if (has("worktree") && (has("prune") || (has("remove") && flags.some(forcing))))
    rules.add("remove-worktree-force");
  if (
    flags.some((f) => f === "--delete" || short(f, /[dD]/)) &&
    (!keywords || has("branch") || has("push") || has("update-ref"))
  )
    rules.add("delete-unmerged-branch");
}

const CLOUD = new Set(["az", "aws", "gcloud"]);
/** A cloud CLI word that marks a read: anything without one is treated as a write. */
const CLOUD_READ_VERB =
  /^(?:list(?:-.*)?|show(?:-.*)?|get(?:-.*)?|describe(?:-.*)?|query|search|wait|exists|version|ls|tail|help|whoami|login|logout|status)$/;
const INFRA_WRITE: Record<string, RegExp> = {
  kubectl:
    /^(?:apply|create|delete|replace|patch|edit|scale|autoscale|rollout|set|label|annotate|drain|cordon|uncordon|taint|expose|run|exec|cp|attach)$/,
  oc: /^(?:apply|create|delete|replace|patch|edit|scale|rollout|set|label|annotate|expose|run|exec|new-app|start-build)$/,
  helm: /^(?:install|upgrade|uninstall|delete|rollback|push)$/,
  terraform: /^(?:apply|destroy|import|taint|untaint|state|force-unlock|workspace)$/,
  tofu: /^(?:apply|destroy|import|taint|untaint|state|force-unlock|workspace)$/,
  terragrunt: /^(?:apply|destroy|import|taint|untaint|state|force-unlock|run-all)$/,
  pulumi: /^(?:up|update|destroy|refresh|import|state|cancel|stack)$/,
  eksctl: /^(?:create|delete|upgrade|scale|set|unset|drain)$/,
};
const PUBLISHERS: Record<string, RegExp> = {
  npm: /^(?:publish|unpublish|deprecate|dist-tag)$/,
  pnpm: /^publish$/,
  yarn: /^(?:publish|npm)$/,
  cargo: /^(?:publish|yank|owner)$/,
  twine: /^upload$/,
  gem: /^(?:push|yank)$/,
  poetry: /^publish$/,
  docker: /^push$/,
  podman: /^push$/,
};
const GH_DELETE: Record<string, RegExp> = {
  repo: /^(?:create|fork|delete|archive|unarchive|rename|edit|sync)$/,
  release: /^(?:create|edit|upload|delete|delete-asset)$/,
  secret: /^(?:delete|remove|set)$/,
  variable: /^(?:delete|set)$/,
  gist: /^(?:create|new|edit|rename|delete)$/,
  // What gh itself runs and with which credentials: extensions, aliases, settings and auth.
  extension: /^(?:install|upgrade|exec|remove)$/,
  extensions: /^(?:install|upgrade|exec|remove)$/,
  ext: /^(?:install|upgrade|exec|remove)$/,
  alias: /^(?:set|import|delete)$/,
  config: /^set$/,
  auth: /^(?:refresh|login|logout|setup-git|token|switch)$/,
  cache: /^delete$/,
  label: /^delete$/,
  issue: /^(?:delete|transfer)$/,
  "ssh-key": /^(?:add|delete)$/,
  "gpg-key": /^(?:add|delete)$/,
  codespace: /^(?:create|delete|edit|stop|rebuild|cp|ssh|ports)$/,
  cs: /^(?:create|delete|edit|stop|rebuild|cp|ssh|ports)$/,
  // Merging and workflow or deploy triggers cannot be taken back. (`gh ruleset` only reads.)
  pr: /^merge$/,
  workflow: /^(?:run|enable|disable)$/,
  run: /^(?:rerun|delete|cancel)$/,
};

/**
 * The only REST writes through `gh api` that reach the classifier: recoverable PR and issue
 * conversation. Each entry is a method set and an endpoint under `repos/<owner>/<repo>/`. Every
 * other write is a floor item (merging, dispatching workflows, deployments, rulesets, transfers,
 * memberships, secrets, variables, settings, refs, releases, ...).
 */
const GH_API_WRITES: [RegExp, RegExp][] = [
  // Issue and PR comments: create, edit.
  [/^POST$/, /^issues\/\d+\/comments$/],
  [/^PATCH$/, /^issues\/comments\/\d+$/],
  // Review comments and replies: create, edit.
  [/^POST$/, /^pulls\/\d+\/comments(?:\/\d+\/replies)?$/],
  [/^PATCH$/, /^pulls\/comments\/\d+$/],
  // Reviews: create, update the body, submit.
  [/^POST$/, /^pulls\/\d+\/reviews$/],
  [/^PUT$/, /^pulls\/\d+\/reviews\/\d+$/],
  [/^POST$/, /^pulls\/\d+\/reviews\/\d+\/events$/],
  // Labels and assignees.
  [/^(?:POST|PUT)$/, /^issues\/\d+\/labels$/],
  [/^DELETE$/, /^issues\/\d+\/labels(?:\/[^/]+)?$/],
  [/^(?:POST|DELETE)$/, /^issues\/\d+\/assignees$/],
  // PR create, and edit of title, body, base or draft (not its state).
  [/^POST$/, /^pulls$/],
  [/^PATCH$/, /^pulls\/\d+$/],
];
/** GraphQL mutations that reach the classifier: the same recoverable conversation edits. */
const GH_MUTATIONS = new Set([
  "addComment",
  "updateIssueComment",
  "addPullRequestReview",
  "addPullRequestReviewComment",
  "addPullRequestReviewThreadReply",
  "updatePullRequestReviewComment",
  "submitPullRequestReview",
  "resolveReviewThread",
  "unresolveReviewThread",
  "createPullRequest",
  "updatePullRequest",
  "addLabelsToLabelable",
  "removeLabelsFromLabelable",
  "addAssigneesToAssignable",
  "removeAssigneesFromAssignable",
]);

/**
 * The top-level field names of every mutation in a GraphQL document, or undefined if it has no
 * mutation. Strings are skipped; an alias (`a: addComment(...)`) counts as its field. A document
 * it cannot follow (block strings, unbalanced brackets) yields no fields, which fails closed.
 */
function mutationFields(text: string): string[] | undefined {
  if (!/\bmutation\b/.test(text)) return undefined;
  if (text.includes('"""')) return [];
  const fields: string[] = [];
  let depth = 0;
  let parens = 0;
  let inMutation = false;
  let found = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (c === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
      continue;
    }
    if (c === "(") parens++;
    else if (c === ")") parens--;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) inMutation = false;
    } else if (depth === 0 && parens === 0 && /[A-Za-z_]/.test(c)) {
      const word = /^[A-Za-z_]\w*/.exec(text.slice(i))?.[0] ?? "";
      if (word === "mutation") inMutation = found = true;
      i += word.length - 1;
    } else if (inMutation && depth === 1 && parens === 0 && /[A-Za-z_]/.test(c)) {
      const word = /^[A-Za-z_]\w*/.exec(text.slice(i))?.[0] ?? "";
      i += word.length - 1;
      if (!/^\s*:/.test(text.slice(i + 1))) fields.push(word);
    }
  }
  if (depth !== 0 || parens !== 0) return [];
  return found ? fields : undefined;
}

/**
 * Whether a `gh api` call is a floor item: any write (a non-GET method, or fields, which make it a
 * POST) outside GH_API_WRITES, any GraphQL mutation outside GH_MUTATIONS (or a pull request state
 * change), and any call whose endpoint or query cannot be read. Options are read anywhere after
 * `api`. A header that overrides the method (`X-HTTP-Method-Override`) or is not literal, and an
 * unquoted expansion other than the endpoint (`$EXTRA`, which can split into `-X DELETE`), fail
 * closed.
 */
function ghApiFloor(words: Word[]): boolean {
  const texts = words.map((word) => word.text);
  let endpoint: string | undefined;
  let endpointAt = -1;
  let method: string | undefined;
  let fields = false;
  const values: string[] = [];
  /** Field words with an expansion: their text is not what gh sends. */
  const computed: string[] = [];
  const start = texts.indexOf("api") + 1;
  for (let k = start; k < texts.length; k++) {
    const text = texts[k] as string;
    const header = /^(?:-H|--header)$/.test(text)
      ? words[k + 1]
      : /^(?:--header=|-H.)/.test(text)
        ? { ...(words[k] as Word), text: text.replace(/^(?:--header=|-H)/, "") }
        : undefined;
    if (header && (!header.literal || /x-http-method-override/i.test(header.text))) return true;
    const attached = /^(?:-X|--method=)(.+)$/.exec(text);
    if (text === "-X" || text === "--method") method = texts[++k];
    else if (attached) method = attached[1];
    else if (/^(?:-[fF]|--field|--raw-field)$/.test(text)) {
      fields = true;
      if (words[k + 1] && !words[k + 1]?.literal) computed.push(texts[k + 1] ?? "");
      values.push(texts[++k] ?? "");
    } else if (/^(?:--field|--raw-field)=|^-[fF]./.test(text)) {
      fields = true;
      if (!words[k]?.literal) computed.push(text);
      values.push(text.replace(/^(?:--field=|--raw-field=|-[fF])/, ""));
    } else if (text === "--input" || text.startsWith("--input=")) {
      fields = true;
      if (text === "--input") k++;
      values.push("@");
    } else if (/^-[Htqp]$|^--(?:header|jq|template|hostname|cache|preview)$/.test(text)) k++;
    else if (!text.startsWith("-") && endpoint === undefined) {
      endpoint = text;
      endpointAt = k;
    }
  }
  if (words.some((word, k) => k >= start && k !== endpointAt && word.bare)) return true;
  const effective = (method ?? (fields ? "POST" : "GET")).toUpperCase();
  // A call with no method and no fields is a GET, whatever the endpoint; a write to an endpoint
  // that cannot be read is a floor item.
  if (endpoint === undefined) return true;
  if (/\$/.test(endpoint))
    return (
      !["GET", "HEAD"].includes(effective) &&
      !(effective === "POST" && fields && variableReply(endpoint))
    );
  if (endpoint === "graphql") {
    // A query read from a file cannot be judged; one without a mutation reads. A query with an
    // expansion (`-f query="$Q"`) can be any mutation; variables (`-f id=$t`) are only values.
    if (values.some((value) => value === "@" || /^query=@/.test(value))) return true;
    if (computed.some((text) => /^(?:(?:--field=|--raw-field=|-[fF])?query=)/.test(text)))
      return true;
    for (const value of values) {
      const mutations = mutationFields(value);
      if (mutations === undefined) continue;
      if (!mutations.length || mutations.some((field) => !GH_MUTATIONS.has(field))) return true;
      if (mutations.includes("updatePullRequest") && /\bstate\s*:/.test(value)) return true;
    }
    return false;
  }
  if (["GET", "HEAD"].includes(effective)) return false;
  const path = /^\/?repos\/[^/]+\/[^/]+\/([^?#]*)$/.exec(endpoint)?.[1]?.replace(/\/$/, "");
  if (path === undefined) return true;
  if (!GH_API_WRITES.some(([methods, shape]) => methods.test(effective) && shape.test(path)))
    return true;
  // Editing a pull request is recoverable; closing, reopening or merging state is not its job here.
  if (/^pulls\/\d+$/.test(path) && values.some((value) => /^state=/.test(value))) return true;
  return false;
}

/** A comment POST shape whose only numeric ids may come from a variable. */
const GH_VARIABLE_REPLY =
  /^(?:issues\/#\/comments|pulls\/#\/comments(?:\/#\/replies)?|pulls\/comments\/#\/replies)$/;
/**
 * Whether a POST to an endpoint with a variable is a comment or reply whose only variable parts
 * are numeric-id segments (`$id`, `${id}`, `$1`): `reply(){ gh api repos/o/r/pulls/7/comments/$1/
 * replies -f body="$2"; }`. Owner and repository must be literal. The caller has made sure it is a
 * POST, a write that goes to the classifier rather than the floor.
 */
function variableReply(endpoint: string): boolean {
  const match = /^\/?repos\/([^/$]+)\/([^/$]+)\/([^?#]*?)\/?$/.exec(endpoint);
  if (!match) return false;
  const segments = (match[3] as string).split("/").map((segment) => {
    if (/^\d+$/.test(segment) || /^\$(?:\w+|\{\w+\})$/.test(segment)) return "#";
    return segment;
  });
  return (
    !segments.some((segment) => segment.includes("$")) && GH_VARIABLE_REPLY.test(segments.join("/"))
  );
}

/**
 * Options a CLI accepts before its command words: `valued` take the next word as their value,
 * `flags` take none. `--name=value` and a short option with its value attached are read as one.
 */
const KUBE_VALUED =
  /^(?:-n|--namespace|--context|--cluster|--user|-s|--server|--kubeconfig|--token|--as|--as-group|--as-uid|--request-timeout|--certificate-authority|--client-certificate|--client-key|--tls-server-name|--cache-dir|-v|--v|--log-file|--profile|--profile-output|--username|--password)$/;
const KUBE_FLAGS =
  /^(?:--insecure-skip-tls-verify|--match-server-version|--warnings-as-errors|-h|--help)$/;
const GLOBALS: Record<string, { valued: RegExp; flags: RegExp }> = {
  // `-h` is help in gh, but is treated as unknown so a word after it is never trusted as the verb.
  gh: { valued: /^(?:-R|--repo|--hostname)$/, flags: /^(?:--help|--version)$/ },
  kubectl: { valued: KUBE_VALUED, flags: KUBE_FLAGS },
  oc: { valued: KUBE_VALUED, flags: KUBE_FLAGS },
  helm: {
    valued:
      /^(?:-n|--namespace|--kube-context|--kubeconfig|--kube-apiserver|--kube-token|--kube-as-user|--kube-as-group|--kube-ca-file|--kube-tls-server-name|--registry-config|--repository-config|--repository-cache|--burst-limit|--qps)$/,
    flags: /^(?:--debug|--kube-insecure-skip-tls-verify|-h|--help)$/,
  },
  terraform: { valued: /^$/, flags: /^(?:-help|-version|--help|--version)$/ },
  tofu: { valued: /^$/, flags: /^(?:-help|-version|--help|--version)$/ },
  pulumi: {
    valued: /^(?:-C|--cwd|-s|--stack|--color|-v|--verbose|--tracing|--memprofilerate)$/,
    flags:
      /^(?:--non-interactive|--emoji|--logflow|--logtostderr|--disable-integrity-checking|-e|-h|--help)$/,
  },
  npm: {
    valued:
      /^(?:--prefix|-C|--registry|--workspace|-w|--userconfig|--globalconfig|--cache|--loglevel|--otp|--tag|--access)$/,
    flags:
      /^(?:-s|--silent|-q|--quiet|-d|--verbose|-y|--yes|-g|--global|--ws|--workspaces|--dry-run|-h|--help)$/,
  },
  pnpm: {
    valued: /^(?:-C|--dir|--filter|-F|--registry|--loglevel|--reporter)$/,
    flags: /^(?:-r|--recursive|-w|--workspace-root|-s|--silent|--dry-run)$/,
  },
  yarn: { valued: /^(?:--cwd|--registry)$/, flags: /^(?:-s|--silent|--verbose)$/ },
  cargo: {
    valued: /^(?:-C|--config|-Z|--color|--manifest-path)$/,
    flags: /^(?:-v|-vv|-q|--quiet|--frozen|--locked|--offline|--verbose)$/,
  },
  docker: {
    valued: /^(?:-H|--host|-c|--context|--config|-l|--log-level|--tlscacert|--tlscert|--tlskey)$/,
    flags: /^(?:-D|--debug|--tls|--tlsverify)$/,
  },
  podman: {
    valued: /^(?:--url|-c|--connection|--root|--runroot|--log-level)$/,
    flags: /^(?:--remote|-r)$/,
  },
  poetry: {
    valued: /^(?:-C|--directory|-P|--project)$/,
    flags: /^(?:-q|--quiet|-v|-vv|-n|--no-interaction|--ansi|--no-ansi)$/,
  },
  dotnet: { valued: /^$/, flags: /^(?:-d|--diagnostics|-h|--help)$/ },
  az: {
    valued: /^(?:--subscription|-o|--output|--query)$/,
    flags: /^(?:--only-show-errors|--debug|--verbose|-h|--help)$/,
  },
  aws: {
    valued:
      /^(?:--profile|--region|--output|--endpoint-url|--query|--color|--ca-bundle|--cli-read-timeout|--cli-connect-timeout|--cli-binary-format)$/,
    flags:
      /^(?:--debug|--no-verify-ssl|--no-paginate|--no-cli-pager|--no-sign-request|--no-cli-auto-prompt)$/,
  },
  gcloud: {
    valued:
      /^(?:--project|--account|--configuration|--format|--verbosity|--impersonate-service-account|--billing-project|--flags-file|--trace-token)$/,
    flags: /^(?:-q|--quiet|--no-user-output-enabled|--log-http|-h|--help)$/,
  },
};

/**
 * The first `count` command words of a CLI invocation once its known global options (and their
 * values) are skipped, and whether an option it does not know came before them: its value could
 * then be one of the words, or hide the real one, so the caller fails closed.
 */
function leading(
  name: string,
  args: string[],
  count: number,
  /** Stop at the first option after a command word (cloud CLIs take global options only first). */
  stop = false,
): { words: string[]; unknown: boolean } {
  const known = GLOBALS[name];
  const words: string[] = [];
  let unknown = false;
  let options = true;
  for (let i = 0; i < args.length && words.length < count; i++) {
    const arg = args[i] as string;
    if (!options || arg === "-" || !arg.startsWith("-")) {
      words.push(arg);
      continue;
    }
    if (stop && words.length) break;
    if (arg === "--") options = false;
    else if (/^--[^=]+=/.test(arg) && known) continue;
    else if (known?.valued.test(arg)) i++;
    else if (known?.flags.test(arg)) continue;
    else if (known && /^-[a-zA-Z]./.test(arg) && known.valued.test(arg.slice(0, 2))) continue;
    else unknown = true;
  }
  return { words, unknown };
}

/** Whether a CLI's command word (the first, or with an unknown option any later word) matches. */
function verbMatches(name: string, args: string[], verb: RegExp | undefined): boolean {
  if (!verb) return false;
  const { words, unknown } = leading(name, args, 1);
  if (unknown) return args.some((arg) => !arg.startsWith("-") && verb.test(arg));
  return verb.test(words[0] ?? "");
}

/** Whether `gh` runs a floor subcommand (`gh <group> <verb>`, `gh repo deploy-key add`). */
function ghFloor(args: string[]): boolean {
  const { words, unknown } = leading("gh", args, 3);
  const pair = (group: string, verb: string, third = "") =>
    GH_DELETE[group]?.test(verb) ||
    (group === "repo" && verb === "deploy-key" && /^(?:add|delete)$/.test(third));
  if (!unknown) return !!pair(words[0] ?? "", words[1] ?? "", words[2] ?? "");
  // An option gh does not know came first: any later pair of words could be the subcommand.
  const positional = args.filter((arg) => !arg.startsWith("-"));
  return positional.some((group, k) =>
    positional.slice(k + 1).some((verb, j) => pair(group, verb, positional[k + j + 2] ?? "")),
  );
}

/** The floor rules for one literal program. */
function floorRules(name: string, cmd: Command, context: Context, rules: Set<HardRule>): void {
  const texts = cmd.args.map((word) => word.text);
  if (verbMatches(name, texts, INFRA_WRITE[name])) rules.add("cloud-write");
  if (name === "dotnet") {
    const { words, unknown } = leading(name, texts, 2);
    if (
      (words[0] === "nuget" && words[1] === "push") ||
      (unknown && texts.includes("nuget") && texts.includes("push"))
    )
      rules.add("publish");
  } else if (verbMatches(name, texts, PUBLISHERS[name])) rules.add("publish");
  if (name === "gh") {
    if (ghFloor(texts)) rules.add("repo-delete");
    const { words, unknown } = leading("gh", texts, 1);
    if ((words[0] === "api" || (unknown && texts.includes("api"))) && ghApiFloor(cmd.args))
      rules.add("repo-delete");
  }
  if (
    httpWrite(
      name,
      cmd.args.map((word) => word.text),
    )
  )
    rules.add("cloud-write");
  if (name === "find") {
    const texts = cmd.args.map((word) => word.text);
    const exec = texts.findIndex((text) => /^-(?:exec|execdir|ok|okdir)$/.test(text));
    const deletes =
      texts.includes("-delete") ||
      (exec >= 0 && /^(?:.*\/)?(?:rm|rmdir|unlink|shred)$/.test(texts[exec + 1] ?? ""));
    // Any action that deletes or runs something, wherever find could reach the state.
    if ((exec >= 0 || texts.includes("-delete")) && findReachesState(texts, context.cwds))
      rules.add("policy-state");
    if (deletes) {
      const start = cmd.args.findIndex((word) => /^[-!(]/.test(word.text));
      const roots = cmd.args.slice(0, start < 0 ? cmd.args.length : start);
      const targets = roots.length ? roots : [{ text: ".", literal: true } as Word];
      if (targets.some((word) => !disposableTarget(word, context))) rules.add("rm-outside");
    }
  }
  if (name === "rm" && cmd.args.some((word) => /^-[a-zA-Z]*[rR]|^--recursive$/.test(word.text)))
    for (const word of cmd.args) {
      if (word.text.startsWith("-") && word.literal) continue;
      if (!disposableTarget(word, context)) rules.add("rm-outside");
    }
}

/**
 * Whether a recursive `rm` target is strictly inside a linked feature worktree, the system temp
 * directory or a profile scratch root. A word that is not literal, or that expands (a glob or a
 * brace) under the home directory, is not.
 */
function disposableTarget(word: Word, context: Context): boolean {
  if (!word.literal) return false;
  const text = word.text;
  const expands = /[*?[{]/.test(text);
  const base = expands ? text.slice(0, text.search(/[*?[{]/)) : text;
  if (expands && (base === "" || base === "~" || base.startsWith("~/") || base === "/")) {
    // `rm -rf ~/{a,b}` or `rm -rf ~/*`: an expansion in the home directory is never disposable.
    if (base.startsWith("~") || base === "/" || base === "") return false;
  }
  if (context.unknownCwd && !base.startsWith("/") && !base.startsWith("~")) return false;
  const roots = [...tempRoots(), ...context.scratchRoots];
  const found = resolutions(base || ".", context.cwds);
  // A target that cannot be resolved (`~user/x`, an unknown directory) is not disposable.
  if (!found.length) return false;
  for (const path of found) {
    let real = path;
    try {
      real = canonical(path);
    } catch {
      /* judged as written */
    }
    if (expands && inside(homedir(), real) && !roots.some((root) => inside(root, real)))
      return false;
    const strictly = roots.some((root) => inside(root, real) && real !== root);
    if (!strictly && !featureWorktree(real)) return false;
  }
  return true;
}

/** Whether a path is strictly inside a linked worktree on a feature branch. */
function featureWorktree(path: string): boolean {
  try {
    let dir = path;
    while (!existsSync(dir)) dir = dirname(dir);
    const top = canonical(git(dir, ["rev-parse", "--show-toplevel"]));
    if (!inside(top, path) || top === path) return false;
    const gitDir = git(dir, ["rev-parse", "--path-format=absolute", "--git-dir"]);
    const common = git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const branch = git(dir, ["branch", "--show-current"]);
    return gitDir !== common && !!branch && !/^(?:main|master)$/.test(branch);
  } catch {
    return false;
  }
}
const SECRET_WORD =
  /(?:secret|credential|password|connection[-_]?strings?|(?:^|[-_])keys?(?:$|[-_])|listKeys|access-token|get-token|kubeconfig)/i;

interface Context {
  cwds: Set<string>;
  unknownCwd: boolean;
  /** Every word of the script and of the scripts it runs, for scripts that cannot be read. */
  words: string[];
  /** The words of every assignment's value, which an expansion can bring into a command. */
  assigned: string[];
  /** The script runs text as code somewhere (a shell, an interpreter, `eval`, `xargs`...). */
  runsText?: boolean;
  /** Absolute directories where a recursive rm is disposable (the profile's scratch roots). */
  scratchRoots: string[];
}

/** Shell variables the shell itself sets or changes: their values are never known here. */
const SPECIAL_VARIABLE =
  /^(?:IFS|PWD|OLDPWD|RANDOM|SRANDOM|SECONDS|LINENO|UID|EUID|PPID|HISTCMD|REPLY|OPTARG|OPTIND|PATH|HOME|CDPATH|ENV|PS\d|BASH\w*|ZSH\w*|EPOCH\w*|FUNCNAME|PIPESTATUS|argv|status|path|cdpath)$/;
/** A value that is one word as it stands: no whitespace, glob, quote or expansion. */
const ONE_WORD = /^[^\s*?[\]{}'"\\$`]+$/;
/** The most combinations of loop values one command is judged with. */
const MAX_VARIANTS = 16;

/**
 * The variables whose value is known at each segment: a name bound exactly once in the script,
 * either by a plain assignment of a literal value (`F=/tmp/x/notes.md`) that has run whenever the
 * segment runs (it starts the script or follows `;` or a newline at the top level, or every
 * operator from it to the segment is `&&`), or by a `for NAME in <literal words>` loop whose body
 * holds the segment. A script with `eval` or `source`, or a name bound any other way (`read`,
 * `export`, `unset`, `${N:=x}`, a loop, arithmetic), has none.
 */
function knownVariables(
  segments: Word[][],
  script: string,
  settled = new Set<string>(),
): Array<Map<string, string[]>> {
  const known = segments.map(() => new Map<string, string[]>());
  if (
    segments.some((segment) => {
      const program = command(segment).program;
      return !!program && (!program.literal || /^(?:eval|source|\.)$/.test(program.text));
    })
  )
    return known;
  const binders = new Map<string, number>();
  const bind = (name: string) => binders.set(name, (binders.get(name) ?? 0) + 1);
  for (const segment of segments) {
    const first = segment[0];
    if (first?.literal && /^(?:for|select)$/.test(first.text) && segment[1]) bind(segment[1].text);
    // Assignments in command position (`F=x`, `F=x cmd`, `env F=x cmd`); `-f t=$t` is an argument.
    for (const word of command(segment).assignments) {
      const name = /^([A-Za-z_]\w*)(\+?)=/.exec(word.text);
      if (name) bind(name[1] as string);
      if (name?.[2]) binders.set(name[1] as string, 2);
    }
  }
  const rebinds = (name: string) =>
    new RegExp(
      `\\b(?:read|unset|export|local|declare|typeset|readonly|let|mapfile|readarray|getopts|vared|zparseopts|integer|float)\\b[^\\n;&|]*\\b${name}\\b|\\bprintf?\\s+(?:-\\S+\\s+)*-v\\s*${name}\\b|\\$\\{${name}:?[=?]|\\(\\([^)]*\\b${name}\\s*(?:[-+*/%]?=|\\+\\+|--)|\\b${name}\\s*\\[`,
    ).test(script);
  const usable = (name: string) =>
    binders.get(name) === 1 && !SPECIAL_VARIABLE.test(name) && !rebinds(name);
  const simple = (after: string | undefined) => !after || /^[;\n]+$/.test(after);
  for (const [j, segment] of segments.entries()) {
    const first = segment[0];
    if (!first) continue;
    // `for NAME in a b c`: inside the body, NAME is one of the words.
    if (first.literal && first.text === "for" && segment[2]?.text === "in" && segment[2].literal) {
      const name = segment[1]?.text ?? "";
      const values = segment.slice(3);
      if (
        !usable(name) ||
        !values.length ||
        values.some(
          (word) => !word.literal || !ONE_WORD.test(word.text) || word.text.startsWith("-"),
        )
      )
        continue;
      for (let k = j + 1; k < segments.length; k++) {
        const head = segments[k]?.[0];
        if (head?.literal && head.text === "done" && head.depth === first.depth) break;
        known[k]?.set(
          name,
          values.map((word) => word.text),
        );
      }
      continue;
    }
    // A segment of plain assignments only, at the top level.
    if (command(segment).program || segment.some((word) => word.depth || word.redirect)) continue;
    for (const word of segment) {
      const match = /^([A-Za-z_]\w*)=(.*)$/s.exec(word.text);
      if (!match || !word.literal) continue;
      const name = match[1] as string;
      if (!usable(name)) continue;
      let chained = true;
      // Assigned before anything reads it, and known wherever it is read afterwards: the value
      // is judged at each use, so the assignment itself names no target.
      const read = new RegExp(`\\$\\{?${name}\\b`);
      if (
        simple(first.after) &&
        !segments.slice(0, j).some((earlier) => earlier.some((w) => read.test(w.text)))
      )
        settled.add(name);
      for (let k = j + 1; k < segments.length; k++) {
        const here = segments[k] as Word[];
        const after = here[0]?.after;
        chained &&= after === "&&" || after === "$(";
        if (!simple(first.after) && (!chained || here.some((w) => w.depth))) break;
        known[k]?.set(name, [match[2] as string]);
      }
    }
  }
  return known;
}

/**
 * The segment with each word whose expansions are all known variables filled in, once per
 * combination of values (at most MAX_VARIANTS), or the segment as it is. An unquoted expansion is
 * filled in only with values that stay one word.
 */
function filled(segment: Word[], known: Map<string, string[]>): Word[][] {
  if (!known.size) return [segment];
  let variants: Word[][] = [[]];
  for (const word of segment) {
    let options = [word];
    if (!word.literal && !word.heredoc && /\$/.test(word.text)) {
      const parts = word.text.split(/(\$\{\w+\}|\$[A-Za-z_]\w*)/);
      let texts: string[] | undefined = [""];
      for (const [index, part] of parts.entries()) {
        if (index % 2 === 0) {
          if (part.includes("$") || part.includes("`")) texts = undefined;
        } else {
          const values = known.get(part.replace(/^\$\{?|\}$/g, ""));
          if (!values || (word.bare && values.some((value) => !ONE_WORD.test(value))))
            texts = undefined;
          else texts = texts?.flatMap((text) => values.map((value) => text + value));
        }
        if (!texts) break;
        if (index % 2 === 0) texts = texts.map((text) => text + part);
      }
      if (texts && texts.length <= MAX_VARIANTS)
        options = texts.map((text) => {
          const { bare: _bare, ...rest } = word;
          return { ...rest, text, literal: true };
        });
    }
    variants = variants.flatMap((variant) => options.map((option) => [...variant, option]));
    if (variants.length > MAX_VARIANTS) return [segment];
  }
  return variants;
}

/** Programs that delete or move their operands: a directory above the state counts for them. */
/** Most directories a script is judged in before its directory counts as unknown. */
const MAX_CWDS = 16;
/** Readers that walk the directory trees they are given, with no flag needed. */
const TREE_READERS = new Set(["rg", "ag", "ack", "tar", "zip", "7z", "rsync", "scp", "rclone"]);
/** Programs that only list or name a directory, whatever their flags. */
const LISTERS = new Set([
  "ls",
  "find",
  "du",
  "stat",
  "tree",
  "cd",
  "pushd",
  "echo",
  "printf",
  "test",
  "[",
]);
const REMOVERS = new Set(["rm", "rmdir", "unlink", "shred", "mv", "trash", "srm", "rsync"]);
const SHELL_NAMES = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "fish", "source", "."]);
/** Programs that run text they are given (inline code, a here-document, standard input). */
const INTERPRETERS = new Set([
  ...["node", "nodejs", "deno", "bun", "python", "python2", "python3", "perl", "ruby", "php"],
  ...["osascript", "pwsh", "powershell", "lua", "tclsh", "expect"],
  ...["jshell", "irb", "R", "Rscript", "julia", "swift", "groovy", "scala"],
]);
/** Programs that run another command from their arguments or input. */
const RUNNERS = new Set([
  ...["eval", "exec", "xargs", "find", "alias", "ssh", "su", "script", "watch", "parallel"],
  ...["tmux", "screen", "docker", "podman", "kubectl", "nohup", "env", "sudo", "doas"],
]);
/** Whether a command (after wrappers) can run text as code. Unknown programs count. */
export function runsText(cmd: Command): boolean {
  const program = cmd.program;
  if (!program) return false;
  if (!program.literal) return true;
  const name = (program.text.split(/[\\/]/).pop() ?? "").replace(/\d+(?:\.\d+)*$/, "");
  const texts = cmd.args.map((word) => word.text);
  // sed runs a command only through GNU `e` (a command or an `s///e` flag); awk through
  // `system(`, a pipe to or from a command, or `|&`. An ordinary edit or print is data.
  if (name === "sed")
    return texts.some((text) =>
      /(?:^|[;\n{}]\s*)e(?:\s|$)|\/[gpIiMm0-9w]*e[gpIiMm0-9]*\s*(?:$|[;}])/.test(text),
    );
  if (["awk", "gawk", "mawk", "nawk"].includes(name))
    return texts.some((text) => /system\s*\(|\|\s*getline|print[^;]*\|\s*"|\|&/.test(text));
  return (
    SHELL_NAMES.has(name) ||
    INTERPRETERS.has(name) ||
    INTERPRETERS.has(program.text.split(/[\\/]/).pop() ?? "") ||
    RUNNERS.has(name)
  );
}
/** Whether any command of a script can run text as code, or the script could not be read. */
export function scriptRunsText(script: string): boolean {
  const { segments, complete } = scan(script);
  return !complete || segments.some((segment) => runsText(command(segment)));
}

/** A word's text as the words it could split into (`X="push --force"; git $X`). */
function split(word: Word): string[] {
  const text = /^[A-Za-z_]\w*\+?=/.test(word.text)
    ? word.text.slice(word.text.indexOf("=") + 1)
    : word.text;
  return text.split(/\s+/).filter(Boolean);
}

/**
 * The commands an awk program runs: the literal ones (`system("cmd")`, `print | "cmd"`,
 * `"cmd" | getline`) and whether any is not a literal string. One pass that skips strings and
 * regular expressions, so a `|` inside `/a|b/` is not a pipe.
 */
function awkCommands(program: string): {
  literal: string[];
  opaque: boolean;
  writes: string[];
  writesOpaque: boolean;
} {
  const literal: string[] = [];
  let opaque = false;
  /** Files `print > "f"` and `printf >> "f"` write, and whether a target is not a literal. */
  const writes: string[] = [];
  let writesOpaque = false;
  /**
   * Whether the program prints at all (any `print`/`printf`, even in a string: fail closed), and
   * the paren depth. With a print anywhere, every `>`/`>>` outside parentheses is read as an
   * output redirection, whatever control keyword (`if`, `else`, `for`, `while`, `do`) or statement
   * it follows; a comparison there is read the same way, which only fails closed.
   */
  const prints = /\bprintf?\b/.test(program);
  let braces = 0;
  let parens = 0;
  let last = ""; // the previous significant character
  let lastString: string | undefined; // the string literal just before, if the last token was one
  /** A string from `from`: its text, where it ends, and whether it has escapes (not judged). */
  const readString = (from: number): [string, number, boolean] | undefined => {
    let text = "";
    let escaped = false;
    for (let j = from + 1; j < program.length; j++) {
      const c = program[j] as string;
      if (c === "\\") {
        escaped = true;
        text += c + (program[++j] ?? "");
        continue;
      }
      if (c === '"') return [text, j, escaped];
      text += c;
    }
    return undefined;
  };
  const skipSpace = (from: number) => {
    let j = from;
    while (j < program.length && /\s/.test(program[j] as string)) j++;
    return j;
  };
  for (let i = 0; i < program.length; i++) {
    const c = program[i] as string;
    if (/\s/.test(c)) continue;
    if (c === '"') {
      const read = readString(i);
      if (!read) {
        opaque = true;
        break;
      }
      lastString = read[2] ? undefined : read[0];
      i = read[1];
      last = '"';
      continue;
    }
    if (c === "/" && (last === "" || "(,~!&|{};:?\n".includes(last))) {
      let j = i + 1;
      while (j < program.length && program[j] !== "/") j += program[j] === "\\" ? 2 : 1;
      i = j;
      last = "/";
      lastString = undefined;
      continue;
    }
    if (c === "|" && program[i + 1] !== "|" && program[i - 1] !== "|") {
      let j = skipSpace(i + 1 + (program[i + 1] === "&" ? 1 : 0));
      if (program.startsWith("getline", j)) {
        if (lastString === undefined) opaque = true;
        else literal.push(lastString);
      } else if (program[j] === '"') {
        const read = readString(j);
        // Output piped into a shell or interpreter is a script nobody can read here.
        if (
          !read ||
          read[2] ||
          /^\s*(?:\S*\/)?(?:sh|bash|zsh|dash|ksh|mksh|pwsh|powershell|python\d*(?:\.\d+)?|node|perl|ruby|php)(?:\s|$)/.test(
            read[0],
          )
        )
          opaque = true;
        else {
          literal.push(read[0]);
          j = read[1];
        }
      } else opaque = true;
      last = "|";
      lastString = undefined;
      continue;
    }
    if (c === "(") parens++;
    else if (c === ")") parens = Math.max(0, parens - 1);
    else if (c === "{") braces++;
    else if (c === "}") braces = Math.max(0, braces - 1);
    // Output redirection, `print ... > "file"` or `>>`, inside an action and outside parentheses
    // (a pattern such as `$3 > 100`, and anything in parentheses, is a comparison). A target that
    // is not one string literal (a variable, a concatenation) is an opaque write. `>=` compares.
    if (c === ">" && prints && braces > 0 && parens === 0 && program[i + 1] !== "=") {
      const at = skipSpace(i + (program[i + 1] === ">" ? 2 : 1));
      const read = program[at] === '"' ? readString(at) : undefined;
      const after = read ? program[skipSpace(read[1] + 1)] : undefined;
      if (read && !read[2] && (after === undefined || ";})|\n".includes(after)))
        writes.push(read[0]);
      else writesOpaque = true;
      if (read) i = read[1];
      last = '"';
      lastString = undefined;
      continue;
    }
    if (program.startsWith("system", i) && !/\w/.test(program[i - 1] ?? "")) {
      const open = skipSpace(i + 6);
      if (program[open] === "(") {
        const start = skipSpace(open + 1);
        const read = program[start] === '"' ? readString(start) : undefined;
        if (read && !read[2] && program[skipSpace(read[1] + 1)] === ")") literal.push(read[0]);
        else opaque = true;
      }
    }
    last = c;
    lastString = undefined;
  }
  return { literal, opaque, writes, writesOpaque };
}

/** Shells whose script can come from standard input; PowerShell's is never read here. */
const POWERSHELLS = new Set(["pwsh", "powershell", "pwsh.exe", "powershell.exe"]);
/** Interpreter options whose value is the code to run (`python3 -c`, `node -e`, `php -r`). */
const CODE_FLAG = /^(?:-c|-e|-E|-p|-r|--eval|--print)$/;

/**
 * The text a literal producer writes to its standard output: `echo` and `printf` with literal
 * arguments, or `cat` of a here-document (quoted, or unquoted with no expansion). Undefined when
 * the output cannot be read here.
 */
function producedText(segment: Word[]): string | undefined {
  const cmd = command(segment);
  const name = cmd.program?.literal ? (cmd.program.text.split("/").pop() ?? "") : "";
  if (cmd.redirects.some((word) => !word.heredoc && !word.writes)) return undefined;
  if (name === "echo" || name === "printf") {
    if (!cmd.args.every((word) => word.literal)) return undefined;
    const args = cmd.args.map((word) => word.text);
    const text = (name === "echo" ? args.filter((arg) => !/^-[neE]+$/.test(arg)) : args).join(" ");
    return text.replace(/\\n/g, "\n");
  }
  if (name === "cat" && !cmd.args.length) {
    const docs = segment.filter((word) => word.heredoc || word.herestring);
    if (docs.length !== 1) return undefined;
    const doc = docs[0] as Word;
    if (!doc.literal || (doc.heredoc && !doc.quoted && /[$`\\]/.test(doc.text))) return undefined;
    return doc.text;
  }
  return undefined;
}

/** The file a program's own command text writes, per program (the target in group 1 or 2). */
const SED_WRITES = /(?:^|[;\n{}]|\/[gpIiMme0-9]*|\d|\$)\s*[wW]\s+([^\n;}]+)/g;
const EX_WRITES =
  /(?:^|[|\n:+])[ \t]*(?:\d+(?:,\d+)?|%)?(?:w(?:rite)?|wq|x(?:it)?|sav(?:eas)?|up(?:date)?)!?[ \t]+(?:>>[ \t]*)?([^\s|]+)/g;
const ED_WRITES = /(?:^|\n)[ \t]*[\d,.$]*[wW]q?[ \t]+(\S+)/g;
const SQLITE_WRITES = /\.(?:output|once|save)\s+(\S+)|\.backup\s+(?:\w+\s+)?(\S+)/g;
const EDITOR_WRITES: Record<string, RegExp> = {
  sed: SED_WRITES,
  gsed: SED_WRITES,
  ex: EX_WRITES,
  vi: EX_WRITES,
  vim: EX_WRITES,
  nvim: EX_WRITES,
  view: EX_WRITES,
  ed: ED_WRITES,
  sqlite3: SQLITE_WRITES,
};

/**
 * Files a program's own text writes (an awk redirection, a sed `w`, an editor's `w`, a sqlite3
 * `.output`) get the checks a shell redirection does: the policy state, protected configuration.
 * A target that is not a literal (a variable, a concatenation) is `opaque-script`, and text that
 * writes somewhere and names `acp` counts as the policy state.
 */
function writeTargets(
  targets: string[],
  opaque: boolean,
  text: string,
  context: Context,
  rules: Set<HardRule>,
): void {
  if (opaque) rules.add("opaque-script");
  if (!targets.length && !opaque) return;
  if (/\bacp/i.test(text)) rules.add("policy-state");
  for (const target of targets) {
    pathRules(target, rules, false);
    const resolved = resolutions(target, context.cwds);
    for (const path of resolved) pathRules(path, rules, false);
    if ([target, ...resolved].some(policyStatePath) || namesState(target, context.cwds, false))
      rules.add("policy-state");
  }
}

/** Shells whose script can come from standard input. Non-POSIX ones are read with sh's rules. */
const ANY_SHELLS = new Set([
  ...["sh", "bash", "zsh", "dash", "ksh", "mksh", "yash", "ash", "rbash", "fish", "csh", "tcsh"],
  ...["nu", "elvish", "xonsh", "busybox"],
]);

/**
 * How a command reads a script from its standard input: `shell` (a shell with no script operand,
 * or `-s`; `source /dev/stdin`), `code` (an interpreter with no code flag or script), `opaque`
 * (PowerShell, `xargs <shell>`, `sh -c "$var"`, a process substitution), or undefined when it does
 * not. A shell's `-c` script is searched for such a command too (`bash -c 'sh'`).
 */
function readsScript(segment: Word[], depth = 0): "shell" | "code" | "opaque" | undefined {
  const cmd = command(segment);
  if (!cmd.program?.literal) return undefined;
  let name = cmd.program.text.split(/[\\/]/).pop() ?? "";
  let words = cmd.args;
  if (name === "busybox") {
    name = words[0]?.text ?? "";
    words = words.slice(1);
  }
  const args = words.map((word) => word.text);
  const operands = args.filter((arg) => !arg.startsWith("-"));
  const programAt = segment.indexOf(cmd.program);
  const viaXargs = segment.some(
    (word, k) => k < programAt && word.literal && /(?:^|\/)xargs$/.test(word.text),
  );
  if (ANY_SHELLS.has(name) || POWERSHELLS.has(name.toLowerCase())) {
    if (viaXargs || POWERSHELLS.has(name.toLowerCase())) return "opaque";
    const flag = args.findIndex((arg) => /^-[a-zA-Z]*c[a-zA-Z]*$|^--command$/.test(arg));
    if (flag >= 0) {
      const body = words[flag + 1];
      if (!body || !body.literal) return "opaque";
      if (depth >= 3) return "opaque";
      for (const inner of scan(body.text).segments) {
        const kind = readsScript(inner, depth + 1);
        if (kind) return kind;
      }
      return undefined;
    }
    if (operands.length && !args.includes("-s")) return undefined; // `bash script.sh`
    return "shell";
  }
  if (name === "source" || name === ".") {
    const target = words[0];
    if (!target) return undefined;
    if (!target.literal) return "opaque"; // `. <(curl ...)`, `source $f`
    return /^\/dev\/(?:stdin|fd\/0)$|^-$/.test(target.text) ? "shell" : undefined;
  }
  if (INTERPRETERS.has(name)) {
    if (viaXargs) return "opaque";
    if (words.some((_, i) => i > 0 && CODE_FLAG.test(args[i - 1] ?? ""))) return undefined;
    if (operands.some((arg) => arg !== "-")) return undefined; // `python3 script.py`
    return "code";
  }
  return undefined;
}

/**
 * A script fed to a shell or interpreter. The stage a pipe feeds is the piped command and, when
 * it opens a group (`( ... )`, `{ ...; }`, `if`, `while`, `for`, `case`), everything inside the
 * group; a here-string or a redirected standard input feeds its own command. When any command
 * there reads its script from standard input (`readsScript`), a literal `echo`, `printf`, quoted
 * here-document or here-string is judged as the script it is (the floor and every hard rule for a
 * shell, the interpreter rule for code); anything else is `opaque-script`.
 */
function stdinScript(
  segments: Word[][],
  k: number,
  context: Context,
  rules: Set<HardRule>,
  depth: number,
): void {
  const segment = segments[k] as Word[];
  const first = segment[0];
  const piped = segment.find((word) => word.piped);
  const here = segment.filter((word) => word.herestring);
  const docs = segment.filter((word) => word.heredoc);
  const cmd = command(segment);
  const fromFile = cmd.redirects.some(
    (word) => !word.heredoc && !word.herestring && !word.writes && !/^\d*$/.test(word.text),
  );
  let kind: "shell" | "code" | "opaque" | undefined;
  let text: string | undefined;
  if (piped) {
    // The stage: this command, and the rest of a group it opens.
    const at = piped.pipedAt ?? first?.depth ?? 0;
    for (let j = k; j < segments.length; j++) {
      const stage = segments[j] as Word[];
      if (j > k && (stage[0]?.depth ?? 0) <= at) break;
      kind ??= readsScript(stage);
      if (kind) break;
    }
    if (!kind) return;
    text = producedText(segments[k - 1] ?? []);
  } else {
    kind = readsScript(segment);
    if (!kind) return;
    if (here.length) {
      const word = here[here.length - 1] as Word;
      if (word.literal) text = word.text;
    } else if (docs.length)
      return; // a here-document: judged as code where it is read
    else if (!fromFile && kind !== "opaque") return; // nothing is fed in (an interactive shell)
  }
  if (kind === "opaque" || text === undefined) {
    rules.add("opaque-script");
    return;
  }
  context.runsText = true;
  if (kind === "shell" && depth < 4) analyzeScript(text, context, rules, depth + 1);
  if (kind === "code" && codeTouchesState(text, context.cwds)) rules.add("policy-state");
  textRules(text, [...context.cwds][0] ?? "", rules);
}

/**
 * Code names the policy service's secrets (the token, grants, socket: anything in a session
 * directory but its audit logs) when a string literal that is a whole path could be one. A path
 * inside longer text (source being edited, a message) is data.
 */
function codeSecrets(code: string, context: Context, rules: Set<HardRule>): void {
  for (const match of code.matchAll(/(["'`])((?:~\/|\/|[A-Za-z]:[\\/])[^\s"'`]{1,4096})\1/g))
    if (namesStateSecret(match[2] as string, context.cwds, false)) {
      rules.add("credential-read");
      return;
    }
}

function analyzeScript(
  script: string,
  context: Context,
  rules: Set<HardRule>,
  depth: number,
): void {
  const { segments, complete } = scan(script);
  // Here-document bodies are data unless something in the script runs text as code.
  const runs = !complete || segments.some((segment) => runsText(command(segment)));
  if (runs) context.runsText = true;
  // Only a shell (or a runner that may start one) reads a here-document as shell commands; one
  // fed to an interpreter, or written to a file an interpreter runs, is code: judged by
  // `codeTouchesState` and for the paths it names.
  const runsShell =
    !complete ||
    segments.some((segment) => {
      const program = command(segment).program;
      const name = (program?.text.split(/[\\/]/).pop() ?? "").replace(/\d+(?:\.\d+)*$/, "");
      return !!program && (!program.literal || SHELL_NAMES.has(name) || RUNNERS.has(name));
    });
  for (const segment of segments)
    for (const word of segment) {
      if (word.heredoc) continue;
      context.words.push(...split(word));
      if (/^[A-Za-z_]\w*\+?=/.test(word.text)) context.assigned.push(...split(word));
    }
  // A script the scanner could not read fully is judged on its words alone.
  if (!complete) opaqueGitRules(context.words, true, rules);
  const settled = new Set<string>();
  const known = knownVariables(segments, script, settled);
  for (const [k, segment] of segments.entries()) {
    for (const variant of filled(segment, known[k] ?? new Map()))
      analyzeCommand(command(variant), variant, context, rules, depth, settled);
    stdinScript(segments, k, context, rules, depth);
    // A here-document fed to a shell, or in a script that runs text (`cat <<EOF | sh`), is code.
    for (const doc of segment.filter((word) => word.heredoc)) {
      if (depth >= 4) continue;
      if (runs && runsShell) {
        analyzeScript(doc.text, context, rules, depth + 1);
        textRules(doc.text, [...context.cwds][0] ?? "", rules);
      } else if (runs) codeSecrets(doc.text, context, rules);
      if (doc.quoted) continue;
      // Fail closed on an unquoted body: besides its substitutions as the scanner reads them, read
      // what follows every `$(` and backtick as a script, so text the scanner might mis-read
      // around them (a stray quote, a backslash, a backtick taken literally) cannot hide a
      // command that will run.
      let openers = 0;
      for (const match of doc.text.matchAll(/\$\(|`/g)) {
        if (++openers > 32) break;
        // What a misread could hide starts at the opener; 4,096 characters bound each rescan.
        const from = (match.index ?? 0) + match[0].length;
        const rest = doc.text.slice(from, from + 4096);
        analyzeScript(rest, context, rules, depth + 1);
      }
    }
  }
}

function analyzeCommand(
  cmd: Command,
  segment: Word[],
  context: Context,
  rules: Set<HardRule>,
  depth: number,
  settled = new Set<string>(),
): void {
  // Every word could name a file: arguments, redirect targets, assignment values. A here-document
  // body, and an argument with whitespace in it (a message, a PR body), is text, not a path,
  // unless the script runs text as code.
  // The policy service's state may be read by a read-only program; anything else that names it
  // (a write, a move, a delete, a redirection into it, an unknown program) goes to a person.
  const programName = cmd.program?.text.split(/[\\/]/).pop() ?? "";
  // `cd` and `pushd` change no file (what runs there is judged in that directory), and the words
  // of a `for NAME in ...` list are values (judged where `$NAME` is used), not operands.
  const loopList = !!segment[0]?.literal && /^(?:for|select)$/.test(segment[0].text);
  const reading =
    loopList ||
    (!!cmd.program?.literal &&
      (/^(?:cd|pushd|case|\[|\[\[|test|echo|:|true|false|break|continue|sleep|seq|wait)$/.test(
        programName,
      ) ||
        readOnly([programName, ...cmd.args.map((word) => word.text)])));
  const argTexts = cmd.args.map((word) => word.text);
  // A recursive permission or owner change reaches everything below its operand, so a directory
  // above the state counts as for a delete.
  const recursive =
    /^(?:chmod|chown|chgrp)$/.test(programName) &&
    argTexts.some((text) => /^-[a-zA-Z]*R|^--recursive$/.test(text));
  const removes = !cmd.program?.literal || REMOVERS.has(programName) || recursive;
  // A reader that walks a directory tree reads the session token below a directory it names.
  const walks =
    !cmd.program?.literal ||
    TREE_READERS.has(programName) ||
    (!LISTERS.has(programName) &&
      argTexts.some((text) => /^-[a-zA-Z]*[rR]|^--recursive$|^--archive$/.test(text)));
  // An archive extracted into a directory the state lies in can overwrite it: `tar -x [-C dir]`,
  // `unzip [-d dir]`, `cpio -i` (into the working directory).
  if (cmd.program?.literal) {
    const optionValue = (flags: RegExp) => {
      const at = argTexts.findIndex((text) => flags.test(text));
      if (at < 0) return undefined;
      const text = argTexts[at] as string;
      const eq = text.indexOf("=");
      return eq > 0 ? text.slice(eq + 1) : (argTexts[at + 1] ?? "");
    };
    let into: string | undefined;
    if (
      programName === "tar" &&
      argTexts.some(
        (text, k) =>
          ((k === 0 || text.startsWith("-")) && /^-?[a-zA-Z]*x[a-zA-Z]*$/.test(text)) ||
          /^--(?:extract|get)$/.test(text),
      )
    )
      into = optionValue(/^(?:-C|--directory)(?:=|$)/) ?? ".";
    else if (programName === "unzip") into = optionValue(/^-d$/) ?? ".";
    else if (
      programName === "cpio" &&
      argTexts.some((text) => /^-[a-zA-Z]*i|^--extract$/.test(text))
    )
      into = optionValue(/^(?:-D|--directory)(?:=|$)/) ?? ".";
    if (into !== undefined && namesState(stateText(into, true), context.cwds, true))
      rules.add("policy-state");
  }
  // `xargs <writer>` takes its targets from input nobody can read here; it fails closed when it
  // could reach the state: it runs where the state lies, or the script names `acp` or a path that
  // could name the state.
  const programAt = cmd.program ? segment.indexOf(cmd.program) : -1;
  const viaXargs = segment.some(
    (word, k) => k < programAt && word.literal && /(?:^|\/)xargs$/.test(word.text),
  );
  if (
    viaXargs &&
    !reading &&
    (namesState(".", context.cwds, true) ||
      context.words.some(
        (word) =>
          /acp/i.test(word) ||
          (/^[/~$]/.test(word) && namesState(stateText(word, false), context.cwds, true)),
      ))
  )
    rules.add("policy-state");
  // Inline interpreter code (`python3 -c`, `perl -e`, `node -e`, a here-document) that could
  // delete, move or write the state.
  if (cmd.program?.literal && INTERPRETERS.has(programName)) {
    // The literal words after the code are `process.argv[1..]` (node -e) or `sys.argv[1..]`
    // (python -c, python - with the code on standard input).
    const words = (from: number) =>
      cmd.args.slice(from).map((word) => (word.literal ? word.text : undefined));
    const inline = cmd.args.findIndex((_, k) =>
      /^(?:-c|-e|-E|-p|-r|--eval|--print)$/.test(cmd.args[k - 1]?.text ?? ""),
    );
    const dash = cmd.args.findIndex((word) => word.text === "-");
    const codes: Array<[string, Array<string | undefined>]> = [
      ...cmd.args
        .filter((_, k) => /^(?:-c|-e|-E|-p|-r|--eval|--print)$/.test(cmd.args[k - 1]?.text ?? ""))
        .map((word): [string, Array<string | undefined>] => [
          word.text,
          inline >= 0 && /^(?:node|nodejs|python[\d.]*)$/.test(programName)
            ? words(inline + 1)
            : [],
        ]),
      ...segment
        .filter((word) => word.heredoc)
        .map((word): [string, Array<string | undefined>] => [
          word.text,
          dash >= 0 && /^python[\d.]*$/.test(programName) ? words(dash + 1) : [],
        ]),
    ];
    if (
      codes.some(([text, argv]) =>
        codeTouchesState(text, context.cwds, { argv, interpreter: programName }),
      )
    )
      rules.add("policy-state");
  }
  // awk runs commands through `system(...)` and pipes (`print | "cmd"`, `"cmd" | getline`): a
  // literal command is judged like `sh -c`, anything else is opaque.
  if (cmd.program?.literal && /^(?:awk|gawk|mawk|nawk)$/.test(programName)) {
    const texts = cmd.args.map((word) => word.text);
    let program: string | undefined;
    for (let i = 0; i < texts.length; i++) {
      const text = texts[i] as string;
      if (/^-[Fvf]$/.test(text)) {
        if (text === "-f") break; // a program file: not read here
        i++;
      } else if (!text.startsWith("-")) {
        program = text;
        break;
      }
    }
    if (program !== undefined) {
      const run = awkCommands(program);
      if (run.opaque) rules.add("opaque-script");
      for (const script of run.literal)
        if (depth < 4) {
          analyzeScript(script, context, rules, depth + 1);
          textRules(script, [...context.cwds][0] ?? "", rules);
        }
      writeTargets(run.writes, run.writesOpaque, program, context, rules);
    }
  }
  // Editors and tools that write files named inside their own command text: sed `w`, `W` and
  // `s///w`, ex/vim `-c 'w file'`, ed's `w`, sqlite3 `.output`/`.once`/`.save`/`.backup`.
  if (cmd.program?.literal && EDITOR_WRITES[programName]) {
    const texts = cmd.args.map((word) => word.text);
    const inputs = segment.filter((word) => word.heredoc || word.herestring);
    const scripts = [...texts, ...inputs.map((word) => word.text)];
    const targets: string[] = [];
    let opaque = inputs.some((word) => !word.literal && !(word.heredoc && word.quoted));
    for (const script of scripts)
      for (const match of script.matchAll(EDITOR_WRITES[programName] as RegExp)) {
        const target = (match[1] ?? match[2] ?? "").replace(/^(["'])(.*)\1$/, "$2");
        if (!target) continue;
        if (/[$`]/.test(target)) opaque = true;
        else targets.push(target);
      }
    writeTargets(targets, opaque, scripts.join("\n"), context, rules);
  }
  // find's name and path patterns are matched below its start directories (`findReachesState`
  // judges what an action could reach), not paths in the working directory.
  const findPatterns = new Set<Word>();
  if (programName === "find" && cmd.program?.literal)
    cmd.args.forEach((word, k) => {
      if (/^-(?:i?name|i?path|i?wholename|i?regex|i?lname)$/.test(cmd.args[k - 1]?.text ?? ""))
        findPatterns.add(word);
    });
  for (const word of segment) {
    if (word.heredoc || findPatterns.has(word)) continue;
    if (!word.redirect && !context.runsText && /\s/.test(word.text)) continue;
    const text = word.text.replace(/^[A-Za-z_]\w*=/, "").replace(/^--?[\w-]+=/, "");
    if (!text) continue;
    pathRules(text, rules, true);
    const resolved = resolutions(text, context.cwds);
    for (const path of resolved) pathRules(path, rules, true);
    // A target is matched as the shell would expand it (a glob, a variable read as `*`), and for a
    // delete or move a directory above the state counts too.
    // A word that is only an expansion (`"$Q"`) counts for a delete, a move or a redirection.
    const target = stateText(text, word.literal);
    const opaque = !word.literal && !/[^*/]/.test(target);
    // A segment of assignments runs nothing: a value that is only an expansion (`B=$(gh ...)`,
    // `X=$Y`) names no file; its command is judged on its own, and its uses where they are.
    if (!cmd.program && opaque) continue;
    if (!cmd.program && settled.has(/^([A-Za-z_]\w*)=/.exec(word.text)?.[1] ?? "")) continue;
    if (
      (word.writes || (!word.redirect && !reading)) &&
      word !== cmd.program &&
      ([text, ...resolved].some(policyStatePath) ||
        ((!opaque || removes || word.writes) && namesState(target, context.cwds, removes)) ||
        (context.unknownCwd && !/^[/~]/.test(text) && /acp/i.test(text)))
    )
      rules.add("policy-state");
    // Reading the service's own files (the token above all; everything but the audit logs) is a
    // credential read, for every reader and any glob or expansion that could reach them.
    if (word !== cmd.program && namesStateSecret(target, context.cwds, walks)) {
      rules.add("credential-read");
      secretReads++;
    }
    const relative = !text.startsWith("/") && !text.startsWith("~") && !text.startsWith("$");
    if (context.unknownCwd && relative && SETTINGS_NAMES.test(text.split("/").pop() ?? ""))
      rules.add("harness-settings");
  }
  const program = cmd.program;
  if (!program) return;
  const name = program.text.split(/[\\/]/).pop() ?? "";
  const args = cmd.args.map((word) => word.text);
  if (program.literal && name === "cd") {
    const target = cmd.args.find((word) => !word.text.startsWith("-"));
    if (!target) context.cwds.add(homedir());
    else if (!target.literal) context.unknownCwd = true;
    else {
      const found = resolutions(target.text, context.cwds);
      // Every `cd` can double the directories a later word is judged in; past a few the script's
      // directory is unknown (relative targets then fail closed) instead of judged in thousands.
      if (!found.length || context.cwds.size + found.length > MAX_CWDS) context.unknownCwd = true;
      else for (const path of found) context.cwds.add(path);
    }
    return;
  }
  const inner = innerScript(cmd);
  if (inner) {
    if (depth < 4) analyzeScript(inner.script, context, rules, depth + 1);
    // An expanded script is not known: judge it on every word the script names.
    if (!inner.literal || depth >= 4) opaqueGitRules(context.words, true, rules);
    return;
  }
  if (program.literal && CLOUD.has(name)) {
    if (args.some((arg) => SECRET_WORD.test(arg))) rules.add("credential-read");
    else {
      // The command path: the words before the first option once known global options are
      // skipped. An option the CLI does not know before it could hide the path, so it fails closed.
      const { words, unknown } = leading(name, args, 6, true);
      const path: string[] = [];
      for (const word of words) {
        if (!/^[a-z][a-z0-9-]*$/.test(word)) break;
        path.push(word);
      }
      const start = args.indexOf(path[0] ?? "");
      const tail = start < 0 ? [] : args.slice(start);
      // `az bicep` compiles, lints and formats local files; it never touches the cloud.
      if (
        unknown ||
        (!path.some((word) => CLOUD_READ_VERB.test(word)) &&
          !cloudGet(tail) &&
          !(name === "az" && path[0] === "bicep"))
      )
        rules.add("cloud-write");
    }
    return;
  }
  if (program.literal) floorRules(name, cmd, context, rules);
  if (program.literal && name !== "git") return;
  // `git`, or a program that is not a literal word (`$GIT`), which could be Git.
  let opaque =
    !program.literal ||
    cmd.assignments.some((word) => /^GIT_/.test(word.text)) ||
    // `env GIT_DIR=...`, `GIT_CONFIG_*` and the like change what Git reads or runs.
    segment.some((word) => /^GIT_[A-Z_]*=/.test(word.text));
  let i = 0;
  /** A `-c remote.*` or `push.*` setting can make a plain push forced or mirrored. */
  let pushConfig = false;
  while (i < cmd.args.length && cmd.args[i]?.text.startsWith("-")) {
    const word = cmd.args[i] as Word;
    if (!word.literal || /^--exec-path/.test(word.text) || /^-c.*alias\./i.test(word.text))
      opaque = true;
    if (/^-c(?:remote|push)\./i.test(word.text)) pushConfig = true;
    if (GIT_VALUED.has(word.text)) {
      const value = cmd.args[i + 1];
      if (
        (word.text === "-c" || word.text === "--config-env") &&
        /^(?:remote|push)\./i.test(value?.text ?? "")
      )
        pushConfig = true;
      // A configuration value can define an alias; a directory (`-C $W`) cannot change what runs.
      if (
        (word.text === "-c" || word.text === "--config-env") &&
        (!value?.literal || /alias\./i.test(value.text))
      )
        opaque = true;
      i += 2;
    } else i++;
  }
  const sub = cmd.args[i];
  // A literal word Git does not know may be an alias: judge what it expands to, in each
  // directory the command could run in (with `-C` applied, as Git reads it).
  if (!opaque && sub?.literal && !KNOWN_GIT.has(sub.text) && program.literal && depth < 4) {
    const dirs = [...context.cwds].map((dir) => {
      const at = args.slice(0, i).lastIndexOf("-C");
      return at >= 0 && args[at + 1] ? resolve(dir, args[at + 1] as string) : dir;
    });
    const rest = shellArgs(args.slice(i + 1));
    let resolved = false;
    for (const dir of dirs) {
      const alias = gitAlias(dir, sub.text);
      if (alias === undefined) continue;
      resolved = true;
      const script = alias.startsWith("!")
        ? `cd ${shellArgs([aliasDirectory(dir)])} && ${alias.slice(1)} ${rest}`
        : `git -C ${shellArgs([dir])} ${alias} ${rest}`;
      const nested: Context = { ...context, cwds: new Set([dir]), words: [], assigned: [] };
      analyzeScript(script, nested, rules, depth + 1);
    }
    if (resolved) return;
  }
  if (!sub?.literal || !KNOWN_GIT.has(sub.text)) opaque = opaque || !!sub;
  if (opaque) {
    // A literal `git` with an unknown subcommand could be anything Git runs: any forcing or
    // deleting flag is enough. An unknown program needs the subcommand's name somewhere too.
    opaqueGitRules([...segment.flatMap(split), ...context.assigned], !program.literal, rules);
    return;
  }
  if (!sub) return;
  // A push whose options are only known at run time (`$ARGS`, `${F:- -f}`, `$(echo -f)`), or
  // that a `remote.*`/`push.*` setting configures, could be forced.
  if (sub.text === "push" && (pushConfig || cmd.args.slice(i + 1).some((word) => word.bare)))
    rules.add("force-push");
  gitRules(sub.text, args.slice(i + 1), rules);
  // `git checkout [<rev>] -- <paths>` and `git restore <paths>` overwrite files: one that is
  // protected where Git runs (`-C` applied: the main checkout, say) is a protected write.
  if (sub.text === "checkout" || sub.text === "restore") {
    const rest = args.slice(i + 1);
    const dashes = rest.indexOf("--");
    const paths = (dashes >= 0 ? rest.slice(dashes + 1) : rest).filter(
      (word) => dashes >= 0 || !word.startsWith("-"),
    );
    const dirs = [...context.cwds].map((dir) => {
      const at = args.slice(0, i).lastIndexOf("-C");
      return at >= 0 && args[at + 1] ? resolve(dir, args[at + 1] as string) : dir;
    });
    if (dirs.some((dir) => paths.some((path) => isProtectedPath(resolve(dir, path)))))
      rules.add("protected");
  }
}

/**
 * The hard rules the command's text names, read as plain words after removing quotes and
 * backslashes. This catches commands the scanner reads as data but that still run: a script
 * piped into a shell, `bash <(...)`, `find -exec`, inline interpreter code, a shell alias. Linear
 * time: splitting only, no backtracking pattern.
 */
function textRules(script: string, cwd: string, rules: Set<HardRule>): void {
  const stripped = script.replace(/['"\\]/g, "");
  const cwds = new Set(cwd ? [cwd] : []);
  for (const segment of stripped.split(/[;&|\n()`<>]/)) {
    const tokens = segment.split(/[\s,]+/).filter(Boolean);
    tokens.forEach((token, k) => {
      const word = token.slice(token.lastIndexOf("=") + 1);
      if (word) {
        pathRules(word, rules, false);
        for (const path of resolutions(word, cwds)) pathRules(path, rules, false);
      }
      if (word.split("/").pop() !== "git") return;
      let j = k + 1;
      while (tokens[j]?.startsWith("-")) j += GIT_VALUED.has(tokens[j] as string) ? 2 : 1;
      const sub = tokens[j];
      if (sub && KNOWN_GIT.has(sub)) gitRules(sub, tokens.slice(j + 1), rules);
    });
  }
}

/** The hard rules a shell script falls under, judged in its working directory. */
export function scriptRules(
  script: string,
  cwd: string,
  scratchRoots: string[] = [],
): Set<HardRule> {
  const rules = new Set<HardRule>();
  const context: Context = {
    cwds: new Set(cwd ? [cwd] : []),
    unknownCwd: !cwd,
    words: [],
    assigned: [],
    scratchRoots,
  };
  analyzeScript(script, context, rules, 0);
  return rules;
}

/** The hard rules a request falls under, from what it touches. */
function requestRules(request: Request, rules: Set<HardRule>, scratchRoots: string[]): void {
  const input = request.input;
  const cwds = new Set(request.cwd ? [request.cwd] : []);
  const file = (path: string, write: boolean) => {
    for (const target of [path, ...resolutions(path, cwds)]) {
      if (write) pathRules(target, rules, false);
      if (write && policyStatePath(target)) rules.add("policy-state");
      if (sensitive(slashes(target))) rules.add("credential-read");
    }
  };
  // A tool that reads or searches a tree (Grep, Glob, LS, a notebook) on a session directory, or a
  // directory above one, can print the session token: a credential read, as `grep -r` is.
  if (TREE_TOOLS.has(request.tool.toLowerCase())) {
    const path = input.path ?? input.notebook_path ?? input.file_path ?? input.dir_path;
    const target = typeof path === "string" && path ? path : request.cwd;
    if (target && namesStateSecret(slashes(target), cwds, true)) rules.add("credential-read");
    if (typeof path === "string") file(path, false);
    return;
  }
  if (WRITE_TOOLS.has(request.tool) || ["Read", "view", "read_file"].includes(request.tool)) {
    const path = input.file_path ?? input.path ?? input.notebook_path;
    if (typeof path === "string") file(path, WRITE_TOOLS.has(request.tool));
    return;
  }
  if (request.tool === "apply_patch") {
    const patch = input.command ?? input.patch ?? input.input;
    if (typeof patch !== "string") return;
    for (const line of patch.split("\n"))
      if (/^\*\*\* (?:Add File|Update File|Delete File|Move to): /.test(line))
        file(line.slice(line.indexOf(": ") + 2).trim(), true);
    return;
  }
  const script = input.command ?? input.cmd;
  if (SHELL_TOOLS.has(request.tool) && typeof script === "string") {
    for (const rule of scriptRules(script, request.cwd, scratchRoots)) rules.add(rule);
    // The union with the plain-text reading, which catches code the scanner reads as data (a
    // script piped into a shell, inline interpreter code). Only when something runs text: in a
    // script that does not, quoted text and here-documents are data (a commit message, a PR body).
    if (scriptRunsText(script)) textRules(script, request.cwd, rules);
  }
}

/** Every hard rule a decision that needs a person falls under, built-in guards first. */
export function hardRules(
  request: Request,
  decision: Decision,
  scratchRoots: string[] = [],
): HardRule[] {
  // The engine and the session ask about the same request in turn: answer from a short memo.
  const key = JSON.stringify([
    request.tool,
    request.cwd,
    request.input,
    decision.reason,
    decision.category,
    decision.userOnly ?? false,
    scratchRoots,
  ]);
  const now = Date.now();
  const hit = ruleMemo.get(key);
  if (hit && now - hit.at < 2000) return [...hit.rules];
  const before = secretReads;
  const rules = withEvidence(() => hardRulesOnce(request, decision, scratchRoots));
  if (ruleMemo.size >= 32) ruleMemo.delete(ruleMemo.keys().next().value as string);
  ruleMemo.set(key, { at: now, rules, secret: secretReads > before });
  return [...rules];
}
const ruleMemo = new Map<string, { at: number; rules: HardRule[]; secret: boolean }>();
/** Shell words that read the policy service's own secrets, counted as the scan finds them. */
let secretReads = 0;
/**
 * Whether a shell request reads the policy service's secrets (the session token, socket, grants:
 * anything in a session directory but its audit logs). Its rule is `credential-read`, and unlike
 * other credential words (a `grep` pattern that mentions `id_rsa`) it is part of the floor: no
 * step approves it.
 */
export function readsPolicySecret(request: Request, scratchRoots: string[] = []): boolean {
  const decision: Decision = {
    decision: "human",
    category: "unknown",
    reason: "",
    requestHash: "",
    cache: "none",
    cached: false,
  };
  const before = secretReads;
  hardRules(request, decision, scratchRoots);
  const key = JSON.stringify([
    request.tool,
    request.cwd,
    request.input,
    decision.reason,
    decision.category,
    false,
    scratchRoots,
  ]);
  return ruleMemo.get(key)?.secret ?? secretReads > before;
}
function hardRulesOnce(request: Request, decision: Decision, scratchRoots: string[]): HardRule[] {
  const rules = new Set<HardRule>();
  if (decision.userOnly || decision.reason === APPROVE_GUARD) rules.add("self-approve");
  if (FOREIGN_RECORD_REASON.test(decision.reason)) rules.add("foreign-classification-record");
  for (const [pattern, rule] of REASON_RULES) if (pattern.test(decision.reason)) rules.add(rule);
  requestRules(request, rules, scratchRoots);
  if (decision.category === "sensitive" && !rules.size) rules.add("protected");
  return [...rules];
}

/** The first hard rule a decision that needs a person falls under, or undefined. */
export function hardRule(
  request: Request,
  decision: Decision,
  scratchRoots: string[] = [],
): HardRule | undefined {
  if (decision.decision !== "human") return undefined;
  return hardRules(request, decision, scratchRoots)[0];
}

/**
 * `az rest` and `az devops invoke` send a GET unless a method says otherwise: with no method, or
 * `GET`/`HEAD`, they read.
 */
function cloudGet(args: string[]): boolean {
  const generic =
    (args[0] === "rest" ? 1 : 0) || (args[0] === "devops" && args[1] === "invoke" ? 2 : 0);
  if (!generic) return false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    const named = /^(?:--method|-m|--http-method)$/.test(arg)
      ? args[i + 1]
      : /^(?:--method|--http-method)=/.test(arg)
        ? arg.slice(arg.indexOf("=") + 1)
        : undefined;
    if (named !== undefined && !/^(?:get|head)$/i.test(named)) return false;
  }
  return true;
}

const LOOPBACK = /^(?:localhost|127(?:\.\d+){3}|\[?::1\]?|0\.0\.0\.0)(?::\d+)?$/i;
/**
 * Whether the request goes only to an explicit loopback host: at least one target names
 * `localhost`, `127.x.x.x` or `::1`, and nothing else looks like a target. A bare host, a
 * variable, or no recognizable URL at all is not loopback, so a write to it is a floor item.
 * Neither is a request that reads more targets from a file (curl `-K`/`--config`, wget
 * `-i`/`--input-file`, `-e`/`--execute`, `--config`).
 */
function loopbackOnly(name: string, args: string[]): boolean {
  const fromFile =
    name === "curl"
      ? /^--config(?:=|$)|^-[a-zA-Z]*K/
      : name === "wget"
        ? /^--(?:input-file|execute|config)(?:=|$)|^-[a-zA-Z]*[ie]/
        : undefined;
  if (fromFile && args.some((arg) => fromFile.test(arg))) return false;
  const targets = args.filter(
    (arg) => !arg.startsWith("-") && /^(?:https?:\/\/)?[\w.[\]:-]+(?::\d+)?(?:[/?#]|$)/i.test(arg),
  );
  const hosts = targets.map(
    (arg) => /^(?:https?:\/\/)?([^/?#\s]+)/i.exec(arg)?.[1]?.replace(/^[^@]*@/, "") ?? "",
  );
  const loopback = hosts.filter((host) => LOOPBACK.test(host));
  const urls = args.filter((arg) => /^[a-z][\w+.-]*:\/\//i.test(arg) || /\$/.test(arg));
  return (
    loopback.length > 0 &&
    urls.every((url) =>
      LOOPBACK.test(/^[a-z][\w+.-]*:\/\/([^/?#\s]+)/i.exec(url)?.[1]?.replace(/^[^@]*@/, "") ?? ""),
    )
  );
}
/**
 * An HTTP client sending anything but GET or HEAD to a host that is not loopback: curl (`-X`,
 * `--request`, data or form options imply POST, `-T` a PUT, `-G` forces GET), wget (`--method`,
 * `--post-*`, `--body-*`), httpie (`http`/`https` with a write method or data items), and
 * PowerShell's `Invoke-RestMethod`/`Invoke-WebRequest` (`-Method`, `-Body`).
 */
function httpWrite(name: string, args: string[]): boolean {
  const lower = name.toLowerCase();
  let method: string | undefined;
  let body = false;
  if (name === "curl") {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i] as string;
      if (arg === "-X" || arg === "--request") method = args[++i];
      else if (/^-X./.test(arg)) method = arg.slice(2);
      else if (arg.startsWith("--request=")) method = arg.slice(10);
      else if (
        /^(?:-d|-F|--data|--data-\w+|--json|--form|--form-string)(?:=|$)/.test(arg) ||
        /^-[dF]./.test(arg)
      )
        body = true;
      else if (arg === "-T" || arg.startsWith("--upload-file")) method = method ?? "PUT";
      else if (arg === "-G" || arg === "--get") method = "GET";
    }
  } else if (name === "wget") {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i] as string;
      if (arg === "--method") method = args[++i];
      else if (arg.startsWith("--method=")) method = arg.slice(9);
      else if (/^--(?:post|body)-(?:data|file)/.test(arg)) body = true;
    }
  } else if (name === "http" || name === "https" || name === "xh") {
    const positional = args.filter((arg) => !arg.startsWith("-"));
    if (/^[A-Z]+$/.test(positional[0] ?? "")) method = positional[0];
    else if (
      positional
        .slice(1)
        .some((item) => /^[^=:@]+(?::=|==?|@)/.test(item) && !/^[^=]+==/.test(item))
    )
      body = true;
  } else if (["invoke-restmethod", "invoke-webrequest", "irm", "iwr"].includes(lower)) {
    for (let i = 0; i < args.length; i++) {
      const arg = (args[i] as string).toLowerCase();
      if (arg === "-method") method = args[++i];
      else if (arg === "-body" || arg === "-infile") body = true;
    }
  } else return false;
  const effective = (method ?? (body ? "POST" : "GET")).toUpperCase();
  return !["GET", "HEAD", "OPTIONS"].includes(effective) && !loopbackOnly(name, args);
}
