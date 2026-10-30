#Requires -Version 5.1
<#
  Fase 10 del plan de despliegue (docs/plan-despliegue-produccion.md): sacar del VPS, de forma
  automatica, las copias de seguridad cifradas que cada instancia deja en su BACKUP_DIR.

  Que hace
    1. Pide al VPS el sha256 de cada .cbak de cada instancia.
    2. Descarga solo los que faltan en el destino local, o los que estan y no cuadran.
    3. Vuelve a calcular el sha256 en local y lo compara con el del VPS. Si no coincide,
       borra el fichero descargado y lo cuenta como error.
    4. Si encuentra el destino secundario (un disco extraible preparado, ver abajo), copia alli
       lo que falte y verifica tambien cada fichero copiado.
    5. Deja un registro y un estado.json con el resultado.

  El destino secundario
    Una copia en un solo PC no es una copia externa: si ese equipo se estropea o se cifra, se
    pierde a la vez el unico duplicado. El segundo destino es un disco extraible marcado con un
    fichero testigo:

        <unidad>:\multiagente-backups\.destino-copias-chatbot

    El script busca ese testigo en todas las unidades extraibles, asi que **da igual la letra**
    que Windows le asigne cada vez. Para preparar un disco nuevo basta crear esa carpeta y ese
    fichero.

    Que el disco no este conectado NO es un error: el script lo anota y sigue. Pero si pasan mas
    de -DiasAvisoSecundario dias sin verlo, avisa en el registro, porque un segundo destino que
    nadie conecta no protege de nada.

  Que NO hace
    - No borra nada en el VPS.
    - No borra nada en local ni en el disco extraible: el VPS solo guarda unos dias de copias y
      las va rotando, asi que el historico de aqui crece y es una ventaja (protege contra que la
      rotacion se lleve la ultima copia buena). Son unos 15 KB por copia: alrededor de 11 MB al
      ano entre las dos instancias.
    - No descifra nada. BACKUP_KEY no aparece aqui, no viaja con las copias y no vive dentro de
      BACKUP_DIR ni del disco extraible. Sin ella estos ficheros no sirven de nada, ni aqui ni
      para quien los robe.

  Requisitos
    - El ssh.exe de Windows (no el de Git Bash, que no habla con el agente de Windows).
    - El servicio ssh-agent en marcha y con la clave del VPS cargada:
        Set-Service ssh-agent -StartupType Automatic   (como administrador)
        Start-Service ssh-agent                        (como administrador)
        ssh-add $env:USERPROFILE\.ssh\chatbot_vps      (como tu usuario, pide la passphrase)
      El agente guarda la clave cifrada y de forma persistente, asi que sobrevive a los
      reinicios y la tarea programada puede usarla sin nadie delante.

  Codigo de salida: 0 si todo fue bien, 1 si hubo cualquier error. El Programador de tareas de
  Windows usa ese codigo para marcar la ejecucion como fallida. El disco secundario ausente no
  cuenta como error.
#>
[CmdletBinding()]
param(
  [string]   $Destino               = 'C:\multiagente-backups',
  [string]   $Alias                 = 'vps',
  [string]   $RutaRemota            = '/srv/chatbot',
  [string[]] $Instancias            = @('instancia-1', 'instancia-2', 'instancia-3'),
  [string]   $CarpetaSecundaria     = 'multiagente-backups',
  [string]   $TestigoSecundario     = '.destino-copias-chatbot',
  [int]      $DiasAvisoSecundario   = 14
)

$ErrorActionPreference = 'Stop'

$ficheroRegistro = Join-Path $Destino 'registro\descargar-copias.log'
$ficheroEstado   = Join-Path $Destino 'estado.json'
$errores         = New-Object System.Collections.Generic.List[string]
$avisos          = New-Object System.Collections.Generic.List[string]

