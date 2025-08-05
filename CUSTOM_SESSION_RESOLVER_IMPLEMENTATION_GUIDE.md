# カスタムSession Resolver実装ガイド

## 🎯 目的
Agent2レベルの直接接続をDCV Gateway経由で実現するため、カスタムSession Resolverを実装し、導通確認を最優先で進める。

## 📋 実装ステップ

### Phase 1: 事前準備

#### 1.1 必要なファイルの確認
```bash
# 作成済みファイルの確認
ls -la custom_session_resolver.py
ls -la dcv-connection-gateway-custom.conf
ls -la session_resolver_test.sh
```

#### 1.2 Python環境の準備
```bash
# Gateway側でPython3とFlaskをインストール
ssh -i "tom.pem" ec2-user@10.213.66.188 -p 50000
sudo yum update -y
sudo yum install -y python3 python3-pip
pip3 install flask
```

### Phase 2: カスタムSession Resolver配置

#### 2.1 ファイル転送
```bash
# Gateway側にファイルを転送
scp -i "tom.pem" -P 50000 custom_session_resolver.py ec2-user@10.213.66.188:/home/ec2-user/
scp -i "tom.pem" -P 50000 dcv-connection-gateway-custom.conf ec2-user@10.213.66.188:/home/ec2-user/
scp -i "tom.pem" -P 50000 session_resolver_test.sh ec2-user@10.213.66.188:/home/ec2-user/
```

#### 2.2 Session Resolver起動
```bash
# Gateway側でSession Resolverを起動
ssh -i "tom.pem" ec2-user@10.213.66.188 -p 50000
cd /home/ec2-user
chmod +x custom_session_resolver.py
chmod +x session_resolver_test.sh

# バックグラウンドで起動
nohup python3 custom_session_resolver.py > session_resolver.log 2>&1 &

# 起動確認
curl http://localhost:9000/health
```

### Phase 3: DCV Gateway設定更新

#### 3.1 設定ファイルバックアップ
```bash
# 現在の設定をバックアップ
sudo cp /etc/dcv-connection-gateway/dcv-connection-gateway.conf /etc/dcv-connection-gateway/dcv-connection-gateway.conf.backup
```

#### 3.2 新しい設定適用
```bash
# カスタム設定を適用
sudo cp /home/ec2-user/dcv-connection-gateway-custom.conf /etc/dcv-connection-gateway/dcv-connection-gateway.conf

# 設定確認
sudo cat /etc/dcv-connection-gateway/dcv-connection-gateway.conf | grep -A 5 "\[resolver\]"
```

#### 3.3 DCV Gateway再起動
```bash
# サービス再起動
sudo systemctl restart dcv-connection-gateway

# 起動確認
sudo systemctl status dcv-connection-gateway

# ログ確認
sudo journalctl -u dcv-connection-gateway -f
```

### Phase 4: Agent2ディスプレイ初期化

#### 4.1 Agent2側でのディスプレイ確認
```bash
# Agent2にSSH接続
ssh -i "tom.pem" ubuntu@10.213.66.188 -p 60001

# ディスプレイ環境確認
echo $DISPLAY
who

# GNOMEデスクトップ起動
sudo systemctl status gdm3
sudo systemctl start gdm3
sudo systemctl enable gdm3

# DCVセッション確認
sudo dcv list-sessions
```

#### 4.2 必要に応じてセッション再作成
```bash
# 既存セッション削除（必要な場合）
sudo dcv close-session console

# 新しいセッション作成
sudo dcv create-session --type=console --owner dcv console

# セッション確認
sudo dcv list-sessions
```

### Phase 5: 接続テスト実行

#### 5.1 テストスクリプト実行
```bash
# Gateway側でテスト実行
cd /home/ec2-user
./session_resolver_test.sh
```

#### 5.2 手動テスト
```bash
# Session Resolver単体テスト
curl -X POST "http://localhost:9000/resolveSession?sessionId=console&transport=HTTP&clientIpAddress=10.213.66.188"

# DCV Gateway経由テスト
curl -k https://10.213.66.188:8443/?sessionId=console

# Agent2直接接続テスト（比較用）
curl -k https://10.213.66.188:60000/?sessionId=console
```

### Phase 6: ブラウザ接続確認

#### 6.1 接続URL
```
# Gateway経由接続（目標）
https://10.213.66.188:8443/?sessionId=console

# Agent2直接接続（比較用）
https://10.213.66.188:60000/?sessionId=console
```

#### 6.2 期待される動作
1. **Session Resolver**: `console`セッションを`10.150.248.136:8443`に解決
2. **DCV Gateway**: Agent2への透過的プロキシ
3. **Agent2**: WebSocket接続確立
4. **ブラウザ**: リモートデスクトップ表示

## 🔧 トラブルシューティング

### Session Resolver関連
```bash
# ログ確認
tail -f session_resolver.log

# プロセス確認
ps aux | grep python3

# ポート確認
netstat -tlnp | grep 9000
```

### DCV Gateway関連
```bash
# サービス状態確認
sudo systemctl status dcv-connection-gateway

# ログ確認
sudo journalctl -u dcv-connection-gateway -n 50

# 設定確認
sudo dcv-connection-gateway --check-config
```

### Agent2関連
```bash
# DCVサーバー状態確認
sudo systemctl status dcvserver

# セッション状態確認
sudo dcv list-sessions

# ログ確認
sudo tail -f /var/log/dcv/server.log
```

## 📊 成功指標

### ✅ 成功時の確認項目
- [ ] Session Resolver起動（ポート9000でリッスン）
- [ ] DCV Gateway起動（カスタム設定適用）
- [ ] Agent2のconsoleセッション存在
- [ ] Session Resolver API応答正常
- [ ] Gateway経由でのHTTP 200応答
- [ ] ブラウザでのリモートデスクトップ表示

### ❌ 失敗時の確認項目
- Session Resolver未起動 → `python3 custom_session_resolver.py`
- DCV Gateway設定エラー → 設定ファイル確認
- Agent2セッション不存在 → セッション再作成
- ネットワーク接続問題 → ファイアウォール・セキュリティグループ確認

## 🎯 次回継続時の確認事項

1. **Session Resolver状態**: `curl http://localhost:9000/health`
2. **DCV Gateway状態**: `sudo systemctl status dcv-connection-gateway`
3. **Agent2セッション**: `sudo dcv list-sessions`
4. **接続テスト**: `./session_resolver_test.sh`

## 📁 関連ファイル

- [`custom_session_resolver.py`](custom_session_resolver.py): カスタムSession Resolver実装
- [`dcv-connection-gateway-custom.conf`](dcv-connection-gateway-custom.conf): Gateway設定
- [`session_resolver_test.sh`](session_resolver_test.sh): 接続テストスクリプト
- [`DCV_SESSION_MANAGER_PROBLEM_RESOLUTION_REPORT.md`](DCV_SESSION_MANAGER_PROBLEM_RESOLUTION_REPORT.md): 総合レポート