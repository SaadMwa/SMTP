param(
  [string]$HostName = "127.0.0.1",
  [int]$Port = 2525,
  [string]$From = "buyer@example.com",
  [string]$To = "sales@example.test",
  [string]$Subject = "Quote request from Windows host"
)

$ErrorActionPreference = "Stop"

function Read-SmtpLine {
  param([System.IO.StreamReader]$Reader)
  $line = $Reader.ReadLine()
  if ($null -eq $line) {
    throw "SMTP server closed the connection before sending a response."
  }
  Write-Host "< $line"
  return $line
}

function Send-SmtpLine {
  param(
    [System.IO.StreamWriter]$Writer,
    [string]$Line
  )
  Write-Host "> $Line"
  $Writer.Write("$Line`r`n")
  $Writer.Flush()
}

$client = [System.Net.Sockets.TcpClient]::new()
$client.ReceiveTimeout = 10000
$client.SendTimeout = 10000
$client.Connect($HostName, $Port)

try {
  $stream = $client.GetStream()
  $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::ASCII)
  $writer = [System.IO.StreamWriter]::new($stream, [System.Text.Encoding]::ASCII)
  $writer.NewLine = "`r`n"
  $writer.AutoFlush = $true

  Read-SmtpLine $reader | Out-Null
  Send-SmtpLine $writer "EHLO windows-host"
  do {
    $line = Read-SmtpLine $reader
  } while ($line.StartsWith("250-"))

  Send-SmtpLine $writer "MAIL FROM:<$From>"
  Read-SmtpLine $reader | Out-Null
  Send-SmtpLine $writer "RCPT TO:<$To>"
  Read-SmtpLine $reader | Out-Null
  Send-SmtpLine $writer "DATA"
  Read-SmtpLine $reader | Out-Null

  $body = @(
    "From: $From",
    "To: $To",
    "Subject: $Subject",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Hello,",
    "",
    "Can you send me a quote for 25 rooms next Friday through Sunday?",
    "",
    "Thanks",
    "."
  )

  foreach ($line in $body) {
    Send-SmtpLine $writer $line
  }

  Read-SmtpLine $reader | Out-Null
  Send-SmtpLine $writer "QUIT"
  Read-SmtpLine $reader | Out-Null
  Write-Host "SMTP test message sent to $HostName`:$Port"
}
finally {
  $client.Close()
}
