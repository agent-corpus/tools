import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { hookResponse } from "../src/adapters.js";
import { hardRule, hardRules } from "../src/hard.js";
import { evaluate } from "../src/policy.js";
import { parseProfile, strictProfile } from "../src/profile.js";
import { PolicySession } from "../src/session.js";
import type { Request } from "../src/types.js";

// Hard human items: credentials, protected configuration, unrecoverable loss and humanPatterns.
// They are never sent to the classifier, and no classification approves them.
const permissive = parseProfile(JSON.stringify({ version: 1, mode: "permissive" }));
let root: string, repo: string, worktree: string, other: string;
let counter = 0;
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    stdio: "ignore",
  });

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "hard-test-")));
  repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-b", "main");
  git(repo, "commit", "--allow-empty", "-m", "init");
  worktree = join(repo, ".worktrees", "feat");
  other = join(repo, ".worktrees", "other");
  git(repo, "worktree", "add", "-b", "feat/a", worktree);
  git(repo, "worktree", "add", "-b", "feat/b", other);
  // A branch with a commit no remote has: deleting it loses work.
  git(repo, "branch", "unmerged");
  git(repo, "worktree", "add", join(root, "u"), "unmerged");
  git(join(root, "u"), "commit", "--allow-empty", "-m", "work");
  git(repo, "worktree", "remove", join(root, "u"));
  // Repository aliases; linked worktrees share them.
  git(repo, "config", "alias.pf", "push --force");
  git(repo, "config", "alias.cl", "clean -fd");
  git(repo, "config", "alias.shpf", "!git push -f origin feat/a");
  git(repo, "config", "alias.st", "status");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function session(profile = permissive, harness: Request["harness"] = "claude") {
  const directory = join(root, `s${counter++}`);
  mkdirSync(directory, { mode: 0o700 });
  let runs = 0;
  const s = new PolicySession(directory, harness, "s1", profile, undefined, {
    classify: async (cli) => {
      runs++;
      return {
        ok: true,
        cli,
        model: "stub",
        latencyMs: 1,
        verdict: {
          category: "worktree-write",
          confidence: 0.99,
          recoverable: true,
          rationale: "x",
        },
      };
    },
    nativeRules: () => undefined,
  });
  return { directory, s, runs: () => runs };
}
const shell = (command: string, cwd = worktree): Request => ({
  sessionId: "s1",
  harness: "claude",
  cwd,
  tool: "Bash",
  input: { command },
});
const write = (file_path: string, cwd = worktree): Request => ({
  sessionId: "s1",
  harness: "claude",
  cwd,
  tool: "Write",
  input: { file_path, content: "x" },
});

