import { describe, expect, it } from 'vitest'
import { resolveDataRoot } from './index'

/** M10：DATA_ROOT 显式数据根（宿主随包装配接缝；缺省行为与独立运行现状逐字节等价）。 */
describe('resolveDataRoot', () => {
  it('未设置 → <cwd>/data（独立运行缺省不变）', () => {
    expect(resolveDataRoot({}, '/work/root')).toBe('/work/root/data')
  })

  it('绝对路径原样返回', () => {
    expect(resolveDataRoot({ DATA_ROOT: '/srv/decision-data' }, '/work/root')).toBe('/srv/decision-data')
  })

  it('相对路径按 cwd 解析为绝对路径', () => {
    expect(resolveDataRoot({ DATA_ROOT: 'state/board' }, '/work/root')).toBe('/work/root/state/board')
  })

  it('空白字符串视为未设置', () => {
    expect(resolveDataRoot({ DATA_ROOT: '   ' }, '/work/root')).toBe('/work/root/data')
  })
})
