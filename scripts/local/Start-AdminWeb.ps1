param([ValidateSet('mock', 'firebase')][string]$DataSource = 'mock')
. "$PSScriptRoot\Local.Common.ps1"
$previousDataSource = $env:VITE_ADMIN_DATA_SOURCE
try {
    $env:VITE_ADMIN_DATA_SOURCE = $DataSource
    Invoke-LocalEnvironment {
        Assert-LocalEmulators
        Assert-FreePorts @(5173)
        Invoke-Checked 'npm.cmd' @('--prefix', 'frontend/admin-web', 'run', 'dev')
    }
} finally {
    if ($null -eq $previousDataSource) {
        Remove-Item -LiteralPath Env:\VITE_ADMIN_DATA_SOURCE -ErrorAction SilentlyContinue
    } else { $env:VITE_ADMIN_DATA_SOURCE = $previousDataSource }
}
