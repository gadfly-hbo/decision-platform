import { render, screen, within, fireEvent, waitFor } from '@testing-library/react'
import { vi } from 'vitest'
import App from './App'
import type { ActionItemView, BoardView, ProjectSummary, ReportRecord } from './data'

/* ---- 测试夹具（注入 data 缝，不拉取后端）---- */

const NOW = '2026-10-12T09:00:00.000Z'

function report(id: number, over: Partial<ReportRecord> = {}): ReportRecord {
  return { id, projectId: 'p1', slug: `r${id}`, filename: `会员周报${id}.md`, status: 'done', error: null, importedAt: NOW, updatedAt: NOW, ...over }
}

function item(id: string, over: Partial<ActionItemView> = {}): ActionItemView {
  return {
    id,
    projectId: 'p1',
    reportId: 1,
    sourceKind: 'extracted',
    title: `行动项 ${id}`,
    rationale: '报告建议依据',
    scene: null,
    lifecycle: null,
    expectedImpact: '预期效果正文',
    metricRef: null,
    priority: 'medium',
    effort: 'medium',
    confidence: 0.55,
    evidence: { facts: [], level: '逻辑推断', reasoning: '推导过程正文' },
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

const items: ActionItemView[] = [
  item('a1', {
    title: '对沉睡会员发放阶梯券',
    priority: 'high',
    effort: 'low',
    confidence: 0.92,
    scene: '日常',
    lifecycle: 'R复购',
    evidence: {
      facts: [{ text: '复购率连续四周下滑。', quote: '会员复购率由 12% 降至 9%' }],
      level: '数据支撑',
      reasoning: '报告数据直接给出复购率降幅。',
    },
    evidenceLevel: '数据支撑',
  }),
  item('a2', { title: '自播开播时间错峰调整', confidence: 0.55, evidenceLevel: '逻辑推断' }),
  item('a3', {
    title: '上线会员日活动',
    sourceKind: 'manual',
    reportId: null,
    confidence: null,
    rationale: '一线观察周末客流高',
    evidence: { facts: [], level: '经验假设', reasoning: '一线观察周末客流高' },
    evidenceLevel: '经验假设',
  }),
  item('a4', {
    reportId: 2,
    title: '调整渠道预算',
    status: 'dismissed',
    dismissedReason: '卡片驳回（未填理由）',
    decidedBy: '审批人',
    decidedAt: NOW,
    decidedVia: 'card',
  }),
  item('a5', {
    reportId: 2,
    title: '回滚落地页实验',
    status: 'adopted',
    decidedBy: '老板',
    decidedAt: NOW,
    decidedVia: 'board',
    tasks: [
      {
        id: 't-a5',
        actionItemId: 'a5',
        title: '核查西南加盟数据',
        owner: '店长',
        dueDate: '2026-10-18',
        status: 'todo',
        priority: 'high',
        note: '重点核对',
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
  }),
]

const baseView: BoardView = {
  title: '决策看板',
  lede: '报告驱动的行动闭环：从分析报告提取决策建议，确认后拆解任务、执行后回录反馈，证据可展开核查。',
  project: { id: 'p1', title: '会员运营', purpose: '复购提升' },
  reports: [report(1), report(2), report(3, { status: 'pending' })],
  actionItems: items,
  stats: { suggested: 3, adopted: 1, dismissed: 1, manual: 1 },
  notify: { configured: false },
  modelChain: { available: true, providers: [] },
  isDemo: false,
}

const cards = () => screen.getAllByRole('article')
const cardOf = (title: string | RegExp): HTMLElement => {
  const found = cards().find((card) => within(card).queryByText(title))
  if (!found) throw new Error(`未找到卡片：${title}`)
  return found
}

function jsonRes(body: unknown, ok = true) {
  return { ok, json: () => Promise.resolve(body) }
}

/** 按路由前缀分发的 fetch stub；PATCH/POST 记录入 calls */
function stubFetch(handlers: Array<{ match: (url: string, method: string) => boolean; respond: (body: unknown, url: string, init?: RequestInit) => unknown }>) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = []
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ url, method, body })
    for (const handler of handlers) {
      if (handler.match(url, method)) {
        const result = handler.respond(body, url, init)
        return result instanceof Promise ? result : Promise.resolve(result)
      }
    }
    return Promise.reject(new Error(`unexpected fetch: ${method} ${url}`))
  })
  vi.stubGlobal('fetch', fetchMock)
  return { fetchMock, calls }
}

/* ---- 三栏 shell ---- */

