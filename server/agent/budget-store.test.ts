import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileBudgetStore } from './budget-store'
import { RuntimeFault } from 'pi-agent-runtime'

const UNCAPPED = {
  cumulative: 'unlimited' as const,
  maxOutputTokens: 8192,
  modelTimeoutMs: 120_000,
  toolTimeoutMs: 30_000,
  controlTimeoutMs: 30_000,
}

function newStore(): { store: FileBudgetStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dp-budget-'))
  return { store: new FileBudgetStore(join(dir, 'ledger.json')), dir }
}

describe('FileBudgetStore（0.4.1 累计不封顶合同）', () => {
  it('claimUncapped 取 lease，预留/结算/释放链路入账', async () => {
    const { store } = newStore()
    const lease = await store.claimUncapped('t1', 'r1', 'cfg-a', UNCAPPED)
    expect(lease.snapshot().modelCalls).toBe(0)
    await lease.reserveModelUpTo(1000)
    expect(lease.snapshot()).toMatchObject({ modelCalls: 1, outputTokens: 1000, reservedOutputTokens: 1000 })
    await lease.settleModelUsage(1000, { inputTokens: 500, outputTokens: 800 })
    expect(lease.snapshot()).toMatchObject({ inputTokens: 500, outputTokens: 800, reservedOutputTokens: 0 })
    await lease.release(1500)
    expect(store.usageOf('t1')).toMatchObject({ activeMs: 1500, modelCalls: 1 })
  })

  it('活动 lease 未释放时二次 claim 拒绝 TASK_BUSY；释放后可再取', async () => {
    const { store } = newStore()
    await store.claimUncapped('t1', 'r1', 'cfg-a', UNCAPPED)
    await expect(store.claimUncapped('t1', 'r2', 'cfg-a', UNCAPPED)).rejects.toMatchObject({ reason: 'TASK_BUSY' })
    const lease = await store.claimUncapped('t1', 'r1', 'cfg-a', UNCAPPED) // 同 runId 幂等重取
    await lease.release(0)
    const next = await store.claimUncapped('t1', 'r2', 'cfg-a', UNCAPPED)
    await next.release(0)
  })

  it('配置签名变化拒绝 CONFIGURATION_CHANGED', async () => {
    const { store } = newStore()
    const lease = await store.claimUncapped('t1', 'r1', 'cfg-a', UNCAPPED)
    await lease.release(0)
    await expect(store.claimUncapped('t1', 'r2', 'cfg-b', UNCAPPED)).rejects.toMatchObject({
      reason: 'CONFIGURATION_CHANGED',
    })
  })

  it('重启不清账：用量与配置身份跨实例保留', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dp-budget-'))
    const file = join(dir, 'ledger.json')
    const first = new FileBudgetStore(file)
    const lease = await first.claimUncapped('t1', 'r1', 'cfg-a', UNCAPPED)
    await lease.reserveModelUpTo(512)
    await lease.settleModelUsage(512, { inputTokens: 100, outputTokens: 300 })
    await lease.release(10)

    const second = new FileBudgetStore(file)
    expect(second.usageOf('t1')).toMatchObject({ modelCalls: 1, inputTokens: 100, outputTokens: 300 })
    await expect(second.claimUncapped('t1', 'r9', 'cfg-b', UNCAPPED)).rejects.toMatchObject({
      reason: 'CONFIGURATION_CHANGED',
    })
    rmSync(dir, { recursive: true, force: true })
  })

  it('账本文件损坏抛 STATE_FAILED，不静默清零', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dp-budget-'))
    const file = join(dir, 'ledger.json')
    writeFileSync(file, '{broken', 'utf-8')
    expect(() => new FileBudgetStore(file)).toThrow(RuntimeFault)
    rmSync(dir, { recursive: true, force: true })
  })

  it('releaseActive 释放崩溃残留 lease 并自审计', async () => {
    const { store, dir } = newStore()
    await store.claimUncapped('t1', 'r1', 'cfg-a', UNCAPPED)
    await store.releaseActive('t1', 'crash-recovery')
    const again = await store.claimUncapped('t1', 'r2', 'cfg-a', UNCAPPED)
    await again.release(0)
    const audit = readFileSync(join(dir, 'ledger.json.audit.jsonl'), 'utf-8')
    expect(audit).toContain('releaseActive')
    expect(audit).toContain('crash-recovery')
    rmSync(dir, { recursive: true, force: true })
  })

  it('未知预留不退款：超预留的真实输出按真实量入账', async () => {
    const { store } = newStore()
    const lease = await store.claimUncapped('t1', 'r1', 'cfg-a', UNCAPPED)
    await lease.reserveModelUpTo(100)
    // Provider 实际输出超过预留：记录真实量（outputTokens 增幅 = output - reserved）
    await lease.settleModelUsage(100, { inputTokens: 0, outputTokens: 250 })
    expect(store.usageOf('t1')).toMatchObject({ outputTokens: 250, reservedOutputTokens: 0 })
    await lease.release(0)
  })
})
