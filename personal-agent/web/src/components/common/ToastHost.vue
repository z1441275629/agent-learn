<script setup lang="ts">
import { toastText } from '../../utils/toast'
</script>

<template>
  <div class="toast" :class="{ on: !!toastText }">{{ toastText }}</div>
</template>
