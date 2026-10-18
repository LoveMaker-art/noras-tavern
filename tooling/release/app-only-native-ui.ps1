param([Parameter(Mandatory)][string]$AppRoot,[Parameter(Mandatory)][string]$Output,[Parameter(Mandatory)][ValidateSet('update','close','ready')][string]$Action)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName Accessibility,UIAutomationClient,UIAutomationTypes
Add-Type -ReferencedAssemblies Accessibility @'
using System;using System.Collections.Generic;using System.Runtime.InteropServices;using Accessibility;
public static class NoraAppNativeUI {
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int state);
 [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h,uint msg,IntPtr w,IntPtr l);
 [DllImport("oleacc.dll")] public static extern int AccessibleObjectFromWindow(IntPtr hwnd,uint id,ref Guid iid,[MarshalAs(UnmanagedType.Interface)] out IAccessible obj);
 [DllImport("oleacc.dll")] public static extern int AccessibleChildren(IAccessible parent,int start,int count,[Out,MarshalAs(UnmanagedType.LPArray,SizeParamIndex=2)] object[] children,out int obtained);
 public static void Find(IAccessible a,int depth,string wanted,List<Tuple<IAccessible,object>> found){if(a==null||depth>25)return;try{string n=a.get_accName(0)??"";int role=Convert.ToInt32(a.get_accRole(0)),state=Convert.ToInt32(a.get_accState(0));if(role==43&&(n==wanted||n.EndsWith(" "+wanted))&&(state&(1|32768|65536))==0)found.Add(Tuple.Create(a,(object)0));int count=a.accChildCount;var children=new object[count];int got;AccessibleChildren(a,0,count,children,out got);foreach(var c in children){var item=c as IAccessible;if(item!=null)Find(item,depth+1,wanted,found);else if(c is int){string cn=a.get_accName(c)??"";int cr=Convert.ToInt32(a.get_accRole(c)),cs=Convert.ToInt32(a.get_accState(c));if(cr==43&&(cn==wanted||cn.EndsWith(" "+wanted))&&(cs&(1|32768|65536))==0)found.Add(Tuple.Create(a,c));}}}catch{}}
 public static bool Button(IntPtr h,string wanted,bool press){Guid id=new Guid("618736E0-3C3D-11CF-810C-00AA00389B71");IAccessible a;int hr=AccessibleObjectFromWindow(h,4294967292,ref id,out a);if(hr!=0)throw new Exception("Native accessibility unavailable HRESULT "+hr);var found=new List<Tuple<IAccessible,object>>();Find(a,0,wanted,found);if(found.Count!=1)return false;if(press)found[0].Item1.accDoDefaultAction(found[0].Item2);return true;}
 public static bool Click(IntPtr h,string wanted){return Button(h,wanted,true);}
 public static bool Available(IntPtr h,string wanted){return Button(h,wanted,false);}
}
'@
$events=@()
try {
 $root=[IO.Path]::GetFullPath($AppRoot).TrimEnd('\')+'\'
 function Window {
  $deadline=[DateTime]::UtcNow.AddSeconds(30)
  do {
   $ids=@(Get-CimInstance Win32_Process|Where-Object{$_.ExecutablePath -and $_.ExecutablePath.StartsWith($root,[StringComparison]::OrdinalIgnoreCase) -and $_.CommandLine -notmatch '(?:^|\s)--type='}|ForEach-Object{$_.ProcessId})
   $windows=[Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children,[Windows.Automation.Condition]::TrueCondition)
   $owned=@($windows|Where-Object{$ids -contains $_.Current.ProcessId -and $_.Current.NativeWindowHandle -ne 0 -and $_.Current.Name -eq '诺拉·酒馆' -and $_.Current.ControlType -in @([Windows.Automation.ControlType]::Window,[Windows.Automation.ControlType]::Pane)})
   if($owned.Count -eq 1){return $owned[0]}
   if($owned.Count -gt 1){throw 'Native UI environment blocked: ambiguous owned main windows'}
   Start-Sleep -Milliseconds 300
  } while([DateTime]::UtcNow -lt $deadline)
  throw 'Native UI environment blocked: no owned interactive window within 30 seconds'
 }
 $w=Window;$h=[IntPtr]$w.Current.NativeWindowHandle
 $events+=@{action='owned-window-selected';pid=$w.Current.ProcessId;handle=$h.ToInt64();title=$w.Current.Name;controlType=$w.Current.ControlType.ProgrammaticName;session=[Diagnostics.Process]::GetCurrentProcess().SessionId}
 [void][NoraAppNativeUI]::ShowWindow($h,9);[void][NoraAppNativeUI]::SetForegroundWindow($h);try{$w.SetFocus()}catch{}
 Start-Sleep -Milliseconds 350
 if([NoraAppNativeUI]::GetForegroundWindow() -ne $h){throw 'Native UI environment blocked: foreground activation refused'}
 if($Action -eq 'close'){[void][NoraAppNativeUI]::PostMessage($h,0x0010,[IntPtr]::Zero,[IntPtr]::Zero);$events+=@{action='WM_CLOSE';pid=$w.Current.ProcessId}}
 elseif($Action -eq 'ready'){
  $deadline=[DateTime]::UtcNow.AddSeconds(30)
  while(![NoraAppNativeUI]::Available($h,'更多')){if([DateTime]::UtcNow -ge $deadline){throw 'Native UI environment blocked: initial UI flow has not exposed enabled More'};Start-Sleep -Milliseconds 300}
  $events+=@{action='read-only-enabled-More';pid=$w.Current.ProcessId;at=[DateTime]::UtcNow.ToString('o')}
 }
 else {
  foreach($names in @(@('更多'),@('检查更新'),@('安装更新','安装新版更新'))){
   $done=$false;$deadline=[DateTime]::UtcNow.AddSeconds(30)
   while(!$done -and [DateTime]::UtcNow -lt $deadline){foreach($name in $names){if([NoraAppNativeUI]::Click($h,$name)){$events+=@{action='accDoDefaultAction';name=$name;pid=$w.Current.ProcessId;at=[DateTime]::UtcNow.ToString('o')};$done=$true;break}};if(!$done){Start-Sleep -Milliseconds 300}}
   if(!$done){throw ('Native update control unavailable: '+($names -join '|'))};Start-Sleep -Milliseconds 500
  }
 }
 [IO.File]::WriteAllText($Output,(@{outcome='native-actions-invoked';session=[Diagnostics.Process]::GetCurrentProcess().SessionId;events=$events}|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
} catch {
 [IO.File]::WriteAllText($Output,(@{outcome='blocked';error=$_.Exception.Message;events=$events}|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false));throw
}
