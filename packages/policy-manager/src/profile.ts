import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { type ClassifierConfig, DEFAULT_CLASSIFIER, parseClassifierConfig } from "./classifier.js";
import { type CredentialUse, DEFAULT_CREDENTIAL_USES, parseCredentialUses } from "./creduse.js";
import { canonical, git } from "./evidence.js";
import { type CredentialHelper, HelperError, parseCredentialHelpers } from "./helpers.js";
import { TOOL_NAME } from "./tools.js";

/**
 * A profile is policy *data*. The engine's checks (protected paths, secret retrieval, verified
 * effects) are code and cannot be relaxed by a profile; a profile only chooses how much of the
 * remaining space is approved automatically. Without a profile the engine is strict.
 */
export interface Profile {
  mode: "strict" | "permissive";
  /** Cloud operations outside the read catalog: `human` (default) or `allow` non-destructive ones. */
  cloudWrites: "human" | "allow";
  /** Extra simple commands that always need a human, matched against the joined argv. */
  humanPatterns: RegExp[];
  /** Absolute directories where permissive mode may write besides linked feature worktrees. */
  scratchRoots: string[];
  /**
   * MCP tools that approve without a prompt: exact `mcp__<server>__<tool>` names, or a name whose
   * last segment ends in `*` (`mcp__github__get_*`). Unlisted MCP tools are left to the harness.
   */
  mcpReadOnly: string[];
  /**
   * Harness tools, per harness, that are not approved by default and keep the classification
   * path. Every other harness tool that is not a shell, file, patch or MCP tool is approved.
   */
  toolsDeny: { claude: string[]; codex: string[]; copilot: string[] };
  /** Scripts that may read a credential for one narrow job, as committed on the default branch. */
  credentialHelpers: CredentialHelper[];
  /**
   * Credentials a command may read only to hand straight to one consumer (`credentialUses`, plus
   * the generic defaults unless `credentialUseDefaults` is false). Permissive profiles only.
   */
  credentialUses: CredentialUse[];
  /** The AI classifier each harness runs for what the engine escalates: CLI models and a kill switch. */
  classifier: ClassifierConfig;
  /** SHA-256 of the file the profile came from, for the audit log. */
  digest?: string;
}

export const strictProfile: Profile = {
  mode: "strict",
  cloudWrites: "human",
  humanPatterns: [],
  scratchRoots: [],
  mcpReadOnly: [],
  toolsDeny: { claude: [], codex: [], copilot: [] },
  credentialHelpers: [],
  credentialUses: [],
  classifier: DEFAULT_CLASSIFIER,
};

export const MAX_MCP_READ_ONLY = 200;
/**
 * `mcp__<server>__<tool>` where neither segment contains `__` (so the split is unambiguous); `*`
 * only as the suffix of a non-empty tool segment.
 */
const MCP_ENTRY =
  /^mcp__[A-Za-z0-9.-]+(?:_[A-Za-z0-9.-]+)*__[A-Za-z0-9.-]+(?:_[A-Za-z0-9.-]+)*(?:_?\*)?$/;

/** Whether `tool` is listed in the profile's `mcpReadOnly`. */
export function mcpReadOnly(profile: Profile, tool: string): boolean {
  if (!tool.startsWith("mcp__")) return false;
  return profile.mcpReadOnly.some((entry) => {
    if (!entry.endsWith("*")) return tool === entry;
    // The whole tool segment, not just the wildcard's part, must be free of `__`.
    const server = entry.slice(0, entry.lastIndexOf("__") + 2);
    return tool.startsWith(entry.slice(0, -1)) && !tool.slice(server.length).includes("__");
  });
}

export const MAX_TOOLS_DENY = 100;
function parseToolsDeny(raw: unknown): Profile["toolsDeny"] {
  const result: Profile["toolsDeny"] = { claude: [], codex: [], copilot: [] };
  if (raw === undefined) return result;
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new ProfileError("toolsDeny must be an object of per-harness tool name lists");
  for (const [harness, names] of Object.entries(raw)) {
    if (!(harness in result))
      throw new ProfileError(`toolsDeny has an unknown harness: ${harness}`);
    if (
      !Array.isArray(names) ||
      names.length > MAX_TOOLS_DENY ||
      names.some((name) => typeof name !== "string" || !TOOL_NAME.test(name))
    )
      throw new ProfileError(`toolsDeny.${harness} must list at most ${MAX_TOOLS_DENY} tool names`);
    result[harness as keyof typeof result] = [...new Set(names as string[])];
  }
  return result;
}

let profilePathMemo: { key: string; path: string } | undefined;
/** The default profile path (memoized on the variables it depends on: it is asked per word). */
export function defaultProfilePath(): string {
  const key = `${process.env.XDG_CONFIG_HOME}|${process.env.HOME}|${process.env.USERPROFILE}`;
  if (profilePathMemo?.key === key) return profilePathMemo.path;
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const path = join(base, "agent-corpus", "policy-manager", "policy.json");
  profilePathMemo = { key, path };
  return path;
}

export class ProfileError extends Error {}

