#!/bin/bash

# DCV動的ルーティング設定デプロイスクリプト
# オンデマンドAgent対応

set -e

# 設定
GATEWAY_HOST="10.213.66.188"
GATEWAY_PORT="50000"
KEY_FILE="tom.pem"

# 色付きログ
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

# 動的ルーティング設定をデプロイ
deploy_dynamic_routing() {
    log_info "🚀 動的ルーティング設定をデプロイ中..."
    
    # 設定ファイルの存在確認
    if [ ! -f "dcv-dynamic-routing-simple.conf" ]; then
        log_error "dcv-dynamic-routing-simple.conf ファイルが見つかりません"
        exit 1
    fi
    
    # 既存設定をバックアップ
    log_info "既存設定をバックアップ中..."
    ssh -i "$KEY_FILE" ec2-user@$GATEWAY_HOST -p $GATEWAY_PORT \
        "sudo cp /etc/nginx/conf.d/dcv-proxy.conf /etc/nginx/conf.d/dcv-proxy.conf.backup.$(date +%Y%m%d_%H%M%S) 2>/dev/null || true"
    
    # 新しい設定をデプロイ
    log_info "新しい動的ルーティング設定をアップロード中..."
    scp -i "$KEY_FILE" -P $GATEWAY_PORT dcv-dynamic-routing-simple.conf ec2-user@$GATEWAY_HOST:/tmp/
    ssh -i "$KEY_FILE" ec2-user@$GATEWAY_HOST -p $GATEWAY_PORT \
        "sudo mv /tmp/dcv-dynamic-routing-simple.conf /etc/nginx/conf.d/dcv-proxy.conf"
    
    # nginx設定テスト
    log_info "nginx設定をテスト中..."
    if ssh -i "$KEY_FILE" ec2-user@$GATEWAY_HOST -p $GATEWAY_PORT "sudo nginx -t"; then
        log_success "nginx設定テスト成功"
    else
        log_error "nginx設定テストに失敗しました"
        exit 1
    fi
    
    # nginx再読み込み
    log_info "nginx設定を再読み込み中..."
    ssh -i "$KEY_FILE" ec2-user@$GATEWAY_HOST -p $GATEWAY_PORT "sudo nginx -s reload"
    
    log_success "動的ルーティング設定デプロイ完了"
}

# 接続テスト
test_dynamic_routing() {
    log_info "🧪 動的ルーティング接続テスト中..."
    
    echo ""
    log_info "1. ヘルスチェックテスト:"
    if curl -k -s "https://$GATEWAY_HOST:8443/health" | grep -q "ok"; then
        log_success "ヘルスチェック成功"
    else
        log_warning "ヘルスチェック失敗"
    fi
    
    echo ""
    log_info "2. API テスト:"
    if curl -k -s "https://$GATEWAY_HOST:8443/api/agents/available" | grep -q "Dynamic routing"; then
        log_success "API テスト成功"
    else
        log_warning "API テスト失敗"
    fi
    
    echo ""
    log_info "3. Agent1 (10.150.248.180) 接続テスト:"
    if curl -k -I -s "https://$GATEWAY_HOST:8443/10.150.248.180/" | grep -q "200\|302"; then
        log_success "Agent1接続成功"
    else
        log_warning "Agent1接続失敗（Agentが起動していない可能性）"
    fi
    
    echo ""
    log_info "4. Agent2 (10.150.248.136) 接続テスト:"
    if curl -k -I -s "https://$GATEWAY_HOST:8443/10.150.248.136/" | grep -q "200\|302"; then
        log_success "Agent2接続成功"
    else
        log_warning "Agent2接続失敗（Agentが起動していない可能性）"
    fi
    
    echo ""
    log_info "5. 不正IPテスト (セキュリティ確認):"
    if curl -k -s "https://$GATEWAY_HOST:8443/8.8.8.8/" | grep -q "Forbidden"; then
        log_success "セキュリティチェック成功（不正IPをブロック）"
    else
        log_warning "セキュリティチェック要確認"
    fi
}

