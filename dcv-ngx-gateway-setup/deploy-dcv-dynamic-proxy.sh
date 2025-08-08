#!/bin/bash

# Universal Dynamic Proxy Deployment Script
# 汎用動的ルーティング設定をサーバーにデプロイ（ポート8000対応）

set -e

echo "=== Universal Dynamic Proxy Deployment ==="
echo "汎用動的ルーティング設定をデプロイします（ポート8000対応）"

# 設定ファイルの存在確認
if [ ! -f "dcv-dynamic-proxy.conf" ]; then
    echo "❌ エラー: dcv-dynamic-proxy.conf が見つかりません"
    exit 1
fi

echo "📁 設定ファイルをサーバーにアップロード中..."
scp -i "../tom.pem" -P 50000 dcv-dynamic-proxy.conf ec2-user@10.213.66.188:/tmp/

echo "🔧 nginx設定を更新中..."
ssh -i "../tom.pem" ec2-user@10.213.66.188 -p 50000 << 'EOF'
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
    echo "汎用動的ルーティングパターン（ポート8000）:"
    echo "  • https://10.213.66.188:8000/<IP>:<PORT>/ → https://<IP>:<PORT>/"
    echo "  • https://10.213.66.188:8000/<IP>:<PORT> → https://<IP>:<PORT>/"
    echo "  • https://10.213.66.188:8000/<IP>/ → https://<IP>:8443/ (デフォルトポート)"
    echo "  • https://10.213.66.188:8000/<IP> → https://<IP>:8443/ (デフォルトポート)"
    echo "  • https://10.213.66.188:8000/ → https://10.150.248.180:8443/ (デフォルト)"
    echo ""
    echo "使用例:"
    echo "  • DCV Agent1: https://10.213.66.188:8000/10.150.248.180:8443/"
    echo "  • DCV Agent2: https://10.213.66.188:8000/10.150.248.136:8443/"
    echo "  • SSH Port 22: https://10.213.66.188:8000/10.150.248.180:22/"
    echo "  • 任意のサービス: https://10.213.66.188:8000/192.168.1.100:3000/"
    
else
    echo "❌ nginx設定にエラーがあります"
    exit 1
fi
EOF

echo ""
echo "🎉 Universal Dynamic Proxy デプロイ完了！"
echo ""
echo "=== 接続テスト ==="
echo "以下のコマンドでテストできます:"
echo ""
echo "# ヘルスチェック"
echo "curl -k https://10.213.66.188:8000/health"
echo ""
echo "# DCV Agent1接続テスト（新しいポート8000）"
echo "curl -k https://10.213.66.188:8000/10.150.248.180:8443/"
echo ""
echo "# DCV Agent2接続テスト（新しいポート8000）"
echo "curl -k https://10.213.66.188:8000/10.150.248.136:8443/"
echo ""
echo "# SSH接続テスト（HTTPプロキシ経由 - 参考用）"
echo "curl -k https://10.213.66.188:8000/10.150.248.180:22/"
echo ""
echo "=== ログ監視 ==="
echo "ログ監視は以下のコマンドで実行できます:"
echo "ssh -i \"tom.pem\" ec2-user@10.213.66.188 -p 50000 \"sudo tail -f /var/log/nginx/universal-proxy-access.log /var/log/nginx/universal-proxy-error.log\""
echo ""
echo "=== 重要な注意事項 ==="
echo "⚠️  SSH接続について:"
echo "   現在の設定はHTTP/HTTPS/WebSocket専用のリバースプロキシです。"
echo "   SSH接続には別途TCP stream proxyが必要です。"
echo "   SSH接続コマンド例: ssh -i key.pem user@10.213.66.188 -p 50000"
echo "   （直接SSH接続する場合は既存のSSHポート50000を使用してください）"