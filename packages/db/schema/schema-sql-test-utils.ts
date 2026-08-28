/** Extracts one semicolon-terminated SQL declaration beginning with the supplied prefix. */
export const extractSqlDeclaration = (sql: string, prefix: string): string => {
  const start = sql.indexOf(prefix)
  if (start === -1) {
    throw new Error(`Missing SQL declaration: ${prefix}`)
  }

  const end = sql.indexOf(';', start)
  if (end === -1) {
    throw new Error(`Unterminated SQL declaration: ${prefix}`)
  }

  return sql.slice(start, end + 1)
}
