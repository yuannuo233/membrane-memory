' Stop the hidden Membrane service: kill whatever process listens on port 8317.
' Runs fully hidden (window style 0). Safe when the service is not running (no-op).
Option Explicit
Dim sh
Set sh = CreateObject("WScript.Shell")
sh.Run "powershell -NoProfile -Command ""Get-NetTCPConnection -LocalPort 8317 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force }""", 0, True
