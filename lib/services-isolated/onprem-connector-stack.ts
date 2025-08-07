import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import * as ssm from 'aws-cdk-lib/aws-ssm';

export interface OnpremConnectorConfig {
  id: string;
  onpremTargetIp: string | string[];  // 単一IPまたは複数IPに対応
  onpremTargetPort: number;
  isolateVpcReceivePort: number;
}

export interface OnpremConnectorStackProps extends cdk.StackProps {
  connectors: OnpremConnectorConfig[];
}

/**
 * Stack for managing onpremise connections via PrivateLink
 * 
 * This stack creates NLB listeners and target groups in the Linked VPC
 * to enable connections from Isolated VPC to onpremise services.
 * 
 * Architecture:
 * [Isolated VPC] --PrivateLink--> [Linked VPC] --NLB--> [Onpremise]
 */
export class OnpremConnectorStack extends cdk.Stack {
  public readonly linkedNlb: elbv2.INetworkLoadBalancer;
  public readonly linkedVpc: ec2.IVpc;
  public readonly targetGroups: { [key: string]: elbv2.NetworkTargetGroup } = {};
  public readonly listeners: { [key: string]: elbv2.NetworkListener } = {};

  constructor(scope: Construct, id: string, props: OnpremConnectorStackProps) {
    super(scope, id, props);

    // Apply standard tags
    cdk.Tags.of(this).add('Project', 'EliteGen2');
    cdk.Tags.of(this).add('Environment', 'Production');
    cdk.Tags.of(this).add('OwnedBy', 'YAMABE');
    cdk.Tags.of(this).add('ManagedBy', 'CloudFormation');

    // Import Linked VPC and NLB from SSM parameters
    this.linkedVpc = this.importLinkedVpc();
    this.linkedNlb = this.importLinkedNlb();


    // Create connectors for each configuration
    props.connectors.forEach((connector) => {
      this.createOnpremConnector(connector);
    });
    // Store service-based connection information in SSM
    this.storeServiceBasedConnectionInfo(props.connectors);
    // Create CloudFormation outputs
    this.createOutputs(props.connectors);
  }



  /**
   * Import Linked VPC using SSM parameter
   */
  private importLinkedVpc(): ec2.IVpc {
    const linkedVpcId = ssm.StringParameter.valueForStringParameter(this, '/linked/infra/vpc/id');
    
    return ec2.Vpc.fromVpcAttributes(this, 'LinkedVpc', {
      vpcId: linkedVpcId,
      availabilityZones: cdk.Stack.of(this).availabilityZones,
    });
  }

  /**
   * Import Linked NLB using SSM parameters
   */
  private importLinkedNlb(): elbv2.INetworkLoadBalancer {
    const linkedNlbArn = ssm.StringParameter.valueForStringParameter(this, '/linked/infra/nlb/arn');
    const linkedNlbDns = ssm.StringParameter.valueForStringParameter(this, '/linked/infra/nlb/dns');
    
    return elbv2.NetworkLoadBalancer.fromNetworkLoadBalancerAttributes(this, 'LinkedNLB', {
      loadBalancerArn: linkedNlbArn,
      loadBalancerDnsName: linkedNlbDns,
      vpc: this.linkedVpc,
    });
  }



  /**
   * Create onpremise connector (target group + listener + IP target)
   */
  private createOnpremConnector(connector: OnpremConnectorConfig): void {
    // Create target group for onpremise service
    const targetGroup = new elbv2.NetworkTargetGroup(this, `${connector.id}TargetGroup`, {
      vpc: this.linkedVpc,
      port: connector.onpremTargetPort,
      protocol: elbv2.Protocol.TCP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        port: connector.onpremTargetPort.toString(),
        protocol: elbv2.Protocol.TCP,
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 2,
        timeout: cdk.Duration.seconds(6),
        interval: cdk.Duration.seconds(30),
      },
    });

    // Add onpremise IP(s) as target(s) to the target group
    const targetIps = Array.isArray(connector.onpremTargetIp)
      ? connector.onpremTargetIp
      : [connector.onpremTargetIp];
    
    targetIps.forEach((ip) => {
      targetGroup.addTarget(
        new targets.IpTarget(ip, connector.onpremTargetPort, "all")
      );
    });

    // Add listener to existing NLB
    const listener = this.linkedNlb.addListener(`${connector.id}Listener`, {
      port: connector.isolateVpcReceivePort,
      protocol: elbv2.Protocol.TCP,
      defaultTargetGroups: [targetGroup],
    });

    // Store references for later use
    this.targetGroups[connector.id] = targetGroup;
    this.listeners[connector.id] = listener;

    // Add descriptive tags
    cdk.Tags.of(targetGroup).add('ServiceName', connector.id);
    cdk.Tags.of(targetGroup).add('Purpose', 'OnpremiseConnection');
    const firstIp = Array.isArray(connector.onpremTargetIp)
      ? connector.onpremTargetIp[0]
      : connector.onpremTargetIp;
    cdk.Tags.of(targetGroup).add('OnpremiseIP', firstIp);
    
