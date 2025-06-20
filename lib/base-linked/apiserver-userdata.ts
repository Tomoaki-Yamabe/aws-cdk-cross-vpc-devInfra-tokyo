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

# Get all service configurations from SSM Parameter Store
def list_service_configs():
    parameters = []
    next_token = None # default value for pagination is 10. due to the number of services we have, we need to paginate
    while True:
        if next_token:
            resp = ssm.get_parameters_by_path(
                Path='/services',
                Recursive=True,
                WithDecryption=False,
                NextToken=next_token,
            )
        else:
            resp = ssm.get_parameters_by_path(
                Path='/services',
                Recursive=True,
                WithDecryption=False,
            )

        # create a list from json SSM parameters
        parameters += [json.loads(p['Value']) for p in resp.get('Parameters', [])]
        next_token = resp.get('NextToken')
        if not next_token:
            break

    return parameters


# Root Page
@app.get("/", response_class=HTMLResponse)
async def root():
    services = list_service_configs()
    html = "<html><head><title>Gateway</title></head><body>"
    html += "<h1>Available Services</h1><ul>"
    for s in services:
        name = s.get("serviceName")
        html += f'<li>{name} — <a href="/docs/{name}">Microservice API from Swagger UI</a></li>'
    html += "</ul></body></html>"

    gitlab = ssm.get_parameter(Name='/onprem/as4-gitlab/endpoint')['Parameter']['Value']
    license = ssm.get_parameter(Name='/onprem/silver-license/endpoint')['Parameter']['Value']
    html += f"""
      <h2>On-Prem Services</h2>
      <ul>
        <li>GitLab API: {gitlab}</li>
        <li>License Server: {license}</li>
      </ul>
    """
    return HTMLResponse(html)


# Reverse Proxy API Router
@app.api_route("/api/{service_name}/{path:path}", methods=["GET","POST","PUT","DELETE","PATCH","OPTIONS"])
async def proxy(service_name: str, path: str, request: Request):

    # Get target service configuration from SSM Parameter Store
    cfg = next((s for s in list_service_configs() if s.get("serviceName")==service_name), None)
    if not cfg:
        return JSONResponse({"error":"service not found preace check service"}, status_code=404)

    # Create target URL and make request to target service
    target = f"http://{cfg['nlbDnsName']}:{cfg['listenerPort']}/{path}"
    req = await request.body()

    # httpx client to make request to target service
    async with httpx.AsyncClient() as client:
        resp = await client.request(request.method, target,
                                    headers=dict(request.headers),
                                    content=req,
                                    params=request.query_params)

    # return respone to client originaly
    return Response(content=resp.content, status_code=resp.status_code, headers=resp.headers)


# OpenAPI defauilt Defenition for each service.
# Connect to the OpenAPI of each microservice to display Swagger UI
@app.get("/openapi/{service_name}.json", response_class=Response)
async def proxy_openapi(service_name: str):
    cfg = next((s for s in list_service_configs() if s["serviceName"] == service_name), None)

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


# Swagger UI for each service
@app.get("/docs/{service_name}", response_class=HTMLResponse)
async def service_docs(service_name: str):
    cfg = next((s for s in list_service_configs() if s.get("serviceName")==service_name), None)
    if not cfg:
        return HTMLResponse(f"<h2>Service '{service_name}' not found</h2>", status_code=404)

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
