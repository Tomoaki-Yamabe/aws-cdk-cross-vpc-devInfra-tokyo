from fastapi import FastAPI, Request, Response
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.openapi.docs import get_swagger_ui_html, get_redoc_html
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


# Get ALB information from SSM Parameter Store
def get_alb_info():
    """
    Get ALB DNS name and IP addresses from SSM Parameter Store
    Returns a dictionary with ALB DNS and IPs
    """
    alb_info = {"dns": "N/A", "ips": "N/A"}
    try:
        alb_dns = ssm.get_parameter(Name='/isolated/infra/alb/dns')['Parameter']['Value']
        alb_info["dns"] = alb_dns
        alb_info["ips"] = get_nlb_ip_addresses(alb_dns)
    except:
        pass
    return alb_info


# Get VPC Endpoint information
def get_vpc_endpoint_info():
    """
    Get VPC Endpoint DNS name and IP addresses from SSM Parameter Store
    Returns a dictionary with VPC Endpoint DNS and IPs
    """
    endpoint_info = {"dns": "N/A", "ips": "N/A"}
    try:
        endpoint_dns = ssm.get_parameter(Name='/linked/infra/privatelink/endpoint')['Parameter']['Value']
        endpoint_info["dns"] = endpoint_dns
        endpoint_info["ips"] = get_nlb_ip_addresses(endpoint_dns)
    except:
        pass
    return endpoint_info


# Get Isolated NLB information
def get_isolated_nlb_info():
    """
    Get Isolated NLB DNS name and IP addresses from SSM Parameter Store
    Returns a dictionary with NLB DNS and IPs
    """
    nlb_info = {"dns": "N/A", "ips": "N/A"}
    try:
        nlb_dns = ssm.get_parameter(Name='/isolated/infra/nlb/dns')['Parameter']['Value']
        nlb_info["dns"] = nlb_dns
        nlb_info["ips"] = get_nlb_ip_addresses(nlb_dns)
    except:
        pass
    return nlb_info


# Get Linked NLB information
def get_linked_nlb_info():
    """
    Get Linked NLB DNS name and IP addresses from SSM Parameter Store
    Returns a dictionary with NLB DNS and IPs
    """
    nlb_info = {"dns": "N/A", "ips": "N/A"}
    try:
        nlb_dns = ssm.get_parameter(Name='/linked/infra/nlb/dns')['Parameter']['Value']
        nlb_info["dns"] = nlb_dns
        nlb_info["ips"] = get_nlb_ip_addresses(nlb_dns)
    except:
        pass
    return nlb_info


# Note: ECR repository and CodePipeline information are now retrieved directly from SSM parameters
# in the service configuration JSON, eliminating the need for separate lookup functions.


