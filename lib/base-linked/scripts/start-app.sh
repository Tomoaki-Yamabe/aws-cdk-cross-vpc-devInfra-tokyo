#!/bin/bash -xe

# start debug log
exec > >(tee /var/log/start-app.log|logger -t start-app -s 2>/dev/console) 2>&1
echo "=== Application start script execution started at $(date) ==="

# confirm to exist config_server.py
if [ ! -f /root/config_server.py ]; then
    echo "ERROR: /root/config_server.py not found!"
    exit 1
fi

# start systemd 
echo "Starting gateway-api service..."
systemctl start gateway-api

# confirm systemd service
echo "Checking service status..."
systemctl status gateway-api --no-pager || echo "Service status check failed"

# confirm start python application
echo "Waiting for application to start..."
APP_STATUS=1
for i in {1..30}; do
    if curl -s http://localhost:8080/ > /dev/null; then
        echo "Application is responding on port 8080"
        APP_STATUS=0
        break
    else
        echo "Waiting for application... ($i/30)"
        sleep 1
    fi
done

# setting FINAL EXIST CODE
if [ $APP_STATUS -eq 0 ]; then
    echo "Application startup completed successfully"
    FINAL_EXIT_CODE=0
else
    echo "Application startup failed"
    FINAL_EXIT_CODE=1
fi

# send SIGNAL to CloudFormation
if [ -n "$STACK_NAME" ] && [ -n "$AWS_DEFAULT_REGION" ]; then
    echo "Sending CloudFormation signal..."
    /opt/aws/bin/cfn-signal -e $FINAL_EXIT_CODE --stack "$STACK_NAME" --resource GatewayASG4347CA7D --region "$AWS_DEFAULT_REGION"
else
    echo "WARNING: STACK_NAME or AWS_DEFAULT_REGION not set, skipping cfn-signal"
fi

echo "=== Application start script execution completed at $(date) with exit code: $FINAL_EXIT_CODE ==="
exit $FINAL_EXIT_CODE