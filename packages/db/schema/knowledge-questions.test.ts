import { getTableName, SQL } from 'drizzle-orm'
import {
  getTableConfig,
  PgDialect,
  type AnyPgColumn,
  type AnyPgTable,
} from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  qaCsvBatches,
  qaDocumentVersions,
  qaQuestions,
  qaRecordStatusEnum,
  qaSyncJobs,
} from './knowledge-questions'
import { extractSqlDeclaration } from './schema-sql-test-utils'

const column = (columns: AnyPgColumn[], name: string): AnyPgColumn => {
  const match = columns.find((candidate) => candidate.name === name)
  expect(match, `missing column ${name}`).toBeDefined()
  return match as AnyPgColumn
}

const dialect = new PgDialect()
const sqlText = (value: SQL | undefined): string => (value ? dialect.sqlToQuery(value).sql : '')
const foreignKeyTuples = (table: AnyPgTable) =>
  getTableConfig(table).foreignKeys.map((key) => {
    const reference = key.reference()
    return {
      local: reference.columns.map((entry) => entry.name),
      localNotNull: reference.columns.map((entry) => entry.notNull),
      foreignTable: getTableName(reference.foreignTable),
      foreign: reference.foreignColumns.map((entry) => entry.name),
      onDelete: key.onDelete,
    }
  })

const indexColumns = (table: AnyPgTable, name: string): string[] => {
  const target = getTableConfig(table).indexes.find((entry) => entry.config.name === name)
  expect(target, `missing index ${name}`).toBeDefined()
  return target?.config.columns.map((entry) => (entry as AnyPgColumn).name) ?? []
}

