"""
App Package for AI Service.

Ensures the ai-service directory is in sys.path so sibling packages
(config, db, services) are always importable regardless of current working directory.
"""

import sys
from pathlib import Path

_AI_SERVICE_DIR = str(Path(__file__).resolve().parent.parent)
if _AI_SERVICE_DIR not in sys.path:
    sys.path.insert(0, _AI_SERVICE_DIR)
