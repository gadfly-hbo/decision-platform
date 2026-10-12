import type { AuditEvent, AuditSink } from 'pi-agent-runtime'
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * 审计（AGENT-RUNTIME §INTEGRATION 输入 4）：SDK 只发安全元数据（任务/运行/模型/工具/原因/序列），
 * 不含 prompt、回复原文或凭据。append 即持久化确认——失败必须上抛（SDK 据此关闭新准入），
 * 不排队、不吞错。JSONL 单文件追加。
 */
export class JsonlAuditSink implements AuditSink {
  constructor(private readonly filePath: string) {}

  async append(event: Readonly<AuditEvent>, _signal: AbortSignal): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    await appendFile(this.filePath, JSON.stringify(event) + '\n', 'utf-8')
  }
}
