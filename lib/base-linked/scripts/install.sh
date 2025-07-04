#!/bin/bash -xe

# Start debug log
exec > >(tee /var/log/install.log|logger -t install -s 2>/dev/console) 2>&1
echo "=== Install script execution started at $(date) ==="

# install CloudFormation helper scripts
yum update -y
yum install -y aws-cfn-bootstrap python3 git

# get information from meta-data (is this best setting?)
echo "Getting instance metadata..."
INSTANCE_ID=$(curl -s --max-time 10 http://169.254.169.254/latest/meta-data/instance-id || echo "unknown")
REGION=${AWS_DEFAULT_REGION:-$(curl -s --max-time 10 http://169.254.169.254/latest/meta-data/placement/region || echo "ap-northeast-1")}

echo "Instance ID: $INSTANCE_ID"
echo "Region: $REGION"
echo "Stack Name: $STACK_NAME"



# Install python
echo "Installing Python packages..."
pip3 install fastapi "uvicorn[standard]" boto3 httpx

# create systemd from aws hp
echo "Creating systemd service..."
cat <<'EOF' > /etc/systemd/system/gateway-api.service
[Unit]
Description=Gateway API Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/root
ExecStart=/usr/bin/python3 /root/config_server.py
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

# activate systemd
echo "Enabling gateway-api service..."
systemctl daemon-reload
systemctl enable gateway-api

echo "=== Install script execution completed at $(date) ==="