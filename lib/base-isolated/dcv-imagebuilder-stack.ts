import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as imagebuilder from 'aws-cdk-lib/aws-imagebuilder';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ssm from 'aws-cdk-lib/aws-ssm';

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

    // Create IAM role for Image Builder instance
    const instanceRole = new iam.Role(this, 'DcvImageBuilderInstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'IAM role for DCV Gateway Image Builder instance',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('EC2InstanceProfileForImageBuilder'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

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


  }
}