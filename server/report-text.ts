import {
  isSupportedReportFile,
  isTextReportFile,
  reportExtension,
  reportImageMime,
  REPORT_FORMAT_HINT,
  type ReportImageMime,
} from '../src/data/report-formats'

/**
 * 报告内容装载（M9 多格式 + 视觉）：上传落盘的原始字节 → 抽取管线的模型输入（文本 + 图像）。
 * - 文本类（md/txt/csv）：UTF-8 直接解码（拒绝 U+FFFD 替换字符）；
 * - pdf：pdfjs-dist 逐页文本层 + 整页渲染为 PNG（pdfjs NodeCanvasFactory → @napi-rs/canvas；矢量图表/扫描页与位图统一覆盖）；
 * - docx/pptx/xlsx：OOXML（zip）解包抽取 XML 文本节点 + media 目录内嵌图片；
 * - doc（OLE 旧格式）：word-extractor（仅文本，内嵌图像不支持）；
 * - 图片（png/jpg/jpeg/webp/gif）：本体直送。
 * 图像一律不做本地 OCR——主模型 MiniMax-M3 原生多模态，图像作为 InputImage 与正文一并送抽取
 * （本层不依赖 pi-agent-runtime，ReportImage 结构与 InputImage 对齐，在 server/agent/extract.ts 接缝收敛）。
 * 失败一律抛中文错误，由报告管线落 failed 供前端重试。
 */

/** 图片输入（结构对齐 pi-agent-runtime InputImage；本文件不进 runtime 依赖） */
export interface ReportImage {
  data: string
  mimeType: ReportImageMime
}

export interface ReportContent {
  /** 文本正文；纯图片/纯扫描页报告可为 '' */
  text: string
  /** 图像输入（图片报告本体 / pdf 页面渲染 / office 内嵌图像）；上界见 MAX_IMAGES */
  images?: ReportImage[]
}

/** 单报告图像上限（防超长 pptx/pdf 撑爆单次请求与 token 预算） */
const MAX_IMAGES = 8
/** PDF 页面渲染倍率（A4 ≈ 918×1188，识别清晰度与 token 成本的平衡点） */
const PDF_RENDER_SCALE = 1.5
/** Office media 过滤：小于此文件字节数视为项目符号/图标不提取 */
const MIN_OFFICE_IMAGE_BYTES = 3 * 1024

export async function extractReportContent(filename: string, buffer: Buffer): Promise<ReportContent> {
  if (!isSupportedReportFile(filename)) throw new Error(`不支持的报告格式：${filename}（${REPORT_FORMAT_HINT}）`)
  const imageMime = reportImageMime(filename)
  if (imageMime) return { text: '', images: [{ data: buffer.toString('base64'), mimeType: imageMime }] }
  const ext = reportExtension(filename)
  let content: ReportContent
  if (isTextReportFile(filename)) {
    content = { text: decodeUtf8(buffer) }
  } else if (ext === '.pdf') {
    content = await pdfToContent(buffer)
  } else if (ext === '.docx') {
    content = await docxToContent(buffer)
  } else if (ext === '.doc') {
    content = { text: await docToText(buffer) }
  } else if (ext === '.pptx') {
    content = await pptxToContent(buffer)
  } else {
    content = await xlsxToContent(buffer)
  }
  const cleaned = content.text.replace(/\r\n?/g, '\n').trim()
  const images = content.images ?? []
  if (cleaned === '' && images.length === 0) {
    throw new Error('未能从文件中提取到文本或图像内容（文件可能为空或已损坏）')
  }
  return { text: cleaned, ...(images.length > 0 ? { images } : {}) }
}

function decodeUtf8(buffer: Buffer): string {
  const content = buffer.toString('utf-8')
  if (content.includes('\uFFFD')) throw new Error('内容无法按 UTF-8 解码（检测到二进制/损坏编码）')
  return content
}

// ---- pdf ----

async function pdfToContent(buffer: Buffer): Promise<ReportContent> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task = getDocument({ data: new Uint8Array(buffer), standardFontDataUrl: 'node_modules/pdfjs-dist/standard_fonts/' })
  try {
    const doc = await task.promise
    const pages: string[] = []
    const images: ReportImage[] = []
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      const line = content.items.map((item) => ('str' in item ? item.str : '')).join('')
      if (line.trim() !== '') pages.push(line)
      if (images.length < MAX_IMAGES) {
        try {
          images.push(await renderPdfPage(page))
        } catch {
          // 单页渲染失败不阻断文本与其他页
        }
      }
    }
    return { text: pages.join('\n'), images }
  } catch (error) {
    throw new Error(`PDF 解析失败（文件损坏或已加密）：${(error as Error).message}`)
  } finally {
    await task.destroy().catch(() => {})
  }
}

/** 整页渲染为 PNG（Node 环境 pdfjs 自动使用 NodeCanvasFactory → @napi-rs/canvas） */
async function renderPdfPage(page: import('pdfjs-dist/types/src/display/api').PDFPageProxy): Promise<ReportImage> {
  const { createCanvas } = await import('@napi-rs/canvas')
  const viewport = page.getViewport({ scale: PDF_RENDER_SCALE })
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
  await page.render({
    canvas: canvas as unknown as HTMLCanvasElement,
    canvasContext: canvas.getContext('2d') as unknown as CanvasRenderingContext2D,
    viewport,
  }).promise
  return { data: canvas.toBuffer('image/png').toString('base64'), mimeType: 'image/png' }
}

