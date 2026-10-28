<template>
	<view class="page">
		<!-- 顶栏：日期切换 + 补跑（只跑自己的） -->
		<view class="row head">
			<picker mode="selector" :range="available" @change="onPickDate">
				<view class="btn ghost sm date-btn">{{ date || (emptyText ? '暂无日报' : '加载中…') }} ▾</view>
			</picker>
			<view class="grow"></view>
			<button class="btn sm" :disabled="busy" @click="onRun">{{ busy ? '生成中…' : '补跑今日' }}</button>
		</view>

		<!-- 质检未过审提醒（pass=false 也照常显示日报，如实标黄） -->
		<view v-if="verdictFail" class="card warn-card">⚠️ 本期质检未过审——critic 挑刺见 status，日报内容按现状交付（star/信源请自行甄别）</view>

		<!-- 生成进度时间线：跑批时显示（SSE 实时推 / App 端轮询降级） -->
		<view v-if="timeline.length" class="card">
			<view class="row"><text class="card-title">生成进度</text><view class="grow"></view><text class="muted">{{ busy ? '跑批中…' : '已完成' }}</text></view>
			<view v-for="(e, i) in timeline" :key="i" class="tl-row">
				<text class="tl-icon">{{ icon(e.stage) }}</text>
				<view class="grow">
					<text>{{ e.message }}</text>
					<text class="muted tl-time">{{ e.ts.slice(11, 19) }}</text>
				</view>
			</view>
		</view>

		<!-- 日报正文：marked 渲染 + DOMPurify 出口过滤（v2 威胁模型：RSS 标题是外部输入会进日报，
		     marked 不转义内嵌 HTML——v1 单机「源头收敛」够用，多租户公网下出口必须再过一道） -->
		<view class="card md-card">
			<view v-if="emptyText" class="empty">
				<text class="empty-title">📭 还没有日报</text>
				<text class="muted">{{ emptyText.replace(/^还没有日报（|）$/g, '') }}</text>
			</view>
			<view v-else class="md-body" v-html="html"></view>
		</view>
	</view>
</template>

<script setup lang="ts">
import { onShow, onUnload } from '@dcloudio/uni-app'
import { ref } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { fetchReport, triggerRun, watchProgress, isTerminal, type ProgressEvent } from '../../api'

const date = ref('')
const html = ref('')
const available = ref<string[]>([])
const timeline = ref<ProgressEvent[]>([])
const busy = ref(false)
const verdictFail = ref(false)
const emptyText = ref('')
let unwatch: (() => void) | null = null

const onShowHook = onShow(async () => {
	await load('') // 进页面拿最新（未登录 401 → api 层跳登录页）
	// 「生成中」检测：progress 非终态（server 的 running 只覆盖它自己 spawn 的——cron 起的用事件流判定）
	const cur = await fetchReport().catch(() => null)
	if (cur && cur.progress.length > 0 && !isTerminal(cur.progress)) startWatch(cur.progress)
})

onUnload(() => unwatch?.())

async function load(d: string) {
	try {
		const j = await fetchReport(d || undefined)
		date.value = j.date
		available.value = j.available
		html.value = DOMPurify.sanitize(marked.parse(j.markdown) as string)
		verdictFail.value = j.status?.verdict?.pass === false
		emptyText.value = ''
	} catch (err: any) {
		if (err?.auth) return // 未登录：api 层已静默跳登录页，不再弹 toast
		// 404（还没有任何日报）走空态引导，不弹 toast、也不留一张空白卡
		emptyText.value = String(err?.message ?? err)
		html.value = ''
	}
}

function onPickDate(e: any) {
	const d = available.value[Number(e.detail.value)]
	if (d && d !== date.value) load(d)
}

async function onRun() {
	const r = await triggerRun().catch(() => null)
	if (r?.running) {
		uni.showToast({ title: '产线已在跑，等它落盘', icon: 'none' })
	}
	startWatch([])
}

function startWatch(initial: ProgressEvent[]) {
	timeline.value = [...initial]
	busy.value = true
	unwatch?.()
	unwatch = watchProgress((e) => {
		if (e.stage === 'connected') return // SSE 连接确认不进时间线
		timeline.value.push(e)
		// 终态（v2 加 skip：无订阅/预算熔断也算收口——收流重拉刷新提示）
		if (['done', 'notify', 'error', 'skip'].includes(e.stage)) {
			// 终态：收流重拉新日报（延迟 2s 等 notify 事件也到齐）
			setTimeout(async () => {
				unwatch?.()
				unwatch = null
				busy.value = false
				await load('')
			}, 2000)
		}
	})
}

const icon = (stage: string) => ({ start: '🚀', researcher: '🔍', writer: '✍️', critic: '🧪', done: '📦', notify: '📣', skip: '⏭️', error: '❌' }[stage] ?? '·')
</script>

<style>
.head {
	padding: 12px 16px 0;
}
.date-btn {
	min-width: 140px;
}
.warn-card {
	border-left: 4px solid #d29922;
}
/* 空态：没日报时给一句「下一步做什么」，不留一张空白卡 */
.empty {
	display: flex;
	flex-direction: column;
	gap: 10px;
	padding: 28px 8px;
	align-items: center;
}
.empty-title {
	font-weight: 600;
	color: #57606a;
}
.card-title {
	font-weight: 600;
}
.tl-row {
	display: flex;
	gap: 8px;
	padding: 6px 0;
	border-bottom: 1px dashed #eaeef2;
	font-size: 14px;
}
.tl-row:last-child {
	border-bottom: none;
}
.tl-icon {
	font-size: 16px;
}
.tl-time {
	display: block;
}
/* 日报 markdown 样式：手机可读性优先（v1 原样） */
.md-body {
	line-height: 1.75;
	word-break: break-word;
}
.md-body h1 {
	font-size: 20px;
	margin: 4px 0 12px;
}
.md-body h2 {
	font-size: 17px;
	margin: 18px 0 8px;
	padding-bottom: 6px;
	border-bottom: 1px solid #eaeef2;
}
.md-body a {
	color: #1f6feb;
	text-decoration: none;
}
.md-body ul {
	padding-left: 20px;
}
.md-body li {
	margin: 8px 0;
}
.md-body strong {
	color: #111;
}
.md-body blockquote {
	border-left: 3px solid #d0d7de;
	padding-left: 10px;
	color: #57606a;
	margin: 10px 0;
}
.md-body code {
	background: #f6f8fa;
	padding: 2px 5px;
	border-radius: 4px;
	font-size: 13px;
}
</style>
