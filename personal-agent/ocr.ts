// 个人 Agent 工作台 · 模块 13 第一件：截图取字（OCR 核心）
//
// 选型记录（2026-11-03 实测）：视觉 LLM 三条路全堵——火山 Coding Plan 明确不支持视觉模型
// （UnsupportedModel）、平台端点没开视觉模型、GLM 视觉撞 5 小时配额。且 OCR 是确定性任务，
// 交给会幻觉的 LLM 本身就不对：本地 tesseract（chi_sim 模型自带拉丁字母）免费、离线、
// 带逐行坐标（=「点一行复制一行」的 UX 基础）。翻译才走文本 LLM（translate.ts）。
//
// 语言包从 npm 包 @tesseract.js-data/{chi_sim,eng} 拷进 .tessdata/（gitignored）——
// tesseract.js 默认从 jsdelivr 拉，本机被墙（2026-11-03 实测 000）。ensure-langdata 自愈：
// 缺文件就从 node_modules 补，克隆仓库后 npm i 即可跑。
import fs from 'node:fs'
import path from 'node:path'
import { createWorker } from 'tesseract.js'

const DIR = import.meta.dirname
const TESSDATA = path.join(DIR, '.tessdata')
const LANGS = ['chi_sim'] as const // 多语言 'chi_sim+eng' 在 Windows 上会拼出乱码语言名（实测），单 chi_sim 已含拉丁

export interface OcrLine {
	id: number
	text: string
	/** 本地引擎有置信度；AI 引擎没有（模型不给可靠置信度，别伪造一个数字） */
	confidence?: number
	/** 本地引擎有坐标；AI 引擎没有（LLM 报坐标幻觉严重，不给假坐标） */
	bbox?: { x0: number; y0: number; x1: number; y1: number }
}
export interface OcrResult {
	engine: 'local' | 'ai'
	text: string
	lines: OcrLine[]
	confidence?: number
	elapsedMs: number
}

// 语言包自愈：npm 包装好后一份拷过来（只在缺的时候做，~20MB 不重复拷）
function ensureLangData(): void {
	fs.mkdirSync(TESSDATA, { recursive: true })
	fs.mkdirSync(path.join(TESSDATA, 'cache'), { recursive: true }) // cachePath 目录不存在时写缓存静默失败（每次重启重新解压）

	for (const lang of LANGS) {
		const dst = path.join(TESSDATA, `${lang}.traineddata.gz`)
		if (fs.existsSync(dst)) continue
		const src = path.join(DIR, '..', 'node_modules', '@tesseract.js-data', lang, '4.0.0_best_int', `${lang}.traineddata.gz`)
		if (!fs.existsSync(src)) throw new Error(`缺语言包：${src}——先 npm i @tesseract.js-data/${lang}`)
		fs.copyFileSync(src, dst)
	}
}

// 中文 OCR 习惯性在汉字间夹空格（「发 票 金 额」）——合并，否则复制出来是一堆碎片。
// 只合并「CJK 与 CJK 之间」的空格：中英混排的 "Hello 世界" 中间那个空格保留。
export function normalizeCjk(s: string): string {
	return s.replace(/(?<=[㐀-鿿＀-￯])\s+(?=[㐀-鿿＀-￯])/g, '')
}

// worker 单例：初始化（加载 wasm+语言包）约 1s，每次重建太亏；server 长驻复用
let workerPromise: Promise<Awaited<ReturnType<typeof createWorker>>> | null = null
function getWorker() {
	if (!workerPromise) {
		ensureLangData()
		// cachePath 必须显式给：默认 '.' 会把解压后的 traineddata（~7MB）落到进程 cwd——
		// 从仓库根起服务时根目录凭空多出 chi_sim.traineddata（实录）。收进 .tessdata/（gitignored）。
		workerPromise = createWorker(LANGS[0], 1, { langPath: TESSDATA, cachePath: path.join(TESSDATA, 'cache'), gzip: true }).catch((err) => {
			workerPromise = null // 初始化失败清掉，下次重试（别把坏掉的 Promise 永久缓存）
			throw err
		})
	}
	return workerPromise
}

export async function recognize(image: Buffer): Promise<OcrResult> {
	const t0 = Date.now()
	const w = await getWorker()
	// 默认输出只有 text：要坐标必须显式要 blocks（v6 默认 output={text:true}）
	const { data } = (await w.recognize(image, {}, { text: true, blocks: true })) as any
	const raw: any[] = (data.blocks ?? []).flatMap((b: any) => b.paragraphs ?? []).flatMap((p: any) => p.lines ?? [])
	const lines: OcrLine[] = raw
		.map((l: any) => ({
			text: normalizeCjk(String(l.text ?? '').replace(/\s+$/, '').trim()),
			confidence: Number(l.confidence ?? 0),
			bbox: l.bbox,
		}))
		.filter((l) => l.text.length > 0)
		// 按版面顺序排（上→下、左→右）：tesseract 的块顺序偶尔跳，坐标排一遍才稳定
		.sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0)
		.map((l, i) => ({ id: i, ...l }))
	return {
		engine: 'local',
		text: normalizeCjk(String(data.text ?? '').trim()),
		lines,
		confidence: Number(data.confidence ?? 0),
		elapsedMs: Date.now() - t0,
	}
}

export async function terminateOcr(): Promise<void> {
	if (!workerPromise) return
	const w = await workerPromise.catch(() => null)
	await w?.terminate().catch(() => {})
	workerPromise = null
}
