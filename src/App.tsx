import { useMemo, useState } from 'react'
import './App.css'
import { demoData, sortConclusions } from './data'
import type { ActionStatus, DashboardData } from './data'
import { ConclusionCard } from './components/ConclusionCard'
import { ActionSummary } from './components/ActionSummary'

export interface AppProps {
  /** 数据边界缝：默认演示数据；M2 接真实数据源时由此替换 */
  data?: DashboardData
}

const initialActionStatus = (data: DashboardData): Record<string, ActionStatus> =>
  Object.fromEntries(
    data.conclusions.flatMap((conclusion) =>
      conclusion.actions.map((action) => [action.id, 'pending' as ActionStatus]),
    ),
  )

export default function App({ data = demoData }: AppProps) {
  const conclusions = sortConclusions(data.conclusions)
  const metricById = useMemo(() => new Map(data.metrics.map((metric) => [metric.id, metric])), [data])
  const seriesById = useMemo(
    () => new Map(data.series.map((series) => [series.metricId, series])),
    [data],
  )
  const [expandedIds, setExpandedIds] = useState<Set<string>>(
    () => new Set(conclusions.length > 0 ? [conclusions[0].id] : []),
  )
  const [actionStatus, setActionStatus] = useState<Record<string, ActionStatus>>(() =>
    initialActionStatus(data),
  )

  const toggle = (id: string) =>
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })

  const setActionStatusOf = (actionId: string, status: ActionStatus) =>
    setActionStatus((prev) => ({ ...prev, [actionId]: status }))

  return (
    <main className="app">
      <header className="overview">
        <h1 className="page-title">{data.title}</h1>
        <p className="overview-lede">{data.lede}</p>
        <p className="overview-meta">
          数据窗口 {data.window} · 更新于 {data.updatedAt}
        </p>
      </header>
      {conclusions.length === 0 ? (
        <div className="empty">
          <p className="empty-title">暂无需要拍板的结论</p>
          <p className="empty-hint">数据窗口内未触发任何规则；接入真实数据源后此处将给出下一次分析的结论。</p>
        </div>
      ) : (
        <section aria-label="结论区">
          <ol className="conclusion-list">
            {conclusions.map((conclusion) => (
              <li key={conclusion.id}>
                <ConclusionCard
                  conclusion={conclusion}
                  expanded={expandedIds.has(conclusion.id)}
                  onToggle={() => toggle(conclusion.id)}
                  metricFor={(id) => metricById.get(id)}
                  seriesFor={(id) => seriesById.get(id)}
                  actionStatus={actionStatus}
                  onActionStatusChange={setActionStatusOf}
                />
              </li>
            ))}
          </ol>
        </section>
      )}
      <ActionSummary
        conclusions={conclusions}
        actionStatus={actionStatus}
        onActionStatusChange={setActionStatusOf}
      />
    </main>
  )
}
