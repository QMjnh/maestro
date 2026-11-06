@echo off
cd /d "%~dp0"
if exist dist\Maestro.exe goto run

rem First run: build it (needs the .NET 10 SDK; set DOTNET_ROOT if it isn't the one on PATH).
set "DOTNET=dotnet"
if defined DOTNET_ROOT set "DOTNET=%DOTNET_ROOT%\dotnet.exe"
echo Building Maestro...
"%DOTNET%" publish src\Maestro -c Release -o dist
if errorlevel 1 (pause & exit /b 1)

:run
start "" dist\Maestro.exe
