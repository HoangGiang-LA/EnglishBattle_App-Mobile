param([switch]$Fresh, [string]$JavaHome)
. "$PSScriptRoot\Local.Common.ps1"
Invoke-LocalJava21 -JavaHome $JavaHome -Action {
    Invoke-LocalEnvironment {
        Assert-FreePorts @(4000, 4400, 4500, 5001, 9000, 9099)
        Invoke-Checked 'npm.cmd' @('--prefix', 'Backend/functions', 'run', 'build')
        $exportPath = Join-Path $script:RepositoryRoot '.local\emulator-data'
        $cliArgs = @('emulators:start', '--config', 'firebase.local.json', '--project', $script:LocalProject,
            '--only', 'auth,database,functions', "--export-on-exit=$exportPath")
        if (!$Fresh -and (Test-Path -LiteralPath (Join-Path $exportPath 'firebase-export-metadata.json'))) {
            $cliArgs += "--import=$exportPath"
        } elseif ($Fresh -and (Test-Path -LiteralPath $exportPath)) {
            # A fresh session never overwrites an existing saved session.
            $exportPath = Join-Path $script:RepositoryRoot ('.local\emulator-fresh-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
            $cliArgs = @('emulators:start', '--config', 'firebase.local.json', '--project', $script:LocalProject,
                '--only', 'auth,database,functions', "--export-on-exit=$exportPath")
            Write-Host "Fresh session export: $exportPath"
        }
        Invoke-Firebase @cliArgs
    }

}
