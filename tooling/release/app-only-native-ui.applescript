on run argv
 set processId to (item 1 of argv) as integer
 set actionName to item 2 of argv
 tell application "System Events"
  set targetProcess to first application process whose unix id is processId
  set frontmost of targetProcess to true
  if actionName is "close" then
   tell targetProcess to keystroke "q" using command down
   return "native-command-q"
  end if
  set wantedButtons to {"更多", "检查更新", "安装更新"}
  if actionName is "ready" then set wantedButtons to {"更多"}
  repeat with wanted in wantedButtons
   set foundButton to false
   repeat 100 times
    tell targetProcess
     if exists window 1 then
      set elements to entire contents of window 1
      repeat with element in elements
       try
        set labelText to name of element as text
        if role of element is "AXButton" and enabled of element and (labelText is wanted or (wanted is "安装更新" and labelText is "安装新版更新")) then
         if actionName is not "ready" then perform action "AXPress" of element
         set foundButton to true
         exit repeat
        end if
       end try
      end repeat
     end if
    end tell
    if foundButton then exit repeat
    delay 0.3
   end repeat
   if not foundButton then error "Native UI environment/control blocked: " & wanted
   delay 0.5
  end repeat
 end tell
 if actionName is "ready" then return "native-read-only-enabled-More"
 return "native-update-buttons-invoked"
end run
