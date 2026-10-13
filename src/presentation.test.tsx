import { render, screen, within, fireEvent, waitFor, act } from '@testing-library/react'
import { vi, afterEach } from 'vitest'
import App from './App'
import type { ActionItemView, BoardView, ProjectSummary, ReportRecord } from './data'

/* ---- M7 S15 汇报模式（契约 2.18 验收全项）---- */

// 失败也不泄漏 fake timers / 全局桩（否则连锁污染后续用例）
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const NOW = '2026-10-13T09:00:00.000Z'

function report(id: number, over: Partial<ReportRecord> = {}): ReportRecord {
  return { id, projectId: 'p1', slug: `r${id}`, filename: `报告${id}.md`, status: 'done', error: null, importedAt: NOW, updatedAt: NOW, ...over }
}

function item(id: string, over: Partial<ActionItemView> = {}): ActionItemView {
  return {
    id,
    projectId: 'p1',
    reportId: 1,
    sourceKind: 'extracted',
    title: `行动项 ${id}`,
    rationale: '依据',
    scene: null,
    lifecycle: null,
    expectedImpact: '效果',
    metricRef: null,
    priority: 'medium',
    effort: 'medium',
    confidence: 0.55,
    evidence: { facts: [], level: '逻辑推断', reasoning: '推导' },
    evidenceLevel: '逻辑推断',
    status: 'suggested',
    dismissedReason: null,
    decidedBy: null,
    decidedAt: null,
    decidedVia: null,
    createdAt: NOW,
    updatedAt: NOW,
    tasks: [],
    ...over,
  }
}

const summaryP1: ProjectSummary = {
  id: 'p1',
  title: '会员运营',
  purpose: '复购提升',
  createdAt: NOW,
  updatedAt: NOW,
  actionCounts: { suggested: 5, adopted: 1, dismissed: 1, manual: 0 },
  lastActivity: NOW,
}

const presItems: ActionItemView[] = [
  item('a1', {
    title: '高优数据级（中置信）',
    priority: 'high',
    confidence: 0.75,
    evidenceLevel: '数据支撑',
    evidence: { facts: [{ text: '复购下滑', quote: '会员复购率由 12% 降至 9%' }], level: '数据支撑', reasoning: 'r1' },
    createdAt: '2026-10-13T08:00:00.000Z',
  }),
  item('a2', {
    title: '高优逻辑级（低置信）',
    priority: 'high',
    confidence: 0.55,
    evidenceLevel: '逻辑推断',
    createdAt: '2026-10-13T08:30:00.000Z',
  }),
  item('a3', {
    title: '中优数据级（高置信）',
    priority: 'medium',
    confidence: 0.94,
    evidenceLevel: '数据支撑',
    createdAt: '2026-10-13T07:00:00.000Z',
  }),
  item('a4', {
    title: '中优多源（0.8）',
    priority: 'medium',
    confidence: 0.8,
    evidenceLevel: '多源佐证',
    createdAt: '2026-10-13T07:30:00.000Z',
  }),
  item('a5', {
    title: '低优经验',
    priority: 'low',
    confidence: 0.3,
    evidenceLevel: '经验假设',
    createdAt: '2026-10-13T06:00:00.000Z',
  }),
  item('a6', {
    title: '已采纳项',
    status: 'adopted',
    decidedBy: '老板',
    decidedAt: NOW,
    decidedVia: 'board',
    priority: 'medium',
  }),
  item('a7', {
    title: '已驳回项（飞书）',
    status: 'dismissed',
    dismissedReason: '与大盘趋势不符且历史数据不支持该方向',
    decidedAt: NOW,
    decidedVia: 'card',
  }),
  item('a8', {
    title: '人工补充项',
    sourceKind: 'manual',
    reportId: null,
    confidence: null,
    evidenceLevel: '经验假设',
    evidence: { facts: [], level: '经验假设', reasoning: '一线经验' },
  }),
]

const presView: BoardView = {
  title: '决策看板',
  lede: '',
  project: { id: 'p1', title: '会员运营', purpose: '复购提升' },
  reports: [report(1), report(2)],
  actionItems: presItems,
  stats: { suggested: 5, adopted: 1, dismissed: 1, manual: 1 },
  notify: { configured: false },
  modelChain: { available: true, providers: [] },
  isDemo: false,
}

function jsonRes(body: unknown, ok = true) {
  return { ok, json: () => Promise.resolve(body) }
}

