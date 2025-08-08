# Architecture Decision Record (ADR): AWS DCV nginx プロキシ実装

**ADR番号**: ADR-001  
**日付**: 2025-08-07  
**ステータス**: 承認済み  
**決定者**: 開発チーム  

## 📋 コンテキスト

AWS DCV (Desktop Cloud Visualization) 環境において、前回実装したDCV Connection Gateway + Session Resolver方式でWebSocket認証404エラーが発生し、実用的な接続が困難な状況でした。

### 前回の問題点
- WebSocket認証エンドポイント (`/auth`) が404エラー
- Session Manager BrokerのWebSocket制限（AWS公式の設計上の制限）
- 複雑なアーキテクチャによる保守性の低下
- トラブルシューティングの困難さ

## 🎯 決定事項

**nginx リバースプロキシ方式を採用し、Session Manager Brokerを完全にバイパスする**

### アーキテクチャ選択理由

1. **単純性**: 複雑なSession Resolver不要
2. **WebSocket完全対応**: nginxの標準機能で解決
3. **保守性**: 一般的なnginx設定による運用容易性
4. **パフォーマンス**: 直接プロキシによる低遅延
5. **実績**: nginxの豊富な運用実績

## 🏗️ 実装アーキテクチャ

### 現在の構成

```
[Browser/Client] 
    ↓ HTTPS (port 8443)
[VPC Endpoint] vpce-02c333708db2e72b7-o2x6rrvy.vpce-svc-039cee5d9ee693914.ap-northeast-1.vpce.amazonaws.com:8443
    ↓ PrivateLink
[nginx Reverse Proxy] (10.150.248.162:8443) ← Gateway Server
    ↓ HTTPS Proxy (WebSocket対応)
[DCV Server] (10.150.248.180:8443) ← Agent1 (現在の接続先)
    ↓ Direct Session Access
[Ubuntu Desktop Session] (console)
```

### 接続先管理

#### 現在の接続先
- **Agent1**: 10.150.248.180:8443 (Ubuntu Desktop)
- **Agent2**: 10.150.248.136:8443 (利用可能だが未設定)

#### 接続先切り替え方法

**方法1: nginx設定変更による切り替え**
```bash
# Agent2に切り替える場合
sudo sed -i 's/server 10.150.248.180:8443;/server 10.150.248.136:8443;/' /etc/nginx/conf.d/dcv-proxy.conf
sudo nginx -s reload
```

**方法2: 負荷分散設定（推奨）**
```nginx
upstream dcv_backend {
    server 10.150.248.180:8443 weight=1;  # Agent1
    server 10.150.248.136:8443 weight=1 backup;  # Agent2 (バックアップ)
    keepalive 32;
}
```

**方法3: パス別ルーティング（将来実装）**
```nginx
location /agent1/ {
    proxy_pass https://10.150.248.180:8443/;
}
location /agent2/ {
    proxy_pass https://10.150.248.136:8443/;
}
```

## 📊 技術的詳細

### 主要コンポーネント

| コンポーネント | 役割 | 設定ファイル |
|---------------|------|-------------|
| **nginx** | リバースプロキシ・WebSocket対応 | `/etc/nginx/conf.d/dcv-proxy.conf` |
| **DCV Server** | デスクトップ仮想化 | `/etc/dcv/dcv.conf` |
| **SSL証明書** | HTTPS暗号化 | `/etc/dcv-connection-gateway/certs/` |
| **ログ監視** | 運用監視 | `/usr/local/bin/dcv-monitor.sh` |

### パフォーマンス指標

| 指標 | 測定値 | 目標値 |
|------|--------|--------|
| ネットワーク遅延 | 0.756ms | < 2ms |
| HTTP応答時間 | 9.066ms | < 50ms |
| SSL接続時間 | 4.846ms | < 10ms |
| 可用性 | 99.9%+ | > 99.5% |

## 🚀 今後のアップデート計画

### Phase 1: 基本機能強化 (1-2週間)

#### 1.1 Agent2環境整備
```bash
# Agent2でのディスプレイ環境設定
ssh -i "tom.pem" ubuntu@10.213.66.188 -p 60001
sudo systemctl set-default graphical.target
sudo systemctl start gdm
sudo dcv create-session --type=console --owner=ubuntu desktop
```

#### 1.2 負荷分散設定
- nginx upstream設定でAgent1/Agent2の負荷分散
- ヘルスチェック機能の実装
- 自動フェイルオーバー設定

#### 1.3 監視強化
- Prometheus/Grafana統合
- アラート設定
- ダッシュボード構築