test('三栏渲染：主区 DOM 在侧栏之前；运行详情开关 aria-expanded 语义', () => {
  // 抽屉打开会拉取账本/事件投影，stub 掉避免真实请求
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no backend'))))
  render(<App data={baseView} />)
  const main = screen.getByRole('main')
  const nav = screen.getByRole('navigation', { name: '项目导航' })
  // G13：DOM 顺序 = main → aside S-L → aside S-R（视觉列位由 grid 控制）
  expect(main.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  const toggle = screen.getByRole('button', { name: '运行详情' })
  expect(toggle).toHaveAttribute('aria-expanded', 'false')
  expect(screen.queryByRole('complementary', { name: '运行详情' })).not.toBeInTheDocument()
  fireEvent.click(toggle)
  expect(toggle).toHaveAttribute('aria-expanded', 'true')
  const drawer = screen.getByRole('complementary', { name: '运行详情' })
  expect(main.compareDocumentPosition(drawer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  fireEvent.click(toggle)
  expect(screen.queryByRole('complementary', { name: '运行详情' })).not.toBeInTheDocument()
  vi.unstubAllGlobals()
})

test('概览头：项目名/purpose 副题/项目内统计/通知 chip（v5）', () => {
  render(<App data={baseView} />)
  expect(screen.getByRole('heading', { level: 1, name: '会员运营' })).toBeInTheDocument()
  expect(screen.getByText('复购提升')).toBeInTheDocument() // purpose 副题
  expect(screen.getByText(/共 3 份报告 · 建议 3 · 已采纳 1 · 已驳回 1 · 人工 1/)).toBeInTheDocument()
  expect(screen.queryByText(/最新报告/)).not.toBeInTheDocument() // v5 移除最新报告段
  expect(screen.getByText('推送未配置')).toBeInTheDocument()
  expect(screen.queryByText('演示数据')).not.toBeInTheDocument()
})

/* ---- S1b 报告状态条 ---- */

test('S1b：待抽取报告可点「抽取」→ 抽取中提示（aria-live）', async () => {
  const { calls } = stubFetch([
    { match: (url, m) => m === 'POST' && url.includes('/reports/extract'), respond: () => jsonRes({ results: [] }) },
    { match: (url, m) => m === 'GET' && url.includes('/api/dashboard'), respond: () => jsonRes(baseView) },
  ])
  render(<App data={baseView} />)
  fireEvent.click(screen.getByRole('button', { name: '抽取' }))
  const live = screen.getByText('正在抽取行动项，模型调用最长约 2 分钟，完成后自动刷新。')
  expect(live).toHaveAttribute('aria-live', 'polite')
  // v5：报告状态仅在 S1b 呈现（左栏为项目导航）
  expect(screen.getAllByText('抽取中')).toHaveLength(1)
  await waitFor(() => {
    const extractCall = calls.find((c) => c.url.includes('/reports/extract'))
    expect(extractCall?.body).toEqual({ slug: 'r3' })
  })
  vi.unstubAllGlobals()
})

test('S1b：抽取失败显示原因与「重试」', async () => {
  const failedView: BoardView = {
    ...baseView,
    reports: [report(1, { status: 'failed', error: '模型调用超时（120s）' })],
    actionItems: [],
    stats: { suggested: 0, adopted: 0, dismissed: 0, manual: 0 },
  }
  stubFetch([
    { match: (url, m) => m === 'POST' && url.includes('/reports/extract'), respond: () => jsonRes({ results: [] }) },
    { match: (url, m) => m === 'GET' && url.includes('/api/dashboard'), respond: () => jsonRes(failedView) },
  ])
  render(<App data={failedView} />)
  expect(screen.getAllByText('抽取失败')).toHaveLength(1)
  expect(screen.getByText('模型调用超时（120s）')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith(expect.stringContaining('/reports/extract'), expect.anything()))
  vi.unstubAllGlobals()
})

test('S1b：重新生成两段式确认（G3 删除范围提示 + force:true）', async () => {
  const { calls } = stubFetch([
    { match: (url, m) => m === 'POST' && url.includes('/reports/extract'), respond: () => jsonRes({ results: [] }) },
    { match: (url, m) => m === 'GET' && url.includes('/api/dashboard'), respond: () => jsonRes(baseView) },
  ])
  render(<App data={baseView} />)
  const reextract = screen.getAllByRole('button', { name: '重新生成' })[0]
  fireEvent.click(reextract)
  expect(screen.getByText('重新生成将删除该报告中仍处「建议」状态的行动项；已采纳/已驳回/含任务的行动项保留')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '确认重新生成' }))
  await waitFor(() => {
    const extractCall = calls.find((c) => c.url.includes('/reports/extract'))
    expect(extractCall?.body).toEqual({ slug: 'r1', force: true })
  })
  vi.unstubAllGlobals()
})

/* ---- S2/S3 行动项卡与证据 ---- */

test('行动项卡：卡头 aria-expanded 展开证据区（事实引用/推导/预期效果/警示）', () => {
  render(<App data={baseView} />)
  const card = cardOf('对沉睡会员发放阶梯券')
  const head = within(card).getByRole('button', { name: /对沉睡会员发放阶梯券/ })
  expect(head).toHaveAttribute('aria-expanded', 'false')
  expect(within(card).queryByText('推导过程')).not.toBeInTheDocument()
  fireEvent.click(head)
  expect(head).toHaveAttribute('aria-expanded', 'true')
  expect(within(card).getByText('会员复购率由 12% 降至 9%')).toBeInTheDocument() // quote 逐字
  expect(within(card).getByText('事实')).toBeInTheDocument()
  expect(within(card).getByText('推导过程')).toBeInTheDocument()
  expect(within(card).getByText('预期效果')).toBeInTheDocument()
  expect(within(card).getByText('置信度由证据派生（证据等级与原文引用决定），非模型自评。')).toBeInTheDocument()
  expect(within(card).getByText('证据等级由提取模型自评，未做真实数据重验证')).toBeInTheDocument()
})

test('四级色标 chip：数据支撑绿/逻辑推断琥珀/经验假设灰，多源佐证见于过滤器', () => {
  render(<App data={baseView} />)
  const levelChip = (card: HTMLElement, level: string) => within(card).getByText(level).closest('.chip')
  expect(levelChip(cardOf('对沉睡会员发放阶梯券'), '数据支撑')).toHaveClass('ev-data')
  expect(levelChip(cardOf('自播开播时间错峰调整'), '逻辑推断')).toHaveClass('ev-logic')
  expect(levelChip(cardOf('上线会员日活动'), '经验假设')).toHaveClass('ev-exp')
  expect(screen.getByRole('button', { name: /多源佐证/ })).toBeInTheDocument() // 四级全量可见于过滤维
})

test('人工项形态：「人工」徽标替代置信度、报告 chip「人工补充」、固定说明行', () => {
  render(<App data={baseView} />)
  const card = cardOf('上线会员日活动')
  expect(within(card).getByText('人工')).toBeInTheDocument()
  expect(within(card).queryByText(/置信度 \d+%/)).not.toBeInTheDocument()
  expect(within(card).getByText('人工补充')).toBeInTheDocument()
  fireEvent.click(within(card).getByRole('button', { name: /上线会员日活动/ }))
  expect(within(card).getByText('人工补充建议，未引用报告事实')).toBeInTheDocument()
  expect(within(card).getByText('人工补充建议：不参与置信度派生，证据等级固定「经验假设」。')).toBeInTheDocument()
  expect(within(card).queryByText('证据等级由提取模型自评，未做真实数据重验证')).not.toBeInTheDocument()
})

/* ---- S6 过滤器 ---- */

test('过滤器四维单选：状态/证据等级/优先级/报告（含计数）', () => {
  render(<App data={baseView} />)
  const group = (label: string) => screen.getByRole('group', { name: label })
  expect(within(group('状态')).getByRole('button', { name: '建议 3' })).toBeInTheDocument()
  expect(within(group('证据等级')).getByRole('button', { name: /多源佐证 0/ })).toBeInTheDocument()
  expect(within(group('优先级')).getByRole('button', { name: /高 1/ })).toBeInTheDocument()
  expect(within(group('报告')).getByRole('button', { name: /人工补充 1/ })).toBeInTheDocument()

  fireEvent.click(within(group('状态')).getByRole('button', { name: /已采纳/ }))
  expect(cards()).toHaveLength(1)
  expect(within(cardOf('回滚落地页实验')).getByText('已采纳')).toBeInTheDocument()
  // 计数基于全量行动项（各维静态计数）；已采纳 + 高优组合无命中 → 过滤空态
  fireEvent.click(within(group('优先级')).getByRole('button', { name: /高 1/ }))
  expect(screen.getByText('该过滤条件下暂无行动项')).toBeInTheDocument()
  fireEvent.click(within(group('状态')).getByRole('button', { name: /全部 5/ }))
  fireEvent.click(within(group('优先级')).getByRole('button', { name: /全部 5/ }))
  expect(cards()).toHaveLength(5)
})

test('过滤器尾注：模型自评警示逐字', () => {
  render(<App data={baseView} />)
  expect(screen.getByText('证据等级由提取模型自评，未做真实数据重验证')).toBeInTheDocument()
})

/* ---- 确认/驳回闭环 ---- */

test('采纳：乐观更新 + PATCH via=board + 留痕', async () => {
  const serverItem = { ...items[0], status: 'adopted' as const, decidedBy: null, decidedAt: '2026-10-12T10:00:00.000Z', decidedVia: 'board' }
  const { calls } = stubFetch([
    { match: (url, m) => m === 'PATCH' && url.includes(`/api/actions/${items[0].id}`), respond: () => jsonRes(serverItem) },
  ])
  render(<App data={baseView} />)
  const card = cardOf('对沉睡会员发放阶梯券')
  const adopt = within(card).getByRole('button', { name: '采纳' })
  expect(adopt).toHaveAttribute('aria-pressed', 'false')
  fireEvent.click(adopt)
  expect(adopt).toHaveAttribute('aria-pressed', 'true') // 乐观更新
  expect(within(card).getByText('已采纳')).toBeInTheDocument()
  await waitFor(() => {
    const patch = calls.find((c) => c.method === 'PATCH')
    expect(patch?.body).toEqual({ status: 'adopted', via: 'board' })
  })
  expect(within(card).getByText(/· 看板$/)).toBeInTheDocument() // 留痕含渠道
  vi.unstubAllGlobals()
})

test('驳回弹窗（S11）：打开聚焦 textarea、校验逐字错误、确认落库、焦点回驳回钮', async () => {
  const serverItem = { ...items[0], status: 'dismissed' as const, dismissedReason: '与大盘趋势不符', decidedAt: NOW, decidedVia: 'board' }
  const { calls } = stubFetch([
    { match: (url, m) => m === 'PATCH' && url.includes(`/api/actions/${items[0].id}`), respond: () => jsonRes(serverItem) },
  ])
  render(<App data={baseView} />)
  const card = cardOf('对沉睡会员发放阶梯券')
  const reject = within(card).getByRole('button', { name: '驳回' })
  fireEvent.click(reject)
  // jsdom 的 dialog.showModal 可用性受限：断言 open attribute + 显式 focus（契约 2.12 的降级验证口径）
  const dialog = screen.getByRole('dialog')
  expect(dialog).toHaveAttribute('open', '')
  expect(screen.getByLabelText('驳回理由 *')).toHaveFocus()
  expect(screen.getByText('至少 2 个字')).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: '确认驳回' }))
  expect(screen.getByRole('alert')).toHaveTextContent('请填写驳回理由（至少 2 个字）')
  expect(screen.getByLabelText('驳回理由 *')).toHaveFocus() // 校验失败焦点保持 textarea

  fireEvent.change(screen.getByLabelText('驳回理由 *'), { target: { value: '与大盘趋势不符' } })
  fireEvent.click(screen.getByRole('button', { name: '确认驳回' }))
  await waitFor(() => {
    const patch = calls.find((c) => c.method === 'PATCH')
    expect(patch?.body).toEqual({ status: 'dismissed', dismissedReason: '与大盘趋势不符', via: 'board' })
  })
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(reject).toHaveFocus() // 关闭后焦点归还驳回钮
  expect(within(card).getByText('已驳回')).toBeInTheDocument()
  vi.unstubAllGlobals()
})