describe("hard items ask a person in every harness, without the classifier", () => {
  const settings = (...parts: string[]) => join(homedir(), ...parts);
  const asks: Array<[string, string, () => Request]> = [
    ["force-push", "--force", () => shell("git push --force origin feat/a")],
    ["force-push", "--mirror", () => shell("git push --mirror origin")],
    ["force-push", "a + refspec", () => shell("git push origin +feat/a")],
    ["force-push", "an unparsed form", () => shell("git push -f origin {feat/a,x}")],
    ["delete-unmerged-branch", "git branch -D", () => shell("git branch -D unmerged", repo)],
    [
      "delete-unmerged-branch",
      "a remote deletion",
      () => shell("git push origin --delete unmerged", repo),
    ],
    [
      "remove-worktree-force",
      "worktree remove --force",
      () => shell(`git worktree remove --force ${other}`, repo),
    ],
    ["git-clean", "git clean -fd", () => shell("git clean -fd")],
    [
      "harness-settings",
      "~/.claude/settings.json",
      () => write(settings(".claude", "settings.json")),
    ],
    [
      "harness-settings",
      "~/.claude/settings.local.json",
      () => write(settings(".claude", "settings.local.json")),
    ],
    ["harness-settings", "~/.codex/hooks.json", () => write(settings(".codex", "hooks.json"))],
    ["harness-settings", "~/.codex/config.toml", () => write(settings(".codex", "config.toml"))],
    [
      "harness-settings",
      "~/.codex/rules",
      () => write(settings(".codex", "rules", "default.rules")),
    ],
    [
      "harness-settings",
      "~/.copilot/hooks",
      () => write(settings(".copilot", "hooks", "policy-manager.json")),
    ],
    [
      "harness-settings",
      "a shell redirect",
      () => shell("echo '{}' > ~/.claude/settings.json", repo),
    ],
    ["harness-settings", "~/.claude/hooks/x.sh", () => write(settings(".claude", "hooks", "x.sh"))],
    ["harness-settings", "~/.claude.json", () => write(settings(".claude.json"))],
    ["harness-settings", "~/.codex/hooks/x.sh", () => write(settings(".codex", "hooks", "x.sh"))],
    [
      "harness-settings",
      "~/.copilot/config.json",
      () => write(settings(".copilot", "config.json")),
    ],
    [
      "policy-profile",
      "the profile path",
      () => write(join(homedir(), ".config", "agent-corpus", "policy-manager", "policy.json")),
    ],
    ["credential-read", "a credential file", () => shell("cat ~/.aws/credentials")],
  ];
  test.each(asks)("%s (%s)", async (rule, _, make) => {
    const r = make();
    for (const harness of ["claude", "copilot", "codex"] as const) {
      const { s, runs } = session(permissive, harness);
      const d = await s.decide({ ...r, harness }, "PreToolUse");
      expect(d.decision).toBe("human");
      expect(d.hard).toBeDefined();
      if (d.hard !== "protected") expect(d.hard).toBe(rule);
      expect(runs()).toBe(0);
      const out = JSON.stringify(hookResponse(harness, "PreToolUse", d));
      if (harness === "codex") {
        expect(out).toContain('"permissionDecision":"deny"');
        expect(out).toContain("approve --last");
      } else expect(out).toContain('"ask"');
      expect(hookResponse(harness, "PermissionRequest", d)).toEqual({});
      expect(s.latestHumanDecision()?.requestHash).toBe(d.requestHash);
    }
  });

  test("protected repository paths are hard too", async () => {
    for (const path of [join(worktree, ".github", "hooks", "x.json"), join(repo, "AGENTS.md")]) {
      const { s, runs } = session();
      const d = await s.decide(write(path, repo), "PreToolUse");
      expect(d).toMatchObject({ decision: "human" });
      expect(d.hard).toBeDefined();
      expect(runs()).toBe(0);
    }
  });

  test("humanPatterns are hard", async () => {
    const profile = parseProfile(
      JSON.stringify({ version: 1, mode: "permissive", humanPatterns: ["^terraform apply"] }),
    );
    const { s, runs } = session(profile);
    const d = await s.decide(shell("terraform apply"), "PreToolUse");
    expect(d).toMatchObject({ decision: "human", hard: "human-patterns" });
    expect(runs()).toBe(0);
  });

  test("approve --last and --session keep working for a hard item", () => {
    const { s } = session();
    const r = shell("git push --force origin feat/a");
    const d = s.review(r, undefined, "PreToolUse");
    expect(s.latestHumanDecision()?.requestHash).toBe(d.requestHash);
    expect(s.grant(d.requestHash, true).granted).toBe(true);
    for (const phase of ["PreToolUse", "PermissionRequest"])
      expect(s.review(r, undefined, phase).decision).toBe("approve");
    expect(s.review(r, undefined, "PreToolUse").decision).toBe("human");
  });

  test("an agent running approve itself is hard", () => {
    const { s } = session();
    const d = s.review(shell("policy-manager approve --last"), undefined, "PreToolUse");
    expect(d).toMatchObject({ decision: "human", hard: "self-approve", userOnly: true });
  });
});

