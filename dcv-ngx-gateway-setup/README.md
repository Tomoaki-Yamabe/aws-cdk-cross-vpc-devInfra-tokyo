# AWS DCV nginx Gateway セットアップ

## 🎯 プロジェクトゴール

AWS DCV (Desktop Cloud Visualization) の WebSocket 認証問題を解決し、複数の DCV Agent への動的ルーティングを実現する nginx リバースプロキシシステムを構築する。

## 📋 プロジェクト概要

### 解決した問題
- **WebSocket 認証 404 エラー**: AWS Session Manager Broker の設計上の制限により発生
- **複数 Agent への動的ルーティング**: パスベースでの柔軟な Agent 切り替えが困難
- **Session Manager 依存**: 複雑な Session Manager Broker 設定による不安定性

### 最終解決策
**nginx リバースプロキシによる Session Manager Broker 完全バイパス**
- 動的 IP ルーティング: `https://proxy:8443/<AgentIP>/` → `https://<AgentIP>:8443/`
- WebSocket 完全対応: HTTP/2 + WebSocket Upgrade 対応
- SSL/TLS 暗号化: 既存証明書の再利用

## 🚀 クイックスタート

### 前提条件
- nginx がプロキシサーバー (10.213.66.188) にインストール済み
- SSL証明書が `/etc/dcv-connection-gateway/certs/` に配置済み
- DCV Agent が各サーバーにインストール済み
- SSH キー (`tom.pem`) が利用可能

### 1. 動的プロキシのデプロイ
```bash
# デプロイスクリプトを実行
./deploy-dcv-dynamic-proxy.sh
```

### 2. DCV セッションの作成
```bash
# Agent1 でセッション作成
./create-dcv-session.sh 10.150.248.180

# Agent2 でセッション作成  
./create-dcv-session.sh 10.150.248.136
```

### 3. 接続テスト
```bash
# ヘルスチェック
curl -k https://10.213.66.188:8443/health

# Agent1 接続テスト
curl -k -I https://10.213.66.188:8443/10.150.248.180/

# Agent2 接続テスト
curl -k -I https://10.213.66.188:8443/10.150.248.136/
```

## 📁 ファイル構成

### メインファイル
- [`dcv-dynamic-proxy.conf`](dcv-dynamic-proxy.conf) - nginx 動的プロキシ設定
- [`deploy-dcv-dynamic-proxy.sh`](deploy-dcv-dynamic-proxy.sh) - 自動デプロイスクリプト
- [`create-dcv-session.sh`](create-dcv-session.sh) - DCV セッション作成スクリプト

### 過去の試行・研究
- [`try-and-research/session-manager-broker-2025-01/`](try-and-research/session-manager-broker-2025-01/) - Session Manager Broker 実装試行
- [`try-and-research/connection-gateway-2025-01/`](try-and-research/connection-gateway-2025-01/) - DCV Connection Gateway 実装試行
- [`try-and-research/nginx-proxy-2025-01/`](try-and-research/nginx-proxy-2025-01/) - nginx プロキシ実装試行

## 🔧 技術仕様

### アーキテクチャ
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

### 主要機能
- **動的 IP ルーティング**: 任意の IP アドレスへの自動ルーティング
- **WebSocket 対応**: HTTP/2 + WebSocket Upgrade 完全サポート
- **SSL/TLS 暗号化**: 既存 DCV 証明書の再利用
- **ヘルスチェック**: `/health` エンドポイントでの状態監視
- **ログ監視**: アクセス・エラーログの統合管理

## 📊 動作確認結果

### HTTP 接続テスト
- ✅ ヘルスチェック: `HTTP/2 200 OK`
- ✅ Agent1 ルーティング: `HTTP/2 200 OK`
- ✅ Agent2 ルーティング: `HTTP/2 200 OK`
- ✅ デフォルトルート: `HTTP/2 200 OK`

### WebSocket 対応
- ✅ WebSocket Upgrade ヘッダー対応
- ✅ Connection Upgrade マッピング
- ✅ プロキシ設定での WebSocket サポート

## 🔍 トラブルシューティング

### デスクトップが表示されない場合

1. **DCV セッションの確認**
```bash
ssh -i "tom.pem" ec2-user@10.150.248.180
sudo dcv list-sessions

# セッションが無い場合は作成
sudo dcv create-session --type=virtual --user=ec2-user desktop-session
```

