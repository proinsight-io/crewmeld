/**
 * Tool Dev Studio file-tree builder + safe path resolver (Sub-spec B §4.4).
 *
 * - `buildFileTree` produces a recursive snapshot of a workspace, with file
 *   sizes and POSIX-style relative paths (the UI is path-style agnostic).
 *   Hidden prefixes (`.crewmeld-studio`, `.git` by default) are skipped at the
 *   directory entry level.
 * - `safeResolve` is the **only** sanctioned way to translate a user-supplied
 *   path into an absolute filesystem location. It rejects any path that, once
 *   resolved, escapes the workspace root via `..` or absolute components.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { paths } from './paths'

/** One node in the workspace file tree. */
export interface FileNode {
  /** Basename of the entry. Empty string for the workspace root. */
  name: string
  /** Relative POSIX path from the workspace root. Empty string for the root. */
  path: string
  type: 'file' | 'directory'
  /** File size in bytes; absent for directories. */
  size?: number
  /** Child entries; absent for files. */
  children?: FileNode[]
}

export interface BuildFileTreeOptions {
  /**
   * Directory/file basenames to skip when walking. Defaults to
   * `['.crewmeld-studio', '.git']`. Passing a custom list replaces the defaults.
   */
  hiddenPrefixes?: string[]
}

/**
 * Walk a session workspace recursively and return its tree representation.
 *
 * Derives the workspace directory via the paths facade
 * (`paths.sessionWorkspace.forBff(sessionId)`), so callers no longer pass the
 * raw filesystem location. Hidden entries (`.crewmeld-studio`, `.git` by
 * default) are pruned at the directory entry level so their contents are
 * never opened.
 */
export async function buildFileTreeFromSession(
  sessionId: string,
  opts?: BuildFileTreeOptions
): Promise<FileNode> {
  const workspaceDir = paths.sessionWorkspace.forBff(sessionId)
  return buildFileTreeFromDir(workspaceDir, opts)
}

/**
 * Build a `FileNode` tree of an adopted tool's persistent code directory
 * (`paths.toolCode.forBff(toolId)`). Mirrors {@link buildFileTreeFromSession}
 * for the tool-code surface read by the operator-facing code browser. Unlike
 * the session tree (which reads through the sandbox SDK), tool code lives on
 * the BFF-accessible NFS volume and is walked directly off the host fs.
 */
export async function buildFileTreeFromTool(
  toolId: string,
  opts?: BuildFileTreeOptions
): Promise<FileNode> {
  return buildFileTreeFromDir(paths.toolCode.forBff(toolId), opts)
}

/**
 * @deprecated Use {@link buildFileTreeFromSession} instead. This wrapper will
 * be removed once all callers migrate to the sessionId-based variant (Task 10
 * of the cross-platform NFS volume refactor).
 */
export async function buildFileTree(
  workspaceDir: string,
  opts?: BuildFileTreeOptions
): Promise<FileNode> {
  return buildFileTreeFromDir(workspaceDir, opts)
}

async function buildFileTreeFromDir(
  workspaceDir: string,
  opts?: BuildFileTreeOptions
): Promise<FileNode> {
  const hidden = new Set(opts?.hiddenPrefixes ?? ['.crewmeld-studio', '.git'])
  return walk(workspaceDir, '', hidden)
}

/** Subset of fields the file-tree builder needs from SDK file metadata. */
export interface FlatFileEntry {
  /** Absolute path inside the sandbox, e.g. `/root/workspace/src/util.py`. */
  path: string
  /** File size in bytes. Absent / 0 is treated as unknown. */
  size?: number
}

/**
 * Build a `FileNode` tree from the OpenSandbox SDK's flat `files.search`
 * output. Directories aren't enumerated by the SDK — they're inferred from
 * the path segments of the files they contain.
 *
 * Paths in the input must be absolute (e.g. `/root/workspace/main.py`).
 * Entries outside `rootAbsPath` are skipped silently.
 *
 * @param rootAbsPath The sandbox-side absolute workspace root, e.g.
 *   `/root/workspace`. Trailing slash tolerated.
 * @param opts.hiddenPrefixes Top-level directory names to drop entirely
 *   (descendants included). Defaults to `['.crewmeld-studio', '.git']`.
 */
