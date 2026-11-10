param([switch]$Browser, [switch]$AdminBrowser)
. "$PSScriptRoot\Local.Common.ps1"
Invoke-LocalEnvironment {
    Assert-LocalEmulators
    Invoke-Checked 'node' @('--test', '--test-concurrency=1', '--test-timeout=120000', 'Backend/server/test/local.integration.test.mjs')
    # Start-Emulators compiles before watching. Type-check without rewriting lib
    # during live tests: a rebuild can restart workers while requests are running.
    Invoke-Checked 'node' @('Backend/functions/node_modules/typescript/bin/tsc', '--project', 'Backend/functions/tsconfig.json', '--noEmit')
    Invoke-Checked 'npm.cmd' @('--prefix', 'Backend/functions', 'run', 'test:integration')
    if ($Browser -and $AdminBrowser) { throw 'Choose -Browser (mock auth suite) or -AdminBrowser (Firebase API suite), not both.' }
    if ($Browser -or $AdminBrowser) {
        $oldBrowserPath = $env:PLAYWRIGHT_BROWSERS_PATH
        if (Test-Path -LiteralPath (Join-Path $script:RepositoryRoot '.local\playwright')) {
            $env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $script:RepositoryRoot '.local\playwright'
        }
        Push-Location 'frontend/admin-web'
        try {
            $browserConfig = if ($AdminBrowser) { 'playwright.admin.config.ts' } else { 'playwright.local.config.ts' }
            Invoke-Checked 'npx.cmd' @('playwright', 'test', '--config', $browserConfig)
        }
        finally { Pop-Location; $env:PLAYWRIGHT_BROWSERS_PATH = $oldBrowserPath }
    }
}