test('驳回弹窗：Esc（cancel 事件）取消 = 无变更不落库', () => {
  const { calls } = stubFetch([])
  render(<App data={baseView} />)
  const card = cardOf('对沉睡会员发放阶梯券')
  const reject = within(card).getByRole('button', { name: '驳回' })
  fireEvent.click(reject)
  const dialog = screen.getByRole('dialog')
  // jsdom 不派发原生 Esc；直接派发 cancel 事件等价验证取消路径
  fireEvent(dialog, new Event('cancel', { cancelable: true }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(reject).toHaveFocus()
  expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(0)
  expect(within(card).getByText('建议')).toBeInTheDocument() // 状态未变
  vi.unstubAllGlobals()
})

test('补填理由（S12）：卡片渠道默认理由显示补填输入；看板渠道只读', async () => {
  const backfilled = { ...items[3], dismissedReason: '复购数据与大盘一致' }
  const { calls } = stubFetch([
    { match: (url, m) => m === 'PATCH' && url.includes(`/api/actions/${items[3].id}`), respond: () => jsonRes(backfilled) },
  ])
  render(<App data={baseView} />)
  const cardItem = cardOf('调整渠道预算')
  fireEvent.click(within(cardItem).getByRole('button', { name: /调整渠道预算/ }))
  expect(within(cardItem).getByText('卡片驳回（未填理由）')).toBeInTheDocument()
  const input = within(cardItem).getByLabelText('补填理由')
  fireEvent.change(input, { target: { value: '复购数据与大盘一致' } })
  fireEvent.click(within(cardItem).getByRole('button', { name: '保存' }))
  await waitFor(() => {
    const patch = calls.find((c) => c.method === 'PATCH')
    expect(patch?.body).toEqual({ backfillDismissedReason: '复购数据与大盘一致' })
  })
  await waitFor(() => expect(within(cardItem).getByText('复购数据与大盘一致')).toBeInTheDocument())

  const boardCard = cardOf('回滚落地页实验')
  fireEvent.click(within(boardCard).getByRole('button', { name: /回滚落地页实验/ }))
  expect(within(boardCard).queryByLabelText('补填理由')).not.toBeInTheDocument() // 已采纳卡无驳回理由块
  vi.unstubAllGlobals()
})

test('保存失败：role=alert 回滚服务器态', async () => {
  stubFetch([
    { match: (url, m) => m === 'PATCH' && url.includes('/api/actions/'), respond: () => jsonRes({ error: 'boom' }, false) },
    { match: (url, m) => m === 'GET' && url.endsWith('/api/projects'), respond: () => jsonRes({ projects: [summaryP1] }) },
    { match: (url, m) => m === 'GET' && url.includes('/api/projects/p1/board'), respond: () => jsonRes(baseView) },
  ])
  render(<App data={baseView} />)
  const card = cardOf('对沉睡会员发放阶梯券')
  const adopt = within(card).getByRole('button', { name: '采纳' })
  fireEvent.click(adopt)
  expect(adopt).toHaveAttribute('aria-pressed', 'true') // 乐观态
  expect(await screen.findByText('保存失败，已恢复为服务器状态')).toBeInTheDocument()
  await waitFor(() => expect(adopt).toHaveAttribute('aria-pressed', 'false')) // 回滚服务器态
  vi.unstubAllGlobals()
})

/* ---- S13 补充建议 ---- */

test('补充建议表单：必填校验 + POST /api/actions + 人工项入列', async () => {
  const created = item('m-new', {
    title: '周末门店快闪',
    rationale: '商圈人流回升',
    sourceKind: 'manual',
    reportId: null,
    confidence: null,
    evidence: { facts: [], level: '经验假设', reasoning: '商圈人流回升' },
    evidenceLevel: '经验假设',
  })
  const { calls } = stubFetch([
    { match: (url, m) => m === 'POST' && url.endsWith('/api/actions'), respond: () => jsonRes(created) },
  ])
  render(<App data={baseView} />)
  fireEvent.click(screen.getByRole('button', { name: '补充建议' }))
  fireEvent.click(screen.getByRole('button', { name: '提交' }))
  expect(screen.getByText('请填写标题')).toBeInTheDocument()
  expect(screen.getByText('请填写依据')).toBeInTheDocument()

  fireEvent.change(screen.getByLabelText('标题 *'), { target: { value: '周末门店快闪' } })
  fireEvent.change(screen.getByLabelText('依据 *'), { target: { value: '商圈人流回升' } })
  fireEvent.change(screen.getByRole('combobox', { name: '优先级' }), { target: { value: 'high' } })
  fireEvent.click(screen.getByRole('button', { name: '提交' }))
  await waitFor(() => {
    const post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/actions'))
    expect(post?.body).toMatchObject({ title: '周末门店快闪', rationale: '商圈人流回升', priority: 'high' })
  })
  await waitFor(() => expect(screen.getByText('周末门店快闪')).toBeInTheDocument())
  expect(within(cardOf('周末门店快闪')).getByText('人工')).toBeInTheDocument()
  vi.unstubAllGlobals()
})

/* ---- S8 空态 / S9 错误态 / S10 加载态 ---- */

test('报告空态：有报告且已抽取、0 行动项（区别于过滤空态）', () => {
  const emptyView: BoardView = { ...baseView, reports: [report(1)], actionItems: [], stats: { suggested: 0, adopted: 0, dismissed: 0, manual: 0 } }
  render(<App data={emptyView} />)
  expect(screen.getByText('该报告未抽取到行动项')).toBeInTheDocument()
  expect(screen.getByText('报告已解析完成，但未包含可执行建议；可尝试重新生成或检查报告内容。')).toBeInTheDocument()
  expect(screen.queryByRole('article')).not.toBeInTheDocument()
})

test('错误态（S9）：模型链不可用 → 概览头错误条 + 抽取按钮禁用', () => {
  const noKeyView: BoardView = { ...baseView, modelChain: { available: false, providers: [] } }
  render(<App data={noKeyView} />)
  expect(screen.getByText('模型服务不可用：未配置 API 密钥，无法抽取行动项。配置密钥后点击重试。')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '抽取' })).toBeDisabled()
  expect(screen.queryByText('演示数据')).not.toBeInTheDocument() // 有报告不冒充演示（G7）
})

