# Crea accesos directos a MiniCAD 3D en el Escritorio y en el menú Inicio.
# Abre el programa en su propia ventana (modo aplicación de Chrome o Edge).
$ErrorActionPreference = 'Stop'

$dir  = $PSScriptRoot
$html = Join-Path $dir 'MiniCAD.html'
$ico  = Join-Path $dir 'minicad.ico'

if (-not (Test-Path $html)) {
    Write-Host "No se encontró MiniCAD.html en $dir" -ForegroundColor Red
    exit 1
}

# Navegador: Chrome si está instalado, si no Edge
$candidatos = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
)
$navegador = $candidatos | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $navegador) {
    Write-Host 'No se encontró Google Chrome ni Microsoft Edge.' -ForegroundColor Red
    exit 1
}

$url = ([System.Uri]$html).AbsoluteUri
$destinos = @(
    (Join-Path ([Environment]::GetFolderPath('Desktop')) 'MiniCAD 3D.lnk'),
    (Join-Path ([Environment]::GetFolderPath('Programs')) 'MiniCAD 3D.lnk')
)

$shell = New-Object -ComObject WScript.Shell
foreach ($lnkPath in $destinos) {
    $lnk = $shell.CreateShortcut($lnkPath)
    $lnk.TargetPath = $navegador
    $lnk.Arguments = "--app=`"$url`""
    $lnk.WorkingDirectory = $dir
    $lnk.Description = 'MiniCAD 3D - modelador CAD ligero'
    if (Test-Path $ico) { $lnk.IconLocation = "$ico,0" }
    $lnk.Save()
    Write-Host "Acceso directo creado: $lnkPath" -ForegroundColor Green
}

Write-Host ''
Write-Host 'Listo. Busca "MiniCAD" en el menú Inicio o usa el icono del Escritorio.'
Write-Host 'Para anclarlo a la barra de tareas: abre MiniCAD, clic derecho en su icono de la barra > Anclar a la barra de tareas.'
