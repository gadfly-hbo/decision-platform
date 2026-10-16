import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import JSZip from 'jszip'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeBoardDb, createActionItem, createProject, listReports, openBoardDb, updateReportStatus, type BoardDb } from './db'
import { extractReports, loadCalibrationContext, scanReports } from './reports'
import { applyActionPatch, CARD_DISMISS_DEFAULT_REASON } from './board'
import type { ExtractionInput, ExtractionRunner } from './agent/extract'
import type { ActionItemDraft } from './agent/types'

let dir: string
let db: BoardDb
let projectId: string
let reportsDir: string

const DRAFT: ActionItemDraft = {
  title: '提高复购频次',
  rationale: '复购率下滑',
  expectedImpact: '复购率 +5%',
  priority: 'high',
  effort: 'low',
  confidence: 0.92,
  evidence: { facts: [{ text: '复购率下滑', quote: '复购率由 12% 降至 9%' }], level: '数据支撑', reasoning: '报告数据支持' },
}

function runnerOf(result: () => ActionItemDraft[]): ExtractionRunner & { inputs: ExtractionInput[] } {
  const inputs: ExtractionInput[] = []
  return {
    inputs,
    async runExtraction(input) {
      inputs.push(input)
      return result()
    },
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dp-pipe-'))
  db = openBoardDb(join(dir, 'board.db'))
  projectId = createProject(db, { title: '管线项目' }).id
  reportsDir = join(dir, 'projects', projectId, 'reports')
  mkdirSync(reportsDir, { recursive: true })
})

afterEach(() => {
  closeBoardDb(db)
  rmSync(dir, { recursive: true, force: true })
})