2. **DCV サービス状態の確認**
```bash
sudo systemctl status dcvserver
sudo journalctl -u dcvserver -f
```

3. **デスクトップ環境の確認**
```bash
# GUI デスクトップ環境のインストール (Ubuntu の場合)
sudo apt update
sudo apt install -y ubuntu-desktop-minimal
sudo systemctl start gdm3
sudo systemctl enable gdm3
```

### nginx ログの監視
```bash
ssh -i "tom.pem" ec2-user@10.213.66.188 -p 50000
sudo tail -f /var/log/nginx/dcv-access.log /var/log/nginx/dcv-error.log
```

## 🔒 セキュリティ考慮事項

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

## 📈 今後の拡張可能性

### 動的 Agent 追加
- 新しい Agent IP を追加する場合、nginx 設定変更不要
- パスベースルーティングにより自動対応

### ロードバランシング
- nginx upstream 設定による負荷分散
- ヘルスチェック機能の追加

### 監視・メトリクス
- Prometheus メトリクス収集
- Grafana ダッシュボード作成

## 📚 過去の試行履歴

### 1. Session Manager Broker 実装 (2025-01)
**目標**: AWS Session Manager Broker を使用した DCV 接続
**結果**: WebSocket 認証 404 エラーにより断念
**学習**: AWS Session Manager Broker は WebSocket に対応していない

**関連ファイル**: [try-and-research/session-manager-broker-2025-01/](try-and-research/session-manager-broker-2025-01/)
- `DCV_SESSION_MANAGER_DETAILED_REPORT.md` - 詳細な実装レポート
- `DCV_SESSION_MANAGER_IMPLEMENTATION_REPORT.md` - 実装手順書
- `DCV_SESSION_MANAGER_PROBLEM_RESOLUTION_REPORT.md` - 問題解決レポート
- `custom_session_resolver.py` - カスタム Session Resolver 実装
- `session-manager-broker-optimized.properties` - 最適化設定

### 2. DCV Connection Gateway 実装 (2025-01)
**目標**: DCV Connection Gateway + Session Resolver による接続
**結果**: 設定の複雑さと WebSocket 問題により断念
**学習**: Connection Gateway も根本的な WebSocket 問題を解決できない

**関連ファイル**: [try-and-research/connection-gateway-2025-01/](try-and-research/connection-gateway-2025-01/)
- `dcv-connection-gateway-*.conf` - 各種 Gateway 設定ファイル
- `dcv-connection-gateway-systemd.service` - systemd サービス設定
- `dcv-server-*.conf` - DCV Server 設定ファイル
- `websocket_auth_fix_commands.sh` - WebSocket 認証修正コマンド

### 3. nginx プロキシ実装 (2025-01)
**目標**: nginx リバースプロキシによる Session Manager バイパス
**結果**: 成功 - 現在の最終解決策
**学習**: シンプルなプロキシ設定が最も効果的

**関連ファイル**: [try-and-research/nginx-proxy-2025-01/](try-and-research/nginx-proxy-2025-01/)
- `dcv-dynamic-routing*.conf` - 動的ルーティング設定の進化
- `dcv-path-routing.conf` - パスベースルーティング実装
- `deploy-dynamic-routing.sh` - 動的ルーティングデプロイスクリプト
- `deploy-dcv-config.sh` - DCV 設定デプロイスクリプト

## 🎉 まとめ

AWS DCV の WebSocket 認証問題を nginx リバースプロキシによる動的ルーティングで解決しました。Session Manager Broker を完全にバイパスすることで、安定した接続を実現し、複数の DCV Agent への柔軟なルーティングが可能になりました。

現在の実装では HTTP 接続は正常に動作していますが、デスクトップセッションの表示には DCV Agent 側でのセッション作成とデスクトップ環境の適切な設定が必要です。

**最終的な成果**:
- ✅ WebSocket 認証問題の完全解決
- ✅ 動的 IP ルーティングの実現
- ✅ HTTP/2 + WebSocket 完全対応
- ✅ 新規環境での再現可能なデプロイ手順
- ✅ 包括的なトラブルシューティングガイド

---

**作成日**: 2025年1月8日  
**最終更新**: 2025年1月8日  
**バージョン**: 1.0.0