// 截图取字状态（两条引擎路线共用同一套 UI 形状：AI 路线没有 bbox/置信度，界面自动降级）

import { computed, ref, watch } from 'vue'
import { runOcr } from '../api'
import type { Bbox, OcrLine, OcrResponse } from '../types'
import { formatUsage } from '../utils/usage'

export type Engine = 'local' | 'ai'
const ENGINE_KEY = 'pa.engine'

export function useOcr() {
  const engine = ref<Engine>(localStorage.getItem(ENGINE_KEY) === 'ai' ? 'ai' : 'local')
  watch(engine, (value) => localStorage.setItem(ENGINE_KEY, value))

  const translate = ref(true)
  const imageUrl = ref('')
  const result = ref<OcrResponse | null>(null)
  const busy = ref(false)
  const error = ref('')
  const activeBbox = ref<Bbox | null>(null)
  let totalSeconds = ref(0)

  const lines = computed<OcrLine[]>(() => result.value?.lines ?? [])
  const translationMap = computed(() => new Map((result.value?.translations ?? []).map((t) => [t.id, t.zh])))

  /** meta 行：引擎 / 行数 / 置信 / 耗时 / 两条链路的 usage（有就显示，没有就跳过） */
  const metaText = computed(() => {
    const r = result.value
    if (!r) return ''
    const bits = [
      r.engine === 'ai' ? 'AI 识别' : '本地 OCR',
      `${r.lines.length} 行`,
      typeof r.confidence === 'number' ? `置信 ${Math.round(r.confidence)}%` : '',
      `OCR ${r.elapsedMs}ms`,
      `共 ${totalSeconds.value.toFixed(1)}s`,
      formatUsage(r.usage),
      r.translateError ? '' : formatUsage(r.translateUsage),
    ].filter(Boolean)
    return bits.join(' · ')
  })

  async function recognize(dataUrl: string): Promise<void> {
    if (busy.value) return
    error.value = ''
    imageUrl.value = dataUrl
    result.value = null
    activeBbox.value = null
    busy.value = true
    const t0 = performance.now()
    try {
      result.value = await runOcr({ image: dataUrl, engine: engine.value, translate: translate.value })
      totalSeconds.value = (performance.now() - t0) / 1000
      if (result.value.translateError) {
        error.value = '翻译服务失败：' + result.value.translateError + '——OCR 结果不受影响'
      }
    } catch (e: any) {
      error.value = '识别失败：' + (e?.message ?? e)
    } finally {
      busy.value = false
    }
  }

  function clear(): void {
    imageUrl.value = ''
    result.value = null
    error.value = ''
    activeBbox.value = null
    totalSeconds.value = 0
  }

  function hover(bbox: Bbox | null): void {
    activeBbox.value = bbox
  }

  return {
    engine,
    translate,
    imageUrl,
    result,
    busy,
    error,
    activeBbox,
    lines,
    translationMap,
    metaText,
    recognize,
    clear,
    hover,
  }
}
