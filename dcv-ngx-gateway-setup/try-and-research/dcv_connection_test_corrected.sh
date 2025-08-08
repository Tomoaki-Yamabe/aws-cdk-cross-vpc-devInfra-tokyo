#!/bin/bash
# LinkedVPCからAgent1とAgent2への正確なDCV接続テスト
# 正しいポートマッピング情報に基づく接続確認

set -e

# 色付きログ出力
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# 正しい接続情報
GATEWAY_HOST="10.213.66.188"
GATEWAY_PORT="8443"
AGENT1_HOST="10.213.66.188"
AGENT1_PORT="50001"
AGENT2_HOST="10.213.66.188"
AGENT2_PORT="60000"

# 認証トークン
TOKENS=("test123" "console123" "demo456")
SESSION_IDS=("console" "desktop" "demo")

# ネットワーク接続確認
test_network_connectivity() {
    log_info "正しいポートマッピングでネットワーク接続性をテストしています..."
    
    echo "=== Gateway (${GATEWAY_HOST}:${GATEWAY_PORT}) ==="
    if nc -z ${GATEWAY_HOST} ${GATEWAY_PORT} 2>/dev/null; then
        log_success "Gateway:${GATEWAY_PORT} ポート開放確認"
    else
        log_warning "Gateway:${GATEWAY_PORT} ポート接続失敗"
    fi
    
    echo -e "\n=== Agent1 (${AGENT1_HOST}:${AGENT1_PORT}) ==="
    if nc -z ${AGENT1_HOST} ${AGENT1_PORT} 2>/dev/null; then
        log_success "Agent1:${AGENT1_PORT} ポート開放確認"
    else
        log_warning "Agent1:${AGENT1_PORT} ポート接続失敗"
    fi
    
    echo -e "\n=== Agent2 (${AGENT2_HOST}:${AGENT2_PORT}) ==="
    if nc -z ${AGENT2_HOST} ${AGENT2_PORT} 2>/dev/null; then
        log_success "Agent2:${AGENT2_PORT} ポート開放確認"
    else
        log_warning "Agent2:${AGENT2_PORT} ポート接続失敗"
    fi
}

# SSL証明書確認
test_ssl_certificates() {
    log_info "SSL証明書を確認しています..."
    
    echo "=== Gateway SSL証明書 ==="
    if timeout 10 openssl s_client -connect ${GATEWAY_HOST}:${GATEWAY_PORT} -servername ${GATEWAY_HOST} </dev/null 2>/dev/null | openssl x509 -noout -text | head -20; then
        log_success "Gateway SSL証明書確認完了"
    else
        log_warning "Gateway SSL証明書確認失敗"
    fi
    
    echo -e "\n=== Agent1 SSL証明書 ==="
    if timeout 10 openssl s_client -connect ${AGENT1_HOST}:${AGENT1_PORT} -servername ${AGENT1_HOST} </dev/null 2>/dev/null | openssl x509 -noout -text | head -20; then
        log_success "Agent1 SSL証明書確認完了"
    else
        log_warning "Agent1 SSL証明書確認失敗"
    fi
    
    echo -e "\n=== Agent2 SSL証明書 ==="
    if timeout 10 openssl s_client -connect ${AGENT2_HOST}:${AGENT2_PORT} -servername ${AGENT2_HOST} </dev/null 2>/dev/null | openssl x509 -noout -text | head -20; then
        log_success "Agent2 SSL証明書確認完了"
    else
        log_warning "Agent2 SSL証明書確認失敗"
    fi
}

