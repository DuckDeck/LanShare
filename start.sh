#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

detect_lan_ip() {
    if command -v ipconfig >/dev/null 2>&1 && [[ "$(uname -s)" == "Darwin" ]]; then
        for iface in en0 en1 en2; do
            local ip
            ip=$(ipconfig getifaddr "$iface" 2>/dev/null || true)
            if [[ -n "$ip" ]]; then
                echo "$ip"
                return 0
            fi
        done
    fi

    if command -v hostname >/dev/null 2>&1; then
        hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)' | head -n 1 || true
    fi
}

LAN_IP="$(detect_lan_ip || true)"
COMPUTER_NAME="$(hostname -s 2>/dev/null || hostname 2>/dev/null || true)"
: > .env
if [[ -n "${LAN_IP}" ]]; then
    echo "HOST_LAN_URL=http://${LAN_IP}:9010" >> .env
    echo "Detected LAN URL: http://${LAN_IP}:9010"
fi
if [[ -n "${COMPUTER_NAME}" ]]; then
    echo "HOST_COMPUTER_NAME=${COMPUTER_NAME}" >> .env
    echo "Detected Host Computer Name: ${COMPUTER_NAME}"
fi

if [[ "${1:-}" == "--rebuild" ]] || [[ -z "$(docker images -q lan-share-lan-share:latest 2>/dev/null || true)" ]]; then
    docker compose up -d --build
else
    echo "Using cached image lan-share-lan-share:latest (mount ./server & ./public). Pass --rebuild to force image rebuild."
    docker compose up -d --force-recreate
fi

echo ""
echo "=== LAN-Share 已启动 ==="
echo "本机访问: http://localhost:9010"
if [[ -n "${LAN_IP}" ]]; then
    echo "局域网/手机扫码访问: http://${LAN_IP}:9010"
fi
