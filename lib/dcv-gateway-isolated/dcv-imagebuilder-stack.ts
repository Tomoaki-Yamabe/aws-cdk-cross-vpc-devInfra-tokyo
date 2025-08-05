import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as imagebuilder from 'aws-cdk-lib/aws-imagebuilder';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as s3 from 'aws-cdk-lib/aws-s3';

interface DcvImageBuilderStackProps extends cdk.StackProps {
  vpcId: string;
  subnetIds: string[];
}

export class DcvImageBuilderStack extends cdk.Stack {
  public readonly imageRecipeArn: string;
  public readonly pipelineArn: string;

  constructor(scope: Construct, id: string, props: DcvImageBuilderStackProps) {
    super(scope, id, props);

    // Apply consistent tags
    cdk.Tags.of(this).add('Project', 'EliteGen2');
    cdk.Tags.of(this).add('Environment', 'Production');
    cdk.Tags.of(this).add('OwnedBy', 'YAMABE');
    cdk.Tags.of(this).add('ManagedBy', 'CloudFormation');
    cdk.Tags.of(this).add('Service', 'DCV-Gateway');


    // ------------------ Basic setup ------------------ //
    // Import VPC and subnets
    const vpc = ec2.Vpc.fromLookup(this, 'DcvVpc', { vpcId: props.vpcId });
    const azs = cdk.Stack.of(this).availabilityZones;
    const subnets = props.subnetIds.map((id, i) =>
      ec2.Subnet.fromSubnetAttributes(this, `DcvSubnet${i}`, {
        subnetId: id,
        availabilityZone: azs[i % azs.length],
      })
    );

    // Create S3 bucket for Image Builder logs
    const logsBucket = new s3.Bucket(this, 'DcvImageBuilderLogsBucket', {
      bucketName: `dcv-imagebuilder-logs-${this.account}-${this.region}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: false,
      lifecycleRules: [
        {
          id: 'DeleteOldLogs',
          enabled: true,
          expiration: cdk.Duration.days(30), // Delete logs after 30 days
        },
      ],
      removalPolicy: cdk.RemovalPolicy.DESTROY, // For development - change to RETAIN for production
    });

    // Create IAM role for Image Builder instance
    const instanceRole = new iam.Role(this, 'DcvImageBuilderInstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'IAM role for DCV Gateway Image Builder instance',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('EC2InstanceProfileForImageBuilder'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    // Grant S3 permissions to the instance role for logging
    logsBucket.grantWrite(instanceRole);

    // Create instance profile
    const instanceProfile = new iam.CfnInstanceProfile(this, 'DcvImageBuilderInstanceProfile', {
      roles: [instanceRole.roleName],
      instanceProfileName: `DcvImageBuilder-InstanceProfile-${this.region}`,
    });

    // Create security group for Image Builder
    const imageBuilderSg = new ec2.SecurityGroup(this, 'DcvImageBuilderSecurityGroup', {
      vpc: vpc,
      description: 'Security group for DCV Gateway Image Builder',
      allowAllOutbound: true,
    });

    // Allow ALL outband
    imageBuilderSg.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.allTraffic(),
      'Allow all outbound traffic'
    );


    // ------------------ Image Builder ------------------ //
    // Create DCV Gateway installation component
    const dcvInstallComponent = new imagebuilder.CfnComponent(this, 'DcvGatewayInstallComponent', {
      name: 'install-dcv-gateway-broker',
      version: '1.0.4',
      platform: 'Linux',
      description: 'Install and configure NICE DCV Gateway with Session Manager Broker',
      data: `
name: install-dcv-gateway-broker
description: Install and configure NICE DCV Gateway with Session Manager Broker
schemaVersion: 1.0
phases:
  - name: build
    steps:
      - name: update-system
        action: ExecuteBash
        inputs:
          commands:
            - echo "Updating system packages..."
            - yum update -y
            - yum install -y jq curl unzip openssl
      
      - name: setup-dcv-repository
        action: ExecuteBash
        inputs:
          commands:
            - echo "Setting up DCV repository..."
            - |
              cat >/etc/yum.repos.d/nice-dcv.repo <<EOF
              [dcv]
              name=NICE DCV packages
              baseurl=https://d1uj6qtbmh3dt5.cloudfront.net/2024.0/rhel/9/x86_64/
              gpgcheck=0
              enabled=1
              EOF

      - name: install-dcv-components
        action: ExecuteBash
        inputs:
          commands:
            - echo "Installing DCV Session Manager Broker and Connection Gateway..."
            - yum -y install nice-dcv-session-manager-broker nice-dcv-connection-gateway

      - name: configure-broker
        action: ExecuteBash
        inputs:
          commands:
            - echo "Configuring Session Manager Broker..."
            - |
              cat >>/etc/dcv-session-manager-broker/session-manager-broker.properties <<'CONF'
              # 内部認証サーバを同居
              enable-gateway              = true
              enable-authorization-server = true
              enable-authorization        = true
              
              # ポート
              client-to-broker-connector-https-port  = 8448
              gateway-to-broker-connector-https-port = 8447
              agent-to-broker-connector-https-port   = 8445
              
              # クラスタ設定（単一ノード）
              broker-to-broker-connection-login = dcvsm-user
              broker-to-broker-connection-pass  = dcvsm-pass
              broker-to-broker-discovery-addresses = 127.0.0.1:47500
              CONF

      - name: configure-gateway
        action: ExecuteBash
        inputs:
          commands:
            - echo "Configuring Connection Gateway..."
            - install -d -o dcvcgw -g dcvcgw /etc/dcv-connection-gateway/certs
            - |
              openssl req -x509 -nodes -days 3650 -newkey rsa:2048 -subj "/CN=$(hostname -f)" \
                      -keyout /etc/dcv-connection-gateway/certs/dcv.key \
                      -out  /etc/dcv-connection-gateway/certs/dcv.crt
            - chmod 600 /etc/dcv-connection-gateway/certs/dcv.key
            - chown dcvcgw:dcvcgw /etc/dcv-connection-gateway/certs/dcv.*
            - |
              cat >/etc/dcv-connection-gateway/dcv-connection-gateway.conf <<'GWCONF'
              [gateway]
              quic-listen-endpoints  = []
              web-listen-endpoints   = ["0.0.0.0:8443"]
              cert-file      = "/etc/dcv-connection-gateway/certs/dcv.crt"
              cert-key-file  = "/etc/dcv-connection-gateway/certs/dcv.key"
              
              [resolver]
              url        = "https://127.0.0.1:8447"
              tls-strict = false
              
              [log]
              level = "info"
              GWCONF

      - name: enable-services
        action: ExecuteBash
        inputs:
          commands:
            - echo "Enabling services..."
            - systemctl daemon-reload
            - systemctl enable dcv-session-manager-broker dcv-connection-gateway
            - echo "DCV Gateway + Broker installation and configuration completed"
      
      - name: security-hardening
        action: ExecuteBash
        inputs:
          commands:
            - echo "Applying security hardening..."
            - yum clean all
            - rm -rf /tmp/*
            - rm -rf /var/tmp/*
            - echo "Security hardening completed"

  - name: validate
    steps:
      - name: verify-installation
        action: ExecuteBash
        inputs:
          commands:
            - echo "Verifying DCV Gateway + Broker installation..."
            - systemctl is-enabled dcv-session-manager-broker.service
            - systemctl is-enabled dcv-connection-gateway.service
            - test -f /etc/dcv-session-manager-broker/session-manager-broker.properties
            - test -f /etc/dcv-connection-gateway/dcv-connection-gateway.conf
            - echo "DCV Gateway + Broker verification completed successfully"

      `,
      tags: {
        Project: 'EliteGen2',
        Environment: 'Production',
        OwnedBy: 'YAMABE',
        ManagedBy: 'CloudFormation',
        Service: 'DCV-Gateway',
      },
    });


    // Create image recipe
    const imageRecipe = new imagebuilder.CfnImageRecipe(this, 'DcvGatewayImageRecipe', {
      name: 'dcv-gateway-broker-recipe',
      version: '1.0.4',
      description: 'Image recipe for NICE DCV Gateway with Session Manager Broker',
      components: [
        {
          componentArn: dcvInstallComponent.attrArn,
        },
      ],
      parentImage: `arn:aws:imagebuilder:${this.region}:aws:image/amazon-linux-2023-x86/x.x.x`,
      blockDeviceMappings: [
        {
          deviceName: '/dev/xvda',
          ebs: {
            volumeSize: 30,
            volumeType: 'gp3',
            encrypted: true, // Enable encryption for security
            deleteOnTermination: true,
          },
        },
      ],
      tags: {
        Project: 'EliteGen2',
        Environment: 'Production',
        OwnedBy: 'YAMABE',
        ManagedBy: 'CloudFormation',
        Service: 'DCV-Gateway',
      },
    });

    this.imageRecipeArn = imageRecipe.attrArn;


    // Create infrastructure configuration
    const infrastructureConfig = new imagebuilder.CfnInfrastructureConfiguration(
      this,
      'DcvGatewayInfrastructureConfig',
      {
        name: 'dcv-gateway-infrastructure-config',
        description: 'Infrastructure configuration for DCV Gateway Image Builder',
        instanceTypes: ['m6i.large'], // Use modern instance type
        subnetId: subnets[0].subnetId, // Use first subnet
        securityGroupIds: [imageBuilderSg.securityGroupId],
        terminateInstanceOnFailure: true,
        instanceProfileName: instanceProfile.instanceProfileName!,
        // Enable IMDSv2 for security
        instanceMetadataOptions: {
          httpTokens: 'required',
          httpPutResponseHopLimit: 1,
        },
        // Enable detailed monitoring
        logging: {
          s3Logs: {
            s3BucketName: logsBucket.bucketName,
            s3KeyPrefix: 'dcv-gateway-logs/',
          },
        },
        tags: {
          Project: 'EliteGen2',
          Environment: 'Production',
          OwnedBy: 'YAMABE',
          ManagedBy: 'CloudFormation',
          Service: 'DCV-Gateway',
        },
      }
    );

    // Add explicit dependency to ensure Instance Profile is created first
    infrastructureConfig.addDependency(instanceProfile);


    // Create distribution configuration
    const distributionConfig = new imagebuilder.CfnDistributionConfiguration(
      this,
      'DcvGatewayDistributionConfig',
      {
        name: 'dcv-gateway-distribution-config',
        description: 'Distribution configuration for DCV Gateway AMI',
        distributions: [
          {
            region: this.region,
            amiDistributionConfiguration: {
              name: `DCV-Gateway-AMI-{{ imagebuilder:buildDate }}`,
              description: 'NICE DCV Gateway AMI built with Image Builder',
              amiTags: {
                Project: 'EliteGen2',
                Environment: 'Production',
                OwnedBy: 'YAMABE',
                ManagedBy: 'CloudFormation',
                Service: 'DCV-Gateway',
                BuildDate: '{{ imagebuilder:buildDate }}',
              },
            },
            // "launchTemplateConfigurations": [
            //   {
            //     "launchTemplateId": "lt-0123456789abcdef0",
            //     "accountId": "123456789012",
            //     "setDefaultVersion": true
            //   }
            // ]
          },
        ],
        tags: {
          Project: 'EliteGen2',
          Environment: 'Production',
          OwnedBy: 'YAMABE',
          ManagedBy: 'CloudFormation',
          Service: 'DCV-Gateway',
        },
      }
    );


    // Create image pipeline
    const imagePipeline = new imagebuilder.CfnImagePipeline(this, 'DcvGatewayImagePipeline', {
      name: 'dcv-gateway-image-pipeline',
      description: 'Image pipeline for NICE DCV Gateway',
      imageRecipeArn: imageRecipe.attrArn,
      infrastructureConfigurationArn: infrastructureConfig.attrArn,
      distributionConfigurationArn: distributionConfig.attrArn,
      status: 'ENABLED',
      // Schedule to run weekly on Sunday at 3:00 AM UTC for security updates
      schedule: {
        scheduleExpression: 'cron(0 3 ? * SUN *)',
        pipelineExecutionStartCondition: 'EXPRESSION_MATCH_AND_DEPENDENCY_UPDATES_AVAILABLE',
      },
      // Enable enhanced image metadata
      enhancedImageMetadataEnabled: true,
      // Enable image scanning for security vulnerabilities
      imageTestsConfiguration: {
        imageTestsEnabled: true,
        timeoutMinutes: 720, // 12 hours timeout
      },
      tags: {
        Project: 'EliteGen2',
        Environment: 'Production',
        OwnedBy: 'YAMABE',
        ManagedBy: 'CloudFormation',
        Service: 'DCV-Gateway',
      },
    });

    this.pipelineArn = imagePipeline.attrArn;


    // ------------------  SSM Param ------------------ //
    // Store important values in SSM Parameter Store
    new ssm.StringParameter(this, 'DcvImageRecipeArn', {
      parameterName: '/isolated/dcv/imagebuilder/recipe/arn',
      stringValue: this.imageRecipeArn,
      description: 'ARN of the DCV Gateway Image Recipe',
    });

    new ssm.StringParameter(this, 'DcvImagePipelineArn', {
      parameterName: '/isolated/dcv/imagebuilder/pipeline/arn',
      stringValue: this.pipelineArn,
      description: 'ARN of the DCV Gateway Image Pipeline',
    });

    new ssm.StringParameter(this, 'DcvInstanceProfileName', {
      parameterName: '/isolated/dcv/imagebuilder/instance-profile/name',
      stringValue: instanceProfile.instanceProfileName!,
      description: 'Name of the DCV Gateway Image Builder Instance Profile',
    });

    new ssm.StringParameter(this, 'DcvSecurityGroupId', {
      parameterName: '/isolated/dcv/imagebuilder/security-group/id',
      stringValue: imageBuilderSg.securityGroupId,
      description: 'Security Group ID for DCV Gateway Image Builder',
    });

    new ssm.StringParameter(this, 'DcvLogsBucketName', {
      parameterName: '/isolated/dcv/imagebuilder/logs-bucket/name',
      stringValue: logsBucket.bucketName,
      description: 'S3 Bucket name for DCV Gateway Image Builder logs',
    });

    
    // ------------------  Cfn Export ------------------ //
    new cdk.CfnOutput(this, 'DcvImageRecipeArnOutput', {
      value: this.imageRecipeArn,
      description: 'ARN of the DCV Gateway Image Recipe',
      exportName: 'DcvImageRecipeArn',
    });

    new cdk.CfnOutput(this, 'DcvImagePipelineArnOutput', {
      value: this.pipelineArn,
      description: 'ARN of the DCV Gateway Image Pipeline',
      exportName: 'DcvImagePipelineArn',
    });

    new cdk.CfnOutput(this, 'DcvInstanceProfileNameOutput', {
      value: instanceProfile.instanceProfileName!,
      description: 'Name of the DCV Gateway Image Builder Instance Profile',
      exportName: 'DcvInstanceProfileName',
    });

  }
}