function enterMode() {
  fireEvent.click(screen.getByRole('button', { name: '汇报模式' }))
  const mode = screen.getByRole('region', { name: '汇报模式' })
  return { mode, ui: within(mode) }
}

test('S15 入口与容器：按钮进入 / P 键等效；容器 role=region；Esc 关闭焦点回入口按钮', () => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no backend'))))
  const { unmount } = render(<App projects={[summaryP1]} data={presView} />)
  const entry = screen.getByRole('button', { name: '汇报模式' })

  // P 键进入（工作台、无输入焦点）
  fireEvent.keyDown(document, { key: 'p' })
  expect(screen.getByRole('region', { name: '汇报模式' })).toBeInTheDocument()

  // Esc 退出 → 焦点回入口（M7-US9）
  fireEvent.keyDown(screen.getByRole('region', { name: '汇报模式' }), { key: 'Escape' })
  expect(screen.queryByRole('region', { name: '汇报模式' })).not.toBeInTheDocument()
  expect(entry).toHaveFocus()

  // 按钮进入
  fireEvent.click(entry)
  expect(screen.getByRole('region', { name: '汇报模式' })).toBeInTheDocument()
  unmount()
  vi.unstubAllGlobals()
})

test('S15 P 键：输入焦点时不触发；无项目空态无入口按钮', () => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no backend'))))
  const { unmount } = render(<App projects={[summaryP1]} data={presView} />)
  const filterNote = screen.getByText('证据等级由提取模型自评，未做真实数据重验证')
  void filterNote
  // 汇总统计行可见（工作台在）
  expect(screen.getByText(/共 2 份报告/)).toBeInTheDocument()

  // 输入焦点时 P 不触发（借过滤器补充建议表单输入）
  fireEvent.click(screen.getByRole('button', { name: '补充建议' }))
  const titleInput = screen.getByLabelText('标题 *')
  fireEvent.focus(titleInput)
  Object.defineProperty(document, 'activeElement', { get: () => titleInput, configurable: true })
  fireEvent.keyDown(document, { key: 'p' })
  expect(screen.queryByRole('region', { name: '汇报模式' })).not.toBeInTheDocument()
  // 删除实例属性还原原型 getter——不还原会永久遮蔽 jsdom 焦点读数，污染后续用例的焦点断言
  delete (document as { activeElement?: Element }).activeElement
  fireEvent.keyDown(document, { key: 'Escape' }) // 收起表单
  unmount()

  // 无项目空态：无「汇报模式」入口（G4'：引导卡只有新建+运行详情）
  const { unmount: unmount2 } = render(<App projects={[]} />)
  expect(screen.queryByRole('button', { name: '汇报模式' })).not.toBeInTheDocument()
  unmount2()
  vi.unstubAllGlobals()
})

test('S15 汇总页：大字统计（报告/建议/高优/已采纳口径）+ 证据分布条图例计数（四级夹具）', () => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no backend'))))
  render(<App projects={[summaryP1]} data={presView} />)
  const { ui } = enterMode()

  // 统计口径：N=报告 2、X=suggested 6（a1-a5+a8）、Y=suggested 且 high 2、Z=adopted 1
  const nums = ui.getAllByText(/^\d+$/, { selector: '.stat-num' }).map((el) => el.textContent)
  expect(nums).toEqual(['2', '6', '2', '1'])

  // 图例（待拍板范围 5 条：数据支撑 2 · 多源佐证 1 · 逻辑推断 1 · 经验假设 0——a8 人工项不在 suggested? a8 是 suggested！
  // a8 manual suggested → 待拍板含 a8（经验假设 +1）→ 5 条 = 数据2+多源1+逻辑1+经验1
  expect(ui.getByText('数据支撑 2')).toBeInTheDocument()
  expect(ui.getByText('多源佐证 1')).toBeInTheDocument()
  expect(ui.getByText('逻辑推断 1')).toBeInTheDocument()
  expect(ui.getByText('经验假设 2')).toBeInTheDocument() // a5 低优经验 + a8 人工（均 suggested）

  // 底部提示行逐字
  expect(ui.getByText('← → 切换 · Esc 退出')).toBeInTheDocument()
  vi.unstubAllGlobals()
})

