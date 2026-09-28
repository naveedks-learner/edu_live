"""
Console + rotating-file logging setup, called once from each entrypoint
(cli.py, app.py). Complements observability.py's per-query SQLite audit
trail - this is the operational log (flow milestones, warnings, errors)
you'd tail live, not the structured per-query dashboard data.
"""

import logging
from logging.handlers import RotatingFileHandler

LOG_FILE = "app.log"
_configured = False


def configure_logging(level: int = logging.INFO) -> None:
    global _configured
    if _configured:
        return

    root = logging.getLogger()
    root.setLevel(level)

    fmt = logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")

    console = logging.StreamHandler()
    console.setFormatter(fmt)
    root.addHandler(console)

    file_handler = RotatingFileHandler(LOG_FILE, maxBytes=2_000_000, backupCount=3, encoding="utf-8")
    file_handler.setFormatter(fmt)
    root.addHandler(file_handler)

    _configured = True
