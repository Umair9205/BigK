param(
    [string]$AndroidSdk = 'C:\Users\umair\AppData\Local\Android\Sdk',
    [string]$JavaPath = 'C:\Program Files\Java\jdk-17'
)
# Native tools (node, gradle) write diagnostics to stderr even on success; those
# must not become terminating errors, because every command below is already
# guarded by an explicit `$LASTEXITCODE` check.
$ErrorActionPreference = 'Continue'
$projectPath = Split-Path -Parent $PSScriptRoot
$env:JAVA_HOME = $JavaPath
$env:ANDROID_HOME = $AndroidSdk
$env:ANDROID_USER_HOME = 'C:\Users\umair\.android'
$env:GRADLE_USER_HOME = 'C:\Users\umair\.gradle'
Push-Location $projectPath
try {
    & node scripts/test-direct-native.cjs
    if ($LASTEXITCODE -ne 0) { throw 'Native control connection tests failed; no APK built.' }
    & node scripts/test-ringtone-settings.cjs
    if ($LASTEXITCODE -ne 0) { throw 'Ringtone setting checks failed; no APK built.' }
    & node scripts/test-background-availability.cjs
    if ($LASTEXITCODE -ne 0) { throw 'Background availability tests failed; no APK built.' }
    & node scripts/test-availability-watchdog.cjs
    if ($LASTEXITCODE -ne 0) { throw 'Availability watchdog tests failed; no APK built.' }
    & node scripts/test-call-connections.cjs
    if ($LASTEXITCODE -ne 0) { throw 'Connection tests failed; no APK built.' }
    & node scripts/test-discovery-presence.cjs
    if ($LASTEXITCODE -ne 0) { throw 'Discovery presence tests failed; no APK built.' }
    & node scripts/test-direct-call.cjs
    if ($LASTEXITCODE -ne 0) { throw 'Direct call tests failed; no APK built.' }
    & node scripts/test-direct-call-lifecycle.cjs
    if ($LASTEXITCODE -ne 0) { throw 'Call handoff/lifecycle tests failed; no APK built.' }
    & node scripts/test-offline-audio.cjs
    if ($LASTEXITCODE -ne 0) { throw 'Audio tests failed; no APK built.' }
    & node node_modules/typescript/bin/tsc --noEmit --pretty false
    if ($LASTEXITCODE -ne 0) { throw 'TypeScript check failed; no APK built.' }
    Push-Location android
    try {
        & .\gradlew.bat :app:assembleRelease --no-daemon '-Pkotlin.compiler.execution.strategy=in-process' --console=plain
        if ($LASTEXITCODE -ne 0) { throw 'Android build failed. Do not install an older APK left in the output folder.' }
    } finally { Pop-Location }
    $apkPath = Join-Path $projectPath 'android\app\build\outputs\apk\release\app-release.apk'
    if (!(Test-Path -LiteralPath $apkPath)) { throw 'Build did not produce an APK.' }
    Write-Host "Build completed: $apkPath"
    Get-FileHash -Algorithm SHA256 -LiteralPath $apkPath
    Write-Host 'Install this same APK on both phones. Keep Bluetooth and Location on (always-on local calling); no router or internet is required for the call. If Wi-Fi is off, the app opens the system Wi-Fi panel itself — one toggle continues the call.'
} finally { Pop-Location }
