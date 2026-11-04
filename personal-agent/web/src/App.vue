<script setup lang="ts">
import { ref } from 'vue'
import AppHeader from './components/common/AppHeader.vue'
import ToastHost from './components/common/ToastHost.vue'
import ChatPane from './components/chat/ChatPane.vue'
import OcrPane from './components/ocr/OcrPane.vue'

type Pane = 'chat' | 'ocr'
const pane = ref<Pane>('chat')
</script>

<template>
  <AppHeader :active="pane" @change="pane = $event" />
  <div class="app-body">
    <!-- v-show 而不是 v-if：切标签页不丢对话/识别结果 -->
    <ChatPane v-show="pane === 'chat'" :active="pane === 'chat'" />
    <OcrPane v-show="pane === 'ocr'" :active="pane === 'ocr'" />
  </div>
  <ToastHost />
</template>