# Root Page
@app.get("/", response_class=HTMLResponse)
async def root():
    services = list_service_configs()
    html = "<html><head><title>Gateway API Server</title>"
    html += """<style>
        body{font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;margin:40px;background-color:#f8f9fa;color:#333;}
        .container{max-width:1200px;margin:0 auto;background-color:white;padding:30px;border-radius:10px;box-shadow:0 2px 10px rgba(0,0,0,0.1);}
        h1{color:#2c3e50;border-bottom:3px solid #3498db;padding-bottom:10px;}
        h2{color:#34495e;margin-top:30px;padding:10px;background-color:#ecf0f1;border-left:4px solid #3498db;border-radius:5px;}
        h3{color:#2980b9;margin-top:20px;}
        table{border-collapse:collapse;width:100%;margin:15px 0;box-shadow:0 2px 5px rgba(0,0,0,0.1);}
        th,td{border:1px solid #bdc3c7;padding:12px;text-align:left;}
        th{background-color:#3498db;color:white;font-weight:bold;}
        tr:nth-child(even){background-color:#f8f9fa;}
        tr:hover{background-color:#e8f4f8;}
        a{color:#2980b9;text-decoration:none;font-weight:bold;}
        a:hover{color:#1abc9c;text-decoration:underline;}
        code{background-color:#ecf0f1;padding:2px 6px;border-radius:3px;font-family:'Courier New',monospace;color:#e74c3c;}
        .info-box{background-color:#f8f9fa;padding:15px;border-radius:5px;margin:10px 0;border-left:4px solid #3498db;}
        .status-badge{padding:4px 8px;border-radius:12px;font-size:12px;font-weight:bold;}
        .status-active{background-color:#2ecc71;color:white;}
        .status-inactive{background-color:#e74c3c;color:white;}
    </style>"""
    html += "</head><body><div class='container'>"
    html += "<h1>🚀 Gateway API Server</h1>"
    
    # Get connection information
    vpc_endpoint_info = get_vpc_endpoint_info()
    isolated_nlb_info = get_isolated_nlb_info()
    linked_nlb_info = get_linked_nlb_info()
    alb_info = get_alb_info()
    
    # Available Services Section
    html += "<h2>🚀 Available Backend Services</h2>"
    if services:
        html += "<table><tr><th>Service Name</th><th>ALBパスルール</th><th>Target Port</th><th>Swagger Docs</th><th>Swagger Redoc</th><th>ECR Repository</th><th>CodePipeline</th></tr>"
        
        for s in services:
            name = s.get("serviceName", "Unknown")
            path_rule = s.get("pathRule", s.get("servicePath", "N/A"))  # pathRuleを優先、フォールバックでservicePath
            target_port = s.get("targetPort", "N/A")
            ecr_url = s.get("ecrRepo", "N/A")
            pipeline_url = s.get("pipelineUrl", "N/A")
            
            html += f'<tr><td>{name}</td><td>{path_rule}</td><td>{target_port}</td>'
            
            # Linked VPC Endpoint IP経由でSwagger UIとReDocにリンク
            base_path = path_rule.replace('/*', '') if path_rule != "N/A" else name
            # VPC Endpoint IPsから最初のIPアドレスを取得（カンマ区切りの場合）
            vpc_endpoint_ip = vpc_endpoint_info["ips"].split(",")[0].strip() if vpc_endpoint_info["ips"] != "N/A" else "N/A"
            
            if vpc_endpoint_ip != "N/A":
                html += f'<td><a href="http://{vpc_endpoint_ip}{base_path}/docs" target="_blank">Swagger UI</a></td>'
                html += f'<td><a href="http://{vpc_endpoint_ip}{base_path}/redoc" target="_blank">ReDoc</a></td>'
            else:
                html += f'<td>N/A</td>'
                html += f'<td>N/A</td>'
            
            # ECRリポジトリリンク
            if ecr_url != "N/A":
                html += f'<td><a href="{ecr_url}" target="_blank">ECR</a></td>'
            else:
                html += f'<td>N/A</td>'
            
            # CodePipelineリンク
            if pipeline_url != "N/A":
                html += f'<td><a href="{pipeline_url}" target="_blank">Pipeline</a></td>'
            else:
                html += f'<td>N/A</td>'
            
            html += '</tr>'
        html += "</table>"
    else:
        html += "<p>No services configured yet.</p>"
    
    # Connection Information
    html += "<h2>🔗 Connection Information</h2>"
    html += "<div class='info-box'>"
    
    # Linked VPC Endpoint Information
    html += "<h3>📡 Linked VPC Endpoint</h3>"
    html += f"<p><strong>DNS Name:</strong> <code>{vpc_endpoint_info['dns']}</code></p>"
    html += f"<p><strong>IP Addresses:</strong> <code>{vpc_endpoint_info['ips']}</code></p>"
    
    # Linked NLB Information
    html += "<h3>⚖️ Linked NLB</h3>"
    html += f"<p><strong>DNS Name:</strong> <code>{linked_nlb_info['dns']}</code></p>"
    html += f"<p><strong>IP Addresses:</strong> <code>{linked_nlb_info['ips']}</code></p>"
    
    # Isolated NLB Information
    html += "<h3>⚖️ Isolated NLB</h3>"
    html += f"<p><strong>DNS Name:</strong> <code>{isolated_nlb_info['dns']}</code></p>"
    html += f"<p><strong>IP Addresses:</strong> <code>{isolated_nlb_info['ips']}</code></p>"
    
    # Isolated ALB Information
    html += "<h3>🔄 Isolated ALB</h3>"
    html += f"<p><strong>DNS Name:</strong> <code>{alb_info['dns']}</code></p>"
    html += f"<p><strong>IP Addresses:</strong> <code>{alb_info['ips']}</code></p>"
    
    html += "</div>"
    
    # API Usage Information
    html += "<h2>📋 API Usage</h2>"
    html += "<div class='info-box'>"
    html += "<p><strong>API Endpoint:</strong> <code>http://&lt;this-server&gt;:8080/api/&lt;service-name&gt;/&lt;path&gt;</code></p>"
    html += "<p><strong>Example:</strong> <code>http://&lt;this-server&gt;:8080/api/gets3data-service/health</code></p>"
    html += "<p><em>Note: Proxy server routes traffic to Isolated VPC services via PrivateLink VPC Endpoint and ALB with priority routing (ALB → VPC Endpoint → NLB)</em></p>"
    html += "</div>"
    
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
    
    html += "</div></body></html>"
    return HTMLResponse(html)


