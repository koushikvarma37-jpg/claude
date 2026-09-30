"""Pinging the owner: desktop notifications plus Apprise (Telegram, Discord, ntfy, email...)."""

from __future__ import annotations

import logging
import platform
import shutil
import subprocess

log = logging.getLogger("motes.notify")


class Notifier:
    def __init__(self, cfg: dict):
        self.desktop = cfg.get("desktop", True)
        self.apprise = None
        urls = cfg.get("apprise_urls") or []
        if urls:
            try:
                import apprise
                self.apprise = apprise.Apprise()
                for url in urls:
                    self.apprise.add(url)
            except ImportError:
                log.warning("apprise_urls set but apprise is not installed: pip install 'motes[notify]'")

    def send(self, title: str, body: str) -> list[str]:
        sent = []
        if self.apprise and self.apprise.notify(title=title, body=body):
            sent.append("apprise")
        if self.desktop and self._desktop(title, body):
            sent.append("desktop")
        return sent

    @staticmethod
    def _desktop(title: str, body: str) -> bool:
        body = body[:300]
        try:
            system = platform.system()
            if system == "Linux" and shutil.which("notify-send"):
                subprocess.run(["notify-send", "-a", "Motes", title, body], timeout=5, check=False)
                return True
            if system == "Darwin":
                script = f"display notification {_osa(body)} with title {_osa(title)}"
                subprocess.run(["osascript", "-e", script], timeout=5, check=False)
                return True
            if system == "Windows":
                ps = (
                    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] > $null;"
                    "$t=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);"
                    "$x=$t.GetElementsByTagName('text');"
                    f"$x.Item(0).AppendChild($t.CreateTextNode({_ps(title)}))>$null;"
                    f"$x.Item(1).AppendChild($t.CreateTextNode({_ps(body)}))>$null;"
                    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Motes').Show([Windows.UI.Notifications.ToastNotification]::new($t))"
                )
                subprocess.run(["powershell", "-NoProfile", "-Command", ps], timeout=10, check=False)
                return True
        except (OSError, subprocess.SubprocessError) as exc:
            log.debug("desktop notification failed: %s", exc)
        return False


def _osa(s: str) -> str:
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _ps(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"
