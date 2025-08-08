#!/bin/bash
# Session Resolver接続テストスクリプト（修正版）
# DCV Gateway視点でのネットワーク接続を考慮

set -e

echo "=== DCV カスタムSession Resolver 接続テスト（修正版） ==="
echo "実行日時: $(date)"
echo

# 色付きログ関数
log_info() {
    echo -e "\033[32m[INFO]\033[0m $1"
}

log_warn() {
    echo -e "\033[33m[WARN]\033[0m $1"
}

log_error() {
    echo -e "\033[31m[ERROR]\033[0m $1"
}

# テスト1: Session Resolver単体テスト
echo "=== Test 1: Session Resolver単体テスト ==="
log_info "カスタムSession ResolverのAPI応答をテスト"

echo "1-1. ヘルスチェック"
if curl -s http://localhost:9000/health > /dev/null; then
    log_info "✅ Session Resolver起動確認: OK"
    curl -s http://localhost:9000/health | jq .
else
    log_error "❌ Session Resolver未起動"
    echo "Session Resolverを起動してください: python3 custom_session_resolver.py"
    exit 1
fi

echo
echo "1-2. セッション一覧取得"
log_info "利用可能なセッション一覧を取得"
curl -s http://localhost:9000/sessions | jq .

echo
echo "1-3. セッション解決テスト (console)"
log_info "consoleセッションの解決をテスト"
RESOLVER_RESPONSE=$(curl -s -X POST "http://localhost:9000/resolveSession?sessionId=console&transport=HTTP&clientIpAddress=10.213.66.188")
echo "Response: $RESOLVER_RESPONSE"

if echo "$RESOLVER_RESPONSE" | jq -e '.SessionId == "console"' > /dev/null; then
    log_info "✅ Session解決テスト: OK"
    # 解決されたエンドポイントを確認
    RESOLVED_HOST=$(echo "$RESOLVER_RESPONSE" | jq -r '.DcvServerEndpoint')
    RESOLVED_PORT=$(echo "$RESOLVER_RESPONSE" | jq -r '.Port')
    log_info "解決されたエンドポイント: $RESOLVED_HOST:$RESOLVED_PORT"
else
    log_error "❌ Session解決テスト: FAILED"
    exit 1
fi

echo
echo "1-4. 存在しないセッションテスト"
log_info "存在しないセッションで404エラーを確認"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "http://localhost:9000/resolveSession?sessionId=nonexistent&transport=HTTP")
if [ "$HTTP_CODE" = "404" ]; then
    log_info "✅ 404エラーテスト: OK"
else
    log_warn "⚠️  404エラーテスト: 期待値404, 実際$HTTP_CODE"
fi

echo
echo "=== Test 2: Agent2直接接続確認（内部IP使用） ==="
log_info "Agent2への内部IP経由での接続状態を確認"

echo "2-1. Agent2 HTTP接続テスト（内部IP: 10.150.248.136）"
if curl -k -s -I https://10.150.248.136:8443/ | grep -q "HTTP/1.1 200 OK"; then
    log_info "✅ Agent2内部IP接続: OK"
else
    log_error "❌ Agent2内部IP接続: FAILED"
    echo "Agent2の状態を確認してください"
fi

echo
echo "2-2. Agent2セッション確認"
log_info "Agent2のDCVセッション状態を確認"
echo "注意: SSH経由でのセッション確認は別途実行してください"

echo
echo "=== Test 3: DCV Gateway経由接続テスト ==="
log_info "DCV Gateway経由でのセッション解決をテスト"

echo "3-1. DCV Gateway HTTP接続テスト"
if curl -k -s -I https://localhost:8443/ | head -1; then
    log_info "DCV Gateway応答確認完了"
else
    log_warn "DCV Gateway接続に問題がある可能性があります"
fi

echo
echo "3-2. DCV Gateway経由セッション接続テスト"
log_info "Gateway経由でconsoleセッションに接続テスト"
GATEWAY_RESPONSE=$(curl -k -s -I https://localhost:8443/?sessionId=console | head -1)
echo "Gateway Response: $GATEWAY_RESPONSE"

if echo "$GATEWAY_RESPONSE" | grep -q "200 OK"; then
    log_info "✅ Gateway経由接続: OK"
elif echo "$GATEWAY_RESPONSE" | grep -q "404"; then
    log_warn "⚠️  Gateway経由接続: 404 (Session Resolver設定要確認)"
else
    log_warn "⚠️  Gateway経由接続: 予期しない応答"
fi

echo
echo "=== Test 4: 統合接続テスト ==="
log_info "ブラウザアクセス用URL生成"

echo "直接接続URL (Agent2内部IP):"
echo "  https://10.150.248.136:8443/?sessionId=console"
echo

echo "Gateway経由URL (外部アクセス用):"
echo "  https://10.213.66.188:8443/?sessionId=console"
echo

echo "=== テスト完了 ==="
log_info "すべてのテストが完了しました"
log_info "ブラウザで上記URLにアクセスしてリモートデスクトップ接続を確認してください"

echo
echo "=== トラブルシューティング ==="
echo "問題が発生した場合:"
echo "1. Session Resolver起動: python3 custom_session_resolver.py"
echo "2. DCV Gateway設定確認: dcv-connection-gateway-working.conf"
echo "3. Agent2サービス確認: sudo systemctl status dcvserver"
echo "4. ログ確認: /var/log/dcv-connection-gateway/"
echo "5. ネットワーク確認: Agent2内部IP (10.150.248.136) への接続性"