# HTTP接続テスト
test_http_connections() {
    log_info "正しいポートマッピングでHTTP接続をテストしています..."
    
    # Gateway接続テスト
    echo -e "\n=== Gateway接続テスト ==="
    for token in "${TOKENS[@]}"; do
        echo -e "\n--- Gateway: Token=${token}, Session=console ---"
        gateway_url="https://${GATEWAY_HOST}:${GATEWAY_PORT}/?authToken=${token}&sessionId=console"
        
        response=$(curl -k -s -w "HTTP_CODE:%{http_code}\nTIME_TOTAL:%{time_total}\n" \
                  -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" \
                  --connect-timeout 10 \
                  --max-time 30 \
                  --noproxy "*" \
                  "${gateway_url}" 2>/dev/null || echo "CURL_ERROR")
        
        if echo "$response" | grep -q "HTTP_CODE:200"; then
            log_success "Gateway接続成功: ${token}"
            echo "URL: ${gateway_url}"
        elif echo "$response" | grep -q "HTTP_CODE:"; then
            http_code=$(echo "$response" | grep "HTTP_CODE:" | cut -d: -f2)
            log_warning "Gateway接続失敗: HTTP ${http_code} - ${token}"
            echo "URL: ${gateway_url}"
        else
            log_error "Gateway接続エラー: ${token}"
        fi
    done
    
    # Agent1接続テスト
    echo -e "\n=== Agent1接続テスト ==="
    for token in "${TOKENS[@]}"; do
        echo -e "\n--- Agent1: Token=${token}, Session=console ---"
        agent1_url="https://${AGENT1_HOST}:${AGENT1_PORT}/?authToken=${token}&sessionId=console"
        
        response=$(curl -k -s -w "HTTP_CODE:%{http_code}\nTIME_TOTAL:%{time_total}\n" \
                  -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" \
                  --connect-timeout 10 \
                  --max-time 30 \
                  --noproxy "*" \
                  "${agent1_url}" 2>/dev/null || echo "CURL_ERROR")
        
        if echo "$response" | grep -q "HTTP_CODE:200"; then
            log_success "Agent1接続成功: ${token}"
            echo "URL: ${agent1_url}"
        elif echo "$response" | grep -q "HTTP_CODE:"; then
            http_code=$(echo "$response" | grep "HTTP_CODE:" | cut -d: -f2)
            log_warning "Agent1接続失敗: HTTP ${http_code} - ${token}"
            echo "URL: ${agent1_url}"
        else
            log_error "Agent1接続エラー: ${token}"
        fi
    done
    
    # Agent2接続テスト
    echo -e "\n=== Agent2接続テスト ==="
    for token in "${TOKENS[@]}"; do
        echo -e "\n--- Agent2: Token=${token}, Session=console ---"
        agent2_url="https://${AGENT2_HOST}:${AGENT2_PORT}/?authToken=${token}&sessionId=console"
        
        response=$(curl -k -s -w "HTTP_CODE:%{http_code}\nTIME_TOTAL:%{time_total}\n" \
                  -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" \
                  --connect-timeout 10 \
                  --max-time 30 \
                  --noproxy "*" \
                  "${agent2_url}" 2>/dev/null || echo "CURL_ERROR")
        
        if echo "$response" | grep -q "HTTP_CODE:200"; then
            log_success "Agent2接続成功: ${token}"
            echo "URL: ${agent2_url}"
        elif echo "$response" | grep -q "HTTP_CODE:"; then
            http_code=$(echo "$response" | grep "HTTP_CODE:" | cut -d: -f2)
            log_warning "Agent2接続失敗: HTTP ${http_code} - ${token}"
            echo "URL: ${agent2_url}"
        else
            log_error "Agent2接続エラー: ${token}"
        fi
    done
}

# ブラウザ接続用URL生成
generate_browser_urls() {
    log_info "正しいポートマッピングでブラウザ接続用URLを生成しています..."
    
    echo -e "\n${GREEN}=== ブラウザ接続用URL一覧（正しいポートマッピング） ===${NC}"
    
    echo -e "\n${BLUE}Gateway (${GATEWAY_HOST}:${GATEWAY_PORT}) 接続URL:${NC}"
    for token in "${TOKENS[@]}"; do
        for session_id in "${SESSION_IDS[@]}"; do
            echo "https://${GATEWAY_HOST}:${GATEWAY_PORT}/?authToken=${token}&sessionId=${session_id}"
        done
    done
    
    echo -e "\n${BLUE}Agent1 (${AGENT1_HOST}:${AGENT1_PORT}) 接続URL:${NC}"
    for token in "${TOKENS[@]}"; do
        for session_id in "${SESSION_IDS[@]}"; do
            echo "https://${AGENT1_HOST}:${AGENT1_PORT}/?authToken=${token}&sessionId=${session_id}"
        done
    done
    
    echo -e "\n${BLUE}Agent2 (${AGENT2_HOST}:${AGENT2_PORT}) 接続URL:${NC}"
    for token in "${TOKENS[@]}"; do
        for session_id in "${SESSION_IDS[@]}"; do
            echo "https://${AGENT2_HOST}:${AGENT2_PORT}/?authToken=${token}&sessionId=${session_id}"
        done
    done
    
    echo -e "\n${YELLOW}推奨テスト順序（正しいポートマッピング）:${NC}"
    echo "1. Gateway: https://${GATEWAY_HOST}:${GATEWAY_PORT}/?authToken=test123&sessionId=console"
    echo "2. Agent1: https://${AGENT1_HOST}:${AGENT1_PORT}/?authToken=test123&sessionId=console"
    echo "3. Agent2: https://${AGENT2_HOST}:${AGENT2_PORT}/?authToken=test123&sessionId=console"
}

# 環境情報表示
show_environment_info() {
    log_info "環境情報を表示しています..."
    
    echo -e "\n=== 正しいネットワーク構成 ==="
    echo "LinkedVPC IP: $(hostname -I | awk '{print $1}')"
    echo "ホスト名: $(hostname)"
    
    echo -e "\n=== 正しい接続情報 ==="
    echo "Gateway: ${GATEWAY_HOST}:${GATEWAY_PORT} (ec2-user@${GATEWAY_HOST} -p 50000)"
    echo "Agent1: ${AGENT1_HOST}:${AGENT1_PORT} → Port 8443にルーティング (ubuntu@${GATEWAY_HOST})"
    echo "Agent2: ${AGENT2_HOST}:${AGENT2_PORT} → Port 8443にルーティング (ubuntu@${GATEWAY_HOST} -p 60001)"
    
    echo -e "\n=== ルーティング情報 ==="
    echo "Gateway (${GATEWAY_HOST}) へのルート:"
    ip route get ${GATEWAY_HOST} 2>/dev/null || echo "ルート情報取得失敗"
}

# メイン処理
main() {
    echo -e "${GREEN}=== LinkedVPC → Gateway/Agent1/Agent2 DCV接続テスト（正しいポートマッピング） ===${NC}"
    echo "テスト開始時刻: $(date)"
    echo ""
    
    case "${1:-all}" in
        "network")
            test_network_connectivity
            ;;
        "ssl")
            test_ssl_certificates
            ;;
        "http")
            test_http_connections
            ;;
        "urls")
            generate_browser_urls
            ;;
        "env")
            show_environment_info
            ;;
        "all")
            show_environment_info
            test_network_connectivity
            test_ssl_certificates
            test_http_connections
            generate_browser_urls
            ;;
        *)
            echo "使用方法: $0 [network|ssl|http|urls|env|all]"
            echo ""
            echo "  network   - ネットワーク接続テスト"
            echo "  ssl       - SSL証明書確認"
            echo "  http      - HTTP接続テスト"
            echo "  urls      - ブラウザ用URL生成"
            echo "  env       - 環境情報表示"
            echo "  all       - 全テスト実行（デフォルト）"
            exit 1
            ;;
    esac
    
    echo ""
    echo -e "${GREEN}テスト完了時刻: $(date)${NC}"
}

# スクリプト実行
main "$@"