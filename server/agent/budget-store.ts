import { RuntimeFault, type BudgetStore, type BudgetLease, type Limits, type UncappedBudgetLease, type UncappedLimits, type UncappedUsage, type Usage } from 'pi-agent-runtime'
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * 权威任务账本（AGENT-RUNTIME §INTEGRATION 输入 3，0.4.1 累计不封顶合同）：
 * 单文件 JSON 持久 + 原子写（tmp+rename），进程内同步变更。
 * 已知局限（本地单用户产品，明示）：不支持多进程并发写入；持久粒度为每次变更全量落盘。
 * 语义按 UNCAPPED-BUDGET-CONTRACT：claimUncapped 原子取 lease；配置签名变化拒绝（CONFIGURATION_CHANGED）；
 * 同任务活动 lease 未释放拒绝（TASK_BUSY）；未知/失败预留不退款；重启不清账。
 */

interface TaskLedger {
  taskId: string
  /** 当前/最近一次 lease 的 runId；active=false 表示已释放（历史保留） */
  runId: string
  configuration: string
  limits: UncappedLimits | Limits
  policy: 'unlimited' | 'finite'
  active: boolean
  usage: UncappedUsage | Usage
  /** 宿主批准的配置迁移标记：下一次 claim 接受新配置签名（用量历史保留） */
  pendingConfigMigration?: boolean
}

interface StoreShape {
  version: 1
  tasks: Record<string, TaskLedger>
}

function emptyUsage(): UncappedUsage {
  return { modelCalls: 0, toolCalls: 0, outputTokens: 0, resourceUnits: 0, activeMs: 0, inputTokens: 0, reservedOutputTokens: 0 }
}

export class FileBudgetStore implements BudgetStore {
  private readonly tasks = new Map<string, TaskLedger>()

