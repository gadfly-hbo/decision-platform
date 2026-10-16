declare module 'word-extractor' {
  /** word-extractor（无官方类型）：仅声明本项目用到的最小面。 */
  export interface ExtractedDoc {
    getBody(): string
  }
  export default class WordExtractor {
    extract(buffer: Buffer): Promise<ExtractedDoc>
  }
}
