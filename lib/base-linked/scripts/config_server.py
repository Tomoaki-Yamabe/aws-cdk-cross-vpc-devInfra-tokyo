from fastapi import FastAPI, Request, Response
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.openapi.docs import get_swagger_ui_html
import boto3, httpx, json, socket

app = FastAPI(title="Gateway API", docs_url=None, redoc_url=None)
ssm = boto3.client('ssm', region_name='ap-northeast-1')

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


# Get NLB IP addresses from DNS name
def get_nlb_ip_addresses(dns_name):
    """
    Resolve NLB DNS name to IP addresses
    Returns a comma-separated string of IP addresses
    """
    try:
        if dns_name == "N/A" or not dns_name:
            return "N/A"
        
        # Get all IP addresses for the DNS name
        ip_addresses = socket.getaddrinfo(dns_name, None)
        # Extract unique IPv4 addresses
        ipv4_addresses = list(set([ip[4][0] for ip in ip_addresses if ip[0] == socket.AF_INET]))
        
        if ipv4_addresses:
            return ", ".join(sorted(ipv4_addresses))
        else:
            return "No IPv4 found"
    except Exception as e:
        return f"DNS解決エラー: {str(e)}"


# Root Page
@app.get("/", response_class=HTMLResponse)
async def root():
    services = list_service_configs()
    html = "<html><head><title>Gateway API Server</title>"
    html += "<style>body{font-family:Arial,sans-serif;margin:40px;} table{border-collapse:collapse;width:100%;} th,td{border:1px solid #ddd;padding:8px;text-align:left;} th{background-color:#f2f2f2;}</style>"
    html += "</head><body>"
    html += "<h1>Hello! Gateway API Server</h1>"
    
    # Available Services Section
    html += "<h2> Available Backend Services</h2>"
    if services:
        html += "<table><tr><th>Service Name</th><th>Isolated NLB DNS</th><th>Linked VPC Endpoint IPs</th><th>Listner Port</th><th>Target Port</th><th>API Docs</th></tr>"
        
        # Get VPC Endpoint DNS from SSM
        vpc_endpoint_dns = "N/A"
        try:
            vpc_endpoint_dns = ssm.get_parameter(Name='/linked/infra/privatelink/endpoint')['Parameter']['Value']
        except:
            pass
        
        vpc_endpoint_ips = get_nlb_ip_addresses(vpc_endpoint_dns)
        
        # Get LinkedVPC NLB DNS from SSM
        linked_nlb_dns = "N/A"
        try:
            linked_nlb_dns = ssm.get_parameter(Name='/linked/infra/nlb/dns')['Parameter']['Value']
        except:
            pass
        
        linked_nlb_ips = get_nlb_ip_addresses(linked_nlb_dns)
        
        for s in services:
            name = s.get("serviceName", "Unknown")
            nlb_dns = s.get("nlbDnsName", "N/A")
            listener_port = s.get("listenerPort", "N/A")
            target_port = s.get("targetPort", "N/A")
            html += f'<tr><td>{name}</td><td>{nlb_dns}</td><td>{vpc_endpoint_ips}</td><td>{listener_port}</td><td>{target_port}</td>'
            html += f'<td><a href="/docs/{name}">Swagger UI</a></td></tr>'
        html += "</table>"
    else:
        html += "<p>No services configured yet.</p>"
    
    # Connection Information
    html += "<h2>🔗 Connection Information</h2>"
    html += "<p><strong>API Endpoint:</strong> <code>http://&lt;this-server&gt;:8080/api/&lt;service-name&gt;/&lt;path&gt;</code></p>"
    html += "<p><strong>Example:</strong> <code>http://&lt;this-server&gt;:8080/api/gets3data-service/health</code></p>"
    
    # PrivateLink Information
    html += "<h2>🔗 PrivateLink Connection Details</h2>"
    html += "<p><strong>VPC Endpoint DNS:</strong> <code>" + vpc_endpoint_dns + "</code></p>"
    html += "<p><strong>VPC Endpoint IPs:</strong> <code>" + vpc_endpoint_ips + "</code></p>"
    html += "<p><strong>Example:</strong> <code>http://10.213.66.188:50001/docs</code></p>" 
    html += "<p><em>Note: Proxy server routes traffic to Isolated VPC services via PrivateLink VPC Endpoint</em></p>"
    
    # On-Prem Services Section (with error handling)
    html += "<h2>🏢 On-Premises Services</h2>"
    onprem_services = []
    
    # Try to get GitLab endpoint
    try:
        gitlab = ssm.get_parameter(Name='/onprem/as4-gitlab/endpoint')['Parameter']['Value']
        onprem_services.append(("GitLab API", gitlab))
    except:
        onprem_services.append(("GitLab API", "Not configured"))
    
    # Try to get License Server endpoint
    try:
        license = ssm.get_parameter(Name='/onprem/silver-license/endpoint')['Parameter']['Value']
        onprem_services.append(("License Server", license))
    except:
        onprem_services.append(("License Server", "Not configured"))
    
    if onprem_services:
        html += "<table><tr><th>Service</th><th>Endpoint</th></tr>"
        for service_name, endpoint in onprem_services:
            html += f"<tr><td>{service_name}</td><td>{endpoint}</td></tr>"
        html += "</table>"
    
    html += "</body></html>"
    return HTMLResponse(html)


# Get VPC Endpoint DNS for routing
def get_vpc_endpoint_dns():
    """Get VPC Endpoint DNS from SSM Parameter Store"""
    try:
        return ssm.get_parameter(Name='/linked/infra/privatelink/endpoint')['Parameter']['Value']
    except:
        return None

# Reverse Proxy API Router
@app.api_route("/api/{service_name}/{path:path}", methods=["GET","POST","PUT","DELETE","PATCH","OPTIONS"])
async def proxy(service_name: str, path: str, request: Request):

    # Get target service configuration from SSM Parameter Store
    cfg = next((s for s in list_service_configs() if s.get("serviceName")==service_name), None)
    if not cfg:
        return JSONResponse({"error":"service not found preace check service"}, status_code=404)

    # Use VPC Endpoint DNS for routing to Isolated VPC services
    vpc_endpoint_dns = get_vpc_endpoint_dns()
    if vpc_endpoint_dns:
        target = f"http://{vpc_endpoint_dns}:{cfg['listenerPort']}/{path}"
    else:
        # Fallback to NLB DNS if VPC endpoint is not available
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

    # Use VPC Endpoint DNS for routing to Isolated VPC services
    vpc_endpoint_dns = get_vpc_endpoint_dns()
    if vpc_endpoint_dns:
        target = f"http://{vpc_endpoint_dns}:{cfg['listenerPort']}/openapi.json"
    else:
        # Fallback to NLB DNS if VPC endpoint is not available
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