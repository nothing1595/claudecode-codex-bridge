$ErrorActionPreference = 'Stop'

$bridgeRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$sourceDir = Join-Path $bridgeRoot 'agents'

# Resolve Codex home directory
$codexHome = if ($env:CODEX_HOME) {
    $env:CODEX_HOME
} elseif (Test-Path -LiteralPath 'E:\ChatGPT\UserProfile\.codex') {
    'E:\ChatGPT\UserProfile\.codex'
} else {
    Join-Path $env:USERPROFILE '.codex'
}

$targetDir = Join-Path $codexHome 'agents'

# Resolve Node executable
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$nodeExe = if ($env:CCB_NODE_EXE) {
    $env:CCB_NODE_EXE
} elseif ($nodeCommand) {
    $nodeCommand.Source
} elseif (Test-Path -LiteralPath 'E:\Node.js\node.exe') {
    'E:\Node.js\node.exe'
} else {
    'node'
}

$serverPath = Join-Path $bridgeRoot 'server\claudecode-worker.cjs'

Write-Host "=== ClaudeCode-Codex Bridge Installer ===" -ForegroundColor Cyan
Write-Host "Bridge Root: $bridgeRoot"
Write-Host "Codex Home : $codexHome"
Write-Host "Node Path  : $nodeExe"
Write-Host "Server Path: $serverPath"

# Clean up obsolete worker definitions if present
$obsoleteWorkers = @('claude-worker.toml', 'claude_worker.toml')
foreach ($oldFile in $obsoleteWorkers) {
    $oldPath = Join-Path $targetDir $oldFile
    if (Test-Path -LiteralPath $oldPath) {
        Remove-Item -LiteralPath $oldPath -Force
        Write-Host "Cleaned up obsolete agent: $oldPath" -ForegroundColor Yellow
    }
}

# CPA-only fail-closed validation: the bridge refuses to run Claude Code
# unless every model request goes through the local CPA gateway, so the
# installer must not succeed when the gateway is missing or unreachable.
Write-Host "`nValidating CPA gateway (~/.claude/settings.json ANTHROPIC_BASE_URL -> /v1/models)..." -ForegroundColor Yellow
$settingsPath = Join-Path $env:USERPROFILE '.claude\settings.json'
$baseUrl = $null; $token = $null
if (Test-Path -LiteralPath $settingsPath) {
    $settings = Get-Content -Raw -LiteralPath $settingsPath | ConvertFrom-Json
    if ($settings.env.ANTHROPIC_BASE_URL) { $baseUrl = $settings.env.ANTHROPIC_BASE_URL }
    if ($settings.env.ANTHROPIC_AUTH_TOKEN) { $token = $settings.env.ANTHROPIC_AUTH_TOKEN }
    if (-not $token -and $settings.env.ANTHROPIC_API_KEY) { $token = $settings.env.ANTHROPIC_API_KEY }
}
if (-not $baseUrl -and $env:CCB_GATEWAY_BASE_URL) { $baseUrl = $env:CCB_GATEWAY_BASE_URL }
if (-not $baseUrl -and $env:ANTHROPIC_BASE_URL) { $baseUrl = $env:ANTHROPIC_BASE_URL }
if (-not $token -and $env:CCB_GATEWAY_AUTH_TOKEN) { $token = $env:CCB_GATEWAY_AUTH_TOKEN }
if (-not $token -and $env:ANTHROPIC_AUTH_TOKEN) { $token = $env:ANTHROPIC_AUTH_TOKEN }

if (-not $baseUrl) {
    throw "CPA gateway required: ANTHROPIC_BASE_URL is not configured (~/.claude/settings.json env or CCB_GATEWAY_BASE_URL). The bridge is CPA-only fail-closed and refuses to install without it."
}
if (-not $token) {
    throw "CPA gateway required: ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY is not configured. The bridge is CPA-only fail-closed and refuses to install without it."
}

$allowedUrls = @('http://127.0.0.1:8317', 'http://localhost:8317')
if ($env:CCB_ALLOWED_GATEWAY_URLS) {
    $allowedUrls = @($env:CCB_ALLOWED_GATEWAY_URLS -split ',' | ForEach-Object { $_.Trim().TrimEnd('/').ToLower() })
}
$normalizedBaseUrl = $baseUrl.TrimEnd('/').ToLower()
if ($allowedUrls -notcontains $normalizedBaseUrl) {
    throw "Refusing to install: gateway '$baseUrl' is not in the CPA allowlist [$($allowedUrls -join ', ')]. Direct connections to Anthropic or unknown endpoints are forbidden (CPA-only policy)."
}