test('加载态（S10）：首屏骨架 + aria-busy，不显示空态', () => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {}))) // 永不 resolve
  render(<App />)
  const main = screen.getByRole('main')
  expect(main).toHaveAttribute('aria-busy', 'true')
  expect(document.querySelectorAll('.skeleton-card')).toHaveLength(3)
  expect(screen.queryByText('该报告未抽取到行动项')).not.toBeInTheDocument()
  vi.unstubAllGlobals()
})

/* ---- S4 任务列表 / S5 反馈回录（T5）---- */

const adoptedA1 = {
  ...items[0],
  status: 'adopted' as const,
  decidedAt: NOW,
  decidedVia: 'board',
}

const serverTask = {
  id: 't1',
  actionItemId: 'a1',
  title: '联系渠道负责人',
  owner: '店长',
  dueDate: '2026-10-20',
  status: 'todo',
  priority: 'medium',
  note: '',
  createdAt: NOW,
  updatedAt: NOW,
}

const fb4 = { adopted: true, outcome: '已按计划执行', metricDelta: '+2.3pp', review: '有效', score: 4, updatedAt: NOW }
const fb5 = { ...fb4, score: 5, review: '二次复盘', updatedAt: NOW }

test('端到端组件流：采纳 → 添加任务 → 进行 → 完成 → 回录反馈 → 只读块 → 更新反馈覆盖', async () => {
  const { calls } = stubFetch([
    { match: (url, m) => m === 'PATCH' && url.includes(`/api/actions/${items[0].id}`), respond: () => jsonRes(adoptedA1) },
    { match: (url, m) => m === 'POST' && url.includes(`/api/actions/${items[0].id}/tasks`), respond: () => jsonRes(serverTask) },
    {
      match: (url, m) => m === 'PATCH' && url.includes('/api/tasks/t1'),
      respond: (body) => jsonRes({ ...serverTask, ...(body as Record<string, unknown>) }),
    },
    {
      match: (url, m) => m === 'POST' && url.includes('/api/tasks/t1/feedback'),
      respond: (body) => jsonRes((body as { score: number }).score === 5 ? fb5 : fb4),
    },
  ])
  render(<App data={baseView} />)
  const card = cardOf('对沉睡会员发放阶梯券')

  // suggested 展开无任务区
  fireEvent.click(within(card).getByRole('button', { name: /对沉睡会员发放阶梯券/ }))
  expect(within(card).queryByRole('region', { name: '任务' })).not.toBeInTheDocument()

  // 采纳 → 任务区出现（空态文案）
  fireEvent.click(within(card).getByRole('button', { name: '采纳' }))
  await waitFor(() => expect(within(card).getByText('已采纳')).toBeInTheDocument())
  const taskRegion = within(card).getByRole('region', { name: '任务' })
  expect(within(taskRegion).getByText('暂无任务，添加第一个执行任务')).toBeInTheDocument()

  // 添加任务：标题 + owner/截止日（可选字段填入）
  fireEvent.click(within(taskRegion).getByRole('button', { name: '添加任务' }))
  const taskForm = within(taskRegion).getByRole('form', { name: '新增任务' })
  fireEvent.change(within(taskForm).getByLabelText('标题 *'), { target: { value: '联系渠道负责人' } })
  fireEvent.change(within(taskForm).getByLabelText('负责人'), { target: { value: '店长' } })
  fireEvent.change(within(taskForm).getByLabelText('截止日'), { target: { value: '2026-10-20' } })
  fireEvent.click(within(taskForm).getByRole('button', { name: '添加任务' }))
  await waitFor(() => expect(within(taskRegion).getByText('联系渠道负责人')).toBeInTheDocument())
  expect(within(taskRegion).getByText(/负责人 店长 · 截止 2026-10-20 · 优先级 中/)).toBeInTheDocument()
  expect(within(taskRegion).getByText('（未填备注）')).toBeInTheDocument()
  await waitFor(() => {
    const post = calls.find((c) => c.method === 'POST' && c.url.includes(`/api/actions/${items[0].id}/tasks`))
    expect(post?.body).toMatchObject({ title: '联系渠道负责人', owner: '店长', dueDate: '2026-10-20', priority: 'medium' })
  })

  // 任务三态：待办（默认按下）→ 进行 → 完成
  const todo = within(taskRegion).getByRole('button', { name: '待办' })
  const doing = within(taskRegion).getByRole('button', { name: '进行' })
  const done = within(taskRegion).getByRole('button', { name: '完成' })
  expect(todo).toHaveAttribute('aria-pressed', 'true')
  expect(doing).toHaveAttribute('aria-pressed', 'false')
  fireEvent.click(doing)
  expect(doing).toHaveAttribute('aria-pressed', 'true')
  expect(todo).toHaveAttribute('aria-pressed', 'false')
  fireEvent.click(done)
  expect(done).toHaveAttribute('aria-pressed', 'true')
  await waitFor(() => {
    const patches = calls.filter((c) => c.method === 'PATCH' && c.url.includes('/api/tasks/t1'))
    expect(patches.map((p) => (p.body as { status: string }).status)).toEqual(['doing', 'done'])
  })

  // 回录反馈：必填校验 → 提交 → 只读块
  const feedbackForm = within(taskRegion).getByRole('form', { name: '反馈' })
  expect(within(feedbackForm).getByText('5=显著正向效果 · 3=无明显变化 · 1=显著负向')).toBeInTheDocument()
  fireEvent.click(within(feedbackForm).getByRole('button', { name: '提交反馈' }))
  expect(within(feedbackForm).getByText('请填写结果')).toBeInTheDocument()
  expect(within(feedbackForm).getByText('请选择评分（1-5）')).toBeInTheDocument()
  fireEvent.change(within(feedbackForm).getByLabelText('结果 *'), { target: { value: '已按计划执行' } })
  fireEvent.change(within(feedbackForm).getByLabelText('指标变化'), { target: { value: '+2.3pp' } })
  fireEvent.click(within(feedbackForm).getByRole('radio', { name: '4' }))
  fireEvent.click(within(feedbackForm).getByRole('button', { name: '提交反馈' }))
  await waitFor(() => expect(within(taskRegion).getByText('已执行 · 评分 4/5')).toBeInTheDocument())
  await waitFor(() => {
    const post = calls.find((c) => c.method === 'POST' && c.url.includes('/api/tasks/t1/feedback'))
    expect(post?.body).toMatchObject({ adopted: true, outcome: '已按计划执行', metricDelta: '+2.3pp', score: 4 })
  })

  // 更新反馈：只读块 → 表单（预填）→ 覆盖提交 → 只读块更新
  fireEvent.click(within(taskRegion).getByRole('button', { name: '更新反馈' }))
  const updateForm = within(taskRegion).getByRole('form', { name: '反馈' })
  expect((within(updateForm).getByLabelText('结果 *') as HTMLTextAreaElement).value).toBe('已按计划执行')
  expect(within(updateForm).getByRole('radio', { name: '4' })).toBeChecked()
  fireEvent.click(within(updateForm).getByRole('radio', { name: '5' }))
  fireEvent.change(within(updateForm).getByLabelText('复盘'), { target: { value: '二次复盘' } })
  fireEvent.click(within(updateForm).getByRole('button', { name: '提交反馈' }))
  await waitFor(() => expect(within(taskRegion).getByText('已执行 · 评分 5/5')).toBeInTheDocument())
  expect(within(taskRegion).queryByRole('form', { name: '反馈' })).not.toBeInTheDocument() // 互斥：只读态无表单
  vi.unstubAllGlobals()
})

