import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { chmod, chown, mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import test from "node:test"

const run = promisify(execFile)
const host = { uid: 29_001, gid: 29_001, groups: [29_003] }
const reviewer = { uid: 29_002, gid: 29_003, groups: [] }
const implementation = { uid: 29_004, gid: 29_004, groups: [] }
const reviewGroup = 29_003
const rootRequired = typeof process.getuid === "function" && process.getuid() === 0

test("host-created review Git state inherits the reviewer group and excludes implementation",
  { skip: rootRequired ? false : "requires the root-run protected CI permission fixture" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "momi-review-permissions-"))
    const source = join(root, "canonical-source")
    const reviewState = join(root, "reviewer-state")
    const repository = join(reviewState, "repository")
    const workspaces = join(reviewState, "workspaces")
    const workspace = join(workspaces, "review-attempt")
    const marker = join(workspace, "host-created.txt")
    const reviewerGitTrust = {
      GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "safe.directory",
      GIT_CONFIG_VALUE_0: repository, GIT_CONFIG_KEY_1: "safe.directory",
      GIT_CONFIG_VALUE_1: `${workspaces}/*`,
    }
    try {
      await chmod(root, 0o755)
      await mkdir(source); await chown(source, host.uid, host.gid); await chmod(source, 0o750)
      await asIdentity(host, "git", ["init", "-b", "main", source])
      await asIdentity(host, process.execPath, ["-e",
        "require('node:fs').writeFileSync(process.argv[1], 'exact subject\\n')",
        join(source, "subject.txt")])
      await asIdentity(host, "git", ["-C", source, "add", "subject.txt"])
      await asIdentity(host, "git", ["-C", source, "-c", "user.name=Review Test",
        "-c", "user.email=review@example.invalid", "commit", "-m", "subject"])
      const revision = (await asIdentity(host, "git", ["-C", source,
        "rev-parse", "HEAD"])).stdout.trim()

      await mkdir(reviewState); await chown(reviewState, reviewer.uid, reviewGroup)
      await chmod(reviewState, 0o750)
      for (const directory of [repository, workspaces]) {
        await mkdir(directory); await chown(directory, host.uid, reviewGroup)
        await chmod(directory, 0o2770)
      }
      await asIdentity(host, "git", ["init", "--bare", repository])
      await asIdentity(host, "git", ["-C", repository, "fetch", "--no-tags", "--force",
        `file://${source}`, "+refs/heads/main:refs/momi-review/exact-head"])
      await asIdentity(host, "git", ["-C", repository, "worktree", "add", "--detach",
        workspace, revision])
      await asIdentity(host, process.execPath, ["-e",
        "require('node:fs').writeFileSync(process.argv[1], 'host marker\\n')", marker])

      const inherited = [repository, workspaces, ...(await pathsBelow(repository)),
        ...(await pathsBelow(workspace))]
      assert.ok(inherited.length > 4)
      for (const path of inherited) {
        const metadata = await stat(path)
        assert.equal(metadata.gid, reviewGroup, path)
        if (metadata.isDirectory()) assert.equal(metadata.mode & 0o2000, 0o2000, path)
      }
      assert.equal((await stat(repository)).mode & 0o2000, 0o2000)
      assert.equal((await stat(workspaces)).mode & 0o2000, 0o2000)
      assert.equal((await stat(workspace)).mode & 0o2000, 0o2000)

      await assert.rejects(asIdentity(reviewer, "git", ["-C", workspace,
        "rev-parse", "HEAD"]), (error: unknown) => {
        assert.match(String((error as { stderr?: string }).stderr), /dubious ownership/)
        return true
      })
      assert.equal((await asIdentity(reviewer, "git", ["-C", workspace,
        "rev-parse", "HEAD"], reviewerGitTrust)).stdout.trim(), revision)
      assert.equal((await asIdentity(reviewer, "git", ["-C", repository,
        "show", `${revision}:subject.txt`], reviewerGitTrust)).stdout, "exact subject\n")
      assert.equal((await asIdentity(reviewer, process.execPath, ["-e",
        "process.stdout.write(require('node:fs').readFileSync(process.argv[1], 'utf8'))",
        marker])).stdout, "host marker\n")
      assert.equal(await readFile(marker, "utf8"), "host marker\n")

      await assert.rejects(asIdentity(implementation, process.execPath, ["-e",
        "require('node:fs').readFileSync(process.argv[1])", marker]))
      await assert.rejects(asIdentity(implementation, "git", ["-C", repository,
        "rev-parse", "refs/momi-review/exact-head"], reviewerGitTrust))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

async function asIdentity(
  identity: { uid: number; gid: number; groups: number[] },
  command: string,
  args: string[],
  extraEnvironment: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string }> {
  const groupArgs = identity.groups.length > 0
    ? ["--groups", identity.groups.join(",")] : ["--clear-groups"]
  return run("setpriv", ["--reuid", String(identity.uid), "--regid", String(identity.gid),
    ...groupArgs, "--no-new-privs", "/bin/sh", "-c", "umask 0007; exec \"$@\"",
    "momi-review-permission-test", command, ...args], { env: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp",
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
      ...extraEnvironment,
    } })
}

async function pathsBelow(directory: string): Promise<string[]> {
  const result: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    result.push(path)
    if (entry.isDirectory()) result.push(...await pathsBelow(path))
  }
  return result
}
