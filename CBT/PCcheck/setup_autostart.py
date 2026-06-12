"""
setup_autostart.py
Registers heartbeat.py to run automatically at Windows startup via Task Scheduler.
Run this once: python setup_autostart.py
"""

import os
import sys
import subprocess
from pathlib import Path


def find_python() -> str:
    return sys.executable


def main():
    base_dir     = Path(__file__).resolve().parent
    bat_file     = base_dir / "start_heartbeat.bat"
    python_exe   = find_python()
    heartbeat_py = base_dir / "heartbeat.py"

    # Write the .bat with correct absolute paths
    bat_content = f"""@echo off
cd /d "{base_dir}"
"{python_exe}" "{heartbeat_py}"
"""
    bat_file.write_text(bat_content, encoding="utf-8")
    print(f"✅ Batch file written: {bat_file}")

    # Task Scheduler XML — runs at logon, hidden window
    task_name = "PCHeartbeatMonitor"
    xml = f"""<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Sends heartbeat pings to monitor server so it can alert on PC shutdown.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
    <BootTrigger>
      <Enabled>true</Enabled>
      <Delay>PT30S</Delay>
    </BootTrigger>
  </Triggers>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>"{python_exe}"</Command>
      <Arguments>"{heartbeat_py}"</Arguments>
      <WorkingDirectory>"{base_dir}"</WorkingDirectory>
    </Exec>
  </Actions>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
</Task>"""

    xml_path = base_dir / "_heartbeat_task.xml"
    xml_path.write_text(xml, encoding="utf-16")

    try:
        # Delete old task if it exists (ignore errors)
        subprocess.run(
            ["schtasks", "/Delete", "/TN", task_name, "/F"],
            capture_output=True,
        )
        # Create new task from XML
        result = subprocess.run(
            ["schtasks", "/Create", "/XML", str(xml_path), "/TN", task_name],
            capture_output=True,
            text=True,
        )
        if result.returncode == 0:
            print(f"✅ Heartbeat added to Windows startup as task '{task_name}'")
            print("   It will start automatically at every login/boot.")
            print(f"   To remove: schtasks /Delete /TN {task_name} /F")
        else:
            print("❌ Task Scheduler registration failed:")
            print(result.stdout)
            print(result.stderr)
            print("\nFallback: Add this to your Startup folder manually:")
            print(f"  {bat_file}")
    except FileNotFoundError:
        print("schtasks not found — are you on Windows?")
        print(f"Manually add to startup: {bat_file}")
    finally:
        xml_path.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