test('S15 议程：排序（优先级>置信度>createdAt）与直达点击进入逐项页', () => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no backend'))))
  render(<App projects={[summaryP1]} data={presView} />)
  const { ui } = enterMode()

  // 待拍板议程（6 条）：high 组 a1(0.75)>a2(0.55)；medium 组 a3(0.94)>a4(0.8)>a8(0)
  const rows = ui.getAllByRole('button', { name: /高优|中优|低优|人工/ })
  const titles = rows.map((r) => r.textContent ?? '')
  const idx = (frag: string) => titles.findIndex((t) => t.includes(frag))
  expect(idx('高优数据级（中置信）')).toBeLessThan(idx('高优逻辑级（低置信）'))
  expect(idx('中优数据级（高置信）')).toBeLessThan(idx('中优多源（0.8）'))
  expect(idx('中优多源（0.8）')).toBeLessThan(idx('人工补充项'))

  // 直达：点第 3 行（a3）→ 逐项页显示其标题与页码
  fireEvent.click(ui.getByRole('button', { name: /中优数据级（高置信）/ }))
  expect(ui.getByText('中优数据级（高置信）')).toBeInTheDocument()
  expect(ui.getByText('3 / 6')).toBeInTheDocument()
  expect(ui.getByLabelText('第 3 条，共 6 条')).toBeInTheDocument()
  vi.unstubAllGlobals()
})

test('S15 逐项页信息结构：页码+范围标签/标题/徽标行/等级 chip+置信度大数字/引用块/推导展开/预期效果/来源', () => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no backend'))))
  render(<App projects={[summaryP1]} data={presView} />)
  const { ui } = enterMode()
  fireEvent.click(ui.getByRole('button', { name: /高优数据级（中置信）/ }))

  expect(ui.getByText('高优数据级（中置信）')).toBeInTheDocument() // 标题
  expect(ui.getByText('1 / 6')).toBeInTheDocument() // 页码
  expect(ui.getByText('待拍板')).toBeInTheDocument() // 范围标签
  expect(ui.getByText('高')).toBeInTheDocument() // 优先级徽标
  expect(ui.getByText('数据支撑')).toBeInTheDocument() // 等级 chip
  expect(ui.getByText('75%')).toBeInTheDocument() // 置信度大数字
  expect(ui.getByText('置信度')).toBeInTheDocument() // 置信度小标签
  expect(ui.getByText('会员复购率由 12% 降至 9%')).toBeInTheDocument() // 引用块逐字
  expect(ui.getByText('预期效果：')).toBeInTheDocument()
  expect(ui.getByText('效果')).toBeInTheDocument()
  expect(ui.getByText('报告1.md')).toBeInTheDocument() // 来源行

  // 推导过程默认收起 → 展开
  expect(ui.queryByText('r1')).not.toBeInTheDocument()
  fireEvent.click(ui.getByRole('button', { name: /推导过程/ }))
  expect(ui.getByText('r1')).toBeInTheDocument()
  vi.unstubAllGlobals()
})

test('S15 全键位：←/→/Home/End/G 导航', () => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no backend'))))
  render(<App projects={[summaryP1]} data={presView} />)
  const { mode, ui } = enterMode()
  fireEvent.click(ui.getByRole('button', { name: /高优数据级（中置信）/ }))
  expect(ui.getByText('1 / 6')).toBeInTheDocument()

  fireEvent.keyDown(mode, { key: 'ArrowRight' })
  expect(ui.getByText('2 / 6')).toBeInTheDocument()
  fireEvent.keyDown(mode, { key: 'End' })
  expect(ui.getByText('6 / 6')).toBeInTheDocument()
  fireEvent.keyDown(mode, { key: 'ArrowRight' })
  expect(ui.getByText('6 / 6')).toBeInTheDocument() // 末条不越界
  fireEvent.keyDown(mode, { key: 'Home' })
  expect(ui.getByText('1 / 6')).toBeInTheDocument()
  fireEvent.keyDown(mode, { key: 'ArrowLeft' })
  expect(ui.getByText('1 / 6')).toBeInTheDocument() // 首条不越界
  fireEvent.keyDown(mode, { key: 'g' })
  expect(ui.getByText('← → 切换 · Esc 退出')).toBeInTheDocument() // 回汇总
  vi.unstubAllGlobals()
})