describe("quoted, indirect and nested forms do not escape the hard list", () => {
  const forms: Array<[string, string]> = [
    ["force-push", "'git' push --force origin x"],
    ["force-push", "git 'push' --force origin x"],
    ["force-push", "git push '--force' origin x"],
    ["force-push", 'git push --for"ce" origin x'],
    ["force-push", "\\git push -f origin x"],
    ["force-push", "GIT=git; $GIT push -f origin x"],
    ["force-push", "x=push; git $x --force origin"],
    ["force-push", 'x="push --force"; git $x origin'],
    ["force-push", "git -c alias.p=push p --force origin"],
    ["force-push", "git $(echo push) --force origin"],
    ["force-push", "git `echo push` --force origin"],
    ["force-push", 'git "$(echo push)" --force origin'],
    ["force-push", "GIT_EXEC_PATH=/tmp/x git push origin x --force"],
    ["force-push", "git --exec-path=/tmp/x push -f origin x"],
    ["force-push", 'eval git push "--for""ce" origin x'],
    ["force-push", "eval 'git pu''sh --force origin x'"],
    ["force-push", 'X=--force; eval "git push $X origin x"'],
    ["force-push", "bash -c 'git push --force origin x'"],
    ["force-push", 'sh -c "git push -f origin x" && echo done'],
    ["force-push", "echo ok; (cd /tmp && git push --force origin x)"],
    ["force-push", "env -i git push --mirror origin"],
    ["force-push", "sudo -u me git push origin +x"],
    ["delete-unmerged-branch", "git update-ref -d refs/heads/x"],
    ["delete-unmerged-branch", "git branch -D ${BR}"],
    ["delete-unmerged-branch", "git 'branch' '-D' x"],
    ["delete-unmerged-branch", "git push origin ':x'"],
    ["git-clean", "git 'clean' -fd"],
    ["git-clean", "git clean -fd {a,b}"],
    ["remove-worktree-force", "git worktree remove '--force' ../x"],
    ["harness-settings", "echo x > ~/.claude/'settings.json'"],
    ["harness-settings", "cd ~/.claude && echo x > settings.json"],
    ["harness-settings", 'cd "$HOME/.claude" && echo x > settings.json'],
    ["harness-settings", "cp /tmp/a ~/.codex/'config.toml'"],
    ["harness-settings", "tee ~/.copilot/hooks/x.json < /tmp/a"],
    ["harness-settings", "cd ~ && mv /tmp/a .claude.json"],
    ["policy-profile", "cd ~/.config/agent-corpus/policy-manager && echo '{}' > policy.json"],
    // Commands the scanner reads as data but that still run: the plain-text reading catches them.
    ["force-push", "echo 'git push -f origin x' | sh"],
    ["force-push", "printf '%s\\n' 'git push --force origin x' | bash"],
    ["force-push", "bash <(echo 'git push -f origin x')"],
    ["force-push", "source <(echo 'git push -f origin x')"],
    ["force-push", "find . -exec git push -f origin x ;"],
    ["force-push", `node -e "require('child_process').execSync('git push -f origin x')"`],
    ["force-push", `python3 -c "import os; os.system('git push -f origin x')"`],
    ["force-push", "alias gp='git push --force'; gp origin x"],
    ["force-push", "bash <<< 'git push --force origin x'"],
    ["git-clean", "echo 'git clean -fdx' | sh"],
    ["harness-settings", `python3 -c "open('/x/.claude/settings.json','w')"`],
    // Push options known only at run time, or a configured forced push.
    ["force-push", "git push $ARGS origin x"],
    ["force-push", "git push ${F:- -f} origin x"],
    ["force-push", "git push origin x $(echo -f)"],
    ["force-push", "git push origin $B:+main"],
    ["force-push", "F=-f; git push $F origin x"],
    ["force-push", "git -c remote.origin.push=+refs/heads/*:refs/heads/* push origin"],
    ["force-push", "git -c remote.origin.mirror=true push origin"],
  ];
  const profiles = [
    ["strict", strictProfile],
    ["permissive", permissive],
  ] as const;
  for (const [mode, profile] of profiles)
    test.each(forms)(`${mode}: %s for %s`, (rule, command) => {
      const r = shell(command, repo);
      const d = session(profile).s.review(r, undefined, "PreToolUse");
      expect(d.decision, command).toBe("human");
      expect(d.hard, command).toBeDefined();
      expect(hardRules(r, d), command).toContain(rule);
    });

  test.each([
    "git status",
    "git log --oneline -5",
    "echo $(git rev-parse HEAD)",
    "git commit -m 'force push later, then clean up'",
    "npm run build -- --force",
  ])("ordinary commands are not hard: %s", (command) => {
    for (const [, profile] of profiles) {
      const d = session(profile).s.review(shell(command), undefined, "PreToolUse");
      expect(d.hard, command).toBeUndefined();
    }
  });
});

