; The Windows installer of the hub (task 1.13, ADR-003). Built by build.ts, which passes
; VERSION, STAGE (the folder with app, hub, node, faro-hub.exe/.xml, tools) and OUT.
;
; Installs to Program Files\Faro and keeps the data in ProgramData\Faro\data, which survives
; reinstalling and uninstalling. Installing over an existing copy is the update: it stops the
; service, replaces the program and starts it again; the hub migrates the database on startup.

Unicode true
ManifestDPIAware true
SetCompressor /SOLID lzma

!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"
!include "WordFunc.nsh"

!ifndef VERSION
  !error "Run build.ts: it passes VERSION, STAGE and OUT"
!endif
!ifndef STAGE
  !error "Run build.ts: it passes VERSION, STAGE and OUT"
!endif
!ifndef OUT
  !error "Run build.ts: it passes VERSION, STAGE and OUT"
!endif

!define SERVICE "faro-hub"
!define PORT "4000"
!define URL "http://localhost:${PORT}"
!define FIREWALL_RULE "Faro (PC de caja)"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Faro"

Name "Faro"
OutFile "${OUT}"
InstallDir "$PROGRAMFILES64\Faro"
RequestExecutionLevel admin
BrandingText "Faro ${VERSION}"
ShowInstDetails show
VIProductVersion "${VERSION}.0.0"
VIAddVersionKey /LANG=1034 "ProductName" "Faro"
VIAddVersionKey /LANG=1034 "FileDescription" "Instalador de Faro para el PC de caja"
VIAddVersionKey /LANG=1034 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=1034 "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=1034 "LegalCopyright" "Faro"

!define MUI_ICON "${STAGE}/faro.ico"
!define MUI_UNICON "${STAGE}/faro.ico"
!define MUI_ABORTWARNING

Var Data           ; ProgramData\Faro\data
Var Edge           ; msedge.exe, or empty
Var FreshData      ; 1 when there was no database before this install
Var ImportDir      ; the data folder brought from another register PC, or empty
Var RadioNew
Var RadioImport
Var DirField

!define MUI_WELCOMEPAGE_TITLE "Faro ${VERSION} para el PC de caja"
!define MUI_WELCOMEPAGE_TEXT "Este programa deja Faro funcionando en este PC: arranca solo al prender el equipo, atiende a los celulares de los meseros y a las impresoras, y sube cada cambio a la nube.$\r$\n$\r$\nSi Faro ya estaba instalado, esto lo actualiza y conserva todos los datos. Hazlo después del cierre de caja: Faro se detiene unos segundos."
!insertmacro MUI_PAGE_WELCOME
Page custom ImportPage ImportPageLeave
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_TITLE "Faro quedó instalado"
!define MUI_FINISHPAGE_TEXT "Faro ya está funcionando en este PC. La dirección para abrirlo en los celulares está en Faro: Personal y roles → Equipos, «Para conectar un celular»."
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "Abrir Faro"
!define MUI_FINISHPAGE_RUN_FUNCTION OpenFaro
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Spanish"

Function .onInit
  ; With "all", $APPDATA is ProgramData and the shortcuts are for every user of the PC.
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "Faro necesita Windows de 64 bits." /SD IDOK
    Abort
  ${EndIf}
  SetShellVarContext all
  SetRegView 64
  StrCpy $Data "$APPDATA\Faro\data"
  StrCpy $ImportDir ""
FunctionEnd

Function un.onInit
  SetShellVarContext all
  SetRegView 64
FunctionEnd

; Only on a PC without Faro data: start from scratch or bring the folder of another register PC.
Function ImportPage
  ${If} ${FileExists} "$Data\pos.sqlite"
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "Datos del restaurante" "¿Empiezas de cero o traes los datos de otro PC de caja?"
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateRadioButton} 0 0 100% 12u "Empezar de cero (un restaurante nuevo)"
  Pop $RadioNew
  ${NSD_CreateRadioButton} 0 18u 100% 12u "Traer los datos de otro PC de caja (la carpeta «data» que copiaste)"
  Pop $RadioImport
  ${NSD_CreateDirRequest} 12u 36u 216u 12u "$ImportDir"
  Pop $DirField
  ${NSD_CreateBrowseButton} 232u 35u 64u 14u "Buscar…"
  Pop $0
  ${NSD_OnClick} $0 BrowseImport
  ${NSD_CreateLabel} 0 60u 100% 48u "Si traes los datos: cierra Faro en el otro PC antes de copiar la carpeta y no lo vuelvas a abrir allá. Desde ahora este PC es la caja del restaurante y sigue con la misma conexión a la nube."
  Pop $0
  ${If} $ImportDir == ""
    ${NSD_Check} $RadioNew
  ${Else}
    ${NSD_Check} $RadioImport
  ${EndIf}
  nsDialogs::Show
