import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { canonical, git } from "./evidence.js";

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
  /** SHA-256 of the file the profile came from, for the audit log. */
  digest?: string;
}

export const strictProfile: Profile = {
  mode: "strict",
  cloudWrites: "human",
  humanPatterns: [],
  scratchRoots: [],
  mcpReadOnly: [],
};

export const MAX_MCP_READ_ONLY = 200;
/** Server segment literal; `*` only as the suffix of a non-empty tool segment. */
const MCP_ENTRY = /^mcp__[A-Za-z0-9_.-]+__[A-Za-z0-9_.-]+\*?$/;

/** Whether `tool` is listed in the profile's `mcpReadOnly`. */
export function mcpReadOnly(profile: Profile, tool: string): boolean {
  if (!tool.startsWith("mcp__")) return false;
  return profile.mcpReadOnly.some((entry) =>
    entry.endsWith("*")
      ? tool.startsWith(entry.slice(0, -1)) && !tool.slice(entry.length - 1).includes("__")
      : tool === entry,
  );
}

export function defaultProfilePath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "agent-corpus", "policy-manager", "policy.json");
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
