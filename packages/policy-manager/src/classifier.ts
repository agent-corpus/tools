import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATEGORIES, type Category, type Request } from "./types.js";

/** The JSON schema every classifier CLI is given for its answer. */
export const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    category: { type: "string", enum: [...CATEGORIES] },
    confidence: { type: "number" },
    recoverable: { type: "boolean" },
    rationale: { type: "string" },
  },
  required: ["category", "confidence", "recoverable", "rationale"],
  additionalProperties: false,
} as const;

/**
 * The AI classifier: the harness's own CLI, run as a child process with the user's own login, no
 * tools, no hooks, no session persistence and no project context. Nothing here approves: it
 * returns a verdict, or a failure that sends the request to a person.
 */

/** Per-harness classifier settings from the profile's `classifier` key. */
export interface ClassifierConfig {
  /** `false` turns the classifier off: everything the engine escalates goes to a person. */
  enabled: boolean;
  claude: { model: string };
  codex: { model: string };
  copilot: { model: string };
}

export const DEFAULT_CLASSIFIER: ClassifierConfig = {
  enabled: true,
  claude: { model: "haiku" },
  codex: { model: "gpt-6-luna" },
  copilot: { model: "auto" },
};

/** How long each CLI may take, in milliseconds. */
export const CLASSIFIER_TIMEOUT_MS: Record<Request["harness"], number> = {
  claude: 15_000,
  codex: 15_000,
  copilot: 20_000,
};

/** Set in the classifier's environment, so a policy hook that still runs there refuses tools. */
export const CLASSIFIER_ENV = "AGENT_CORPUS_POLICY_CLASSIFIER";

export interface Verdict {
  category: Category;
  confidence: number;
  recoverable: boolean;
  rationale: string;
}

export type FailureReason =
  | "disabled"
  | "too-long"
  | "missing"
  | "not-logged-in"
  | "exit"
  | "timeout"
  | "bad-json"
  | "schema";

export type ClassifierResult =
  | { ok: true; verdict: Verdict; cli: Request["harness"]; model: string; latencyMs: number }
  | {
      ok: false;
      reason: FailureReason;
      cli: Request["harness"];
      model: string;
      latencyMs: number;
    };

export interface RunResult {
  /** Exit code; null when killed. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** `ENOENT` when the program is not installed; `timeout` when it was killed for time. */
  error?: "ENOENT" | "timeout" | "other";
}
export interface RunOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}
/** Runs a program without a shell. Replaceable in tests. */
export type Runner = (file: string, args: string[], options: RunOptions) => Promise<RunResult>;

/** `execFile`, no shell, standard input closed, output capped, killed at the timeout. */
export const execRunner: Runner = (file, args, options) =>
  new Promise((resolve) => {
    const child = execFile(
      file,
      args,
      {
        cwd: options.cwd,
        env: options.env,
        timeout: options.timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        const failure = error as
          | (NodeJS.ErrnoException & { killed?: boolean; signal?: string | null })
          | null;
        resolve({
          code: failure ? (typeof failure.code === "number" ? failure.code : null) : 0,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          ...(failure
            ? {
                error:
                  failure.code === "ENOENT"
                    ? "ENOENT"
                    : failure.killed || failure.signal
                      ? "timeout"
                      : typeof failure.code === "number"
                        ? undefined
                        : "other",
              }
            : {}),
        });
      },
    );
    child.stdin?.end();
  });

const LOGIN = /log ?in|logged|auth|credential|api key|unauthori[sz]ed|\b401\b|forbidden|\b403\b/i;

/** A verdict with exactly the schema's shape, or undefined. */
export function parseVerdict(value: unknown): Verdict | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (
    !(CATEGORIES as readonly string[]).includes(v.category as string) ||
    typeof v.confidence !== "number" ||
    !Number.isFinite(v.confidence) ||
    v.confidence < 0 ||
    v.confidence > 1 ||
    typeof v.recoverable !== "boolean" ||
    typeof v.rationale !== "string"
  )
    return undefined;
  return {
    category: v.category as Category,
    confidence: v.confidence,
    recoverable: v.recoverable,
    rationale: v.rationale.slice(0, 1000),
  };
}