describe("a classification never approves a hard item", () => {
  test.each([
    "git push -f origin {feat/a,x}",
    "git clean -fd {a,b}",
    "git branch -D ${BR}",
    "git push origin --delete ${BR}",
  ])("%s", async (command) => {
    const { s, runs } = session();
    const r = shell(command);
    const d = s.review(r, undefined, "PreToolUse");
    expect(d.decision).toBe("human");
    expect(d.needsClassification).toBeFalsy();
    const ai = {
      requestHash: d.requestHash,
      category: "worktree-write" as const,
      confidence: 0.99,
      recoverable: true,
    };
    // Not offered for classification, and a record for it approves nothing.
    expect(() => s.classify(ai)).toThrow();
    expect(s.review(r, ai, "PreToolUse").decision).toBe("human");
    expect(evaluate(r, ai, permissive).decision).toBe("human");
    expect((await s.decide(r, "PreToolUse")).decision).toBe("human");
    expect(runs()).toBe(0);
  });
});

test("a long run of slashes in hook input is judged in linear time", () => {
  const long = `/${"/".repeat(100_000)}x`;
  const base = { ...evaluate(shell("ls"), undefined, permissive), decision: "human" as const };
  const started = Date.now();
  hardRule(shell(`echo ${long}/ > ${long}//`), base);
  hardRule(write(`${long}/`), base);
  expect(Date.now() - started).toBeLessThan(2000);
});

describe("git aliases are judged by what they run", () => {
  const profiles = [
    ["strict", strictProfile],
    ["permissive", permissive],
  ] as const;
  for (const [mode, profile] of profiles) {
    test.each([
      ["force-push", "git pf origin feat/a"],
      ["force-push", "git 'pf' origin feat/a"],
      ["git-clean", "git cl"],
      ["force-push", "git shpf"],
    ])(`${mode}: %s through an alias: %s`, (rule, command) => {
      const d = session(profile).s.review(shell(command), undefined, "PreToolUse");
      expect(d, command).toMatchObject({ decision: "human", hard: rule });
    });

    test(`${mode}: an unknown subcommand that is not an alias is never approved`, () => {
      for (const command of ["git frobnicate-nothing --force", "git frobnicate-nothing"]) {
        const d = session(profile).s.review(shell(command), undefined, "PreToolUse");
        expect(d.decision, command).not.toBe("approve");
      }
    });
  }

  test("an ordinary alias is approved as before", () => {
    const d = session().s.review(shell("git st"), undefined, "PreToolUse");
    expect(d.decision).toBe("approve");
  });
});

describe("data text is not code", () => {
  test.each([
    "cat > notes.md <<'EOF'\nDo not run git clean -fdx or git push --force here.\nEOF",
    'gh pr create --title x --body "never git push --force or edit ~/.claude/settings.json"',
    'git commit -m "explain why git clean -fd is unsafe"',
    "printf '%s\\n' 'git push -f origin x' > doc.txt",
  ])("%s is not a hard item", (command) => {
    const d = { ...evaluate(shell("ls"), undefined, permissive), decision: "human" as const };
    expect(hardRules(shell(command), d)).toEqual([]);
  });

  test.each([
    ["git-clean", "bash <<'EOF'\ngit clean -fdx\nEOF"],
    ["force-push", "cat <<'EOF' | sh\ngit push --force origin x\nEOF"],
    ["force-push", "node <<'EOF'\nrequire('child_process').execSync('git push -f origin x')\nEOF"],
    ["force-push", "python3 - <<'EOF'\nimport os; os.system('git push -f origin x')\nEOF"],
    ["force-push", 'sh -c "git push -f origin x"'],
  ])(
    "%s: a here-document or string fed to a shell or interpreter is code (%s)",
    (rule, command) => {
      const d = { ...evaluate(shell("ls"), undefined, permissive), decision: "human" as const };
      expect(hardRules(shell(command), d)).toContain(rule);
    },
  );
});

