' Membrane one-click launcher - completely windowless.
' Double-click the desktop shortcut (wscript.exe) and NOTHING black appears:
'   1. service already running -> reuse it
'   2. otherwise start node serve HIDDEN (no console window at all)
'   3. wait for <db>.url (tokenized console URL) written by the server
'   4. open Edge in --app mode (borderless standalone window)
' Stop the service with the "stop" shortcut (stop-service.vbs), or:
'   taskkill /F /IM node.exe  (only if nothing else uses node)
' The classic console launcher 启动控制台.bat still exists for terminal users.
Option Explicit
Dim sh, fso, dir, node, cli, urlFile, url, edge, waited, rc
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
cli = dir & "\dist\cli.js"
urlFile = dir & "\data\membrane.db.url"

' --- locate node.exe: workspace-local tools first, then system installs ---
node = ""
If fso.FileExists(fso.GetAbsolutePathName(dir & "\..\tools\nodejs\node.exe")) Then
  node = fso.GetAbsolutePathName(dir & "\..\tools\nodejs\node.exe")
ElseIf fso.FileExists(sh.ExpandEnvironmentStrings("%ProgramFiles%\nodejs\node.exe")) Then
  node = sh.ExpandEnvironmentStrings("%ProgramFiles%\nodejs\node.exe")
ElseIf fso.FileExists(sh.ExpandEnvironmentStrings("%LOCALAPPDATA%\Programs\nodejs\node.exe")) Then
  node = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%\Programs\nodejs\node.exe")
Else
  node = "node" ' last resort: whatever is on PATH
End If

' --- service already running? /api/health is token-free since v0.2.7 ---
rc = sh.Run("cmd /c curl -s -o NUL -m 2 http://127.0.0.1:8317/api/health", 0, True)
If rc <> 0 Then
  If fso.FileExists(urlFile) Then fso.DeleteFile urlFile, True
  ' hidden background service: window style 0 = no console window
  sh.Run """" & node & """ """ & cli & """ serve", 0, False
  waited = 0
  Do While Not fso.FileExists(urlFile) And waited < 20
    WScript.Sleep 1000
    waited = waited + 1
  Loop
End If

' --- read the tokenized console URL ---
url = ""
If fso.FileExists(urlFile) Then
  Dim f
  Set f = fso.OpenTextFile(urlFile, 1)
  url = Trim(f.ReadLine)
  f.Close
End If
If url = "" Then url = "http://127.0.0.1:8317/"

' --- Edge --app: standalone window with the site favicon as taskbar icon ---
edge = sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe")
If Not fso.FileExists(edge) Then
  edge = sh.ExpandEnvironmentStrings("%ProgramFiles%\Microsoft\Edge\Application\msedge.exe")
End If
If fso.FileExists(edge) Then
  sh.Run """" & edge & """ --app=""" & url & """", 1, False
Else
  sh.Run url, 1, False
End If
