<script setup lang="ts">
import { computed } from 'vue'
import { markdownToHtml } from '../../utils/markdown'

const props = defineProps<{ source: string }>()
// markdownToHtml 先整体转义再插白名单标签——v-html 在这里是安全的
const html = computed(() => markdownToHtml(props.source))
</script>

<template>
  <div class="markdown" v-html="html"></div>
</template>

<style scoped>
.markdown :deep(p) {
  margin: 6px 0;
}

.markdown :deep(h1),
.markdown :deep(h2),
.markdown :deep(h3) {
  margin: 10px 0 6px;
  line-height: 1.35;
}

.markdown :deep(h1) {
  font-size: 18px;
}

.markdown :deep(h2) {
  font-size: 16px;
}

.markdown :deep(h3) {
  font-size: 15px;
}

.markdown :deep(ul) {
  margin: 6px 0;
  padding-left: 20px;
}

.markdown :deep(pre) {
  background: #0f172a;
  color: #e5e7eb;
  padding: 10px 12px;
  border-radius: 8px;
  overflow-x: auto;
  font-size: 13px;
}

.markdown :deep(code) {
  background: #f1f3f5;
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 13px;
}

.markdown :deep(pre code) {
  background: transparent;
  padding: 0;
}

.markdown :deep(a) {
  color: var(--accent);
}

.markdown :deep(table) {
  border-collapse: collapse;
  margin: 8px 0;
  font-size: 13px;
  display: block; /* 宽表整块横向滚，不撑破气泡 */
  max-width: 100%;
  overflow-x: auto;
}

.markdown :deep(th),
.markdown :deep(td) {
  border: 1px solid var(--line);
  padding: 5px 10px;
}

.markdown :deep(th) {
  background: #f6f8fa;
}

.markdown :deep(img) {
  max-width: 100%;
  border-radius: 8px;
  border: 1px solid #e2e8f0;
  margin: 6px 0;
}

.markdown :deep(.gap) {
  height: 6px;
}
</style>
