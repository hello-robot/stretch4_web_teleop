"""Feature flags, read the same way feature-flags.js reads them.

Defaults come from features.json at the repository root; a FEATURE_<NAME>
environment variable overrides one.
"""

import json
import os
from pathlib import Path

FEATURES_PATH = Path(__file__).resolve().parent.parent / "features.json"
TRUTHY = {"1", "true", "yes", "on"}
FALSY = {"0", "false", "no", "off"}


def env_var_name(name: str) -> str:
    return f"FEATURE_{name.upper()}"


def load_features(path: Path = FEATURES_PATH) -> dict[str, bool]:
    """Every declared flag with environment overrides applied."""
    registry = json.loads(path.read_text())
    features = {}
    for name, entry in registry.items():
        raw = os.environ.get(env_var_name(name), "")
        value = raw.strip().lower()
        if value in TRUTHY:
            features[name] = True
        elif value in FALSY:
            features[name] = False
        elif value:
            raise ValueError(
                f'{env_var_name(name)}="{raw}" is not a boolean; use 1/0, true/false, yes/no or on/off.'
            )
        else:
            features[name] = bool(entry.get("enabled"))
    return features


_FEATURES = load_features()

FEATURE_EE_VELOCITY_LIMITER = _FEATURES.get("ee_velocity_limiter", False)
FEATURE_VOICE_CONTROL_INTERFACE = _FEATURES.get("voice_control_interface", False)
FEATURE_VOICE_INPUT_RECORDING = _FEATURES.get("voice_input_recording", False)
