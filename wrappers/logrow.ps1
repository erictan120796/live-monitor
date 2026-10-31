param([string]$Repo,[string]$TaskType,[string]$Tool,[string]$Model,[string]$Effort,$InputTokens='',$OutputTokens='',$DurationS='',[string]$SessionId='',[string]$Result='',[string]$Notes='')
$q={param($v) $s="$v"; if($s -match '[,"\r\n]'){ '"'+$s.Replace('"','""')+'"' } else { $s }}
$row=((Get-Date -Format 'yyyy-MM-dd HH:mm'),$Repo,$TaskType,$Tool,$Model,$Effort,$InputTokens,$OutputTokens,$DurationS,$SessionId,$Result,$Notes | ForEach-Object { & $q $_ }) -join ','
Add-Content "$HOME\.orchestrator\task-log.csv" $row -Encoding utf8
$row
