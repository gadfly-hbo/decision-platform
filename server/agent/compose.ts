import { join } from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createRuntime, type RuntimeOptions } from 'pi-agent-runtime'
import { JsonlAuditSink } from './audit'
import { FileBudgetStore } from './budget-store'
import { candidateChain, loadKeysFromDisk, type Candidate } from './model'
import { createExtractionRunner, type ExtractionRunner } from './extract'

/**
 * 生产装配（composition root）：模型链 + 文件账本 + JSONL 审计 + 本地授权。
 * 业务代码唯一触点；测试不经此文件（直接注入 runner / 合成 transport）。
 */

export const LOCAL_POLICY_VERSION = 'decision-board-local-v1'

async function localAuthorize(): Promise<boolean> {
  // 本地单用户产品：抽取任务由用户放置报告触发即预授权；无工具、无 external 效果。
  // publish = 结果交付本地用户；真实外发（推送）由 notify/im 通道自己的配置与幂等闸控制。
  return true
}

export interface AgentComposition {
  runner: ExtractionRunner
  ledgerPath: string
  auditPath: string
  /** 权威任务账本实例（S-R 运行详情投影：usageTotals/usageOf） */
  store: FileBudgetStore
}

/** 装配默认抽取 runner；无密钥时抛错（调用方决定降级语义）。 */
export function composeDefaultAgent(dataDir: string): AgentComposition {
  loadKeysFromDisk()
  return composeAgent(dataDir, candidateChain())
}

/** 显式候选/授权装配；不发现凭据，独立入口与宿主入口共用。 */
export function composeAgent(
  dataDir: string,
  chain: readonly Candidate[],
  authorize: RuntimeOptions['authorize'] = localAuthorize,
): AgentComposition {
  const ledgerPath = join(dataDir, 'agent-ledger.json')
  const auditPath = join(dataDir, 'agent-audit.jsonl')
  const primary = chain[0]
  if (!primary) throw new Error('无可用模型候选')
  const store = new FileBudgetStore(ledgerPath)
  // SDK recovery and the extractor's malformed-JSON repair share this one
  // logical invocation allowance. Durable usage remains solely in store.
  const scopes = new AsyncLocalStorage<{ taskId: string; calls: number; open: boolean }>()
  const active = new Set<string>()
  const runtime = createRuntime({
    model: primary.model,
    transport: primary.transport,
    ...(chain.length > 1 ? { fallbacks: chain.slice(1).map((c) => ({ model: c.model, transport: c.transport })) } : {}),
    authorize: async (action, signal) => {
      const scope = scopes.getStore()
      const current = () => scope?.open && scope.taskId === action.taskId && !signal.aborted
      if (!current() || (action.kind !== 'model' && action.kind !== 'publish')) return false
      if (!await authorize(action, signal) || !current()) return false
      if (action.kind === 'model') {
        if (scope!.calls >= 2) return false
        scope!.calls++
      }
      return true
    },
    audit: new JsonlAuditSink(auditPath),
    budgets: store,
  })
  const extraction = createExtractionRunner({ runtime })
  const runner: ExtractionRunner = {
    async runExtraction(input) {
      if (active.has(input.taskId)) throw new Error('同一报告正在抽取')
      active.add(input.taskId)
      const scope = { taskId: input.taskId, calls: 0, open: true }
      try {
        return await scopes.run(scope, () => extraction.runExtraction(input))
      } finally {
        scope.open = false
        active.delete(input.taskId)
      }
    },
  }
  return { runner, ledgerPath, auditPath, store }
}