class Failure extends Error {
  constructor(readonly reason: FailureReason) {
    super(reason);
  }
}

function json(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Failure("bad-json");
  }
}

function failed(run: RunResult): void {
  if (run.error === "ENOENT") throw new Failure("missing");
  if (run.error === "timeout") throw new Failure("timeout");
  if (run.code !== 0) {
    // Structured output (a Claude result, Copilot events) holds usage fields and model text that
    // can mention "auth"; only an error message decides that the CLI is not logged in.
    let text = run.stdout;
    try {
      const value = JSON.parse(run.stdout.split("\n").find((line) => line.trim()) ?? "");
      text =
        value &&
        typeof value === "object" &&
        typeof value.result === "string" &&
        value.is_error === true
          ? value.result
          : "";
    } catch {
      /* plain text output */
    }
    throw new Failure(LOGIN.test(`${run.stderr}\n${text}`) ? "not-logged-in" : "exit");
  }
}

interface Invocation {
  file: string;
  args: string[];
  env: Record<string, string>;
  /** Reads the verdict from the finished run. */
  parse: (run: RunResult) => unknown;
}

/**
 * The exact command line for each harness. Claude: `-p` with a JSON schema; the answer is in
 * `.structured_output`. Codex: `exec` with an output schema and an output file, in an empty
 * directory. Copilot: `-p` with JSON events, its home moved to a private directory whose settings
 * turn every hook off; authentication still comes from the user's stored login (the system
 * keychain, or COPILOT_GITHUB_TOKEN/GH_TOKEN/GITHUB_TOKEN), which lives outside that directory.
 */
function invocation(
  cli: Request["harness"],
  model: string,
  prompt: string,
  dir: string,
  empty: string,
): Invocation {
  const schema = JSON.stringify(VERDICT_SCHEMA);
  if (cli === "claude")
    return {
      file: "claude",
      args: [
        "-p",
        "--model",
        model,
        "--tools",
        "",
        "--setting-sources",
        "",
        "--settings",
        JSON.stringify({ disableAllHooks: true, autoMemoryEnabled: false }),
        "--no-session-persistence",
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--permission-mode",
        "dontAsk",
        // The schema answer is itself a tool call; a model that first reaches for a tool it does
        // not have needs a few turns to return it (at 2, some runs stopped at the turn limit).
        "--max-turns",
        "5",
        "--output-format",
        "json",
        "--json-schema",
        schema,
        prompt,
      ],
      env: {},
      parse: (run) => {
        const out = json(run.stdout) as Record<string, unknown> | null;
        if (!out || typeof out !== "object") throw new Failure("bad-json");
        if (out.is_error === true)
          throw new Failure(LOGIN.test(String(out.result ?? "")) ? "not-logged-in" : "exit");
        if (out.structured_output === undefined) throw new Failure("schema");
        return out.structured_output;
      },
    };
  if (cli === "codex") {
    const schemaFile = join(dir, "schema.json");
    const outFile = join(dir, "out.json");
    writeFileSync(schemaFile, schema, { mode: 0o600 });
    return {
      file: "codex",
      args: [
        "exec",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--disable",
        "hooks",
        "--skip-git-repo-check",
        "-s",
        "read-only",
        "-c",
        'approval_policy="never"',
        "-c",
        'model_reasoning_effort="low"',
        "-m",
        model,
        "-C",
        empty,
        "--output-schema",
        schemaFile,
        "-o",
        outFile,
        prompt,
      ],
      env: {},
      parse: () => {
        let text: string;
        try {
          text = readFileSync(outFile, "utf8");
        } catch {
          throw new Failure("bad-json");
        }
        return json(text);
      },
    };
  }
  const home = join(dir, "copilot-home");
  mkdirSync(home, { mode: 0o700 });
  writeFileSync(join(home, "settings.json"), JSON.stringify({ disableAllHooks: true }), {
    mode: 0o600,
  });
  return {
    file: "copilot",
    args: [
      "-p",
      prompt,
      "--model",
      model,
      "--available-tools",
      "",
      "--no-custom-instructions",
      "--disable-builtin-mcps",
      "--no-ask-user",
      "--no-auto-update",
      "--disable-client-telemetry",
      "--output-format",
      "json",
    ],
    env: { COPILOT_HOME: home },
    parse: (run) => {
      const events = run.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line) as { type?: string; data?: Record<string, unknown> };
          } catch {
            return {};
          }
        });
      const error = events.find((event) => event.type === "session.error");
      if (error)
        throw new Failure(LOGIN.test(String(error.data?.message ?? "")) ? "not-logged-in" : "exit");
      const message = events
        .filter((event) => event.type === "assistant.message")
        .map((event) => event.data?.content)
        .filter((content): content is string => typeof content === "string")
        .at(-1);
      if (message === undefined) throw new Failure("bad-json");
      const start = message.indexOf("{");
      const end = message.lastIndexOf("}");
      if (start < 0 || end < start) throw new Failure("bad-json");
      return json(message.slice(start, end + 1));
    },
  };
}