test('S15 A 采纳：乐观留痕 + 800ms 自动前进（fake timers）；PATCH via=board', async () => {
  // shouldAdvanceTime：让 RTL findBy/waitFor 的内部定时器在假时钟下仍可推进
  vi.useFakeTimers({ shouldAdvanceTime: true })
  const adopted = { ...presItems[0], status: 'adopted' as const, decidedAt: NOW, decidedVia: 'board' }
  const calls: Array<{ url: string; method: string; body?: unknown }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      if (method === 'PATCH' && url.includes('/api/actions/a1')) return Promise.resolve(jsonRes(adopted))
      return Promise.resolve(jsonRes(presView))
    }),
  )
  render(<App projects={[summaryP1]} data={presView} />)
  const { mode, ui } = enterMode()
  fireEvent.click(ui.getByRole('button', { name: /高优数据级（中置信）/ }))

  fireEvent.keyDown(mode, { key: 'a' })
  // 乐观留痕行立即出现（aria-live 区同文案，限定留痕行选择器）
  expect(ui.getByText(/已采纳 · 看板 · /, { selector: '.pres-decided' })).toBeInTheDocument()
  const patch = calls.find((c) => c.method === 'PATCH')
  expect(patch?.body).toEqual({ status: 'adopted', via: 'board' })

  // 800ms 前不前进；推进后前进到第 2 条
  expect(ui.getByText('1 / 6')).toBeInTheDocument()
  act(() => {
    vi.advanceTimersByTime(800)
  })
  await waitFor(() => expect(ui.getByText('2 / 6')).toBeInTheDocument())
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

test('S15 D 驳回：大字弹窗（dlg-lg）、逐字校验、Esc 只关弹窗不退模式、提交后前进', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  const dismissed = { ...presItems[0], status: 'dismissed' as const, dismissedReason: '不成立', decidedAt: NOW, decidedVia: 'board' }
  const calls: Array<{ body?: unknown }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ body: init?.body ? JSON.parse(String(init.body)) : undefined })
      if (url.includes('/api/actions/a1')) return Promise.resolve(jsonRes(dismissed))
      return Promise.resolve(jsonRes(presView))
    }),
  )
  render(<App projects={[summaryP1]} data={presView} />)
  const { mode, ui } = enterMode()
  fireEvent.click(ui.getByRole('button', { name: /高优数据级（中置信）/ }))

  fireEvent.keyDown(mode, { key: 'd' })
  const dialog = screen.getByRole('dialog')
  expect(dialog).toHaveClass('dlg-lg') // 大字变体
  // 文件级串行下 React 焦点设置可能晚一拍（隔离运行即时生效）——等待落定，断言语义不变
  await waitFor(() => expect(screen.getByLabelText('驳回理由 *')).toHaveFocus())

  // 空理由提交 → 逐字错误
  fireEvent.click(screen.getByRole('button', { name: '确认驳回' }))
  expect(screen.getByText('请填写驳回理由（至少 2 个字）')).toBeInTheDocument()

  // Esc 只关弹窗（G1''）——模式仍在
  fireEvent(dialog, new Event('cancel', { cancelable: true }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(screen.getByRole('region', { name: '汇报模式' })).toBeInTheDocument()

  // 重开 → 填理由提交 → 留痕 + 800ms 前进
  fireEvent.click(ui.getByRole('button', { name: '驳回 (D)' }))
  fireEvent.change(screen.getByLabelText('驳回理由 *'), { target: { value: '不成立' } })
  fireEvent.click(screen.getByRole('button', { name: '确认驳回' }))
  expect(await ui.findByText(/已驳回 · 不成立/)).toBeInTheDocument()
  act(() => {
    vi.advanceTimersByTime(800)
  })
  await waitFor(() => expect(ui.getByText('2 / 6')).toBeInTheDocument())
  expect(calls.some((c) => (c.body as { dismissedReason?: string })?.dismissedReason === '不成立')).toBe(true)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

test('S15 失败停留：驳回提交失败 → aria-live 逐字、停留当前页、按钮恢复可再操作', async () => {
  // 按 URL 路由：/api/projects 必须回列表形状（畸形响应会腐蚀 ProjectNav 数据）
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/projects') return Promise.resolve(jsonRes({ projects: [summaryP1] }))
      if (url.includes('/api/actions/a1') && init?.method === 'PATCH') {
        return Promise.resolve(jsonRes({ error: 'boom' }, false))
      }
      return Promise.resolve(jsonRes(presView)) // 回滚刷新返回服务器态
    }),
  )
  render(<App projects={[summaryP1]} data={presView} />)
  const { mode, ui } = enterMode()
  fireEvent.click(ui.getByRole('button', { name: /高优数据级（中置信）/ }))
  expect(ui.getByText('1 / 6')).toBeInTheDocument()

  fireEvent.keyDown(mode, { key: 'd' })
  fireEvent.change(screen.getByLabelText('驳回理由 *'), { target: { value: '不成立的理由' } })
  fireEvent.click(screen.getByRole('button', { name: '确认驳回' }))

  expect(await ui.findByRole('alert')).toHaveTextContent('保存失败，已恢复为服务器状态')
  expect(ui.getByText('1 / 6')).toBeInTheDocument() // 停留当前页
  expect(ui.getByRole('button', { name: '驳回 (D)' })).toBeInTheDocument() // 按钮恢复（回滚为 suggested）
  vi.unstubAllGlobals()
})