test('反馈互斥：已回录任务直接呈现只读块（未执行 · 评分），无提交表单', () => {
  const withFeedback: BoardView = {
    ...baseView,
    actionItems: baseView.actionItems.map((it) =>
      it.id === 'a5'
        ? { ...it, tasks: [{ ...it.tasks[0], status: 'done' as const, feedback: { adopted: false, outcome: '未上线', metricDelta: '', review: '', score: 2, updatedAt: NOW } }] }
        : it,
    ),
  }
  render(<App data={withFeedback} />)
  const card = cardOf('回滚落地页实验')
  fireEvent.click(within(card).getByRole('button', { name: /回滚落地页实验/ }))
  expect(within(card).getByText('未执行 · 评分 2/5')).toBeInTheDocument()
  expect(within(card).queryByRole('form', { name: '反馈' })).not.toBeInTheDocument()
  expect(within(card).getByText(/更新时间 10-12 \d{2}:\d{2}/)).toBeInTheDocument() // 时区无关：只断日期段
})

test('任务编辑：行内表单预填现值，保存走 PATCH /api/tasks/:id', async () => {
  const { calls } = stubFetch([
    {
      match: (url, m) => m === 'PATCH' && url.includes('/api/tasks/t-a5'),
      respond: (body) => jsonRes({ ...items[4].tasks[0], ...(body as Record<string, unknown>) }),
    },
  ])
  render(<App data={baseView} />)
  const card = cardOf('回滚落地页实验')
  fireEvent.click(within(card).getByRole('button', { name: /回滚落地页实验/ }))
  const taskRegion = within(card).getByRole('region', { name: '任务' })
  expect(within(taskRegion).getByText('核查西南加盟数据')).toBeInTheDocument()

  fireEvent.click(within(taskRegion).getByRole('button', { name: '编辑' }))
  const editForm = within(taskRegion).getByRole('form', { name: '编辑任务' })
  expect((within(editForm).getByLabelText('标题 *') as HTMLInputElement).value).toBe('核查西南加盟数据')
  expect((within(editForm).getByLabelText('负责人') as HTMLInputElement).value).toBe('店长')
  fireEvent.change(within(editForm).getByLabelText('负责人'), { target: { value: '运营' } })
  fireEvent.click(within(editForm).getByRole('button', { name: '保存' }))
  await waitFor(() => expect(within(taskRegion).getByText(/负责人 运营/)).toBeInTheDocument())
  await waitFor(() => {
    const patch = calls.find((c) => c.method === 'PATCH' && c.url.includes('/api/tasks/t-a5'))
    expect(patch?.body).toMatchObject({ title: '核查西南加盟数据', owner: '运营', dueDate: '2026-10-18', priority: 'high' })
  })
  vi.unstubAllGlobals()
})

test('任务区仅已采纳项显示：suggested/dismissed 展开均无「任务」区', () => {
  render(<App data={baseView} />)
  fireEvent.click(within(cardOf('对沉睡会员发放阶梯券')).getByRole('button', { name: /对沉睡会员发放阶梯券/ }))
  expect(within(cardOf('对沉睡会员发放阶梯券')).queryByRole('region', { name: '任务' })).not.toBeInTheDocument()
  fireEvent.click(within(cardOf('调整渠道预算')).getByRole('button', { name: /调整渠道预算/ }))
  expect(within(cardOf('调整渠道预算')).queryByRole('region', { name: '任务' })).not.toBeInTheDocument()
})

/* ---- S1 通知 chip 四态（T6，契约 2.1）---- */

