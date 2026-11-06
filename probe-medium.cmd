@echo off
rem Medium-integrity probe: launched via explorer.exe so the child inherits the shell's token.
cd /d "%~dp0"
if not exist "_out" mkdir "_out"
"%~dp0dist\vdmhost.exe" capabilities < nul > "_out\cap-medium.json" 2> "_out\cap-medium.err"
echo exitcode=%ERRORLEVEL%>>"_out\cap-medium.err"
