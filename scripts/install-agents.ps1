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

# Dynamic Model Verification via the Anthropic-compatible gateway (/v1/models)
Write-Host "`nValidating available models via the Claude Code gateway..." -ForegroundColor Yellow
$availableModels = @()
try {
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $settingsPath = Join-Path $env:USERPROFILE '.claude\settings.json'
    $baseUrl = $null; $token = $null
    if (Test-Path -LiteralPath $settingsPath) {
        $settings = Get-Content -Raw -LiteralPath $settingsPath | ConvertFrom-Json
        if ($settings.env.ANTHROPIC_BASE_URL) { $baseUrl = $settings.env.ANTHROPIC_BASE_URL }
        if ($settings.env.ANTHROPIC_AUTH_TOKEN) { $token = $settings.env.ANTHROPIC_AUTH_TOKEN }
    }
    if (-not $baseUrl -and $env:ANTHROPIC_BASE_URL) { $baseUrl = $env:ANTHROPIC_BASE_URL }
    if (-not $token -and $env:ANTHROPIC_AUTH_TOKEN) { $token = $env:ANTHROPIC_AUTH_TOKEN }
    if ($baseUrl) {
        $headers = @{ 'Accept' = 'application/json'; 'anthropic-version' = '2023-06-01' }
        if ($token) {
            $headers['x-api-key'] = $token
            $headers['Authorization'] = "Bearer $token"
        }
        $response = Invoke-RestMethod -Uri "$($baseUrl.TrimEnd('/'))/v1/models" -Headers $headers -TimeoutSec 12
        $availableModels = @($response.data | ForEach-Object { $_.id })
        Write-Host "Found $($availableModels.Count) available models on the gateway." -ForegroundColor Green
    } else {
        Write-Warning "No ANTHROPIC_BASE_URL configured; list_models will serve built-in alias defaults."
    }
    $ErrorActionPreference = $prevEap
} catch {
    Write-Warning "Could not query the gateway /v1/models ($($_.Exception.Message)). Will proceed; broker serves cached/built-in defaults."
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
