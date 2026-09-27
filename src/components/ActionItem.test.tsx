import { render, screen } from '@testing-library/react'
import { ActionItem } from './ActionItem'
import type { StoredActionState } from '../useActionStore'

const action = { id: 'a-1', conclusionId: 'c-1', text: '核查增长驱动', impact: '预期止损 5%' }
const noop = () => {}

test('有留痕时展示「审批人 · MM-DD HH:mm」', () => {
  const decided: StoredActionState = { status: 'accepted', decidedBy: '张三', decidedAt: '2026-09-27T06:30:00Z', decidedVia: 'card' }
  render(<ActionItem action={action} status="accepted" decided={decided} onAction={noop} />)
  // ISO 时间按本地时区渲染，只断言日期段与审批人
  const meta = screen.getByText(/张三 · 09-\d{2} \d{2}:\d{2}/)
  expect(meta).toBeInTheDocument()
})

test('卡片渠道无审批人名字 → 显示「IM 审批」；PC 渠道 → 显示「PC」', () => {
  const { rerender } = render(
    <ActionItem action={action} status="rejected" decided={{ status: 'rejected', decidedAt: '2026-09-27T06:30:00Z', decidedVia: 'card' }} onAction={noop} />,
  )
  expect(screen.getByText(/IM 审批 · 09-\d{2}/)).toBeInTheDocument()
  rerender(
    <ActionItem action={action} status="accepted" decided={{ status: 'accepted', decidedAt: '2026-09-27T06:30:00Z', decidedVia: 'pc' }} onAction={noop} />,
  )
  expect(screen.getByText(/PC · 09-\d{2}/)).toBeInTheDocument()
})

test('无留痕（decided 缺失或无 decidedAt）→ 不渲染留痕文本', () => {
  const { rerender } = render(<ActionItem action={action} status="pending" onAction={noop} />)
  expect(screen.queryByText(/· 09-\d{2}/)).not.toBeInTheDocument()
  rerender(<ActionItem action={action} status="accepted" decided={{ status: 'accepted' }} onAction={noop} />)
  expect(screen.queryByText(/· 09-\d{2}/)).not.toBeInTheDocument()
})