describe("more data is not code", () => {
  const base = () => ({
    ...evaluate(shell("ls"), undefined, permissive),
    decision: "human" as const,
  });
  test.each([
    "sed -i '' 's|old|git push --force|' notes.md",
    "gh pr create --body \"$(cat <<'EOF'\nsee ~/.claude/settings.json and git clean -fd\nEOF\n)\"",
    "az rest --url https://example.com/api",
    "az rest --method get --url https://example.com/api",
    "az devops invoke --area build --resource timeline",
  ])("%s is not a hard item", (command) => {
    expect(hardRules(shell(command), base())).toEqual([]);
  });
  test.each([
    ["force-push", "sed -n 's/x/git push --force origin x/e' f"],
    ["cloud-write", "az rest --method delete --url https://example.com/api"],
    ["cloud-write", "az rest -m PUT --url https://example.com/api"],
  ])("%s: %s", (rule, command) => {
    expect(hardRules(shell(command), base())).toContain(rule);
  });
});

describe("here-documents: quoted delimiters are data, unquoted ones expand", () => {
  const base = () => ({
    ...evaluate(shell("ls"), undefined, permissive),
    decision: "human" as const,
  });
  test.each([
    ["force-push", "$(git push --force origin x)"],
    ["credential-read", "$(cat ~/.aws/credentials)"],
    ["cloud-write", "$(az group delete -n x --yes)"],
    ["repo-delete", "`gh repo delete o/r --yes`"],
    ["force-push", "${X:-$(git push -f origin x)}"],
  ])("%s runs from an unquoted body: %s", (rule, line) => {
    expect(hardRules(shell(`cat <<EOF\n${line}\nEOF`), base())).toContain(rule);
    for (const delimiter of ["'EOF'", '"EOF"', "\\EOF"])
      expect(hardRules(shell(`cat > notes.md <<${delimiter}\n${line}\nEOF`), base())).toEqual([]);
  });
  test("the classifier never approves them", async () => {
    for (const line of ["$(git push --force origin x)", "$(az group delete -n x --yes)"]) {
      const { s, runs } = session();
      const d = await s.decide(shell(`cat <<EOF\n${line}\nEOF`), "PreToolUse");
      expect(d.decision, line).toBe("human");
      expect(runs()).toBe(0);
    }
  });
});

describe("more of the floor", () => {
  const base = () => ({
    ...evaluate(shell("ls"), undefined, permissive),
    decision: "human" as const,
  });
  test.each([
    ["cloud-write", "curl -X DELETE https://management.example.com/sub/x"],
    ["cloud-write", "curl -XPATCH https://api.example.com/x"],
    ["cloud-write", "curl --request PUT https://api.example.com/x"],
    ["cloud-write", "curl -d '{}' https://api.example.com/repos/o/r/releases"],
    ["cloud-write", "curl -T file.bin https://upload.example.com/x"],
    ["cloud-write", "wget --method=DELETE https://api.example.com/x"],
    ["cloud-write", "http DELETE https://api.example.com/x"],
    ["cloud-write", "http https://api.example.com/x name=value"],
    ["repo-delete", "gh api repos/o/r -f archived=true -X PATCH"],
    ["repo-delete", "gh api -X DELETE repos/o/r/releases/1"],
    ["repo-delete", "gh api -X PUT repos/o/r/branches/main/protection --input p.json"],
    [
      "repo-delete",
      "gh api graphql -f query='mutation{deleteRepository(input:{repositoryId:\"x\"}){clientMutationId}}'",
    ],

    ["rm-outside", "find ~/proj -delete"],
    ["rm-outside", "find /opt/data -name '*.log' -exec rm {} ;"],
    ["cloud-write", "eval 'az group delete -n x --yes'"],
    ["cloud-write", "bash -c 'kubectl delete ns prod'"],
    ["cloud-write", "xargs -n1 az group delete -n"],
    ["cloud-write", "env A=1 terraform destroy"],
    ["cloud-write", "nohup helm uninstall app"],
    ["cloud-write", "timeout 30 pulumi destroy --yes"],
    ["cloud-write", "watch -n 5 kubectl delete pod x"],
  ])("%s: %s", (rule, command) => {
    expect(hardRules(shell(command), base())).toContain(rule);
  });
  test.each([
    "curl https://api.example.com/x",
    "curl -G -d q=1 https://api.example.com/search",
    "curl -X POST http://localhost:3000/api",
    "curl -X DELETE http://127.0.0.1:8080/x",
    "gh api repos/o/r/pulls",
    "gh api -X GET repos/o/r -f per_page=100",
    "gh api repos/o/r/issues -f title=x",
    "gh api repos/o/r/pulls/1/comments -f body=ok",
    "gh api graphql -f query='mutation{addPullRequestReviewThreadReply(input:{}){comment{id}}}'",
    'gh api graphql -f query=\'{repository(owner:"o",name:"r"){id}}\'',
    `find ${tmpdir().replace(/\\/g, "/")}/x -delete`,
  ])("not the floor: %s", (command) => {
    const rules = hardRules(shell(command), base());
    expect(
      rules.filter((rule) => ["cloud-write", "rm-outside", "repo-delete"].includes(rule)),
    ).toEqual([]);
  });
});

