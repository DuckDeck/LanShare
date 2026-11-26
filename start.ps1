param(
    [switch]$Rebuild
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

# 过滤虚拟网卡（WSL/Hyper-V/Docker/VMware/VirtualBox/VPN），优先获取真实局域网 IPv4
$lanIp = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object {
        $_.IPAddress -notlike "127.*" -and
        $_.IPAddress -notlike "169.254.*" -and
        $_.InterfaceAlias -notmatch "vEthernet|WSL|Docker|VMware|VirtualBox|Loopback|ZeroTier|Tailscale" -and
        ($_.AddressState -eq "Preferred" -or $null -eq $_.AddressState)
    } |
    Sort-Object {
        if ($_.IPAddress -like "192.168.*") { 0 }
        elseif ($_.IPAddress -like "10.*") { 1 }
        else { 2 }
    } |
    Select-Object -First 1 -ExpandProperty IPAddress

$computerName = $env:COMPUTERNAME
$envLines = @()
if ($lanIp) {
    $hostUrl = "http://${lanIp}:9010"
    $envLines += "HOST_LAN_URL=$hostUrl"
    Write-Host "Detected LAN URL: $hostUrl" -ForegroundColor Green
} else {
    Write-Host "Could not auto-detect LAN IP, using default .env" -ForegroundColor Yellow
}
if ($computerName) {
    $envLines += "HOST_COMPUTER_NAME=$computerName"
    Write-Host "Detected Host Computer Name: $computerName" -ForegroundColor Green
}
if ($envLines.Count -gt 0) {
    $envLines | Set-Content -Path ".env" -Encoding UTF8
}

$hasImage = docker images -q lan-share-lan-share:latest
if ($Rebuild -or -not $hasImage) {
    docker compose up -d --build
} else {
    Write-Host "Using cached image lan-share-lan-share:latest (mount ./server & ./public). Pass -Rebuild to force image rebuild." -ForegroundColor Gray
    docker compose up -d --force-recreate
}
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "Docker 启动失败，请确认 Docker Desktop 已打开且网络/代理可拉取基础镜像。" -ForegroundColor Red
    exit $LASTEXITCODE
}

Write-Host ""
Write-Host "=== LAN-Share 已启动 ===" -ForegroundColor Cyan
Write-Host "本机访问: http://localhost:9010"
if ($lanIp) {
    Write-Host "局域网/手机扫码访问: http://${lanIp}:9010" -ForegroundColor Green
}
Write-Host "提示: 若手机无法连接，请在管理员 PowerShell 运行放行端口命令:" -ForegroundColor Yellow
Write-Host '  New-NetFirewallRule -DisplayName "LAN-Share-9010" -Direction Inbound -Protocol TCP -LocalPort 9010 -Action Allow'