test('通知 chip 四态：未配置 / IM 已配置未推送 / 已推送 · slug / 未配置飞书 · 文本摘要推送', () => {
  const { unmount } = render(<App data={{ ...baseView, notify: { configured: false } }} />)
  const none = screen.getByText('推送未配置')
  expect(none).toHaveClass('notify-chip', 'warn')
  unmount()

  render(<App data={{ ...baseView, notify: { configured: true, imConfigured: true } }} />)
  expect(screen.getByText('已配置 · 未推送')).toHaveClass('warn')
  unmount()

  render(<App data={{ ...baseView, notify: { configured: true, imConfigured: true, lastPushedReport: '会员周报-2026-10-10' } }} />)
  const pushed = screen.getByText('已推送 · 会员运营/会员周报-2026-10-10')
  expect(pushed).toHaveClass('notify-chip')
  expect(pushed.textContent).toBe('已推送 · 会员运营/会员周报-2026-10-10') // G5' 短形态
  expect(pushed).not.toHaveClass('warn') // 已推送为 ok 色
  unmount()

  render(<App data={{ ...baseView, notify: { configured: true } }} />)
  expect(screen.getByText('未配置飞书 · 文本摘要推送')).toHaveClass('warn')
})

/* ---- S-R 运行详情抽屉（T7，契约 2.16）---- */

const USAGE_BODY = {
  available: true,
  totals: { modelCalls: 3, inputTokens: 1200, outputTokens: 800, activeMs: 5400, toolCalls: 0, resourceUnits: 3 },
}
const EVENTS_BODY = {
  events: [
    { at: '2026-10-13T09:00:05.000Z', kind: 'failed', reason: 'MODEL_FAILED', model: 'MiniMax-M3', report: '会员周报-2026-10-12' },
    { at: '2026-10-13T08:59:40.000Z', kind: 'success', model: 'MiniMax-M3', report: '会员周报-2026-10-10' },
    { at: '2026-10-13T08:59:30.000Z', kind: 'start', model: 'MiniMax-M3', report: '会员周报-2026-10-10' },
  ],
}

function stubDrawerFetch(usage: unknown = USAGE_BODY, events: unknown = EVENTS_BODY) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/agent/usage')) return Promise.resolve({ ok: true, json: () => Promise.resolve(usage) })
    if (url.includes('/api/agent/events')) return Promise.resolve({ ok: true, json: () => Promise.resolve(events) })
    return Promise.reject(new Error(`unexpected fetch: ${url}`))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const drawerView: BoardView = {
  ...baseView,
  modelChain: {
    available: true,
    providers: [
      { role: '主', provider: 'minimax-cn', modelId: 'MiniMax-M3', keyReady: true },
      { role: '备', provider: 'xiaomi-token-plan-cn', modelId: 'mimo-v2.6-flash', keyReady: false },
    ],
  },
}

test('S-R 抽屉：默认收起，打开渲染模型链（主/备+密钥 chip）、账本用量 chips、时间线（失败原因红字行）', async () => {
  stubDrawerFetch()
  render(<App data={drawerView} />)
  expect(screen.queryByRole('complementary', { name: '运行详情' })).not.toBeInTheDocument() // 默认收起
  fireEvent.click(screen.getByRole('button', { name: '运行详情' }))
  const drawer = screen.getByRole('complementary', { name: '运行详情' })
  expect(within(drawer).getByText('关闭')).toBeInTheDocument() // 头部 = 标题 + 关闭

  // 模型链：主/备各一行 + 密钥 chip（就绪/未配置）
  const chain = within(within(drawer).getByRole('region', { name: '模型链' }))
  expect(chain.getByText('主')).toBeInTheDocument()
  expect(chain.getByText('MiniMax-M3')).toBeInTheDocument()
  expect(chain.getByText('备')).toBeInTheDocument()
  expect(chain.getByText('mimo-v2.6-flash')).toBeInTheDocument()
  expect(chain.getByText('就绪')).toBeInTheDocument()
  expect(chain.getByText('未配置')).toBeInTheDocument()

  // 任务账本用量 4 chips
  const stats = within(within(drawer).getByRole('region', { name: '任务账本用量' }))
  expect(await stats.findByText('模型调用 3')).toBeInTheDocument()
  expect(stats.getByText('token 入 1200')).toBeInTheDocument()
  expect(stats.getByText('token 出 800')).toBeInTheDocument()
  expect(stats.getByText(/用时 5s/)).toBeInTheDocument() // activeMs 5400 → 5s

  // 时间线：最新在前，失败原因行可见
  const timeline = within(within(drawer).getByRole('region', { name: '抽取事件' }))
  expect(await timeline.findByText('抽取失败')).toBeInTheDocument()
  const rows = timeline.getAllByRole('listitem')
  expect(rows.map((row) => row.textContent)).toEqual([
    expect.stringContaining('抽取失败'),
    expect.stringContaining('抽取成功'),
    expect.stringContaining('抽取开始'),
  ])
  expect(rows[0].textContent).toContain('MODEL_FAILED') // 失败原因红字行
  expect(rows[0].textContent).toContain('会员周报-2026-10-12')
  vi.unstubAllGlobals()
})

test('S-R 抽屉：空时间线逐字文案；账本未注入时用量显示 —', async () => {
  stubDrawerFetch({ available: false }, { events: [] })
  render(<App data={drawerView} />)
  fireEvent.click(screen.getByRole('button', { name: '运行详情' }))
  const drawer = screen.getByRole('complementary', { name: '运行详情' })
  const stats = within(within(drawer).getByRole('region', { name: '任务账本用量' }))
  expect(await stats.findByText('模型调用 —')).toBeInTheDocument()
  expect(stats.getByText('token 入 —')).toBeInTheDocument()
  const timeline = within(within(drawer).getByRole('region', { name: '抽取事件' }))
  expect(await timeline.findByText('暂无抽取事件——放入新报告后此处显示。')).toBeInTheDocument()
  vi.unstubAllGlobals()
})

test('S-R 抽屉：关闭后焦点回开关钮；再点开关可重新打开', async () => {
  stubDrawerFetch()
  render(<App data={drawerView} />)
  const toggle = screen.getByRole('button', { name: '运行详情' })
  fireEvent.click(toggle)
  const drawer = screen.getByRole('complementary', { name: '运行详情' })
  fireEvent.click(within(drawer).getByRole('button', { name: '关闭' }))
  expect(screen.queryByRole('complementary', { name: '运行详情' })).not.toBeInTheDocument()
  expect(toggle).toHaveFocus() // 非模态抽屉：关闭后焦点回开关钮
  fireEvent.click(toggle)
  expect(screen.getByRole('complementary', { name: '运行详情' })).toBeInTheDocument()
  vi.unstubAllGlobals()
})

/* ---- M6：项目导航 / 上传 / 无项目空态 / localStorage（T3）---- */

function summaryOfProject(over: Partial<ProjectSummary> & { id: string; title: string }): ProjectSummary {
  return {
    purpose: '',
    createdAt: NOW,
    updatedAt: NOW,
    actionCounts: { suggested: 0, adopted: 0, dismissed: 0, manual: 0 },
    lastActivity: '',
    ...over,
  }
}

