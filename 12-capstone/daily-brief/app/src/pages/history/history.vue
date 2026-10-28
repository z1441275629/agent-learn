<template>
	<view class="page">
		<!-- 累计总账四卡：跨日成本聚合（history.json.totals） -->
		<view class="grid">
			<view class="card cell"><text class="num">{{ totals.runs }}</text><text class="muted">运行次数</text></view>
			<view class="card cell"><text class="num">{{ totals.calls }}</text><text class="muted">LLM 调用</text></view>
			<view class="card cell"><text class="num">{{ kTokens }}</text><text class="muted">tokens（入/出）</text></view>
			<view class="card cell"><text class="num">{{ hours }}</text><text class="muted">累计墙钟</text></view>
		</view>

		<view class="card">
			<view class="row"><text class="card-title">运行记录</text><view class="grow"></view><text class="muted">每次运行一条（补跑也按次记）</text></view>
			<view v-for="(r, i) in runs" :key="i" class="run-row">
				<view class="row">
					<text class="date">{{ r.date }} {{ r.startedAt?.slice(11, 16) }}</text>
					<text :class="r.pass ? 'pass' : 'fail'">{{ r.pass ? '过审' : '未过' }}</text>
					<view class="grow"></view>
					<text class="muted">{{ (r.elapsedMs / 1000).toFixed(0) }}s</text>
				</view>
				<text class="muted detail">{{ r.topics }} 主题 · 精选 {{ r.selected }} 条 · {{ r.calls }} 调用 · {{ r.promptTokens + r.completionTokens }} tokens</text>
			</view>
			<view v-if="!runs.length" class="muted">还没有运行记录</view>
		</view>
	</view>
</template>

<script setup lang="ts">
import { onShow } from '@dcloudio/uni-app'
import { ref, computed } from 'vue'
import { fetchHistory } from '../../api'

const totals = ref({ runs: 0, calls: 0, promptTokens: 0, completionTokens: 0, elapsedMs: 0 })
const runs = ref<any[]>([])

onShow(async () => {
	const j = await fetchHistory().catch(() => null)
	if (j) {
		totals.value = j.totals
		runs.value = [...j.runs].reverse() // 新的在上
	}
})

const kTokens = computed(() => {
	const t = totals.value
	return `${(t.promptTokens / 1000).toFixed(1)}k/${(t.completionTokens / 1000).toFixed(1)}k`
})
const hours = computed(() => (totals.value.elapsedMs / 3600000).toFixed(1) + 'h')
</script>

<style>
.grid {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: 0 12px;
	padding: 12px 16px 0;
}
.cell {
	display: flex;
	flex-direction: column;
	align-items: center;
	margin: 0 0 12px;
}
.num {
	font-size: 22px;
	font-weight: 700;
}
.card-title {
	font-weight: 600;
}
.run-row {
	padding: 10px 0;
	border-bottom: 1px dashed #eaeef2;
}
.run-row:last-child {
	border-bottom: none;
}
.date {
	font-weight: 600;
	font-size: 14px;
}
.pass {
	color: #1a7f37;
	font-size: 12px;
	border: 1px solid #1a7f37;
	border-radius: 4px;
	padding: 0 6px;
}
.fail {
	color: #d1242f;
	font-size: 12px;
	border: 1px solid #d1242f;
	border-radius: 4px;
	padding: 0 6px;
}
.detail {
	display: block;
	margin-top: 2px;
}
</style>
