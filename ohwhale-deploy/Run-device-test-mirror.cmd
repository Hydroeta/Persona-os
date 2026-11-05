@echo off
setlocal
rem The default installer already uses the Aliyun PyPI mirror.
rem This entry switches that to the Tsinghua mirror as an alternative.
rem The CUDA wheel command still specifies the official PyTorch index.
set "PIP_INDEX_URL=https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple"
set "PIP_EXTRA_INDEX_URL="
call "%~dp0Run-device-test.cmd"
endlocal
