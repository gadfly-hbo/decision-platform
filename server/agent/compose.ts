import { join } from 'node:path'
import { createRuntime } from 'pi-agent-runtime'
import { JsonlAuditSink } from './audit'
import { FileBudgetStore } from './budget-store'
import { candidateChain, loadKeysFromDisk } from './model'
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
  const ledgerPath = join(dataDir, 'agent-ledger.json')
  const auditPath = join(dataDir, 'agent-audit.jsonl')
  const chain = candidateChain()
  const primary = chain[0]
  const store = new FileBudgetStore(ledgerPath)
  const runtime = createRuntime({
    model: primary.model,
    transport: primary.transport,
    ...(chain.length > 1 ? { fallbacks: chain.slice(1).map((c) => ({ model: c.model, transport: c.transport })) } : {}),
    authorize: localAuthorize,
    audit: new JsonlAuditSink(auditPath),
    budgets: store,
  })
  return { runner: createExtractionRunner({ runtime }), ledgerPath, auditPath, store }
}
