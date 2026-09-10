import { execFileSync } from "node:child_process"
import { lstat, readFile } from "node:fs/promises"
import { resolve } from "node:path"

export async function readReleaseCommit(repository) {
  let marker = null
  try {
    const path = resolve(repository, ".release-commit")
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("release commit marker must be a regular file")
    marker = (await readFile(path, "utf8")).trim()
    if (!/^[0-9a-f]{40}$/.test(marker)) throw new Error("release commit marker is invalid")
  } catch (error) { if (error.code !== "ENOENT") throw error }
  let git = null
  try {
    await lstat(resolve(repository, ".git"))
    git = execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
  } catch (error) { if (error.code !== "ENOENT") throw error }
  if (git && !/^[0-9a-f]{40}$/.test(git)) throw new Error("git release identity is invalid")
  if (git && marker && git !== marker) throw new Error("release marker does not match git HEAD")
  if (!git && !marker) throw new Error("release needs git metadata or a valid .release-commit marker")
  return git ?? marker
}
