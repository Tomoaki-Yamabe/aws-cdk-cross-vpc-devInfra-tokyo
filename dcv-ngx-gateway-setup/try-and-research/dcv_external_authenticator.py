#!/usr/bin/env python3
"""
DCV External Authenticator
導通確認最優先・セキュリティ度外視版

DCV Connection Gateway用のExternal Authentication実装
AWS公式ドキュメントの仕様に準拠
"""

from flask import Flask, request
import logging
from datetime import datetime

# ログ設定
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

app = Flask(__name__)

# 認証トークンとユーザーのマッピング（セキュリティ度外視）
valid_tokens = {
    "test123": "dcv",
    "console123": "ubuntu", 
    "demo456": "testuser"
}

@app.route('/', methods=['POST'])
def authenticate():
    """
    DCV ServerからのExternal Authentication要求を処理
    
    リクエスト形式:
    POST / HTTP/1.1
    Content-Type: application/x-www-form-urlencoded
    sessionId=session_id&authenticationToken=token&clientAddress=client_address
    
    レスポンス形式:
    成功: <auth result="yes"><username>username</username></auth>
    失敗: <auth result="no"><message>message</message></auth>
    """
    
    # リクエストデータ取得
    session_id = request.form.get('sessionId')
    auth_token = request.form.get('authenticationToken')
    client_address = request.form.get('clientAddress')
    
    # ログ出力
    logger.info(f"External Auth Request: sessionId={session_id}, token={auth_token}, clientAddress={client_address}")
    
    # バリデーション
    if not auth_token:
        logger.error("Missing authenticationToken")
        return '<auth result="no"><message>Missing authentication token</message></auth>', 400
    
    if not session_id:
        logger.error("Missing sessionId")
        return '<auth result="no"><message>Missing session ID</message></auth>', 400
    
    # トークン認証
    username = valid_tokens.get(auth_token)
    if username:
        logger.info(f"Authentication successful: token={auth_token}, user={username}")
        return f'<auth result="yes"><username>{username}</username></auth>'
    else:
        logger.warning(f"Authentication failed: invalid token={auth_token}")
        return '<auth result="no"><message>Invalid authentication token</message></auth>'

@app.route('/health', methods=['GET'])
def health_check():
    """ヘルスチェックエンドポイント"""
    return {
        "status": "healthy",
        "timestamp": datetime.now().isoformat(),
        "service": "DCV External Authenticator",
        "valid_tokens": list(valid_tokens.keys())
    }

@app.route('/tokens', methods=['GET'])
def list_tokens():
    """利用可能なトークン一覧（デバッグ用）"""
    return {
        "tokens": valid_tokens,
        "count": len(valid_tokens)
    }

if __name__ == '__main__':
    logger.info("Starting DCV External Authenticator")
    logger.info(f"Valid tokens: {list(valid_tokens.keys())}")
    logger.info("Security features disabled for connectivity testing")
    
    # セキュリティ度外視でHTTP起動
    app.run(
        port=8444, 
        host='0.0.0.0', 
        debug=True,
        threaded=True
    )