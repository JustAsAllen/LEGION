Option Explicit
' ======================================================================
'  LEGION launcher
'  Double-click this file to start LEGION. It runs silently (no console
'  window) and is the recommended way to launch the app.
'  For a console + any error output, use "Launch LEGION.bat" instead.
' ======================================================================

Dim shell, fso, here, electron, cmd
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
Set current = fso.GetCurrentFolder
If Len(current) = 0 Then Set current = shell.ExpandEnvironmentStrings("%USERPROFILE%")
fso.CurrentFolder = here

' Electron is a dev dependency; use its local binary so nothing global is required.
electron = here & "\node_modules\electron\dist\electron.exe"

If Not fso.FileExists(electron) Then
  MsgBox "LEGION could not start." & vbCrLf & vbCrLf & _
         "Electron was not found at:" & vbCrLf & electron & vbCrLf & vbCrLf & _
         "Run this once in a terminal:" & vbCrLf & _
         "    npm install" & vbCrLf & _
         "then launch LEGION again.", vbCritical, "LEGION"
  WScript.Quit 1
End If

cmd = """" & electron & """ "" & here
' Launch hidden: 0 = normal, 1 = hidden
shell.Run cmd, 1, False