describe('项目报告扫描与抽取管线（SQLite + 假 runner）', () => {
  it('受支持格式（md/csv 等）注册为 pending；已注册 slug 不重复；不支持格式跳过', () => {
    writeFileSync(join(reportsDir, '周报.md'), '# 报告一')
    writeFileSync(join(reportsDir, '会员周报4213.csv'), 'a,b\n1,2')
    writeFileSync(join(reportsDir, '笔记.exe'), 'MZ')
    const reports1 = scanReports(db, projectId, reportsDir)
    expect(reports1).toHaveLength(2)
    expect(reports1.map((r) => r.slug).sort()).toEqual(['会员周报4213', '周报'])
    expect(reports1.find((r) => r.slug === '周报')).toMatchObject({ projectId, filename: '周报.md', status: 'pending' })

    const reports2 = scanReports(db, projectId, reportsDir)
    expect(reports2).toHaveLength(2)
    expect(reports2.map((r) => r.id).sort()).toEqual(reports1.map((r) => r.id).sort())
  })

  it('extract 处理 pending 报告：done + 行动项入库；再次 extract 不重复处理', async () => {
    writeFileSync(join(reportsDir, 'r1.md'), '报告内容')
    const runner = runnerOf(() => [DRAFT])
    scanReports(db, projectId, reportsDir)

    const results1 = await extractReports(db, projectId, reportsDir, runner)
    expect(results1).toHaveLength(1)
    expect(results1[0]).toMatchObject({ slug: 'r1', status: 'done', inserted: 1 })
    expect(runner.inputs.map((input) => input.taskId)).toEqual([`extract:${projectId}:r1`])

    const results2 = await extractReports(db, projectId, reportsDir, runner)
    expect(results2).toHaveLength(0) // 无待处理报告
    expect(runner.inputs).toHaveLength(1)
  })

  it('docx 报告：抽取前由 report-text 转为纯文本送入 runner', async () => {
    const zip = new JSZip()
    zip.file('word/document.xml', '<w:document><w:body><w:p><w:r><w:t>会员复购率由 12% 降至 9%</w:t></w:r></w:p></w:body></w:document>')
    writeFileSync(join(reportsDir, '会员周报.docx'), await zip.generateAsync({ type: 'nodebuffer' }))
    const runner = runnerOf(() => [DRAFT])
    scanReports(db, projectId, reportsDir)

    const results = await extractReports(db, projectId, reportsDir, runner)
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ slug: '会员周报', status: 'done', inserted: 1 })
    expect(runner.inputs[0].reportContent).toContain('会员复购率由 12% 降至 9%')
  })

  it('图片报告：正文为空，图像作为 InputImage 送入 runner', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
    writeFileSync(join(reportsDir, '门店照片.png'), png)
    const runner = runnerOf(() => [DRAFT])
    scanReports(db, projectId, reportsDir)

    const results = await extractReports(db, projectId, reportsDir, runner)
    expect(results[0]).toMatchObject({ slug: '门店照片', status: 'done', inserted: 1 })
    expect(runner.inputs[0].reportContent).toBe('')
    expect(runner.inputs[0].images).toHaveLength(1)
    expect(runner.inputs[0].images![0].mimeType).toBe('image/png')
    expect(Buffer.from(runner.inputs[0].images![0].data, 'base64')).toEqual(png)
  })

  it('runner 抛错 → failed + error 信息；可重试成功', async () => {
    writeFileSync(join(reportsDir, 'r1.md'), '报告内容')
    let fail = true
    const runner: ExtractionRunner = {
      async runExtraction() {
        if (fail) throw new Error('模型超时')
        return []
      },
    }
    scanReports(db, projectId, reportsDir)

    const results1 = await extractReports(db, projectId, reportsDir, runner)
    expect(results1[0]).toMatchObject({ slug: 'r1', status: 'failed', error: '模型超时' })
    expect(listReports(db, projectId)[0]).toMatchObject({ status: 'failed', error: '模型超时' })

    fail = false
    const results2 = await extractReports(db, projectId, reportsDir, runner)
    expect(results2[0]).toMatchObject({ slug: 'r1', status: 'done' })
  })

  it('force 重抽（G3）：纯 suggested 删除重建；adopted/dismissed/含任务项存活', async () => {
    const draftOf = (title: string): ActionItemDraft => ({ ...DRAFT, title })
    writeFileSync(join(reportsDir, 'r1.md'), '报告内容')
    let current: ActionItemDraft[] = [draftOf('A-已采纳'), draftOf('B-已驳回'), draftOf('C-含任务'), draftOf('D-纯建议')]
    const runner = runnerOf(() => current)
    await extractReports(db, projectId, reportsDir, runner)

    const loadItems = () =>
      db.prepare('SELECT id, title FROM action_items WHERE project_id = ?').all(projectId) as Array<{ id: string; title: string }>
    const items = loadItems()
    const idOf = (title: string) => items.find((it) => it.title === title)?.id
    const idA = idOf('A-已采纳')
    const idB = idOf('B-已驳回')
    const idC = idOf('C-含任务')
    const idD = idOf('D-纯建议')
    expect([idA, idB, idC, idD].every(Boolean)).toBe(true)

    // 造数：A 采纳；B 驳回（带理由）；C 保持 suggested 但挂任务
    applyActionPatch(db, idA as string, { status: 'adopted', via: 'board' })
    applyActionPatch(db, idB as string, { status: 'dismissed', dismissedReason: '与大盘趋势不符', via: 'board' })
    db.prepare(
      'INSERT INTO action_tasks (id, action_item_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('t-c', idC as string, '联系渠道负责人', 't', 't')

    // force 重抽：只返回一条新建议 → 纯 suggested（D）删除重建，其余存活
    current = [draftOf('E-新建议')]
    const force = await extractReports(db, projectId, reportsDir, runner, { slug: 'r1', force: true })
    expect(force[0]).toMatchObject({ slug: 'r1', status: 'done', inserted: 1, removedStale: 1 })

    const after = loadItems()
    const ids = new Set(after.map((it) => it.id))
    expect(ids.has(idA as string)).toBe(true)
    expect(ids.has(idB as string)).toBe(true)
    expect(ids.has(idC as string)).toBe(true)
    expect(ids.has(idD as string)).toBe(false)
    expect(after).toHaveLength(4) // A/B/C + 新 E
    const taskLeft = db.prepare('SELECT COUNT(*) AS c FROM action_tasks').get() as { c: number }
    expect(taskLeft.c).toBe(1) // 存活项的任务未受影响
  })

  it('指定 slug 抽取单份报告；未知 slug 空结果', async () => {
    writeFileSync(join(reportsDir, 'r1.md'), 'A')
    writeFileSync(join(reportsDir, 'r2.txt'), 'B')
    scanReports(db, projectId, reportsDir)
    const runner = runnerOf(() => [])

    const only2 = await extractReports(db, projectId, reportsDir, runner, { slug: 'r2' })
    expect(only2).toHaveLength(1)
    expect(only2[0].slug).toBe('r2')

    const missing = await extractReports(db, projectId, reportsDir, runner, { slug: 'nope' })
    expect(missing).toHaveLength(0)
  })

  it('扫描隔离：B 项目目录的报告不出现在 A 项目列表', () => {
    const projectB = createProject(db, { title: '项目B' }).id
    const dirB = join(dir, 'projects', projectB, 'reports')
    mkdirSync(dirB, { recursive: true })
    writeFileSync(join(reportsDir, 'a-报告.md'), 'A')
    writeFileSync(join(dirB, 'b-报告.md'), 'B')
    expect(scanReports(db, projectId, reportsDir).map((r) => r.slug)).toEqual(['a-报告'])
    expect(scanReports(db, projectB, dirB).map((r) => r.slug)).toEqual(['b-报告'])
  })
})

