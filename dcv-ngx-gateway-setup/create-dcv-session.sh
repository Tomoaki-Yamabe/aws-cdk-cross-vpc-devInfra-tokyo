#!/bin/bash

# DCV セッション作成スクリプト
# 使用方法: ./create-dcv-session.sh [agent_ip] [session_name]

AGENT_IP=${1:-"10.150.248.180"}
SESSION_NAME=${2:-"desktop-session"}
SSH_KEY="tom.pem"
SSH_USER="ec2-user"

echo "🖥️  DCV セッション作成中..."
echo "Agent IP: $AGENT_IP"
echo "Session Name: $SESSION_NAME"

# Agent に SSH 接続してセッションを作成
ssh -i "$SSH_KEY" "$SSH_USER@$AGENT_IP" "
    # 既存セッションの確認
    echo '現在のセッション一覧:'
    sudo dcv list-sessions
    
    # セッションが存在しない場合は作成
    if ! sudo dcv list-sessions | grep -q '$SESSION_NAME'; then
        echo 'セッションを作成中...'
        sudo dcv create-session --type=virtual --user=$SSH_USER $SESSION_NAME
        echo 'セッション作成完了'
    else
        echo 'セッションは既に存在します'
    fi
    
    # セッション状態の確認
    echo '最終セッション状態:'
    sudo dcv list-sessions
"

echo "✅ セッション作成処理完了"
echo ""
echo "🌐 ブラウザでアクセス:"
echo "  https://10.213.66.188:8443/$AGENT_IP/"