#!/usr/bin/env bash
# 生成自签 CA 与服务端证书，供网关对外提供 HTTPS。
#
# 为什么是两级而不是一张自签证书：客户端要把签发者导入信任库，而宿主 curl 用的是
# NSS，它拒绝把 basicConstraints=CA:TRUE 的证书当服务器证书使用
# （SEC_ERROR_INADEQUATE_CERT_TYPE: "Certificate type not approved for application"）。
# 一级自签还会让 OpenSSL 报 "Issuer certificate is invalid"。两级链两边都满足。
#
# 产物：
#   state/tls/ca.crt      导入客户端信任库的就是这个（或 curl --cacert）
#   state/tls/server.crt  叶子证书 + CA（网关加载的证书链）
#   state/tls/server.key  叶子私钥
#
# SAN 覆盖：本机局域网 IP、localhost/127.0.0.1、注册表里每个租户的 hosts 条目、命令行追加项。
#
# 用法：
#   bin/make-cert.sh                              # 自动收集 SAN
#   bin/make-cert.sh "dsh.example.com,10.0.0.9"   # 追加主机名/IP（逗号分隔）
#
# 换用你们自己的 CA：用你们的 CA 签发一张服务器证书，把链写进 server.crt、
# 私钥写进 server.key，再把你们的 CA 证书放到 ca.crt，网关只读 server.crt 与 server.key。
set -euo pipefail
cd "$(dirname "$0")/.."
# 宿主机没有 curl 时用容器里的顶（局域网装不了包的情况）。
# shellcheck disable=SC1091
. bin/lib-http.sh

OUT="${MT_TLS_DIR:-state/tls}"
EXTRA="${1:-}"
DAYS_LEAF=825    # 主流浏览器接受的最长有效期
DAYS_CA=3650

mkdir -p "$OUT"
chmod 700 "$OUT"

LAN_IP="$(ip -4 -o addr show scope global 2>/dev/null \
  | awk '$2 !~ /^(docker|br-|veth|virbr|lo)/ { split($4, a, "/"); print a[1] }' | head -1)"

SAN="DNS:localhost,IP:127.0.0.1"
[ -n "$LAN_IP" ] && SAN="${SAN},IP:${LAN_IP}"
if [ -f tenants.json ]; then
  for host in $(grep -o '"[a-z0-9][a-z0-9.-]*\.local"' tenants.json 2>/dev/null | tr -d '"' | sort -u || true); do
    SAN="${SAN},DNS:${host}"
  done
fi
[ -n "$EXTRA" ] && SAN="${SAN},$(printf '%s' "$EXTRA" | sed 's/[[:space:]]//g')"

# ── 1. CA ──────────────────────────────────────────────────────────────────
cat > "$OUT/ca.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = dsh-multitenant local CA
[v3]
basicConstraints = critical, CA:TRUE
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
EOF

if [ ! -f "$OUT/ca.key" ] || [ ! -f "$OUT/ca.crt" ]; then
  openssl req -x509 -newkey rsa:2048 -sha256 -days "$DAYS_CA" -nodes \
    -keyout "$OUT/ca.key" -out "$OUT/ca.crt" -config "$OUT/ca.cnf" 2>/dev/null
  chmod 600 "$OUT/ca.key"
fi

# ── 2. 服务端证书 ──────────────────────────────────────────────────────────
cat > "$OUT/server.cnf" <<EOF
[req]
distinguished_name = dn
prompt = no
[dn]
CN = dsh-multitenant
[v3]
subjectAltName = ${SAN}
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
EOF

openssl req -newkey rsa:2048 -sha256 -nodes \
  -keyout "$OUT/server.key" -out "$OUT/server.csr" -config "$OUT/server.cnf" 2>/dev/null
openssl x509 -req -in "$OUT/server.csr" -sha256 -days "$DAYS_LEAF" \
  -CA "$OUT/ca.crt" -CAkey "$OUT/ca.key" -CAcreateserial \
  -extfile "$OUT/server.cnf" -extensions v3 -out "$OUT/server.leaf.crt" 2>/dev/null

# 网关加载的证书链：叶子在前，签发者在后。
cat "$OUT/server.leaf.crt" "$OUT/ca.crt" > "$OUT/server.crt"

chmod 600 "$OUT/server.key" "$OUT/ca.key"
chmod 644 "$OUT/server.crt" "$OUT/ca.crt"
rm -f "$OUT/server.csr" "$OUT/ca.srl"

echo "==> 证书已生成（两级链）"
echo "  CA（导入客户端信任库）: $PWD/$OUT/ca.crt"
echo "  服务端证书链          : $PWD/$OUT/server.crt"
echo "  服务端私钥            : $PWD/$OUT/server.key"
echo "  SAN: $SAN"
echo
openssl x509 -in "$OUT/server.leaf.crt" -noout -subject -issuer -dates 2>/dev/null | sed 's/^/  /'
openssl x509 -in "$OUT/server.leaf.crt" -noout -text 2>/dev/null | grep -A1 'Subject Alternative Name' | tail -1 | sed 's/^/  SAN: /'
echo
echo "客户端消除证书警告：导入 $OUT/ca.crt 到信任库；"
echo "用 curl 验证：curl --cacert $OUT/ca.crt https://<主机>:8090/"
