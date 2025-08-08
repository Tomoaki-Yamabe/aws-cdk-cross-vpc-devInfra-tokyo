#!/bin/bash

# DCV Dynamic Proxy Deployment Script
# オンデマンドAgent用のシンプルで動的なnginx設定をデプロイ

set -e

echo "=== DCV Dynamic Proxy Deployment ==="
echo "オンデマンドAgent対応の動的ルーティング設定をデプロイします"

# 設定ファイルの存在確認
if [ ! -f "dcv-dynamic-proxy.conf" ]; then
    echo "❌ エラー: dcv-dynamic-proxy.conf が見つかりません"
    exit 1
fi

echo "📁 設定ファイルをサーバーにアップロード中..."
scp -i "tom.pem" -P 50000 dcv-dynamic-proxy.conf ec2-user@10.213.66.188:/tmp/

echo "🔧 nginx設定を更新中..."
ssh -i "tom.pem" ec2-user@10.213.66.188 -p 50000 << 'EOF'
# 既存の設定をバックアップ
sudo cp /etc/nginx/conf.d/dcv-proxy.conf /etc/nginx/conf.d/dcv-proxy.conf.backup.$(date +%Y%m%d_%H%M%S) 2>/dev/null || true

# 新しい設定をデプロイ
sudo cp /tmp/dcv-dynamic-proxy.conf /etc/nginx/conf.d/dcv-proxy.conf

# 設定ファイルの構文チェック
echo "🔍 nginx設定の構文チェック中..."
if sudo nginx -t; then
    echo "✅ nginx設定の構文チェック成功"
    
    # nginx再起動
    echo "🔄 nginx再起動中..."
    sudo nginx -s reload
    echo "✅ nginx再起動完了"
    
    # 設定確認
    echo ""
    echo "=== 現在の設定 ==="
    echo "動的ルーティングパターン:"
    echo "  • https://10.213.66.188:8443/<IP>/ → https://<IP>:8443/"
    echo "  • https://10.213.66.188:8443/<IP> → https://<IP>:8443/"
    echo "  • https://10.213.66.188:8443/ → https://10.150.248.180:8443/ (デフォルト)"
    echo ""
    echo "使用例:"
    echo "  • Agent1: https://10.213.66.188:8443/10.150.248.180/"
    echo "  • Agent2: https://10.213.66.188:8443/10.150.248.136/"
    echo "  • 任意のAgent: https://10.213.66.188:8443/192.168.1.100/"
    
else
    echo "❌ nginx設定にエラーがあります"
    exit 1
fi
EOF

echo ""
echo "🎉 DCV Dynamic Proxy デプロイ完了！"
echo ""
echo "=== 接続テスト ==="
echo "以下のコマンドでテストできます:"
echo ""
echo "# ヘルスチェック"
echo "curl -k https://10.213.66.188:8443/health"
echo ""
echo "# Agent1接続テスト"
echo "curl -k https://10.213.66.188:8443/10.150.248.180/"
echo ""
echo "# Agent2接続テスト"
echo "curl -k https://10.213.66.188:8443/10.150.248.136/"
echo ""
echo "=== ログ監視 ==="
echo "ログ監視は以下のコマンドで実行できます:"
echo "ssh -i \"tom.pem\" ec2-user@10.213.66.188 -p 50000 \"sudo tail -f /var/log/nginx/dcv-access.log /var/log/nginx/dcv-error.log\""