    // 複数IPの場合は個数をTag
    if (Array.isArray(connector.onpremTargetIp)) {
      cdk.Tags.of(targetGroup).add('TargetCount', connector.onpremTargetIp.length.toString());
    }
  }



  /**
   * Store service-based connection information in SSM for loose coupling
   */
  private storeServiceBasedConnectionInfo(connectors: OnpremConnectorConfig[]): void {
    const privateLinkEndpoint = ssm.StringParameter.valueForStringParameter(this, '/linked/infra/privatelink/endpoint');

    // Store individual service connection information
    connectors.forEach((connector) => {
      const serviceConnectionString = `${privateLinkEndpoint}:${connector.isolateVpcReceivePort}`;
      
      // Service endpoint for applications
      new ssm.StringParameter(this, `${connector.id}SSMEndpoint`, {
        parameterName: `/isolated/infra/privatelink/onprem-services/${connector.id}/endpoint`,
        stringValue: serviceConnectionString,
        description: `Service endpoint for ${connector.id} - use this in your applications`,
      });

      // Service port
      new ssm.StringParameter(this, `${connector.id}SSMPort`, {
        parameterName: `/isolated/infra/privatelink/onprem-services/${connector.id}/port`,
        stringValue: connector.isolateVpcReceivePort.toString(),
        description: `Service port for ${connector.id}`,
      });

      // Complete service configuration
      new ssm.StringParameter(this, `${connector.id}SSMConfig`, {
        parameterName: `/isolated/infra/privatelink/onprem-services/${connector.id}/config`,
        stringValue: JSON.stringify({
          serviceName: connector.id,
          endpoint: serviceConnectionString,
          port: connector.isolateVpcReceivePort,
          privateLinkEndpoint: privateLinkEndpoint,
          description: `Connection configuration for ${connector.id}`,
          usage: `Use this endpoint in your applications: ${serviceConnectionString}`,
        }, null, 2),
        description: `Complete configuration for ${connector.id} service`,
      });

      // Target group ARN for infrastructure management
      new ssm.StringParameter(this, `${connector.id}SSMTargetGroupArn`, {
        parameterName: `/isolated/infra/privatelink/onprem-services/${connector.id}/target-group-arn`,
        stringValue: this.targetGroups[connector.id].targetGroupArn,
        description: `Target group ARN for ${connector.id} - for infrastructure management only`,
      });
    });

    // Store list of all available services
    const serviceList = connectors.map(connector => ({
      id: connector.id,
      endpoint: `${privateLinkEndpoint}:${connector.isolateVpcReceivePort}`,
      port: connector.isolateVpcReceivePort,
    }));

    new ssm.StringParameter(this, 'OnpremServicesList', {
      parameterName: '/isolated/infra/privatelink/onprem-services/list',
      stringValue: JSON.stringify(serviceList, null, 2),
      description: 'List of all available onpremise services',
    });
  }

  /**
   * Create CloudFormation outputs
   */
  private createOutputs(connectors: OnpremConnectorConfig[]): void {
    const linkedNlbDns = ssm.StringParameter.valueForStringParameter(this, '/linked/infra/nlb/dns');
    const privateLinkEndpoint = ssm.StringParameter.valueForStringParameter(this, '/linked/infra/privatelink/endpoint');

    // General connection information
    new cdk.CfnOutput(this, 'PrivateLinkEndpoint', {
      value: privateLinkEndpoint,
      description: 'PrivateLink endpoint for service connections',
      exportName: `${this.stackName}-PrivateLinkEndpoint`,
    });

    new cdk.CfnOutput(this, 'LinkedNLBDnsName', {
      value: linkedNlbDns,
      description: 'Linked VPC NLB DNS name (for infrastructure reference)',
      exportName: `${this.stackName}-LinkedNLBDnsName`,
    });

    // Service-specific connection information
    connectors.forEach((connector) => {
      const serviceEndpoint = `${privateLinkEndpoint}:${connector.isolateVpcReceivePort}`;
      
      new cdk.CfnOutput(this, `${connector.id}ServiceEndpoint`, {
        value: serviceEndpoint,
        description: `Service endpoint for ${connector.id} - use this in your applications`,
        exportName: `${this.stackName}-${connector.id}-ServiceEndpoint`,
      });

      new cdk.CfnOutput(this, `${connector.id}SSMPath`, {
        value: `/isolated/infra/privatelink/onprem-services/${connector.id}/endpoint`,
        description: `SSM parameter path for ${connector.id} endpoint`,
        exportName: `${this.stackName}-${connector.id}-SSMPath`,
      });
    });

    // Usage instructions
    new cdk.CfnOutput(this, 'UsageInstructions', {
      value: 'Applications should use SSM parameters: /onprem-services/{service-name}/endpoint',
      description: 'How to get service endpoints in your applications',
    });
  }
}