# 現在の状況を確認
check_status() {
    log_info "=== 現在の状況確認 ==="
    
    echo ""
    log_info "Gateway nginx状況:"
    ssh -i "$KEY_FILE" ec2-user@$GATEWAY_HOST -p $GATEWAY_PORT \
        "sudo systemctl status nginx --no-pager -l | head -8"
    
    echo ""
    log_info "nginx設定確認:"
    ssh -i "$KEY_FILE" ec2-user@$GATEWAY_HOST -p $GATEWAY_PORT \
        "sudo nginx -T 2>/dev/null | grep -A5 -B5 'location.*[0-9].*[0-9].*[0-9].*[0-9]' | head -10"
    
    echo ""
    log_info "アクセスログ（最新5件）:"
    ssh -i "$KEY_FILE" ec2-user@$GATEWAY_HOST -p $GATEWAY_PORT \
        "sudo tail -5 /var/log/nginx/dcv-access.log 2>/dev/null || echo 'ログファイルが見つかりません'"
}

# Agent1のディスプレイ環境を修正
fix_agent1_display() {
    log_info "🔧 Agent1のディスプレイ環境を修正中..."
    
    # Xvfb仮想ディスプレイを起動
    ssh -i "$KEY_FILE" ubuntu@10.213.66.188 \
        "sudo pkill Xvfb 2>/dev/null || true && sudo Xvfb :99 -screen 0 1920x1080x24 &"
    
    # DCV設定でディスプレイを指定
    ssh -i "$KEY_FILE" ubuntu@10.213.66.188 \
        "echo 'export DISPLAY=:99' | sudo tee -a /etc/environment"
    
    # DCVセッションを再作成
    ssh -i "$KEY_FILE" ubuntu@10.213.66.188 \
        "sudo dcv close-session console 2>/dev/null || true && sleep 2 && DISPLAY=:99 sudo dcv create-session --type=console --owner=ubuntu --name='Ubuntu Desktop' console"
    
    log_success "Agent1ディスプレイ環境修正完了"
}

# 使用方法表示
show_usage() {
    echo "🌐 DCV動的ルーティングゲートウェイ"
    echo ""
    echo "✅ デプロイ完了！以下の方法でアクセスできます："
    echo ""
    echo "📋 基本的な使用方法:"
    echo "  https://$GATEWAY_HOST:8443/<AgentのIP>/"
    echo ""
    echo "💡 具体例:"
    echo "  Agent1: https://$GATEWAY_HOST:8443/10.150.248.180/"
    echo "  Agent2: https://$GATEWAY_HOST:8443/10.150.248.136/"
    echo "  カスタム: https://$GATEWAY_HOST:8443/192.168.1.100/"
    echo ""
    echo "🔧 管理用URL:"
    echo "  ヘルスチェック: https://$GATEWAY_HOST:8443/health"
    echo "  API情報: https://$GATEWAY_HOST:8443/api/agents/available"
    echo "  ゲートウェイ情報: https://$GATEWAY_HOST:8443/"
    echo ""
    echo "🔒 セキュリティ:"
    echo "  許可IPレンジ: 10.150.248.x, 192.168.x.x"
    echo "  その他のIPは自動的にブロックされます"
    echo ""
    echo "📊 ログ監視:"
    echo "  sudo tail -f /var/log/nginx/dcv-access.log"
    echo "  sudo tail -f /var/log/nginx/dcv-error.log"
}

# メイン処理
case "${1:-deploy}" in
    "deploy")
        log_info "🚀 DCV動的ルーティングをデプロイします"
        deploy_dynamic_routing
        fix_agent1_display
        test_dynamic_routing
        check_status
        echo ""
        show_usage
        ;;
    "test")
        log_info "🧪 接続テストを実行します"
        test_dynamic_routing
        ;;
    "status")
        check_status
        ;;
    "fix-display")
        fix_agent1_display
        ;;
    *)
        echo "使用方法: $0 [deploy|test|status|fix-display]"
        echo ""
        echo "コマンド:"
        echo "  deploy      - 動的ルーティング設定をデプロイ（デフォルト）"
        echo "  test        - 接続テストを実行"
        echo "  status      - 現在の状況を確認"
        echo "  fix-display - Agent1のディスプレイ環境を修正"
        exit 1
        ;;
esac