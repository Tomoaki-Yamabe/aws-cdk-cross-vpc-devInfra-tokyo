#!/usr/bin/env python3
"""
Simple DCV Gateway - 最小構成
Session Resolverと連携してAgent1/Agent2にプロキシする
"""

from http.server import HTTPServer, BaseHTTPRequestHandler
import ssl
import requests
import urllib.parse
import json
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class DCVGatewayHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.handle_request()
    
    def do_POST(self):
        self.handle_request()
    
    def handle_request(self):
        try:
            # URLパラメータ解析
            parsed_url = urllib.parse.urlparse(self.path)
            query_params = urllib.parse.parse_qs(parsed_url.query)
            
            session_id = query_params.get('sessionId', ['console'])[0]
            auth_token = query_params.get('authToken', [None])[0]
            
            logger.info(f"Request: {self.command} {self.path}")
            logger.info(f"SessionID: {session_id}, AuthToken: {auth_token}")
            
            # Session Resolverに問い合わせ
            resolver_url = "http://localhost:9000/resolveSession"
            resolver_params = {
                'sessionId': session_id,
                'transport': 'HTTP',
                'clientIpAddress': self.client_address[0]
            }
            
            response = requests.post(resolver_url, params=resolver_params, timeout=10)
            
            if response.status_code != 200:
                self.send_error(404, "Session not found")
                return
            
            session_info = response.json()
            target_host = session_info['DcvServerEndpoint']
            target_port = session_info['Port']
            
            logger.info(f"Routing to: {target_host}:{target_port}")
            
            # Agentに直接リダイレクト
            redirect_url = f"https://{target_host}:{target_port}{self.path}"
            
            self.send_response(302)
            self.send_header('Location', redirect_url)
            self.end_headers()
            
            logger.info(f"Redirected to: {redirect_url}")
            
        except Exception as e:
            logger.error(f"Error: {e}")
            self.send_error(500, str(e))

def main():
    # 自己署名証明書作成
    import subprocess
    try:
        subprocess.run([
            'openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-keyout', 'gateway.key',
            '-out', 'gateway.crt', '-days', '1', '-nodes', '-subj', '/CN=gateway'
        ], check=True, capture_output=True)
    except:
        pass
    
    # HTTPSサーバー起動
    server = HTTPServer(('0.0.0.0', 8445), DCVGatewayHandler)
    
    try:
        context = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
        context.load_cert_chain('gateway.crt', 'gateway.key')
        server.socket = context.wrap_socket(server.socket, server_side=True)
    except:
        logger.warning("SSL setup failed, running HTTP only")
    
    logger.info("Simple DCV Gateway starting on port 8445")
    logger.info("Session Resolver: http://localhost:9000")
    
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logger.info("Gateway stopped")

if __name__ == '__main__':
    main()