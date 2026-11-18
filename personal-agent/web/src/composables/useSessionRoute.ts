// 会话 id ↔ 路由绑定：route.params.id 是「当前打开哪个会话」的唯一事实源。
// 切会话只改路由（router.push），这个 watcher 把路由翻译成 openSession/newChat——
// 刷新、深链、前进后退走同一条路径。openSession 自身不回写路由（环路防护）。
import { watch } from 'vue'
import { useRoute } from 'vue-router'
import { useChat } from './useChat'

export function useSessionRoute(): void {
  const route = useRoute()
  const { openSession, newChat } = useChat()

  watch(
    () => route.params.id,
    (id) => {
      if (typeof id === 'string' && id) void openSession(id)
      else newChat()
    },
    { immediate: true },
  )
}
