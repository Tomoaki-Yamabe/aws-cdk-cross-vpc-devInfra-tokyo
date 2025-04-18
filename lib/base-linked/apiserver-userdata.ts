export const configServerUserData = `#!/bin/bash
# Install Python3 & pip
yum update -y
yum install -y python3 git

# Install FastAPI, uvicorn and boto3
pip3 install fastapi "uvicorn[standard]" boto3

# Create application source in /root
cat <<'EOF' > /root/config_server.py
from fastapi import FastAPI
from fastapi.responses import HTMLResponse, JSONResponse
import boto3
import json
import uvicorn

app = FastAPI()
ssm = boto3.client('ssm', region_name='us-west-2')

def list_service_configs():
    paginator = ssm.get_paginator('describe_parameters')
    parameters = []

    for page in paginator.paginate(ParameterFilters=[
        {
            'Key': 'Name',
            'Option': 'BeginsWith',
            'Values': ['/services/']
        }
    ]):
        for param in page['Parameters']:
            parameters.append(param['Name'])

    service_data = []
    for name in parameters:
        try:
            response = ssm.get_parameter(Name=name)
            config = json.loads(response['Parameter']['Value'])
            service_data.append(config)
        except Exception as e:
            service_data.append({
                "serviceName": name.split('/')[-2],
                "nlbDnsName": "N/A",
                "listenerPort": "N/A",
                "error": str(e)
            })

    return service_data

@app.get("/", response_class=HTMLResponse)
def root():
    service_data = list_service_configs()

    html = """
    <html>
        <head><title>Microservice Gateway</title></head>
        <body>
            <h1>Microservice Gateway</h1>
            <p>This is FastAPI service gateway</p>
            <p><a href="/docs">📘 Swagger UI</a></p>
            <table border="1">
                <tr>
                    <th>Service Name</th>
                    <th>DNS</th>
                    <th>Port</th>
                    <th>API</th>
                </tr>
    """

    for s in service_data:
        html += f"""
                <tr>
                    <td>{s.get("serviceName", "N/A")}</td>
                    <td>{s.get("nlbDnsName", "N/A")}</td>
                    <td>{s.get("listenerPort", "N/A")}</td>
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

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8080)
EOF

# Navigate to application directory
cd /root

# Start FastAPI using Python (no need for uvicorn command directly)
nohup python3 /root/config_server.py > /root/config_server.log 2>&1 &
`;
