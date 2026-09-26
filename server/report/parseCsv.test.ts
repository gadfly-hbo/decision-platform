import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseMemberWeeklyCsv, yoy, ReportParseError } from './parseCsv'

const sampleCsv = readFileSync(join(__dirname, 'testdata', 'sample.csv'), 'utf-8')

test('解析真实样本：定位表头（容错前导行）、22 行、6 指标', () => {
  const report = parseMemberWeeklyCsv(sampleCsv, '会员周报4213-2026-09-26-08-58-36.csv')
  expect(report.period).toBe('2026-09-26')
  expect(report.rows).toHaveLength(22)
  const first = report.rows[0]
  expect(first.channel).toBe('A品牌-华北加盟')
  expect(first.mode).toBe('加盟')
  expect(first.region).toBe('A品牌-华北区')
  expect(first.metrics.memberSales).toEqual({ current: 17913757.52, previous: 15798018.0 })
})

test('同比一律重算：源表声明的错误值被纠正（直营浙江 零售额 -1.34% → 重算 -1.91%）', () => {
  const report = parseMemberWeeklyCsv(sampleCsv, 'x-2026-09-26.csv')
  const row = report.rows.find((r) => r.mode === '直营' && r.channel === 'A品牌-浙江分公司')!
  expect(yoy(row.metrics.totalSales)).toBeCloseTo(-1.9144, 3)
})

test('yoy 助手与源表正确的声明一致（华北加盟 会员零售额 +13.39%）', () => {
  const report = parseMemberWeeklyCsv(sampleCsv, 'x-2026-09-26.csv')
  expect(yoy(report.rows[0].metrics.memberSales)).toBeCloseTo(13.3924, 3)
})

test('缺列显式报错（指出缺失列名），不静默丢数据', () => {
  const malformed = [
    '渠道品牌,运营模式,一级渠道,二级渠道,会员零售额本期值,会员零售额同期值',
    'A品牌,加盟,区,店,100,50',
  ].join('\n')
  expect(() => parseMemberWeeklyCsv(malformed, 'x-2026-09-26.csv')).toThrow(/缺少指标列/)
})

test('行数据列数不足报错并带行号', () => {
  const malformed = [
    '渠道品牌,运营模式,一级渠道,二级渠道,会员零售额本期值,会员零售额同期值,会员购买人数本期值,会员购买人数同期值,会员开卡人数本期值,会员开卡人数同期值,零售额本期值,零售额同期值,新会员购买人数本期值,新会员购买人数同期值,新会员复购人数本期值,新会员复购人数同期值',
    'A品牌,加盟,区,店,100,50',
  ].join('\n')
  expect(() => parseMemberWeeklyCsv(malformed, 'x-2026-09-26.csv')).toThrow(/第 2 行/)
})

test('坏数字（非数值单元格）显式报错', () => {
  const lines = sampleCsv.split('\n')
  const headerIdx = lines.findIndex((l) => l.startsWith('渠道品牌'))
  lines[headerIdx + 1] = lines[headerIdx + 1].replace('17913757.52', 'N/A')
  expect(() => parseMemberWeeklyCsv(lines.join('\n'), 'x-2026-09-26.csv')).toThrow(ReportParseError)
})

test('找不到表头行时报错', () => {
  expect(() => parseMemberWeeklyCsv('没有表头的文本\n第二行', 'x-2026-09-26.csv')).toThrow(
    ReportParseError,
  )
})

test('期次提取兼容两种文件名日期格式并归一化', () => {
  const compact = parseMemberWeeklyCsv(sampleCsv, '会员周报4213-20260926.csv')
  expect(compact.period).toBe('2026-09-26')
  const dashed = parseMemberWeeklyCsv(sampleCsv, '会员周报-2026-09-26-08-58-36.csv')
  expect(dashed.period).toBe('2026-09-26')
})

test('空数值单元格显式报错（含行号），不再静默解析为 0', () => {
  const lines = sampleCsv.split('\n')
  const headerIdx = lines.findIndex((l) => l.startsWith('渠道品牌'))
  lines[headerIdx + 1] = lines[headerIdx + 1].replace('17913757.52', '')
  expect(() => parseMemberWeeklyCsv(lines.join('\n'), 'x-2026-09-26.csv')).toThrow(
    /空数值|第 \d+ 行/,
  )
})

test('表头后无数据行时报错（不产出 0 结论的空报告）', () => {
  const lines = sampleCsv.split('\n')
  const headerIdx = lines.findIndex((l) => l.startsWith('渠道品牌'))
  expect(() => parseMemberWeeklyCsv(lines[headerIdx], 'x-2026-09-26.csv')).toThrow(/无数据行/)
})

test('含空行的文件：报错行号为物理行号（不被空行偏移）', () => {
  const lines = sampleCsv.split('\n')
  const headerIdx = lines.findIndex((l) => l.startsWith('渠道品牌'))
  lines.splice(headerIdx + 1, 0, '')
  lines[headerIdx + 2] = lines[headerIdx + 2].replace('17913757.52', 'N/A')
  try {
    parseMemberWeeklyCsv(lines.join('\n'), 'x-2026-09-26.csv')
    throw new Error('should have thrown')
  } catch (e) {
    expect((e as ReportParseError).message).toMatch(`第 ${headerIdx + 3} 行`)
  }
})

test('带 UTF-8 BOM 的表头可正常解析', () => {
  const bomCsv = '\uFEFF' + sampleCsv
  const report = parseMemberWeeklyCsv(bomCsv, 'x-2026-09-26.csv')
  expect(report.rows).toHaveLength(22)
})