test('S15 全部范围：状态分组 + 已决留痕行（G3 决议格式）只读无操作钮', () => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no backend'))))
  render(<App projects={[summaryP1]} data={presView} />)
  const { ui } = enterMode()
  fireEvent.click(ui.getByRole('button', { name: '全部' }))

  // 全部 = 5 suggested → 1 adopted → 1 dismissed → 人工 a8 在 suggested 组（共 8）
  // 议程顺序：suggested(a1,a2,a3,a4,a8) → adopted(a6) → dismissed(a7)
  const rows = ui.getAllByRole('button', { name: /高优|中优|低优|人工|已采|已驳/ })
  const texts = rows.map((r) => r.textContent ?? '')
  const idx = (frag: string) => texts.findIndex((t) => t.includes(frag))
  expect(idx('已采纳项')).toBeGreaterThan(idx('人工补充项'))
  expect(idx('已驳回项')).toBeGreaterThan(idx('已采纳项'))

  // 直达已采纳项 → 留痕行（G3 决议格式：已采纳 · 看板 · 时间），无操作钮
  fireEvent.click(ui.getByRole('button', { name: /已采纳项/ }))
  expect(ui.getByText(/已采纳 · 看板 · 10-13/)).toBeInTheDocument()
  expect(ui.queryByRole('button', { name: '采纳 (A)' })).not.toBeInTheDocument()
  expect(ui.queryByRole('button', { name: '驳回 (D)' })).not.toBeInTheDocument()

  // 已驳回项（飞书）→ 留痕行已驳回 · 理由摘要（12 字截断 + 省略号）
  fireEvent.click(ui.getByRole('button', { name: '汇总 (G)' }))
  fireEvent.click(ui.getByRole('button', { name: /已驳回项/ }))
  expect(ui.getByText(/已驳回 · 与大盘趋势不符且历史数据…/)).toBeInTheDocument()
  vi.unstubAllGlobals()
})

test('S15 人工项变体：「人工」大徽标、固定说明行逐字、无引用块', () => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no backend'))))
  render(<App projects={[summaryP1]} data={presView} />)
  const { ui } = enterMode()
  fireEvent.click(ui.getByRole('button', { name: /人工补充项/ }))
  expect(ui.getByText('人工')).toBeInTheDocument()
  expect(ui.queryByText('置信度', { selector: '.conf-caption' })).toBeNull() // 无置信度小标签（说明行「置信度派生」除外）
  expect(ui.queryByText(/^\d+%$/, { selector: '.conf-big' })).toBeNull() // 无置信度数字
  expect(ui.getByText('人工补充建议：不参与置信度派生，证据等级固定「经验假设」。')).toBeInTheDocument()
  expect(document.querySelector('.pres-quote')).toBeNull() // 无引用块
  vi.unstubAllGlobals()
})

test('S15 空议程：无待拍板项进入不阻止；逐字文案 + 查看全部切换', () => {
  const noPending: BoardView = {
    ...presView,
    actionItems: [presItems[5], presItems[6]], // 仅 adopted + dismissed
    stats: { suggested: 0, adopted: 1, dismissed: 1, manual: 0 },
  }
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no backend'))))
  render(<App projects={[summaryP1]} data={noPending} />)
  const { ui } = enterMode() // 不阻止进入（复盘仍可用）

  expect(ui.getByText('当前没有待拍板的建议')).toBeInTheDocument()
  fireEvent.click(ui.getByRole('button', { name: '查看全部' }))
  expect(ui.getByRole('button', { name: /已采纳项/ })).toBeInTheDocument() // 全部范围有议程
  vi.unstubAllGlobals()
})

