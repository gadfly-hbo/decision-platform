import { useEffect, useState } from 'react'
import './App.css'
import { sortConclusions } from './data'
import type { ActionStatus, DashboardData } from './data'
import { useDashboardData } from './useDashboardData'
import { useActionStore } from './useActionStore'
import { ConclusionCard } from './components/ConclusionCard'
import { ActionSummary } from './components/ActionSummary'

export interface AppProps {
  /** 数据边界缝：注入即直接使用（测试/嵌入），不拉取后端；缺省从 /api/dashboard 拉取 */
  data?: DashboardData
}

export default function App({ data: injected }: AppProps = {}) {
  const data = useDashboardData(injected)
  const { store: actionState, setAction, error: actionError } = useActionStore()
  const conclusions = sortConclusions(data.conclusions)
  const metricById = new Map(data.metrics.map((metric) => [metric.id, metric]))
  const seriesById = new Map(data.series.map((series) => [series.metricId, series]))
  const [expandedIds, setExpandedIds] = useState<Set<string>>(
    () => new Set(conclusions.length > 0 ? [conclusions[0].id] : []),
  )

  // 数据源切换（演示回退 → 真实计算）时，展开态按新数据重置
  const dataKey = data.period ?? data.window
  useEffect(() => {
    setExpandedIds(new Set(conclusions.length > 0 ? [conclusions[0].id] : []))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataKey])

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

  // 行动变更：附带行动文本/结论维度/期次入库，供跨周对照展示
  const handleAction = (actionId: string, patch: { status: ActionStatus; executedNote?: string }) => {
    const conclusion = conclusions.find((c) => c.actions.some((a) => a.id === actionId))
    const action = conclusion?.actions.find((a) => a.id === actionId)
    // 演示回退（无期次）不落库：避免空 period 记录永久混入对照块（REVIEW cycle 3）
    setAction(
      actionId,
      {
        ...patch,
        ...(action ? { text: action.text } : {}),
        ...(conclusion?.dimension ? { dimension: conclusion.dimension } : {}),
        ...(data.period ? { period: data.period } : {}),
      },
      Boolean(data.period),
    )
  }

  return (
    <main className="app">
      <header className="overview">
        <h1 className="page-title">{data.title}</h1>
        <p className="overview-lede">{data.lede}</p>
        <p className="overview-meta">
          数据窗口 {data.window} · 更新于 {data.updatedAt}
          {data.historyCount !== undefined && ` · 已累积 ${data.historyCount} 期`}
          {data.historyCount === 1 && '（累积 ≥2 期周报后展示趋势）'}
          {data.isDemo && <span className="chip demo-chip">演示数据</span>}
          {data.notify &&
            (data.notify.configured ? (
              data.notify.lastPushedPeriod ? (
                <span className="chip notify-chip">已推送 · {data.notify.lastPushedPeriod}</span>
              ) : (
                <span className="chip notify-chip warn">已配置 · 未推送</span>
              )
            ) : (
              <span className="chip notify-chip warn">推送未配置</span>
            ))}
        </p>
      </header>
      {conclusions.length === 0 ? (
        <div className="empty">
          <p className="empty-title">暂无需要拍板的结论</p>
          <p className="empty-hint">
            数据窗口内未触发任何规则；将最新周报 CSV 放入 data/raw/ 后刷新即可。
          </p>
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
                  actionState={actionState}
                  onActionAction={handleAction}
                />
              </li>
            ))}
          </ol>
        </section>
      )}
      {actionError && (
        <p className="action-error" role="alert">
          行动状态保存失败，已恢复为服务器状态
        </p>
      )}
      <ActionSummary
        conclusions={conclusions}
        actionState={actionState}
        onActionAction={handleAction}
        actionReview={data.actionReview}
      />
    </main>
  )
}
