import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonlAuditSink } from './audit'
import type { AuditEvent } from 'pi-agent-runtime'

function event(sequence: number): AuditEvent {
  return {
    version: '1.0',
    taskId: 't1',
    runId: 'r1',
    sequence,
    kind: 'run.started',
    at: '2026-10-12T00:00:00.000Z',
    provider: 'test',
    model: 'test-model',
    contextVersions: {},
  }
}

describe('JsonlAuditSink（append 即持久确认）', () => {
  it('逐行追加 JSONL，自动建目录', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dp-audit-'))
    const file = join(dir, 'nested', 'audit.jsonl')
    const sink = new JsonlAuditSink(file)
    await sink.append(event(1), new AbortController().signal)
    await sink.append(event(2), new AbortController().signal)
    const lines = readFileSync(file, 'utf-8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[1]).sequence).toBe(2)
    rmSync(dir, { recursive: true, force: true })
  })

  it('写入失败原样上抛（关闭新准入语义由 SDK 边界处理）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dp-audit-'))
    const sink = new JsonlAuditSink(join(dir, 'a-file', 'that-is-a-dir', 'audit.jsonl'))
    // 先造同名目录占位使 appendFile 失败
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(dir, 'a-file', 'that-is-a-dir', 'audit.jsonl'), { recursive: true })
    await expect(sink.append(event(1), new AbortController().signal)).rejects.toThrow()
    rmSync(dir, { recursive: true, force: true })
  })
})