export interface ClassifyOptions {
  runner?: Runner;
  timeoutMs?: number;
}

/**
 * Classifies one prompt with `cli`'s own CLI. Every failure (not installed, not logged in, a
 * nonzero exit, a timeout, output that is not JSON or not the schema) is a result with `ok: false`,
 * never an exception and never an approval.
 */
export async function classifyWithCli(
  cli: Request["harness"],
  prompt: string | undefined,
  config: ClassifierConfig = DEFAULT_CLASSIFIER,
  options: ClassifyOptions = {},
): Promise<ClassifierResult> {
  const model = config[cli].model;
  const started = Date.now();
  const fail = (reason: FailureReason): ClassifierResult => ({
    ok: false,
    reason,
    cli,
    model,
    latencyMs: Date.now() - started,
  });
  if (!config.enabled) return fail("disabled");
  if (prompt === undefined) return fail("too-long");
  let dir: string | undefined;
  try {
    dir = mkdtempSync(join(tmpdir(), "acp-classifier-"));
    const empty = join(dir, "empty");
    mkdirSync(empty, { mode: 0o700 });
    const call = invocation(cli, model, prompt, dir, empty);
    const run = await (options.runner ?? execRunner)(call.file, call.args, {
      cwd: empty,
      env: { ...process.env, ...call.env, [CLASSIFIER_ENV]: "1" },
      timeoutMs: options.timeoutMs ?? CLASSIFIER_TIMEOUT_MS[cli],
    });
    failed(run);
    const verdict = parseVerdict(call.parse(run));
    if (!verdict) return fail("schema");
    return { ok: true, verdict, cli, model, latencyMs: Date.now() - started };
  } catch (error) {
    return fail(error instanceof Failure ? error.reason : "exit");
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;

/** Parses the profile's `classifier` key. Throws a message for anything invalid. */
export function parseClassifierConfig(raw: unknown): ClassifierConfig {
  if (raw === undefined) return structuredClone(DEFAULT_CLASSIFIER);
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("classifier must be an object");
  const value = raw as Record<string, unknown>;
  const result = structuredClone(DEFAULT_CLASSIFIER);
  for (const [key, entry] of Object.entries(value)) {
    if (key === "enabled") {
      if (typeof entry !== "boolean") throw new Error("classifier.enabled must be true or false");
      result.enabled = entry;
      continue;
    }
    if (key !== "claude" && key !== "codex" && key !== "copilot")
      throw new Error(`classifier has an unknown key: ${key}`);
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new Error(`classifier.${key} must be an object`);
    for (const [field, model] of Object.entries(entry as Record<string, unknown>)) {
      if (field !== "model") throw new Error(`classifier.${key} has an unknown key: ${field}`);
      if (typeof model !== "string" || !MODEL.test(model))
        throw new Error(`classifier.${key}.model must be a model name`);
      result[key].model = model;
    }
  }
  return result;
}
