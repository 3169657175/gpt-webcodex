param(
    [string]$PythonVersion = "3.12.10"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Target = Join-Path $ProjectRoot "resources\native-python"
$Archive = Join-Path $env:TEMP "python-$PythonVersion-embed-amd64.zip"
$PythonUrl = "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip"
$GetPip = Join-Path $env:TEMP "get-pip.py"

Write-Host "Preparing portable Python $PythonVersion..." -ForegroundColor Cyan
if (Test-Path -LiteralPath $Target) {
    Remove-Item -LiteralPath $Target -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $Target | Out-Null

Invoke-WebRequest -UseBasicParsing -Uri $PythonUrl -OutFile $Archive
Expand-Archive -LiteralPath $Archive -DestinationPath $Target -Force

$PthFile = Get-ChildItem -LiteralPath $Target -Filter "python*._pth" | Select-Object -First 1
if (-not $PthFile) { throw "Embedded Python ._pth file was not found." }
$Pth = Get-Content -LiteralPath $PthFile.FullName
$Pth = $Pth -replace '^#import site$', 'import site'
if ($Pth -notcontains 'Lib\site-packages') { $Pth += 'Lib\site-packages' }
if ($Pth -notcontains '..\coding-tools-mcp\python_vendor') { $Pth += '..\coding-tools-mcp\python_vendor' }
if ($Pth -notcontains '..\coding-tools-mcp') { $Pth += '..\coding-tools-mcp' }
Set-Content -LiteralPath $PthFile.FullName -Value $Pth -Encoding Ascii

Invoke-WebRequest -UseBasicParsing -Uri "https://bootstrap.pypa.io/get-pip.py" -OutFile $GetPip
& (Join-Path $Target "python.exe") $GetPip --no-warn-script-location
if ($LASTEXITCODE -ne 0) { throw "pip bootstrap failed." }
$SitePackages = Join-Path $Target "Lib\site-packages"
$BundledSource = Join-Path $ProjectRoot "resources\coding-tools-mcp"
& (Join-Path $Target "python.exe") -m pip install --no-warn-script-location --target $SitePackages "PyJWT>=2.8,<3"
if ($LASTEXITCODE -ne 0) { throw "PyJWT installation failed." }

# pip is only needed while assembling the portable runtime. Removing it keeps
# the shipped runtime smaller and prevents the embedded interpreter from being
# mistaken for a general-purpose package installation environment.
Remove-Item -LiteralPath (Join-Path $SitePackages "pip") -Recurse -Force -ErrorAction SilentlyContinue
Get-ChildItem -LiteralPath $SitePackages -Filter "pip-*.dist-info" -ErrorAction SilentlyContinue |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
Get-ChildItem -LiteralPath (Join-Path $Target "Scripts") -Filter "pip*.exe" -ErrorAction SilentlyContinue |
    Remove-Item -Force -ErrorAction SilentlyContinue

Remove-Item -LiteralPath $Archive,$GetPip -Force -ErrorAction SilentlyContinue
Write-Host "Portable runtime ready: $Target" -ForegroundColor Green
