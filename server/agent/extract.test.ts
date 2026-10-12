import { describe, expect, it } from 'vitest'
import type { ModelConfig, ModelContent, ModelRequest, ModelReply, ModelTransport } from 'pi-agent-runtime'
import { createRuntime, createMemoryBudgetStore, ProviderFailure } from 'pi-agent-runtime'
import { createRecorder, createReplay } from 'pi-agent-runtime/testing'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonlAuditSink } from './audit'
import { createExtractionRunner, EXTRACTION_LIMITS } from './extract'

const FAKE_MODEL: ModelConfig = {
  provider: 'test',
  id: 'fake-model',
  protocol: 'anthropic-messages',
  endpoint: 'https://example.test',
  contextWindow: 128_000,
  maxOutputTokens: 8192,
}

const FAKE_BACKUP_MODEL: ModelConfig = { ...FAKE_MODEL, id: 'fake-model-backup' }

function textReply(text: string): ModelReply {
  const content: ModelContent[] = [{ kind: 'text', text }]
  return { content, stop: 'complete', usage: { inputTokens: 10, outputTokens: 20 } }
}

function makeRunner(transport: ModelTransport) {
  const dir = mkdtempSync(join(tmpdir(), 'dp-extract-'))
  const runtime = createRuntime({
    model: FAKE_MODEL,
    transport,
    authorize: async () => true,
    audit: new JsonlAuditSink(join(dir, 'audit.jsonl')),
    budgets: createMemoryBudgetStore(),
  })
  return { runner: createExtractionRunner({ runtime }), dir }
}

/** 固定回复 + 捕获真实请求（replay 记录的规范来源：先录后放，canonical 全等） */
function capturingTransport(replyText: string, requests: ModelRequest[]): ModelTransport {
  return async (request) => {
    requests.push(request)
    return textReply(replyText)
  }
}

const DRAFTS_JSON = JSON.stringify([
  {
    title: '提高复购频次',
    rationale: '复购率连续下滑',
    expectedImpact: '复购率 +5%',
    priority: 'high',
    effort: 'low',
    evidence: {
      facts: [{ text: '复购率下滑', quote: '复购率由 12% 降至 9%' }],
      level: '数据支撑',
      reasoning: '报告数据直接支持',
    },
  },
])

const SAMPLE_INPUT = {
  taskId: 'extract:demo-report',
  reportName: 'demo.md',
  reportContent: '报告正文',
}