FunctionEnd

Function BrowseImport
  nsDialogs::SelectFolderDialog "Elige la carpeta «data» del otro PC de caja" ""
  Pop $0
  ${If} $0 != "error"
    ${NSD_SetText} $DirField $0
    ${NSD_Uncheck} $RadioNew
    ${NSD_Check} $RadioImport
  ${EndIf}
FunctionEnd

Function ImportPageLeave
  ${NSD_GetState} $RadioImport $0
  ${If} $0 == ${BST_CHECKED}
    ${NSD_GetText} $DirField $1
    ${If} $1 == ""
      MessageBox MB_ICONEXCLAMATION "Elige primero la carpeta con «Buscar…»."
      Abort
    ${EndIf}
    ${IfNot} ${FileExists} "$1\pos.sqlite"
      MessageBox MB_ICONEXCLAMATION "En esa carpeta no está «pos.sqlite». Elige la carpeta «data» que copiaste del otro PC de caja."
      Abort
    ${EndIf}
    StrCpy $ImportDir $1
  ${Else}
    StrCpy $ImportDir ""
  ${EndIf}
FunctionEnd

Function FindEdge
  StrCpy $Edge ""
  ReadRegStr $0 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe" ""
  ${If} $0 == ""
    SetRegView 32
    ReadRegStr $0 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe" ""
    SetRegView 64
  ${EndIf}
  ${If} $0 == ""
    StrCpy $0 "$PROGRAMFILES32\Microsoft\Edge\Application\msedge.exe"
  ${EndIf}
  ${If} ${FileExists} $0
    StrCpy $Edge $0
  ${EndIf}
FunctionEnd

; The register opens Faro in its own Edge window (no address bar); without Edge, Explorer opens the
; address in the default browser.
!macro FaroShortcut ROUTE
  ${If} $Edge != ""
    CreateShortcut "${ROUTE}" "$Edge" "--app=${URL}" "$INSTDIR\faro.ico" 0
  ${Else}
    CreateShortcut "${ROUTE}" "$WINDIR\explorer.exe" "${URL}" "$INSTDIR\faro.ico" 0
  ${EndIf}
!macroend

Function StopService
  ${If} ${FileExists} "$INSTDIR\faro-hub.exe"
    DetailPrint "Deteniendo Faro…"
    nsExec::ExecToLog '"$INSTDIR\faro-hub.exe" stop'
    Pop $0
    nsExec::ExecToLog '"$INSTDIR\faro-hub.exe" uninstall'
    Pop $0
    ; WinSW returns once the service stopped; this gives Windows time to release node.exe.
    Sleep 2000
  ${EndIf}
FunctionEnd

; Waits up to 60 s for the hub to answer on /api/health. Leaves 1 or 0 on the stack.
Function WaitForHub
  StrCpy $1 0
  ${Do}
    nsExec::ExecToStack 'powershell -NoProfile -NonInteractive -Command "try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 ${URL}/api/health).StatusCode } catch { 0 }"'
    Pop $0
    Pop $2
    ${If} $2 == "200$\r$\n"
    ${OrIf} $2 == "200"
      Push 1
      Return
    ${EndIf}
    IntOp $1 $1 + 1
    ${If} $1 >= 30
      Push 0
      Return
    ${EndIf}
    Sleep 2000
  ${Loop}
FunctionEnd

