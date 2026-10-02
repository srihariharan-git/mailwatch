Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "C:\Users\sriha\OneDrive\Documents\opencode\mailwatch"
sh.Run """C:\Program Files\nodejs\node.exe"" server/index.js 1>>mailwatch.log 2>&1", 0, True