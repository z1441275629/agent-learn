<script setup lang="ts">
import { Delete } from '@element-plus/icons-vue'
import { ElMessageBox } from 'element-plus'
import type { SessionSummary } from '../../types'

defineProps<{
  sessions: SessionSummary[]
  sessionId: string | null
  /** 进行中的流式会话集合（useChat 模块单例），驱动条目上的呼吸点标记 */
  streamingSessions: Set<string>
  /** 分页：还有没加载完的（加载更多按钮的显示条件） */
  hasMore: boolean
  total: number
}>()
const emit = defineEmits<{ open: [id: string]; newChat: []; delete: [id: string]; loadMore: [] }>()

// updatedAt 是 ISO 串；列表里给个轻量的相对时间，比完整时间戳好扫读
function shortTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const now = new Date()
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString()
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (sameDay(d, now)) return hm
  if (sameDay(d, yesterday)) return `昨天 ${hm}`
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

// 删除要过确认弹窗（复用管理页模式）；取消走 reject 分支静默返回。
// 在跑会话的按钮是 disabled 的，这里再挡一道——双保险防误删正在生成的会话
async function confirmDelete(s: SessionSummary, running: boolean): Promise<void> {
  if (running) return
  try {
    await ElMessageBox.confirm(`删除会话「${s.title}」？不可恢复`, '删除会话', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  emit('delete', s.id)
}
</script>

<template>
  <aside class="session-sidebar">
    <button class="new-chat" @click="emit('newChat')">＋ 新对话</button>
    <div class="session-list">
      <!-- 条目从 button 换成 div：里面要嵌删除按钮，button 套 button 不是合法 HTML -->
      <div
        v-for="s in sessions"
        :key="s.id"
        class="session-item"
        :class="{ active: s.id === sessionId }"
        role="button"
        :title="s.title"
        @click="emit('open', s.id)"
      >
        <span class="title">{{ s.title }}</span>
        <span class="row">
          <span class="time">{{ shortTime(s.updatedAt) }}</span>
          <span v-if="streamingSessions.has(s.id)" class="run-dot" title="回答进行中"></span>
          <button
            class="del-btn"
            :disabled="streamingSessions.has(s.id)"
            :title="streamingSessions.has(s.id) ? '回答进行中，先停止再删除' : '删除会话'"
            @click.stop="confirmDelete(s, streamingSessions.has(s.id))"
          >
            <el-icon :size="13"><Delete /></el-icon>
          </button>
        </span>
      </div>
      <p v-if="!sessions.length" class="empty">还没有历史会话</p>
      <button v-if="hasMore" class="load-more" @click="emit('loadMore')">
        加载更多（{{ sessions.length }}/{{ total }}）
      </button>
    </div>
  </aside>
</template>

<style scoped>
.session-sidebar {
  width: 232px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--line);
  background: var(--card);
  min-height: 0;
}

.new-chat {
  margin: 12px 12px 8px;
  padding: 9px 12px;
  font: inherit;
  font-size: 14px;
  border: 1px solid var(--accent);
  border-radius: 10px;
  background: var(--accent-soft);
  color: var(--accent);
  cursor: pointer;
  white-space: nowrap;
}

.new-chat:hover {
  background: #e3e9ff;
}

.session-list {
  flex: 1;
  overflow-y: auto;
  padding: 0 8px 12px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.session-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  padding: 8px 10px;
  border: none;
  border-radius: 10px;
  background: transparent;
  text-align: left;
  cursor: pointer;
  min-width: 0;
}

.session-item:hover {
  background: var(--bg);
}

.session-item.active {
  background: var(--accent-soft);
}

.title {
  font-size: 13px;
  line-height: 1.4;
  color: var(--text);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-item.active .title {
  color: var(--accent);
  font-weight: 600;
}

.row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.time {
  font-size: 11px;
  color: var(--muted);
}

.run-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
  animation: pulse 1.2s ease-in-out infinite;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 0.35;
  }
  50% {
    opacity: 1;
  }
}

.empty {
  font-size: 13px;
  color: var(--muted);
  text-align: center;
  padding: 18px 0;
}

/* 删除按钮：hover 浮出（透明度过渡），在跑禁用置灰 */
.del-btn {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 3px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s;
}

.session-item:hover .del-btn {
  opacity: 1;
}

.del-btn:hover {
  color: var(--el-color-danger, #f56c6c);
  background: var(--bg);
}

.del-btn:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.del-btn:disabled:hover {
  color: var(--muted);
  background: transparent;
}

.load-more {
  margin: 10px 4px 2px;
  padding: 7px 10px;
  width: calc(100% - 8px);
  font: inherit;
  font-size: 12px;
  color: var(--muted);
  background: transparent;
  border: 1px dashed var(--line);
  border-radius: 8px;
  cursor: pointer;
  white-space: nowrap;
}

.load-more:hover {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--accent-soft);
}
</style>