const summaryP1 = summaryOfProject({ id: 'p1', title: '会员运营', actionCounts: { suggested: 3, adopted: 1, dismissed: 0, manual: 1 } })
const summaryP2 = summaryOfProject({ id: 'p2', title: '门店扩张', actionCounts: { suggested: 2, adopted: 0, dismissed: 1, manual: 0 }, lastActivity: NOW })

const boardP2: BoardView = {
  ...baseView,
  project: { id: 'p2', title: '门店扩张', purpose: '新店筹备' },
  reports: [report(5, { projectId: 'p2' })],
  actionItems: [item('b1', { projectId: 'p2', reportId: 5, title: '门店B-选址复核' })],
  stats: { suggested: 1, adopted: 0, dismissed: 0, manual: 0 },
}

test('项目切换：点左栏项目项 → 主区整体换数据源（S1/S1b/S6/S2），aria-pressed 高亮', async () => {
  stubFetch([
    { match: (url) => url.includes('/api/projects/p2/board'), respond: () => jsonRes(boardP2) },
  ])
  render(<App projects={[summaryP1, summaryP2]} data={baseView} />)
  expect(screen.getByRole('heading', { level: 1, name: '会员运营' })).toBeInTheDocument()
  const nav = screen.getByRole('navigation', { name: '项目导航' })
  expect(within(nav).getByRole('button', { name: /^会员运营/ })).toHaveAttribute('aria-pressed', 'true')

  fireEvent.click(within(nav).getByRole('button', { name: /^门店扩张/ }))
  expect(await screen.findByRole('heading', { level: 1, name: '门店扩张' })).toBeInTheDocument()
  expect(screen.getByText('新店筹备')).toBeInTheDocument() // purpose 副题切换
  expect(screen.getByText('门店B-选址复核')).toBeInTheDocument()
  expect(within(nav).getByRole('button', { name: /^门店扩张/ })).toHaveAttribute('aria-pressed', 'true')
  expect(screen.queryByText('对沉睡会员发放阶梯券')).not.toBeInTheDocument() // A 项目数据不残留
  vi.unstubAllGlobals()
})

test('S-L 新建项目：inline 表单必填校验（请填写名称）→ 创建成功切换为新项目', async () => {
  const created = summaryOfProject({ id: 'p-new', title: '新项目' })
  const boardNew: BoardView = { ...baseView, project: { id: 'p-new', title: '新项目', purpose: '' }, reports: [], actionItems: [], stats: { suggested: 0, adopted: 0, dismissed: 0, manual: 0 } }
  const { calls } = stubFetch([
    { match: (url, m) => m === 'POST' && url.endsWith('/api/projects'), respond: () => jsonRes(created) },
    { match: (url, m) => m === 'GET' && url.endsWith('/api/projects'), respond: () => jsonRes({ projects: [summaryP1, created] }) },
    { match: (url) => url.includes('/api/projects/p-new/board'), respond: () => jsonRes(boardNew) },
  ])
  render(<App projects={[summaryP1]} data={baseView} />)
  fireEvent.click(screen.getByRole('button', { name: '＋ 新建项目' }))
  fireEvent.click(screen.getByRole('button', { name: '创建' }))
  expect(screen.getByText('请填写名称')).toBeInTheDocument() // 逐字校验文案

  fireEvent.change(screen.getByLabelText('名称'), { target: { value: '新项目' } })
  fireEvent.change(screen.getByLabelText('目的'), { target: { value: '跟踪试点' } })
  fireEvent.click(screen.getByRole('button', { name: '创建' }))
  await waitFor(() => {
    const post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/projects'))
    expect(post?.body).toEqual({ title: '新项目', purpose: '跟踪试点' })
  })
  expect(await screen.findByRole('heading', { level: 1, name: '新项目' })).toBeInTheDocument() // 切换为新项目
  expect(screen.queryByLabelText('新建项目')).not.toBeInTheDocument() // 表单收起
  vi.unstubAllGlobals()
})

test('S-L 编辑项目：当前项编辑入口预填名称/purpose → 保存走 PATCH', async () => {
  const renamed = { ...summaryP1, title: '会员运营V2' }
  const boardRenamed: BoardView = { ...baseView, project: { ...baseView.project, title: '会员运营V2' } }
  const { calls } = stubFetch([
    { match: (url, m) => m === 'PATCH' && url.includes('/api/projects/p1'), respond: () => jsonRes(renamed) },
    { match: (url, m) => m === 'GET' && url.endsWith('/api/projects'), respond: () => jsonRes({ projects: [renamed] }) },
    { match: (url) => url.includes('/api/projects/p1/board'), respond: () => jsonRes(boardRenamed) },
  ])
  render(<App projects={[summaryP1]} data={baseView} />)
  fireEvent.click(screen.getByRole('button', { name: '编辑 会员运营' }))
  const form = screen.getByLabelText('编辑项目')
  expect((within(form).getByLabelText('名称') as HTMLInputElement).value).toBe('会员运营')
  fireEvent.change(within(form).getByLabelText('名称'), { target: { value: '会员运营V2' } })
  fireEvent.click(within(form).getByRole('button', { name: '保存' }))
  await waitFor(() => {
    const patch = calls.find((c) => c.method === 'PATCH')
    expect(patch?.body).toEqual({ title: '会员运营V2' })
  })
  vi.unstubAllGlobals()
})

test('S14 删除项目弹窗：逐字正文+项目名、打开聚焦取消、取消/Esc 回 ×、确认走 DELETE 并回退当前项目', async () => {
  const { calls } = stubFetch([
    { match: (url, m) => m === 'DELETE' && url.includes('/api/projects/p2'), respond: () => jsonRes({ deleted: true }) },
    { match: (url, m) => m === 'GET' && url.endsWith('/api/projects'), respond: () => jsonRes({ projects: [summaryP1] }) },
    { match: (url) => url.includes('/api/projects/p1/board'), respond: () => jsonRes(baseView) },
  ])
  render(<App projects={[summaryP2, summaryP1]} data={boardP2} />)
  expect(screen.getByRole('heading', { level: 1, name: '门店扩张' })).toBeInTheDocument()

  const delBtn = screen.getByRole('button', { name: '删除 门店扩张' })
  fireEvent.click(delBtn)
  const dialog = screen.getByRole('dialog')
  expect(dialog).toHaveAttribute('open', '')
  expect(screen.getByText('删除项目')).toBeInTheDocument()
  expect(within(dialog).getByText('门店扩张')).toBeInTheDocument()
  expect(screen.getByText('项目及其报告文件将一并删除，不可恢复。')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '取消' })).toHaveFocus() // 破坏性操作安全位

  // Esc 取消：无变更
  fireEvent(dialog, new Event('cancel', { cancelable: true }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(delBtn).toHaveFocus()
  expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0)

  // 确认删除 → 硬删 + G7' 回退列表首个项目
  fireEvent.click(delBtn)
  fireEvent.click(screen.getByRole('button', { name: '确认删除' }))
  await waitFor(() => expect(calls.find((c) => c.method === 'DELETE')).toBeTruthy())
  expect(await screen.findByRole('heading', { level: 1, name: '会员运营' })).toBeInTheDocument() // 回退 p1
  vi.unstubAllGlobals()
})