// ---- office（OOXML zip）：文本节点 + media 目录内嵌图片 ----

const OFFICE_MEDIA_RE = /^(?:ppt|word|xl)\/media\/[^/]+\.(png|jpe?g|gif|webp)$/i

async function collectOfficeMedia(zip: import('jszip'), images: ReportImage[]): Promise<void> {
  const names = Object.keys(zip.files).filter((name) => OFFICE_MEDIA_RE.test(name)).sort()
  for (const name of names) {
    if (images.length >= MAX_IMAGES) return
    const mime = reportImageMime(name)
    if (!mime) continue
    const buf = await zip.file(name)!.async('nodebuffer')
    if (buf.byteLength < MIN_OFFICE_IMAGE_BYTES) continue
    images.push({ data: buf.toString('base64'), mimeType: mime })
  }
}

async function docxToContent(buffer: Buffer): Promise<ReportContent> {
  const zip = await loadZip(buffer)
  const document = zip.file('word/document.xml')
  if (!document) throw new Error('docx 结构不完整（缺少 word/document.xml）')
  const xml = await document.async('string')
  const parts: string[] = []
  const re = /<w:t[^>]*>([^<]*)<\/w:t>|<\/w:p>/g
  let match: RegExpExecArray | null
  while ((match = re.exec(xml)) !== null) {
    parts.push(match[1] === undefined ? '\n' : decodeXmlEntities(match[1]))
  }
  const images: ReportImage[] = []
  await collectOfficeMedia(zip, images)
  return { text: parts.join(''), images }
}

async function docToText(buffer: Buffer): Promise<string> {
  const { default: WordExtractor } = await import('word-extractor')
  const extracted = await new WordExtractor().extract(buffer)
  return extracted.getBody()
}

async function pptxToContent(buffer: Buffer): Promise<ReportContent> {
  const zip = await loadZip(buffer)
  const slideNames = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => slideIndex(a) - slideIndex(b))
  if (slideNames.length === 0) throw new Error('pptx 结构不完整（缺少幻灯片）')
  const slides: string[] = []
  for (const name of slideNames) {
    const xml = await zip.file(name)!.async('string')
    const parts: string[] = []
    const re = /<a:t>([^<]*)<\/a:t>|<\/a:p>/g
    let match: RegExpExecArray | null
    while ((match = re.exec(xml)) !== null) {
      parts.push(match[1] === undefined ? '\n' : decodeXmlEntities(match[1]))
    }
    const slide = parts.join('').trim()
    if (slide !== '') slides.push(slide)
  }
  const images: ReportImage[] = []
  await collectOfficeMedia(zip, images)
  return { text: slides.join('\n\n'), images }
}

function slideIndex(name: string): number {
  return Number(name.match(/slide(\d+)\.xml$/)?.[1] ?? 0)
}

async function xlsxToContent(buffer: Buffer): Promise<ReportContent> {
  const zip = await loadZip(buffer)
  const shared = await readSharedStrings(zip)
  const sheetNames = Object.keys(zip.files)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort((a, b) => sheetIndex(a) - sheetIndex(b))
  if (sheetNames.length === 0) throw new Error('xlsx 结构不完整（缺少工作表）')
  const sheets: string[] = []
  for (const name of sheetNames) {
    const xml = await zip.file(name)!.async('string')
    const rows: string[] = []
    const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g
    let rowMatch: RegExpExecArray | null
    while ((rowMatch = rowRe.exec(xml)) !== null) {
      const cells: string[] = []
      const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g
      let cellMatch: RegExpExecArray | null
      while ((cellMatch = cellRe.exec(rowMatch[1])) !== null) {
        cells.push(readCell(cellMatch[1], cellMatch[2] ?? '', shared))
      }
      const row = cells.join('\t').trim()
      if (row !== '') rows.push(row)
    }
    if (rows.length > 0) sheets.push(rows.join('\n'))
  }
  const images: ReportImage[] = []
  await collectOfficeMedia(zip, images)
  return { text: sheets.join('\n\n'), images }
}

function sheetIndex(name: string): number {
  return Number(name.match(/sheet(\d+)\.xml$/)?.[1] ?? 0)
}

async function readSharedStrings(zip: import('jszip')): Promise<string[]> {
  const file = zip.file('xl/sharedStrings.xml')
  if (!file) return []
  const xml = await file.async('string')
  const strings: string[] = []
  const siRe = /<si>([\s\S]*?)<\/si>/g
  let match: RegExpExecArray | null
  while ((match = siRe.exec(xml)) !== null) {
    const parts = [...match[1].matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((t) => decodeXmlEntities(t[1]))
    strings.push(parts.join(''))
  }
  return strings
}

function readCell(attrs: string, inner: string, shared: string[]): string {
  const type = attrs.match(/\bt="([^"]+)"/)?.[1]
  if (type === 'inlineStr') {
    const parts = [...inner.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((t) => decodeXmlEntities(t[1]))
    return parts.join('')
  }
  const value = inner.match(/<v>([^<]*)<\/v>/)?.[1] ?? ''
  if (value === '') return ''
  if (type === 's') return shared[Number(value)] ?? ''
  return decodeXmlEntities(value)
}

async function loadZip(buffer: Buffer): Promise<import('jszip')> {
  const { default: JSZip } = await import('jszip')
  try {
    return await JSZip.loadAsync(buffer)
  } catch {
    throw new Error('文件损坏或格式不符（不是有效的 Office 文档）')
  }
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}
