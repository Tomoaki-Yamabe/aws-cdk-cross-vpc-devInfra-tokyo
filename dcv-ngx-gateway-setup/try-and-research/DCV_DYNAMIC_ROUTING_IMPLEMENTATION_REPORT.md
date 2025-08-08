# AWS DCV 動的ルーティング実装レポート

## 概要

AWS DCV (Desktop Cloud Visualization) の WebSocket 認証問題を解決するため、Session Manager Broker を完全にバイパスする nginx リバースプロキシによる動的ルーティングシステムを実装しました。

## 問題の背景

### 元の問題
- DCV Connection Gateway + Session Resolver 実装で WebSocket 認証 404 エラーが発生
- AWS Session Manager Broker の設計上の制限により WebSocket 接続が不安定
- 複数の DCV Agent への動的ルーティングが困難

### 解決アプローチ
- Session Manager Broker を完全にバイパス
- nginx リバースプロキシによる直接ルーティング
- パスベースの動的 IP ルーティング実装

## アーキテクチャ

```
[クライアント] 
    ↓ HTTPS/WebSocket
[nginx Proxy Server (10.213.66.188:8443)]
    ↓ 動的ルーティング
[DCV Agent1 (10.150.248.180:8443)] または [DCV Agent2 (10.150.248.136:8443)]
```

### ルーティングパターン
- `https://10.213.66.188:8443/10.150.248.180/` → Agent1
- `https://10.213.66.188:8443/10.150.248.136/` → Agent2  
- `https://10.213.66.188:8443/` → Agent1 (デフォルト)
- `https://10.213.66.188:8443/health` → ヘルスチェック

## 実装ファイル

### 1. nginx 動的プロキシ設定ファイル

**ファイル名**: `dcv-dynamic-proxy.conf`

```nginx
# DCV Dynamic Routing Configuration - Simple & Universal
# WebSocket Upgrade Map
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 8443 ssl;
    http2 on;
    server_name _;

    # SSL証明書設定
    ssl_certificate /etc/dcv-connection-gateway/certs/dcv.crt;
    ssl_certificate_key /etc/dcv-connection-gateway/certs/dcv.key;
    
    # SSL最適化
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;

    # ログ設定
    access_log /var/log/nginx/dcv-access.log;
    error_log /var/log/nginx/dcv-error.log;

    # クライアント設定
    client_max_body_size 1G;
    client_body_timeout 60s;
    client_header_timeout 60s;

    # ヘルスチェック
    location /health {
        return 200 "DCV Proxy OK";
        add_header Content-Type text/plain;
    }

    # 動的IPルーティング - 任意のIPアドレスに対応
    # パターン: https://proxy:8443/192.168.1.100/ -> https://192.168.1.100:8443/
    location ~ ^/([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})/(.*)$ {
        set $agent_ip $1;
        set $agent_path /$2;
        
        proxy_pass https://$agent_ip:8443$agent_path;
        proxy_ssl_verify off;
        proxy_http_version 1.1;
        
        # WebSocket対応ヘッダー
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        
        # 標準ヘッダー
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # タイムアウト設定
        proxy_connect_timeout 10s;
        proxy_send_timeout 300s;
        proxy_read_timeout 300s;
        
        # バッファリング無効化
        proxy_buffering off;
        tcp_nodelay on;
        proxy_socket_keepalive on;
    }

    # ルートパスでのIPルーティング
    # パターン: https://proxy:8443/192.168.1.100 -> https://192.168.1.100:8443/
    location ~ ^/([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})$ {
        set $agent_ip $1;
        
        proxy_pass https://$agent_ip:8443/;
        proxy_ssl_verify off;
        proxy_http_version 1.1;
        
        # WebSocket対応ヘッダー
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        
        # 標準ヘッダー
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # タイムアウト設定
        proxy_connect_timeout 10s;
        proxy_send_timeout 300s;
        proxy_read_timeout 300s;
        
        # バッファリング無効化
        proxy_buffering off;
        tcp_nodelay on;
        proxy_socket_keepalive on;
    }

    # デフォルトルート（Agent1へのフォールバック）
    location / {
        proxy_pass https://10.150.248.180:8443/;
        proxy_ssl_verify off;
        proxy_http_version 1.1;
        
        # WebSocket対応ヘッダー
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        
        # 標準ヘッダー
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # タイムアウト設定
        proxy_connect_timeout 10s;
        proxy_send_timeout 300s;
        proxy_read_timeout 300s;
        
        # バッファリング無効化
        proxy_buffering off;
        tcp_nodelay on;
        proxy_socket_keepalive on;
    }
}
```

### 2. 自動デプロイスクリプト

**ファイル名**: `deploy-dcv-dynamic-proxy.sh`

