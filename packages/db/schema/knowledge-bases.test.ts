import { getTableConfig } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { knowledgeBases } from './knowledge-bases'

describe('knowledgeBases schema', () => {
  it('declares unique remote IDs, defaults, and database validation constraints', () => {
    const config = getTableConfig(knowledgeBases)

    expect(config.columns.find((column) => column.name === 'ragflow_dataset_id')?.isUnique).toBe(true)
    expect(config.columns.find((column) => column.name === 'type')?.default).toBe('document')
    expect(config.columns.find((column) => column.name === 'enabled')?.default).toBe(true)
    expect(config.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining(['knowledge_bases_type_check', 'knowledge_bases_threshold_override_check'])
    )
  })

  it('keeps material init SQL defaults and constraints aligned with the Drizzle table', () => {
    const initSql = readFileSync(resolve(import.meta.dir, '..', 'init.sql'), 'utf8')
    const tableSql = initSql.match(
      /CREATE TABLE IF NOT EXISTS knowledge_bases \([\s\S]*?\n\);/
    )?.[0]

    expect(tableSql).toBeDefined()

    expect(tableSql).toContain("ragflow_dataset_id text NOT NULL UNIQUE")
    expect(tableSql).toContain("type text NOT NULL DEFAULT 'document'")
    expect(tableSql).toContain("enabled boolean NOT NULL DEFAULT true")
    expect(tableSql).toContain("navigation jsonb NOT NULL DEFAULT '{}'::jsonb")
    expect(tableSql).toContain("type IN ('document', 'qa')")
    expect(tableSql).toContain('threshold_override >= 0 AND threshold_override <= 1')
    expect(tableSql.match(/timestamptz NOT NULL DEFAULT now\(\)/g)).toHaveLength(2)
  })
})
