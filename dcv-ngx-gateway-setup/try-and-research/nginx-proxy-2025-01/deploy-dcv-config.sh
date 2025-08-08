#!/bin/bash

# DCV設定デプロイスクリプト
# 使用方法: ./deploy-dcv-config.sh [path-routing|single-agent|status]

set -e

# 設定
GATEWAY_HOST="10.213.66.188"
GATEWAY_PORT="50000"
AGENT1_HOST="10.213.66.188"
AGENT1_PORT="22"
AGENT2_HOST="10.213.66.188"
AGENT2_PORT="60001"
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

# Gateway側にパス別ルーティング設定をデプロイ
deploy_path_routing() {
    log_info "パス別ルーティング設定をデプロイ中..."
    
    # 既存設定をバックアップ
    ssh -i "$KEY_FILE" ec2-user@$GATEWAY_HOST -p $GATEWAY_PORT \
        "sudo cp /etc/nginx/conf.d/dcv-proxy.conf /etc/nginx/conf.d/dcv-proxy.conf.backup.$(date +%Y%m%d_%H%M%S) 2>/dev/null || true"
    
    # 新しい設定をデプロイ
    scp -i "$KEY_FILE" -P $GATEWAY_PORT dcv-path-routing.conf ec2-user@$GATEWAY_HOST:/tmp/
    ssh -i "$KEY_FILE" ec2-user@$GATEWAY_HOST -p $GATEWAY_PORT \
        "sudo mv /tmp/dcv-path-routing.conf /etc/nginx/conf.d/dcv-proxy.conf"
    
    # nginx設定テスト
    log_info "nginx設定をテスト中..."
    ssh -i "$KEY_FILE" ec2-user@$GATEWAY_HOST -p $GATEWAY_PORT "sudo nginx -t"
    
    # nginx再読み込み
    ssh -i "$KEY_FILE" ec2-user@$GATEWAY_HOST -p $GATEWAY_PORT "sudo nginx -s reload"
    
    log_success "Gateway側パス別ルーティング設定完了"
}

# Agent1にDCV設定をデプロイ
deploy_agent1_config() {
    log_info "Agent1にDCV設定をデプロイ中..."
    
    # 既存設定をバックアップ
    ssh -i "$KEY_FILE" ubuntu@$AGENT1_HOST -p $AGENT1_PORT \
        "sudo cp /etc/dcv/dcv.conf /etc/dcv/dcv.conf.backup.$(date +%Y%m%d_%H%M%S) 2>/dev/null || true"
    
    # 新しい設定をデプロイ
    scp -i "$KEY_FILE" -P $AGENT1_PORT dcv-agent1.conf ubuntu@$AGENT1_HOST:/tmp/
    ssh -i "$KEY_FILE" ubuntu@$AGENT1_HOST -p $AGENT1_PORT \
        "sudo mv /tmp/dcv-agent1.conf /etc/dcv/dcv.conf"
    
    # DCV Server再起動
    log_info "Agent1 DCV Server再起動中..."
    ssh -i "$KEY_FILE" ubuntu@$AGENT1_HOST -p $AGENT1_PORT \
        "sudo systemctl restart dcvserver"
    
    # セッション確認
    sleep 3
    ssh -i "$KEY_FILE" ubuntu@$AGENT1_HOST -p $AGENT1_PORT \
        "sudo dcv list-sessions"
    
    log_success "Agent1設定完了"
}

# Agent2にDCV設定をデプロイ（Agent2が利用可能な場合）
deploy_agent2_config() {
    log_info "Agent2にDCV設定をデプロイ中..."
    
    # Agent2接続テスト
    if ! ssh -i "$KEY_FILE" -o ConnectTimeout=5 ubuntu@$AGENT2_HOST -p $AGENT2_PORT "echo 'Agent2接続確認'" 2>/dev/null; then
        log_warning "Agent2に接続できません。スキップします。"
        return 1
    fi
    
    # 既存設定をバックアップ
    ssh -i "$KEY_FILE" ubuntu@$AGENT2_HOST -p $AGENT2_PORT \
        "sudo cp /etc/dcv/dcv.conf /etc/dcv/dcv.conf.backup.$(date +%Y%m%d_%H%M%S) 2>/dev/null || true"
    
    # 新しい設定をデプロイ
    scp -i "$KEY_FILE" -P $AGENT2_PORT dcv-agent1.conf ubuntu@$AGENT2_HOST:/tmp/dcv-agent2.conf
    ssh -i "$KEY_FILE" ubuntu@$AGENT2_HOST -p $AGENT2_PORT \
        "sudo mv /tmp/dcv-agent2.conf /etc/dcv/dcv.conf"
    
    # DCV Server再起動
    log_info "Agent2 DCV Server再起動中..."
    ssh -i "$KEY_FILE" ubuntu@$AGENT2_HOST -p $AGENT2_PORT \
        "sudo systemctl restart dcvserver"
    
    # セッション確認
    sleep 3
    ssh -i "$KEY_FILE" ubuntu@$AGENT2_HOST -p $AGENT2_PORT \
        "sudo dcv list-sessions"
    
    log_success "Agent2設定完了"
}

