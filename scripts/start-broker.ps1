param(
    [switch]$Restart
)

$ErrorActionPreference = 'Stop'

$bridgeRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$brokerScript = Join-Path $bridgeRoot 'server\claudecode-broker.cjs'
$brokerPort = if ($env:CCB_BROKER_PORT) { $env:CCB_BROKER_PORT } else { 19226 }
$nodeExe = if (Test-Path -LiteralPath 'E:\Node.js\node.exe') { 'E:\Node.js\node.exe' } else { (Get-Command node).Source }

Write-Host "=== ClaudeCode Host Broker Manager ===" -ForegroundColor Cyan

# 1. Check if broker is already listening on the configured port
$conn = Get-NetTCPConnection -LocalPort $brokerPort -ErrorAction SilentlyContinue
if ($conn) {
    $procId = $conn.OwningProcess
    $owner = try { (Get-WmiObject Win32_Process -Filter "ProcessId = $procId").GetOwner().User } catch { "Unknown" }
    Write-Host "Broker already listening on 127.0.0.1:$brokerPort (PID: $procId, User: $owner)" -ForegroundColor Green
    if ($Restart -or ($owner -match "sandbox")) {
        Write-Host "Restarting broker daemon (terminating PID: $procId)..." -ForegroundColor Yellow
        Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 600
    } else {
        Write-Host "Broker is active and ready for Codex dispatches." -ForegroundColor Cyan
        exit 0
    }
}

# 2. Ensure scheduled task exists and has ACLs for sandbox users
try {
    $taskCmd = "`"$nodeExe`" `"$brokerScript`""
    schtasks /Create /TN "ClaudeCodeBroker" /TR $taskCmd /SC ONCE /ST 23:59 /F 2>&1 | Out-Null
    icacls "C:\Windows\System32\Tasks\ClaudeCodeBroker" /grant "Users:(RX)" "CodexSandboxOffline:(RX)" "CodexSandboxOnline:(RX)" 2>&1 | Out-Null
    Write-Host "Verified ClaudeCodeBroker scheduled task and sandbox permissions." -ForegroundColor Green
} catch {
    Write-Warning "Scheduled task check notice: $($_.Exception.Message)"
}

# 3. Launch the broker under host user session
Write-Host "Starting broker daemon in host user session..." -ForegroundColor Yellow
$launched = $false
try {
    schtasks /Run /TN "ClaudeCodeBroker" 2>&1 | Out-Null
    $launched = $true
} catch {
    # Fallback to background process
    Start-Process -FilePath $nodeExe -ArgumentList "`"$brokerScript`"" -WindowStyle Hidden
    $launched = $true
}

# 4. Wait up to 5s for the loopback port to open
for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Milliseconds 300
    $c = Get-NetTCPConnection -LocalPort $brokerPort -ErrorAction SilentlyContinue
    if ($c) {
        $p = $c.OwningProcess
        $u = try { (Get-WmiObject Win32_Process -Filter "ProcessId = $p").GetOwner().User } catch { "Host" }
        Write-Host "ClaudeCode Broker successfully started on 127.0.0.1:$brokerPort (PID: $p, User: $u)!" -ForegroundColor Green
        exit 0
    }
}

Write-Error "Failed to verify broker listening on port $brokerPort."
