rm -rf /tmp/ghidra-project
mkdir -p /tmp/ghidra-project
mkdir -p /tmp/output


/snap/ghidra/current/ghidra_12.1_PUBLIC/support/analyzeHeadless  \
    /tmp/ghidra-project  \
    ZaloProject  \
    -import /home/nnluc073/Documents/s36/zalo-linux/native/nativelibs/zcall/zcall_mac.node  \
    -scriptPath /home/nnluc073/ghidra_scripts  \
    -postScript DecompilerExporter.java /tmp/output