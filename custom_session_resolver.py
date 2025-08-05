#!/usr/bin/env python3
"""
カスタムSession Resolver for AWS DCV Connection Gateway
導通確認最優先・セキュリティ度外視版

Agent2への直接接続を実現するためのシンプルなSession Resolver実装
AWS公式ドキュメントのPython実装例をベースに作成
"""

from flask import Flask, request
import json
import logging
from datetime import datetime

# ログ設定
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

app = Flask(__name__)

# Agent2の情報を静的に定義（セキュリティ度外視）
dcv_sessions = {
    "console": {
        "SessionId": "console",
        "Host": "10.150.248.136",  # Agent2の内部IP
        "HttpPort": 8443,
        "QuicPort": 8443,
        "WebUrlPath": "/"
    }
}

@app.route('/resolveSession', methods=['POST'])
def resolve_session():
    """
    DCV Connection Gatewayからのセッション解決リクエストを処理
    
    リクエスト形式:
    POST /resolveSession?sessionId=session_id&transport=transport&clientIpAddress=clientIpAddress
    
    レスポンス形式:
    {
        "SessionId": session_id,
        "TransportProtocol": transport_protocol,
        "DcvServerEndpoint": dns_name,
        "Port": port,
        "WebUrlPath": web_url_path
    }
    """
    # リクエストパラメータ取得
    session_id = request.args.get('sessionId')
    transport = request.args.get('transport', 'HTTP')
    client_ip = request.args.get('clientIpAddress', 'unknown')
    
    # ログ出力
    logger.info(f"Session Resolver Request: sessionId={session_id}, transport={transport}, clientIP={client_ip}")
    
    # バリデーション
    if session_id is None:
        logger.error("Missing sessionId parameter")
        return "Missing sessionId parameter", 400
    
    if transport not in ["HTTP", "QUIC"]:
        logger.error(f"Invalid transport parameter: {transport}")
        return f"Invalid transport parameter: {transport}", 400
    
    # セッション検索
    dcv_session = dcv_sessions.get(session_id)
    if dcv_session is None:
        logger.warning(f"Session not found: {session_id}")
        return "Session id not found", 404
    
    # レスポンス構築
    response = {
        "SessionId": dcv_session['SessionId'],
        "TransportProtocol": transport,
        "DcvServerEndpoint": dcv_session['Host'],
        "Port": dcv_session["HttpPort"] if transport == "HTTP" else dcv_session['QuicPort'],
        "WebUrlPath": dcv_session['WebUrlPath']
    }
    
    logger.info(f"Session Resolver Response: {response}")
    return json.dumps(response)

@app.route('/health', methods=['GET'])
def health_check():
    """ヘルスチェックエンドポイント"""
    return {
        "status": "healthy",
        "timestamp": datetime.now().isoformat(),
        "available_sessions": list(dcv_sessions.keys())
    }

@app.route('/sessions', methods=['GET'])
def list_sessions():
    """利用可能なセッション一覧（デバッグ用）"""
    return {
        "sessions": dcv_sessions,
        "count": len(dcv_sessions)
    }

if __name__ == '__main__':
    logger.info("Starting Custom Session Resolver for DCV Connection Gateway")
    logger.info(f"Available sessions: {list(dcv_sessions.keys())}")
    logger.info("Security features disabled for connectivity testing")
    
    # セキュリティ度外視でHTTP起動
    app.run(
        port=9000, 
        host='0.0.0.0', 
        debug=True,
        threaded=True
    )