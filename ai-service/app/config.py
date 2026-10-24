"""Re-export of the service settings so `app.*` modules can import `app.config`."""

from config import Settings, settings

__all__ = ["Settings", "settings"]