; On a fresh database the hub creates the admin and, with no window, writes its sign-in details to
; admin-pin.txt (readable only by administrators): they are shown here once and the file deleted.
; A silent install (/S) shows nothing, so the file stays for whoever installs to read it.
Function ShowAdmin
  ${If} ${Silent}
    Return
  ${EndIf}
  StrCpy $1 0
  ${DoUntil} ${FileExists} "$Data\admin-pin.txt"
    IntOp $1 $1 + 1
    ${If} $1 > 15
      MessageBox MB_ICONEXCLAMATION "No apareció la contraseña del administrador. Cuando Faro esté funcionando, crea una nueva: menú Inicio → Faro → Nueva contraseña del administrador."
      Return
    ${EndIf}
    Sleep 1000
  ${Loop}
  Sleep 500
  StrCpy $3 ""
  ClearErrors
  FileOpen $0 "$Data\admin-pin.txt" r
  ${Do}
    FileRead $0 $2
    ${If} ${Errors}
      ${Break}
    ${EndIf}
    StrCpy $3 "$3$2"
  ${Loop}
  FileClose $0
  ; The hub writes the labels in English (ADR-010); the owner reads them in Spanish.
  ${WordReplace} "$3" "PIN to authorize:" "PIN para autorizar:" "+" $3
  ${WordReplace} "$3" "Username:" "Usuario:" "+" $3
  ${WordReplace} "$3" "Password:" "Contraseña:" "+" $3
  MessageBox MB_ICONINFORMATION "Estos son los datos del administrador para entrar en la caja. Guárdalos en un lugar seguro (por ejemplo, el gestor de contraseñas): no se vuelven a mostrar. Puedes copiar este mensaje con Ctrl+C.$\r$\n$\r$\n$3" /SD IDOK
  Delete "$Data\admin-pin.txt"
FunctionEnd

Section "Faro" SecFaro
  SectionIn RO
  Call StopService

  ${IfNot} ${FileExists} "$Data\pos.sqlite"
    StrCpy $FreshData 1
  ${Else}
    StrCpy $FreshData 0
  ${EndIf}

  ; The program: the old app and hub go first, their file names change in each version.
  RMDir /r "$INSTDIR\app"
  RMDir /r "$INSTDIR\hub"
  SetOutPath "$INSTDIR"
  File /r "${STAGE}/*"

  ; The data folder: only Windows (SYSTEM) and administrators can read it, because it has the PIN
  ; key and the cloud credential. The logs next to it are readable by everyone.
  CreateDirectory "$Data"
  CreateDirectory "$APPDATA\Faro\logs"
  nsExec::ExecToLog 'icacls "$Data" /inheritance:r /grant:r *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F'
  Pop $0

  ; Data from another register PC: the database and what goes with it, never the sign-in files
  ; (pines-*.txt, admin-pin.txt) left there.
  ${If} $ImportDir != ""
  ${AndIf} $FreshData == 1
    DetailPrint "Copiando los datos de $ImportDir…"
    CopyFiles /SILENT "$ImportDir\pos.sqlite" "$Data"
    ${If} ${FileExists} "$ImportDir\pos.sqlite-wal"
      CopyFiles /SILENT "$ImportDir\pos.sqlite-wal" "$Data"
    ${EndIf}
    ${If} ${FileExists} "$ImportDir\pin-key"
      CopyFiles /SILENT "$ImportDir\pin-key" "$Data"
    ${EndIf}
    ${If} ${FileExists} "$ImportDir\hub-instance"
      CopyFiles /SILENT "$ImportDir\hub-instance" "$Data"
    ${EndIf}
    ${If} ${FileExists} "$ImportDir\cloud-link.json"
      CopyFiles /SILENT "$ImportDir\cloud-link.json" "$Data"
    ${EndIf}
    ${If} ${FileExists} "$ImportDir\cloud-snapshots.json"
      CopyFiles /SILENT "$ImportDir\cloud-snapshots.json" "$Data"
    ${EndIf}
    ${If} ${FileExists} "$ImportDir\photos\*.*"
      CreateDirectory "$Data\photos"
      CopyFiles /SILENT "$ImportDir\photos\*.*" "$Data\photos"
    ${EndIf}
    ; Without the database the hub would start empty, linked to the restaurant's cloud.
    ${IfNot} ${FileExists} "$Data\pos.sqlite"
      MessageBox MB_ICONSTOP "No se pudieron copiar los datos de $ImportDir. Revisa la memoria USB y vuelve a abrir el instalador." /SD IDOK
      Abort
    ${EndIf}
  ${EndIf}

  DetailPrint "Instalando el servicio de Faro…"
  nsExec::ExecToLog '"$INSTDIR\faro-hub.exe" install'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "No se pudo instalar el servicio de Faro (código $0). Los detalles están en la lista de arriba." /SD IDOK
    Abort
  ${EndIf}

  ; The phones reach the hub only from the local network, on any network profile (the restaurant
  ; Wi-Fi is often marked as public).
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="${FIREWALL_RULE}"'
  Pop $0
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="${FIREWALL_RULE}" dir=in action=allow protocol=TCP localport=${PORT} remoteip=localsubnet profile=any program="$INSTDIR\node\node.exe"'
  Pop $0

  DetailPrint "Arrancando Faro…"
  nsExec::ExecToLog '"$INSTDIR\faro-hub.exe" start'
  Pop $0
  Call WaitForHub
  Pop $0
  ${If} $0 != 1
    MessageBox MB_ICONEXCLAMATION "Faro quedó instalado pero no responde todavía. Reinicia el PC; si sigue igual, mándale a Faro los archivos de menú Inicio → Faro → Registros de Faro." /SD IDOK
  ${EndIf}
  ${If} $FreshData == 1
  ${AndIf} $ImportDir == ""
    Call ShowAdmin
  ${EndIf}

  Call FindEdge
  CreateDirectory "$SMPROGRAMS\Faro"
  !insertmacro FaroShortcut "$SMPROGRAMS\Faro\Faro.lnk"
  !insertmacro FaroShortcut "$DESKTOP\Faro.lnk"
  CreateShortcut "$SMPROGRAMS\Faro\Nueva contraseña del administrador.lnk" "$INSTDIR\tools\reset-admin.cmd" "" "$INSTDIR\faro.ico" 0
  CreateShortcut "$SMPROGRAMS\Faro\Registros de Faro.lnk" "$APPDATA\Faro\logs"
  CreateShortcut "$SMPROGRAMS\Faro\Desinstalar Faro.lnk" "$INSTDIR\uninstall.exe"

  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "DisplayName" "Faro (PC de caja)"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "Publisher" "Faro"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\faro.ico"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegDWORD HKLM "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINSTALL_KEY}" "NoRepair" 1
