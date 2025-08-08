#!/usr/bin/env python3
"""
AWS DCV Connection Gateway Session Resolver
公式仕様準拠版
"""

from flask import Flask, request
import json
import logging

# ログ設定
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('session_resolver.log'),
        logging.StreamHandler()
    ]
)

app = Flask(__name__)

# DCV セッション定義（公式仕様準拠）
dcv_sessions = {
    "console": {
        "SessionId": "console",
        "Host": "10.150.248.180",  # Agent1
        "HttpPort": 8443,
        "QuicPort": 8443,
        "WebUrlPath": "/"
    },
    "desktop": {
        "SessionId": "desktop", 
        "Host": "10.150.248.136",  # Agent2
        "HttpPort": 8443,
        "QuicPort": 8443,
        "WebUrlPath": "/"
    }
}

@app.route('/resolveSession', methods=['POST'])
def resolve_session():
    session_id = request.args.get('sessionId')
    transport = request.args.get('transport')
    client_ip_address = request.args.get('clientIpAddress', 'unknown')

    logging.info(f"Session Resolver Request: sessionId={session_id}, transport={transport}, clientIP={client_ip_address}")

    if session_id is None:
        logging.error("Missing sessionId parameter")
        return "Missing sessionId parameter", 400

    if transport != "HTTP" and transport != "QUIC":
        logging.error(f"Invalid transport parameter: {transport}")
        return "Invalid transport parameter: " + transport, 400

    dcv_session = dcv_sessions.get(session_id)
    if dcv_session is None:
        logging.warning(f"Session not found: {session_id}")
        return "Session id not found", 404

    # 公式仕様に準拠したレスポンス
    response = {
        "SessionId": dcv_session['SessionId'],
        "TransportProtocol": transport,
        "DcvServerEndpoint": dcv_session['Host'],  # 公式仕様: DcvServerEndpoint
        "Port": dcv_session["HttpPort"] if transport == "HTTP" else dcv_session['QuicPort'],  # 公式仕様: Port
        "WebUrlPath": dcv_session['WebUrlPath']
    }
    
    logging.info(f"Session Resolver Response: {response}")
    return json.dumps(response)

@app.route('/health', methods=['GET'])
def health_check():
    return "OK", 200

if __name__ == '__main__':
    logging.info("Starting Session Resolver on port 9000...")
    app.run(port=9000, host='0.0.0.0', debug=False)