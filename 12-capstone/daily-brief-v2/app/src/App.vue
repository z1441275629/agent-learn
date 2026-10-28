<script setup lang="ts">
// 全局壳：无 onLaunch 逻辑（登录态没有全局拦——各页 API 401 时由 api.ts 统一 reLaunch 到登录页），
// 只放公共样式（卡片/布局/表单/按钮，各页共用；v1 把 .field/.label 复制在两页里，v2 收进来）
</script>

<style>
page {
	background: #f5f6f8;
	font-size: 15px;
	color: #24292f;
}
.card {
	background: #fff;
	border-radius: 12px;
	padding: 16px;
	margin: 12px 16px;
	box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
}
.row {
	display: flex;
	align-items: center;
	gap: 8px;
}
.grow {
	flex: 1;
}
/* tabBar 是 fixed 悬浮层、不占文档流——页面底部要自己留白，否则最后一屏内容被压住（实录：邀请码被挡住） */
.page {
	padding-bottom: 80px;
	box-sizing: border-box;
}
/* 卡片里紧跟一组表单的全宽按钮，与上面留呼吸空间（.field 只有 margin-top，下方按钮会贴着输入框） */
.btn.mt {
	margin-top: 16px;
}
.muted {
	color: #8b949e;
	font-size: 13px;
}

/* ---------- 按钮 ----------
   uni-button 默认样式：font-size:18px + line-height:2.56 + margin:auto + display:block（元素选择器，特异性
   0,0,1）。块 4 的 .btn 只盖了 font-size/padding，没盖 line-height 与 margin——14px 字被 2.56 行高撑成
   ~52px 高的巨按钮、auto margin 又把它们推开（「补跑今日等按钮太大」实录）。这里把行高/边距/显示/尺寸
   全部显式压平，.btn 的 class 特异性(0,1,0) 天然赢过元素选择器。
   width 那条留作防守：某些 uni 版本用 uni-button:not([size=mini]){width:100%}（特异性 0,1,1 > .btn）
   强制满宽，只能 !important；:not(.block) 把满宽按钮排除在防守之外。 */
.btn {
	display: inline-block;
	width: auto;
	margin: 0;
	padding: 8px 14px;
	font-size: 14px;
	line-height: 1.4;
	text-align: center;
	border: 1px solid transparent;
	border-radius: 8px;
	background: #1f6feb;
	color: #fff;
	box-sizing: border-box;
}
uni-button.btn:not(.block) {
	width: auto !important;
}
/* uni-button 的 ::after 是默认 1px 描边（像是给方角按钮画的），圆角+自定义边框后要关掉 */
uni-button.btn::after {
	border: 0;
}
.btn.block {
	display: block;
	width: 100%;
}
.btn.sm {
	padding: 6px 12px;
	font-size: 13px;
}
.btn.ghost {
	background: #fff;
	color: #1f6feb;
	border-color: #d0d7de;
}
.btn.warn {
	background: #d1242f;
	color: #fff;
}
.btn[disabled] {
	opacity: 0.5;
}

/* ---------- 表单 ----------
   label/input/button 竖排成组，组内 gap 10 给足间距（「输入框和按钮贴在一起」实录） */
.field {
	display: flex;
	flex-direction: column;
	gap: 10px;
	margin-top: 12px;
}
.label {
	font-size: 12px;
	color: #57606a;
}
/* 关键：uni-app 编译期把选择器里的 input 映射到 uni-input 宿主元素（不是原生 input），
   而 uni-input 自带固定 height:1.4em（≈20px）——再加 padding + border-box，内容盒被算成 0px，
   输入框实际高度归零（「输入框和按钮贴在一起」的真实原因：输入框塌没了）。必须显式 height:auto。 */
.field input {
	height: auto;
	border: 1px solid #d0d7de;
	border-radius: 8px;
	padding: 9px 10px;
	font-size: 14px;
	line-height: 1.4;
	background: #fafbfc;
	box-sizing: border-box;
}
</style>