function verifyLocation(path: string): void {
  if (!isAbsolute(path)) throw new ProfileError("Profile path must be absolute");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new ProfileError("Profile must be a regular file");
  // POSIX ownership and mode bits do not exist on Windows. There the trust boundary is the NTFS
  // ACL of the user's profile directory, which Node cannot inspect, so only the file type,
  // symlink and Git-checkout checks apply.
  if (process.platform !== "win32") {
    if (process.getuid && stat.uid !== process.getuid())
      throw new ProfileError("Profile must be owned by the current user");
    if ((stat.mode & 0o022) !== 0)
      throw new ProfileError("Profile must not be group or world writable");
  }
  try {
    git(dirname(canonical(path)), ["rev-parse", "--show-toplevel"]);
  } catch {
    return; // not inside a Git checkout: an agent cannot rewrite it from a worktree
  }
  throw new ProfileError("Profile must live outside Git checkouts");
}

export function parseProfile(text: string): Profile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ProfileError("Profile is not valid JSON");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new ProfileError("Profile must be an object");
  const value = raw as Record<string, unknown>;
  const allowed = new Set([
    "version",
    "mode",
    "cloudWrites",
    "humanPatterns",
    "scratchRoots",
    "mcpReadOnly",
    "toolsDeny",
    "credentialHelpers",
    "credentialUses",
    "credentialUseDefaults",
    "classifier",
    "description",
  ]);
  for (const key of Object.keys(value))
    if (!allowed.has(key)) throw new ProfileError(`Unknown profile key: ${key}`);
  if (value.version !== 1) throw new ProfileError("Unsupported profile version");
  if (value.mode !== "strict" && value.mode !== "permissive")
    throw new ProfileError("mode must be strict or permissive");
  const cloudWrites = value.cloudWrites ?? "human";
  if (cloudWrites !== "human" && cloudWrites !== "allow")
    throw new ProfileError("cloudWrites must be human or allow");
  const patterns = value.humanPatterns ?? [];
  const roots = value.scratchRoots ?? [];
  if (!Array.isArray(patterns) || patterns.some((p) => typeof p !== "string" || p.length > 300))
    throw new ProfileError("humanPatterns must be short strings");
  if (!Array.isArray(roots) || roots.some((r) => typeof r !== "string" || !isAbsolute(r)))
    throw new ProfileError("scratchRoots must be absolute paths");
  const mcp = value.mcpReadOnly ?? [];
  if (
    !Array.isArray(mcp) ||
    mcp.length > MAX_MCP_READ_ONLY ||
    mcp.some((entry) => typeof entry !== "string" || entry.length > 128 || !MCP_ENTRY.test(entry))
  )
    throw new ProfileError(
      `mcpReadOnly must list at most ${MAX_MCP_READ_ONLY} names like mcp__server__tool, optionally ending in *`,
    );
  const toolsDeny = parseToolsDeny(value.toolsDeny);
  let classifier: ClassifierConfig;
  try {
    classifier = parseClassifierConfig(value.classifier);
  } catch (error) {
    throw new ProfileError((error as Error).message);
  }
  let credentialHelpers: CredentialHelper[];
  try {
    credentialHelpers = parseCredentialHelpers(value.credentialHelpers);
  } catch (error) {
    if (error instanceof HelperError) throw new ProfileError(error.message);
    throw error;
  }
  let credentialUses: CredentialUse[];
  try {
    credentialUses = parseCredentialUses(value.credentialUses);
  } catch (error) {
    if (error instanceof HelperError) throw new ProfileError(error.message);
    throw error;
  }
  const useDefaults = value.credentialUseDefaults ?? true;
  if (typeof useDefaults !== "boolean")
    throw new ProfileError("credentialUseDefaults must be true or false");
  let humanPatterns: RegExp[];
  try {
    humanPatterns = (patterns as string[]).map((p) => new RegExp(p));
  } catch {
    throw new ProfileError("humanPatterns contains an invalid expression");
  }
  const scratchRoots = new Set<string>();
  for (const root of roots as string[]) {
    try {
      scratchRoots.add(canonical(root));
    } catch {
      /* a missing scratch directory simply grants nothing */
    }
  }
  return {
    mode: value.mode,
    cloudWrites,
    humanPatterns,
    scratchRoots: value.mode === "permissive" ? [...scratchRoots] : [],
    mcpReadOnly: [...new Set(mcp as string[])],
    toolsDeny,
    credentialHelpers: value.mode === "permissive" ? credentialHelpers : [],
    credentialUses:
      value.mode === "permissive"
        ? [...(useDefaults ? DEFAULT_CREDENTIAL_USES : []), ...credentialUses]
        : [],
    classifier,
    digest: createHash("sha256").update(text).digest("hex"),
  };
}

/** Loads the installed profile. A missing file means strict; an invalid one is an error. */
export function loadProfile(path = defaultProfilePath()): Profile {
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return strictProfile;
    throw new ProfileError("Profile is not readable");
  }
  verifyLocation(path);
  return parseProfile(readFileSync(path, "utf8"));
}
