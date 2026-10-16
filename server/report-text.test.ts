import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { deflateSync } from 'node:zlib'
import { createCanvas } from '@napi-rs/canvas'
import { extractReportContent } from './report-text'

/** 最小可解析 PDF（xref 偏移程序计算）；可选内嵌 RGB 图像（FlateDecode，/Im1 Do） */
function minimalPdf(text: string, withImage = false): Buffer {
  const contents = withImage ? `BT /F1 24 Tf 100 700 Td (${text}) Tj ET q 65 0 0 65 100 500 cm /Im1 Do Q` : `BT /F1 24 Tf 100 700 Td (${text}) Tj ET`
  const objs: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >>${withImage ? ' /XObject << /Im1 6 0 R >>' : ''} >> >>`,
    `<< /Length ${contents.length} >>\nstream\n${contents}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let imageBuf: Buffer | null = null
  if (withImage) {
    const rgb = Buffer.alloc(65 * 65 * 3, 128)
    imageBuf = deflateSync(rgb)
    objs.push(`<< /Type /XObject /Subtype /Image /Width 65 /Height 65 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${imageBuf.length} >>\nstream`)
  }
  // 图像流含二进制：整体按 Buffer 拼接（拉丁字符 + 二进制段）
  let out = Buffer.from('%PDF-1.4\n', 'latin1')
  const offsets: number[] = []
  for (const [idx, body] of objs.entries()) {
    offsets.push(out.length)
    out = Buffer.concat([out, Buffer.from(`${idx + 1} 0 obj\n`, 'latin1')])
    if (idx === 5 && imageBuf) {
      out = Buffer.concat([out, Buffer.from(`${body}\n`, 'latin1'), imageBuf, Buffer.from('\nendstream\nendobj\n', 'latin1')])
    } else {
      out = Buffer.concat([out, Buffer.from(`${body}\nendobj\n`, 'latin1')])
    }
  }
  const xrefPos = out.length
  let tail = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) tail += `${String(off).padStart(10, '0')} 00000 n \n`
  tail += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`
  return Buffer.concat([out, Buffer.from(tail, 'latin1')])
}

function zipWith(files: Record<string, string | Buffer>): Promise<Buffer> {
  const zip = new JSZip()
  for (const [name, content] of Object.entries(files)) zip.file(name, content)
  return zip.generateAsync({ type: 'nodebuffer' })
}

/** 生成 >3KB 的噪声 PNG（小图会被 office media 阈值过滤）；mulberry32 伪随机保证不可压缩 */
function noisyPng(size = 100): Buffer {
  let state = 42
  const rand = () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const canvas = createCanvas(size, size)
  const ctx = canvas.getContext('2d')
  const imageData = ctx.createImageData(size, size)
  for (let i = 0; i < imageData.data.length; i++) imageData.data[i] = Math.floor(rand() * 256)
  ctx.putImageData(imageData, 0, 0)
  return canvas.toBuffer('image/png')
}

describe('extractReportContent（多格式 → 文本 + 图像）', () => {
  it('文本类（md/txt/csv）UTF-8 直读', async () => {
    await expect(extractReportContent('a.md', Buffer.from('# 标题', 'utf-8'))).resolves.toEqual({ text: '# 标题' })
    const csv = await extractReportContent('b.csv', Buffer.from('指标,数值\n复购率,9%', 'utf-8'))
    expect(csv.text).toContain('复购率')
  })

  it('文本类拒绝二进制/损坏编码（U+FFFD）', async () => {
    await expect(extractReportContent('a.md', Buffer.from([0xff, 0xfe, 0x82]))).rejects.toThrow('UTF-8')
  })

  it('图片文件：本体直送模型图像输入，无文本', async () => {
    const png = noisyPng(8)
    const result = await extractReportContent('截图.png', png)
    expect(result.text).toBe('')
    expect(result.images).toHaveLength(1)
    expect(result.images![0].mimeType).toBe('image/png')
    expect(Buffer.from(result.images![0].data, 'base64')).toEqual(png)
    await expect(extractReportContent('照片.jpg', Buffer.from('jpeg-bytes'))).resolves.toMatchObject({
      images: [{ mimeType: 'image/jpeg' }],
    })
  })

  it('pdf：文本层提取 + 整页渲染为图像输入（含内嵌位图页）', async () => {
    const withImage = await extractReportContent('r.pdf', minimalPdf('Hello Report 2026', true))
    expect(withImage.text).toContain('Hello Report 2026')
    expect(withImage.images).toHaveLength(1)
    expect(withImage.images![0].mimeType).toBe('image/png')
    expect(withImage.images![0].data.length).toBeGreaterThan(0)

    const textOnly = await extractReportContent('r.pdf', minimalPdf('Hello Report 2026'))
    expect(textOnly.text).toContain('Hello Report 2026')
    expect(textOnly.images).toHaveLength(1) // 纯文本页也渲染，图表/版式信息不丢
  })

  it('docx：段落文本（含 XML 实体解码）+ media 图片', async () => {
    const buf = await zipWith({
      'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>第一段 复购率 &amp; 9%</w:t></w:r></w:p><w:p><w:r><w:t>第二段</w:t></w:r></w:p></w:body></w:document>',
      'word/media/chart1.png': noisyPng(),
      'word/media/icon.gif': Buffer.from('GIF89a'), // < 3KB 过滤
    })
    const result = await extractReportContent('r.docx', buf)
    expect(result.text).toBe('第一段 复购率 & 9%\n第二段')
    expect(result.images).toHaveLength(1)
    expect(result.images![0].mimeType).toBe('image/png')
  })

  it('pptx：按页序提取全部幻灯片文本 + media 图片', async () => {
    const buf = await zipWith({
      'ppt/slides/slide2.xml': '<p:sld><a:p><a:r><a:t>第二页</a:t></a:r></a:p></p:sld>',
      'ppt/slides/slide1.xml': '<p:sld><a:p><a:r><a:t>第一页</a:t></a:r></a:p></p:sld>',
      'ppt/media/trend.png': noisyPng(),
    })
    const result = await extractReportContent('r.pptx', buf)
    expect(result.text).toBe('第一页\n\n第二页')
    expect(result.images).toHaveLength(1)
  })

  it('xlsx：共享字符串/内联串/数值，行内 tab 分隔', async () => {
    const buf = await zipWith({
      'xl/sharedStrings.xml': '<sst><si><t>指标</t></si><si><r><t>复购</t></r><r><t>率</t></r></si></sst>',
      'xl/worksheets/sheet1.xml':
        '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>内联</t></is></c><c r="B2"><v>9.5</v></c></row></sheetData></worksheet>',
    })
    const result = await extractReportContent('r.xlsx', buf)
    expect(result.text).toBe('指标\t复购率\n内联\t9.5')
  })

  it('负向：不支持格式 / 损坏 zip / 损坏 pdf / 空文本且无图像', async () => {
    await expect(extractReportContent('a.exe', Buffer.from('MZ'))).rejects.toThrow('不支持的报告格式')
    await expect(extractReportContent('a.docx', Buffer.from('not a zip'))).rejects.toThrow('不是有效的 Office 文档')
    await expect(extractReportContent('a.pdf', Buffer.from('garbage'))).rejects.toThrow('PDF 解析失败')
    await expect(extractReportContent('a.md', Buffer.from('   \n ', 'utf-8'))).rejects.toThrow('未能从文件中提取到文本或图像')
  })
})