SectionEnd

Section "Que el PC no se duerma (conectado a la corriente)" SecAwake
  ; If the PC sleeps, the phones lose the register and the kitchen stops printing.
  nsExec::ExecToLog 'powercfg /change standby-timeout-ac 0'
  Pop $0
  nsExec::ExecToLog 'powercfg /change hibernate-timeout-ac 0'
  Pop $0
SectionEnd

Section "Abrir Faro al iniciar sesión en este PC" SecStartup
  !insertmacro FaroShortcut "$SMSTARTUP\Faro.lnk"
SectionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SecFaro} "Faro y su servicio, que arranca con Windows."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecAwake} "Recomendado: si el PC se duerme, los celulares pierden la caja y la cocina deja de imprimir."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecStartup} "Abre la caja de Faro al entrar a Windows."
!insertmacro MUI_FUNCTION_DESCRIPTION_END

Function OpenFaro
  ; Through Explorer, so Faro does not open with the installer's administrator rights.
  Exec '"$WINDIR\explorer.exe" "$SMPROGRAMS\Faro\Faro.lnk"'
FunctionEnd

Section "Uninstall"
  nsExec::ExecToLog '"$INSTDIR\faro-hub.exe" stop'
  Pop $0
  nsExec::ExecToLog '"$INSTDIR\faro-hub.exe" uninstall'
  Pop $0
  Sleep 2000
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="${FIREWALL_RULE}"'
  Pop $0
  Delete "$DESKTOP\Faro.lnk"
  Delete "$SMSTARTUP\Faro.lnk"
  RMDir /r "$SMPROGRAMS\Faro"
  RMDir /r "$INSTDIR\app"
  RMDir /r "$INSTDIR\hub"
  RMDir /r "$INSTDIR\node"
  RMDir /r "$INSTDIR\tools"
  Delete "$INSTDIR\faro-hub.*"
  Delete "$INSTDIR\faro.ico"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKLM "${UNINSTALL_KEY}"
  ; The data stays, but never a password nobody read.
  Delete "$APPDATA\Faro\data\admin-pin.txt"
  MessageBox MB_ICONINFORMATION "Faro se desinstaló. Los datos del restaurante siguen en $APPDATA\Faro\data: si vuelves a instalar Faro, los usa." /SD IDOK
SectionEnd
