# Run this script as Administrator in PowerShell
# Right-click PowerShell -> "Run as administrator" -> paste and hit Enter

# Open port 3000 (App HTTPS via nginx proxy)
netsh advfirewall firewall add rule `
  name="Full-Interviewer App HTTPS (3000)" `
  protocol=TCP dir=in localport=3000 action=allow

# Open port 8443 (Jitsi HTTPS)
netsh advfirewall firewall add rule `
  name="Full-Interviewer Jitsi HTTPS (8443)" `
  protocol=TCP dir=in localport=8443 action=allow

# Open port 10000 UDP (Jitsi media/WebRTC)
netsh advfirewall firewall add rule `
  name="Full-Interviewer Jitsi WebRTC UDP (10000)" `
  protocol=UDP dir=in localport=10000 action=allow

Write-Host ""
Write-Host "Firewall rules added. Other LAN devices can now reach:" -ForegroundColor Green
Write-Host "  App  -> https://10.19.220.188:3000" -ForegroundColor Cyan
Write-Host "  Jitsi-> https://10.19.220.188:8443" -ForegroundColor Cyan
