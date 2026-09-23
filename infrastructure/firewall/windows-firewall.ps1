<#
.SYNOPSIS
    KAIROS DB — Windows Defender Firewall configuration.

.DESCRIPTION
    The Windows equivalent of ufw-setup.sh, for when the laptop runs Windows
    with Docker Desktop rather than Ubuntu Server.

    Run from an elevated PowerShell prompt:
        Set-ExecutionPolicy -Scope Process Bypass
        .\windows-firewall.ps1

    A caveat worth knowing: Docker Desktop on Windows proxies published ports
    through vpnkit, which runs as a host process. Blocking the port at the
    firewall works, but the reliable fix is still to not publish the port in
    docker-compose.prod.yml at all.
#>

#Requires -RunAsAdministrator

$ErrorActionPreference = 'Stop'

# Set to your LAN subnet to keep remote administration possible.
$AdminSubnet = '192.168.0.0/16'

Write-Host '==> Removing any previous Kairos rules'
Get-NetFirewallRule -DisplayName 'Kairos *' -ErrorAction SilentlyContinue |
    Remove-NetFirewallRule

Write-Host '==> Setting default profile policy to block inbound'
Set-NetFirewallProfile -Profile Domain,Public,Private `
    -DefaultInboundAction Block `
    -DefaultOutboundAction Allow `
    -NotifyOnListen False `
    -LogBlocked True `
    -LogFileName '%SystemRoot%\System32\LogFiles\Firewall\kairos.log' `
    -LogMaxSizeKilobytes 16384

Write-Host '==> Allowing public HTTP and HTTPS'
New-NetFirewallRule -DisplayName 'Kairos HTTP'  -Direction Inbound `
    -Protocol TCP -LocalPort 80  -Action Allow -Profile Any | Out-Null
New-NetFirewallRule -DisplayName 'Kairos HTTPS' -Direction Inbound `
    -Protocol TCP -LocalPort 443 -Action Allow -Profile Any | Out-Null

Write-Host '==> Blocking data-plane ports from everywhere'
foreach ($port in 5432, 6379, 9000, 9001) {
    New-NetFirewallRule -DisplayName "Kairos Block $port" -Direction Inbound `
        -Protocol TCP -LocalPort $port -Action Block -Profile Any | Out-Null
    Write-Host "    blocked tcp/$port"
}

Write-Host '==> Allowing dashboard and API from the LAN only'
foreach ($port in 3000, 4000) {
    New-NetFirewallRule -DisplayName "Kairos LAN $port" -Direction Inbound `
        -Protocol TCP -LocalPort $port -RemoteAddress $AdminSubnet `
        -Action Allow -Profile Private | Out-Null
}

Write-Host '==> Allowing RDP from the LAN only (remove if unused)'
New-NetFirewallRule -DisplayName 'Kairos RDP LAN' -Direction Inbound `
    -Protocol TCP -LocalPort 3389 -RemoteAddress $AdminSubnet `
    -Action Allow -Profile Private | Out-Null

Write-Host ''
Get-NetFirewallRule -DisplayName 'Kairos *' |
    Select-Object DisplayName, Direction, Action, Enabled |
    Format-Table -AutoSize

Write-Host ''
Write-Host 'Done. Verify from another machine that tcp/5432 is closed:'
Write-Host '    Test-NetConnection <laptop-ip> -Port 5432'
Write-Host 'TcpTestSucceeded must be False.'
