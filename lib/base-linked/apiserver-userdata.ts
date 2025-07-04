import * as path from 'path';
import { Asset } from 'aws-cdk-lib/aws-s3-assets';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export class ApiServerUserData {
  public readonly userData: ec2.UserData;
  public readonly installScriptAsset: Asset;
  public readonly appCodeAsset: Asset;
  public readonly startAppScriptAsset: Asset;

  constructor(scope: Construct, id: string) {
    // Use Asset system
    this.installScriptAsset = new Asset(scope, `${id}InstallScriptAsset`, {
      path: path.join(__dirname, 'scripts/install.sh'),
    });

    this.appCodeAsset = new Asset(scope, `${id}AppCodeAsset`, {
      path: path.join(__dirname, 'scripts/config_server.py'),
    });

    this.startAppScriptAsset = new Asset(scope, `${id}StartAppScriptAsset`, {
      path: path.join(__dirname, 'scripts/start-app.sh'),
    });

    // ==== Set up UserData ====
    this.userData = ec2.UserData.forLinux();

    // install.sh を DL & 実行（環境構築）
    this.userData.addS3DownloadCommand({
      bucket: this.installScriptAsset.bucket,
      bucketKey: this.installScriptAsset.s3ObjectKey,
      localFile: '/tmp/install.sh',
    });
    this.userData.addExecuteFileCommand({
      filePath: '/tmp/install.sh',
      arguments: '',
    });

    // 2) config_server.py を DL（アプリ本体）
    this.userData.addS3DownloadCommand({
      bucket: this.appCodeAsset.bucket,
      bucketKey: this.appCodeAsset.s3ObjectKey,
      localFile: '/root/config_server.py',
    });

    // 3) start-app.sh を DL & 実行（アプリケーション起動）
    this.userData.addS3DownloadCommand({
      bucket: this.startAppScriptAsset.bucket,
      bucketKey: this.startAppScriptAsset.s3ObjectKey,
      localFile: '/tmp/start-app.sh',
    });
    this.userData.addExecuteFileCommand({
      filePath: '/tmp/start-app.sh',
      arguments: '',
    });
  }

  /**
   * 全てのS3アセットを読み取れるようにIAMロールに権限を付与
   * @param role IAMロール
   */
  public grantReadToRole(role: iam.IRole): void {
    this.installScriptAsset.grantRead(role);
    this.appCodeAsset.grantRead(role);
    this.startAppScriptAsset.grantRead(role);
  }
}
