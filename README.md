# AWS CDK Cross-VPC Development Infrastructure (Tokyo Region)

このプロジェクトは、AWS CDKを使用してクロスVPC環境での開発インフラストラクチャを構築するためのTypeScriptプロジェクトです。東京リージョン（ap-northeast-1）での展開を想定しています。

## プロジェクト概要

- **Base Isolated Stack**: 独立したVPC環境でのベースインフラストラクチャ
- **Base Linked Stack**: 他のVPCと連携するベースインフラストラクチャ
- **Services Isolated Stack**: ECSサービスを含む独立したサービス環境

## 前提条件

- Node.js 18.x 以上
- npm 8.x 以上
- AWS CLI v2
- AWS CDK v2
- AWS アカウントと適切な権限

## セットアップ手順

### Windows環境でのセットアップ

#### 1. Node.jsのインストール
1. [Node.js公式サイト](https://nodejs.org/)から最新のLTS版をダウンロード
2. インストーラーを実行し、デフォルト設定でインストール
3. PowerShellまたはコマンドプロンプトを開いて確認：
```powershell
node --version
npm --version
```

#### 2. AWS CLIのインストール
1. [AWS CLI公式サイト](https://aws.amazon.com/cli/)からWindows用インストーラーをダウンロード
2. インストーラーを実行
3. インストール後、PowerShellで確認：
```powershell
aws --version
```

#### 3. AWS CDKのインストール
```powershell
npm install -g aws-cdk
cdk --version
```

#### 4. プロジェクトのセットアップ
```powershell
# プロジェクトをクローン
git clone http://172.23.11.223/XILS_SILS_TEAM/dx8d_idp_team/cloudformationstacks/develop/mirrorondemand-aws-cdk-cross-vpc-devinfra-tokyo
cd aws-cdk-cross-vpc-devInfra-tokyo

# 依存関係をインストール
npm install

# TypeScriptをインストール
npm install --save-dev typescript

# プロジェクトをビルド
npm run build
```   
# 

### Ubuntu環境でのセットアップ

#### 1. Node.jsのインストール
```bash
# Node.jsの最新LTS版をインストール
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt-get install -y nodejs

# バージョン確認
node --version
npm --version
```

#### 2. AWS CLIのインストール
```bash
# AWS CLI v2をインストール
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
unzip awscliv2.zip
sudo ./aws/install

# バージョン確認
aws --version
```

#### 3. AWS CDKのインストール
```bash
sudo npm install -g aws-cdk
cdk --version
```

#### 4. プロジェクトのセットアップ
```bash
# プロジェクトをクローン
git clone <repository-url>
cd aws-cdk-cross-vpc-devInfra-tokyo

# 依存関係をインストール
npm install

# TypeScriptをインストール（開発依存関係）
npm install --save-dev typescript

# プロジェクトをビルド
npm run build
```

## AWS認証情報の設定

### 方法1: AWS CLIを使用した設定
```bash
aws configure
```
以下の情報を入力：
- AWS Access Key ID
- AWS Secret Access Key
- Default region name: `ap-northeast-1`
- Default output format: `json`

## 開発の開始

### 1. プロジェクトのビルドと確認
```bash
# TypeScriptをJavaScriptにコンパイル
npm run build

# CloudFormationテンプレートの生成確認
cdk synth

# 現在のスタックと差分を確認
cdk diff
```

### 2. スタックのデプロイ
```bash
# 全スタックをデプロイ
cdk deploy --all

# 特定のスタックのみデプロイ
cdk deploy BaseIsolatedStack
cdk deploy BaseLinkedStack
cdk deploy ServicesIsolatedStack
```

### 3. 開発時の便利なコマンド
```bash
# ファイル変更を監視して自動コンパイル
npm run watch

# Jestユニットテストの実行
npm run test

# スタックの削除
cdk destroy --all
```

## プロジェクト構造

```
├── bin/
│   └── app.ts                    # CDKアプリケーションのエントリーポイント
├── lib/
│   ├── base-isolated/
│   │   └── infra-stack.ts        # 独立ベースインフラスタック
│   ├── base-linked/
│   │   ├── infra-stack.ts        # 連携ベースインフラスタック
│   │   ├── apiserver-userdata.ts # APIサーバーのユーザーデータ
│   │   └── scripts/              # セットアップスクリプト
│   └── services-isolated/
│       └── ecs-service-stack.ts  # ECSサービススタック
├── test/                         # テストファイル
├── cdk.json                      # CDK設定ファイル
└── package.json                  # npm設定ファイル
```


## cdk command list

* `npm run build`   - TypeScriptをJavaScriptにコンパイル
* `npm run watch`   - ファイル変更を監視して自動コンパイル
* `npm run test`    - Jestユニットテストを実行
* `npx cdk deploy`  - スタックをデフォルトのAWSアカウント/リージョンにデプロイ
* `npx cdk diff`    - デプロイ済みスタックと現在の状態を比較
* `npx cdk synth`   - CloudFormationテンプレートを生成
* `npx cdk destroy` - スタックを削除

## 参考資料

- [AWS CDK Developer Guide](https://docs.aws.amazon.com/cdk/v2/guide/)
- [AWS CDK API Reference](https://docs.aws.amazon.com/cdk/api/v2/)
- [TypeScript Documentation](https://www.typescriptlang.org/docs/)
