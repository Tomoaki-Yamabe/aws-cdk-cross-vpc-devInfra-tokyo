# DCV Gateway Update Summary - Amazon Linux 2023 + Session Manager Broker Migration

## Overview
This document summarizes the comprehensive updates made to the DCV Gateway infrastructure, including migration to Amazon Linux 2023 and integration with Session Manager Broker for improved session management.

## Major Architecture Changes

### 1. Migration to Amazon Linux 2023
- **Previous**: Amazon Linux 2 with custom ImageBuilder AMI
- **Current**: Amazon Linux 2023 with direct UserData configuration
- **Benefits**: Better security, performance, and long-term support

### 2. Session Manager Broker Integration
- **Previous**: Custom Flask Session Resolver
- **Current**: NICE DCV Session Manager Broker with built-in authentication server
- **Benefits**: Official AWS solution, better scalability, integrated authentication

### 3. Simplified Architecture
- **Previous**: Separate S3 bucket for web resources, complex custom resolver
- **Current**: Local web resources, integrated broker solution
- **Benefits**: Reduced complexity, better reliability, easier maintenance

## Updated CDK Stack Configuration

### DCV Gateway Stack (`lib/dcv-gateway-isolated/dcv-gateway-stack.ts`)

#### Key Changes:
1. **AMI Selection**:
   ```typescript
   // OLD: Custom ImageBuilder AMI lookup
   const dcvGatewayAmi = new ec2.LookupMachineImage({...});
   
   // NEW: Direct Amazon Linux 2023
   const dcvGatewayAmi = ec2.MachineImage.latestAmazonLinux2023({
     cpuType: ec2.AmazonLinuxCpuType.X86_64,
     userData: ec2.UserData.forLinux()
   });
   ```

2. **Removed S3 Dependencies**:
   - Eliminated `webResourcesBucket` creation
   - Removed S3 bucket policies and VPC endpoint configurations
   - Simplified IAM permissions

3. **Updated Security Groups**:
   ```typescript
   // Added broker internal ports
   dcvGatewaySg.addIngressRule(
     ec2.Peer.ipv4(vpc.vpcCidrBlock),
     ec2.Port.tcpRange(8445, 8448),
     'Broker internal'
   );
   ```

4. **New UserData Configuration**:
   ```bash
   # DCV Repository setup for Amazon Linux 2023
   cat >/etc/yum.repos.d/nice-dcv.repo <<EOF
   [dcv]
   name=NICE DCV packages
   baseurl=https://d1uj6qtbmh3dt5.cloudfront.net/2024.0/rhel/9/x86_64/
   gpgcheck=0
   enabled=1
   EOF
   
   # Install both broker and gateway
   yum -y install nice-dcv-session-manager-broker nice-dcv-connection-gateway
   ```

### ImageBuilder Stack (`lib/dcv-gateway-isolated/dcv-imagebuilder-stack.ts`)

#### Key Changes:
1. **Base Image Update**:
   ```typescript
   // OLD: Amazon Linux 2
   parentImage: `arn:aws:imagebuilder:${this.region}:aws:image/amazon-linux-2-x86/x.x.x`
   
   // NEW: Amazon Linux 2023
   parentImage: `arn:aws:imagebuilder:${this.region}:aws:image/amazon-linux-2023-x86/x.x.x`
   ```

2. **Component Updates**:
   - Updated component name to `install-dcv-gateway-broker`
   - Version bumped to `1.0.4`
   - Added Session Manager Broker installation and configuration

## New Service Configuration

### Session Manager Broker Configuration
```properties
# /etc/dcv-session-manager-broker/session-manager-broker.properties
enable-gateway              = true
enable-authorization-server = true
enable-authorization        = true

# Port configuration
client-to-broker-connector-https-port  = 8448
gateway-to-broker-connector-https-port = 8447
agent-to-broker-connector-https-port   = 8445

# Single-node cluster configuration
broker-to-broker-connection-login = dcvsm-user
broker-to-broker-connection-pass  = dcvsm-pass
broker-to-broker-discovery-addresses = 127.0.0.1:47500
```