describe('createExtractionRunner（runWorker 结构化抽取）', () => {
  it('正常抽取：模型输出 JSON 数组 → 归一化行动项草稿', async () => {
    // 第一步：stub 回复录制真实请求；第二步：replay 严格重放同一请求
    const recorded: ModelRequest[] = []
    const recorder = createRecorder(capturingTransport(DRAFTS_JSON, recorded))
    const { runner, dir } = makeRunner(recorder.transport)
    const drafts = await runner.runExtraction(SAMPLE_INPUT)
    expect(drafts).toHaveLength(1)
    expect(drafts[0]).toMatchObject({ title: '提高复购频次', priority: 'high', confidence: 0.92 })

    const replay = createReplay(recorder.records())
    const { runner: replayRunner, dir: dir2 } = makeRunner(replay.transport)
    const again = await replayRunner.runExtraction(SAMPLE_INPUT)
    expect(again).toEqual(drafts)
    replay.assertConsumed()
    rmSync(dir, { recursive: true, force: true })
    rmSync(dir2, { recursive: true, force: true })
  })

  it('prompt 注入报告与校准上下文（G12）', async () => {
    const requests: ModelRequest[] = []
    const { runner, dir } = makeRunner(capturingTransport('[]', requests))
    await runner.runExtraction({
      taskId: 'extract:calib',
      reportName: 'r.md',
      reportContent: '正文内容 ABC',
      calibration: {
        dismissalReasons: ['与大盘趋势不符'],
        manualAdditions: [{ title: '补充动作', rationale: '一线经验' }],
      },
    })
    const promptText = JSON.stringify(requests.flatMap((r) => r.messages))
    expect(promptText).toContain('正文内容 ABC')
    expect(promptText).toContain('与大盘趋势不符')
    expect(promptText).toContain('补充动作')
    rmSync(dir, { recursive: true, force: true })
  })

  it('无校准数据时 prompt 不含校准段', async () => {
    const requests: ModelRequest[] = []
    const { runner, dir } = makeRunner(capturingTransport('[]', requests))
    await runner.runExtraction({ taskId: 'extract:plain', reportName: 'r.md', reportContent: '正文' })
    const promptText = JSON.stringify(requests.flatMap((r) => r.messages))
    expect(promptText).toContain('正文')
    expect(promptText).not.toContain('用户已驳回')
    rmSync(dir, { recursive: true, force: true })
  })

  it('模型输出非严格 JSON（带 fence）→ run 失败（INVALID_OUTPUT 语义）', async () => {
    const { runner, dir } = makeRunner(capturingTransport('```json\n[]\n```', []))
    const result = await runner.runExtractionRaw({ taskId: 'extract:bad', reportName: 'r.md', reportContent: 'x' })
    expect(result.status).toBe('failed')
    rmSync(dir, { recursive: true, force: true })
  })

  it('validate 拒绝非数组 JSON → run 失败', async () => {
    const { runner, dir } = makeRunner(capturingTransport('{"nodes":[]}', []))
    const result = await runner.runExtractionRaw({ taskId: 'extract:notarray', reportName: 'r.md', reportContent: 'x' })
    expect(result.status).toBe('failed')
    rmSync(dir, { recursive: true, force: true })
  })

  it('单次保护参数符合 PRD 初值', () => {
    expect(EXTRACTION_LIMITS).toEqual({
      cumulative: 'unlimited',
      maxOutputTokens: 8192,
      modelTimeoutMs: 120_000,
      toolTimeoutMs: 30_000,
      controlTimeoutMs: 30_000,
    })
  })
})

describe('输入裁剪与备用链（REVIEW B2）', () => {
  it('输入裁剪：>16,000 字符报告正文截断到 16,000，边界后内容不入 prompt', async () => {
    const requests: ModelRequest[] = []
    const { runner, dir } = makeRunner(capturingTransport('[]', requests))
    const body = '报'.repeat(16_000) // PRD 单次保护初值：REPORT_CLIP_CHARS = 16_000
    await runner.runExtraction({
      taskId: 'extract:clip',
      reportName: 'big.md',
      reportContent: `${body}【截断外尾部】`,
    })
    const promptText = JSON.stringify(requests.flatMap((r) => r.messages))
    expect(promptText).toContain(body) // 前 16,000 字符完整保留
    expect(promptText).not.toContain('【截断外尾部】') // 边界后内容被裁掉
    rmSync(dir, { recursive: true, force: true })
  })

  it('备用链切换：主 transport 抛 ProviderFailure(unavailable) → 落到备 transport 成功', async () => {
    const primaryCalls: ModelRequest[] = []
    const fallbackRequests: ModelRequest[] = []
    const primary: ModelTransport = async (request) => {
      primaryCalls.push(request)
      throw new ProviderFailure('unavailable')
    }
    const dir = mkdtempSync(join(tmpdir(), 'dp-extract-'))
    const runtime = createRuntime({
      model: FAKE_MODEL,
      transport: primary,
      fallbacks: [{ model: FAKE_BACKUP_MODEL, transport: capturingTransport(DRAFTS_JSON, fallbackRequests) }],
      authorize: async () => true,
      audit: new JsonlAuditSink(join(dir, 'audit.jsonl')),
      budgets: createMemoryBudgetStore(),
    })
    const runner = createExtractionRunner({ runtime })

    const drafts = await runner.runExtraction(SAMPLE_INPUT)
    expect(drafts).toHaveLength(1) // 备模型返回正常 JSON → 抽取成功
    expect(primaryCalls).toHaveLength(1) // 请求确实到达过主 transport（并被拒）
    expect(fallbackRequests).toHaveLength(1) // 请求确实到达备 transport
    rmSync(dir, { recursive: true, force: true })
  })
})