function Escribir([string]$texto, [string]$color = 'Gray') {
  $linea = ('{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $texto)
  Write-Host $linea -ForegroundColor $color
  try { Add-Content -Path $ficheroRegistro -Value $linea -Encoding utf8 } catch { }
}

function AnotarError([string]$texto) {
  $errores.Add($texto)
  Escribir ('ERROR: {0}' -f $texto) 'Red'
}

function AnotarAviso([string]$texto) {
  $avisos.Add($texto)
  Escribir ('AVISO: {0}' -f $texto) 'Yellow'
}

# Busca el disco secundario por su testigo, no por su letra: una unidad extraible cambia de letra
# segun lo que haya conectado en cada momento.
function BuscarSecundario {
  foreach ($disco in @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType = 2' -ErrorAction SilentlyContinue)) {
    $carpeta = Join-Path ($disco.DeviceID + '\') $CarpetaSecundaria
    try {
      if (Test-Path (Join-Path $carpeta $TestigoSecundario)) { return $carpeta }
    } catch { }
  }
  return $null
}

# --- Preparacion -----------------------------------------------------------------------------

foreach ($carpeta in @($Destino, (Join-Path $Destino 'registro'))) {
  if (-not (Test-Path $carpeta)) { New-Item -ItemType Directory -Path $carpeta -Force | Out-Null }
}

# Recorte del registro: por encima de 1 MB se guarda una generacion anterior y se empieza de cero.
if (Test-Path $ficheroRegistro) {
  if ((Get-Item $ficheroRegistro).Length -gt 1MB) {
    Move-Item -Path $ficheroRegistro -Destination ($ficheroRegistro + '.1') -Force
  }
}

# Estado de la ejecucion anterior: de ahi sale cuando se vio por ultima vez el disco secundario.
$estadoPrevio = $null
if (Test-Path $ficheroEstado) {
  try { $estadoPrevio = Get-Content $ficheroEstado -Raw | ConvertFrom-Json } catch { }
}

Escribir '== Descarga de copias de seguridad del VPS ==' 'Cyan'

$ssh = Join-Path $env:WINDIR 'System32\OpenSSH\ssh.exe'
$scp = Join-Path $env:WINDIR 'System32\OpenSSH\scp.exe'
foreach ($exe in @($ssh, $scp)) {
  if (-not (Test-Path $exe)) {
    AnotarError ('no se encuentra {0}; hace falta el cliente OpenSSH de Windows' -f $exe)
    exit 1
  }
}

# Prueba de conexion antes de nada, para que un fallo de clave o de cortafuegos de un mensaje
# claro en vez de veinte fallos de descarga seguidos.
$prueba = & $ssh -4 -o BatchMode=yes -o ConnectTimeout=20 $Alias 'echo listo' 2>&1
if ($LASTEXITCODE -ne 0 -or "$prueba" -notmatch 'listo') {
  AnotarError ("no se puede conectar con '{0}': {1}" -f $Alias, ("$prueba".Trim()))
  Escribir 'Si pone "Permission denied (publickey)", la clave no esta en el agente: arranca el' 'Yellow'
  Escribir 'servicio ssh-agent y haz ssh-add. Si pone "timed out", mira el cortafuegos de Hetzner:' 'Yellow'
  Escribir 'la IP publica de esta linea es dinamica y el puerto 22 solo acepta rangos concretos.' 'Yellow'
  exit 1
}

$secundario = BuscarSecundario
if ($secundario) {
  Escribir ('Destino secundario encontrado: {0}' -f $secundario) 'Cyan'
}

# --- Descarga --------------------------------------------------------------------------------

$resumen = [ordered]@{}

foreach ($instancia in $Instancias) {
  Escribir ('-- {0}' -f $instancia) 'Cyan'

  $directorioRemoto = ('{0}/{1}/backups' -f $RutaRemota, $instancia)
  $destinoLocal     = Join-Path $Destino $instancia
  if (-not (Test-Path $destinoLocal)) {
    New-Item -ItemType Directory -Path $destinoLocal -Force | Out-Null
  }

  # sha256sum de todas las copias. El "|| true" evita que un directorio vacio aborte la orden.
  $orden  = ('sha256sum {0}/*.cbak 2>/dev/null || true' -f $directorioRemoto)
  $salida = & $ssh -4 -o BatchMode=yes -o ConnectTimeout=20 $Alias $orden 2>&1
  if ($LASTEXITCODE -ne 0) {
    AnotarError ('{0}: no se pudo listar el directorio remoto: {1}' -f $instancia, ("$salida".Trim()))
    continue
  }

  $remotos = @{}
  foreach ($linea in @($salida)) {
    $texto = "$linea".Trim()
    if ($texto -eq '') { continue }
    $partes = $texto -split '\s+', 2
    if ($partes.Count -ne 2) { continue }
    $nombre = Split-Path $partes[1].Trim() -Leaf
    $remotos[$nombre] = $partes[0].Trim()
  }

  if ($remotos.Count -eq 0) {
    AnotarError ('{0}: el VPS no tiene ninguna copia en {1}' -f $instancia, $directorioRemoto)
    continue
  }
  Escribir ('{0}: {1} copias en el VPS' -f $instancia, $remotos.Count)

  # Que falta: lo que no esta en local, o esta pero con otro contenido (descarga a medias).
  $pendientes = @()
  foreach ($nombre in $remotos.Keys) {
    $rutaLocal = Join-Path $destinoLocal $nombre
    if (-not (Test-Path $rutaLocal)) {
      $pendientes += $nombre
      continue
    }
    $hashLocal = (Get-FileHash -Path $rutaLocal -Algorithm SHA256).Hash
    if ($hashLocal -ne $remotos[$nombre]) {
      Escribir ('{0}: {1} no cuadra con el VPS, se vuelve a descargar' -f $instancia, $nombre) 'Yellow'
      $pendientes += $nombre
    }
  }

  if ($pendientes.Count -eq 0) {
    Escribir ('{0}: nada que descargar, las {1} ya estaban' -f $instancia, $remotos.Count) 'Green'
  } else {
    Escribir ('{0}: hay que descargar {1}' -f $instancia, $pendientes.Count)
    # Un solo scp con todos los origenes pendientes: menos ruido y menos conexiones.
    $origenes = @()
    foreach ($nombre in $pendientes) {
      $origenes += ($Alias + ':' + $directorioRemoto + '/' + $nombre)
    }
    $salidaScp = & $scp -4 -p -o BatchMode=yes -o ConnectTimeout=20 @origenes $destinoLocal 2>&1
    if ($LASTEXITCODE -ne 0) {
      AnotarError ('{0}: fallo la descarga: {1}' -f $instancia, ("$salidaScp".Trim()))
    }
  }

  # Verificacion: el sha256 local tiene que coincidir con el que dio el VPS. Un fichero que no
  # cuadra se borra, para que no quede una copia rota con pinta de buena.
  $correctas = 0
  foreach ($nombre in $remotos.Keys) {
    $rutaLocal = Join-Path $destinoLocal $nombre
    if (-not (Test-Path $rutaLocal)) {
      AnotarError ('{0}: {1} no llego a descargarse' -f $instancia, $nombre)
      continue
    }
    $hashLocal = (Get-FileHash -Path $rutaLocal -Algorithm SHA256).Hash
    if ($hashLocal -ne $remotos[$nombre]) {
      AnotarError ('{0}: {1} se descargo corrupto, se borra' -f $instancia, $nombre)
      Remove-Item -Path $rutaLocal -Force
      continue
    }
    $correctas++
  }

  $totalLocal = @(Get-ChildItem -Path $destinoLocal -Filter '*.cbak' -File).Count
  Escribir ('{0}: {1}/{2} verificadas, {3} en el historico local' -f $instancia, $correctas, $remotos.Count, $totalLocal) 'Green'

  # --- Copia al destino secundario -------------------------------------------------------------
  # Se copia TODO el historico local, no solo lo que hay hoy en el VPS: el disco extraible es la
  # copia de ultimo recurso y debe poder reconstruirlo todo por si solo.
  $copiadas2 = 0
  $total2    = 0
  if ($secundario) {
    $destino2 = Join-Path $secundario $instancia
    try {
      if (-not (Test-Path $destino2)) { New-Item -ItemType Directory -Path $destino2 -Force | Out-Null }
      foreach ($fichero in @(Get-ChildItem -Path $destinoLocal -Filter '*.cbak' -File)) {
        $ruta2 = Join-Path $destino2 $fichero.Name
        $hace  = $true
        if (Test-Path $ruta2) {
          $hace = (Get-FileHash -Path $ruta2 -Algorithm SHA256).Hash -ne (Get-FileHash -Path $fichero.FullName -Algorithm SHA256).Hash
        }
        if ($hace) {
          Copy-Item -Path $fichero.FullName -Destination $ruta2 -Force
          # Verificar tambien aqui: un disco extraible se puede retirar a mitad de la copia.
          if ((Get-FileHash -Path $ruta2 -Algorithm SHA256).Hash -ne (Get-FileHash -Path $fichero.FullName -Algorithm SHA256).Hash) {
            AnotarError ('{0}: {1} se copio mal al destino secundario, se borra' -f $instancia, $fichero.Name)
            Remove-Item -Path $ruta2 -Force
            continue
          }
          $copiadas2++
        }
        $total2++
      }
      Escribir ('{0}: destino secundario al dia, {1} ficheros ({2} copiados ahora)' -f $instancia, $total2, $copiadas2) 'Green'
    } catch {
      AnotarError ('{0}: fallo al copiar al destino secundario: {1}' -f $instancia, $_.Exception.Message)
    }
  }

  $ultima = ($remotos.Keys | Sort-Object | Select-Object -Last 1)
  $resumen[$instancia] = [ordered]@{
    copiasEnVps        = $remotos.Count
    descargadasAhora   = $pendientes.Count
    verificadas        = $correctas
    historicoLocal     = $totalLocal
    ultimaCopiaEnVps   = $ultima
    enDestinoSecundario = $total2
  }
}

# --- Destino secundario: disponibilidad y antiguedad -------------------------------------------

$vistoAhora = (Get-Date -Format 'yyyy-MM-ddTHH:mm:ssK')
$ultimoVisto = $null
if ($estadoPrevio -and $estadoPrevio.destinoSecundario) {
  $ultimoVisto = $estadoPrevio.destinoSecundario.ultimaVez
}

if ($secundario) {
  $ultimoVisto = $vistoAhora
} else {
  if ($ultimoVisto) {
    $dias = [math]::Floor(((Get-Date) - [datetime]$ultimoVisto).TotalDays)
    if ($dias -ge $DiasAvisoSecundario) {
      AnotarAviso ('el disco de copias lleva {0} dias sin conectarse; un segundo destino que nadie conecta no protege de nada' -f $dias)
    } else {
      Escribir ('Destino secundario no conectado (ultima vez hace {0} dias).' -f $dias) 'Yellow'
    }
  } else {
    AnotarAviso 'el destino secundario no se ha conectado nunca; las copias estan solo en el VPS y en este PC'
  }
}

# --- Estado ------------------------------------------------------------------------------------

$estado = [ordered]@{
  momento           = $vistoAhora
  destino           = $Destino
  origen            = $Alias
  instancias        = $resumen
  destinoSecundario = [ordered]@{
    disponible = [bool]$secundario
    ruta       = $(if ($secundario) { $secundario } else { $null })
    ultimaVez  = $ultimoVisto
  }
  avisos    = @($avisos)
  errores   = @($errores)
  resultado = $(if ($errores.Count -eq 0) { 'correcto' } else { 'con errores' })
}
$estado | ConvertTo-Json -Depth 5 | Set-Content -Path $ficheroEstado -Encoding utf8

if ($errores.Count -eq 0) {
  Escribir '== Terminado sin errores ==' 'Green'
  exit 0
}

Escribir ('== Terminado con {0} error(es) ==' -f $errores.Count) 'Red'
exit 1