  constructor(private readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true })
    this.load()
  }

  private load(): void {
    let raw: string
    try {
      raw = readFileSync(this.filePath, 'utf-8')
    } catch {
      return // 首次使用：空账本
    }
    let parsed: StoreShape
    try {
      parsed = JSON.parse(raw) as StoreShape
    } catch {
      // 账本故障关闭准入：不静默清零用户历史
      throw new RuntimeFault('STATE_FAILED')
    }
    if (parsed.version !== 1 || typeof parsed.tasks !== 'object' || parsed.tasks === null) {
      throw new RuntimeFault('STATE_FAILED')
    }
    for (const t of Object.values(parsed.tasks)) this.tasks.set(t.taskId, t)
  }

  /** 同步原子持久（本地单用户：单写者进程内串行，无并发窗口）。 */
  private persist(): void {
    const shape: StoreShape = { version: 1, tasks: Object.fromEntries(this.tasks) }
    const tmp = `${this.filePath}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(shape, null, 1), 'utf-8')
      renameSync(tmp, this.filePath)
    } catch {
      throw new RuntimeFault('STATE_FAILED')
    }
  }

  private ledger(taskId: string, create?: { runId: string; configuration: string; limits: UncappedLimits | Limits; policy: 'unlimited' | 'finite' }): TaskLedger {
    const existing = this.tasks.get(taskId)
    if (existing) return existing
    if (!create) throw new RuntimeFault('TASK_BUSY')
    const ledger: TaskLedger = { taskId, runId: create.runId, configuration: create.configuration, limits: create.limits, policy: create.policy, active: false, usage: emptyUsage() }
    this.tasks.set(taskId, ledger)
    return ledger
  }

  async claimUncapped(taskId: string, runId: string, configuration: string, limits: UncappedLimits): Promise<UncappedBudgetLease> {
    const existing = this.tasks.get(taskId)
    if (existing) {
      if (existing.active && existing.runId !== runId) throw new RuntimeFault('TASK_BUSY')
      if (existing.configuration !== configuration) {
        if (!existing.pendingConfigMigration) throw new RuntimeFault('CONFIGURATION_CHANGED')
        // 宿主显式批准的迁移：接受新配置，保留全部累计用量与审计
        existing.configuration = configuration
        existing.limits = limits
        existing.pendingConfigMigration = false
        this.persist()
        this.selfAudit({ kind: 'configMigrated', taskId, reason: 'host-approved' })
      }
      if (existing.policy !== 'unlimited') throw new RuntimeFault('CONFIGURATION_CHANGED')
      existing.runId = runId
      existing.active = true
      this.persist()
    } else {
      const ledger = this.ledger(taskId, { runId, configuration, limits, policy: 'unlimited' })
      ledger.active = true
      this.persist()
    }
    return this.uncappedLease(taskId)
  }

  async claim(taskId: string, runId: string, configuration: string, limits: Limits): Promise<BudgetLease> {
    const existing = this.tasks.get(taskId)
    if (existing) {
      if (existing.active && existing.runId !== runId) throw new RuntimeFault('TASK_BUSY')
      if (existing.configuration !== configuration) throw new RuntimeFault('CONFIGURATION_CHANGED')
      existing.runId = runId
      existing.active = true
      this.persist()
    } else {
      const ledger = this.ledger(taskId, { runId, configuration, limits, policy: 'finite' })
      ledger.active = true
      this.persist()
    }
    return this.finiteLease(taskId)
  }

  /** 宿主批准的配置迁移：下一次 claim 接受新配置签名；用量历史保留；自审计。 */
  forceNextClaim(taskId: string, reason: string): void {
    const ledger = this.require(taskId)
    ledger.pendingConfigMigration = true
    this.persist()
    this.selfAudit({ kind: 'forceNextClaim', taskId, reason })
  }

  /** 任务用量快照（右栏运行详情投影；不存在返回 null）。 */
  usageOf(taskId: string): (UncappedUsage | Usage) | null {
    const ledger = this.tasks.get(taskId)
    return ledger ? { ...ledger.usage } : null
  }

  /** 全部任务用量汇总（右栏运行详情聚合视图）。 */
  usageTotals(): UncappedUsage {
    const totals = emptyUsage()
    for (const ledger of this.tasks.values()) {
      totals.modelCalls += ledger.usage.modelCalls
      totals.toolCalls += ledger.usage.toolCalls
      totals.outputTokens += ledger.usage.outputTokens
      totals.resourceUnits += ledger.usage.resourceUnits
      totals.activeMs += ledger.usage.activeMs
      totals.inputTokens += ledger.usage.inputTokens ?? 0
      totals.reservedOutputTokens += ledger.usage.reservedOutputTokens ?? 0
    }
    return totals
  }

  /**
   * 宿主显式恢复动作：核查外部回执后释放残留活动 lease（如进程崩溃遗留）。
   * 不是绕过账本：历史用量保留，恢复动作写入自审计 JSONL。
   */
  async releaseActive(taskId: string, reason: string): Promise<void> {
    const ledger = this.tasks.get(taskId)
    if (!ledger) return // 幂等：从未有账目的任务直接视为已恢复
    if (ledger.active) {
      ledger.active = false
      this.persist()
    }
    this.selfAudit({ kind: 'releaseActive', taskId, runId: ledger.runId, reason })
  }

  private selfAudit(entry: Record<string, unknown>): void {
    try {
      appendFileSync(`${this.filePath}.audit.jsonl`, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf-8')
    } catch {
      // 自审计失败不影响账本本身（状态已落盘）；宿主日志可见性由调用方兜底
    }
  }

  private require(taskId: string): TaskLedger {
    const ledger = this.tasks.get(taskId)
    if (!ledger) throw new RuntimeFault('TASK_BUSY')
    return ledger
  }

  private uncappedLease(taskId: string): UncappedBudgetLease {
    const ledger = this.require(taskId)
    if (ledger.policy !== 'unlimited') throw new RuntimeFault('CONFIGURATION_CHANGED')
    const save = () => this.persist()
    const reserveUpTo = async (maximumTokens: number): Promise<number> => {
      if (!Number.isFinite(maximumTokens) || maximumTokens <= 0) throw new RuntimeFault('INVALID_REQUEST')
      const u = ledger.usage as UncappedUsage
      u.modelCalls += 1
      u.resourceUnits += 1
      u.outputTokens += maximumTokens
      u.reservedOutputTokens = (u.reservedOutputTokens ?? 0) + maximumTokens
      save()
      return maximumTokens
    }
    const settleUsage = async (reservedTokens: number, usage: { inputTokens: number; outputTokens: number }): Promise<void> => {
      const u = ledger.usage as UncappedUsage
      u.inputTokens = (u.inputTokens ?? 0) + usage.inputTokens
      // 已知真实输出入账；未结算预留按预留额释放（即使 output>reserved 也记录真实量）
      u.outputTokens += usage.outputTokens - reservedTokens
      u.reservedOutputTokens = Math.max(0, (u.reservedOutputTokens ?? 0) - reservedTokens)
      save()
    }
    return {
      snapshot(): UncappedUsage {
        return { ...ledger.usage, inputTokens: ledger.usage.inputTokens ?? 0, reservedOutputTokens: ledger.usage.reservedOutputTokens ?? 0 }
      },
      async reserveModel(): Promise<number> {
        // uncapped 主路径是 reserveModelUpTo；此处按单次输出上限预留（接口完备性兜底）
        return reserveUpTo((ledger.limits as UncappedLimits).maxOutputTokens)
      },
      async settleModel(reservedTokens: number, actualTokens: number): Promise<void> {
        // uncapped 主路径是 settleModelUsage；此映射仅兜底（输入未知按 0 入账，不伪装 UNKNOWN 快照）
        return settleUsage(reservedTokens, { inputTokens: 0, outputTokens: actualTokens })
      },
      reserveModelUpTo: reserveUpTo,
      settleModelUsage: settleUsage,
      async reserveTool(units: number): Promise<void> {
        const u = ledger.usage
        u.toolCalls += 1
        u.resourceUnits += units
        save()
      },
      async release(activeMs: number): Promise<void> {
        ledger.usage.activeMs += Math.max(0, Math.round(activeMs))
        ledger.active = false
        save()
      },
    }
  }

  private finiteLease(taskId: string): BudgetLease {
    const ledger = this.require(taskId)
    if (ledger.policy !== 'finite') throw new RuntimeFault('CONFIGURATION_CHANGED')
    const limits = ledger.limits as Limits
    const save = () => this.persist()
    return {
      snapshot(): Usage {
        return { ...ledger.usage }
      },
      async reserveModel(): Promise<number> {
        const u = ledger.usage
        if (limits.modelCalls > 0 && u.modelCalls >= limits.modelCalls) throw new RuntimeFault('BUDGET_EXHAUSTED')
        u.modelCalls += 1
        u.resourceUnits += 1
        save()
        return limits.outputTokens > 0 ? Math.max(0, limits.outputTokens - u.outputTokens) : Number.MAX_SAFE_INTEGER
      },
      async reserveModelUpTo(maximumTokens: number): Promise<number> {
        const u = ledger.usage
        if (limits.outputTokens > 0) {
          const remaining = Math.max(0, limits.outputTokens - u.outputTokens)
          if (remaining <= 0) throw new RuntimeFault('BUDGET_EXHAUSTED')
          const n = Math.min(maximumTokens, remaining)
          u.modelCalls += 1
          u.resourceUnits += 1
          u.outputTokens += n
          u.reservedOutputTokens = (u.reservedOutputTokens ?? 0) + n
          save()
          return n
        }
        u.modelCalls += 1
        u.resourceUnits += 1
        save()
        return maximumTokens
      },
      async settleModel(reservedTokens: number, actualTokens: number): Promise<void> {
        const u = ledger.usage
        u.outputTokens += actualTokens - reservedTokens
        u.reservedOutputTokens = Math.max(0, (u.reservedOutputTokens ?? 0) - reservedTokens)
        save()
      },
      async reserveTool(units: number): Promise<void> {
        const u = ledger.usage
        if (limits.toolCalls > 0 && u.toolCalls >= limits.toolCalls) throw new RuntimeFault('BUDGET_EXHAUSTED')
        u.toolCalls += 1
        u.resourceUnits += units
        save()
      },
      async release(activeMs: number): Promise<void> {
        ledger.usage.activeMs += Math.max(0, Math.round(activeMs))
        ledger.active = false
        save()
      },
    }
  }
}