### Connection Gateway Configuration
```toml
# /etc/dcv-connection-gateway/dcv-connection-gateway.conf
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
```

## Migration Benefits

### 1. **Improved Reliability**
- Official AWS Session Manager Broker instead of custom resolver
- Better error handling and session management
- Integrated authentication and authorization

### 2. **Enhanced Security**
- Amazon Linux 2023 with latest security patches
- Proper SSL certificate management
- Integrated authentication server

### 3. **Simplified Maintenance**
- Reduced custom code (eliminated Flask resolver)
- Standard AWS configuration patterns
- Better logging and monitoring integration

### 4. **Better Scalability**
- Session Manager Broker supports clustering
- Built-in load balancing capabilities
- Agent-based session management

## Deployment Process

### 1. **ImageBuilder Pipeline**
```bash
# Trigger new AMI build with updated components
aws imagebuilder start-image-pipeline-execution \
  --image-pipeline-arn <pipeline-arn>
```

### 2. **Auto Scaling Group Update**
- New launch template with Amazon Linux 2023
- Updated UserData with broker configuration
- Increased grace periods for broker startup

### 3. **Verification Steps**
1. Verify broker service: `systemctl status dcv-session-manager-broker`
2. Verify gateway service: `systemctl status dcv-connection-gateway`
3. Check port bindings: `ss -tlnp | grep -E ":(8443|8445|8446|8447|8448)"`
4. Test endpoint: `https://<nlb-dns>:8443`

## Monitoring and Logging

### CloudWatch Integration
- Enhanced logging for both broker and gateway services
- Separate log groups for better troubleshooting
- Metrics collection for performance monitoring

### Log Locations
- Broker logs: `/var/log/dcv-session-manager-broker/`
- Gateway logs: `/var/log/dcv-connection-gateway/`
- CloudWatch log groups: `/aws/ec2/dcv-session-manager-broker` and `/aws/ec2/dcv-connection-gateway`

## Previous Working Configuration (Reference)

### Flask Session Resolver (Deprecated)
The previous working configuration used a custom Flask application:
- **Location**: `/tmp/session_resolver_fixed.py` on DCV Gateway instance (i-054521c929bdedb53)
- **Endpoint**: `http://localhost:8447/resolveSession` (POST)
- **Response Format**: AWS DCV Gateway compliant JSON with WebUrlPath
- **Target**: DCV Server at 10.150.248.152:8443

### Legacy Gateway Configuration
```toml
[gateway]
web-port = 8090
web-listen-endpoints = ["0.0.0.0:8090"]
quic-listen-endpoints = ["0.0.0.0:8443"]
quic-port = 8443

[resolver]
url = "http://localhost:8447"

[web-resources]
local-resources-path = "/usr/share/dcv/www"
```

## Rollback Plan

If issues occur with the new configuration:
1. Revert to previous AMI version in launch template
2. Update Auto Scaling Group to use old launch template
3. Restore custom Flask Session Resolver if needed
4. Revert security group rules to previous configuration

## Future Enhancements

1. **Agent Integration**: Configure DCV Server instances to register with Session Manager Broker
2. **Load Balancing**: Implement multi-node broker cluster for high availability
3. **Authentication**: Integrate with external identity providers
4. **Monitoring**: Enhanced metrics and alerting for session management
5. **Automation**: Automated agent registration and session lifecycle management

## Technical Notes

- Session Manager Broker provides REST API for session management
- Built-in web interface available at broker HTTPS port
- Supports both HTTP and QUIC transport protocols
- Compatible with existing DCV Server installations
- Requires proper certificate management for HTTPS endpoints
- Self-signed certificates are automatically generated for testing

## Migration Timeline

- **Phase 1**: CDK stack updates (Completed)
- **Phase 2**: ImageBuilder component updates (Completed)
- **Phase 3**: Testing and validation (Pending)
- **Phase 4**: Production deployment (Pending)

---

**Last Updated**: 2025年7月30日 04:45 UTC

**Migration Status**: CDK Configuration Updated - Ready for Testing

**Next Steps**: Deploy updated infrastructure and validate Session Manager Broker functionality