describe('QA source-of-truth schema', () => {
  it('defines question ownership, defaults, optimistic versioning, and enabled uniqueness', () => {
    const config = getTableConfig(qaQuestions)

    expect(column(config.columns, 'enabled').default).toBe(true)
    expect(column(config.columns, 'sort_order').default).toBe(0)
    expect(column(config.columns, 'tags').default).toEqual([])
    expect(column(config.columns, 'version').default).toBe(1)
    expect(foreignKeyTuples(qaQuestions)).toEqual([
      { local: ['knowledge_base_id'], localNotNull: [true], foreignTable: 'knowledge_bases', foreign: ['id'], onDelete: 'cascade' },
      { local: ['batch_id'], localNotNull: [true], foreignTable: 'qa_csv_batches', foreign: ['id'], onDelete: 'cascade' },
      { local: ['created_by'], localNotNull: [false], foreignTable: 'user', foreign: ['id'], onDelete: 'set null' },
      { local: ['updated_by'], localNotNull: [false], foreignTable: 'user', foreign: ['id'], onDelete: 'set null' },
    ])
    expect(indexColumns(qaQuestions, 'qa_questions_batch_idx')).toEqual(['batch_id'])

    const unique = config.indexes.find((index) => index.config.name === 'qa_questions_enabled_normalized_uidx')
    expect(unique?.config.unique).toBe(true)
    expect(unique?.config.columns.map((entry) => (entry as AnyPgColumn).name)).toEqual([
      'knowledge_base_id',
      'normalized_question',
    ])
    expect(sqlText(unique?.config.where)).toContain('enabled')
    expect(sqlText(unique?.config.where)).toContain('true')
  })

  it('supports deferred active-version assignment without cascading remote document metadata', () => {
    const batchConfig = getTableConfig(qaCsvBatches)
    const versionConfig = getTableConfig(qaDocumentVersions)

    expect(column(batchConfig.columns, 'active_version_id').notNull).toBe(false)
    expect(foreignKeyTuples(qaCsvBatches)).toEqual([
      { local: ['knowledge_base_id'], localNotNull: [true], foreignTable: 'knowledge_bases', foreign: ['id'], onDelete: 'cascade' },
      { local: ['created_by'], localNotNull: [false], foreignTable: 'user', foreign: ['id'], onDelete: 'set null' },
      { local: ['active_version_id'], localNotNull: [false], foreignTable: 'qa_document_versions', foreign: ['id'], onDelete: 'set null' },
    ])
    expect(foreignKeyTuples(qaDocumentVersions)).toEqual([
      { local: ['batch_id'], localNotNull: [true], foreignTable: 'qa_csv_batches', foreign: ['id'], onDelete: 'cascade' },
    ])
    expect(indexColumns(qaCsvBatches, 'qa_csv_batches_knowledge_base_idx')).toEqual(['knowledge_base_id'])
    expect(indexColumns(qaDocumentVersions, 'qa_document_versions_batch_status_idx')).toEqual(['batch_id', 'status'])
    expect(column(versionConfig.columns, 'status').default).toBe('pending')
  })

  it('uses the exact lifecycle statuses and unique sync idempotency keys', () => {
    const versionConfig = getTableConfig(qaDocumentVersions)
    const jobConfig = getTableConfig(qaSyncJobs)
    expect(qaRecordStatusEnum.enumValues).toEqual([
      'pending',
      'syncing',
      'active',
      'failed',
      'superseded',
    ])
    expect(column(jobConfig.columns, 'attempts').default).toBe(0)
    expect(column(jobConfig.columns, 'status').default).toBe('pending')
    expect(column(jobConfig.columns, 'idempotency_key').isUnique).toBe(true)
    expect(foreignKeyTuples(qaSyncJobs)).toEqual([
      { local: ['batch_id'], localNotNull: [true], foreignTable: 'qa_csv_batches', foreign: ['id'], onDelete: 'cascade' },
    ])
    expect(indexColumns(qaSyncJobs, 'qa_sync_jobs_batch_status_idx')).toEqual(['batch_id', 'status'])
  })

  it('keeps init SQL aligned, including FK actions and the partial predicate', () => {
    const initSql = readFileSync(resolve(import.meta.dir, '..', 'init.sql'), 'utf8')
    const enumSql = extractSqlDeclaration(initSql, 'CREATE TYPE qa_record_status')
    const batchesSql = extractSqlDeclaration(initSql, 'CREATE TABLE IF NOT EXISTS qa_csv_batches')
    const versionsSql = extractSqlDeclaration(initSql, 'CREATE TABLE IF NOT EXISTS qa_document_versions')
    const questionsSql = extractSqlDeclaration(initSql, 'CREATE TABLE IF NOT EXISTS qa_questions')
    const jobsSql = extractSqlDeclaration(initSql, 'CREATE TABLE IF NOT EXISTS qa_sync_jobs')
    const activeVersionSql = extractSqlDeclaration(initSql, 'ALTER TABLE qa_csv_batches')

    expect(enumSql).toContain(
      "CREATE TYPE qa_record_status AS ENUM ('pending', 'syncing', 'active', 'failed', 'superseded')"
    )
    expect(batchesSql).toContain('knowledge_base_id text NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE')
    expect(batchesSql).toContain('active_version_id text')
    expect(batchesSql).toContain('created_by text REFERENCES "user"(id) ON DELETE SET NULL')
    expect(batchesSql.match(/timestamptz NOT NULL DEFAULT now\(\)/g)).toHaveLength(2)
    expect(versionsSql).toContain('batch_id text NOT NULL REFERENCES qa_csv_batches(id) ON DELETE CASCADE')
    expect(versionsSql).toContain('ragflow_document_id text')
    expect(versionsSql).toContain('checksum text NOT NULL')
    expect(versionsSql).toContain('filename text NOT NULL')
    expect(versionsSql).toContain("status qa_record_status NOT NULL DEFAULT 'pending'")
    expect(versionsSql).toContain('parsed_at timestamptz')
    expect(versionsSql).toContain('synced_at timestamptz')
    expect(versionsSql).toContain('error text')
    expect(versionsSql.match(/timestamptz NOT NULL DEFAULT now\(\)/g)).toHaveLength(2)
    expect(questionsSql).toContain('knowledge_base_id text NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE')
    expect(questionsSql).toContain('batch_id text NOT NULL REFERENCES qa_csv_batches(id) ON DELETE CASCADE')
    for (const declaration of [
      'question text NOT NULL',
      'answer text NOT NULL',
      'enabled boolean NOT NULL DEFAULT true',
      'sort_order integer NOT NULL DEFAULT 0',
      "tags jsonb NOT NULL DEFAULT '[]'::jsonb",
      'normalized_question text NOT NULL',
      'version integer NOT NULL DEFAULT 1',
      'created_by text REFERENCES "user"(id) ON DELETE SET NULL',
      'updated_by text REFERENCES "user"(id) ON DELETE SET NULL',
    ]) expect(questionsSql).toContain(declaration)
    expect(questionsSql.match(/timestamptz NOT NULL DEFAULT now\(\)/g)).toHaveLength(2)
    expect(jobsSql).toContain('batch_id text NOT NULL REFERENCES qa_csv_batches(id) ON DELETE CASCADE')
    expect(jobsSql).toContain('reason text NOT NULL')
    expect(jobsSql).toContain('idempotency_key text NOT NULL UNIQUE')
    expect(jobsSql).toContain('attempts integer NOT NULL DEFAULT 0')
    expect(jobsSql).toContain("status qa_record_status NOT NULL DEFAULT 'pending'")
    expect(jobsSql).toContain('error text')
    expect(jobsSql.match(/timestamptz NOT NULL DEFAULT now\(\)/g)).toHaveLength(2)
    expect(activeVersionSql).toContain('ADD CONSTRAINT qa_csv_batches_active_version_fk')
    expect(activeVersionSql).toContain('FOREIGN KEY (active_version_id) REFERENCES qa_document_versions(id) ON DELETE SET NULL')

    const expectedIndexes = [
      ['CREATE INDEX IF NOT EXISTS qa_csv_batches_knowledge_base_idx', 'ON qa_csv_batches(knowledge_base_id)'],
      ['CREATE INDEX IF NOT EXISTS qa_document_versions_batch_status_idx', 'ON qa_document_versions(batch_id, status)'],
      ['CREATE INDEX IF NOT EXISTS qa_questions_batch_idx', 'ON qa_questions(batch_id)'],
      ['CREATE UNIQUE INDEX IF NOT EXISTS qa_questions_enabled_normalized_uidx', 'ON qa_questions(knowledge_base_id, normalized_question) WHERE enabled = true'],
      ['CREATE INDEX IF NOT EXISTS qa_sync_jobs_batch_status_idx', 'ON qa_sync_jobs(batch_id, status)'],
    ] as const
    for (const [prefix, declaration] of expectedIndexes) {
      expect(extractSqlDeclaration(initSql, prefix)).toContain(declaration)
    }
  })
})