# 単一Agent設定をデプロイ（従来方式）
deploy_single_agent() {
    log_info "単一Agent設定をデプロイ中..."
    
    # 従来のdcv-proxy.confを使用
    if [ ! -f "dcv-proxy.conf" ]; then
        log_error "dcv-proxy.conf ファイルが見つかりません"
        exit 1
    fi
    
    scp -i "$KEY_FILE" -P $GATEWAY_PORT dcv-proxy.conf ec2-user@$GATEWAY_HOST:/tmp/
    ssh -i "$KEY_FILE" ec2-user@$GATEWAY_HOST -p $GATEWAY_PORT \
        "sudo mv /tmp/dcv-proxy.conf /etc/nginx/conf.d/dcv-proxy.conf && sudo nginx -t && sudo nginx -s reload"
    
    log_success "単一Agent設定完了"
}

# 現在の状況を確認
check_status() {
    log_info "=== 現在の状況確認 ==="
    
    echo ""
    log_info "Gateway nginx状況:"
    ssh -i "$KEY_FILE" ec2-user@$GATEWAY_HOST -p $GATEWAY_PORT \
        "sudo systemctl status nginx --no-pager -l | head -10"
    
    echo ""
    log_info "Agent1 DCV状況:"
    ssh -i "$KEY_FILE" ubuntu@$AGENT1_HOST -p $AGENT1_PORT \
        "sudo systemctl status dcvserver --no-pager -l | head -5 && echo '--- セッション ---' && sudo dcv list-sessions"
    
    echo ""
    log_info "Agent2 DCV状況:"
    if ssh -i "$KEY_FILE" -o ConnectTimeout=5 ubuntu@$AGENT2_HOST -p $AGENT2_PORT "echo 'Agent2接続確認'" 2>/dev/null; then
        ssh -i "$KEY_FILE" ubuntu@$AGENT2_HOST -p $AGENT2_PORT \
            "sudo systemctl status dcvserver --no-pager -l | head -5 && echo '--- セッション ---' && sudo dcv list-sessions"
    else
        log_warning "Agent2に接続できません"
    fi
    
    echo ""
    log_info "接続テスト:"
    echo "Gateway経由接続: https://$GATEWAY_HOST:8443/"
    echo "Agent1直接: https://$GATEWAY_HOST:8443/10.150.248.180/"
    echo "Agent2直接: https://$GATEWAY_HOST:8443/10.150.248.136/"
}

# メイン処理
case "${1:-path-routing}" in
    "path-routing")
        log_info "🚀 パス別ルーティング方式をデプロイします"
        deploy_path_routing
        deploy_agent1_config
        deploy_agent2_config || log_warning "Agent2設定はスキップされました"
        check_status
        echo ""
        log_success "✅ パス別ルーティング設定完了！"
        echo ""
        echo "🌐 アクセス方法:"
        echo "  Agent選択ページ: https://$GATEWAY_HOST:8443/"
        echo "  Agent1直接:      https://$GATEWAY_HOST:8443/10.150.248.180/"
        echo "  Agent2直接:      https://$GATEWAY_HOST:8443/10.150.248.136/"
        ;;
    "single-agent")
        log_info "🚀 単一Agent方式をデプロイします"
        deploy_single_agent
        deploy_agent1_config
        check_status
        log_success "✅ 単一Agent設定完了！"
        ;;
    "status")
        check_status
        ;;
    *)
        echo "使用方法: $0 [path-routing|single-agent|status]"
        echo ""
        echo "コマンド:"
        echo "  path-routing  - パス別ルーティング方式をデプロイ（推奨）"
        echo "  single-agent  - 単一Agent方式をデプロイ"
        echo "  status        - 現在の状況を確認"
        exit 1
        ;;
esac