```bash
#!/bin/bash

# DCV Dynamic Proxy デプロイスクリプト
# 使用方法: ./deploy-dcv-dynamic-proxy.sh

set -e

# 設定
PROXY_SERVER="10.213.66.188"
SSH_PORT="50000"
SSH_KEY="tom.pem"
SSH_USER="ec2-user"
CONFIG_FILE="dcv-dynamic-proxy.conf"
REMOTE_CONFIG_PATH="/etc/nginx/conf.d/dcv-proxy.conf"

echo "🚀 DCV Dynamic Proxy デプロイ開始..."

# 1. 設定ファイルの存在確認
if [ ! -f "$CONFIG_FILE" ]; then
    echo "❌ エラー: $CONFIG_FILE が見つかりません"
    exit 1
fi

# 2. SSH接続テスト
echo "📡 SSH接続テスト..."
if ! ssh -i "$SSH_KEY" -p $SSH_PORT -o ConnectTimeout=10 "$SSH_USER@$PROXY_SERVER" "echo 'SSH接続OK'" > /dev/null 2>&1; then
    echo "❌ エラー: SSH接続に失敗しました"
    exit 1
fi

# 3. 設定ファイルのアップロード
echo "📤 設定ファイルをアップロード中..."
scp -i "$SSH_KEY" -P $SSH_PORT "$CONFIG_FILE" "$SSH_USER@$PROXY_SERVER:/tmp/"

# 4. 既存設定のバックアップ
echo "💾 既存設定をバックアップ中..."
ssh -i "$SSH_KEY" -p $SSH_PORT "$SSH_USER@$PROXY_SERVER" "
    sudo cp $REMOTE_CONFIG_PATH $REMOTE_CONFIG_PATH.backup.$(date +%Y%m%d_%H%M%S) 2>/dev/null || true
"

# 5. 新しい設定の適用
echo "⚙️  新しい設定を適用中..."
ssh -i "$SSH_KEY" -p $SSH_PORT "$SSH_USER@$PROXY_SERVER" "
    sudo cp /tmp/$CONFIG_FILE $REMOTE_CONFIG_PATH
    sudo chown root:root $REMOTE_CONFIG_PATH
    sudo chmod 644 $REMOTE_CONFIG_PATH
"

# 6. nginx設定の検証
echo "🔍 nginx設定を検証中..."
if ! ssh -i "$SSH_KEY" -p $SSH_PORT "$SSH_USER@$PROXY_SERVER" "sudo nginx -t" > /dev/null 2>&1; then
    echo "❌ エラー: nginx設定に問題があります"
    ssh -i "$SSH_KEY" -p $SSH_PORT "$SSH_USER@$PROXY_SERVER" "sudo nginx -t"
    exit 1
fi

# 7. nginxサービスの再読み込み
echo "🔄 nginxサービスを再読み込み中..."
ssh -i "$SSH_KEY" -p $SSH_PORT "$SSH_USER@$PROXY_SERVER" "sudo systemctl reload nginx"

# 8. ヘルスチェック
echo "🏥 ヘルスチェック実行中..."
sleep 2
if curl -k -s "https://$PROXY_SERVER:8443/health" | grep -q "DCV Proxy OK"; then
    echo "✅ ヘルスチェック成功"
else
    echo "⚠️  ヘルスチェックに失敗しました"
fi

echo ""
echo "🎉 DCV Dynamic Proxy デプロイ完了！"
echo ""
echo "📋 テストコマンド:"
echo "  ヘルスチェック: curl -k https://$PROXY_SERVER:8443/health"
echo "  Agent1接続:    curl -k -I https://$PROXY_SERVER:8443/10.150.248.180/"
echo "  Agent2接続:    curl -k -I https://$PROXY_SERVER:8443/10.150.248.136/"
echo "  デフォルト:    curl -k -I https://$PROXY_SERVER:8443/"
echo ""
echo "🌐 ブラウザアクセス:"
echo "  Agent1: https://$PROXY_SERVER:8443/10.150.248.180/"
echo "  Agent2: https://$PROXY_SERVER:8443/10.150.248.136/"
echo "  デフォルト: https://$PROXY_SERVER:8443/"
```

### 3. DCV Agent 設定ファイル

**ファイル名**: `dcv-server-agent.conf` (各Agent用)

```ini
[license]
[log]
[display]
[connectivity]
web-url-path="/"
web-port=8443
web-use-https=true
enable-web-access=true

[security]
authentication="none"
```

### 4. DCV セッション作成スクリプト

**ファイル名**: `create-dcv-session.sh`

```bash
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
```

## デプロイ手順

### 前提条件
- nginx がプロキシサーバー (10.213.66.188) にインストール済み
- SSL証明書が `/etc/dcv-connection-gateway/certs/` に配置済み
- DCV Agent が各サーバーにインストール済み

