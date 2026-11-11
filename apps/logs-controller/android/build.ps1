# Builds the Ledge Top Logs controller test APK with only the Android SDK command-line tools and a JDK
# (no Gradle, no downloaded libraries). Usage:
#   powershell -File apps/logs-controller/android/build.ps1 -Sdk <android-sdk> -Jdk <jdk17> [-Out <dir>]
param(
  [Parameter(Mandatory = $true)][string]$Sdk,
  [Parameter(Mandatory = $true)][string]$Jdk,
  [string]$Out = "$PSScriptRoot\build",
  [string]$BuildTools = "36.1.0",
  [string]$Platform = "android-36",
  [int]$VersionCode = 1,
  [string]$VersionName = "0.1.0"
)
$ErrorActionPreference = "Stop"
$bt = Join-Path $Sdk "build-tools\$BuildTools"
$androidJar = Join-Path $Sdk "platforms\$Platform\android.jar"
$java = Join-Path $Jdk "bin"
$env:JAVA_HOME = $Jdk
$env:PATH = "$java;$env:PATH"
function Run($exe) { & $exe @args; if ($LASTEXITCODE -ne 0) { throw "$exe failed ($LASTEXITCODE)" } }

if (Test-Path $Out) { Remove-Item -Recurse -Force $Out }
New-Item -ItemType Directory -Force "$Out\gen", "$Out\classes", "$Out\dex" | Out-Null

Run "$bt\aapt2.exe" compile --dir "$PSScriptRoot\res" -o "$Out\res.zip"
Run "$bt\aapt2.exe" link -I $androidJar --manifest "$PSScriptRoot\AndroidManifest.xml" -o "$Out\unsigned.apk" "$Out\res.zip" `
  --java "$Out\gen" --min-sdk-version 26 --target-sdk-version 29 --version-code $VersionCode --version-name $VersionName

$sources = @(Get-ChildItem -Recurse "$PSScriptRoot\src", "$Out\gen" -Filter *.java | ForEach-Object { $_.FullName })
Run "$java\javac.exe" -source 11 -target 11 -encoding UTF-8 "-Xlint:-options" -classpath $androidJar -d "$Out\classes" @sources
$classes = @(Get-ChildItem -Recurse "$Out\classes" -Filter *.class | ForEach-Object { $_.FullName })
Run "$bt\d8.bat" --release --min-api 26 --lib $androidJar --output "$Out\dex" @classes

# Add classes.dex to the APK, then align and sign it.
Push-Location "$Out\dex"; Run "$java\jar.exe" -uf0M "$Out\unsigned.apk" classes.dex; Pop-Location
Run "$bt\zipalign.exe" -f -p 4 "$Out\unsigned.apk" "$Out\aligned.apk"

# A local debug key for test builds only (not a release key), kept outside the repo so upgrades install over each other.
$keyDir = Join-Path $env:LOCALAPPDATA "LedgeTop\android"
$keystore = Join-Path $keyDir "ledgetop-logs-debug.keystore"
if (-not (Test-Path $keystore)) {
  New-Item -ItemType Directory -Force $keyDir | Out-Null
  Run "$java\keytool.exe" -genkeypair -keystore $keystore -storepass android -keypass android -alias debug `
    -dname "CN=Ledge Top Logs debug" -keyalg RSA -keysize 2048 -validity 3650
}
Run "$bt\apksigner.bat" sign --ks $keystore --ks-pass pass:android --key-pass pass:android --ks-key-alias debug `
  --out "$Out\ledgetop-logs-$VersionName-debug.apk" "$Out\aligned.apk"
Run "$bt\apksigner.bat" verify "$Out\ledgetop-logs-$VersionName-debug.apk"
Write-Output "Built $Out\ledgetop-logs-$VersionName-debug.apk"