export function buildTreeFromSearchResults(
  results: readonly FlatFileEntry[],
  rootAbsPath: string,
  opts?: BuildFileTreeOptions
): FileNode {
  const hidden = new Set(opts?.hiddenPrefixes ?? ['.crewmeld-studio', '.git'])
  const root: FileNode = { name: '', path: '', type: 'directory', children: [] }
  const rootNorm = rootAbsPath.replace(/\/$/, '')

  for (const item of results) {
    if (!item.path) continue
    if (item.path !== rootNorm && !item.path.startsWith(`${rootNorm}/`)) continue
    const relPath = item.path === rootNorm ? '' : item.path.slice(rootNorm.length + 1)
    if (!relPath) continue
    const segs = relPath.split('/').filter(Boolean)
    if (segs.length === 0) continue
    // Filter by top-level segment so anything under `.crewmeld-studio/...`
    // or `.git/...` is dropped wholesale.
    if (hidden.has(segs[0])) continue

    let cursor = root
    for (let i = 0; i < segs.length - 1; i++) {
      const segName = segs[i]
      const segRelPath = segs.slice(0, i + 1).join('/')
      const existing = cursor.children?.find(
        (c) => c.name === segName && c.type === 'directory'
      )
      if (existing) {
        cursor = existing
        continue
      }
      const next: FileNode = {
        name: segName,
        path: segRelPath,
        type: 'directory',
        children: [],
      }
      cursor.children = [...(cursor.children ?? []), next]
      cursor = next
    }
    const fileName = segs[segs.length - 1]
    cursor.children = [
      ...(cursor.children ?? []),
      { name: fileName, path: relPath, type: 'file', size: item.size },
    ]
  }
  return root
}

async function walk(absPath: string, relPath: string, hidden: Set<string>): Promise<FileNode> {
  const stat = await fs.stat(absPath)
  const name = path.basename(absPath)

  if (stat.isFile()) {
    return { name, path: relPath, type: 'file', size: stat.size }
  }

  const entries = await fs.readdir(absPath)
  const children: FileNode[] = []
  for (const entry of entries) {
    if (hidden.has(entry)) continue
    const childAbs = path.join(absPath, entry)
    const childRel = relPath === '' ? entry : `${relPath}/${entry}`
    children.push(await walk(childAbs, childRel, hidden))
  }
  return {
    name: relPath === '' ? '' : name,
    path: relPath,
    type: 'directory',
    children,
  }
}

/**
 * Resolve a caller-supplied path against the session workspace, rejecting any
 * input that escapes the workspace root. The workspace root is derived via
 * the paths facade (`paths.sessionWorkspace.forBff(sessionId)`).
 *
 * @returns The resolved absolute path, or `null` when the input would escape
 *   (via `..`, absolute path components, or symlink-style indirection that
 *   the resolver itself collapses).
 */
export function safeResolveInSession(
  sessionId: string,
  requestPath: string
): string | null {
  return safeResolveInDir(paths.sessionWorkspace.forBff(sessionId), requestPath)
}

/**
 * Resolve a caller-supplied path against an adopted tool's code directory
 * (`paths.toolCode.forBff(toolId)`), rejecting any input that escapes the
 * root. Mirrors {@link safeResolveInSession} for the tool-code surface.
 *
 * @returns The resolved absolute path, or `null` when the input would escape.
 */
export function safeResolveInTool(toolId: string, requestPath: string): string | null {
  return safeResolveInDir(paths.toolCode.forBff(toolId), requestPath)
}

/**
 * @deprecated Use {@link safeResolveInSession} (or `paths.safeResolve`
 * directly) instead. This wrapper will be removed once all callers migrate
 * to the sessionId-based variant (Task 10 of the cross-platform NFS volume
 * refactor).
 *
 * @example
 * ```ts
 * safeResolve('/ws', 'src/a.ts')           // → '/ws/src/a.ts'
 * safeResolve('/ws', '../etc/passwd')      // → null
 * safeResolve('/ws', '/etc/passwd')        // → null
 * ```
 */
export function safeResolve(workspaceDir: string, requestPath: string): string | null {
  return safeResolveInDir(workspaceDir, requestPath)
}

function safeResolveInDir(workspaceDir: string, requestPath: string): string | null {
  const root = path.resolve(workspaceDir)
  const resolved = path.resolve(root, requestPath)
  if (resolved === root) return resolved
  if (!resolved.startsWith(root + path.sep)) return null
  return resolved
}
