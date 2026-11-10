$ErrorActionPreference = 'Stop'
$script:RepositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$script:LocalProject = 'demo-englishbattle'

function Invoke-Checked {
    param([string]$Command, [string[]]$Arguments = @())
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Command failed with exit code $LASTEXITCODE" }
}

function Invoke-Firebase {
    $cli = Get-Command firebase.cmd -ErrorAction SilentlyContinue
    if ($cli) { Invoke-Checked $cli.Source $args }
    else { Invoke-Checked 'npx.cmd' (@('--yes', 'firebase-tools@15.34.2') + $args) }
}


# Keep emulator Java separate from Android Studio and the Windows default JVM.
function Invoke-LocalJava21 {
    param([scriptblock]$Action, [string]$JavaHome)
    $candidates = @()
    if ($JavaHome) { $candidates += $JavaHome }
    else {
        $candidates += $env:JAVA_HOME
        $portableRoot = Join-Path $script:RepositoryRoot '.local\tools\jdk21'
        $candidates += $portableRoot
        if (Test-Path -LiteralPath $portableRoot) {
            $candidates += @(Get-ChildItem -LiteralPath $portableRoot -Directory | ForEach-Object { $_.FullName })
        }
        foreach ($installRoot in @('C:\Program Files\Microsoft', 'C:\Program Files\Eclipse Adoptium', 'C:\Program Files\Java')) {
            if (Test-Path -LiteralPath $installRoot) {
                $candidates += @(Get-ChildItem -LiteralPath $installRoot -Directory -Filter '*21*' | ForEach-Object { $_.FullName })
            }
        }
        $javaCommand = Get-Command java.exe -CommandType Application -ErrorAction SilentlyContinue
        if ($javaCommand) { $candidates += Split-Path (Split-Path $javaCommand.Source -Parent) -Parent }
    }
    $selectedJava = $null
    foreach ($candidate in ($candidates | Where-Object { $_ } | Select-Object -Unique)) {
        $javaExe = Join-Path $candidate 'bin\java.exe'
        $javacExe = Join-Path $candidate 'bin\javac.exe'
        if (!(Test-Path -LiteralPath $javaExe) -or !(Test-Path -LiteralPath $javacExe)) { continue }
        $releaseFile = Join-Path $candidate 'release'
        if (!(Test-Path -LiteralPath $releaseFile) -or
            !(Select-String -LiteralPath $releaseFile -Pattern '^JAVA_VERSION="21[.+-]' -Quiet)) { continue }
        $javaVersion = @(& $javaExe '--version' 2>&1)
        if ($LASTEXITCODE -eq 0 -and $javaVersion.Count -and [string]$javaVersion[0] -match '^(openjdk|java) 21[.\s]') {
            $selectedJava = [IO.Path]::GetFullPath($candidate)
            break
        }
    }
    if (!$selectedJava) {
        throw 'JDK 21 is required. Supply -JavaHome <JDK21 directory>, set JAVA_HOME, or extract JDK 21 into .local\tools\jdk21. Java 17/25/26 is not selected.'
    }
    $previousJavaHome = $env:JAVA_HOME
    $previousPath = $env:PATH
    try {
        $env:JAVA_HOME = $selectedJava
        $env:PATH = (Join-Path $selectedJava 'bin') + ';' + $previousPath
        Write-Host "Local emulator JDK 21: $selectedJava"
        & $Action
    } finally {
        $env:PATH = $previousPath
        if ($null -eq $previousJavaHome) { Remove-Item -LiteralPath Env:\JAVA_HOME -ErrorAction SilentlyContinue }
        else { $env:JAVA_HOME = $previousJavaHome }
    }
}

