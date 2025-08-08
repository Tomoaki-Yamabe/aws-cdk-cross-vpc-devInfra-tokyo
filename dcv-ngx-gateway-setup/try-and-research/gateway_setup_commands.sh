#!/bin/bash
# Gatewayサーバー（10.213.66.188）で実行するコマンド

echo "=== Gateway Server Setup Commands ==="
echo "SSH接続: ssh -i \"tom.pem\" ec2-user@10.213.66.188 -p 50000"
echo ""
echo "Gatewayサーバーで以下のコマンドを実行してください："
echo ""

echo "1. 現在のDCV Serverプロセス確認:"
echo "sudo ss -tlnp | grep 8443"
echo "ps aux | grep dcv"
echo ""

echo "2. DCV Serverを停止（8443ポートを解放）:"
echo "sudo pkill -f dcvserver"
echo ""

echo "3. Session Resolverファイルを作成:"
cat << 'EOF'
cat > session_resolver.py << 'RESOLVER_EOF'
from flask import Flask, request
import json

app = Flask(__name__)

dcv_sessions = {
    "console": {
        "SessionId": "console",
        "Host": "10.213.66.188",
        "HttpPort": 50001,
        "QuicPort": 50001,
        "WebUrlPath": "/"
    },
    "desktop": {
        "SessionId": "desktop",
        "Host": "10.213.66.188",
        "HttpPort": 60000,
        "QuicPort": 60000,
        "WebUrlPath": "/"
    },
    "agent1": {
        "SessionId": "agent1",
        "Host": "10.213.66.188",
        "HttpPort": 50001,
        "QuicPort": 50001,
        "WebUrlPath": "/"
    },
    "agent2": {
        "SessionId": "agent2",
        "Host": "10.213.66.188",
        "HttpPort": 60000,
        "QuicPort": 60000,
        "WebUrlPath": "/"
    }
}

@app.route('/resolveSession', methods=['POST'])
def resolve_session():
    session_id = request.args.get('sessionId')
    transport = request.args.get('transport')
    client_ip_address = request.args.get('clientIpAddress')

    if session_id is None:
        return "Missing sessionId parameter", 400

    if transport != "HTTP" and transport != "QUIC":
        return "Invalid transport parameter: " + transport, 400

    print("Requested sessionId: " + session_id + ", transport: " + transport + ", clientIpAddress: " + str(client_ip_address))
    dcv_session = dcv_sessions.get(session_id)
    if dcv_session is None:
        return "Session id not found", 404

    response = {
        "SessionId": dcv_session['SessionId'],
        "TransportProtocol": transport,
        "DcvServerEndpoint": dcv_session['Host'],
        "Port": dcv_session["HttpPort"] if transport == "HTTP" else dcv_session['QuicPort'],
        "WebUrlPath": dcv_session['WebUrlPath']
    }
    return json.dumps(response)

if __name__ == '__main__':
    app.run(port=9000, host='0.0.0.0')
RESOLVER_EOF
EOF

echo ""
echo "4. Session Resolverを起動:"
echo "nohup python3 session_resolver.py > session_resolver.log 2>&1 &"
echo ""

echo "5. DCV Connection Gateway設定ファイル作成:"
cat << 'EOF'
sudo mkdir -p /etc/dcv-connection-gateway
sudo tee /etc/dcv-connection-gateway/dcv-connection-gateway.conf << 'GATEWAY_EOF'
[gateway]
web-listen-endpoints = ["0.0.0.0:8443"]
quic-listen-endpoints = ["0.0.0.0:8443"]
cert-file = "/etc/dcv-connection-gateway/certs/dcv.crt"
cert-key-file = "/etc/dcv-connection-gateway/certs/dcv.key"

[resolver]
url = "http://localhost:9000"

[web-resources]
local-resources-path = "/usr/share/dcv/www"

[dcv]
tls-strict = false

[log]
level = "debug"
directory = "/var/log/dcv-connection-gateway"
GATEWAY_EOF
EOF

echo ""
echo "6. DCV Connection Gatewayを起動:"
echo "sudo dcv-connection-gateway --config /etc/dcv-connection-gateway/dcv-connection-gateway.conf"
echo ""

echo "7. 接続テスト用URL:"
echo "Agent1経由: https://10.213.66.188:8443/?authToken=test123&sessionId=console"
echo "Agent2経由: https://10.213.66.188:8443/?authToken=test123&sessionId=desktop"