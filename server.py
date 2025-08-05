 cat /opt/session_resolver.py
#!/usr/bin/env python3
import http.server, socketserver, urllib.parse, json

DCV_ENDPOINT = "10.150.248.152"     # ← DCV Server
DCV_PORT     = 8443
WEB_URL_PATH = "/"                  # ← DCV server の connectivity.web-url-path と揃える

def build(session_id: str, transport: str) -> bytes:
    return json.dumps({
        "SessionId":          session_id,
        "TransportProtocol":  transport,     # "HTTP" か "QUIC"
        "DcvServerEndpoint":  DCV_ENDPOINT,
        "Port":               DCV_PORT,
        "WebUrlPath":         WEB_URL_PATH
    }).encode()

class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        if not self.path.startswith("/resolveSession"):
            return self.send_error(404)
        qs     = urllib.parse.urlparse(self.path).query
        params = urllib.parse.parse_qs(qs)
        sid    = params.get("sessionId", ["console-session"])[0]
        trans  = params.get("transport",  ["HTTP"])[0]
        self._ok(build(sid, trans))

    # GET は疎通テスト用
    def do_GET(self):
        self._ok(build("console-session", "HTTP"))

    def _ok(self, payload: bytes):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *_):  # 静かに
        pass

if __name__ == "__main__":
    PORT = 8447
    with socketserver.TCPServer(("", PORT), Handler) as srv:
        print(f"Session‑Resolver started on :{PORT}")
        srv.serve_forever()

[ssm-user@ip-10-150-248-174 bin]$ cat /etc/dcv-connection-gateway/dcv-connection-gateway.conf
[gateway]
# HTTP（Web UI 配信用）
web-port = 8090
web-listen-endpoints = ["0.0.0.0:8090"]

# QUIC/TLS 接続用
quic-listen-endpoints = ["0.0.0.0:8443"]
quic-port = 8443

[resolver]
tls-strict = false
url = "http://localhost:8447"

[web-resources]
# url = "https://dcv-web-client-private-481393820746-ap-northeast-1.s3.ap-northeast-1.amazonaws.com/client/"
local-resources-path = "/usr/share/dcv/www"

[log]
level = "debug"
directory = "/var/log/dcv-connection-gateway"


[dcv]
tls-strict = false