' Launches a command with no console window at all.
'
' Why a VBS: `wscript.exe` is a GUI-subsystem host, so it never allocates a
' console for itself. Everything it starts with window style 0 inherits that —
' no console window is shown, and none is left behind. That is different from
' spawning the child directly: a console-subsystem child spawned from a
' window-less parent gets a new console unless CREATE_NO_WINDOW is passed, and
' when the parent lives inside Windows Terminal the tab is already open before
' any flag can take effect.
'
' Usage: wscript.exe //nologo launch-hidden.vbs <cwd> <exe> [args...]
' The first argument is the working directory the child must start in.
' WScript.Shell.Run resolves relative paths against *its own* working
' directory — the one wscript.exe inherited — not the `cwd` Node passed to
' spawn, because that option does not reach a grandchild. Setting
' CurrentDirectory makes the child's directory the package root regardless of
' where carte was invoked from.
' Not the fix for the `B:\migrations` startup failure: that came from the
' compiled binary's virtual `import.meta.dir`, resolved through
' CARTETHYIA_PACKAGE_ROOT. This only removes the inherited-directory guess.
' The third argument (True) would make wscript wait for the child; it must stay
' False so the launcher returns immediately and the child outlives it.

Set shell = CreateObject("WScript.Shell")

' First argument is the working directory; everything after it is the command.
workingDirectory = WScript.Arguments(0)
If workingDirectory <> "" Then shell.CurrentDirectory = workingDirectory

command = ""
For i = 1 To WScript.Arguments.Count - 1
  arg = WScript.Arguments(i)
  If command <> "" Then command = command & " "
  command = command & """" & arg & """"
Next

If command = "" Then
  WScript.Quit 2
End If

' 0 = hidden window, False = do not wait.
shell.Run command, 0, False