describe('G12 校准注入（项目级：驳回理由与人工补充方向）', () => {
  function seedItem(title: string): string {
    return createActionItem(db, {
      projectId,
      sourceKind: 'manual',
      reportId: null,
      title,
      rationale: `${title}的依据`,
      scene: null,
      lifecycle: null,
      expectedImpact: '待评估',
      priority: 'medium',
      effort: 'medium',
      confidence: null,
      evidence: { facts: [], level: '经验假设', reasoning: `${title}的依据` },
    })
  }

  it('本项目有驳回（有内容的理由）与人工补充时 runner 收到 calibration；卡片默认占位理由无信号不注入', async () => {
    writeFileSync(join(reportsDir, 'r1.md'), '报告内容')
    seedItem('上线会员日活动')
    const boardDismissed = seedItem('调整渠道预算')
    const cardDismissed = seedItem('更换门店物料')
    applyActionPatch(db, boardDismissed, { status: 'dismissed', dismissedReason: '与大盘趋势不符', via: 'board' })
    applyActionPatch(db, cardDismissed, { status: 'dismissed', via: 'card' }) // 默认占位理由

    const runner = runnerOf(() => [])
    await extractReports(db, projectId, reportsDir, runner)
    expect(runner.inputs[0].calibration).toEqual({
      dismissalReasons: ['与大盘趋势不符'],
      manualAdditions: [{ title: '上线会员日活动', rationale: '上线会员日活动的依据' }],
    })
    void CARD_DISMISS_DEFAULT_REASON
  })

  it('本项目无校准数据时 calibration 为 undefined（prompt 形态不变）', async () => {
    writeFileSync(join(reportsDir, 'r1.md'), '报告内容')
    const runner = runnerOf(() => [])
    await extractReports(db, projectId, reportsDir, runner)
    expect(runner.inputs[0].calibration).toBeUndefined()
  })

  it('校准项目级隔离：B 项目的驳回理由不进 A 项目 prompt', async () => {
    writeFileSync(join(reportsDir, 'a.md'), 'A')
    const projectB = createProject(db, { title: '项目B' }).id
    const dirB = join(dir, 'projects', projectB, 'reports')
    mkdirSync(dirB, { recursive: true })
    writeFileSync(join(dirB, 'b.md'), 'B')

    const dismissedB = createActionItem(db, {
      projectId: projectB,
      sourceKind: 'manual',
      reportId: null,
      title: 'B 项目建议',
      rationale: 'x',
      scene: null,
      lifecycle: null,
      expectedImpact: '待评估',
      priority: 'medium',
      effort: 'medium',
      confidence: null,
      evidence: { facts: [], level: '经验假设', reasoning: 'x' },
    })
    applyActionPatch(db, dismissedB, { status: 'dismissed', dismissedReason: 'B 项目专属驳回理由', via: 'board' })

    expect(loadCalibrationContext(db, projectId)).toBeUndefined() // A 项目无数据 → 不注入
    const calibB = loadCalibrationContext(db, projectB)
    expect(calibB?.dismissalReasons).toEqual(['B 项目专属驳回理由']) // B 项目可见自己的信号
  })
})

describe('扫描恢复（N4）：进程重启遗留 extracting 复位', () => {
  it('遗留 extracting 报告 → 扫描复位为 failed（可重试）；runner 就绪后重试成功', async () => {
    writeFileSync(join(reportsDir, 'r1.md'), '报告内容')
    const registered = scanReports(db, projectId, reportsDir)[0]
    updateReportStatus(db, registered.id, 'extracting') // 模拟进程崩溃遗留（本进程无在抽任务）
    expect(listReports(db, projectId)[0].status).toBe('extracting')

    const afterScan = scanReports(db, projectId, reportsDir) // 扫描含复位
    expect(afterScan[0]).toMatchObject({ status: 'failed', error: '进程重启中断抽取，可重试' })

    const okRunner = runnerOf(() => [])
    const results = await extractReports(db, projectId, reportsDir, okRunner) // failed 可重试
    expect(results[0]).toMatchObject({ slug: 'r1', status: 'done' })
  })
})

describe('抽取完成事件钩子（M6-T2：事件驱动推送缝）', () => {
  it('done 且有行动项 → 回调 {slug, inserted}；失败不回调', async () => {
    writeFileSync(join(reportsDir, 'ok.md'), 'A')
    writeFileSync(join(reportsDir, 'bad.md'), 'B')
    scanReports(db, projectId, reportsDir)
    const done: Array<{ slug: string; inserted: number }> = []
    const runner: ExtractionRunner = {
      async runExtraction(input) {
        if (input.taskId.endsWith(':bad')) throw new Error('模型超时')
        return [DRAFT]
      },
    }
    await extractReports(db, projectId, reportsDir, runner, { slug: 'bad' })
    await extractReports(db, projectId, reportsDir, runner, { slug: 'ok', onReportDone: (info) => done.push(info) })
    expect(done).toEqual([{ slug: 'ok', inserted: 1 }])
  })
})
