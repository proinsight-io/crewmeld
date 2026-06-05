import { create } from 'zustand'

/**
 * Cross-component UI state for the dev-studio dialog.
 *
 * Today the only consumer is the global NotificationCenter, which suppresses
 * its corner cards while the dialog is open so the operator doesn't see the
 * same ask twice (inline in the chat + duplicated in the upper-right) and
 * doesn't accidentally trigger the close-confirm by clicking the corner card.
 */
interface DevStudioUIState {
  /** True while the DevStudioDialog is mounted + visible. */
  dialogOpen: boolean
  setDialogOpen: (open: boolean) => void
}

export const useDevStudioUI = create<DevStudioUIState>((set) => ({
  dialogOpen: false,
  setDialogOpen: (open) => set({ dialogOpen: open }),
}))
