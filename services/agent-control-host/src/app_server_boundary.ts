import { isAbsolute, relative, resolve } from "node:path"

export type AppServerBoundary = {
  implementationCodexHome: string
  reviewCodexHome: string
  reviewRepositoryRoot: string
  reviewWorkspaceRoot: string
}

const reviewStateRoot = "/var/lib/momi-agent-reviewer"

export function readAppServerBoundary(
  env: Record<string, string | undefined>,
): AppServerBoundary {
  const implementationCodexHome = normalized(env.CODEX_HOME)
  const reviewCodexHome = normalized(env.MOMI_REVIEW_CODEX_HOME)
  const reviewRepositoryRoot = normalized(env.MOMI_REVIEW_REPOSITORY_ROOT)
  const reviewWorkspaceRoot = normalized(env.MOMI_REVIEW_WORKSPACE_ROOT)
  if (!implementationCodexHome || !reviewCodexHome || !reviewRepositoryRoot ||
    !reviewWorkspaceRoot ||
    implementationCodexHome === reviewCodexHome ||
    overlaps(implementationCodexHome, reviewCodexHome) ||
    overlaps(implementationCodexHome, reviewRepositoryRoot) ||
    overlaps(implementationCodexHome, reviewWorkspaceRoot) ||
    overlaps(reviewCodexHome, reviewRepositoryRoot) ||
    overlaps(reviewCodexHome, reviewWorkspaceRoot) ||
    overlaps(reviewRepositoryRoot, reviewWorkspaceRoot) ||
    inside(implementationCodexHome, reviewStateRoot) ||
    !inside(reviewCodexHome, reviewStateRoot) ||
    !inside(reviewRepositoryRoot, reviewStateRoot) ||
    !inside(reviewWorkspaceRoot, reviewStateRoot)) {
    throw new Error("review_app_server_boundary_invalid")
  }
  return { implementationCodexHome, reviewCodexHome, reviewRepositoryRoot,
    reviewWorkspaceRoot }
}

function normalized(value: string | undefined): string | null {
  const path = value?.trim() ?? ""
  return isAbsolute(path) ? resolve(path) : null
}

function inside(path: string, root: string): boolean {
  const child = relative(root, path)
  return child !== "" && !child.startsWith("..") && !isAbsolute(child)
}

function overlaps(left: string, right: string): boolean {
  return inside(left, right) || inside(right, left)
}
