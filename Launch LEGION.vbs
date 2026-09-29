Option Explicit
' ======================================================================
'  LEGION launcher
'  Double-click this file to start LEGION. It runs silently (no console
'  window) and is the recommended way to launch the app.
'  For a console + any error output, use "Launch LEGION.bat" instead.
' ======================================================================

Dim shell, fso, here, electron, q, cmd

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)

' package.json names the real entry point (src/main/main.js), so hand Electron
' the app directory as "." with the working directory set to it. Passing the
' directory path itself makes Electron treat it as a module to resolve, which
' fails with "Cannot find module" on a path containing spaces.
electron = here & "\node_modules\electron\dist\electron.exe"
If Not fso.FileExists(electron) Then
  MsgBox "LEGION could not start." & vbCrLf & vbCrLf & _
         "Electron was not found at:" & vbCrLf & electron & vbCrLf & vbCrLf & _
         "Run this once in a terminal:" & vbCrLf & _
         "    npm install" & vbCrLf & _
         "then launch LEGION again.", vbCritical, "LEGION"
  WScript.Quit 1
End If

If Not fso.FileExists(here & "\package.json") Then
  MsgBox "LEGION could not start." & vbCrLf & vbCrLf & _
         "No package.json in:" & vbCrLf & here & vbCrLf & vbCrLf & _
         "Keep this launcher in the project root.", vbCritical, "LEGION"
  WScript.Quit 1
End If

q = Chr(34)
' Run hidden (window style 1). The working directory has to change too, because
' Electron resolves "." relative to it.
shell.CurrentDirectory = here
cmd = q & electron & q & " ."
shell.Run cmd, 1, False