function Invoke-LocalEnvironment {
    param([scriptblock]$Action)
    $settings = @{
        FIREBASE_PROJECT_ID = $script:LocalProject
        GCLOUD_PROJECT = $script:LocalProject
        GOOGLE_CLOUD_PROJECT = $script:LocalProject
        FIREBASE_DATABASE_URL = "https://$script:LocalProject-default-rtdb.firebaseio.com"
        FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099'
        FIREBASE_DATABASE_EMULATOR_HOST = '127.0.0.1:9000'
        FIREBASE_LOCAL_MODE = 'true'
        GOOGLE_APPLICATION_CREDENTIALS = $null
        FIREBASE_TOKEN = $null
        NO_UPDATE_NOTIFIER = '1'
        HOST = '127.0.0.1'
        PORT = '8080'
        ADMIN_ORIGINS = 'http://127.0.0.1:5173,http://localhost:5173'
        VITE_USE_FIREBASE_EMULATORS = 'true'
        VITE_BACKEND_BASE_URL = 'http://127.0.0.1:8080'
    }
    $previous = @{}
    foreach ($key in $settings.Keys) {
        $previous[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
        if ($null -eq $settings[$key]) {
            Remove-Item -LiteralPath ('Env:\' + $key) -ErrorAction SilentlyContinue
        } else {
            [Environment]::SetEnvironmentVariable($key, $settings[$key], 'Process')
        }
    }
    $oldLocation = Get-Location
    try { Set-Location -LiteralPath $script:RepositoryRoot; & $Action }
    finally {
        Set-Location -LiteralPath $oldLocation.Path
        foreach ($key in $previous.Keys) {
            if ($null -eq $previous[$key]) {
                # Passing $null to a .NET string parameter can create an empty
                # variable on PowerShell 7, which would override a later .env.
                Remove-Item -LiteralPath ('Env:\' + $key) -ErrorAction SilentlyContinue
            } else {
                [Environment]::SetEnvironmentVariable($key, $previous[$key], 'Process')
            }
        }
    }
}

function Assert-FreePorts {
    param([int[]]$Ports)
    foreach ($port in $Ports) {
        $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $port)
        try { $listener.Start() }
        catch { throw "Port $port is in use. Stop its owner yourself; this script does not stop other processes." }
        finally { $listener.Stop() }
    }
}

function Assert-LocalEmulators {
    Invoke-Checked 'node' @((Join-Path $script:RepositoryRoot 'Backend/server/tools/local-config.mjs'), '--check')
}

function Resolve-AndroidAdb {
    param([string]$SettingsPath = (Join-Path $script:RepositoryRoot 'frontend\local.properties'))
    $sdkRoots = @()
    if (Test-Path -LiteralPath $SettingsPath) {
        # Android Studio stores Java Properties escapes, including spaces/Unicode.
        $sdkLine = Get-Content -LiteralPath $SettingsPath -Encoding UTF8 |
            Where-Object { $_ -match '^\s*sdk\.dir\s*[=:]' } | Select-Object -Last 1
        if ($sdkLine -match '^\s*sdk\.dir\s*[=:]\s*(.*)$') {
            $sdkRoots += [regex]::Replace($Matches[1], '\\(u[0-9A-Fa-f]{4}|.)', {
                param($match)
                $escaped = $match.Groups[1].Value
                if ($escaped -match '^u[0-9A-Fa-f]{4}$') {
                    return [string][char][Convert]::ToInt32($escaped.Substring(1), 16)
                }
                switch -CaseSensitive ($escaped) {
                    't' { return "`t" }
                    'r' { return "`r" }
                    'n' { return "`n" }
                    'f' { return "`f" }
                    default { return $escaped }
                }
            })
        }
    }
    $sdkRoots += @($env:ANDROID_HOME, $env:ANDROID_SDK_ROOT) | Where-Object { $_ }
    foreach ($sdkRoot in $sdkRoots) {
        $candidate = Join-Path $sdkRoot 'platform-tools\adb.exe'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    $command = Get-Command adb.exe -CommandType Application -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $candidate = Join-Path $env:LOCALAPPDATA 'Android\Sdk\platform-tools\adb.exe'
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    throw 'adb.exe not found. Install Android SDK Platform-Tools; configure sdk.dir, ANDROID_HOME or PATH.'
}