test('上传报告：多文件前端预检（类型/大小逐字失败文案）+ 合法文件 POST 逐份上传', async () => {
  const uploadedBoard: BoardView = {
    ...baseView,
    reports: [...baseView.reports, report(9, { filename: '新报告.md', status: 'extracting' })],
  }
  const { calls } = stubFetch([
    {
      match: (url, m) => m === 'POST' && url.includes('/api/projects/p1/reports'),
      respond: () => jsonRes({ results: [{ filename: '新报告.md', slug: '新报告', ok: true, status: 'accepted' }] }),
    },
    { match: (url) => url.includes('/api/projects/p1/board'), respond: () => jsonRes(uploadedBoard) },
    { match: (url, m) => m === 'GET' && url.endsWith('/api/projects'), respond: () => jsonRes({ projects: [summaryP1] }) },
  ])
  const { container } = render(<App projects={[summaryP1]} data={baseView} />)
  const input = container.querySelector('input.upload-input') as HTMLInputElement
  const goodFile = new File(['# 报告内容'], '新报告.md', { type: 'text/markdown' })
  const badType = new File(['a,b'], '数据.csv', { type: 'text/csv' })
  const tooBig = new File(['x'.repeat(2 * 1024 * 1024 + 1)], '超大.md')
  Object.defineProperty(input, 'files', { value: [goodFile, badType, tooBig] })
  fireEvent.change(input)

  await waitFor(() => {
    const post = calls.find((c) => c.method === 'POST' && c.url.includes('/api/projects/p1/reports'))
    expect(post).toBeTruthy()
  })
  const post = calls.find((c) => c.method === 'POST' && c.url.includes('/api/projects/p1/reports'))!
  expect((post.body as { files: Array<{ filename: string }> }).files.map((f) => f.filename)).toEqual(['新报告.md']) // 预检失败不发送
  expect(await screen.findByText('上传失败：仅支持 .md/.txt 文件')).toBeInTheDocument() // 契约逐字
  expect(screen.getByText('上传失败：文件超过 2MB')).toBeInTheDocument()
  await waitFor(() => expect(screen.getByText('抽取中')).toBeInTheDocument()) // 上传成功 → board 刷新见抽取中
  vi.unstubAllGlobals()
})

test('无项目空态：引导卡（尚无项目/一句话/新建表单）+ S-L 空态逐字 + 运行详情开关保留', async () => {
  const created = summaryOfProject({ id: 'p-first', title: '第一个项目' })
  const boardFirst: BoardView = { ...baseView, project: { id: 'p-first', title: '第一个项目', purpose: '' }, reports: [], actionItems: [], stats: { suggested: 0, adopted: 0, dismissed: 0, manual: 0 } }
  stubFetch([
    { match: (url, m) => m === 'POST' && url.endsWith('/api/projects'), respond: () => jsonRes(created) },
    { match: (url, m) => m === 'GET' && url.endsWith('/api/projects'), respond: () => jsonRes({ projects: [created] }) },
    { match: (url) => url.includes('/api/projects/p-first/board'), respond: () => jsonRes(boardFirst) },
  ])
  render(<App projects={[]} />)
  expect(screen.getByText('尚无项目——新建一个开始。')).toBeInTheDocument() // S-L 空态逐字
  expect(screen.getByRole('heading', { level: 2, name: '尚无项目' })).toBeInTheDocument()
  expect(screen.getByText('新建一个项目，在项目内上传报告即可生成看板。')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '运行详情' })).toBeInTheDocument() // G4'：开关保留在引导卡头部

  const guide = document.querySelector('.project-guide') as HTMLElement
  fireEvent.click(within(guide).getByRole('button', { name: '＋ 新建项目' })) // 引导卡入口（S-L 顶栏入口并存）
  fireEvent.change(within(guide).getByLabelText('名称'), { target: { value: '第一个项目' } })
  fireEvent.click(screen.getByRole('button', { name: '创建' }))
  expect(await screen.findByRole('heading', { level: 1, name: '第一个项目' })).toBeInTheDocument()
  vi.unstubAllGlobals()
})

test('演示形态禁现（v5 负面用例 2）：有项目与无项目态均不出现演示文案', () => {
  const { unmount } = render(<App projects={[]} />)
  for (const banned of ['演示数据', '示例报告', '放入 data/raw/']) {
    expect(screen.queryByText(new RegExp(banned))).not.toBeInTheDocument()
  }
  unmount()
  render(<App data={baseView} />)
  for (const banned of ['演示数据', '示例报告', '放入 data/raw/']) {
    expect(screen.queryByText(new RegExp(banned))).not.toBeInTheDocument()
  }
})

test('localStorage 记忆（G7 决议）：刷新回到最后项目；切换写入', async () => {
  window.localStorage.setItem('dp.activeProjectId', 'p2')
  stubFetch([
    { match: (url, m) => m === 'GET' && url.endsWith('/api/projects'), respond: () => jsonRes({ projects: [summaryP1, summaryP2] }) },
    { match: (url) => url.includes('/api/projects/p2/board'), respond: () => jsonRes(boardP2) },
    { match: (url) => url.includes('/api/projects/p1/board'), respond: () => jsonRes(baseView) },
  ])
  render(<App />)
  expect(await screen.findByRole('heading', { level: 1, name: '门店扩张' })).toBeInTheDocument() // 回到最后项目

  fireEvent.click(screen.getByRole('button', { name: /^会员运营/ }))
  await screen.findByRole('heading', { level: 1, name: '会员运营' })
  expect(window.localStorage.getItem('dp.activeProjectId')).toBe('p1') // 切换写入
  window.localStorage.removeItem('dp.activeProjectId')
  vi.unstubAllGlobals()
})

test('fetch 失败 → 明确错误态（不回退演示）：项目列表加载失败 + 重试', async () => {
  let fail = true
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/projects') && !fail) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ projects: [summaryP1] }) })
      }
      if (url.includes('/api/projects/p1/board')) return Promise.resolve({ ok: true, json: () => Promise.resolve(baseView) })
      return Promise.reject(new Error('backend down'))
    }),
  )
  render(<App />)
  expect(await screen.findByText('项目列表加载失败')).toBeInTheDocument()
  expect(screen.queryByText('演示数据')).not.toBeInTheDocument()

  fail = false
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  expect(await screen.findByRole('heading', { level: 1, name: '会员运营' })).toBeInTheDocument()
  vi.unstubAllGlobals()
})
