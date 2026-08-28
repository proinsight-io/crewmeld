/** Compatibility permission mapping until dedicated QA codes are introduced. */
export const QA_PERMISSIONS = {
  view: 'knowledge:list',
  edit: 'knowledge:edit',
  import: 'knowledge:edit',
  export: 'knowledge:edit',
  remove: 'knowledge:delete',
} as const
