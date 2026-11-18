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
    () => [route.name, route.params.id] as const,
    ([name, id]) => {
      // 只翻译聊天路由自身的变化。ChatPane 被 keep-alive 缓存，切到管理页时 watcher 还活着：
      // params.id 变 undefined 是「离开了聊天页」不是「要开新对话」——没有这道守卫，
      // 打开会话后点记忆/知识库会被 newChat 拽回 /chat（终审 C1）
      if (name !== 'chat') return
      if (typeof id === 'string' && id) void openSession(id)
      else newChat()
    },
    { immediate: true },
  )
}
