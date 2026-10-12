import { useEffect, useState } from 'react'
import type { BoardView } from '../data'

export interface AgentUsageResponse {
  available: boolean
  totals?: {
    modelCalls: number
    inputTokens: number
    outputTokens: number
    activeMs: number
    toolCalls: number
    resourceUnits: number
  }
}

export interface AgentEventEntry {
  at: string
  kind: 'start' | 'success' | 'failed'
  reason?: string
  model: string
  report: string
}

export const EMPTY_TIMELINE_TEXT = '暂无抽取事件——放入新报告后此处显示。'

const KIND_LABELS: Record<AgentEventEntry['kind'], string> = {
  start: '抽取开始',
  success: '抽取成功',
  failed: '抽取失败',
}

/** 时间（HH:mm:ss）展示口径 */
function formatClock(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

interface RunDrawerProps {
  modelChain: BoardView['modelChain']
  onClose(): void
}

/**
 * S-R 右栏「运行详情」抽屉（契约 2.16）：模型链状态 + 任务账本用量 chips + 抽取事件时间线。
 * 非模态（无遮罩、不圈焦点）；打开时拉取账本/审计投影；默认收起由 S1 开关控制（App 不渲染即收起）。
 */
export function RunDrawer({ modelChain, onClose }: RunDrawerProps) {
  const [usage, setUsage] = useState<AgentUsageResponse | null>(null)
  const [events, setEvents] = useState<AgentEventEntry[] | null>(null)

  useEffect(() => {
    let cancelled = false
    setUsage(null)
    setEvents(null)
    fetch('/api/agent/usage')
      .then((res) => (res.ok ? (res.json() as Promise<AgentUsageResponse>) : { available: false }))
      .then((data) => {
        if (!cancelled) setUsage(data)
      })
      .catch(() => {
        if (!cancelled) setUsage({ available: false })
      })
    fetch('/api/agent/events')
      .then((res) => (res.ok ? (res.json() as Promise<{ events: AgentEventEntry[] }>) : { events: [] }))
      .then((data) => {
        if (!cancelled) setEvents(data.events)
      })
      .catch(() => {
        if (!cancelled) setEvents([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  const totals = usage?.available ? usage.totals : undefined

  return (
    <aside className="run-drawer" id="run-drawer" aria-label="运行详情">
      <div className="run-drawer-head">
        <h2 className="run-drawer-title">运行详情</h2>
        <button type="button" onClick={onClose}>
          关闭
        </button>
      </div>
      <section className="run-drawer-section" aria-label="模型链">
        <h3 className="run-section-title">模型链</h3>
        {modelChain.providers.map((provider) => (
          <p key={`${provider.role}-${provider.modelId}`} className="model-chain-row">
            <span className="model-role">{provider.role}</span>
            <span className="model-name">{provider.modelId}</span>
            <span className={`chip key-chip ${provider.keyReady ? 'kc-ready' : 'kc-missing'}`}>
              {provider.keyReady ? '就绪' : '未配置'}
            </span>
          </p>
        ))}
      </section>
      <section className="run-drawer-section" aria-label="任务账本用量">
        <h3 className="run-section-title">任务账本用量</h3>
        <div className="drawer-stats">
          <span className="chip stat-chip">模型调用 {totals ? totals.modelCalls : '—'}</span>
          <span className="chip stat-chip">token 入 {totals ? totals.inputTokens : '—'}</span>
          <span className="chip stat-chip">token 出 {totals ? totals.outputTokens : '—'}</span>
          <span className="chip stat-chip">用时 {totals ? `${Math.round(totals.activeMs / 1000)}s` : '—'}</span>
        </div>
      </section>
      <section className="run-drawer-section" aria-label="抽取事件">
        <h3 className="run-section-title">抽取事件</h3>
        {events !== null && events.length === 0 && <p className="empty-lite">{EMPTY_TIMELINE_TEXT}</p>}
        {events !== null && events.length > 0 && (
          <ul className="timeline">
            {events.map((event, index) => (
              <li key={`${event.at}-${index}`} className={`timeline-row tl-${event.kind}`}>
                <span className="timeline-time">{formatClock(event.at)}</span>
                <span className="timeline-kind">{KIND_LABELS[event.kind]}</span>
                <span className="timeline-report">{event.report}</span>
                {event.kind === 'failed' && event.reason && <span className="timeline-reason">{event.reason}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  )
}
