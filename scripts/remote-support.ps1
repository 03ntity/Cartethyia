# ============================================================================
#  Cartethyia - Remote Support tunnel launcher (PowerShell companion)
# ----------------------------------------------------------------------------
#  Launches cloudflared/tailscale so it is NOT a child of the caller.
#
#  Why: the gateway (bun) must not own the tunnel. A child process inherits the
#  parent's console and dies with it, so a gateway restart or a Ctrl-C in the
#  terminal would silently kill the operator's remote-support session.
#  Start-Process hands the process to the OS session instead.
#
#  This file never installs anything. If the binary is not on PATH it reports
#  so and exits; installing is the operator's job.
# ============================================================================
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("launch")]
    [string]$Action,

    [Parameter(Mandatory = $true)]
    [ValidateSet("cloudflared", "tailscale")]
    [string]$Tool,

    [int]$Port = 12800,

    [Parameter(Mandatory = $true)]
    [string]$StateDir
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if (-not (Test-Path -LiteralPath $StateDir)) {
    New-Item -ItemType Directory -Path $StateDir -Force | Out-Null
}

$pidFile = Join-Path $StateDir "$Tool.pid"
$urlFile = Join-Path $StateDir "$Tool.url"
$logFile = Join-Path $StateDir "$Tool.log"

Remove-Item -LiteralPath $urlFile -Force -ErrorAction SilentlyContinue

# --- Resolve the binary. Never install, never download. -------------------
$binary = Get-Command $Tool -ErrorAction SilentlyContinue
if (-not $binary) {
    Write-Error "$Tool is not installed or not on PATH. Install it yourself, then retry."
    exit 3
}
$exe = $binary.Source

# --- Build the argument list. ---------------------------------------------
if ($Tool -eq "cloudflared") {
    # --url prints a fresh *.trycloudflare.com hostname to STDERR.
    $arguments = @("tunnel", "--url", "http://127.0.0.1:$Port", "--no-autoupdate")
} else {
    # tailscale serve --bg returns immediately; the funnel port is 443.
    $arguments = @("serve", "--bg", "--https=443", "http://127.0.0.1:$Port")
}

# --- Launch detached. ------------------------------------------------------
# Start-Process with -PassThru gives us the real OS pid to record. The process
# is attached to the window session, not to this script's job object.
try {
    $proc = Start-Process -FilePath $exe `
        -ArgumentList $arguments `
        -WindowStyle Hidden `
        -PassThru `
        -RedirectStandardOutput $logFile `
        -RedirectStandardError "$logFile.err"
} catch {
    Write-Error "Failed to launch $Tool`: $($_.Exception.Message)"
    exit 1
}

Set-Content -LiteralPath $pidFile -Value $proc.Id -Encoding ascii -Force

# --- Wait for the public URL to appear in the captured output. -------------
# cloudflared writes the hostname within a few seconds; tailscale --bg exits
# quickly and its address comes from `tailscale serve status` instead.
#
# The pattern is anchored to the tunnel's own hostname on purpose. cloudflared
# prints a startup banner that contains `https://www.cloudflare.com` and
# `api.cloudflare.com` long before it prints the assigned hostname, so a loose
# `https://...` match latched onto the marketing link and reported that as the
# remote URL — which is wrong, and looks plausible enough to mislead.
$urlPattern = if ($Tool -eq 'cloudflared') {
    'https://[A-Za-z0-9-]+\.trycloudflare\.com'
} else {
    'https://[A-Za-z0-9.-]+\.ts\.net'
}
$deadline = (Get-Date).AddSeconds(25)
$url = $null
while ((Get-Date) -lt $deadline) {
    foreach ($candidate in @($logFile, "$logFile.err")) {
        if (-not (Test-Path -LiteralPath $candidate)) { continue }
        $text = Get-Content -LiteralPath $candidate -Raw -ErrorAction SilentlyContinue
        if (-not $text) { continue }
        $match = [regex]::Match($text, $urlPattern)
        if ($match.Success) {
            $url = $match.Value
            break
        }
    }
    if ($url) { break }
    Start-Sleep -Milliseconds 500
}

if ($url) {
    Set-Content -LiteralPath $urlFile -Value $url -Encoding ascii -Force
    Write-Output $url
} elseif ($Tool -eq "tailscale") {
    # tailscale --bg prints nothing useful; ask the daemon for the served URL.
    #
    # Every property read here goes through a hashtable index instead of
    # dotted access. `Set-StrictMode -Version Latest` (above) turns a missing
    # property into a terminating PropertyNotFoundException, and the shape of
    # `tailscale serve status --json` is not stable across versions — DNSName
    # sits under `Self` in some releases and at the root in others. Under strict
    # mode, probing `$parsed.DNSName` on an object that lacks it threw instead
    # of returning null, which surfaced as a launch failure.
    $status = & $exe serve status --json 2>$null
    if ($status) {
        $parsed = $status | ConvertFrom-Json -ErrorAction SilentlyContinue
        $hostname = $null
        if ($parsed -is [System.Collections.IDictionary]) {
            if ($parsed.Contains('DNSName')) { $hostname = $parsed['DNSName'] }
        } else {
            $props = @($parsed.PSObject.Properties)
            foreach ($name in @('DNSName', 'Self')) {
                $prop = $props | Where-Object { $_.Name -eq $name }
                if (-not $prop) { continue }
                $value = $prop.Value
                if ($name -eq 'Self' -and $value) {
                    $inner = @($value.PSObject.Properties) | Where-Object { $_.Name -eq 'DNSName' }
                    if ($inner) { $hostname = $inner.Value }
                } elseif ($value) {
                    $hostname = $value
                }
                if ($hostname) { break }
            }
        }
        if ($hostname) {
            $url = ("https://" + $hostname.ToString().Trim().TrimEnd('/'))
            Set-Content -LiteralPath $urlFile -Value $url -Encoding ascii -Force
            Write-Output $url
        }
    }
}

if (-not $url) {
    Write-Output "started"
}

exit 0