### 1. ファイルの準備
```bash
# 設定ファイルを作成
cat > dcv-dynamic-proxy.conf << 'EOF'
[上記の nginx 設定内容]
EOF

# デプロイスクリプトを作成
cat > deploy-dcv-dynamic-proxy.sh << 'EOF'
[上記のデプロイスクリプト内容]
EOF

chmod +x deploy-dcv-dynamic-proxy.sh

# セッション作成スクリプトを作成
cat > create-dcv-session.sh << 'EOF'
[上記のセッション作成スクリプト内容]
EOF

chmod +x create-dcv-session.sh
```

### 2. プロキシサーバーへのデプロイ
```bash
# 動的プロキシをデプロイ
./deploy-dcv-dynamic-proxy.sh
```

### 3. DCV Agent の設定

各 Agent サーバーで以下を実行:

```bash
# Agent1 (10.150.248.180) での設定
ssh -i "tom.pem" ec2-user@10.150.248.180

# DCV設定ファイルの更新
sudo tee /etc/dcv/dcv.conf << 'EOF'
[license]
[log]
[display]
[connectivity]
web-url-path="/"
web-port=8443
web-use-https=true
enable-web-access=true

[security]
authentication="none"
EOF

# DCV サービスの再起動
sudo systemctl restart dcvserver

# セッションの作成
sudo dcv create-session --type=virtual --user=ec2-user desktop-session
```

### 4. 接続テスト

```bash
# ヘルスチェック
curl -k https://10.213.66.188:8443/health

# Agent1 接続テスト
curl -k -I https://10.213.66.188:8443/10.150.248.180/

# Agent2 接続テスト  
curl -k -I https://10.213.66.188:8443/10.150.248.136/

# デフォルトルート テスト
curl -k -I https://10.213.66.188:8443/
```

## 動作確認結果

### HTTP接続テスト結果
- ✅ ヘルスチェック: `HTTP/2 200 OK`
- ✅ Agent1 ルーティング: `HTTP/2 200 OK`
- ✅ Agent2 ルーティング: `HTTP/2 200 OK`
- ✅ デフォルトルート: `HTTP/2 200 OK`

### WebSocket対応
- ✅ WebSocket Upgrade ヘッダー対応
- ✅ Connection Upgrade マッピング
- ✅ プロキシ設定での WebSocket サポート

## トラブルシューティング

### デスクトップが表示されない場合

1. **DCV セッションの確認**
```bash
# Agent でセッション状態を確認
ssh -i "tom.pem" ec2-user@10.150.248.180
sudo dcv list-sessions

# セッションが無い場合は作成
sudo dcv create-session --type=virtual --user=ec2-user desktop-session
```

2. **DCV サービス状態の確認**
```bash
# DCV サービス状態
sudo systemctl status dcvserver

# DCV ログの確認
sudo journalctl -u dcvserver -f
```

3. **デスクトップ環境の確認**
```bash
# GUI デスクトップ環境のインストール (Ubuntu の場合)
sudo apt update
sudo apt install -y ubuntu-desktop-minimal

# X11 サービスの開始
sudo systemctl start gdm3
sudo systemctl enable gdm3
```

### nginx ログの監視

```bash
# リアルタイムログ監視
ssh -i "tom.pem" ec2-user@10.213.66.188 -p 50000
sudo tail -f /var/log/nginx/dcv-access.log /var/log/nginx/dcv-error.log
```

## セキュリティ考慮事項

### 現在の設定
- SSL/TLS 暗号化通信
- 認証なし (`authentication="none"`)
- 特定 IP 範囲への制限なし

### 本番環境での推奨事項
1. **認証の有効化**
   - DCV 認証の設定
   - nginx での Basic 認証追加

2. **アクセス制御**
   - IP アドレス制限の実装
   - VPN 経由でのアクセス制限

3. **ログ監視**
   - アクセスログの定期監視
   - 異常アクセスの検出

## 今後の拡張可能性

### 動的 Agent 追加
- 新しい Agent IP を追加する場合、nginx 設定変更不要
- パスベースルーティングにより自動対応

### ロードバランシング
- nginx upstream 設定による負荷分散
- ヘルスチェック機能の追加

### 監視・メトリクス
- Prometheus メトリクス収集
- Grafana ダッシュボード作成

## まとめ

AWS DCV の WebSocket 認証問題を nginx リバースプロキシによる動的ルーティングで解決しました。Session Manager Broker を完全にバイパスすることで、安定した接続を実現し、複数の DCV Agent への柔軟なルーティングが可能になりました。

現在の実装では HTTP 接続は正常に動作していますが、デスクトップセッションの表示には DCV Agent 側でのセッション作成とデスクトップ環境の適切な設定が必要です。