test('an unquoted here-document body with `"` and `\\"` keeps its substitutions apart', () => {
  const base = { ...evaluate(shell("ls"), undefined, permissive), decision: "human" as const };
  const body = 'say "hi" and \\" then $(git push --force origin x) "';
  expect(hardRules(shell(`cat <<EOF\n${body}\nEOF`), base)).toContain("force-push");
  expect(hardRules(shell(`cat <<EOF\nsay "hi" and \\" only text\nEOF`), base)).toEqual([]);
});

describe("unquoted here-document bodies are read with the shell's rules", () => {
  const base = () => ({
    ...evaluate(shell("ls"), undefined, permissive),
    decision: "human" as const,
  });
  const alphabet = ["\\", '"', "'", "$", "(", ")", "`", "\n", "a", " "];
  let seed = 7;
  const random = (n: number) =>
    Array.from({ length: n }, () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return alphabet[seed % alphabet.length];
    }).join("");
  test("a substitution embedded in any text always hits the floor", () => {
    let misses = 0;
    for (let k = 0; k < 400; k++) {
      // `a ` before it keeps a trailing backslash in the prefix from escaping its `$`, as the
      // shell would; every line is kept apart from the delimiter.
      const body = `${random(k % 17)}a $(az group delete -n x) ${random(k % 13)}`
        .split("\n")
        .map((line) => (line === "EOF" ? "EOF " : line))
        .join("\n");
      if (!hardRules(shell(`cat <<EOF\n${body}\nEOF`), base()).includes("cloud-write")) misses++;
    }
    expect(misses).toBe(0);
  });
  test.each(['\\\\"', '\\\\\\"', '\\\\\\\\"'])(
    "%s before a quote does not hide what follows",
    (backslashes) => {
      const body = `say ${backslashes}hi${backslashes} and $(az group delete -n x)`;
      expect(hardRules(shell(`cat <<EOF\n${body}\nEOF`), base())).toContain("cloud-write");
    },
  );
  test("an escaped substitution is text, as in the shell", () => {
    expect(hardRules(shell("cat <<EOF\nnot run: \\$(az group delete -n x)\nEOF"), base())).toEqual(
      expect.not.arrayContaining(["force-push"]),
    );
  });
});

describe("the floor fails closed when it cannot read the target", () => {
  const base = () => ({
    ...evaluate(shell("ls"), undefined, permissive),
    decision: "human" as const,
  });
  test.each([
    ["cloud-write", "curl -X DELETE example.com/x"],
    ["cloud-write", "curl -X POST $URL"],
    ["cloud-write", 'curl --request PUT "$API/items/1"'],
    ["cloud-write", "curl -X DELETE"],
    ["cloud-write", "curl -d x=1 api.internal:8080/v1"],
    ["cloud-write", "wget --post-data=x api.example.com/x"],
    ["cloud-write", "curl -X DELETE http://localhost:3000/x https://api.example.com/y"],
    ["rm-outside", "rm -rf ~other/x"],
  ])("%s: %s", (rule, command) => {
    expect(hardRules(shell(command), base())).toContain(rule);
  });
  test.each([
    "curl -X POST http://localhost:3000/api",
    "curl -X DELETE 127.0.0.1:8080/x",
    "curl -d x=1 http://[::1]:9000/y",
  ])("explicit loopback only is exempt: %s", (command) => {
    expect(hardRules(shell(command), base())).not.toContain("cloud-write");
  });
});

