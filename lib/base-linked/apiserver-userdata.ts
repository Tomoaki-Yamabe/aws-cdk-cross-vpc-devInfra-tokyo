export const configServerUserData = `#!/bin/bash
# Install Python3 & pip
yum update -y
yum install -y python3 git

# Install FastAPI, uvicorn, boto3 and httpx
pip3 install fastapi "uvicorn[standard]" boto3 httpx

# Create application source in /root
cat <<'EOF' > /root/config_server.py
from fastapi import FastAPI, Request, Response
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.openapi.docs import get_swagger_ui_html
import boto3, httpx, json

app = FastAPI(title="Gateway API", docs_url=None, redoc_url=None)
ssm = boto3.client('ssm', region_name='us-west-2')

def list_service_configs():
    paginator = ssm.get_paginator('describe_parameters')
    parameters = []
    for page in paginator.paginate(ParameterFilters=[
        {'Key':'Name','Option':'BeginsWith','Values':['/services/']}
    ]):
        parameters += [p['Name'] for p in page['Parameters']]
    svc_data = []
    for name in parameters:
        try:
            resp = ssm.get_parameter(Name=name)
            cfg = json.loads(resp['Parameter']['Value'])
        except Exception as e:
            cfg = {"serviceName": name.split('/')[-2], "nlbDnsName":"N/A","listenerPort":"N/A","error":str(e)}
        svc_data.append(cfg)
    return svc_data

@app.get("/", response_class=HTMLResponse)
async def root():
    services = list_service_configs()
    html = "<html><head><title>Gateway</title></head><body>"
    html += "<h1>Available Services</h1><ul>"
    for s in services:
        name = s.get("serviceName")
        html += f'<li>{name} — <a href="/docs/{name}">Swagger UI</a></li>'
    html += "</ul></body></html>"
    return HTMLResponse(html)

@app.api_route("/api/{service_name}/{path:path}", methods=["GET","POST","PUT","DELETE","PATCH","OPTIONS"])
async def proxy(service_name: str, path: str, request: Request):
    cfg = next((s for s in list_service_configs() if s.get("serviceName")==service_name), None)
    if not cfg:
        return JSONResponse({"error":"service not found"}, status_code=404)
    target = f"http://{cfg['nlbDnsName']}:{cfg['listenerPort']}/{path}"
    req = await request.body()
    async with httpx.AsyncClient() as client:
        resp = await client.request(request.method, target,
                                    headers=dict(request.headers),
                                    content=req,
                                    params=request.query_params)
    return Response(content=resp.content, status_code=resp.status_code, headers=resp.headers)

@app.get("/openapi/{service_name}.json", response_class=Response)
async def proxy_openapi(service_name: str):
    services = list_service_configs()
    cfg = next((s for s in services if s["serviceName"] == service_name), None)

    if not cfg:
        return Response(
            content=b'{"error":"service not found"}',
            media_type="application/json",
            status_code=404
        )

    target = f"http://{cfg['nlbDnsName']}:{cfg['listenerPort']}/openapi.json"
    
    async with httpx.AsyncClient() as client:
        resp = await client.get(target, timeout=10.0)

    return Response(
        content=resp.content,
        status_code=resp.status_code,
        media_type="application/json"
    )

@app.get("/docs/{service_name}", response_class=HTMLResponse)
async def service_docs(service_name: str):
    cfg = next((s for s in list_service_configs() if s.get("serviceName")==service_name), None)
    if not cfg:
        return HTMLResponse(f"<h2>Service '{service_name}' not found</h2>", status_code=404)
    // openapi_url = f"http://{cfg['nlbDnsName']}:{cfg['listenerPort']}/openapi.json"
    openapi_url = f"/openapi/{service_name}.json"
    return get_swagger_ui_html(
        openapi_url=openapi_url,
        title=f"{service_name} API Docs"
    )

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8080)
EOF

# Navigate to application directory and start
cd /root
nohup python3 /root/config_server.py > /root/config_server.log 2>&1 &
`;