test('S15 工作台零侵入：模式打开与退出后工作台用例仍全绿（回归）', () => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no backend'))))
  render(<App projects={[summaryP1]} data={presView} />)
  // 工作台常态断言
  expect(screen.getByRole('heading', { level: 1, name: '会员运营' })).toBeInTheDocument()
  expect(screen.getByText(/共 2 份报告/)).toBeInTheDocument()

  const { mode } = enterMode()
  // 工作台 DOM 不被覆盖层销毁（零侵入：负面用例 11）
  expect(screen.getByRole('heading', { level: 1, name: '会员运营' })).toBeInTheDocument()
  fireEvent.keyDown(mode, { key: 'Escape' })
  expect(screen.queryByRole('region', { name: '汇报模式' })).not.toBeInTheDocument()

  // 退出后工作台完全恢复
  expect(screen.getByRole('heading', { level: 1, name: '会员运营' })).toBeInTheDocument()
  expect(screen.getByText(/共 2 份报告/)).toBeInTheDocument()
  expect(screen.getAllByRole('article').length).toBeGreaterThan(0)
  vi.unstubAllGlobals()
})

test('S15 采纳失败：停留当前页、逐字 alert、按钮恢复、回看无假留痕（REVIEW B1）', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/projects') return Promise.resolve(jsonRes({ projects: [summaryP1] }))
      if (url.includes('/api/actions/a1') && init?.method === 'PATCH') {
        return Promise.resolve(jsonRes({ error: 'boom' }, false))
      }
      return Promise.resolve(jsonRes(presView))
    }),
  )
  render(<App projects={[summaryP1]} data={presView} />)
  const { mode, ui } = enterMode()
  fireEvent.click(ui.getByRole('button', { name: /高优数据级（中置信）/ }))
  expect(ui.getByText('1 / 6')).toBeInTheDocument()

  fireEvent.keyDown(mode, { key: 'a' })
  // 失败：逐字播报（模式内 alert）+ 停留当前页 + 采纳钮恢复
  expect(await ui.findByRole('alert')).toHaveTextContent('保存失败，已恢复为服务器状态')
  expect(ui.getByText('1 / 6')).toBeInTheDocument()
  expect(ui.getByRole('button', { name: '采纳 (A)' })).toBeInTheDocument()
  expect(ui.queryByText(/已采纳 · 看板 · /, { selector: '.pres-decided' })).not.toBeInTheDocument()
  expect(mode).toHaveFocus() // 指针采纳失败后键盘流仍在（焦点回容器）
})

test('S15 拍板后焦点回容器：指针采纳与驳回确认成功后键盘流/Esc 仍可用（REVIEW B2）', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  const adopted = { ...presItems[0], status: 'adopted' as const, decidedAt: NOW, decidedVia: 'board' }
  const dismissed = { ...presItems[1], status: 'dismissed' as const, dismissedReason: '不成立', decidedAt: NOW, decidedVia: 'board' }
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/api/actions/a1') && init?.method === 'PATCH') return Promise.resolve(jsonRes(adopted))
      if (url.includes('/api/actions/a2') && init?.method === 'PATCH') return Promise.resolve(jsonRes(dismissed))
      if (url === '/api/projects') return Promise.resolve(jsonRes({ projects: [summaryP1] }))
      return Promise.resolve(jsonRes(presView))
    }),
  )
  render(<App projects={[summaryP1]} data={presView} />)
  const { mode, ui } = enterMode()
  fireEvent.click(ui.getByRole('button', { name: /高优数据级（中置信）/ }))

  // 指针采纳：按钮卸载后焦点必须回到容器（否则键盘流与 Esc 全断）
  fireEvent.click(ui.getByRole('button', { name: '采纳 (A)' }))
  await waitFor(() => expect(mode).toHaveFocus())
  act(() => {
    vi.advanceTimersByTime(800)
  })
  await waitFor(() => expect(ui.getByText('2 / 6')).toBeInTheDocument())

  // 驳回确认成功（弹窗关闭焦点归还落空路径）：焦点同样回容器
  fireEvent.keyDown(mode, { key: 'd' })
  fireEvent.change(screen.getByLabelText('驳回理由 *'), { target: { value: '不成立' } })
  fireEvent.click(screen.getByRole('button', { name: '确认驳回' }))
  await waitFor(() => expect(mode).toHaveFocus())
  act(() => {
    vi.advanceTimersByTime(800)
  })
  await waitFor(() => expect(ui.getByText('3 / 6')).toBeInTheDocument())

  // Esc 仍可退出（唯一退出通道）
  fireEvent.keyDown(mode, { key: 'Escape' })
  expect(screen.queryByRole('region', { name: '汇报模式' })).not.toBeInTheDocument()
})