describe("the floor overrides an engine approval", () => {
  test.each([
    "helm uninstall app",
    "kubectl delete ns prod",
    "terraform destroy -auto-approve",
    "pulumi destroy --yes",
    "npm publish",
    "docker push example/app:1",
    "gh repo delete o/r --yes",
    "gh release delete v1 --yes",
    "gh api -X DELETE repos/o/r/git/refs/heads/x",
    "gh api graphql -f query='mutation{deleteRepository(input:{repositoryId:\"x\"}){clientMutationId}}'",
    "curl -X DELETE https://api.example.com/x",
    "rm -rf ~/Documents/old",
    "find ~/proj -delete",
  ])("%s asks in every profile", (command) => {
    for (const profile of [strictProfile, permissive]) {
      const d = evaluate(shell(command), undefined, profile);
      expect(d.decision, command).toBe("human");
      expect(d.hard, command).toBeDefined();
    }
  });
  test("a profile that allows cloud writes keeps them automatic, deletion still asks", () => {
    const allow = parseProfile(
      JSON.stringify({ version: 1, mode: "permissive", cloudWrites: "allow" }),
    );
    expect(
      evaluate(shell("az vm restart --name a --resource-group b"), undefined, allow).decision,
    ).toBe("approve");
    expect(evaluate(shell("kubectl delete ns prod"), undefined, allow).decision).toBe("human");
  });
});

describe("a file tool is judged by its target, never by the text it writes", () => {
  const text = "see ~/.claude/settings.json, .env, ~/.aws/credentials, git push --force, rm -rf ~";
  const tool = (name: string, input: Record<string, unknown>): Request => ({
    sessionId: "s1",
    harness: "claude",
    cwd: worktree,
    tool: name,
    input,
  });
  test.each([
    ["Write", () => ({ file_path: join(worktree, "notes.md"), content: text })],
    [
      "Edit",
      () => ({ file_path: join(worktree, "src.ts"), old_string: text, new_string: `${text}!` }),
    ],
    [
      "MultiEdit",
      () => ({
        file_path: join(worktree, "src.ts"),
        edits: [{ old_string: text, new_string: "x" }],
      }),
    ],
    ["NotebookEdit", () => ({ notebook_path: join(worktree, "n.ipynb"), new_source: text })],
  ])("%s in a feature worktree is approved", async (name, input) => {
    const r = tool(name as string, (input as () => Record<string, unknown>)());
    expect(evaluate(r, undefined, permissive).decision).toBe("approve");
    const { s, runs } = session();
    expect((await s.decide(r, "PreToolUse")).decision).toBe("approve");
    expect(runs()).toBe(0);
  });
  test("a patch is judged by its file headers, not its lines", () => {
    const r: Request = {
      sessionId: "s1",
      harness: "codex",
      cwd: worktree,
      tool: "apply_patch",
      input: { command: `*** Begin Patch\n*** Add File: notes.md\n+${text}\n*** End Patch` },
    };
    expect(evaluate(r, undefined, permissive).decision).toBe("approve");
  });
  test("the target still decides: a settings file asks whatever the text", () => {
    const r = tool("Edit", {
      file_path: join(worktree, ".claude", "settings.json"),
      old_string: "a",
      new_string: "b",
    });
    expect(evaluate(r, undefined, permissive).decision).toBe("human");
  });
});

test("az bicep is local", () => {
  const base = { ...evaluate(shell("ls"), undefined, permissive), decision: "human" as const };
  expect(hardRules(shell("az bicep build --file main.bicep --stdout"), base)).not.toContain(
    "cloud-write",
  );
  expect(hardRules(shell("az deployment group create -g x -f main.bicep"), base)).toContain(
    "cloud-write",
  );
});
