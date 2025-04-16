// lib/services/linked-vpc/config-server-userdata.ts
export const configServerUserData = `#!/bin/bash
yum update -y
yum install -y python3 git
pip3 install --user fastapi "uvicorn[standard]" boto3
setcap 'cap_net_bind_service=+ep' /home/ec2-user/.local/bin/uvicorn

cat <<'EOF' > /home/ec2-user/config_server.py

from fastapi import FastAPI
from fastapi.responses import HTMLResponse, JSONResponse
import boto3
import json

app = FastAPI()
ssm = boto3.client('ssm', region_name='us-west-2')

SERVICE_NAMES = [
    "xils-backend-service",
    "xils-backend-service",
    "xils-backend-service",
]

@app.get("/", response_class=HTMLResponse)
def root():
    service_data = []
    for service in SERVICE_NAMES:
        try:
            response = ssm.get_parameter(Name=f"/services/{service}/config")
            config = json.loads(response['Parameter']['Value'])
            service_data.append(config)
        except Exception as e:
            service_data.append({
                "serviceName": service,
                "error": str(e)
            })

    html = """
    <html>
        <head><title>Microservice Gateway</title></head>
        <body>
            <h1>Microservice Gateway</h1>
            <p>This is FastAPI service gateway</p>
            <p><a href="/docs">📘 Swagger UIdocuments</a></p>
        </body>
        <head>
            <title>Service Catalog</title>
            <style>
                body { font-family: Arial, sans-serif; margin: 40px; }
                table { border-collapse: collapse; width: 100%; }
                th, td { border: 1px solid #ddd; padding: 8px; }
                th { background-color: #f2f2f2; }
                a { text-decoration: none; color: blue; }
            </style>
        </head>
        <body>
            <h2>Available Microservices</h2>
            <table>
                <tr>
                    <th>Service Name</th>
                    <th>DNS</th>
                    <th>Connection Port</th>
                    <th>Appli Port</th>
                    <th>API</th>
                </tr>
    """

    for s in service_data:
        html += f"""
            <tr>
                <td>{s.get("serviceName", "N/A")}</td>
                <td>{s.get("nlbDnsName", "N/A")}</td>
                <td>{s.get("listenerPort", "N/A")}</td>
                <td>{s.get("targetPort", "N/A")}</td>
                <td><a href="/api/{s.get("serviceName", "")}" target="_blank">/api/{s.get("serviceName", "")}</a></td>
            </tr>
        """

    html += """
            </table>
        </body>
    </html>
    """
    return HTMLResponse(content=html)

@app.get("/api/{service_name}", response_class=JSONResponse)
def get_service_config(service_name: str):
    try:
        response = ssm.get_parameter(Name=f"/services/{service_name}/config")
        return json.loads(response['Parameter']['Value'])
    except Exception as e:
        return {"error": str(e)}
    """
    return HTMLResponse(content=html)

@app.get("/api/{service_name}", response_class=JSONResponse)
def get_service_config(service_name: str):
    try:
        response = ssm.get_parameter(Name=f"/services/{service_name}/config")
        return json.loads(response['Parameter']['Value'])
    except Exception as e:
        return {"error": str(e)}
EOF

# Run server without sudo
nohup /home/ec2-user/.local/bin/uvicorn config_server:app --host 0.0.0.0 --port 80 > /home/ec2-user/config_server.log 2>&1 &
`;
