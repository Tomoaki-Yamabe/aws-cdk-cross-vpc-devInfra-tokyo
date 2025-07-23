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
      name: 'install-dcv-connection-gateway',
      version: '1.0.3',
      platform: 'Linux',
      description: 'Install and configure NICE DCV Gateway with Web Viewer',
      data: `
name: install-dcv-gateway
description: Install and configure NICE DCV Gateway
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
            - yum install -y wget curl
      
      - name: install-dcv-gateway
        action: ExecuteBash
        inputs:
          commands:
            - echo "Installing NICE DCV Gateway..."
            - cd /tmp
            
            # Download and extract DCV packages (Web Viewer)
            - wget https://d1uj6qtbmh3dt5.cloudfront.net/nice-dcv-amzn2-x86_64.tgz
            - tar -xzf nice-dcv-amzn2-x86_64.tgz
            - mkdir -p /tmp/dcvgw/dcv-server-packages
            - mv nice-dcv-2024.0-*/ /tmp/dcvgw/dcv-server-packages/
            
            # Install DCV Web Viewer (required for Web UI)
            - yum localinstall -y /tmp/dcvgw/dcv-server-packages/nice-dcv-2024.0-*/nice-dcv-web-viewer-*.rpm
            
            # Install DCV Connection Gateway
            - wget https://d1uj6qtbmh3dt5.cloudfront.net/2024.0/Gateway/nice-dcv-connection-gateway-2024.0.848-1.el7.x86_64.rpm
            - yum install -y ./nice-dcv-connection-gateway-2024.0.848-1.el7.x86_64.rpm

      - name: configure-dcv-gateway
        action: ExecuteBash
        inputs:
          commands:
            - echo "Configuring NICE DCV Gateway..."
            
            # Create proper configuration file
            - |
              cat > /etc/dcv-connection-gateway/dcv-connection-gateway.conf << 'EOF'
              [gateway]
              web-listen-endpoints = ["0.0.0.0:8090", "0.0.0.0:8443"]
              web-port = 8090
              quic-listen-endpoints = ["0.0.0.0:8443"]
              quic-port = 8443
              
              [web-resources]
              local-resources-path = "/usr/share/dcv/www"
              
              [health-check]
              bind-addr = "0.0.0.0"
              port = 8888
              
              [dcv]
              tls-strict = false
              
              [resolver]
              url = "https://localhost:8081"
              
              [log]
              level = "info"
              directory = "/var/log/dcv-connection-gateway"
              EOF
            
            # Set proper permissions
            - chown root:root /etc/dcv-connection-gateway/dcv-connection-gateway.conf
            - chmod 644 /etc/dcv-connection-gateway/dcv-connection-gateway.conf
            
            # Enable and start the service
            - systemctl daemon-reload
            - systemctl enable dcv-connection-gateway.service
            - systemctl start dcv-connection-gateway.service
            
            - echo "DCV Gateway installation and configuration completed"
      
      - name: security-hardening
        action: ExecuteBash
        inputs:
          commands:
            - echo "Applying security hardening..."
            - # Remove unnecessary packages
            - rpm -e --nodeps wget curl
            - # Clear package cache
            - yum clean all
            - # Clear temporary files
            - rm -rf /tmp/*
            - rm -rf /var/tmp/*
            - echo "Security hardening completed"

  - name: validate
    steps:
      - name: verify-installation
        action: ExecuteBash
        inputs:
          commands:
            - echo "Verifying DCV Gateway installation..."
            - test -f /opt/nice-dcv-connection-gateway/bin/dcv-connection-gateway
            - systemctl is-enabled dcv-connection-gateway.service
            - echo "DCV Gateway verification completed successfully"

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
      name: 'dcv-gateway-recipe',
      version: '1.0.3',
      description: 'Image recipe for NICE DCV Gateway with Web Viewer',
      components: [
        {
          componentArn: dcvInstallComponent.attrArn,
        },
      ],
      parentImage: `arn:aws:imagebuilder:${this.region}:aws:image/amazon-linux-2-x86/x.x.x`,
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