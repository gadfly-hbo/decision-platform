import { describe, expect, it } from 'vitest'
import type { ModelConfig, ModelContent, ModelRequest, ModelReply, ModelTransport } from 'pi-agent-runtime'
import { createRuntime, createMemoryBudgetStore } from 'pi-agent-runtime'
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

/** 队列式 transport：按序返回预设回复，捕获全部请求（重试链路断言用） */
function queueTransport(replies: string[], requests: ModelRequest[]): ModelTransport {
  return async (request) => {
    requests.push(request)
    const reply = replies.shift()
    if (reply === undefined) throw new Error('transport 队列耗尽')
    return textReply(reply)
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

describe('createExtractionRunner（M8：runText + 宿主解析 + 修复重试）', () => {
  it('正常抽取：裸 JSON 数组 → 归一化行动项草稿', async () => {
    const recorded: ModelRequest[] = []
    const recorder = createRecorder(queueTransport([DRAFTS_JSON], recorded))
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

  it('```json 围栏回复成功（原 INVALID_OUTPUT 真实场景，M8 修复）', async () => {
    const requests: ModelRequest[] = []
    const { runner, dir } = makeRunner(queueTransport(['```json\n' + DRAFTS_JSON + '\n```'], requests))
    const drafts = await runner.runExtraction(SAMPLE_INPUT)
    expect(drafts).toHaveLength(1)
    expect(requests).toHaveLength(1) // 解析成功不触发重试
    rmSync(dir, { recursive: true, force: true })
  })

  it('说明文字包裹的数组成功提取', async () => {
    const requests: ModelRequest[] = []
    const { runner, dir } = makeRunner(queueTransport(['以下是行动项：\n' + DRAFTS_JSON + '\n以上。'], requests))
    const drafts = await runner.runExtraction(SAMPLE_INPUT)
    expect(drafts).toHaveLength(1)
    rmSync(dir, { recursive: true, force: true })
  })

  it('截断 JSON → 自动修复重试：重试 prompt 含修复指令且成功', async () => {
    const requests: ModelRequest[] = []
    const { runner, dir } = makeRunner(queueTransport(['[{"title":"截断', DRAFTS_JSON], requests))
    const drafts = await runner.runExtraction(SAMPLE_INPUT)
    expect(drafts).toHaveLength(1)
    expect(requests).toHaveLength(2)
    const secondPrompt = JSON.stringify(requests[1].messages)
    expect(secondPrompt).toContain('只输出严格的 JSON 数组')
    const firstPrompt = JSON.stringify(requests[0].messages)
    expect(firstPrompt).not.toContain('只输出严格的 JSON 数组')
    rmSync(dir, { recursive: true, force: true })
  })

  it('两次皆无法解析 → 抛错（报告管线落 failed 可重试）', async () => {
    const requests: ModelRequest[] = []
    const { runner, dir } = makeRunner(queueTransport(['{"nodes":[]}', '还是不是数组'], requests))
    await expect(runner.runExtraction(SAMPLE_INPUT)).rejects.toThrow(/JSON 数组/)
    expect(requests).toHaveLength(2) // 重试上限 1 次
    rmSync(dir, { recursive: true, force: true })
  })

  it('模型故障（非格式）不触发格式重试：modelRecovery 语义保留', async () => {
    const requests: ModelRequest[] = []
    const { runner, dir } = makeRunner(queueTransport([], requests)) // 队列耗尽 → transport 抛错
    await expect(runner.runExtraction(SAMPLE_INPUT)).rejects.toThrow()
    expect(requests).toHaveLength(1)
    rmSync(dir, { recursive: true, force: true })
  })

  it('prompt 注入报告与校准上下文（G12），数量上限进 system', async () => {
    const requests: ModelRequest[] = []
    const { runner, dir } = makeRunner(queueTransport(['[]'], requests))
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
    expect(promptText).toContain('6 条以内')
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
