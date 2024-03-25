@echo off
SETLOCAL EnableDelayedExpansion

REM Get the current git describe string
FOR /F "tokens=*" %%i IN ('git describe --always --long ') DO SET GIT_DESCRIBE=%%i

echo Deploying version !GIT_DESCRIBE! to the development server (rocky1)

REM Update GitVersion.js
echo export const gitVersion= '!GIT_DESCRIBE!'  > gitversion.js

REM Sync files to the staging server
REM Note: Update the source and target paths and server details
scp -r *.js package.json root@rocky1.vpn.techspace.cz:/data/www/ext-prod.techspace.cz/node/ftk

REM You might need to replace `scp` with the full path to the executable if it's not in your PATH
                                                                                                       
ENDLOCAL
