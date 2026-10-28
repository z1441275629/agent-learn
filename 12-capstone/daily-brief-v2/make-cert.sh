#!/usr/bin/env bash
# 局域网自签证书：让 v2 server 跑在 HTTPS 上（密码/cookie 不再明文裸奔）。
# 用法：bash 12-capstone/daily-brief-v2/make-cert.sh [IP1 IP2 ...]
#   不传 IP 就自动探测当前局域网 IPv4 写进 SAN。
#   产物：certs/server.crt + certs/server.key（gitignored——私钥绝不入库）
#   .env 加两行：V2_TLS_CERT=certs/server.crt / V2_TLS_KEY=certs/server.key
# 注意：自签证书手机首次访问会提示「不安全」——继续前往即可（家用可接受）；
#       公网部署不要用自签，走 Cloudflare Tunnel / Caddy 自动签发 + V2_HTTPS=1。
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v openssl >/dev/null; then
	echo "缺 openssl（Git Bash 自带；或 winget install FireDaemon.OpenSSL）" >&2
	exit 1
fi

mkdir -p certs
IPS=("$@")
if [ ${#IPS[@]} -eq 0 ]; then
	LAN=$(node -e "const os=require('os');const a=os.networkInterfaces()['WLAN']||os.networkInterfaces()['以太网']||[];const v=a.flatMap(x=>x.family==='IPv4'&&!x.internal?[x.address]:[])[0];console.log(v||'')" 2>/dev/null || true)
	[ -n "$LAN" ] && IPS=("$LAN")
fi

# SAN：localhost + 127.0.0.1 + 探测到的局域网 IP（Chrome 只认 SAN，不认 CN——没写进的 IP 会 NET::ERR_CERT_COMMON_NAME_INVALID）
SAN="DNS:localhost,IP:127.0.0.1"
for ip in "${IPS[@]:-}"; do
	[ -n "$ip" ] && SAN="$SAN,IP:$ip"
done
echo "SAN: $SAN"

# MSYS_NO_PATHCONV：Git Bash 会把 -subj "/CN=xxx" 当路径转成 C:/Program Files/Git/CN=xxx（MSYS 路径转换实录）
MSYS_NO_PATHCONV=1 openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
	-keyout certs/server.key -out certs/server.crt -days 825 -nodes \
	-subj "/CN=daily-brief-v2" -addext "subjectAltName=$SAN"

chmod 600 certs/server.key 2>/dev/null || true
echo "已生成 certs/server.crt + server.key（825 天）。.env 加："
echo "  V2_TLS_CERT=certs/server.crt"
echo "  V2_TLS_KEY=certs/server.key"
