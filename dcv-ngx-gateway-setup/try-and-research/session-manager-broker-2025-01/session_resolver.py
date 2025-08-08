from flask import Flask, request
import json

app = Flask(__name__)

# Agent1: 10.213.66.188:50001, Agent2: 10.213.66.188:60000
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