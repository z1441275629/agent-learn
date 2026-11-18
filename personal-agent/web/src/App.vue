<script setup lang="ts">
import AppHeader from './components/common/AppHeader.vue'
import ConfirmHost from './components/chat/ConfirmHost.vue'
</script>

<template>
  <AppHeader />
  <div class="app-body">
    <!-- keep-alive 保 ChatPane/OcrPane 实例：切到管理页再回来，对话与识别结果不丢 -->
    <router-view v-slot="{ Component }">
      <keep-alive :include="['ChatPane', 'OcrPane']">
        <component :is="Component" />
      </keep-alive>
    </router-view>
  </div>
  <ConfirmHost />
</template>
