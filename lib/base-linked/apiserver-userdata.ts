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
  private environmentVariables: Record<string, string> = {};

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

    // Download and execute install.sh
    this.userData.addS3DownloadCommand({
      bucket: this.installScriptAsset.bucket,
      bucketKey: this.installScriptAsset.s3ObjectKey,
      localFile: '/tmp/install.sh',
    });
    this.userData.addExecuteFileCommand({
      filePath: '/tmp/install.sh',
      arguments: '',
    });

    // Download config_server.py
    this.userData.addS3DownloadCommand({
      bucket: this.appCodeAsset.bucket,
      bucketKey: this.appCodeAsset.s3ObjectKey,
      localFile: '/root/config_server.py',
    });

    // Execute start-app.sh
    this.userData.addS3DownloadCommand({
      bucket: this.startAppScriptAsset.bucket,
      bucketKey: this.startAppScriptAsset.s3ObjectKey,
      localFile: '/tmp/start-app.sh',
    });
  }

  /**
   * Setting Env and execute start-app.sh
   * @param environment 環境変数のオブジェクト
   */
  public setEnvironmentAndExecuteStartApp(environment: Record<string, string>): void {
    this.environmentVariables = environment;
    
    // Add Enviroment parameter add export command
    const envCommands = Object.entries(this.environmentVariables).map(
      ([key, value]) => `export ${key}="${value}"`
    );
    this.userData.addCommands(...envCommands);
    
    // execute start-app.sh
    this.userData.addExecuteFileCommand({
      filePath: '/tmp/start-app.sh',
      arguments: '',
    });
  }

  /**
   * Get S3 Asset IAM Plicy
   * @param role IAMロール
   */
  public grantReadToRole(role: iam.IRole): void {
    this.installScriptAsset.grantRead(role);
    this.appCodeAsset.grantRead(role);
    this.startAppScriptAsset.grantRead(role);
  }
}
