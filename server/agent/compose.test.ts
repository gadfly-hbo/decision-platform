import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPiTransport, type ModelConfig, type ModelTransport, type RuntimeOptions } from 'pi-agent-runtime'
import { composeAgent } from './compose'

const dirs: string[] = []
function directory() { const dir = mkdtempSync(join(tmpdir(), 'dp-compose-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const model: ModelConfig = { provider: 'synthetic-primary', id: 'synthetic-primary', protocol: 'openai-completions', endpoint: 'https://example.invalid/v1', contextWindow: 128_000, maxOutputTokens: 8192 }
const fallback: ModelConfig = { ...model, provider: 'synthetic-fallback', id: 'synthetic-fallback' }
const valid = JSON.stringify([{ title: '合成核查', rationale: '合成依据', expectedImpact: '待验证', priority: 'low', effort: 'low', evidence: { facts: [{ text: '指标变化', quote: '10 to 8' }], level: '数据支撑', reasoning: '合成' } }])
const input = (taskId: string) => ({ taskId, reportName: `${taskId}.md`, reportContent: 'synthetic metric 10 to 8' })
function reply(text: string) { return { content: [{ kind: 'text' as const, text }], stop: 'complete' as const, usage: { inputTokens: 10, outputTokens: 20 } } }
function sse(text: string) {
  const chunks = [
    { id: 'test', object: 'chat.completion.chunk', created: 1, model: 'synthetic', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] },
    { id: 'test', object: 'chat.completion.chunk', created: 1, model: 'synthetic', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } },
  ]
  return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
}
function codec(primaryResponses: Array<string | 503>, fallbackResponses: Array<string | 503> = [], authorize?: RuntimeOptions['authorize']) {
  const calls: string[] = []
  function transport(config: ModelConfig, responses: Array<string | 503>) {
    return createPiTransport({ model: config, apiKey: 'synthetic-only', fetch: async () => {
      calls.push(config.id)
      const response = responses.shift()
      if (response === 503) return new Response('{"error":{"message":"synthetic unavailable"}}', { status: 503, headers: { 'content-type': 'application/json' } })
      return sse(response ?? valid)
    } })
  }
  const composition = composeAgent(directory(), [{ model, transport: transport(model, primaryResponses) }, { model: fallback, transport: transport(fallback, fallbackResponses) }], authorize)
  return { ...composition, calls }
}

describe('DP-RECOVERY-01 one recovery allowance per logical extraction', () => {
  it('real codec: primary success needs one call', async () => {
    const agent = codec([valid])
    expect(await agent.runner.runExtraction(input('success'))).toHaveLength(1)
    expect(agent.calls).toEqual([model.id])
  })
  it('real codec: malformed primary output can use the one repair attempt', async () => {
    const agent = codec(['[{invalid', valid])
    expect(await agent.runner.runExtraction(input('json-repair'))).toHaveLength(1)
    expect(agent.calls).toEqual([model.id, model.id])
  })
  it('real codec: primary failure then fallback success spends one recovery', async () => {
    const agent = codec([503], [valid])
    expect(await agent.runner.runExtraction(input('fallback'))).toHaveLength(1)
    expect(agent.calls).toEqual([model.id, fallback.id])
    expect(agent.store.usageOf('fallback')).toMatchObject({ modelCalls: 2, reservedOutputTokens: 8192 })
  })
  it('real codec: fallback malformed JSON cannot start a third call, even when it would succeed', async () => {
    const agent = codec([503, 503], ['[{invalid', valid])
    await expect(agent.runner.runExtraction(input('stacked-recovery'))).rejects.toThrow()
    expect(agent.calls).toEqual([model.id, fallback.id])
    expect(agent.store.usageOf('stacked-recovery')).toMatchObject({ modelCalls: 2, inputTokens: 10, outputTokens: 8212, reservedOutputTokens: 8192 })
  })
  it('real codec: JSON repair transport failure cannot add fallback as a third call', async () => {
    const agent = codec(['[{invalid', 503], [valid])
    await expect(agent.runner.runExtraction(input('repair-fallback'))).rejects.toThrow()
    expect(agent.calls).toEqual([model.id, model.id])
    expect(agent.store.usageOf('repair-fallback')?.modelCalls).toBe(2)
  })
  it('explicit later invocation uses a fresh allowance but preserves same-task cumulative accounting', async () => {
    const agent = codec([valid, '[{invalid', valid])
    await agent.runner.runExtraction(input('same-task'))
    expect(await agent.runner.runExtraction(input('same-task'))).toHaveLength(1)
    expect(agent.calls).toHaveLength(3)
    expect(agent.store.usageOf('same-task')).toMatchObject({ modelCalls: 3, inputTokens: 30, outputTokens: 60, reservedOutputTokens: 0 })
  })
  it('concurrent projects have independent allowances without sharing mutable counters', async () => {
    let calls = 0
    const transport: ModelTransport = async () => { calls++; return reply('[{invalid') }
    const agent = composeAgent(directory(), [{ model, transport }])
    const results = await Promise.allSettled(['project-a', 'project-b'].map(id => agent.runner.runExtraction(input(id))))
    expect(results.every(result => result.status === 'rejected')).toBe(true)
    expect(calls).toBe(4)
    expect(agent.store.usageOf('project-a')?.modelCalls).toBe(2)
    expect(agent.store.usageOf('project-b')?.modelCalls).toBe(2)
  })
  it('same-task concurrent invocation cannot reset the active allowance', async () => {
    let release!: () => void
    let entered!: () => void
    const enteredPromise = new Promise<void>(resolve => { entered = resolve })
    const hold = new Promise<void>(resolve => { release = resolve })
    let calls = 0
    const agent = composeAgent(directory(), [{ model, transport: async () => { calls++; entered(); await hold; return reply(valid) } }])
    const first = agent.runner.runExtraction(input('busy'))
    await enteredPromise
    try { await expect(agent.runner.runExtraction(input('busy'))).rejects.toThrow() }
    finally { release() }
    expect(await first).toHaveLength(1)
    expect(calls).toBe(1)
  })
  it('host authority is checked on each attempt; revocation blocks repair before transport', async () => {
    let modelAdmissions = 0
    const agent = codec(['[{invalid', valid], [], async action => action.kind !== 'model' || ++modelAdmissions === 1)
    await expect(agent.runner.runExtraction(input('revoked'))).rejects.toThrow()
    expect(agent.calls).toHaveLength(1)
    expect(modelAdmissions).toBe(2)
  })
})