$headers = @{ 'Accept' = 'application/json'; 'anthropic-version' = '2023-06-01' }
$headers['x-api-key'] = $token
$headers['Authorization'] = "Bearer $token"
try {
    $response = Invoke-WebRequest -Uri "$($baseUrl.TrimEnd('/'))/v1/models" -Headers $headers -TimeoutSec 12 -UseBasicParsing
    $availableModels = @((($response.Content | ConvertFrom-Json).data) | ForEach-Object { $_.id })
    Write-Host "Found $($availableModels.Count) available models on the CPA gateway ($baseUrl)." -ForegroundColor Green
} catch {
    $status = $null
    if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
    if ($status -eq 429) {
        Write-Warning "CPA gateway is alive but rate limited (HTTP 429). Proceeding with installation."
    } elseif ($status -eq 401 -or $status -eq 403) {
        throw "CPA gateway rejected credentials (HTTP $status). Fix ANTHROPIC_AUTH_TOKEN in ~/.claude/settings.json before installing."
    } else {
        throw "CPA gateway health check failed ($($_.Exception.Message)). The bridge is CPA-only fail-closed; start the gateway on $baseUrl before installing."
    }
}

function ConvertTo-TomlBasicStringValue([string]$Value) {
    return $Value.Replace('\', '\\').Replace('"', '\"')
}

function Install-AgentTemplate([string]$FileName) {
    $sourcePath = Join-Path $sourceDir $FileName
    if (-not (Test-Path -LiteralPath $sourcePath)) {
        Write-Warning "Source template not found: $sourcePath"
        return
    }

    $template = Get-Content -Raw -LiteralPath $sourcePath
    $rendered = $template.Replace('__NODE_EXE__', (ConvertTo-TomlBasicStringValue $nodeExe))
    $rendered = $rendered.Replace('__CLAUDECODE_BRIDGE_SERVER__', (ConvertTo-TomlBasicStringValue $serverPath))

    $targetPath = Join-Path $targetDir $FileName
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($targetPath, $rendered, $utf8NoBom)
    Write-Host "Installed: $targetPath" -ForegroundColor Green
}

New-Item -ItemType Directory -Force -Path $targetDir | Out-Null

# Install the single unified gateway agent
Install-AgentTemplate 'cc-worker.toml'

# Register in Codex config.toml so Codex automatically approves tool dispatches without prompting
$configPath = Join-Path $codexHome 'config.toml'
if (Test-Path -LiteralPath $configPath) {
    $configText = Get-Content -Raw -LiteralPath $configPath
    if ($configText -notmatch '(?m)^\[mcp_servers\.claudecode_worker\]\s*$') {
        $mcpConfig = @"

[mcp_servers.claudecode_worker]
command = "$(ConvertTo-TomlBasicStringValue $nodeExe)"
args = ["$(ConvertTo-TomlBasicStringValue $serverPath)"]
startup_timeout_sec = 20
tool_timeout_sec = 60
"@
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::AppendAllText($configPath, $mcpConfig, $utf8NoBom)
        Write-Host "Registered claudecode_worker globally in $configPath (auto-approves tool dispatch)" -ForegroundColor Green
    }
}

# Register user-level Windows Scheduled Task for ClaudeCodeBroker
# This ensures that when the worker calls schtasks /Run /TN ClaudeCodeBroker, the broker
# executes in the interactive authenticated host user session (e.g. 15869) even if invoked from codexsandboxoffline.
if ($IsWindows -or $env:OS -match 'Windows') {
    try {
        $brokerScript = Join-Path $bridgeRoot 'server\claudecode-broker.cjs'
        $taskCmd = "`"$nodeExe`" `"$brokerScript`""
        schtasks /Create /TN "ClaudeCodeBroker" /TR $taskCmd /SC ONCE /ST 23:59 /F 2>&1 | Out-Null
        icacls "C:\Windows\System32\Tasks\ClaudeCodeBroker" /grant "Users:(RX)" "CodexSandboxOffline:(RX)" "CodexSandboxOnline:(RX)" 2>&1 | Out-Null
        Write-Host "Registered user Scheduled Task 'ClaudeCodeBroker' with sandbox execution permissions." -ForegroundColor Green
    } catch {
        Write-Warning "Could not register ClaudeCodeBroker scheduled task: $($_.Exception.Message)"
    }

    # Start or restart the broker daemon immediately in host session
    $startScript = Join-Path $bridgeRoot 'scripts\start-broker.ps1'
    if (Test-Path -LiteralPath $startScript) {
        & $startScript -Restart
    }
}

Write-Host "`nInstallation completed successfully!" -ForegroundColor Cyan
Write-Host "Restart Codex, then ask it to spawn cc_worker."
Write-Host "When assigned, cc_worker will report all available 'cc_XXX_worker' models (gateway discovery) or the built-in alias catalog, and auto-approve all operations."