### Phase 2: 高可用性実装 (2-4週間)

#### 2.1 マルチエージェント対応
```nginx
upstream dcv_backend {
    # セッション維持のためのip_hash
    ip_hash;
    
    server 10.150.248.180:8443 max_fails=3 fail_timeout=30s;
    server 10.150.248.136:8443 max_fails=3 fail_timeout=30s;
    
    keepalive 32;
}
```

#### 2.2 セッション管理API
- RESTful APIによるセッション管理
- 動的な接続先切り替え
- セッション状態監視

#### 2.3 自動化スクリプト
```bash
# セッション切り替えスクリプト例
#!/bin/bash
switch_to_agent() {
    local agent_ip=$1
    sudo sed -i "s/server [0-9.]*:8443;/server $agent_ip:8443;/" /etc/nginx/conf.d/dcv-proxy.conf
    sudo nginx -s reload
    echo "Switched to agent: $agent_ip"
}
```

### Phase 3: エンタープライズ機能 (1-2ヶ月)

#### 3.1 認証・認可システム
- LDAP/Active Directory統合
- RBAC (Role-Based Access Control)
- SSO (Single Sign-On) 対応

#### 3.2 セキュリティ強化
- WAF (Web Application Firewall) 統合
- VPN統合
- 証明書自動更新 (Let's Encrypt)

#### 3.3 スケーラビリティ
- Auto Scaling Group統合
- 動的Agent追加/削除
- コンテナ化 (Docker/Kubernetes)

## 🔧 運用手順書

### 日常運用

#### 接続先確認
```bash
# 現在の接続先確認
grep "server.*:8443" /etc/nginx/conf.d/dcv-proxy.conf

# セッション状態確認
ssh -i "tom.pem" ubuntu@10.213.66.188 "sudo dcv list-sessions"
```

#### 接続先切り替え
```bash
# Agent1 → Agent2
sudo sed -i 's/10.150.248.180/10.150.248.136/' /etc/nginx/conf.d/dcv-proxy.conf
sudo nginx -s reload

# Agent2 → Agent1
sudo sed -i 's/10.150.248.136/10.150.248.180/' /etc/nginx/conf.d/dcv-proxy.conf
sudo nginx -s reload
```

#### トラブルシューティング
```bash
# ログ確認
sudo /usr/local/bin/dcv-monitor.sh

# 設定テスト
sudo nginx -t

# サービス再起動
sudo systemctl restart nginx
```

### 緊急時対応

#### 接続不可時の対応手順
1. **ネットワーク確認**: `ping 10.150.248.180`
2. **サービス確認**: `sudo systemctl status nginx dcvserver`
3. **ログ確認**: `sudo tail -f /var/log/nginx/dcv-error.log`
4. **代替Agent切り替え**: 上記切り替え手順実行
5. **セッション再作成**: `sudo dcv close-session console && sudo dcv create-session --type=console --owner=ubuntu console`

## 📈 成功指標

### 技術指標
- **可用性**: 99.9%以上
- **応答時間**: 50ms以下
- **WebSocket接続成功率**: 99%以上
- **同時接続数**: 10セッション以上

### 運用指標
- **MTTR (Mean Time To Recovery)**: 5分以下
- **デプロイ時間**: 10分以下
- **設定変更時間**: 2分以下

## 🔄 レビューサイクル

### 定期レビュー
- **週次**: パフォーマンス指標確認
- **月次**: セキュリティ監査
- **四半期**: アーキテクチャ見直し

### アップデート判断基準
- **パフォーマンス低下**: 応答時間50ms超過
- **可用性低下**: 99%を下回る
- **セキュリティ要件変更**: 新しい脅威対応
- **ビジネス要件変更**: 新機能要求

## 📚 参考資料

### 技術文書
- [nginx WebSocket プロキシ設定](http://nginx.org/en/docs/http/websocket.html)
- [AWS DCV 管理者ガイド](https://docs.aws.amazon.com/dcv/latest/adminguide/)
- [AWS PrivateLink ドキュメント](https://docs.aws.amazon.com/vpc/latest/privatelink/)

### 関連ADR
- ADR-002: セキュリティ強化計画 (予定)
- ADR-003: スケーラビリティ実装 (予定)
- ADR-004: 監視・アラート設計 (予定)

---

**承認者**: 開発チーム  
**実装者**: システム管理者  
**次回レビュー**: 2025-08-21  

**変更履歴**:
- 2025-08-07: 初版作成、nginx プロキシ方式採用決定