# Get VPC Endpoint DNS for routing
def get_vpc_endpoint_dns():
    """Get VPC Endpoint DNS from SSM Parameter Store"""
    try:
        return ssm.get_parameter(Name='/linked/infra/privatelink/endpoint')['Parameter']['Value']
    except:
        return None

# Get ALB DNS for routing
def get_alb_dns():
    """Get ALB DNS from SSM Parameter Store"""
    try:
        return ssm.get_parameter(Name='/isolated/infra/alb/dns')['Parameter']['Value']
    except:
        return None

# Reverse Proxy API Router with ALB support
@app.api_route("/api/{service_name}/{path:path}", methods=["GET","POST","PUT","DELETE","PATCH","OPTIONS"])
async def proxy(service_name: str, path: str, request: Request):

    # Get target service configuration from SSM Parameter Store
    cfg = next((s for s in list_service_configs() if s.get("serviceName")==service_name), None)
    if not cfg:
        return JSONResponse({"error":"service not found please check service"}, status_code=404)

    # Priority routing: ALB -> VPC Endpoint -> NLB
    alb_dns = get_alb_dns()
    vpc_endpoint_dns = get_vpc_endpoint_dns()
    
    if alb_dns:
        # Use ALB for routing with path-based routing
        target = f"http://{alb_dns}/{service_name}/{path}"
    elif vpc_endpoint_dns:
        # Use VPC Endpoint DNS for routing to Isolated VPC services
        target = f"http://{vpc_endpoint_dns}:{cfg['listenerPort']}/{path}"
    else:
        # Fallback to NLB DNS if ALB and VPC endpoint are not available
        target = f"http://{cfg['nlbDnsName']}:{cfg['listenerPort']}/{path}"
    
    req = await request.body()

    # httpx client to make request to target service
    async with httpx.AsyncClient() as client:
        resp = await client.request(request.method, target,
                                    headers=dict(request.headers),
                                    content=req,
                                    params=request.query_params)

    # return response to client originally
    return Response(content=resp.content, status_code=resp.status_code, headers=resp.headers)


# Direct ALB routing for OpenAPI JSON
@app.get("/{service_name}/openapi.json", response_class=Response)
async def proxy_openapi_direct(service_name: str):
    """Direct routing to service OpenAPI via ALB"""
    cfg = next((s for s in list_service_configs() if s["serviceName"] == service_name), None)

    if not cfg:
        return Response(
            content=b'{"error":"service not found"}',
            media_type="application/json",
            status_code=404
        )

    # Priority routing: ALB -> VPC Endpoint -> NLB
    alb_dns = get_alb_dns()
    vpc_endpoint_dns = get_vpc_endpoint_dns()
    
    if alb_dns:
        # Use ALB for routing with path-based routing
        target = f"http://{alb_dns}/{service_name}/openapi.json"
    elif vpc_endpoint_dns:
        # Use VPC Endpoint DNS for routing to Isolated VPC services
        target = f"http://{vpc_endpoint_dns}:{cfg['listenerPort']}/openapi.json"
    else:
        # Fallback to NLB DNS if ALB and VPC endpoint are not available
        target = f"http://{cfg['nlbDnsName']}:{cfg['listenerPort']}/openapi.json"

    async with httpx.AsyncClient() as client:
        resp = await client.get(target, timeout=10.0)

    return Response(
        content=resp.content,
        status_code=resp.status_code,
        media_type="application/json"
    )


