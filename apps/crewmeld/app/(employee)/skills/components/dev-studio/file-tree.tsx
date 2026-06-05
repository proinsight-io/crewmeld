'use client'

import { Trash2 } from 'lucide-react'
import type { FileNode } from '@/lib/dev-studio/file-tree'

interface FileTreeRenderProps {
  node: FileNode
  /** Called on single click of a file leaf. */
  onOpen: (file: FileNode) => void
  /**
   * Optional delete handler. The button only renders for direct children of
   * `upload/` (the user's reference-file area). All other files are
   * functional — code, manifests, sandbox outputs — and never expose a
   * delete affordance through this tree, even when this prop is supplied.
   */
  onDelete?: (file: FileNode) => void
  /** Indentation depth — 0 for the root, +1 per level. */
  depth: number
}

const INDENT_PX = 12

/**
 * Format a byte count as `B` / `KB` / `MB` / `GB`. Mirrors the helper in
 * connection-tab; copied here so file-tree stays self-contained.
 */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} KB`
  return `${bytes} B`
}

/** Direct child of the `upload/` subdir — the only files the user is
 *  allowed to delete from this tree. Nested files (if any) are excluded. */
const UPLOAD_FILE_RE = /^upload\/[^/]+$/

/**
 * Pure recursive renderer for {@link FileNode}.
 *
 * Top-level levels (depth < 2) are open by default; deeper folders collapse
 * so a large workspace stays scannable. Files surface a double-click handler
 * that the parent panel uses to open a preview dialog — folders still use
 * native `<details>` toggle semantics so clicking a folder doesn't preview
 * anything, it just expands/collapses.
 */
export function FileTreeRender({ node, onOpen, onDelete, depth }: FileTreeRenderProps) {
  if (node.type === 'directory') {
    return (
      <details open={depth < 2} data-testid={`dev-studio:file-tree:dir:${node.path || 'root'}`}>
        <summary
          className='cursor-pointer select-none rounded px-1 py-0.5 hover:bg-accent'
          style={{ paddingLeft: depth * INDENT_PX }}
        >
          <span aria-hidden='true'>📁 </span>
          {node.name || '/'}
        </summary>
        <div>
          {(node.children ?? []).map((child) => (
            <FileTreeRender
              key={child.path}
              node={child}
              onOpen={onOpen}
              onDelete={onDelete}
              depth={depth + 1}
            />
          ))}
        </div>
      </details>
    )
  }
  const deletable = onDelete !== undefined && UPLOAD_FILE_RE.test(node.path)
  return (
    <div
      className='group flex cursor-pointer items-center rounded px-1 py-0.5 hover:bg-accent'
      style={{ paddingLeft: depth * INDENT_PX + 16 }}
      onDoubleClick={() => onOpen(node)}
      data-testid={`dev-studio:file-tree:file:${node.path}`}
    >
      <span className='flex-1 truncate'>
        <span aria-hidden='true'>📄 </span>
        {node.name}{' '}
        <span className='text-xs text-muted-foreground'>{formatBytes(node.size ?? 0)}</span>
      </span>
      {deletable && (
        <button
          type='button'
          onClick={(e) => {
            // Stop the row's onDoubleClick from also firing — even a single
            // click on the button shouldn't open the preview dialog.
            e.stopPropagation()
            onDelete?.(node)
          }}
          className='ml-1 hidden shrink-0 items-center justify-center rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive group-hover:flex'
          aria-label='Delete'
          data-testid={`dev-studio:file-tree:delete:${node.path}`}
        >
          <Trash2 className='size-3.5' />
        </button>
      )}
    </div>
  )
}
