#!/bin/bash

PLIST=/Library/LaunchAgents/com.claudebot.plist
GUI="gui/$(id -u)"

case "$1" in
  start)
    launchctl bootstrap "$GUI" "$PLIST"
    echo "Bot started."
    ;;
  stop)
    launchctl bootout "$GUI" "$PLIST"
    echo "Bot stopped."
    ;;
  restart)
    launchctl bootout "$GUI" "$PLIST" 2>/dev/null
    launchctl bootstrap "$GUI" "$PLIST"
    echo "Bot restarted."
    ;;
  status)
    launchctl list | grep claudebot || echo "Not running."
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status}"
    exit 1
    ;;
esac