# Legacy OpenAPI default Definition for each service (for backward compatibility)
@app.get("/openapi/{service_name}.json", response_class=Response)
async def proxy_openapi_legacy(service_name: str):
    cfg = next((s for s in list_service_configs() if s["serviceName"] == service_name), None)

    if not cfg:
        return Response(
            content=b'{"error":"service not found"}',
            media_type="application/json",
            status_code=404
        )

    # Priority routing: ALB -> VPC Endpoint -> NLB
    alb_dns = get_alb_dns()
    vpc_endpoint_dns = get_vpc_endpoint_dns()
    
    if alb_dns:
        # Use ALB for routing with path-based routing
        target = f"http://{alb_dns}/{service_name}/openapi.json"
    elif vpc_endpoint_dns:
        # Use VPC Endpoint DNS for routing to Isolated VPC services
        target = f"http://{vpc_endpoint_dns}:{cfg['listenerPort']}/openapi.json"
    else:
        # Fallback to NLB DNS if ALB and VPC endpoint are not available
        target = f"http://{cfg['nlbDnsName']}:{cfg['listenerPort']}/openapi.json"

    async with httpx.AsyncClient() as client:
        resp = await client.get(target, timeout=10.0)

    return Response(
        content=resp.content,
        status_code=resp.status_code,
        media_type="application/json"
    )


# Direct ALB routing for Swagger UI
@app.get("/{service_name}/docs", response_class=Response)
async def service_docs_direct(service_name: str, request: Request):
    """Direct routing to service docs via ALB"""
    cfg = next((s for s in list_service_configs() if s.get("serviceName")==service_name), None)
    if not cfg:
        return HTMLResponse(f"<h2>Service '{service_name}' not found</h2>", status_code=404)

    # Priority routing: ALB -> VPC Endpoint -> NLB
    alb_dns = get_alb_dns()
    vpc_endpoint_dns = get_vpc_endpoint_dns()
    
    if alb_dns:
        target = f"http://{alb_dns}/{service_name}/docs"
    elif vpc_endpoint_dns:
        target = f"http://{vpc_endpoint_dns}:{cfg['listenerPort']}/docs"
    else:
        target = f"http://{cfg['nlbDnsName']}:{cfg['listenerPort']}/docs"
    
    async with httpx.AsyncClient() as client:
        resp = await client.get(target, timeout=10.0)
    
    return Response(
        content=resp.content,
        status_code=resp.status_code,
        headers=resp.headers
    )


# Direct ALB routing for ReDoc
@app.get("/{service_name}/redoc", response_class=Response)
async def service_redoc_direct(service_name: str, request: Request):
    """Direct routing to service redoc via ALB"""
    cfg = next((s for s in list_service_configs() if s.get("serviceName")==service_name), None)
    if not cfg:
        return HTMLResponse(f"<h2>Service '{service_name}' not found</h2>", status_code=404)

    # Priority routing: ALB -> VPC Endpoint -> NLB
    alb_dns = get_alb_dns()
    vpc_endpoint_dns = get_vpc_endpoint_dns()
    
    if alb_dns:
        target = f"http://{alb_dns}/{service_name}/redoc"
    elif vpc_endpoint_dns:
        target = f"http://{vpc_endpoint_dns}:{cfg['listenerPort']}/redoc"
    else:
        target = f"http://{cfg['nlbDnsName']}:{cfg['listenerPort']}/redoc"
    
    async with httpx.AsyncClient() as client:
        resp = await client.get(target, timeout=10.0)
    
    return Response(
        content=resp.content,
        status_code=resp.status_code,
        headers=resp.headers
    )


# Legacy Swagger UI for each service (for backward compatibility)
@app.get("/docs/{service_name}", response_class=HTMLResponse)
async def service_docs_legacy(service_name: str):
    cfg = next((s for s in list_service_configs() if s.get("serviceName")==service_name), None)
    if not cfg:
        return HTMLResponse(f"<h2>Service '{service_name}' not found</h2>", status_code=404)

    openapi_url = f"/openapi/{service_name}.json"
    return get_swagger_ui_html(
        openapi_url=openapi_url,
        title=f"{service_name} API Docs - Swagger UI"
    )


# Legacy ReDoc for each service (for backward compatibility)
@app.get("/redoc/{service_name}", response_class=HTMLResponse)
async def service_redoc_legacy(service_name: str):
    cfg = next((s for s in list_service_configs() if s.get("serviceName")==service_name), None)
    if not cfg:
        return HTMLResponse(f"<h2>Service '{service_name}' not found</h2>", status_code=404)

    openapi_url = f"/openapi/{service_name}.json"
    return get_redoc_html(
        openapi_url=openapi_url,
        title=f"{service_name} API Docs - ReDoc"
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8080)